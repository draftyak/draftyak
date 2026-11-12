import { randomBytes, timingSafeEqual } from "node:crypto";
import { fileURLToPath } from "node:url";
import { types } from "node:util";
import { DataClass } from "@draftyak/protocol/data-class";
import {
	type Accepted,
	Challenge,
	ChallengeRequest,
	decodeDeviceStatement,
	type OperationReview,
	SignedEnvelope,
} from "@draftyak/protocol/device-api";
import type { FlagCode } from "@draftyak/protocol/flags";
import { canonicalize } from "@draftyak/protocol/jcs";
import { fromBase64Url, toBase64Url, Ulid } from "@draftyak/protocol/scalars";
import {
	isFresh,
	openTypedStatement,
	parseStatement,
	STATEMENT_TTL_MS,
} from "@draftyak/protocol/statements";
import type { AdminStatement } from "@draftyak/protocol/statements/admin";
import type { PairConfirmStatement } from "@draftyak/protocol/statements/pair-confirm";
import type { SendStatement } from "@draftyak/protocol/statements/send";
import { AuditChain } from "../audit/chain.ts";
import { Authorizer, assertAuthorizerStore } from "../authz/authorizer.ts";
import { plainRecord } from "../authz/decide.ts";
import type { NativeDevicePeer } from "../authz/native-peer.ts";
import { pairConfirmPinScope } from "../authz/scopes.ts";
import type { WorkScope } from "../jobs/database.ts";
import { type Clock, systemClock } from "../kernel/clock.ts";
import { newId } from "../kernel/ids.ts";
import {
	applySendApproval,
	assertSendApprovalVerifier,
	gateSendApproval,
	prepareSendApproval,
	type SendApprovalVerifier,
	writeSendApproval,
} from "../outbox/verifier.ts";
import type { SendTargetScope } from "../outbox/verifier-types.ts";
import {
	assertStoreTransaction,
	HubStore,
	type SqlReader,
	type SqlTransaction,
} from "../store/store.ts";
import {
	type AccountModePrepared,
	abortNativeAdminScope,
	applyNativeAdminOperation,
	assertNativeAdminOperations,
	assertNativeAdminScope,
	type NativeAccountModeOperations,
	ownsNativeAdminOperation,
	prepareNativeAdminOperation,
	writeNativeAdminOperations,
} from "./admin-operations.ts";
import {
	abortNativeBackupScope,
	applyNativeBackupOperation,
	assertNativeBackupOperations,
	assertNativeBackupScope,
	type BackupPrepared,
	type NativeBackupOperations,
	ownsNativeBackupOperation,
	prepareNativeBackupOperation,
	writeNativeBackupOperations,
} from "./backup-operations.ts";
import {
	ADMIN_CHALLENGE_SQL,
	type AdminAcceptContext,
	type AdminAcceptedFacts,
	adminOperationPinScope,
	BACKUP_CHALLENGE_SQL,
	backupOperationPinScope,
} from "./challenges-admin.ts";
import { PairConfirmOperations } from "./challenges-pair-confirm.ts";
import {
	type ChallengeError,
	type ClockSample,
	dataCopy,
	failure,
	guard,
	refuse,
	sample,
} from "./challenges-support.ts";
import { type DeviceGrant, DeviceRegistry } from "./devices.ts";
import type { HubIdentity } from "./hub-key.ts";
import { type PinProof, PinService } from "./pin.ts";

export { PAIR_CONFIRM_OPERATION_TTL_MS } from "./challenges-pair-confirm.ts";
export { ChallengeError, type ChallengeErrorCode, type ClockSample } from "./challenges-support.ts";
export const CHALLENGE_MIGRATIONS: string = fileURLToPath(
	new URL(
		import.meta.url.endsWith(".ts")
			? "./challenges-migrations/"
			: "./identity/challenges-migrations/",
		import.meta.url,
	),
);
export const CHALLENGE_TTL_MS: number = STATEMENT_TTL_MS;
export const MAX_OPEN_CHALLENGES = 256;
export const MAX_DEVICE_CHALLENGES = 16;
export type StatementKindDisposition = "accepted" | "postponed" | "unavailable";
export const STATEMENT_KIND_DISPOSITIONS: Readonly<Record<string, StatementKindDisposition>> =
	Object.freeze(
		Object.assign(Object.create(null), {
			"approval.send.v1": "accepted",
			"pair-confirm.v1": "accepted",
			"admin.v1": "unavailable",
			"login.v1": "postponed",
			"send-receipt.v1": "postponed",
			"hub-key-rotate.v1": "unavailable",
			"consent.v1": "unavailable",
			"agent-session.v1": "postponed",
		}),
	);
export function statementKindDisposition(kind: unknown): StatementKindDisposition {
	return typeof kind === "string" && Object.hasOwn(STATEMENT_KIND_DISPOSITIONS, kind)
		? (STATEMENT_KIND_DISPOSITIONS[kind] ?? "unavailable")
		: "unavailable";
}
export function sendApprovalPinScope(nonce: string): string {
	const bytes = typeof nonce === "string" && nonce.length === 22 ? fromBase64Url(nonce) : undefined;
	if (bytes?.length !== 16) refuse("CHALLENGE_INVALID");
	return `outbox.send-approval:${Buffer.from(bytes).toString("hex")}`;
}
export interface SendStatementFields {
	readonly outbox: string;
	readonly contentHash: string;
	readonly flagsHash: string;
	readonly flagsAcked: readonly FlagCode[];
	readonly notBefore: number | null;
	readonly deliverBy: number;
}
export interface SendPrepared {
	readonly fields: SendStatementFields;
	readonly dataClass: string;
	readonly targetVersion: number;
}
export interface SendIssueContext {
	readonly grant: DeviceGrant;
	readonly hub: string;
	readonly epoch: number;
	readonly owner: string;
	readonly now: ClockSample;
}
export interface SendAcceptContext extends SendIssueContext {
	readonly statement: SendStatement;
	readonly challenge: string;
	readonly targetVersion: number;
}
export type SendApprovalHandler = Pick<
	SendApprovalVerifier,
	"prepareSend" | "gateSend" | "writeSend" | "applySend"
>;
const contexts = new WeakMap<
	object,
	{
		kind: "issue" | "accept";
		store: HubStore;
		issuer: object;
		tx?: SqlTransaction;
		scope?: SendTargetScope;
	}
>();
const services = new WeakMap<object, { active: boolean }>();
/** Internal brand: structural contexts cannot drive the native verifier. */
export function assertChallengeContext(
	value: unknown,
	kind: "issue" | "accept",
	store: HubStore,
	tx?: SqlTransaction,
	scope?: SendTargetScope,
): void {
	if (value === null || typeof value !== "object" || types.isProxy(value)) refuse("UNAVAILABLE");
	const context = contexts.get(value);
	if (
		!context ||
		context.kind !== kind ||
		context.store !== store ||
		!services.get(context.issuer)?.active ||
		coordinators.get(store) !== context.issuer ||
		context.tx !== tx ||
		context.scope !== scope
	)
		refuse("UNAVAILABLE");
	if (tx) assertStoreTransaction(store, tx);
}
type NativeAdminIssuer = NativeAccountModeOperations | NativeBackupOperations;

interface OpenChallenge {
	readonly id: string;
	readonly nonce: string;
	readonly kind: "approval.send.v1" | "pair-confirm.v1" | "admin.v1";
	readonly target: string;
	readonly device: string;
	readonly user: string;
	readonly epoch: number;
	readonly dataClass: string;
	readonly targetVersion: number | null;
	readonly admin?: NativeAdminIssuer;
	readonly bytes: Buffer;
	readonly wall: number;
	readonly mono: number;
	readonly expires: number;
	busy: boolean;
}
const coordinators = new WeakMap<HubStore, object>();
interface AdminContextState {
	readonly service: object;
	readonly admin: NativeAdminIssuer;
	readonly issuerKind: "account" | "backup";
	readonly store: HubStore;
	readonly tx: SqlTransaction;
	readonly scope: WorkScope;
	readonly facts: AdminAcceptedFacts;
	consumed: boolean;
}
const adminContexts = new WeakMap<object, AdminContextState>();
/** Internal consumption only: no caller can register or mint an accepted admin context. */
export function consumeAdminChallengeContext(
	value: AdminAcceptContext,
	issuer: unknown,
	tx: SqlTransaction,
	scope: WorkScope,
): AdminAcceptedFacts {
	if (value === null || typeof value !== "object" || types.isProxy(value)) refuse("UNAVAILABLE");
	const state = adminContexts.get(value);
	adminContexts.delete(value);
	if (
		!state ||
		state.consumed ||
		state.admin !== issuer ||
		state.tx !== tx ||
		state.scope !== scope ||
		!services.get(state.service)?.active ||
		coordinators.get(state.store) !== state.service
	)
		refuse("UNAVAILABLE");
	assertStoreTransaction(state.store, tx);
	if (state.issuerKind === "backup") {
		assertNativeBackupOperations(issuer, state.store);
		assertNativeBackupScope(issuer, tx, scope);
	} else {
		assertNativeAdminOperations(issuer, state.store);
		assertNativeAdminScope(issuer, tx, scope);
	}
	state.consumed = true;
	return state.facts;
}
const equalBytes = (left: Buffer, right: Buffer): boolean =>
	left.length === right.length && timingSafeEqual(left, right);
const read = HubStore.prototype.read,
	write = HubStore.prototype.write;
const registryStore = DeviceRegistry.prototype.assertStore,
	registryIdentity = DeviceRegistry.prototype.assertIdentity;
const _state = DeviceRegistry.prototype.state;
const requireRoute = Authorizer.prototype.requirePeerRoute,
	requireKind = Authorizer.prototype.requirePeerKind;
const assertGrant = Authorizer.prototype.assertCurrentGrant;
const append = AuditChain.prototype.append,
	verifyAudit = AuditChain.prototype.verify;
const verifyPin = PinService.prototype.verify,
	consumePin = PinService.prototype.consume,
	discardPin = PinService.prototype.discard;
const CHALLENGE_SQL = `SELECT CASE WHEN typeof(id)='text' AND length(CAST(id AS BLOB))=26 THEN id END AS id,
 CASE WHEN typeof(nonce)='text' AND length(CAST(nonce AS BLOB))=22 THEN nonce END AS nonce,
 CASE WHEN kind IN ('approval.send.v1','pair-confirm.v1') THEN kind END AS kind,
 CASE WHEN typeof(target_id)='text' AND length(CAST(target_id AS BLOB))=26 THEN target_id END AS target,
 CASE WHEN typeof(device_id)='text' AND length(CAST(device_id AS BLOB))=26 THEN device_id END AS device,
 CASE WHEN typeof(user_id)='text' AND length(CAST(user_id AS BLOB))=26 THEN user_id END AS user,
 CASE WHEN typeof(data_class)='text' AND length(CAST(data_class AS BLOB)) BETWEEN 1 AND 64 THEN data_class END AS dataClass,
 CASE WHEN typeof(epoch)='integer' THEN epoch END AS epoch,
 CASE WHEN typeof(statement)='blob' AND length(statement) BETWEEN 1 AND 16384 THEN statement END AS bytes,
 CASE WHEN typeof(issued_at)='integer' THEN issued_at END AS wall,
 CASE WHEN typeof(expires_at)='integer' THEN expires_at END AS expires,
 target_version AS targetVersion,consumed_at,burned_at,signature FROM main.approval_challenges WHERE id=?`;

export interface ChallengeServiceOptions {
	readonly identity: HubIdentity;
	readonly clock?: Clock;
	readonly send: SendApprovalVerifier;
	/** The genuine same-store native account-mode issuer. */
	readonly admin?: NativeAccountModeOperations;
	/** A genuine same-store backup issuer; no structural target or callback is accepted. */
	readonly backup?: NativeBackupOperations;
	/** Native composition data only. Absent retained SAS makes pairing review unavailable. */
	readonly pairConfirmSas?: (candidateId: string) => string | undefined;
}
export class ChallengeService {
	readonly #store: HubStore;
	readonly #audit: AuditChain;
	readonly #pins: PinService;
	readonly #registry: DeviceRegistry;
	readonly #authorizer: Authorizer;
	readonly #send: SendApprovalVerifier;
	readonly #admin: NativeAccountModeOperations | undefined;
	readonly #backup: NativeBackupOperations | undefined;
	readonly #clock: Clock;
	readonly #hub: string;
	readonly #open: Map<string, OpenChallenge>;
	readonly #pair: PairConfirmOperations;
	#locked = false;
	constructor(
		store: HubStore,
		audit: AuditChain,
		pins: PinService,
		registry: DeviceRegistry,
		authorizer: Authorizer,
		options: ChallengeServiceOptions,
	) {
		const settings = plainRecord(
			options,
			["identity", "send"],
			["clock", "pairConfirmSas", "admin", "backup"],
		) as unknown as ChallengeServiceOptions | undefined;
		if (!settings) refuse("UNAVAILABLE");
		guard(() => {
			if (types.isProxy(store) || types.isProxy(audit) || types.isProxy(pins))
				refuse("UNAVAILABLE");
			registryStore.call(registry, store);
			registryIdentity.call(registry, settings.identity);
			assertAuthorizerStore(authorizer, store);
			assertSendApprovalVerifier(settings.send, store);
			if (settings.admin !== undefined) assertNativeAdminOperations(settings.admin, store);
			if (settings.backup !== undefined) assertNativeBackupOperations(settings.backup, store);
			discardPin.call(pins, Object.freeze(Object.create(null)));
			read.call(store, (db: SqlReader) => verifyAudit.call(audit, db));
		});
		this.#store = store;
		this.#audit = audit;
		this.#pins = pins;
		this.#registry = registry;
		this.#authorizer = authorizer;
		this.#send = settings.send;
		this.#admin = settings.admin;
		this.#backup = settings.backup;
		this.#clock = settings.clock ?? systemClock;
		this.#hub = settings.identity.hid;
		if (
			settings.pairConfirmSas !== undefined &&
			(typeof settings.pairConfirmSas !== "function" || types.isProxy(settings.pairConfirmSas))
		)
			refuse("UNAVAILABLE");
		this.#open = new Map();
		this.#pair = new PairConfirmOperations(
			store,
			audit,
			registry,
			authorizer,
			this.#clock,
			settings.pairConfirmSas,
		);
		coordinators.set(store, this);
		services.set(this, { active: true });
	}
	#ready(): void {
		if (this.#locked || coordinators.get(this.#store) !== this) refuse("UNAVAILABLE");
		registryStore.call(this.#registry, this.#store);
	}
	#accepted(kind: unknown): boolean {
		return kind === "admin.v1"
			? this.#admin !== undefined || this.#backup !== undefined
			: statementKindDisposition(kind) === "accepted";
	}
	#isBackupIssuer(issuer: NativeAdminIssuer): boolean {
		if (this.#backup !== undefined && issuer === this.#backup) return true;
		if (this.#admin !== undefined && issuer === this.#admin) return false;
		return refuse("UNAVAILABLE");
	}
	#ownedAdmin(operationId: string): NativeAdminIssuer {
		const account = this.#admin !== undefined && ownsNativeAdminOperation(this.#admin, operationId);
		const backup =
			this.#backup !== undefined && ownsNativeBackupOperation(this.#backup, operationId);
		if (account && backup) refuse("UNAVAILABLE");
		if (backup && this.#backup) return this.#backup;
		if (account && this.#admin) return this.#admin;
		return refuse("STALE");
	}
	#heldAdmin(item: OpenChallenge): NativeAdminIssuer {
		if (item.kind !== "admin.v1" || item.admin === undefined) refuse("UNAVAILABLE");
		this.#isBackupIssuer(item.admin);
		return item.admin;
	}
	#challengeTable(item: OpenChallenge): string {
		if (item.kind !== "admin.v1") return "main.approval_challenges";
		return this.#isBackupIssuer(this.#heldAdmin(item))
			? "main.native_backup_challenges"
			: "main.native_admin_challenges";
	}
	#adminPinScope(item: OpenChallenge, nonce: string): string {
		return this.#isBackupIssuer(this.#heldAdmin(item))
			? backupOperationPinScope(item.target, nonce)
			: adminOperationPinScope(item.target, nonce);
	}
	#assertAdminScope(issuer: NativeAdminIssuer, tx: SqlTransaction, scope: WorkScope): void {
		if (this.#isBackupIssuer(issuer)) assertNativeBackupScope(issuer, tx, scope);
		else assertNativeAdminScope(issuer, tx, scope);
	}
	#prepareAdmin(
		issuer: NativeAdminIssuer,
		tx: SqlTransaction,
		scope: WorkScope,
		peer: NativeDevicePeer,
		operationId: string,
	): AccountModePrepared | BackupPrepared {
		return this.#isBackupIssuer(issuer)
			? prepareNativeBackupOperation(issuer, tx, scope, peer, operationId)
			: prepareNativeAdminOperation(issuer, tx, scope, peer, operationId);
	}
	#applyAdmin(
		issuer: NativeAdminIssuer,
		tx: SqlTransaction,
		scope: WorkScope,
		context: AdminAcceptContext,
	): void {
		if (this.#isBackupIssuer(issuer)) applyNativeBackupOperation(issuer, tx, scope, context);
		else applyNativeAdminOperation(issuer, tx, scope, context);
	}
	#writeAdmin<T>(issuer: NativeAdminIssuer, work: (tx: SqlTransaction, scope: WorkScope) => T): T {
		const backup = this.#isBackupIssuer(issuer);
		let callbackFailed = false;
		let callbackFailure: unknown;
		try {
			const perform = (tx: SqlTransaction, scope: WorkScope): T => {
				try {
					return work(tx, scope);
				} catch (error) {
					callbackFailed = true;
					callbackFailure = error;
					try {
						if (backup) abortNativeBackupScope(issuer, scope);
						else abortNativeAdminScope(issuer, scope);
					} catch {
						/* The refusal still throws through the genuine native writer. */
					}
					throw error;
				}
			};
			return backup
				? writeNativeBackupOperations(issuer, perform)
				: writeNativeAdminOperations(issuer, perform);
		} catch (error) {
			// Preserve the refusal only after the native writer has exited and rolled back.
			throw callbackFailed ? callbackFailure : error;
		}
	}
	#adminContext(
		peer: NativeDevicePeer,
		grant: DeviceGrant,
		now: ClockSample,
		statement: AdminStatement,
		item: OpenChallenge,
		tx: SqlTransaction,
		scope: WorkScope,
	): { context: AdminAcceptContext; state: AdminContextState } {
		const admin = this.#heldAdmin(item);
		const context = Object.freeze(Object.create(null)) as AdminAcceptContext;
		const facts: AdminAcceptedFacts = Object.freeze({
			statement: Object.freeze({ ...statement }),
			peer,
			operationVersion: item.targetVersion ?? refuse("CHALLENGE_INVALID"),
			owner: grant.ownerUserId,
			epoch: grant.epoch,
			deviceId: grant.deviceId,
			approvalKey: grant.approvalKey,
			now,
			challengeId: item.id,
		});
		const state: AdminContextState = {
			service: this,
			admin,
			issuerKind: this.#isBackupIssuer(admin) ? "backup" : "account",
			store: this.#store,
			tx,
			scope,
			facts,
			consumed: false,
		};
		adminContexts.set(context, state);
		return { context, state };
	}
	#context(
		grant: DeviceGrant,
		now: ClockSample,
		statement?: SendStatement,
		challenge?: string,
		targetVersion?: number,
		tx?: SqlTransaction,
		scope?: SendTargetScope,
	): SendIssueContext | SendAcceptContext {
		const base = { grant, hub: this.#hub, epoch: grant.epoch, owner: grant.ownerUserId, now };
		const context = Object.freeze(
			statement
				? {
						...base,
						statement,
						challenge: challenge ?? refuse("UNAVAILABLE"),
						targetVersion: targetVersion ?? refuse("UNAVAILABLE"),
					}
				: base,
		);
		contexts.set(context, {
			kind: statement ? "accept" : "issue",
			store: this.#store,
			issuer: this,
			tx,
			scope,
		});
		return context;
	}
	openPairConfirmation(peer: NativeDevicePeer, request: unknown): { id: string } {
		this.#ready();
		return this.#pair.open(peer, request);
	}
	reviewPairConfirmation(peer: NativeDevicePeer, id: string): OperationReview {
		this.#ready();
		if (!Ulid.safeParse(id).success) refuse("INVALID_REQUEST");
		return this.#pair.review(peer, id);
	}
	issue(peer: NativeDevicePeer, raw: unknown): Challenge {
		if (raw !== null && typeof raw === "object" && !types.isProxy(raw)) {
			const kind = Object.getOwnPropertyDescriptor(raw, "kind");
			if (kind && "value" in kind && !this.#accepted(kind.value)) refuse("KIND_UNAVAILABLE");
		}
		this.#ready();
		const record = plainRecord(raw, ["kind", "id"], ["flagsAcked"]);
		if (!record) refuse("INVALID_REQUEST");
		if (!this.#accepted(record.kind)) refuse("KIND_UNAVAILABLE");
		const parsed = ChallengeRequest.safeParse(dataCopy(record));
		if (!parsed.success) refuse("INVALID_REQUEST");
		const request = parsed.data;
		if (
			request.kind !== "approval.send.v1" &&
			request.kind !== "pair-confirm.v1" &&
			request.kind !== "admin.v1"
		)
			refuse("KIND_UNAVAILABLE");
		const now = guard(() => sample(this.#clock));
		const adminIssuer =
			request.kind === "admin.v1" ? guard(() => this.#ownedAdmin(request.id)) : undefined;
		for (const [nonce, item] of this.#open)
			if (now.mono < item.mono || now.mono - item.mono > CHALLENGE_TTL_MS) this.#open.delete(nonce);
		const old: OpenChallenge[] = [];
		const writeChallenge = (
			work: (tx: SqlTransaction, scope?: WorkScope) => OpenChallenge,
		): OpenChallenge =>
			request.kind === "approval.send.v1"
				? writeSendApproval(this.#send, (tx) => work(tx))
				: request.kind === "admin.v1"
					? this.#writeAdmin(adminIssuer ?? refuse("UNAVAILABLE"), work)
					: (write.call(this.#store, work) as OpenChallenge);
		const opened = guard(
			() =>
				writeChallenge((tx: SqlTransaction, scope?: WorkScope) => {
					this.#ready();
					if (request.kind === "admin.v1")
						this.#assertAdminScope(
							adminIssuer ?? refuse("UNAVAILABLE"),
							tx,
							scope ?? refuse("UNAVAILABLE"),
						);
					const adminPrepared =
						request.kind === "admin.v1"
							? this.#prepareAdmin(
									adminIssuer ?? refuse("UNAVAILABLE"),
									tx,
									scope ?? refuse("UNAVAILABLE"),
									peer,
									request.id,
								)
							: undefined;
					// Pair route policy needs the native operation's preset, checked by prepare below.
					if (request.kind === "approval.send.v1" || request.kind === "admin.v1")
						requireRoute.call(this.#authorizer, tx, peer, "challenge", { kind: request.kind });
					const grant = requireKind.call(this.#authorizer, tx, peer, request.kind);
					const deviceOpen = [...this.#open.values()].filter(
						(item) => item.device === grant.deviceId,
					);
					const replacing = deviceOpen.some(
						(item) => item.kind === request.kind && item.target === request.id,
					)
						? 1
						: 0;
					if (
						this.#open.size - replacing >= MAX_OPEN_CHALLENGES ||
						deviceOpen.length - replacing >= MAX_DEVICE_CHALLENGES
					)
						refuse("UNAVAILABLE");
					const base = {
						v: 1 as const,
						hub: this.#hub,
						epoch: grant.epoch,
						device: grant.deviceId,
						nonce: toBase64Url(randomBytes(16)),
						iat: now.wall,
						exp: now.wall + CHALLENGE_TTL_MS,
					};
					let fields: object;
					let dataClass: string;
					let targetVersion: number | null = null;
					if (request.kind === "approval.send.v1") {
						const context = this.#context(grant, now, undefined, undefined, undefined, tx);
						try {
							const prepared = prepareSendApproval(this.#send, tx, context, request);
							fields = prepared.fields;
							dataClass = prepared.dataClass;
							targetVersion = prepared.targetVersion;
						} finally {
							contexts.delete(context);
						}
					} else if (request.kind === "admin.v1") {
						const prepared = adminPrepared ?? refuse("UNAVAILABLE");
						const expectedKind = this.#isBackupIssuer(adminIssuer ?? refuse("UNAVAILABLE"))
							? "data.backup"
							: "account.mode-full";
						if (prepared.fields.op !== request.id || prepared.fields.kind !== expectedKind)
							refuse("UNAVAILABLE");
						fields = prepared.fields;
						dataClass = DataClass.parse(prepared.dataClass);
						targetVersion = prepared.operationVersion;
					} else {
						fields = this.#pair.prepare(tx, peer, request.id, now);
						dataClass = "hub.state";
					}
					const bytes = Buffer.from(canonicalize({ ...base, ...fields }));
					if (bytes.length > 16384 || !parseStatement(request.kind, bytes)) refuse("UNAVAILABLE");
					const item: OpenChallenge = {
						id: newId(now.wall),
						nonce: base.nonce,
						kind: request.kind,
						target: request.id,
						device: grant.deviceId,
						user: grant.userId,
						epoch: grant.epoch,
						dataClass,
						targetVersion,
						bytes,
						wall: now.wall,
						mono: now.mono,
						expires: base.exp,
						busy: false,
						...(adminIssuer === undefined ? {} : { admin: adminIssuer }),
					};
					for (const previous of this.#open.values())
						if (
							previous.device === item.device &&
							previous.kind === item.kind &&
							previous.target === item.target
						) {
							tx.run(
								`UPDATE ${this.#challengeTable(previous)} SET burned_at=? WHERE id=? AND consumed_at IS NULL AND burned_at IS NULL`,
								[now.wall, previous.id],
							);
							old.push(previous);
						}
					tx.run(
						`INSERT INTO ${this.#challengeTable(item)}(id,nonce,kind,target_id,device_id,user_id,data_class,epoch,statement,issued_at,expires_at,target_version) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`,
						[
							item.id,
							item.nonce,
							item.kind,
							item.target,
							item.device,
							item.user,
							item.dataClass,
							item.epoch,
							item.bytes,
							item.wall,
							item.expires,
							item.targetVersion,
						],
					);
					tx.run(
						`DELETE FROM ${this.#challengeTable(item)} WHERE id IN(SELECT id FROM ${this.#challengeTable(item)} WHERE consumed_at IS NULL AND burned_at IS NULL AND expires_at<? ORDER BY expires_at LIMIT 64)`,
						[Math.max(0, now.wall - 86_400_000)],
					);
					if (request.kind === "admin.v1") {
						const finalGrant = requireKind.call(this.#authorizer, tx, peer, request.kind);
						if (
							finalGrant.deviceId !== grant.deviceId ||
							finalGrant.userId !== grant.userId ||
							finalGrant.ownerUserId !== grant.ownerUserId ||
							finalGrant.epoch !== grant.epoch ||
							finalGrant.approvalKey !== grant.approvalKey
						)
							refuse("CHALLENGE_INVALID");
						assertGrant.call(this.#authorizer, tx, finalGrant);
						this.#checkTime(item, sample(this.#clock));
					}
					return item;
				}) as OpenChallenge,
		);
		for (const previous of old) this.#open.delete(previous.nonce);
		this.#open.set(opened.nonce, opened);
		return Challenge.parse({
			kind: opened.kind,
			id: opened.target,
			statement: toBase64Url(opened.bytes),
		});
	}
	#check(
		db: SqlReader,
		item: OpenChallenge,
		grant: DeviceGrant,
		bytes: Buffer,
		now: ClockSample,
	): void {
		const row = db.get<
			OpenChallenge & {
				consumed_at: number | null;
				burned_at: number | null;
				signature: string | null;
			}
		>(
			item.kind === "admin.v1"
				? this.#isBackupIssuer(this.#heldAdmin(item))
					? BACKUP_CHALLENGE_SQL
					: ADMIN_CHALLENGE_SQL
				: CHALLENGE_SQL,
			[item.id],
		);
		if (
			!row ||
			row.id !== item.id ||
			row.nonce !== item.nonce ||
			row.kind !== item.kind ||
			row.target !== item.target ||
			row.device !== item.device ||
			row.user !== item.user ||
			row.epoch !== item.epoch ||
			row.dataClass !== item.dataClass ||
			row.targetVersion !== item.targetVersion ||
			row.wall !== item.wall ||
			row.expires !== item.expires ||
			!Buffer.isBuffer(row.bytes) ||
			!equalBytes(row.bytes, item.bytes) ||
			!equalBytes(item.bytes, bytes) ||
			row.consumed_at !== null ||
			row.burned_at !== null ||
			row.signature !== null ||
			grant.deviceId !== item.device ||
			grant.userId !== item.user ||
			grant.epoch !== item.epoch
		)
			refuse("CHALLENGE_INVALID");
		this.#checkTime(item, now);
	}
	#checkTime(item: OpenChallenge, now: ClockSample): void {
		if (
			now.wall < item.wall ||
			now.wall > item.expires ||
			now.mono < item.mono ||
			now.mono - item.mono > CHALLENGE_TTL_MS
		)
			refuse("CHALLENGE_INVALID");
	}
	#burn(item: OpenChallenge, error: ChallengeError): void {
		// Retire first: failure to append the refusal cannot reopen the in-memory authority.
		this.#open.delete(item.nonce);
		guard(() =>
			write.call(this.#store, (tx: SqlTransaction) => {
				const now = sample(this.#clock);
				tx.run(
					`UPDATE ${this.#challengeTable(item)} SET burned_at=? WHERE id=? AND consumed_at IS NULL AND burned_at IS NULL`,
					[now.wall, item.id],
				);
				append.call(this.#audit, tx, {
					id: newId(now.wall),
					at: now.wall,
					action: `challenge.refused.${error.code.toLowerCase()}`,
					actor: { kind: "device", id: item.device },
					refs: { challenge: item.id },
				});
			}),
		);
	}
	async accept(peer: NativeDevicePeer, kind: string, raw: unknown): Promise<Accepted> {
		if (!this.#accepted(kind)) refuse("KIND_UNAVAILABLE");
		this.#ready();
		const envelope = SignedEnvelope.safeParse(dataCopy(raw));
		if (!envelope.success) refuse("INVALID_REQUEST");
		const bytes = Buffer.from(fromBase64Url(envelope.data.statement) ?? refuse("INVALID_REQUEST"));
		if (kind !== "approval.send.v1" && kind !== "pair-confirm.v1" && kind !== "admin.v1")
			refuse("KIND_UNAVAILABLE");
		if (!decodeDeviceStatement(kind, envelope.data.statement)) refuse("INVALID_REQUEST");
		const shape = parseStatement(kind, bytes);
		if (!shape) refuse("INVALID_REQUEST");
		let item: OpenChallenge | undefined;
		let pin: PinProof | undefined;
		let context: SendAcceptContext | undefined;
		try {
			const initial = guard(
				() =>
					read.call(this.#store, (db: SqlReader) => {
						const grant = requireKind.call(this.#authorizer, db, peer, kind);
						const candidate = this.#open.get(shape.nonce);
						if (!candidate || candidate.device !== grant.deviceId || candidate.kind !== kind)
							refuse("CHALLENGE_INVALID");
						if (candidate.busy) refuse("CHALLENGE_INVALID");
						const now = sample(this.#clock);
						this.#check(db, candidate, grant, bytes, now);
						item = candidate;
						candidate.busy = true;
						if (!openTypedStatement(kind, bytes, envelope.data.signature, grant.approvalKey))
							refuse("SIGNATURE_INVALID");
						if (!isFresh(shape, now.wall)) refuse("CHALLENGE_INVALID");
						assertGrant.call(this.#authorizer, db, grant);
						return { grant, now };
					}) as { grant: DeviceGrant; now: ClockSample },
			);
			const held = item ?? refuse("CHALLENGE_INVALID");
			pin = await verifyPin.call(
				this.#pins,
				initial.grant.userId,
				envelope.data.pin,
				kind === "approval.send.v1"
					? sendApprovalPinScope(shape.nonce)
					: kind === "admin.v1"
						? this.#adminPinScope(held, shape.nonce)
						: pairConfirmPinScope(shape.nonce),
			);
			this.#ready();
			if (kind === "approval.send.v1") {
				context = this.#context(
					initial.grant,
					initial.now,
					shape as SendStatement,
					held.id,
					held.targetVersion ?? refuse("CHALLENGE_INVALID"),
				) as SendAcceptContext;
				await gateSendApproval(this.#send, context);
				this.#ready();
			}
			const apply = (tx: SqlTransaction, scope?: SendTargetScope): Accepted => {
				this.#ready();
				assertStoreTransaction(this.#store, tx);
				if (kind === "admin.v1") {
					const liveScope = scope ?? refuse("UNAVAILABLE");
					const issuer = this.#heldAdmin(held);
					this.#assertAdminScope(issuer, tx, liveScope);
					requireKind.call(this.#authorizer, tx, peer, kind);
					const prepared = this.#prepareAdmin(issuer, tx, liveScope, peer, held.target);
					const statement = shape as AdminStatement;
					const expectedKind = this.#isBackupIssuer(issuer) ? "data.backup" : "account.mode-full";
					if (
						prepared.fields.op !== held.target ||
						prepared.fields.op !== statement.op ||
						prepared.fields.kind !== expectedKind ||
						prepared.fields.kind !== statement.kind ||
						prepared.fields.digest !== statement.digest ||
						prepared.operationVersion !== held.targetVersion ||
						DataClass.parse(prepared.dataClass) !== held.dataClass
					)
						refuse("STALE");
				}
				// Refresh native peer rights after asynchronous work and native scope preparation.
				const grant = requireKind.call(this.#authorizer, tx, peer, kind),
					now = sample(this.#clock);
				if (grant.approvalKey !== initial.grant.approvalKey || grant.epoch !== initial.grant.epoch)
					refuse("CHALLENGE_INVALID");
				this.#check(tx, held, grant, bytes, now);
				if (!openTypedStatement(kind, bytes, envelope.data.signature, grant.approvalKey))
					refuse("SIGNATURE_INVALID");
				assertGrant.call(this.#authorizer, tx, grant);
				if (kind === "approval.send.v1" || kind === "admin.v1")
					consumePin.call(
						this.#pins,
						tx,
						pin as PinProof,
						grant.userId,
						kind === "approval.send.v1"
							? sendApprovalPinScope(shape.nonce)
							: this.#adminPinScope(held, shape.nonce),
					);
				if (
					tx.run(
						`UPDATE ${this.#challengeTable(held)} SET consumed_at=?,signature=? WHERE id=? AND consumed_at IS NULL AND burned_at IS NULL`,
						[now.wall, envelope.data.signature, held.id],
					).changes !== 1
				)
					refuse("CHALLENGE_INVALID");
				if (kind === "approval.send.v1") {
					const current = this.#context(
						requireKind.call(this.#authorizer, tx, peer, kind),
						now,
						shape as SendStatement,
						held.id,
						held.targetVersion ?? refuse("CHALLENGE_INVALID"),
						tx,
						scope ?? refuse("UNAVAILABLE"),
					) as SendAcceptContext;
					try {
						applySendApproval(this.#send, tx, scope ?? refuse("UNAVAILABLE"), current);
					} finally {
						contexts.delete(current);
					}
				} else if (kind === "admin.v1") {
					const liveScope = scope ?? refuse("UNAVAILABLE");
					const accepted = this.#adminContext(
						peer,
						grant,
						now,
						shape as AdminStatement,
						held,
						tx,
						liveScope,
					);
					try {
						this.#applyAdmin(this.#heldAdmin(held), tx, liveScope, accepted.context);
						if (!accepted.state.consumed) refuse("UNAVAILABLE");
					} finally {
						adminContexts.delete(accepted.context);
					}
				} else
					this.#pair.apply(
						tx,
						peer,
						held.target,
						shape as PairConfirmStatement,
						bytes,
						envelope.data.signature,
						pin as PinProof,
						now,
					);
				// Native data work may consume time or change authority. Recheck before commit.
				this.#ready();
				const finalGrant = requireKind.call(this.#authorizer, tx, peer, kind);
				if (
					finalGrant.deviceId !== held.device ||
					finalGrant.userId !== held.user ||
					finalGrant.epoch !== held.epoch ||
					(kind === "admin.v1" && finalGrant.ownerUserId !== initial.grant.ownerUserId) ||
					finalGrant.approvalKey !== initial.grant.approvalKey
				)
					refuse("CHALLENGE_INVALID");
				if (!openTypedStatement(kind, bytes, envelope.data.signature, finalGrant.approvalKey))
					refuse("SIGNATURE_INVALID");
				assertGrant.call(this.#authorizer, tx, finalGrant);
				this.#checkTime(held, sample(this.#clock));
				assertGrant.call(this.#authorizer, tx, finalGrant);
				return Object.freeze({ kind, id: held.target });
			};
			const result =
				kind === "approval.send.v1"
					? writeSendApproval(this.#send, (tx, scope) => apply(tx, scope))
					: kind === "admin.v1"
						? this.#writeAdmin(this.#heldAdmin(held), (tx, scope) => apply(tx, scope))
						: (write.call(this.#store, (tx: SqlTransaction) => apply(tx)) as Accepted);
			this.#open.delete(held.nonce);
			return result as Accepted;
		} catch (error) {
			const refusal = failure(error);
			const transient = refusal.wire === "UNAVAILABLE" || this.#locked;
			if (item && !transient)
				try {
					this.#burn(item, refusal);
				} catch {
					/* The original refusal remains authoritative. */
				}
			throw refusal;
		} finally {
			if (context) contexts.delete(context);
			if (pin) discardPin.call(this.#pins, pin);
			if (item) item.busy = false;
		}
	}
	lock(): void {
		this.#locked = true;
		const state = services.get(this);
		if (state) state.active = false;
		this.#open.clear();
	}
}

const originalChallengeMethods = Object.freeze({
	issue: ChallengeService.prototype.issue,
	accept: ChallengeService.prototype.accept,
	lock: ChallengeService.prototype.lock,
});
export function issueNativeChallenge(
	service: ChallengeService,
	peer: NativeDevicePeer,
	raw: unknown,
): Challenge {
	return originalChallengeMethods.issue.call(service, peer, raw);
}
export function acceptNativeChallenge(
	service: ChallengeService,
	peer: NativeDevicePeer,
	kind: string,
	raw: unknown,
): Promise<Accepted> {
	return originalChallengeMethods.accept.call(service, peer, kind, raw);
}
export function lockNativeChallenges(service: ChallengeService): void {
	originalChallengeMethods.lock.call(service);
}
