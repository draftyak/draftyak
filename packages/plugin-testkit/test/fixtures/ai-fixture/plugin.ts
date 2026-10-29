import {
	AI_PROVIDER_V1,
	type DraftOutcome,
	type DraftRequest,
} from "@draftyak/protocol/ai-provider-v1";
import type { PluginManifestV1 } from "@draftyak/protocol/manifest";
import { type AiProviderPluginDefinition, defineAiProviderPlugin } from "@draftyak/sdk";
import type { AiProviderFixtures } from "../../../src/contracts/ai-provider.ts";
import type { MockPlugin } from "../../../src/types.ts";

export const manifest: PluginManifestV1 = {
	id: "@example/scripted-provider",
	version: "1.0.0",
	kind: "ai-provider",
	sdk: "1.0.0",
	runtime: "node",
	isolation: "standard",
	contract: { extension: AI_PROVIDER_V1, version: 1 },
	auth: { kind: "none", scopes: [], requiredGrantedScopes: [] },
	credentials: { mode: "brokered", urlSecrets: [] },
	permissions: {},
	dataClasses: ["example.content"],
	license: "Apache-2.0",
	egress: { profile: "messages-api-v1" },
};

export const request: DraftRequest = {
	model: "scripted-model",
	system: "DYTEST-Return the scripted reply body only.",
	prompt: "DYTEST-A fictional message asks when the sample is ready.",
	contextIds: ["c1"],
};

export const outcome: Extract<DraftOutcome, { kind: "draft" }> = {
	kind: "draft",
	model: "scripted-model",
	fallback: false,
	usage: { input: 8, output: 6 },
	output: {
		body: "DYTEST-The sample is ready for review.",
		ownerNotes: "DYTEST-Check the sample before replying.",
		needsOwnerInput: [],
		suspectedInstructions: false,
		contextRefs: ["c1"],
	},
};

export function aiFixture(overrides: Partial<Omit<AiProviderPluginDefinition, "manifest">> = {}): MockPlugin {
	return {
		manifest,
		entry: defineAiProviderPlugin({
			manifest,
			describe: () => ({ name: "Scripted provider", structuredOutput: "validated" }),
			listModels: () => ({ models: [{ id: "scripted-model", contextTokens: 2048, fallbacks: false }] }),
			probe: () => ({ status: "ok" }),
			async generateDraft(_args, context) {
				await context.progress(0, 1);
				await context.progress(1, 1);
				return structuredClone(outcome);
			},
			...overrides,
		}),
	};
}

export function fixtures(): AiProviderFixtures {
	return {
		upstreams: [],
		request: structuredClone(request),
		expected: structuredClone(outcome),
		progress: [{ progress: 0, total: 1 }, { progress: 1, total: 1 }],
	};
}

export const plugin: MockPlugin = aiFixture();
