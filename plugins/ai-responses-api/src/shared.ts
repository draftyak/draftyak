import { type PluginErrorCode as Code, PluginErrorCode } from "@draftyak/protocol/errors";

export type ResponsesErrorCode = Code | "ABORTED";
export class ResponsesError extends Error {
	readonly code: ResponsesErrorCode;
	declare readonly retryAfterMs?: number;
	constructor(code: ResponsesErrorCode, retryAfterMs?: number) {
		super(`responses: ${code}`);
		this.name = "ResponsesError";
		this.code = code;
		if (validRetry(retryAfterMs)) this.retryAfterMs = retryAfterMs;
	}
}
export const record = (value: unknown): value is Record<string, unknown> =>
	typeof value === "object" && value !== null && !Array.isArray(value);

function field(value: unknown, key: string): unknown {
	try {
		return record(value) ? value[key] : undefined;
	} catch {
		return undefined;
	}
}

function validRetry(value: unknown): value is number {
	return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function retryAfter(
	error: unknown,
	result: unknown,
	nested: unknown,
	now: number,
): number | undefined {
	for (const value of [
		field(error, "retryAfterMs"),
		field(result, "retryAfterMs"),
		field(nested, "retryAfterMs"),
	])
		if (validRetry(value)) return value;
	const headers = field(error, "headers");
	let value: unknown;
	try {
		if (headers instanceof Headers) value = headers.get("retry-after");
		else if (record(headers)) {
			const keys = Object.keys(headers);
			if (keys.length > 64) return undefined;
			const names = keys.filter((key) => key.length === 11 && key.toLowerCase() === "retry-after");
			if (names.length === 1) value = field(headers, names[0] as string);
		}
	} catch {
		return undefined;
	}
	if (typeof value !== "string") return undefined;
	const hint = value.replace(/^[ \t]+|[ \t]+$/g, "");
	let milliseconds: number;
	if (/^[0-9]+$/.test(hint)) milliseconds = Number(hint) * 1_000;
	else {
		if (
			!/^[A-Z][a-z]{2}, [0-9]{2} [A-Z][a-z]{2} [0-9]{4} [0-9]{2}:[0-9]{2}:[0-9]{2} GMT$/.test(hint)
		)
			return undefined;
		const at = Date.parse(hint);
		if (!Number.isSafeInteger(now) || !Number.isFinite(at) || new Date(at).toUTCString() !== hint)
			return undefined;
		milliseconds = Math.max(0, at - now);
	}
	return validRetry(milliseconds) ? milliseconds : undefined;
}

// Only fixed contract codes and bounded numeric hints cross this completed-response boundary.
export function normalizeError(error: unknown, now: number = Date.now()): ResponsesError {
	const nested = field(error, "error");
	const result = field(error, "result");
	const codes = [field(error, "code"), field(result, "code"), field(nested, "code")];
	const retry = retryAfter(error, result, nested, now);
	for (const value of codes) {
		const parsed = PluginErrorCode.safeParse(value);
		if (parsed.success) return new ResponsesError(parsed.data, retry);
	}
	const status = field(error, "status") ?? field(error, "statusCode");
	const code: Code = codes.includes("insufficient_quota")
		? "QUOTA_EXCEEDED"
		: status === 401 || codes.includes("invalid_api_key")
			? "AUTH_REVOKED"
			: status === 403 || codes.includes("permission_denied")
				? "PERMISSION_DENIED"
				: status === 429 || codes.includes("rate_limit_exceeded")
					? "RATE_LIMITED"
					: "TRANSIENT";
	return new ResponsesError(code, retry);
}
