import { isProxy } from "node:util/types";
import type { Account } from "@draftyak/protocol/entities/account";
import type { HeaderList } from "@draftyak/protocol/hash";
import { HOST_MAX_STREAM_BYTES, HostFetchParams, jsonCopy } from "@draftyak/protocol/host-channel";
import { parseStrict } from "@draftyak/protocol/jcs";
import type { ChannelProfile } from "@draftyak/protocol/manifest";
import { MAX_INLINE_BYTES } from "@draftyak/protocol/normalized-change";
import { fromBase64Url } from "@draftyak/protocol/scalars";
import { denseArray, inertRecord } from "../../../extensions/values.ts";
import { canonicalChannelUrl } from "./canonical.ts";
import { decideChannelRequest } from "./decision.ts";
import { NativeChannelHostError } from "./native-connection.ts";

export interface NativeMetadataRequest {
	readonly url: string;
	readonly method: "GET" | "POST";
	readonly headers: HeaderList;
	/** Captured request DATA. The consuming operation owns terminal erasure. */
	readonly body: Uint8Array;
	readonly maxBytes: number;
	readonly stream: boolean;
}

const MAX_METADATA_BYTES = Math.min(35 * 1024 * 1024, HOST_MAX_STREAM_BYTES);
const refused = (): NativeChannelHostError => new NativeChannelHostError();

/** Only known fetch DATA is copied; no caller object reaches the protocol parser. */
function fetchSnapshot(raw: unknown): HostFetchParams {
	// Unsupported projection/ticket keys refuse without traversing their supplied values.
	const source = inertRecord(raw, ["method", "url", "headers"], ["body", "stream"], "unavailable");
	if (typeof source.method !== "string" || typeof source.url !== "string") throw refused();
	if (isProxy(source.headers)) throw refused();
	const headers = denseArray(source.headers, 64, "unavailable").map((rawRow) => {
		if (isProxy(rawRow)) throw refused();
		const row = denseArray(rawRow, 2, "unavailable");
		if (row.length !== 2 || typeof row[0] !== "string" || typeof row[1] !== "string")
			throw refused();
		return [row[0], row[1]] as [string, string];
	});
	const snapshot: Record<string, unknown> = { method: source.method, url: source.url, headers };
	if (source.body !== undefined) {
		// Blob references are not metadata request bodies; their values need not be inspected.
		const body = inertRecord(source.body, ["base64"], [], "unavailable");
		if (typeof body.base64 !== "string") throw refused();
		snapshot.body = { base64: body.base64 };
	}
	if (source.stream !== undefined) {
		if (typeof source.stream !== "boolean") throw refused();
		snapshot.stream = source.stream;
	}
	// Preserve the protocol's aggregate frame bound, now over owned inert DATA only.
	return HostFetchParams.parse(jsonCopy(snapshot));
}

/** Captures bounded metadata request DATA. No caller or credential authority is established. */
export function captureNativeMetadataRequest(
	raw: unknown,
	profile: ChannelProfile,
	account: Account,
): NativeMetadataRequest {
	try {
		const candidate = fetchSnapshot(raw);
		const decision = decideChannelRequest({ profile, accountMode: account.mode }, candidate, {
			state: "absent",
		});
		if (!decision.allowed || decision.class !== "read") throw refused();
		const url = canonicalChannelUrl(decision.url);
		if (!url) throw refused();
		if (profile === "slack-v1") {
			if (
				account.channel !== "chat" ||
				url.segments[1] === "apps.connections.open" ||
				(decision.method !== "GET" && decision.method !== "POST")
			)
				throw refused();
		} else {
			if (
				account.channel !== "email" ||
				decision.method !== "GET" ||
				(url.segments[3] !== "me" &&
					decodeURIComponent(url.segments[3] ?? "") !== account.address) ||
				url.segments.includes("attachments")
			)
				throw refused();
			if (
				(url.segments[4] === "messages" || url.segments[4] === "threads") &&
				url.segments.length > 5
			) {
				const formats = new URL(url.href).searchParams.getAll("format");
				if (formats.length !== 1 || !["metadata", "minimal"].includes(formats[0] ?? ""))
					throw refused();
			}
		}
		const body = candidate.body;
		if (body !== undefined && !("base64" in body)) throw refused();
		const decoded = body === undefined ? new Uint8Array() : fromBase64Url(body.base64);
		if (decoded === undefined) throw refused();
		const bytes = Buffer.from(decoded);
		try {
			if (bytes.length > MAX_INLINE_BYTES || (candidate.method === "GET" && bytes.length !== 0))
				throw refused();
			if (bytes.length !== 0) {
				const text = bytes.toString("utf8");
				if (!Buffer.from(text, "utf8").equals(bytes)) throw refused();
				const contentType = decision.headers.find(([name]) => name === "content-type")?.[1];
				let names: string[];
				if (contentType?.split(";", 1)[0]?.trim().toLowerCase() === "application/json") {
					const fields = parseStrict(text);
					if (!fields || typeof fields !== "object" || Array.isArray(fields)) throw refused();
					names = Object.keys(fields);
					if (Object.values(fields).some((value) => typeof value !== "string")) throw refused();
				} else if (
					contentType?.split(";", 1)[0]?.trim().toLowerCase() ===
					"application/x-www-form-urlencoded"
				) {
					names = [...new URLSearchParams(text).keys()];
				} else throw refused();
				const queryNames = new URL(url.href).searchParams.keys();
				const all = [...queryNames, ...names];
				if (
					new Set(all).size !== all.length ||
					all.some(
						(name) =>
							name.startsWith("$") ||
							["token", "access_token", "oauth_token", "key"].includes(name.toLowerCase()),
					)
				)
					throw refused();
			}
			return Object.freeze({
				url: decision.url,
				method: decision.method as "GET" | "POST",
				headers: decision.headers,
				body: bytes,
				maxBytes: MAX_METADATA_BYTES,
				stream: candidate.stream === true,
			});
		} catch {
			bytes.fill(0);
			throw refused();
		}
	} catch {
		throw refused();
	}
}

/** History-bearing paths remain unavailable until their genuine provider-window binding exists. */
export function assertNativeMetadataWindow(
	input: Readonly<{ profile: ChannelProfile; historyFloorMs: number }>,
	request: NativeMetadataRequest,
): void {
	try {
		if (!Number.isSafeInteger(input.historyFloorMs) || input.historyFloorMs < 0) throw refused();
		const segments = new URL(request.url).pathname.slice(1).split("/");
		if (
			(input.profile !== "slack-v1" &&
				["messages", "threads", "history"].includes(segments[4] ?? "")) ||
			(input.profile === "slack-v1" &&
				["conversations.history", "conversations.replies"].includes(segments[1] ?? ""))
		)
			throw refused();
	} catch {
		throw refused();
	}
}
