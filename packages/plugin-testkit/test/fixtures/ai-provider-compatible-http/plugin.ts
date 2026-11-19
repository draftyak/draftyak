import type { DraftOutcome, DraftRequest } from "@draftyak/protocol/ai-provider-v1";
import { DraftOutputV1 } from "@draftyak/protocol/draft-output";
import { exportedSchema } from "@draftyak/protocol/extension";
import type { PluginManifestV1 } from "@draftyak/protocol/manifest";
import { defineAiProviderPlugin, type PluginContext, PluginError, serve } from "@draftyak/sdk";
import type { MockPlugin } from "../../../src/types.ts";

export type CompatibleFixtureFormat = "json_schema" | "json_object" | "ollama";
const origin = "https://compatible.example.invalid";
const model = "dytest-compatible-model";
const probe = {
	system:
		"Return exactly one DraftOutputV1 JSON object with body, ownerNotes, needsOwnerInput, suspectedInstructions, and contextRefs.",
	prompt:
		'Return exactly {"body":"","ownerNotes":"","needsOwnerInput":[],"suspectedInstructions":false,"contextRefs":[]}.',
};
const omitted = new Set(["$id", "$schema", "maxLength", "minLength", "maxItems", "minItems", "uniqueItems"]);
function wireSchema(value: unknown): unknown {
	if (Array.isArray(value)) return value.map(wireSchema);
	if (value && typeof value === "object")
		return Object.fromEntries(
			Object.entries(value)
				.filter(([key]) => !omitted.has(key))
				.map(([key, item]) => [key, wireSchema(item)]),
		);
	return value;
}
const schema = wireSchema(exportedSchema("schemas/draft-output-v1.schema.json", DraftOutputV1));

function body(format: CompatibleFixtureFormat, input: DraftRequest): string {
	return JSON.stringify({
		model: input.model,
		messages: [
			{ role: "system", content: input.system },
			{ role: "user", content: input.prompt },
		],
		...(format === "ollama"
			? { format: schema }
			: {
					response_format:
						format === "json_object"
							? { type: "json_object" }
							: { type: "json_schema", json_schema: { name: "draft_output_v1", strict: true, schema } },
				}),
		stream: false,
	});
}

interface WireCompletion {
	readonly model: string;
	readonly choices?: readonly { readonly message: { readonly content: string } }[];
	readonly message?: { readonly content: string };
	readonly usage?: { readonly prompt_tokens: number; readonly completion_tokens: number };
	readonly prompt_eval_count?: number;
	readonly eval_count?: number;
}

/** Scripted SDK fixture only; the real provider adapter is qualified by its own consumer. */
export function compatibleProvider(format: CompatibleFixtureFormat): MockPlugin {
	const endpoint = `${origin}${format === "ollama" ? "/api/chat" : "/v1/chat/completions"}`;
	const manifest: PluginManifestV1 = {
		id: `@example/compatible-http-${format.replaceAll("_", "-")}`,
		version: "1.0.0",
		sdk: "1.0.0",
		runtime: "node",
		kind: "ai-provider",
		contract: { extension: "io.github.draftyak/ai-provider", version: 1 },
		isolation: "standard",
		auth: { kind: "none", scopes: [], requiredGrantedScopes: [] },
		credentials: { mode: "brokered", urlSecrets: [] },
		permissions: {},
		dataClasses: ["example.content"],
		egress: { profile: "chat-completions-v1" },
		license: "Apache-2.0",
	};
	const generate = async (input: DraftRequest, context: PluginContext): Promise<DraftOutcome> => {
		const response = await context.fetch(endpoint, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: body(format, input),
			stream: true,
		});
		if (response.status !== 200) throw new PluginError("TRANSIENT");
		const value = (await response.json()) as WireCompletion;
		const content = format === "ollama" ? value.message?.content : value.choices?.[0]?.message.content;
		const inputTokens = format === "ollama" ? value.prompt_eval_count : value.usage?.prompt_tokens;
		const outputTokens = format === "ollama" ? value.eval_count : value.usage?.completion_tokens;
		if (value.model !== model || typeof content !== "string" || typeof inputTokens !== "number" || typeof outputTokens !== "number")
			throw new PluginError("TRANSIENT");
		return {
			kind: "draft",
			model: value.model,
			fallback: false,
			usage: { input: inputTokens, output: outputTokens },
			output: DraftOutputV1.parse(JSON.parse(content)),
		};
	};
	return {
		manifest,
		entry: defineAiProviderPlugin({
			manifest,
			describe: () => ({ name: "DYTEST compatible HTTP fixture", structuredOutput: "validated" }),
			async listModels(_input, context) {
				const response = await context.fetch(`${origin}${format === "ollama" ? "/api/tags" : "/v1/models"}`, { stream: true });
				if (response.status !== 200) throw new PluginError("TRANSIENT");
				const value = (await response.json()) as { data?: { id: string }[]; models?: { name: string }[] };
				if (format === "ollama") {
					if (!Array.isArray(value.models)) throw new PluginError("TRANSIENT");
					return { models: value.models.map(({ name }) => ({ id: name, fallbacks: false as const })) };
				}
				if (!Array.isArray(value.data)) throw new PluginError("TRANSIENT");
				return { models: value.data.map(({ id }) => ({ id, fallbacks: false as const })) };
			},
			async probe(_input, context) {
				const result = await generate({ model, ...probe, contextIds: [] }, context);
				return { status: result.kind === "draft" ? "ok" : "degraded" };
			},
			async generateDraft(input, context) {
				await context.progress(0);
				const result = await generate(input, context);
				await context.progress(1);
				return result;
			},
		}),
	};
}

export function startCompatibleFixture(format: CompatibleFixtureFormat): void {
	if (process.permission?.has("net") !== false)
		throw new Error("DYTEST compatible fixture requires denied direct network");
	serve(compatibleProvider(format).entry);
}
