import { markStdioFixtureReady } from "../stdio-readiness.ts";
import { defineAiProviderPlugin } from "../../src/ai-provider.ts";
import { serve } from "../../src/serve.ts";
import { aiManifest } from "../definitions-fixtures.ts";

serve(defineAiProviderPlugin({manifest: aiManifest,
	describe: () => ({name: "Progress fixture", structuredOutput: "validated"}),
	listModels: () => ({models: []}), probe: async (_args, context) => {await context.progress("legacy-host-label", 1, 2); return {status: "ok"};},
	generateDraft: async (_args, context) => {
		await context.progress(1, 2);
		return {kind: "unexpected", model: "test-model", fallback: false, usage: {input: null, output: 0}, stopReason: null};
	},
}));

markStdioFixtureReady();
