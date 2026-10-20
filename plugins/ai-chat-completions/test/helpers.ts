import type { DraftRequest } from "@draftyak/protocol/ai-provider-v1";
import {
	type CompatibleCore,
	type CompatibleFormat,
	type CompatibleResponse,
	createCompatibleCore,
} from "../src/index.ts";

export const MODEL = "synthetic-model:1";
export const REQUEST: DraftRequest = {
	model: MODEL,
	system: "Trusted drafting instructions.",
	prompt: "Synthetic thread data.",
	contextIds: ["c1", "c3"],
};
export const OUTPUT: Record<string, unknown> = {
	body: "Synthetic reply",
	ownerNotes: "",
	needsOwnerInput: [],
	suspectedInstructions: false,
	contextRefs: ["c1"],
};
export function core(format: CompatibleFormat = "json_schema"): CompatibleCore {
	return createCompatibleCore(
		{
			endpoint: `http://127.0.0.1:11434/${format === "ollama" ? "api/chat" : "v1/chat/completions"}`,
			model: MODEL,
			format,
		},
		{ hostname: "127.0.0.1", destination: "local" },
	);
}
export function response(
	provider: CompatibleCore,
	body: unknown,
	status = 200,
): CompatibleResponse {
	return {
		status,
		url: provider.config.endpoint,
		contentType: "application/json; charset=utf-8",
		body: new TextEncoder().encode(JSON.stringify(body)),
	};
}
export function completion(
	provider: CompatibleCore,
	output: unknown = OUTPUT,
	reason = "stop",
): CompatibleResponse {
	const message = {
		role: "assistant",
		content: typeof output === "string" ? output : JSON.stringify(output),
	};
	return response(
		provider,
		provider.config.format === "ollama"
			? {
					model: MODEL,
					message,
					done: true,
					done_reason: reason,
					prompt_eval_count: 10,
					eval_count: 3,
				}
			: {
					model: MODEL,
					choices: [{ index: 0, finish_reason: reason, message }],
					usage: { prompt_tokens: 10, completion_tokens: 3 },
				},
	);
}
