import { createHmac, timingSafeEqual } from "node:crypto";
import { fileURLToPath } from "node:url";
import { types } from "node:util";
import { DataClass } from "@draftyak/protocol/data-class";
import {
	AdminDataBackupSubject,
	OperationRequest,
	OperationReview,
} from "@draftyak/protocol/device-api";
import { jcsSha256 } from "@draftyak/protocol/hash";
import { canonicalize } from "@draftyak/protocol/jcs";
import { Sha256Hex, UtcMs } from "@draftyak/protocol/scalars";
import { STATEMENT_TTL_MS } from "@draftyak/protocol/statements";
import { AuditChain } from "../audit/chain.ts";
import { Authorizer } from "../authz/authorizer.ts";
import type { NativeDevicePeer } from "../authz/native-peer.ts";
import { dataMember, isPlainFunction } from "../extensions/values.ts";
import { WorkDatabase, type WorkScope } from "../jobs/database.ts";
import { fields, id, integer } from "../jobs/values.ts";
import { type Clock, systemClock } from "../kernel/clock.ts";
import { newId } from "../kernel/ids.ts";
import { MasterKey } from "../kernel/master-key.ts";
import { assertHubSessionAdmission, type HubSession } from "../lifecycle/session.ts";
import { readStamp } from "../store/read-stamp.ts";
import {
	assertStoreTransaction,
	HubStore,
	type SqlReader,
	type SqlTransaction,
} from "../store/store.ts";
import { NativeAdminError, refuseAdminOperation as refuse } from "./admin-errors.ts";
import { consumeAdminChallengeContext } from "./challenges.ts";
import type { AdminAcceptContext } from "./challenges-admin.ts";
import { type ClockSample, dataCopy } from "./challenges-support.ts";
import { type DeviceGrant, DeviceRegistry } from "./devices.ts";

export const BACKUP_OPERATION_TTL_MS: number = STATEMENT_TTL_MS;
export const BACKUP_OPERATION_MIGRATIONS: string = fileURLToPath(
	new URL(
		import.meta.url.endsWith(".ts") ? "./backup-migrations/" : "./identity/backup-migrations/",
		import.meta.url,
	),
);
export interface BackupPrepared {
	readonly fields: { readonly op: string; readonly kind: "data.backup"; readonly digest: string };
	readonly dataClass: DataClass;
	readonly operationVersion: number;
}
declare const backupLeaseBrand: unique symbol;
/** One-use native authorization. Only the committed genuine challenge path can issue one. */
export interface NativeBackupLease {
	readonly [backupLeaseBrand]: true;
}
declare const backupExecutionBrand: unique symbol;
/** A consumed authorization, rechecked natively through an artifact's asynchronous lifetime. */
export interface NativeBackupExecution {
	readonly [backupExecutionBrand]: true;
}
interface Operation {
	readonly id: string;
	readonly kind: "data.backup";
	readonly owner: string;
	readonly epoch: number;
	readonly subject: AdminDataBackupSubject;
	readonly digest: string;
	readonly issuedAt: number;
	readonly expiresAt: number;
	readonly state: "pending" | "applied";
	readonly appliedAt: number | null;
}
interface Row {
	readonly id: unknown;
	readonly kind: unknown;
	readonly owner_user_id: unknown;
	readonly epoch: unknown;
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
	readonly owner: string;
	readonly epoch: number;
}
interface Authorized {
	readonly issuer: NativeBackupOperations;
	readonly session: HubSession;
	readonly operationId: string;
	readonly version: number;
	readonly owner: string;
	readonly epoch: number;
	readonly peer: NativeDevicePeer;
	readonly deviceId: string;
	readonly approvalKey: string;
	readonly live: LiveOperation;
}
interface WriteFrame {
	readonly staged: Authorized[];
	revoked: boolean;
}
interface ExecutionState {
	readonly value: Authorized;
	active: boolean;
}
const issuers = new WeakMap<object, HubStore>();
const leases = new WeakMap<NativeBackupLease, Authorized>();
const executions = new WeakMap<NativeBackupExecution, ExecutionState>();
const read = HubStore.prototype.read,
	assertKey = HubStore.prototype.assertMasterKey;
const derive = MasterKey.prototype.derive;
const workWrite = WorkDatabase.prototype.write,
	workSql = WorkDatabase.prototype.sql,
	workAbort = WorkDatabase.prototype.abort;
const auditVerify = AuditChain.prototype.verify,
	auditAppend = AuditChain.prototype.append;
const registryStore = DeviceRegistry.prototype.assertStore,
	registryIdentity = DeviceRegistry.prototype.assertIdentity,
	registryState = DeviceRegistry.prototype.state;
const requirePeer = Authorizer.prototype.requirePeerDevice,
	assertGrant = Authorizer.prototype.assertCurrentGrant;
const opFields = [
	"id",
	"kind",
	"owner",
	"epoch",
	"subject",
	"digest",
	"issuedAt",
	"expiresAt",
	"state",
	"appliedAt",
] as const;
const ROW = `SELECT id,kind,owner_user_id,epoch,state,
 CASE WHEN typeof(payload)='text' AND length(CAST(payload AS BLOB)) BETWEEN 2 AND 32768 THEN payload END AS payload,
 audit_seq,CASE WHEN typeof(audit_mac)='text' AND length(CAST(audit_mac AS BLOB))=64 THEN audit_mac END AS audit_mac,
 CASE WHEN typeof(mac)='text' AND length(CAST(mac AS BLOB))=64 THEN mac END AS mac
 FROM main.native_backup_operations WHERE id=?`;

function capture(raw: unknown): Operation {
	const value = fields(dataCopy(raw), opFields),
		subject = AdminDataBackupSubject.parse(value.subject),
		issuedAt = integer(value.issuedAt),
		expiresAt = integer(value.expiresAt),
		state = value.state,
		appliedAt = value.appliedAt === null ? null : integer(value.appliedAt);
	if (
		value.kind !== "data.backup" ||
		(state !== "pending" && state !== "applied") ||
		value.digest !== jcsSha256(subject) ||
		expiresAt - issuedAt !== BACKUP_OPERATION_TTL_MS ||
		!UtcMs.safeParse(issuedAt).success ||
		!UtcMs.safeParse(expiresAt).success ||
		(state === "pending"
			? appliedAt !== null
			: appliedAt === null || appliedAt < issuedAt || appliedAt > expiresAt)
	)
		refuse();
	return Object.freeze({
		id: id(value.id),
		kind: "data.backup",
		owner: id(value.owner),
		epoch: integer(value.epoch),
		subject: Object.freeze(subject),
		digest: jcsSha256(subject),
		issuedAt,
		expiresAt,
		state,
		appliedAt,
	});
}
function failure(error: unknown): NativeAdminError {
	return !types.isProxy(error) && error instanceof NativeAdminError
		? error
		: new NativeAdminError();
}
function executionState(execution: unknown): ExecutionState {
	if (!execution || typeof execution !== "object" || types.isProxy(execution)) refuse();
	const state = executions.get(execution as NativeBackupExecution);
	if (!state) refuse();
	return state;
}

/** Native authorization for an encrypted backup, without creating or delivering an artifact. */
export class NativeBackupOperations {
	readonly #session: HubSession;
	readonly #store: HubStore;
	readonly #audit: AuditChain;
	readonly #devices: DeviceRegistry;
	readonly #authorizer: Authorizer;
	readonly #database: WorkDatabase;
	readonly #wall: () => unknown;
	readonly #mono: () => unknown;
	readonly #scopes = new WeakMap<SqlTransaction, WorkScope>();
	readonly #failed = new WeakSet<WorkScope>();
	readonly #live = new Map<string, LiveOperation>();
	readonly #authorized = new Map<string, Authorized>();
	readonly #leases = new Map<string, NativeBackupLease>();
	readonly #executions = new Map<string, NativeBackupExecution>();
	#current: WorkScope | undefined;
	#frame: WriteFrame | undefined;
	#key: Buffer | undefined;
	constructor(session: unknown, masterKey: MasterKey, clock: Clock = systemClock) {
		let key: Buffer | undefined;
		try {
			assertHubSessionAdmission(session);
			if ([session, masterKey, clock].some(types.isProxy)) refuse();
			const source = session as HubSession;
			assertKey.call(source.store, masterKey);
			registryStore.call(source.devices, source.store);
			registryIdentity.call(source.devices, source.identity);
			const wall = dataMember(clock, "wallMs", "config"),
				mono = dataMember(clock, "monotonicMs", "config");
			if (
				!isPlainFunction(wall) ||
				!isPlainFunction(mono) ||
				types.isAsyncFunction(wall) ||
				types.isAsyncFunction(mono)
			)
				refuse();
			read.call(source.store, (tx) => {
				auditVerify.call(source.audit, tx);
				tx.get("SELECT id FROM main.native_backup_operations LIMIT 1");
			});
			key = derive.call(masterKey, "approvals");
			this.#session = source;
			this.#store = source.store;
			this.#audit = source.audit;
			this.#devices = source.devices;
			this.#authorizer = new Authorizer(source.devices);
			this.#database = new WorkDatabase(source.store);
			this.#wall = () => wall.call(clock);
			this.#mono = () => mono.call(clock);
			assertHubSessionAdmission(source);
			assertKey.call(source.store, masterKey);
			registryStore.call(source.devices, source.store);
			this.#key = key;
			issuers.set(this, source.store);
		} catch {
			key?.fill(0);
			throw new NativeAdminError();
		}
	}
	assertActive(): void {
		this.#active();
	}
	#active(): void {
		try {
			if (!this.#key || issuers.get(this) !== this.#store) refuse();
			assertHubSessionAdmission(this.#session);
			registryStore.call(this.#devices, this.#store);
		} catch {
			throw new NativeAdminError();
		}
	}
	#sample(): ClockSample {
		this.#active();
		const wall = this.#wall(),
			mono = this.#mono();
		this.#active();
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
			now.mono - live.mono > BACKUP_OPERATION_TTL_MS
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
		return this.#write(work);
	}
	#write<T>(work: (tx: SqlTransaction, scope: WorkScope) => T): T {
		this.#active();
		if (
			this.#frame ||
			typeof work !== "function" ||
			types.isProxy(work) ||
			types.isAsyncFunction(work)
		)
			refuse("INVALID_REQUEST");
		const frame: WriteFrame = { staged: [], revoked: false };
		this.#frame = frame;
		try {
			const result = workWrite.call(this.#database, (scope: WorkScope) => {
				const tx = workSql.call(this.#database, scope);
				this.#scopes.set(tx, scope);
				this.#current = scope;
				try {
					this.#reader(tx);
					return work(tx, scope);
				} catch (error) {
					this.#abort(scope);
					throw error;
				} finally {
					this.#scopes.delete(tx);
					this.#current = undefined;
				}
			}) as T;
			// HubStore forbids nested use; this return follows the real SQLite COMMIT.
			// Never publish a staged authorization from inside its transaction callback.
			if (frame.revoked) refuse();
			for (const authorization of frame.staged) this.#checkAuthorization(authorization);
			this.#active();
			for (const authorization of frame.staged)
				this.#authorized.set(authorization.operationId, authorization);
			return result;
		} catch (error) {
			frame.revoked = true;
			this.#abortCurrent();
			throw failure(error);
		} finally {
			frame.staged.length = 0;
			if (this.#frame === frame) this.#frame = undefined;
		}
	}
	abortScope(scope: WorkScope): void {
		this.#abort(scope);
	}
	#abort(scope: WorkScope): void {
		if (this.#frame) this.#frame.revoked = true;
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
			throw failure(error);
		}
	}
	assertScope(tx: SqlTransaction, scope: WorkScope): void {
		this.#mutate(tx, scope, () => undefined);
	}
	#mac(value: unknown): string {
		if (!this.#key) refuse();
		return createHmac("sha256", this.#key)
			.update("draftyak/native-data-backup-operation/v1\n")
			.update(canonicalize(value))
			.digest("hex");
	}
	#row(db: SqlReader, operationId: string): Loaded {
		this.#active();
		auditVerify.call(this.#audit, db);
		const row = db.get<Row>(ROW, [id(operationId)]);
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
			row.state !== record.state
		)
			refuse();
		const latest = db.get<{ seq: number; mac: string }>(
			"SELECT seq,mac FROM main.audit_events NOT INDEXED WHERE action IN ('admin.data_backup.opened','admin.data_backup.applied') AND refs=? ORDER BY seq DESC LIMIT 1",
			[canonicalize({ operation: record.id })],
		);
		if (!latest || latest.seq !== row.audit_seq || latest.mac !== row.audit_mac) refuse();
		return { record, version: integer(row.audit_seq, 1) };
	}
	#load(tx: SqlTransaction, operationId: string): Loaded {
		this.#reader(tx);
		return this.#row(tx, operationId);
	}
	#save(tx: SqlTransaction, record: Operation, actor: string, previousVersion?: number): Loaded {
		this.#reader(tx);
		const value = capture(record),
			payload = canonicalize(value);
		if (Buffer.byteLength(payload) > 32768) refuse();
		const now = this.#sample();
		auditAppend.call(this.#audit, tx, {
			id: newId(now.wall),
			at: now.wall,
			action: value.state === "pending" ? "admin.data_backup.opened" : "admin.data_backup.applied",
			actor: { kind: "device", id: id(actor) },
			refs: { operation: value.id },
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
				state: value.state,
				payload,
				audit_seq: integer(head.audit_seq, 1),
				audit_mac: head.audit_head,
			},
			mac = this.#mac(signed);
		if (previousVersion === undefined)
			tx.run(
				"INSERT INTO main.native_backup_operations(id,kind,owner_user_id,epoch,state,payload,audit_seq,audit_mac,mac) VALUES(?,?,?,?,?,?,?,?,?)",
				[...Object.values(signed), mac],
			);
		else if (
			tx.run(
				"UPDATE main.native_backup_operations SET state=?,payload=?,audit_seq=?,audit_mac=?,mac=? WHERE id=? AND state='pending' AND audit_seq=?",
				[value.state, payload, signed.audit_seq, signed.audit_mac, mac, value.id, previousVersion],
			).changes !== 1
		)
			refuse("STALE");
		return { record: value, version: signed.audit_seq };
	}
	#grant(db: SqlReader, peer: NativeDevicePeer, owner: string, epoch: number): DeviceGrant {
		const grant = requirePeer.call(this.#authorizer, db, peer, "admin");
		if (grant.userId !== owner || grant.ownerUserId !== owner || grant.epoch !== epoch)
			refuse("STALE");
		assertGrant.call(this.#authorizer, db, grant);
		return grant;
	}
	#authority(db: SqlReader, owner: string, epoch: number): void {
		const state = registryState.call(this.#devices, db);
		if (!state.bootstrapDone || state.ownerUserId !== owner || state.epoch !== epoch)
			refuse("STALE");
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
					Math.min(record.expiresAt - now.wall, BACKUP_OPERATION_TTL_MS - (now.mono - live.mono)),
				),
			),
		});
	}
	#expire(now: ClockSample): void {
		for (const [operation, live] of this.#live) {
			if (now.wall <= live.expires && now.mono - live.mono <= BACKUP_OPERATION_TTL_MS) continue;
			this.#live.delete(operation);
			this.#authorized.delete(operation);
			const lease = this.#leases.get(operation);
			if (lease) leases.delete(lease);
			this.#leases.delete(operation);
			const execution = this.#executions.get(operation);
			if (execution) executionState(execution).active = false;
			this.#executions.delete(operation);
		}
	}
	open(peer: NativeDevicePeer, request: OperationRequest): OperationReview {
		try {
			const parsed = OperationRequest.parse(dataCopy(request));
			if (parsed.kind !== "data.backup" || parsed.ids.length !== 0) refuse("INVALID_REQUEST");
		} catch {
			throw new NativeAdminError("INVALID_REQUEST");
		}
		const opened = this.#write((tx) => {
			const state = registryState.call(this.#devices, tx);
			if (!state.bootstrapDone || state.ownerUserId === null) refuse();
			const now = this.#sample(),
				owner = state.ownerUserId;
			this.#expire(now);
			if (this.#live.size >= 256) refuse();
			const live: LiveOperation = {
				wall: now.wall,
				mono: now.mono,
				expires: integer(now.wall + BACKUP_OPERATION_TTL_MS),
				owner,
				epoch: state.epoch,
			};
			const grant = this.#grant(tx, peer, owner, state.epoch);
			const subject = AdminDataBackupSubject.parse({ scope: "backup" });
			const saved = this.#save(
				tx,
				{
					id: newId(now.wall),
					kind: "data.backup",
					owner,
					epoch: state.epoch,
					subject,
					digest: jcsSha256(subject),
					issuedAt: now.wall,
					expiresAt: live.expires,
					state: "pending",
					appliedAt: null,
				},
				grant.deviceId,
			);
			const finalTime = this.#sample();
			this.#authority(tx, owner, state.epoch);
			this.#time(live, finalTime);
			this.#grant(tx, peer, owner, state.epoch);
			return { saved, live, now: finalTime };
		});
		this.#active();
		const currentTime = read.call(this.#store, (db: SqlReader) => {
			const loaded = this.#row(db, opened.saved.record.id),
				now = this.#sample();
			if (
				loaded.version !== opened.saved.version ||
				canonicalize(loaded.record) !== canonicalize(opened.saved.record)
			)
				refuse("STALE");
			this.#time(opened.live, now);
			this.#authority(db, opened.live.owner, opened.live.epoch);
			this.#grant(db, peer, opened.live.owner, opened.live.epoch);
			return now;
		}) as ClockSample;
		this.#active();
		this.#live.set(opened.saved.record.id, opened.live);
		return this.#review(opened.saved.record, opened.live, currentTime);
	}
	/** Routing DATA only; prepare still performs every authenticated native check. */
	owns(operationId: string): boolean {
		try {
			this.#active();
			return this.#live.has(id(operationId));
		} catch (error) {
			throw failure(error);
		}
	}
	#pending(
		tx: SqlTransaction,
		peer: NativeDevicePeer,
		operationId: string,
	): {
		loaded: Loaded;
		live: LiveOperation;
		now: ClockSample;
		grant: DeviceGrant;
	} {
		const live = this.#live.get(id(operationId));
		if (!live) refuse("STALE");
		const loaded = this.#load(tx, operationId),
			record = loaded.record,
			now = this.#sample();
		if (
			record.state !== "pending" ||
			record.owner !== live.owner ||
			record.epoch !== live.epoch ||
			record.issuedAt !== live.wall ||
			record.expiresAt !== live.expires
		)
			refuse("STALE");
		this.#time(live, now);
		this.#authority(tx, live.owner, live.epoch);
		const grant = this.#grant(tx, peer, live.owner, live.epoch);
		return { loaded, live, now, grant };
	}
	prepare(
		tx: SqlTransaction,
		scope: WorkScope,
		peer: NativeDevicePeer,
		operationId: string,
	): BackupPrepared {
		return this.#mutate(tx, scope, () => {
			const { loaded } = this.#pending(tx, peer, operationId);
			return Object.freeze({
				fields: Object.freeze({
					op: loaded.record.id,
					kind: "data.backup",
					digest: loaded.record.digest,
				}),
				dataClass: DataClass.parse("hub.state"),
				operationVersion: loaded.version,
			});
		});
	}
	review(peer: NativeDevicePeer, operationId: string): OperationReview {
		return this.#write((tx) => {
			const value = this.#pending(tx, peer, operationId);
			return this.#review(value.loaded.record, value.live, value.now);
		});
	}
	apply(tx: SqlTransaction, scope: WorkScope, context: AdminAcceptContext): void {
		this.#mutate(tx, scope, () => {
			const facts = consumeAdminChallengeContext(context, this, tx, scope),
				statement = facts.statement;
			const pending = this.#pending(tx, facts.peer, statement.op),
				record = pending.loaded.record;
			if (
				statement.kind !== "data.backup" ||
				statement.digest !== record.digest ||
				statement.hub !== this.#session.identity.hid ||
				statement.epoch !== record.epoch ||
				facts.owner !== record.owner ||
				facts.epoch !== record.epoch ||
				statement.device !== pending.grant.deviceId ||
				facts.deviceId !== pending.grant.deviceId ||
				facts.approvalKey !== pending.grant.approvalKey ||
				facts.operationVersion !== pending.loaded.version ||
				pending.now.wall < facts.now.wall ||
				pending.now.mono < facts.now.mono
			)
				refuse("STALE");
			const saved = this.#save(
				tx,
				{ ...record, state: "applied", appliedAt: pending.now.wall },
				facts.deviceId,
				pending.loaded.version,
			);
			const after = this.#load(tx, record.id),
				now = this.#sample();
			this.#time(pending.live, now);
			this.#authority(tx, record.owner, record.epoch);
			if (
				after.version !== saved.version ||
				canonicalize(after.record) !== canonicalize(saved.record) ||
				now.wall < facts.now.wall ||
				now.mono < facts.now.mono
			)
				refuse("STALE");
			const grant = this.#grant(tx, facts.peer, record.owner, record.epoch);
			if (grant.deviceId !== facts.deviceId || grant.approvalKey !== facts.approvalKey)
				refuse("STALE");
			const frame = this.#frame;
			if (!frame || frame.revoked || frame.staged.length >= 256) refuse();
			frame.staged.push({
				issuer: this,
				session: this.#session,
				operationId: record.id,
				version: saved.version,
				owner: record.owner,
				epoch: record.epoch,
				peer: facts.peer,
				deviceId: grant.deviceId,
				approvalKey: grant.approvalKey,
				live: pending.live,
			});
		});
	}
	#checkAuthorization(value: Authorized): void {
		this.#active();
		if (
			value.issuer !== this ||
			value.session !== this.#session ||
			this.#live.get(value.operationId) !== value.live
		)
			refuse("STALE");
		read.call(this.#store, (db: SqlReader) => {
			const loaded = this.#row(db, value.operationId),
				now = this.#sample();
			if (
				loaded.record.state !== "applied" ||
				loaded.version !== value.version ||
				loaded.record.owner !== value.owner ||
				loaded.record.epoch !== value.epoch
			)
				refuse("STALE");
			this.#time(value.live, now);
			this.#authority(db, value.owner, value.epoch);
			const grant = this.#grant(db, value.peer, value.owner, value.epoch);
			if (grant.deviceId !== value.deviceId || grant.approvalKey !== value.approvalKey)
				refuse("STALE");
		});
		this.#active();
	}
	/** Internal only: remove the post-commit authorization before checking its currentness. */
	takeLease(peer: NativeDevicePeer, operationId: string): NativeBackupLease {
		try {
			const operation = id(operationId),
				value = this.#authorized.get(operation);
			this.#authorized.delete(operation);
			if (this.#frame || this.#current) {
				this.#abortCurrent();
				refuse();
			}
			if (!value || value.peer !== peer) refuse("STALE");
			this.#checkAuthorization(value);
			const lease = Object.freeze(Object.create(null)) as NativeBackupLease;
			leases.set(lease, value);
			this.#leases.set(operation, lease);
			return lease;
		} catch (error) {
			throw failure(error);
		}
	}
	/** Internal only: spending is irreversible even when later native checks refuse. */
	consumeLease(lease: NativeBackupLease, originalSession: unknown): NativeBackupExecution {
		try {
			const value = leases.get(lease);
			if (value) {
				leases.delete(lease);
				value.issuer.#leases.delete(value.operationId);
			}
			if (!value || value.issuer !== this || value.session !== originalSession) refuse();
			if (this.#frame || this.#current) {
				this.#abortCurrent();
				refuse();
			}
			this.#checkAuthorization(value);
			const execution = Object.freeze(Object.create(null)) as NativeBackupExecution;
			executions.set(execution, { value, active: true });
			this.#executions.set(value.operationId, execution);
			return execution;
		} catch (error) {
			throw failure(error);
		}
	}
	#execution(execution: unknown, originalSession: unknown): ExecutionState {
		const state = executionState(execution);
		if (!state.active || state.value.issuer !== this || state.value.session !== originalSession)
			refuse();
		this.#checkAuthorization(state.value);
		if (!state.active) refuse();
		return state;
	}
	assertExecutionCurrent(execution: unknown, originalSession: unknown): void {
		try {
			this.#execution(execution, originalSession);
		} catch (error) {
			throw failure(error);
		}
	}
	assertExecutionSigner(
		execution: unknown,
		originalSession: unknown,
		peer: NativeDevicePeer,
	): void {
		try {
			const state = this.#execution(execution, originalSession),
				value = state.value;
			read.call(this.#store, (db: SqlReader) => {
				const now = this.#sample();
				this.#time(value.live, now);
				this.#authority(db, value.owner, value.epoch);
				const grant = this.#grant(db, peer, value.owner, value.epoch);
				if (grant.deviceId !== value.deviceId || grant.approvalKey !== value.approvalKey)
					refuse("STALE");
			});
			this.#active();
			if (!state.active) refuse();
		} catch (error) {
			throw failure(error);
		}
	}
	retireExecution(execution: unknown, originalSession: unknown): void {
		const state = executionState(execution);
		if (state.value.issuer !== this || state.value.session !== originalSession) refuse();
		state.active = false;
		if (this.#executions.get(state.value.operationId) === execution)
			this.#executions.delete(state.value.operationId);
	}
	lock(): void {
		const key = this.#key;
		this.#key = undefined;
		key?.fill(0);
		this.#live.clear();
		this.#authorized.clear();
		for (const lease of this.#leases.values()) leases.delete(lease);
		this.#leases.clear();
		for (const execution of this.#executions.values()) executionState(execution).active = false;
		this.#executions.clear();
		if (this.#frame) {
			this.#frame.revoked = true;
			this.#frame.staged.length = 0;
		}
		this.#abortCurrent();
	}
}

// Capture original concrete methods only after this class is initialized; no cross-class TDZ.
const original = Object.freeze({
	active: NativeBackupOperations.prototype.assertActive,
	write: NativeBackupOperations.prototype.write,
	assertScope: NativeBackupOperations.prototype.assertScope,
	abortScope: NativeBackupOperations.prototype.abortScope,
	owns: NativeBackupOperations.prototype.owns,
	prepare: NativeBackupOperations.prototype.prepare,
	apply: NativeBackupOperations.prototype.apply,
	takeLease: NativeBackupOperations.prototype.takeLease,
	consumeLease: NativeBackupOperations.prototype.consumeLease,
	assertExecutionCurrent: NativeBackupOperations.prototype.assertExecutionCurrent,
	assertExecutionSigner: NativeBackupOperations.prototype.assertExecutionSigner,
	retireExecution: NativeBackupOperations.prototype.retireExecution,
});
function actual(issuer: unknown, active = true): NativeBackupOperations {
	if (!issuer || typeof issuer !== "object" || types.isProxy(issuer) || !issuers.has(issuer))
		refuse();
	if (active) original.active.call(issuer as NativeBackupOperations);
	return issuer as NativeBackupOperations;
}
export function assertNativeBackupOperations(issuer: unknown, store: HubStore): void {
	const target = actual(issuer);
	if (issuers.get(target) !== store) refuse();
}
export function writeNativeBackupOperations<T>(
	issuer: unknown,
	work: (tx: SqlTransaction, scope: WorkScope) => T,
): T {
	return original.write.call(actual(issuer), work) as T;
}
export function assertNativeBackupScope(
	issuer: unknown,
	tx: SqlTransaction,
	scope: WorkScope,
): void {
	original.assertScope.call(actual(issuer), tx, scope);
}
export function abortNativeBackupScope(issuer: unknown, scope: WorkScope): void {
	original.abortScope.call(actual(issuer, false), scope);
}
export function ownsNativeBackupOperation(issuer: unknown, operationId: string): boolean {
	return original.owns.call(actual(issuer), operationId);
}
export function prepareNativeBackupOperation(
	issuer: unknown,
	tx: SqlTransaction,
	scope: WorkScope,
	peer: NativeDevicePeer,
	operationId: string,
): BackupPrepared {
	return original.prepare.call(actual(issuer), tx, scope, peer, operationId);
}
export function applyNativeBackupOperation(
	issuer: unknown,
	tx: SqlTransaction,
	scope: WorkScope,
	context: AdminAcceptContext,
): void {
	original.apply.call(actual(issuer), tx, scope, context);
}
export function takeNativeBackupLease(
	issuer: unknown,
	peer: NativeDevicePeer,
	operationId: string,
): NativeBackupLease {
	return original.takeLease.call(actual(issuer, false), peer, operationId);
}
export function consumeNativeBackupLease(
	lease: unknown,
	originalSession: unknown,
): NativeBackupExecution {
	if (!lease || typeof lease !== "object" || types.isProxy(lease)) refuse();
	const value = leases.get(lease as NativeBackupLease);
	if (!value) refuse();
	// The genuine method spends its private lease before session/current-state validation.
	return original.consumeLease.call(value.issuer, lease as NativeBackupLease, originalSession);
}
export function assertNativeBackupExecutionCurrent(
	execution: unknown,
	originalSession: unknown,
): void {
	original.assertExecutionCurrent.call(
		executionState(execution).value.issuer,
		execution,
		originalSession,
	);
}
export function assertNativeBackupExecutionSigner(
	execution: unknown,
	originalSession: unknown,
	peer: NativeDevicePeer,
): void {
	original.assertExecutionSigner.call(
		executionState(execution).value.issuer,
		execution,
		originalSession,
		peer,
	);
}
export function retireNativeBackupExecution(execution: unknown, originalSession: unknown): void {
	// Terminal cleanup verifies only private provenance/session identity, never OPEN admission.
	original.retireExecution.call(executionState(execution).value.issuer, execution, originalSession);
}
