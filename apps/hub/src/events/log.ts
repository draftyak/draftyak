import { fileURLToPath } from "node:url";
import { types } from "node:util";
import { DataClass } from "@draftyak/protocol/data-class";
import type { WorkDatabase, WorkScope } from "../jobs/database.ts";
import { fields, id, integer, WorkError } from "../jobs/values.ts";
import type { SqlTransaction } from "../store/store.ts";

export const EVENT_MIGRATIONS: string = fileURLToPath(
	new URL("./events-migrations/", import.meta.url),
);
export const EVENT_RETENTION_MS: number = 7 * 24 * 60 * 60_000;
export const EVENT_PAGE_SIZE: number = 100;
export const EVENT_KINDS = [
	"accounts.changed",
	"drafts.changed",
	"jobs.changed",
	"messages.changed",
	"outbox.changed",
	"policies.changed",
	"settings.changed",
	"threads.changed",
	"plugins.changed",
	"devices.changed",
	"tools.changed",
] as const;
Object.freeze(EVENT_KINDS);
export type EventKind = (typeof EVENT_KINDS)[number];
const kinds = new Set<string>(EVENT_KINDS);
export interface EventInput {
	readonly userId: string;
	readonly accountId: string | null;
	readonly dataClass: DataClass;
	readonly kind: EventKind;
	readonly ids: readonly string[];
}
export interface EventRecord extends EventInput {
	readonly seq: number;
	readonly at: number;
}
export interface EventPageInput {
	readonly userId: string;
	readonly afterSeq: number;
	readonly limit?: number;
}
export interface EventPage {
	readonly events: readonly EventRecord[];
	readonly lastSeq: number;
	readonly floorSeq: number;
	readonly nextSeq: number;
	readonly more: boolean;
	readonly resyncRequired: boolean;
}
export interface EventPurgeProgress {
	readonly deleted: number;
	readonly more: boolean;
}
interface Head {
	last_seq: number | null;
	floor_seq: number | null;
}
interface Row {
	valid: number;
	seq: number;
	user_id: string;
	account_id: string | null;
	data_class: string;
	kind: string;
	ids: string;
	at: number;
}
const HEAD = `SELECT
 CASE WHEN typeof(last_seq)='integer' AND last_seq BETWEEN 0 AND 9007199254740991 THEN last_seq ELSE NULL END AS last_seq,
 CASE WHEN typeof(floor_seq)='integer' AND floor_seq BETWEEN 0 AND last_seq THEN floor_seq ELSE NULL END AS floor_seq
 FROM main.event_meta WHERE singleton=1`;
// Bound every stored variable-width value before it enters JavaScript.
const ROWS = `SELECT
 CASE WHEN typeof(seq)='integer' AND seq BETWEEN 1 AND 9007199254740991
  AND typeof(user_id)='text' AND length(CAST(user_id AS BLOB))=26
  AND (account_id IS NULL OR (typeof(account_id)='text' AND length(CAST(account_id AS BLOB))=26))
  AND typeof(data_class)='text' AND length(CAST(data_class AS BLOB)) BETWEEN 1 AND 64
  AND typeof(kind)='text' AND length(CAST(kind AS BLOB)) BETWEEN 1 AND 64
  AND typeof(ids)='text' AND length(CAST(ids AS BLOB)) BETWEEN 2 AND 4096
  AND typeof(at)='integer' AND at BETWEEN 0 AND 9007199254740991 THEN 1 ELSE 0 END AS valid,
 CASE WHEN typeof(seq)='integer' AND seq BETWEEN 1 AND 9007199254740991 THEN seq ELSE NULL END AS seq,
 CASE WHEN typeof(user_id)='text' AND length(CAST(user_id AS BLOB))=26 THEN user_id ELSE NULL END AS user_id,
 CASE WHEN typeof(account_id)='text' AND length(CAST(account_id AS BLOB))=26 THEN account_id ELSE NULL END AS account_id,
 CASE WHEN typeof(data_class)='text' AND length(CAST(data_class AS BLOB)) BETWEEN 1 AND 64 THEN data_class ELSE NULL END AS data_class,
 CASE WHEN typeof(kind)='text' AND length(CAST(kind AS BLOB)) BETWEEN 1 AND 64 THEN kind ELSE NULL END AS kind,
 CASE WHEN typeof(ids)='text' AND length(CAST(ids AS BLOB)) BETWEEN 2 AND 4096 THEN ids ELSE NULL END AS ids,
 CASE WHEN typeof(at)='integer' AND at BETWEEN 0 AND 9007199254740991 THEN at ELSE NULL END AS at
 FROM main.events`;

function ids(raw: unknown): readonly string[] {
	if (types.isProxy(raw) || !Array.isArray(raw) || Object.getPrototypeOf(raw) !== Array.prototype)
		throw new WorkError("input");
	const length = Object.getOwnPropertyDescriptor(raw, "length")?.value;
	integer(length, 0, EVENT_PAGE_SIZE);
	if (Reflect.ownKeys(raw).length !== length + 1) throw new WorkError("input");
	const copy: string[] = [];
	for (let index = 0; index < length; index++) {
		const descriptor = Object.getOwnPropertyDescriptor(raw, String(index));
		if (!descriptor?.enumerable || !("value" in descriptor)) throw new WorkError("input");
		copy.push(id(descriptor.value));
	}
	if (new Set(copy).size !== copy.length) throw new WorkError("input");
	return Object.freeze(copy);
}

function input(raw: unknown): EventInput {
	const row = fields(raw, ["userId", "accountId", "dataClass", "kind", "ids"]);
	if (
		typeof row.dataClass !== "string" ||
		row.dataClass.length > 64 ||
		/[\0\r\n]/.test(row.dataClass) ||
		!DataClass.safeParse(row.dataClass).success ||
		typeof row.kind !== "string" ||
		!kinds.has(row.kind)
	)
		throw new WorkError("input");
	return Object.freeze({
		userId: id(row.userId),
		accountId: row.accountId === null ? null : id(row.accountId),
		dataClass: row.dataClass as DataClass,
		kind: row.kind as EventKind,
		ids: ids(row.ids),
	});
}

function head(sql: SqlTransaction): { lastSeq: number; floorSeq: number } {
	const row = sql.get<Head>(HEAD);
	if (!row || row.last_seq === null || row.floor_seq === null) throw new WorkError("data");
	return { lastSeq: row.last_seq, floorSeq: row.floor_seq };
}

function record(row: Row): EventRecord {
	try {
		if (row.valid !== 1) throw new WorkError("data");
		const data = input({
			userId: row.user_id,
			accountId: row.account_id,
			dataClass: row.data_class,
			kind: row.kind,
			ids: JSON.parse(row.ids),
		});
		if (JSON.stringify(data.ids) !== row.ids) throw new WorkError("data");
		return Object.freeze({ ...data, seq: integer(row.seq, 1), at: integer(row.at) });
	} catch {
		throw new WorkError("data");
	}
}

/** Native ID-only invalidations. The transport owns authentication and data-class authorization. */
export class EventLog {
	readonly #database: WorkDatabase;
	readonly #now: () => number;
	constructor(database: WorkDatabase, now: () => number) {
		if (typeof now !== "function" || types.isProxy(now)) throw new WorkError("input");
		this.#database = database;
		this.#now = now;
	}

	append(scope: WorkScope, raw: EventInput): EventRecord {
		return this.#mutate(scope, () => this.#append(scope, raw));
	}

	#mutate<T>(scope: WorkScope, work: () => T): T {
		try {
			return work();
		} catch (error) {
			this.#database.abort(scope);
			throw error;
		}
	}

	#append(scope: WorkScope, raw: EventInput): EventRecord {
		const data = input(raw);
		const at = integer(this.#now());
		const sql = this.#database.sql(scope);
		const { lastSeq } = head(sql);
		if (lastSeq === Number.MAX_SAFE_INTEGER) throw new WorkError("data");
		const seq = lastSeq + 1;
		if (
			sql.run("UPDATE main.event_meta SET last_seq=? WHERE singleton=1 AND last_seq=?", [
				seq,
				lastSeq,
			]).changes !== 1
		)
			throw new WorkError("data");
		sql.run(
			"INSERT INTO main.events(seq,user_id,account_id,data_class,kind,ids,at) VALUES (?,?,?,?,?,?,?)",
			[seq, data.userId, data.accountId, data.dataClass, data.kind, JSON.stringify(data.ids), at],
		);
		return Object.freeze({ ...data, seq, at });
	}

	page(scope: WorkScope, raw: EventPageInput): EventPage {
		const values = fields(raw, ["userId", "afterSeq"], ["limit"]);
		const userId = id(values.userId);
		const afterSeq = integer(values.afterSeq);
		const limit = Object.hasOwn(values, "limit")
			? integer(values.limit, 1, EVENT_PAGE_SIZE)
			: EVENT_PAGE_SIZE;
		const sql = this.#database.sql(scope);
		const { lastSeq, floorSeq } = head(sql);
		if (afterSeq > lastSeq) throw new WorkError("input");
		if (afterSeq < floorSeq)
			return Object.freeze({
				events: Object.freeze([]),
				lastSeq,
				floorSeq,
				nextSeq: lastSeq,
				more: false,
				resyncRequired: true,
			});
		const rows = sql.all<Row>(`${ROWS} WHERE user_id=? AND seq>? ORDER BY seq LIMIT ?`, [
			userId,
			afterSeq,
			limit + 1,
		]);
		// Validate the lookahead too: malformed metadata never yields a partial successful page.
		const all = rows.map(record);
		if (all.some((row) => row.seq > lastSeq)) throw new WorkError("data");
		const more = all.length > limit;
		const events = Object.freeze(all.slice(0, limit));
		return Object.freeze({
			events,
			lastSeq,
			floorSeq,
			nextSeq: more ? (events.at(-1)?.seq ?? afterSeq) : lastSeq,
			more,
			resyncRequired: false,
		});
	}

	purge(scope: WorkScope): EventPurgeProgress {
		return this.#mutate(scope, () => this.#purge(scope));
	}

	#purge(scope: WorkScope): EventPurgeProgress {
		const now = integer(this.#now());
		const sql = this.#database.sql(scope);
		const { lastSeq, floorSeq } = head(sql);
		const target = sql.get<{ seq: number | null }>(
			"SELECT max(seq) AS seq FROM main.events WHERE at < ?",
			[now - EVENT_RETENTION_MS],
		)?.seq;
		if (target === null || target === undefined) return Object.freeze({ deleted: 0, more: false });
		integer(target, floorSeq + 1, lastSeq);
		const rows = sql.all<{ seq: number }>(
			"SELECT seq FROM main.events WHERE seq<=? ORDER BY seq LIMIT ?",
			[target, EVENT_PAGE_SIZE],
		);
		const through = rows.at(-1)?.seq;
		if (through === undefined) throw new WorkError("data");
		integer(through, floorSeq + 1, target);
		if (sql.run("DELETE FROM main.events WHERE seq<=?", [through]).changes !== rows.length)
			throw new WorkError("data");
		if (
			sql.run("UPDATE main.event_meta SET floor_seq=? WHERE singleton=1 AND floor_seq=?", [
				through,
				floorSeq,
			]).changes !== 1
		)
			throw new WorkError("data");
		return Object.freeze({
			deleted: rows.length,
			more: sql.get("SELECT 1 FROM main.events WHERE seq<=? LIMIT 1", [target]) !== undefined,
		});
	}
}
