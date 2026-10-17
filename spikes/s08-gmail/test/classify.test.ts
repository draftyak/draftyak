import { describe, expect, it } from "vitest";
import {
	classifyBodyFailure,
	classifyNetworkError,
	classifyResponse,
	nextStep,
	type Outcome,
	parseGoogleError,
} from "../src/classify.ts";
import {
	backend500,
	concurrent429,
	dailyLimit403,
	domainPolicy403,
	invalid400,
	mailSending429,
	rateLimit403,
	userRateLimit403,
} from "./google-errors.ts";

const now = Date.parse("2026-10-17T18:00:00Z");
const none = new Headers();
const classify = (status: number, body: unknown, headers: Headers = none): Outcome =>
	classifyResponse(status, body, headers, now);

describe("both 429 shapes", () => {
	it("Mail sending: a long retry at the time Gmail names", () => {
		const outcome = classify(429, mailSending429("2026-10-17T22:44:13.257Z"));
		expect(outcome).toEqual({
			kind: "retry",
			reason: "mail_sending",
			retryAt: Date.parse("2026-10-17T22:44:13.257Z"),
		});
	});

	it("Too many concurrent requests: a short retry", () => {
		expect(classify(429, concurrent429)).toEqual({ kind: "retry", reason: "concurrent" });
		const later = classify(429, concurrent429, new Headers({ "retry-after": "7" }));
		expect(later).toEqual({ kind: "retry", reason: "concurrent", retryAt: now + 7000 });
	});

	it("tells them apart by message text, whatever the reason says", () => {
		const sending = mailSending429("2026-10-18T00:00:00Z");
		const shared = [sending, concurrent429].map((body) => parseGoogleError(body).reasons.join());
		expect(shared).toEqual(["rateLimitExceeded", "rateLimitExceeded"]);
		expect(classify(429, sending)).toMatchObject({ reason: "mail_sending" });
		expect(classify(429, concurrent429)).toMatchObject({ reason: "concurrent" });
		const otherReason = mailSending429("2026-10-18T00:00:00Z", "userRateLimitExceeded");
		expect(classify(429, otherReason)).toMatchObject({ reason: "mail_sending" });
	});

	it("Mail sending without a time to retry: still the long lock", () => {
		expect(classify(429, mailSending429())).toEqual({ kind: "retry", reason: "mail_sending" });
	});

	it("treats any other 429 as a rate limit, honouring Retry-After as seconds or a date", () => {
		expect(classify(429, undefined)).toEqual({ kind: "retry", reason: "rate_limit" });
		const date = new Headers({ "retry-after": "Sat, 17 Oct 2026 18:05:00 GMT" });
		expect(classify(429, "Too Many Requests", date)).toEqual({
			kind: "retry",
			reason: "rate_limit",
			retryAt: Date.parse("2026-10-17T18:05:00Z"),
		});
	});
});

describe("403s and other statuses", () => {
	it("retries the 403 rate limits", () => {
		expect(classify(403, rateLimit403)).toEqual({ kind: "retry", reason: "rate_limit" });
		expect(classify(403, userRateLimit403)).toEqual({ kind: "retry", reason: "rate_limit" });
	});

	it("fails every other 403 and 4xx, and leaves 5xx unknown", () => {
		expect(classify(403, dailyLimit403)).toEqual({
			kind: "failed",
			status: 403,
			reason: "dailyLimitExceeded",
		});
		expect(classify(403, domainPolicy403)).toMatchObject({
			kind: "failed",
			reason: "domainPolicy",
		});
		expect(classify(400, invalid400)).toMatchObject({ kind: "failed", reason: "invalidArgument" });
		expect(classify(401, { error: { status: "UNAUTHENTICATED" } })).toMatchObject({
			kind: "failed",
			reason: "UNAUTHENTICATED",
		});
		expect(classify(404, "")).toEqual({ kind: "failed", status: 404, reason: "http_404" });
		expect(classify(408, "")).toEqual({ kind: "retry", reason: "request_timeout" });
		expect(classify(500, backend500)).toEqual({ kind: "unknown", reason: "http_500" });
		expect(classify(503, "")).toEqual({ kind: "unknown", reason: "http_503" });
		expect(classify(200, {})).toEqual({ kind: "ok" });
	});

	it("retries what never left the machine and leaves the rest unknown", () => {
		const refused = Object.assign(new TypeError("fetch failed"), {
			cause: { code: "ECONNREFUSED" },
		});
		expect(classifyNetworkError(refused)).toEqual({ kind: "retry", reason: "not_written" });
		expect(classifyNetworkError({ code: "ENOTFOUND" })).toEqual({
			kind: "retry",
			reason: "not_written",
		});
		const timeout = Object.assign(new Error("timed out"), { name: "TimeoutError" });
		expect(classifyNetworkError(timeout)).toEqual({ kind: "unknown", reason: "timeout" });
		const reset = Object.assign(new TypeError("fetch failed"), { cause: { code: "ECONNRESET" } });
		expect(classifyNetworkError(reset)).toEqual({ kind: "unknown", reason: "ECONNRESET" });
	});

	it("leaves a 2xx whose body was lost unknown, and reads other statuses without a body", () => {
		const cut = Object.assign(new TypeError("terminated"), { cause: { code: "UND_ERR_SOCKET" } });
		const timeout = Object.assign(new Error("timed out"), { name: "TimeoutError" });
		expect(classifyBodyFailure(200, none, cut, now)).toEqual({
			kind: "unknown",
			reason: "body_UND_ERR_SOCKET",
		});
		expect(classifyBodyFailure(200, none, timeout, now)).toEqual({
			kind: "unknown",
			reason: "body_timeout",
		});
		const refused = { cause: { code: "ECONNREFUSED" } };
		expect(classifyBodyFailure(204, none, refused, now)).toEqual({
			kind: "unknown",
			reason: "body_lost",
		});
		expect(classifyBodyFailure(429, new Headers({ "retry-after": "3" }), cut, now)).toEqual({
			kind: "retry",
			reason: "rate_limit",
			retryAt: now + 3000,
		});
		expect(classifyBodyFailure(400, none, cut, now)).toMatchObject({ kind: "failed" });
		expect(classifyBodyFailure(503, none, cut, now)).toEqual({
			kind: "unknown",
			reason: "http_503",
		});
	});
});

describe("nextStep: the outbox transition", () => {
	const deliverBy = now + 15 * 60_000;
	const half = () => 0.5;

	it("sends a retry past deliverBy to NEEDS_REAPPROVAL (missed), never late", () => {
		const hours = classify(429, mailSending429("2026-10-17T21:00:00Z"));
		expect(nextStep(hours, { now, deliverBy, attempt: 0 }, half)).toEqual({
			state: "NEEDS_REAPPROVAL",
			reason: "missed",
		});
		const soon = classify(429, mailSending429("2026-10-17T18:05:00Z"));
		expect(nextStep(soon, { now, deliverBy, attempt: 0 }, half)).toEqual({
			state: "RETRY_WAIT",
			notBefore: Date.parse("2026-10-17T18:05:00Z"),
		});
	});

	it("treats Mail sending without a time as missed, even in a 24 h window", () => {
		const untimed = classify(429, mailSending429());
		const window = { now, deliverBy: now + 24 * 3_600_000, attempt: 0 };
		expect(nextStep(untimed, window, half)).toEqual({
			state: "NEEDS_REAPPROVAL",
			reason: "missed",
		});
		expect(nextStep(classify(429, concurrent429), window, half)).toMatchObject({
			state: "RETRY_WAIT",
		});
	});

	it("backs off 2^n s with jitter, capped at 5 min and at deliverBy", () => {
		const outcome = classify(429, concurrent429);
		expect(nextStep(outcome, { now, deliverBy, attempt: 3 }, () => 1)).toEqual({
			state: "RETRY_WAIT",
			notBefore: now + 8000,
		});
		expect(nextStep(outcome, { now, deliverBy, attempt: 3 }, () => 0)).toEqual({
			state: "RETRY_WAIT",
			notBefore: now + 4000,
		});
		expect(nextStep(outcome, { now, deliverBy: now + 10 * 60_000, attempt: 20 }, () => 1)).toEqual({
			state: "RETRY_WAIT",
			notBefore: now + 300_000,
		});
		expect(nextStep(outcome, { now, deliverBy: now + 1000, attempt: 5 }, () => 1)).toEqual({
			state: "RETRY_WAIT",
			notBefore: now + 1000,
		});
		expect(nextStep(outcome, { now, deliverBy: now, attempt: 0 }, half)).toEqual({
			state: "NEEDS_REAPPROVAL",
			reason: "missed",
		});
	});

	it("maps the other outcomes", () => {
		const window = { now, deliverBy, attempt: 0 };
		expect(nextStep({ kind: "ok" }, window)).toEqual({ state: "SENT" });
		expect(nextStep(classify(400, invalid400), window)).toEqual({
			state: "FAILED",
			reason: "invalidArgument",
		});
		expect(nextStep(classify(502, ""), window)).toEqual({ state: "UNKNOWN" });
	});
});
