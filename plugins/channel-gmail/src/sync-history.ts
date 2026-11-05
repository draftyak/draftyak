import { createHash, randomBytes } from "node:crypto";
import { Cursor, channelV1, type SyncPage, type SyncRequest } from "@draftyak/protocol/channel-v1";
import { canonicalize } from "@draftyak/protocol/jcs";
import {
	type PluginChange as Change,
	MAX_CHANGES,
	PluginChange,
} from "@draftyak/protocol/normalized-change";
import { Base64Url } from "@draftyak/protocol/scalars";
import { type PluginContext, PluginError } from "@draftyak/sdk";
import { copyHistoryData, historyDecimal, historyRecord } from "./history/page.ts";
import { readHistoryPage } from "./history/read.ts";

type DeltaRequest = Extract<SyncRequest, { mode: "delta" }>;
interface Position {
	readonly start: string;
	readonly watermark?: string;
	readonly pageToken?: string;
}
interface SnapshotReference {
	readonly nonce: string;
	readonly digest: string;
	readonly offset: number;
}
interface RecordBody {
	readonly v: 1;
	readonly scope: string;
	readonly nonce: string;
	readonly input: string;
	readonly successor: string;
	readonly more: boolean;
	readonly count: number;
	readonly changesDigest: string;
}
interface RetainedRecord extends RecordBody {
	readonly digest: string;
}
interface Snapshot {
	readonly changes: readonly Change[];
	readonly count: number;
	readonly digest: string;
	readonly bytes: number;
}
const PREFIX = "gh1";
const MAX_TOKEN_BYTES = 2048;
const PAGE_CHANGES = 7;
const MAX_RECORD_BYTES = 8192;
const MAX_SNAPSHOT_BYTES = 4 * 1024 * 1024;
const snapshots = new Map<string, Snapshot>();
const recordKeys = [
	"v",
	"scope",
	"nonce",
	"input",
	"successor",
	"more",
	"count",
	"changesDigest",
	"digest",
];

function expired(): never {
	throw new PluginError("CURSOR_EXPIRED");
}
function live(context: PluginContext): void {
	if (context.signal.aborted) throw new PluginError("TRANSIENT");
}
function hash(domain: string, value: unknown): string {
	return createHash("sha256").update(domain).update("\0").update(canonicalize(value)).digest("hex");
}
function hex(value: unknown): string {
	if (typeof value !== "string" || !/^[0-9a-f]{64}$/.test(value)) expired();
	return value;
}
function nonce(value: unknown): string {
	const checked = Base64Url.safeParse(value);
	if (!checked.success || checked.data.length !== 43) expired();
	const bytes = Buffer.from(checked.data, "base64url");
	if (bytes.length !== 32 || bytes.toString("base64url") !== checked.data) expired();
	return checked.data;
}
function providerToken(value: string): string {
	if (!/^[!-~]+$/.test(value) || value.length > MAX_TOKEN_BYTES) expired();
	return value;
}
function position(historyId: string): string {
	return `${PREFIX}.p.${historyDecimal(historyId)}`;
}
function continuation(start: string, watermark: string, token: string): string {
	const encoded = Buffer.from(providerToken(token), "utf8").toString("base64url");
	const cursor = `${PREFIX}.c.${historyDecimal(start)}.${historyDecimal(watermark)}.${encoded}`;
	if (!Cursor.safeParse(cursor).success) expired();
	return cursor;
}
function plainCursor(value: string): Position {
	try {
		if (!Cursor.safeParse(value).success) expired();
		const parts = value.split(".");
		if (parts[0] !== PREFIX) expired();
		if (parts[1] === "p" && parts.length === 3) {
			const start = historyDecimal(parts[2]);
			if (position(start) !== value) expired();
			return Object.freeze({ start });
		}
		if (parts[1] !== "c" || parts.length !== 5) expired();
		const start = historyDecimal(parts[2]);
		const watermark = historyDecimal(parts[3]);
		if (BigInt(watermark) < BigInt(start)) expired();
		const parsed = Base64Url.safeParse(parts[4]);
		if (!parsed.success) expired();
		const bytes = Buffer.from(parsed.data, "base64url");
		if (bytes.length > MAX_TOKEN_BYTES || bytes.toString("base64url") !== parsed.data) expired();
		const pageToken = providerToken(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
		if (continuation(start, watermark, pageToken) !== value) expired();
		return Object.freeze({ start, watermark, pageToken });
	} catch {
		expired();
	}
}
function readCursor(value: string): Position | SnapshotReference {
	if (!value.startsWith(`${PREFIX}.s.`)) return plainCursor(value);
	try {
		if (!Cursor.safeParse(value).success) expired();
		const parts = value.split(".");
		if (parts.length !== 5 || !/^[1-9][0-9]{0,2}$/.test(parts[4] ?? "")) expired();
		const offset = Number(parts[4]);
		if (offset >= MAX_CHANGES || offset % PAGE_CHANGES !== 0) expired();
		return Object.freeze({ nonce: nonce(parts[2]), digest: hex(parts[3]), offset });
	} catch {
		expired();
	}
}
function requestCursor(request: DeltaRequest): string {
	let settings: Record<string, unknown>;
	try {
		settings = historyRecord(copyHistoryData(request), ["mode", "cursor"]);
		if (settings.mode !== "delta" || typeof settings.cursor !== "string")
			throw new PluginError("INVALID_INPUT");
	} catch {
		throw new PluginError("INVALID_INPUT");
	}
	if (!Cursor.safeParse(settings.cursor).success) expired();
	const parsed = channelV1.tools.channel_sync.input.safeParse(settings);
	if (!parsed.success || parsed.data.mode !== "delta") throw new PluginError("INVALID_INPUT");
	return parsed.data.cursor;
}
function scope(context: PluginContext): string {
	const plugin = context.plugin,
		account = context.account ?? null;
	if (
		typeof plugin !== "string" ||
		plugin.length > 214 ||
		!/^[!-~]+$/.test(plugin) ||
		(account !== null &&
			(typeof account !== "string" || account.length > 256 || !/^[!-~]+$/.test(account)))
	)
		expired();
	// This namespaces untrusted DATA, not native account or instance authority.
	return hash("DraftYak Gmail history cache scope v1", { plugin, account });
}
function slot(): string {
	return "gh1.snapshot.v1";
}
function recordDigest(value: RecordBody): string {
	return hash("DraftYak Gmail retained history v1", value);
}
function makeRecord(body: RecordBody): RetainedRecord {
	const value = Object.freeze({ ...body, digest: recordDigest(body) });
	if (Buffer.byteLength(canonicalize(value)) > MAX_RECORD_BYTES) expired();
	return value;
}
function parseRecord(
	raw: unknown,
	cacheScope: string,
	reference: SnapshotReference,
): RetainedRecord {
	try {
		const data = historyRecord(copyHistoryData(raw), recordKeys);
		if (
			Object.keys(data).length !== recordKeys.length ||
			data.v !== 1 ||
			data.scope !== cacheScope ||
			typeof data.input !== "string" ||
			typeof data.successor !== "string" ||
			typeof data.more !== "boolean" ||
			typeof data.count !== "number" ||
			!Number.isInteger(data.count) ||
			data.count <= PAGE_CHANGES ||
			data.count > MAX_CHANGES
		)
			expired();
		const input = plainCursor(data.input),
			successor = plainCursor(data.successor);
		if (
			data.more
				? successor.pageToken === undefined || successor.start !== input.start
				: successor.pageToken !== undefined
		)
			expired();
		const finalWatermark = data.more ? successor.watermark : successor.start;
		if (
			finalWatermark === undefined ||
			BigInt(finalWatermark) < BigInt(input.start) ||
			(input.watermark !== undefined && BigInt(finalWatermark) > BigInt(input.watermark))
		)
			expired();
		const body: RecordBody = {
			v: 1,
			scope: cacheScope,
			nonce: nonce(data.nonce),
			input: data.input,
			successor: data.successor,
			more: data.more,
			count: data.count,
			changesDigest: hex(data.changesDigest),
		};
		const record = makeRecord(body);
		if (
			hex(data.digest) !== record.digest ||
			record.nonce !== reference.nonce ||
			record.digest !== reference.digest ||
			reference.offset >= record.count
		)
			expired();
		return record;
	} catch {
		expired();
	}
}
async function currentRecord(
	context: PluginContext,
	cacheScope: string,
	reference: SnapshotReference,
): Promise<RetainedRecord> {
	live(context);
	const raw = await context.kv.get(slot());
	live(context);
	return parseRecord(raw, cacheScope, reference);
}
function freezeData<T>(value: T): T {
	if (value && typeof value === "object") {
		for (const child of Object.values(value)) freezeData(child);
		Object.freeze(value);
	}
	return value;
}
function captureChanges(input: readonly Change[]): Snapshot {
	try {
		const copied = copyHistoryData(input);
		if (!Array.isArray(copied) || copied.length > MAX_CHANGES) expired();
		const changes: Change[] = copied.map((value) => {
			const parsed = PluginChange.safeParse(value);
			if (!parsed.success) expired();
			return freezeData(parsed.data);
		});
		const text = canonicalize(changes),
			bytes = Buffer.byteLength(text);
		if (bytes > MAX_SNAPSHOT_BYTES) expired();
		return Object.freeze({
			changes: Object.freeze(changes),
			count: changes.length,
			digest: hash("DraftYak Gmail normalized changes v1", changes),
			bytes,
		});
	} catch {
		expired();
	}
}
function memoryKey(record: RetainedRecord): string {
	return `${record.scope}:${record.nonce}:${record.digest}`;
}
function remember(record: RetainedRecord, snapshot: Snapshot): void {
	const key = memoryKey(record);
	snapshots.delete(key);
	snapshots.set(key, snapshot);
	while (snapshots.size > 2) {
		const oldest = snapshots.keys().next().value;
		if (oldest === undefined) break;
		snapshots.delete(oldest);
	}
}
function remembered(record: RetainedRecord): Snapshot | undefined {
	const value = snapshots.get(memoryKey(record));
	if (value) remember(record, value);
	return value;
}
function snapshotCursor(record: RetainedRecord, offset: number): string {
	const cursor = `${PREFIX}.s.${record.nonce}.${record.digest}.${offset}`;
	if (
		offset <= 0 ||
		offset >= record.count ||
		offset % PAGE_CHANGES !== 0 ||
		!Cursor.safeParse(cursor).success
	)
		expired();
	return cursor;
}
function output(
	context: PluginContext,
	changes: readonly Change[],
	cursor: string,
	more: boolean,
): SyncPage {
	live(context);
	const page = Object.freeze({ changes, cursor, more });
	if (!channelV1.tools.channel_sync.output.safeParse(page).success)
		throw new PluginError("TRANSIENT");
	return page;
}
function slice(
	context: PluginContext,
	record: RetainedRecord,
	snapshot: Snapshot,
	offset: number,
): SyncPage {
	if (
		snapshot.count !== record.count ||
		snapshot.digest !== record.changesDigest ||
		offset >= snapshot.count
	)
		expired();
	const end = Math.min(offset + PAGE_CHANGES, snapshot.count),
		complete = end === snapshot.count;
	return output(
		context,
		Object.freeze(snapshot.changes.slice(offset, end)),
		complete ? record.successor : snapshotCursor(record, end),
		complete ? record.more : true,
	);
}

/** Encodes provider position DATA; this does not issue a native checkpoint or grant. */
export function gmailHistoryCursor(historyId: string): string {
	try {
		return position(historyId);
	} catch {
		throw new PluginError("INVALID_INPUT");
	}
}

/** Bounded ordered DATA pages; retained cursor and cache values carry no native apply authority. */
export async function syncGmailHistory(
	context: PluginContext,
	request: DeltaRequest,
): Promise<SyncPage> {
	const encoded = requestCursor(request),
		state = readCursor(encoded);
	try {
		live(context);
		if ("offset" in state) {
			const cacheScope = scope(context),
				record = await currentRecord(context, cacheScope, state);
			live(context);
			let snapshot = remembered(record);
			if (!snapshot) {
				const original = plainCursor(record.input);
				const replay = await readHistoryPage(context, {
					startHistoryId: original.start,
					...(original.pageToken === undefined ? {} : { pageToken: original.pageToken }),
				});
				live(context);
				snapshot = captureChanges(replay.changes);
				if (snapshot.count !== record.count || snapshot.digest !== record.changesDigest) expired();
				// Re-read after awaited I/O. This observes overwrites, not a KV transaction/CAS.
				await currentRecord(context, cacheScope, state);
				live(context);
				remember(record, snapshot);
			}
			return slice(context, record, snapshot, state.offset);
		}
		const result = await readHistoryPage(context, {
			startHistoryId: state.start,
			...(state.pageToken === undefined ? {} : { pageToken: state.pageToken }),
		});
		live(context);
		const historyId = historyDecimal(result.historyId);
		const watermark =
			state.watermark !== undefined && BigInt(state.watermark) < BigInt(historyId)
				? state.watermark
				: historyId;
		if (result.more !== (result.nextPageToken !== null)) throw new PluginError("TRANSIENT");
		const successor = result.more
			? continuation(state.start, watermark, result.nextPageToken as string)
			: position(watermark);
		if (result.changes.length <= PAGE_CHANGES)
			return output(context, result.changes, successor, result.more);
		const snapshot = captureChanges(result.changes),
			cacheScope = scope(context);
		const record = makeRecord({
			v: 1,
			scope: cacheScope,
			nonce: randomBytes(32).toString("base64url"),
			input: encoded,
			successor,
			more: result.more,
			count: snapshot.count,
			changesDigest: snapshot.digest,
		});
		live(context);
		await context.kv.set(slot(), record);
		live(context);
		await currentRecord(context, cacheScope, {
			nonce: record.nonce,
			digest: record.digest,
			offset: PAGE_CHANGES,
		});
		live(context);
		remember(record, snapshot);
		return slice(context, record, snapshot, 0);
	} catch (error) {
		if (context.signal.aborted) throw new PluginError("TRANSIENT");
		if (error instanceof PluginError) throw error;
		throw new PluginError("TRANSIENT");
	}
}
