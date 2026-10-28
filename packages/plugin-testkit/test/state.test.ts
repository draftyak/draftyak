import { createHelloFake, createToolUpstream } from "@draftyak/fakes";
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
});

it("accepts only a trusted instance id and empty configuration until configuration bootstrap exists", () => {
	for (const instance of [
		"00000000000000000000000001",
		{ id: "00000000000000000000000001", config: {} },
	])
		track(createMockHub({ mode: "in-memory", plugin: channelFixture(), instance, upstreams: [] }));
	expect(() =>
		createMockHub({
			mode: "in-memory",
			plugin: channelFixture(),
			instance: { id: "00000000000000000000000001", config: { enabled: true } },
			upstreams: [],
		}),
	).toThrow("INSTANCE_CONFIG_UNAVAILABLE");
	expect(() =>
		createMockHub({
			mode: "in-memory",
			plugin: channelFixture(),
			instance: "untrusted-label",
			upstreams: [],
		}),
	).toThrow("INVALID_INSTANCE");
});
it("requires explicit matching account binding and snapshots mode before plugin execution", async () => {
	const id = "00000000000000000000000002";
	expect(() =>
		createMockHub({ mode: "in-memory", plugin: channelFixture(undefined, id), upstreams: [] }),
	).toThrow("ACCOUNT_MISMATCH");
	const account = { id, mode: "read_only" as "read_only" | "full" };
	const fake = createHelloFake();
	const hub = track(
		createMockHub({
			mode: "in-memory",
			plugin: channelFixture(undefined, id),
			account,
			upstreams: [fake],
		}),
	);
	account.mode = "full";
	await expect(
		hub.host.request("host/fetch", {
			method: "PATCH",
			url: `https://${fake.host}/v1/conversations/conv-1`,
			headers: [],
		}),
	).rejects.toThrow("DENIED");
	expect(hub.host.denials[0]?.reason).toBe("FULL_MODE_REQUIRED");
	expect(fake.recorder.takeRequests()).toEqual([]);
});
it("detaches and freezes the validated manifest before subsequent source mutation", async () => {
	const plugin = channelFixture();
	const fake = createHelloFake();
	const hub = track(createMockHub({ mode: "in-memory", plugin, upstreams: [fake] }));
	const manifest = plugin.manifest as { egress: { rules: { pathTemplate: string }[] } };
	const first = manifest.egress.rules[0];
	if (!first) throw new Error("fixture");
	first.pathTemplate = "/unlisted";
	expect(Object.isFrozen(hub.manifest)).toBe(true);
	await expect(
		hub.host.request("host/fetch", {
			method: "GET",
			url: `https://${fake.host}/unlisted`,
			headers: [],
		}),
	).rejects.toThrow("DENIED");
	expect(
		(
			await hub.host.request("host/fetch", {
				method: "GET",
				url: `https://${fake.host}/v1/conversations`,
				headers: [],
			})
		).status,
	).toBe(200);
});
it("refuses undeclared and unknown tool names before invoking a plugin handler", async () => {
	const handler = vi.fn(async () => ({ entries: [] }));
	const plugin = toolFixture(handler);
	const extra = { ...plugin.entry.tools[0], name: "calendar.free_busy", handler };
	const hub = track(
		createMockHub({
			mode: "in-memory",
			plugin: {
				...plugin,
				entry: { ...plugin.entry, tools: [...plugin.entry.tools, extra] },
			} as never,
			upstreams: [],
		}),
	);
	await expect(hub.call("calendar.free_busy", {})).rejects.toThrow("TOOL_NAME_UNDECLARED");
	await expect(hub.call("arbitrary.lookup", {})).rejects.toThrow("TOOL_NAME_UNDECLARED");
	expect(handler).not.toHaveBeenCalled();
});
it("records channel progress and keeps independently bounded in-memory key/value state", async () => {
	const hub = track(createMockHub({ mode: "in-memory", plugin: channelFixture(), upstreams: [] }));
	await hub.host.request("host/progress", { token: "synthetic", progress: 1, total: 2 });
	expect(hub.host.progress).toEqual([{ token: "synthetic", progress: 1, total: 2 }]);
	await expect(
		hub.host.request("host/kv.set", { key: "too-large", value: "x".repeat(65536) }),
	).rejects.toThrow("TOO_LARGE");
	for (let index = 0; index < 1024; index++)
		await hub.host.request("host/kv.set", { key: `k${index}`, value: index });
	await expect(hub.host.request("host/kv.set", { key: "excess", value: 0 })).rejects.toThrow(
		"TOO_LARGE",
	);
	await hub.host.request("host/kv.set", { key: "k0", value: "replacement" });
	expect(await hub.host.request("host/kv.get", { key: "k0" })).toEqual({ value: "replacement" });
});
it("cannot represent a truncated denial audit as complete", async () => {
	const fake = createHelloFake();
	const hub = track(
		createMockHub({ mode: "in-memory", plugin: channelFixture(), upstreams: [fake] }),
	);
	for (let index = 0; index < 4097; index++)
		await hub.host
			.request("host/fetch", { method: "GET", url: `https://${fake.host}/unlisted`, headers: [] })
			.catch(() => {});
	expect(hub.host.denials).toHaveLength(4096);
	expect(hub.host.auditComplete).toBe(false);
	expect(hub.host.disabled).toBe(true);
	expect(fake.recorder.takeRequests()).toEqual([]);
});
it("burns a found ticket before a missing body reference refuses the request", async () => {
	const fake = createHelloFake();
	const hub = track(
		createMockHub({ mode: "in-memory", plugin: channelFixture(), upstreams: [fake] }),
	);
	const url = `https://${fake.host}/v1/conversations/conv-1/messages?idempotency_key=00000000000000000000000003`;
	const headers = [["Content-Type", "application/json"]] as const;
	const now = Date.now();
	const ticket = hub.host.mintTicket({
		outboxId: "00000000000000000000000003",
		method: "POST",
		url,
		headers,
		body: new Uint8Array(),
		mintedAt: now,
		deliverBy: now + 1000,
	});
	await expect(
		hub.host.request("host/fetch", {
			method: "POST",
			url,
			headers,
			body: { ref: "00000000000000000000000009" },
			sendTicket: ticket,
		}),
	).rejects.toThrow("DENIED");
	expect(hub.host.denials[0]?.reason).toBe("BODY_REF_UNKNOWN");
	expect(hub.host.hasTicket(ticket.id)).toBe(false);
	expect(fake.recorder.takeRequests()).toEqual([]);
});
it("allows a declared HEAD within a lookup without treating it as a body-bearing GET", async () => {
	const fake = createToolUpstream();
	const plugin = toolFixture(
		async (_input, context) => {
			const response = await context.fetch("secret://calendarUrl", { method: "HEAD" });
			return { entries: [{ label: String(response.status), text: await response.text() }] };
		},
		{
			rules: [
				{
					class: "read",
					method: "HEAD",
					url: "secret://calendarUrl",
					maxBytes: 1024,
					timeoutMs: 1000,
				},
			],
		},
	);
	const hub = track(
		createMockHub({
			mode: "in-memory",
			plugin,
			upstreams: [fake],
			secrets: { calendarUrl: fake.secretUrl },
		}),
	);
	expect((await hub.call("kb.lookup", { topic: "test" })).structuredContent).toEqual({
		entries: [{ label: "200", text: "" }],
	});
	expect(fake.recorder.takeRequests()).toHaveLength(1);
});
