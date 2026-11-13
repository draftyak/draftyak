import { createFake } from "@draftyak/fakes";
import type { DraftOutcome, DraftRequest } from "@draftyak/protocol/ai-provider-v1";
import { DraftOutputV1 } from "@draftyak/protocol/draft-output";
import { exportedSchema } from "@draftyak/protocol/extension";
import type { AiProviderFixtures } from "../../../src/contracts/ai-provider.ts";
import type { MockHubOptions, MockPlugin } from "../../../src/types.ts";
import { type CompatibleFixtureFormat, compatibleProvider } from "./plugin.ts";

export const origin = "https://compatible.example.invalid";
export const request: DraftRequest = {
	model: "dytest-compatible-model",
	system: "DYTEST-Return the fictional reply as DraftOutputV1.",
	prompt: "DYTEST-A fictional message asks when the sample is ready.",
	contextIds: ["c1"],
};
export const outcome: Extract<DraftOutcome, { kind: "draft" }> = {
	kind: "draft",
	model: "dytest-compatible-model",
	fallback: false,
	usage: { input: 100, output: 50 },
	output: {
		body: "DYTEST-The sample is ready for review.",
		ownerNotes: "DYTEST-Check the sample before replying.",
		needsOwnerInput: [],
		suspectedInstructions: false,
		contextRefs: ["c1"],
	},
};

export function compatibleConfig(format: CompatibleFixtureFormat): {
	endpoint: string;
	model: string;
	format: CompatibleFixtureFormat;
} {
	return {
		endpoint: `${origin}${format === "ollama" ? "/api/chat" : "/v1/chat/completions"}`,
		model: "dytest-compatible-model",
		format,
	};
}

export function probeRequest(): DraftRequest {
	return {
		model: "dytest-compatible-model",
		system:
			"Return exactly one DraftOutputV1 JSON object with body, ownerNotes, needsOwnerInput, suspectedInstructions, and contextRefs.",
		prompt:
			'Return exactly {"body":"","ownerNotes":"","needsOwnerInput":[],"suspectedInstructions":false,"contextRefs":[]}.',
		contextIds: [],
	};
}

/** Independent wire oracle from the public schema, not the policy's comparator or child output. */
export function compatibleBody(format: CompatibleFixtureFormat, draft: DraftRequest): string {
	const stripped = new Set(["$id", "$schema", "maxLength", "minLength", "maxItems", "minItems", "uniqueItems"]);
	const schema = JSON.parse(
		JSON.stringify(exportedSchema("schemas/draft-output-v1.schema.json", DraftOutputV1), (key, value: unknown) =>
			stripped.has(key) ? undefined : value,
		),
	) as unknown;
	const result: Record<string, unknown> = {
		model: draft.model,
		messages: [
			{ role: "system", content: draft.system },
			{ role: "user", content: draft.prompt },
		],
	};
	if (format === "ollama") result.format = schema;
	else result.response_format = format === "json_object" ? { type: "json_object" } : {
		type: "json_schema",
		json_schema: { name: "draft_output_v1", strict: true, schema },
	};
	result.stream = false;
	return JSON.stringify(result);
}

export interface CompatibleRecordedCall {
	readonly method: string;
	readonly url: string;
	readonly headers: readonly (readonly [string, string])[];
	readonly body: string;
}
export interface CompatibleProviderFixture extends AiProviderFixtures {
	readonly compatibleHttp: NonNullable<MockHubOptions["compatibleHttp"]>;
}
export interface CompatibleContractFixture {
	readonly plugin: MockPlugin;
	readonly calls: CompatibleRecordedCall[];
	fixtures(): CompatibleProviderFixture;
}
interface FixtureOptions {
	readonly status?: number;
	readonly beforeReply?: (request: Request) => Promise<void>;
}

export function createCompatibleContractFixture(
	format: CompatibleFixtureFormat,
	options: FixtureOptions = {},
): CompatibleContractFixture {
	const calls: CompatibleRecordedCall[] = [];
	return {
		plugin: compatibleProvider(format),
		calls,
		fixtures(): CompatibleProviderFixture {
			const upstream = createFake({
				async fetch(input) {
					const body = await input.text();
					calls.push({ method: input.method, url: input.url, headers: [...input.headers], body });
					await options.beforeReply?.(input);
					if (options.status) return Response.json({ error: "DYTEST_UNTRUSTED_PROVIDER_DETAIL" }, { status: options.status });
					const pathname = new URL(input.url).pathname;
					if (pathname === "/v1/models") return Response.json({ object: "list", data: [{ object: "model", id: request.model }] });
					if (pathname === "/api/tags") return Response.json({ models: [{ name: request.model }] });
					const wire = JSON.parse(body) as { messages: { content: string }[] };
					const output = wire.messages[1]?.content === probeRequest().prompt ? {
						body: "", ownerNotes: "", needsOwnerInput: [], suspectedInstructions: false, contextRefs: [],
					} : outcome.output;
					const content = JSON.stringify(output);
					return Response.json(format === "ollama" ? {
						model: request.model, message: { role: "assistant", content }, done: true,
						done_reason: "stop", prompt_eval_count: 100, eval_count: 50,
					} : {
						model: request.model, choices: [{ message: { role: "assistant", content }, finish_reason: "stop" }],
						usage: { prompt_tokens: 100, completion_tokens: 50 },
					});
				},
			}, { host: "compatible.example.invalid" });
			return {
				upstreams: [upstream],
				request: structuredClone(request),
				expected: structuredClone(outcome),
				progress: [{ progress: 0 }, { progress: 1 }],
				compatibleHttp: [
					{ operation: "ai_models_list", config: compatibleConfig(format) },
					{ operation: "ai_probe", config: compatibleConfig(format) },
					{ operation: "ai_draft_generate", config: compatibleConfig(format), draft: structuredClone(request) },
				],
			};
		},
	};
}
