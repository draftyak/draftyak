import { isUtf8 } from "node:buffer";
import { createHash } from "node:crypto";
import {
	Cursor,
	channelV1,
	type SyncPage,
	type SyncRequest,
} from "@draftyak/protocol/channel-v1";
import { canonicalize } from "@draftyak/protocol/jcs";
import { type EmailMessageChange, MAX_CHANGES } from "@draftyak/protocol/normalized-change";
import { type PluginContext, PluginError } from "@draftyak/sdk";
import {
	fetchGmailMessagePageData,
	fetchGmailMetadata,
	fetchGmailProfilePosition,
} from "../read.ts";
import { gmailHistoryCursor } from "../sync-history.ts";
import { copyHistoryData, historyDecimal, historyRecord } from "./page.ts";

export type GmailInitialRequest = Extract<SyncRequest, { readonly mode: "initial" | "resync" }>;
export interface GmailInitialOptions {
	/** Combined list/metadata wire-byte limit. The profile read has its own existing 4MiB cap. */
	readonly maxBytes?: number;
}
interface Continuation {
	readonly v: 1;
	readonly mode: "initial" | "resync";
	readonly since: number;
	readonly historyId: string;
	readonly pageToken: string;
	readonly seen: readonly string[];
}

const PREFIX = "gi1.c.";
const MAX_BYTES = 4 * 1024 * 1024;
const MAX_PAGES = 64;
const MAX_TOKEN_BYTES = 2_048;
const keys = ["v", "mode", "since", "historyId", "pageToken", "seen"] as const;
// Integrity bookkeeping for untrusted DATA, not authentication or scan authority.
const digest = (value: string): string =>
	createHash("sha256").update("gmail-initial-data-v1\0").update(value).digest("base64url");

function live(context: PluginContext): void {
	if (context.signal.aborted) throw new PluginError("TRANSIENT");
}
function expired(): never {
	throw new PluginError("CURSOR_EXPIRED");
}
function token(value: unknown): string {
	if (typeof value !== "string" || value.length > MAX_TOKEN_BYTES || !/^[!-~]+$/.test(value))
		expired();
	return value;
}
function requestData(value: GmailInitialRequest): GmailInitialRequest {
	try {
		const parsed = channelV1.tools.channel_sync.input.safeParse(copyHistoryData(value));
		if (!parsed.success || parsed.data.mode === "delta") throw new Error();
		return Object.freeze({
			mode: parsed.data.mode,
			since: parsed.data.since,
			...(parsed.data.cursor === undefined ? {} : { cursor: parsed.data.cursor }),
		});
	} catch {
		throw new PluginError("INVALID_INPUT");
	}
}
function byteLimit(options: GmailInitialOptions): number {
	try {
		const settings = historyRecord(copyHistoryData(options), ["maxBytes"]);
		const bytes = Object.hasOwn(settings, "maxBytes") ? settings.maxBytes : MAX_BYTES;
		if (typeof bytes !== "number" || !Number.isSafeInteger(bytes) || bytes < 0 || bytes > MAX_BYTES)
			throw new Error();
		return bytes;
	} catch {
		throw new PluginError("INVALID_INPUT");
	}
}
function encode(state: Continuation): string {
	const json = canonicalize(state);
	const value = `${PREFIX}${Buffer.from(json, "utf8").toString("base64url")}.${digest(json)}`;
	if (!Cursor.safeParse(value).success) throw new PluginError("QUOTA_EXCEEDED");
	return value;
}
function continuation(request: GmailInitialRequest): Continuation | undefined {
	if (request.cursor === undefined) return undefined;
	try {
		const parts = request.cursor.split(".");
		if (parts.length !== 4 || parts[0] !== "gi1" || parts[1] !== "c") expired();
		const encoded = parts[2],
			stamp = parts[3];
		if (!encoded || !stamp || !/^[A-Za-z0-9_-]+$/.test(encoded)) expired();
		const bytes = Buffer.from(encoded, "base64url");
		if (!isUtf8(bytes) || bytes.toString("base64url") !== encoded) expired();
		const json = bytes.toString("utf8");
		const data = historyRecord(copyHistoryData(JSON.parse(json)), keys);
		if (
			Object.keys(data).length !== keys.length ||
			data.v !== 1 ||
			data.mode !== request.mode ||
			data.since !== request.since ||
			!Array.isArray(data.seen) ||
			data.seen.length > MAX_PAGES - 2
		)
			expired();
		const historyId = historyDecimal(data.historyId),
			pageToken = token(data.pageToken);
		const seen = data.seen.map((value) => {
			if (typeof value !== "string" || !/^[A-Za-z0-9_-]{43}$/.test(value)) expired();
			return value;
		});
		if (new Set(seen).size !== seen.length || seen.includes(digest(pageToken))) expired();
		const state: Continuation = Object.freeze({
			v: 1,
			mode: request.mode,
			since: request.since,
			historyId,
			pageToken,
			seen: Object.freeze(seen),
		});
		if (canonicalize(state) !== json || digest(json) !== stamp || encode(state) !== request.cursor)
			expired();
		return state;
	} catch {
		return expired();
	}
}

/**
 * One default-scope provider page of metadata DATA. Neither `more:false` nor the
 * returned provider position certifies a mailbox snapshot or an authorized scan.
 */
export async function syncGmailInitial(
	context: PluginContext,
	request: GmailInitialRequest,
	options: GmailInitialOptions = {},
): Promise<SyncPage> {
	const input = requestData(request),
		state = continuation(input);
	let remaining = byteLimit(options);
	if (remaining === 0) throw new PluginError("QUOTA_EXCEEDED");
	try {
		live(context);
		let historyId: string;
		if (state) historyId = state.historyId;
		else {
			const profile = await fetchGmailProfilePosition(context);
			live(context);
			historyId = historyDecimal(profile.historyId);
			if (!Number.isSafeInteger(profile.bytesRead) || profile.bytesRead < 0)
				throw new PluginError("TRANSIENT");
			if (profile.bytesRead > MAX_BYTES) throw new PluginError("QUOTA_EXCEEDED");
		}
		const charge = (bytes: number): void => {
			if (!Number.isSafeInteger(bytes) || bytes < 0) throw new PluginError("TRANSIENT");
			if (bytes > remaining) throw new PluginError("QUOTA_EXCEEDED");
			remaining -= bytes;
		};
		const page = await fetchGmailMessagePageData(context, {
			maxResults: MAX_CHANGES,
			maxBytes: remaining,
			...(state ? { pageToken: state.pageToken } : {}),
		});
		live(context);
		charge(page.bytesRead);
		let cursor: string;
		const more = page.nextPageToken !== undefined;
		if (page.nextPageToken === undefined) cursor = gmailHistoryCursor(historyId);
		else {
			const seen = state ? [...state.seen, digest(state.pageToken)] : [];
			if (seen.length > MAX_PAGES - 2) throw new PluginError("QUOTA_EXCEEDED");
			if (seen.includes(digest(page.nextPageToken))) expired();
			cursor = encode({
				v: 1,
				mode: input.mode,
				since: input.since,
				historyId,
				pageToken: page.nextPageToken,
				seen,
			});
		}
		const changes: EmailMessageChange[] = [];
		for (const ref of page.messages) {
			live(context);
			if (remaining === 0) throw new PluginError("QUOTA_EXCEEDED");
			const result = await fetchGmailMetadata(
				context,
				{ kind: "email", providerId: ref.providerId },
				{ maxBytes: remaining },
			);
			live(context);
			charge(result.bytesRead);
			if (result.message.threadId !== ref.threadId || result.message.raw !== undefined)
				throw new PluginError("TRANSIENT");
			if (result.message.internalDate >= input.since) changes.push(result.message);
		}
		live(context);
		const result: SyncPage = Object.freeze({ changes: Object.freeze(changes), cursor, more });
		if (!channelV1.tools.channel_sync.output.safeParse(result).success)
			throw new PluginError("TRANSIENT");
		return result;
	} catch (error) {
		if (context.signal.aborted) throw new PluginError("TRANSIENT");
		if (error instanceof PluginError) throw error;
		throw new PluginError("TRANSIENT");
	}
}
