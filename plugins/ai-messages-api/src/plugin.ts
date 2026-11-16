import Anthropic from "@anthropic-ai/sdk";
import { aiProviderV1, type ModelInfo } from "@draftyak/protocol/ai-provider-v1";
import { validateManifest } from "@draftyak/protocol/manifest";
import { type AiProviderContext, defineAiProviderPlugin } from "@draftyak/sdk/ai-provider";
import type { PluginContext } from "@draftyak/sdk/context";
import { PluginError } from "@draftyak/sdk/errors";
import { HostError } from "@draftyak/sdk/host";
import { z } from "zod";
import { createClient, draftCall } from "./client.ts";
import { DEFAULT_EFFORT, DEFAULT_MODEL, EFFORTS, MAX_TOKENS } from "./request.ts";
import { readDraft } from "./response.ts";
import { isModel, isRecord, MessagesError, snapshotRequestData } from "./shared.ts";

const settingsSchema = z.strictObject({
	model: z.string().refine(isModel).default(DEFAULT_MODEL),
	effort: z.enum(EFFORTS).default(DEFAULT_EFFORT),
	maxTokens: z.int().min(1).max(MAX_TOKENS).default(MAX_TOKENS),
});
type InstanceSettings = z.output<typeof settingsSchema>;

function settings(context: PluginContext): InstanceSettings {
	try {
		const parsed = settingsSchema.safeParse(
			snapshotRequestData(context.instance === undefined ? {} : context.instance.config),
			{ jitless: true },
		);
		if (parsed.success) return parsed.data;
	} catch {
		// Configuration failures never include owner-entered values.
	}
	throw new PluginError("INVALID_INPUT");
}

function retryHint(value: string | null | undefined): number | undefined {
	if (value === null || value === undefined || value.length > 128) return undefined;
	let milliseconds: number;
	if (/^\d+$/.test(value)) milliseconds = Number(value) * 1_000;
	else {
		if (
			!/^(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun), \d{2} (?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) \d{4} \d{2}:\d{2}:\d{2} GMT$/.test(
				value,
			)
		)
			return undefined;
		const at = Date.parse(value);
		if (!Number.isFinite(at) || new Date(at).toUTCString() !== value) return undefined;
		milliseconds = Math.max(0, at - Date.now());
	}
	return Number.isSafeInteger(milliseconds) && milliseconds >= 0 ? milliseconds : undefined;
}

function failure(error: unknown): PluginError {
	if (error instanceof PluginError) return error;
	if (error instanceof HostError)
		return new PluginError(error.code === "DENIED" ? "PERMISSION_DENIED" : "TRANSIENT");
	if (error instanceof MessagesError)
		return new PluginError(error.code === "INVALID_INPUT" ? "INVALID_INPUT" : "TRANSIENT");
	if (error instanceof Anthropic.APIError) {
		const code =
			error.status === 402 && error.type === "billing_error"
				? "QUOTA_EXCEEDED"
				: error.status === 401
					? "AUTH_EXPIRED"
					: error.status === 403
						? "PERMISSION_DENIED"
						: error.status === 404
							? "NOT_FOUND"
							: error.status === 429
								? "RATE_LIMITED"
								: error.status === 400 || error.status === 422
									? "INVALID_INPUT"
									: "TRANSIENT";
		const retryAfterMs =
			error.status === 429 ||
			(error.status !== undefined && error.status >= 500 && error.status <= 599)
				? retryHint(error.headers?.get("retry-after"))
				: undefined;
		return new PluginError(code, retryAfterMs === undefined ? {} : { retryAfterMs });
	}
	return new PluginError("TRANSIENT");
}

async function call<T>(
	context: PluginContext,
	operation: (client: Anthropic, config: InstanceSettings) => Promise<T>,
): Promise<T> {
	let brokerFailure: unknown;
	try {
		context.signal.throwIfAborted();
		const config = settings(context);
		const client = createClient(
			async (input, init) => {
				try {
					return await context.fetch(input, init);
				} catch (error) {
					brokerFailure = error;
					throw error;
				}
			},
			{ maxRetries: 0 },
		);
		const result = await operation(client, config);
		context.signal.throwIfAborted();
		return result;
	} catch (error) {
		throw failure(context.signal.aborted ? undefined : (brokerFailure ?? error));
	}
}

function modelInfo(value: unknown): ModelInfo {
	if (
		!isRecord(value) ||
		!isModel(value.id) ||
		typeof value.display_name !== "string" ||
		typeof value.lifecycle !== "string" ||
		!["active", "deprecated", "retired"].includes(value.lifecycle) ||
		(value.max_input_tokens !== null &&
			(!Number.isSafeInteger(value.max_input_tokens) || Number(value.max_input_tokens) < 1))
	)
		throw new MessagesError("INVALID_RESPONSE");
	const projected = {
		id: value.id,
		name: value.display_name,
		...(value.max_input_tokens === null ? {} : { contextTokens: value.max_input_tokens }),
	};
	const parsed = aiProviderV1.tools.ai_models_list.output.safeParse(
		{ models: [projected] },
		{ jitless: true },
	);
	if (!parsed.success) throw new MessagesError("INVALID_RESPONSE");
	return parsed.data.models[0] as ModelInfo;
}

async function reportProgress(context: AiProviderContext): Promise<void> {
	context.signal.throwIfAborted();
	let abort = (): void => {};
	const cancelled = new Promise<never>((_resolve, reject) => {
		abort = () => reject(context.signal.reason);
		context.signal.addEventListener("abort", abort, { once: true });
	});
	try {
		await Promise.race([
			Promise.resolve().then(() => {
				context.signal.throwIfAborted();
				return context.progress(0);
			}),
			cancelled,
		]);
	} finally {
		context.signal.removeEventListener("abort", abort);
	}
}

async function withProgress<T>(
	context: AiProviderContext,
	operation: () => Promise<T>,
): Promise<T> {
	await reportProgress(context);
	context.signal.throwIfAborted();
	let pending: Promise<void> | undefined;
	let progressFailure: unknown;
	const timer = setInterval(() => {
		if (!pending && progressFailure === undefined)
			pending = reportProgress(context)
				.catch((error: unknown) => {
					progressFailure = error;
				})
				.finally(() => {
					pending = undefined;
				});
	}, 5_000);
	timer.unref();
	let result: T;
	try {
		result = await operation();
	} finally {
		clearInterval(timer);
		await pending;
	}
	if (progressFailure !== undefined) throw progressFailure;
	return result;
}

/** Define the component surface; the host still owns installation and all egress authority. */
export function createMessagesPlugin(manifest: unknown): ReturnType<typeof defineAiProviderPlugin> {
	const checked = validateManifest(manifest);
	if (
		!checked.ok ||
		checked.manifest.kind !== "ai-provider" ||
		checked.manifest.egress.profile !== "messages-api-v1"
	)
		throw new TypeError("Messages provider manifest refused");
	return defineAiProviderPlugin({
		manifest: checked.manifest,
		describe: () => ({ name: "Anthropic Messages", structuredOutput: "native" }),
		listModels: (_args, context) =>
			call(context, async (client) => {
				const models: ModelInfo[] = [];
				const seen = new Set<string>();
				let page = await client.models.list({ limit: 100 }, { signal: context.signal });
				for (let count = 0; count < 5; count++) {
					if (
						!Array.isArray(page.data) ||
						page.data.length > 100 ||
						typeof page.has_more !== "boolean"
					)
						throw new MessagesError("INVALID_RESPONSE");
					for (const row of page.data) {
						const model = modelInfo(row);
						if (row.lifecycle === "retired" || seen.has(model.id))
							throw new MessagesError("INVALID_RESPONSE");
						seen.add(model.id);
						models.push(model);
					}
					if (!page.has_more) return { models };
					if (!page.data.length || page.last_id !== page.data.at(-1)?.id || count === 4)
						throw new MessagesError("INVALID_RESPONSE");
					context.signal.throwIfAborted();
					page = await page.getNextPage();
				}
				throw new MessagesError("INVALID_RESPONSE");
			}),
		probe: (args, context) =>
			call(context, async (client, config) => {
				const model = args.model ?? config.model;
				if (!isModel(model)) throw new MessagesError("INVALID_INPUT");
				const result = await client.models.retrieve(model, {}, { signal: context.signal });
				modelInfo(result);
				return result.lifecycle === "retired"
					? { status: "degraded" as const, detail: "MODEL_RETIRED" }
					: { status: "ok" as const };
			}),
		generateDraft: (args, context) =>
			call(context, (client, config) =>
				withProgress(context, async () => {
					const { params, headers } = draftCall(args, { ...config, model: args.model });
					const message = await client.messages.create(params, { headers, signal: context.signal });
					return readDraft(message, args.contextIds);
				}),
			),
	});
}
