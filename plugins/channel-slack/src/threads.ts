import { isProxy } from "node:util/types";
import { MAX_CHANGES } from "@draftyak/protocol/normalized-change";
import type { PluginContext } from "@draftyak/sdk/context";
import type { HostFetch } from "@draftyak/sdk/fetch";
import { MAX_SLACK_POLL_PAGES, pollMessages } from "./poll.ts";
import type { SlackReadPage } from "./reduce.ts";

/** Observed routing data only; it is neither a read grant nor a completeness claim. */
export interface SlackObservedThread {
	readonly channelId: string;
	readonly threadTs: string;
	readonly replyCount: number;
}
export interface SlackThreadPage extends SlackObservedThread {
	readonly page: SlackReadPage;
}

function invalid(): never {
	throw new Error("SLACK_THREADS_INVALID");
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
function array(raw: unknown): readonly unknown[] {
	if (raw === null || typeof raw !== "object" || isProxy(raw) || !Array.isArray(raw)) invalid();
	if (Object.getPrototypeOf(raw) !== Array.prototype) invalid();
	const length = Object.getOwnPropertyDescriptor(raw, "length")?.value;
	if (!Number.isSafeInteger(length) || length < 0 || length > MAX_CHANGES) invalid();
	if (Reflect.ownKeys(raw).length !== length + 1) invalid();
	const result: unknown[] = [];
	for (let at = 0; at < length; at++) {
		const descriptor = Object.getOwnPropertyDescriptor(raw, String(at));
		if (!descriptor?.enumerable || !("value" in descriptor)) invalid();
		result.push(descriptor.value);
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
function timestamp(raw: unknown): string {
	const value = ascii(raw, 256);
	if (!/^(?:0|[1-9][0-9]*)\.[0-9]{1,9}$/.test(value)) invalid();
	const dot = value.indexOf(".");
	const ns =
		BigInt(value.slice(0, dot)) * 1_000_000_000n + BigInt(value.slice(dot + 1).padEnd(9, "0"));
	if (ns / 1_000_000n > BigInt(Number.MAX_SAFE_INTEGER)) invalid();
	return value;
}
function count(raw: unknown, positive = false): number {
	if (typeof raw !== "number" || !Number.isSafeInteger(raw) || raw < (positive ? 1 : 0)) invalid();
	return raw;
}

/** Join the existing page sidecar; absent/zero counts never manufacture a thread. */
export function observeSlackThreads(
	historyPage: SlackReadPage,
	options: Readonly<{ maxRoots: number }>,
): readonly SlackObservedThread[] {
	const config = record(options, ["maxRoots"]);
	const maxRoots = count(config.maxRoots, true);
	if (maxRoots > MAX_CHANGES) invalid();
	const data = record(historyPage, ["changes", "replyCounts"]);
	const rows: { channelId: string; ts: string; threadTs: string | undefined }[] = [];
	const ids = new Set<string>();
	for (const raw of array(data.changes)) {
		const row = record(raw, ["kind", "channelId", "ts", "threadTs"]);
		if (row.kind !== "chat.message") invalid();
		const channelId = ascii(row.channelId, 256);
		const ts = timestamp(row.ts);
		const threadTs = row.threadTs === undefined ? undefined : timestamp(row.threadTs);
		if (ids.has(ts)) invalid();
		ids.add(ts);
		rows.push({ channelId, ts, threadTs });
	}
	const counts = new Map<string, number>();
	for (const raw of array(data.replyCounts)) {
		const row = record(raw, ["ts", "count"]);
		const ts = timestamp(row.ts);
		const observed = count(row.count);
		if (!ids.has(ts) || counts.has(ts)) invalid();
		counts.set(ts, observed);
	}
	const result: SlackObservedThread[] = [];
	for (const row of rows) {
		const replyCount = counts.get(row.ts);
		if (replyCount === undefined || replyCount === 0) continue;
		if (row.threadTs !== undefined && row.threadTs !== row.ts) invalid();
		if (result.length >= maxRoots) invalid();
		result.push(Object.freeze({ channelId: row.channelId, threadTs: row.ts, replyCount }));
	}
	return Object.freeze(result);
}

function capturedThread(raw: unknown): SlackObservedThread {
	const data = record(raw, ["channelId", "threadTs", "replyCount"]);
	return Object.freeze({
		channelId: ascii(data.channelId, 256),
		threadTs: timestamp(data.threadTs),
		replyCount: count(data.replyCount, true),
	});
}
function capturedContext(raw: unknown): Pick<PluginContext, "fetch" | "signal"> {
	const data = record(raw, ["fetch", "signal"]);
	if (typeof data.fetch !== "function" || isProxy(data.fetch)) invalid();
	if (data.signal === null || typeof data.signal !== "object" || isProxy(data.signal)) invalid();
	try {
		Reflect.get(AbortSignal.prototype, "aborted", data.signal);
	} catch {
		invalid();
	}
	const fetch = data.fetch as HostFetch;
	return Object.freeze({
		fetch: (...args: Parameters<HostFetch>) => Reflect.apply(fetch, raw, args),
		signal: data.signal as AbortSignal,
	});
}
function assertActive(signal: AbortSignal): void {
	if (Reflect.get(AbortSignal.prototype, "aborted", signal))
		throw new Error("SLACK_THREADS_ABORTED");
}
async function* threadPages(
	context: Pick<PluginContext, "fetch" | "signal">,
	thread: SlackObservedThread,
	pages: AsyncGenerator<SlackReadPage, void>,
): AsyncGenerator<SlackThreadPage, void> {
	try {
		assertActive(context.signal);
		for await (const page of pages) {
			assertActive(context.signal);
			for (const row of page.changes) {
				if (
					row.channelId !== thread.channelId ||
					(row.ts === thread.threadTs
						? row.threadTs !== undefined && row.threadTs !== thread.threadTs
						: row.threadTs !== thread.threadTs)
				)
					invalid();
			}
			yield Object.freeze({ ...thread, page });
		}
		assertActive(context.signal);
	} catch {
		assertActive(context.signal);
		invalid();
	}
}

/** Resume exactly one observed root. Count never truncates pages or proves coverage. */
export function pollObservedThread(
	ctx: Pick<PluginContext, "fetch" | "signal">,
	thread: SlackObservedThread,
	options: Readonly<{ cursor?: string; maxPages: number }>,
): AsyncGenerator<SlackThreadPage, void> {
	const observed = capturedThread(thread);
	const config = record(options, ["cursor", "maxPages"]);
	const maxPages = count(config.maxPages, true);
	if (maxPages > MAX_SLACK_POLL_PAGES) invalid();
	const cursor =
		config.cursor === undefined ? undefined : ascii(config.cursor, 4096, true) || undefined;
	const context = capturedContext(ctx);
	let pages: AsyncGenerator<SlackReadPage, void>;
	try {
		pages = pollMessages(context, {
			kind: "replies",
			channelId: observed.channelId,
			threadTs: observed.threadTs,
			maxPages,
			...(cursor === undefined ? {} : { cursor }),
		});
	} catch {
		return invalid();
	}
	return threadPages(context, observed, pages);
}
