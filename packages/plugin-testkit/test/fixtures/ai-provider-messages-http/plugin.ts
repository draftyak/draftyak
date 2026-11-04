import { type DraftOutcome, type DraftRequest } from "@draftyak/protocol/ai-provider-v1";
import { DraftOutputV1 } from "@draftyak/protocol/draft-output";
import type { PluginManifestV1 } from "@draftyak/protocol/manifest";
import { defineAiProviderPlugin, PluginError, serve, type PluginContext } from "@draftyak/sdk";
import type { MockPlugin } from "../../../src/types.ts";

export const origin = "https://api.anthropic.com";
export const model = "claude-sonnet-5-5";
/** Scripted fixture DATA, not a claim about the vendor schema transformer. */
export const schema: {
	type: string;
	properties: {
		body: { type: string };
		ownerNotes: { type: string };
		needsOwnerInput: { type: string; items: { type: string } };
		suspectedInstructions: { type: string };
		contextRefs: { type: string; items: { type: string; enum: string[] } };
	};
	required: string[];
	additionalProperties: boolean;
} = {
	type: "object",
	properties: {
		body: { type: "string" },
		ownerNotes: { type: "string" },
		needsOwnerInput: { type: "array", items: { type: "string" } },
		suspectedInstructions: { type: "boolean" },
		contextRefs: { type: "array", items: { type: "string", enum: ["c1", "c2", "c3"] } },
	},
	required: ["body", "ownerNotes", "needsOwnerInput", "suspectedInstructions", "contextRefs"],
	additionalProperties: false,
};

function requestHeaders(post = false): Record<string, string> {
	return {
		accept: "application/json",
		"anthropic-version": "2023-06-01",
		"x-api-key": "brokered",
		"user-agent": "Anthropic/JS 0.135.0",
		"x-stainless-retry-count": "0",
		"x-stainless-timeout": "600",
		...(post ? {
			"content-type": "application/json",
			"anthropic-beta": "server-side-fallback-2026-07-01",
		} : {}),
	};
}

export function messagesProvider(): MockPlugin {
	const manifest: PluginManifestV1 = {
		id: "@example/messages-http-fixture",
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
		egress: { profile: "messages-api-v1" },
		license: "Apache-2.0",
	};
	async function generate(input: DraftRequest, context: PluginContext): Promise<DraftOutcome> {
		const response = await context.fetch(`${origin}/v1/messages`, {
			method: "POST",
			headers: requestHeaders(true),
			body: JSON.stringify({
				model: input.model,
				system: input.system,
				messages: [{ role: "user", content: input.prompt }],
				max_tokens: 16_000,
				output_config: { effort: "medium", format: { type: "json_schema", schema } },
				fallbacks: "default",
			}),
			stream: true,
		});
		if (response.status !== 200) throw new PluginError("TRANSIENT");
		const value = await response.json() as {
			model?: string;
			stop_reason?: string;
			content?: { type: string; text: string }[];
			usage?: { input_tokens: number; output_tokens: number };
		};
		const first = value.content?.[0];
		const usage = value.usage;
		if (value.model !== model || value.stop_reason !== "end_turn" ||
			value.content?.length !== 1 || first?.type !== "text" ||
			typeof first.text !== "string" ||
			typeof usage?.input_tokens !== "number" || typeof usage.output_tokens !== "number")
			throw new PluginError("TRANSIENT");
		return {
			kind: "draft",
			model,
			fallback: false,
			usage: { input: usage.input_tokens, output: usage.output_tokens },
			output: DraftOutputV1.parse(JSON.parse(first.text)),
		};
	}
	return {
		manifest,
		entry: defineAiProviderPlugin({
			manifest,
			describe: () => ({ name: "DYTEST Messages HTTP fixture", structuredOutput: "native" }),
			async listModels(_args, context) {
				const result: { id: string; name?: string; contextTokens?: number }[] = [];
				let target = `${origin}/v1/models?limit=100`;
				for (let index = 0; index < 5; index++) {
					const response = await context.fetch(target, { headers: requestHeaders(), stream: true });
					if (response.status !== 200) throw new PluginError("TRANSIENT");
					const page = await response.json() as {
						data: { id: string; display_name: string; max_input_tokens: number }[];
						has_more: boolean;
						last_id: string;
					};
					for (const value of page.data)
						result.push({ id: value.id, name: value.display_name, contextTokens: value.max_input_tokens });
					if (!page.has_more) return { models: result };
					if (index === 4 || !page.data.length || page.last_id !== page.data.at(-1)?.id)
						throw new PluginError("TRANSIENT");
					target = `${origin}/v1/models?limit=100&after_id=${encodeURIComponent(page.last_id)}`;
				}
				throw new PluginError("TRANSIENT");
			},
			async probe(args, context) {
				const response = await context.fetch(`${origin}/v1/models/${args.model ?? model}`, {
					headers: requestHeaders(), stream: true,
				});
				if (response.status !== 200) throw new PluginError("TRANSIENT");
				const value = await response.json() as { id: string; lifecycle: string };
				if (value.id !== (args.model ?? model)) throw new PluginError("TRANSIENT");
				return { status: value.lifecycle === "retired" ? "degraded" : "ok" };
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

export function startMessagesFixture(): void {
	if (process.permission?.has("net") !== false)
		throw new Error("DYTEST Messages fixture requires denied direct network");
	serve(messagesProvider().entry);
}
