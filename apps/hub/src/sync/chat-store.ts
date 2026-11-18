import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { types } from "node:util";
import { cleanText, type HygieneResult } from "@draftyak/content/hygiene";
import { Cursor } from "@draftyak/protocol/channel-v1";
import {
	ChatMessageChange,
	MAX_CHANGES,
	NormalizedChange,
} from "@draftyak/protocol/normalized-change";
import { type AccountRecord, NativeAccounts } from "../accounts/records.ts";
import { EVENT_PAGE_SIZE, EventLog } from "../events/log.ts";
import { DeviceRegistry } from "../identity/devices.ts";
import { WorkDatabase, type WorkScope } from "../jobs/database.ts";
import { type JobLease, JobQueue } from "../jobs/queue.ts";
import { fields, id, integer } from "../jobs/values.ts";
import type { Clock } from "../kernel/clock.ts";
import { newId } from "../kernel/ids.ts";
import type { SqlTransaction } from "../store/store.ts";
import type { MetadataAccountRef } from "./account-ref.ts";

export const CHAT_CONTENT_MIGRATIONS: string = fileURLToPath(
	new URL("./chat-migrations/", import.meta.url),
);
export const CHAT_PAGE_BYTES: number = 4_194_304;
export const CHAT_THREAD_MESSAGES: number = 100;
export const CHAT_THREAD_BYTES: number = 4_194_304;
const MESSAGE_BYTES = 1_048_576;

export interface ChatCheckpoint {
	readonly cursor: string | null;
	readonly revision: number;
}
export interface ChatPageInput extends MetadataAccountRef {
	readonly expectedCursor: string | null;
	readonly expectedRevision: number;
	readonly cursor: string;
	readonly changes: readonly NormalizedChange[];
}
declare const preparedChatPage: unique symbol;
/** Prepared content DATA only; neither source admission nor a job capability. */
export interface PreparedChatPage {
	readonly [preparedChatPage]: true;
}
export interface ChatApplyResult {
	readonly checkpoint: ChatCheckpoint;
	readonly changedMessageIds: readonly string[];
	readonly changedConversationIds: readonly string[];
	readonly lease: JobLease;
}
export interface NativeChatMessage {
	readonly id: string;
	readonly channelId: string;
	readonly ts: string;
	readonly threadTs?: string;
	readonly sentAt: number;
	readonly author: ChatMessageChange["author"];
	readonly body: HygieneResult;
	readonly subtype?: string;
	readonly editedAt?: number;
	readonly files?: ChatMessageChange["files"];
}
export interface NativeChatThread {
	readonly account: MetadataAccountRef;
	readonly conversationId: string | null;
	readonly channelId: string;
	readonly threadTs: string;
	readonly checkpoint: ChatCheckpoint;
	readonly threadRevision: number;
	readonly messages: readonly NativeChatMessage[];
	readonly availability: "available" | "missing" | "withheld" | "truncated";
	readonly coverage: {
		readonly state: "unknown";
		readonly reason: "provider-history-unproven";
	};
}
export class NativeChatError extends Error {
	readonly code = "CHAT_STORAGE_UNAVAILABLE";
	constructor() {
		super("Chat storage unavailable");
		this.name = "NativeChatError";
	}
}

const original = Object.freeze({
	sql: WorkDatabase.prototype.sql,
	abort: WorkDatabase.prototype.abort,
	account: NativeAccounts.prototype.getInTransaction,
	state: DeviceRegistry.prototype.state,
	renew: JobQueue.prototype.renew,
	queueDatabase: JobQueue.prototype.assertDatabase,
	append: EventLog.prototype.append,
});
const REF_FIELDS = ["accountId", "generation", "pluginInstanceId", "ownerEpoch", "mode"];
const prepared = new WeakMap<object, Page>();
const COVERAGE: NativeChatThread["coverage"] = Object.freeze({
	state: "unknown",
	reason: "provider-history-unproven",
});
interface MessageData {
	readonly channelId: string;
	readonly ts: string;
	readonly threadTs?: string;
	readonly sentAt: number;
	readonly author: ChatMessageChange["author"];
	readonly body: HygieneResult;
	readonly subtype?: string;
	readonly editedAt?: number;
	readonly files?: ChatMessageChange["files"];
}
type Change =
	| {
			readonly kind: "chat.message";
			readonly value: MessageData;
			readonly json: string;
			readonly digest: string;
	  }
	| { readonly kind: "chat.deleted"; readonly channelId: string; readonly ts: string }
	| { readonly kind: "chat.conversation"; readonly channelId: string; readonly json: string };
interface Page {
	readonly account: MetadataAccountRef;
	readonly expectedCursor: string | null;
	readonly expectedRevision: number;
	readonly cursor: string;
	readonly changes: readonly Change[];
}
interface CheckpointRow {
	readonly userId: string;
	readonly pluginInstanceId: string;
	readonly mode: string;
	readonly cursor: string;
	readonly revision: number;
}
interface MessageRow {
	readonly id: string;
	readonly conversationId: string | null;
	readonly threadTs: string | null;
	readonly deleted: number;
	readonly digest: string | null;
	readonly sentAt: number | null;
	readonly editedAt: number | null;
}
function refuse(): never {
	throw new NativeChatError();
}
function digest(value: string): string {
	return createHash("sha256").update(value, "utf8").digest("hex");
}
function visible(value: unknown, maximum = 256): string {
	if (
		typeof value !== "string" ||
		value.length < 1 ||
		value.length > maximum ||
		!/^[!-~]+$/.test(value)
	)
		refuse();
	return value;
}
function cursor(value: unknown): string {
	const result = visible(value, 4096);
	if (!Cursor.safeParse(result).success) refuse();
	return result;
}
function reference(value: unknown): MetadataAccountRef {
	const row = fields(value, REF_FIELDS);
	if (row.mode !== "full" && row.mode !== "read_only") refuse();
	return Object.freeze({
		accountId: id(row.accountId),
		generation: integer(row.generation, 1),
		pluginInstanceId: id(row.pluginInstanceId),
		ownerEpoch: integer(row.ownerEpoch),
		mode: row.mode,
	});
}
function freeze<T>(value: T): T {
	if (value !== null && typeof value === "object") {
		for (const child of Object.values(value)) freeze(child);
		Object.freeze(value);
	}
	return value;
}

// Materialize only bounded inert DATA before schema validation or text hygiene.
function snapshot(value: unknown): unknown {
	let nodes = 0;
	let bytes = 0;
	const active = new Set<object>();
	const text = (input: string): string => {
		if (!input.isWellFormed()) refuse();
		bytes += Buffer.byteLength(input);
		if (bytes > CHAT_PAGE_BYTES) refuse();
		return input;
	};
	const visit = (input: unknown, depth: number): unknown => {
		if (++nodes > 150_000 || depth > 12) refuse();
		if (input === null || input === undefined || typeof input === "boolean") return input;
		if (typeof input === "string") return text(input);
		if (typeof input === "number") return integer(input);
		if (typeof input !== "object" || types.isProxy(input) || active.has(input)) refuse();
		active.add(input);
		try {
			if (Array.isArray(input)) {
				if (Object.getPrototypeOf(input) !== Array.prototype) refuse();
				const length = integer(
					Object.getOwnPropertyDescriptor(input, "length")?.value,
					0,
					MAX_CHANGES,
				);
				if (Reflect.ownKeys(input).length !== length + 1) refuse();
				return Array.from({ length }, (_, at) => {
					const descriptor = Object.getOwnPropertyDescriptor(input, String(at));
					if (!descriptor || !("value" in descriptor) || !descriptor.enumerable) refuse();
					return visit(descriptor.value, depth + 1);
				});
			}
			const prototype = Object.getPrototypeOf(input);
			if (prototype !== null && prototype !== Object.prototype) refuse();
			const result: Record<string, unknown> = Object.create(null);
			for (const key of Reflect.ownKeys(input)) {
				if (typeof key !== "string") refuse();
				text(key);
				const descriptor = Object.getOwnPropertyDescriptor(input, key);
				if (!descriptor || !("value" in descriptor) || !descriptor.enumerable) refuse();
				result[key] = visit(descriptor.value, depth + 1);
			}
			return result;
		} finally {
			active.delete(input);
		}
	};
	return visit(value, 0);
}

/** Validate and clean a bounded plugin page before entering any SQL scope. */
export function prepareChatPage(input: ChatPageInput): PreparedChatPage {
	try {
		const row = fields(snapshot(input), [
			...REF_FIELDS,
			"expectedCursor",
			"expectedRevision",
			"cursor",
			"changes",
		]);
		if (Buffer.byteLength(JSON.stringify(row)) > CHAT_PAGE_BYTES || !Array.isArray(row.changes))
			refuse();
		const account = reference(Object.fromEntries(REF_FIELDS.map((key) => [key, row[key]])));
		const changes: Change[] = row.changes.map((raw) => {
			const change = NormalizedChange.parse(raw);
			if (change.kind === "chat.deleted")
				return Object.freeze({ kind: change.kind, channelId: change.channelId, ts: change.ts });
			if (change.kind === "chat.conversation") {
				// Channel metadata remains untrusted DATA, never membership/admission authority.
				const metadata = {
					...change,
					...(change.name === undefined ? {} : { name: cleanText(change.name).text }),
				};
				return Object.freeze({
					kind: change.kind,
					channelId: change.channelId,
					json: JSON.stringify(metadata),
				});
			}
			if (change.kind !== "chat.message") refuse();
			if (change.editedAt !== undefined && change.editedAt < change.sentAt) refuse();
			const value: MessageData = freeze({
				channelId: change.channelId,
				ts: change.ts,
				// A provider root may omit threadTs or spell its own ts; these are the same DATA.
				...(change.threadTs === undefined || change.threadTs === change.ts
					? {}
					: { threadTs: change.threadTs }),
				sentAt: change.sentAt,
				author: { ...change.author },
				body: cleanText(change.text),
				...(change.subtype === undefined ? {} : { subtype: change.subtype }),
				...(change.editedAt === undefined ? {} : { editedAt: change.editedAt }),
				...(change.files === undefined ? {} : { files: change.files.map((file) => ({ ...file })) }),
			});
			const json = JSON.stringify(value);
			if (Buffer.byteLength(json) > MESSAGE_BYTES) refuse();
			return Object.freeze({ kind: change.kind, value, json, digest: digest(json) });
		});
		const page: Page = Object.freeze({
			account,
			expectedCursor: row.expectedCursor === null ? null : cursor(row.expectedCursor),
			expectedRevision: integer(row.expectedRevision),
			cursor: cursor(row.cursor),
			changes: Object.freeze(changes),
		});
		const handle = Object.freeze(Object.create(null)) as PreparedChatPage;
		prepared.set(handle, page);
		return handle;
	} catch {
		return refuse();
	}
}

function readBody(value: unknown): HygieneResult {
	const row = fields(value, ["text", "removals", "links", "suspectedInstructions"]);
	if (
		typeof row.text !== "string" ||
		!row.text.isWellFormed() ||
		row.text.length > 40_000 ||
		typeof row.suspectedInstructions !== "boolean" ||
		!Array.isArray(row.links) ||
		row.links.length > 512
	)
		refuse();
	const raw = fields(row.removals, ["hidden", "invisible", "quoted", "truncated", "uris"]);
	const removals = {
		hidden: integer(raw.hidden),
		invisible: integer(raw.invisible),
		quoted: integer(raw.quoted),
		truncated: integer(raw.truncated),
		uris: integer(raw.uris),
	};
	let previous = 0;
	const links = row.links.map((value) => {
		const link = fields(value, ["index", "host"]);
		const index = integer(link.index, previous + 1, 512);
		previous = index;
		return Object.freeze({ index, host: visible(link.host, 40_000) });
	});
	return freeze({
		text: row.text,
		removals,
		links,
		suspectedInstructions: row.suspectedInstructions,
	});
}
function readMessage(json: string, messageId: string): NativeChatMessage {
	const parsed: unknown = JSON.parse(json);
	if (JSON.stringify(parsed) !== json) refuse();
	const row = fields(
		parsed,
		["channelId", "ts", "sentAt", "author", "body"],
		["threadTs", "subtype", "editedAt", "files"],
	);
	// The original protocol validates metadata only. Hygienic body DATA has its own
	// stored representation and is never reparsed as provider text or cleaned twice.
	const metadata = { ...row };
	delete metadata.body;
	const checked = ChatMessageChange.parse({ kind: "chat.message", ...metadata, text: "" });
	return freeze({
		id: id(messageId),
		channelId: checked.channelId,
		ts: checked.ts,
		...(checked.threadTs === undefined ? {} : { threadTs: checked.threadTs }),
		sentAt: checked.sentAt,
		author: checked.author,
		body: readBody(row.body),
		...(checked.subtype === undefined ? {} : { subtype: checked.subtype }),
		...(checked.editedAt === undefined ? {} : { editedAt: checked.editedAt }),
		...(checked.files === undefined ? {} : { files: checked.files }),
	});
}

/** Durable hygienic chat DATA; the native caller separately admits its source and use. */
export class NativeChatStore {
	readonly #database: WorkDatabase;
	readonly #accounts: NativeAccounts;
	readonly #registry: DeviceRegistry;
	readonly #jobs: JobQueue;
	readonly #events: EventLog;
	readonly #clock: Clock;
	#retired = false;
	constructor(
		database: WorkDatabase,
		accounts: NativeAccounts,
		registry: DeviceRegistry,
		jobs: JobQueue,
		events: EventLog,
		clock: Clock,
	) {
		original.queueDatabase.call(jobs, database);
		this.#database = database;
		this.#accounts = accounts;
		this.#registry = registry;
		this.#jobs = jobs;
		this.#events = events;
		this.#clock = clock;
	}
	/** Retires this projection only; borrowed native resources remain with their owner. */
	retire(): void {
		this.#retired = true;
	}
	#work<T>(scope: WorkScope, work: (sql: SqlTransaction) => T): T {
		try {
			if (this.#retired) refuse();
			return work(original.sql.call(this.#database, scope));
		} catch {
			try {
				original.abort.call(this.#database, scope);
			} catch {
				/* Foreign scopes stay refused. */
			}
			return refuse();
		}
	}
	#account(sql: SqlTransaction, ref: MetadataAccountRef): AccountRecord {
		const state = original.state.call(this.#registry, sql);
		if (!state.bootstrapDone || state.ownerUserId === null || state.epoch !== ref.ownerEpoch)
			refuse();
		const record = original.account.call(this.#accounts, sql, state.ownerUserId, ref.accountId);
		const now = integer(this.#clock.wallMs());
		if (
			!record ||
			record.generation !== ref.generation ||
			record.account.userId !== state.ownerUserId ||
			record.account.pluginInstanceId !== ref.pluginInstanceId ||
			record.account.mode !== ref.mode ||
			record.account.channel !== "chat" ||
			record.account.status !== "active" ||
			(record.account.deletionDeadline !== null && record.account.deletionDeadline <= now)
		)
			refuse();
		for (const table of [
			"chatcontent_checkpoints",
			"chatcontent_channels",
			"chatcontent_threads",
			"chatcontent_messages",
		]) {
			if (
				sql.get(`SELECT 1 FROM main.${table} WHERE account_id=? AND user_id<? LIMIT 1`, [
					ref.accountId,
					state.ownerUserId,
				]) ||
				sql.get(`SELECT 1 FROM main.${table} WHERE account_id=? AND user_id>? LIMIT 1`, [
					ref.accountId,
					state.ownerUserId,
				])
			)
				refuse();
		}
		return record;
	}
	#checkpoint(sql: SqlTransaction, ref: MetadataAccountRef, ownerId: string): ChatCheckpoint {
		const row = sql.get<CheckpointRow>(
			"SELECT user_id AS userId,plugin_instance_id AS pluginInstanceId,mode,cursor,revision FROM main.chatcontent_checkpoints WHERE account_id=? AND generation=?",
			[ref.accountId, ref.generation],
		);
		if (!row) return Object.freeze({ cursor: null, revision: 0 });
		if (
			row.userId !== ownerId ||
			row.pluginInstanceId !== ref.pluginInstanceId ||
			row.mode !== ref.mode
		)
			refuse();
		return Object.freeze({ cursor: cursor(row.cursor), revision: integer(row.revision, 1) });
	}
	checkpoint(scope: WorkScope, input: MetadataAccountRef): ChatCheckpoint {
		return this.#work(scope, (sql) => {
			const ref = reference(input),
				record = this.#account(sql, ref);
			return this.#checkpoint(sql, ref, record.account.userId);
		});
	}
	applyPage(scope: WorkScope, lease: JobLease, input: PreparedChatPage): ChatApplyResult {
		return this.#work(scope, () => {
			const page = prepared.get(input);
			if (!page) refuse();
			// The original Queue consumes the genuine handle, including its monotonic deadline.
			// Neither a failed operation nor enclosing rollback revives that handle.
			const renewed = original.renew.call(this.#jobs, scope, lease);
			const sql = original.sql.call(this.#database, scope),
				ref = page.account;
			const record = this.#account(sql, ref),
				ownerId = record.account.userId;
			if (
				renewed.job.kind !== "sync" ||
				renewed.job.state !== "RUNNING" ||
				renewed.job.accountId !== ref.accountId ||
				renewed.job.ownerId !== ownerId
			)
				refuse();
			const checkpoint = this.#checkpoint(sql, ref, ownerId);
			if (
				checkpoint.cursor !== page.expectedCursor ||
				checkpoint.revision !== page.expectedRevision
			)
				refuse();
			const revision = integer(checkpoint.revision + 1, 1);
			const messages = new Set<string>(),
				threads = new Set<string>();
			const at = integer(this.#clock.wallMs(), 0, 0xffffffffffff);
			for (const change of page.changes) {
				if (change.kind === "chat.conversation") {
					sql.run(
						`INSERT INTO main.chatcontent_channels(account_id,generation,user_id,channel_id,metadata_json) VALUES(?,?,?,?,?)
 ON CONFLICT(account_id,generation,channel_id) DO UPDATE SET metadata_json=excluded.metadata_json`,
						[ref.accountId, ref.generation, ownerId, change.channelId, change.json],
					);
					continue;
				}
				const channelId =
					change.kind === "chat.message" ? change.value.channelId : change.channelId;
				const ts = change.kind === "chat.message" ? change.value.ts : change.ts;
				const old = sql.get<MessageRow>(
					"SELECT id,conversation_id AS conversationId,thread_ts AS threadTs,deleted,payload_sha256 AS digest,sent_at AS sentAt,edited_at AS editedAt FROM main.chatcontent_messages WHERE account_id=? AND generation=? AND channel_id=? AND ts=?",
					[ref.accountId, ref.generation, channelId, ts],
				);
				if (old) {
					id(old.id);
					if (old.conversationId !== null) id(old.conversationId);
				}
				if (change.kind === "chat.deleted") {
					if (old?.deleted === 1) continue;
					const messageId = old?.id ?? newId(at);
					sql.run(
						`INSERT INTO main.chatcontent_messages(id,account_id,generation,user_id,channel_id,ts,thread_ts,conversation_id,sent_at,edited_at,deleted,payload_json,payload_sha256)
 VALUES(?,?,?,?,?,?,NULL,NULL,NULL,NULL,1,NULL,NULL) ON CONFLICT(account_id,generation,channel_id,ts) DO UPDATE SET deleted=1,payload_json=NULL,payload_sha256=NULL`,
						[messageId, ref.accountId, ref.generation, ownerId, channelId, ts],
					);
					messages.add(messageId);
					if (old?.conversationId) threads.add(old.conversationId);
					continue;
				}
				// The normalized delete has no restore capability or ordering timestamp.
				// Ordinary history messages cannot resurrect a generation's tombstone.
				if (old?.deleted === 1) continue;
				if (old) {
					if (old.sentAt !== change.value.sentAt) refuse();
					if (
						old.editedAt !== null &&
						(change.value.editedAt === undefined || change.value.editedAt < old.editedAt)
					)
						continue;
					if ((old.editedAt ?? undefined) === change.value.editedAt) {
						if (old.digest === change.digest) continue;
						// Conflicting content with no newer observed edit is unordered.
						refuse();
					}
				}
				const root = change.value.threadTs ?? change.value.ts;
				let thread = sql.get<{ id: string }>(
					"SELECT id FROM main.chatcontent_threads WHERE account_id=? AND generation=? AND channel_id=? AND thread_ts=?",
					[ref.accountId, ref.generation, channelId, root],
				);
				if (!thread) {
					thread = { id: newId(at) };
					sql.run(
						"INSERT INTO main.chatcontent_threads(id,account_id,generation,user_id,channel_id,thread_ts,revision) VALUES(?,?,?,?,?,?,?)",
						[thread.id, ref.accountId, ref.generation, ownerId, channelId, root, revision],
					);
				}
				const conversationId = id(thread.id),
					messageId = old?.id ?? newId(at);
				sql.run(
					`INSERT INTO main.chatcontent_messages(id,account_id,generation,user_id,channel_id,ts,thread_ts,conversation_id,sent_at,edited_at,deleted,payload_json,payload_sha256)
 VALUES(?,?,?,?,?,?,?,?,?,?,0,?,?) ON CONFLICT(account_id,generation,channel_id,ts) DO UPDATE SET thread_ts=excluded.thread_ts,conversation_id=excluded.conversation_id,sent_at=excluded.sent_at,edited_at=excluded.edited_at,deleted=0,payload_json=excluded.payload_json,payload_sha256=excluded.payload_sha256`,
					[
						messageId,
						ref.accountId,
						ref.generation,
						ownerId,
						channelId,
						ts,
						root,
						conversationId,
						change.value.sentAt,
						change.value.editedAt ?? null,
						change.json,
						change.digest,
					],
				);
				messages.add(messageId);
				threads.add(conversationId);
				if (old?.conversationId) threads.add(old.conversationId);
			}
			for (const conversationId of threads) {
				if (
					sql.run(
						"UPDATE main.chatcontent_threads SET revision=? WHERE id=? AND account_id=? AND generation=? AND user_id=?",
						[revision, conversationId, ref.accountId, ref.generation, ownerId],
					).changes !== 1
				)
					refuse();
			}
			sql.run(
				`INSERT INTO main.chatcontent_checkpoints(account_id,generation,user_id,plugin_instance_id,mode,cursor,revision) VALUES(?,?,?,?,?,?,?)
 ON CONFLICT(account_id,generation) DO UPDATE SET cursor=excluded.cursor,revision=excluded.revision`,
				[
					ref.accountId,
					ref.generation,
					ownerId,
					ref.pluginInstanceId,
					ref.mode,
					page.cursor,
					revision,
				],
			);
			for (const [kind, values] of [
				["messages.changed", [...messages]],
				["threads.changed", [...threads]],
			] as const) {
				for (let start = 0; start < values.length; start += EVENT_PAGE_SIZE)
					original.append.call(this.#events, scope, {
						userId: ownerId,
						accountId: ref.accountId,
						dataClass: "slack.content",
						kind,
						ids: values.slice(start, start + EVENT_PAGE_SIZE),
					});
			}
			// No external await occurs in this scope. Recheck retirement/account state after writes.
			if (this.#retired) refuse();
			this.#account(original.sql.call(this.#database, scope), ref);
			return Object.freeze({
				checkpoint: Object.freeze({ cursor: page.cursor, revision }),
				changedMessageIds: Object.freeze([...messages]),
				changedConversationIds: Object.freeze([...threads]),
				lease: renewed,
			});
		});
	}
	readThread(
		scope: WorkScope,
		input: MetadataAccountRef,
		selection: { readonly channelId: string; readonly threadTs: string },
	): NativeChatThread {
		return this.#work(scope, (sql) => {
			const ref = reference(input),
				record = this.#account(sql, ref);
			const selected = fields(selection, ["channelId", "threadTs"]);
			const channelId = visible(selected.channelId),
				threadTs = visible(selected.threadTs);
			const checkpoint = this.#checkpoint(sql, ref, record.account.userId);
			const thread = sql.get<{ id: string; revision: number }>(
				"SELECT id,revision FROM main.chatcontent_threads WHERE account_id=? AND generation=? AND user_id=? AND channel_id=? AND thread_ts=?",
				[ref.accountId, ref.generation, record.account.userId, channelId, threadTs],
			);
			const result = (
				availability: NativeChatThread["availability"],
				messages: readonly NativeChatMessage[] = [],
			): NativeChatThread =>
				Object.freeze({
					account: ref,
					conversationId: thread ? id(thread.id) : null,
					channelId,
					threadTs,
					checkpoint,
					threadRevision: thread ? integer(thread.revision, 1, checkpoint.revision) : 0,
					messages: Object.freeze([...messages]),
					availability,
					coverage: COVERAGE,
				});
			if (!thread) return result("missing");
			const root = sql.get<MessageRow>(
				"SELECT id,conversation_id AS conversationId,thread_ts AS threadTs,deleted,payload_sha256 AS digest,sent_at AS sentAt,edited_at AS editedAt FROM main.chatcontent_messages WHERE account_id=? AND generation=? AND user_id=? AND channel_id=? AND ts=?",
				[ref.accountId, ref.generation, record.account.userId, channelId, threadTs],
			);
			if (root?.deleted !== 0 || root.conversationId !== thread.id || root.threadTs !== threadTs)
				return result("withheld");
			const rows = sql.all<{ id: string; ts: string; bytes: number }>(
				"SELECT id,ts,length(CAST(payload_json AS BLOB)) AS bytes FROM main.chatcontent_messages WHERE account_id=? AND generation=? AND user_id=? AND conversation_id=? AND deleted=0 ORDER BY sent_at,ts LIMIT ?",
				[ref.accountId, ref.generation, record.account.userId, thread.id, CHAT_THREAD_MESSAGES + 1],
			);
			if (rows.length > CHAT_THREAD_MESSAGES) return result("truncated");
			let bytes = 0;
			const messages: NativeChatMessage[] = [];
			for (const row of rows) {
				bytes += integer(row.bytes, 1, MESSAGE_BYTES);
				if (bytes > CHAT_THREAD_BYTES) return result("truncated");
				const stored = sql.get<{ json: string | null; digest: string | null }>(
					`SELECT CASE WHEN length(CAST(payload_json AS BLOB)) BETWEEN 1 AND ${MESSAGE_BYTES} THEN payload_json END AS json,payload_sha256 AS digest FROM main.chatcontent_messages WHERE id=? AND account_id=? AND generation=? AND user_id=? AND conversation_id=? AND deleted=0`,
					[id(row.id), ref.accountId, ref.generation, record.account.userId, thread.id],
				);
				if (!stored || typeof stored.json !== "string" || digest(stored.json) !== stored.digest)
					refuse();
				const message = readMessage(stored.json, row.id);
				if (
					message.channelId !== channelId ||
					message.ts !== row.ts ||
					(message.ts === threadTs
						? message.threadTs !== undefined && message.threadTs !== threadTs
						: message.threadTs !== threadTs)
				)
					refuse();
				messages.push(message);
			}
			if (!messages.some((message) => message.ts === threadTs)) refuse();
			return result("available", messages);
		});
	}
}
