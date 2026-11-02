import { checkDraftOutcome } from "@draftyak/protocol/ai-provider-v1";
import { afterAll, describe, expect, it } from "vitest";
import {
	type AiProviderContractOptions,
	aiProviderContract,
	checkAiProviderOutput,
	checkAiProviderProgress,
} from "../../src/contracts/ai-provider.ts";
import { bindProcessPlugin, createMockHub, type MockPlugin } from "../../src/index.ts";
import { aiFixture, fixtures, request } from "../fixtures/ai-fixture/plugin.ts";
import { aiProcessFixtures } from "../fixtures/ai-fixture/process.ts";
import { badAiFixture } from "../fixtures/ai-fixture-bad/plugin.ts";
import { badProgressAiFixture } from "../fixtures/ai-fixture-progress-bad/plugin.ts";

const packed = await aiProcessFixtures();
afterAll(async () => {
	await packed.cleanup();
});

function parentMustNotRun(plugin: MockPlugin): MockPlugin {
	return {
		...plugin,
		entry: {
			...plugin.entry,
			tools: plugin.entry.tools.map((tool) => ({
				...tool,
				handler() {
					throw new Error("Parent provider handler executed");
				},
			})),
		},
	};
}

function options(
	variant: "good" | "recipientBad" | "progressBad" = "good",
): AiProviderContractOptions {
	const plugin =
		variant === "recipientBad"
			? badAiFixture()
			: variant === "progressBad"
				? badProgressAiFixture()
				: aiFixture();
	return {
		plugin: bindProcessPlugin(parentMustNotRun(plugin), packed[variant]),
		fixtures,
	};
}

await aiProviderContract(options());

describe("provider contracts through the retained process driver", () => {
	it("refuses the bundled recipient twin after SDK normalization", async () => {
		const contract = options("recipientBad");
		const hub = createMockHub({ mode: "process", plugin: contract.plugin, upstreams: [] });
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
		expect(await checkAiProviderOutput(contract)).toEqual({
			status: "fail",
			code: "AI_DRAFT_NOT_GENERATED",
		});
		expect(await checkAiProviderProgress(contract)).toEqual({
			status: "fail",
			code: "AI_DRAFT_MISMATCH",
		});
	});

	it("keeps the progress twin's final output valid", async () => {
		expect(await checkAiProviderOutput(options("progressBad"))).toEqual({ status: "pass" });
	});

	it("refuses the bundled progress twin with the same valid final draft", async () => {
		expect(await checkAiProviderProgress(options("progressBad"))).toEqual({
			status: "fail",
			code: "AI_PROGRESS_INVALID",
		});
	});
});
