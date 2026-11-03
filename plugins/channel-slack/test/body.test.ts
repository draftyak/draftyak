import { createSlackReadFake, SLACK_READ_HOST, type SlackReadFake } from "@draftyak/fakes/slack";
import type { MessageRef } from "@draftyak/protocol/channel-v1";
import type { HostFetchParams, HostMethod, HostMethods } from "@draftyak/protocol/host-channel";
import { createPluginContext, type PluginContext } from "@draftyak/sdk/context";
import type { HostFetch } from "@draftyak/sdk/fetch";
import { type HostRequestOptions, type MemoryHost, memoryHost } from "@draftyak/sdk/host";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fetchSlackMessageBody } from "../src/body.ts";
import { reduceMessagesPage } from "../src/reduce.ts";

const CHANNEL = "CDYTEST1";
const ROOT = "1800000000.000000001";
const REPLY = "1800000001.000000002";
const SIBLING = "1800000001.000000003";
const messageRef = (ts = ROOT): MessageRef => ({ kind: "chat", channelId: CHANNEL, ts });
const observed = (ts = REPLY, threadTs = ROOT) => ({ channelId: CHANNEL, ts, threadTs });
const row = (ts = ROOT, extra: Record<string, unknown> = {}) => ({
	type: "message",
	ts,
	user: "UDYTEST1",
	text: "DYTEST body",
	...extra,
});
const page = (messages: unknown[] = [], cursor = "", more = cursor !== "") => ({
	ok: true,
	messages,
	has_more: more,
	response_metadata: { next_cursor: cursor },
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
interface Controls {
	readonly headersSeen?: Gate;
	readonly headerGate?: Gate;
	readonly cleanupSeen?: Gate;
	readonly cleanupGate?: Gate;
}
interface Fixture {
	readonly context: Pick<PluginContext, "fetch" | "signal">;
	readonly shared: AbortController;
	readonly requests: Trace[];
	readonly methods: HostMethod[];
	readonly cleanupAbort: boolean[];
	readonly host: MemoryHost;
	close(): void;
}
const fixtures: Fixture[] = [];
const network = vi.fn<typeof fetch>();
type Serve = (url: URL, init: RequestInit) => Response | Promise<Response>;

/** Small in-memory responses still cross the actual SDK host schemas and body reader. */
function sdk(serve: Serve, controls: Controls = {}): Fixture {
	const shared = new AbortController();
	const requests: Trace[] = [];
	const methods: HostMethod[] = [];
	const cleanupAbort: boolean[] = [];
	const host = memoryHost(async (method, raw, signal) => {
		methods.push(method);
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
	const originalRequest = host.request;
	host.request = function <M extends HostMethod>(
		method: M,
		params: HostMethods[M]["params"],
		options?: HostRequestOptions,
	): Promise<HostMethods[M]["result"]> {
		if (method === "host/fetch")
			requests.push({ params: params as HostFetchParams, signal: options?.signal });
		return Reflect.apply(originalRequest, this, [method, params, options]);
	};
	const original = createPluginContext(
		{ plugin: "channel-slack", account: "dytest" },
		host,
		shared.signal,
	);
	const fetch: HostFetch = async (...args) => {
		const response = await Reflect.apply(original.fetch, original, args);
		if ((controls.cleanupSeen || controls.cleanupGate) && response.body !== null) {
			const body = response.body;
			const getReader = body.getReader.bind(body);
			Object.defineProperty(body, "getReader", {
				configurable: true,
				value: () => {
					const reader = getReader();
					const cancel = reader.cancel.bind(reader);
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
		controls.headersSeen?.release();
		await controls.headerGate?.promise;
		return response;
	};
	const result: Fixture = {
		context: Object.freeze({ fetch, signal: original.signal }),
		shared,
		requests,
		methods,
		cleanupAbort,
		host,
		close() {
			controls.headerGate?.release();
			controls.cleanupGate?.release();
			shared.abort();
			host.close();
		},
	};
	fixtures.push(result);
	return result;
}
function fakeSlack(): SlackReadFake {
	return createSlackReadFake({
		conversations: [
			{
				id: CHANNEL,
				name: "dytest-body",
				kind: "public_channel",
				member: true,
				archived: false,
				sharing: "none",
				memberCount: 1,
			},
		],
	});
}
function through(fake: SlackReadFake): Fixture {
	return sdk((url, init) => {
		expect(url.origin).toBe("https://slack.com");
		const local = new URL(url);
		local.hostname = SLACK_READ_HOST;
		return fake.fetch(local, init);
	});
}
function request(fixture: Fixture, at = 0): URL {
	const trace = fixture.requests[at];
	if (!trace) throw new Error("DYTEST missing request");
	expect(trace.params).toMatchObject({ method: "GET", headers: [], stream: true });
	for (const key of ["body", "saveAs", "sendTicket", "lookupPermit"])
		expect(trace.params).not.toHaveProperty(key);
	return new URL(trace.params.url);
}

beforeEach(() => {
	network.mockReset();
	network.mockRejectedValue(new Error("DYTEST network forbidden"));
	vi.stubGlobal("fetch", network);
});
afterEach(async () => {
	try {
		for (const fixture of fixtures.splice(0)) {
			fixture.close();
			expect(fixture.methods.every((method) => method === "host/fetch")).toBe(true);
		}
		await Promise.resolve();
		expect(network).not.toHaveBeenCalled();
	} finally {
		vi.unstubAllGlobals();
	}
});

describe("Slack exact message bodies", () => {
	it("reads an exact genuine history body with inclusive nanosecond bounds", async () => {
		const fake = fakeSlack();
		fake.addMessage(CHANNEL, { ts: ROOT, user: "UDYTEST1", text: "DYTEST exact \u{1f642}" });
		fake.addMessage(CHANNEL, { ts: REPLY, user: "UDYTEST1", text: "DYTEST other" });
		const owned = through(fake);
		const result = await fetchSlackMessageBody(owned.context, messageRef());
		expect(result).toEqual({
			kind: "chat.message",
			channelId: CHANNEL,
			ts: ROOT,
			sentAt: 1800000000000,
			author: { kind: "user", id: "UDYTEST1" },
			text: "DYTEST exact \u{1f642}",
		});
		expect(Object.isFrozen(result)).toBe(true);
		expect(Object.isFrozen(result.author)).toBe(true);
		expect(owned.requests).toHaveLength(1);
		const url = request(owned);
		expect(url.pathname).toBe("/api/conversations.history");
		expect(Object.fromEntries(url.searchParams)).toEqual({
			channel: CHANNEL,
			limit: "100",
			oldest: ROOT,
			latest: ROOT,
			inclusive: "true",
		});
		expect(fake.recorder.takeRequests().map((entry) => entry.path)).toEqual([
			"/api/conversations.history",
		]);
		expect(owned.requests[0]?.signal?.aborted).toBe(true);
		expect(owned.shared.signal.aborted).toBe(false);
	});

	it("routes a genuine reply only using the matching previously observed root", async () => {
		const fake = fakeSlack();
		fake.addMessage(CHANNEL, { ts: ROOT, user: "UDYTEST1", text: "DYTEST root" });
		fake.addMessage(CHANNEL, { ts: REPLY, user: "UDYTEST1", text: "DYTEST reply", threadTs: ROOT });
		const owned = through(fake);
		const result = await fetchSlackMessageBody(owned.context, messageRef(REPLY), observed());
		expect(result).toMatchObject({ ts: REPLY, threadTs: ROOT, text: "DYTEST reply" });
		expect(owned.requests).toHaveLength(1);
		const url = request(owned);
		expect(url.pathname).toBe("/api/conversations.replies");
		expect(Object.fromEntries(url.searchParams)).toEqual({
			channel: CHANNEL,
			limit: "100",
			ts: ROOT,
			oldest: REPLY,
			latest: REPLY,
			inclusive: "true",
		});
		expect(fake.recorder.takeRequests().map((entry) => entry.path)).toEqual([
			"/api/conversations.replies",
		]);
	});

	it("does not guess a reply root or report a history miss as absence", async () => {
		const fake = fakeSlack();
		fake.addMessage(CHANNEL, { ts: ROOT, user: "UDYTEST1", text: "DYTEST root" });
		fake.addMessage(CHANNEL, { ts: REPLY, user: "UDYTEST1", text: "DYTEST reply", threadTs: ROOT });
		const owned = through(fake);
		await expect(fetchSlackMessageBody(owned.context, messageRef(REPLY))).rejects.toMatchObject({
			result: { code: "TRANSIENT" },
		});
		expect(owned.requests).toHaveLength(1);
		expect(request(owned).pathname).toBe("/api/conversations.history");
	});

	it("captures routing data before awaiting the provider", async () => {
		const owned = sdk(() => Response.json(page([row(REPLY, { thread_ts: ROOT })])));
		const target: { kind: "chat"; channelId: string; ts: string } = {
			kind: "chat",
			channelId: CHANNEL,
			ts: REPLY,
		};
		const route = observed();
		const pending = fetchSlackMessageBody(owned.context, target, route);
		target.ts = SIBLING;
		route.threadTs = SIBLING;
		expect((await pending).ts).toBe(REPLY);
		expect(request(owned).searchParams.get("ts")).toBe(ROOT);
		expect(request(owned).searchParams.get("oldest")).toBe(REPLY);
	});

	it.each([
		{ channelId: "CDYTEST2", ts: REPLY, threadTs: ROOT },
		{ channelId: CHANNEL, ts: SIBLING, threadTs: ROOT },
		{ channelId: CHANNEL, ts: REPLY, threadTs: "not-a-timestamp" },
	])("refuses a mismatched or invalid observed tuple before host work", (route) => {
		const owned = sdk(() => Response.json(page()));
		expect(() => fetchSlackMessageBody(owned.context, messageRef(REPLY), route)).toThrow(
			"INVALID_INPUT",
		);
		expect(owned.requests).toEqual([]);
	});

	it("refuses unsupported or malformed message references before host work", () => {
		const owned = sdk(() => Response.json(page()));
		expect(() =>
			fetchSlackMessageBody(owned.context, { kind: "email", providerId: "DYTEST" }),
		).toThrow("UNSUPPORTED");
		expect(() => fetchSlackMessageBody(owned.context, messageRef("bad"))).toThrow("INVALID_INPUT");
		expect(owned.requests).toEqual([]);
	});

	it("refuses observed routing accessors and proxies without invoking their hooks", () => {
		const owned = sdk(() => Response.json(page()));
		let hooks = 0;
		const accessor = Object.defineProperty(observed(), "threadTs", {
			enumerable: true,
			get() {
				hooks++;
				throw new Error("DYTEST unread routing getter");
			},
		});
		const proxy = new Proxy(observed(), {
			get() {
				hooks++;
				throw new Error("DYTEST unread routing proxy");
			},
			getPrototypeOf() {
				hooks++;
				throw new Error("DYTEST unread routing prototype");
			},
			getOwnPropertyDescriptor() {
				hooks++;
				throw new Error("DYTEST unread routing descriptor");
			},
		});
		for (const route of [accessor, proxy])
			expect(() => fetchSlackMessageBody(owned.context, messageRef(REPLY), route)).toThrow(
				"INVALID_INPUT",
			);
		expect(hooks).toBe(0);
		expect(owned.requests).toEqual([]);
	});

	it("returns NOT_FOUND only for a completed observed-thread search", async () => {
		const owned = sdk(() => Response.json(page([row(SIBLING, { thread_ts: ROOT })])));
		await expect(
			fetchSlackMessageBody(owned.context, messageRef(REPLY), observed()),
		).rejects.toMatchObject({ result: { code: "NOT_FOUND" } });
		expect(owned.requests).toHaveLength(1);
	});

	it("refuses a matching timestamp reported under a different thread", async () => {
		const owned = sdk(() =>
			Response.json(page([row(REPLY, { thread_ts: "1799999999.000000001" })])),
		);
		await expect(
			fetchSlackMessageBody(owned.context, messageRef(REPLY), observed()),
		).rejects.toMatchObject({ result: { code: "TRANSIENT" } });
	});

	it("refuses conflicting thread metadata for an observed root", async () => {
		const otherRoot = "1799999999.000000001";
		const response = page([row(ROOT, { thread_ts: otherRoot })]);
		// This is a valid provider row: the body correlation guard must refuse it.
		expect(reduceMessagesPage(CHANNEL, response).changes[0]).toMatchObject({
			ts: ROOT,
			threadTs: otherRoot,
		});
		const owned = sdk(() => Response.json(response));
		await expect(
			fetchSlackMessageBody(owned.context, messageRef(ROOT), observed(ROOT, ROOT)),
		).rejects.toMatchObject({ result: { code: "TRANSIENT" } });
		expect(owned.requests).toHaveLength(1);
		expect(request(owned).pathname).toBe("/api/conversations.replies");
		expect(request(owned).searchParams.get("ts")).toBe(ROOT);
	});

	it.each([
		{ name: "omitted", metadata: {} },
		{ name: "self", metadata: { thread_ts: ROOT } },
	])("returns an observed root with $name thread metadata", async ({ name, metadata }) => {
		const owned = sdk(() => Response.json(page([row(ROOT, metadata)])));
		const result = await fetchSlackMessageBody(
			owned.context,
			messageRef(ROOT),
			observed(ROOT, ROOT),
		);
		expect(result).toMatchObject({ channelId: CHANNEL, ts: ROOT, text: "DYTEST body" });
		if (name === "omitted") expect(result).not.toHaveProperty("threadTs");
		else expect(result.threadTs).toBe(ROOT);
		expect(owned.requests).toHaveLength(1);
		expect(Object.fromEntries(request(owned).searchParams)).toEqual({
			channel: CHANNEL,
			limit: "100",
			ts: ROOT,
			oldest: ROOT,
			latest: ROOT,
			inclusive: "true",
		});
	});

	it.each([
		() => Response.json({ ok: false, error: "DYTEST provider refusal" }),
		() => Response.json(page(), { status: 429 }),
		() => Response.json(page([], "", true)),
		() => new Response("{", { headers: { "content-type": "application/json" } }),
	])("does not turn provider errors or incomplete pages into NOT_FOUND", async (response) => {
		const owned = sdk(response);
		await expect(
			fetchSlackMessageBody(owned.context, messageRef(REPLY), observed()),
		).rejects.toMatchObject({ result: { code: "TRANSIENT" } });
		expect(owned.requests).toHaveLength(1);
	});

	it("follows opaque continuation and refuses a cycle without claiming absence", async () => {
		const owned = sdk(() => Response.json(page([], "dytest-cycle")));
		await expect(
			fetchSlackMessageBody(owned.context, messageRef(REPLY), observed()),
		).rejects.toMatchObject({ result: { code: "TRANSIENT" } });
		expect(owned.requests).toHaveLength(2);
		expect(request(owned, 1).searchParams.get("cursor")).toBe("dytest-cycle");
	});

	it("does not expand an unresolved history lookup beyond its single-page bound", async () => {
		const owned = sdk(() => Response.json(page([], "dytest-more-history")));
		await expect(fetchSlackMessageBody(owned.context, messageRef(REPLY))).rejects.toMatchObject({
			result: { code: "TRANSIENT" },
		});
		expect(owned.requests).toHaveLength(1);
		expect(request(owned).pathname).toBe("/api/conversations.history");
	});

	it("keeps a search incomplete when its finite 128-page bound is exhausted", async () => {
		let pages = 0;
		const owned = sdk(() => Response.json(page([], `dytest-${++pages}`)));
		await expect(
			fetchSlackMessageBody(owned.context, messageRef(REPLY), observed()),
		).rejects.toMatchObject({ result: { code: "TRANSIENT" } });
		expect(owned.requests).toHaveLength(128);
		expect(request(owned, 127).searchParams.get("cursor")).toBe("dytest-127");
	});

	it("does not return a valid body released after the shared caller aborts", async () => {
		const headersSeen = gate(),
			headerGate = gate();
		const owned = sdk(() => Response.json(page([row()])), { headersSeen, headerGate });
		const pending = fetchSlackMessageBody(owned.context, messageRef());
		const refused = expect(pending).rejects.toMatchObject({ result: { code: "TRANSIENT" } });
		await headersSeen.promise;
		owned.shared.abort();
		headerGate.release();
		await refused;
		expect(owned.requests).toHaveLength(1);
	});

	it("does not return a valid body after genuine SDK cleanup awaits caller cancellation", async () => {
		const cleanupSeen = gate(),
			cleanupGate = gate();
		const owned = sdk(() => Response.json(page([row()])), { cleanupSeen, cleanupGate });
		const pending = fetchSlackMessageBody(owned.context, messageRef());
		const refused = expect(pending).rejects.toMatchObject({ result: { code: "TRANSIENT" } });
		await cleanupSeen.promise;
		expect(owned.cleanupAbort).toEqual([true]);
		expect(owned.shared.signal.aborted).toBe(false);
		owned.shared.abort();
		cleanupGate.release();
		await refused;
		expect(owned.requests).toHaveLength(1);
	});

	it("does no host work when already cancelled", async () => {
		const owned = sdk(() => Response.json(page([row()])));
		owned.shared.abort();
		await expect(fetchSlackMessageBody(owned.context, messageRef())).rejects.toMatchObject({
			result: { code: "TRANSIENT" },
		});
		expect(owned.requests).toEqual([]);
	});
});
