import { createFake } from "@draftyak/fakes";
import type { AiProviderFixtures } from "@draftyak/plugin-testkit";
import type { DraftRequest } from "@draftyak/protocol/ai-provider-v1";
import { DraftOutputV1 } from "@draftyak/protocol/draft-output";
import type { ResponsesHttpBindingInput } from "@draftyak/protocol/manifest/responses-http";

export const origin = "https://api.openai.com" as const;
export const request: DraftRequest = {
	model: "gpt-process-fixture",
	system: "Draft a plain-text reply.",
	prompt: "Synthetic thread; propose Tuesday.",
	contextIds: ["c1"],
};
const draft: DraftOutputV1 = {
	body: "Tuesday works for me.",
	ownerNotes: "Synthetic note.",
	needsOwnerInput: [],
	suspectedInstructions: false,
	contextRefs: ["c1"],
};

export function expectedPost(): unknown {
	const schema = DraftOutputV1.toJSONSchema({
		target: "draft-7",
		override: ({ jsonSchema }) => {
			delete jsonSchema.uniqueItems;
		},
	});
	return {
		model: request.model,
		instructions: request.system,
		input: [{ role: "user", content: request.prompt }],
		text: { format: { type: "json_schema", name: "draft_output", strict: true, schema } },
		stream: true,
		store: false,
	};
}

export const resources = (): Record<string, number> => {
	const names = ["ProcessWrap", "PipeWrap", "PipeServerWrap", "TCPServerWrap"];
	const active = process.getActiveResourcesInfo();
	return Object.fromEntries(names.map((name) => [name, active.filter((item) => item === name).length]));
};

export function processContractFixture(): {
	readonly calls: { method: string; url: string; body: string; processes: number }[];
	readonly before: Record<string, number>;
	readonly fixtures: AiProviderFixtures & {
		readonly responsesHttp: readonly ResponsesHttpBindingInput[];
	};
} {
	const calls: { method: string; url: string; body: string; processes: number }[] = [];
	const before = resources();
	const upstream = createFake({
		async fetch(input) {
			calls.push({
				method: input.method,
				url: input.url,
				body: await input.text(),
				processes: resources().ProcessWrap ?? 0,
			});
			const target = new URL(input.url).pathname;
			if (target === "/v1/models")
				return Response.json({ object: "list", data: [{ object: "model", id: request.model }] });
			if (target === `/v1/models/${request.model}`)
				return Response.json({ object: "model", id: request.model });
			if (target === "/v1/responses") {
				const event = {
					type: "response.completed",
					response: {
						status: "completed",
						model: request.model,
						usage: { input_tokens: 100, output_tokens: 50 },
						output: [{
							type: "message",
							role: "assistant",
							status: "completed",
							content: [{ type: "output_text", text: JSON.stringify(draft), annotations: [] }],
						}],
					},
				};
				// A finite body supplies genuine EOF after the completed event.
				return new Response(`event: response.completed\ndata: ${JSON.stringify(event)}\n\n`, {
					headers: { "content-type": "text/event-stream" },
				});
			}
			return new Response(null, { status: 404 });
		},
	}, { host: "api.openai.com" });
	return {
		calls,
		before,
		fixtures: {
			upstreams: [upstream],
			request: structuredClone(request),
			expected: {
				kind: "draft",
				model: request.model,
				fallback: false,
				usage: { input: 100, output: 50 },
				output: structuredClone(draft),
			},
			progress: [{ progress: 0 }],
			responsesHttp: [
				{ operation: "ai_models_list", origin },
				{ operation: "ai_probe", origin, model: request.model },
				{ operation: "ai_draft_generate", origin, draft: structuredClone(request) },
			],
		},
	};
}
