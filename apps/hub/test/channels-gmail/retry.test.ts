import { describe, expect, it } from "vitest";
import { planGmailPollRetry } from "../../src/channels/gmail/retry.ts";

type ErrorData = Parameters<typeof planGmailPollRetry>[0];
type State = Parameters<typeof planGmailPollRetry>[1];
type Options = Parameters<typeof planGmailPollRetry>[2];

const transient: ErrorData = Object.freeze({ code: "TRANSIENT" });
const initial: State = Object.freeze({ nowMs: 1_000, attempt: 1, cancelled: false });
const invalidMessage = "Invalid Gmail poll retry input";

function invalid(error: unknown, state: unknown, options?: unknown): void {
	expect(() =>
		planGmailPollRetry(error as ErrorData, state as State, options as Options),
	).toThrowError(new TypeError(invalidMessage));
}

describe("Gmail polling retry DATA", () => {
	it.each([
		[1, 30_000],
		[2, 60_000],
		[3, 120_000],
		[4, 240_000],
		[5, 480_000],
		[6, 900_000],
		[7, 900_000],
	])("backs off failed attempt %i by %i ms with the default cap", (attempt, delayMs) => {
		expect(planGmailPollRetry(transient, { ...initial, attempt })).toEqual({
			kind: "retry",
			delayMs,
			retryAtMs: initial.nowMs + delayMs,
		});
	});

	it("uses a custom cap without rounding it upward or lowering the 30-second floor", () => {
		expect(planGmailPollRetry(transient, initial, { maxBackoffMs: 45_000 })).toEqual({
			kind: "retry",
			delayMs: 30_000,
			retryAtMs: 31_000,
		});
		expect(
			planGmailPollRetry(transient, { ...initial, attempt: 3 }, { maxBackoffMs: 45_000 }),
		).toEqual({ kind: "retry", delayMs: 45_000, retryAtMs: 46_000 });
		expect(
			planGmailPollRetry(transient, { ...initial, attempt: 7 }, { maxBackoffMs: 30_000 }),
		).toEqual({ kind: "retry", delayMs: 30_000, retryAtMs: 31_000 });
	});

	it("bounds exponential work by the total-attempt limit even with a very large cap", () => {
		const delayMs = 30_000 * 2 ** 30;
		expect(
			planGmailPollRetry(
				transient,
				{ nowMs: 0, attempt: 31, cancelled: false },
				{ maxAttempts: 32, maxBackoffMs: Number.MAX_SAFE_INTEGER },
			),
		).toEqual({ kind: "retry", delayMs, retryAtMs: delayMs });
	});

	it("counts maxAttempts as total attempts and never schedules another after exhaustion", () => {
		for (const attempt of [8, 9, Number.MAX_SAFE_INTEGER]) {
			expect(planGmailPollRetry(transient, { ...initial, attempt })).toEqual({
				kind: "stop",
				reason: "attempts-exhausted",
			});
		}
		expect(planGmailPollRetry(transient, initial, { maxAttempts: 1 })).toEqual({
			kind: "stop",
			reason: "attempts-exhausted",
		});
		expect(planGmailPollRetry(transient, { ...initial, attempt: 32 }, { maxAttempts: 32 })).toEqual(
			{ kind: "stop", reason: "attempts-exhausted" },
		);
	});

	it("retries rate-limited and transient errors without treating either as cancellation", () => {
		for (const code of ["TRANSIENT", "RATE_LIMITED"] as const) {
			expect(planGmailPollRetry({ code }, initial)).toEqual({
				kind: "retry",
				delayMs: 30_000,
				retryAtMs: 31_000,
			});
		}
	});

	it("keeps provider delay as a lower bound beyond the local backoff cap", () => {
		expect(
			planGmailPollRetry(
				{ code: "RATE_LIMITED", retryAfterMs: 2_000_000 },
				{ ...initial, attempt: 7 },
				{ maxBackoffMs: 45_000 },
			),
		).toEqual({ kind: "retry", delayMs: 2_000_000, retryAtMs: 2_001_000 });
		expect(planGmailPollRetry({ code: "TRANSIENT", retryAfterMs: 0 }, initial)).toEqual({
			kind: "retry",
			delayMs: 30_000,
			retryAtMs: 31_000,
		});
		expect(
			planGmailPollRetry(
				{ code: "RATE_LIMITED", retryAfterMs: 40_000 },
				{ ...initial, attempt: 2 },
			),
		).toEqual({ kind: "retry", delayMs: 60_000, retryAtMs: 61_000 });
	});

	it("cancellation stops before retry, exhaustion or deadline decisions", () => {
		for (const code of ["TRANSIENT", "RATE_LIMITED", "SEND_UNCERTAIN"] as const) {
			expect(
				planGmailPollRetry(
					{ code, retryAfterMs: Number.MAX_SAFE_INTEGER },
					{
						nowMs: Number.MAX_SAFE_INTEGER,
						attempt: 8,
						cancelled: true,
						deliverByMs: 0,
					},
				),
			).toEqual({ kind: "stop", reason: "cancelled" });
		}
	});

	it("does not mistake local quota bounds or other error codes for polling rate limits", () => {
		const codes: ErrorData["code"][] = [
			"AUTH_EXPIRED",
			"AUTH_REVOKED",
			"QUOTA_EXCEEDED",
			"CURSOR_EXPIRED",
			"NOT_FOUND",
			"PERMISSION_DENIED",
			"INVALID_INPUT",
			"UNSUPPORTED",
			"SEND_REJECTED",
			"SEND_UNCERTAIN",
		];
		for (const code of codes) {
			expect(planGmailPollRetry({ code, retryAfterMs: 50_000 }, initial)).toEqual({
				kind: "stop",
				reason: "non-retryable",
			});
		}
	});

	it("stops at the deadline boundary and never schedules at or after it", () => {
		for (const deliverByMs of [0, 999, 1_000, 30_999, 31_000]) {
			expect(planGmailPollRetry(transient, { ...initial, deliverByMs })).toEqual({
				kind: "stop",
				reason: "deadline",
			});
		}
		expect(planGmailPollRetry(transient, { ...initial, deliverByMs: 31_001 })).toEqual({
			kind: "retry",
			delayMs: 30_000,
			retryAtMs: 31_000,
		});
		expect(
			planGmailPollRetry(
				{ code: "RATE_LIMITED", retryAfterMs: 2_000_000 },
				{ ...initial, deliverByMs: 2_001_000 },
			),
		).toEqual({ kind: "stop", reason: "deadline" });
	});

	it("refuses retry timestamp overflow and accepts the largest exactly representable timestamp", () => {
		invalid(transient, { ...initial, nowMs: Number.MAX_SAFE_INTEGER - 29_999 });
		invalid({ code: "RATE_LIMITED", retryAfterMs: Number.MAX_SAFE_INTEGER }, initial);
		expect(
			planGmailPollRetry(transient, { ...initial, nowMs: Number.MAX_SAFE_INTEGER - 30_000 }),
		).toEqual({
			kind: "retry",
			delayMs: 30_000,
			retryAtMs: Number.MAX_SAFE_INTEGER,
		});
		expect(
			planGmailPollRetry(
				{ code: "RATE_LIMITED", retryAfterMs: Number.MAX_SAFE_INTEGER },
				{ ...initial, nowMs: 0 },
			),
		).toEqual({
			kind: "retry",
			delayMs: Number.MAX_SAFE_INTEGER,
			retryAtMs: Number.MAX_SAFE_INTEGER,
		});
	});

	it("rejects malformed error DATA with a fixed TypeError", () => {
		for (const error of [undefined, null, [], "TRANSIENT", {}, { code: "UNKNOWN" }, { code: 1 }]) {
			invalid(error, initial);
		}
		for (const retryAfterMs of [-1, 0.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1, null, "1"]) {
			invalid({ code: "RATE_LIMITED", retryAfterMs }, initial);
		}
	});

	it("rejects malformed state DATA without coercion", () => {
		for (const state of [undefined, null, [], 1, {}, { ...initial, cancelled: 0 }]) {
			invalid(transient, state);
		}
		for (const nowMs of [-1, 0.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1, "1000"]) {
			invalid(transient, { ...initial, nowMs });
		}
		for (const attempt of [0, -1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1, "1"]) {
			invalid(transient, { ...initial, attempt });
		}
		for (const deliverByMs of [-1, 0.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1, null, "1"]) {
			invalid(transient, { ...initial, deliverByMs });
		}
	});

	it("rejects invalid policy options instead of weakening retry bounds", () => {
		for (const options of [null, [], "options", 1]) invalid(transient, initial, options);
		for (const maxAttempts of [0, 33, 1.5, NaN, Infinity, null, "8"]) {
			invalid(transient, initial, { maxAttempts });
		}
		for (const maxBackoffMs of [
			29_999,
			-1,
			30_000.5,
			NaN,
			Infinity,
			Number.MAX_SAFE_INTEGER + 1,
			null,
		]) {
			invalid(transient, initial, { maxBackoffMs });
		}
	});

	it("ignores detail text without reading or interpreting it", () => {
		const error = {
			code: "TRANSIENT" as const,
			get detail(): string {
				throw new Error("unread-detail");
			},
		};
		expect(planGmailPollRetry(error, initial)).toEqual(planGmailPollRetry(transient, initial));
	});

	it("sanitizes malformed field access failures without preserving their cause", () => {
		const error = {
			get code(): "TRANSIENT" {
				throw new Error("untrusted-field-value");
			},
		};
		try {
			planGmailPollRetry(error, initial);
			throw new Error("Expected input refusal");
		} catch (caught) {
			expect(caught).toBeInstanceOf(TypeError);
			expect((caught as TypeError).message).toBe(invalidMessage);
			expect(Object.hasOwn(caught as object, "cause")).toBe(false);
		}
	});

	it("returns frozen DATA and repeats the same decision from restored durable state", () => {
		const error = Object.freeze({ code: "RATE_LIMITED" as const, retryAfterMs: 90_000 });
		const state = Object.freeze({ nowMs: 12_000, attempt: 3, cancelled: false });
		const options = Object.freeze({ maxAttempts: 8, maxBackoffMs: 900_000 });
		const result = planGmailPollRetry(error, state, options);
		expect(Object.isFrozen(result)).toBe(true);
		expect(Object.isFrozen(planGmailPollRetry({ code: "QUOTA_EXCEEDED" }, state))).toBe(true);
		const restoredError: ErrorData = JSON.parse(JSON.stringify(error));
		const restoredState: State = JSON.parse(JSON.stringify(state));
		expect(planGmailPollRetry(restoredError, restoredState, { ...options })).toEqual(result);
		expect(state).toEqual({ nowMs: 12_000, attempt: 3, cancelled: false });
		expect(error).toEqual({ code: "RATE_LIMITED", retryAfterMs: 90_000 });
	});
});
