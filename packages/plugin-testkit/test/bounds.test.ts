import { createFake, createToolUpstream } from "@draftyak/fakes";
import { afterEach, expect, it, vi } from "vitest";
import { createMockHub, type MockHub } from "../src/index.ts";
import { channelFixture } from "./fixtures/channel/plugin.ts";
import { toolFixture } from "./fixtures/tool/plugin.ts";

const hubs: MockHub[] = [];
const track = (hub: MockHub): MockHub => {
	hubs.push(hub);
	return hub;
};
afterEach(async () => {
	await Promise.all(hubs.splice(0).map((hub) => hub.close()));
	vi.useRealTimers();
});
it("checks the declared request body ceiling before dispatch and accepts its exact boundary", async () => {
	const fake = createFake({ fetch: () => new Response("{}") }, { host: "hello.draftyak.example" });
	const plugin = channelFixture(undefined, "00000000000000000000000002");
	const manifest = plugin.manifest as { egress: { rules: { maxBytes: number }[] } };
	const rule = manifest.egress.rules[1];
	if (!rule) throw new Error("fixture");
	rule.maxBytes = 4;
	const hub = track(
		createMockHub({
			mode: "in-memory",
			plugin,
			account: { id: "00000000000000000000000002", mode: "full" },
			upstreams: [fake],
		}),
	);
	for (const size of [4, 5]) {
		const result = hub.host.request("host/fetch", {
			method: "PATCH",
			url: `https://${fake.host}/v1/conversations/conv-1`,
			headers: [],
			body: { base64: Buffer.alloc(size).toString("base64url") },
		});
		if (size === 4) expect((await result).status).toBe(200);
		else await expect(result).rejects.toThrow("TOO_LARGE");
	}
	expect(hub.host.denials[0]?.reason).toBe("REQUEST_TOO_LARGE");
	expect(fake.recorder.takeRequests()).toHaveLength(1);
});
it("enforces actual bytes against a lower declared rule cap even when Content-Length lies", async () => {
	for (const size of [4, 5]) {
		const fake = createFake(
			{ fetch: () => new Response(new Uint8Array(size), { headers: { "content-length": "0" } }) },
			{ host: "feeds.draftyak.example" },
		);
		const hub = track(
			createMockHub({
				mode: "in-memory",
				plugin: toolFixture(undefined, { maxBytes: 4 }),
				upstreams: [fake],
				secrets: { calendarUrl: `https://${fake.host}/data` },
			}),
		);
		const result = await hub.call("kb.lookup", { topic: "test" });
		if (size === 4) {
			expect(result.isError).not.toBe(true);
			expect(hub.host.denials).toEqual([]);
		} else {
			expect(result.isError).toBe(true);
			expect(hub.host.denials[0]?.reason).toBe("RESPONSE_TOO_LARGE");
		}
		expect(fake.recorder.takeRequests()).toHaveLength(1);
	}
});
it("accepts exactly 33554432 tool response bytes and refuses the first excess byte", {
	timeout: 20_000,
}, async () => {
	// This case measures byte admission, independent of the runner's stream-processing speed.
	vi.useFakeTimers({ toFake: ["Date", "performance", "setTimeout", "clearTimeout"] });
	for (const size of [33_554_432, 33_554_433]) {
		const fake = createToolUpstream({ oversizeBytes: size });
		const hub = track(
			createMockHub({
				mode: "in-memory",
				plugin: toolFixture(),
				upstreams: [fake],
				secrets: { calendarUrl: `https://${fake.host}/oversize.ics` },
			}),
		);
		const result = await hub.call("kb.lookup", { topic: "test" });
		if (size === 33_554_432)
			expect(result.structuredContent).toMatchObject({
				entries: [{ label: "bytes", text: "33554432" }, expect.any(Object)],
			});
		else {
			expect(result.isError).toBe(true);
			expect(hub.host.denials[0]?.reason).toBe("RESPONSE_TOO_LARGE");
		}
		await hub.close();
	}
});
it("returns a fixed timeout before a bounded slow response can be admitted", async () => {
	// Host time moves only after dispatch, so a busy runner can't use up the 5 ms budget first.
	// The upstream's delay runs on real time, so it stays far beyond that budget.
	vi.useFakeTimers({ toFake: ["Date", "performance", "setTimeout", "clearTimeout"] });
	const fake = createToolUpstream({ slowMs: 30_000 });
	const dispatched = Promise.withResolvers<void>();
	const hub = track(
		createMockHub({
			mode: "in-memory",
			plugin: toolFixture(undefined, { timeoutMs: 5 }),
			upstreams: [
				{
					...fake,
					fetch(input, init) {
						dispatched.resolve();
						return fake.fetch(input, init);
					},
				},
			],
			secrets: { calendarUrl: `https://${fake.host}/slow.ics` },
		}),
	);
	const result = hub.call("kb.lookup", { topic: "test" });
	await Promise.race([dispatched.promise, result]);
	await vi.advanceTimersByTimeAsync(5);
	expect(hub.host.denials[0]?.reason).toBe("FETCH_TIMEOUT");
	expect((await result).isError).toBe(true);
	expect(fake.recorder.takeRequests()).toHaveLength(1);
});
it("does not follow or admit redirect responses from a declared fake upstream", async () => {
	const fake = createToolUpstream();
	const hub = track(
		createMockHub({
			mode: "in-memory",
			plugin: toolFixture(),
			upstreams: [fake],
			secrets: { calendarUrl: `https://${fake.host}/redirect.ics` },
		}),
	);
	expect((await hub.call("kb.lookup", { topic: "test" })).isError).toBe(true);
	expect(hub.host.denials[0]?.reason).toBe("REDIRECT_REFUSED");
	expect(fake.recorder.takeRequests().map((request) => request.target)).toEqual(["/redirect.ics"]);
});
it("checks the manifest's output ceiling independently of the kind's shared ceiling", async () => {
	const hub = track(
		createMockHub({
			mode: "in-memory",
			plugin: toolFixture(async () => ({ entries: [] }), { outputMaxBytes: 10 }),
			upstreams: [],
		}),
	);
	await expect(hub.call("kb.lookup", { topic: "test" })).rejects.toThrow("TOOL_RESULT_TOO_LARGE");
});
it("refuses an oversized raw tool request before invoking its handler", async () => {
	const handler = vi.fn(async () => ({ entries: [] }));
	const hub = track(
		createMockHub({ mode: "in-memory", plugin: toolFixture(handler), upstreams: [] }),
	);
	await expect(
		hub.call("kb.lookup", { topic: "test" }, { padding: "x".repeat(65_536) }),
	).rejects.toThrow("TOOL_FRAME_TOO_LARGE");
	expect(handler).not.toHaveBeenCalled();
});
it("checks raw output frames before decoding can erase unknown or oversized fields", async () => {
	const hub = track(
		createMockHub({
			mode: "in-memory",
			plugin: toolFixture(async () => ({
				entries: [{ label: "result", text: "x".repeat(65_536) }],
			})),
			upstreams: [],
		}),
	);
	await expect(hub.call("kb.lookup", { topic: "test" })).rejects.toThrow("TOOL_FRAME_TOO_LARGE");
});
