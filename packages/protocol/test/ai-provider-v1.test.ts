import { Validator } from "@cfworker/json-schema";
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
	AI_PROVIDER_V1,
	aiProviderV1,
	checkDraftOutcome,
	DraftOutcome,
} from "../src/ai-provider-v1.ts";
import { validateDraftOutput } from "../src/draft-output.ts";
import { checkToolCall, checkToolResult } from "../src/extension.ts";
import { agree, committed, withMember } from "./plugin-contracts.ts";

const output = {
	body: "Thanks, DYTEST. Tuesday at 10 works for me.",
	ownerNotes: "",
	needsOwnerInput: [],
	suspectedInstructions: false,
	contextRefs: ["c1"],
};
const ran = { model: "claude-opus-5-5", fallback: false, usage: { input: 1_200, output: 300 } };
const loneSurrogate = "DYTEST \ud800";

// M0.30's outcome model, one of each kind (spikes/s09-messages-api/src/draft.ts).
const outcomes = {
	draft: { kind: "draft", ...ran, output },
	fallbackDraft: { kind: "draft", ...ran, model: "claude-opus-4-8", fallback: true, output },
	refusal: {
		kind: "refusal",
		...ran,
		usage: { input: 1_200, output: 0 },
		category: "cyber",
		explanation: "This request was declined (cyber).",
		recommendedModel: null,
	},
	refusalWithoutDetails: {
		kind: "refusal",
		...ran,
		category: null,
		explanation: null,
		recommendedModel: null,
	},
	truncated: {
		kind: "truncated",
		...ran,
		usage: { input: 1_200, output: 16_000 },
		stopReason: "max_tokens",
	},
	contextExceeded: { kind: "truncated", ...ran, stopReason: "model_context_window_exceeded" },
	invalid: { kind: "invalid", ...ran, problems: ["output.body: at most 8000 characters"] },
	// The problems M0.30's parser names: its path without the root, or "output".
	invalidFromParser: {
		kind: "invalid",
		...ran,
		problems: [
			"output: not JSON",
			"output: 2 text blocks",
			"body: too_big",
			"needsOwnerInput.0: too_big",
		],
	},
	unexpected: { kind: "unexpected", ...ran, stopReason: "pause_turn" },
	unexpectedWithoutReason: {
		kind: "unexpected",
		...ran,
		usage: { input: null, output: 0 },
		stopReason: null,
	},
};

const calls = {
	ai_describe: { input: {}, output: { name: "DYTEST provider", structuredOutput: "native" } },
	ai_models_list: {
		input: {},
		output: {
			models: [
				{ id: "claude-opus-5-5", name: "DYTEST large", contextTokens: 200_000, fallbacks: true },
				{ id: "llama3.1:8b" },
			],
		},
	},
	ai_probe: { input: { model: "llama3.1:8b" }, output: { status: "degraded", detail: "slow" } },
	ai_draft_generate: {
		input: {
			model: "claude-opus-5-5",
			system: "Draft a reply in the owner's voice.",
			prompt: "<thread-0f>DYTEST can we meet Tuesday?</thread-0f>",
			contextIds: ["c1"],
		},
		output: outcomes.draft,
	},
};

const schema = committed("schemas/ai-provider-v1.schema.json");
const document = new Validator(schema, "2020-12", false);

describe("ai-provider-v1", () => {
	it("is io.github.draftyak/ai-provider version 1 with §4's four tools, none optional", () => {
		expect(aiProviderV1.id).toBe(AI_PROVIDER_V1);
		expect(aiProviderV1.id).toBe("io.github.draftyak/ai-provider");
		expect(aiProviderV1.version).toBe(1);
		expect(Object.keys(aiProviderV1.tools)).toEqual(Object.keys(calls));
		expect((schema as { required: string[] }).required).toEqual(Object.keys(calls));
	});

	it("accepts a call of every tool, in zod and as an exported document", () => {
		expect(document.validate(calls).valid).toBe(true);
		for (const [name, call] of Object.entries(calls)) {
			const check = checkToolCall(aiProviderV1, { name, arguments: call.input });
			expect(check.ok, name).toBe(true);
			const result = checkToolResult(aiProviderV1, name, { structuredContent: call.output });
			expect(result, name).toEqual({ ok: true, isError: false, value: call.output });
		}
	});

	it.each(Object.entries(calls))(
		"%s refuses an unknown field in its input and output",
		(name, call) => {
			const extended = [
				{ ...call, input: withMember(call.input, "extra", 1) },
				{ ...call, output: withMember(call.output, "extra", 1) },
			];
			for (const changed of extended) {
				expect(document.validate({ ...calls, [name]: changed }).valid).toBe(false);
			}
			expect(checkToolCall(aiProviderV1, { name, arguments: extended[0]?.input }).ok).toBe(false);
			expect(
				checkToolResult(aiProviderV1, name, { structuredContent: extended[1]?.output }).ok,
			).toBe(false);
		},
	);

	it("drafts only with the job's context ids", () => {
		const input = calls.ai_draft_generate.input;
		for (const contextIds of [["c4"], ["c2", "c2"], ["c1", "c2", "c3", "c1"], "c1"]) {
			const call = { name: "ai_draft_generate", arguments: { ...input, contextIds } };
			expect(checkToolCall(aiProviderV1, call).ok).toBe(false);
		}
	});

	it("refuses model ids with a trailing line feed and prompts holding a lone surrogate", () => {
		const input = calls.ai_draft_generate.input;
		const refused = [
			{ ...input, model: "claude-opus-5-5\n" },
			{ ...input, system: loneSurrogate },
			{ ...input, prompt: loneSurrogate },
		];
		for (const args of refused) {
			expect(checkToolCall(aiProviderV1, { name: "ai_draft_generate", arguments: args }).ok).toBe(
				false,
			);
		}
		const probe = { name: "ai_probe", arguments: { model: "llama3.1:8b\n" } };
		expect(checkToolCall(aiProviderV1, probe).ok).toBe(false);
	});
});

describe("DraftOutcome", () => {
	const refused = [
		{ ...outcomes.draft, kind: "error" },
		{ kind: "draft", ...ran },
		{ ...outcomes.draft, output: withMember(output, "recipient", "sam@example.com") },
		{ ...outcomes.draft, output: withMember(output, "subject", "Re: DYTEST") },
		{ ...outcomes.draft, output: withMember(output, "body", "x".repeat(8_001)) },
		{ ...outcomes.truncated, stopReason: "stop_sequence" },
		{ ...outcomes.invalid, problems: [] },
		{ ...outcomes.invalid, problems: ["output.body: Hi Sam, call me at 555-0100"] },
		{ ...outcomes.invalid, problems: ["output.body: at most 8000 characters\n"] },
		{ ...outcomes.invalid, problems: ["the draft said <thread-0f>"] },
		{ ...outcomes.refusal, recommendedModel: undefined },
		withMember(outcomes.unexpected, "output", output),
		withMember(outcomes.draft, "usage", { input: 1, output: null }),
		withMember(outcomes.draft, "fallback", "no"),
		withMember(outcomes.draft, "model", "a model"),
		withMember(outcomes.draft, "model", "claude-opus-5-5\n"),
		(({ usage: _, ...rest }) => rest)(outcomes.draft),
	].map((value) => JSON.parse(JSON.stringify(value)));

	it("is M0.30's outcome union, in zod and the exported schema", () => {
		const json = committed("schemas/ai-provider-v1.schema.json") as {
			properties: { ai_draft_generate: { properties: { output: object } } };
		};
		agree(
			DraftOutcome,
			json.properties.ai_draft_generate.properties.output,
			Object.values(outcomes),
			refused,
		);
	});

	it("refuses an ai_draft_generate result outside the union", () => {
		for (const structuredContent of refused) {
			expect(checkToolResult(aiProviderV1, "ai_draft_generate", { structuredContent }).ok).toBe(
				false,
			);
		}
		const error = {
			isError: true,
			structuredContent: { code: "QUOTA_EXCEEDED", retryAfterMs: 60_000 },
		};
		expect(checkToolResult(aiProviderV1, "ai_draft_generate", error)).toMatchObject({
			ok: true,
			isError: true,
		});
	});

	it("takes validateDraftOutput's problems for any output as an invalid outcome (1,000 runs)", () => {
		const text = fc.oneof(fc.string({ unit: "binary" }), fc.constant("\udc00"), fc.anything());
		const corrupted = fc.record(
			{
				body: text,
				ownerNotes: text,
				needsOwnerInput: fc.oneof(fc.array(text, { maxLength: 30 }), fc.anything()),
				suspectedInstructions: fc.anything(),
				contextRefs: fc.anything(),
				extra: fc.anything(),
			},
			{ requiredKeys: [] },
		);
		fc.assert(
			fc.property(fc.oneof(corrupted, fc.anything()), (value) => {
				const check = validateDraftOutput(value);
				if (check.ok) return;
				const invalid = { kind: "invalid", ...ran, problems: check.problems };
				expect(DraftOutcome.safeParse(invalid).success).toBe(true);
			}),
			{ numRuns: 1000 },
		);
	});

	it("refuses provider text and error details holding a lone surrogate", () => {
		const results = [
			{ structuredContent: { ...outcomes.refusal, explanation: loneSurrogate } },
			{ structuredContent: { ...outcomes.unexpected, stopReason: loneSurrogate } },
			{ structuredContent: { ...outcomes.draft, output: { ...output, body: loneSurrogate } } },
			{ isError: true, structuredContent: { code: "TRANSIENT", detail: loneSurrogate } },
		];
		for (const result of results) {
			const check = checkToolResult(aiProviderV1, "ai_draft_generate", result);
			expect(check).toMatchObject({ ok: false });
			expect(JSON.stringify(check)).toContain("lone surrogate");
		}
	});
});

describe("checkDraftOutcome", () => {
	const draftWith = (contextRefs: unknown) => ({
		structuredContent: { ...outcomes.draft, output: { ...output, contextRefs } },
	});

	it("narrows a draft's contextRefs to the job's ids, so they never fail the draft", () => {
		for (const [refs, ids, kept] of [
			[["C1", "c1", "c4"], ["c1"], ["c1"]],
			[["c3"], ["c1"], []],
			[
				["c2", "c1"],
				["c1", "c2"],
				["c1", "c2"],
			],
			["c1", ["c1"], []],
			[null, ["c1"], []],
		] as const) {
			expect(checkDraftOutcome(draftWith(refs), ids)).toEqual({
				ok: true,
				isError: false,
				value: { ...outcomes.draft, output: { ...output, contextRefs: kept } },
			});
		}
		const { contextRefs: _, ...without } = output;
		const missing = { structuredContent: { ...outcomes.draft, output: without } };
		expect(checkDraftOutcome(missing, ["c1"])).toMatchObject({ ok: true });
		expect(checkToolResult(aiProviderV1, "ai_draft_generate", draftWith(["c3"]))).toMatchObject({
			ok: true,
		});
	});

	it("checks everything else as checkToolResult does", () => {
		for (const result of [
			{ structuredContent: outcomes.refusal },
			{ structuredContent: outcomes.invalidFromParser },
			{ isError: true, structuredContent: { code: "RATE_LIMITED", retryAfterMs: 1_000 } },
			{ structuredContent: { ...outcomes.draft, output: withMember(output, "subject", "x") } },
			{ structuredContent: { ...outcomes.draft, output: "draft" } },
			{ resultType: "input_required", structuredContent: outcomes.draft },
			{ structuredContent: null },
			"result",
			null,
		]) {
			const expected = checkToolResult(aiProviderV1, "ai_draft_generate", result);
			expect(checkDraftOutcome(result, ["c1"])).toEqual(expected);
		}
	});
});
