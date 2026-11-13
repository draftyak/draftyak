import { Buffer } from "node:buffer";
import { createHash, type Hash } from "node:crypto";
import { types } from "node:util";
import { checkedParsedMail, contentErrorCode, type ParsedMail } from "@draftyak/content";
import { EmailAddress } from "@draftyak/protocol/entities/common";
import type { BlobRef } from "@draftyak/protocol/normalized-change";
import { NativeAccounts } from "../accounts/records.ts";
import { DeviceRegistry } from "../identity/devices.ts";
import { WorkDatabase, type WorkScope } from "../jobs/database.ts";
import { type JobLease, JobQueue } from "../jobs/queue.ts";
import { fields, id, integer } from "../jobs/values.ts";
import type { SqlTransaction } from "../store/store.ts";
import { type MetadataAccountRef, type MetadataCheckpoint, NativeMetadataStore } from "./apply.ts";
import {
	NativeRawStore,
	RAW_CONTENT_CHUNK_BYTES,
	RAW_CONTENT_MAX_BYTES,
	type RawContentSlice,
} from "./raw-store.ts";

export const MAX_PARSED_JSON_BYTES = 4_194_304;
export const MAX_PARSED_ACCOUNT_BYTES = 67_108_864;
export const MAX_PARSED_ACCOUNT_RECORDS = 10_000;
export const PARSED_READ_LIMIT = 100;
export const PARSED_CLEANUP_LIMIT = 500;
export const PARSED_SEARCH_SCAN_LIMIT = 100;
export const MAX_PARSED_SEARCH_BYTES = 4_194_304;
export const MAX_PARSED_SEARCH_QUERY_BYTES = 1024;
export const MAX_PARSED_SEARCH_QUERY_SCALARS = 256;
declare const parsedSource: unique symbol;
export interface NativeParsedSource {
	readonly [parsedSource]: true;
}
export interface NativeParsedRecord {
	readonly messageId: string;
	readonly providerId: string;
	readonly threadId: string;
	readonly raw: BlobRef;
	readonly rawSha256: string;
	readonly rawBytes: number;
	readonly sourceCheckpoint: MetadataCheckpoint;
	readonly mail: ParsedMail;
	readonly association: "unverified";
}
export interface NativeParsedThreadPage {
	readonly records: readonly NativeParsedRecord[];
	readonly nextAfterId: string | null;
	readonly scanned: number;
}
/** Proposed literal-phrase search DATA; no provider association or history authority. */
export interface NativeParsedSearchPage {
	readonly account: MetadataAccountRef;
	readonly query: string;
	readonly checkpoint: MetadataCheckpoint;
	readonly records: readonly NativeParsedRecord[];
	readonly nextAfterId: string | null;
	readonly scanned: number;
	readonly coverage: {
		readonly state: "unknown";
		readonly reason: "provider-history-unproven";
	};
}
export interface ParsedCleanupProgress {
	readonly deleted: number;
	readonly nextId: string | null;
	readonly more: boolean;
}
export class NativeParsedError extends Error {
	readonly code = "PARSED_CONTENT_UNAVAILABLE";
	constructor() {
		super("Parsed content unavailable");
		this.name = "NativeParsedError";
	}
}
const original = Object.freeze({
	sql: WorkDatabase.prototype.sql,
	abort: WorkDatabase.prototype.abort,
	account: NativeAccounts.prototype.get,
	devices: DeviceRegistry.prototype.state,
	checkpoint: NativeMetadataStore.prototype.checkpoint,
	raw: NativeRawStore.prototype.read,
	renew: JobQueue.prototype.renew,
	complete: JobQueue.prototype.complete,
	fail: JobQueue.prototype.fail,
});
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
const REF_FIELDS = ["accountId", "generation", "pluginInstanceId", "ownerEpoch", "mode"];
function refuse(): never {
	throw new NativeParsedError();
}
function digest(value: string | Uint8Array): string {
	return createHash("sha256").update(value).digest("hex");
}
function sha(value: unknown): string {
	if (typeof value !== "string" || !/^[0-9a-f]{64}$/.test(value)) refuse();
	return value;
}
function text(value: unknown, maximum: number, minimum = 0): string {
	if (
		typeof value !== "string" ||
		!value.isWellFormed() ||
		value.length < minimum ||
		value.length > maximum
	)
		refuse();
	return value;
}
function visible(value: unknown, maximum = 256): string {
	const result = text(value, maximum, 1);
	if (!/^[!-~]+$/.test(result)) refuse();
	return result;
}
function ref(value: MetadataAccountRef): MetadataAccountRef {
	const r = fields(value, REF_FIELDS);
	if (r.mode !== "full" && r.mode !== "read_only") refuse();
	return Object.freeze({
		accountId: id(r.accountId),
		generation: integer(r.generation, 1),
		pluginInstanceId: id(r.pluginInstanceId),
		ownerEpoch: integer(r.ownerEpoch),
		mode: r.mode,
	});
}
function blob(value: BlobRef): BlobRef {
	return Object.freeze({ ref: id(fields(value, ["ref"]).ref) });
}

/** Materialize bounded inert JSON before shared checks or serialization can observe it. */
function snapshot(value: unknown): unknown {
	let nodes = 0,
		budget = 0;
	const charge = (amount: number): void => {
		budget += amount;
		if (budget > MAX_PARSED_JSON_BYTES) refuse();
	};
	const string = (s: string): void => {
		charge(2);
		for (let i = 0; i < s.length; i++) {
			const n = s.charCodeAt(i);
			if (n < 32) charge(n === 8 || n === 9 || n === 10 || n === 12 || n === 13 ? 2 : 6);
			else if (n === 34 || n === 92) charge(2);
			else if (n < 128) charge(1);
			else if (n < 2048) charge(2);
			else if (
				n >= 0xd800 &&
				n <= 0xdbff &&
				i + 1 < s.length &&
				s.charCodeAt(i + 1) >= 0xdc00 &&
				s.charCodeAt(i + 1) <= 0xdfff
			) {
				charge(4);
				i++;
			} else charge(n >= 0xd800 && n <= 0xdfff ? 6 : 3);
		}
	};
	const copy = (v: unknown, depth: number): unknown => {
		if (++nodes > 20_000 || depth > 8) refuse();
		if (v === null) {
			charge(4);
			return null;
		}
		if (typeof v === "string") {
			string(v);
			return v;
		}
		if (typeof v === "boolean") {
			charge(v ? 4 : 5);
			return v;
		}
		if (typeof v === "number" && Number.isFinite(v)) {
			charge(String(v).length);
			return v;
		}
		if (typeof v !== "object" || types.isProxy(v)) refuse();
		if (Array.isArray(v)) {
			if (
				v.length > 20_000 ||
				Reflect.ownKeys(v).some(
					(k) =>
						k !== "length" &&
						(typeof k !== "string" || !/^(0|[1-9][0-9]*)$/.test(k) || Number(k) >= v.length),
				)
			)
				refuse();
			charge(2 + Math.max(0, v.length - 1));
			const result: unknown[] = [];
			for (let i = 0; i < v.length; i++) {
				const d = Object.getOwnPropertyDescriptor(v, String(i));
				if (!d?.enumerable || !("value" in d)) refuse();
				result.push(copy(d.value, depth + 1));
			}
			return result;
		}
		if (Object.getPrototypeOf(v) !== Object.prototype && Object.getPrototypeOf(v) !== null)
			refuse();
		const names = Reflect.ownKeys(v),
			result: Record<string, unknown> = Object.create(null);
		charge(2 + Math.max(0, names.length - 1));
		for (const key of names) {
			if (typeof key !== "string") refuse();
			const d = Object.getOwnPropertyDescriptor(v, key);
			if (!d?.enumerable || !("value" in d)) refuse();
			string(key);
			charge(1);
			result[key] = copy(d.value, depth + 1);
		}
		return result;
	};
	return copy(value, 0);
}
function array(value: unknown, maximum: number): readonly unknown[] {
	if (!Array.isArray(value) || value.length > maximum) refuse();
	return value;
}
function freeze<T>(value: T): T {
	if (value !== null && typeof value === "object") {
		for (const item of Object.values(value)) freeze(item);
		Object.freeze(value);
	}
	return value;
}
function parsed(value: unknown): ParsedMail {
	const m = fields(
		snapshot(value),
		[
			"rawSha256",
			"direction",
			"auth",
			"from",
			"to",
			"cc",
			"bcc",
			"replyTo",
			"subject",
			"body",
			"attachments",
		],
		["messageId", "inReplyTo", "references", "date", "bodyRefusal", "replyToHeaderCount"],
	);
	sha(m.rawSha256);
	if (m.direction !== "inbound") refuse();
	const auth = fields(m.auth, ["dmarc", "reason"]);
	if (
		auth.dmarc !== "none" ||
		!["unsupported-provider", "ambiguous-from"].includes(String(auth.reason))
	)
		refuse();
	for (const name of ["from", "to", "cc", "bcc", "replyTo"])
		for (const item of array(m[name], 500)) {
			const b = fields(item, ["address"], ["name"]);
			if (!EmailAddress.safeParse(b.address).success) refuse();
			if (b.name !== undefined) text(b.name, 65_536);
		}
	text(m.subject, 65_536);
	for (const name of ["messageId", "inReplyTo", "references", "date"])
		if (m[name] !== undefined) text(m[name], 65_536);
	if (m.bodyRefusal !== undefined && !contentErrorCode(m.bodyRefusal)) refuse();
	if (m.replyToHeaderCount !== undefined) integer(m.replyToHeaderCount);
	const body = fields(m.body, ["text", "removals", "links", "suspectedInstructions"]);
	text(body.text, 80_000);
	if ([...(body.text as string)].length > 40_000 || typeof body.suspectedInstructions !== "boolean")
		refuse();
	const removals = fields(body.removals, ["hidden", "invisible", "quoted", "truncated", "uris"]);
	for (const n of Object.values(removals)) integer(n);
	for (const link of array(body.links, 20_000)) {
		const l = fields(link, ["index", "host"]);
		integer(l.index, 0, (body.text as string).length);
		text(l.host, 4096, 1);
	}
	for (const item of array(m.attachments, 100)) {
		const a = fields(item, ["mimeType", "size", "sha256"], ["filename"]);
		text(a.mimeType, 256, 1);
		integer(a.size, 0, RAW_CONTENT_MAX_BYTES);
		sha(a.sha256);
		if (a.filename !== undefined) text(a.filename, 2048);
	}
	return freeze(checkedParsedMail(m as unknown as ParsedMail));
}

interface Message {
	messageId: string;
	providerId: string;
	threadId: string;
	conversationId: string;
	internalDate: number;
	labelJson: string;
	sizeBytes: number | null;
}
interface Context {
	checkpoint: MetadataCheckpoint;
	ownerId: string;
	ownerAddress: string;
	accountDigest: string;
}
function parsedScope(input: MetadataAccountRef, context: Context): string {
	const hex = (value: string): string => Buffer.from(value, "utf8").toString("hex");
	return [
		"dyparsedv1",
		hex(context.ownerId),
		hex(input.accountId),
		String(input.generation),
		hex(input.pluginInstanceId),
		hex(input.mode),
		context.accountDigest,
	].join("z");
}
function searchQuery(value: unknown): string {
	const query = text(value, MAX_PARSED_SEARCH_QUERY_SCALARS * 2, 1);
	if (
		[...query].length > MAX_PARSED_SEARCH_QUERY_SCALARS ||
		Buffer.byteLength(query, "utf8") > MAX_PARSED_SEARCH_QUERY_BYTES ||
		query.normalize("NFC") !== query ||
		/\p{Cc}/u.test(query) ||
		!/[\p{L}\p{N}]/u.test(query)
	)
		refuse();
	return query;
}
const ftsLiteral = (value: string): string => `"${value.replaceAll('"', '""')}"`;
interface SourceState {
	owner: NativeParsedStore;
	ref: MetadataAccountRef;
	message: Message;
	metadataDigest: string;
	context: Context;
	raw: BlobRef;
	rawSha256: string;
	rawBytes: number;
	lease: JobLease;
	active: boolean;
	finished: boolean;
	offset: number | null;
	hash: Hash | undefined;
	passes: number;
}
const sources = new WeakMap<object, SourceState>();
const MESSAGE = `SELECT m.id AS messageId,m.provider_id AS providerId,c.provider_id AS threadId,
 m.conversation_id AS conversationId,m.internal_date AS internalDate,
 CASE WHEN typeof(m.label_json)='text' AND length(CAST(m.label_json AS BLOB))<=131841 THEN m.label_json END AS labelJson,
 m.size_bytes AS sizeBytes
 FROM main.content_messages m JOIN main.content_conversations c
 ON c.id=m.conversation_id AND c.account_id=m.account_id AND c.generation=m.generation AND c.user_id=m.user_id
 WHERE m.id=? AND m.account_id=? AND m.generation=? AND m.user_id=? AND m.state='unparsed' AND m.direction='inbound'`;
interface StoredRow {
	messageId: string;
	providerId: string;
	threadId: string;
	rawRef: string;
	rawSha256: string;
	rawBytes: number;
	cursor: string;
	revision: number;
	accountDigest: string;
	metadataDigest: string;
	json: string | null;
	parsedDigest: string;
	association: string;
	scopeToken: string;
	cleanedBody: string | null;
}
const STORED = `SELECT message_id AS messageId,provider_id AS providerId,thread_id AS threadId,raw_ref AS rawRef,
 raw_sha256 AS rawSha256,raw_bytes AS rawBytes,source_cursor AS cursor,source_revision AS revision,
 account_digest AS accountDigest,metadata_digest AS metadataDigest,
 CASE WHEN typeof(parsed_json)='text' AND length(CAST(parsed_json AS BLOB))<=${MAX_PARSED_JSON_BYTES} THEN parsed_json END AS json,
  parsed_digest AS parsedDigest,association,scope_token AS scopeToken,
  CASE WHEN typeof(cleaned_body)='text' AND length(CAST(cleaned_body AS BLOB))<=160000 THEN cleaned_body END AS cleanedBody
  FROM main.content_parsed_messages`;

/** Parsed extraction DATA, not verified provider-message association, history or send authority. */
export class NativeParsedStore {
	readonly #database: WorkDatabase;
	readonly #accounts: NativeAccounts;
	readonly #devices: DeviceRegistry;
	readonly #jobs: JobQueue;
	readonly #metadata: NativeMetadataStore;
	readonly #raw: NativeRawStore;
	constructor(
		database: WorkDatabase,
		accounts: NativeAccounts,
		devices: DeviceRegistry,
		jobs: JobQueue,
		metadata: NativeMetadataStore,
		raw: NativeRawStore,
	) {
		this.#database = database;
		this.#accounts = accounts;
		this.#devices = devices;
		this.#jobs = jobs;
		this.#metadata = metadata;
		this.#raw = raw;
	}
	#work<T>(scope: WorkScope, work: (sql: SqlTransaction) => T): T {
		try {
			return work(original.sql.call(this.#database, scope));
		} catch {
			try {
				original.abort.call(this.#database, scope);
			} catch {
				/* Foreign scopes stay refused. */
			}
			throw new NativeParsedError();
		}
	}
	#context(scope: WorkScope, sql: SqlTransaction, input: MetadataAccountRef): Context {
		const checkpoint = original.checkpoint.call(this.#metadata, scope, input);
		const state = original.devices.call(this.#devices, sql);
		if (!state.bootstrapDone || state.ownerUserId === null || state.epoch !== input.ownerEpoch)
			refuse();
		const record = original.account.call(this.#accounts, scope, state.ownerUserId, input.accountId);
		if (
			!record ||
			record.generation !== input.generation ||
			record.account.userId !== state.ownerUserId ||
			record.account.channel !== "email" ||
			record.account.status !== "active" ||
			record.account.mode !== input.mode ||
			record.account.pluginInstanceId !== input.pluginInstanceId
		)
			refuse();
		for (const comparison of ["<", ">"] as const) {
			if (
				sql.get(
					`SELECT 1 FROM main.content_parsed_messages WHERE account_id=? AND user_id${comparison}? LIMIT 1`,
					[input.accountId, state.ownerUserId],
				)
			)
				refuse();
		}
		if (checkpoint.cursor === null || checkpoint.revision < 1) refuse();
		return {
			checkpoint,
			ownerId: id(state.ownerUserId),
			ownerAddress: record.account.address,
			accountDigest: digest(JSON.stringify(record.account)),
		};
	}
	#message(
		sql: SqlTransaction,
		input: MetadataAccountRef,
		ownerId: string,
		messageId: string,
	): Message | undefined {
		const row = sql.get<Message>(MESSAGE, [messageId, input.accountId, input.generation, ownerId]);
		if (!row) return undefined;
		id(row.messageId);
		id(row.conversationId);
		visible(row.providerId);
		visible(row.threadId);
		integer(row.internalDate);
		if (row.sizeBytes !== null) integer(row.sizeBytes);
		text(row.labelJson, 131_841, 2);
		const labels: unknown = JSON.parse(row.labelJson);
		for (const item of array(labels, 256)) visible(item);
		return row;
	}
	#rawMeta(
		scope: WorkScope,
		input: MetadataAccountRef,
		raw: BlobRef,
	): { rawSha256: string; rawBytes: number } {
		const slice = original.raw.call(this.#raw, scope, input, raw, 0, 1);
		try {
			return {
				rawSha256: sha(slice.sha256),
				rawBytes: integer(slice.totalBytes, 1, RAW_CONTENT_MAX_BYTES),
			};
		} finally {
			slice.bytes.fill(0);
		}
	}
	#source(source: NativeParsedSource, active = true): SourceState {
		if (source === null || typeof source !== "object" || types.isProxy(source)) refuse();
		const state = sources.get(source);
		if (!state || state.owner !== this || (active && (!state.active || state.finished))) refuse();
		return state;
	}
	#sourceFor(scope: WorkScope, source: NativeParsedSource, active = true): SourceState {
		try {
			return this.#source(source, active);
		} catch {
			try {
				original.abort.call(this.#database, scope);
			} catch {
				/* Foreign scopes stay refused. */
			}
			throw new NativeParsedError();
		}
	}
	#check(scope: WorkScope, sql: SqlTransaction, state: SourceState): void {
		const context = this.#context(scope, sql, state.ref),
			message = this.#message(sql, state.ref, context.ownerId, state.message.messageId);
		const currentRaw = this.#rawMeta(scope, state.ref, state.raw);
		if (
			context.ownerId !== state.context.ownerId ||
			context.accountDigest !== state.context.accountDigest ||
			context.checkpoint.cursor !== state.context.checkpoint.cursor ||
			context.checkpoint.revision !== state.context.checkpoint.revision ||
			!message ||
			digest(JSON.stringify(message)) !== state.metadataDigest ||
			currentRaw.rawBytes !== state.rawBytes ||
			currentRaw.rawSha256 !== state.rawSha256
		)
			refuse();
	}
	capture(
		scope: WorkScope,
		lease: JobLease,
		input: MetadataAccountRef,
		messageId: string,
		raw: BlobRef,
	): NativeParsedSource {
		return this.#work(scope, (sql) => {
			const account = ref(input),
				key = id(messageId),
				object = blob(raw),
				context = this.#context(scope, sql, account),
				message = this.#message(sql, account, context.ownerId, key);
			if (!message) refuse();
			const job = fields(fields(lease, ["job"]).job, JOB_FIELDS);
			if (
				job.kind !== "sync" ||
				job.state !== "RUNNING" ||
				job.accountId !== account.accountId ||
				job.ownerId !== context.ownerId ||
				job.refId !== key
			)
				refuse();
			const rawMeta = this.#rawMeta(scope, account, object),
				renewed = original.renew.call(this.#jobs, scope, lease);
			const source = Object.freeze({}) as NativeParsedSource;
			sources.set(source, {
				owner: this,
				ref: account,
				message,
				metadataDigest: digest(JSON.stringify(message)),
				context,
				raw: object,
				...rawMeta,
				lease: renewed,
				active: true,
				finished: false,
				offset: 0,
				hash: createHash("sha256"),
				passes: 0,
			});
			return source;
		});
	}
	ownerAddress(scope: WorkScope, source: NativeParsedSource): string {
		const state = this.#sourceFor(scope, source);
		try {
			return this.#work(scope, (sql) => {
				this.#check(scope, sql, state);
				state.lease = original.renew.call(this.#jobs, scope, state.lease);
				return state.context.ownerAddress;
			});
		} catch {
			state.active = false;
			throw new NativeParsedError();
		}
	}
	readSource(
		scope: WorkScope,
		source: NativeParsedSource,
		offset = 0,
		maxBytes: number = RAW_CONTENT_CHUNK_BYTES,
	): RawContentSlice {
		const state = this.#sourceFor(scope, source);
		let slice: RawContentSlice | undefined;
		try {
			return this.#work(scope, (sql) => {
				this.#check(scope, sql, state);
				integer(offset, 0, state.rawBytes);
				integer(maxBytes, 1, RAW_CONTENT_CHUNK_BYTES);
				if (state.offset === null && offset === 0) {
					state.offset = 0;
					state.hash = createHash("sha256");
				}
				if (state.offset !== offset || !state.hash) refuse();
				state.lease = original.renew.call(this.#jobs, scope, state.lease);
				slice = original.raw.call(this.#raw, scope, state.ref, state.raw, offset, maxBytes);
				if (
					slice.totalBytes !== state.rawBytes ||
					slice.sha256 !== state.rawSha256 ||
					slice.bytes.length < 1 ||
					slice.bytes.length > maxBytes ||
					slice.nextOffset !==
						(offset + slice.bytes.length === state.rawBytes ? null : offset + slice.bytes.length)
				)
					refuse();
				state.hash.update(slice.bytes);
				state.offset = slice.nextOffset;
				if (slice.nextOffset === null) {
					if (state.hash.digest("hex") !== state.rawSha256) refuse();
					state.hash = undefined;
					state.passes++;
				}
				return slice;
			});
		} catch {
			slice?.bytes.fill(0);
			state.active = false;
			throw new NativeParsedError();
		}
	}
	commit(scope: WorkScope, source: NativeParsedSource, value: ParsedMail): NativeParsedRecord {
		const state = this.#sourceFor(scope, source);
		try {
			return this.#work(scope, (sql) => {
				const mail = parsed(value);
				this.#check(scope, sql, state);
				if (state.passes < 2 || state.offset !== null || mail.rawSha256 !== state.rawSha256)
					refuse();
				const json = JSON.stringify(mail);
				if (Buffer.byteLength(json) > MAX_PARSED_JSON_BYTES) refuse();
				const old = sql.get<{ bytes: number }>(
					"SELECT length(CAST(parsed_json AS BLOB)) AS bytes FROM main.content_parsed_messages WHERE message_id=?",
					[state.message.messageId],
				);
				const total = sql.get<{ count: number; bytes: number | null }>(
					"SELECT count(*) AS count,sum(length(CAST(parsed_json AS BLOB))) AS bytes FROM main.content_parsed_messages WHERE account_id=? AND generation=?",
					[state.ref.accountId, state.ref.generation],
				);
				if (
					!total ||
					total.count + (old ? 0 : 1) > MAX_PARSED_ACCOUNT_RECORDS ||
					(total.bytes ?? 0) - (old?.bytes ?? 0) + Buffer.byteLength(json) >
						MAX_PARSED_ACCOUNT_BYTES
				)
					refuse();
				original.complete.call(this.#jobs, scope, state.lease);
				const params = [
					state.message.messageId,
					state.ref.accountId,
					state.ref.generation,
					state.context.ownerId,
					state.ref.pluginInstanceId,
					state.ref.mode,
					state.message.providerId,
					state.message.threadId,
					state.context.accountDigest,
					state.metadataDigest,
					state.context.checkpoint.cursor,
					state.context.checkpoint.revision,
					state.raw.ref,
					state.rawSha256,
					state.rawBytes,
					json,
					digest(json),
					parsedScope(state.ref, state.context),
					mail.body.text,
				];
				if (
					sql.run(
						`INSERT INTO main.content_parsed_messages(message_id,account_id,generation,user_id,plugin_instance_id,mode,provider_id,thread_id,account_digest,metadata_digest,source_cursor,source_revision,raw_ref,raw_sha256,raw_bytes,parsed_json,parsed_digest,scope_token,cleaned_body,association)
 VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,'unverified') ON CONFLICT(message_id) DO UPDATE SET provider_id=excluded.provider_id,thread_id=excluded.thread_id,account_digest=excluded.account_digest,metadata_digest=excluded.metadata_digest,source_cursor=excluded.source_cursor,source_revision=excluded.source_revision,raw_ref=excluded.raw_ref,raw_sha256=excluded.raw_sha256,raw_bytes=excluded.raw_bytes,parsed_json=excluded.parsed_json,parsed_digest=excluded.parsed_digest,scope_token=excluded.scope_token,cleaned_body=excluded.cleaned_body,association='unverified'
 WHERE account_id=excluded.account_id AND generation=excluded.generation AND user_id=excluded.user_id AND plugin_instance_id=excluded.plugin_instance_id AND mode=excluded.mode`,
						params,
					).changes !== 1
				)
					refuse();
				state.active = false;
				state.finished = true;
				return freeze({
					messageId: state.message.messageId,
					providerId: state.message.providerId,
					threadId: state.message.threadId,
					raw: { ref: state.raw.ref },
					rawSha256: state.rawSha256,
					rawBytes: state.rawBytes,
					sourceCheckpoint: { ...state.context.checkpoint },
					mail,
					association: "unverified" as const,
				});
			});
		} catch {
			state.active = false;
			throw new NativeParsedError();
		}
	}
	abandon(scope: WorkScope, source: NativeParsedSource): void {
		const state = this.#sourceFor(scope, source, false);
		if (state.finished) return;
		state.active = false;
		try {
			this.#work(scope, () => original.fail.call(this.#jobs, scope, state.lease));
		} finally {
			state.finished = true;
			state.hash = undefined;
		}
	}
	#record(
		scope: WorkScope,
		sql: SqlTransaction,
		input: MetadataAccountRef,
		context: Context,
		row: StoredRow,
	): NativeParsedRecord | undefined {
		const message = this.#message(sql, input, context.ownerId, id(row.messageId));
		if (
			!message ||
			row.accountDigest !== context.accountDigest ||
			row.metadataDigest !== digest(JSON.stringify(message))
		)
			return undefined;
		integer(row.revision, 1);
		visible(row.cursor, 4096);
		if (
			row.association !== "unverified" ||
			row.json === null ||
			digest(row.json) !== sha(row.parsedDigest) ||
			row.revision > context.checkpoint.revision ||
			(row.revision === context.checkpoint.revision && row.cursor !== context.checkpoint.cursor)
		)
			refuse();
		const raw = blob({ ref: row.rawRef }),
			current = this.#rawMeta(scope, input, raw),
			mail = parsed(JSON.parse(row.json));
		if (row.scopeToken !== parsedScope(input, context) || row.cleanedBody !== mail.body.text)
			refuse();
		if (
			current.rawBytes !== row.rawBytes ||
			current.rawSha256 !== row.rawSha256 ||
			mail.rawSha256 !== row.rawSha256 ||
			row.providerId !== message.providerId ||
			row.threadId !== message.threadId
		)
			refuse();
		return freeze({
			messageId: row.messageId,
			providerId: row.providerId,
			threadId: row.threadId,
			raw,
			rawSha256: sha(row.rawSha256),
			rawBytes: integer(row.rawBytes, 1, RAW_CONTENT_MAX_BYTES),
			sourceCheckpoint: { cursor: visible(row.cursor, 4096), revision: integer(row.revision, 1) },
			mail,
			association: "unverified" as const,
		});
	}
	read(
		scope: WorkScope,
		input: MetadataAccountRef,
		messageId: string,
	): NativeParsedRecord | undefined {
		return this.#work(scope, (sql) => {
			const account = ref(input),
				context = this.#context(scope, sql, account);
			const row = sql.get<StoredRow>(
				`${STORED} WHERE message_id=? AND account_id=? AND generation=? AND user_id=? AND plugin_instance_id=? AND mode=?`,
				[
					id(messageId),
					account.accountId,
					account.generation,
					context.ownerId,
					account.pluginInstanceId,
					account.mode,
				],
			);
			return row ? this.#record(scope, sql, account, context, row) : undefined;
		});
	}
	/** The continuation advances scanned candidates, including stale cached rows. */
	forThread(
		scope: WorkScope,
		input: MetadataAccountRef,
		threadId: string,
		afterId: string | null = null,
		scanLimit: number = PARSED_READ_LIMIT,
	): NativeParsedThreadPage {
		return this.#work(scope, (sql) => {
			const account = ref(input),
				context = this.#context(scope, sql, account),
				count = integer(scanLimit, 1, PARSED_READ_LIMIT);
			const records: NativeParsedRecord[] = [];
			const rows = sql.all<StoredRow>(
				`${STORED} WHERE account_id=? AND generation=? AND user_id=? AND plugin_instance_id=? AND mode=? AND thread_id=? AND message_id>? ORDER BY message_id LIMIT ?`,
				[
					account.accountId,
					account.generation,
					context.ownerId,
					account.pluginInstanceId,
					account.mode,
					visible(threadId),
					afterId === null ? "" : id(afterId),
					count,
				],
			);
			let lastScannedId: string | null = null;
			for (const row of rows) {
				lastScannedId = id(row.messageId);
				const record = this.#record(scope, sql, account, context, row);
				if (record) records.push(record);
			}
			return Object.freeze({
				records: Object.freeze(records),
				nextAfterId: rows.length === count ? lastScannedId : null,
				scanned: rows.length,
			});
		});
	}
	/**
	 * UNAPPLIED API proposal: literal phrase with the proposed unicode61 tokenizer.
	 * Walk at most 100 account-indexed rows and issue at most one point MATCH each.
	 * This is a Source-level bound, not a proved bound on the native FTS engine.
	 */
	search(
		scope: WorkScope,
		input: MetadataAccountRef,
		query: string,
		afterId: string | null = null,
		scanLimit: number = PARSED_SEARCH_SCAN_LIMIT,
	): NativeParsedSearchPage {
		return this.#work(scope, (sql) => {
			const account = ref(input),
				phrase = searchQuery(query),
				context = this.#context(scope, sql, account);
			const maximum = integer(scanLimit, 1, PARSED_SEARCH_SCAN_LIMIT),
				token = parsedScope(account, context);
			const match = `scope_token : ${ftsLiteral(token)} AND cleaned_body : ${ftsLiteral(phrase)}`;
			let cursor = afterId === null ? null : id(afterId),
				scanned = 0,
				more = false;
			const records: NativeParsedRecord[] = [];
			const coverage: NativeParsedSearchPage["coverage"] = Object.freeze({
				state: "unknown",
				reason: "provider-history-unproven",
			});
			let bytes = Buffer.byteLength(
				JSON.stringify({
					account,
					query: phrase,
					checkpoint: context.checkpoint,
					records: [],
					nextAfterId: "00000000000000000000000000",
					scanned: PARSED_SEARCH_SCAN_LIMIT,
					coverage,
				}),
				"utf8",
			);
			if (bytes > MAX_PARSED_SEARCH_BYTES) refuse();
			while (scanned < maximum && records.length < PARSED_READ_LIMIT) {
				const candidate = sql.get<{ seq: number; messageId: string }>(
					`SELECT seq,message_id AS messageId FROM main.content_parsed_messages INDEXED BY content_parsed_search_page
 WHERE scope_token=? AND account_id=? AND generation=? AND user_id=? AND plugin_instance_id=? AND mode=? AND message_id>? ORDER BY message_id LIMIT 1`,
					[
						token,
						account.accountId,
						account.generation,
						context.ownerId,
						account.pluginInstanceId,
						account.mode,
						cursor ?? "",
					],
				);
				if (!candidate) {
					more = false;
					break;
				}
				const next = id(candidate.messageId),
					seq = integer(candidate.seq, 1);
				if (cursor !== null && next <= cursor) refuse();
				scanned++;
				const hit = sql.get<{ seq: number }>(
					"SELECT rowid AS seq FROM main.content_parsed_fts WHERE rowid BETWEEN ? AND ? AND content_parsed_fts MATCH ?",
					[seq, seq, match],
				);
				if (hit) {
					if (integer(hit.seq, 1) !== seq) refuse();
					const row = sql.get<StoredRow>(
						`${STORED} WHERE seq=? AND message_id=? AND scope_token=? AND account_id=? AND generation=? AND user_id=? AND plugin_instance_id=? AND mode=?`,
						[
							seq,
							next,
							token,
							account.accountId,
							account.generation,
							context.ownerId,
							account.pluginInstanceId,
							account.mode,
						],
					);
					const record = row ? this.#record(scope, sql, account, context, row) : undefined;
					if (record) {
						if (record.messageId !== next || record.association !== "unverified") refuse();
						const added =
							Buffer.byteLength(JSON.stringify(record), "utf8") + (records.length === 0 ? 0 : 1);
						if (bytes + added > MAX_PARSED_SEARCH_BYTES) {
							if (records.length === 0) refuse();
							more = true;
							break;
						}
						records.push(record);
						bytes += added;
					}
				}
				cursor = next;
				more = true;
			}
			const after = this.#context(scope, sql, account);
			if (
				after.ownerId !== context.ownerId ||
				after.accountDigest !== context.accountDigest ||
				after.checkpoint.cursor !== context.checkpoint.cursor ||
				after.checkpoint.revision !== context.checkpoint.revision
			)
				refuse();
			const result: NativeParsedSearchPage = Object.freeze({
				account,
				query: phrase,
				checkpoint: Object.freeze({ ...after.checkpoint }),
				records: Object.freeze(records),
				nextAfterId: more ? cursor : null,
				scanned,
				coverage,
			});
			if (Buffer.byteLength(JSON.stringify(result), "utf8") > MAX_PARSED_SEARCH_BYTES) refuse();
			return result;
		});
	}
	cleanup(
		scope: WorkScope,
		input: MetadataAccountRef,
		afterId: string | null = null,
		limit: number = PARSED_CLEANUP_LIMIT,
	): ParsedCleanupProgress {
		return this.#work(scope, (sql) => {
			const account = ref(input),
				context = this.#context(scope, sql, account),
				count = integer(limit, 1, PARSED_CLEANUP_LIMIT);
			const rows = sql.all<{
				messageId: string;
				metadataDigest: string;
				accountDigest: string;
				rawValid: number;
			}>(
				`SELECT p.message_id AS messageId,p.metadata_digest AS metadataDigest,p.account_digest AS accountDigest,
 EXISTS(SELECT 1 FROM main.rawcontent_objects r WHERE r.id=p.raw_ref AND r.account_id=p.account_id AND r.generation=p.generation AND r.user_id=p.user_id
 AND r.plugin_instance_id=p.plugin_instance_id AND r.mode=p.mode AND r.state='committed' AND r.byte_count=p.raw_bytes AND r.sha256=p.raw_sha256) AS rawValid
 FROM main.content_parsed_messages p WHERE p.account_id=? AND p.generation=? AND p.user_id=? AND p.message_id>? ORDER BY p.message_id LIMIT ?`,
				[
					account.accountId,
					account.generation,
					context.ownerId,
					afterId === null ? "" : id(afterId),
					count + 1,
				],
			);
			const page = rows.slice(0, count);
			let deleted = 0;
			for (const row of page) {
				const message = this.#message(sql, account, context.ownerId, id(row.messageId));
				if (
					!message ||
					row.rawValid !== 1 ||
					row.accountDigest !== context.accountDigest ||
					row.metadataDigest !== digest(JSON.stringify(message))
				)
					deleted += sql.run(
						"DELETE FROM main.content_parsed_messages WHERE message_id=? AND account_id=? AND generation=? AND user_id=?",
						[row.messageId, account.accountId, account.generation, context.ownerId],
					).changes;
			}
			return Object.freeze({
				deleted,
				nextId: page.length ? (page[page.length - 1]?.messageId ?? null) : null,
				more: rows.length > count,
			});
		});
	}
}
