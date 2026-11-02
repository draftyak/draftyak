import { createHmac, timingSafeEqual } from "node:crypto";
import { fileURLToPath } from "node:url";
import { types } from "node:util";
import { DataClass } from "@draftyak/protocol/data-class";
import {
	AdminAccountSubject,
	OperationRequest,
	OperationReview,
} from "@draftyak/protocol/device-api";
import { Account } from "@draftyak/protocol/entities/account";
import { jcsSha256 } from "@draftyak/protocol/hash";
import { canonicalize } from "@draftyak/protocol/jcs";
import { Sha256Hex, UtcMs } from "@draftyak/protocol/scalars";
import { STATEMENT_TTL_MS } from "@draftyak/protocol/statements";
import { type AccountRecord, NativeAccounts } from "../accounts/records.ts";
import { AuditChain } from "../audit/chain.ts";
import { Authorizer, assertAuthorizerStore } from "../authz/authorizer.ts";
import type { NativeDevicePeer } from "../authz/native-peer.ts";
import { EventLog } from "../events/log.ts";
import { dataMember, isPlainFunction } from "../extensions/values.ts";
import { WorkDatabase, type WorkScope } from "../jobs/database.ts";
import { fields, id, integer } from "../jobs/values.ts";
import { type Clock, systemClock } from "../kernel/clock.ts";
import { newId } from "../kernel/ids.ts";
import { MasterKey } from "../kernel/master-key.ts";
import { readStamp } from "../store/read-stamp.ts";
import { assertStoreTransaction, HubStore, type SqlTransaction } from "../store/store.ts";
import { NativeAdminError, refuseAdminOperation as refuse } from "./admin-errors.ts";
import { consumeAdminChallengeContext } from "./challenges.ts";
import type { AdminAcceptContext } from "./challenges-admin.ts";
import { type ClockSample, dataCopy } from "./challenges-support.ts";
import { type DeviceGrant, DeviceRegistry } from "./devices.ts";
import type { HubIdentity } from "./hub-key.ts";

export { NativeAdminError, type NativeAdminErrorCode } from "./admin-errors.ts";
export const ADMIN_OPERATION_TTL_MS: number = STATEMENT_TTL_MS;
export const ADMIN_OPERATION_MIGRATIONS: string = fileURLToPath(
	new URL(
		import.meta.url.endsWith(".ts") ? "./admin-migrations/" : "./identity/admin-migrations/",
		import.meta.url,
	),
);
export interface AccountModePrepared {
	readonly fields: {
		readonly op: string;
		readonly kind: "account.mode-full";
		readonly digest: string;
	};
	readonly dataClass: DataClass;
	readonly operationVersion: number;
}
interface Operation {
	readonly id: string;
	readonly kind: "account.mode-full";
	readonly owner: string;
	readonly epoch: number;
	readonly account: Account;
	readonly generation: number;
	readonly subject: AdminAccountSubject;
	readonly digest: string;
	readonly issuedAt: number;
	readonly expiresAt: number;
	readonly state: "pending" | "applied";
	readonly appliedAt: number | null;
	readonly appliedGeneration: number | null;
}
interface Row {
	readonly id: unknown;
	readonly kind: unknown;
	readonly owner_user_id: unknown;
	readonly epoch: unknown;
	readonly account_id: unknown;
	readonly account_generation: unknown;
	readonly state: unknown;
	readonly payload: unknown;
	readonly audit_seq: unknown;
	readonly audit_mac: unknown;
	readonly mac: unknown;
}
interface Loaded {
	readonly record: Operation;
	readonly version: number;
}
interface LiveOperation {
	readonly wall: number;
	readonly mono: number;
	readonly expires: number;
	readonly account: string;
	readonly generation: number;
	readonly owner: string;
	readonly epoch: number;
}
const owners = new WeakMap<object, HubStore>();
const storeRead = HubStore.prototype.read,
	assertKey = HubStore.prototype.assertMasterKey;
const derive = MasterKey.prototype.derive;
const workWrite = WorkDatabase.prototype.write,
	workSql = WorkDatabase.prototype.sql,
	workAbort = WorkDatabase.prototype.abort;
const auditVerify = AuditChain.prototype.verify,
	auditAppend = AuditChain.prototype.append;
const registryStore = DeviceRegistry.prototype.assertStore,
	registryIdentity = DeviceRegistry.prototype.assertIdentity;
const registryState = DeviceRegistry.prototype.state;
const requirePeer = Authorizer.prototype.requirePeerDevice,
	assertGrant = Authorizer.prototype.assertCurrentGrant;
const accountGet = NativeAccounts.prototype.get,
	accountReplace = NativeAccounts.prototype.replace;
const opFields = [
	"id",
	"kind",
	"owner",
	"epoch",
	"account",
	"generation",
	"subject",
	"digest",
	"issuedAt",
	"expiresAt",
	"state",
	"appliedAt",
	"appliedGeneration",
] as const;
const ROW = `SELECT id,kind,owner_user_id,epoch,account_id,account_generation,state,
 CASE WHEN typeof(payload)='text' AND length(CAST(payload AS BLOB)) BETWEEN 2 AND 32768 THEN payload END AS payload,
 audit_seq,CASE WHEN typeof(audit_mac)='text' AND length(CAST(audit_mac AS BLOB))=64 THEN audit_mac END AS audit_mac,
 CASE WHEN typeof(mac)='text' AND length(CAST(mac AS BLOB))=64 THEN mac END AS mac
 FROM main.native_admin_operations WHERE id=?`;

function subject(account: Account): AdminAccountSubject {
	const common = { account: account.id, alias: account.alias, createdAt: account.createdAt };
	return AdminAccountSubject.parse(
		account.channel === "email"
			? { ...common, channel: "email", address: account.address }
			: { ...common, channel: "chat", teamId: account.teamId, selfUserId: account.selfUserId },
	);
}
function eligible(account: Account): void {
	if (
		account.status !== "active" ||
		account.mode !== "read_only" ||
		account.deletionDeadline !== null
	)
		refuse("STALE");
}
function capture(raw: unknown): Operation {
	const value = fields(dataCopy(raw), opFields),
		account = Account.parse(value.account),
		parsedSubject = AdminAccountSubject.parse(value.subject),
		issuedAt = integer(value.issuedAt),
		expiresAt = integer(value.expiresAt),
		generation = integer(value.generation, 1, Number.MAX_SAFE_INTEGER - 1),
		state = value.state;
	if (
		value.kind !== "account.mode-full" ||
		(state !== "pending" && state !== "applied") ||
		account.userId !== id(value.owner) ||
		canonicalize(parsedSubject) !== canonicalize(subject(account)) ||
		value.digest !== jcsSha256(parsedSubject) ||
		expiresAt - issuedAt !== ADMIN_OPERATION_TTL_MS ||
		!UtcMs.safeParse(issuedAt).success ||
		!UtcMs.safeParse(expiresAt).success
	)
		refuse("UNAVAILABLE");
	eligible(account);
	const appliedAt = value.appliedAt === null ? null : integer(value.appliedAt),
		appliedGeneration =
			value.appliedGeneration === null ? null : integer(value.appliedGeneration, 1);
	if (
		state === "pending"
			? appliedAt !== null || appliedGeneration !== null
			: appliedAt === null || appliedAt < issuedAt || appliedGeneration !== generation + 1
	)
		refuse("UNAVAILABLE");
	return Object.freeze({
		id: id(value.id),
		kind: "account.mode-full",
		owner: account.userId,
		epoch: integer(value.epoch),
		account: Object.freeze(account),
		generation,
		subject: parsedSubject,
		digest: jcsSha256(parsedSubject),
		issuedAt,
		expiresAt,
		state,
		appliedAt,
		appliedGeneration,
	});
}

/** A live native issuer for one fixed account transition; stored records confer no authority. */
export class NativeAccountModeOperations {
	readonly #store: HubStore;
	readonly #audit: AuditChain;
	readonly #devices: DeviceRegistry;
	readonly #authorizer: Authorizer;
	readonly #identity: HubIdentity;
	readonly #database: WorkDatabase;
	readonly #accounts: NativeAccounts;
	readonly #wall: () => unknown;
	readonly #mono: () => unknown;
	readonly #scopes = new WeakMap<SqlTransaction, WorkScope>();
	readonly #failed = new WeakSet<WorkScope>();
	readonly #live = new Map<string, LiveOperation>();
	#current: WorkScope | undefined;
	#key: Buffer | undefined;
	constructor(
		store: HubStore,
		audit: AuditChain,
		masterKey: MasterKey,
		devices: DeviceRegistry,
		authorizer: Authorizer,
		identity: HubIdentity,
		clock: Clock = systemClock,
	) {
		let key: Buffer | undefined;
		try {
			if ([store, audit, masterKey, devices, authorizer, identity, clock].some(types.isProxy))
				refuse();
			assertKey.call(store, masterKey);
			registryStore.call(devices, store);
			registryIdentity.call(devices, identity);
			assertAuthorizerStore(authorizer, store);
			const wall = dataMember(clock, "wallMs", "config"),
				mono = dataMember(clock, "monotonicMs", "config");
			if (
				!isPlainFunction(wall) ||
				!isPlainFunction(mono) ||
				types.isAsyncFunction(wall) ||
				types.isAsyncFunction(mono)
			)
				refuse();
			storeRead.call(store, (tx) => {
				auditVerify.call(audit, tx);
				tx.get("SELECT id FROM main.native_admin_operations LIMIT 1");
			});
			key = derive.call(masterKey, "approvals");
			this.#store = store;
			this.#audit = audit;
			this.#devices = devices;
			this.#authorizer = authorizer;
			this.#identity = identity;
			this.#wall = () => wall.call(clock);
			this.#mono = () => mono.call(clock);
			this.#database = new WorkDatabase(store);
			this.#accounts = new NativeAccounts(
				this.#database,
				new EventLog(this.#database, () => this.#sample().wall),
				audit,
				() => this.#sample().wall,
			);
			this.#key = key;
			owners.set(this, store);
		} catch {
			key?.fill(0);
			throw new NativeAdminError();
		}
	}
	assertActive(): void {
		this.#active();
	}
	/** Routing DATA only; prepare still proves the live operation and current authority. */
	ownsOperation(operationId: string): boolean {
		this.#active();
		return this.#live.has(id(operationId));
	}
	#active(): void {
		if (!this.#key || owners.get(this) !== this.#store) refuse();
		registryStore.call(this.#devices, this.#store);
	}
	#sample(): ClockSample {
		this.#active();
		const wall = this.#wall(),
			mono = this.#mono();
		if (
			!UtcMs.safeParse(wall).success ||
			typeof wall !== "number" ||
			typeof mono !== "number" ||
			!Number.isFinite(mono) ||
			mono < 0 ||
			mono > Number.MAX_SAFE_INTEGER
		)
			refuse();
		return Object.freeze({ wall, mono });
	}
	#time(live: LiveOperation, now: ClockSample): void {
		if (
			now.wall < live.wall ||
			now.wall > live.expires ||
			now.mono < live.mono ||
			now.mono - live.mono > ADMIN_OPERATION_TTL_MS
		)
			refuse("STALE");
	}
	#reader(tx: SqlTransaction): void {
		this.#active();
		assertStoreTransaction(this.#store, tx);
		const scope = this.#scopes.get(tx);
		if (!scope || scope !== this.#current || this.#failed.has(scope) || !readStamp(tx)) refuse();
		auditVerify.call(this.#audit, tx);
	}
	write<T>(work: (tx: SqlTransaction, scope: WorkScope) => T): T {
		this.#active();
		if (typeof work !== "function" || types.isProxy(work) || types.isAsyncFunction(work))
			refuse("INVALID_REQUEST");
		try {
			return workWrite.call(this.#database, (scope: WorkScope) => {
				const tx = workSql.call(this.#database, scope);
				this.#scopes.set(tx, scope);
				this.#current = scope;
				try {
					this.#reader(tx);
					return work(tx, scope);
				} catch (error) {
					workAbort.call(this.#database, scope);
					throw error instanceof NativeAdminError ? error : new NativeAdminError();
				} finally {
					this.#scopes.delete(tx);
					this.#current = undefined;
				}
			}) as T;
		} catch (error) {
			this.#abortCurrent();
			throw error instanceof NativeAdminError ? error : new NativeAdminError();
		}
	}
	abortScope(scope: WorkScope): void {
		this.#abort(scope);
	}
	#abort(scope: WorkScope): void {
		this.#failed.add(scope);
		workAbort.call(this.#database, scope);
	}
	#abortCurrent(): void {
		if (this.#current) this.#abort(this.#current);
	}
	#mutate<T>(tx: SqlTransaction, scope: WorkScope, work: () => T): T {
		try {
			if (workSql.call(this.#database, scope) !== tx) refuse();
			this.#reader(tx);
			return work();
		} catch (error) {
			try {
				this.#abort(scope);
			} catch {
				/* A foreign scope grants nothing. */
			}
			this.#abortCurrent();
			throw error instanceof NativeAdminError ? error : new NativeAdminError();
		}
	}
	assertScope(tx: SqlTransaction, scope: WorkScope): void {
		this.#mutate(tx, scope, () => undefined);
	}
	#mac(value: unknown): string {
		if (!this.#key) refuse();
		return createHmac("sha256", this.#key)
			.update("draftyak/native-account-mode-operation/v1\n")
			.update(canonicalize(value))
			.digest("hex");
	}
	#load(tx: SqlTransaction, operationId: string): Loaded {
		this.#reader(tx);
		const row = tx.get<Row>(ROW, [id(operationId)]);
		if (!row) refuse("NOT_FOUND");
		const { mac, ...signed } = row;
		if (
			typeof row.payload !== "string" ||
			typeof mac !== "string" ||
			!Sha256Hex.safeParse(mac).success ||
			!timingSafeEqual(Buffer.from(mac, "hex"), Buffer.from(this.#mac(signed), "hex"))
		)
			refuse();
		const record = capture(JSON.parse(row.payload));
		if (
			canonicalize(record) !== row.payload ||
			row.id !== record.id ||
			row.kind !== record.kind ||
			row.owner_user_id !== record.owner ||
			row.epoch !== record.epoch ||
			row.account_id !== record.account.id ||
			row.account_generation !== record.generation ||
			row.state !== record.state
		)
			refuse();
		const latest = tx.get<{ seq: number; mac: string }>(
			"SELECT seq,mac FROM main.audit_events NOT INDEXED WHERE action IN ('admin.account_mode.opened','admin.account_mode.applied') AND refs=? ORDER BY seq DESC LIMIT 1",
			[canonicalize({ account: record.account.id, operation: record.id })],
		);
		if (!latest || latest.seq !== row.audit_seq || latest.mac !== row.audit_mac) refuse();
		return { record, version: integer(row.audit_seq, 1) };
	}
	#save(tx: SqlTransaction, record: Operation, actor: string, previousVersion?: number): Loaded {
		this.#reader(tx);
		const value = capture(record),
			payload = canonicalize(value);
		if (Buffer.byteLength(payload) > 32768) refuse();
		auditAppend.call(this.#audit, tx, {
			id: newId(),
			at: this.#sample().wall,
			action:
				value.state === "pending" ? "admin.account_mode.opened" : "admin.account_mode.applied",
			actor: { kind: "device", id: id(actor) },
			refs: { account: value.account.id, operation: value.id },
		});
		const head = tx.get<{ audit_seq: number; audit_head: string }>(
			"SELECT audit_seq,audit_head FROM main.audit_meta WHERE singleton=1",
		);
		if (!head || !Sha256Hex.safeParse(head.audit_head).success) refuse();
		const signed = {
				id: value.id,
				kind: value.kind,
				owner_user_id: value.owner,
				epoch: value.epoch,
				account_id: value.account.id,
				account_generation: value.generation,
				state: value.state,
				payload,
				audit_seq: integer(head.audit_seq, 1),
				audit_mac: head.audit_head,
			},
			mac = this.#mac(signed);
		if (previousVersion === undefined)
			tx.run(
				"INSERT INTO main.native_admin_operations(id,kind,owner_user_id,epoch,account_id,account_generation,state,payload,audit_seq,audit_mac,mac) VALUES(?,?,?,?,?,?,?,?,?,?,?)",
				[...Object.values(signed), mac],
			);
		else if (
			tx.run(
				"UPDATE main.native_admin_operations SET state=?,payload=?,audit_seq=?,audit_mac=?,mac=? WHERE id=? AND state='pending' AND audit_seq=?",
				[value.state, payload, signed.audit_seq, signed.audit_mac, mac, value.id, previousVersion],
			).changes !== 1
		)
			refuse("STALE");
		return { record: value, version: signed.audit_seq };
	}
	#grant(tx: SqlTransaction, peer: NativeDevicePeer, owner: string, epoch: number): DeviceGrant {
		const grant = requirePeer.call(this.#authorizer, tx, peer, "admin");
		if (grant.userId !== owner || grant.ownerUserId !== owner || grant.epoch !== epoch)
			refuse("STALE");
		assertGrant.call(this.#authorizer, tx, grant);
		return grant;
	}
	#currentAccount(scope: WorkScope, owner: string, accountId: string): AccountRecord {
		return accountGet.call(this.#accounts, scope, owner, accountId) ?? refuse("NOT_FOUND");
	}
	#review(record: Operation, live: LiveOperation, now: ClockSample): OperationReview {
		this.#time(live, now);
		return OperationReview.parse({
			id: record.id,
			kind: record.kind,
			digest: record.digest,
			subject: record.subject,
			expiresAt: record.expiresAt,
			remainingMs: Math.max(
				0,
				Math.floor(
					Math.min(record.expiresAt - now.wall, ADMIN_OPERATION_TTL_MS - (now.mono - live.mono)),
				),
			),
		});
	}
	open(peer: NativeDevicePeer, request: OperationRequest): OperationReview {
		let accountId: string;
		try {
			const input = OperationRequest.parse(dataCopy(request));
			if (input.kind !== "account.mode-full" || input.ids.length !== 1) refuse("INVALID_REQUEST");
			accountId = id(input.ids[0]);
		} catch {
			throw new NativeAdminError("INVALID_REQUEST");
		}
		const opened = this.write((tx, scope) => {
			const state = registryState.call(this.#devices, tx);
			if (!state.bootstrapDone || state.ownerUserId === null) refuse();
			const owner = state.ownerUserId,
				current = this.#currentAccount(scope, owner, accountId);
			eligible(current.account);
			const now = this.#sample(),
				grant = this.#grant(tx, peer, owner, state.epoch),
				operationId = newId(now.wall),
				nativeSubject = subject(current.account),
				live: LiveOperation = {
					wall: now.wall,
					mono: now.mono,
					expires: integer(now.wall + ADMIN_OPERATION_TTL_MS),
					account: canonicalize(current.account),
					generation: current.generation,
					owner,
					epoch: state.epoch,
				};
			for (const [key, value] of this.#live)
				if (now.wall > value.expires || now.mono - value.mono > ADMIN_OPERATION_TTL_MS)
					this.#live.delete(key);
			if (this.#live.size >= 256) refuse();
			const saved = this.#save(
				tx,
				{
					id: operationId,
					kind: "account.mode-full",
					owner,
					epoch: state.epoch,
					account: current.account,
					generation: current.generation,
					subject: nativeSubject,
					digest: jcsSha256(nativeSubject),
					issuedAt: now.wall,
					expiresAt: live.expires,
					state: "pending",
					appliedAt: null,
					appliedGeneration: null,
				},
				grant.deviceId,
			);
			const after = this.#currentAccount(scope, owner, accountId),
				finalTime = this.#sample();
			if (after.generation !== current.generation || canonicalize(after.account) !== live.account)
				refuse("STALE");
			this.#time(live, finalTime);
			this.#grant(tx, peer, owner, state.epoch);
			return { saved, live, now: finalTime };
		});
		this.#active();
		this.#live.set(opened.saved.record.id, opened.live);
		return this.#review(opened.saved.record, opened.live, opened.now);
	}
	#pending(
		tx: SqlTransaction,
		scope: WorkScope,
		peer: NativeDevicePeer,
		operationId: string,
	): {
		loaded: Loaded;
		live: LiveOperation;
		current: AccountRecord;
		grant: DeviceGrant;
		now: ClockSample;
	} {
		const live = this.#live.get(id(operationId));
		if (!live) refuse("STALE");
		const loaded = this.#load(tx, operationId),
			record = loaded.record,
			current = this.#currentAccount(scope, record.owner, record.account.id),
			now = this.#sample();
		if (
			record.state !== "pending" ||
			record.owner !== live.owner ||
			record.epoch !== live.epoch ||
			record.generation !== live.generation ||
			record.issuedAt !== live.wall ||
			record.expiresAt !== live.expires ||
			canonicalize(record.account) !== live.account ||
			current.generation !== record.generation ||
			canonicalize(current.account) !== live.account
		)
			refuse("STALE");
		eligible(current.account);
		this.#time(live, now);
		const grant = this.#grant(tx, peer, record.owner, record.epoch);
		return { loaded, live, current, grant, now };
	}
	prepare(
		tx: SqlTransaction,
		scope: WorkScope,
		peer: NativeDevicePeer,
		operationId: string,
	): AccountModePrepared {
		return this.#mutate(tx, scope, () => {
			const pending = this.#pending(tx, scope, peer, operationId),
				record = pending.loaded.record;
			return Object.freeze({
				fields: Object.freeze({ op: record.id, kind: record.kind, digest: record.digest }),
				dataClass: DataClass.parse(
					record.account.channel === "email" ? "gmail.metadata" : "slack.metadata",
				),
				operationVersion: pending.loaded.version,
			});
		});
	}
	review(peer: NativeDevicePeer, operationId: string): OperationReview {
		return this.write((tx, scope) => {
			const pending = this.#pending(tx, scope, peer, operationId);
			return this.#review(pending.loaded.record, pending.live, pending.now);
		});
	}
	apply(tx: SqlTransaction, scope: WorkScope, context: AdminAcceptContext): void {
		this.#mutate(tx, scope, () => {
			const facts = consumeAdminChallengeContext(context, this, tx, scope),
				statement = facts.statement,
				pending = this.#pending(tx, scope, facts.peer, statement.op),
				record = pending.loaded.record;
			if (
				statement.kind !== record.kind ||
				statement.digest !== record.digest ||
				statement.hub !== this.#identity.hid ||
				statement.epoch !== record.epoch ||
				facts.epoch !== record.epoch ||
				facts.owner !== record.owner ||
				statement.device !== pending.grant.deviceId ||
				facts.deviceId !== pending.grant.deviceId ||
				facts.approvalKey !== pending.grant.approvalKey ||
				facts.operationVersion !== pending.loaded.version ||
				pending.now.wall < facts.now.wall ||
				pending.now.mono < facts.now.mono
			)
				refuse("STALE");
			const next = Account.parse({ ...pending.current.account, mode: "full" }),
				changed = accountReplace.call(this.#accounts, scope, next, record.generation);
			if (
				changed.generation !== record.generation + 1 ||
				canonicalize(changed.account) !== canonicalize(next)
			)
				refuse("STALE");
			const saved = this.#save(
				tx,
				{
					...record,
					state: "applied",
					appliedAt: this.#sample().wall,
					appliedGeneration: changed.generation,
				},
				pending.grant.deviceId,
				pending.loaded.version,
			);
			const current = this.#currentAccount(scope, record.owner, record.account.id),
				after = this.#load(tx, record.id),
				now = this.#sample();
			this.#time(pending.live, now);
			if (
				now.wall < facts.now.wall ||
				now.mono < facts.now.mono ||
				current.generation !== record.generation + 1 ||
				canonicalize(current.account) !== canonicalize(next) ||
				after.version !== saved.version ||
				canonicalize(after.record) !== canonicalize(saved.record)
			)
				refuse("STALE");
			const grant = this.#grant(tx, facts.peer, record.owner, record.epoch);
			if (grant.deviceId !== facts.deviceId || grant.approvalKey !== facts.approvalKey)
				refuse("STALE");
		});
	}
	lock(): void {
		this.#abortCurrent();
		this.#key?.fill(0);
		this.#key = undefined;
		this.#live.clear();
		owners.delete(this);
	}
}

const original = Object.freeze({
	active: NativeAccountModeOperations.prototype.assertActive,
	open: NativeAccountModeOperations.prototype.open,
	review: NativeAccountModeOperations.prototype.review,
	lock: NativeAccountModeOperations.prototype.lock,
	owns: NativeAccountModeOperations.prototype.ownsOperation,
	write: NativeAccountModeOperations.prototype.write,
	assertScope: NativeAccountModeOperations.prototype.assertScope,
	abortScope: NativeAccountModeOperations.prototype.abortScope,
	prepare: NativeAccountModeOperations.prototype.prepare,
	apply: NativeAccountModeOperations.prototype.apply,
});
export function openNativeAdminOperation(
	issuer: NativeAccountModeOperations,
	peer: NativeDevicePeer,
	request: OperationRequest,
): OperationReview {
	return original.open.call(issuer, peer, request);
}
export function reviewNativeAdminOperation(
	issuer: NativeAccountModeOperations,
	peer: NativeDevicePeer,
	operationId: string,
): OperationReview {
	return original.review.call(issuer, peer, operationId);
}
export function lockNativeAdminOperations(issuer: NativeAccountModeOperations): void {
	original.lock.call(issuer);
}
export function assertNativeAdminOperations(issuer: unknown, store: HubStore): void {
	if (!issuer || typeof issuer !== "object" || owners.get(issuer) !== store) refuse();
	original.active.call(issuer as NativeAccountModeOperations);
}
function actual(issuer: unknown): NativeAccountModeOperations {
	if (!issuer || typeof issuer !== "object") refuse();
	const store = owners.get(issuer);
	if (!store) refuse();
	assertNativeAdminOperations(issuer, store);
	return issuer as NativeAccountModeOperations;
}
export function ownsNativeAdminOperation(issuer: unknown, operationId: string): boolean {
	return original.owns.call(actual(issuer), operationId);
}
export function writeNativeAdminOperations<T>(
	issuer: unknown,
	work: (tx: SqlTransaction, scope: WorkScope) => T,
): T {
	return original.write.call(actual(issuer), work) as T;
}
export function assertNativeAdminScope(
	issuer: unknown,
	tx: SqlTransaction,
	scope: WorkScope,
): void {
	original.assertScope.call(actual(issuer), tx, scope);
}
export function abortNativeAdminScope(issuer: unknown, scope: WorkScope): void {
	original.abortScope.call(issuer as NativeAccountModeOperations, scope);
}
export function prepareNativeAdminOperation(
	issuer: unknown,
	tx: SqlTransaction,
	scope: WorkScope,
	peer: NativeDevicePeer,
	operationId: string,
): AccountModePrepared {
	return original.prepare.call(actual(issuer), tx, scope, peer, operationId);
}
export function applyNativeAdminOperation(
	issuer: unknown,
	tx: SqlTransaction,
	scope: WorkScope,
	context: AdminAcceptContext,
): void {
	original.apply.call(actual(issuer), tx, scope, context);
}
