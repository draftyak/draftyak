import {
	type AiProviderV1Tools,
	aiProviderV1,
	type DraftRequest,
} from "@draftyak/protocol/ai-provider-v1";
import { normalizeDraftOutput, validateDraftOutput } from "@draftyak/protocol/draft-output";
import type { PluginContext } from "./context.ts";
import { capture, checkedTool, dataCopy, entry, type Handler, manifest } from "./definitions.ts";
import type { PluginEntry } from "./serve.ts";

export interface AiProviderContext extends Omit<PluginContext, "progress"> {
	/** Current-request MCP progress; ignored when the caller did not request progress. */
	progress(value: number, total?: number): Promise<void>;
}

export interface AiProviderPluginDefinition {
	readonly manifest: unknown;
	readonly describe: Handler<AiProviderV1Tools["ai_describe"]>;
	readonly listModels: Handler<AiProviderV1Tools["ai_models_list"]>;
	readonly probe: Handler<AiProviderV1Tools["ai_probe"]>;
	readonly generateDraft: Handler<AiProviderV1Tools["ai_draft_generate"], AiProviderContext>;
}
const names = {
	describe: "ai_describe",
	listModels: "ai_models_list",
	probe: "ai_probe",
	generateDraft: "ai_draft_generate",
} as const;
export function defineAiProviderPlugin(options: AiProviderPluginDefinition): PluginEntry {
	const captured = capture(options, ["manifest", ...Object.keys(names)]);
	const declared = manifest(captured.manifest, "ai-provider");
	return entry(
		declared,
		aiProviderV1,
		Object.entries(names).map(([key, name]) =>
			checkedTool(name, aiProviderV1.tools[name], async (args, context, _metadata, request) => {
				const contextIds =
					name === "ai_draft_generate" ? Array.from((args as DraftRequest).contextIds) : undefined;
				const invocationContext =
					name === "ai_draft_generate"
						? Object.freeze({ ...context, progress: request?.progress ?? (async () => {}) })
						: context;
				const value = dataCopy(
					await Reflect.apply(captured[key] as (...args: never[]) => unknown, undefined, [
						args,
						invocationContext,
					]),
				);
				if (!contextIds || !value || typeof value !== "object" || Array.isArray(value))
					return value;
				const outcome = value as Record<string, unknown>;
				if (outcome.kind !== "draft") return outcome;
				const checked = validateDraftOutput(normalizeDraftOutput(outcome.output, contextIds));
				if (checked.ok) return { ...outcome, output: checked.output };
				const { output: _output, ...rest } = outcome;
				return { ...rest, kind: "invalid", problems: checked.problems };
			}),
		),
	);
}
