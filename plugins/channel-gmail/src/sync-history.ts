import { Cursor, channelV1, type SyncPage, type SyncRequest } from "@draftyak/protocol/channel-v1";
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
const PREFIX = "gh1";
const MAX_TOKEN_BYTES = 2048;

function expired(): never {
	throw new PluginError("CURSOR_EXPIRED");
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
function readCursor(value: string): Position {
	try {
		if (!Cursor.safeParse(value).success) expired();
		const parts = value.split(".");
		if (parts[0] !== PREFIX) expired();
		if (parts[1] === "p" && parts.length === 3) {
			return Object.freeze({ start: historyDecimal(parts[2]) });
		}
		if (parts[1] !== "c" || parts.length !== 5) expired();
		const start = historyDecimal(parts[2]);
		const watermark = historyDecimal(parts[3]);
		if (BigInt(watermark) < BigInt(start)) expired();
		const parsed = Base64Url.safeParse(parts[4]);
		if (!parsed.success) expired();
		const encoded = parsed.data;
		const bytes = Buffer.from(encoded, "base64url");
		if (bytes.length > MAX_TOKEN_BYTES || bytes.toString("base64url") !== encoded) expired();
		const pageToken = providerToken(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
		return Object.freeze({ start, watermark, pageToken });
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

/** Encodes provider position DATA; this does not issue a native checkpoint or grant. */
export function gmailHistoryCursor(historyId: string): string {
	try {
		return position(historyId);
	} catch {
		throw new PluginError("INVALID_INPUT");
	}
}

/** One bounded history page through the existing SDK reader, with no native apply authority. */
export async function syncGmailHistory(
	context: PluginContext,
	request: DeltaRequest,
): Promise<SyncPage> {
	const state = readCursor(requestCursor(request));
	try {
		const result = await readHistoryPage(context, {
			startHistoryId: state.start,
			...(state.pageToken === undefined ? {} : { pageToken: state.pageToken }),
		});
		const historyId = historyDecimal(result.historyId);
		const watermark =
			state.watermark !== undefined && BigInt(state.watermark) < BigInt(historyId)
				? state.watermark
				: historyId;
		if (result.more !== (result.nextPageToken !== null)) throw new PluginError("TRANSIENT");
		const cursor = result.more
			? continuation(state.start, watermark, result.nextPageToken as string)
			: position(watermark);
		const page = Object.freeze({ changes: result.changes, cursor, more: result.more });
		if (!channelV1.tools.channel_sync.output.safeParse(page).success)
			throw new PluginError("TRANSIENT");
		return page;
	} catch (error) {
		if (error instanceof PluginError) throw error;
		throw new PluginError("TRANSIENT");
	}
}
