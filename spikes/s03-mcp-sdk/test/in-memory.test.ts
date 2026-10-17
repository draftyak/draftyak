import { createMcpHandler, type McpServer } from "@modelcontextprotocol/server";
import { describe, expect, it } from "vitest";
import { createMcpServer, type ServerFactory } from "../src/server.ts";
import { modern, serve } from "./harness.ts";

// The SDK entry itself, no Hono and no socket: what M1's testkit in-memory mode drives.
const entry = (factory: ServerFactory) =>
	createMcpHandler(factory, { legacy: "reject", responseMode: "json" });

describe("in-memory 2026-era harness", () => {
	it("answers server/discover with capabilities.extensions and lists both fake read tools", async () => {
		const handler = entry(() => createMcpServer());
		const discover = await serve(handler, modern("server/discover"));
		expect(discover.status).toBe(200);
		expect(discover.body.result.supportedVersions).toEqual(["2026-07-28"]);
		expect(discover.body.result.capabilities.extensions).toEqual({
			"io.modelcontextprotocol/ui": {},
		});

		const tools = await serve(handler, modern("tools/list"));
		const listed = tools.body.result.tools;
		expect(listed.map((tool: { name: string }) => tool.name)).toEqual([
			"accounts_list",
			"message_get",
		]);
		for (const tool of listed) {
			expect(tool.annotations).toEqual({
				readOnlyHint: true,
				destructiveHint: false,
				idempotentHint: true,
				openWorldHint: false,
			});
		}
		const call = await serve(
			handler,
			modern("tools/call", {
				name: "message_get",
				arguments: { messageId: "01J9Z8Y7X6W5V4T3S2R1Q0P9N8" },
			}),
		);
		expect(call.body.result.structuredContent).toMatchObject({ untrusted: true });
	});

	it("serves repeated liveness calls, concurrent ones included, each on a fresh McpServer", async () => {
		const made = new Set<McpServer>();
		const handler = entry(() => {
			const server = createMcpServer();
			made.add(server);
			return server;
		});
		const calls = Array.from({ length: 6 }, (_, id) =>
			serve(handler, modern("server/discover", {}, { id })),
		);
		const served = [...(await Promise.all(calls)), await serve(handler, modern("server/discover"))];
		expect(served.map((response) => response.status)).toEqual(Array(7).fill(200));
		expect(served.every((response) => response.body.result.capabilities.extensions)).toBe(true);
		expect(made.size).toBe(7);
	});

	it("fails a request that overlaps another on a shared McpServer, hence one per request", async () => {
		const { promise: running, resolve: started } = Promise.withResolvers<void>();
		const { promise: held, resolve: release } = Promise.withResolvers<void>();
		const shared = createMcpServer();
		shared.registerTool("hold", { description: "waits until released" }, async () => {
			started();
			await held;
			return { content: [{ type: "text", text: "released" }] };
		});
		const handler = entry(() => shared);
		const first = serve(handler, modern("tools/call", { name: "hold", arguments: {} }));
		await running;
		const overlapping = await serve(handler, modern("server/discover", {}, { id: 2 }));
		release();
		expect([overlapping.status, overlapping.body.error.code]).toEqual([500, -32603]);
		expect((await first).body.result.content[0].text).toBe("released");
	});
});
