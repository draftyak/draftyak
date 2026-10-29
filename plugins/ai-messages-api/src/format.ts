import { betaZodOutputFormat } from "@anthropic-ai/sdk/helpers/beta/zod";
import type { AutoParseableOutputFormat } from "@anthropic-ai/sdk/lib/parser";
import { DraftOutputV1 } from "@draftyak/protocol/draft-output";

// The SDK parses text before exposing stop_reason. Leave it unchanged so readDraft can
// classify refusal and truncation before the shared bounded draft parser runs.
export const draftFormat: AutoParseableOutputFormat<string> = {
	type: "json_schema",
	schema: betaZodOutputFormat(DraftOutputV1).schema,
	parse: (text) => text,
};
