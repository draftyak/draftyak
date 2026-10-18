import { createHash, generateKeyPairSync, randomUUID, sign } from "node:crypto";
import { type AddressInfo, createServer } from "node:net";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	AGENT_NAME,
	authorizationUrl,
	CALLBACK_HOST,
	CALLBACK_PATH,
	CALLBACK_PORT,
	type Credential,
	discover,
	isHostId,
	listenForCallback,
	newAttempt,
	newHostId,
	planUsage,
	REGISTRATION_CLIENT,
	RESOURCE,
	type Registration,
	SCOPES,
	signIn,
} from "../src/auth.ts";
import { SiwcError } from "../src/errors.ts";
import { verifyIdToken } from "../src/id-token.ts";
import { type FakeAuth, type FakeAuthOptions, startFakeAuth } from "./fake-auth.ts";
import { failure } from "./harness.ts";

const opened: { close(): Promise<void> | void }[] = [];
afterEach(async () => {
	for (const item of opened.splice(0)) await item.close();
});

async function fakeAuth(options: Partial<FakeAuthOptions> = {}): Promise<FakeAuth> {
	const auth = await startFakeAuth(options);
	opened.push(auth);
	return auth;
}

// A foreign listener on an OS-assigned port (never a probed-then-freed one: another process could
// take it in between); returns its port.
async function hold(host: string): Promise<number> {
	const server = createServer((socket) => socket.destroy());
	await new Promise<void>((resolve, reject) => {
		server.once("error", reject).listen({ host, port: 0, exclusive: true }, resolve);
	});
	opened.push({ close: () => new Promise<void>((resolve) => server.close(() => resolve())) });
	return (server.address() as AddressInfo).port;
}

const portOf = (redirectUri: string): number => Number(new URL(redirectUri).port);

const params = (url: string): [string, string][] => [...new URL(url).searchParams];
const names = (url: string): string[] => params(url).map(([name]) => name);
const value = (url: string, name: string): string | null => new URL(url).searchParams.get(name);

async function signInWith(auth: FakeAuth, extra: Partial<Parameters<typeof signIn>[0]> = {}) {
	return signIn({
		hostId: extra.hostId ?? newHostId(),
		endpoints: await discover(auth.url),
		port: 0,
		openBrowser: auth.browse,
		...extra,
	});
}

const registration = (credential: Credential): Registration => {
	const { tokens: _tokens, ...saved } = credential;
	return saved;
};

describe("authorization requests (Registration and sign-in, step 2)", () => {
	const endpoint = "https://auth.example.test/api/accounts/authorize";
	const redirectUri = `http://${CALLBACK_HOST}:${CALLBACK_PORT}${CALLBACK_PATH}`;
	const hostId = newHostId();
	const saved: Registration = {
		issuer: "https://auth.example.test",
		clientId: "oaiapp_example",
		subject: "user-1",
		email: "owner@example.com",
		hostId,
		idTokenHint: "header.payload.signature",
	};

	it("registers as DraftYak with this hub's host ID, PKCE S256 and the full scope set", () => {
		const attempt = newAttempt();
		const url = authorizationUrl({ endpoint, redirectUri, hostId, attempt });
		expect(names(url)).toEqual([
			"client_id",
			"agent_name_hint",
			"ext_agent_host_id",
			"response_type",
			"redirect_uri",
			"scope",
			"resource",
			"state",
			"nonce",
			"code_challenge_method",
			"code_challenge",
		]);
		expect(value(url, "client_id")).toBe(REGISTRATION_CLIENT);
		expect(value(url, "agent_name_hint")).toBe(AGENT_NAME);
		expect(value(url, "ext_agent_host_id")).toBe(hostId);
		expect(value(url, "redirect_uri")).toBe("http://127.0.0.1:1455/auth/callback");
		expect(value(url, "scope")).toBe(
			"openid profile email offline_access resource.invoke chatgpt.tokens.use.direct",
		);
		expect(value(url, "resource")).toBe("https://api.openai.com/v1");
		expect(value(url, "code_challenge")).toBe(
			createHash("sha256").update(attempt.verifier).digest("base64url"),
		);
		expect(attempt.verifier).toMatch(/^[A-Za-z0-9_-]{43}$/);
	});

	it("reauthorizes a saved account with its issued client and hints, without the name hint", () => {
		const url = authorizationUrl({
			endpoint,
			redirectUri,
			hostId,
			attempt: newAttempt(),
			registration: saved,
		});
		expect(value(url, "client_id")).toBe("oaiapp_example");
		expect(names(url)).not.toContain("agent_name_hint");
		expect(value(url, "id_token_hint")).toBe(saved.idTokenHint);
		expect(value(url, "login_hint")).toBe("owner@example.com");
		expect(names(url)).not.toContain("prompt");
	});

	it("sends prompt=consent only when the owner turns plan usage on for a saved account", () => {
		const attempt = newAttempt();
		const enable = authorizationUrl({
			endpoint,
			redirectUri,
			hostId,
			attempt,
			registration: saved,
			enablePlan: true,
		});
		const fresh = authorizationUrl({ endpoint, redirectUri, hostId, attempt, enablePlan: true });
		expect(value(enable, "prompt")).toBe("consent");
		expect(value(enable, "scope")).toBe(SCOPES.join(" "));
		expect(names(fresh)).not.toContain("prompt");
	});

	it("uses fresh state, nonce and verifier for every attempt", () => {
		const [a, b] = [newAttempt(), newAttempt()];
		expect(new Set([a.state, b.state, a.nonce, b.nonce, a.verifier, b.verifier]).size).toBe(6);
	});

	it("refuses a host ID outside the documented formats", () => {
		for (const bad of ["laptop-1", "owner@example.com", `urn:uuid:${randomUUID().toUpperCase()}`]) {
			expect(() =>
				authorizationUrl({ endpoint, redirectUri, hostId: bad, attempt: newAttempt() }),
			).toThrow(/host ID/);
		}
	});
});

describe("host IDs (Overview, A client vs. an agent host)", () => {
	it("are UUIDv4 URNs by default", () => {
		expect(newHostId()).toMatch(/^urn:uuid:[0-9a-f-]{36}$/);
		expect(isHostId(newHostId())).toBe(true);
	});

	it("accept the documented thumbprint and did:key forms (RFC 9278's example) and nothing else", () => {
		expect(
			isHostId(
				"urn:ietf:params:oauth:jwk-thumbprint:sha-256:NzbLsXh8uDCcd-6MNwXF4W_7noWXFZAfHkxZsRGC9Xs",
			),
		).toBe(true);
		expect(isHostId("did:key:z6MkhaXgBZDvotDkL5257faiztiGiC2QtKLGpbnnEGta2doK")).toBe(true);
		for (const other of ["urn:uuid:not-a-uuid", "did:web:example.test", "host-1", ""]) {
			expect(isHostId(other)).toBe(false);
		}
	});
});

describe("the callback port", () => {
	it("defaults to 127.0.0.1:1455 with the documented path", () => {
		expect([CALLBACK_HOST, CALLBACK_PORT, CALLBACK_PATH]).toEqual([
			"127.0.0.1",
			1455,
			"/auth/callback",
		]);
	});

	// The same check as on 1455, which only the heavy tier binds (under the kit's lock).
	it.each(["127.0.0.1", "0.0.0.0"])(
		"gives PORT_IN_USE while a listener on %s holds it",
		async (host) => {
			const port = await hold(host);
			const error = await failure(listenForCallback("state", { port }));
			expect(error).toBeInstanceOf(SiwcError);
			expect((error as SiwcError).code).toBe("PORT_IN_USE");
			expect((error as SiwcError).facts.detail).toBe(`127.0.0.1:${port}`);
		},
	);

	it("frees the port after a callback, a timeout or an abort", async () => {
		const state = newAttempt().state;
		const first = await listenForCallback(state, { port: 0 });
		const port = portOf(first.redirectUri);
		await fetch(`${first.redirectUri}?state=${state}&code=c1`);
		expect(await first.result).toEqual({ kind: "code", code: "c1" });
		const second = await listenForCallback(state, { port, timeoutMs: 50 });
		expect(((await failure(second.result)) as SiwcError).facts.detail).toBe("timeout");
		const controller = new AbortController();
		const third = await listenForCallback(state, { port, signal: controller.signal });
		controller.abort();
		expect(((await failure(third.result)) as SiwcError).facts.detail).toBe("aborted");
		const last = await listenForCallback(state, { port });
		last.close();
	});

	// A timer left running would keep a sign-in process alive for the whole timeout.
	it("clears its timeout once the callback arrives", async () => {
		const set = vi.spyOn(globalThis, "setTimeout");
		const clear = vi.spyOn(globalThis, "clearTimeout");
		try {
			const state = newAttempt().state;
			const listener = await listenForCallback(state, { port: 0, timeoutMs: 600_000 });
			const ours = set.mock.calls.findIndex(([, ms]) => ms === 600_000);
			await (await fetch(`${listener.redirectUri}?state=${state}&code=c1`)).text();
			await listener.result;
			expect(ours).toBeGreaterThanOrEqual(0);
			expect(clear).toHaveBeenCalledWith(set.mock.results[ours]?.value);
		} finally {
			set.mockRestore();
			clear.mockRestore();
		}
	});

	it("answers only GET /auth/callback with its Host and state", async () => {
		const state = newAttempt().state;
		const listener = await listenForCallback(state, { port: 0 });
		const port = portOf(listener.redirectUri);
		const base = `http://127.0.0.1:${port}`;
		expect((await fetch(`${base}/callback?state=${state}&code=x`)).status).toBe(404);
		expect((await fetch(`${base}${CALLBACK_PATH}?state=x&code=x`)).status).toBe(400);
		expect((await fetch(`${base}${CALLBACK_PATH}?state=${state}`, { method: "POST" })).status).toBe(
			404,
		);
		const other = await fetch(
			`http://localhost:${port}${CALLBACK_PATH}?state=${state}&code=x`,
		).catch(() => undefined);
		expect(other === undefined || other.status === 404).toBe(true);
		const response = await fetch(
			`${base}${CALLBACK_PATH}?state=${state}&code=good&client_id=oaiapp_1`,
		);
		expect(response.headers.get("cache-control")).toBe("no-store");
		expect(response.headers.get("referrer-policy")).toBe("no-referrer");
		expect(await listener.result).toEqual({ kind: "code", code: "good", clientId: "oaiapp_1" });
	});
});

describe("sign-in against the fake authorization server", () => {
	it("registers, exchanges the code with PKCE and keeps a credential with plan usage on", async () => {
		const auth = await fakeAuth();
		const hostId = newHostId();
		const credential = await signInWith(auth, { hostId });
		expect(auth.problems).toEqual([]);
		expect(credential).toMatchObject({
			issuer: auth.url,
			subject: "user-fake-0001",
			email: "owner@example.com",
			hostId,
			tokens: { scopes: SCOPES },
		});
		expect(credential.clientId).toMatch(/^oaiapp_fake/);
		expect(planUsage(credential)).toBe("enabled");
		const [form] = auth.tokenForms;
		expect([...(form?.keys() ?? [])]).toEqual([
			"grant_type",
			"client_id",
			"code",
			"code_verifier",
			"redirect_uri",
			"resource",
		]);
		expect(form?.get("client_id")).toBe(credential.clientId);
		expect(form?.get("resource")).toBe(RESOURCE);
		expect(form?.get("redirect_uri")).toBe(auth.authorizations[0]?.get("redirect_uri"));
		const expiresIn = (credential.tokens?.expiresAt ?? 0) - (credential.tokens?.savedAt ?? 0);
		expect(expiresIn).toBe(3_600_000);
	});

	it("keeps the sign-in with plan usage off when chatgpt.tokens.use.direct isn't granted", async () => {
		const auth = await fakeAuth({ consent: "no-plan" });
		const credential = await signInWith(auth);
		expect(credential.tokens?.scopes).toContain("offline_access");
		expect(credential.tokens?.scopes).not.toContain("chatgpt.tokens.use.direct");
		expect(planUsage(credential)).toBe("disabled");
	});

	it("keeps the registration without tokens when only identity scopes come back", async () => {
		const auth = await fakeAuth({ consent: "identity-only" });
		const credential = await signInWith(auth);
		expect(credential.tokens).toBeNull();
		expect(credential.clientId).toMatch(/^oaiapp_fake/);
		expect(credential.idTokenHint).toBeDefined();
		expect(planUsage(credential)).toBe("disabled");
	});

	it("asks again with prompt=consent and the saved client only on the explicit path", async () => {
		const auth = await fakeAuth({ consent: "identity-only" });
		const first = await signInWith(auth);
		auth.options.consent = "allow";
		const routine = await signInWith(auth, {
			hostId: first.hostId,
			registration: registration(first),
		});
		expect(planUsage(routine)).toBe("disabled");
		const enabled = await signInWith(auth, {
			hostId: first.hostId,
			registration: registration(routine),
			enablePlan: true,
		});
		expect(planUsage(enabled)).toBe("enabled");
		expect(enabled.clientId).toBe(first.clientId);
		expect(auth.authorizations.map((request) => request.get("prompt"))).toEqual([
			null,
			null,
			"consent",
		]);
		expect(auth.authorizations[2]?.get("client_id")).toBe(first.clientId);
		expect(auth.problems).toEqual([]);
	});

	it("stops without exchanging a code when the owner declines", async () => {
		const auth = await fakeAuth({ consent: "decline" });
		const error = (await failure(signInWith(auth))) as SiwcError;
		expect([error.code, error.facts.apiCode]).toEqual(["SIGN_IN_FAILED", "access_denied"]);
		expect(auth.tokenForms).toEqual([]);
	});

	it("treats a registration callback without an issued client as incomplete", async () => {
		const auth = await fakeAuth({ omitIssuedClient: true });
		const error = (await failure(signInWith(auth))) as SiwcError;
		expect(error.facts.detail).toBe("registration incomplete");
		expect(auth.tokenForms).toEqual([]);
	});

	it("refuses a reauthorization callback that names another client", async () => {
		const auth = await fakeAuth();
		const first = await signInWith(auth);
		auth.options.reauthClientId = "other";
		const error = (await failure(
			signInWith(auth, { hostId: first.hostId, registration: registration(first) }),
		)) as SiwcError;
		expect(error.facts.detail).toBe("the callback named another client");
	});

	it("refuses a different ChatGPT account signing in to a saved registration", async () => {
		const auth = await fakeAuth();
		const first = await signInWith(auth);
		const saved = { ...registration(first), subject: "user-someone-else" };
		const error = (await failure(
			signInWith(auth, { hostId: first.hostId, registration: saved }),
		)) as SiwcError;
		expect(error.facts.detail).toBe("another ChatGPT account signed in");
	});

	it("after invalid_grant, signs in again with the client issued to the failed attempt", async () => {
		const auth = await fakeAuth({ codeErrors: ["invalid_grant"] });
		const hostId = newHostId();
		const error = (await failure(signInWith(auth, { hostId }))) as SiwcError;
		expect([error.code, error.facts.apiCode, error.facts.status]).toEqual([
			"SIGN_IN_FAILED",
			"invalid_grant",
			400,
		]);
		const clientId = error.facts.clientId ?? "";
		expect(clientId).toMatch(/^oaiapp_fake/);
		const credential = await signInWith(auth, { hostId, registration: { clientId } });
		expect([credential.clientId, credential.subject, planUsage(credential)]).toEqual([
			clientId,
			"user-fake-0001",
			"enabled",
		]);
		const retry = auth.authorizations[1];
		expect([retry?.get("client_id"), retry?.has("agent_name_hint")]).toEqual([clientId, false]);
		expect([...auth.clients.keys()]).toEqual([clientId]);
		expect(auth.problems).toEqual(["token: scripted"]);
	});

	// Unlike a refresh, a code exchange that gets a 503 or no answer can only start over.
	it("keeps SIGN_IN_FAILED for a code exchange the token endpoint didn't answer", async () => {
		const auth = await fakeAuth();
		const endpoints = await discover(auth.url);
		const down = (status: number | undefined): typeof fetch =>
			(async (url: string | URL | Request, init?: RequestInit) => {
				if (String(url) !== endpoints.token) return fetch(url, init);
				if (status === undefined) throw new TypeError("fetch failed");
				return new Response(null, { status });
			}) as typeof fetch;
		for (const [status, facts] of [
			[503, { status: 503 }],
			[undefined, { detail: "token endpoint unreachable" }],
		] as const) {
			const error = (await failure(signInWith(auth, { fetch: down(status) }))) as SiwcError;
			expect([error.code, error.recovery]).toEqual(["SIGN_IN_FAILED", "reauth"]);
			expect(error.facts).toMatchObject(facts);
		}
	});

	it.each([
		["no id_token", ({ id_token: _id, ...body }: Record<string, unknown>) => body],
		["another token_type", (body: Record<string, unknown>) => ({ ...body, token_type: "mac" })],
		["no expires_in", ({ expires_in: _e, ...body }: Record<string, unknown>) => body],
	])("refuses a code exchange with %s", async (_name, change) => {
		const auth = await fakeAuth({
			tokenResponse: (body, grant) => (grant === "authorization_code" ? change(body) : body),
		});
		const error = (await failure(signInWith(auth))) as SiwcError;
		expect([error.code, error.facts.detail]).toEqual([
			"SIGN_IN_FAILED",
			"token response incomplete",
		]);
	});

	it("refuses a saved registration that belongs to another host ID", async () => {
		const auth = await fakeAuth();
		const first = await signInWith(auth);
		const error = (await failure(
			signInWith(auth, { registration: registration(first) }),
		)) as SiwcError;
		expect(error.facts.detail).toBe("host ID differs from the saved one");
		expect(auth.authorizations).toHaveLength(1);
	});
});

describe("ID-token validation (step 4)", () => {
	const tampered: [string, Partial<FakeAuthOptions>, string][] = [
		["a key outside the JWKS", { signWithStranger: true }, "signature"],
		[
			"another issuer",
			{ idClaims: (c) => ({ ...c, iss: "https://issuer.example.test" }) },
			"issuer",
		],
		["another audience", { idClaims: (c) => ({ ...c, aud: "oaiapp_other" }) }, "audience"],
		["an expired token", { idClaims: (c) => ({ ...c, exp: Number(c.iat) - 3_600 }) }, "expired"],
		[
			"a token issued in the future",
			{ idClaims: (c) => ({ ...c, iat: Number(c.iat) + 3_600 }) },
			"issued in the future",
		],
		["a token without iat", { idClaims: ({ iat: _iat, ...c }) => c }, "issued in the future"],
		["another nonce", { idClaims: (c) => ({ ...c, nonce: "replayed" }) }, "nonce"],
		["no subject", { idClaims: ({ sub: _sub, ...c }) => c }, "subject"],
		[
			"several audiences without azp",
			{ idClaims: (c) => ({ ...c, aud: [c.aud, "oaiapp_other"] }) },
			"authorized party",
		],
	];

	it.each(tampered)("refuses %s", async (_name, options, detail) => {
		const auth = await fakeAuth(options);
		const error = (await failure(signInWith(auth))) as SiwcError;
		expect([error.code, error.facts.detail]).toEqual(["ID_TOKEN_INVALID", detail]);
	});

	describe("against a JWKS with one EC and one RSA key", () => {
		const ec = generateKeyPairSync("ec", { namedCurve: "P-256" });
		const rsa = generateKeyPairSync("rsa", { modulusLength: 2048 });
		const keys = [
			{ ...ec.publicKey.export({ format: "jwk" }), kid: "ec-1" },
			{ ...rsa.publicKey.export({ format: "jwk" }), kid: "rsa-1" },
		];
		const part = (value: object) => Buffer.from(JSON.stringify(value)).toString("base64url");
		const now = Date.now();
		const claims = {
			iss: "https://i.example.test",
			aud: "c1",
			sub: "s1",
			nonce: "n1",
			iat: now / 1000,
			exp: now / 1000 + 60,
		};
		const check = (jwks: () => Promise<Response> = async () => Response.json({ keys })) => ({
			issuer: claims.iss,
			jwksUri: "http://127.0.0.1/jwks",
			clientId: "c1",
			nonce: "n1",
			now,
			fetch: jwks as unknown as typeof fetch,
		});
		const token = (alg: string, kid: string): string => {
			const signed = `${part({ alg, kid })}.${part(claims)}`;
			const key =
				alg === "ES256"
					? { key: ec.privateKey, dsaEncoding: "ieee-p1363" as const }
					: rsa.privateKey;
			return `${signed}.${sign("sha256", Buffer.from(signed), key).toString("base64url")}`;
		};
		const detail = async (promise: Promise<unknown>): Promise<unknown> => {
			const error = await failure(promise);
			expect(error).toBeInstanceOf(SiwcError);
			return (error as SiwcError).facts.detail;
		};

		it("accepts ES256 and RS256 tokens signed by their keys", async () => {
			expect(await verifyIdToken(token("ES256", "ec-1"), check())).toEqual({ subject: "s1" });
			expect(await verifyIdToken(token("RS256", "rsa-1"), check())).toEqual({ subject: "s1" });
		});

		// Without the key-type match these would reach the signature check with the wrong key.
		it("refuses an unsigned token, and a kid that names a key of another type", async () => {
			const unsigned = (alg: string, kid: string) => `${part({ alg, kid })}.${part(claims)}.AAAA`;
			expect(await detail(verifyIdToken(unsigned("none", "ec-1"), check()))).toBe(
				"unsupported algorithm",
			);
			for (const [alg, kid] of [
				["ES256", "rsa-1"],
				["RS256", "ec-1"],
			] as const) {
				expect(await detail(verifyIdToken(unsigned(alg, kid), check()))).toBe(
					"unknown signing key",
				);
			}
		});

		it("gives ID_TOKEN_INVALID when the JWKS can't be fetched, read or used", async () => {
			const answers: (() => Promise<Response>)[] = [
				async () => {
					throw new TypeError("fetch failed");
				},
				async () => new Response("not json", { status: 200 }),
				async () => new Response(null, { status: 503 }),
				async () => Response.json({ keys: [{ kty: "EC", kid: "ec-1" }] }),
			];
			for (const answer of answers) {
				expect(await detail(verifyIdToken(token("ES256", "ec-1"), check(answer)))).toBe(
					"jwks unavailable",
				);
			}
		});
	});

	it("gives ID_TOKEN_INVALID when sign-in can't reach the JWKS", async () => {
		const auth = await fakeAuth();
		const endpoints = await discover(auth.url);
		const fetcher = (async (url: string | URL | Request, init?: RequestInit) =>
			String(url) === endpoints.jwks
				? Promise.reject(new TypeError("fetch failed"))
				: fetch(url, init)) as typeof fetch;
		const error = (await failure(signInWith(auth, { endpoints, fetch: fetcher }))) as SiwcError;
		expect([error.code, error.facts.detail]).toEqual(["ID_TOKEN_INVALID", "jwks unavailable"]);
	});
});

describe("discovery", () => {
	it("reads the documented endpoints from the issuer's document", async () => {
		const auth = await fakeAuth();
		expect(await discover(auth.url)).toEqual({
			issuer: auth.url,
			authorization: `${auth.url}/api/accounts/authorize`,
			token: `${auth.url}/api/accounts/oauth/token`,
			revocation: `${auth.url}/oauth/revoke`,
			jwks: `${auth.url}/.well-known/jwks.json`,
		});
	});

	it.each([
		[
			"another issuer",
			(doc: Record<string, unknown>) => ({ ...doc, issuer: "https://elsewhere.example.test" }),
			"discovery: issuer",
		],
		[
			"a token endpoint elsewhere",
			(doc: Record<string, unknown>) => ({
				...doc,
				token_endpoint: "https://elsewhere.example.test/token",
			}),
			"discovery: token_endpoint",
		],
		[
			"no revocation endpoint",
			({ revocation_endpoint: _r, ...doc }: Record<string, unknown>) => doc,
			"discovery: revocation_endpoint",
		],
	])("refuses %s", async (_name, discovery, detail) => {
		const auth = await fakeAuth({ discovery });
		expect(((await failure(discover(auth.url))) as SiwcError).facts.detail).toBe(detail);
	});
});
