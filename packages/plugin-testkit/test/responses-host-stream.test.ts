import { createFake, type Fake } from "@draftyak/fakes";
import { DraftOutputV1 } from "@draftyak/protocol/draft-output";
import {
	HOST_MAX_ACTIVE_REQUESTS,
	HOST_MAX_STREAM_BYTES,
	type HostStreamChunk,
} from "@draftyak/protocol/host-channel";
import type { PluginManifestV1 } from "@draftyak/protocol/manifest";
import type { ResponsesHttpBindingInput } from "@draftyak/protocol/manifest/responses-http";
import { hostFetch } from "@draftyak/sdk";
import { afterEach, expect, it, vi } from "vitest";
import { createMockHost } from "../src/host.ts";
import { manifest as aiManifest, request as draftRequest } from "./fixtures/ai-fixture/plugin.ts";
import { channelFixture } from "./fixtures/channel/plugin.ts";

const ORIGIN = "https://api.openai.com";
const headers: [string, string][] = [
	["accept", "application/json"],
	["authorization", "Bearer brokered"],
];
const binding: ResponsesHttpBindingInput = { operation: "ai_models_list", origin: ORIGIN };
if (aiManifest.kind !== "ai-provider") throw new Error("expected provider fixture");
const manifest: PluginManifestV1 = {
	...aiManifest,
	kind: "ai-provider",
	egress: { profile: "responses-api-v1" },
};
const cleanup: (() => void)[] = [];
const turn = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

afterEach(() => {
	for (const close of cleanup.splice(0)) close();
	vi.restoreAllMocks();
	vi.useRealTimers();
});

function held(cancel: () => unknown = () => undefined) {
	let controller!: ReadableStreamDefaultController<Uint8Array>;
	let pulls = 0;
	let cancels = 0;
	const body = new ReadableStream<Uint8Array>(
		{
			start(value) {
				controller = value;
			},
			pull() {
				pulls++;
			},
			async cancel() {
				cancels++;
				await cancel();
			},
		},
		{ highWaterMark: 0 },
	);
	return { body, controller, pulls: () => pulls, cancels: () => cancels };
}

function setup(
	fetch: Fake["fetch"],
	input: { manifest?: PluginManifestV1; responsesHttp?: readonly ResponsesHttpBindingInput[] } = {},
) {
	const fake = createFake({ fetch: () => new Response("unused") }, { host: "api.openai.com" });
	const calls: { url: string; init?: RequestInit }[] = [];
	const bridge = createMockHost({
		manifest: input.manifest ?? manifest,
		instance: "00000000000000000000000001",
		responsesHttp: input.responsesHttp ?? [binding],
		upstreams: [
			{
				...fake,
				async fetch(url, init) {
					calls.push({ url: String(url), init });
					return fetch(url, init);
				},
			},
		],
	});
	cleanup.push(() => bridge.host.close());
	const events: HostStreamChunk[] = [];
	bridge.host.subscribe((event) => {
		if (event.method === "host/stream.chunk") events.push(event.params);
	});
	return {
		...bridge,
		calls,
		events,
		request: (signal?: AbortSignal) =>
			bridge.host.request(
				"host/fetch",
				{ method: "GET", url: `${ORIGIN}/v1/models`, headers, stream: true },
				{ signal },
			),
	};
}

it("returns headers before EOF and delivers the first real SDK chunk while upstream stays open", async () => {
	const stream = held();
	const bridge = setup(
		async () =>
			new Response(stream.body, {
				headers: { "content-type": "application/json", "x-hidden": "discard" },
			}),
	);
	const responsePromise = hostFetch(bridge.host)(`${ORIGIN}/v1/models`, { headers, stream: true });
	const early = await Promise.race([responsePromise, turn().then(() => null)]);
	expect(early, "headers must precede upstream EOF").not.toBeNull();
	const response = await responsePromise;
	expect(response.status).toBe(200);
	expect(response.headers.has("x-hidden")).toBe(false);
	expect(bridge.calls[0]?.init?.headers).toEqual(headers);
	if (!response.body) throw new Error("expected stream body");
	const reader = response.body.getReader();
	const first = reader.read();
	stream.controller.enqueue(new Uint8Array([65, 66]));
	const received = await first;
	expect(received.done).toBe(false);
	expect(Array.from(received.value ?? [])).toEqual([65, 66]);
	expect(bridge.events.map((event) => event.done)).toEqual([false]);
	expect(stream.pulls()).toBeGreaterThan(0);
	stream.controller.close();
	expect(await reader.read()).toEqual({ done: true, value: undefined });
	expect(bridge.events.map((event) => event.sequence)).toEqual([0, 1]);
	expect(bridge.events.filter((event) => event.done)).toHaveLength(1);
});

it("retains the original caller cancellation after headers and releases the actual reader", async () => {
	const stream = held();
	const bridge = setup(async () => new Response(stream.body));
	const controller = new AbortController();
	const response = await hostFetch(bridge.host)(`${ORIGIN}/v1/models`, {
		headers,
		stream: true,
		signal: controller.signal,
	});
	if (!response.body) throw new Error("expected stream body");
	const read = response.body
		.getReader()
		.read()
		.catch((error: unknown) => error);
	controller.abort();
	expect(await read).toMatchObject({ code: "DENIED" });
	await turn();
	expect(bridge.calls[0]?.init?.signal?.aborted).toBe(true);
	expect(stream.cancels()).toBe(1);
	expect(stream.body.locked).toBe(false);
	expect(bridge.events.filter((event) => event.done)).toHaveLength(1);
	const count = bridge.events.length;
	await turn();
	expect(bridge.events).toHaveLength(count);
});

it("keeps the fetch deadline alive after the memory host has returned headers", async () => {
	vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
	// A fixed clock keeps the 30,000 ms budget exact; fractional time can round the timer down.
	vi.spyOn(performance, "now").mockReturnValue(0);
	const stream = held();
	const bridge = setup(async () => new Response(stream.body));
	await bridge.request();
	await turn();
	await vi.advanceTimersByTimeAsync(29_999);
	expect(bridge.events).toHaveLength(0);
	await vi.advanceTimersByTimeAsync(1);
	expect(bridge.events).toMatchObject([{ sequence: 0, done: true, error: "TIMEOUT" }]);
	expect(stream.cancels()).toBe(1);
	expect(vi.getTimerCount()).toBe(0);
});

it("splits a 65537-byte upstream chunk into bounded monotonic notifications and one EOF", async () => {
	const stream = held();
	const bridge = setup(async () => new Response(stream.body));
	await bridge.request();
	stream.controller.enqueue(new Uint8Array(65_537).fill(7));
	stream.controller.close();
	await turn();
	expect(bridge.events.map((event) => Buffer.from(event.base64, "base64url").length)).toEqual([
		65_536, 1, 0,
	]);
	expect(bridge.events.map((event) => event.sequence)).toEqual([0, 1, 2]);
	expect(bridge.events.map((event) => event.done)).toEqual([false, false, true]);
});

it.each(["rule", "protocol"] as const)(
	"enforces the %s total stream bound before delivering excess bytes",
	async (bound) => {
		const stream = held();
		const channel = channelFixture().manifest as Extract<PluginManifestV1, { kind: "channel" }>;
		const selected: PluginManifestV1 =
			bound === "rule"
				? {
						...channel,
						egress: {
							rules: [
								{
									class: "read",
									method: "GET",
									host: "api.openai.com",
									pathTemplate: "/v1/models",
									maxBytes: 2,
									timeoutMs: 1000,
								},
							],
						},
					}
				: manifest;
		const bridge = setup(async () => new Response(stream.body), {
			manifest: selected,
			responsesHttp: bound === "rule" ? [] : [binding],
		});
		await bridge.request();
		if (bound === "rule") {
			stream.controller.enqueue(new Uint8Array([1, 2]));
			await turn();
			stream.controller.enqueue(new Uint8Array([3]));
		} else stream.controller.enqueue(new Uint8Array(HOST_MAX_STREAM_BYTES + 1));
		await turn();
		expect(bridge.events.at(-1)).toMatchObject({ done: true, error: "TOO_LARGE" });
		expect(
			bridge.events.reduce((sum, event) => sum + Buffer.from(event.base64, "base64url").length, 0),
		).toBe(bound === "rule" ? 2 : 0);
		expect(stream.cancels()).toBe(1);
	},
);

it("keeps disposing readers inside the finite stream capacity until cancellation settles", async () => {
	const disposal = Promise.withResolvers<void>();
	const streams: ReturnType<typeof held>[] = [];
	const bridge = setup(async () => {
		const stream = held(() => disposal.promise);
		streams.push(stream);
		return new Response(stream.body);
	});
	for (let index = 0; index < HOST_MAX_ACTIVE_REQUESTS; index++) {
		const controller = new AbortController();
		await bridge.request(controller.signal);
		controller.abort();
	}
	expect(streams.every((stream) => stream.cancels() === 1)).toBe(true);
	expect(streams.every((stream) => stream.body.locked)).toBe(true);
	await expect(bridge.request()).rejects.toMatchObject({ code: "TOO_LARGE" });
	expect(bridge.calls).toHaveLength(HOST_MAX_ACTIVE_REQUESTS);
	disposal.resolve();
	await turn();
	expect(streams.every((stream) => !stream.body.locked)).toBe(true);
	await expect(bridge.request()).resolves.toHaveProperty("streamId");
});

it("retires lookup-owned streams after headers and retains disposing lookup work", async () => {
	const disposal = Promise.withResolvers<void>();
	const stream = held(() => disposal.promise);
	const bridge = setup(async () => new Response(stream.body));
	expect(
		await bridge.lookup(async () => {
			await bridge.request();
			return "complete";
		}),
	).toBe("complete");
	expect(stream.cancels()).toBe(1);
	expect(stream.body.locked).toBe(true);
	expect(bridge.events).toMatchObject([{ done: true, error: "DENIED" }]);
	disposal.resolve();
	await turn();
	expect(stream.body.locked).toBe(false);
});

it("keeps lookups counted while their streams' upstream cancellation is pending", async () => {
	const disposal = Promise.withResolvers<void>();
	const streams: ReturnType<typeof held>[] = [];
	const bridge = setup(async () => {
		const stream = held(() => disposal.promise);
		streams.push(stream);
		return new Response(stream.body);
	});
	// The host retains at most 16 lookups, including ones whose work is still disposing.
	for (let index = 0; index < 16; index++)
		await bridge.lookup(async () => {
			await bridge.request();
		});
	expect(streams.map((stream) => stream.cancels())).toEqual(Array(16).fill(1));
	await expect(bridge.lookup(async () => "admitted")).rejects.toMatchObject({
		code: "LOOKUP_LIMIT",
	});
	disposal.resolve();
	await turn();
	await expect(bridge.lookup(async () => "admitted")).resolves.toBe("admitted");
});

it("closes an admitted stream without late bytes or duplicate terminal notifications", async () => {
	const disposal = Promise.withResolvers<void>();
	const stream = held(() => disposal.promise);
	const bridge = setup(async () => new Response(stream.body));
	await bridge.request();
	await turn();
	bridge.host.close();
	expect(stream.cancels()).toBe(1);
	const count = bridge.events.length;
	disposal.resolve();
	await turn();
	expect(stream.body.locked).toBe(false);
	expect(bridge.events).toHaveLength(count);
});

it("owns a late upstream response and its hanging cancellation after the caller aborts", async () => {
	const delivery = Promise.withResolvers<Response>();
	const disposal = Promise.withResolvers<void>();
	const stream = held(() => disposal.promise);
	const bridge = setup(async () => delivery.promise);
	const controller = new AbortController();
	const result = bridge.request(controller.signal).catch((error: unknown) => error);
	await turn();
	controller.abort();
	expect(await result).toMatchObject({ code: "DENIED" });
	delivery.resolve(new Response(stream.body));
	await turn();
	expect(stream.cancels()).toBe(1);
	expect(bridge.events).toHaveLength(0);
	disposal.resolve();
	await turn();
});

it("constructs immutable expectations from the original trusted binding inputs", async () => {
	const original = { operation: "ai_probe", origin: ORIGIN, model: "model:pchar+literal" } as const;
	const bridge = setup(async () => new Response("ok"), { responsesHttp: [original] });
	Object.assign(original, { model: "different" });
	await expect(
		bridge.host.request("host/fetch", {
			method: "GET",
			url: `${ORIGIN}/v1/models/model:pchar+literal`,
			headers,
		}),
	).resolves.toMatchObject({ status: 200 });
	await expect(
		bridge.host.request("host/fetch", {
			method: "GET",
			url: `${ORIGIN}/v1/models/different`,
			headers,
		}),
	).rejects.toMatchObject({ code: "DENIED" });
	expect(bridge.calls).toHaveLength(1);
});

it("refuses unsafe binding vectors without invoking caller hooks", () => {
	let hooks = 0;
	const getter: unknown[] = [];
	Object.defineProperty(getter, "0", {
		enumerable: true,
		get() {
			hooks++;
			return binding;
		},
	});
	const proxy = new Proxy([binding], {
		get() {
			hooks++;
			throw new Error("synthetic");
		},
	});
	for (const inputs of [
		getter,
		proxy,
		Array(1),
		Array(17).fill(binding),
		[Object.assign({}, binding, { origin: "https://other.invalid" })],
	]) {
		expect(() =>
			setup(async () => new Response("unused"), {
				responsesHttp: inputs as ResponsesHttpBindingInput[],
			}),
		).toThrow("INVALID_RESPONSES_BINDINGS");
	}
	expect(hooks).toBe(0);
});

it("refuses nonempty bindings for other manifests and treats an explicit undefined as absent", () => {
	const channel = channelFixture().manifest as PluginManifestV1;
	for (const selected of [channel, aiManifest])
		expect(() =>
			setup(async () => new Response("unused"), {
				manifest: selected,
				responsesHttp: [binding],
			}),
		).toThrow("INVALID_RESPONSES_BINDINGS");
	for (const selected of [channel, aiManifest, manifest]) {
		const bridge = createMockHost({
			manifest: selected,
			instance: "00000000000000000000000001",
			upstreams: [],
			responsesHttp: undefined,
		});
		bridge.host.close();
	}
});

const schema = DraftOutputV1.toJSONSchema({
	target: "draft-7",
	override: ({ jsonSchema }) => {
		delete jsonSchema.uniqueItems;
	},
});
const draftHeaders = { "content-type": "application/json", authorization: "Bearer brokered" };
function draftBody(): string {
	return JSON.stringify({
		model: draftRequest.model,
		instructions: draftRequest.system,
		input: [{ role: "user", content: draftRequest.prompt }],
		text: { format: { type: "json_schema", name: "draft_output", strict: true, schema } },
		stream: true,
		store: false,
	});
}

it("streams a bound draft POST with its exact body through the real SDK and refuses a changed byte", async () => {
	const stream = held();
	const received: Buffer[] = [];
	const upstream = createFake(
		{
			async fetch(request: Request) {
				received.push(Buffer.from(await request.arrayBuffer()));
				return new Response(stream.body, { headers: { "content-type": "text/event-stream" } });
			},
		},
		{ host: "api.openai.com" },
	);
	const bridge = createMockHost({
		manifest,
		instance: "00000000000000000000000001",
		upstreams: [upstream],
		responsesHttp: [
			{ operation: "ai_draft_generate", origin: ORIGIN, draft: structuredClone(draftRequest) },
		],
	});
	cleanup.push(() => bridge.host.close());
	const events: HostStreamChunk[] = [];
	bridge.host.subscribe((event) => {
		if (event.method === "host/stream.chunk") events.push(event.params);
	});
	const fetch = hostFetch(bridge.host);
	const body = draftBody();
	const response = await fetch(`${ORIGIN}/v1/responses`, {
		method: "POST",
		headers: draftHeaders,
		body,
		stream: true,
	});
	expect(response.status).toBe(200);
	expect(response.headers.get("content-type")).toBe("text/event-stream");
	expect(received).toEqual([Buffer.from(body)]);
	if (!response.body) throw new Error("expected stream body");
	const reader = response.body.getReader();
	const first = reader.read();
	stream.controller.enqueue(new TextEncoder().encode("data: one\n\n"));
	expect(new TextDecoder().decode((await first).value)).toBe("data: one\n\n");
	expect(events.filter((event) => event.done)).toHaveLength(0);
	stream.controller.close();
	expect(await reader.read()).toEqual({ done: true, value: undefined });
	const position = body.indexOf(draftRequest.prompt) + draftRequest.prompt.length - 1;
	const changed = `${body.slice(0, position)}?${body.slice(position + 1)}`;
	const original = Buffer.from(body);
	expect(Buffer.byteLength(changed)).toBe(original.length);
	expect(Buffer.from(changed).filter((byte, index) => byte !== original[index])).toHaveLength(1);
	await expect(
		fetch(`${ORIGIN}/v1/responses`, {
			method: "POST",
			headers: draftHeaders,
			body: changed,
			stream: true,
		}),
	).rejects.toMatchObject({ code: "DENIED" });
	expect(received).toHaveLength(1);
	expect(bridge.host.denials.map((denial) => denial.reason)).toEqual(["OFF_RULE"]);
});

it("refuses a bound models GET that carries a body before upstream dispatch", async () => {
	const bridge = setup(async () => new Response("ok"));
	await expect(
		bridge.host.request("host/fetch", {
			method: "GET",
			url: `${ORIGIN}/v1/models`,
			headers,
			body: { base64: "AQ" },
		}),
	).rejects.toMatchObject({ code: "DENIED" });
	expect(bridge.calls).toHaveLength(0);
	expect(bridge.host.denials.map((denial) => denial.reason)).toEqual(["OFF_RULE"]);
	await expect(
		bridge.host.request("host/fetch", { method: "GET", url: `${ORIGIN}/v1/models`, headers }),
	).resolves.toMatchObject({ status: 200 });
	expect(bridge.calls).toHaveLength(1);
});

it.each([
	["an oversized value", { "content-type": `text/plain; x=${"a".repeat(9_000)}` }],
	[
		"an aggregate above the header bound",
		{
			"content-type": "a".repeat(8_000),
			etag: "b".repeat(8_000),
			"last-modified": "c".repeat(8_000),
		},
	],
] as const)(
	"refuses response headers with %s before any stream starts and keeps stream capacity",
	async (_kind, invalid) => {
		let valid = false;
		const streams: ReturnType<typeof held>[] = [];
		const bridge = setup(async () => {
			const stream = held();
			streams.push(stream);
			return new Response(stream.body, {
				headers: valid ? { "content-type": "application/json" } : invalid,
			});
		});
		for (let index = 0; index <= HOST_MAX_ACTIVE_REQUESTS; index++) {
			await expect(bridge.request()).rejects.toMatchObject({ code: "BAD_REQUEST" });
			await turn();
		}
		await expect(
			bridge.host.request("host/fetch", { method: "GET", url: `${ORIGIN}/v1/models`, headers }),
		).rejects.toMatchObject({ code: "BAD_REQUEST" });
		await turn();
		expect(streams.map((stream) => stream.cancels())).toEqual(
			Array(HOST_MAX_ACTIVE_REQUESTS + 2).fill(1),
		);
		expect(streams.every((stream) => !stream.body.locked)).toBe(true);
		expect(bridge.events).toHaveLength(0);
		expect(bridge.host.denials.map((denial) => denial.reason)).toEqual(
			Array(HOST_MAX_ACTIVE_REQUESTS + 2).fill("RESPONSE_INVALID"),
		);
		valid = true;
		await expect(bridge.request()).resolves.toHaveProperty("streamId");
	},
);

it.each([
	["redirect", "REDIRECT_REFUSED"],
	["upstream failure", "UPSTREAM_FAILED"],
	["caller abort before headers", "DENIED"],
] as const)("releases the stream reservation of a request refused by %s", async (kind, reason) => {
	let refused = true;
	const bridge = setup(async (_url, init) => {
		if (!refused) return new Response(held().body);
		if (kind === "redirect")
			return new Response(null, { status: 302, headers: { location: `${ORIGIN}/v1/other` } });
		if (kind === "upstream failure") throw new Error("synthetic upstream failure");
		return new Promise<Response>((_resolve, reject) => {
			const signal = init?.signal;
			if (!signal) throw new Error("expected the host signal");
			signal.addEventListener("abort", () => reject(signal.reason), { once: true });
		});
	});
	for (let index = 0; index <= HOST_MAX_ACTIVE_REQUESTS; index++) {
		const controller = new AbortController();
		const result = bridge.request(controller.signal);
		if (kind === "caller abort before headers") {
			await turn();
			controller.abort();
		}
		await expect(result).rejects.toMatchObject({ code: "DENIED" });
		await turn();
	}
	expect(bridge.calls).toHaveLength(HOST_MAX_ACTIVE_REQUESTS + 1);
	expect(bridge.host.denials.map((denial) => denial.reason)).toEqual(
		Array(HOST_MAX_ACTIVE_REQUESTS + 1).fill(reason),
	);
	refused = false;
	await expect(bridge.request()).resolves.toHaveProperty("streamId");
});

it("checks original candidate headers before filtering and denies missing trusted inputs", async () => {
	for (const missing of [false, true]) {
		const bridge = setup(async () => new Response("unused"), {
			responsesHttp: missing ? [] : [binding],
		});
		await expect(
			bridge.host.request("host/fetch", {
				method: "GET",
				url: `${ORIGIN}/v1/models`,
				headers: missing ? headers : [...headers, ["x-hidden", "candidate"]],
			}),
		).rejects.toMatchObject({ code: "DENIED" });
		expect(bridge.calls).toHaveLength(0);
	}
});

const DATA_CHUNK_LIMIT = 65_536;
const CHUNK_BYTE_LIMIT = 65_536;

it.each([1, NaN])(
	"counts actual bytes despite a shadowed byteLength of %s without invoking view hooks",
	async (reported) => {
		// Exercise byte accounting independently of the upstream deadline under a busy test runner.
		vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
		vi.spyOn(performance, "now").mockReturnValue(0);
		let hooks = 0;
		const hook = () => {
			hooks++;
			throw new Error("synthetic view hook");
		};
		const stream = held();
		const channel = channelFixture().manifest as Extract<PluginManifestV1, { kind: "channel" }>;
		const bridge = setup(async () => new Response(stream.body), {
			manifest: {
				...channel,
				egress: {
					rules: [
						{
							class: "read",
							method: "GET",
							host: "api.openai.com",
							pathTemplate: "/v1/models",
							maxBytes: CHUNK_BYTE_LIMIT,
							timeoutMs: 1000,
						},
					],
				},
			},
			responsesHttp: [],
		});
		await bridge.request();
		const chunk = new Uint8Array(CHUNK_BYTE_LIMIT).fill(11);
		Object.defineProperties(chunk, {
			byteLength: { value: reported },
			byteOffset: { get: hook },
			buffer: { get: hook },
			length: { get: hook },
			subarray: { get: hook },
			constructor: { get: hook },
			[Symbol.iterator]: { get: hook },
		});
		stream.controller.enqueue(chunk);
		await turn();
		expect(bridge.events).toHaveLength(1);
		expect(Buffer.from(bridge.events[0]?.base64 ?? "", "base64url")).toEqual(
			Buffer.alloc(CHUNK_BYTE_LIMIT, 11),
		);
		stream.controller.enqueue(new Uint8Array([12]));
		await turn();
		expect(bridge.events.at(-1)).toMatchObject({ done: true, error: "TOO_LARGE" });
		expect(bridge.events.filter((event) => event.done)).toHaveLength(1);
		expect(stream.cancels()).toBe(1);
		expect(hooks).toBe(0);
	},
);

it("copies a genuine offset Buffer view into the real SDK response", async () => {
	const stream = held();
	const bridge = setup(async () => new Response(stream.body));
	const response = await hostFetch(bridge.host)(`${ORIGIN}/v1/models`, { headers, stream: true });
	stream.controller.enqueue(Buffer.from([0, 65, 66, 0]).subarray(1, 3));
	stream.controller.close();
	expect(Array.from(new Uint8Array(await response.arrayBuffer()))).toEqual([65, 66]);
	expect(bridge.events.filter((event) => event.done)).toHaveLength(1);
});

it.each(["shared", "detached", "out-of-bounds", "proxy"] as const)(
	"refuses a %s data view with one terminal and reader cleanup",
	async (kind) => {
		let hooks = 0;
		let chunk: Uint8Array;
		if (kind === "shared") chunk = new Uint8Array(new SharedArrayBuffer(1));
		else if (kind === "detached") {
			chunk = new Uint8Array(1);
			structuredClone(chunk.buffer, { transfer: [chunk.buffer] });
		} else if (kind === "out-of-bounds") {
			const buffer = new ArrayBuffer(2, { maxByteLength: 4 });
			chunk = new Uint8Array(buffer, 1, 1);
			buffer.resize(0);
		} else
			chunk = new Proxy(new Uint8Array(1), {
				get() {
					hooks++;
					throw new Error("synthetic proxy hook");
				},
			});
		const stream = held();
		let first = true;
		const bridge = setup(async () => {
			if (!first) return new Response("reused");
			first = false;
			return new Response(stream.body);
		});
		await bridge.request();
		stream.controller.enqueue(chunk);
		await turn();
		expect(bridge.events).toHaveLength(1);
		expect(bridge.events[0]).toMatchObject({
			sequence: 0,
			done: true,
			error: "BAD_REQUEST",
			base64: "",
		});
		expect(stream.cancels()).toBe(1);
		expect(stream.body.locked).toBe(false);
		expect(hooks).toBe(0);
		await expect(bridge.request()).resolves.toHaveProperty("streamId");
	},
);

it.each([
	["tiny", DATA_CHUNK_LIMIT],
	["tiny", DATA_CHUNK_LIMIT + 1],
	["empty", DATA_CHUNK_LIMIT],
	["empty", DATA_CHUNK_LIMIT + 1],
] as const)(
	"bounds %s data reads at %i independently of byte accounting and reuses stream capacity",
	async (kind, count) => {
		let produced = 0;
		let cancels = 0;
		const body = new ReadableStream<Uint8Array>(
			{
				pull(controller) {
					if (produced === count) controller.close();
					else {
						produced++;
						controller.enqueue(new Uint8Array(kind === "tiny" ? [1] : []));
					}
				},
				cancel() {
					cancels++;
				},
			},
			{ highWaterMark: 0 },
		);
		let first = true;
		const bridge = setup(async () => {
			if (!first) return new Response("reused");
			first = false;
			return new Response(body);
		});
		await bridge.request();
		await turn();
		const overflow = count > DATA_CHUNK_LIMIT;
		expect(produced).toBe(count);
		expect(bridge.events.filter((event) => event.done)).toHaveLength(1);
		expect(bridge.events.at(-1)?.error).toBe(overflow ? "TOO_LARGE" : undefined);
		expect(bridge.events.every((event, index) => event.sequence === index)).toBe(true);
		expect(
			bridge.events.reduce((sum, event) => sum + Buffer.from(event.base64, "base64url").length, 0),
		).toBe(kind === "tiny" ? DATA_CHUNK_LIMIT : 0);
		expect(cancels).toBe(overflow ? 1 : 0);
		expect(body.locked).toBe(false);
		await expect(bridge.request()).resolves.toHaveProperty("streamId");
	},
);

it("bounds split data notifications independently of upstream read count", async () => {
	let produced = 0;
	let cancels = 0;
	const body = new ReadableStream<Uint8Array>(
		{
			pull(controller) {
				produced++;
				controller.enqueue(new Uint8Array(produced < DATA_CHUNK_LIMIT ? 1 : CHUNK_BYTE_LIMIT * 2));
			},
			cancel() {
				cancels++;
			},
		},
		{ highWaterMark: 0 },
	);
	const bridge = setup(async () => new Response(body));
	await bridge.request();
	await turn();
	expect(produced).toBe(DATA_CHUNK_LIMIT);
	expect(bridge.events.filter((event) => !event.done)).toHaveLength(DATA_CHUNK_LIMIT);
	expect(bridge.events.filter((event) => event.done)).toHaveLength(1);
	expect(bridge.events.at(-1)?.error).toBe("TOO_LARGE");
	expect(bridge.events.every((event, index) => event.sequence === index)).toBe(true);
	expect(cancels).toBe(1);
	expect(body.locked).toBe(false);
});
