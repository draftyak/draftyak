import {
	createFake,
	createGmailFake,
	GMAIL_HOST,
	GMAIL_READONLY_SCOPE,
	manualClock,
} from "@draftyak/fakes";
import { createMockHub, type MockPlugin } from "@draftyak/plugin-testkit";
import { CHANNEL_V1, channelV1 } from "@draftyak/protocol/channel-v1";
import { extensionDeclaration } from "@draftyak/protocol/extension";
import {
	HOST_REQUEST_TIMEOUT_MS,
	HostFetchParams,
	type HostFetchResult,
	HostNotification,
} from "@draftyak/protocol/host-channel";
import { createPluginContext, HostError, memoryHost, PluginError } from "@draftyak/sdk";
import { describe, expect, it, vi } from "vitest";
import { fetchGmailMessagePageData } from "../src/read.ts";

const BASE = "https://gmail.googleapis.com/gmail/v1/users/me/messages";
const PLUGIN = "@example/gmail-message-page-data";
const DATE = 1_710_000_000_123;
const MAX_BYTES = 4 * 1024 * 1024;
const STREAM = "DYTEST-message-page-stream";
const row = (id = "DYTEST-z", threadId = "DYTEST-thread") => ({ id, threadId });
const encode = (value: unknown) => new TextEncoder().encode(JSON.stringify(value));
function reply(bytes: Uint8Array, status = 200): HostFetchResult {
	return {
		status,
		headers: [["content-type", "application/json"]],
		body: { base64: Buffer.from(bytes).toString("base64url") },
	};
}
function wire(work: (request: HostFetchParams) => HostFetchResult | Promise<HostFetchResult>) {
	const controller = new AbortController(),
		requests: HostFetchParams[] = [];
	const host = memoryHost((method, params) => {
		if (method !== "host/fetch") throw new HostError("UNSUPPORTED");
		const request = HostFetchParams.parse(params);
		requests.push(request);
		return work(request);
	});
	return {
		context: createPluginContext({ plugin: PLUGIN }, host, controller.signal),
		host,
		requests,
		abort: () => controller.abort(),
		close() {
			controller.abort();
			host.close();
		},
	};
}
async function refuses(work: () => Promise<unknown>, code: string): Promise<boolean> {
	try {
		await work();
		return false;
	} catch (error) {
		return (
			error instanceof PluginError &&
			error.message === code &&
			error.result.code === code &&
			Object.keys(error.result).length === 1 &&
			!Object.hasOwn(error, "cause")
		);
	}
}
function padded(value: unknown, size: number): Uint8Array {
	const bytes = encode(value);
	if (bytes.length > size) throw new Error("DYTEST padding unavailable");
	const output = new Uint8Array(size).fill(32);
	output.set(bytes);
	return output;
}
function streamed(bytes: Uint8Array, chunkSize = 65_536) {
	const f = wire(() => {
		setImmediate(() => {
			let sequence = 0;
			for (let at = 0; at < bytes.length; at += chunkSize) {
				const chunk = bytes.subarray(at, at + chunkSize);
				f.host.notify(
					HostNotification.parse({
						jsonrpc: "2.0",
						method: "host/stream.chunk",
						params: {
							streamId: STREAM,
							sequence: sequence++,
							base64: Buffer.from(chunk).toString("base64url"),
							done: at + chunk.length === bytes.length,
						},
					}),
				);
			}
		});
		return { status: 200, headers: [], streamId: STREAM };
	});
	return f;
}
function fakeFixture() {
	const clock = manualClock(DATE),
		requests: { method: string; url: string }[] = [];
	const backend = createGmailFake({
		clock,
		accessGrant: () => ({ scopes: [GMAIL_READONLY_SCOPE], expiresAt: DATE + 3_600_000 }),
	});
	for (const [id, labels] of [
		["DYTEST-z", ["INBOX"]],
		["DYTEST-a", ["INBOX"]],
		["DYTEST-spam", ["SPAM"]],
		["DYTEST-trash", ["TRASH"]],
	] as const) {
		backend.addMessage({
			id,
			threadId: `DYTEST-thread-${id}`,
			raw: new TextEncoder().encode("Subject: DYTEST page\r\n\r\nSynthetic.\r\n"),
			internalDate: DATE,
			labelIds: [...labels],
		});
	}
	const upstream = createFake(
		{
			fetch(request) {
				requests.push({ method: request.method, url: request.url });
				const headers = new Headers(request.headers);
				headers.set("authorization", "Bearer synthetic-page-fixture");
				return backend.fetch(new Request(request, { headers }));
			},
		},
		{ host: GMAIL_HOST },
	);
	const plugin: MockPlugin = {
		manifest: {
			id: PLUGIN,
			version: "1.0.0",
			kind: "channel",
			sdk: "1.0.0",
			runtime: "node",
			isolation: "standard",
			contract: { extension: CHANNEL_V1, version: 1 },
			auth: { kind: "none", scopes: [], requiredGrantedScopes: [] },
			credentials: { mode: "brokered", urlSecrets: [] },
			permissions: {},
			dataClasses: ["example.content"],
			license: "Apache-2.0",
			egress: {
				rules: [
					{
						class: "read",
						method: "GET",
						host: GMAIL_HOST,
						pathTemplate: "/gmail/v1/users/me/messages",
						query: ["maxResults", "pageToken"],
						maxBytes: MAX_BYTES + 1024,
						timeoutMs: 30_000,
					},
				],
			},
		},
		entry: {
			name: "gmail-message-page-data",
			version: "1.0.0",
			plugin: PLUGIN,
			account: "00000000000000000000000001",
			extensions: { [CHANNEL_V1]: extensionDeclaration(channelV1) },
			tools: [
				{
					name: "message_page_data",
					handler: (_args, context) => fetchGmailMessagePageData(context),
				},
			],
		},
	};
	const hub = createMockHub({
		mode: "in-memory",
		plugin,
		upstreams: [upstream],
		account: { id: "00000000000000000000000001", mode: "read_only" },
	});
	const controller = new AbortController();
	return {
		context: createPluginContext({ plugin: PLUGIN }, hub.host, controller.signal),
		clock,
		requests,
		async close() {
			controller.abort();
			await hub.close();
		},
	};
}

describe("Gmail bounded default-scope message page DATA", () => {
	it("uses the real SDK and FakeGmail for one same-query continuation without SPAM or TRASH", async () => {
		const f = fakeFixture();
		try {
			const first = await fetchGmailMessagePageData(f.context, { maxResults: 1 });
			expect(first.messages).toEqual([
				{ providerId: "DYTEST-z", threadId: "DYTEST-thread-DYTEST-z" },
			]);
			expect(typeof first.nextPageToken).toBe("string");
			const second = await fetchGmailMessagePageData(f.context, {
				maxResults: 1,
				pageToken: first.nextPageToken as string,
			});
			expect(second.messages).toEqual([
				{ providerId: "DYTEST-a", threadId: "DYTEST-thread-DYTEST-a" },
			]);
			expect(second).not.toHaveProperty("nextPageToken");
			expect(first.resultSizeEstimate).toBe(2);
			expect(f.requests).toHaveLength(2);
			expect(
				f.requests.every(
					(request) =>
						request.method === "GET" && new URL(request.url).pathname.endsWith("/messages"),
				),
			).toBe(true);
			for (const request of f.requests)
				expect([...new URL(request.url).searchParams.keys()].sort()).toEqual(
					request === f.requests[0] ? ["maxResults"] : ["maxResults", "pageToken"],
				);
		} finally {
			await f.close();
		}
	});

	it.each(["changed maximum", "expired token"] as const)(
		"does not restart or fall back after a %s",
		async (fault) => {
			const f = fakeFixture();
			try {
				const first = await fetchGmailMessagePageData(f.context, { maxResults: 1 });
				expect(first.nextPageToken).toBeTypeOf("string");
				if (fault === "expired token") f.clock.advance(60_001);
				expect(
					await refuses(
						() =>
							fetchGmailMessagePageData(f.context, {
								maxResults: fault === "changed maximum" ? 2 : 1,
								pageToken: first.nextPageToken as string,
							}),
						"TRANSIENT",
					),
				).toBe(true);
				expect(f.requests).toHaveLength(2);
			} finally {
				await f.close();
			}
		},
	);

	it("uses one fixed default GET and exact opaque token encoding without authority knobs", async () => {
		const document = { messages: [row()], nextPageToken: "next+/=%?opaque", resultSizeEstimate: 0 };
		const f = wire(() => reply(encode(document)));
		try {
			const result = await fetchGmailMessagePageData(f.context, { pageToken: "literal+/=%?token" });
			expect(result).toEqual({
				messages: [{ providerId: "DYTEST-z", threadId: "DYTEST-thread" }],
				nextPageToken: "next+/=%?opaque",
				resultSizeEstimate: 0,
				bytesRead: encode(document).length,
			});
			expect(f.requests).toHaveLength(1);
			const request = f.requests[0],
				url = new URL(request?.url ?? "");
			expect(url.origin + url.pathname).toBe(BASE);
			expect([...url.searchParams]).toEqual([
				["maxResults", "500"],
				["pageToken", "literal+/=%?token"],
			]);
			expect(request).toMatchObject({
				method: "GET",
				headers: [["accept", "application/json"]],
				stream: true,
			});
			for (const key of ["body", "saveAs", "sendTicket"]) expect(request).not.toHaveProperty(key);
			expect(Object.keys(result).sort()).toEqual([
				"bytesRead",
				"messages",
				"nextPageToken",
				"resultSizeEstimate",
			]);
		} finally {
			f.close();
		}
	});

	it("preserves provider order, shared threads and detached frozen rows", async () => {
		const document = { messages: [row("DYTEST-z"), row("DYTEST-a")] },
			f = wire(() => reply(encode(document)));
		try {
			const result = await fetchGmailMessagePageData(f.context);
			document.messages[0]!.id = "DYTEST-mutated";
			expect(result.messages.map((value) => value.providerId)).toEqual(["DYTEST-z", "DYTEST-a"]);
			expect(
				Object.isFrozen(result) &&
					Object.isFrozen(result.messages) &&
					result.messages.every(Object.isFrozen),
			).toBe(true);
		} finally {
			f.close();
		}
	});

	it("accepts missing messages as empty DATA and preserves a continuation without completion authority", async () => {
		const f = wire(() => reply(encode({ nextPageToken: "still-more", resultSizeEstimate: 17 })));
		try {
			const result = await fetchGmailMessagePageData(f.context);
			expect(result).toMatchObject({
				messages: [],
				nextPageToken: "still-more",
				resultSizeEstimate: 17,
			});
			for (const key of ["complete", "more", "cursor", "snapshot", "checkpoint", "since"])
				expect(result).not.toHaveProperty(key);
		} finally {
			f.close();
		}
	});

	it("refuses provider pages above requested maxResults", async () => {
		const f = wire(() => reply(encode({ messages: [row("DYTEST-one"), row("DYTEST-two")] })));
		try {
			expect(
				await refuses(
					() => fetchGmailMessagePageData(f.context, { maxResults: 1 }),
					"QUOTA_EXCEEDED",
				),
			).toBe(true);
			expect(f.requests).toHaveLength(1);
		} finally {
			f.close();
		}
	});

	it.each([
		null,
		[],
		{ messages: null },
		{ messages: {} },
		{ messages: [null] },
		{ messages: [{ id: "DYTEST-id" }] },
		{ messages: [row(".")] },
		{ messages: [row("DYTEST-id", "..")] },
		{ messages: [row("DYTEST-id"), row("DYTEST-id", "other-thread")] },
		{ nextPageToken: "" },
		{ nextPageToken: "space token" },
		{ nextPageToken: "x".repeat(2049) },
		{ resultSizeEstimate: -1 },
		{ resultSizeEstimate: 0.5 },
		{ resultSizeEstimate: Number.MAX_SAFE_INTEGER + 1 },
	])("refuses malformed provider DATA %j without retries", async (document) => {
		const f = wire(() => reply(encode(document)));
		try {
			expect(await refuses(() => fetchGmailMessagePageData(f.context), "TRANSIENT")).toBe(true);
			expect(f.requests).toHaveLength(1);
		} finally {
			f.close();
		}
	});

	it.each([
		{ maxResults: 0 },
		{ maxResults: 501 },
		{ maxResults: 1.5 },
		{ maxResults: Number.NaN },
		{ maxBytes: -1 },
		{ maxBytes: MAX_BYTES + 1 },
		{ maxBytes: undefined },
		{ pageToken: "" },
		{ pageToken: "x".repeat(2049) },
		{ pageToken: "has space" },
		{ pageToken: "snow\u2603" },
		{ maxResults: 1, q: "after:1" },
		{ since: 0 },
		{ includeSpamTrash: true },
	])("refuses invalid or extra caller options %j before GET", async (options) => {
		const f = wire(() => reply(encode({})));
		try {
			expect(
				await refuses(
					() => fetchGmailMessagePageData(f.context, options as never),
					"INVALID_INPUT",
				),
			).toBe(true);
			expect(f.requests).toHaveLength(0);
		} finally {
			f.close();
		}
	});

	it("does not invoke hostile option getters or proxies", async () => {
		let calls = 0;
		const f = wire(() => reply(encode({})));
		try {
			const accessor = {
				get maxResults() {
					calls++;
					return 1;
				},
			};
			const proxy = new Proxy(
				{},
				{
					get() {
						calls++;
						throw new Error("DYTEST proxy");
					},
				},
			);
			for (const options of [accessor, proxy])
				expect(
					await refuses(() => fetchGmailMessagePageData(f.context, options), "INVALID_INPUT"),
				).toBe(true);
			expect(calls).toBe(0);
			expect(f.requests).toHaveLength(0);
		} finally {
			f.close();
		}
	});

	it("does not acquire fetch with a zero budget or already-aborted invocation", async () => {
		const f = wire(() => reply(encode({})));
		try {
			expect(
				await refuses(
					() => fetchGmailMessagePageData(f.context, { maxBytes: 0 }),
					"QUOTA_EXCEEDED",
				),
			).toBe(true);
			f.abort();
			expect(await refuses(() => fetchGmailMessagePageData(f.context), "TRANSIENT")).toBe(true);
			expect(f.requests).toHaveLength(0);
		} finally {
			f.close();
		}
	});

	it.each([MAX_BYTES, MAX_BYTES + 1])("retains the actual wire byte boundary %s", async (size) => {
		const f = streamed(padded({ messages: [] }, size));
		try {
			if (size === MAX_BYTES)
				expect((await fetchGmailMessagePageData(f.context)).bytesRead).toBe(size);
			else
				expect(await refuses(() => fetchGmailMessagePageData(f.context), "QUOTA_EXCEEDED")).toBe(
					true,
				);
		} finally {
			f.close();
		}
	});

	it.each([8_192, 8_193])("retains the shared chunk boundary %s", async (count) => {
		const f = streamed(padded({ messages: [] }, count), 1);
		try {
			if (count === 8_192)
				expect((await fetchGmailMessagePageData(f.context)).bytesRead).toBe(count);
			else
				expect(await refuses(() => fetchGmailMessagePageData(f.context), "QUOTA_EXCEEDED")).toBe(
					true,
				);
		} finally {
			f.close();
		}
	});

	it("uses a caller-selected smaller byte budget without trusting a length header", async () => {
		const bytes = encode({ messages: [row()] }),
			f = wire(() => reply(bytes));
		try {
			expect(
				(await fetchGmailMessagePageData(f.context, { maxBytes: bytes.length })).bytesRead,
			).toBe(bytes.length);
		} finally {
			f.close();
		}
		const short = wire(() => reply(bytes));
		try {
			expect(
				await refuses(
					() => fetchGmailMessagePageData(short.context, { maxBytes: bytes.length - 1 }),
					"QUOTA_EXCEEDED",
				),
			).toBe(true);
		} finally {
			short.close();
		}
	});

	it("retains the thirty-second deadline and consumes late fetch rejection", async () => {
		vi.useFakeTimers();
		const delayed = Promise.withResolvers<HostFetchResult>(),
			f = wire(() => delayed.promise);
		try {
			const result = refuses(() => fetchGmailMessagePageData(f.context), "TRANSIENT");
			await vi.advanceTimersByTimeAsync(HOST_REQUEST_TIMEOUT_MS);
			expect(await result).toBe(true);
			expect(f.requests).toHaveLength(1);
			delayed.reject(new Error("DYTEST late response"));
		} finally {
			delayed.resolve(reply(encode({})));
			f.close();
			vi.useRealTimers();
		}
	});

	it("is unsettled before abort and cancels a pending metadata stream without another GET", async () => {
		const entered = Promise.withResolvers<void>(),
			f = wire(() => {
				entered.resolve();
				return { status: 200, headers: [], streamId: STREAM };
			});
		let settled = false;
		try {
			const pending = fetchGmailMessagePageData(f.context);
			void pending.then(
				() => {
					settled = true;
				},
				() => {
					settled = true;
				},
			);
			await entered.promise;
			await new Promise<void>((resolve) => setImmediate(resolve));
			expect(settled).toBe(false);
			f.abort();
			expect(await refuses(() => pending, "TRANSIENT")).toBe(true);
			expect(f.requests).toHaveLength(1);
		} finally {
			f.close();
		}
	});

	it.each([
		[201, "TRANSIENT"],
		[401, "AUTH_EXPIRED"],
		[403, "PERMISSION_DENIED"],
		[404, "NOT_FOUND"],
		[429, "RATE_LIMITED"],
		[503, "TRANSIENT"],
	] as const)("retains status %s as %s without retry", async (status, code) => {
		const f = wire(() => reply(encode({}), status));
		try {
			expect(await refuses(() => fetchGmailMessagePageData(f.context), code)).toBe(true);
			expect(f.requests).toHaveLength(1);
		} finally {
			f.close();
		}
	});
});
