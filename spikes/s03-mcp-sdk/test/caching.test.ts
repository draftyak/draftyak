import { describe, expect, it } from "vitest";
import { createApp, createMcpServer } from "../src/server.ts";
import { conformanceFactory } from "./conformance-fixtures.ts";
import { initialize, legacy, modern, serve } from "./harness.ts";

// §6: the list and read results carry exact hints; tool calls, completion and InputRequiredResult
// carry none.
const HOUR = { cacheScope: "public", ttlMs: 3_600_000 };
const MINUTE_PRIVATE = { cacheScope: "private", ttlMs: 60_000 };
const NO_STORE = { cacheScope: "private", ttlMs: 0 };

function factory() {
	const server = createMcpServer();
	server.registerResource("mail", "draftyak://message/01J9Z8Y7X6W5V4T3S2R1Q0P9N8", {}, (uri) => ({
		contents: [{ uri: uri.href, mimeType: "text/plain", text: "fake mail" }],
	}));
	const guide = { cacheHint: { cacheScope: "public", ttlMs: 3_600_000 } } as const;
	server.registerResource("guide", "draftyak://guide/agents", guide, (uri) => ({
		contents: [{ uri: uri.href, mimeType: "text/plain", text: "fake guide" }],
	}));
	return server;
}

const hints = (result: { ttlMs?: number; cacheScope?: string }) => ({
	cacheScope: result.cacheScope,
	ttlMs: result.ttlMs,
});

describe("caching hints (SEP-2549)", () => {
	const app = createApp({ factory });

	it.each([
		["server/discover", {}, HOUR],
		["resources/list", {}, HOUR],
		["tools/list", {}, MINUTE_PRIVATE],
		["prompts/list", {}, MINUTE_PRIVATE],
		["resources/templates/list", {}, MINUTE_PRIVATE],
		["resources/read", { uri: "draftyak://message/01J9Z8Y7X6W5V4T3S2R1Q0P9N8" }, NO_STORE],
		["resources/read", { uri: "draftyak://guide/agents" }, HOUR],
	])("%s %j carries %j", async (method, params, expected) => {
		const response = await serve(app, modern(method, params));
		expect(hints(response.body.result)).toEqual(expected);
	});

	it("puts none on tool calls, completions and InputRequiredResults", async () => {
		const call = await serve(app, modern("tools/call", { name: "accounts_list", arguments: {} }));
		expect(hints(call.body.result)).toEqual({ cacheScope: undefined, ttlMs: undefined });

		const fixtures = createApp({ factory: conformanceFactory() });
		const elicitation = { elicitation: {} };
		const pending = await serve(
			fixtures,
			modern(
				"tools/call",
				{ name: "test_input_required_result_elicitation", arguments: {} },
				{ capabilities: elicitation },
			),
		);
		expect(pending.body.result.resultType).toBe("input_required");
		expect(hints(pending.body.result)).toEqual({ cacheScope: undefined, ttlMs: undefined });
		const completion = await serve(
			fixtures,
			modern("completion/complete", {
				ref: { type: "ref/prompt", name: "test_prompt_with_arguments" },
				argument: { name: "arg1", value: "par" },
			}),
		);
		expect(completion.body.result.completion.values).toEqual(["paris", "park", "party"]);
		expect(hints(completion.body.result)).toEqual({ cacheScope: undefined, ttlMs: undefined });
	});

	it("keeps the other hints when a factory sets one, or capabilities, of its own", async () => {
		const tuned = createApp({
			factory: () =>
				createMcpServer({
					capabilities: { completions: {} },
					cacheHints: { "tools/list": { cacheScope: "private", ttlMs: 5_000 } },
				}),
		});
		const expected = [
			["tools/list", { cacheScope: "private", ttlMs: 5_000 }],
			["server/discover", HOUR],
			["resources/list", HOUR],
			["prompts/list", MINUTE_PRIVATE],
			["resources/templates/list", MINUTE_PRIVATE],
		] as const;
		for (const [method, hint] of expected) {
			expect(hints((await serve(tuned, modern(method))).body.result)).toEqual(hint);
		}
	});

	it("never adds them to 2025-era results", async () => {
		expect(hints((await serve(app, initialize())).body.result)).toEqual({
			cacheScope: undefined,
			ttlMs: undefined,
		});
		for (const method of [
			"tools/list",
			"prompts/list",
			"resources/list",
			"resources/templates/list",
		]) {
			const response = await serve(app, legacy(method));
			expect(hints(response.body.result)).toEqual({ cacheScope: undefined, ttlMs: undefined });
		}
	});
});
