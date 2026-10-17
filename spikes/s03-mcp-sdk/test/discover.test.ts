import { describe, expect, it } from "vitest";
import { createApp, createMcpServer } from "../src/server.ts";
import { initialize, modern, serve } from "./harness.ts";

const app = createApp();
const DECLARED = {
	tools: { listChanged: false },
	resources: { listChanged: false },
	prompts: { listChanged: false },
	extensions: { "io.modelcontextprotocol/ui": {} },
};

describe("server/discover", () => {
	it("declares tools, resources, prompts and the Apps extension, never listChanged or subscribe", async () => {
		const response = await serve(app, modern("server/discover"));
		expect(response.status).toBe(200);
		const { result } = response.body;
		expect(result.resultType).toBe("complete");
		expect(result.supportedVersions).toEqual(["2026-07-28"]);
		expect(result.capabilities).toEqual(DECLARED);
		expect(result._meta["io.modelcontextprotocol/serverInfo"]).toEqual({
			name: "draftyak-spike-s03",
			version: "0.0.0",
		});
	});

	it("gives 2025-era clients the same capabilities through initialize", async () => {
		const { result } = (await serve(app, initialize())).body;
		const discovered = (await serve(app, modern("server/discover"))).body.result;
		expect(result.capabilities).toEqual(discovered.capabilities);
	});

	it("keeps that declaration when a factory passes capabilities of its own", async () => {
		const extended = createApp({
			factory: () => {
				const server = createMcpServer({ capabilities: { completions: {} } });
				server.registerPrompt("hello", { description: "a prompt" }, () => ({ messages: [] }));
				server.registerResource("note", "test://note", {}, (uri) => ({
					contents: [{ uri: uri.href, mimeType: "text/plain", text: "note" }],
				}));
				return server;
			},
		});
		const { result } = (await serve(extended, modern("server/discover"))).body;
		expect(result.capabilities).toEqual({ ...DECLARED, completions: {} });
	});

	it("answers the same whatever clientInfo says", async () => {
		const bodies = [];
		for (const name of ["hosted-client", "desktop-client", "cli-client", "x7f3"]) {
			const response = await serve(
				app,
				modern("server/discover", {}, { clientInfo: { name, version: "1" } }),
			);
			bodies.push(response.body);
		}
		expect(new Set(bodies.map((body) => JSON.stringify(body))).size).toBe(1);
	});

	it("is answered the same way by every one of several fresh requests", async () => {
		const all = await Promise.all(
			[1, 2, 3].map((id) => serve(app, modern("server/discover", {}, { id }))),
		);
		expect(all.map((response) => response.body.id)).toEqual([1, 2, 3]);
		expect(new Set(all.map((response) => JSON.stringify(response.body.result))).size).toBe(1);
	});
});
