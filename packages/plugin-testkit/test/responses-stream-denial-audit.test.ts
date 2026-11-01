import { createFake } from "@draftyak/fakes";
import type { HostStreamChunk } from "@draftyak/protocol/host-channel";
import { validateManifest } from "@draftyak/protocol/manifest";
import { HostError } from "@draftyak/sdk";
import { afterEach, expect, it, vi } from "vitest";
import { createMockHost } from "../src/host.ts";
import { channelFixture } from "./fixtures/channel/plugin.ts";

const closes: (() => void)[] = [];
const turn = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

afterEach(() => {
	for (const close of closes.splice(0)) close();
	vi.restoreAllMocks();
	vi.useRealTimers();
});

function streamManifest(timeoutMs: number) {
	const source = validateManifest(channelFixture().manifest);
	if (!source.ok || source.manifest.kind !== "channel") throw new Error("expected channel fixture");
	const fixture = source.manifest;
	const { send: _send, ...base } = fixture;
	const checked = validateManifest({
		...base,
		egress: {
			rules: [
				{
					class: "read",
					method: "GET",
					host: "audit.example",
					pathTemplate: "/stream",
					maxBytes: 2,
					timeoutMs,
				},
			],
		},
	});
	if (!checked.ok) throw new Error("expected valid stream rule");
	return checked.manifest;
}

function setup(timeoutMs = 1000) {
	let controller!: ReadableStreamDefaultController<Uint8Array>;
	let cancellations = 0;
	const body = new ReadableStream<Uint8Array>(
		{
			start(value) {
				controller = value;
			},
			cancel() {
				cancellations++;
			},
		},
		{ highWaterMark: 0 },
	);
	const upstream = createFake({ fetch: () => new Response(body) }, { host: "audit.example" });
	const bridge = createMockHost({
		manifest: streamManifest(timeoutMs),
		instance: "00000000000000000000000001",
		upstreams: [upstream],
	});
	closes.push(() => bridge.host.close());
	const events: HostStreamChunk[] = [];
	bridge.host.subscribe((event) => {
		if (event.method === "host/stream.chunk") events.push(event.params);
	});
	const request = (signal?: AbortSignal, url = "https://audit.example/stream") =>
		bridge.host.request(
			"host/fetch",
			{ method: "GET", url, headers: [], stream: true },
			{ signal },
		);
	return { ...bridge, body, controller, events, request, cancellations: () => cancellations };
}

it.each([
	["oversize", "RESPONSE_TOO_LARGE", "TOO_LARGE"],
	["read failure", "UPSTREAM_FAILED", "DENIED"],
	["fetch deadline", "FETCH_TIMEOUT", "TIMEOUT"],
] as const)(
	"records exactly one late %s denial with the captured lookup and sequence",
	async (phase, reason, code) => {
		vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
		const bridge = setup();
		await expect(bridge.request(undefined, "https://audit.example/off-rule")).rejects.toMatchObject(
			{ code: "DENIED" },
		);
		let messageReads = 0;
		const failure = Object.defineProperty(new Error(), "message", {
			get() {
				messageReads++;
				throw new Error("synthetic private error");
			},
		});
		await bridge.lookup(async () => {
			expect(await bridge.request()).toHaveProperty("streamId");
			expect(bridge.host.denials).toHaveLength(1);
			if (phase === "oversize") bridge.controller.enqueue(new Uint8Array([1, 2, 3]));
			else if (phase === "read failure") bridge.controller.error(failure);
			else await vi.advanceTimersByTimeAsync(1000);
			await turn();
			expect(bridge.events).toHaveLength(1);
			expect(bridge.events[0]).toMatchObject({ sequence: 0, done: true, error: code });
			expect(bridge.host.denials.slice(1)).toEqual([
				{ sequence: 1, method: "host/fetch", reason, lookup: 1 },
			]);
			await turn();
			expect(bridge.host.denials).toHaveLength(2);
			expect(bridge.events).toHaveLength(1);
			return "finished";
		});
		expect(bridge.host.denials).toHaveLength(2);
		expect(bridge.body.locked).toBe(false);
		expect(messageReads).toBe(0);
	},
);

it("preserves LOOKUP_TIMEOUT when lookup retirement wins the late deadline race", async () => {
	vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
	vi.spyOn(performance, "now").mockReturnValue(0);
	const bridge = setup(30_000);
	const ready = Promise.withResolvers<void>();
	const finish = Promise.withResolvers<void>();
	const result = bridge
		.lookup(async () => {
			await bridge.request();
			ready.resolve();
			await finish.promise;
		})
		.catch((error: unknown) => error);
	try {
		await ready.promise;
		await vi.advanceTimersByTimeAsync(30_000);
		expect(await result).toMatchObject({ code: "TIMEOUT" });
		await turn();
		expect(bridge.host.denials).toEqual([
			{ sequence: 0, method: "host/fetch", reason: "LOOKUP_TIMEOUT", lookup: 1 },
		]);
		expect(bridge.events).toMatchObject([{ sequence: 0, done: true, error: "TIMEOUT" }]);
	} finally {
		finish.resolve();
	}
});

it.each(["EOF", "caller abort", "host close"] as const)(
	"does not add a late denial for intentional %s",
	async (phase) => {
		const bridge = setup();
		const caller = new AbortController();
		await bridge.request(caller.signal);
		if (phase === "EOF") bridge.controller.close();
		else if (phase === "caller abort") caller.abort(new HostError("TIMEOUT"));
		else bridge.host.close();
		await turn();
		expect(bridge.host.denials).toHaveLength(0);
		if (phase !== "host close") expect(bridge.events).toHaveLength(1);
		if (phase === "caller abort") expect(bridge.events[0]?.error).toBe("DENIED");
		expect(bridge.body.locked).toBe(false);
	},
);

it("records no late denial when a caller aborts a stream with the host's earlier timeout refusal", async () => {
	vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
	const upstream = createFake(
		{ fetch: () => new Response(new ReadableStream<Uint8Array>({}, { highWaterMark: 0 })) },
		{ host: "audit.example" },
	);
	const bridge = createMockHost({
		manifest: streamManifest(1000),
		instance: "00000000000000000000000001",
		upstreams: [upstream],
	});
	closes.push(() => bridge.host.close());
	const events: HostStreamChunk[] = [];
	bridge.host.subscribe((event) => {
		if (event.method === "host/stream.chunk") events.push(event.params);
	});
	const url = "https://audit.example/stream";
	const pending = bridge.host
		.request("host/fetch", { method: "GET", url, headers: [] })
		.catch((error: unknown) => error);
	await vi.advanceTimersByTimeAsync(1000);
	const refusal = await pending;
	expect(refusal).toMatchObject({ code: "TIMEOUT", reason: "FETCH_TIMEOUT" });
	expect(bridge.host.denials.map((denial) => denial.reason)).toEqual(["FETCH_TIMEOUT"]);
	const caller = new AbortController();
	expect(
		await bridge.host.request(
			"host/fetch",
			{ method: "GET", url, headers: [], stream: true },
			{ signal: caller.signal },
		),
	).toHaveProperty("streamId");
	caller.abort(refusal);
	await turn();
	expect(events).toMatchObject([{ sequence: 0, done: true, error: "DENIED" }]);
	expect(bridge.host.denials.map((denial) => denial.reason)).toEqual(["FETCH_TIMEOUT"]);
});

it("fails closed when a late denial exhausts the public audit capacity without appending overflow", async () => {
	vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
	vi.spyOn(performance, "now").mockReturnValue(0);
	const bridge = setup();
	const ready = Promise.withResolvers<void>();
	const finish = Promise.withResolvers<void>();
	const result = bridge
		.lookup(async () => {
			await bridge.request();
			ready.resolve();
			await finish.promise;
		})
		.catch((error: unknown) => error);
	try {
		await ready.promise;
		for (let index = 0; index < 4096; index++)
			await expect(
				bridge.request(undefined, "https://audit.example/off-rule"),
			).rejects.toMatchObject({ code: "DENIED" });
		expect(bridge.host.auditComplete).toBe(true);
		expect(bridge.host.disabled).toBe(false);
		bridge.controller.enqueue(new Uint8Array([1, 2, 3]));
		await turn();
		expect(bridge.host.denials).toHaveLength(4096);
		expect(bridge.host.denials.every((denial, index) => denial.sequence === index)).toBe(true);
		expect(bridge.host.auditComplete).toBe(false);
		expect(bridge.host.disabled).toBe(true);
		expect(await result).toMatchObject({ code: "DENIED" });
		expect(bridge.events).toMatchObject([{ sequence: 0, done: true, error: "TOO_LARGE" }]);
		await expect(bridge.request()).rejects.toMatchObject({ code: "DENIED" });
		expect(bridge.host.denials).toHaveLength(4096);
	} finally {
		finish.resolve();
	}
});
