import { createFake } from "@draftyak/fakes";
import type { HostStreamChunk } from "@draftyak/protocol/host-channel";
import type { HostRequestOptions } from "@draftyak/sdk";
import { afterEach, expect, it, vi } from "vitest";
import { createMockHost } from "../src/host.ts";
import { manifest } from "./fixtures/ai-fixture/plugin.ts";

const origin = "https://api.openai.com";
if (manifest.kind !== "ai-provider") throw new Error("expected provider fixture");
const responsesManifest = { ...manifest, egress: { profile: "responses-api-v1" as const } };
const cleanup: (() => void)[] = [];
const turn = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

afterEach(() => {
	for (const close of cleanup.splice(0)) close();
	vi.restoreAllMocks();
	vi.useRealTimers();
});

function setup() {
	vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
	let now = 0;
	vi.spyOn(performance, "now").mockImplementation(() => now);
	let controller!: ReadableStreamDefaultController<Uint8Array>;
	let cancellations = 0;
	let calls = 0;
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
	const fake = createFake({ fetch: () => new Response("unused") }, { host: "api.openai.com" });
	const bridge = createMockHost({
		manifest: responsesManifest,
		instance: "00000000000000000000000001",
		responsesHttp: [{ operation: "ai_models_list", origin }],
		upstreams: [
			{
				...fake,
				async fetch() {
					calls++;
					return new Response(body);
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
		body,
		controller,
		events,
		at(value: number) {
			now = value;
		},
		cancellations: () => cancellations,
		calls: () => calls,
		request: (options: HostRequestOptions) =>
			bridge.host.request(
				"host/fetch",
				{
					method: "GET",
					url: `${origin}/v1/models`,
					headers: [
						["accept", "application/json"],
						["authorization", "Bearer brokered"],
					],
					stream: true,
				},
				options,
			),
	};
}

it.each([10, 11])(
	"refuses bytes at %ims after a 10ms caller deadline without relying on timer callbacks",
	async (elapsed) => {
		const bridge = setup();
		await expect(bridge.request({ timeoutMs: 10 })).resolves.toHaveProperty("streamId");
		await turn();
		bridge.at(elapsed);
		bridge.controller.enqueue(new Uint8Array([65]));
		await turn();
		expect(bridge.events).toMatchObject([
			{ sequence: 0, base64: "", done: true, error: "TIMEOUT" },
		]);
		expect(bridge.cancellations()).toBe(1);
		expect(bridge.body.locked).toBe(false);
		expect(bridge.host.denials.at(-1)?.reason).toBe("FETCH_TIMEOUT");
		await turn();
		expect(bridge.events).toHaveLength(1);
		expect(vi.getTimerCount()).toBe(0);
	},
);

it("keeps the shorter timer after headers, admits early bytes and cancels a pending read once", async () => {
	const bridge = setup();
	await bridge.request({ timeoutMs: 10 });
	await turn();
	bridge.at(9);
	await vi.advanceTimersByTimeAsync(9);
	bridge.controller.enqueue(new Uint8Array([65]));
	await turn();
	expect(bridge.events).toMatchObject([{ sequence: 0, base64: "QQ", done: false }]);
	bridge.at(10);
	await vi.advanceTimersByTimeAsync(1);
	expect(bridge.events).toMatchObject([
		{ sequence: 0, base64: "QQ", done: false },
		{ sequence: 1, base64: "", done: true, error: "TIMEOUT" },
	]);
	expect(bridge.cancellations()).toBe(1);
	expect(() => bridge.controller.enqueue(new Uint8Array([66]))).toThrow(TypeError);
	await turn();
	expect(bridge.events).toHaveLength(2);
	expect(vi.getTimerCount()).toBe(0);
});

it("counts option capture time against the original absolute request deadline", async () => {
	const bridge = setup();
	await bridge.request({
		get timeoutMs() {
			bridge.at(7);
			return 10;
		},
	});
	await turn();
	await vi.advanceTimersByTimeAsync(2);
	expect(bridge.events).toHaveLength(0);
	bridge.at(10);
	await vi.advanceTimersByTimeAsync(1);
	expect(bridge.events).toMatchObject([{ base64: "", done: true, error: "TIMEOUT" }]);
	expect(bridge.cancellations()).toBe(1);
	expect(vi.getTimerCount()).toBe(0);
});

it.each([0, -1, NaN, Infinity, 30_001, "10"])(
	"refuses invalid timeout %s before upstream dispatch",
	async (timeoutMs) => {
		const bridge = setup();
		await expect(bridge.request({ timeoutMs: timeoutMs as number })).rejects.toMatchObject({
			code: "BAD_REQUEST",
		});
		expect(bridge.calls()).toBe(0);
		expect(bridge.events).toHaveLength(0);
	},
);
