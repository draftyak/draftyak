import { createToolUpstream } from "@draftyak/fakes";
import { afterEach, expect, it } from "vitest";
import { createMockHub, type MockHub } from "../src/index.ts";
import { toolFixture } from "./fixtures/tool/plugin.ts";

const hubs: MockHub[] = [];
const track = (hub: MockHub): MockHub => {
	hubs.push(hub);
	return hub;
};
afterEach(async () => {
	await Promise.all(hubs.splice(0).map((hub) => hub.close()));
});
it("requires a private hub-started lookup instead of trusting caller metadata or labels", async () => {
	const fake = createToolUpstream();
	const hub = track(
		createMockHub({
			mode: "in-memory",
			plugin: toolFixture(),
			upstreams: [fake],
			secrets: { calendarUrl: fake.secretUrl },
		}),
	);
	await hub.discover();
	await hub.listTools();
	await expect(
		hub.host.request("host/fetch", { method: "GET", url: "secret://calendarUrl", headers: [] }),
	).rejects.toThrow("DENIED");
	expect(hub.host.denials[0]).toMatchObject({ reason: "LOOKUP_REQUIRED", lookup: null });
	expect(fake.recorder.takeRequests()).toEqual([]);
	expect(
		(
			await hub.call(
				"kb.lookup",
				{ topic: "real" },
				{ lookup: "forged", instanceId: "forged", account: "forged" },
			)
		).isError,
	).not.toBe(true);
	expect(fake.recorder.takeRequests()).toHaveLength(1);
});
it("permits four requests in each call and records/refuses the fifth before dispatch", async () => {
	const fake = createToolUpstream();
	const plugin = toolFixture(async (_args, context) => {
		for (let index = 0; index < 5; index++) {
			const reply = await context.fetch("secret://calendarUrl");
			await reply.arrayBuffer();
		}
		return { entries: [] };
	});
	const hub = track(
		createMockHub({
			mode: "in-memory",
			plugin,
			upstreams: [fake],
			secrets: { calendarUrl: fake.secretUrl },
		}),
	);
	for (let index = 0; index < 2; index++)
		expect((await hub.call("kb.lookup", { topic: "test" })).isError).toBe(true);
	expect(fake.recorder.takeRequests()).toHaveLength(8);
	expect(hub.host.denials.map((row) => row.reason)).toEqual([
		"LOOKUP_REQUEST_LIMIT",
		"LOOKUP_REQUEST_LIMIT",
	]);
	expect(new Set(hub.host.denials.map((row) => row.lookup)).size).toBe(2);
});
it("accounts concurrent independent lookups separately across asynchronous handlers", async () => {
	const fake = createToolUpstream();
	const barrier = Promise.withResolvers<void>();
	let arrived = 0;
	const plugin = toolFixture(async (_args, context) => {
		const first = await context.fetch("secret://calendarUrl");
		await first.arrayBuffer();
		if (++arrived === 2) barrier.resolve();
		await barrier.promise;
		for (let index = 0; index < 3; index++) {
			const reply = await context.fetch("secret://calendarUrl");
			await reply.arrayBuffer();
		}
		return { entries: [] };
	});
	const hub = track(
		createMockHub({
			mode: "in-memory",
			plugin,
			upstreams: [fake],
			secrets: { calendarUrl: fake.secretUrl },
		}),
	);
	const results = await Promise.all([
		hub.call("kb.lookup", { topic: "first" }),
		hub.call("kb.lookup", { topic: "second" }),
	]);
	expect(results.map((result) => result.structuredContent)).toEqual([
		{ entries: [] },
		{ entries: [] },
	]);
	expect(fake.recorder.takeRequests()).toHaveLength(8);
	expect(hub.host.denials).toEqual([]);
});
it("retires captured lookup authority so deferred host work cannot outlive its call", async () => {
	const fake = createToolUpstream();
	const release = Promise.withResolvers<void>();
	let late: Promise<unknown> | undefined;
	let hub: MockHub;
	const plugin = toolFixture(async () => {
		late = release.promise
			.then(() =>
				hub.host.request("host/fetch", { method: "GET", url: "secret://calendarUrl", headers: [] }),
			)
			.catch((error: unknown) => error);
		return { entries: [] };
	});
	hub = track(
		createMockHub({
			mode: "in-memory",
			plugin,
			upstreams: [fake],
			secrets: { calendarUrl: fake.secretUrl },
		}),
	);
	expect((await hub.call("kb.lookup", { topic: "test" })).structuredContent).toEqual({
		entries: [],
	});
	release.resolve();
	expect(await late).toMatchObject({ code: "DENIED" });
	expect(hub.host.denials[0]?.reason).toBe("LOOKUP_REQUIRED");
	expect(hub.host.denials[0]?.lookup).not.toBeNull();
	expect(fake.recorder.takeRequests()).toEqual([]);
});
it("cancels pending upstream work when the host closes", async () => {
	const fake = createToolUpstream({ slowMs: Infinity });
	const hub = track(
		createMockHub({
			mode: "in-memory",
			plugin: toolFixture(),
			upstreams: [fake],
			secrets: { calendarUrl: `https://${fake.host}/slow.ics` },
		}),
	);
	const call = hub.call("kb.lookup", { topic: "test" });
	const settled = call.catch((error: unknown) => error);
	let received = 0;
	for (let tries = 0; tries < 100 && received === 0; tries++) {
		received += fake.recorder.takeRequests().length;
		if (!received) await new Promise((resolve) => setImmediate(resolve));
	}
	expect(received).toBe(1);
	await hub.close();
	expect(await settled).toMatchObject({ code: "DENIED" });
});
it("keeps tool KV in memory, copies JSON and records allowed logs", async () => {
	const hub = track(createMockHub({ mode: "in-memory", plugin: toolFixture(), upstreams: [] }));
	const value = { nested: [1] };
	await hub.host.request("host/kv.set", { key: "key", value });
	value.nested.push(2);
	expect(await hub.host.request("host/kv.get", { key: "key" })).toEqual({ value: { nested: [1] } });
	await hub.host.request("host/log", { level: "info", message: "synthetic log" });
	expect(hub.host.logs).toEqual([{ level: "info", message: "synthetic log" }]);
	await hub.host.request("host/kv.delete", { key: "key" });
	expect(await hub.host.request("host/kv.get", { key: "key" })).toEqual({ value: null });
	await hub.close();
	const fresh = track(createMockHub({ mode: "in-memory", plugin: toolFixture(), upstreams: [] }));
	expect(await fresh.host.request("host/kv.get", { key: "key" })).toEqual({ value: null });
});
