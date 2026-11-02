import { isProxy } from "node:util/types";
import { HOST_MAX_STREAM_BYTES } from "@draftyak/protocol/host-channel";
import type { PluginContext } from "@draftyak/sdk/context";
import type { HostFetch, HostResponse } from "@draftyak/sdk/fetch";
import { reduceMessagesPage, type SlackReadPage } from "./reduce.ts";

/** A bound on this component's request work, not a provider or native read allowance. */
export const MAX_SLACK_POLL_PAGES = 128;

interface SlackPollOptions {
	readonly channelId: string;
	readonly cursor?: string;
	readonly maxPages: number;
	readonly oldest?: string;
	readonly latest?: string;
	readonly inclusive?: boolean;
}

export type SlackPollRequest = SlackPollOptions &
	(
		| { readonly kind: "history"; readonly threadTs?: never }
		| { readonly kind: "replies"; readonly threadTs: string }
	);

interface CapturedRequest extends SlackPollOptions {
	readonly kind: "history" | "replies";
	readonly threadTs?: string;
}

const REQUEST_KEYS = [
	"kind",
	"channelId",
	"cursor",
	"maxPages",
	"oldest",
	"latest",
	"inclusive",
	"threadTs",
];

function invalid(): never {
	throw new Error("SLACK_POLL_INVALID");
}

function record(raw: unknown, keys: readonly string[]): Record<string, unknown> {
	if (raw === null || typeof raw !== "object" || isProxy(raw)) invalid();
	const prototype = Object.getPrototypeOf(raw);
	if (prototype !== null && prototype !== Object.prototype) invalid();
	const result: Record<string, unknown> = Object.create(null);
	for (const key of keys) {
		const descriptor = Object.getOwnPropertyDescriptor(raw, key);
		if (descriptor === undefined) continue;
		if (!descriptor.enumerable || !("value" in descriptor)) invalid();
		result[key] = descriptor.value;
	}
	return result;
}

function ascii(raw: unknown, maximum: number, empty = false): string {
	if (typeof raw !== "string" || raw.length > maximum || (!empty && raw.length === 0)) {
		invalid();
	}
	for (let at = 0; at < raw.length; at++) {
		const code = raw.charCodeAt(at);
		if (code < 33 || code > 126) invalid();
	}
	return raw;
}

// Query timestamps retain the reducer's exact IDs and safe millisecond range.
function timestamp(raw: unknown): string {
	const value = ascii(raw, 256);
	if (!/^(?:0|[1-9][0-9]*)\.[0-9]{1,9}$/.test(value)) invalid();
	if (nanoseconds(value) / 1_000_000n > BigInt(Number.MAX_SAFE_INTEGER)) invalid();
	return value;
}

function nanoseconds(ts: string): bigint {
	const dot = ts.indexOf(".");
	return BigInt(ts.slice(0, dot)) * 1_000_000_000n + BigInt(ts.slice(dot + 1).padEnd(9, "0"));
}

function capture(raw: unknown): CapturedRequest {
	const data = record(raw, REQUEST_KEYS);
	if (data.kind !== "history" && data.kind !== "replies") invalid();
	if (data.kind === "history" && Object.hasOwn(data, "threadTs")) invalid();
	const channelId = ascii(data.channelId, 256);
	if (
		typeof data.maxPages !== "number" ||
		!Number.isSafeInteger(data.maxPages) ||
		data.maxPages < 1 ||
		data.maxPages > MAX_SLACK_POLL_PAGES
	) {
		invalid();
	}
	const cursor =
		data.cursor === undefined ? undefined : ascii(data.cursor, 4_096, true) || undefined;
	const oldest = data.oldest === undefined ? undefined : timestamp(data.oldest);
	const latest = data.latest === undefined ? undefined : timestamp(data.latest);
	if (oldest !== undefined && latest !== undefined && nanoseconds(oldest) > nanoseconds(latest)) {
		invalid();
	}
	if (data.inclusive !== undefined && typeof data.inclusive !== "boolean") invalid();
	const threadTs = data.kind === "replies" ? timestamp(data.threadTs) : undefined;
	return Object.freeze({
		kind: data.kind,
		channelId,
		maxPages: data.maxPages,
		...(cursor === undefined ? {} : { cursor }),
		...(oldest === undefined ? {} : { oldest }),
		...(latest === undefined ? {} : { latest }),
		...(data.inclusive === undefined ? {} : { inclusive: data.inclusive }),
		...(threadTs === undefined ? {} : { threadTs }),
	});
}

function assertActive(signal: AbortSignal): void {
	// Use the native receiver check, leaving shadow properties on a signal unread.
	if (Reflect.get(AbortSignal.prototype, "aborted", signal)) {
		throw new Error("SLACK_POLL_ABORTED");
	}
}

function transport(raw: unknown): { fetch: HostFetch; signal: AbortSignal; receiver: unknown } {
	const data = record(raw, ["fetch", "signal"]);
	if (typeof data.fetch !== "function" || isProxy(data.fetch)) invalid();
	if (data.signal === null || typeof data.signal !== "object" || isProxy(data.signal)) invalid();
	try {
		Reflect.get(AbortSignal.prototype, "aborted", data.signal);
	} catch {
		invalid();
	}
	return { fetch: data.fetch as HostFetch, signal: data.signal as AbortSignal, receiver: raw };
}

function urlFor(request: CapturedRequest, cursor: string | undefined): URL {
	const url = new URL(`https://slack.com/api/conversations.${request.kind}`);
	url.searchParams.set("channel", request.channelId);
	url.searchParams.set("limit", "100");
	if (cursor !== undefined) url.searchParams.set("cursor", cursor);
	if (request.threadTs !== undefined) url.searchParams.set("ts", request.threadTs);
	if (request.oldest !== undefined) url.searchParams.set("oldest", request.oldest);
	if (request.latest !== undefined) url.searchParams.set("latest", request.latest);
	if (request.inclusive !== undefined) url.searchParams.set("inclusive", String(request.inclusive));
	return url;
}

async function readPage(
	request: CapturedRequest,
	cursor: string | undefined,
	input: ReturnType<typeof transport>,
): Promise<SlackReadPage> {
	const owned = new AbortController();
	const signal = AbortSignal.any([input.signal, owned.signal]);
	let response: HostResponse | undefined;
	let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
	try {
		assertActive(input.signal);
		const received: HostResponse = await Reflect.apply(input.fetch, input.receiver, [
			urlFor(request, cursor),
			{ method: "GET", stream: true, signal },
		]);
		response = received;
		assertActive(input.signal);
		if (
			!response.ok ||
			response.bodyRef !== undefined ||
			response.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase() !==
				"application/json" ||
			response.body === null
		) {
			invalid();
		}
		reader = response.body.getReader();
		const decoder = new TextDecoder("utf-8", { fatal: true });
		const text: string[] = [];
		let bytes = 0;
		for (;;) {
			const part = await reader.read();
			assertActive(input.signal);
			if (part.done) break;
			bytes += part.value.byteLength;
			if (bytes > HOST_MAX_STREAM_BYTES) invalid();
			text.push(decoder.decode(part.value, { stream: true }));
		}
		text.push(decoder.decode());
		const page = reduceMessagesPage(request.channelId, JSON.parse(text.join("")));
		assertActive(input.signal);
		return page;
	} catch {
		assertActive(input.signal);
		return invalid();
	} finally {
		// SDK body cancellation removes its abort listener, so abort our request first.
		owned.abort();
		try {
			if (reader !== undefined) await reader.cancel();
			else if (response?.body !== null && response?.body !== undefined)
				await response.body.cancel();
		} catch {
			// The abort or a completed/errored response may already have closed this body.
		} finally {
			try {
				reader?.releaseLock();
			} catch {
				invalid();
			}
		}
	}
}

async function* pages(
	request: CapturedRequest,
	input: ReturnType<typeof transport>,
): AsyncGenerator<SlackReadPage, void> {
	let cursor = request.cursor;
	const seen = new Set<string>(cursor === undefined ? [] : [cursor]);
	for (let at = 0; at < request.maxPages; at++) {
		const page = await readPage(request, cursor, input);
		assertActive(input.signal);
		if (page.nextCursor !== undefined && seen.has(page.nextCursor)) invalid();
		// Cleanup and complete page validation precede delivery; no cursor is committed here.
		yield page;
		if (!page.more || page.nextCursor === undefined) return;
		cursor = page.nextCursor;
		seen.add(cursor);
	}
}

/**
 * Capture an ordinary read request now, then fetch pages only as the caller asks.
 * Invalid requests throw synchronously. Page limits and missing continuation leave
 * the last page's incompleteness intact; no yielded page establishes read authority.
 */
export function pollMessages(
	ctx: Pick<PluginContext, "fetch" | "signal">,
	request: SlackPollRequest,
): AsyncGenerator<SlackReadPage, void> {
	return pages(capture(request), transport(ctx));
}
