import { createFake } from "@draftyak/fakes";
import { TOOL_ERROR_META_KEY } from "@draftyak/protocol/tool-v1";
import { afterEach, expect, it, vi } from "vitest";
import { createMockHub, type MockHub } from "../src/index.ts";
import { toolFixture } from "./fixtures/tool/plugin.ts";

const epoch = 1_800_000_000_000;
const hubs: MockHub[] = [];
afterEach(async () => {
	await Promise.all(hubs.splice(0).map((hub) => hub.close()));
	vi.useRealTimers();
});
function clock(): void {
	vi.useFakeTimers({ toFake: ["Date"] });
	vi.setSystemTime(epoch);
}
function hubFor(fetch: () => Response): { hub: MockHub; calls: () => number } {
	let calls = 0;
	const fake = createFake({ fetch: () => new Response("unused") }, { host: "deadline.example" });
	// Preserve the original synthetic body: a recorder tee could pull it before the host reader.
	const upstream = {
		...fake,
		async fetch() {
			calls++;
			return fetch();
		},
	};
	const hub = createMockHub({
		mode: "in-memory",
		plugin: toolFixture(
			async (_args, context) => {
				const response = await context.fetch("secret://calendarUrl");
				return { entries: [{ label: "data", text: await response.text() }] };
			},
			{ timeoutMs: 1000 },
		),
		upstreams: [upstream],
		secrets: { calendarUrl: "https://deadline.example/data" },
	});
	hubs.push(hub);
	return { hub, calls: () => calls };
}
function expectTimedOut(result: Record<string, unknown>, hub: MockHub): void {
	// The generic SDK sanitizes uncaught HostError; the mock audit retains its fixed timeout reason.
	expect(result).toMatchObject({
		isError: true,
		_meta: { [TOOL_ERROR_META_KEY]: { code: "TRANSIENT" } },
	});
	expect(result).not.toHaveProperty("structuredContent");
	expect(hub.host.denials.at(-1)?.reason).toBe("FETCH_TIMEOUT");
}
it("refuses headers resolving at the exact fetch deadline without executing a timer callback", async () => {
	clock();
	for (const elapsed of [999, 1000]) {
		vi.setSystemTime(epoch);
		let reads = 0;
		const { hub, calls } = hubFor(() => {
			vi.setSystemTime(epoch + elapsed);
			return new Response(
				new ReadableStream(
					{
						pull(controller) {
							reads++;
							controller.enqueue(new TextEncoder().encode("body"));
							controller.close();
						},
					},
					{ highWaterMark: 0 },
				),
			);
		});
		const result = await hub.call("kb.lookup", { topic: "test" });
		if (elapsed === 999)
			expect(result.structuredContent).toEqual({ entries: [{ label: "data", text: "body" }] });
		else expectTimedOut(result, hub);
		expect(reads).toBe(elapsed === 999 ? 1 : 0);
		expect(calls()).toBe(1);
	}
});
it("refuses bytes arriving at the fetch deadline before accepting a read chunk", async () => {
	clock();
	let reads = 0;
	const { hub, calls } = hubFor(
		() =>
			new Response(
				new ReadableStream(
					{
						pull(controller) {
							reads++;
							vi.setSystemTime(epoch + 1000);
							if (reads === 1) controller.enqueue(new TextEncoder().encode("late"));
							else controller.close();
						},
					},
					{ highWaterMark: 0 },
				),
			),
	);
	expectTimedOut(await hub.call("kb.lookup", { topic: "test" }), hub);
	expect(calls()).toBe(1);
	expect(reads).toBe(1);
});
it("refuses a body ending at the fetch deadline even when it has no bytes", async () => {
	clock();
	const { hub } = hubFor(
		() =>
			new Response(
				new ReadableStream(
					{
						pull(controller) {
							vi.setSystemTime(epoch + 1000);
							controller.close();
						},
					},
					{ highWaterMark: 0 },
				),
			),
	);
	expectTimedOut(await hub.call("kb.lookup", { topic: "test" }), hub);
});
it("refuses final lookup admission at its literal 5000 millisecond deadline without timers", async () => {
	clock();
	for (const elapsed of [4999, 5000]) {
		vi.setSystemTime(epoch);
		const hub = createMockHub({
			mode: "in-memory",
			plugin: toolFixture(async () => {
				vi.setSystemTime(epoch + elapsed);
				return { entries: [] };
			}),
			upstreams: [],
		});
		hubs.push(hub);
		const result = hub.call("kb.lookup", { topic: "test" });
		if (elapsed === 4999) expect((await result).structuredContent).toEqual({ entries: [] });
		else await expect(result).rejects.toMatchObject({ code: "TIMEOUT" });
	}
});
it("refuses expired lookup authority before any upstream dispatch", async () => {
	clock();
	let dispatched = 0;
	const fake = createFake(
		{
			fetch: () => {
				dispatched++;
				return new Response("data");
			},
		},
		{ host: "deadline.example" },
	);
	const hub = createMockHub({
		mode: "in-memory",
		plugin: toolFixture(async (_args, context) => {
			vi.setSystemTime(epoch + 5000);
			await expect(context.fetch("secret://calendarUrl")).rejects.toMatchObject({
				code: "TIMEOUT",
			});
			return { entries: [] };
		}),
		upstreams: [fake],
		secrets: { calendarUrl: "https://deadline.example/data" },
	});
	hubs.push(hub);
	await expect(hub.call("kb.lookup", { topic: "test" })).rejects.toMatchObject({ code: "TIMEOUT" });
	expect(hub.host.denials.at(-1)?.reason).toBe("FETCH_TIMEOUT");
	expect(dispatched).toBe(0);
});
