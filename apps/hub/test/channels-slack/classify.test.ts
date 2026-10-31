import { readFileSync } from "node:fs";
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
	classifySlackSend,
	parseSlackRetryAfter,
	SlackCoreError,
} from "../../src/channels/slack/index.ts";

const fixtures = JSON.parse(
	readFileSync(new URL("./fixtures/send-outcomes.json", import.meta.url), "utf8"),
) as { name: string; observation: unknown; expected: unknown }[];
const context = { channelId: "C0CHAN001", now: 0, deliverBy: 900_000, retryAttempt: 0 };
const rate = { kind: "response", status: 429, retryAfter: "30" };

describe("Slack send outcomes", () => {
	it.each(fixtures)("golden: $name", ({ observation, expected }) => {
		const result = classifySlackSend({ ...context, observation });
		expect(result).toEqual(expected);
		expect(JSON.stringify(result)).not.toContain("PRIVATE_CANARY");
	});
	it.each(["ratelimited", "rate_limited"])(
		"preserves the full server wait and approval deadline for %s",
		(error) => {
			const body = Object.freeze({ ok: false, error, detail: "PRIVATE_CANARY" });
			for (const status of [200, 400]) {
				const observation = Object.freeze({ kind: "response", status, body, retryAfter: "600" });
				expect(
					classifySlackSend(Object.freeze({ ...context, deliverBy: 599_999, observation })),
				).toEqual({ state: "NEEDS_REAPPROVAL", reason: "missed" });
				expect(
					classifySlackSend(Object.freeze({ ...context, deliverBy: 600_000, observation })),
				).toEqual({ state: "RETRY_WAIT", notBefore: 600_000, reason: "rate_limited" });
				expect(observation).toEqual({ kind: "response", status, body, retryAfter: "600" });
			}
		},
	);
	it("keeps completed statuses outside 2xx and 4xx ambiguous despite recognized bodies", () => {
		const bodies = [
			{ ok: true, channel: context.channelId, ts: "1760000001.000100" },
			{ ok: false, error: "ratelimited" },
			{ ok: false, error: "rate_limited" },
			{ ok: false, error: "channel_not_found" },
		];
		for (const status of [100, 199, 300, 302, 399, 500, 599, 600, Number.MAX_SAFE_INTEGER]) {
			for (const body of bodies) {
				expect(
					classifySlackSend({
						...context,
						observation: { kind: "response", status, body, retryAfter: "30" },
					}),
				).toEqual({ state: "UNKNOWN", reason: "ambiguous" });
			}
		}
	});
	it("keeps unrecognized 4xx responses and success shaped bodies ambiguous", () => {
		for (const status of [400, 401, 403, 404, 409, 418, 451, 499]) {
			for (const body of [
				undefined,
				"PRIVATE_CANARY",
				{ ok: false, error: "PRIVATE_CANARY" },
				{ ok: false, error: "fatal_error" },
				{ ok: true, channel: context.channelId, ts: "1760000001.000100" },
			]) {
				expect(
					classifySlackSend({ ...context, observation: { kind: "response", status, body } }),
				).toEqual({ state: "UNKNOWN", reason: "ambiguous" });
			}
		}
	});
	it.each([
		"restricted_action_read_only_channel",
		"restricted_action_thread_only_channel",
		"restricted_action_thread_locked",
		"restricted_action_non_threadable_channel",
		"cannot_reply_to_message",
		"ekm_access_denied",
		"team_access_not_granted",
	])("recognizes the definite %s refusal independently of HTTP status", (error) => {
		for (const status of [200, 400, 403])
			expect(
				classifySlackSend({
					...context,
					observation: { kind: "response", status, body: { ok: false, error } },
				}),
			).toEqual({ state: "FAILED", reason: "rejected" });
	});
	it("requires an explicit Slack refusal before interpreting an error code", () => {
		for (const error of [
			"ratelimited",
			"rate_limited",
			"channel_not_found",
			"cannot_reply_to_message",
		]) {
			for (const ok of [undefined, true, "false"]) {
				expect(
					classifySlackSend({
						...context,
						observation: { kind: "response", status: 200, body: { ok, error } },
					}),
				).toEqual({ state: "UNKNOWN", reason: "ambiguous" });
			}
		}
	});
	it("honors the entire Retry-After instead of shortening it to fit the approved window", () => {
		expect(classifySlackSend({ ...context, deliverBy: 29_999, observation: rate })).toEqual({
			state: "NEEDS_REAPPROVAL",
			reason: "missed",
		});
		expect(classifySlackSend({ ...context, deliverBy: 30_000, observation: rate })).toEqual({
			state: "RETRY_WAIT",
			notBefore: 30_000,
			reason: "rate_limited",
		});
		expect(
			classifySlackSend({
				...context,
				observation: { ...rate, retryAfter: "999999999999999999999999999" },
			}),
		).toEqual({ state: "NEEDS_REAPPROVAL", reason: "missed" });
		expect(classifySlackSend({ ...context, now: 900_001, observation: rate })).toEqual({
			state: "NEEDS_REAPPROVAL",
			reason: "missed",
		});
	});
	it("caps exponential backoff with bounded injected jitter, while retaining longer server waits", () => {
		expect(
			classifySlackSend({
				...context,
				retryAttempt: 2,
				jitterMs: 123,
				observation: { kind: "transport", written: "none" },
			}),
		).toEqual({ state: "RETRY_WAIT", notBefore: 4123, reason: "not_written" });
		expect(
			classifySlackSend({
				...context,
				retryAttempt: 1_000_000,
				observation: { kind: "transport", written: "none" },
			}),
		).toEqual({ state: "RETRY_WAIT", notBefore: 300_000, reason: "not_written" });
		expect(classifySlackSend({ ...context, observation: { ...rate, retryAfter: "600" } })).toEqual({
			state: "RETRY_WAIT",
			notBefore: 600_000,
			reason: "rate_limited",
		});
	});
	it("keeps ambiguous and confirmed outcomes after a deadline, without inventing a resend", () => {
		expect(
			classifySlackSend({
				...context,
				now: 900_001,
				observation: { kind: "transport", written: "maybe" },
			}),
		).toEqual({ state: "UNKNOWN", reason: "ambiguous" });
		expect(
			classifySlackSend({
				...context,
				now: 900_001,
				observation: {
					kind: "response",
					status: 200,
					body: { ok: true, channel: "C0CHAN001", ts: "1760000001.000100" },
				},
			}),
		).toEqual({ state: "SENT", channelId: "C0CHAN001", ts: "1760000001.000100" });
	});
	it("rejects malformed classifier control inputs without echoing provider content", () => {
		for (const value of [
			null,
			[],
			{ ...context, now: Number.NaN, observation: rate },
			{ ...context, jitterMs: 1001, observation: rate },
			{ ...context, observation: { kind: "transport", written: "PRIVATE_CANARY" } },
		]) {
			try {
				classifySlackSend(value);
				throw new Error("expected failure");
			} catch (error) {
				expect(error).toBeInstanceOf(SlackCoreError);
				expect(String(error)).not.toContain("PRIVATE_CANARY");
			}
		}
	});
	it.each([
		0,
		99,
		-1,
		200.5,
		Number.NaN,
		Number.POSITIVE_INFINITY,
		Number.MAX_SAFE_INTEGER + 1,
		"600",
	])("rejects malformed status %s without echoing provider content", (status) => {
		expect(() =>
			classifySlackSend({
				...context,
				observation: { kind: "response", status, body: "PRIVATE_CANARY" },
			}),
		).toThrow("INVALID_INPUT");
	});
	it("rejects a malformed destination and keeps malformed success timestamps ambiguous", () => {
		for (const suffix of ["\n", "\r\n", "\u2028", "\u2029"]) {
			expect(() =>
				classifySlackSend({
					...context,
					channelId: `${context.channelId}${suffix}`,
					observation: rate,
				}),
			).toThrow(SlackCoreError);
			expect(
				classifySlackSend({
					...context,
					observation: {
						kind: "response",
						status: 200,
						body: { ok: true, channel: context.channelId, ts: `1760000001.000100${suffix}` },
					},
				}),
			).toEqual({ state: "UNKNOWN", reason: "ambiguous" });
		}
	});
	it("never schedules a retry outside deliverBy (200 runs)", () => {
		fc.assert(
			fc.property(
				fc.integer({ min: 0, max: 1_000_000 }),
				fc.integer({ min: 0, max: 3600 }),
				fc.integer({ min: 0, max: 40 }),
				(deliverBy, seconds, retryAttempt) => {
					const result = classifySlackSend({
						...context,
						deliverBy,
						retryAttempt,
						observation: { ...rate, retryAfter: String(seconds) },
					});
					if (result.state === "RETRY_WAIT") {
						expect(result.notBefore).toBeLessThanOrEqual(deliverBy);
						expect(result.notBefore).toBeGreaterThanOrEqual(seconds * 1000);
						expect(result.notBefore).toBeGreaterThan(0);
					} else expect(result).toEqual({ state: "NEEDS_REAPPROVAL", reason: "missed" });
				},
			),
			{ numRuns: 200, seed: 6102 },
		);
	});
});

describe("Retry-After", () => {
	const now = Date.parse("2026-10-17T12:00:00Z");
	it("parses seconds and IMF-fixdate, including past dates and large waits", () => {
		expect(parseSlackRetryAfter(" 30 ", now)).toBe(30_000);
		expect(parseSlackRetryAfter("0", now)).toBe(0);
		expect(parseSlackRetryAfter("Sat, 17 Oct 2026 12:00:45 GMT", now)).toBe(45_000);
		expect(parseSlackRetryAfter("Sat, 17 Oct 2026 11:59:00 GMT", now)).toBe(0);
		expect(parseSlackRetryAfter("999999999999999999999999", now)).toBe(Number.MAX_SAFE_INTEGER);
	});
	it.each([
		undefined,
		null,
		"",
		"-1",
		"1.5",
		"soon",
		"2026-10-17T12:00:45Z",
		"Sun, 17 Oct 2026 12:00:45 GMT",
		"9".repeat(513),
		"\ud800",
		"30\n",
		30,
	])("treats malformed headers as absent", (value) =>
		expect(parseSlackRetryAfter(value, now)).toBeNull(),
	);
});
