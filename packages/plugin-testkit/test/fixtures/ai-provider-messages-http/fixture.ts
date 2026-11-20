import { createFake } from "@draftyak/fakes";
import { type DraftOutcome, type DraftRequest } from "@draftyak/protocol/ai-provider-v1";
import type { AiProviderFixtures } from "../../../src/contracts/ai-provider.ts";
import type { MockPlugin } from "../../../src/types.ts";
import { messagesProvider, model, origin, schema } from "./plugin.ts";

export { origin, schema };
export const request: DraftRequest = {
	model,
	system: "DYTEST-Use only this fictional context.",
	prompt: "DYTEST-Please draft the fictional response.",
	contextIds: ["c1"],
};
export const outcome: Extract<DraftOutcome, { kind: "draft" }> = {
	kind: "draft",
	model,
	fallback: false,
	usage: { input: 100, output: 50 },
	output: {
		body: "DYTEST-This is a fictional response.",
		ownerNotes: "",
		needsOwnerInput: [],
		suspectedInstructions: false,
		contextRefs: ["c1"],
	},
};

/** Independent fixture oracle; never calls the child request builder or policy comparator. */
export function messagesBody(input: DraftRequest = request): object {
	return {
		model: input.model,
		system: input.system,
		messages: [{ role: "user", content: input.prompt }],
		max_tokens: 16_000,
		output_config: { effort: "medium", format: { type: "json_schema", schema: structuredClone(schema) } },
		fallbacks: "default",
	};
}

export function createMessagesContractFixture(options: {
	readonly pages?: boolean;
	readonly draftResponse?: (request: Request) => Promise<Response>;
} = {}): {
	readonly plugin: MockPlugin;
	readonly calls: { method: string; url: string; headers: Record<string, string>; body: string }[];
	readonly fake: ReturnType<typeof createFake>;
	fixtures(): AiProviderFixtures;
} {
	const calls: { method: string; url: string; headers: Record<string, string>; body: string }[] = [];
	const row = (id: string) => ({ id, type: "model", display_name: "DYTEST Messages model", lifecycle: "active", max_input_tokens: 12345 });
	const fake = createFake({
		async fetch(candidate) {
			const text = await candidate.text();
			calls.push({ method: candidate.method, url: candidate.url, headers: Object.fromEntries(candidate.headers), body: text });
			const url = new URL(candidate.url);
			if (candidate.method === "GET" && url.pathname === "/v1/models") {
				const next = url.searchParams.has("after_id");
				const id = next ? "claude-page-2" : model;
				return Response.json({ data: [row(id)], has_more: options.pages === true && !next, first_id: id, last_id: id });
			}
			if (candidate.method === "GET" && url.pathname === `/v1/models/${model}`)
				return Response.json(row(model));
			if (candidate.method === "POST" && url.pathname === "/v1/messages") {
				if (options.draftResponse) return options.draftResponse(candidate);
				return Response.json({ id: "msg_DYTEST", type: "message", role: "assistant", model,
					content: [{ type: "text", text: JSON.stringify(outcome.output) }], stop_reason: "end_turn",
					usage: { input_tokens: 100, output_tokens: 50 } });
			}
			return Response.json({ error: "DYTEST-unexpected fixture request" }, { status: 400 });
		},
	}, { host: "api.anthropic.com" });
	return {
		plugin: messagesProvider(), calls, fake,
		fixtures(): AiProviderFixtures {
			return {
				upstreams: [fake], request, expected: outcome,
				progress: [{ progress: 0 }, { progress: 1 }],
				messagesHttp: [
					{ operation: "ai_models_list", origin },
					...(options.pages ? [{ operation: "ai_models_list" as const, origin: "https://api.anthropic.com" as const, afterId: model }] : []),
					{ operation: "ai_probe", origin, model },
					{ operation: "ai_draft_generate", origin, draft: request, schema: structuredClone(schema) },
				],
			};
		},
	};
}
