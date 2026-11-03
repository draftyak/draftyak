import { types } from "node:util";
import { Account } from "@draftyak/protocol/entities/account";
import { AuditChain } from "../audit/chain.ts";
import { EventLog } from "../events/log.ts";
import { WorkDatabase, type WorkScope } from "../jobs/database.ts";
import { fields, id, integer } from "../jobs/values.ts";
import { newId } from "../kernel/ids.ts";
import type { SqlTransaction } from "../store/store.ts";

export interface AccountRecord {
	readonly account: Account;
	readonly generation: number;
}
export interface AccountPage {
	readonly accounts: readonly AccountRecord[];
	readonly nextId: string | null;
}
export class AccountError extends Error {
	readonly code = "ACCOUNT_UNAVAILABLE";
	constructor() {
		super("Account unavailable");
		this.name = "AccountError";
	}
}
const unavailable = (): AccountError => new AccountError();
const sqlFor = WorkDatabase.prototype.sql;
const abort = WorkDatabase.prototype.abort;
const appendEvent = EventLog.prototype.append;
const appendAudit = AuditChain.prototype.append;
const verifyAudit = AuditChain.prototype.verify;
const COMMON = [
	"id",
	"userId",
	"alias",
	"mode",
	"status",
	"deletionDeadline",
	"historyLimitDays",
	"disclosureVersion",
	"createdAt",
	"channel",
	"pluginInstanceId",
];
const MAX_BYTES = 8192;
const PAGE_SIZE = 100;
interface Row {
	readonly valid: number;
	readonly id: string;
	readonly userId: string;
	readonly pluginInstanceId: string;
	readonly generation: number;
	readonly json: string | null;
}
// Never return unbounded stored text to JavaScript, including corrupt rows.
const ROW = `SELECT
 CASE WHEN typeof(id)='text' AND length(CAST(id AS BLOB))=26
  AND typeof(user_id)='text' AND length(CAST(user_id AS BLOB))=26
  AND typeof(plugin_instance_id)='text' AND length(CAST(plugin_instance_id AS BLOB))=26
  AND typeof(generation)='integer' AND generation BETWEEN 1 AND 9007199254740991
  AND (account_json IS NULL OR (typeof(account_json)='text' AND length(CAST(account_json AS BLOB)) BETWEEN 2 AND 8192))
 THEN 1 ELSE 0 END AS valid,
 CASE WHEN typeof(id)='text' AND length(CAST(id AS BLOB))=26 THEN id END AS id,
 CASE WHEN typeof(user_id)='text' AND length(CAST(user_id AS BLOB))=26 THEN user_id END AS userId,
 CASE WHEN typeof(plugin_instance_id)='text' AND length(CAST(plugin_instance_id AS BLOB))=26 THEN plugin_instance_id END AS pluginInstanceId,
 CASE WHEN typeof(generation)='integer' AND generation BETWEEN 1 AND 9007199254740991 THEN generation END AS generation,
 CASE WHEN account_json IS NULL OR (typeof(account_json)='text' AND length(CAST(account_json AS BLOB)) BETWEEN 2 AND 8192) THEN account_json END AS json
 FROM main.accounts`;

function account(raw: Account): Account {
	if (!raw || typeof raw !== "object" || types.isProxy(raw)) throw unavailable();
	const channel = Object.getOwnPropertyDescriptor(raw, "channel");
	if (!channel || !("value" in channel)) throw unavailable();
	const extra = channel.value === "email" ? ["address"] : ["teamId", "selfUserId"];
	const copy = fields(raw, [...COMMON, ...extra]);
	const parsed = Account.parse(copy);
	if (Buffer.byteLength(JSON.stringify(parsed)) > MAX_BYTES) throw unavailable();
	return Object.freeze(parsed);
}
function checked(raw: Row): Row {
	if (raw.valid !== 1) throw unavailable();
	id(raw.id);
	id(raw.userId);
	id(raw.pluginInstanceId);
	integer(raw.generation, 1);
	return raw;
}
function snapshot(raw: Row): AccountRecord {
	const row = checked(raw);
	if (row.json === null) throw unavailable();
	const value = account(JSON.parse(row.json));
	if (
		value.id !== row.id ||
		value.userId !== row.userId ||
		value.pluginInstanceId !== row.pluginInstanceId
	)
		throw unavailable();
	return Object.freeze({ account: value, generation: row.generation });
}
function read(sql: SqlTransaction, userId: string, accountId: string): Row | undefined {
	const row = sql.get<Row>(`${ROW} WHERE user_id=? AND id=?`, [id(userId), id(accountId)]);
	return row === undefined ? undefined : checked(row);
}

/** Native records only. Metadata, generations and notifications never authorize a credential or send. */
export class NativeAccounts {
	readonly #database: WorkDatabase;
	readonly #events: EventLog;
	readonly #audit: AuditChain;
	readonly #now: () => number;
	constructor(database: WorkDatabase, events: EventLog, audit: AuditChain, now: () => number) {
		if (typeof now !== "function" || types.isProxy(now)) throw unavailable();
		this.#database = database;
		this.#events = events;
		this.#audit = audit;
		this.#now = now;
	}
	#mutate<T>(scope: WorkScope, work: (sql: SqlTransaction) => T): T {
		try {
			const sql = sqlFor.call(this.#database, scope);
			verifyAudit.call(this.#audit, sql);
			return work(sql);
		} catch {
			try {
				abort.call(this.#database, scope);
			} catch {
				/* Retired or foreign scopes stay refused. */
			}
			throw unavailable();
		}
	}
	#changed(scope: WorkScope, sql: SqlTransaction, value: Account, action: string): void {
		const at = integer(this.#now());
		appendAudit.call(this.#audit, sql, {
			id: newId(),
			at,
			action,
			actor: { kind: "hub", id: null },
			refs: { account: value.id, user: value.userId, pluginInstance: value.pluginInstanceId },
		});
		appendEvent.call(this.#events, scope, {
			userId: value.userId,
			accountId: value.id,
			dataClass: value.channel === "email" ? "gmail.metadata" : "slack.metadata",
			kind: "accounts.changed",
			ids: [value.id],
		});
	}
	create(scope: WorkScope, raw: Account): AccountRecord {
		return this.#mutate(scope, (sql) => {
			const value = account(raw);
			sql.run(
				"INSERT INTO main.accounts(id,user_id,plugin_instance_id,generation,account_json) VALUES(?,?,?,1,?)",
				[value.id, value.userId, value.pluginInstanceId, JSON.stringify(value)],
			);
			this.#changed(scope, sql, value, "account.created");
			return Object.freeze({ account: value, generation: 1 });
		});
	}
	get(scope: WorkScope, userId: string, accountId: string): AccountRecord | undefined {
		try {
			const row = read(sqlFor.call(this.#database, scope), userId, accountId);
			return !row || row.json === null ? undefined : snapshot(row);
		} catch {
			throw unavailable();
		}
	}
	hasLiveAccounts(scope: WorkScope, pluginInstanceId: string): boolean {
		try {
			const sql = sqlFor.call(this.#database, scope);
			return (
				sql.get(
					"SELECT 1 FROM main.accounts WHERE plugin_instance_id=? AND account_json IS NOT NULL LIMIT 1",
					[id(pluginInstanceId)],
				) !== undefined
			);
		} catch {
			throw unavailable();
		}
	}
	page(scope: WorkScope, userId: string, afterId: string | null = null): AccountPage {
		try {
			const sql = sqlFor.call(this.#database, scope);
			const rows = sql.all<Row>(
				`${ROW} WHERE user_id=? AND id>? AND account_json IS NOT NULL ORDER BY id LIMIT ?`,
				[id(userId), afterId === null ? "" : id(afterId), PAGE_SIZE + 1],
			);
			const records = rows.map(snapshot);
			const accounts = Object.freeze(records.slice(0, PAGE_SIZE));
			return Object.freeze({
				accounts,
				nextId: rows.length > PAGE_SIZE ? (accounts.at(-1)?.account.id ?? null) : null,
			});
		} catch {
			throw unavailable();
		}
	}
	replace(scope: WorkScope, raw: Account, generation: number): AccountRecord {
		return this.#mutate(scope, (sql) => {
			const value = account(raw);
			const row = read(sql, value.userId, value.id);
			if (!row || row.json === null || row.generation !== integer(generation, 1))
				throw unavailable();
			const previous = snapshot(row).account;
			if (
				previous.pluginInstanceId !== value.pluginInstanceId ||
				previous.channel !== value.channel ||
				previous.createdAt !== value.createdAt ||
				(previous.status === "disconnecting" && value.status !== "disconnecting")
			)
				throw unavailable();
			if (
				previous.channel === "email" &&
				value.channel === "email" &&
				previous.address !== value.address
			)
				throw unavailable();
			if (
				previous.channel === "chat" &&
				value.channel === "chat" &&
				(previous.teamId !== value.teamId || previous.selfUserId !== value.selfUserId)
			)
				throw unavailable();
			const next = integer(generation + 1, 1);
			if (
				sql.run(
					"UPDATE main.accounts SET generation=?,account_json=? WHERE id=? AND user_id=? AND generation=? AND account_json IS NOT NULL",
					[next, JSON.stringify(value), value.id, value.userId, generation],
				).changes !== 1
			)
				throw unavailable();
			this.#changed(scope, sql, value, "account.changed");
			return Object.freeze({ account: value, generation: next });
		});
	}
	/** The owning purge transaction removes credentials/content first; IDs remain to fence stale creates. */
	retire(scope: WorkScope, userId: string, accountId: string, generation: number): void {
		this.#mutate(scope, (sql) => {
			const row = read(sql, userId, accountId);
			if (!row || row.json === null || row.generation !== integer(generation, 1))
				throw unavailable();
			const value = snapshot(row).account;
			if (value.status !== "disconnecting") throw unavailable();
			if (
				sql.run(
					"UPDATE main.accounts SET generation=?,account_json=NULL WHERE id=? AND user_id=? AND generation=?",
					[integer(generation + 1, 1), accountId, userId, generation],
				).changes !== 1
			)
				throw unavailable();
			this.#changed(scope, sql, value, "account.retired");
		});
	}
}
