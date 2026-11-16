import type { MockPlugin } from "../../../src/types.ts";
import { aiFixture, outcome } from "../ai-fixture/plugin.ts";

export function badProgressAiFixture(): MockPlugin {
	return aiFixture({
		async generateDraft(_args, context) {
			await context.progress(1, 1);
			await context.progress(0, 1);
			return structuredClone(outcome);
		},
	});
}

export const plugin: MockPlugin = badProgressAiFixture();
