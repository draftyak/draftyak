import { isProxy } from "node:util/types";
import { HOST_MAX_STREAM_BYTES } from "@draftyak/protocol/host-channel";
import type { ChatConversationChange } from "@draftyak/protocol/normalized-change";
import type { PluginContext } from "@draftyak/sdk/context";
import type { HostFetch, HostResponse } from "@draftyak/sdk/fetch";
import {
	reduceConversationInfo,
	reduceConversationListPage,
	type SlackConversationListPage,
} from "./conversations.ts";

/** A finite request-work bound, never an assertion of account or native coverage. */
export const MAX_SLACK_CATALOG_PAGES = 128;

export interface SlackConversationListOptions {
	readonly cursor?: string;
	readonly maxPages: number;
}

interface CapturedTransport {
	readonly fetch: HostFetch;
	readonly signal: AbortSignal;
	readonly receiver: unknown;
}

function invalid(): never {
	throw new Error("SLACK_CATALOG_INVALID");
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
	if (typeof raw !== "string" || raw.length > maximum || (!empty && raw.length === 0)) invalid();
	for (let at = 0; at < raw.length; at++) {
		const code = raw.charCodeAt(at);
		if (code < 33 || code > 126) invalid();
	}
	return raw;
}

function capture(raw: unknown): SlackConversationListOptions {
	const data = record(raw, ["cursor", "maxPages"]);
	if (
		typeof data.maxPages !== "number" ||
		!Number.isSafeInteger(data.maxPages) ||
		data.maxPages < 1 ||
		data.maxPages > MAX_SLACK_CATALOG_PAGES
	)
		invalid();
	const cursor =
		data.cursor === undefined ? undefined : ascii(data.cursor, 4096, true) || undefined;
	return Object.freeze({ maxPages: data.maxPages, ...(cursor === undefined ? {} : { cursor }) });
}

function transport(raw: unknown): CapturedTransport {
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

function assertActive(signal: AbortSignal): void {
	if (Reflect.get(AbortSignal.prototype, "aborted", signal)) {
		throw new Error("SLACK_CATALOG_ABORTED");
	}
}

function listUrl(cursor: string | undefined): URL {
	const url = new URL("https://slack.com/api/users.conversations");
	url.searchParams.set("types", "public_channel,private_channel,mpim,im");
	url.searchParams.set("limit", "100");
	if (cursor !== undefined) url.searchParams.set("cursor", cursor);
	return url;
}

async function readJson<T>(
	url: URL,
	input: CapturedTransport,
	decode: (value: unknown) => T,
): Promise<T> {
	const owned = new AbortController();
	const signal = AbortSignal.any([input.signal, owned.signal]);
	let response: HostResponse | undefined;
	let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
	try {
		assertActive(input.signal);
		const received: HostResponse = await Reflect.apply(input.fetch, input.receiver, [
			url,
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
		)
			invalid();
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
		const value = decode(JSON.parse(text.join("")));
		assertActive(input.signal);
		return value;
	} catch {
		assertActive(input.signal);
		return invalid();
	} finally {
		// Cancellation must reach our request before SDK body cancellation removes its listener.
		owned.abort();
		try {
			if (reader !== undefined) await reader.cancel();
			else if (response?.body !== null && response?.body !== undefined)
				await response.body.cancel();
		} catch {
			// A completed, aborted or errored body can already be closed.
		} finally {
			try {
				reader?.releaseLock();
			} catch {
				invalid();
			}
		}
	}
}

async function* listPages(
	options: SlackConversationListOptions,
	input: CapturedTransport,
): AsyncGenerator<SlackConversationListPage, void> {
	let cursor = options.cursor;
	const seen = new Set<string>(cursor === undefined ? [] : [cursor]);
	for (let at = 0; at < options.maxPages; at++) {
		const page = await readJson(listUrl(cursor), input, reduceConversationListPage);
		assertActive(input.signal);
		if (page.nextCursor !== undefined && seen.has(page.nextCursor)) invalid();
		yield page;
		if (!page.more || page.nextCursor === undefined) return;
		cursor = page.nextCursor;
		seen.add(cursor);
	}
}

/** Discovery data only; hydration, native read admission and persisted sync coverage are separate. */
export function pollConversationListPages(
	ctx: Pick<PluginContext, "fetch" | "signal">,
	options: SlackConversationListOptions,
): AsyncGenerator<SlackConversationListPage, void> {
	return listPages(capture(options), transport(ctx));
}

/** Return only the explicitly observed facts for the exact requested conversation. */
export function fetchConversationInfo(
	ctx: Pick<PluginContext, "fetch" | "signal">,
	channelId: string,
): Promise<ChatConversationChange> {
	const channel = ascii(channelId, 256);
	const input = transport(ctx);
	const url = new URL("https://slack.com/api/conversations.info");
	url.searchParams.set("channel", channel);
	url.searchParams.set("include_num_members", "true");
	return readJson(url, input, (value) => {
		const change = reduceConversationInfo(value);
		if (change.channelId !== channel) invalid();
		return change;
	}).then((change) => {
		assertActive(input.signal);
		return change;
	});
}
