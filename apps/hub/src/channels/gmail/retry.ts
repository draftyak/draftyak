import type { PluginErrorResult } from "@draftyak/protocol/errors";

export interface GmailPollRetryState {
	readonly nowMs: number;
	readonly attempt: number;
	readonly cancelled: boolean;
	readonly deliverByMs?: number;
}

export interface GmailPollRetryOptions {
	readonly maxAttempts?: number;
	readonly maxBackoffMs?: number;
}

export type GmailPollRetryPlan =
	| Readonly<{ kind: "retry"; retryAtMs: number; delayMs: number }>
	| Readonly<{
			kind: "stop";
			reason: "cancelled" | "attempts-exhausted" | "deadline" | "non-retryable";
	  }>;

const MIN_DELAY_MS = 30_000;
const DEFAULT_MAX_ATTEMPTS = 8;
const DEFAULT_MAX_BACKOFF_MS = 15 * 60_000;
const INVALID_INPUT = "Invalid Gmail poll retry input";

const retryable: Readonly<Record<PluginErrorResult["code"], boolean>> = Object.freeze({
	AUTH_EXPIRED: false,
	AUTH_REVOKED: false,
	RATE_LIMITED: true,
	QUOTA_EXCEEDED: false,
	CURSOR_EXPIRED: false,
	NOT_FOUND: false,
	PERMISSION_DENIED: false,
	TRANSIENT: true,
	INVALID_INPUT: false,
	UNSUPPORTED: false,
	SEND_REJECTED: false,
	SEND_UNCERTAIN: false,
});

function integerAtLeast(value: unknown, minimum: number): value is number {
	return typeof value === "number" && Number.isSafeInteger(value) && value >= minimum;
}

function object(value: unknown): boolean {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stop(reason: Extract<GmailPollRetryPlan, { kind: "stop" }>["reason"]): GmailPollRetryPlan {
	return Object.freeze({ kind: "stop", reason });
}

/**
 * Computes polling DATA only. The caller owns durable attempt/journal state and
 * native job cancellation, currentness, account checks and broker budgets.
 * Attempt 1 is the first failed attempt; maxAttempts counts total attempts.
 * This function creates no timer, transaction, reservation or send permission.
 */
export function planGmailPollRetry(
	error: Pick<PluginErrorResult, "code" | "retryAfterMs">,
	state: GmailPollRetryState,
	options?: GmailPollRetryOptions,
): GmailPollRetryPlan {
	try {
		if (!object(error) || !object(state) || (options !== undefined && !object(options))) {
			throw new TypeError(INVALID_INPUT);
		}
		const code = error.code;
		const retryAfterMs = error.retryAfterMs;
		const nowMs = state.nowMs;
		const attempt = state.attempt;
		const cancelled = state.cancelled;
		const deliverByMs = state.deliverByMs;
		const suppliedMaxAttempts = options?.maxAttempts;
		const suppliedMaxBackoffMs = options?.maxBackoffMs;
		const maxAttempts =
			suppliedMaxAttempts === undefined ? DEFAULT_MAX_ATTEMPTS : suppliedMaxAttempts;
		const maxBackoffMs =
			suppliedMaxBackoffMs === undefined ? DEFAULT_MAX_BACKOFF_MS : suppliedMaxBackoffMs;
		if (
			typeof code !== "string" ||
			!Object.hasOwn(retryable, code) ||
			(retryAfterMs !== undefined && !integerAtLeast(retryAfterMs, 0)) ||
			!integerAtLeast(nowMs, 0) ||
			!integerAtLeast(attempt, 1) ||
			typeof cancelled !== "boolean" ||
			(deliverByMs !== undefined && !integerAtLeast(deliverByMs, 0)) ||
			!integerAtLeast(maxAttempts, 1) ||
			maxAttempts > 32 ||
			!integerAtLeast(maxBackoffMs, MIN_DELAY_MS)
		) {
			throw new TypeError(INVALID_INPUT);
		}

		if (cancelled) return stop("cancelled");
		if (attempt >= maxAttempts) return stop("attempts-exhausted");
		if (deliverByMs !== undefined && nowMs >= deliverByMs) return stop("deadline");
		if (!retryable[code]) return stop("non-retryable");

		let backoff = MIN_DELAY_MS;
		for (let previous = 1; previous < attempt && backoff < maxBackoffMs; previous++) {
			backoff = backoff > maxBackoffMs - backoff ? maxBackoffMs : backoff * 2;
		}
		// Provider delay is a lower bound, including when it exceeds our backoff cap.
		const delayMs = Math.max(backoff, retryAfterMs ?? 0);
		if (nowMs > Number.MAX_SAFE_INTEGER - delayMs) throw new TypeError(INVALID_INPUT);
		const retryAtMs = nowMs + delayMs;
		if (deliverByMs !== undefined && retryAtMs >= deliverByMs) return stop("deadline");
		return Object.freeze({ kind: "retry", retryAtMs, delayMs });
	} catch {
		throw new TypeError(INVALID_INPUT);
	}
}
