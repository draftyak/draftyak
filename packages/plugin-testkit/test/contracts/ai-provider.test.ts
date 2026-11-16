import { aiProviderV1, checkDraftOutcome } from "@draftyak/protocol/ai-provider-v1";
import { extensionDeclaration } from "@draftyak/protocol/extension";
import { describe, expect, it, vi } from "vitest";
import {
	type AiProviderContractOptions,
	aiProviderContract,
	checkAiProviderModels,
	checkAiProviderOutput,
	checkAiProviderProbe,
	checkAiProviderProgress,
	checkAiProviderSurface,
} from "../../src/contracts/ai-provider.ts";
import { createMockHub } from "../../src/mock-hub.ts";
import { aiFixture, fixtures, outcome, request } from "../fixtures/ai-fixture/plugin.ts";
import { badAiFixture } from "../fixtures/ai-fixture-bad/plugin.ts";
import { badProgressAiFixture } from "../fixtures/ai-fixture-progress-bad/plugin.ts";

function options(plugin = aiFixture()): AiProviderContractOptions {
	return { plugin, mode: "in-memory", fixtures };
}

await aiProviderContract(options());

describe("direct provider contract checks", () => {
	it("passes each exported check with independent fixture state", async () => {
		let prepared = 0;
		for (const check of [
			checkAiProviderSurface,
			checkAiProviderModels,
			checkAiProviderProbe,
			checkAiProviderOutput,
			checkAiProviderProgress,
		]) {
			expect(
				await check({
					...options(),
					fixtures: () => {
						prepared++;
						return fixtures();
					},
				}),
			).toEqual({ status: "pass" });
		}
		expect(prepared).toBe(5);
	});

	it("fails the recipient twin after the SDK normalizes it into a schema-valid invalid outcome", async () => {
		const plugin = badAiFixture();
		const hub = createMockHub({ mode: "in-memory", plugin, upstreams: [] });
		try {
			const result = await hub.call("ai_draft_generate", { ...request });
			expect(checkDraftOutcome(result, request.contextIds)).toMatchObject({
				ok: true,
				isError: false,
			});
			expect(result.structuredContent).toMatchObject({ kind: "invalid" });
			expect(result.structuredContent).not.toHaveProperty("output");
		} finally {
			await hub.close();
		}
		expect(await checkAiProviderOutput(options(plugin))).toEqual({
			status: "fail",
			code: "AI_DRAFT_NOT_GENERATED",
		});
	});

	it("checks the actual extension digest", async () => {
		const plugin = aiFixture();
		const wrong = {
			...plugin,
			entry: {
				...plugin.entry,
				extensions: {
					[aiProviderV1.id]: {
						...extensionDeclaration(aiProviderV1),
						schemaDigest: "0".repeat(64),
					},
				},
			},
		};
		expect(await checkAiProviderSurface(options(wrong))).toEqual({
			status: "fail",
			code: "AI_SURFACE_INVALID",
		});
	});

	it("fails when one of the four canonical tools is absent", async () => {
		const plugin = aiFixture();
		const missing = {
			...plugin,
			entry: {
				...plugin.entry,
				tools: plugin.entry.tools.filter((tool) => tool.name !== "ai_probe"),
			},
		};
		expect(await checkAiProviderSurface(options(missing))).toEqual({
			status: "fail",
			code: "AI_SURFACE_INVALID",
		});
	});

	it("requires the scripted model and refuses duplicate model ids", async () => {
		expect(
			await checkAiProviderModels(options(aiFixture({ listModels: () => ({ models: [] }) }))),
		).toEqual({
			status: "fail",
			code: "AI_MODEL_MISSING",
		});
		expect(
			await checkAiProviderModels(
				options(
					aiFixture({
						listModels: () => ({ models: [{ id: request.model }, { id: request.model }] }),
					}),
				),
			),
		).toEqual({ status: "fail", code: "AI_MODELS_INVALID" });
	});

	it("does not pass a degraded probe or an error result", async () => {
		expect(
			await checkAiProviderProbe(options(aiFixture({ probe: () => ({ status: "degraded" }) }))),
		).toEqual({
			status: "fail",
			code: "AI_PROBE_UNHEALTHY",
		});
		expect(
			await checkAiProviderProbe(
				options(
					aiFixture({
						probe: () => {
							throw new Error("DYTEST-private-detail");
						},
					}),
				),
			),
		).toEqual({
			status: "fail",
			code: "AI_PROBE_INVALID",
		});
	});

	it("does not pass a schema-valid non-draft branch or a different valid draft", async () => {
		expect(
			await checkAiProviderOutput(
				options(
					aiFixture({
						generateDraft: () => ({
							kind: "refusal",
							model: request.model,
							fallback: false,
							usage: { input: 1, output: 0 },
							category: null,
							explanation: null,
							recommendedModel: null,
						}),
					}),
				),
			),
		).toEqual({ status: "fail", code: "AI_DRAFT_NOT_GENERATED" });
		expect(
			await checkAiProviderOutput(
				options(
					aiFixture({
						generateDraft: () => ({
							...structuredClone(outcome),
							output: { ...structuredClone(outcome.output), body: "DYTEST-A different reply." },
						}),
					}),
				),
			),
		).toEqual({ status: "fail", code: "AI_DRAFT_MISMATCH" });
	});

	it("requires observed MCP progress from the invocation that returns the expected outcome", async () => {
		expect(
			await checkAiProviderProgress(
				options(aiFixture({ generateDraft: () => structuredClone(outcome) })),
			),
		).toEqual({
			status: "fail",
			code: "AI_PROGRESS_MISSING",
		});
		expect(await checkAiProviderProgress(options(badProgressAiFixture()))).toEqual({
			status: "fail",
			code: "AI_PROGRESS_INVALID",
		});
		expect(await checkAiProviderProgress(options(badAiFixture()))).toEqual({
			status: "fail",
			code: "AI_DRAFT_MISMATCH",
		});
	});

	it("keeps caller-request progress separate from host/progress", async () => {
		const hub = createMockHub({ mode: "in-memory", plugin: aiFixture(), upstreams: [] });
		try {
			expect(
				(await hub.call("ai_draft_generate", { ...request }, { progressToken: 0 }))
					.structuredContent,
			).toEqual(outcome);
			expect(hub.host.progress).toEqual([]);
			expect(hub.host.denials).toEqual([]);
		} finally {
			await hub.close();
		}
	});

	it.each([
		["initial", 10_000],
		["initial", 10_001],
		["between", 10_000],
		["between", 10_001],
		["tail", 10_000],
		["tail", 10_001],
	] as const)("checks the %s progress gap boundary at %ims", async (phase, gap) => {
		let now = 100;
		const clock = vi.spyOn(performance, "now").mockImplementation(() => now);
		try {
			const result = await checkAiProviderProgress(
				options(
					aiFixture({
						async generateDraft(_args, context) {
							if (phase === "initial") now += gap;
							await context.progress(0, 1);
							if (phase === "between") now += gap;
							await context.progress(1, 1);
							if (phase === "tail") now += gap;
							return structuredClone(outcome);
						},
					}),
				),
			);
			expect(result).toEqual(
				gap === 10_000 ? { status: "pass" } : { status: "fail", code: "AI_PROGRESS_INVALID" },
			);
		} finally {
			clock.mockRestore();
		}
	});

	it("returns content-free failure codes for fixture preparation and malformed expected output", async () => {
		expect(
			await checkAiProviderOutput({
				...options(),
				fixtures: () => {
					throw new Error("DYTEST-private-detail");
				},
			}),
		).toEqual({
			status: "fail",
			code: "AI_FIXTURES_INVALID",
		});
		expect(
			await checkAiProviderOutput({
				...options(),
				fixtures: () => ({ ...fixtures(), expected: { ...outcome, output: {} } as typeof outcome }),
			}),
		).toEqual({
			status: "fail",
			code: "AI_FIXTURES_INVALID",
		});
		expect(
			await checkAiProviderProgress({
				...options(),
				fixtures: () => ({ ...fixtures(), progress: [] }),
			}),
		).toEqual({
			status: "fail",
			code: "AI_FIXTURES_INVALID",
		});
	});
});
