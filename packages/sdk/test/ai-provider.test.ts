import { aiProviderV1, type DraftOutcome, DraftProblem } from "@draftyak/protocol/ai-provider-v1";
import { MAX_DRAFT_PROBLEMS } from "@draftyak/protocol/draft-output";
import { describe, expect, it } from "vitest";
import { type AiProviderPluginDefinition, defineAiProviderPlugin } from "../src/ai-provider.ts";
import { PluginError } from "../src/errors.ts";
import { memoryHost } from "../src/host.ts";
import { aiManifest, channelManifest, served } from "./definitions-fixtures.ts";

const common = { model: "test-model", fallback: false, usage: { input: null, output: 1 } };
const outcomes: DraftOutcome[] = [
	{
		...common,
		kind: "draft",
		output: {
			body: "Hello",
			ownerNotes: "",
			needsOwnerInput: [],
			suspectedInstructions: false,
			contextRefs: ["c1"],
		},
	},
	{ ...common, kind: "refusal", category: null, explanation: null, recommendedModel: null },
	{ ...common, kind: "truncated", stopReason: "max_tokens" },
	{ ...common, kind: "invalid", problems: ["output.body: too_big"] },
	{ ...common, kind: "unexpected", stopReason: null },
];
function definition(
	generateDraft: AiProviderPluginDefinition["generateDraft"] = () => outcomes[0] as DraftOutcome,
): AiProviderPluginDefinition {
	return {
		manifest: aiManifest,
		describe: () => ({ name: "Test provider", structuredOutput: "validated" }),
		listModels: () => ({ models: [{ id: "test-model" }] }),
		probe: () => ({ status: "ok" }),
		generateDraft,
	};
}
const args = { model: "test-model", system: "Instructions", prompt: "Message", contextIds: ["c1"] };
describe("provider definitions", () => {
	it("keeps request context IDs independent of provider argument mutation", async () => {
		const draft = outcomes[0] as Extract<DraftOutcome, { kind: "draft" }>;
		await served(
			defineAiProviderPlugin(
				definition((request) => {
					(request.contextIds as string[]).splice(0, 1, "c2");
					return { ...draft, output: { ...draft.output, contextRefs: ["c2"] } };
				}),
			),
			async (ask) => {
				const value = (await ask("tools/call", { name: "ai_draft_generate", arguments: args }))
					.result?.structuredContent;
				expect(value).toEqual({ ...draft, output: { ...draft.output, contextRefs: [] } });
			},
		);
	});
	it("normalizes draft references against required request context IDs before returning the outcome", async () => {
		const draft = outcomes[0] as Extract<DraftOutcome, { kind: "draft" }>;
		const cases: { refs?: unknown; request: string[]; expected: string[] }[] = [
			{ refs: ["c2"], request: ["c1"], expected: [] },
			{
				refs: ["C2", "c1", "C2", "unknown", "c3"],
				request: ["c3", "c1", "c2"],
				expected: ["c3", "c1", "c2"],
			},
			{ request: ["c1"], expected: [] },
			{ refs: { c1: true }, request: ["c1"], expected: [] },
			{ refs: "c1", request: ["c1"], expected: [] },
			{ refs: [null, 1, "C1", "c1"], request: ["c1"], expected: ["c1"] },
			{ refs: ["c1"], request: [], expected: [] },
		];
		for (const item of cases) {
			const { contextRefs: _refs, ...body } = draft.output;
			const value = {
				...draft,
				output: { ...body, ...(Object.hasOwn(item, "refs") ? { contextRefs: item.refs } : {}) },
			};
			await served(defineAiProviderPlugin(definition(() => value as DraftOutcome)), async (ask) => {
				const result = (
					await ask("tools/call", {
						name: "ai_draft_generate",
						arguments: { ...args, contextIds: item.request },
					})
				).result;
				expect(result?.isError).not.toBe(true);
				expect(result?.structuredContent).toEqual({
					...draft,
					output: { ...draft.output, contextRefs: item.expected },
				});
			});
		}
	});
	it("maps invalid draft bodies to a bounded content-free invalid outcome instead of a tool error", async () => {
		const draft = outcomes[0] as Extract<DraftOutcome, { kind: "draft" }>;
		for (const output of [
			{ ...draft.output, body: "x".repeat(8001) },
			{ ...draft.output, body: 1, needsOwnerInput: Array.from({ length: 50 }, () => 1) },
		]) {
			await served(
				defineAiProviderPlugin(definition(() => ({ ...draft, output }) as DraftOutcome)),
				async (ask) => {
					const result = (await ask("tools/call", { name: "ai_draft_generate", arguments: args }))
						.result;
					expect(result?.isError).not.toBe(true);
					const value = result?.structuredContent as Record<string, unknown>;
					expect(value).toMatchObject({ ...common, kind: "invalid" });
					expect(value).not.toHaveProperty("output");
					const problems = value.problems as unknown[];
					expect(problems.length).toBeGreaterThan(0);
					expect(problems.length).toBeLessThanOrEqual(20);
					for (const problem of problems)
						expect(DraftProblem.safeParse(problem).success).toBe(true);
					expect(MAX_DRAFT_PROBLEMS).toBe(20);
				},
			);
		}
	});
	it("serves exactly the provider tools and every DraftOutcome branch with progress", async () => {
		const progress: unknown[] = [];
		const host = memoryHost((method, params) => {
			expect(method).toBe("host/progress");
			progress.push(params);
			return null;
		});
		let index = 0;
		await served(
			defineAiProviderPlugin(
				definition(async (_args, context) => {
					await context.progress(index, 5);
					return outcomes[index++] as DraftOutcome;
				}),
			),
			async (ask) => {
				const list = (await ask("tools/list")).result?.tools as { name: string }[];
				expect(list.map((item) => item.name).sort()).toEqual(
					Object.keys(aiProviderV1.tools).sort(),
				);
				for (const expected of outcomes)
					expect(
						(await ask("tools/call", { name: "ai_draft_generate", arguments: args })).result
							?.structuredContent,
					).toEqual(expected);
			},
			{},
			host,
		);
		expect(progress).toHaveLength(0);
	});
	it("requires exact own function handlers and the provider manifest kind", () => {
		for (const key of ["describe", "listModels", "probe", "generateDraft"]) {
			const input = { ...definition() } as Record<string, unknown>;
			delete input[key];
			expect(() =>
				defineAiProviderPlugin(input as unknown as AiProviderPluginDefinition),
			).toThrow();
		}
		expect(() => defineAiProviderPlugin({ ...definition(), manifest: channelManifest })).toThrow();
		expect(() =>
			defineAiProviderPlugin({ ...definition(), prompts: [] } as AiProviderPluginDefinition),
		).toThrow();
		let invoked = 0;
		expect(() =>
			defineAiProviderPlugin(
				Object.defineProperty(definition(), "probe", {
					enumerable: true,
					get() {
						invoked++;
						return () => ({ status: "ok" });
					},
				}),
			),
		).toThrow();
		expect(invoked).toBe(0);
	});
	it("does not return malformed drafts or recipient fields to the hub", async () => {
		const draft = outcomes[0] as Extract<DraftOutcome, { kind: "draft" }>;
		for (const output of [
			{
				...draft,
				output: {
					...draft.output,
					to: ["forged"],
				},
			},
			{ ...common, kind: "invalid", problems: ["untrusted-private-detail!"] },
			{ ...common, kind: "draft", output: { body: "missing" } },
		]) {
			await served(
				defineAiProviderPlugin(definition(() => output as DraftOutcome)),
				async (ask) => {
					const result = (await ask("tools/call", { name: "ai_draft_generate", arguments: args }))
						.result;
					if (output.kind === "draft") {
						expect(result?.isError).not.toBe(true);
						expect(result?.structuredContent).toMatchObject({ ...common, kind: "invalid" });
						expect(result?.structuredContent).not.toHaveProperty("output");
					} else
						expect(result).toMatchObject({
							isError: true,
							structuredContent: { code: "TRANSIENT" },
						});
					expect(JSON.stringify(result)).not.toContain("untrusted-private-detail");
				},
			);
		}
	});
	it("preserves typed errors and rejects missing context IDs without entering the provider", async () => {
		for (const [error, expected] of [
			[
				new PluginError("RATE_LIMITED", { retryAfterMs: 250 }),
				{ code: "RATE_LIMITED", retryAfterMs: 250 },
			],
			[new Error("untrusted-private-detail"), { code: "TRANSIENT" }],
		] as const) {
			await served(
				defineAiProviderPlugin(
					definition(() => {
						throw error;
					}),
				),
				async (ask) => {
					const result = (await ask("tools/call", { name: "ai_draft_generate", arguments: args }))
						.result;
					expect(result).toMatchObject({ isError: true, structuredContent: expected });
					expect(JSON.stringify(result)).not.toContain("untrusted-private-detail");
				},
			);
		}
		let calls = 0;
		await served(
			defineAiProviderPlugin(
				definition(() => {
					calls++;
					return outcomes[0] as DraftOutcome;
				}),
			),
			async (ask) => {
				const { contextIds: _ids, ...missing } = args;
				const reply = await ask("tools/call", { name: "ai_draft_generate", arguments: missing });
				expect(reply.result?.isError === true || reply.error !== undefined).toBe(true);
			},
		);
		expect(calls).toBe(0);
	});
	it("does not execute draft output or reference behavior before normalization", async () => {
		let executed = 0;
		const draft = outcomes[0] as Extract<DraftOutcome, { kind: "draft" }>;
		for (const output of [
			Object.defineProperty({ ...draft.output }, "contextRefs", {
				enumerable: true,
				get() {
					executed++;
					return ["c1"];
				},
			}),
			new Proxy(draft.output, {
				ownKeys() {
					executed++;
					return [];
				},
			}),
			{
				...draft.output,
				contextRefs: new Proxy(["c1"], {
					get() {
						executed++;
						return 1;
					},
				}),
			},
		]) {
			await served(
				defineAiProviderPlugin(definition(() => ({ ...draft, output }) as DraftOutcome)),
				async (ask) => {
					expect(
						(await ask("tools/call", { name: "ai_draft_generate", arguments: args })).result,
					).toMatchObject({ isError: true, structuredContent: { code: "TRANSIENT" } });
				},
			);
		}
		expect(executed).toBe(0);
	});
});
