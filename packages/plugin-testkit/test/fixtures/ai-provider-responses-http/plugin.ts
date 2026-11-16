import { type DraftOutcome, type DraftRequest } from "@draftyak/protocol/ai-provider-v1";
import { DraftOutputV1 } from "@draftyak/protocol/draft-output";
import type { PluginManifestV1 } from "@draftyak/protocol/manifest";
import { defineAiProviderPlugin, type PluginContext } from "@draftyak/sdk";
import type { MockPlugin } from "../../../src/types.ts";
import { manifest as scripted, outcome, request } from "../ai-fixture/plugin.ts";

export { outcome, request };
export const origin = "https://api.openai.com" as const;
if (scripted.kind !== "ai-provider") throw new Error("Bound provider fixture requires a provider");
export const manifest: PluginManifestV1 = {
	...scripted,
	id: "@example/bound-responses-provider",
	egress: { profile: "responses-api-v1" },
};
const schema = DraftOutputV1.toJSONSchema({
	target: "draft-7",
	override: ({ jsonSchema }) => {
		delete jsonSchema.uniqueItems;
	},
});

export function responseBody(input: DraftRequest): string {
	return JSON.stringify({
		model: input.model,
		instructions: input.system,
		input: [{ role: "user", content: input.prompt }],
		text: { format: { type: "json_schema", name: "draft_output", strict: true, schema } },
		stream: true,
		store: false,
	});
}

export function responsesProvider(observe?: (context: PluginContext) => void): MockPlugin {
	return {
		manifest,
		entry: defineAiProviderPlugin({
			manifest,
			describe: () => ({ name: "Bound Responses fixture", structuredOutput: "native" }),
			async listModels(_input, context) {
				const reply = await context.fetch(`${origin}/v1/models`, {
					headers: { accept: "application/json", authorization: "Bearer brokered" },
					stream: true,
				});
				return (await reply.json()) as { models: [{ id: string }] };
			},
			async probe(input, context) {
				const reply = await context.fetch(`${origin}/v1/models/${input.model}`, {
					headers: { accept: "application/json", authorization: "Bearer brokered" },
					stream: true,
				});
				return (await reply.json()) as { status: "ok" };
			},
			async generateDraft(input, context) {
				observe?.(context);
				await context.progress(0, 1);
				const reply = await context.fetch(`${origin}/v1/responses`, {
					method: "POST",
					headers: { "content-type": "application/json", authorization: "Bearer brokered" },
					body: responseBody(input),
					stream: true,
				});
				const result = (await reply.json()) as DraftOutcome;
				await context.progress(1, 1);
				return result;
			},
		}),
	};
}

export const plugin: MockPlugin = responsesProvider();
