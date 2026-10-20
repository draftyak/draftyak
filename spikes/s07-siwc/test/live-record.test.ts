import type { ResponseStreamEvent } from "openai/resources/responses/responses";
import { afterEach, describe, expect, it } from "vitest";
import type { Structure } from "../src/responses.ts";
import {
	detailText,
	discoveryShape,
	eventStats,
	jwksShape,
	name,
	pathName,
	revocationVerdict,
	tokenFormat,
	tokenShape,
	upstreamRecorder,
	WITHHELD,
	waitUntil,
} from "./live-record.ts";
import { draftVerdict, scrub, withheldIn } from "./live-session.ts";
import { json, type Served, serve } from "./serve.ts";

// What the live session may record (test/live-record.ts) and the final content check: names,
// shapes, sizes and codes pass; values, text and content-shaped strings don't.

const glue = (...parts: string[]): string => parts.join("");
const part = (value: object): string => Buffer.from(JSON.stringify(value)).toString("base64url");
const event = (value: Record<string, unknown>): ResponseStreamEvent =>
	value as unknown as ResponseStreamEvent;

let served: Served | undefined;
afterEach(async () => {
	await served?.close();
	served = undefined;
});

describe("names, paths and details from upstream", () => {
	it("pass identifiers and withhold anything else", () => {
		const names = ["invalid_grant", "tools[0]", "x-request-id", "chatgpt.tokens.use.direct"];
		expect(names.map(name)).toEqual(names);
		const others = [
			glue("owner", "@", "example", ".com"),
			"user-123456789",
			"3f2c8a1e",
			"two words",
			"a".repeat(101),
			42,
		];
		expect(others.map(name)).toEqual(Array(others.length).fill(WITHHELD));
		expect(["/oauth/revoke", "oauth/revoke", "/users/123456789"].map(pathName)).toEqual([
			"/oauth/revoke",
			WITHHELD,
			WITHHELD,
		]);
		expect(["discovery: issuer", "a\nb", 7].map(detailText)).toEqual([
			"discovery: issuer",
			WITHHELD,
			WITHHELD,
		]);
	});
});

describe("token answers", () => {
	it("keep a JWT's header fields and claim names, never a value", () => {
		const header = part({ alg: "RS256", kid: "key-1", typ: "JWT" });
		const claims = part({ sub: "subject-not-recorded", email: "x@y.test", aud: ["a", "b"] });
		const jwt = [header, claims, "c2lnbmF0dXJl"].join(".");
		const format = tokenFormat(jwt);
		expect(format).toEqual({
			format: "jwt",
			length: jwt.length,
			alg: "RS256",
			typ: "JWT",
			kid: true,
			claims: ["aud", "email", "sub"],
			audType: "array",
		});
		expect(JSON.stringify(format)).not.toMatch(/subject-not-recorded|x@y/);
		expect(tokenFormat("opaque-token-value")).toEqual({ format: "opaque", length: 18 });
	});

	it("give an ID token yes/no facts about its issuer, audience and authorized party, never a value", () => {
		const issuer = "https://auth.example.test";
		const clientId = "oaiapp_client_not_recorded";
		const header = part({ alg: "RS256", kid: "key-1", typ: "JWT" });
		const jwt = (claims: object): string => [header, part(claims), "c2lnbmF0dXJl"].join(".");
		const check = { issuer, clientId };
		const facts = (claims: object): unknown => tokenFormat(jwt(claims), check)?.facts;
		expect(facts({ iss: issuer, aud: clientId })).toEqual({
			audHasClientId: true,
			audHasDynamicAgentClient: false,
			audHasResource: false,
			azpIsClientId: false,
			issIsIssuer: true,
		});
		const other = {
			iss: "https://elsewhere.example.test",
			aud: ["dynamic_agent_client", "https://api.openai.com/v1"],
			azp: clientId,
		};
		expect(facts(other)).toEqual({
			audHasClientId: false,
			audHasDynamicAgentClient: true,
			audHasResource: true,
			azpIsClientId: true,
			issIsIssuer: false,
		});
		expect(facts({ sub: "x" })).toEqual({
			audHasClientId: false,
			audHasDynamicAgentClient: false,
			audHasResource: false,
			azpIsClientId: false,
			issIsIssuer: false,
		});
		expect(tokenFormat("opaque-token-value", check)).toEqual({ format: "opaque", length: 18 });

		const body = {
			access_token: jwt({ iss: issuer, aud: clientId }),
			id_token: jwt({ iss: issuer, aud: [clientId, "https://api.openai.com/v1"], azp: clientId }),
		};
		const shape = tokenShape(body, Date.now(), check);
		expect(shape.idToken).toMatchObject({
			facts: {
				audHasClientId: true,
				audHasDynamicAgentClient: false,
				audHasResource: true,
				azpIsClientId: true,
				issIsIssuer: true,
			},
		});
		expect(shape.accessToken).not.toHaveProperty("facts");
		expect(tokenShape(body).idToken).not.toHaveProperty("facts");
		expect(JSON.stringify(shape)).not.toMatch(/client_not_recorded|example\.test|api\.openai/);
	});

	it("record fields, types, scopes and when earliest_refresh_at points, in each format", () => {
		const now = Date.UTC(2026, 9, 18);
		const shape = tokenShape(
			{
				access_token: "opaque-access",
				refresh_token: "opaque-refresh",
				token_type: "Bearer",
				expires_in: 3600,
				scope: "openid email chatgpt.tokens.use.direct",
				earliest_refresh_at: now / 1000 + 600,
			},
			now,
		);
		expect(shape).toEqual({
			fields: [
				"access_token",
				"earliest_refresh_at",
				"expires_in",
				"refresh_token",
				"scope",
				"token_type",
			],
			types: {
				access_token: "string",
				earliest_refresh_at: "number",
				expires_in: "number",
				refresh_token: "string",
				scope: "string",
				token_type: "string",
			},
			tokenType: "Bearer",
			expiresIn: 3600,
			scopes: ["chatgpt.tokens.use.direct", "email", "openid"],
			earliestRefreshAt: { type: "number", unit: "s", inS: 600 },
			accessToken: { format: "opaque", length: 13 },
			refreshToken: { format: "opaque", length: 14 },
		});
		const iso = new Date(now + 60_000).toISOString();
		expect(tokenShape({ earliest_refresh_at: iso }, now).earliestRefreshAt).toEqual({
			type: "string",
			inS: 60,
		});
		expect(tokenShape({ earliest_refresh_at: now + 5_000 }, now).earliestRefreshAt).toEqual({
			type: "number",
			unit: "ms",
			inS: 5,
		});
		const refused = {
			error: { code: "invalid_grant", message: "words" },
			error_description: "more",
		};
		expect(tokenShape(refused)).toMatchObject({
			error: { code: "invalid_grant", fields: ["code", "message"] },
			description: true,
		});
		expect(tokenShape("not an object")).toEqual({ json: false });
	});
});

it("discovery: each endpoint's host, path and whether it shares the issuer's origin", () => {
	const issuer = "https://auth.example.test";
	const doc = {
		issuer,
		authorization_endpoint: `${issuer}/api/accounts/authorize`,
		token_endpoint: `${issuer}/api/accounts/oauth/token`,
		revocation_endpoint: "https://revoke.example.test/oauth/revoke?client=1",
		jwks_uri: `${issuer}/.well-known/jwks.json`,
		id_token_signing_alg_values_supported: ["RS256", "ES256"],
	};
	expect(discoveryShape(doc, issuer)).toEqual({
		issuerMatches: true,
		endpoints: {
			authorization_endpoint: {
				host: "auth.example.test",
				path: "/api/accounts/authorize",
				sameOrigin: true,
				query: false,
			},
			token_endpoint: {
				host: "auth.example.test",
				path: "/api/accounts/oauth/token",
				sameOrigin: true,
				query: false,
			},
			revocation_endpoint: {
				host: "revoke.example.test",
				path: "/oauth/revoke",
				sameOrigin: false,
				query: true,
			},
			jwks_uri: {
				host: "auth.example.test",
				path: "/.well-known/jwks.json",
				sameOrigin: true,
				query: false,
			},
		},
		fields: [
			"authorization_endpoint",
			"id_token_signing_alg_values_supported",
			"issuer",
			"jwks_uri",
			"revocation_endpoint",
			"token_endpoint",
		],
		id_token_signing_alg_values_supported: ["ES256", "RS256"],
	});
	expect(discoveryShape({ issuer: "https://other.test" }, issuer)).toMatchObject({
		issuerMatches: false,
	});
});

it("upstream calls: chunk sizes as they arrive, whole numbers as numbers, an error body's shape", async () => {
	const pieces = ["event: one\ndata: {}\n\n", "event: two\ndata: {}\n\n"];
	served = await serve((request) => {
		if (new URL(request.url).pathname === "/v1/models") {
			const body = {
				error: { code: "rate_limit_exceeded", message: "words", type: "requests", param: null },
			};
			const headers = { "retry-after": "20", "x-ratelimit-limit-tokens": "150000000" };
			return json(429, body, headers);
		}
		const encoder = new TextEncoder();
		const stream = new ReadableStream<Uint8Array>({
			async pull(controller) {
				const next = pieces.shift();
				if (next === undefined) return controller.close();
				await new Promise((resolve) => setTimeout(resolve, 20));
				controller.enqueue(encoder.encode(next));
			},
		});
		const headers = { "content-type": "text/event-stream", "x-request-id": "req_raw_1" };
		return new Response(stream, { headers });
	});
	const recorder = upstreamRecorder();
	const streamed = await recorder.fetch(`${served.url}/v1/responses`, {
		method: "POST",
		body: "{}",
	});
	const text = await streamed.text();
	const refused = await recorder.fetch(`${served.url}/v1/models`);
	await refused.body?.cancel();
	const [first, second] = recorder.calls;
	expect(first).toMatchObject({
		method: "POST",
		path: "/v1/responses",
		status: 200,
		requestId: "req_raw_1",
		values: { "content-type": "text/event-stream" },
	});
	expect(first?.sizes?.reduce((sum, size) => sum + size, 0)).toBe(Buffer.byteLength(text));
	expect(first?.firstChunkMs).toEqual(expect.any(Number));
	expect(second).toMatchObject({
		path: "/v1/models",
		status: 429,
		values: { "retry-after": 20, "x-ratelimit-limit-tokens": 150_000_000 },
		errorBody: {
			fields: ["error"],
			error: {
				fields: ["code", "message", "param", "type"],
				code: "rate_limit_exceeded",
				type: "requests",
				param: null,
			},
		},
	});
	expect(JSON.stringify(recorder.calls)).not.toContain("words");
});

it("stream events: counts, delta sizes, an error event's fields and usage, never text", () => {
	const stats = eventStats();
	stats.add(event({ type: "response.output_text.delta", delta: "Hello" }));
	stats.add(
		event({ type: "error", code: "x", message: "private words", param: null, sequence_number: 2 }),
	);
	const output = [{ type: "message", content: [{ type: "output_text", text: "Hello" }] }];
	const usage = {
		input_tokens: 5,
		output_tokens: 2,
		total_tokens: 7,
		input_tokens_details: { cached_tokens: 0 },
		output_tokens_details: { reasoning_tokens: 1 },
	};
	const response = { model: "gpt-x", status: "completed", output, usage };
	stats.add(event({ type: "response.completed", response }));
	const summary = stats.summary();
	expect(summary).toMatchObject({
		counts: { "response.output_text.delta": 1, error: 1, "response.completed": 1 },
		deltas: 1,
		deltaChars: 5,
		model: "gpt-x",
		failure: { event: "error", fields: ["code", "message", "param", "sequence_number", "type"] },
		completed: {
			status: "completed",
			outputTypes: ["message"],
			functionCalls: [],
			repeatsOutput: true,
			outputChars: 5,
			usage: {
				inputTokens: 5,
				outputTokens: 2,
				totalTokens: 7,
				cachedTokens: 0,
				reasoningTokens: 1,
			},
		},
	});
	expect(JSON.stringify(summary)).not.toMatch(/Hello|private words/);
});

it("function calls: each one's name, namespace and field names, never its arguments", () => {
	const stats = eventStats();
	const call = (extra: Record<string, unknown>) => ({
		id: "fc_not_recorded",
		type: "function_call",
		status: "completed",
		call_id: "call_not_recorded",
		arguments: '{"body":"private words"}',
		...extra,
	});
	const output = [
		call({ name: "submit_draft", namespace: "draftyak" }),
		call({ name: "draftyak.submit_draft" }),
		call({ name: "submit_draft", namespace: null }),
		call({ name: "two words", namespace: 7 }),
		{ type: "message", content: [{ type: "output_text", text: "private words" }] },
	];
	stats.add(event({ type: "response.completed", response: { status: "completed", output } }));
	const completed = stats.summary().completed;
	const fields = ["arguments", "call_id", "id", "name", "status", "type"];
	const withNamespace = ["arguments", "call_id", "id", "name", "namespace", "status", "type"];
	expect(completed?.functionCalls).toEqual([
		{ name: "submit_draft", namespace: "draftyak", fields: withNamespace },
		{ name: "draftyak.submit_draft", namespace: "absent", fields },
		{ name: "submit_draft", namespace: null, fields: withNamespace },
		{ name: WITHHELD, namespace: WITHHELD, fields: withNamespace },
	]);
	expect(completed?.outputTypes).toEqual([...Array(4).fill("function_call"), "message"]);
	expect(JSON.stringify(completed)).not.toMatch(/private words|not_recorded/);
});

it("the final check replaces content-shaped strings and keys, and counts them", () => {
	const count = { withheld: 0 };
	const uuid = glue("3f2c8a1e-9b4d", "-4e6f-8a7b-", "1c2d3e4f5a6b");
	const email = glue("someone", "@", "example", ".com");
	const value = { ok: "invalid_grant", list: [uuid, 3], [email]: true, nested: { n: Number.NaN } };
	expect(scrub(value, count)).toEqual({
		ok: "invalid_grant",
		list: [WITHHELD, 3],
		[WITHHELD]: true,
		nested: { n: null },
	});
	expect(count.withheld).toBe(3);
});

it("draft verdicts: unsupported only when the refusal names the structure's own fields", () => {
	const error = (code: string, status: number, param?: string) => ({
		outcome: "error" as const,
		error: {
			code,
			plugin: "UNSUPPORTED",
			recovery: "never",
			status,
			...(param !== undefined && { param }),
		},
	});
	const verdict = (
		structure: Structure,
		record: Omit<Parameters<typeof draftVerdict>[0], "structure">,
	) => draftVerdict({ structure, ...record });
	expect([
		verdict("text-format", { outcome: "draft" }),
		verdict("text-format", error("UNSUPPORTED_CAPABILITY", 400, "text.format")),
		verdict("tool-namespace", error("UNSUPPORTED_CAPABILITY", 400, "tools[0]")),
		verdict("tool-item", error("UNSUPPORTED_CAPABILITY", 400, "input[0].tools[0]")),
		verdict("tool-top-level", error("API_ERROR", 400, "tool_choice")),
		verdict("text-format", error("UNSUPPORTED_CAPABILITY", 400, "model")),
		verdict("tool-item", error("UNSUPPORTED_CAPABILITY", 400, "input[1].content")),
		verdict("text-format", error("UNSUPPORTED_CAPABILITY", 400, "tools[0]")),
		verdict("tool-namespace", error("UNSUPPORTED_CAPABILITY", 400)),
		verdict("tool-namespace", error("ROUTE_NOT_SUPPORTED", 403)),
		verdict("text-format", error("API_ERROR", 400, "model")),
		verdict("text-format", error("API_ERROR", 400)),
		verdict("text-format", error("USAGE_LIMIT", 429)),
		verdict("text-format", { outcome: "aborted" }),
		verdict("text-format", { outcome: "incomplete", reason: "max_output_tokens" }),
		verdict("text-format", { outcome: "refusal" }),
		verdict("text-format", { outcome: "invalid" }),
	]).toEqual([
		"ok",
		"unsupported",
		"unsupported",
		"unsupported",
		"unsupported",
		"fails(UNSUPPORTED_CAPABILITY:model)",
		"fails(UNSUPPORTED_CAPABILITY:input[1].content)",
		"fails(UNSUPPORTED_CAPABILITY:tools[0])",
		"fails(UNSUPPORTED_CAPABILITY)",
		"fails(ROUTE_NOT_SUPPORTED)",
		"fails(API_ERROR:model)",
		"fails(API_ERROR)",
		"fails(USAGE_LIMIT)",
		"fails(timeout)",
		"fails(incomplete:max_output_tokens)",
		"fails(refusal)",
		"fails(invalid)",
	]);
});

it("a revocation counts only after a 200 and a refusal naming the refresh token invalid", () => {
	const refused = (code: string, apiCode?: string) => ({
		accepted: false,
		code,
		...(apiCode !== undefined && { apiCode }),
	});
	expect([
		revocationVerdict(true, refused("REAUTH_REQUIRED", "invalid_grant")),
		revocationVerdict(true, refused("REAUTH_REQUIRED", "invalid_refresh_token")),
		revocationVerdict(true, refused("REAUTH_REQUIRED", "refresh_token_invalidated")),
		revocationVerdict(false, refused("REAUTH_REQUIRED", "invalid_grant")),
		revocationVerdict(true, { accepted: true, revokedAgain: true }),
		revocationVerdict(true, refused("REAUTH_REQUIRED", "refresh_token_reused")),
		revocationVerdict(true, refused("REAUTH_REQUIRED", "refresh_token_expired")),
		revocationVerdict(true, refused("UNAVAILABLE")),
		revocationVerdict(true, refused("SIGN_IN_FAILED")),
		revocationVerdict(true, refused("INVALID_CLIENT", "invalid_client")),
		revocationVerdict(true, refused("ERROR")),
		revocationVerdict(true, null),
		revocationVerdict(true, refused("REAUTH_REQUIRED", "two words")),
	]).toEqual([
		"yes",
		"yes",
		"yes",
		"no(revocation unconfirmed)",
		"no(the revoked refresh token still works)",
		"no(revocation unconfirmed: probe REAUTH_REQUIRED:refresh_token_reused)",
		"no(revocation unconfirmed: probe REAUTH_REQUIRED:refresh_token_expired)",
		"no(revocation unconfirmed: probe UNAVAILABLE)",
		"no(revocation unconfirmed: probe SIGN_IN_FAILED)",
		"no(revocation unconfirmed: probe INVALID_CLIENT:invalid_client)",
		"no(revocation unconfirmed: probe ERROR)",
		"no(revocation unconfirmed: not tried again)",
		`no(revocation unconfirmed: probe REAUTH_REQUIRED:${WITHHELD})`,
	]);
});

it("the hub's wait after expiry ends on the clock: a minute per timer at most, and at once after a jump", async () => {
	const due = 63 * 60_000 + 500;
	let clock = 0;
	let sleeps: number[] = [];
	const now = (): number => clock;
	// Each timer moves the clock on by `passed` of its milliseconds.
	const timer = (passed: (ms: number) => number) => async (ms: number) => {
		sleeps.push(ms);
		clock += passed(ms);
	};
	const onTime = timer((ms) => ms);
	await waitUntil(due, now, onTime);
	expect([clock, sleeps]).toEqual([due, [...Array(63).fill(60_000), 500]]);
	// The PC slept for two hours during the first timer.
	const asleep = timer(() => 2 * 3600_000);
	[clock, sleeps] = [0, []];
	await waitUntil(due, now, asleep);
	expect(sleeps).toEqual([60_000]);
	// Already due: no timer.
	[clock, sleeps] = [due, []];
	await waitUntil(due, now, onTime);
	expect(sleeps).toEqual([]);
});

it("the withheld count takes in what the recorders already withheld, keys included", () => {
	expect(withheldIn({ a: WITHHELD, [WITHHELD]: [1, WITHHELD, { b: "ok" }], c: null })).toBe(3);
	expect(withheldIn({ a: "ok", list: [] })).toBe(0);
});

it("JWKS: key types, algorithms and uses, a field a key leaves out read as absent", () => {
	const keys = [
		{ kty: "RSA", kid: "k1", n: "x", e: "AQAB" },
		{ kty: "EC", kid: "k2", alg: "ES256", use: "sig" },
		{ kty: "RSA", alg: 7 },
	];
	expect(jwksShape({ keys })).toEqual({
		keys: 3,
		kty: ["EC", "RSA"],
		alg: [WITHHELD, "ES256", "absent"],
		use: ["absent", "sig"],
	});
	expect(jwksShape({ other: [] })).toEqual({ json: true });
});
