import { ModelId, type ModelInfo } from "@draftyak/protocol/ai-provider-v1";
import type { AiProviderPluginDefinition } from "@draftyak/sdk/ai-provider";
import type { PluginContext } from "@draftyak/sdk/context";
import { PluginError } from "@draftyak/sdk/errors";
import { createCompletedTransport, modelMetadata, type ResponsesFetch } from "./client.ts";
import { EFFORTS, type Effort, type Settings } from "./request.ts";
import { generateDraft } from "./runner.ts";
import { normalizeError, ResponsesError, record } from "./shared.ts";

export type ResponsesModeHandlers = Pick<
	AiProviderPluginDefinition,
	"describe" | "listModels" | "probe" | "generateDraft"
>;

function hostFetch(context: PluginContext): ResponsesFetch {
	return (input, init) => context.fetch(input, { ...init, stream: true });
}

async function guarded<T>(context: PluginContext, run: () => Promise<T>): Promise<T> {
	try {
		if (context.signal.aborted) throw new ResponsesError("ABORTED");
		return await run();
	} catch (error) {
		const failure = normalizeError(error);
		throw new PluginError(failure.code === "ABORTED" ? "TRANSIENT" : failure.code, {
			...(failure.retryAfterMs === undefined ? {} : { retryAfterMs: failure.retryAfterMs }),
		});
	}
}

function modelInfo(value: unknown): ModelInfo {
	if (!record(value) || value.object !== "model") throw new ResponsesError("TRANSIENT");
	const id = ModelId.safeParse(value.id, { jitless: true });
	if (!id.success) throw new ResponsesError("TRANSIENT");
	// The provider's metadata supplies no context-length or fallback capability guarantee.
	return { id: id.data };
}

function modelList(value: unknown): { models: ModelInfo[] } {
	if (
		!record(value) ||
		value.object !== "list" ||
		!Array.isArray(value.data) ||
		value.data.length > 500
	)
		throw new ResponsesError("TRANSIENT");
	const models = value.data.map(modelInfo);
	if (new Set(models.map(({ id }) => id)).size !== models.length)
		throw new ResponsesError("TRANSIENT");
	return { models };
}

function settings(context: PluginContext): Settings {
	const effort = context.instance?.config.effort;
	if (effort === undefined) return {};
	if (typeof effort !== "string" || !EFFORTS.includes(effort as Effort))
		throw new ResponsesError("INVALID_INPUT");
	return { effort: effort as Effort };
}

const apiKey: ResponsesModeHandlers = Object.freeze<ResponsesModeHandlers>({
	describe: () => ({ name: "Responses API-key", structuredOutput: "native" }),
	listModels: (_args, context) =>
		guarded(context, async () =>
			modelList(await modelMetadata(hostFetch(context), undefined, context.signal)),
		),
	probe: ({ model }, context) =>
		guarded(context, async () => {
			const metadata = await modelMetadata(hostFetch(context), model, context.signal);
			if (model === undefined) modelList(metadata);
			else if (modelInfo(metadata).id !== model) throw new ResponsesError("TRANSIENT");
			return { status: "ok" as const };
		}),
	generateDraft: (request, context) =>
		guarded(context, async () => {
			const configured = settings(context);
			let active = true;
			let progress = 0;
			const report = (): void => {
				if (active && !context.signal.aborted)
					void context.progress(progress++).catch(() => undefined);
			};
			const timer = setInterval(report, 10_000);
			const stop = (): void => {
				active = false;
				clearInterval(timer);
			};
			context.signal.addEventListener("abort", stop, { once: true });
			try {
				report();
				return await generateDraft(
					request,
					configured,
					createCompletedTransport(hostFetch(context)),
					context.signal,
				);
			} finally {
				stop();
				context.signal.removeEventListener("abort", stop);
			}
		}),
});

// Additional modes register their own complete handler set; unknown modes never select a fallback.
export const MODES: Readonly<Record<string, ResponsesModeHandlers>> = Object.freeze({
	"api-key": apiKey,
});
