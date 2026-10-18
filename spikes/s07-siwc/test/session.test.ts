import { afterEach, describe, expect, it } from "vitest";
import {
	type Credential,
	discover,
	newHostId,
	planUsage,
	REGISTRATION_CLIENT,
	RESOURCE,
	type Registration,
	signIn,
} from "../src/auth.ts";
import type { SiwcError } from "../src/errors.ts";
import {
	acceptTransfer,
	type CredentialStore,
	EARLY_MS,
	refreshDue,
	Session,
	transferText,
} from "../src/session.ts";
import { type FakeAuth, type FakeAuthOptions, startFakeAuth } from "./fake-auth.ts";
import { failure, memoryStore } from "./harness.ts";

const opened: FakeAuth[] = [];
afterEach(async () => {
	for (const auth of opened.splice(0)) await auth.close();
});

interface Setup {
	readonly auth: FakeAuth;
	readonly credential: Credential;
	readonly store: CredentialStore;
	readonly session: Session;
}

async function setup(options: Partial<FakeAuthOptions> = {}, hostId = newHostId()): Promise<Setup> {
	const auth = await startFakeAuth(options);
	opened.push(auth);
	const endpoints = await discover(auth.url);
	const credential = await signIn({
		hostId,
		endpoints,
		port: 0,
		openBrowser: auth.browse,
	});
	const store = memoryStore(credential);
	return {
		auth,
		credential,
		store,
		session: new Session(store, endpoints, { sleep: async () => {} }),
	};
}

// The stored credential with its access token already expired.
async function expire(store: CredentialStore): Promise<Credential> {
	const current = (await store.read()) as Credential;
	const tokens = current.tokens;
	if (!tokens) throw new Error("signed out");
	const stale = { ...current, tokens: { ...tokens, expiresAt: Date.now() - 1_000 } };
	await store.write(stale);
	return stale;
}

const refreshForms = (auth: FakeAuth): URLSearchParams[] =>
	auth.tokenForms.filter((form) => form.get("grant_type") === "refresh_token");

describe("refresh (Accounts and sessions, Refreshing tokens)", () => {
	it("serializes concurrent callers into one rotation, written before anyone uses it", async () => {
		const { auth, store, session } = await setup({ refreshDelayMs: 50 });
		const stale = await expire(store);
		const tokens = await Promise.all(Array.from({ length: 10 }, () => session.accessToken()));
		const stored = (await store.read()) as Credential;
		expect(refreshForms(auth)).toHaveLength(1);
		expect(new Set(tokens)).toEqual(new Set([stored.tokens?.accessToken]));
		expect(stored.tokens?.accessToken).not.toBe(stale.tokens?.accessToken);
		expect(stored.tokens?.refreshToken).not.toBe(stale.tokens?.refreshToken);
		expect(auth.refresh.get(stale.tokens?.refreshToken ?? "")?.used).toBe(true);
		expect(auth.problems).toEqual([]);
	});

	it("sends the issued client, the saved refresh token and the resource, and no scope", async () => {
		const { auth, credential, session } = await setup();
		await session.refresh();
		const [form] = refreshForms(auth);
		expect([...(form?.entries() ?? [])]).toEqual([
			["grant_type", "refresh_token"],
			["client_id", credential.clientId],
			["refresh_token", credential.tokens?.refreshToken],
			["resource", RESOURCE],
		]);
		expect(form?.get("client_id")).not.toBe(REGISTRATION_CLIENT);
	});

	it("doesn't refresh a token that isn't due, or before earliest_refresh_at while it is valid", () => {
		const now = 1_000_000_000;
		const tokens = { accessToken: "a", refreshToken: "r", scopes: [], savedAt: now };
		expect(refreshDue({ ...tokens, expiresAt: now + EARLY_MS + 1 }, now)).toBe(false);
		expect(refreshDue({ ...tokens, expiresAt: now + EARLY_MS - 1 }, now)).toBe(true);
		const waiting = { ...tokens, expiresAt: now + 1_000, earliestRefreshAt: now + 500 };
		expect(refreshDue(waiting, now)).toBe(false);
		expect(refreshDue(waiting, now + 500)).toBe(true);
		expect(refreshDue({ ...waiting, earliestRefreshAt: now + 5_000 }, now + 1_000)).toBe(true);
	});

	it("reads earliest_refresh_at as Unix seconds or a date", async () => {
		const seconds = await setup({ earliestRefreshAt: 1_900_000_000 });
		expect(seconds.credential.tokens?.earliestRefreshAt).toBe(1_900_000_000_000);
		const date = await setup({ earliestRefreshAt: "2030-03-17T17:46:40Z" });
		expect(date.credential.tokens?.earliestRefreshAt).toBe(Date.parse("2030-03-17T17:46:40Z"));
		const odd = await setup({ earliestRefreshAt: { at: 1 } });
		expect(odd.credential.tokens?.earliestRefreshAt).toBeUndefined();
	});

	it("skips a forced refresh when another caller already replaced the token", async () => {
		const { auth, credential, session } = await setup();
		const seen = credential.tokens?.accessToken;
		await Promise.all([session.refresh(seen), session.refresh(seen)]);
		expect(refreshForms(auth)).toHaveLength(1);
	});

	it.each(["string", "object"] as const)(
		"clears a reused refresh token and asks to sign in again (error as %s)",
		async (errorShape) => {
			const { auth, store, session } = await setup({ errorShape });
			const old = (await store.read()) as Credential;
			await session.refresh();
			await store.write(old);
			const error = (await failure(session.refresh())) as SiwcError;
			expect([error.code, error.facts.apiCode, error.recovery]).toEqual([
				"REAUTH_REQUIRED",
				"refresh_token_reused",
				"reauth",
			]);
			const after = (await store.read()) as Credential;
			expect(after.tokens).toBeNull();
			expect([after.clientId, after.hostId, after.subject]).toEqual([
				old.clientId,
				old.hostId,
				old.subject,
			]);
			expect(((await failure(session.accessToken())) as SiwcError).code).toBe("REAUTH_REQUIRED");
			expect(auth.problems.at(-1)).toBe("token: refresh_token reused");
		},
	);

	it.each([
		["a 503", async () => new Response(null, { status: 503 }), { status: 503 }],
		["a 429", async () => new Response(null, { status: 429 }), { status: 429 }],
		[
			"no answer",
			async () => {
				throw new TypeError("fetch failed");
			},
			{ detail: "token endpoint unreachable" },
		],
	])("keeps the tokens and backs off when a refresh gets %s", async (_name, answer, facts) => {
		const { auth, credential, store } = await setup();
		const session = new Session(store, await discover(auth.url), {
			fetch: answer as unknown as typeof fetch,
		});
		const error = (await failure(session.refresh())) as SiwcError;
		expect([error.code, error.plugin, error.recovery]).toEqual([
			"UNAVAILABLE",
			"TRANSIENT",
			"backoff",
		]);
		expect(error.facts).toMatchObject(facts);
		expect((await store.read())?.tokens).toEqual(credential.tokens);
	});

	it("replaces the scopes on refresh, so a narrowed grant turns plan usage off", async () => {
		const narrowed = "openid profile email offline_access resource.invoke";
		const { store, session } = await setup({
			tokenResponse: (body, grant) =>
				grant === "refresh_token" ? { ...body, scope: narrowed } : body,
		});
		const after = await session.refresh();
		expect([after.tokens?.scopes, planUsage(after)]).toEqual([narrowed.split(" "), "disabled"]);
		expect((await store.read())?.tokens?.scopes).toEqual(narrowed.split(" "));
		const error = (await failure(session.accessToken())) as SiwcError;
		expect([error.code, error.plugin, error.recovery]).toEqual([
			"PLAN_USAGE_DISABLED",
			"PERMISSION_DENIED",
			"never",
		]);
	});

	it("keeps the granted scopes when a refresh response leaves scope out", async () => {
		const { credential, session } = await setup({
			tokenResponse: (body, grant) => {
				const { scope: _scope, ...rest } = body;
				return grant === "refresh_token" ? rest : body;
			},
		});
		const after = await session.refresh();
		expect(after.tokens?.scopes).toEqual(credential.tokens?.scopes);
		expect(planUsage(after)).toBe("enabled");
	});

	it("hands out no access token while plan usage is off", async () => {
		const { auth, session } = await setup({ consent: "no-plan" });
		expect(((await failure(session.accessToken())) as SiwcError).code).toBe("PLAN_USAGE_DISABLED");
		expect(refreshForms(auth)).toEqual([]);
	});

	it("maps invalid_client to INVALID_CLIENT", async () => {
		const { store, session } = await setup();
		const current = (await store.read()) as Credential;
		await store.write({ ...current, clientId: "oaiapp_unknown" });
		expect(((await failure(session.refresh())) as SiwcError).code).toBe("INVALID_CLIENT");
	});

	it("never hands out a rotated token whose write failed", async () => {
		const { auth, credential } = await setup();
		const endpoints = await discover(auth.url);
		const failing: CredentialStore = {
			read: async () => ({
				...credential,
				tokens: credential.tokens && { ...credential.tokens, expiresAt: Date.now() - 1_000 },
			}),
			write: async () => {
				throw new Error("disk full");
			},
		};
		const session = new Session(failing, endpoints);
		expect(String(await failure(session.accessToken()))).toMatch(/disk full/);
	});
});

describe("revocation on sign-out (Accounts and sessions, End the renewable session)", () => {
	it("revokes the refresh token with its hint and client, then drops tokens and the hint", async () => {
		const { auth, credential, store, session } = await setup();
		expect(await session.revoke()).toBe(true);
		expect([...(auth.revocations[0]?.entries() ?? [])]).toEqual([
			["token", credential.tokens?.refreshToken],
			["token_type_hint", "refresh_token"],
			["client_id", credential.clientId],
		]);
		const after = (await store.read()) as Credential;
		expect(after.tokens).toBeNull();
		expect(after.idTokenHint).toBeUndefined();
		expect([after.clientId, after.hostId]).toEqual([credential.clientId, credential.hostId]);
		expect(((await failure(session.refresh())) as SiwcError).code).toBe("REAUTH_REQUIRED");
		expect(auth.refresh.get(credential.tokens?.refreshToken ?? "")?.family.revoked).toBe(true);
	});

	it("retries a 5xx with backoff, and says when revocation wasn't confirmed", async () => {
		const retried = await setup({ revocationStatuses: [503, 502] });
		expect(await retried.session.revoke()).toBe(true);
		expect(retried.auth.revocations).toHaveLength(3);
		const refused = await setup({ revocationStatuses: [503, 503, 503] });
		expect(await refused.session.revoke()).toBe(false);
		expect((await refused.store.read())?.tokens).toBeNull();
		const client = await setup({ revocationStatuses: [400] });
		expect(await client.session.revoke()).toBe(false);
		expect(client.auth.revocations).toHaveLength(1);
	});
});

describe("the documented transfer to a headless hub (plan §4 step 2; Self-hosted VMs)", () => {
	it("gives the hub what the desktop signed in with the hub's host ID; the desktop forgets it", async () => {
		const hubHostId = newHostId();
		const desktop = await setup({}, hubHostId);
		const hubStore = memoryStore();
		const text = transferText((await desktop.store.read()) as Credential);
		await hubStore.write(acceptTransfer(text, { hostId: hubHostId, issuer: desktop.auth.url }));
		await desktop.store.write(null);
		expect(await desktop.store.read()).toBeNull();
		const hub = new Session(hubStore, await discover(desktop.auth.url));
		const before = (await hubStore.read()) as Credential;
		await hub.refresh();
		expect((await hubStore.read())?.tokens?.refreshToken).not.toBe(before.tokens?.refreshToken);
		expect((await hubStore.read())?.hostId).toBe(hubHostId);
		expect(desktop.auth.problems).toEqual([]);
	});

	it("refuses a credential for another host, issuer or registration, and malformed ones", async () => {
		const { auth, credential } = await setup();
		const text = transferText(credential);
		const hub = { hostId: credential.hostId, issuer: auth.url };
		const saved: Registration = { ...credential, clientId: "oaiapp_other" };
		const cases: [string, Parameters<typeof acceptTransfer>[1], string][] = [
			[text, { ...hub, hostId: newHostId() }, "hostId"],
			[text, { ...hub, issuer: "https://issuer.example.test" }, "issuer"],
			[text, { ...hub, saved }, "another registration"],
			[transferText({ ...credential, clientId: REGISTRATION_CLIENT }), hub, "clientId"],
			[JSON.stringify({ v: 2, credential }), hub, "credential"],
			["{", hub, "not JSON"],
		];
		for (const [input, target, detail] of cases) {
			const error = (await failure(
				Promise.resolve().then(() => acceptTransfer(input, target)),
			)) as SiwcError;
			expect([error.code, error.facts.detail]).toEqual(["TRANSFER_REFUSED", detail]);
		}
		expect(acceptTransfer(text, { ...hub, saved: credential })).toEqual(credential);
	});
});
