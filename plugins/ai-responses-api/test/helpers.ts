import type { DraftOutputV1 } from "@draftyak/protocol/draft-output";
import type { DraftRequest } from "../src/index.ts";

export const input: DraftRequest = {
	model: "gpt-synthetic",
	system: "Draft a plain-text reply.",
	prompt: "Synthetic thread; propose Tuesday.",
	contextIds: ["c1"],
};
export const draft: DraftOutputV1 = {
	body: "Tuesday works for me.",
	ownerNotes: "Synthetic note.",
	needsOwnerInput: [],
	suspectedInstructions: false,
	contextRefs: ["c1"],
};
export const CANARY = "PRIVATE_SYNTHETIC_CANARY";
export function message(overrides: Record<string, unknown> = {}): Record<string, unknown> {
	return {
		status: "completed",
		model: input.model,
		usage: { input_tokens: 100, output_tokens: 50 },
		output: [
			{ type: "reasoning", summary: [] },
			{
				type: "message",
				role: "assistant",
				status: "completed",
				content: [{ type: "output_text", text: JSON.stringify(draft), annotations: [] }],
			},
		],
		...overrides,
	};
}
