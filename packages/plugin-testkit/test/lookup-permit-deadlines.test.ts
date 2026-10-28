import { createFake } from "@draftyak/fakes";
import { validateManifest } from "@draftyak/protocol/manifest";
import { afterEach, expect, it, vi } from "vitest";
import { createMockHost } from "../src/host.ts";
import { toolFixture } from "./fixtures/tool/plugin.ts";

const cleanup: (() => void)[] = [];
afterEach(() => {
	for (const close of cleanup.splice(0)) close();
	vi.restoreAllMocks();
	vi.useRealTimers();
});
function setup(response: () => Response = () => new Response("data"), timeoutMs = 15_000) {
	let now = 0,
		calls = 0;
	vi.spyOn(performance, "now").mockImplementation(() => now);
	const checked = validateManifest(toolFixture(undefined, { timeoutMs }).manifest);
	if (!checked.ok) throw new Error("fixture manifest");
	const fake = createFake({ fetch: () => new Response("unused") }, { host: "permit.example" });
	const bridge = createMockHost({
		manifest: checked.manifest,
		instance: "00000000000000000000000001",
		upstreams: [
			{
				...fake,
				async fetch() {
					calls++;
					return response();
				},
			},
		],
		secrets: { calendarUrl: "https://permit.example/data" },
	});
	cleanup.push(() => bridge.host.close());
	return {
		...bridge,
		at(value: number) {
			now = value;
		},
		calls: () => calls,
		request: (permit?: string) =>
			bridge.host.request("host/fetch", {
				method: "GET",
				url: "secret://calendarUrl",
				headers: [],
				lookupPermit: permit,
			}),
	};
}

it.each([
	{ kind: "kb.lookup", budget: 5000 },
	{ kind: "contact.notes", budget: 5000 },
	{ kind: "calendar.freebusy", budget: 15_000 },
] as const)("keeps $kind admission on its literal monotonic boundary", async ({ kind, budget }) => {
	for (const elapsed of [budget - 1, budget]) {
		const bridge = setup();
		const result = bridge.lookup(async (_signal, permit) => {
			bridge.at(elapsed);
			if (elapsed === budget)
				await expect(bridge.request(permit)).rejects.toMatchObject({ code: "TIMEOUT" });
			else expect((await bridge.request(permit)).status).toBe(200);
			return "result";
		}, kind);
		if (elapsed === budget) await expect(result).rejects.toMatchObject({ code: "TIMEOUT" });
		else expect(await result).toBe("result");
		expect(bridge.calls()).toBe(elapsed === budget ? 0 : 1);
		bridge.host.close();
		vi.restoreAllMocks();
	}
});

it.each([-31_536_000_000, 31_536_000_000])(
	"does not extend or expire grants after a UTC jump of %i",
	async (jump) => {
		vi.useFakeTimers({ toFake: ["Date"] });
		vi.setSystemTime(1_800_000_000_000);
		const bridge = setup();
		await bridge.lookup(async (_signal, permit) => {
			vi.setSystemTime(1_800_000_000_000 + jump);
			bridge.at(4999);
			expect((await bridge.request(permit)).status).toBe(200);
			return "inside elapsed budget";
		}, "kb.lookup");
		expect(bridge.calls()).toBe(1);
	},
);

it.each(["headers", "chunk", "eof", "final"] as const)(
	"refuses lower-budget %s at exact elapsed deadline without timer callbacks",
	async (phase) => {
		let reads = 0;
		const bridge = setup(() => {
			if (phase === "headers") bridge.at(1000);
			const response = new Response(
				phase === "final"
					? null
					: new ReadableStream<Uint8Array>(
							{
								pull(controller) {
									reads++;
									if (phase === "chunk" || phase === "eof") bridge.at(1000);
									if (phase === "eof") controller.close();
									else {
										controller.enqueue(new Uint8Array([1]));
										controller.close();
									}
								},
							},
							{ highWaterMark: 0 },
						),
			);
			if (phase === "final") {
				const entries = response.headers.entries.bind(response.headers);
				response.headers.entries = () => {
					bridge.at(1000);
					return entries();
				};
			}
			return response;
		}, 1000);
		await bridge.lookup(async (_signal, permit) => {
			await expect(bridge.request(permit)).rejects.toMatchObject({ code: "TIMEOUT" });
			return "lookup remains within its 5s budget";
		}, "kb.lookup");
		expect(bridge.host.denials.at(-1)?.reason).toBe("FETCH_TIMEOUT");
		expect(bridge.calls()).toBe(1);
		expect(reads).toBe(phase === "chunk" || phase === "eof" ? 1 : 0);
	},
);

it("fences final lookup completion even without a fetch or timer callback", async () => {
	const bridge = setup();
	await expect(
		bridge.lookup(async () => {
			bridge.at(5000);
			return "expired";
		}, "kb.lookup"),
	).rejects.toMatchObject({ code: "TIMEOUT" });
});

it("refuses an elapsed admission deadline before the scheduled handler or MCP dispatch", async () => {
	const bridge = setup();
	let dispatched = 0;
	const action = async () => {
		dispatched++;
		return "expired dispatch";
	};
	const result = bridge.lookup(action, "kb.lookup");
	bridge.at(5000);
	await expect(result).rejects.toMatchObject({ code: "TIMEOUT" });
	expect(dispatched).toBe(0);
	expect(bridge.calls()).toBe(0);
});

it("rechecks closure after scheduling but before actual fake dispatch", async () => {
	const bridge = setup();
	const result = bridge.lookup(async (_signal, permit) => {
		const response = bridge.request(permit);
		queueMicrotask(() => bridge.host.close());
		await expect(response).rejects.toMatchObject({ code: "DENIED" });
		return "closed";
	}, "kb.lookup");
	await expect(result).rejects.toMatchObject({ code: "DENIED" });
	expect(bridge.calls()).toBe(0);
});

it.each([999, 1000])(
	"checks queued stream delivery against lower elapsed budget at %i",
	async (elapsed) => {
		const bridge = setup(() => new Response(new Uint8Array(65_537)), 1000);
		const chunks: { done: boolean; bytes: number; error?: string }[] = [];
		bridge.host.subscribe((notification) => {
			if (notification.method === "host/stream.chunk")
				chunks.push({
					done: notification.params.done,
					bytes: Buffer.from(notification.params.base64, "base64url").length,
					...(notification.params.error ? { error: notification.params.error } : {}),
				});
		});
		await bridge.lookup(async (_signal, permit) => {
			expect(await bridge.request(permit)).toHaveProperty("streamId");
			bridge.at(elapsed);
			await new Promise<void>((resolve) => setImmediate(() => setImmediate(resolve)));
			return "complete";
		}, "kb.lookup");
		expect(chunks).toEqual(
			elapsed === 999
				? [
						{ done: false, bytes: 65_536 },
						{ done: true, bytes: 1 },
					]
				: [{ done: true, bytes: 0, error: "TIMEOUT" }],
		);
	},
);
