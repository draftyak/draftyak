import { createSlackReadFake, SLACK_READ_HOST } from "@draftyak/fakes/slack";
import type { HostFetchParams, HostMethod, HostMethods } from "@draftyak/protocol/host-channel";
import { MAX_CHANGES } from "@draftyak/protocol/normalized-change";
import { createPluginContext, type PluginContext } from "@draftyak/sdk/context";
import type { HostFetch } from "@draftyak/sdk/fetch";
import { type HostRequestOptions, memoryHost } from "@draftyak/sdk/host";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { pollMessages } from "../src/poll.ts";
import { reduceMessagesPage, type SlackReadPage } from "../src/reduce.ts";
import {
	observeSlackThreads,
	pollObservedThread,
	type SlackObservedThread,
	type SlackThreadPage,
} from "../src/threads.ts";

const CHANNEL = "CDYTEST1";
const ROOT = "1800000000.000000001";
const ROOT2 = "1800000000.000000002";
const REPLY = "1800000001.000000001";
const turn = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));
const wireRow = (ts: string, extra: Record<string, unknown> = {}) => ({
	type: "message",
	ts,
	user: "UDYTEST1",
	text: "DYTEST thread",
	...extra,
});
const wirePage = (messages: unknown[] = [], cursor = "", more = cursor !== "") => ({
	ok: true,
	messages,
	has_more: more,
	response_metadata: { next_cursor: cursor },
});
const history = (messages: unknown[]) => reduceMessagesPage(CHANNEL, wirePage(messages));
const root = (replyCount = 1): SlackObservedThread => ({
	channelId: CHANNEL,
	threadTs: ROOT,
	replyCount,
});
interface Gate {
	readonly promise: Promise<void>;
	release(): void;
}
function gate(): Gate {
	let release = (): void => {};
	const promise = new Promise<void>((resolve) => {
		release = resolve;
	});
	return { promise, release };
}
interface Trace {
	readonly params: HostFetchParams;
	readonly signal: AbortSignal | undefined;
}
interface Fixture {
	readonly context: Pick<PluginContext, "fetch" | "signal">;
	readonly shared: AbortController;
	readonly requests: Trace[];
	readonly cleanupAbort: boolean[];
	close(): void;
}
const fixtures: Fixture[] = [];
const network = vi.fn<typeof fetch>();
function sdk(
	serve: (url: URL, init: RequestInit) => Response | Promise<Response>,
	controls: { cleanupSeen?: Gate; cleanupGate?: Gate } = {},
): Fixture {
	const shared = new AbortController(),
		requests: Trace[] = [],
		cleanupAbort: boolean[] = [];
	const host = memoryHost(async (method, raw, signal) => {
		if (method !== "host/fetch") throw new Error("DYTEST unexpected host method");
		const params = raw as HostFetchParams;
		const response = await serve(new URL(params.url), {
			method: params.method,
			headers: params.headers as [string, string][],
			signal,
		});
		return {
			status: response.status,
			headers: [...response.headers.entries()],
			body: { base64: Buffer.from(await response.arrayBuffer()).toString("base64url") },
		};
	});
	const request = host.request;
	host.request = function <M extends HostMethod>(
		method: M,
		params: HostMethods[M]["params"],
		options?: HostRequestOptions,
	): Promise<HostMethods[M]["result"]> {
		if (method === "host/fetch")
			requests.push({ params: params as HostFetchParams, signal: options?.signal });
		return Reflect.apply(request, this, [method, params, options]);
	};
	const original = createPluginContext(
		{ plugin: "channel-slack", account: "dytest" },
		host,
		shared.signal,
	);
	const fetch: HostFetch = async (...args) => {
		const response = await Reflect.apply(original.fetch, original, args);
		if ((controls.cleanupSeen || controls.cleanupGate) && response.body !== null) {
			const body = response.body,
				getReader = body.getReader.bind(body);
			Object.defineProperty(body, "getReader", {
				configurable: true,
				value: () => {
					const reader = getReader(),
						cancel = reader.cancel.bind(reader);
					Object.defineProperty(reader, "cancel", {
						configurable: true,
						value: async (reason?: unknown) => {
							cleanupAbort.push(requests.at(-1)?.signal?.aborted === true);
							controls.cleanupSeen?.release();
							await controls.cleanupGate?.promise;
							return cancel(reason);
						},
					});
					return reader;
				},
			});
		}
		return response;
	};
	const result: Fixture = {
		context: Object.freeze({ fetch, signal: original.signal }),
		shared,
		requests,
		cleanupAbort,
		close() {
			controls.cleanupGate?.release();
			shared.abort();
			host.close();
		},
	};
	fixtures.push(result);
	return result;
}
async function collect(pages: AsyncGenerator<SlackThreadPage, void>): Promise<SlackThreadPage[]> {
	const result: SlackThreadPage[] = [];
	for await (const page of pages) result.push(page);
	return result;
}

beforeEach(() => {
	network.mockReset();
	network.mockRejectedValue(new Error("DYTEST network forbidden"));
	vi.stubGlobal("fetch", network);
});
afterEach(async () => {
	try {
		for (const fixture of fixtures.splice(0)) fixture.close();
		await Promise.resolve();
		expect(network).not.toHaveBeenCalled();
	} finally {
		vi.unstubAllGlobals();
	}
});

describe("Slack observed thread metadata", () => {
	it("joins positive observed counts by exact timestamp in history order", () => {
		const page = history([
			wireRow(ROOT, { reply_count: 2 }),
			wireRow(ROOT2, { thread_ts: ROOT2, reply_count: 1 }),
			wireRow(REPLY, { thread_ts: ROOT, reply_count: 0 }),
			wireRow("1800000002.0"),
			wireRow("1800000003.0", { reply_count: 0 }),
		]);
		const reversed = { ...page, replyCounts: [...page.replyCounts].reverse() };
		const result = observeSlackThreads(reversed, { maxRoots: 2 });
		expect(result).toEqual([root(2), { channelId: CHANNEL, threadTs: ROOT2, replyCount: 1 }]);
		expect(Object.isFrozen(result)).toBe(true);
		for (const item of result) expect(Object.isFrozen(item)).toBe(true);
	});

	it("does not invent roots or zero counts when the provider omitted metadata", () => {
		expect(observeSlackThreads(history([wireRow(ROOT)]), { maxRoots: 1 })).toEqual([]);
		expect(
			observeSlackThreads(history([wireRow(ROOT, { reply_count: 0 })]), { maxRoots: 1 }),
		).toEqual([]);
	});

	it("accepts the actual 500-row bound and refuses a root budget that would silently drop work", () => {
		const page = history(
			Array.from({ length: MAX_CHANGES }, (_, at) =>
				wireRow(`1800000000.${String(at).padStart(9, "0")}`, { reply_count: 1 }),
			),
		);
		expect(observeSlackThreads(page, { maxRoots: 500 })).toHaveLength(500);
		expect(() => observeSlackThreads(page, { maxRoots: 499 })).toThrow("SLACK_THREADS_INVALID");
	});

	it.each([0, 501, 1.5, Number.NaN])("refuses invalid root-work bound %s", (maxRoots) => {
		expect(() => observeSlackThreads(history([]), { maxRoots })).toThrow("SLACK_THREADS_INVALID");
	});

	it.each([
		{ replyCounts: [{ ts: ROOT2, count: 1 }] },
		{
			replyCounts: [
				{ ts: ROOT, count: 1 },
				{ ts: ROOT, count: 1 },
			],
		},
		{ replyCounts: [{ ts: ROOT, count: -1 }] },
		{ replyCounts: [{ ts: ROOT, count: 1.5 }] },
	])("refuses orphan, duplicate, or invalid count data atomically", ({ replyCounts }) => {
		const page = { ...history([wireRow(ROOT)]), replyCounts };
		expect(() => observeSlackThreads(page, { maxRoots: 1 })).toThrow("SLACK_THREADS_INVALID");
	});

	it("does not reclassify a reply with a positive count as an observed root", () => {
		const page = history([wireRow(REPLY, { thread_ts: ROOT, reply_count: 1 })]);
		expect(() => observeSlackThreads(page, { maxRoots: 1 })).toThrow("SLACK_THREADS_INVALID");
	});

	it("detaches routing scalars without reading unselected content or metadata", () => {
		const source = history([wireRow(ROOT, { reply_count: 1 })]);
		let hooks = 0;
		const row = { ...source.changes[0] };
		Object.defineProperty(row, "text", {
			enumerable: true,
			get() {
				hooks++;
				throw new Error("DYTEST unread text");
			},
		});
		const page = { ...source, changes: [row] };
		Object.defineProperty(page, "extra", {
			get() {
				hooks++;
				throw new Error("DYTEST unread metadata");
			},
		});
		const result = observeSlackThreads(page as SlackReadPage, { maxRoots: 1 });
		row.channelId = "CDYTEST2";
		expect(result).toEqual([root()]);
		expect(hooks).toBe(0);
	});

	it("refuses requested accessors and proxies without executing their hooks", () => {
		let hooks = 0;
		const source = history([wireRow(ROOT, { reply_count: 1 })]);
		const accessor = Object.defineProperty({ ...source }, "replyCounts", {
			enumerable: true,
			get() {
				hooks++;
				throw new Error("DYTEST getter");
			},
		});
		const proxy = new Proxy(source, {
			get() {
				hooks++;
				throw new Error("DYTEST get");
			},
			getPrototypeOf() {
				hooks++;
				throw new Error("DYTEST prototype");
			},
			getOwnPropertyDescriptor() {
				hooks++;
				throw new Error("DYTEST descriptor");
			},
		});
		for (const input of [accessor, proxy])
			expect(() => observeSlackThreads(input, { maxRoots: 1 })).toThrow("SLACK_THREADS_INVALID");
		expect(hooks).toBe(0);
	});
});

describe("Slack single observed-thread polling", () => {
	it("reads genuine paginated replies without treating the observed count as a cap", async () => {
		const fake = createSlackReadFake({
			conversations: [
				{
					id: CHANNEL,
					name: "dytest-thread",
					kind: "public_channel",
					member: true,
					archived: false,
					sharing: "none",
					memberCount: 1,
				},
			],
		});
		fake.addMessage(CHANNEL, { ts: ROOT, user: "UDYTEST1", text: "DYTEST root" });
		fake.addMessage(CHANNEL, { ts: REPLY, user: "UDYTEST1", text: "DYTEST first", threadTs: ROOT });
		const owned = sdk((url, init) => {
			expect(url.origin).toBe("https://slack.com");
			const local = new URL(url);
			local.hostname = SLACK_READ_HOST;
			return fake.fetch(local, init);
		});
		const historyPages = pollMessages(owned.context, {
			kind: "history",
			channelId: CHANNEL,
			maxPages: 1,
		});
		const first = await historyPages.next();
		if (first.done) throw new Error("DYTEST expected history page");
		const [thread] = observeSlackThreads(first.value, { maxRoots: 1 });
		await historyPages.return();
		if (!thread) throw new Error("DYTEST expected observed thread");
		expect(thread.replyCount).toBe(1);
		for (let at = 2; at <= 101; at++)
			fake.addMessage(CHANNEL, {
				ts: `1800000001.${String(at).padStart(9, "0")}`,
				user: "UDYTEST1",
				text: "DYTEST later",
				threadTs: ROOT,
			});
		const pages = pollObservedThread(owned.context, thread, { maxPages: 3 });
		expect(owned.requests).toHaveLength(1);
		const page1 = await pages.next();
		if (page1.done) throw new Error("DYTEST expected replies page");
		expect(page1.value).toMatchObject({ ...root(), page: { more: true } });
		expect(page1.value.page.changes).toHaveLength(100);
		const cursor = page1.value.page.nextCursor;
		await turn();
		expect(owned.requests).toHaveLength(2);
		const page2 = await pages.next();
		if (page2.done) throw new Error("DYTEST expected remaining replies");
		expect(page2.value.page.changes).toHaveLength(2);
		expect(page2.value.page.more).toBe(false);
		expect((await pages.next()).done).toBe(true);
		expect(fake.recorder.takeRequests().map((entry) => entry.path)).toEqual([
			"/api/conversations.history",
			"/api/conversations.replies",
			"/api/conversations.replies",
		]);
		const query = new URL(owned.requests[2]?.params.url ?? "").searchParams;
		expect(Object.fromEntries(query)).toEqual({ channel: CHANNEL, limit: "100", ts: ROOT, cursor });
		for (const { params, signal } of owned.requests) {
			expect(params).toMatchObject({ method: "GET", stream: true, headers: [] });
			expect(params).not.toHaveProperty("sendTicket");
			expect(signal?.aborted).toBe(true);
		}
		expect(owned.shared.signal.aborted).toBe(false);
	});

	it("captures a root and opaque resume cursor before any provider I/O", async () => {
		const owned = sdk(() => Response.json(wirePage([wireRow(ROOT)])));
		const thread = { ...root() },
			options = { cursor: "opaque+/&=", maxPages: 1 };
		const pages = pollObservedThread(owned.context, thread, options);
		thread.channelId = "CDYTEST2";
		thread.threadTs = ROOT2;
		options.cursor = "changed";
		expect(owned.requests).toEqual([]);
		const result = await collect(pages);
		expect(result[0]).toMatchObject(root());
		expect(Object.fromEntries(new URL(owned.requests[0]?.params.url ?? "").searchParams)).toEqual({
			channel: CHANNEL,
			limit: "100",
			ts: ROOT,
			cursor: "opaque+/&=",
		});
	});

	it.each([undefined, "dytest-next"])(
		"preserves incomplete pages at a missing cursor or page cap",
		async (cursor) => {
			const owned = sdk(() => Response.json(wirePage([], cursor ?? "", true)));
			const result = await collect(pollObservedThread(owned.context, root(), { maxPages: 1 }));
			expect(result).toHaveLength(1);
			expect(result[0]?.page).toMatchObject({ more: true, nextCursor: cursor });
			expect(owned.requests).toHaveLength(1);
		},
	);

	it("does not force extra reads to satisfy a stale large reply count", async () => {
		const owned = sdk(() => Response.json(wirePage([wireRow(ROOT)])));
		const result = await collect(
			pollObservedThread(owned.context, root(Number.MAX_SAFE_INTEGER), { maxPages: 3 }),
		);
		expect(result[0]?.page.more).toBe(false);
		expect(owned.requests).toHaveLength(1);
	});

	it("refuses a repeated provider cursor before yielding its page", async () => {
		const owned = sdk(() => Response.json(wirePage([wireRow(ROOT)], "dytest-resume")));
		const pages = pollObservedThread(owned.context, root(), {
			cursor: "dytest-resume",
			maxPages: 2,
		});
		await expect(pages.next()).rejects.toThrow("SLACK_THREADS_INVALID");
		expect(owned.requests).toHaveLength(1);
	});

	it.each([
		wireRow(REPLY),
		wireRow(REPLY, { thread_ts: ROOT2 }),
		wireRow(ROOT, { thread_ts: ROOT2 }),
	])("refuses an unbound or conflicting thread row before yielding", async (row) => {
		const owned = sdk(() => Response.json(wirePage([row])));
		await expect(pollObservedThread(owned.context, root(), { maxPages: 1 }).next()).rejects.toThrow(
			"SLACK_THREADS_INVALID",
		);
		expect(owned.requests).toHaveLength(1);
	});

	it("stops owned work on consumer return without prefetching or aborting the caller", async () => {
		const owned = sdk(() => Response.json(wirePage([wireRow(ROOT)], "dytest-next")));
		const pages = pollObservedThread(owned.context, root(), { maxPages: 2 });
		await pages.next();
		await pages.return();
		await turn();
		expect(owned.requests).toHaveLength(1);
		expect(owned.shared.signal.aborted).toBe(false);
	});

	it("does not emit a page when the caller aborts during genuine SDK cleanup", async () => {
		const cleanupSeen = gate(),
			cleanupGate = gate();
		const owned = sdk(() => Response.json(wirePage([wireRow(ROOT)])), { cleanupSeen, cleanupGate });
		const pending = pollObservedThread(owned.context, root(), { maxPages: 1 }).next();
		const refused = expect(pending).rejects.toThrow("SLACK_THREADS_ABORTED");
		await cleanupSeen.promise;
		expect(owned.cleanupAbort).toEqual([true]);
		owned.shared.abort();
		cleanupGate.release();
		await refused;
		expect(owned.requests).toHaveLength(1);
	});

	it("does no host work when already aborted", async () => {
		const owned = sdk(() => Response.json(wirePage([wireRow(ROOT)])));
		owned.shared.abort();
		await expect(pollObservedThread(owned.context, root(), { maxPages: 1 }).next()).rejects.toThrow(
			"SLACK_THREADS_ABORTED",
		);
		expect(owned.requests).toEqual([]);
	});

	it("refuses invalid roots or page bounds synchronously before provider work", () => {
		const owned = sdk(() => Response.json(wirePage([])));
		for (const thread of [
			{ ...root(), replyCount: 0 },
			{ ...root(), threadTs: "bad" },
		])
			expect(() => pollObservedThread(owned.context, thread, { maxPages: 1 })).toThrow(
				"SLACK_THREADS_INVALID",
			);
		for (const maxPages of [0, 129, 1.5])
			expect(() => pollObservedThread(owned.context, root(), { maxPages })).toThrow(
				"SLACK_THREADS_INVALID",
			);
		expect(owned.requests).toEqual([]);
	});
});
