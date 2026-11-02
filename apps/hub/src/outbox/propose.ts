import { createHmac, timingSafeEqual } from "node:crypto";
import { fileURLToPath } from "node:url";
import { types } from "node:util";
import { DataClass } from "@draftyak/protocol/data-class";
import { SendReview } from "@draftyak/protocol/device-api";
import { OutboxState, StateReason } from "@draftyak/protocol/entities/outbox";
import { type Flag, Flags, flagsHash } from "@draftyak/protocol/flags";
import { canonicalize } from "@draftyak/protocol/jcs";
import { Sha256Hex } from "@draftyak/protocol/scalars";
import { renderLocalWallTime } from "@draftyak/protocol/schedule";
import { CurrentSendSnapshotV1, contentHash, sendWindow } from "@draftyak/protocol/snapshot";
import { AuditChain } from "../audit/chain.ts";
import { Authorizer, assertAuthorizerStore } from "../authz/authorizer.ts";
import type { NativeDevicePeer } from "../authz/native-peer.ts";
import { NativeDraftFreeze } from "../drafts/freeze.ts";
import {
	captureDraftBinding,
	captureDraftData,
	type DraftAppend,
	type DraftBinding,
	immutableDraftData,
	NativeDraftRevisions,
	type NativeRevision,
} from "../drafts/revisions.ts";
import { EventLog } from "../events/log.ts";
import { DeviceRegistry } from "../identity/devices.ts";
import type { HubIdentity } from "../identity/hub-key.ts";
import { WorkDatabase, type WorkScope } from "../jobs/database.ts";
import { fields, id, integer } from "../jobs/values.ts";
import { type Clock, systemClock } from "../kernel/clock.ts";
import { MasterKey } from "../kernel/master-key.ts";
import { readStamp } from "../store/read-stamp.ts";
import {
	assertStoreTransaction,
	HubStore,
	type SqlReader,
	type SqlTransaction,
} from "../store/store.ts";
import { ProposalError, refuseProposal as refused } from "./propose-errors.ts";
import { consumeVerifiedSendApproval } from "./verifier.ts";
import type {
	SendApplyResult,
	SendTargetRecord,
	StoredSendApproval,
	VerifiedSendApproval,
} from "./verifier-types.ts";

export { NativeOutboxError, ProposalError, type ProposalErrorCode } from "./propose-errors.ts";
export const OUTBOX_MIGRATIONS: string = fileURLToPath(
	new URL(
		import.meta.url.endsWith(".ts") ? "./propose-migrations/" : "./outbox/propose-migrations/",
		import.meta.url,
	),
);
export const NATIVE_OUTBOX_DEFAULT_UNDO_MS = 10_000;
export const NATIVE_OUTBOX_DEFAULT_TTL_MS = 86_400_000;
export interface NativeOutboxSettings {
	readonly undoWindowMs?: number;
	readonly requiredApprovals?: number;
	readonly requiredUsers?: readonly string[];
	readonly proposalTtlMs?: number;
}
/** Candidate data only. Native currentness and account/flag facts are independently required. */
export interface NativeProposalInput {
	readonly binding: DraftBinding;
	readonly expectedRev: number;
	readonly snapshot: CurrentSendSnapshotV1;
	readonly dataClass: string;
	readonly requiredApprovals: number;
	readonly requiredUsers: readonly string[];
	readonly undoWindowMs: number;
	readonly expiresAt: number;
}
export interface NativeProposalFacts {
	readonly accountId: string;
	readonly conversationId: string | null;
	readonly dataClass: string;
	readonly footer: string;
	readonly kind: "email" | "chat";
	readonly email?: {
		readonly from: string;
		readonly threadId?: string;
		readonly inReplyTo?: string;
		readonly references: readonly string[];
	};
	readonly chat?: Extract<CurrentSendSnapshotV1, { kind: "chat" }>["chat"];
}
/** Native composition supplies data, never rights or a substitute target/approval proof. */
export interface NativeProposalProviders {
	readonly facts: (
		tx: SqlTransaction,
		binding: DraftBinding,
		revision: NativeRevision,
	) => NativeProposalFacts | undefined;
	readonly flags: (
		tx: SqlTransaction,
		binding: DraftBinding,
		revision: NativeRevision,
		snapshot: CurrentSendSnapshotV1,
	) => readonly Flag[] | undefined;
}
export interface NativeProposalRecord extends Omit<SendTargetRecord, "targetVersion"> {
	readonly binding: DraftBinding;
	readonly rev: number;
	readonly revisionContentHash: string;
	readonly lockId: string;
	readonly notBefore: number | null;
	readonly deliverBy: number | null;
	readonly createdAt: number;
	readonly updatedAt: number;
}
interface Row {
	id: string;
	user_id: string;
	account_id: string;
	draft_id: string;
	state: string;
	schedule_kind: string;
	payload: string;
	audit_seq: number;
	mac: string;
}
interface Loaded {
	readonly record: NativeProposalRecord;
	readonly version: number;
}
const live = new Set<OutboxState>(["APPROVED", "SCHEDULED", "SENDING", "RETRY_WAIT", "UNKNOWN"]);
const terminal = new Set<OutboxState>([
	"SENT",
	"FAILED",
	"NEEDS_REAPPROVAL",
	"CANCELLED",
	"REJECTED",
	"SUPERSEDED",
	"EXPIRED",
]);
const owners = new WeakMap<object, HubStore>();
const storeRead = HubStore.prototype.read;
const assertMasterKey = HubStore.prototype.assertMasterKey;
const derive = MasterKey.prototype.derive;
const revision = Object.freeze({
	assertStore: NativeDraftRevisions.prototype.assertStore,
	currentInTransaction: NativeDraftRevisions.prototype.currentInTransaction,
	appendInTransaction: NativeDraftRevisions.prototype.appendInTransaction,
	auditOutboxInTransaction: NativeDraftRevisions.prototype.auditOutboxInTransaction,
});
const freeze = Object.freeze({
	freezeInTransaction: NativeDraftFreeze.prototype.freezeInTransaction,
	proofInTransaction: NativeDraftFreeze.prototype.proofInTransaction,
	releaseInTransaction: NativeDraftFreeze.prototype.releaseInTransaction,
});
const authorizer = Object.freeze({
	requirePeerDevice: Authorizer.prototype.requirePeerDevice,
	requireDevice: Authorizer.prototype.requireDevice,
	assertCurrentGrant: Authorizer.prototype.assertCurrentGrant,
});
const registry = Object.freeze({
	assertStore: DeviceRegistry.prototype.assertStore,
	assertIdentity: DeviceRegistry.prototype.assertIdentity,
	state: DeviceRegistry.prototype.state,
});
const auditVerify = AuditChain.prototype.verify;
const workWrite = WorkDatabase.prototype.write;
const workSql = WorkDatabase.prototype.sql;
const workAbort = WorkDatabase.prototype.abort;
const appendEvent = EventLog.prototype.append;
const ROW = `SELECT CASE WHEN typeof(id)='text' AND length(CAST(id AS BLOB))=26 THEN id ELSE NULL END AS id,
 CASE WHEN typeof(user_id)='text' AND length(CAST(user_id AS BLOB))=26 THEN user_id ELSE NULL END AS user_id,
 CASE WHEN typeof(account_id)='text' AND length(CAST(account_id AS BLOB))=26 THEN account_id ELSE NULL END AS account_id,
 CASE WHEN typeof(draft_id)='text' AND length(CAST(draft_id AS BLOB))=26 THEN draft_id ELSE NULL END AS draft_id,
 CASE WHEN typeof(state)='text' AND length(CAST(state AS BLOB))<=32 THEN state ELSE NULL END AS state,
 CASE WHEN typeof(schedule_kind)='text' AND length(CAST(schedule_kind AS BLOB))<=4 THEN schedule_kind ELSE NULL END AS schedule_kind,
 CASE WHEN typeof(payload)='text' AND length(CAST(payload AS BLOB)) BETWEEN 1 AND 2097152 THEN payload ELSE NULL END AS payload,
 CASE WHEN typeof(audit_seq)='integer' AND audit_seq BETWEEN 1 AND 9007199254740991 THEN audit_seq ELSE NULL END AS audit_seq,
 CASE WHEN typeof(mac)='text' AND length(CAST(mac AS BLOB))=64 THEN mac ELSE NULL END AS mac FROM main.outbox`;
const recordKeys = [
	"id",
	"userId",
	"accountId",
	"draftId",
	"dataClass",
	"snapshot",
	"contentHash",
	"flags",
	"flagsHash",
	"requiredApprovals",
	"requiredUsers",
	"undoWindowMs",
	"expiresAt",
	"state",
	"stateReason",
	"binding",
	"rev",
	"revisionContentHash",
	"lockId",
	"notBefore",
	"deliverBy",
	"createdAt",
	"updatedAt",
] as const;
function users(raw: unknown, empty = false): readonly string[] {
	const values = captureDraftData(raw);
	if (!Array.isArray(values) || values.length < (empty ? 0 : 1) || values.length > 16) refused();
	const result = values.map(id).sort();
	if (new Set(result).size !== result.length) refused();
	return Object.freeze(result);
}
function record(raw: unknown): NativeProposalRecord {
	const v = fields(raw, recordKeys),
		snapshot = CurrentSendSnapshotV1.parse(v.snapshot),
		bound = captureDraftBinding(v.binding as DraftBinding),
		state = OutboxState.parse(v.state),
		parsedFlags = Flags.parse(v.flags),
		userId = id(v.userId),
		outboxId = id(v.id),
		createdAt = integer(v.createdAt),
		updatedAt = integer(v.updatedAt),
		requiredUsers = users(v.requiredUsers),
		lockId = id(v.lockId),
		notBefore = v.notBefore === null ? null : integer(v.notBefore),
		deliverBy = v.deliverBy === null ? null : integer(v.deliverBy),
		stateReason = v.stateReason === null ? null : StateReason.parse(v.stateReason);
	if (
		snapshot.outbox !== outboxId ||
		snapshot.account !== id(v.accountId) ||
		snapshot.source.draft !== id(v.draftId) ||
		snapshot.source.rev !== integer(v.rev, 1) ||
		bound.accountId !== snapshot.account ||
		bound.draftId !== snapshot.source.draft ||
		bound.conversationId !== snapshot.conversation ||
		bound.channel !== snapshot.kind ||
		!Sha256Hex.safeParse(v.revisionContentHash).success ||
		contentHash(snapshot) !== v.contentHash ||
		flagsHash(parsedFlags) !== v.flagsHash ||
		!requiredUsers.includes(userId) ||
		updatedAt < createdAt ||
		integer(v.expiresAt) <= createdAt ||
		(state === "NEEDS_REAPPROVAL") !== (stateReason !== null) ||
		(live.has(state) && (deliverBy === null || notBefore === null)) ||
		(state === "PENDING_APPROVAL" && (deliverBy !== null || notBefore !== null))
	)
		refused();
	return immutableDraftData({
		...v,
		id: outboxId,
		userId,
		accountId: snapshot.account,
		draftId: bound.draftId,
		dataClass: DataClass.parse(v.dataClass),
		snapshot,
		contentHash: contentHash(snapshot),
		flags: parsedFlags,
		flagsHash: flagsHash(parsedFlags),
		requiredApprovals: integer(v.requiredApprovals, 1, 16),
		requiredUsers,
		undoWindowMs: integer(v.undoWindowMs, 0, 30_000),
		expiresAt: integer(v.expiresAt),
		state,
		stateReason,
		binding: bound,
		rev: snapshot.source.rev,
		revisionContentHash: v.revisionContentHash as string,
		lockId,
		notBefore,
		deliverBy,
		createdAt,
		updatedAt,
	}) as NativeProposalRecord;
}
function projection(value: NativeProposalRecord, targetVersion: number): SendTargetRecord {
	return immutableDraftData({
		id: value.id,
		userId: value.userId,
		accountId: value.accountId,
		draftId: value.draftId,
		dataClass: value.dataClass,
		snapshot: value.snapshot,
		contentHash: value.contentHash,
		flags: value.flags,
		flagsHash: value.flagsHash,
		requiredApprovals: value.requiredApprovals,
		requiredUsers: value.requiredUsers,
		undoWindowMs: value.undoWindowMs,
		expiresAt: value.expiresAt,
		state: value.state,
		stateReason: value.stateReason,
		targetVersion,
	});
}
/** Counts current users, never devices; the owner and every required user must be present. */
export function tallyApprovals(
	input: {
		readonly userId: string;
		readonly requiredApprovals: number;
		readonly requiredUsers: readonly string[];
	},
	voterUserIds: readonly string[],
): boolean {
	const value = fields(captureDraftData(input), ["userId", "requiredApprovals", "requiredUsers"]),
		captured = captureDraftData(voterUserIds);
	if (!Array.isArray(captured)) refused();
	const owner = id(value.userId),
		required = users(value.requiredUsers),
		voters = users([...new Set(captured.map(id))], true);
	if (!required.includes(owner)) refused("POLICY_DENIED");
	return (
		voters.includes(owner) &&
		voters.length >= integer(value.requiredApprovals, 1, 16) &&
		required.every((user) => voters.includes(user))
	);
}
function intersectWindows(
	snapshot: CurrentSendSnapshotV1,
	approvals: readonly StoredSendApproval[],
	undoEnd: number,
) {
	if (approvals.length < 1 || approvals.length > 16) refused();
	let deliverBy = Number.MAX_SAFE_INTEGER;
	for (const accepted of approvals) {
		const window = sendWindow(snapshot, integer(accepted.iat));
		if (
			accepted.iat > accepted.approvedAt ||
			accepted.notBefore !== (window.notBefore ?? null) ||
			accepted.deliverBy !== window.deliverBy
		)
			refused();
		deliverBy = Math.min(deliverBy, window.deliverBy);
	}
	if (
		undoEnd >= deliverBy ||
		(snapshot.schedule.kind === "at" && undoEnd > snapshot.schedule.notBefore)
	)
		refused();
	return {
		notBefore: snapshot.schedule.kind === "now" ? undoEnd : snapshot.schedule.notBefore,
		deliverBy,
	};
}

/** Owns the native target. Stored snapshots and exposed records are data, not approval authority. */
export class NativeOutboxProposals {
	readonly #store: HubStore;
	readonly #audit: AuditChain;
	readonly #revisions: NativeDraftRevisions;
	readonly #freeze: NativeDraftFreeze;
	readonly #registry: DeviceRegistry;
	readonly #authorizer: Authorizer;
	readonly #identity: HubIdentity;
	readonly #clock: Clock;
	readonly #database: WorkDatabase;
	readonly #events: EventLog;
	readonly #owner: object;
	readonly #settings: Required<NativeOutboxSettings>;
	readonly #providers: NativeProposalProviders;
	readonly #scopes = new WeakMap<SqlTransaction, WorkScope>();
	readonly #failedScopes = new WeakSet<WorkScope>();
	#currentScope: WorkScope | undefined;
	#key: Buffer | undefined;
	constructor(
		store: HubStore,
		audit: AuditChain,
		masterKey: MasterKey,
		revisions: NativeDraftRevisions,
		devices: DeviceRegistry,
		auth: Authorizer,
		identity: HubIdentity,
		clock: Clock = systemClock,
		settings: NativeOutboxSettings = {},
		providers?: NativeProposalProviders,
	) {
		let key: Buffer | undefined;
		try {
			if ([store, audit, masterKey, revisions, devices, auth, identity, clock].some(types.isProxy))
				refused();
			assertMasterKey.call(store, masterKey);
			registry.assertStore.call(devices, store);
			registry.assertIdentity.call(devices, identity);
			assertAuthorizerStore(auth, store);
			const owner = storeRead.call(store, (db: SqlReader) => {
				auditVerify.call(audit, db);
				return readStamp(db)?.owner;
			});
			if (typeof owner !== "object" || owner === null) refused();
			revision.assertStore.call(revisions, store);
			this.#owner = owner;
			const config = fields(
				captureDraftData(settings),
				[],
				["undoWindowMs", "requiredApprovals", "requiredUsers", "proposalTtlMs"],
			);
			this.#settings = Object.freeze({
				undoWindowMs: integer(
					config.undoWindowMs === undefined ? NATIVE_OUTBOX_DEFAULT_UNDO_MS : config.undoWindowMs,
					0,
					30_000,
				),
				requiredApprovals: integer(
					config.requiredApprovals === undefined ? 1 : config.requiredApprovals,
					1,
					16,
				),
				requiredUsers: users(config.requiredUsers === undefined ? [] : config.requiredUsers, true),
				proposalTtlMs: integer(
					config.proposalTtlMs === undefined ? NATIVE_OUTBOX_DEFAULT_TTL_MS : config.proposalTtlMs,
					1,
				),
			});
			if (providers === undefined)
				this.#providers = Object.freeze({ facts: () => undefined, flags: () => undefined });
			else {
				const p = fields(providers, ["facts", "flags"]);
				if (
					[p.facts, p.flags].some(
						(fn) => typeof fn !== "function" || types.isProxy(fn) || types.isAsyncFunction(fn),
					)
				)
					refused();
				this.#providers = Object.freeze({
					facts: p.facts,
					flags: p.flags,
				}) as NativeProposalProviders;
			}
			key = derive.call(masterKey, "outbox");
		} catch {
			key?.fill(0);
			throw new ProposalError();
		}
		this.#key = key;
		this.#store = store;
		this.#audit = audit;
		this.#revisions = revisions;
		this.#freeze = new NativeDraftFreeze(revisions);
		this.#registry = devices;
		this.#authorizer = auth;
		this.#identity = identity;
		this.#clock = clock;
		this.#database = new WorkDatabase(store);
		this.#events = new EventLog(this.#database, () => this.#now());
		owners.set(this, store);
	}
	assertActive(): void {
		this.#active();
	}
	#active(): void {
		if (!this.#key || owners.get(this) !== this.#store) refused();
		registry.assertStore.call(this.#registry, this.#store);
	}
	#now(): number {
		return integer(this.#clock.wallMs());
	}
	#reader(db: SqlReader): SqlTransaction {
		this.#active();
		assertStoreTransaction(this.#store, db as SqlTransaction);
		const scope = this.#scopes.get(db as SqlTransaction);
		if (!scope || scope !== this.#currentScope || this.#failedScopes.has(scope)) refused();
		if (readStamp(db)?.owner !== this.#owner) refused();
		auditVerify.call(this.#audit, db);
		return db as SqlTransaction;
	}
	#mac(value: unknown): string {
		if (!this.#key) refused();
		return createHmac("sha256", this.#key)
			.update("draftyak/outbox-proposal/v1\n")
			.update(canonicalize(value))
			.digest("hex");
	}
	#load(db: SqlReader, outboxId: string): Loaded | undefined {
		const tx = this.#reader(db),
			row = tx.get<Row>(`${ROW} WHERE id=?`, [id(outboxId)]);
		if (!row) return undefined;
		const { mac, ...signed } = row;
		if (
			typeof row.payload !== "string" ||
			!Sha256Hex.safeParse(mac).success ||
			!timingSafeEqual(Buffer.from(mac, "hex"), Buffer.from(this.#mac(signed), "hex"))
		)
			refused();
		const value = record(JSON.parse(row.payload));
		if (
			canonicalize(value) !== row.payload ||
			value.id !== row.id ||
			value.userId !== row.user_id ||
			value.accountId !== row.account_id ||
			value.draftId !== row.draft_id ||
			value.state !== row.state ||
			value.snapshot.schedule.kind !== row.schedule_kind
		)
			refused();
		const latest = tx.get<{ seq: number }>(
			"SELECT seq FROM main.audit_events WHERE refs=? AND action IN ('outbox.proposed','outbox.superseded','outbox.approved') ORDER BY seq DESC LIMIT 1",
			[canonicalize({ outbox: value.id })],
		);
		if (latest?.seq !== row.audit_seq) refused();
		return { record: value, version: integer(row.audit_seq, 1) };
	}
	#reading<T>(db: SqlReader, work: () => T): T {
		try {
			return work();
		} catch (error) {
			this.#abortTransaction(db);
			this.#abortCurrent();
			throw error instanceof ProposalError ? error : new ProposalError();
		}
	}
	get(db: SqlReader, outboxId: string): NativeProposalRecord | undefined {
		return this.#reading(db, () => this.#load(db, outboxId)?.record);
	}
	item(db: SqlReader, outboxId: string): SendTargetRecord | undefined {
		return this.#reading(db, () => {
			const loaded = this.#load(db, outboxId);
			if (!loaded) return undefined;
			const tx = this.#reader(db),
				item = loaded.record,
				current = revision.currentInTransaction.call(this.#revisions, tx, item.binding),
				authority = registry.state.call(this.#registry, tx);
			if (
				authority.ownerUserId !== item.userId ||
				authority.epoch !== item.snapshot.epoch ||
				item.snapshot.hub !== this.#identity.hid ||
				current.revision.rev !== item.rev ||
				current.flagsHash !== item.flagsHash ||
				current.revision.contentSha256 !== item.revisionContentHash ||
				current.lockId !== item.lockId
			)
				refused();
			this.#nativeData(tx, item.binding, current, item.snapshot, item.dataClass);
			freeze.proofInTransaction.call(this.#freeze, tx, item.binding, item.id);
			const after = this.#load(tx, item.id),
				authorityAfter = registry.state.call(this.#registry, tx);
			if (
				!after ||
				after.version !== loaded.version ||
				canonicalize(after.record) !== canonicalize(item) ||
				authorityAfter.ownerUserId !== item.userId ||
				authorityAfter.epoch !== item.snapshot.epoch
			)
				refused();
			return projection(item, loaded.version);
		});
	}
	write<T>(work: (tx: SqlTransaction, scope: WorkScope) => T): T {
		this.#active();
		if (typeof work !== "function" || types.isProxy(work) || types.isAsyncFunction(work)) refused();
		return workWrite.call(this.#database, (scope: WorkScope) => {
			const tx = workSql.call(this.#database, scope);
			this.#scopes.set(tx, scope);
			this.#currentScope = scope;
			try {
				this.#reader(tx);
				return work(tx, scope);
			} catch (error) {
				workAbort.call(this.#database, scope);
				throw error instanceof ProposalError ? error : new ProposalError();
			} finally {
				this.#scopes.delete(tx);
				this.#currentScope = undefined;
			}
		}) as T;
	}
	assertScope(tx: SqlTransaction, scope: WorkScope): void {
		this.#mutate(scope, (actualTx) => {
			if (actualTx !== tx) refused();
		});
	}
	/** Tightening only: a failed native operation may poison its own scope even during shutdown. */
	abortScope(scope: WorkScope): void {
		this.#failedScopes.add(scope);
		workAbort.call(this.#database, scope);
	}
	abortTransaction(db: SqlReader): void {
		this.#abortTransaction(db);
	}
	#abortTransaction(db: SqlReader): void {
		const scope = this.#scopes.get(db as SqlTransaction);
		if (scope) {
			this.#failedScopes.add(scope);
			workAbort.call(this.#database, scope);
		}
	}
	#abortCurrent(): void {
		if (this.#currentScope) {
			this.#failedScopes.add(this.#currentScope);
			workAbort.call(this.#database, this.#currentScope);
		}
	}
	#mutate<T>(scope: WorkScope, work: (tx: SqlTransaction) => T): T {
		try {
			const tx = workSql.call(this.#database, scope);
			this.#reader(tx);
			return work(tx);
		} catch (error) {
			try {
				this.#failedScopes.add(scope);
				workAbort.call(this.#database, scope);
			} catch {
				/* A foreign scope grants no mutation. */
			}
			this.#abortCurrent();
			throw error instanceof ProposalError ? error : new ProposalError();
		}
	}
	#save(
		scope: WorkScope,
		raw: NativeProposalRecord,
		action: "outbox.proposed" | "outbox.superseded" | "outbox.approved",
		insert = false,
	): Loaded {
		const tx = workSql.call(this.#database, scope),
			value = record(raw),
			payload = canonicalize(value);
		if (
			Buffer.byteLength(payload) > 2097152 ||
			Buffer.byteLength(
				canonicalize(
					SendReview.parse({
						id: value.id,
						snapshot: value.snapshot,
						contentHash: value.contentHash,
						flags: value.flags,
						flagsHash: value.flagsHash,
						state: value.state,
						stateReason: value.stateReason,
						requiredUsers: value.requiredUsers,
						expiresAt: value.expiresAt,
					}),
				),
			) > 1048576
		)
			refused();
		const audit_seq = revision.auditOutboxInTransaction.call(
				this.#revisions,
				tx,
				action,
				value.id,
			).seq,
			signed = {
				id: value.id,
				user_id: value.userId,
				account_id: value.accountId,
				draft_id: value.draftId,
				state: value.state,
				schedule_kind: value.snapshot.schedule.kind,
				payload,
				audit_seq,
			},
			mac = this.#mac(signed);
		if (insert)
			tx.run(
				"INSERT INTO main.outbox(id,user_id,account_id,draft_id,state,schedule_kind,payload,audit_seq,mac) VALUES(?,?,?,?,?,?,?,?,?)",
				Object.values({ ...signed, mac }),
			);
		else if (
			tx.run(
				"UPDATE main.outbox SET state=?,payload=?,audit_seq=?,mac=? WHERE id=? AND state='PENDING_APPROVAL'",
				[value.state, payload, audit_seq, mac, value.id],
			).changes !== 1
		)
			refused();
		appendEvent.call(this.#events, scope, {
			userId: value.userId,
			accountId: value.accountId,
			dataClass: DataClass.parse(value.dataClass),
			kind: "outbox.changed",
			ids: [value.id],
		});
		return { record: value, version: audit_seq };
	}
	draftLocked(db: SqlReader, draftId: string): boolean {
		return this.#reading(db, () => {
			const tx = this.#reader(db),
				rows = tx.all<{ id: string }>(
					"SELECT id FROM main.outbox WHERE draft_id=? AND state IN ('APPROVED','SCHEDULED','SENDING','RETRY_WAIT','UNKNOWN') LIMIT 2",
					[id(draftId)],
				);
			if (rows.length > 1) refused();
			for (const row of rows)
				if (!live.has(this.#load(tx, row.id)?.record.state ?? "FAILED")) refused();
			return rows.length === 1;
		});
	}
	scheduledCount(db: SqlReader, accountId: string, excludeOutboxId: string): number {
		return this.#reading(db, () => {
			const tx = this.#reader(db),
				rows = tx.all<{ id: string }>(
					"SELECT id FROM main.outbox WHERE account_id=? AND id<>? AND schedule_kind='at' AND state NOT IN ('SENT','FAILED','NEEDS_REAPPROVAL','CANCELLED','REJECTED','SUPERSEDED','EXPIRED') LIMIT 101",
					[id(accountId), id(excludeOutboxId)],
				);
			for (const row of rows) {
				const item = this.#load(tx, row.id)?.record;
				if (!item || terminal.has(item.state) || item.snapshot.schedule.kind !== "at") refused();
			}
			return rows.length;
		});
	}
	#supersede(scope: WorkScope, draftId: string): void {
		const tx = workSql.call(this.#database, scope),
			rows = tx.all<{ id: string }>(
				"SELECT id FROM main.outbox WHERE draft_id=? AND state='PENDING_APPROVAL' LIMIT 101",
				[draftId],
			);
		if (rows.length > 100) refused();
		for (const row of rows) {
			const old = this.#load(tx, row.id)?.record ?? refused();
			freeze.releaseInTransaction.call(this.#freeze, tx, old.binding, old.id);
			this.#save(
				scope,
				{ ...old, state: "SUPERSEDED", updatedAt: Math.max(this.#now(), old.updatedAt) },
				"outbox.superseded",
			);
		}
	}
	#nativeData(
		tx: SqlTransaction,
		bound: DraftBinding,
		current: NativeRevision,
		snapshot: CurrentSendSnapshotV1,
		dataClass: string,
	): void {
		const rawFacts = this.#providers.facts(tx, bound, current);
		if (rawFacts === undefined) refused("NATIVE_FACTS_UNAVAILABLE");
		const facts = fields(
			captureDraftData(rawFacts),
			["accountId", "conversationId", "dataClass", "footer", "kind"],
			["email", "chat"],
		);
		const expected =
			snapshot.kind === "email"
				? {
						accountId: bound.accountId,
						conversationId: bound.conversationId,
						dataClass,
						footer: snapshot.body.footer,
						kind: "email",
						email: {
							from: snapshot.email.from,
							...(snapshot.email.threadId === undefined
								? {}
								: { threadId: snapshot.email.threadId }),
							...(snapshot.email.inReplyTo === undefined
								? {}
								: { inReplyTo: snapshot.email.inReplyTo }),
							references: snapshot.email.references,
						},
					}
				: {
						accountId: bound.accountId,
						conversationId: bound.conversationId,
						dataClass,
						footer: snapshot.body.footer,
						kind: "chat",
						chat: snapshot.chat,
					};
		if (canonicalize(facts) !== canonicalize(expected)) refused("POLICY_DENIED");
		const recomputed = this.#providers.flags(tx, bound, current, snapshot);
		if (recomputed === undefined) refused("NATIVE_FLAGS_UNAVAILABLE");
		if (flagsHash(Flags.parse(captureDraftData(recomputed))) !== current.flagsHash)
			refused("PROPOSAL_STALE");
	}
	propose(peer: NativeDevicePeer, input: NativeProposalInput): SendTargetRecord {
		return this.write((_tx, scope) => this.proposeInTransaction(scope, peer, input));
	}
	proposeInTransaction(
		scope: WorkScope,
		peer: NativeDevicePeer,
		input: NativeProposalInput,
	): SendTargetRecord {
		return this.#mutate(scope, (tx) => {
			const captured = captureDraftData(input),
				raw = fields(captured, [
					"binding",
					"expectedRev",
					"snapshot",
					"dataClass",
					"requiredApprovals",
					"requiredUsers",
					"undoWindowMs",
					"expiresAt",
				]);
			if (
				String(raw.dataClass).startsWith("sms.") ||
				(raw.snapshot as { kind?: unknown })?.kind === "sms"
			)
				refused("SMS_UNAVAILABLE");
			const grant = authorizer.requirePeerDevice.call(this.#authorizer, tx, peer, "draft"),
				bound = captureDraftBinding(raw.binding as DraftBinding),
				snapshot = CurrentSendSnapshotV1.parse(raw.snapshot),
				current = revision.currentInTransaction.call(this.#revisions, tx, bound),
				at = this.#now(),
				requiredUsers = users(raw.requiredUsers),
				expectedRev = integer(raw.expectedRev, 1),
				dataClass = DataClass.parse(raw.dataClass),
				undo = integer(raw.undoWindowMs, 0, 30_000);
			if (
				snapshot.hub !== this.#identity.hid ||
				snapshot.epoch !== grant.epoch ||
				current.draft.rev !== expectedRev ||
				!requiredUsers.includes(grant.ownerUserId) ||
				at < current.draft.updatedAt ||
				this.#load(tx, snapshot.outbox) ||
				tx.get(
					"SELECT 1 FROM main.audit_events WHERE action='outbox.proposed' AND refs=? LIMIT 1",
					[canonicalize({ outbox: snapshot.outbox })],
				)
			)
				refused();
			if (this.draftLocked(tx, bound.draftId)) refused("DRAFT_LOCKED");
			this.#nativeData(tx, bound, current, snapshot, dataClass);
			const latestGrant = authorizer.requirePeerDevice.call(this.#authorizer, tx, peer, "draft");
			if (
				latestGrant.userId !== grant.userId ||
				latestGrant.ownerUserId !== grant.ownerUserId ||
				latestGrant.epoch !== grant.epoch
			)
				refused();
			authorizer.assertCurrentGrant.call(this.#authorizer, tx, latestGrant);
			if (
				undo < this.#settings.undoWindowMs ||
				integer(raw.requiredApprovals, 1, 16) < this.#settings.requiredApprovals ||
				this.#settings.requiredUsers.some((user) => !requiredUsers.includes(user))
			)
				refused("POLICY_DENIED");
			const expiresAt = Math.min(
				integer(raw.expiresAt),
				integer(at + this.#settings.proposalTtlMs),
				snapshot.schedule.kind === "at"
					? snapshot.schedule.notBefore - undo
					: Number.MAX_SAFE_INTEGER,
			);
			if (expiresAt <= at) refused();
			if (snapshot.schedule.kind === "at") {
				if (
					snapshot.schedule.notBefore % 60_000 !== 0 ||
					snapshot.schedule.notBefore < at + Math.max(60_000, undo) ||
					snapshot.schedule.notBefore > at + 30 * 24 * 60 * 60_000
				)
					refused();
				try {
					if (
						renderLocalWallTime(snapshot.schedule.notBefore, snapshot.schedule.zone) !==
						snapshot.schedule.localWallTime
					)
						refused("LOCAL_TIME_MISMATCH");
				} catch (error) {
					if (error instanceof ProposalError) throw error;
					refused("SCHEDULING_UNAVAILABLE");
				}
			}
			this.#supersede(scope, bound.draftId);
			if (
				snapshot.schedule.kind === "at" &&
				this.scheduledCount(tx, bound.accountId, snapshot.outbox) >= 100
			)
				refused("SCHEDULE_LIMIT");
			freeze.freezeInTransaction.call(this.#freeze, tx, bound, expectedRev, snapshot);
			const locked = revision.currentInTransaction.call(this.#revisions, tx, bound);
			if (locked.lockId === null) refused();
			const saved = this.#save(
				scope,
				{
					id: snapshot.outbox,
					userId: grant.ownerUserId,
					accountId: bound.accountId,
					draftId: bound.draftId,
					dataClass,
					snapshot,
					contentHash: contentHash(snapshot),
					flags: current.revision.flags,
					flagsHash: current.flagsHash,
					requiredApprovals: integer(raw.requiredApprovals, 1, 16),
					requiredUsers,
					undoWindowMs: undo,
					expiresAt,
					state: "PENDING_APPROVAL",
					stateReason: null,
					binding: bound,
					rev: locked.revision.rev,
					revisionContentHash: locked.revision.contentSha256,
					lockId: locked.lockId,
					notBefore: null,
					deliverBy: null,
					createdAt: at,
					updatedAt: at,
				},
				"outbox.proposed",
				true,
			);
			return projection(saved.record, saved.version);
		});
	}
	/** The postponed agent entry has no mutation or native target issuance. */
	proposeAgent(): never {
		return refused("AGENT_PROPOSAL_UNAVAILABLE");
	}
	appendRevision(peer: NativeDevicePeer, input: DraftAppend): NativeRevision {
		return this.write((_tx, scope) => this.appendRevisionInTransaction(scope, peer, input));
	}
	appendRevisionInTransaction(
		scope: WorkScope,
		peer: NativeDevicePeer,
		input: DraftAppend,
	): NativeRevision {
		return this.#mutate(scope, (tx) => {
			const captured = captureDraftData(input) as DraftAppend,
				grant = authorizer.requirePeerDevice.call(this.#authorizer, tx, peer, "draft"),
				bound = captureDraftBinding({
					draftId: captured.draftId,
					accountId: captured.accountId,
					conversationId: captured.conversationId,
					channel: captured.channel,
				});
			authorizer.assertCurrentGrant.call(this.#authorizer, tx, grant);
			if (this.draftLocked(tx, bound.draftId)) refused("DRAFT_LOCKED");
			this.#supersede(scope, bound.draftId);
			return revision.appendInTransaction.call(this.#revisions, tx, {
				...captured,
				author: { kind: "owner", id: grant.userId },
			});
		});
	}
	apply(scope: WorkScope, proof: VerifiedSendApproval): SendApplyResult {
		return this.#mutate(scope, (tx) => {
			const { approval, stored } = consumeVerifiedSendApproval(proof, tx, scope, this),
				loaded = this.#load(tx, approval.outboxId) ?? refused(),
				item = loaded.record,
				at = this.#now(),
				authority = registry.state.call(this.#registry, tx);
			if (
				loaded.version !== approval.targetVersion ||
				item.state !== "PENDING_APPROVAL" ||
				approval.approvedAt >= item.expiresAt ||
				approval.approvedAt > at ||
				approval.hub !== this.#identity.hid ||
				approval.epoch !== authority.epoch ||
				item.snapshot.hub !== approval.hub ||
				item.snapshot.epoch !== approval.epoch ||
				approval.contentHash !== item.contentHash ||
				approval.flagsHash !== item.flagsHash ||
				authority.ownerUserId !== item.userId ||
				this.draftLocked(tx, item.draftId)
			)
				refused();
			freeze.proofInTransaction.call(this.#freeze, tx, item.binding, item.id);
			const current = revision.currentInTransaction.call(this.#revisions, tx, item.binding);
			if (
				current.lockId !== item.lockId ||
				current.revision.rev !== item.rev ||
				current.flagsHash !== item.flagsHash ||
				current.revision.contentSha256 !== item.revisionContentHash
			)
				refused();
			this.#nativeData(tx, item.binding, current, item.snapshot, item.dataClass);
			const freshAt = this.#now(),
				after = this.#load(tx, item.id),
				authorityAfter = registry.state.call(this.#registry, tx),
				currentAfter = revision.currentInTransaction.call(this.#revisions, tx, item.binding);
			if (
				freshAt < at ||
				freshAt >= item.expiresAt ||
				!after ||
				after.version !== loaded.version ||
				canonicalize(after.record) !== canonicalize(item) ||
				authorityAfter.ownerUserId !== item.userId ||
				authorityAfter.epoch !== approval.epoch ||
				currentAfter.lockId !== item.lockId ||
				currentAfter.revision.rev !== item.rev ||
				currentAfter.flagsHash !== item.flagsHash ||
				currentAfter.revision.contentSha256 !== item.revisionContentHash
			)
				refused();
			freeze.proofInTransaction.call(this.#freeze, tx, item.binding, item.id);
			const freshUndoEnd = integer(freshAt + item.undoWindowMs);
			const voters = new Set<string>();
			let found = false;
			if (stored.length < 1 || stored.length > 16) refused();
			for (const accepted of stored) {
				const grant = authorizer.requireDevice.call(
						this.#authorizer,
						tx,
						accepted.deviceId,
						"approve",
					),
					window = sendWindow(item.snapshot, accepted.iat);
				if (
					grant.userId !== accepted.userId ||
					grant.ownerUserId !== item.userId ||
					grant.epoch !== approval.epoch ||
					voters.has(grant.userId) ||
					accepted.approvedAt > freshAt ||
					accepted.iat > accepted.approvedAt ||
					accepted.deliverBy !== window.deliverBy ||
					accepted.notBefore !== (window.notBefore ?? null) ||
					accepted.deliverBy < freshUndoEnd ||
					(accepted.notBefore !== null && accepted.notBefore < freshUndoEnd)
				)
					refused();
				authorizer.assertCurrentGrant.call(this.#authorizer, tx, grant);
				voters.add(grant.userId);
				if (
					accepted.approvalId === approval.approvalId &&
					accepted.userId === approval.userId &&
					accepted.deviceId === approval.deviceId
				)
					found = true;
			}
			if (!found) refused();
			if (
				!tallyApprovals(
					{
						userId: item.userId,
						requiredApprovals: item.requiredApprovals,
						requiredUsers: item.requiredUsers,
					},
					[...voters],
				)
			)
				return "pending";
			const window = intersectWindows(item.snapshot, stored, freshUndoEnd);
			if (
				item.snapshot.schedule.kind === "at" &&
				this.scheduledCount(tx, item.accountId, item.id) >= 100
			)
				refused("SCHEDULE_LIMIT");
			this.#save(
				scope,
				{
					...item,
					state: item.snapshot.schedule.kind === "at" ? "SCHEDULED" : "APPROVED",
					...window,
					updatedAt: Math.max(freshAt, item.updatedAt),
				},
				"outbox.approved",
			);
			return item.snapshot.schedule.kind === "at" ? "scheduled" : "approved";
		});
	}
	destroy(): void {
		this.#abortCurrent();
		this.#key?.fill(0);
		this.#key = undefined;
		owners.delete(this);
	}
}

// Capture this module's own original methods only after its class is initialized. Imported modules
// call these narrow functions later; no cyclic module reads another class during initialization.
const original = Object.freeze({
	assertActive: NativeOutboxProposals.prototype.assertActive,
	write: NativeOutboxProposals.prototype.write,
	item: NativeOutboxProposals.prototype.item,
	apply: NativeOutboxProposals.prototype.apply,
	draftLocked: NativeOutboxProposals.prototype.draftLocked,
	scheduledCount: NativeOutboxProposals.prototype.scheduledCount,
	assertScope: NativeOutboxProposals.prototype.assertScope,
	abortScope: NativeOutboxProposals.prototype.abortScope,
	abortTransaction: NativeOutboxProposals.prototype.abortTransaction,
});
export function assertNativeOutboxTarget(
	target: unknown,
	store: HubStore,
): asserts target is NativeOutboxProposals {
	if (!target || typeof target !== "object" || owners.get(target) !== store) refused();
	original.assertActive.call(target as NativeOutboxProposals);
}
function actual(target: unknown): NativeOutboxProposals {
	if (!target || typeof target !== "object") refused();
	const store = owners.get(target);
	if (!store) refused();
	assertNativeOutboxTarget(target, store);
	return target;
}
export function writeNativeOutboxTarget<T>(
	target: unknown,
	work: (tx: SqlTransaction, scope: WorkScope) => T,
): T {
	return original.write.call(actual(target), work) as T;
}
export function readNativeOutboxTarget(
	target: unknown,
	db: SqlReader,
	outboxId: string,
): SendTargetRecord | undefined {
	try {
		return original.item.call(actual(target), db, outboxId);
	} catch (error) {
		try {
			original.abortTransaction.call(target as NativeOutboxProposals, db);
		} catch {
			/* No foreign scope authority. */
		}
		throw error;
	}
}
export function applyNativeOutboxTarget(
	target: unknown,
	scope: WorkScope,
	proof: VerifiedSendApproval,
): SendApplyResult {
	try {
		return original.apply.call(actual(target), scope, proof);
	} catch (error) {
		try {
			original.abortScope.call(target as NativeOutboxProposals, scope);
		} catch {
			/* No foreign scope authority. */
		}
		throw error;
	}
}
export function isNativeOutboxDraftLocked(
	target: unknown,
	db: SqlReader,
	draftId: string,
): boolean {
	try {
		return original.draftLocked.call(actual(target), db, draftId);
	} catch (error) {
		try {
			original.abortTransaction.call(target as NativeOutboxProposals, db);
		} catch {
			/* No foreign scope authority. */
		}
		throw error;
	}
}
export function countNativeOutboxScheduled(
	target: unknown,
	db: SqlReader,
	accountId: string,
	excludeOutboxId: string,
): number {
	try {
		return original.scheduledCount.call(actual(target), db, accountId, excludeOutboxId);
	} catch (error) {
		try {
			original.abortTransaction.call(target as NativeOutboxProposals, db);
		} catch {
			/* No foreign scope authority. */
		}
		throw error;
	}
}
export function assertNativeOutboxScope(
	target: unknown,
	tx: SqlTransaction,
	scope: WorkScope,
): void {
	try {
		original.assertScope.call(actual(target), tx, scope);
	} catch (error) {
		try {
			original.abortScope.call(target as NativeOutboxProposals, scope);
		} catch {
			/* No foreign scope authority. */
		}
		throw error;
	}
}
export function abortNativeOutboxScope(target: unknown, scope: WorkScope): void {
	// The original method's native private-field access and WorkDatabase's owner map reject copies.
	original.abortScope.call(target as NativeOutboxProposals, scope);
}
