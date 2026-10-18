import { describe, expect, it } from "vitest";
import {
	assertToken,
	callSlack,
	DEFAULT_RETRY_AFTER_MS,
	MAX_RETRY_AFTER_MS,
	parseRetryAfter,
	SlackError,
	systemClock,
} from "../src/api.ts";
import { fakeToken } from "./fake-slack.ts";

const CANARY = "canary-text-0b7d";
const NOW = Date.UTC(2026, 9, 17, 12);

interface Sent {
	readonly url: URL;
	readonly init: RequestInit;
}

// A fetch that records the request and answers with `response`.
function answering(response: () => Response): {
	readonly sent: Sent[];
	readonly fetch: typeof fetch;
} {
	const sent: Sent[] = [];
	const fetch = (async (input: RequestInfo | URL, init: RequestInit = {}) => {
		sent.push({ url: new URL(input instanceof Request ? input.url : input), init });
		return response();
	}) as typeof globalThis.fetch;
	return { sent, fetch };
}

const json =
	(status: number, body: unknown, headers: Record<string, string> = {}) =>
	() =>
		new Response(JSON.stringify(body), {
			status,
			headers: { "content-type": "application/json", ...headers },
		});

const user = fakeToken("xoxp");
const app = fakeToken("xapp");

describe("callSlack", () => {
	it("sends reads as GETs with query arguments and the token only in the Authorization header", async () => {
		const { sent, fetch } = answering(json(200, { ok: true, messages: [] }));
		const out = await callSlack(
			"conversations.history",
			user,
			{ channel: "C0CHAN001", limit: 15, cursor: undefined },
			{ base: "https://slack.com/api/", fetch },
		);
		expect(out.data).toEqual({ ok: true, messages: [] });
		const [request] = sent;
		expect(request?.url.href).toBe(
			"https://slack.com/api/conversations.history?channel=C0CHAN001&limit=15",
		);
		expect(request?.init).toMatchObject({
			method: "GET",
			headers: { authorization: `Bearer ${user}` },
			redirect: "error",
		});
		expect(request?.init.body).toBeUndefined();
	});

	it("posts apps.connections.open with the app-level token and an empty form", async () => {
		const { sent, fetch } = answering(
			json(200, { ok: true, url: "wss://wss-primary.slack.com/link/?ticket=t" }),
		);
		await callSlack("apps.connections.open", app, {}, { fetch });
		const [request] = sent;
		expect(request?.url.href).toBe("https://slack.com/api/apps.connections.open");
		expect(request?.init).toMatchObject({
			method: "POST",
			headers: {
				authorization: `Bearer ${app}`,
				"content-type": "application/x-www-form-urlencoded",
			},
		});
		expect(String(request?.init.body)).toBe("");
	});

	it("refuses the wrong token kind and undocumented arguments before sending", async () => {
		const { sent, fetch } = answering(json(200, { ok: true }));
		await expect(callSlack("conversations.history", app, {}, { fetch })).rejects.toThrow(
			"expected a user token",
		);
		await expect(callSlack("apps.connections.open", user, {}, { fetch })).rejects.toThrow(
			"expected an app-level token",
		);
		await expect(
			callSlack("conversations.history", user, { query: "x" }, { fetch }),
		).rejects.toThrow("conversations.history takes no query");
		await expect(callSlack("auth.test", user, { token: user }, { fetch })).rejects.toThrow(
			"takes no token",
		);
		expect(sent).toHaveLength(0);
		expect(() => assertToken("app", `xoxe.${app}`)).not.toThrow();
		expect(() => assertToken("user", `xoxe.${user}`)).not.toThrow();
		expect(() => assertToken("user", fakeToken("xoxb"))).toThrow();
	});

	it("classifies failures and keeps only Slack's error code", async () => {
		const failure = async (response: () => Response): Promise<SlackError> => {
			const { fetch } = answering(response);
			const error = await callSlack(
				"conversations.info",
				user,
				{ channel: "C0CHAN001" },
				{ fetch, now: () => NOW },
			).catch((caught: unknown) => caught);
			expect(error).toBeInstanceOf(SlackError);
			return error as SlackError;
		};
		expect(
			await failure(json(429, { ok: false, error: "ratelimited" }, { "retry-after": "30" })),
		).toMatchObject({
			kind: "rate_limited",
			retryAfterMs: 30_000,
			status: 429,
		});
		expect(await failure(json(200, { ok: false, error: "ratelimited" }))).toMatchObject({
			kind: "rate_limited",
			retryAfterMs: DEFAULT_RETRY_AFTER_MS,
		});
		for (const code of ["invalid_auth", "token_revoked", "account_inactive", "not_authed"]) {
			expect(await failure(json(200, { ok: false, error: code }))).toMatchObject({
				kind: "auth",
				code,
			});
		}
		expect(await failure(json(200, { ok: false, error: "channel_not_found" }))).toMatchObject({
			kind: "failed",
			retryAfterMs: null,
		});
		expect(await failure(json(503, { ok: false }))).toMatchObject({
			kind: "transient",
			code: "http_503",
		});
		expect(
			await failure(() => new Response(`<html>${CANARY}</html>`, { status: 200 })),
		).toMatchObject({
			kind: "transient",
			code: "malformed",
		});
		const odd = await failure(
			json(200, { ok: false, error: `${CANARY} with text`, detail: CANARY }),
		);
		expect(odd).toMatchObject({ kind: "failed", code: "unknown" });
		expect(`${odd.message} ${JSON.stringify(odd)}`).not.toContain(CANARY);
		const network = await failure(() => {
			throw new TypeError(`fetch failed: ${CANARY}`);
		});
		expect(network).toMatchObject({ kind: "transient", code: "network", status: 0 });
		expect(network.message).not.toContain(CANARY);
	});

	it("passes an abort through instead of calling it a network failure", async () => {
		const controller = new AbortController();
		controller.abort();
		const fetch = ((_input: RequestInfo | URL, init?: RequestInit) =>
			Promise.reject(init?.signal?.reason)) as typeof globalThis.fetch;
		await expect(
			callSlack("auth.test", user, {}, { fetch, signal: controller.signal }),
		).rejects.toMatchObject({ name: "AbortError" });
	});
});

describe("parseRetryAfter", () => {
	it("reads delay-seconds and IMF-fixdate HTTP-dates, at most 15 minutes, and nothing else", () => {
		expect(parseRetryAfter("30", NOW)).toBe(30_000);
		expect(parseRetryAfter(" 0 ", NOW)).toBe(0);
		expect(parseRetryAfter(new Date(NOW + 45_000).toUTCString(), NOW)).toBe(45_000);
		expect(parseRetryAfter(new Date(NOW - 45_000).toUTCString(), NOW)).toBe(0);
		for (const value of [
			"901",
			"999999999",
			"9".repeat(400),
			new Date(NOW + 2 ** 31).toUTCString(),
		]) {
			expect(parseRetryAfter(value, NOW)).toBe(MAX_RETRY_AFTER_MS);
		}
		for (const value of [null, "", "-1", "1.5", "soon", "2026-10-17T12:00:45Z"]) {
			expect(parseRetryAfter(value, NOW)).toBeNull();
		}
	});
});

describe("systemClock", () => {
	it("never hands Node a timer over 2^31-1 ms, which would fire after 1 ms", async () => {
		const controller = new AbortController();
		const slept = systemClock.delay(2 ** 31 + 1000, controller.signal).then(
			() => "fired",
			() => "aborted",
		);
		await new Promise((resolve) => setTimeout(resolve, 100));
		controller.abort();
		expect(await slept).toBe("aborted");
	});
});

describe("the unit tier", () => {
	it("is offline: fetch and WebSocket refuse every host beyond loopback", async () => {
		const guarded = (value: unknown): boolean =>
			(value as { loopbackOnly?: boolean }).loopbackOnly === true;
		expect([guarded(globalThis.fetch), guarded(globalThis.WebSocket)]).toEqual([true, true]);
		// The .invalid hosts come first, so a guard that let everything through fails before any
		// request could reach Slack.
		for (const url of ["https://guard-check.invalid/", "https://slack.com/api/auth.test"]) {
			await expect(fetch(url)).rejects.toThrow("outside loopback refused");
		}
		for (const url of ["wss://guard-check.invalid/", "wss://wss-primary.slack.com/link/"]) {
			expect(() => new WebSocket(url)).toThrow("outside loopback refused");
		}
	});
});
