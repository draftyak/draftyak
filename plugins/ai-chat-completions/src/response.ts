import { type DraftOutcome, type DraftRequest, ModelId } from "@draftyak/protocol/ai-provider-v1";
import { normalizeDraftOutput, validateDraftOutput } from "@draftyak/protocol/draft-output";
import { parseStrict } from "@draftyak/protocol/jcs";
import { bytes, data, fail, string } from "./boundary.ts";
import type { CompatibleConfig } from "./config.ts";

export const MAX_RESPONSE_BYTES = 262_144;
export const MAX_CONTENT_BYTES = 131_072;
export interface CompatibleResponse {
	readonly status: number;
	readonly url: string;
	readonly contentType: string;
	readonly body: Uint8Array;
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
			const usage = body.usage === undefined ? {} : data(body.usage);
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
			(message.tool_calls !== undefined &&
				(!Array.isArray(message.tool_calls) || message.tool_calls.length !== 0))
		)
			return unexpected("invalid_message");
		const content = string(message.content, MAX_CONTENT_BYTES);
		if (Buffer.byteLength(content, "utf8") > MAX_CONTENT_BYTES)
			return { kind: "invalid", ...base, problems: ["output: too_big"] };
		let value: unknown;
		try {
			value = parseStrict(content);
		} catch {
			return { kind: "invalid", ...base, problems: ["output: invalid_json"] };
		}
		const validated = validateDraftOutput(normalizeDraftOutput(value, request.contextIds));
		return validated.ok
			? { kind: "draft", ...base, output: validated.output }
			: { kind: "invalid", ...base, problems: validated.problems };
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
