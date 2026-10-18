import { afterAll, beforeAll, describe, expect, test } from "vitest";
import {
	type As,
	authorize,
	authorizeUrl,
	Browser,
	finish,
	publicClient,
	REDIRECT_URI,
	startAs,
	startAuthorization,
} from "./flow.ts";

const client = publicClient();
let as: As;

beforeAll(async () => {
	as = await startAs([client]);
});
afterAll(async () => {
	await as?.close();
});

// Authorization responses come in the query, or the fragment for front-channel response types.
function callbackParams(location: string): Record<string, string> {
	const url = new URL(location);
	expect(`${url.origin}${url.pathname}`).toBe(REDIRECT_URI);
	return Object.fromEntries(new URLSearchParams(url.hash ? url.hash.slice(1) : url.search));
}

async function redirectFor(params: Record<string, string | undefined>, browser = new Browser()) {
	const { url, state } = authorizeUrl(as, client, params);
	const response = await browser.get(url);
	expect(response.status).toBe(303);
	return { params: callbackParams(response.headers.get("location") ?? ""), state };
}

test("a successful authorization response carries code, state and iss", async () => {
	const authorized = await authorize(as, client);
	const params = callbackParams(authorized.callback.href);
	expect(Object.keys(params).sort()).toStrictEqual(["code", "iss", "state"]);
	expect(params.iss).toBe(as.origin);
	expect(params.state).toBe(authorized.state);
	const metadata = (await (
		await fetch(`${as.origin}/.well-known/oauth-authorization-server`)
	).json()) as Record<string, unknown>;
	expect(metadata.authorization_response_iss_parameter_supported).toBe(true);
	expect(metadata.issuer).toBe(as.origin);
});

describe("every error redirect carries iss", () => {
	const cases: readonly (readonly [string, Record<string, string | undefined>, string])[] = [
		["no PKCE", { code_challenge: undefined, code_challenge_method: undefined }, "invalid_request"],
		["another resource", { resource: "https://evil.example/mcp" }, "invalid_target"],
		["a front-channel response type", { response_type: "token" }, "unsupported_response_type"],
		["a malformed scope", { scope: 'inbox:read "x"' }, "invalid_scope"],
		["prompt=none without a session", { prompt: "none" }, "login_required"],
	];
	test.each(cases)("%s", async (_name, params, error) => {
		const redirect = await redirectFor(params);
		expect(redirect.params.error).toBe(error);
		expect(redirect.params.iss).toBe(as.origin);
		expect(redirect.params.state).toBe(redirect.state);
	});

	test("prompt=none with a session (no silent authorization)", async () => {
		const browser = new Browser();
		await authorize(as, client, {}, browser);
		const redirect = await redirectFor({ prompt: "none" }, browser);
		expect(redirect.params).toStrictEqual({
			error: "consent_required",
			error_description: "every authorization needs the owner's typed-code consent",
			state: redirect.state,
			iss: as.origin,
		});
	});

	test("the owner denies", async () => {
		const browser = new Browser();
		const started = await startAuthorization(as, browser, client);
		as.consent.deny(started.uid);
		expect(callbackParams((await finish(as, browser, started.uid)).href)).toStrictEqual({
			error: "access_denied",
			error_description: "the owner did not approve the request",
			state: started.state,
			iss: as.origin,
		});
	});

	test("the owner leaves every scope unticked", async () => {
		const browser = new Browser();
		const started = await startAuthorization(as, browser, client);
		as.consent.approve(started.uid, started.code, []);
		const params = callbackParams((await finish(as, browser, started.uid)).href);
		expect(params.error).toBe("access_denied");
		expect(params.iss).toBe(as.origin);
		expect(params.state).toBe(started.state);
	});

	test("consent is rate limited", async () => {
		const limited = await startAs([client], { consent: { limits: { perMinute: 0 } } });
		try {
			const browser = new Browser();
			const started = await startAuthorization(limited, browser, client);
			expect(callbackParams((await finish(limited, browser, started.uid)).href)).toStrictEqual({
				error: "temporarily_unavailable",
				error_description: "consent is paused or rate limited",
				state: started.state,
				iss: limited.origin,
			});
		} finally {
			await limited.close();
		}
	});
});

describe("errors that can't be trusted to a redirect stay on the AS", () => {
	test.each([
		["an unknown client", { client_id: "unknown-client" }, "invalid_client"],
		[
			"an unregistered redirect URI",
			{ redirect_uri: "https://evil.example/cb" },
			"invalid_redirect_uri",
		],
	] as const)("%s", async (_name, params, error) => {
		const { url } = authorizeUrl(as, client, params);
		const response = await new Browser().get(url);
		expect(response.status).toBe(400);
		expect(response.headers.get("location")).toBeNull();
		expect(response.headers.get("content-security-policy")).toBe(
			"default-src 'none'; base-uri 'none'; frame-ancestors 'none'",
		);
		const html = await response.text();
		expect(html).toContain(`<p>error: ${error}</p>`);
		expect(html).not.toMatch(/<script|<link|<style|@import|url\(/i);
	});
});
