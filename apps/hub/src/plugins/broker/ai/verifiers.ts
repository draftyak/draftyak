import { exactBody } from "./boundary.ts";
import type { AiProfileRegistration, AiVerifierInput } from "./profile-registry.ts";
import { compatibleSchema, messagesSchema, responsesSchema } from "./schemas.ts";
import { refuse } from "./types.ts";

const FALLBACK_BETA = "server-side-fallback-2026-07-01";
const FALLBACK_MODELS = new Set([
	"claude-fable-5-1",
	"claude-fable-5",
	"claude-opus-5-5",
	"claude-opus-5",
	"claude-sonnet-5-5",
]);

function headers(
	input: AiVerifierInput,
	required: Readonly<Record<string, string>>,
	optional: Readonly<Record<string, (value: string) => boolean>> = {},
): void {
	for (const [name, expected] of Object.entries(required))
		if (input.headers.get(name) !== expected) refuse();
	for (const [name, value] of input.headers)
		if (!(Object.hasOwn(required, name) && required[name] === value) && !optional[name]?.(value))
			refuse();
}

function messages(input: AiVerifierInput): void {
	const { draft, settings, endpoint } = input.binding;
	if (
		settings.kind !== "messages" ||
		![
			"https://api.anthropic.com/v1/messages",
			"https://api.anthropic.com/v1/messages?beta=true",
		].includes(endpoint)
	)
		refuse();
	if (settings.fallback && !FALLBACK_MODELS.has(draft.model)) refuse();
	headers(
		input,
		{
			"content-type": "application/json",
			"anthropic-version": "2023-06-01",
			"x-api-key": "brokered",
			...(settings.fallback ? { "anthropic-beta": FALLBACK_BETA } : {}),
		},
		{
			accept: (value) => value === "application/json",
			"user-agent": (value) => value === "Anthropic/JS 0.135.0",
			"x-stainless-retry-count": (value) => /^\d{1,2}$/.test(value),
			"x-stainless-timeout": (value) => /^\d{1,6}$/.test(value),
			"x-stainless-helper-method": (value) => value === "stream",
		},
	);
	exactBody(input.body, {
		model: draft.model,
		system: draft.system,
		messages: [{ role: "user", content: draft.prompt }],
		max_tokens: settings.maxTokens,
		output_config: {
			effort: settings.effort,
			format: { type: "json_schema", schema: messagesSchema() },
		},
		...(settings.stream === "omit" ? {} : { stream: settings.stream }),
		...(settings.fallback ? { fallbacks: "default" } : {}),
	});
}

function responses(input: AiVerifierInput): void {
	const { draft, settings, endpoint } = input.binding;
	if (settings.kind !== "responses" || endpoint !== "https://api.openai.com/v1/responses") refuse();
	headers(
		input,
		{ "content-type": "application/json", authorization: "Bearer brokered" },
		{ accept: (value) => value === "application/json" },
	);
	exactBody(input.body, {
		model: draft.model,
		instructions: draft.system,
		input: [{ role: "user", content: draft.prompt }],
		text: {
			format: {
				type: "json_schema",
				name: "draft_output",
				strict: true,
				schema: responsesSchema(),
			},
		},
		...(settings.effort === undefined ? {} : { reasoning: { effort: settings.effort } }),
		stream: true,
		store: false,
	});
}

function compatible(input: AiVerifierInput): void {
	const { draft, settings } = input.binding;
	if (settings.kind !== "compatible") refuse();
	headers(input, { "content-type": "application/json" });
	const messages = [
		{ role: "system", content: draft.system },
		{ role: "user", content: draft.prompt },
	];
	exactBody(
		input.body,
		settings.format === "ollama"
			? {
					model: draft.model,
					messages,
					format: compatibleSchema(),
					stream: false,
				}
			: {
					model: draft.model,
					messages,
					response_format:
						settings.format === "json_object"
							? { type: "json_object" }
							: {
									type: "json_schema",
									json_schema: {
										name: "draft_output_v1",
										strict: true,
										schema: compatibleSchema(),
									},
								},
					stream: false,
				},
	);
}

export const builtinRegistrations: readonly AiProfileRegistration[] = Object.freeze([
	Object.freeze({ profile: "messages-api-v1", verify: messages }),
	Object.freeze({ profile: "responses-api-v1", verify: responses }),
	Object.freeze({ profile: "chat-completions-v1", verify: compatible }),
]);
