import { Buffer } from "node:buffer";
import { WorkDatabase, type WorkScope } from "../jobs/database.ts";
import { fields, id, integer } from "../jobs/values.ts";
import { type MetadataAccountRef, type MetadataCheckpoint, NativeMetadataStore } from "./apply.ts";
import { type NativeParsedRecord, NativeParsedStore } from "./parsed.ts";

export const MAX_THREAD_PROJECTION_BYTES = 4_194_304;
export const MAX_THREAD_PROJECTION_ROWS = 100;
export const MAX_THREAD_PROJECTION_SCANS = 100;

export interface NativeThreadProjection {
	readonly account: MetadataAccountRef;
	readonly threadId: string;
	readonly checkpoint: MetadataCheckpoint;
	readonly messages: readonly NativeParsedRecord[];
	readonly nextAfterId: string | null;
	readonly coverage: {
		readonly state: "unknown";
		readonly reason: "provider-history-unproven";
	};
}

export class NativeThreadError extends Error {
	readonly code = "THREAD_UNAVAILABLE";
	constructor() {
		super("Thread projection unavailable");
		this.name = "NativeThreadError";
	}
}

const sqlFor = WorkDatabase.prototype.sql;
const abort = WorkDatabase.prototype.abort;
const checkpointFor = NativeMetadataStore.prototype.checkpoint;
const parsedForThread = NativeParsedStore.prototype.forThread;
const REF_FIELDS = ["accountId", "generation", "pluginInstanceId", "ownerEpoch", "mode"];

function reference(input: MetadataAccountRef): MetadataAccountRef {
	const value = fields(input, REF_FIELDS);
	if (value.mode !== "full" && value.mode !== "read_only") throw new NativeThreadError();
	return Object.freeze({
		accountId: id(value.accountId),
		generation: integer(value.generation, 1),
		pluginInstanceId: id(value.pluginInstanceId),
		ownerEpoch: integer(value.ownerEpoch),
		mode: value.mode,
	});
}

export class NativeThreadReader {
	readonly #database: WorkDatabase;
	readonly #metadata: NativeMetadataStore;
	readonly #parsed: NativeParsedStore;

	constructor(database: WorkDatabase, metadata: NativeMetadataStore, parsed: NativeParsedStore) {
		this.#database = database;
		this.#metadata = metadata;
		this.#parsed = parsed;
	}

	read(
		scope: WorkScope,
		input: MetadataAccountRef,
		thread: string,
		afterId: string | null = null,
		limit: number = MAX_THREAD_PROJECTION_ROWS,
	): NativeThreadProjection {
		try {
			sqlFor.call(this.#database, scope);
			const account = reference(input);
			if (
				typeof thread !== "string" ||
				thread.length === 0 ||
				thread.length > 256 ||
				!/^[!-~]+$/.test(thread)
			)
				throw new NativeThreadError();
			// Provider keys are bounded before JSON materialization; they are not
			// local message ULIDs. The original store rechecks the same key bounds.
			const threadId = thread;
			const maximum = integer(limit, 1, MAX_THREAD_PROJECTION_ROWS);
			let cursor = afterId === null ? null : id(afterId);
			const before = checkpointFor.call(this.#metadata, scope, account);
			const coverage: NativeThreadProjection["coverage"] = Object.freeze({
				state: "unknown",
				reason: "provider-history-unproven",
			});
			const messages: NativeParsedRecord[] = [];
			// Reserve the complete envelope, including the largest local-ID cursor.
			// The final null cursor is smaller; record bytes and array commas follow.
			let bytes = Buffer.byteLength(
				JSON.stringify({
					account,
					threadId,
					checkpoint: before,
					messages: [],
					nextAfterId: "00000000000000000000000000",
					coverage,
				}),
				"utf8",
			);
			if (bytes > MAX_THREAD_PROJECTION_BYTES) throw new NativeThreadError();
			let more = false;
			let scanned = 0;
			while (messages.length < maximum && scanned < MAX_THREAD_PROJECTION_SCANS) {
				// Decode one bounded stored record at a time. A page does not first
				// materialize an arbitrarily large collection of parsed bodies.
				const page = parsedForThread.call(this.#parsed, scope, account, threadId, cursor, 1);
				if (page.scanned === 0) {
					if (page.records.length !== 0 || page.nextAfterId !== null) throw new NativeThreadError();
					break;
				}
				if (page.scanned !== 1 || page.records.length > 1 || page.nextAfterId === null)
					throw new NativeThreadError();
				const next = id(page.nextAfterId);
				if (cursor !== null && next <= cursor) throw new NativeThreadError();
				if (page.records.length === 1) {
					const row = page.records[0];
					if (
						!row ||
						row.threadId !== threadId ||
						row.association !== "unverified" ||
						row.messageId !== next
					)
						throw new NativeThreadError();
					const size = Buffer.byteLength(JSON.stringify(row), "utf8");
					if (size > MAX_THREAD_PROJECTION_BYTES) throw new NativeThreadError();
					const added = size + (messages.length === 0 ? 0 : 1);
					if (bytes + added > MAX_THREAD_PROJECTION_BYTES) {
						if (messages.length === 0) throw new NativeThreadError();
						more = true;
						break;
					}
					messages.push(row);
					bytes += added;
				}
				cursor = next;
				scanned++;
			}
			if (messages.length === maximum || scanned === MAX_THREAD_PROJECTION_SCANS) more = true;
			const after = checkpointFor.call(this.#metadata, scope, account);
			if (before.cursor !== after.cursor || before.revision !== after.revision)
				throw new NativeThreadError();
			return Object.freeze({
				account,
				threadId,
				checkpoint: Object.freeze({ cursor: after.cursor, revision: after.revision }),
				messages: Object.freeze(messages),
				nextAfterId: more ? cursor : null,
				// Exhausting this stored projection never proves a provider's complete
				// history, a known-empty thread or an authenticated message/raw relation.
				coverage,
			});
		} catch {
			try {
				abort.call(this.#database, scope);
			} catch {
				// A foreign or retired original scope remains refused.
			}
			throw new NativeThreadError();
		}
	}
}
