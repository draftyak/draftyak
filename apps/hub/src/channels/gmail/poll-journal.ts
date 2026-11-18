/** Ordinary SQL DATA I/O; this structural port is not a native participant. */
export type GmailPollJournalSqlValue = string | number | bigint | Uint8Array | null;

export interface GmailPollJournalSql {
	get(sql: string, bindings?: readonly GmailPollJournalSqlValue[]): unknown;
	run(sql: string, bindings?: readonly GmailPollJournalSqlValue[]): Readonly<{ changes: number }>;
}

/** Correlation DATA only. The caller must check the actual current account. */
export interface GmailPollJournalKey {
	readonly accountId: string;
	readonly generation: number;
	readonly pluginInstanceId: string;
	readonly ownerEpoch: number;
	readonly mode: "full" | "read_only";
}

export interface GmailPollJournalRecord {
	readonly formatVersion: 1;
	readonly key: Readonly<GmailPollJournalKey>;
	readonly revision: number;
	readonly payload: string;
}

export type GmailPollJournalWriteResult =
	| Readonly<{ kind: "written"; revision: number }>
	| Readonly<{ kind: "conflict" }>;

export type GmailPollJournalErrorCode = "invalid-row" | "sql-failure" | "invalid-result";

export class GmailPollJournalError extends Error {
	override readonly name: string = "GmailPollJournalError";
	readonly code: GmailPollJournalErrorCode;

	constructor(code: GmailPollJournalErrorCode) {
		super("Gmail poll journal operation failed");
		this.code = code;
		Object.freeze(this);
	}
}

const MAX_KEY_BYTES = 256;
const MAX_PAYLOAD_BYTES = 16_384;
const INVALID_INPUT = "Invalid Gmail poll journal input";
const keyFields = ["accountId", "generation", "pluginInstanceId", "ownerEpoch", "mode"];
const rowFields = [...keyFields, "formatVersion", "revision", "payload"];
const selectRow = `SELECT account_id AS accountId, generation,
 plugin_instance_id AS pluginInstanceId, owner_epoch AS ownerEpoch, mode,
 format_version AS formatVersion, revision, payload
 FROM main.gmail_poll_journal
 WHERE account_id = ? AND generation = ? AND plugin_instance_id = ?
 AND owner_epoch = ? AND mode = ?`;
const insertRow = `INSERT INTO main.gmail_poll_journal
 (account_id, generation, plugin_instance_id, owner_epoch, mode, format_version, revision, payload)
 VALUES (?, ?, ?, ?, ?, ?, ?, ?)
 ON CONFLICT (account_id, generation, plugin_instance_id, owner_epoch, mode) DO NOTHING`;
const updateRow = `UPDATE main.gmail_poll_journal SET revision = ?, payload = ?
 WHERE account_id = ? AND generation = ? AND plugin_instance_id = ?
 AND owner_epoch = ? AND mode = ? AND revision = ? AND format_version = ?`;

function invalid(): never {
	throw new TypeError(INVALID_INPUT);
}

function integer(value: unknown): number {
	if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) invalid();
	return value;
}

function record(value: unknown, fields: readonly string[]): Record<string, unknown> {
	if (typeof value !== "object" || value === null || Array.isArray(value)) invalid();
	const names = Reflect.ownKeys(value);
	if (names.length !== fields.length || fields.some((field) => !Object.hasOwn(value, field))) {
		invalid();
	}
	return value as Record<string, unknown>;
}

function text(value: unknown, maximum: number, key: boolean): string {
	if (
		typeof value !== "string" ||
		value.length < 1 ||
		value.length > maximum ||
		!value.isWellFormed() ||
		(key && value.includes("\0")) ||
		new TextEncoder().encode(value).byteLength > maximum
	) {
		invalid();
	}
	return value;
}

function key(value: unknown): Readonly<GmailPollJournalKey> {
	try {
		const input = record(value, keyFields);
		const accountId = text(input.accountId, MAX_KEY_BYTES, true);
		const generation = integer(input.generation);
		const pluginInstanceId = text(input.pluginInstanceId, MAX_KEY_BYTES, true);
		const ownerEpoch = integer(input.ownerEpoch);
		const mode = input.mode;
		if (mode !== "full" && mode !== "read_only") invalid();
		return Object.freeze({ accountId, generation, pluginInstanceId, ownerEpoch, mode });
	} catch {
		return invalid();
	}
}

function payload(value: unknown): string {
	try {
		return text(value, MAX_PAYLOAD_BYTES, false);
	} catch {
		return invalid();
	}
}

function bindings(value: GmailPollJournalKey): GmailPollJournalSqlValue[] {
	return [value.accountId, value.generation, value.pluginInstanceId, value.ownerEpoch, value.mode];
}

function get(sql: GmailPollJournalSql, values: readonly GmailPollJournalSqlValue[]): unknown {
	try {
		return sql.get(selectRow, values);
	} catch {
		throw new GmailPollJournalError("sql-failure");
	}
}

function run(
	sql: GmailPollJournalSql,
	query: string,
	values: readonly GmailPollJournalSqlValue[],
): number {
	let result: unknown;
	try {
		result = sql.run(query, values);
	} catch {
		throw new GmailPollJournalError("sql-failure");
	}
	try {
		if (typeof result !== "object" || result === null || !Object.hasOwn(result, "changes")) {
			throw new GmailPollJournalError("invalid-result");
		}
		const changes = (result as { changes: unknown }).changes;
		if (changes !== 0 && changes !== 1) throw new GmailPollJournalError("invalid-result");
		return changes;
	} catch {
		throw new GmailPollJournalError("invalid-result");
	}
}

function read(
	sql: GmailPollJournalSql,
	requested: GmailPollJournalKey,
): GmailPollJournalRecord | undefined {
	const raw = get(sql, bindings(requested));
	if (raw === undefined) return undefined;
	try {
		const value = record(raw, rowFields);
		const storedKey = key({
			accountId: value.accountId,
			generation: value.generation,
			pluginInstanceId: value.pluginInstanceId,
			ownerEpoch: value.ownerEpoch,
			mode: value.mode,
		});
		if (
			storedKey.accountId !== requested.accountId ||
			storedKey.generation !== requested.generation ||
			storedKey.pluginInstanceId !== requested.pluginInstanceId ||
			storedKey.ownerEpoch !== requested.ownerEpoch ||
			storedKey.mode !== requested.mode ||
			value.formatVersion !== 1
		) {
			throw new GmailPollJournalError("invalid-row");
		}
		return Object.freeze({
			formatVersion: 1,
			key: storedKey,
			revision: integer(value.revision),
			payload: payload(value.payload),
		});
	} catch {
		throw new GmailPollJournalError("invalid-row");
	}
}

function conflict(): GmailPollJournalWriteResult {
	return Object.freeze({ kind: "conflict" });
}

/**
 * Reads opaque storage DATA, not a validated polling snapshot. Before use, the
 * caller must canonical-decode payload and compare its embedded cadence revision
 * to this row's revision. No scope, transaction or native authority is retained.
 */
export function readGmailPollJournal(
	sql: GmailPollJournalSql,
	suppliedKey: GmailPollJournalKey,
): GmailPollJournalRecord | undefined {
	return read(sql, key(suppliedKey));
}

/** Runs synchronously inside the caller's existing outer SQL transaction. */
export function createGmailPollJournal(
	sql: GmailPollJournalSql,
	suppliedKey: GmailPollJournalKey,
	suppliedPayload: string,
): GmailPollJournalWriteResult {
	const requested = key(suppliedKey);
	const storedPayload = payload(suppliedPayload);
	const changes = run(sql, insertRow, [...bindings(requested), 1, 0, storedPayload]);
	if (changes === 0) {
		if (read(sql, requested) === undefined) throw new GmailPollJournalError("invalid-result");
		return conflict();
	}
	return Object.freeze({ kind: "written", revision: 0 });
}

/**
 * The caller owns commit/abort, currentness and budgets. A written result records
 * only this row CAS; it does not permit a poll or prove native nonoverlap.
 * SQL failures must propagate to the outer transaction's rollback path.
 */
export function compareAndSwapGmailPollJournal(
	sql: GmailPollJournalSql,
	suppliedKey: GmailPollJournalKey,
	expectedRevision: number,
	suppliedPayload: string,
): GmailPollJournalWriteResult {
	const requested = key(suppliedKey);
	const storedPayload = payload(suppliedPayload);
	const revision = integer(expectedRevision);
	if (revision === Number.MAX_SAFE_INTEGER) invalid();
	const nextRevision = revision + 1;
	if (read(sql, requested) === undefined) return conflict();
	const changes = run(sql, updateRow, [
		nextRevision,
		storedPayload,
		...bindings(requested),
		revision,
		1,
	]);
	return changes === 0 ? conflict() : Object.freeze({ kind: "written", revision: nextRevision });
}
