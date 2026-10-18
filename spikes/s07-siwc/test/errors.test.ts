import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import type { Credential } from "../src/auth.ts";
import { classifyError, type SiwcCode, SiwcError, STRUCTURED } from "../src/errors.ts";
import { runDraft } from "../src/responses.ts";
import type { FakeAuthOptions } from "./fake-auth.ts";
import { admission, errorEvents, failedEvents, type Reply, structured } from "./fake-responses.ts";
import { failure, type Harness, job, MODEL, rescript, signedIn } from "./harness.ts";

// One sign-in for the cases that leave the session as it was.
let shared: Harness;
beforeAll(async () => {
	shared = await signedIn();
});
afterAll(async () => {
	await shared.close();
});

let open: Harness | undefined;
afterEach(async () => {
	await open?.close();
	open = undefined;
});

async function draftWith(reply: Reply): Promise<{ error: SiwcError; harness: Harness }> {
	rescript(shared, () => reply);
	const error = await failure(runDraft(shared.client, job("tool-namespace")));
	expect(error).toBeInstanceOf(SiwcError);
	return { error: error as SiwcError, harness: shared };
}

// Errors and recovery, Structured Responses errors (read 2026-10-18): code, status, what to do.
const DOCUMENTED: [string, number, SiwcCode, string, string][] = [
	["subscription_sharing_user_not_eligible", 403, "NOT_ELIGIBLE", "PERMISSION_DENIED", "never"],
	["subscription_sharing_usage_limit_exceeded", 429, "USAGE_LIMIT", "QUOTA_EXCEEDED", "never"],
	["subscription_sharing_usage_unavailable", 503, "UNAVAILABLE", "TRANSIENT", "backoff"],
	[
		"subscription_sharing_unsupported_capability",
		400,
		"UNSUPPORTED_CAPABILITY",
		"UNSUPPORTED",
		"never",
	],
	["subscription_sharing_route_not_supported", 403, "ROUTE_NOT_SUPPORTED", "UNSUPPORTED", "never"],
	["subscription_sharing_invalid_user", 401, "INVALID_USER", "AUTH_REVOKED", "reauth"],
	["chatpass_v2_scope_not_authorized", 403, "SCOPE_NOT_AUTHORIZED", "PERMISSION_DENIED", "never"],
	[
		"chatpass_v2_invalid_authorization_context",
		403,
		"SCOPE_NOT_AUTHORIZED",
		"PERMISSION_DENIED",
		"never",
	],
	["subscription_sharing_user_unavailable", 503, "UNAVAILABLE", "TRANSIENT", "backoff"],
];

describe("documented errors map to codes", () => {
	it("covers the plan's seven kinds, each with its own code, and every documented code", () => {
		const kinds: SiwcCode[] = [
			"USAGE_LIMIT",
			"UNAVAILABLE",
			"NOT_ELIGIBLE",
			"UNSUPPORTED_CAPABILITY",
			"ROUTE_NOT_SUPPORTED",
			"INVALID_USER",
			"SCOPE_NOT_AUTHORIZED",
		];
		expect(new Set(DOCUMENTED.map(([, , code]) => code))).toEqual(new Set(kinds));
		expect([...STRUCTURED.keys()].sort()).toEqual(DOCUMENTED.map(([code]) => code).sort());
	});

	it.each(DOCUMENTED)(
		"%s (HTTP %i) before the stream: %s",
		async (apiCode, status, code, plugin, recovery) => {
			const { error, harness } = await draftWith(structured(status, apiCode, "tools[0]"));
			expect([error.code, error.plugin, error.recovery]).toEqual([code, plugin, recovery]);
			expect(error.facts).toMatchObject({
				status,
				apiCode,
				param: "tools[0]",
				shape: "error-object",
			});
			expect(error.facts.requestId).toMatch(/^req_[0-9a-f]{24}$/);
			// No retry: a limit pauses, and the owner chooses what happens next (plan §5).
			expect(harness.api.received).toHaveLength(1);
			expect(error.message).not.toMatch(/fake/);
		},
	);

	it.each([
		[401, "ADMISSION_REFUSED", "AUTH_EXPIRED", "reauth"],
		[403, "ADMISSION_REFUSED", "PERMISSION_DENIED", "never"],
		[503, "UNAVAILABLE", "TRANSIENT", "backoff"],
	] as const)("direct admission %i with {detail}: %s", async (status, code, plugin, recovery) => {
		const { error, harness } = await draftWith(admission(status));
		expect([error.code, error.plugin, error.recovery]).toEqual([code, plugin, recovery]);
		expect(error.facts).toMatchObject({ status, shape: "detail" });
		expect(error.facts.apiCode).toBeUndefined();
		expect(error.message).not.toMatch(/admission refusal/);
		expect(harness.api.received).toHaveLength(1);
	});

	// Errors and recovery: keep the status, body shape, code and request ID, also inside a stream.
	it.each([
		["subscription_sharing_usage_limit_exceeded", "USAGE_LIMIT"],
		["subscription_sharing_usage_unavailable", "UNAVAILABLE"],
		["server_error", "STREAM_FAILED"],
	] as const)("response.failed with %s after streaming began: %s", async (apiCode, code) => {
		const { error } = await draftWith({ kind: "events", events: failedEvents(MODEL, apiCode) });
		expect([error.code, error.facts.apiCode, error.facts.shape]).toEqual([code, apiCode, "event"]);
		expect(error.facts.status).toBe(200);
		expect(error.facts.requestId).toMatch(/^req_[0-9a-f]{24}$/);
	});

	it("an SSE error event maps by its code and keeps its param, status and request ID", async () => {
		const reply: Reply = {
			kind: "events",
			events: errorEvents(MODEL, "subscription_sharing_unsupported_capability", "reasoning"),
		};
		const { error } = await draftWith(reply);
		expect([error.code, error.facts.param, error.facts.shape, error.facts.status]).toEqual([
			"UNSUPPORTED_CAPABILITY",
			"reasoning",
			"event",
			200,
		]);
		expect(error.facts.requestId).toMatch(/^req_[0-9a-f]{24}$/);
	});

	it("an error event the SDK hands over (data lines only) maps the same, keeping no free text", async () => {
		const events = errorEvents(MODEL, "subscription_sharing_usage_limit_exceeded", "a free text");
		const { error } = await draftWith({ kind: "events", events, dataOnly: true });
		expect([error.code, error.facts.shape, error.facts.status]).toEqual([
			"USAGE_LIMIT",
			"event",
			200,
		]);
		expect(error.facts.requestId).toMatch(/^req_[0-9a-f]{24}$/);
		expect(error.facts.param).toBeUndefined();
	});

	it("an undocumented code falls back to its status", async () => {
		const { error } = await draftWith(structured(429, "rate_limit_exceeded"));
		expect([error.code, error.plugin, error.recovery, error.facts.apiCode]).toEqual([
			"API_ERROR",
			"RATE_LIMITED",
			"backoff",
			"rate_limit_exceeded",
		]);
	});

	it("a revoked or expired access token gets the admission 401 and asks to sign in again", async () => {
		open = await signedIn();
		await open.session.revoke();
		const current = await open.store.read();
		const credential = open.credential;
		expect(current?.tokens).toBeNull();
		await open.store.write(credential);
		const error = (await failure(runDraft(open.client, job("text-format")))) as SiwcError;
		expect([error.code, error.recovery, error.facts.status]).toEqual([
			"ADMISSION_REFUSED",
			"reauth",
			401,
		]);
	});

	it("keeps only identifier-shaped codes and params, never free text", () => {
		const error = classifyError({
			status: 400,
			error: { code: "not a code: <script>", param: "input[0] secret text", message: "Dear Sam" },
			headers: new Headers({ "x-request-id": "req_123" }),
		});
		expect(error.facts).toEqual({ status: 400, requestId: "req_123", shape: "error-object" });
		expect(error.message).not.toMatch(/Sam|script|secret/);
		expect(classifyError(new TypeError("terminated")).code).toBe("STREAM_INTERRUPTED");
	});
});

// The stored credential with its access token expired, and anything else changed.
async function expire(h: Harness, change: Partial<Credential> = {}): Promise<void> {
	const current = (await h.store.read()) as Credential;
	const tokens = current.tokens && { ...current.tokens, expiresAt: Date.now() - 1 };
	await h.store.write({ ...current, ...change, tokens });
}

// Errors and recovery: Refresh errors and ChatGPT plan use isn't enabled, as runDraft sees them.
describe("credential failures reach the drafting caller, and nothing leaves", () => {
	const cases: [string, Partial<FakeAuthOptions>, (h: Harness) => Promise<void>, string[]][] = [
		[
			"signed out",
			{},
			(h) => h.store.write({ ...h.credential, tokens: null }),
			["REAUTH_REQUIRED", "AUTH_REVOKED", "reauth"],
		],
		[
			"a reused refresh token",
			{},
			async (h) => {
				await h.session.refresh();
				await h.store.write(h.credential);
				await expire(h);
			},
			["REAUTH_REQUIRED", "AUTH_REVOKED", "reauth"],
		],
		[
			"invalid_client on refresh",
			{},
			(h) => expire(h, { clientId: "oaiapp_unknown" }),
			["INVALID_CLIENT", "AUTH_REVOKED", "never"],
		],
		[
			"plan usage off",
			{ consent: "no-plan" },
			async () => {},
			["PLAN_USAGE_DISABLED", "PERMISSION_DENIED", "never"],
		],
		[
			"the token endpoint down at refresh",
			{},
			async (h) => {
				await expire(h);
				await h.auth.close();
			},
			["UNAVAILABLE", "TRANSIENT", "backoff"],
		],
	];

	it.each(cases)("%s", async (_name, auth, prepare, [code, plugin, recovery]) => {
		open = await signedIn({ auth });
		await prepare(open);
		const error = (await failure(runDraft(open.client, job("text-format")))) as SiwcError;
		expect([error.code, error.plugin, error.recovery]).toEqual([code, plugin, recovery]);
		expect(open.api.received).toEqual([]);
		expect(open.broker.requests.map(({ verdict, credential }) => [verdict, credential])).toEqual([
			[{ ok: true }, code],
		]);
	});

	it("keeps the stored tokens when the refresh failure is temporary", async () => {
		open = await signedIn();
		await expire(open);
		const before = await open.store.read();
		await open.auth.close();
		await failure(runDraft(open.client, job("text-format")));
		expect(await open.store.read()).toEqual(before);
	});
});
