import { afterAll, beforeAll, describe, expect, test } from "vitest";
import {
	type As,
	authorize,
	authorizeUrl,
	Browser,
	confidentialClient,
	exchange,
	pkcePair,
	publicClient,
	startAs,
} from "./flow.ts";

const clients = [publicClient(), confidentialClient()];
let as: As;

beforeAll(async () => {
	as = await startAs(clients);
});
afterAll(async () => {
	await as?.close();
});

// The error comes back to the client's redirect URI, with iss and state.
async function rejected(params: Record<string, string | undefined>, client = clients[0]) {
	if (!client) throw new Error("no client");
	const { url, state } = authorizeUrl(as, client, params);
	const response = await new Browser().get(url);
	expect(response.status).toBe(303);
	const callback = new URL(response.headers.get("location") ?? "");
	expect(callback.origin + callback.pathname).toBe("https://client.example/callback");
	expect(callback.searchParams.get("iss")).toBe(as.origin);
	expect(callback.searchParams.get("state")).toBe(state);
	expect(callback.searchParams.has("code")).toBe(false);
	return {
		error: callback.searchParams.get("error"),
		description: callback.searchParams.get("error_description"),
	};
}

describe.each(clients)("$kind client", (client) => {
	test("an authorization request without a code challenge is refused", async () => {
		expect(
			await rejected({ code_challenge: undefined, code_challenge_method: undefined }, client),
		).toStrictEqual({
			error: "invalid_request",
			description: "Authorization Server policy requires PKCE to be used for this request",
		});
	});

	test("a missing PKCE verifier fails at the token endpoint", async () => {
		const authorized = await authorize(as, client);
		const { status, body } = await exchange(as, client, authorized, { code_verifier: undefined });
		expect(status).toBe(400);
		expect(body.error).toBe("invalid_grant");
		expect(body.access_token).toBeUndefined();
	});

	test("a wrong PKCE verifier fails at the token endpoint", async () => {
		const authorized = await authorize(as, client);
		const { status, body } = await exchange(as, client, authorized, {
			code_verifier: pkcePair().verifier,
		});
		expect(status).toBe(400);
		expect(body.error).toBe("invalid_grant");
	});

	test("the right verifier gets tokens", async () => {
		const authorized = await authorize(as, client);
		const { status, body } = await exchange(as, client, authorized);
		expect(status).toBe(200);
		expect(body.token_type).toBe("Bearer");
	});
});

test("S256 is the only challenge method", async () => {
	expect(await rejected({ code_challenge_method: "plain" })).toStrictEqual({
		error: "invalid_request",
		description: "not supported value of code_challenge_method",
	});
	expect(await rejected({ code_challenge_method: undefined })).toStrictEqual({
		error: "invalid_request",
		description: "code_challenge_method must be provided",
	});
	expect(await rejected({ code_challenge: "too-short" })).toStrictEqual({
		error: "invalid_request",
		description: "code_challenge must be a string with a minimum length of 43 characters",
	});
});

test("a malformed verifier is refused", async () => {
	const [client] = clients;
	if (!client) throw new Error("no client");
	const authorized = await authorize(as, client);
	const { status, body } = await exchange(as, client, authorized, {
		code_verifier: "x".repeat(42),
	});
	expect(status).toBe(400);
	expect(body.error).toBe("invalid_request");
});
