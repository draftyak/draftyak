import { createFake } from "@draftyak/fakes";
import type { ResponsesHttpBindingInput } from "@draftyak/protocol/manifest/responses-http";
import type { PluginContext } from "@draftyak/sdk";
import type { AiProviderFixtures } from "../../../src/contracts/ai-provider.ts";
import type { MockPlugin } from "../../../src/types.ts";
import { origin, outcome, request, responsesProvider } from "./plugin.ts";

export interface ResponsesProviderFixture extends AiProviderFixtures {
	readonly responsesHttp: readonly ResponsesHttpBindingInput[];
}

export interface ResponsesContractFixture {
	readonly plugin: MockPlugin;
	readonly calls: { method: string; url: string; body: string }[];
	fixtures(): ResponsesProviderFixture;
}

export function createResponsesContractFixture(
	observe?: (context: PluginContext) => void,
): ResponsesContractFixture {
	const calls: { method: string; url: string; body: string }[] = [];
	return {
		plugin: responsesProvider(observe),
		calls,
		fixtures(): ResponsesProviderFixture {
			const upstream = createFake(
				{
					async fetch(input) {
						calls.push({ method: input.method, url: input.url, body: await input.text() });
						const url = new URL(input.url);
						if (url.pathname === "/v1/models")
							return Response.json({ models: [{ id: request.model }] });
						if (url.pathname === `/v1/models/${request.model}`)
							return Response.json({ status: "ok" });
						if (url.pathname === "/v1/responses") return Response.json(outcome);
						return new Response(null, { status: 404 });
					},
				},
				{ host: "api.openai.com" },
			);
			return {
				upstreams: [upstream],
				request: structuredClone(request),
				expected: structuredClone(outcome),
				progress: [{ progress: 0, total: 1 }, { progress: 1, total: 1 }],
				responsesHttp: [
					{ operation: "ai_models_list", origin },
					{ operation: "ai_probe", origin, model: request.model },
					{ operation: "ai_draft_generate", origin, draft: structuredClone(request) },
				],
			};
		},
	};
}
