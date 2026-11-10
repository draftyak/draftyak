import { createHash, type Hash } from "node:crypto";
import { setImmediate as yieldTurn } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { types } from "node:util";
import { HOST_JSON_MEMBER_MAX_DECODED_BYTES } from "@draftyak/protocol/host-channel";
import type { BlobRef } from "@draftyak/protocol/normalized-change";
import { NativeAccounts } from "../accounts/records.ts";
import { DeviceRegistry } from "../identity/devices.ts";
import { WorkDatabase, type WorkScope } from "../jobs/database.ts";
import { fields, id, integer } from "../jobs/values.ts";
import type { Clock } from "../kernel/clock.ts";
import { newId } from "../kernel/ids.ts";
import type { JsonMemberWriter } from "../plugins/broker/blob/projection.ts";
import type { SqlTransaction } from "../store/store.ts";
import type { MetadataAccountRef } from "./account-ref.ts";

export const RAW_CONTENT_MIGRATIONS: string = fileURLToPath(
	new URL(
		import.meta.url.endsWith(".ts") ? "./raw-migrations/" : "./sync/raw-migrations/",
		import.meta.url,
	),
);
export const RAW_CONTENT_CHUNK_BYTES = 65_536;
export const RAW_CONTENT_MAX_BYTES: number = HOST_JSON_MEMBER_MAX_DECODED_BYTES;
const TTL = 60_000;
const MAX_TIME = 0xffffffffffff;
const DELETE_BATCH = 64;
const sqlFor = WorkDatabase.prototype.sql;
const poison = WorkDatabase.prototype.abort;
const write = WorkDatabase.prototype.write;
const accountGet = NativeAccounts.prototype.get;
const registryState = DeviceRegistry.prototype.state;
const signalAborted = Object.getOwnPropertyDescriptor(AbortSignal.prototype, "aborted")?.get;
const typedArray = Object.getPrototypeOf(Uint8Array.prototype) as object;
const arrayBuffer = Object.getOwnPropertyDescriptor(typedArray, "buffer")?.get;
const byteLength = Object.getOwnPropertyDescriptor(typedArray, "byteLength")?.get;
const byteOffset = Object.getOwnPropertyDescriptor(typedArray, "byteOffset")?.get;

export interface RawWriteLimits {
	readonly maxBytes?: number;
	readonly ttlMs?: number;
}
export interface RawContentSlice {
	readonly bytes: Uint8Array;
	readonly nextOffset: number | null;
	readonly totalBytes: number;
	readonly sha256: string;
}
export interface RawStagingCleanup {
	readonly deletedChunks: number;
	readonly deletedObjects: number;
	readonly more: boolean;
}
export class RawContentError extends Error {
	readonly code = "RAW_CONTENT_UNAVAILABLE";
	constructor() {
		super("Raw content unavailable");
		this.name = "RawContentError";
	}
}
function refuse(): never {
	throw new RawContentError();
}
function monotonic(value: unknown): number {
	if (
		typeof value !== "number" ||
		!Number.isFinite(value) ||
		value < 0 ||
		value > Number.MAX_SAFE_INTEGER
	)
		refuse();
	return value;
}
function signal(signal: AbortSignal): void {
	if (types.isProxy(signal) || !signalAborted || signalAborted.call(signal) !== false) refuse();
}
function reference(raw: MetadataAccountRef): MetadataAccountRef {
	const value = fields(raw, ["accountId", "generation", "pluginInstanceId", "ownerEpoch", "mode"]);
	if (value.mode !== "full" && value.mode !== "read_only") refuse();
	return Object.freeze({
		accountId: id(value.accountId),
		generation: integer(value.generation, 1),
		pluginInstanceId: id(value.pluginInstanceId),
		ownerEpoch: integer(value.ownerEpoch),
		mode: value.mode,
	});
}
function copyBytes(value: Uint8Array): Uint8Array {
	if (
		types.isProxy(value) ||
		!types.isUint8Array(value) ||
		!arrayBuffer ||
		!byteLength ||
		!byteOffset
	)
		refuse();
	const buffer: unknown = arrayBuffer.call(value);
	if (!types.isArrayBuffer(buffer) || types.isSharedArrayBuffer(buffer)) refuse();
	const length = integer(byteLength.call(value), 0, RAW_CONTENT_MAX_BYTES);
	const offset = integer(byteOffset.call(value));
	// Constructing this view also refuses a detached backing buffer, including an empty one.
	const view = new Uint8Array(buffer, offset, length);
	const result = new Uint8Array(length);
	Uint8Array.prototype.set.call(result, view);
	return result;
}
interface ObjectRow {
	valid: number;
	userId: string;
	accountId: string;
	generation: number;
	pluginInstanceId: string;
	mode: string;
	ownerEpoch: number;
	state: string;
	byteCount: number;
	chunkCount: number;
	maxBytes: number;
	expiresAt: number;
	sha256: string;
}
const OBJECT = `SELECT
 CASE WHEN length(CAST(user_id AS BLOB))=26 AND length(CAST(account_id AS BLOB))=26
 AND length(CAST(plugin_instance_id AS BLOB))=26 AND generation BETWEEN 1 AND 9007199254740991
 AND owner_epoch BETWEEN 0 AND 9007199254740991 AND mode IN ('full','read_only')
 AND state IN ('staged','committed','discarding') AND max_bytes BETWEEN 0 AND ${RAW_CONTENT_MAX_BYTES}
 AND byte_count BETWEEN 0 AND max_bytes AND chunk_count BETWEEN 0 AND 512
 AND expires_at BETWEEN 1 AND 9007199254740991 AND typeof(sha256)='text' AND length(sha256) IN (0,64)
 THEN 1 ELSE 0 END AS valid,
 CASE WHEN length(CAST(user_id AS BLOB))=26 THEN user_id END AS userId,
 CASE WHEN length(CAST(account_id AS BLOB))=26 THEN account_id END AS accountId,
 CASE WHEN generation BETWEEN 1 AND 9007199254740991 THEN generation END AS generation,
 CASE WHEN length(CAST(plugin_instance_id AS BLOB))=26 THEN plugin_instance_id END AS pluginInstanceId,
 CASE WHEN mode IN ('full','read_only') THEN mode END AS mode,
 CASE WHEN owner_epoch BETWEEN 0 AND 9007199254740991 THEN owner_epoch END AS ownerEpoch,
 CASE WHEN state IN ('staged','committed','discarding') THEN state END AS state,
 CASE WHEN byte_count BETWEEN 0 AND ${RAW_CONTENT_MAX_BYTES} THEN byte_count END AS byteCount,
 CASE WHEN chunk_count BETWEEN 0 AND 512 THEN chunk_count END AS chunkCount,
 CASE WHEN max_bytes BETWEEN 0 AND ${RAW_CONTENT_MAX_BYTES} THEN max_bytes END AS maxBytes,
 CASE WHEN expires_at BETWEEN 1 AND 9007199254740991 THEN expires_at END AS expiresAt,
 CASE WHEN typeof(sha256)='text' AND length(sha256) IN (0,64) THEN sha256 END AS sha256
 FROM main.rawcontent_objects WHERE id=?`;
interface WriterState {
	readonly blobId: string;
	readonly ownerId: string;
	readonly ref: MetadataAccountRef;
	readonly createdAt: number;
	readonly expiresAt: number;
	readonly monotonicAt: number;
	readonly ttl: number;
	readonly maxBytes: number;
	readonly pending: Uint8Array;
	readonly hash: Hash;
	used: number;
	total: number;
	persisted: number;
	chunks: number;
	busy: boolean;
	delivered: boolean;
	phase: "open" | "committed" | "aborted";
	cleanup?: Promise<void>;
}

/**
 * Encrypted, account-confined untrusted bytes for the broker's existing streaming writer.
 * The native caller separately admits its source and keeps the store open through async drain.
 * References and database scopes grant no source, file, send or retention authority.
 * Register RAW_CONTENT_MIGRATIONS explicitly; the reopen catalog never activates this component.
 */
export class NativeRawStore {
	readonly #database: WorkDatabase;
	readonly #accounts: NativeAccounts;
	readonly #devices: DeviceRegistry;
	readonly #clock: Clock;
	constructor(
		database: WorkDatabase,
		accounts: NativeAccounts,
		devices: DeviceRegistry,
		clock: Clock,
	) {
		this.#database = database;
		this.#accounts = accounts;
		this.#devices = devices;
		this.#clock = clock;
	}
	#work<T>(scope: WorkScope, work: (sql: SqlTransaction) => T): T {
		try {
			return work(sqlFor.call(this.#database, scope));
		} catch {
			try {
				poison.call(this.#database, scope);
			} catch {
				/* Foreign scopes remain refused. */
			}
			throw new RawContentError();
		}
	}
	#owner(sql: SqlTransaction): string {
		const state = registryState.call(this.#devices, sql);
		if (!state.bootstrapDone || state.ownerUserId === null) refuse();
		return id(state.ownerUserId);
	}
	#account(scope: WorkScope, sql: SqlTransaction, ref: MetadataAccountRef): string {
		const state = registryState.call(this.#devices, sql);
		if (!state.bootstrapDone || state.ownerUserId === null || state.epoch !== ref.ownerEpoch)
			refuse();
		const current = accountGet.call(this.#accounts, scope, state.ownerUserId, ref.accountId);
		const now = integer(this.#clock.wallMs(), 0, MAX_TIME);
		if (
			!current ||
			current.generation !== ref.generation ||
			current.account.userId !== state.ownerUserId ||
			current.account.pluginInstanceId !== ref.pluginInstanceId ||
			current.account.mode !== ref.mode ||
			current.account.status !== "active" ||
			(current.account.deletionDeadline !== null && current.account.deletionDeadline <= now)
		)
			refuse();
		return id(state.ownerUserId);
	}
	#object(sql: SqlTransaction, blobId: string): ObjectRow | undefined {
		const row = sql.get<ObjectRow>(OBJECT, [blobId]);
		if (!row) return undefined;
		if (row.valid !== 1) refuse();
		id(row.userId);
		id(row.accountId);
		id(row.pluginInstanceId);
		if (row.state === "committed" ? !/^[0-9a-f]{64}$/.test(row.sha256) : row.sha256 !== "")
			refuse();
		return row;
	}
	#matches(row: ObjectRow, ownerId: string, ref: MetadataAccountRef): void {
		// Creation epoch fences an unfinished writer. Retained bytes are data; a read
		// separately proves the live epoch/bootstrap and current account generation.
		if (
			row.userId !== ownerId ||
			row.accountId !== ref.accountId ||
			row.generation !== ref.generation ||
			row.pluginInstanceId !== ref.pluginInstanceId ||
			row.mode !== ref.mode
		)
			refuse();
	}
	#live(state: WriterState): void {
		const wall = integer(this.#clock.wallMs(), 0, MAX_TIME);
		const mono = monotonic(this.#clock.monotonicMs());
		if (
			state.phase !== "open" ||
			wall < state.createdAt ||
			wall >= state.expiresAt ||
			mono < state.monotonicAt ||
			mono - state.monotonicAt >= state.ttl
		)
			refuse();
	}
	begin(
		scope: WorkScope,
		input: MetadataAccountRef,
		limits: RawWriteLimits = {},
	): JsonMemberWriter {
		return this.#work(scope, (sql) => {
			const ref = reference(input);
			const ownerId = this.#account(scope, sql, ref);
			const options = fields(limits, [], ["maxBytes", "ttlMs"]);
			const maxBytes = integer(
				options.maxBytes === undefined ? RAW_CONTENT_MAX_BYTES : options.maxBytes,
				0,
				RAW_CONTENT_MAX_BYTES,
			);
			const ttl = integer(options.ttlMs === undefined ? TTL : options.ttlMs, 1, TTL);
			const createdAt = integer(this.#clock.wallMs(), 0, MAX_TIME - TTL);
			const monotonicAt = monotonic(this.#clock.monotonicMs());
			if (
				sql.all(
					"SELECT id FROM main.rawcontent_objects WHERE state IN ('staged','discarding') LIMIT 5",
				).length >= 4 ||
				sql.all(
					"SELECT id FROM main.rawcontent_objects WHERE state IN ('staged','discarding') AND account_id=? LIMIT 3",
					[ref.accountId],
				).length >= 2
			)
				refuse();
			const blobId = newId(createdAt);
			sql.run(
				`INSERT INTO main.rawcontent_objects
 (id,user_id,account_id,generation,plugin_instance_id,mode,owner_epoch,state,created_at,expires_at,max_bytes,byte_count,chunk_count,sha256)
 VALUES (?,?,?,?,?,?,?,'staged',?,?,?,0,0,'')`,
				[
					blobId,
					ownerId,
					ref.accountId,
					ref.generation,
					ref.pluginInstanceId,
					ref.mode,
					ref.ownerEpoch,
					createdAt,
					createdAt + ttl,
					maxBytes,
				],
			);
			return this.#writer({
				blobId,
				ownerId,
				ref,
				createdAt,
				expiresAt: createdAt + ttl,
				monotonicAt,
				ttl,
				maxBytes,
				pending: new Uint8Array(RAW_CONTENT_CHUNK_BYTES),
				hash: createHash("sha256"),
				used: 0,
				total: 0,
				persisted: 0,
				chunks: 0,
				busy: false,
				delivered: false,
				phase: "open",
			});
		});
	}
	#flush(state: WriterState): void {
		if (state.used === 0) return;
		const bytes = Buffer.from(state.pending.subarray(0, state.used));
		try {
			write.call(this.#database, (scope) =>
				this.#work(scope, (sql) => {
					this.#live(state);
					if (this.#account(scope, sql, state.ref) !== state.ownerId) refuse();
					const row = this.#object(sql, state.blobId);
					if (!row) refuse();
					this.#matches(row, state.ownerId, state.ref);
					if (
						row.state !== "staged" ||
						row.ownerEpoch !== state.ref.ownerEpoch ||
						row.byteCount !== state.persisted ||
						row.chunkCount !== state.chunks ||
						row.maxBytes !== state.maxBytes ||
						row.expiresAt !== state.expiresAt
					)
						refuse();
					sql.run(
						"INSERT INTO main.rawcontent_chunks(object_id,seq,bytes,sha256) VALUES(?,?,?,?)",
						[state.blobId, state.chunks, bytes, createHash("sha256").update(bytes).digest("hex")],
					);
					if (
						sql.run(
							"UPDATE main.rawcontent_objects SET byte_count=byte_count+?,chunk_count=chunk_count+1 WHERE id=? AND state='staged'",
							[bytes.length, state.blobId],
						).changes !== 1
					)
						refuse();
				}),
			);
			state.persisted += bytes.length;
			state.chunks++;
			state.pending.fill(0);
			state.used = 0;
		} finally {
			bytes.fill(0);
		}
	}
	#writer(state: WriterState): JsonMemberWriter {
		const stop = (): Promise<void> => {
			state.phase = "aborted";
			state.pending.fill(0);
			state.used = 0;
			state.cleanup ??= this.#discard(state);
			return state.cleanup;
		};
		const failed = async (): Promise<never> => {
			if (!state.delivered) {
				try {
					await stop();
				} catch {
					/* Preserve a fixed refusal. */
				}
			}
			throw new RawContentError();
		};
		return Object.freeze({
			write: async (input: Uint8Array, abortSignal: AbortSignal): Promise<void> => {
				let bytes: Uint8Array | undefined;
				try {
					if (state.busy || state.phase !== "open") refuse();
					signal(abortSignal);
					bytes = copyBytes(input);
					if (state.total + bytes.length > state.maxBytes) refuse();
					state.busy = true;
					state.total += bytes.length;
					state.hash.update(bytes);
					await Promise.resolve();
					this.#live(state);
					signal(abortSignal);
					write.call(this.#database, (scope) =>
						this.#work(scope, (sql) => {
							if (this.#account(scope, sql, state.ref) !== state.ownerId) refuse();
							const row = this.#object(sql, state.blobId);
							if (!row || row.state !== "staged" || row.ownerEpoch !== state.ref.ownerEpoch)
								refuse();
							this.#matches(row, state.ownerId, state.ref);
						}),
					);
					for (let offset = 0; offset < bytes.length; ) {
						this.#live(state);
						signal(abortSignal);
						const count = Math.min(bytes.length - offset, RAW_CONTENT_CHUNK_BYTES - state.used);
						state.pending.set(bytes.subarray(offset, offset + count), state.used);
						state.used += count;
						offset += count;
						if (state.used === RAW_CONTENT_CHUNK_BYTES) {
							this.#flush(state);
							await yieldTurn();
						}
					}
					this.#live(state);
					signal(abortSignal);
				} catch {
					return await failed();
				} finally {
					bytes?.fill(0);
					state.busy = false;
				}
			},
			commit: async (abortSignal: AbortSignal): Promise<BlobRef> => {
				try {
					if (state.busy || state.phase !== "open") refuse();
					signal(abortSignal);
					state.busy = true;
					this.#live(state);
					this.#flush(state);
					const sha256 = state.hash.digest("hex");
					write.call(this.#database, (scope) =>
						this.#work(scope, (sql) => {
							this.#live(state);
							if (this.#account(scope, sql, state.ref) !== state.ownerId) refuse();
							const row = this.#object(sql, state.blobId);
							if (!row) refuse();
							this.#matches(row, state.ownerId, state.ref);
							if (
								row.state !== "staged" ||
								row.ownerEpoch !== state.ref.ownerEpoch ||
								row.byteCount !== state.total ||
								row.chunkCount !== state.chunks ||
								state.persisted !== state.total
							)
								refuse();
							if (
								sql.run(
									"UPDATE main.rawcontent_objects SET state='committed',sha256=? WHERE id=? AND state='staged'",
									[sha256, state.blobId],
								).changes !== 1
							)
								refuse();
						}),
					);
					state.phase = "committed";
					await Promise.resolve();
					signal(abortSignal);
					if (state.phase !== "committed") refuse();
					state.delivered = true;
					return Object.freeze({ ref: state.blobId });
				} catch {
					return await failed();
				} finally {
					state.busy = false;
				}
			},
			abort: stop,
		});
	}
	async #discard(state: WriterState): Promise<void> {
		let more: boolean;
		do {
			const result = write.call(this.#database, (scope) =>
				this.#work(scope, (sql) => {
					const row = this.#object(sql, state.blobId);
					if (!row) return false;
					this.#matches(row, state.ownerId, state.ref);
					if (row.ownerEpoch !== state.ref.ownerEpoch) refuse();
					sql.run("UPDATE main.rawcontent_objects SET state='discarding',sha256='' WHERE id=?", [
						state.blobId,
					]);
					return this.#deleteBatch(sql, state.blobId).more;
				}),
			);
			if (typeof result !== "boolean") refuse();
			more = result;
			if (more) await yieldTurn();
		} while (more);
	}
	#deleteBatch(sql: SqlTransaction, blobId: string): RawStagingCleanup {
		const deleted = sql.run(
			`DELETE FROM main.rawcontent_chunks WHERE object_id=? AND seq IN
 (SELECT seq FROM main.rawcontent_chunks WHERE object_id=? ORDER BY seq LIMIT ${DELETE_BATCH})`,
			[blobId, blobId],
		).changes;
		const more = !!sql.get("SELECT 1 FROM main.rawcontent_chunks WHERE object_id=? LIMIT 1", [
			blobId,
		]);
		const removed = more
			? 0
			: sql.run("DELETE FROM main.rawcontent_objects WHERE id=? AND state<>'committed'", [blobId])
					.changes;
		return Object.freeze({ deletedChunks: deleted, deletedObjects: removed, more });
	}
	read(
		scope: WorkScope,
		input: MetadataAccountRef,
		blob: BlobRef,
		offset: number = 0,
		maxBytes: number = RAW_CONTENT_CHUNK_BYTES,
	): RawContentSlice {
		return this.#work(scope, (sql) => {
			const ref = reference(input),
				ownerId = this.#account(scope, sql, ref);
			const blobId = id(fields(blob, ["ref"]).ref);
			const row = this.#object(sql, blobId);
			if (!row || row.state !== "committed" || !/^[0-9a-f]{64}$/.test(row.sha256)) refuse();
			this.#matches(row, ownerId, ref);
			if (row.chunkCount !== Math.ceil(row.byteCount / RAW_CONTENT_CHUNK_BYTES)) refuse();
			const layout = sql.get<{
				count: number;
				bytes: number | null;
				first: number | null;
				last: number | null;
			}>(
				"SELECT count(*) AS count,sum(length(bytes)) AS bytes,min(seq) AS first,max(seq) AS last FROM main.rawcontent_chunks WHERE object_id=?",
				[blobId],
			);
			if (
				!layout ||
				layout.count !== row.chunkCount ||
				(layout.bytes ?? 0) !== row.byteCount ||
				(row.chunkCount > 0 && (layout.first !== 0 || layout.last !== row.chunkCount - 1))
			)
				refuse();
			const start = integer(offset, 0, row.byteCount),
				count = Math.min(integer(maxBytes, 1, RAW_CONTENT_CHUNK_BYTES), row.byteCount - start);
			const result = new Uint8Array(count);
			for (let copied = 0; copied < count; ) {
				const position = start + copied,
					sequence = Math.floor(position / RAW_CONTENT_CHUNK_BYTES);
				const chunk = sql.get<{ bytes: Uint8Array | null; sha256: string | null }>(
					`SELECT
 CASE WHEN typeof(bytes)='blob' AND length(bytes) BETWEEN 1 AND ${RAW_CONTENT_CHUNK_BYTES} THEN bytes END AS bytes,
 CASE WHEN typeof(sha256)='text' AND length(sha256)=64 THEN sha256 END AS sha256
 FROM main.rawcontent_chunks WHERE object_id=? AND seq=?`,
					[blobId, sequence],
				);
				const expected = Math.min(
					RAW_CONTENT_CHUNK_BYTES,
					row.byteCount - sequence * RAW_CONTENT_CHUNK_BYTES,
				);
				if (
					!chunk ||
					!chunk.bytes ||
					chunk.bytes.length !== expected ||
					typeof chunk.sha256 !== "string" ||
					createHash("sha256").update(chunk.bytes).digest("hex") !== chunk.sha256
				)
					refuse();
				const from = position % RAW_CONTENT_CHUNK_BYTES,
					take = Math.min(count - copied, chunk.bytes.length - from);
				result.set(chunk.bytes.subarray(from, from + take), copied);
				copied += take;
			}
			return Object.freeze({
				bytes: result,
				nextOffset: start + count === row.byteCount ? null : start + count,
				totalBytes: row.byteCount,
				sha256: row.sha256,
			});
		});
	}
	expireStaging(scope: WorkScope): RawStagingCleanup {
		return this.#work(scope, (sql) => {
			const owner = this.#owner(sql),
				now = integer(this.#clock.wallMs(), 0, MAX_TIME);
			const selected =
				sql.get<{ id: string }>(
					`SELECT id FROM main.rawcontent_objects
 WHERE user_id=? AND state='discarding' ORDER BY expires_at,id LIMIT 1`,
					[owner],
				) ??
				sql.get<{ id: string }>(
					`SELECT id FROM main.rawcontent_objects
 WHERE user_id=? AND state='staged' AND expires_at<=? ORDER BY expires_at,id LIMIT 1`,
					[owner, now],
				);
			if (!selected) return Object.freeze({ deletedChunks: 0, deletedObjects: 0, more: false });
			const blobId = id(selected.id);
			sql.run(
				"UPDATE main.rawcontent_objects SET state='discarding',sha256='' WHERE id=? AND state<>'committed'",
				[blobId],
			);
			const result = this.#deleteBatch(sql, blobId);
			const more =
				result.more ||
				!!sql.get(
					`SELECT 1 FROM main.rawcontent_objects
 WHERE user_id=? AND state='discarding' LIMIT 1`,
					[owner],
				) ||
				!!sql.get(
					`SELECT 1 FROM main.rawcontent_objects WHERE user_id=? AND state='staged' AND expires_at<=? LIMIT 1`,
					[owner, now],
				);
			return Object.freeze({ ...result, more });
		});
	}
}
