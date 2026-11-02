import { fileURLToPath } from "node:url";
import { types } from "node:util";
import { DataClass } from "@draftyak/protocol/data-class";
import { checkRouteResponse, SendReview } from "@draftyak/protocol/device-api";
import { type FlagCode, Flags, flagsHash } from "@draftyak/protocol/flags";
import { Ulid, UtcMs } from "@draftyak/protocol/scalars";
import { renderLocalWallTime, ScheduleError } from "@draftyak/protocol/schedule";
import { CurrentSendSnapshotV1, contentHash, sendWindow } from "@draftyak/protocol/snapshot";
import {
	checkFlagsAcked,
	checkSendWindow,
	requiredAckCodes,
} from "@draftyak/protocol/statements/send";
import { AuditChain } from "../audit/chain.ts";
import { Authorizer, assertAuthorizerStore } from "../authz/authorizer.ts";
import { plainRecord } from "../authz/decide.ts";
import type { NativeDevicePeer } from "../authz/native-peer.ts";
import { settleWithin } from "../extensions/policy.ts";
import {
	assertChallengeContext,
	type SendAcceptContext,
	type SendIssueContext,
	type SendPrepared,
} from "../identity/challenges.ts";
import { dataCopy, guard, refuse } from "../identity/challenges-support.ts";
import { DeviceRegistry } from "../identity/devices.ts";
import type { HubIdentity } from "../identity/hub-key.ts";
import { systemClock, type TimerClock } from "../kernel/clock.ts";
import { newId } from "../kernel/ids.ts";
import type { MasterKey } from "../kernel/master-key.ts";
import {
	assertStoreTransaction,
	HubStore,
	type SqlReader,
	type SqlTransaction,
} from "../store/store.ts";
import {
	abortNativeOutboxScope,
	applyNativeOutboxTarget,
	assertNativeOutboxScope,
	assertNativeOutboxTarget,
	countNativeOutboxScheduled,
	isNativeOutboxDraftLocked,
	readNativeOutboxTarget,
	writeNativeOutboxTarget,
} from "./propose.ts";
import { ApprovalRows } from "./verifier-rows.ts";
import type {
	ConsumedSendApproval,
	SendApplyResult,
	SendApprovalPolicy,
	SendApprovalPolicyInput,
	SendApprovalTarget,
	SendTargetRecord,
	SendTargetScope,
	VerifiedSendApproval,
	VerifiedSendApprovalFacts,
} from "./verifier-types.ts";

export type {
	ConsumedSendApproval,
	SendApplyResult,
	SendApprovalPolicy,
	SendApprovalPolicyInput,
	SendApprovalPolicyResult,
	SendApprovalTarget,
	SendTargetRecord,
	SendTargetScope,
	StoredSendApproval,
	VerifiedSendApproval,
	VerifiedSendApprovalFacts,
} from "./verifier-types.ts";
export const APPROVAL_MIGRATIONS: string = fileURLToPath(
	new URL(
		import.meta.url.endsWith(".ts") ? "./verifier-migrations/" : "./outbox/verifier-migrations/",
		import.meta.url,
	),
);
export const SEND_POLICY_DEADLINE_MS = 2_000;
const HORIZON_MS = 30 * 86_400_000;
export const CORE_SEND_APPROVAL_POLICY: SendApprovalPolicy = Object.freeze({
	id: "core",
	evaluate: async () => Object.freeze({ kind: "require" as const, approvals: 1 }),
});
interface ProofState {
	readonly issuer: SendApprovalVerifier;
	readonly context: SendAcceptContext;
	readonly store: HubStore;
	readonly tx: SqlTransaction;
	readonly scope: SendTargetScope;
	readonly target: SendApprovalTarget;
	readonly rows: ApprovalRows;
	readonly approval: VerifiedSendApprovalFacts;
	consumed: boolean;
}
const proofs = new WeakMap<object, ProofState>();
const verifiers = new WeakMap<object, HubStore>();
const read = HubStore.prototype.read;
const registryState = DeviceRegistry.prototype.state;
const assertRegistryStore = DeviceRegistry.prototype.assertStore;
const assertRegistryIdentity = DeviceRegistry.prototype.assertIdentity;
const requireRoute = Authorizer.prototype.requirePeerRoute;
const assertGrant = Authorizer.prototype.assertCurrentGrant;
const auditVerify = AuditChain.prototype.verify;

/** Only a live accepting transaction can expose the authenticated approval table projection. */
export function consumeVerifiedSendApproval(
	proof: VerifiedSendApproval,
	tx: SqlTransaction,
	scope: SendTargetScope,
	target: SendApprovalTarget,
): ConsumedSendApproval {
	const state =
		proof !== null && typeof proof === "object" && !types.isProxy(proof)
			? proofs.get(proof)
			: undefined;
	if (
		!state ||
		state.consumed ||
		state.tx !== tx ||
		state.scope !== scope ||
		state.target !== target
	)
		refuse("UNAVAILABLE");
	assertStoreTransaction(state.store, tx);
	assertNativeOutboxTarget(target, state.store);
	assertVerifierActive.call(state.issuer);
	assertNativeOutboxScope(target, tx, scope);
	assertChallengeContext(state.context, "accept", state.store, tx, scope);
	state.consumed = true;
	proofs.delete(proof);
	const record = readNativeOutboxTarget(target, tx, state.approval.outboxId);
	if (
		!record ||
		record.targetVersion !== state.approval.targetVersion ||
		record.contentHash !== state.approval.contentHash ||
		record.flagsHash !== state.approval.flagsHash
	)
		refuse("STALE");
	const stored = state.rows.current(tx, state.approval);
	assertChallengeContext(state.context, "accept", state.store, tx, scope);
	assertVerifierActive.call(state.issuer);
	return Object.freeze({
		approval: state.approval,
		stored,
	});
}
export function isVerifiedSendApproval(value: unknown): value is VerifiedSendApproval {
	if (value === null || typeof value !== "object" || types.isProxy(value)) return false;
	const state = proofs.get(value);
	if (!state || state.consumed) return false;
	try {
		assertStoreTransaction(state.store, state.tx);
		assertVerifierActive.call(state.issuer);
		assertNativeOutboxScope(state.target, state.tx, state.scope);
		assertChallengeContext(state.context, "accept", state.store, state.tx, state.scope);
		return true;
	} catch {
		return false;
	}
}
export function assertSendApprovalVerifier(value: unknown, store: HubStore): void {
	if (
		value === null ||
		typeof value !== "object" ||
		types.isProxy(value) ||
		verifiers.get(value) !== store
	)
		refuse("UNAVAILABLE");
	assertVerifierActive.call(value);
}
export interface SendApprovalVerifierOptions {
	readonly identity: HubIdentity;
	readonly target: SendApprovalTarget;
	readonly masterKey: MasterKey;
	readonly clock?: TimerClock;
	readonly policy?: SendApprovalPolicy;
}

/** The send verifier has one authority producer: the native challenge/signature/PIN pipeline. */
export class SendApprovalVerifier {
	readonly #store: HubStore;
	readonly #registry: DeviceRegistry;
	readonly #authorizer: Authorizer;
	readonly #target: SendApprovalTarget;
	readonly #hub: string;
	readonly #rows: ApprovalRows;
	readonly #clock: TimerClock;
	readonly #policy: SendApprovalPolicy;
	#locked = false;
	constructor(
		store: HubStore,
		audit: AuditChain,
		registry: DeviceRegistry,
		authorizer: Authorizer,
		options: SendApprovalVerifierOptions,
	) {
		const value = plainRecord(options, ["identity", "target", "masterKey"], ["clock", "policy"]);
		if (!value || types.isProxy(store) || types.isProxy(audit)) refuse("UNAVAILABLE");
		try {
			HubStore.prototype.assertMasterKey.call(store, options.masterKey);
			assertRegistryStore.call(registry, store);
			assertRegistryIdentity.call(registry, options.identity);
			assertAuthorizerStore(authorizer, store);
			assertNativeOutboxTarget(options.target, store);
			read.call(store, (db: SqlReader) => auditVerify.call(audit, db));
		} catch {
			refuse("UNAVAILABLE");
		}
		this.#store = store;
		this.#registry = registry;
		this.#authorizer = authorizer;
		this.#target = options.target;
		this.#hub = options.identity.hid;
		this.#rows = new ApprovalRows(store, audit, options.masterKey);
		this.#clock = options.clock ?? systemClock;
		this.#policy = options.policy ?? CORE_SEND_APPROVAL_POLICY;
		verifiers.set(this, store);
	}
	assertActive(): void {
		this.#active();
	}
	#active(): void {
		if (this.#locked) refuse("UNAVAILABLE");
		try {
			assertRegistryStore.call(this.#registry, this.#store);
			assertNativeOutboxTarget(this.#target, this.#store);
		} catch {
			refuse("UNAVAILABLE");
		}
	}
	#record(db: SqlReader, id: string, owner: string, epoch: number): SendTargetRecord {
		let raw: SendTargetRecord | undefined;
		try {
			raw = readNativeOutboxTarget(this.#target, db, id);
		} catch {
			refuse("STALE");
		}
		if (!raw) refuse("NOT_FOUND");
		try {
			const value = dataCopy(raw) as SendTargetRecord;
			const snapshot = CurrentSendSnapshotV1.parse(value.snapshot),
				flags = Flags.parse(value.flags);
			const users = value.requiredUsers;
			if (
				!Ulid.safeParse(value.id).success ||
				value.id !== id ||
				!Ulid.safeParse(value.accountId).success ||
				!Ulid.safeParse(value.draftId).success ||
				value.userId !== owner ||
				!Array.isArray(users) ||
				users.length < 1 ||
				users.length > 16 ||
				!users.every(
					(user, i) => Ulid.safeParse(user).success && (i === 0 || (users[i - 1] as string) < user),
				) ||
				!users.includes(owner) ||
				!Number.isSafeInteger(value.requiredApprovals) ||
				!Number.isSafeInteger(value.targetVersion) ||
				value.targetVersion < 1 ||
				value.requiredApprovals < 1 ||
				value.requiredApprovals > 16 ||
				!Number.isSafeInteger(value.undoWindowMs) ||
				value.undoWindowMs < 0 ||
				value.undoWindowMs > 30_000 ||
				!UtcMs.safeParse(value.expiresAt).success ||
				!DataClass.safeParse(value.dataClass).success ||
				snapshot.hub !== this.#hub ||
				snapshot.epoch !== epoch ||
				snapshot.outbox !== id ||
				snapshot.account !== value.accountId ||
				snapshot.source.draft !== value.draftId ||
				contentHash(snapshot) !== value.contentHash ||
				flagsHash(flags) !== value.flagsHash
			)
				refuse("STALE");
			this.#review(value);
			return value;
		} catch {
			refuse("STALE");
		}
	}
	#review(record: SendTargetRecord): SendReview {
		const review = SendReview.parse({
			id: record.id,
			snapshot: record.snapshot,
			contentHash: record.contentHash,
			flags: record.flags,
			flagsHash: record.flagsHash,
			state: record.state,
			stateReason: record.stateReason,
			requiredUsers: record.requiredUsers,
			expiresAt: record.expiresAt,
		});
		if (!checkRouteResponse("send-review", review)) refuse("STALE");
		return review;
	}
	review(peer: NativeDevicePeer, outboxId: string): SendReview {
		this.#active();
		if (!Ulid.safeParse(outboxId).success) refuse("INVALID_REQUEST");
		return guard(
			() =>
				this.#write((db: SqlTransaction) => {
					requireRoute.call(this.#authorizer, db, peer, "send-review");
					const state = registryState.call(this.#registry, db);
					if (state.ownerUserId === null) refuse("UNAVAILABLE");
					return dataCopy(
						this.#review(this.#record(db, outboxId, state.ownerUserId, state.epoch)),
					) as SendReview;
				}) as SendReview,
		);
	}
	#prepare(
		db: SqlReader,
		context: SendIssueContext,
		id: string,
		flagsAcked: readonly FlagCode[],
		duplicate: boolean,
	): SendPrepared {
		this.#active();
		assertGrant.call(this.#authorizer, db, context.grant);
		const record = this.#record(db, id, context.owner, context.epoch),
			now = context.now.wall;
		if (record.state !== "PENDING_APPROVAL" || record.expiresAt <= now) refuse("STALE");
		if (!requiredAckCodes(record.flags).every((code) => flagsAcked.includes(code)))
			refuse("ACK_REQUIRED");
		// The target separately proves the D193 pending freeze. This guard names later live states.
		if (isNativeOutboxDraftLocked(this.#target, db, record.draftId)) refuse("DRAFT_LOCKED");
		const window = sendWindow(record.snapshot, now);
		const facts: VerifiedSendApprovalFacts = {
			approvalId: id,
			outboxId: id,
			challengeId: id,
			userId: context.grant.userId,
			deviceId: context.grant.deviceId,
			hub: context.hub,
			epoch: context.epoch,
			contentHash: record.contentHash,
			flagsHash: record.flagsHash,
			flagsAcked,
			targetVersion: record.targetVersion,
			iat: now,
			notBefore: window.notBefore ?? null,
			deliverBy: window.deliverBy,
			approvedAt: now,
		};
		if (
			duplicate &&
			this.#rows
				.current(db, facts)
				.some(
					(approval) =>
						approval.userId === context.grant.userId &&
						(approval.notBefore !== null || approval.deliverBy >= now + record.undoWindowMs),
				)
		)
			refuse("STALE");
		const schedule = record.snapshot.schedule;
		if (schedule.kind === "at") {
			if (now + record.undoWindowMs > schedule.notBefore || schedule.notBefore > now + HORIZON_MS)
				refuse("STALE");
			let local: string;
			try {
				local = renderLocalWallTime(schedule.notBefore, schedule.zone);
			} catch (error) {
				if (error instanceof ScheduleError && error.code === "SCHEDULING_UNAVAILABLE")
					refuse("SCHEDULING_UNAVAILABLE");
				refuse("STALE");
			}
			if (local !== schedule.localWallTime) refuse("LOCAL_TIME_MISMATCH");
			const count = countNativeOutboxScheduled(this.#target, db, record.accountId, id);
			if (!Number.isSafeInteger(count) || count < 0) refuse("UNAVAILABLE");
			if (count >= 100) refuse("SCHEDULE_LIMIT");
		}
		assertGrant.call(this.#authorizer, db, context.grant);
		return Object.freeze({
			fields: Object.freeze({
				outbox: id,
				contentHash: record.contentHash,
				flagsHash: record.flagsHash,
				flagsAcked,
				notBefore: window.notBefore ?? null,
				deliverBy: window.deliverBy,
			}),
			dataClass: record.dataClass,
			targetVersion: record.targetVersion,
		});
	}
	prepareSend(
		tx: SqlTransaction,
		context: SendIssueContext,
		request: { readonly id: string; readonly flagsAcked: readonly FlagCode[] },
	): SendPrepared {
		assertChallengeContext(context, "issue", this.#store, tx);
		assertStoreTransaction(this.#store, tx);
		return this.#prepare(tx, context, request.id, request.flagsAcked, true);
	}
	async gateSend(context: SendAcceptContext): Promise<void> {
		assertChallengeContext(context, "accept", this.#store);
		this.#active();
		const record = this.#write((db: SqlTransaction) =>
			this.#record(db, context.statement.outbox, context.owner, context.epoch),
		) as SendTargetRecord;
		if (record.targetVersion !== context.targetVersion) refuse("STALE");
		const input = dataCopy({
			phase: "propose",
			snapshot: record.snapshot,
			flags: record.flags,
			userId: record.userId,
			accountId: record.accountId,
		}) as SendApprovalPolicyInput;
		try {
			const policy = plainRecord(this.#policy, ["id", "evaluate"]);
			if (!policy) refuse("POLICY_DENIED");
			const evaluate = policy.evaluate;
			if (typeof evaluate !== "function" || types.isProxy(evaluate)) refuse("POLICY_DENIED");
			const settled = await settleWithin(
				() => evaluate.call(this.#policy, input),
				SEND_POLICY_DEADLINE_MS,
				this.#clock,
			);
			if (!settled) refuse("POLICY_DENIED");
			const result = dataCopy(settled.value);
			const value = plainRecord(result, ["kind", "approvals"], ["users", "roles"]);
			if (
				value?.kind !== "require" ||
				!Number.isSafeInteger(value.approvals) ||
				(value.approvals as number) < 1 ||
				(value.approvals as number) > record.requiredApprovals
			)
				refuse("POLICY_DENIED");
			if (value.roles !== undefined && (!Array.isArray(value.roles) || value.roles.length !== 0))
				refuse("POLICY_DENIED");
			if (
				value.users !== undefined &&
				(!Array.isArray(value.users) ||
					value.users.length > 16 ||
					new Set(value.users).size !== value.users.length ||
					!value.users.every(
						(user) => typeof user === "string" && record.requiredUsers.includes(user),
					))
			)
				refuse("POLICY_DENIED");
			this.#active();
			assertChallengeContext(context, "accept", this.#store);
		} catch {
			refuse("POLICY_DENIED");
		}
	}
	writeSend<T>(work: (tx: SqlTransaction, scope: SendTargetScope) => T): T {
		return this.#write(work);
	}
	#write<T>(work: (tx: SqlTransaction, scope: SendTargetScope) => T): T {
		this.#active();
		if (typeof work !== "function" || types.isProxy(work) || types.isAsyncFunction(work))
			refuse("UNAVAILABLE");
		let callbackFailed = false,
			callbackFailure: unknown;
		try {
			return writeNativeOutboxTarget(this.#target, (tx, scope) => {
				assertStoreTransaction(this.#store, tx);
				assertNativeOutboxScope(this.#target, tx, scope);
				try {
					return work(tx, scope);
				} catch (error) {
					callbackFailed = true;
					callbackFailure = error;
					try {
						abortNativeOutboxScope(this.#target, scope);
					} catch {
						/* The callback still throws through the native writer. */
					}
					throw error;
				}
			}) as T;
		} catch (error) {
			// Preserve the device refusal only after the native writer has rolled back.
			throw callbackFailed ? callbackFailure : error;
		}
	}
	applySend(tx: SqlTransaction, scope: SendTargetScope, context: SendAcceptContext): void {
		try {
			this.#apply(tx, scope, context);
		} catch (error) {
			try {
				abortNativeOutboxScope(this.#target, scope);
			} catch {
				/* Never make a failed operation committable. */
			}
			throw error;
		}
	}
	#apply(tx: SqlTransaction, scope: SendTargetScope, context: SendAcceptContext): void {
		assertChallengeContext(context, "accept", this.#store, tx, scope);
		assertStoreTransaction(this.#store, tx);
		const statement = context.statement;
		this.#prepare(tx, context, statement.outbox, statement.flagsAcked, true);
		const record = this.#record(tx, statement.outbox, context.owner, context.epoch);
		if (
			statement.hub !== context.hub ||
			statement.device !== context.grant.deviceId ||
			statement.epoch !== context.epoch ||
			statement.contentHash !== record.contentHash ||
			statement.flagsHash !== record.flagsHash ||
			context.targetVersion !== record.targetVersion ||
			!checkSendWindow(statement, record.snapshot)
		)
			refuse("STALE");
		if (!checkFlagsAcked(statement, record.flags)) refuse("ACK_REQUIRED");
		assertGrant.call(this.#authorizer, tx, context.grant);
		this.#rows.lapse(tx, record.id, context.now.wall, record.undoWindowMs, context.grant.deviceId);
		const facts: VerifiedSendApprovalFacts = Object.freeze({
			approvalId: newId(context.now.wall),
			outboxId: record.id,
			challengeId: context.challenge,
			userId: context.grant.userId,
			deviceId: context.grant.deviceId,
			hub: context.hub,
			epoch: context.epoch,
			contentHash: record.contentHash,
			flagsHash: record.flagsHash,
			flagsAcked: Object.freeze([...statement.flagsAcked]),
			targetVersion: record.targetVersion,
			iat: statement.iat,
			notBefore: statement.notBefore,
			deliverBy: statement.deliverBy,
			approvedAt: context.now.wall,
		});
		this.#rows.insert(tx, facts, record.accountId, record.dataClass);
		const proof = Object.freeze(Object.create(null)) as VerifiedSendApproval;
		const state: ProofState = {
			issuer: this,
			context,
			store: this.#store,
			tx,
			scope,
			target: this.#target,
			rows: this.#rows,
			approval: facts,
			consumed: false,
		};
		proofs.set(proof, state);
		try {
			const result: SendApplyResult = applyNativeOutboxTarget(this.#target, scope, proof);
			this.#active();
			assertChallengeContext(context, "accept", this.#store, tx, scope);
			if (
				!state.consumed ||
				(result !== "pending" &&
					result !== (record.snapshot.schedule.kind === "now" ? "approved" : "scheduled"))
			)
				refuse("UNAVAILABLE");
		} finally {
			proofs.delete(proof);
		}
	}
	lock(): void {
		this.#locked = true;
	}
}

// Bind cross-module calls only after this module's class is initialized.
const assertVerifierActive = SendApprovalVerifier.prototype.assertActive;
const prepareOriginal = SendApprovalVerifier.prototype.prepareSend;
const gateOriginal = SendApprovalVerifier.prototype.gateSend;
const writeOriginal = SendApprovalVerifier.prototype.writeSend;
const applyOriginal = SendApprovalVerifier.prototype.applySend;
export function prepareSendApproval(
	value: SendApprovalVerifier,
	tx: SqlTransaction,
	context: SendIssueContext,
	request: { readonly id: string; readonly flagsAcked: readonly FlagCode[] },
): SendPrepared {
	return prepareOriginal.call(value, tx, context, request);
}
export function gateSendApproval(
	value: SendApprovalVerifier,
	context: SendAcceptContext,
): Promise<void> {
	return gateOriginal.call(value, context);
}
export function writeSendApproval<T>(
	value: SendApprovalVerifier,
	work: (tx: SqlTransaction, scope: SendTargetScope) => T,
): T {
	return writeOriginal.call(value, work) as T;
}
export function applySendApproval(
	value: SendApprovalVerifier,
	tx: SqlTransaction,
	scope: SendTargetScope,
	context: SendAcceptContext,
): void {
	applyOriginal.call(value, tx, scope, context);
}
