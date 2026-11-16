import type { DraftOutputV1 } from "@draftyak/protocol/draft-output";
import type { DraftInput } from "../src/index.ts";

export const canary = "PRIVATE_PROVIDER_CANARY_7M";
export const draft: DraftOutputV1 = {
	body: "Synthetic reply.",
	ownerNotes: "",
	needsOwnerInput: [],
	suspectedInstructions: false,
	contextRefs: ["c1"],
};
export const message = (fields: Record<string, unknown> = {}): Record<string, unknown> => ({
	model: "claude-opus-5-5",
	usage: { input_tokens: 300, output_tokens: 100 },
	stop_reason: "end_turn",
	content: [{ type: "text", text: JSON.stringify(draft) }],
	...fields,
});
export const input: DraftInput = {
	system: "Trusted synthetic instructions.",
	prompt: "Synthetic message.",
	contextIds: ["c1"] as const,
};
export const pin = { model: "claude-opus-5-5", effort: "medium" as const };
