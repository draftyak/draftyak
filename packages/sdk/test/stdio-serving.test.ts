import {
	canonicalToolsV1,
	checkToolResult,
	TOOL_ERROR_META_KEY,
	TOOL_EXTENSION_ID,
	toolExtensionDeclaration,
} from "@draftyak/protocol/tool-v1";
import { describe, expect, it } from "vitest";
import { stdioFixture } from "./stdio-fixture.ts";

describe("real stdio plugin serving", () => {
	it("discovers, lists absent optional properties, and calls a canonical tool after a typed error", async () => {
		const peer = stdioFixture(new URL("./fixtures/stdio-serving.ts", import.meta.url));
		const { ask } = peer;
		try {
			const discovery = await ask("server/discover");
			expect(discovery?.error).toBeUndefined();
			expect(discovery.result?.capabilities, peer.diagnostics()).toEqual({
				tools: { listChanged: false },
				extensions: { [TOOL_EXTENSION_ID]: toolExtensionDeclaration },
			});
			const listed = await ask("tools/list");
			expect(listed?.result?.tools).toMatchObject([
				{
					name: "tool_describe",
					description: canonicalToolsV1.tool_describe.entry.description,
					inputSchema: canonicalToolsV1.tool_describe.entry.inputSchema,
					outputSchema: canonicalToolsV1.tool_describe.entry.outputSchema,
				},
			]);
			expect(listed?.error).toBeUndefined();
			const tools = listed?.result?.tools as Record<string, unknown>[];
			expect(tools).toHaveLength(1);
			for (const absent of ["title", "annotations", "icons", "_meta"])
				expect(tools[0]).not.toHaveProperty(absent);

			const limited = await ask("tools/call", { name: "tool_describe", arguments: {} });
			expect(limited?.error).toBeUndefined();
			expect(checkToolResult("tool_describe", limited?.result)).toEqual({
				status: "error",
				error: { code: "RATE_LIMITED", retryAfterMs: 250, detail: "Try later" },
			});
			expect(limited?.result).not.toHaveProperty("structuredContent");
			expect(limited?.result?._meta).toMatchObject({
				[TOOL_ERROR_META_KEY]: { code: "RATE_LIMITED", retryAfterMs: 250 },
			});

			const recovered = await ask("tools/call", { name: "tool_describe", arguments: {} });
			expect(recovered?.error).toBeUndefined();
			expect(checkToolResult("tool_describe", recovered?.result)).toMatchObject({
				status: "ok",
				value: { kinds: ["kb.lookup"] },
			});
			expect(recovered?.result).toMatchObject({ structuredContent: { kinds: ["kb.lookup"] } });
			expect(peer.stderr()).toBe("");
		} finally {
			await peer.close();
		}
	}, 20_000);
});
