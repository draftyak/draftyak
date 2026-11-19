import { type DraftOutcome, type DraftRequest, ModelId } from "@draftyak/protocol/ai-provider-v1";
import { parseDraftOutputText } from "@draftyak/protocol/draft-output-text";
import { parseStrict } from "@draftyak/protocol/jcs";
import { bytes, CompatibleError, data, fail, string } from "./boundary.ts";
import type { CompatibleConfig } from "./config.ts";

export const MAX_RESPONSE_BYTES = 262_144;
export const MAX_CONTENT_BYTES = 131_072;
export interface CompatibleResponse {
	readonly status: number;
	readonly url: string;
	readonly contentType: string;
	readonly headers?: Readonly<Record<string, string>>;
	readonly body: Uint8Array;
}

function retryAfterMs(input: unknown): number | undefined {
	try {
		const headers = data(input);
		const values = Object.entries(headers).filter(([name]) => name.toLowerCase() === "retry-after");
		if (values.length !== 1) return undefined;
		const raw = values[0]?.[1];
		if (typeof raw !== "string") return undefined;
		const value = raw.trim();
		if (/^\d+$/.test(value)) return Math.min(Number.MAX_SAFE_INTEGER, Number(value) * 1000);
		if (value.length > 128 || !/^[A-Za-z]/.test(value)) return undefined;
		const delay = Math.max(0, Date.parse(value) - Date.now());
		return Number.isSafeInteger(delay) && delay >= 0 ? delay : undefined;
	} catch {
		return undefined;
	}
}

function quotaExceeded(input: unknown): boolean {
	try {
		const body = data(parseStrict(bytes(input, MAX_RESPONSE_BYTES)));
		return data(body.error).code === "insufficient_quota";
	} catch {
		return false;
	}
}

function responseFailure(config: CompatibleConfig, input: unknown): CompatibleError | undefined {
	try {
		const response = data(input);
		if (response.url !== config.endpoint || !Number.isInteger(response.status)) return undefined;
		const status = response.status;
		if (status === 401) return new CompatibleError("AUTH_REVOKED");
		if (status === 403) return new CompatibleError("PERMISSION_DENIED");
		if (status === 400 || (status === 404 && config.format === "ollama"))
			return new CompatibleError("INVALID_INPUT");
		if (status === 429)
			return new CompatibleError(
				quotaExceeded(response.body) ? "QUOTA_EXCEEDED" : "RATE_LIMITED",
				retryAfterMs(response.headers),
			);
		if (typeof status === "number" && (status === 408 || (status >= 500 && status <= 599)))
			return new CompatibleError("TRANSIENT");
	} catch {
		// Invalid envelopes still take the bounded invalid-response outcome path.
	}
	return undefined;
}

export function responseObject(input: unknown, endpoint: string): Record<string, unknown> {
	const response = data(input);
	if (
		response.url !== endpoint ||
		typeof response.status !== "number" ||
		!Number.isInteger(response.status) ||
		response.status < 200 ||
		response.status >= 300 ||
		typeof response.contentType !== "string" ||
		response.contentType.split(";")[0]?.trim().toLowerCase() !== "application/json"
	)
		fail("INVALID_RESPONSE");
	try {
		return data(parseStrict(bytes(response.body, MAX_RESPONSE_BYTES)));
	} catch {
		return fail("INVALID_RESPONSE");
	}
}

function count(value: unknown): number | null {
	return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : null;
}

export function readOutcome(
	config: CompatibleConfig,
	request: DraftRequest,
	input: unknown,
): DraftOutcome {
	const failure = responseFailure(config, input);
	if (failure) throw failure;
	let base = {
		model: config.model,
		fallback: false,
		usage: { input: null as number | null, output: 0 },
	};
	const unexpected = (stopReason: string | null): DraftOutcome => ({
		kind: "unexpected",
		...base,
		stopReason,
	});
	try {
		const body = responseObject(input, config.endpoint);
		if (body.model !== config.model) return unexpected("model_mismatch");
		let reason: unknown;
		let rawMessage: unknown;
		if (config.format === "ollama") {
			base = {
				...base,
				usage: { input: count(body.prompt_eval_count), output: count(body.eval_count) ?? 0 },
			};
			if (body.done !== true) return unexpected("not_done");
			reason = body.done_reason;
			rawMessage = body.message;
		} else {
			const usage = body.usage == null ? {} : data(body.usage);
			base = {
				...base,
				usage: { input: count(usage.prompt_tokens), output: count(usage.completion_tokens) ?? 0 },
			};
			if (!Array.isArray(body.choices) || body.choices.length !== 1)
				return unexpected("invalid_envelope");
			const choice = data(body.choices[0]);
			reason = choice.finish_reason;
			rawMessage = choice.message;
		}
		if (reason === "length" || reason === "max_tokens")
			return { kind: "truncated", ...base, stopReason: "max_tokens" };
		if (reason === "model_context_window_exceeded")
			return { kind: "truncated", ...base, stopReason: "model_context_window_exceeded" };
		if (reason === "content_filter")
			return {
				kind: "refusal",
				...base,
				category: "content_filter",
				explanation: null,
				recommendedModel: null,
			};
		if (reason !== "stop") return unexpected(null);
		const message = data(rawMessage);
		if (message.refusal !== undefined && message.refusal !== null && message.refusal !== "") {
			return {
				kind: "refusal",
				...base,
				category: "refusal",
				explanation: null,
				recommendedModel: null,
			};
		}
		if (
			message.role !== "assistant" ||
			message.function_call != null ||
			(message.tool_calls != null &&
				(!Array.isArray(message.tool_calls) || message.tool_calls.length !== 0))
		)
			return unexpected("invalid_message");
		const content = string(message.content, MAX_CONTENT_BYTES);
		if (Buffer.byteLength(content, "utf8") > MAX_CONTENT_BYTES)
			return { kind: "invalid", ...base, problems: ["output: too_big"] };
		const validated = parseDraftOutputText(content, request.contextIds);
		return validated.ok
			? { kind: "draft", ...base, output: validated.output }
			: {
					kind: "invalid",
					...base,
					problems: validated.problems.map((problem) =>
						problem === "output: invalid_JSON" ? "output: invalid_json" : problem,
					),
				};
	} catch {
		return unexpected("invalid_response");
	}
}

export function modelIds(config: CompatibleConfig, input: unknown): readonly string[] {
	try {
		const body = responseObject(input, config.modelsEndpoint);
		const models = config.format === "ollama" ? body.models : body.data;
		if (!Array.isArray(models) || models.length > 500) fail();
		const ids = models.map((item: unknown) => {
			const value = data(item);
			const id = ModelId.safeParse(config.format === "ollama" ? value.name : value.id);
			if (!id.success) fail();
			return id.data;
		});
		return Object.freeze([...new Set(ids)]);
	} catch {
		return fail("INVALID_RESPONSE");
	}
}
