import type { BlobRef } from "@draftyak/protocol/normalized-change";
import { fields, id, integer } from "../jobs/values.ts";
import type { SqlTransaction, SqlValue } from "../store/store.ts";

export const COMMITTED_BODY_EVICTION_CHUNK_LIMIT: number = 64;

/** DDL output for the owning migration writer; never executed by this resource. */
export const COMMITTED_BODY_EVICTION_JOURNAL_SQL: string = `CREATE TABLE committed_body_evictions (
 eviction_id TEXT PRIMARY KEY NOT NULL CHECK(length(eviction_id)=26 AND eviction_id NOT GLOB '*[^0-9A-HJKMNP-TV-Z]*'),
 message_id TEXT NOT NULL CHECK(length(message_id)=26 AND message_id NOT GLOB '*[^0-9A-HJKMNP-TV-Z]*'),
 raw_ref TEXT UNIQUE NOT NULL CHECK(length(raw_ref)=26 AND raw_ref NOT GLOB '*[^0-9A-HJKMNP-TV-Z]*'),
 account_id TEXT NOT NULL CHECK(length(account_id)=26 AND account_id NOT GLOB '*[^0-9A-HJKMNP-TV-Z]*'),
 generation INTEGER NOT NULL CHECK(generation BETWEEN 1 AND 9007199254740991),
 user_id TEXT NOT NULL CHECK(length(user_id)=26 AND user_id NOT GLOB '*[^0-9A-HJKMNP-TV-Z]*'),
 plugin_instance_id TEXT NOT NULL CHECK(length(plugin_instance_id)=26 AND plugin_instance_id NOT GLOB '*[^0-9A-HJKMNP-TV-Z]*'),
 mode TEXT NOT NULL CHECK(mode IN ('full','read_only')),
 owner_epoch INTEGER NOT NULL CHECK(owner_epoch BETWEEN 0 AND 9007199254740991),
 raw_sha256 TEXT NOT NULL CHECK(length(raw_sha256)=64 AND raw_sha256 NOT GLOB '*[^0-9a-f]*'),
 raw_bytes INTEGER NOT NULL CHECK(raw_bytes BETWEEN 0 AND 33554432),
 chunk_count INTEGER NOT NULL CHECK(chunk_count BETWEEN 0 AND 512 AND chunk_count=(raw_bytes+65535)/65536),
 raw_created_at INTEGER NOT NULL CHECK(raw_created_at BETWEEN 0 AND 9007199254740991),
 raw_expires_at INTEGER NOT NULL CHECK(raw_expires_at-raw_created_at BETWEEN 1 AND 60000),
 raw_max_bytes INTEGER NOT NULL CHECK(raw_max_bytes BETWEEN raw_bytes AND 33554432),
 phase TEXT NOT NULL CHECK(phase IN ('discarding','complete')),
 refetch_state TEXT NOT NULL CHECK(refetch_state IN ('pending','acknowledged','superseded'))
) STRICT;`;

export interface CommittedBodyEvictionSelection {
	readonly evictionId: string;
	readonly messageId: string;
	readonly raw: BlobRef;
	readonly accountId: string;
	readonly generation: number;
	readonly userId: string;
	readonly pluginInstanceId: string;
	readonly mode: "full" | "read_only";
	readonly ownerEpoch: number;
	readonly rawSha256: string;
	readonly rawBytes: number;
	readonly chunkCount: number;
}
export interface CommittedBodyEvictionProgress {
	readonly evictionId: string;
	readonly phase: "discarding" | "complete";
	readonly refetchState: "pending" | "acknowledged" | "superseded";
	readonly deletedChunks: number;
	readonly deletedObjects: number;
	readonly deletedParsed: number;
	readonly more: boolean;
	readonly refetchRequired: boolean;
}
export class CommittedBodyEvictionError extends Error {
	readonly code = "BODY_EVICTION_UNAVAILABLE";
	constructor() {
		super("Body eviction unavailable");
		this.name = "CommittedBodyEvictionError";
	}
}
interface RawRow {
	readonly accountId: string;
	readonly generation: number;
	readonly userId: string;
	readonly pluginInstanceId: string;
	readonly mode: string;
	readonly ownerEpoch: number;
	readonly state: string;
	readonly sha256: string;
	readonly byteCount: number;
	readonly chunkCount: number;
	readonly createdAt: number;
	readonly expiresAt: number;
	readonly maxBytes: number;
}
interface JournalRow extends RawIdentity {
	readonly evictionId: string;
	readonly messageId: string;
	readonly rawRef: string;
	readonly accountId: string;
	readonly generation: number;
	readonly userId: string;
	readonly pluginInstanceId: string;
	readonly mode: "full" | "read_only";
	readonly ownerEpoch: number;
	readonly rawSha256: string;
	readonly rawBytes: number;
	readonly chunkCount: number;
	readonly phase: CommittedBodyEvictionProgress["phase"];
	readonly refetchState: CommittedBodyEvictionProgress["refetchState"];
}
interface RawIdentity {
	readonly rawCreatedAt: number;
	readonly rawExpiresAt: number;
	readonly rawMaxBytes: number;
}
const KEYS = [
	"evictionId",
	"messageId",
	"raw",
	"accountId",
	"generation",
	"userId",
	"pluginInstanceId",
	"mode",
	"ownerEpoch",
	"rawSha256",
	"rawBytes",
	"chunkCount",
];
const JOURNAL = `SELECT eviction_id AS evictionId,message_id AS messageId,raw_ref AS rawRef,
 account_id AS accountId,generation,user_id AS userId,plugin_instance_id AS pluginInstanceId,
 mode,owner_epoch AS ownerEpoch,raw_sha256 AS rawSha256,raw_bytes AS rawBytes,chunk_count AS chunkCount,
 raw_created_at AS rawCreatedAt,raw_expires_at AS rawExpiresAt,raw_max_bytes AS rawMaxBytes,
 phase,refetch_state AS refetchState FROM main.committed_body_evictions WHERE eviction_id=?`;
const RAW = `SELECT account_id AS accountId,generation,user_id AS userId,
 plugin_instance_id AS pluginInstanceId,mode,owner_epoch AS ownerEpoch,state,sha256,
 byte_count AS byteCount,chunk_count AS chunkCount,created_at AS createdAt,expires_at AS expiresAt,
 max_bytes AS maxBytes FROM main.rawcontent_objects WHERE id=?`;
const RAW_IDENTITY = `id=? AND account_id=? AND generation=? AND user_id=? AND plugin_instance_id=?
 AND mode=? AND owner_epoch=? AND byte_count=? AND chunk_count=? AND created_at=? AND expires_at=? AND max_bytes=?`;
const PARSED_IDENTITY = `message_id=? AND account_id=? AND generation=? AND user_id=?
 AND plugin_instance_id=? AND mode=? AND raw_ref=? AND raw_sha256=? AND raw_bytes=?`;
const unavailable = (): never => {
	throw new CommittedBodyEvictionError();
};

function selection(input: CommittedBodyEvictionSelection): CommittedBodyEvictionSelection {
	try {
		const value = fields(input, KEYS),
			raw = fields(value.raw, ["ref"]);
		if (value.mode !== "full" && value.mode !== "read_only") return unavailable();
		if (typeof value.rawSha256 !== "string" || !/^[0-9a-f]{64}$/.test(value.rawSha256))
			return unavailable();
		const rawBytes = integer(value.rawBytes, 0, 33_554_432),
			chunkCount = integer(value.chunkCount, 0, 512);
		if (chunkCount !== Math.ceil(rawBytes / 65_536)) return unavailable();
		return Object.freeze({
			evictionId: id(value.evictionId),
			messageId: id(value.messageId),
			raw: Object.freeze({ ref: id(raw.ref) }),
			accountId: id(value.accountId),
			generation: integer(value.generation, 1),
			userId: id(value.userId),
			pluginInstanceId: id(value.pluginInstanceId),
			mode: value.mode,
			ownerEpoch: integer(value.ownerEpoch),
			rawSha256: value.rawSha256,
			rawBytes,
			chunkCount,
		});
	} catch {
		return unavailable();
	}
}
function selected(row: JournalRow): CommittedBodyEvictionSelection {
	return selection({
		evictionId: row.evictionId,
		messageId: row.messageId,
		raw: { ref: row.rawRef },
		accountId: row.accountId,
		generation: row.generation,
		userId: row.userId,
		pluginInstanceId: row.pluginInstanceId,
		mode: row.mode,
		ownerEpoch: row.ownerEpoch,
		rawSha256: row.rawSha256,
		rawBytes: row.rawBytes,
		chunkCount: row.chunkCount,
	});
}
function readJournal(
	sql: SqlTransaction,
	value: CommittedBodyEvictionSelection,
): JournalRow | undefined {
	const row = sql.get<JournalRow>(JOURNAL, [value.evictionId]);
	if (!row) return undefined;
	if (JSON.stringify(selected(row)) !== JSON.stringify(value)) return unavailable();
	integer(row.rawCreatedAt);
	integer(row.rawExpiresAt);
	integer(row.rawMaxBytes, row.rawBytes, 33_554_432);
	if (
		row.rawExpiresAt - row.rawCreatedAt < 1 ||
		row.rawExpiresAt - row.rawCreatedAt > 60_000 ||
		(row.phase !== "discarding" && row.phase !== "complete") ||
		(row.refetchState !== "pending" &&
			row.refetchState !== "acknowledged" &&
			row.refetchState !== "superseded")
	)
		return unavailable();
	return row;
}
function metadataMatches(sql: SqlTransaction, value: CommittedBodyEvictionSelection): boolean {
	return (
		sql.get(
			"SELECT 1 FROM main.content_messages WHERE id=? AND account_id=? AND generation=? AND user_id=?",
			[value.messageId, value.accountId, value.generation, value.userId],
		) !== undefined
	);
}
function parsedValues(value: CommittedBodyEvictionSelection): readonly SqlValue[] {
	return [
		value.messageId,
		value.accountId,
		value.generation,
		value.userId,
		value.pluginInstanceId,
		value.mode,
		value.raw.ref,
		value.rawSha256,
		value.rawBytes,
	];
}
function projection(
	sql: SqlTransaction,
	value: CommittedBodyEvictionSelection,
): "absent" | "matching" | "different" {
	if (!sql.get("SELECT 1 FROM main.content_parsed_messages WHERE message_id=?", [value.messageId]))
		return "absent";
	return sql.get(
		`SELECT 1 FROM main.content_parsed_messages WHERE ${PARSED_IDENTITY}`,
		parsedValues(value),
	)
		? "matching"
		: "different";
}
function rawMatches(
	row: RawRow,
	value: CommittedBodyEvictionSelection,
	identity?: RawIdentity,
): boolean {
	return (
		row.accountId === value.accountId &&
		row.generation === value.generation &&
		row.userId === value.userId &&
		row.pluginInstanceId === value.pluginInstanceId &&
		row.mode === value.mode &&
		row.ownerEpoch === value.ownerEpoch &&
		row.byteCount === value.rawBytes &&
		row.chunkCount === value.chunkCount &&
		(identity === undefined ||
			(row.createdAt === identity.rawCreatedAt &&
				row.expiresAt === identity.rawExpiresAt &&
				row.maxBytes === identity.rawMaxBytes))
	);
}
function rawValues(value: CommittedBodyEvictionSelection, row: RawIdentity): readonly SqlValue[] {
	return [
		value.raw.ref,
		value.accountId,
		value.generation,
		value.userId,
		value.pluginInstanceId,
		value.mode,
		value.ownerEpoch,
		value.rawBytes,
		value.chunkCount,
		row.rawCreatedAt,
		row.rawExpiresAt,
		row.rawMaxBytes,
	];
}
function chunksRemain(sql: SqlTransaction, value: CommittedBodyEvictionSelection): boolean {
	return (
		sql.get("SELECT 1 FROM main.rawcontent_chunks WHERE object_id=? LIMIT 1", [value.raw.ref]) !==
		undefined
	);
}
function ready(
	sql: SqlTransaction,
	value: CommittedBodyEvictionSelection,
	row: JournalRow,
): boolean {
	return (
		row.phase === "complete" &&
		row.refetchState === "pending" &&
		metadataMatches(sql, value) &&
		projection(sql, value) === "absent" &&
		!sql.get("SELECT 1 FROM main.rawcontent_objects WHERE id=?", [value.raw.ref]) &&
		!chunksRemain(sql, value)
	);
}
function progress(
	sql: SqlTransaction,
	value: CommittedBodyEvictionSelection,
	row: JournalRow,
	deletedChunks = 0,
	deletedObjects = 0,
	deletedParsed = 0,
): CommittedBodyEvictionProgress {
	return Object.freeze({
		evictionId: value.evictionId,
		phase: row.phase,
		refetchState: row.refetchState,
		deletedChunks,
		deletedObjects,
		deletedParsed,
		more: row.phase === "discarding",
		refetchRequired: ready(sql, value, row),
	});
}
function update(
	sql: SqlTransaction,
	value: CommittedBodyEvictionSelection,
	phase: JournalRow["phase"],
	state: JournalRow["refetchState"],
): JournalRow {
	if (
		sql.run(
			"UPDATE main.committed_body_evictions SET phase=?,refetch_state=? WHERE eviction_id=?",
			[phase, state, value.evictionId],
		).changes !== 1
	)
		return unavailable();
	return readJournal(sql, value) ?? unavailable();
}

/**
 * One bounded step on the caller's ORIGINAL transaction. SQL errors escape unchanged.
 * The caller owns authorization, age/current-generation policy, leases and cancellation;
 * it must roll its transaction back on failure. Every returned count/status is provisional
 * until that outer transaction commits. This function starts/commits no transaction.
 */
export function stepCommittedBodyEviction(
	sql: SqlTransaction,
	input: CommittedBodyEvictionSelection,
): CommittedBodyEvictionProgress {
	const value = selection(input);
	let row = readJournal(sql, value);
	let raw = sql.get<RawRow>(RAW, [value.raw.ref]);
	const metaCurrent = metadataMatches(sql, value),
		parsed = projection(sql, value);
	if (!row) {
		if (
			!raw ||
			!rawMatches(raw, value) ||
			raw.state !== "committed" ||
			raw.sha256 !== value.rawSha256 ||
			!metaCurrent ||
			parsed === "different"
		)
			return unavailable();
		const identity = {
			rawCreatedAt: integer(raw.createdAt),
			rawExpiresAt: integer(raw.expiresAt),
			rawMaxBytes: integer(raw.maxBytes, value.rawBytes, 33_554_432),
		};
		if (
			identity.rawExpiresAt - identity.rawCreatedAt < 1 ||
			identity.rawExpiresAt - identity.rawCreatedAt > 60_000
		)
			return unavailable();
		if (
			sql.run(
				`INSERT INTO main.committed_body_evictions
 (eviction_id,message_id,raw_ref,account_id,generation,user_id,plugin_instance_id,mode,owner_epoch,
 raw_sha256,raw_bytes,chunk_count,raw_created_at,raw_expires_at,raw_max_bytes,phase,refetch_state)
 VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,'discarding','pending')`,
				[
					value.evictionId,
					value.messageId,
					value.raw.ref,
					value.accountId,
					value.generation,
					value.userId,
					value.pluginInstanceId,
					value.mode,
					value.ownerEpoch,
					value.rawSha256,
					value.rawBytes,
					value.chunkCount,
					identity.rawCreatedAt,
					identity.rawExpiresAt,
					identity.rawMaxBytes,
				],
			).changes !== 1
		)
			return unavailable();
		row = readJournal(sql, value) ?? unavailable();
	}
	// A completed operation can never adopt an object later reusing its old BlobRef.
	if (row.phase === "complete") {
		if (raw || !metaCurrent || parsed === "different")
			row = update(sql, value, "complete", "superseded");
		return progress(sql, value, row);
	}
	if (
		raw &&
		(!rawMatches(raw, value, row) ||
			(raw.state !== "committed" && raw.state !== "discarding") ||
			(raw.state === "committed" ? raw.sha256 !== value.rawSha256 : raw.sha256 !== ""))
	) {
		row = update(sql, value, "complete", "superseded");
		return progress(sql, value, row);
	}
	if (!metaCurrent || parsed === "different") row = update(sql, value, "discarding", "superseded");
	if (raw?.state === "committed") {
		if (
			sql.run(
				`UPDATE main.rawcontent_objects SET state='discarding',sha256='' WHERE ${RAW_IDENTITY} AND state='committed' AND sha256=?`,
				[...rawValues(value, row), value.rawSha256],
			).changes !== 1
		)
			return unavailable();
		raw = sql.get<RawRow>(RAW, [value.raw.ref]);
		if (raw?.state !== "discarding" || raw.sha256 !== "" || !rawMatches(raw, value, row))
			return unavailable();
	}
	// Delete the parent only. The existing AFTER DELETE trigger uses OLD.seq,
	// OLD.scope_token and OLD.cleaned_body to remove its exact FTS entry.
	const deletedParsed =
		parsed === "matching"
			? integer(
					sql.run(
						`DELETE FROM main.content_parsed_messages WHERE ${PARSED_IDENTITY}`,
						parsedValues(value),
					).changes,
					0,
					1,
				)
			: 0;
	let deletedChunks = 0,
		deletedObjects = 0;
	if (raw) {
		deletedChunks = integer(
			sql.run(
				`DELETE FROM main.rawcontent_chunks WHERE object_id=?
 AND seq IN (SELECT seq FROM main.rawcontent_chunks WHERE object_id=? ORDER BY seq LIMIT 64)
 AND EXISTS (SELECT 1 FROM main.rawcontent_objects WHERE ${RAW_IDENTITY} AND state='discarding' AND sha256='')`,
				[value.raw.ref, value.raw.ref, ...rawValues(value, row)],
			).changes,
			0,
			COMMITTED_BODY_EVICTION_CHUNK_LIMIT,
		);
		if (!chunksRemain(sql, value)) {
			deletedObjects = integer(
				sql.run(
					`DELETE FROM main.rawcontent_objects WHERE ${RAW_IDENTITY}
 AND state='discarding' AND sha256='' AND NOT EXISTS(SELECT 1 FROM main.rawcontent_chunks WHERE object_id=?)`,
					[...rawValues(value, row), value.raw.ref],
				).changes,
				1,
				1,
			);
			raw = undefined;
		}
	} else if (chunksRemain(sql, value)) {
		// An unprovable orphan does not become permission to delete arbitrary chunks.
		return unavailable();
	}
	if (!raw) row = update(sql, value, "complete", row.refetchState);
	return progress(sql, value, row, deletedChunks, deletedObjects, deletedParsed);
}

export function readCommittedBodyEviction(
	sql: SqlTransaction,
	input: CommittedBodyEvictionSelection,
): CommittedBodyEvictionProgress | null {
	const value = selection(input),
		row = readJournal(sql, value);
	return row ? progress(sql, value, row) : null;
}

/** Refetch intent DATA only; the native caller must establish current binding before enqueue. */
export function pendingCommittedBodyRefetch(
	sql: SqlTransaction,
	input: CommittedBodyEvictionSelection,
): CommittedBodyEvictionSelection | null {
	const value = selection(input),
		row = readJournal(sql, value);
	return row && ready(sql, value, row) ? value : null;
}

/**
 * Acknowledge DATA only after the caller enqueues its real refetch in THIS SAME original
 * transaction. This neither creates nor verifies a job/lease or grants fetch authority.
 */
export function acknowledgeCommittedBodyRefetch(
	sql: SqlTransaction,
	input: CommittedBodyEvictionSelection,
): void {
	const value = selection(input),
		row = readJournal(sql, value);
	if (!row || !ready(sql, value, row)) unavailable();
	update(sql, value, "complete", "acknowledged");
}
