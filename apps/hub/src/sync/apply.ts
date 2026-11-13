import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { types } from "node:util";
import { Cursor } from "@draftyak/protocol/channel-v1";
import { MAX_CHANGES, NormalizedChange } from "@draftyak/protocol/normalized-change";
import { type AccountRecord, NativeAccounts } from "../accounts/records.ts";
import { EVENT_PAGE_SIZE, EventLog } from "../events/log.ts";
import { DeviceRegistry } from "../identity/devices.ts";
import { WorkDatabase, type WorkScope } from "../jobs/database.ts";
import { type JobLease, JobQueue } from "../jobs/queue.ts";
import { fields, id, integer } from "../jobs/values.ts";
import type { Clock } from "../kernel/clock.ts";
import { newId } from "../kernel/ids.ts";
import type { SqlTransaction } from "../store/store.ts";

export const CONTENT_MIGRATIONS: string = fileURLToPath(
	new URL(
		import.meta.url.endsWith(".ts") ? "./migrations/" : "./sync/migrations/",
		import.meta.url,
	),
);
export const MAX_APPLY_BYTES = 4_194_304;
export const CONTENT_PURGE_BATCH = 500;
export interface MetadataAccountRef {
	readonly accountId: string;
	readonly generation: number;
	readonly pluginInstanceId: string;
	readonly ownerEpoch: number;
	readonly mode: "full" | "read_only";
}
export interface ApplyMetadataPage extends MetadataAccountRef {
	readonly expectedCursor: string | null;
	readonly expectedRevision: number;
	readonly cursor: string;
	readonly changes: readonly NormalizedChange[];
}
export interface MetadataCheckpoint {
	readonly cursor: string | null;
	readonly revision: number;
}
export interface ApplyMetadataResult extends MetadataCheckpoint {
	readonly changedIds: readonly string[];
}
export interface NativeMessageMetadata {
	readonly id: string;
	readonly providerId: string;
	readonly threadId: string;
	readonly internalDate: number;
	readonly labelIds: readonly string[];
	readonly sizeBytes: number | null;
	readonly state: "unparsed";
	readonly direction: "inbound";
}
export interface MetadataPurgeProgress {
	readonly deleted: number;
	readonly more: boolean;
	readonly lease: JobLease | null;
}
export class NativeSyncError extends Error {
	readonly code = "SYNC_UNAVAILABLE";
	constructor() {
		super("Sync storage unavailable");
		this.name = "NativeSyncError";
	}
}

const sqlFor = WorkDatabase.prototype.sql;
const abort = WorkDatabase.prototype.abort;
const getAccount = NativeAccounts.prototype.get;
const registryState = DeviceRegistry.prototype.state;
const completeJob = JobQueue.prototype.complete;
const renewJob = JobQueue.prototype.renew;
const appendEvent = EventLog.prototype.append;
// 256 labels of 256 visible ASCII bytes, all JSON-escaped, plus separators/quotes.
const MAX_LABEL_JSON_BYTES = 131_841;
const RAW_PURGE_CHUNK_BATCH = 64;
const RAW_PURGE_INDEX =
	"CREATE INDEX rawcontent_account_purge ON rawcontent_objects(account_id,user_id,id)";
const REF_FIELDS = ["accountId", "generation", "pluginInstanceId", "ownerEpoch", "mode"];
const JOB_FIELDS = [
	"id",
	"accountId",
	"ownerId",
	"kind",
	"refId",
	"state",
	"attempts",
	"maxAttempts",
	"createdAt",
	"nextAt",
	"leaseUntil",
];
function refuse(): never {
	throw new NativeSyncError();
}

// The public data boundary never invokes caller getters, proxies or serialization hooks.
function snapshot(input: unknown): unknown {
	let bytes = 0;
	let nodes = 0;
	const active = new Set<object>();
	const text = (value: string): string => {
		if (!value.isWellFormed()) refuse();
		bytes += Buffer.byteLength(value);
		if (bytes > MAX_APPLY_BYTES) refuse();
		return value;
	};
	const visit = (value: unknown, depth: number): unknown => {
		if (++nodes > 150_000 || depth > 10) refuse();
		if (value === null || value === undefined || typeof value === "boolean") return value;
		if (typeof value === "string") return text(value);
		if (typeof value === "number") return integer(value);
		if (typeof value !== "object" || types.isProxy(value) || active.has(value)) refuse();
		active.add(value);
		try {
			if (Array.isArray(value)) {
				if (Object.getPrototypeOf(value) !== Array.prototype) refuse();
				const length = Object.getOwnPropertyDescriptor(value, "length")?.value;
				integer(length, 0, MAX_CHANGES);
				if (Reflect.ownKeys(value).length !== length + 1) refuse();
				return Array.from({ length }, (_, index) => {
					const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
					if (!descriptor || !("value" in descriptor) || !descriptor.enumerable) refuse();
					return visit(descriptor.value, depth + 1);
				});
			}
			if (![null, Object.prototype].includes(Object.getPrototypeOf(value))) refuse();
			const copy: Record<string, unknown> = Object.create(null);
			for (const key of Reflect.ownKeys(value)) {
				if (typeof key !== "string") refuse();
				text(key);
				const descriptor = Object.getOwnPropertyDescriptor(value, key);
				if (!descriptor || !("value" in descriptor) || !descriptor.enumerable) refuse();
				copy[key] = visit(descriptor.value, depth + 1);
			}
			return copy;
		} finally {
			active.delete(value);
		}
	};
	const copy = visit(input, 0);
	const json = JSON.stringify(copy);
	if (typeof json !== "string" || Buffer.byteLength(json) > MAX_APPLY_BYTES) refuse();
	return copy;
}
function visible(value: unknown, maximum: number): string {
	if (typeof value !== "string" || value.length < 1 || value.length > maximum) refuse();
	for (let at = 0; at < value.length; at++) {
		const code = value.charCodeAt(at);
		if (code < 33 || code > 126) refuse();
	}
	return value;
}
function cursor(value: unknown): string {
	const text = visible(value, 4096);
	if (!Cursor.safeParse(text).success) refuse();
	return text;
}
function reference(input: unknown): MetadataAccountRef {
	const row = fields(input, REF_FIELDS);
	if (row.mode !== "full" && row.mode !== "read_only") refuse();
	return Object.freeze({
		accountId: id(row.accountId),
		generation: integer(row.generation, 1),
		pluginInstanceId: id(row.pluginInstanceId),
		ownerEpoch: integer(row.ownerEpoch),
		mode: row.mode,
	});
}
type EmailChange =
	| {
			readonly kind: "email.message";
			readonly providerId: string;
			readonly threadId: string;
			readonly internalDate: number;
			readonly labelIds: readonly string[];
			readonly sizeBytes: number | null;
	  }
	| {
			readonly kind: "email.labels";
			readonly providerId: string;
			readonly threadId: string;
			readonly labelIds: readonly string[];
	  }
	| { readonly kind: "email.deleted"; readonly providerId: string };
function labels(value: readonly string[]): readonly string[] {
	if (value.length > 256) refuse();
	return Object.freeze([...new Set(value.map((label) => visible(label, 256)))].sort());
}
function emailChange(input: unknown): EmailChange {
	const change = NormalizedChange.parse(input);
	if (change.kind === "email.deleted")
		return Object.freeze({ kind: change.kind, providerId: visible(change.providerId, 256) });
	if (change.kind !== "email.message" && change.kind !== "email.labels") refuse();
	const common = {
		providerId: visible(change.providerId, 256),
		threadId: visible(change.threadId, 256),
		labelIds: labels(change.labelIds),
	};
	// Raw bytes are deliberately not metadata, derived content or a blob-access grant.
	return change.kind === "email.labels"
		? Object.freeze({ kind: change.kind, ...common })
		: Object.freeze({
				kind: change.kind,
				...common,
				internalDate: integer(change.internalDate),
				sizeBytes: change.sizeBytes === undefined ? null : integer(change.sizeBytes),
			});
}
function page(input: unknown): MetadataAccountRef & {
	cursor: string;
	expectedCursor: string | null;
	expectedRevision: number;
	changes: readonly EmailChange[];
} {
	const row = fields(snapshot(input), [
		...REF_FIELDS,
		"expectedCursor",
		"expectedRevision",
		"cursor",
		"changes",
	]);
	const ref = reference(Object.fromEntries(REF_FIELDS.map((key) => [key, row[key]])));
	if (!Array.isArray(row.changes) || row.changes.length > MAX_CHANGES) refuse();
	return Object.freeze({
		...ref,
		expectedCursor: row.expectedCursor === null ? null : cursor(row.expectedCursor),
		expectedRevision: integer(row.expectedRevision),
		cursor: cursor(row.cursor),
		changes: Object.freeze(row.changes.map(emailChange)),
	});
}
interface CheckpointRow {
	valid: number;
	userId: string;
	pluginInstanceId: string;
	mode: string;
	cursor: string;
	revision: number;
}
interface MessageRow {
	valid: number;
	id: string;
	providerId: string;
	threadId: string;
	conversationId: string;
	internalDate: number;
	labelJson: string;
	sizeBytes: number | null;
	state: string;
	direction: string;
}
const MESSAGES = `SELECT
 CASE WHEN length(CAST(m.id AS BLOB))=26 AND length(CAST(m.provider_id AS BLOB)) BETWEEN 1 AND 256
  AND length(CAST(c.provider_id AS BLOB)) BETWEEN 1 AND 256 AND length(CAST(m.conversation_id AS BLOB))=26
  AND typeof(m.internal_date)='integer' AND m.internal_date BETWEEN 0 AND 9007199254740991
  AND typeof(m.label_json)='text' AND length(CAST(m.label_json AS BLOB)) BETWEEN 2 AND ${MAX_LABEL_JSON_BYTES}
  AND (m.size_bytes IS NULL OR (typeof(m.size_bytes)='integer' AND m.size_bytes BETWEEN 0 AND 9007199254740991))
  AND m.state='unparsed' AND m.direction='inbound' THEN 1 ELSE 0 END AS valid,
 CASE WHEN length(CAST(m.id AS BLOB))=26 THEN m.id END AS id,
 CASE WHEN length(CAST(m.provider_id AS BLOB)) BETWEEN 1 AND 256 THEN m.provider_id END AS providerId,
 CASE WHEN length(CAST(c.provider_id AS BLOB)) BETWEEN 1 AND 256 THEN c.provider_id END AS threadId,
 CASE WHEN length(CAST(m.conversation_id AS BLOB))=26 THEN m.conversation_id END AS conversationId,
 CASE WHEN typeof(m.internal_date)='integer' AND m.internal_date BETWEEN 0 AND 9007199254740991 THEN m.internal_date END AS internalDate,
 CASE WHEN typeof(m.label_json)='text' AND length(CAST(m.label_json AS BLOB)) BETWEEN 2 AND ${MAX_LABEL_JSON_BYTES} THEN m.label_json END AS labelJson,
 CASE WHEN m.size_bytes IS NULL OR (typeof(m.size_bytes)='integer' AND m.size_bytes BETWEEN 0 AND 9007199254740991) THEN m.size_bytes END AS sizeBytes,
 CASE WHEN m.state='unparsed' THEN m.state END AS state,
 CASE WHEN m.direction='inbound' THEN m.direction END AS direction
 FROM main.content_messages m LEFT JOIN main.content_conversations c
 ON c.id=m.conversation_id AND c.account_id=m.account_id AND c.generation=m.generation AND c.user_id=m.user_id`;
function message(raw: MessageRow): NativeMessageMetadata {
	if (raw.valid !== 1 || raw.state !== "unparsed" || raw.direction !== "inbound") refuse();
	const value: unknown = JSON.parse(raw.labelJson);
	if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) refuse();
	return Object.freeze({
		id: id(raw.id),
		providerId: visible(raw.providerId, 256),
		threadId: visible(raw.threadId, 256),
		internalDate: integer(raw.internalDate),
		labelIds: labels(value),
		sizeBytes: raw.sizeBytes === null ? null : integer(raw.sizeBytes),
		state: "unparsed",
		direction: "inbound",
	});
}

function purgeRawAccount(
	sql: SqlTransaction,
	accountId: string,
	ownerId: string,
): { deleted: number; more: boolean } {
	const markers = sql.all<{
		name: string;
		type: string;
		tableName: string;
		definition: string | null;
	}>(`SELECT name,type,tbl_name AS tableName,
 CASE WHEN name='rawcontent_account_purge' AND length(CAST(sql AS BLOB))<=256 THEN sql END AS definition
 FROM main.sqlite_schema WHERE name IN
 ('rawcontent_objects','rawcontent_chunks','_migrations_rawcontent','_migrations_rawcontent_lock','rawcontent_account_purge')`);
	// Metadata-only compositions never activate raw storage. An applied or partial
	// namespace must instead carry its explicit account-purge migration already.
	if (markers.length === 0) return { deleted: 0, more: false };
	for (const name of [
		"rawcontent_objects",
		"rawcontent_chunks",
		"_migrations_rawcontent",
		"_migrations_rawcontent_lock",
	]) {
		const marker = markers.find((row) => row.name === name);
		if (!marker || marker.type !== "table" || marker.tableName !== name) refuse();
	}
	const index = markers.find((row) => row.name === "rawcontent_account_purge");
	if (
		!index ||
		index.type !== "index" ||
		index.tableName !== "rawcontent_objects" ||
		typeof index.definition !== "string" ||
		index.definition.replace(/\s+/g, " ").trim() !== RAW_PURGE_INDEX
	)
		refuse();
	const object = sql.get<{ id: string; userId: string }>(
		`SELECT id,user_id AS userId FROM main.rawcontent_objects INDEXED BY rawcontent_account_purge
 WHERE account_id=? ORDER BY user_id,id LIMIT 1`,
		[accountId],
	);
	if (!object) return { deleted: 0, more: false };
	// Do not filter a corrupt foreign owner out of the account's indexed range.
	if (object.userId !== ownerId) refuse();
	const blobId = id(object.id);
	// Retire derived content across this account's generations before removing any
	// Raw bytes. Account purge does not assume raw_ref is the Raw object's ID.
	for (const comparison of ["<", ">"] as const) {
		if (
			sql.get(
				`SELECT 1 FROM main.content_parsed_messages INDEXED BY content_parsed_owner
 WHERE account_id=? AND user_id${comparison}? LIMIT 1`,
				[accountId, ownerId],
			)
		)
			refuse();
	}
	let deleted = sql.run(
		`DELETE FROM main.content_parsed_messages WHERE rowid IN
 (SELECT rowid FROM main.content_parsed_messages INDEXED BY content_parsed_page
  WHERE account_id=? AND user_id=? ORDER BY generation,user_id,message_id LIMIT ?)`,
		[accountId, ownerId, CONTENT_PURGE_BATCH],
	).changes;
	// DELETE reaches the parsed/FTS trigger in this same transaction. Do not start
	// chunk deletion while another bounded batch of derived rows is still present.
	if (
		sql.get(
			"SELECT 1 FROM main.content_parsed_messages INDEXED BY content_parsed_owner WHERE account_id=? LIMIT 1",
			[accountId],
		) !== undefined
	)
		return { deleted, more: true };
	deleted += sql.run(
		`DELETE FROM main.rawcontent_chunks WHERE object_id=? AND seq IN
 (SELECT seq FROM main.rawcontent_chunks WHERE object_id=? ORDER BY seq LIMIT ${RAW_PURGE_CHUNK_BATCH})`,
		[blobId, blobId],
	).changes;
	if (!sql.get("SELECT 1 FROM main.rawcontent_chunks WHERE object_id=? LIMIT 1", [blobId])) {
		const removed = sql.run(
			"DELETE FROM main.rawcontent_objects WHERE id=? AND account_id=? AND user_id=?",
			[blobId, accountId, ownerId],
		).changes;
		if (removed !== 1) refuse();
		deleted += removed;
	}
	return {
		deleted,
		more:
			sql.get(
				"SELECT 1 FROM main.rawcontent_objects INDEXED BY rawcontent_account_purge WHERE account_id=? LIMIT 1",
				[accountId],
			) !== undefined,
	};
}

/**
 * Native metadata persistence, not a channel-admission or content-verification issuer.
 * The native caller must already have admitted the source before invoking it. Expected
 * fields are stale-work fences, never grants. No wire handler or parsed/outbound view is
 * installed here. Register CONTENT_MIGRATIONS explicitly in the owning composition.
 */
export class NativeMetadataStore {
	readonly #database: WorkDatabase;
	readonly #accounts: NativeAccounts;
	readonly #registry: DeviceRegistry;
	readonly #jobs: JobQueue;
	readonly #events: EventLog;
	readonly #clock: Clock;
	constructor(
		database: WorkDatabase,
		accounts: NativeAccounts,
		registry: DeviceRegistry,
		jobs: JobQueue,
		events: EventLog,
		clock: Clock,
	) {
		this.#database = database;
		this.#accounts = accounts;
		this.#registry = registry;
		this.#jobs = jobs;
		this.#events = events;
		this.#clock = clock;
	}
	#work<T>(scope: WorkScope, work: (sql: SqlTransaction) => T): T {
		try {
			return work(sqlFor.call(this.#database, scope));
		} catch {
			try {
				abort.call(this.#database, scope);
			} catch {
				/* Foreign or retired scopes stay refused. */
			}
			throw new NativeSyncError();
		}
	}
	#account(
		scope: WorkScope,
		sql: SqlTransaction,
		ref: MetadataAccountRef,
		purging = false,
	): AccountRecord {
		const state = registryState.call(this.#registry, sql);
		if (!state.bootstrapDone || state.ownerUserId === null || state.epoch !== ref.ownerEpoch)
			refuse();
		const record = getAccount.call(this.#accounts, scope, state.ownerUserId, ref.accountId);
		const at = integer(this.#clock.wallMs());
		if (
			!record ||
			record.generation !== ref.generation ||
			record.account.userId !== state.ownerUserId ||
			record.account.pluginInstanceId !== ref.pluginInstanceId ||
			record.account.mode !== ref.mode ||
			record.account.channel !== "email" ||
			record.account.status !== (purging ? "disconnecting" : "active")
		)
			refuse();
		if (
			!purging &&
			record.account.deletionDeadline !== null &&
			record.account.deletionDeadline <= at
		)
			refuse();
		for (const table of ["content_messages", "content_conversations", "content_checkpoints"]) {
			// Account identities never transfer owners. Indexed disjoint ranges catch
			// corrupt ownership across every generation without scanning its inbox.
			if (
				sql.get(`SELECT 1 FROM main.${table} WHERE account_id=? AND user_id<? LIMIT 1`, [
					ref.accountId,
					record.account.userId,
				]) ||
				sql.get(`SELECT 1 FROM main.${table} WHERE account_id=? AND user_id>? LIMIT 1`, [
					ref.accountId,
					record.account.userId,
				])
			)
				refuse();
		}
		return record;
	}
	#lease(lease: JobLease, record: AccountRecord, kind: "sync" | "retention"): string {
		const value = fields(fields(lease, ["job"]).job, JOB_FIELDS);
		if (
			value.kind !== kind ||
			value.state !== "RUNNING" ||
			value.accountId !== record.account.id ||
			value.ownerId !== record.account.userId
		)
			refuse();
		return id(value.id);
	}
	#checkpoint(sql: SqlTransaction, ref: MetadataAccountRef, owner: string): MetadataCheckpoint {
		const row = sql.get<CheckpointRow>(
			`SELECT
 CASE WHEN length(CAST(user_id AS BLOB))=26 AND length(CAST(plugin_instance_id AS BLOB))=26
  AND mode IN ('full','read_only') AND typeof(cursor)='text' AND length(CAST(cursor AS BLOB)) BETWEEN 1 AND 4096
  AND typeof(revision)='integer' AND revision BETWEEN 1 AND 9007199254740991 THEN 1 ELSE 0 END AS valid,
 CASE WHEN length(CAST(user_id AS BLOB))=26 THEN user_id END AS userId,
 CASE WHEN length(CAST(plugin_instance_id AS BLOB))=26 THEN plugin_instance_id END AS pluginInstanceId,
 CASE WHEN mode IN ('full','read_only') THEN mode END AS mode,
 CASE WHEN typeof(cursor)='text' AND length(CAST(cursor AS BLOB)) BETWEEN 1 AND 4096 THEN cursor END AS cursor,
 CASE WHEN typeof(revision)='integer' AND revision BETWEEN 1 AND 9007199254740991 THEN revision END AS revision
 FROM main.content_checkpoints WHERE account_id=? AND generation=?`,
			[ref.accountId, ref.generation],
		);
		if (!row) return Object.freeze({ cursor: null, revision: 0 });
		if (
			row.valid !== 1 ||
			row.userId !== owner ||
			row.pluginInstanceId !== ref.pluginInstanceId ||
			row.mode !== ref.mode
		)
			refuse();
		return Object.freeze({ cursor: cursor(row.cursor), revision: integer(row.revision, 1) });
	}
	checkpoint(scope: WorkScope, input: MetadataAccountRef): MetadataCheckpoint {
		return this.#work(scope, (sql) => {
			const ref = reference(snapshot(input));
			const record = this.#account(scope, sql, ref);
			return this.#checkpoint(sql, ref, record.account.userId);
		});
	}
	messages(
		scope: WorkScope,
		input: MetadataAccountRef,
		afterId: string | null = null,
		limit = 100,
	): readonly NativeMessageMetadata[] {
		return this.#work(scope, (sql) => {
			const ref = reference(snapshot(input));
			const record = this.#account(scope, sql, ref);
			const after = afterId === null ? "" : id(afterId);
			return Object.freeze(
				sql
					.all<MessageRow>(
						`${MESSAGES} WHERE m.user_id=? AND m.account_id=? AND m.generation=? AND m.id>? ORDER BY m.id LIMIT ?`,
						[record.account.userId, ref.accountId, ref.generation, after, integer(limit, 1, 100)],
					)
					.map(message),
			);
		});
	}
	applyPage(scope: WorkScope, lease: JobLease, input: ApplyMetadataPage): ApplyMetadataResult {
		return this.#work(scope, (sql) => {
			const value = page(input);
			const record = this.#account(scope, sql, value);
			const owner = record.account.userId;
			const jobId = this.#lease(lease, record, "sync");
			const current = this.#checkpoint(sql, value, owner);
			if (
				current.cursor !== value.expectedCursor ||
				current.revision !== value.expectedRevision ||
				current.revision === Number.MAX_SAFE_INTEGER
			)
				refuse();
			if (
				sql.get(
					"SELECT 1 FROM main.content_pages WHERE account_id=? AND generation=? AND job_id=?",
					[value.accountId, value.generation, jobId],
				)
			)
				refuse();
			const changed = new Set<string>();
			const threads = new Set<string>();
			for (const change of value.changes) {
				const previous = sql.get<MessageRow>(
					`${MESSAGES} WHERE m.user_id=? AND m.account_id=? AND m.generation=? AND m.provider_id=?`,
					[owner, value.accountId, value.generation, change.providerId],
				);
				const before = previous ? message(previous) : undefined;
				if (change.kind === "email.deleted") {
					if (before && previous) {
						sql.run(
							"DELETE FROM main.content_messages WHERE id=? AND account_id=? AND generation=?",
							[before.id, value.accountId, value.generation],
						);
						changed.add(before.id);
						threads.add(id(previous.conversationId));
					}
					continue;
				}
				if (change.kind === "email.labels" && !before) continue;
				let conversation = sql.get<{ id: string; userId: string }>(
					"SELECT CASE WHEN length(CAST(id AS BLOB))=26 THEN id END AS id, CASE WHEN length(CAST(user_id AS BLOB))=26 THEN user_id END AS userId FROM main.content_conversations WHERE account_id=? AND generation=? AND provider_id=?",
					[value.accountId, value.generation, change.threadId],
				);
				if (!conversation) {
					conversation = { id: newId(), userId: owner };
					sql.run(
						"INSERT INTO main.content_conversations(id,user_id,account_id,generation,provider_id) VALUES(?,?,?,?,?)",
						[conversation.id, owner, value.accountId, value.generation, change.threadId],
					);
				}
				if (conversation.userId !== owner) refuse();
				id(conversation.id);
				const next: NativeMessageMetadata = Object.freeze({
					id: before?.id ?? newId(),
					providerId: change.providerId,
					threadId: change.threadId,
					internalDate:
						change.kind === "email.message"
							? change.internalDate
							: (before?.internalDate ?? refuse()),
					labelIds: change.labelIds,
					sizeBytes:
						change.kind === "email.message" ? change.sizeBytes : (before?.sizeBytes ?? null),
					state: "unparsed",
					direction: "inbound",
				});
				if (before && JSON.stringify(before) === JSON.stringify(next)) continue;
				sql.run(
					`INSERT INTO main.content_messages(id,user_id,account_id,generation,provider_id,conversation_id,internal_date,label_json,size_bytes,state,direction) VALUES(?,?,?,?,?,?,?,?,?,'unparsed','inbound')
 ON CONFLICT(account_id,generation,provider_id) DO UPDATE SET conversation_id=excluded.conversation_id,internal_date=excluded.internal_date,label_json=excluded.label_json,size_bytes=excluded.size_bytes`,
					[
						next.id,
						owner,
						value.accountId,
						value.generation,
						next.providerId,
						conversation.id,
						next.internalDate,
						JSON.stringify(next.labelIds),
						next.sizeBytes,
					],
				);
				changed.add(next.id);
				threads.add(conversation.id);
				if (previous) threads.add(id(previous.conversationId));
			}
			const revision = current.revision + 1;
			sql.run(
				`INSERT INTO main.content_checkpoints(account_id,generation,user_id,plugin_instance_id,mode,cursor,revision) VALUES(?,?,?,?,?,?,?)
 ON CONFLICT(account_id,generation) DO UPDATE SET cursor=excluded.cursor,revision=excluded.revision`,
				[
					value.accountId,
					value.generation,
					owner,
					value.pluginInstanceId,
					value.mode,
					value.cursor,
					revision,
				],
			);
			const digest = createHash("sha256").update(JSON.stringify(value)).digest("hex");
			sql.run(
				"INSERT INTO main.content_pages(account_id,generation,job_id,payload_digest,cursor,revision) VALUES(?,?,?,?,?,?)",
				[value.accountId, value.generation, jobId, digest, value.cursor, revision],
			);
			// A forged, retired or expired lease aborts every preceding metadata write too.
			completeJob.call(this.#jobs, scope, lease);
			for (const [kind, ids] of [
				["messages.changed", [...changed]],
				["threads.changed", [...threads]],
			] as const) {
				for (let start = 0; start < ids.length; start += EVENT_PAGE_SIZE)
					appendEvent.call(this.#events, scope, {
						userId: owner,
						accountId: value.accountId,
						dataClass: "gmail.metadata",
						kind,
						ids: ids.slice(start, start + EVENT_PAGE_SIZE),
					});
			}
			return Object.freeze({
				cursor: value.cursor,
				revision,
				changedIds: Object.freeze([...changed]),
			});
		});
	}
	/** The owning lifecycle supplies purge authorization; these are consistency fences only. */
	purge(scope: WorkScope, lease: JobLease, input: MetadataAccountRef): MetadataPurgeProgress {
		return this.#work(scope, (sql) => {
			const ref = reference(snapshot(input));
			const record = this.#account(scope, sql, ref, true);
			this.#lease(lease, record, "retention");
			const raw = purgeRawAccount(sql, ref.accountId, record.account.userId);
			let deleted = raw.deleted;
			// Drain bounded journal children before deleting their metadata parents.
			deleted += sql.run(
				`DELETE FROM main.sync_page_observations WHERE rowid IN
 (SELECT rowid FROM main.sync_page_observations WHERE account_id=?
  ORDER BY generation,scan_id,page_ordinal,change_index LIMIT ?)`,
				[ref.accountId, CONTENT_PURGE_BATCH],
			).changes;
			deleted += sql.run(
				`DELETE FROM main.sync_scan_pages WHERE rowid IN
 (SELECT rowid FROM main.sync_scan_pages WHERE account_id=?
  ORDER BY generation,scan_id,ordinal LIMIT ?)
 AND NOT EXISTS(SELECT 1 FROM main.sync_page_observations o
  WHERE o.scan_id=sync_scan_pages.scan_id AND o.page_ordinal=sync_scan_pages.ordinal
  AND o.account_id=sync_scan_pages.account_id AND o.generation=sync_scan_pages.generation)`,
				[ref.accountId, CONTENT_PURGE_BATCH],
			).changes;
			deleted += sql.run(
				`DELETE FROM main.sync_scans WHERE rowid IN
 (SELECT rowid FROM main.sync_scans WHERE account_id=?
  ORDER BY user_id,generation,id LIMIT ?)
 AND NOT EXISTS(SELECT 1 FROM main.sync_scan_pages p
  WHERE p.scan_id=sync_scans.id AND p.account_id=sync_scans.account_id
  AND p.generation=sync_scans.generation)`,
				[ref.accountId, CONTENT_PURGE_BATCH],
			).changes;
			const journalMore = ["sync_page_observations", "sync_scan_pages", "sync_scans"].some(
				(table) =>
					sql.get(`SELECT 1 FROM main.${table} WHERE account_id=? LIMIT 1`, [ref.accountId]) !==
					undefined,
			);
			if (journalMore) {
				const next = renewJob.call(this.#jobs, scope, lease);
				return Object.freeze({ deleted, more: true, lease: next });
			}
			deleted += sql.run(
				`DELETE FROM main.content_messages WHERE rowid IN
 (SELECT rowid FROM main.content_messages WHERE account_id=? ORDER BY generation,provider_id LIMIT ?)`,
				[ref.accountId, CONTENT_PURGE_BATCH],
			).changes;
			deleted += sql.run(
				`DELETE FROM main.content_conversations WHERE rowid IN
 (SELECT rowid FROM main.content_conversations WHERE account_id=? ORDER BY generation,provider_id LIMIT ?)
 AND NOT EXISTS(SELECT 1 FROM main.content_messages m WHERE m.conversation_id=content_conversations.id
 AND m.account_id=content_conversations.account_id AND m.generation=content_conversations.generation)`,
				[ref.accountId, CONTENT_PURGE_BATCH],
			).changes;
			for (const table of ["content_pages", "content_checkpoints"]) {
				const order = table === "content_pages" ? "generation,job_id" : "generation";
				deleted += sql.run(
					`DELETE FROM main.${table} WHERE rowid IN (SELECT rowid FROM main.${table} WHERE account_id=? ORDER BY ${order} LIMIT ?)`,
					[ref.accountId, CONTENT_PURGE_BATCH],
				).changes;
			}
			const metadataMore = [
				"sync_page_observations",
				"sync_scan_pages",
				"sync_scans",
				"content_messages",
				"content_conversations",
				"content_pages",
				"content_checkpoints",
			].some(
				(table) =>
					sql.get(`SELECT 1 FROM main.${table} WHERE account_id=? LIMIT 1`, [ref.accountId]) !==
					undefined,
			);
			const more = raw.more || metadataMore;
			let next: JobLease | null = null;
			if (more) next = renewJob.call(this.#jobs, scope, lease);
			else completeJob.call(this.#jobs, scope, lease);
			return Object.freeze({ deleted, more, lease: next });
		});
	}
}
