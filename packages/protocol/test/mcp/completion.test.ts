import { describe, expect, it } from "vitest";
import {
	AuthorizedAliases,
	COMPLETION_LIMIT,
	COMPLETION_METHOD,
	COMPLETION_WINDOW_MS,
	CompletionRequest,
	CompletionResult,
	completeArgument,
	completionTarget,
} from "../../src/mcp/completion.ts";

const scopes = ["inbox:read", "drafts:write"] as const;
const request = (name: string, value = "", prompt = "triage_inbox"): CompletionRequest => ({
	ref: { type: "ref/prompt", name: prompt },
	argument: { name, value },
});
describe("MCP completion contracts", () => {
	it("exposes only allowlisted aliases and fixed window/tone choices", () => {
		expect(
			completeArgument(request("account", "g"), { aliases: ["gmail-1", "slack-1"] }, scopes),
		).toEqual({ values: ["gmail-1"], total: 1, hasMore: false });
		expect(completeArgument(request("window"), { aliases: [] }, scopes).values).toEqual([
			"24h",
			"72h",
			"7d",
		]);
		expect(
			completeArgument(request("tone", "", "draft_reply"), { aliases: [] }, scopes).values,
		).toEqual(["brief", "neutral", "warm"]);
		expect(
			completeArgument(request("account", "owner@example.test"), { aliases: ["gmail-1"] }, scopes)
				.values,
		).toEqual([]);
	});
	it("never completes item IDs, resource variables, arbitrary fields or unheld prompt arguments", () => {
		for (const name of [
			"conversationId",
			"draftId",
			"messageId",
			"subject",
			"label",
			"contact",
			"phone",
			"body",
		])
			expect(completeArgument(request(name), { aliases: ["gmail-1"] }, scopes).values).toEqual([]);
		expect(completionTarget(request("account", "", "unknown"), scopes)).toBeNull();
		expect(
			completeArgument(request("tone", "", "draft_reply"), { aliases: [] }, ["inbox:read"]).values,
		).toEqual([]);
		expect(
			completeArgument(
				{
					ref: { type: "ref/resource", uri: "draftyak://conversation/{id}" },
					argument: { name: "id", value: "" },
				},
				{ aliases: ["gmail-1"] },
				scopes,
			).values,
		).toEqual([]);
	});
	it("caps unique matches at twenty with truthful total and hasMore", () => {
		const aliases = Array.from({ length: 25 }, (_, i) => `mail-${i}`);
		const result = completeArgument(
			request("account"),
			{ aliases: [...aliases, aliases[0] ?? ""] },
			scopes,
		);
		expect(result).toEqual({ values: aliases.slice(0, 20), total: 25, hasMore: true });
		expect(CompletionResult.parse(result)).toEqual(result);
		for (const bad of [
			{ ...result, values: aliases },
			{ ...result, total: 19 },
			{ ...result, hasMore: false },
			{ values: ["owner@example.test"], total: 1, hasMore: false },
		])
			expect(CompletionResult.safeParse(bad).success).toBe(false);
	});
	it("accepts a named strict alias projection, never generic metadata, and fixes the separate rate policy", () => {
		expect(AuthorizedAliases.safeParse({ aliases: ["gmail-1"], subject: "CANARY" }).success).toBe(
			false,
		);
		expect(() =>
			completeArgument(request("account"), { aliases: ["owner@example.test"] }, scopes),
		).toThrow();
		expect(() =>
			completeArgument(request("account"), { aliases: ["gmail-1\n"] }, scopes),
		).toThrow();
		expect(CompletionRequest.safeParse({ ...request("window"), owner: "CANARY" }).success).toBe(
			false,
		);
		expect(COMPLETION_METHOD).toBe("completion/complete");
		expect([COMPLETION_LIMIT, COMPLETION_WINDOW_MS]).toEqual([60, 60000]);
	});
});
