import { describe, expect, it } from "vitest";
import {
	DraftReplyArguments,
	PROMPTS,
	PrepareSendRequestArguments,
	PromptGetRequest,
	parsePromptArguments,
	promptsFor,
	SummarizeThreadArguments,
	TriageInboxArguments,
} from "../../src/mcp/prompts.ts";

const scopes = ["inbox:read", "drafts:write", "outbox:propose"] as const;
const id = "01ARZ3NDEKTSV4RRFFQ69G5FAV";
describe("MCP prompt contracts", () => {
	it("has exactly four prompts, every argument optional and request objects closed", () => {
		expect(PROMPTS.map((prompt) => prompt.name)).toEqual([
			"triage_inbox",
			"summarize_thread",
			"draft_reply",
			"prepare_send_request",
		]);
		for (const prompt of PROMPTS) {
			expect(prompt.arguments.parse({})).toEqual({});
			expect(PromptGetRequest.safeParse({ name: prompt.name }).success).toBe(true);
			for (const field of ["owner", "subject", "body", "__proto__", "constructor"]) {
				expect(prompt.arguments.safeParse({ [field]: "CANARY_MAILBOX" }).success).toBe(false);
			}
		}
		expect(PromptGetRequest.safeParse({ name: "triage_inbox", extra: true }).success).toBe(false);
	});
	it("holds all required scopes and makes unknown/unheld prompts indistinguishable", () => {
		expect(promptsFor([])).toEqual([]);
		expect(promptsFor(["inbox:read"]).map((entry) => entry.name)).toEqual([
			"triage_inbox",
			"summarize_thread",
		]);
		expect(promptsFor(["drafts:write", "outbox:propose"])).toEqual([]);
		expect(Object.isFrozen(PROMPTS)).toBe(true);
		expect(Object.isFrozen(PROMPTS[0]?.scopes)).toBe(true);
		expect(() => Object.assign(PROMPTS[0] ?? {}, { scopes: [] })).toThrow();
		for (const name of ["draft_reply", "unknown"])
			expect(() => parsePromptArguments(name, {}, ["inbox:read"])).toThrow("Prompt unavailable");
		expect(parsePromptArguments("triage_inbox", undefined, scopes)).toEqual({});
		expect(() => parsePromptArguments("triage_inbox", null, scopes)).toThrow();
	});
	it("accepts only account aliases, fixed window/tone and canonical item IDs", () => {
		expect(TriageInboxArguments.parse({ account: "gmail-1", window: "72h" })).toEqual({
			account: "gmail-1",
			window: "72h",
		});
		expect(SummarizeThreadArguments.parse({ conversationId: id })).toEqual({ conversationId: id });
		expect(DraftReplyArguments.parse({ conversationId: id, tone: "warm" })).toEqual({
			conversationId: id,
			tone: "warm",
		});
		expect(PrepareSendRequestArguments.parse({ draftId: id })).toEqual({ draftId: id });
		for (const bad of [
			{ account: "owner@example.test" },
			{ account: "gmail-1\n" },
			{ account: "Inbox Name" },
			{ window: "30d" },
			{ window: 24 },
		])
			expect(TriageInboxArguments.safeParse(bad).success).toBe(false);
		for (const bad of [{ tone: "send-now" }, { conversationId: id.toLowerCase() }, { draftId: id }])
			expect(DraftReplyArguments.safeParse(bad).success).toBe(false);
	});
});
