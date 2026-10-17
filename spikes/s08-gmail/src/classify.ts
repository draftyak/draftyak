// The gmail-rfc5322 outcome classifier (plan §3 outbox): 2xx is SENT ("Accepted by Gmail"); a
// request that took no effect (408, 429, 403 rate limits, never written) is RETRY_WAIT; any other
// 4xx is FAILED; 5xx, timeouts and resets are UNKNOWN, which only reconcile resolves.

export type RetryReason =
	| "concurrent"
	| "mail_sending"
	| "rate_limit"
	| "request_timeout"
	| "not_written";

export type Outcome =
	| { readonly kind: "ok" }
	| { readonly kind: "retry"; readonly reason: RetryReason; readonly retryAt?: number }
	| { readonly kind: "failed"; readonly status: number; readonly reason: string }
	| { readonly kind: "unknown"; readonly reason: string };

interface GoogleError {
	readonly status?: string;
	readonly messages: readonly string[];
	readonly reasons: readonly string[];
}

const asRecord = (value: unknown): Record<string, unknown> =>
	value !== null && typeof value === "object" ? (value as Record<string, unknown>) : {};
const asString = (value: unknown): string | undefined =>
	typeof value === "string" ? value : undefined;

// { error: { code, message, status, errors: [{ domain, reason, message }] } }
export function parseGoogleError(body: unknown): GoogleError {
	const error = asRecord(asRecord(body).error);
	const items = Array.isArray(error.errors) ? error.errors.map(asRecord) : [];
	const pick = (key: string, list: Record<string, unknown>[]): string[] =>
		list.flatMap((item) => asString(item[key]) ?? []);
	const status = asString(error.status);
	return {
		...(status === undefined ? {} : { status }),
		messages: [...pick("message", [error]), ...pick("message", items)],
		reasons: pick("reason", items),
	};
}

// "Retry after <RFC 3339 time>" in the message (the Mail sending shape), else Retry-After.
export function retryTime(
	messages: readonly string[],
	headers: Headers,
	now: number,
): number | undefined {
	for (const message of messages) {
		const at = Date.parse(/retry after (\S+?)\.?(?:\s|$)/i.exec(message)?.[1] ?? "");
		if (Number.isFinite(at)) return at;
	}
	const header = headers.get("retry-after")?.trim() ?? "";
	if (/^\d+$/.test(header)) return now + Number(header) * 1000;
	const date = Date.parse(header);
	return Number.isFinite(date) ? date : undefined;
}

const RATE_LIMIT_403 = new Set(["rateLimitExceeded", "userRateLimitExceeded"]);

function retry(reason: RetryReason, retryAt: number | undefined): Outcome {
	return retryAt === undefined ? { kind: "retry", reason } : { kind: "retry", reason, retryAt };
}

export function classifyResponse(
	status: number,
	body: unknown,
	headers: Headers,
	now: number,
): Outcome {
	if (status >= 200 && status < 300) return { kind: "ok" };
	const error = parseGoogleError(body);
	const says = (pattern: RegExp): boolean => error.messages.some((text) => pattern.test(text));
	if (status === 429) {
		const at = retryTime(error.messages, headers, now);
		if (says(/\(mail sending\)/i)) return retry("mail_sending", at);
		if (says(/too many concurrent requests/i)) return retry("concurrent", at);
		return retry("rate_limit", at);
	}
	if (status === 403 && error.reasons.some((reason) => RATE_LIMIT_403.has(reason))) {
		return retry("rate_limit", retryTime(error.messages, headers, now));
	}
	if (status === 408) return { kind: "retry", reason: "request_timeout" };
	if (status >= 400 && status < 500) {
		return { kind: "failed", status, reason: error.reasons[0] ?? error.status ?? `http_${status}` };
	}
	return { kind: "unknown", reason: `http_${status}` };
}

// Errors raised before a byte of the request left this machine.
const NOT_WRITTEN = new Set([
	"ECONNREFUSED",
	"ENOTFOUND",
	"EAI_AGAIN",
	"EHOSTUNREACH",
	"ENETUNREACH",
	"UND_ERR_CONNECT_TIMEOUT",
]);

export function classifyNetworkError(error: unknown): Outcome {
	const outer = asRecord(error);
	const code = asString(asRecord(outer.cause).code) ?? asString(outer.code);
	if (code !== undefined && NOT_WRITTEN.has(code)) return { kind: "retry", reason: "not_written" };
	const name = asString(outer.name);
	if (name === "TimeoutError" || name === "AbortError")
		return { kind: "unknown", reason: "timeout" };
	return { kind: "unknown", reason: code ?? "network" };
}

// The status arrived but the body didn't (a reset or timeout mid-body). A 2xx may have taken
// effect, so it is UNKNOWN; any other status is classified as if its body were empty.
export function classifyBodyFailure(
	status: number,
	headers: Headers,
	error: unknown,
	now: number,
): Outcome {
	if (status < 200 || status >= 300) return classifyResponse(status, undefined, headers, now);
	const cause = classifyNetworkError(error);
	return { kind: "unknown", reason: `body_${cause.kind === "unknown" ? cause.reason : "lost"}` };
}

export type NextStep =
	| { readonly state: "SENT" }
	| { readonly state: "RETRY_WAIT"; readonly notBefore: number }
	| { readonly state: "NEEDS_REAPPROVAL"; readonly reason: "missed" }
	| { readonly state: "FAILED"; readonly reason: string }
	| { readonly state: "UNKNOWN" };

// RETRY_WAIT backs off 2^n s with jitter, capped at 5 min and at deliverBy; a retry time past
// deliverBy is a missed window, never a late send. "Mail sending" can last hours, so without
// Gmail's time to retry it counts as past deliverBy too.
export function nextStep(
	outcome: Outcome,
	window: { readonly now: number; readonly deliverBy: number; readonly attempt: number },
	random: () => number = Math.random,
): NextStep {
	switch (outcome.kind) {
		case "ok":
			return { state: "SENT" };
		case "failed":
			return { state: "FAILED", reason: outcome.reason };
		case "unknown":
			return { state: "UNKNOWN" };
		case "retry": {
			const late = outcome.retryAt ?? (outcome.reason === "mail_sending" ? Infinity : undefined);
			if (late !== undefined && late > window.deliverBy) {
				return { state: "NEEDS_REAPPROVAL", reason: "missed" };
			}
			const backoff = Math.min(2 ** window.attempt * 1000, 300_000) * (0.5 + random() / 2);
			const at = Math.max(outcome.retryAt ?? 0, window.now + Math.round(backoff));
			if (window.now >= window.deliverBy) return { state: "NEEDS_REAPPROVAL", reason: "missed" };
			return { state: "RETRY_WAIT", notBefore: Math.min(at, window.deliverBy) };
		}
	}
}
