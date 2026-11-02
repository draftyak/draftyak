import { createSlackReadFake, SLACK_READ_HOST, type SlackReadFake } from "@draftyak/fakes/slack";
import {
	HOST_MAX_STREAM_BYTES,
	type HostFetchParams,
	type HostMethod,
	type HostMethods,
	HostStreamChunk,
} from "@draftyak/protocol/host-channel";
import { BlobRef } from "@draftyak/protocol/normalized-change";
import { createPluginContext, type PluginContext } from "@draftyak/sdk/context";
import { type HostRequestOptions, type MemoryHost, memoryHost } from "@draftyak/sdk/host";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MAX_SLACK_POLL_PAGES, pollMessages, type SlackPollRequest } from "../src/poll.ts";
import type { SlackReadPage } from "../src/reduce.ts";

const CHANNEL = "CDYTEST1";
const ROOT = "1800000000.123456789";
const API = "https://slack.com";
const turn = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));
const history = (overrides: Record<string, unknown> = {}): SlackPollRequest =>
	({ kind: "history", channelId: CHANNEL, maxPages: 4, ...overrides }) as SlackPollRequest;
const message = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
	type: "message",
	ts: ROOT,
	user: "UDYTEST1",
	text: "DYTEST message",
	...overrides,
});
const page = (messages: unknown[] = [message()], cursor = ""): Record<string, unknown> => ({
	ok: true,
	messages,
	has_more: cursor !== "",
	response_metadata: { next_cursor: cursor },
});
const json = (value: unknown): Response => Response.json(value);

interface RequestTrace {
	readonly params: HostFetchParams;
	readonly signal: AbortSignal | undefined;
}
type Serve = (url: URL, init: RequestInit, params: HostFetchParams) => Promise<Response> | Response;
interface BodyGate {
	readonly promise: Promise<void>;
	resolve(): void;
}
interface SDKHarness {
	readonly context: PluginContext;
	readonly shared: AbortController;
	readonly requests: RequestTrace[];
	readonly unexpected: HostMethod[];
	readonly pumps: Promise<void>[];
	readonly pumpErrors: unknown[];
	readonly host: MemoryHost;
	releaseBody(): void;
}
const harnesses: SDKHarness[] = [];
const network = vi.fn<typeof fetch>();

/** Only in-memory responses travel through the genuine SDK host protocol. */
function sdk(serve: Serve, inline = false, reference?: string, bodyGate?: BodyGate): SDKHarness {
	const shared = new AbortController();
	const requests: RequestTrace[] = [];
	const unexpected: HostMethod[] = [];
	const pumps: Promise<void>[] = [];
	const pumpErrors: unknown[] = [];
	let streamNumber = 0;
	const host = memoryHost(async (method, raw, signal) => {
		if (method !== "host/fetch") {
			unexpected.push(method);
			throw new Error("DYTEST unexpected host method");
		}
		const params = raw as HostFetchParams;
		const response = await serve(
			new URL(params.url),
			{
				method: params.method,
				headers: params.headers as [string, string][],
				signal,
			},
			params,
		);
		const bytes = Buffer.from(await response.arrayBuffer());
		const headers = [...response.headers.entries()];
		if (reference !== undefined)
			return { status: response.status, headers, body: { ref: reference } };
		if (inline)
			return { status: response.status, headers, body: { base64: bytes.toString("base64url") } };
		const streamId = `dytest-poll-${++streamNumber}`;
		const requestSignal = requests.at(-1)?.signal;
		const pump = async (): Promise<void> => {
			// Let the SDK bind the returned stream before delivering its body.
			await turn();
			await bodyGate?.promise;
			let sequence = 0;
			for (let offset = 0; offset < bytes.length; offset += 16_384) {
				if (shared.signal.aborted || requestSignal?.aborted) return;
				const chunk = HostStreamChunk.parse({
					streamId,
					sequence: sequence++,
					base64: bytes.subarray(offset, offset + 16_384).toString("base64url"),
					done: false,
				});
				host.notify({ jsonrpc: "2.0", method: "host/stream.chunk", params: chunk });
				await turn();
			}
			if (!shared.signal.aborted && !requestSignal?.aborted)
				host.notify({
					jsonrpc: "2.0",
					method: "host/stream.chunk",
					params: HostStreamChunk.parse({ streamId, sequence, base64: "", done: true }),
				});
		};
		pumps.push(
			pump().catch((error) => {
				pumpErrors.push(error);
				shared.abort(error);
			}),
		);
		return { status: response.status, headers, streamId };
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
	const context = createPluginContext(
		{ plugin: "channel-slack", account: "dytest-account" },
		host,
		shared.signal,
	);
	const result = {
		context,
		shared,
		requests,
		unexpected,
		pumps,
		pumpErrors,
		host,
		releaseBody: () => bodyGate?.resolve(),
	};
	harnesses.push(result);
	return result;
}

function fakeSlack(): SlackReadFake {
	return createSlackReadFake({
		conversations: [
			{
				id: CHANNEL,
				name: "dytest-channel",
				kind: "public_channel",
				member: true,
				archived: false,
				sharing: "none",
				memberCount: 1,
			},
		],
	});
}
function through(fake: SlackReadFake) {
	return sdk((url, init) => {
		expect(url.origin).toBe(API);
		const local = new URL(url);
		local.hostname = SLACK_READ_HOST;
		return fake.fetch(local, init);
	});
}
async function collect(iterator: AsyncGenerator<SlackReadPage, void>): Promise<SlackReadPage[]> {
	const result: SlackReadPage[] = [];
	for await (const value of iterator) result.push(value);
	return result;
}
function invalid(ctx: Pick<PluginContext, "fetch" | "signal">, input: unknown): void {
	expect(() => pollMessages(ctx, input as SlackPollRequest)).toThrow("SLACK_POLL_INVALID");
}

beforeEach(() => {
	network.mockReset();
	network.mockRejectedValue(new Error("DYTEST network forbidden"));
	vi.stubGlobal("fetch", network);
});
afterEach(async () => {
	try {
		const closing = harnesses.splice(0);
		for (const h of closing) {
			h.shared.abort();
			h.host.close();
			h.releaseBody();
		}
		await Promise.all(closing.flatMap((h) => h.pumps));
		for (const h of closing) {
			expect(h.pumpErrors).toEqual([]);
			expect(h.unexpected).toEqual([]);
		}
		expect(network).not.toHaveBeenCalled();
	} finally {
		vi.unstubAllGlobals();
	}
});

describe("Slack message polling", () => {
	it("lazily reads genuine Slack history and forwards its opaque cursor without prefetch", async () => {
		const fake = fakeSlack();
		for (let at = 0; at < 101; at++)
			fake.addMessage(CHANNEL, {
				ts: `1800000000.${String(at).padStart(9, "0")}`,
				user: "UDYTEST1",
				text: `DYTEST ${at}`,
			});
		const h = through(fake);
		const iterator = pollMessages(h.context, history());
		expect(h.requests).toHaveLength(0);
		const first = await iterator.next();
		expect(first.done).toBe(false);
		if (first.done) throw new Error("DYTEST expected first page");
		expect(first.value?.changes).toHaveLength(100);
		expect(first.value?.more).toBe(true);
		const cursor = first.value?.nextCursor;
		expect(cursor).toMatch(/^[0-9a-f]{32}$/);
		await turn();
		expect(h.requests).toHaveLength(1);
		const second = await iterator.next();
		if (second.done) throw new Error("DYTEST expected second page");
		expect(second.value?.changes).toHaveLength(1);
		expect(second.value?.more).toBe(false);
		expect((await iterator.next()).done).toBe(true);
		const recorded = fake.recorder.takeRequests();
		expect(recorded.map((r) => r.path)).toEqual([
			"/api/conversations.history",
			"/api/conversations.history",
		]);
		expect(new URLSearchParams(recorded[0]?.query).get("cursor")).toBeNull();
		expect(new URLSearchParams(recorded[1]?.query).get("cursor")).toBe(cursor);
		for (const { params, signal } of h.requests) {
			expect(params.method).toBe("GET");
			expect(params.stream).toBe(true);
			expect(params.body).toBeUndefined();
			expect(params.saveAs).toBeUndefined();
			expect(params.sendTicket).toBeUndefined();
			expect(new URL(params.url).searchParams.get("limit")).toBe("100");
			expect(signal?.aborted).toBe(true);
		}
		expect(h.shared.signal.aborted).toBe(false);
	});

	it("reads real replies with byte-exact nanosecond thread and watermark filters", async () => {
		const fake = fakeSlack();
		fake.addMessage(CHANNEL, { ts: ROOT, user: "UDYTEST1", text: "DYTEST root" });
		fake.addMessage(CHANNEL, {
			ts: "1800000001.000000001",
			user: "UDYTEST1",
			text: "DYTEST reply",
			threadTs: ROOT,
		});
		const h = through(fake);
		const result = await collect(
			pollMessages(h.context, {
				kind: "replies",
				channelId: CHANNEL,
				threadTs: ROOT,
				maxPages: 2,
				oldest: ROOT,
				latest: "1800000001.000000001",
				inclusive: true,
			}),
		);
		expect(result).toHaveLength(1);
		expect(result[0]?.changes).toHaveLength(2);
		const url = new URL(h.requests[0]?.params.url ?? "");
		expect(url.pathname).toBe("/api/conversations.replies");
		expect(Object.fromEntries(url.searchParams)).toEqual({
			channel: CHANNEL,
			limit: "100",
			ts: ROOT,
			oldest: ROOT,
			latest: "1800000001.000000001",
			inclusive: "true",
		});
	});

	it("captures the request at call time and returns without reading the network", async () => {
		const h = sdk(() => json(page()));
		const input = { kind: "history", channelId: CHANNEL, maxPages: 1, inclusive: false } as const;
		const mutable: { kind: "history"; channelId: string; maxPages: number; inclusive: boolean } = {
			...input,
		};
		const iterator = pollMessages(h.context, mutable);
		mutable.channelId = "CDYTEST2";
		mutable.maxPages = 2;
		expect(h.requests).toHaveLength(0);
		await collect(iterator);
		const url = new URL(h.requests[0]?.params.url ?? "");
		expect(url.searchParams.get("channel")).toBe(CHANNEL);
		expect(url.searchParams.get("inclusive")).toBe("false");
	});

	it("stops at the mechanical page budget while preserving incomplete data", async () => {
		const h = sdk(() => json(page([message()], "dytest-next")));
		const result = await collect(pollMessages(h.context, history({ maxPages: 1 })));
		expect(result).toHaveLength(1);
		expect(result[0]).toMatchObject({ more: true, nextCursor: "dytest-next" });
		expect(h.requests).toHaveLength(1);
	});

	it.each([undefined, ""])("preserves more without inventing a cursor (%s)", async (cursor) => {
		const h = sdk(() =>
			json({
				ok: true,
				messages: [message()],
				has_more: true,
				...(cursor === undefined ? {} : { response_metadata: { next_cursor: cursor } }),
			}),
		);
		const result = await collect(pollMessages(h.context, history()));
		expect(result[0]).toMatchObject({ more: true, nextCursor: undefined });
		expect(h.requests).toHaveLength(1);
	});

	it("follows a real continuation even when has_more is false", async () => {
		const h = sdk((url) =>
			json(
				url.searchParams.has("cursor")
					? page([])
					: {
							...page(),
							has_more: false,
							response_metadata: { next_cursor: "opaque+/%=&" },
						},
			),
		);
		const result = await collect(pollMessages(h.context, history()));
		expect(result).toHaveLength(2);
		expect(new URL(h.requests[1]?.params.url ?? "").searchParams.get("cursor")).toBe("opaque+/%=&");
	});

	it("refuses a cycle before delivering the repeated page", async () => {
		const h = sdk((url) => {
			const cursor = url.searchParams.get("cursor");
			return json(page([message()], cursor === "dytest-a" ? "dytest-b" : "dytest-a"));
		});
		const iterator = pollMessages(h.context, history());
		expect((await iterator.next()).done).toBe(false);
		expect((await iterator.next()).done).toBe(false);
		await expect(iterator.next()).rejects.toThrow("SLACK_POLL_INVALID");
		expect((await iterator.next()).done).toBe(true);
		expect(h.requests.map(({ params }) => new URL(params.url).searchParams.get("cursor"))).toEqual([
			null,
			"dytest-a",
			"dytest-b",
		]);
	});

	it("includes the caller's initial cursor in cycle detection", async () => {
		const h = sdk(() => json(page([message()], "dytest-initial")));
		const iterator = pollMessages(h.context, history({ cursor: "dytest-initial" }));
		await expect(iterator.next()).rejects.toThrow("SLACK_POLL_INVALID");
		expect(h.requests).toHaveLength(1);
	});

	it("supports the full finite page budget without falsely marking completion", async () => {
		expect(MAX_SLACK_POLL_PAGES).toBe(128);
		let count = 0;
		const h = sdk(() => json(page([], `dytest-${++count}`)));
		const result = await collect(
			pollMessages(h.context, history({ maxPages: MAX_SLACK_POLL_PAGES })),
		);
		expect(result).toHaveLength(128);
		expect(h.requests).toHaveLength(128);
		expect(result.at(-1)).toMatchObject({ more: true, nextCursor: "dytest-128" });
	});

	it("does not request another page when the consumer returns", async () => {
		const h = sdk(() => json(page([message()], "dytest-unused")));
		const iterator = pollMessages(h.context, history());
		await iterator.next();
		await iterator.return();
		await turn();
		expect(h.requests).toHaveLength(1);
		expect(h.shared.signal.aborted).toBe(false);
	});

	it("does not advance after a genuine revoked-credential response", async () => {
		const fake = fakeSlack();
		fake.revoke();
		const h = through(fake);
		const input = history();
		await expect(collect(pollMessages(h.context, input))).rejects.toThrow("SLACK_POLL_INVALID");
		expect(h.requests).toHaveLength(1);
		expect(input.cursor).toBeUndefined();
	});

	it("does not retry or advance a genuine rate-limited second page", async () => {
		const fake = createSlackReadFake({
			conversations: [
				{
					id: CHANNEL,
					name: "dytest-channel",
					kind: "public_channel",
					member: true,
					archived: false,
					sharing: "none",
					memberCount: 1,
				},
			],
			readBudget: { calls: 1, windowMs: 60_000 },
		});
		for (let at = 0; at < 101; at++)
			fake.addMessage(CHANNEL, {
				ts: `1800000000.${String(at).padStart(9, "0")}`,
				user: "UDYTEST1",
				text: "DYTEST rate fixture",
			});
		const h = through(fake);
		const iterator = pollMessages(h.context, history());
		const first = await iterator.next();
		if (first.done) throw new Error("DYTEST expected first page");
		await expect(iterator.next()).rejects.toThrow("SLACK_POLL_INVALID");
		await turn();
		expect(h.requests).toHaveLength(2);
		expect(new URL(h.requests[1]?.params.url ?? "").searchParams.get("cursor")).toBe(
			first.value.nextCursor,
		);
		expect((await iterator.next()).done).toBe(true);
	});

	it("accepts a legal 500-row SDK-streamed page larger than the fake's response cap", async () => {
		const rows = Array.from({ length: 500 }, (_, at) =>
			message({
				ts: `1800000000.${String(at).padStart(9, "0")}`,
				text: "D".repeat(600),
			}),
		);
		const body = page(rows);
		expect(Buffer.byteLength(JSON.stringify(body))).toBeGreaterThan(256 * 1024);
		const h = sdk(() => json(body));
		const result = await collect(pollMessages(h.context, history()));
		expect(result).toHaveLength(1);
		expect(result[0]?.changes).toHaveLength(500);
		expect(new URL(h.requests[0]?.params.url ?? "").searchParams.get("limit")).toBe("100");
	});

	it("keeps 40,000 astral code points across real SDK stream chunk boundaries", async () => {
		const text = "\u{1F680}".repeat(40_000);
		const h = sdk(() => json(page([message({ text })])));
		const result = await collect(pollMessages(h.context, history()));
		expect(result[0]?.changes).toEqual([expect.objectContaining({ text })]);
	});

	it("refuses a response beyond the SDK stream bound without yielding or advancing", async () => {
		// This checks the real SDK bound, not sensitivity of the poller's duplicate byte counter.
		const payload = JSON.stringify({
			...page([], "dytest-too-large"),
			harmless: "D".repeat(HOST_MAX_STREAM_BYTES),
		});
		expect(Buffer.byteLength(payload)).toBeGreaterThan(HOST_MAX_STREAM_BYTES);
		const h = sdk(() => new Response(payload, { headers: { "content-type": "application/json" } }));
		const input = history({ cursor: "dytest-before" });
		const iterator = pollMessages(h.context, input);
		await expect(iterator.next()).rejects.toThrow("SLACK_POLL_INVALID");
		expect((await iterator.next()).done).toBe(true);
		expect(h.requests).toHaveLength(1);
		expect(input.cursor).toBe("dytest-before");
	});

	it("refuses a genuine channel close after headers while its SDK body is pending", async () => {
		const body = Promise.withResolvers<void>();
		const headers = Promise.withResolvers<void>();
		const h = sdk(() => json(page([message()], "dytest-after-close")), false, undefined, body);
		const ctx = {
			signal: h.context.signal,
			async fetch(...args: Parameters<PluginContext["fetch"]>) {
				const response = await h.context.fetch(...args);
				headers.resolve();
				return response;
			},
		};
		const input = history({ cursor: "dytest-before" });
		const iterator = pollMessages(ctx, input);
		const pending = iterator.next();
		try {
			await headers.promise;
			h.host.close();
		} finally {
			body.resolve();
		}
		await expect(pending).rejects.toThrow("SLACK_POLL_INVALID");
		expect((await iterator.next()).done).toBe(true);
		expect(h.requests).toHaveLength(1);
		expect(input.cursor).toBe("dytest-before");
		expect(h.shared.signal.aborted).toBe(false);
	});

	it("projects harmless provider metadata while keeping returned data detached", async () => {
		const wire = {
			...page([{ ...message(), team: "DYTEST", blocks: [{ type: "ignored" }] }]),
			warning: { extra: [1, 2] },
			response_metadata: { next_cursor: "", harmless: "DYTEST" },
		};
		const h = sdk(() => json(wire));
		const result = await collect(pollMessages(h.context, history()));
		expect(result[0]?.changes).toEqual([expect.objectContaining({ text: "DYTEST message" })]);
		expect(result[0]?.changes[0]).not.toHaveProperty("team");
		expect(Object.isFrozen(result[0])).toBe(true);
		expect(Object.isFrozen(result[0]?.changes)).toBe(true);
		expect(Object.isFrozen(result[0]?.changes[0])).toBe(true);
	});

	it.each([
		["non-JSON media type", () => new Response("{}", { headers: { "content-type": "text/html" } })],
		[
			"malformed JSON",
			() => new Response('{"ok":', { headers: { "content-type": "application/json" } }),
		],
		[
			"invalid UTF-8",
			() => new Response(Uint8Array.of(0xff), { headers: { "content-type": "application/json" } }),
		],
		["provider refusal", () => json({ ok: false, error: "DYTEST refused" })],
		[
			"malformed row",
			() =>
				json(page([message(), { ...message({ ts: "1800000001.0" }), files: [] }], "dytest-poison")),
		],
	] as const)("refuses %s without yielding or advancing the bad page", async (_, response) => {
		const h = sdk(() => response());
		const input = history({ cursor: "dytest-before" });
		const iterator = pollMessages(h.context, input);
		await expect(iterator.next()).rejects.toThrow("SLACK_POLL_INVALID");
		expect((await iterator.next()).done).toBe(true);
		expect(h.requests).toHaveLength(1);
		expect(input.cursor).toBe("dytest-before");
	});

	it("refuses a genuine SDK blob response instead of treating its reference as JSON", async () => {
		const reference = BlobRef.parse({ ref: "01ARZ3NDEKTSV4RRFFQ69G5FAV" }).ref;
		const h = sdk(() => json(page()), false, reference);
		const response = await h.context.fetch(`${API}/api/conversations.history`, { stream: true });
		expect(response.bodyRef).toEqual({ ref: reference });
		expect(response.body).toBeNull();
		await expect(collect(pollMessages(h.context, history()))).rejects.toThrow("SLACK_POLL_INVALID");
	});

	it("aborts its own page before cancelling a refused genuine SDK body", async () => {
		const h = sdk(() => Response.json({ ok: false }, { status: 429 }));
		const observations: boolean[] = [];
		const ctx = {
			signal: h.context.signal,
			async fetch(...args: Parameters<PluginContext["fetch"]>) {
				const response = await h.context.fetch(...args);
				const body = response.body;
				if (!body) throw new Error("DYTEST expected response body");
				const cancel = body.cancel;
				body.cancel = function (...arguments_: Parameters<typeof cancel>) {
					observations.push(h.requests.at(-1)?.signal?.aborted === true);
					return Reflect.apply(cancel, this, arguments_);
				};
				return response;
			},
		};
		await expect(collect(pollMessages(ctx, history()))).rejects.toThrow("SLACK_POLL_INVALID");
		expect(observations).toEqual([true]);
		expect(h.shared.signal.aborted).toBe(false);
	});

	it("rejects an inline page released after the shared invocation aborts", async () => {
		const h = sdk(() => json(page([message()], "dytest-late-cursor")), true);
		const headers = Promise.withResolvers<void>();
		const release = Promise.withResolvers<void>();
		const ctx = {
			signal: h.context.signal,
			async fetch(...args: Parameters<PluginContext["fetch"]>) {
				const response = await h.context.fetch(...args);
				headers.resolve();
				await release.promise;
				return response;
			},
		};
		const input = history({ cursor: "dytest-before" });
		const iterator = pollMessages(ctx, input);
		const pending = iterator.next();
		await headers.promise;
		h.shared.abort();
		release.resolve();
		await expect(pending).rejects.toThrow("SLACK_POLL_ABORTED");
		expect((await iterator.next()).done).toBe(true);
		expect(h.requests).toHaveLength(1);
		expect(input.cursor).toBe("dytest-before");
		expect(h.requests[0]?.signal?.aborted).toBe(true);
	});

	it("does not dispatch when already cancelled", async () => {
		const h = sdk(() => json(page()));
		h.shared.abort();
		await expect(collect(pollMessages(h.context, history()))).rejects.toThrow("SLACK_POLL_ABORTED");
		expect(h.requests).toHaveLength(0);
	});

	it("cancels a pending genuine SDK request without retry", async () => {
		const entered = Promise.withResolvers<void>();
		const h = sdk((_, init) => {
			entered.resolve();
			return new Promise<Response>((_, reject) => {
				init.signal?.addEventListener("abort", () => reject(init.signal?.reason), { once: true });
			});
		});
		const pending = collect(pollMessages(h.context, history()));
		await entered.promise;
		h.shared.abort();
		await expect(pending).rejects.toThrow("SLACK_POLL_ABORTED");
		expect(h.requests).toHaveLength(1);
		expect(h.requests[0]?.signal?.aborted).toBe(true);
	});
});

describe("Slack polling request capture", () => {
	it.each([0, -1, 129, 1.5, Number.NaN, Number.POSITIVE_INFINITY])(
		"refuses invalid maxPages %s synchronously",
		(maxPages) => {
			const h = sdk(() => json(page()));
			invalid(h.context, history({ maxPages }));
			expect(h.requests).toHaveLength(0);
		},
	);

	it.each([
		{ kind: "other" },
		{ channelId: "" },
		{ channelId: "x".repeat(257) },
		{ cursor: "bad\ncursor" },
		{ cursor: "x".repeat(4097) },
		{ inclusive: "true" },
		{ oldest: "1800000000" },
		{ latest: "9007199254740.992" },
		{ oldest: "1800000000.000000002", latest: "1800000000.000000001" },
		{ kind: "replies" },
		{ kind: "replies", threadTs: "bad" },
		{ threadTs: ROOT },
		{ threadTs: undefined },
	])("refuses an invalid request before any host call (%j)", (override) => {
		const h = sdk(() => json(page()));
		invalid(h.context, history(override));
		expect(h.requests).toHaveLength(0);
	});

	it("ignores unknown metadata without invoking accessors or proxy branches", async () => {
		const h = sdk(() => json(page()));
		let calls = 0;
		const poison = new Proxy(
			{},
			{
				get() {
					calls++;
					throw new Error("DYTEST poison");
				},
			},
		);
		const input = Object.defineProperties(history(), {
			extra: {
				enumerable: true,
				get() {
					calls++;
					throw new Error("DYTEST getter");
				},
			},
			metadata: { enumerable: true, value: poison },
		});
		await collect(pollMessages(h.context, input));
		expect(calls).toBe(0);
		expect(h.requests).toHaveLength(1);
	});

	it("refuses requested accessors and proxies without running their hooks", () => {
		const h = sdk(() => json(page()));
		let calls = 0;
		const accessor = Object.defineProperty(history(), "cursor", {
			enumerable: true,
			get() {
				calls++;
				throw new Error("DYTEST getter");
			},
		});
		invalid(h.context, accessor);
		const proxy = new Proxy(history(), {
			get() {
				calls++;
				throw new Error("DYTEST get");
			},
			getPrototypeOf() {
				calls++;
				throw new Error("DYTEST prototype");
			},
			getOwnPropertyDescriptor() {
				calls++;
				throw new Error("DYTEST descriptor");
			},
			ownKeys() {
				calls++;
				throw new Error("DYTEST keys");
			},
		});
		invalid(h.context, proxy);
		expect(calls).toBe(0);
		expect(h.requests).toHaveLength(0);
	});

	it("keeps opaque provider IDs and safe timestamp boundaries without fake-only limits", async () => {
		const h = sdk(() => json(page()));
		const id = "channel:/?&=";
		await collect(
			pollMessages(h.context, {
				kind: "replies",
				channelId: id,
				threadTs: "9007199254740.991",
				maxPages: 1,
				oldest: "0.000000001",
				latest: "9007199254740.991999999",
				inclusive: false,
			}),
		);
		const query = new URL(h.requests[0]?.params.url ?? "").searchParams;
		expect(query.get("channel")).toBe(id);
		expect(query.get("ts")).toBe("9007199254740.991");
		expect(query.get("latest")).toBe("9007199254740.991999999");
	});

	it("normalizes only empty cursors and omitted optional values", async () => {
		const h = sdk(() => json(page()));
		await collect(
			pollMessages(
				h.context,
				history({
					cursor: "",
					oldest: undefined,
					latest: undefined,
					inclusive: undefined,
				}),
			),
		);
		expect([...new URL(h.requests[0]?.params.url ?? "").searchParams.keys()]).toEqual([
			"channel",
			"limit",
		]);
	});
});
