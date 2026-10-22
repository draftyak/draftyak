import { createHelloFake, createToolUpstream, TOOL_SECRET_PATH } from "@draftyak/fakes";
import { createPluginServer } from "@draftyak/sdk";
import { createMcpHandler } from "@modelcontextprotocol/server";
import { afterEach, expect, it } from "vitest";
import { createMockHub, headerValue, type MockHub, modernRequest } from "../src/index.ts";
import { channelFixture } from "./fixtures/channel/plugin.ts";
import { toolFixture } from "./fixtures/tool/plugin.ts";

const hubs: MockHub[] = [];
afterEach(async () => {
	await Promise.all(hubs.splice(0).map((hub) => hub.close()));
});
it("drives modern discovery, list/call and idempotent close through the merged factory", async () => {
	const hub = createMockHub({
		mode: "in-memory",
		plugin: channelFixture(),
		upstreams: [createHelloFake()],
	});
	hubs.push(hub);
	expect((await hub.discover()).supportedVersions).toContain("2026-07-28");
	expect((await hub.listTools()).tools).toEqual(
		expect.arrayContaining([expect.objectContaining({ name: "channel_fetch" })]),
	);
	const result = await hub.call("channel_fetch", {
		url: "https://hello.draftyak.example/v1/conversations",
	});
	expect(result.structuredContent).toMatchObject({ status: 200 });
	await hub.close();
	await hub.close();
	await expect(hub.discover()).rejects.toThrow("HOST_CLOSED");
});
it("preserves secret address bytes at the fake and only exposes the four tool headers", async () => {
	const upstream = createToolUpstream();
	const hub = createMockHub({
		mode: "in-memory",
		plugin: toolFixture(),
		upstreams: [upstream],
		secrets: { calendarUrl: upstream.secretUrl },
	});
	hubs.push(hub);
	const result = await hub.call("kb.lookup", { topic: "calendar" });
	expect(result.isError).not.toBe(true);
	expect(result.structuredContent).toMatchObject({
		entries: [
			{ label: "bytes", text: expect.any(String) },
			{ label: "headers", text: "content-length,content-type,etag,last-modified" },
		],
	});
	expect(upstream.recorder.takeRequests().map((request) => request.target)).toEqual([
		TOOL_SECRET_PATH,
	]);
	expect(hub.host.denials).toEqual([]);
});
it("uses header sentinel encoding, preserves empty values and omits undefined headers", () => {
	expect(headerValue("safe-name")).toBe("safe-name");
	expect(headerValue("caf\u00e9")).toBe("=?base64?Y2Fmw6k=?=");
	expect(headerValue("=?base64?eA==?=")).not.toBe("=?base64?eA==?=");
	const request = modernRequest(
		"tools/call",
		{ name: "caf\u00e9", arguments: {} },
		{ headers: { "x-empty": "", "x-omit": undefined } },
	);
	expect(request.headers.get("mcp-name")).toBe("=?base64?Y2Fmw6k=?=");
	expect(request.headers.get("x-empty")).toBe("");
	expect(request.headers.has("x-omit")).toBe(false);
});
it("rejects the legacy era in the actual in-memory handler", async () => {
	const plugin = channelFixture();
	const hub = createMockHub({ mode: "in-memory", plugin, upstreams: [] });
	hubs.push(hub);
	const handler = createMcpHandler(createPluginServer(plugin.entry, hub.host), {
		legacy: "reject",
		responseMode: "json",
	});
	const reply = await handler.fetch(
		new Request("http://127.0.0.1/mcp", {
			method: "POST",
			headers: { "content-type": "application/json", "mcp-protocol-version": "2025-11-25" },
			body: JSON.stringify({
				jsonrpc: "2.0",
				id: 1,
				method: "initialize",
				params: {
					protocolVersion: "2025-11-25",
					capabilities: {},
					clientInfo: { name: "test", version: "1" },
				},
			}),
		}),
	);
	expect(reply.status).not.toBe(200);
});
it("refuses unsupported process mode, bad manifests and mismatched identity before serving", () => {
	expect(() => createMockHub({ mode: "process", plugin: channelFixture(), upstreams: [] })).toThrow(
		"PROCESS_MODE_UNAVAILABLE",
	);
	expect(() =>
		createMockHub({
			mode: "in-memory",
			plugin: { ...channelFixture(), manifest: {} },
			upstreams: [],
		}),
	).toThrow("MANIFEST_INVALID");
	const plugin = channelFixture();
	expect(() =>
		createMockHub({
			mode: "in-memory",
			plugin: { ...plugin, entry: { ...plugin.entry, plugin: "other" } },
			upstreams: [],
		}),
	).toThrow("PLUGIN_IDENTITY_MISMATCH");
});
