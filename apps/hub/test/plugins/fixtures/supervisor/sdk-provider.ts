import { defineAiProviderPlugin, serve } from "@draftyak/sdk";

// A real SDK AI-provider server, bundled into one module at test time.
serve(
	defineAiProviderPlugin({
		manifest: {
			id: "dytest-provider",
			version: "1.0.0",
			sdk: "1.0.0",
			isolation: "standard",
			kind: "ai-provider",
			contract: { extension: "io.github.draftyak/ai-provider", version: 1 },
			auth: { kind: "none", scopes: [], requiredGrantedScopes: [] },
			credentials: { mode: "brokered", urlSecrets: [] },
			permissions: {},
			dataClasses: ["dytest.content"],
			license: "Apache-2.0",
			egress: { profile: "messages-api-v1" },
		},
		describe: () => ({ name: "DYTEST provider", structuredOutput: "validated" }),
		listModels: () => ({ models: [] }),
		probe: () => ({ status: "ok" }),
		generateDraft: async (_args, context) => {
			await context.progress(1, 3);
			await context.fetch("https://provider.dytest.invalid/v1/messages");
			await context.progress(2, 3);
			return {
				kind: "unexpected",
				model: "test-model",
				fallback: false,
				usage: { input: 1, output: 1 },
				stopReason: null,
			};
		},
	}),
);
