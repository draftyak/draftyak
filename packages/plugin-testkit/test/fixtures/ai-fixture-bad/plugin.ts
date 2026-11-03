import type { DraftOutcome } from "@draftyak/protocol/ai-provider-v1";
import type { MockPlugin } from "../../../src/types.ts";
import { aiFixture, outcome } from "../ai-fixture/plugin.ts";

export function badAiFixture(): MockPlugin {
	return aiFixture({
		async generateDraft(_args, context) {
			await context.progress(0, 1);
			await context.progress(1, 1);
			return {
				...structuredClone(outcome),
				output: { ...structuredClone(outcome.output), to: ["DYTEST-recipient"] },
			} as DraftOutcome;
		},
	});
}

export const plugin: MockPlugin = badAiFixture();
