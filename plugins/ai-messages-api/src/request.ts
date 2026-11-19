import { aiProviderV1 } from "@draftyak/protocol/ai-provider-v1";
import type { ContextId } from "@draftyak/protocol/draft-output";
import { canonicalize } from "@draftyak/protocol/jcs";
import { draftFormat } from "./format.ts";
import { boundedText, isModel, isRecord, MessagesError, snapshotRequestData } from "./shared.ts";

export const DEFAULT_MODEL = "claude-opus-5-5";
export const DEFAULT_EFFORT = "medium";
export const MAX_TOKENS = 16_000;
export const API_URL = "https://api.anthropic.com/v1/messages";
export const FALLBACK_BETA = "server-side-fallback-2026-07-01";
export const EFFORTS = ["low", "medium", "high", "xhigh", "max"] as const;
export type Effort = (typeof EFFORTS)[number];

const fallbackModels = new Set([
	"claude-fable-5-1",
	"claude-fable-5",
	"claude-opus-5-5",
	"claude-opus-5",
	"claude-sonnet-5-5",
]);
const schemaJson = canonicalize(draftFormat.schema);

export interface Settings {
	readonly model?: string;
	readonly effort?: Effort;
	readonly maxTokens?: number;
}
export interface DraftInput {
	readonly system: string;
	readonly prompt: string;
	readonly contextIds?: readonly ContextId[];
}
export interface Pin {
	readonly model: string;
	readonly effort: Effort;
}
export interface RequestBody {
	readonly model: string;
	readonly system: string;
	readonly messages: readonly [{ readonly role: "user"; readonly content: string }];
	readonly max_tokens: number;
	readonly output_config: {
		readonly effort: Effort;
		readonly format: { readonly type: "json_schema"; readonly schema: Record<string, unknown> };
	};
	readonly stream?: boolean;
	readonly fallbacks?: "default";
}
export interface MessagesRequest {
	readonly method: "POST";
	readonly url: string;
	readonly headers: Readonly<Record<string, string>>;
	readonly body: RequestBody;
}
export interface OutgoingRequest {
	readonly method: string;
	readonly url: string;
	readonly headers: Headers | Readonly<Record<string, string>>;
	readonly body: unknown;
}
export type Verdict =
	| { readonly ok: true; readonly request: MessagesRequest }
	| { readonly ok: false; readonly problems: readonly string[] };

export function supportsFallback(model: string): boolean {
	return fallbackModels.has(model);
}

export function buildRequest(input: DraftInput, settings: Settings = {}): MessagesRequest {
	try {
		const model = settings.model ?? DEFAULT_MODEL;
		const effort = settings.effort ?? DEFAULT_EFFORT;
		const maxTokens = settings.maxTokens ?? MAX_TOKENS;
		const parsed = aiProviderV1.tools.ai_draft_generate.input.safeParse(
			{
				model,
				system: input.system,
				prompt: input.prompt,
				contextIds: input.contextIds ?? [],
			},
			{ jitless: true },
		);
		if (
			!parsed.success ||
			!isModel(model) ||
			!EFFORTS.includes(effort) ||
			!Number.isSafeInteger(maxTokens) ||
			maxTokens < 1 ||
			maxTokens > MAX_TOKENS
		)
			throw new MessagesError("INVALID_INPUT");
		const fallback = supportsFallback(model);
		return {
			method: "POST",
			url: API_URL,
			headers: {
				"content-type": "application/json",
				"anthropic-version": "2023-06-01",
				"x-api-key": "brokered",
				...(fallback ? { "anthropic-beta": FALLBACK_BETA } : {}),
			},
			body: {
				model,
				system: parsed.data.system,
				messages: [{ role: "user", content: parsed.data.prompt }],
				max_tokens: maxTokens,
				output_config: {
					effort,
					format: {
						type: "json_schema",
						schema: JSON.parse(schemaJson) as Record<string, unknown>,
					},
				},
				...(fallback ? { fallbacks: "default" } : {}),
			},
		};
	} catch {
		throw new MessagesError("INVALID_INPUT");
	}
}

const bodyKeys = [
	"model",
	"system",
	"messages",
	"max_tokens",
	"output_config",
	"stream",
	"fallbacks",
];
function closed(value: Record<string, unknown>, allowed: readonly string[]): boolean {
	return Object.keys(value).every((key) => allowed.includes(key));
}

const headerRules = new Map<string, (value: string) => boolean>([
	["accept", (value) => value === "application/json"],
	["content-type", (value) => value === "application/json"],
	["anthropic-version", (value) => value === "2023-06-01"],
	["x-api-key", (value) => value === "brokered"],
	["anthropic-beta", (value) => value === FALLBACK_BETA],
	["user-agent", (value) => value === "Anthropic/JS 0.135.0"],
	["x-stainless-retry-count", (value) => /^\d{1,2}$/.test(value)],
	["x-stainless-timeout", (value) => /^\d{1,6}$/.test(value)],
	["x-stainless-helper-method", (value) => value === "stream"],
]);

// Only the reconstructed request from a successful verdict may be sent.
export function verifyRequest(rawRequest: OutgoingRequest, rawPin: Pin): Verdict {
	try {
		const request = snapshotRequestData(rawRequest);
		const pin = snapshotRequestData(rawPin);
		const problems: string[] = [];
		const fail = (path: string): void => {
			if (problems.length < 20) problems.push(`${path}: refused`);
		};
		if (
			request.method !== "POST" ||
			(request.url !== API_URL && request.url !== `${API_URL}?beta=true`)
		)
			fail("target");
		const body = request.body;
		if (!isRecord(body)) return { ok: false, problems: ["body: refused"] };
		if (!closed(body, bodyKeys)) fail("body");
		if (!isModel(body.model) || body.model !== pin.model) fail("model");
		if (!boundedText(body.system, 100_000)) fail("system");
		const messages = body.messages;
		const message = Array.isArray(messages) && messages.length === 1 ? messages[0] : null;
		if (
			!isRecord(message) ||
			!closed(message, ["role", "content"]) ||
			message.role !== "user" ||
			!boundedText(message.content, 1_000_000)
		)
			fail("messages");
		if (
			!Number.isSafeInteger(body.max_tokens) ||
			Number(body.max_tokens) < 1 ||
			Number(body.max_tokens) > MAX_TOKENS
		)
			fail("max_tokens");
		const output = body.output_config;
		if (
			!isRecord(output) ||
			!closed(output, ["format", "effort"]) ||
			output.effort !== pin.effort ||
			!EFFORTS.includes(output.effort as Effort)
		)
			fail("output_config");
		const format = isRecord(output) ? output.format : null;
		if (
			!isRecord(format) ||
			!closed(format, ["type", "schema"]) ||
			format.type !== "json_schema" ||
			canonicalize(format.schema) !== schemaJson
		)
			fail("output_config.format");
		if ("stream" in body && typeof body.stream !== "boolean") fail("stream");
		if (
			"fallbacks" in body &&
			(body.fallbacks !== "default" || !supportsFallback(String(body.model)))
		)
			fail("fallbacks");
		const headers = new Headers(request.headers);
		for (const [name, value] of headers) if (!headerRules.get(name)?.(value)) fail("headers");
		for (const name of ["content-type", "anthropic-version", "x-api-key"])
			if (!headers.has(name)) fail("headers");
		if (headers.has("anthropic-beta") !== "fallbacks" in body) fail("fallbacks");
		if (problems.length) return { ok: false, problems };
		const clean = buildRequest(
			{ system: body.system as string, prompt: (message as { content: string }).content },
			{
				model: pin.model,
				effort: pin.effort,
				maxTokens: body.max_tokens as number,
			},
		);
		const { fallbacks: _fallbacks, ...withoutFallbacks } = clean.body;
		return {
			ok: true,
			request: {
				method: "POST",
				url: request.url,
				headers: Object.fromEntries(headers),
				body: {
					...withoutFallbacks,
					...("stream" in body ? { stream: body.stream as boolean } : {}),
					...("fallbacks" in body ? { fallbacks: "default" as const } : {}),
				},
			},
		};
	} catch {
		return { ok: false, problems: ["request: refused"] };
	}
}
