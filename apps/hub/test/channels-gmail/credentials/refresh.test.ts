import { createHash, randomBytes } from "node:crypto";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	realpathSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { ClientRequest } from "node:http";
import { createServer } from "node:https";
import { createServer as createTcpServer } from "node:net";
import os from "node:os";
import path from "node:path";
import {
	createGoogleOAuthFake,
	GOOGLE_OAUTH_CLIENT_ID,
	GOOGLE_OAUTH_REDIRECT_URI,
} from "@draftyak/fakes";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { AuditChain } from "../../../src/audit/chain.ts";
import {
	GMAIL_CREDENTIAL_MIGRATIONS,
	GmailCredentials,
} from "../../../src/channels/gmail/connection/google-credentials.ts";
import { CredentialRefreshError, CredentialVault } from "../../../src/credentials/vault.ts";
import { EVENT_MIGRATIONS, EventLog } from "../../../src/events/log.ts";
import { WorkDatabase } from "../../../src/jobs/database.ts";
import { JOB_MIGRATIONS } from "../../../src/jobs/queue.ts";
import { newId } from "../../../src/kernel/ids.ts";
import { MasterKey } from "../../../src/kernel/master-key.ts";
import { withNetworkTestHooks } from "../../../src/plugins/broker/network/test-context.ts";
import { HubStore } from "../../../src/store/store.ts";
import { createTlsFixture } from "../../plugins/broker/tls-fixture.ts";
import { migrations, nativeBinding } from "../../store/helpers.ts";

let tls: Awaited<ReturnType<typeof createTlsFixture>>;
beforeAll(async () => {
	tls = await createTlsFixture(["oauth2.googleapis.com"]);
});
const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
	for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});
const OWNER = newId(),
	ACCOUNT = newId();
const BINDING = { ownerKind: "account" as const, ownerId: ACCOUNT, kind: "gmail-oauth" as const };
const SECRET = "DYTEST-client-secret";
const policy = { deniedAddresses: [], deniedPorts: [] };
type Tokens = { access_token: string; refresh_token: string; expires_in: number };
const defer = () => {
	let resolve: () => void = () => undefined;
	const promise = new Promise<void>((yes) => {
		resolve = yes;
	});
	return { promise, resolve };
};
async function closedLoopbackPort(): Promise<number> {
	const reservation = createTcpServer();
	try {
		await new Promise<void>((resolve, reject) => {
			reservation.once("error", reject);
			reservation.listen(0, "127.0.0.1", resolve);
		});
		const address = reservation.address();
		if (!address || typeof address === "string") throw new Error("Fixture address unavailable");
		return address.port;
	} finally {
		if (reservation.listening)
			await new Promise<void>((resolve, reject) =>
				reservation.close((error) => (error ? reject(error) : resolve())),
			);
	}
}
async function fixture(rotate = true, timeoutMs = 5000) {
	const fake = createGoogleOAuthFake({
		rotateRefreshTokens: rotate,
		clients: [
			{
				clientId: GOOGLE_OAUTH_CLIENT_ID,
				clientSecret: SECRET,
				redirectUris: [GOOGLE_OAUTH_REDIRECT_URI],
			},
		],
	});
	const verifier = "DYTEST-verifier".padEnd(43, "x");
	const auth = await fake.fetch(
		`/o/oauth2/v2/auth?${new URLSearchParams({ response_type: "code", client_id: GOOGLE_OAUTH_CLIENT_ID, redirect_uri: GOOGLE_OAUTH_REDIRECT_URI, state: "DYTEST-state", code_challenge_method: "S256", code_challenge: createHash("sha256").update(verifier).digest("base64url"), scope: "openid email https://www.googleapis.com/auth/gmail.modify", access_type: "offline", prompt: "consent" })}`,
		{ redirect: "manual" },
	);
	const code = new URL(auth.headers.get("location") as string).searchParams.get("code") as string;
	const exchange = await fake.fetch("/token", {
		method: "POST",
		headers: { "content-type": "application/x-www-form-urlencoded" },
		body: new URLSearchParams({
			grant_type: "authorization_code",
			client_id: GOOGLE_OAUTH_CLIENT_ID,
			client_secret: SECRET,
			code,
			code_verifier: verifier,
			redirect_uri: GOOGLE_OAUTH_REDIRECT_URI,
		}),
	});
	const original = (await exchange.json()) as Tokens;
	expect(exchange.status).toBe(200);
	let requests = 0,
		mode: "normal" | "lost" | "hang" | "oversize" | "redirect" | "malformed" = "normal";
	let reply: { status: number; body: string } | undefined, clientFailure: Error | undefined;
	let entered = defer(),
		release: ReturnType<typeof defer> | undefined;
	const server = createServer({ cert: tls.cert, key: tls.key }, async (req, res) => {
		requests++;
		entered.resolve();
		const chunks: Buffer[] = [];
		for await (const chunk of req) chunks.push(Buffer.from(chunk));
		if (release) await release.promise;
		if (mode === "hang") return;
		if (reply) {
			res.writeHead(reply.status, { "content-type": "application/json" });
			res.end(reply.body);
			return;
		}
		const body = Buffer.concat(chunks);
		const response = await fake.fetch("/token", {
			method: "POST",
			headers: { "content-type": "application/x-www-form-urlencoded" },
			body,
		});
		if (mode === "lost") {
			res.destroy();
			return;
		}
		if (mode === "redirect") {
			res.writeHead(302, { location: "https://other.example/token" });
			res.end();
			return;
		}
		const responseBody = Buffer.from(await response.arrayBuffer());
		res.writeHead(response.status, { "content-type": "application/json" });
		res.end(
			mode === "oversize"
				? JSON.stringify({ ...JSON.parse(responseBody.toString()), padding: "x".repeat(24_577) })
				: mode === "malformed"
					? "{}"
					: responseBody,
		);
	});
	await new Promise<void>((yes) => server.listen(0, "127.0.0.1", yes));
	const address = server.address();
	if (!address || typeof address === "string") throw new Error("Fixture address unavailable");
	let targetPort = address.port;
	const parent = realpathSync.native(os.tmpdir()),
		dir = realpathSync.native(mkdtempSync(path.join(parent, "draftyak-gmail-credentials-")));
	const filename = path.join(dir, "fixture.db"),
		key = new MasterKey(randomBytes(32));
	const auditBytes = key.derive("audit"),
		audit = new AuditChain(auditBytes);
	auditBytes.fill(0);
	const fault = path.join(dir, "fault");
	mkdirSync(fault);
	const registered = {
		audit: path.join(migrations, "audit"),
		jobs: JOB_MIGRATIONS,
		events: EVENT_MIGRATIONS,
		credentials: path.resolve(import.meta.dirname, "../../../src/credentials/migrations"),
		gmailcredentials: GMAIL_CREDENTIAL_MIGRATIONS,
	};
	const options = { filename, nativeBinding, masterKey: key, migrations: { ...registered, fault } };
	let store = new HubStore({ ...options, create: true });
	const stores = [store],
		vaults: CredentialVault[] = [];
	cleanups.push(async () => {
		release?.resolve();
		for (const current of vaults) current.destroy();
		server.closeAllConnections();
		await new Promise<void>((yes) => server.close(() => yes()));
		for (const db of stores) db.close();
		audit.destroy();
		key.destroy();
		if (
			path.dirname(dir) !== parent ||
			!path.basename(dir).startsWith("draftyak-gmail-credentials-") ||
			realpathSync.native(dir) !== dir
		)
			throw new Error("Fixture cleanup refused");
		rmSync(dir, { recursive: true });
		expect(existsSync(dir)).toBe(false);
	});
	for (const namespace of Object.keys(registered)) await store.migrate(namespace);
	let database = new WorkDatabase(store),
		events = new EventLog(database, Date.now),
		vault = new CredentialVault(store, audit, key);
	const makeAdapter = () =>
		new GmailCredentials({
			store,
			database,
			events,
			vault,
			clientFor: () => {
				if (clientFailure) throw clientFailure;
				return { clientId: GOOGLE_OAUTH_CLIENT_ID, clientSecret: SECRET };
			},
			egressPolicy: policy,
			timeoutMs,
		});
	let adapter = makeAdapter();
	vaults.push(vault);
	const reference = database.write((scope) =>
		adapter.createInTransaction(scope, ACCOUNT, OWNER, {
			kind: "gmail-oauth",
			accessToken: original.access_token,
			refreshToken: original.refresh_token,
			expiresAt: 0,
		}),
	);
	const run = <T>(work: () => T): T =>
		withNetworkTestHooks(
			{
				ca: tls.ca,
				resolve: async (host) => {
					expect(host).toBe("oauth2.googleapis.com");
					return [{ address: "93.184.216.34", family: 4 }];
				},
				dial: () => ({ address: "127.0.0.1", family: 4, port: targetPort }),
			},
			work,
		);
	const use = (requestClass: "read" | "send" = "read", signal?: AbortSignal) =>
		run(() =>
			vault.withCredential(
				reference,
				BINDING,
				{ requestClass, refresh: adapter.refresh, ...(signal ? { signal } : {}) },
				(value) => (value.kind === "gmail-oauth" ? value.accessToken : ""),
			),
		);
	return {
		fake,
		original,
		get store() {
			return store;
		},
		get database() {
			return database;
		},
		get events() {
			return events;
		},
		get vault() {
			return vault;
		},
		get adapter() {
			return adapter;
		},
		reference,
		run,
		use,
		filename,
		fault,
		requests: () => requests,
		targetPort: (port = address.port) => {
			targetPort = port;
		},
		mode: (next: typeof mode) => {
			mode = next;
		},
		reply: (status: number, body: unknown) => {
			reply = { status, body: JSON.stringify(body) };
		},
		clientFailure: (error: Error) => {
			clientFailure = error;
		},
		row: () =>
			store.read((db) =>
				db.get<{ generation: number; status: string; cleared: number }>(
					"SELECT generation,status,value IS NULL AS cleared FROM main.credentials WHERE id=?",
					[reference],
				),
			),
		replace: (accessToken = "DYTEST-reconnected") =>
			database.write((scope) =>
				adapter.replaceInTransaction(scope, ACCOUNT, {
					kind: "gmail-oauth",
					accessToken,
					refreshToken: "DYTEST-reconnected-refresh",
					expiresAt: Date.now() + 60_000,
				}),
			),
		hold: () => {
			entered = defer();
			release = defer();
			return { entered: entered.promise, release: release.resolve };
		},
		reopen: () => {
			vault.destroy();
			store.close();
			store = new HubStore(options);
			stores.push(store);
			database = new WorkDatabase(store);
			events = new EventLog(database, Date.now);
			vault = new CredentialVault(store, audit, key);
			vaults.push(vault);
			adapter = makeAdapter();
			return vault;
		},
	};
}

async function expectClosedAcrossReopen(f: Awaited<ReturnType<typeof fixture>>) {
	expect(f.row()?.status).toBe("refreshing");
	expect(() => f.vault.describe(f.reference, BINDING)).toThrow("Credential unavailable");
	const row = f.row(),
		requests = f.requests();
	f.reopen();
	expect(f.row()).toEqual(row);
	expect(() => f.vault.describe(f.reference, BINDING)).toThrow("Credential unavailable");
	await expect(f.use()).rejects.toThrow("Credential unavailable");
	expect(f.requests()).toBe(requests);
	expect(f.adapter.deadline(ACCOUNT)).toBeNull();
	f.replace();
	expect(f.vault.describe(f.reference, BINDING).generation).toBeGreaterThan(row?.generation ?? 0);
	await expect(f.use()).resolves.toBe("DYTEST-reconnected");
}

describe("native Gmail credential refresh", () => {
	it.each([true, false])(
		"serializes refresh and persists rotation=%s before another use",
		async (rotate) => {
			const f = await fixture(rotate);
			const results = await Promise.all([f.use(), f.use(), f.use()]);
			expect(f.requests()).toBe(1);
			expect(new Set(results).size).toBe(1);
			expect(results[0]).not.toBe(f.original.access_token);
			const reopened = f.reopen();
			await reopened.withCredential(f.reference, BINDING, { requestClass: "read" }, (value) => {
				expect(value.kind).toBe("gmail-oauth");
				if (value.kind === "gmail-oauth")
					expect(value.refreshToken === f.original.refresh_token).toBe(!rotate);
			});
		},
	);
	it("never refreshes send-class requests", async () => {
		const f = await fixture();
		await expect(f.use("send")).rejects.toThrow("Credential unavailable");
		expect(f.requests()).toBe(0);
	});
	it("restores a fresh generation after a real connection refusal before sending the token body", async () => {
		const f = await fixture();
		f.targetPort(await closedLoopbackPort());
		const end = vi.spyOn(ClientRequest.prototype, "end"),
			emit = vi.spyOn(ClientRequest.prototype, "emit");
		try {
			const waiting = [f.use(), f.use(), f.use()].map((pending) =>
				expect(pending).rejects.toThrow("Credential unavailable"),
			);
			await Promise.all(waiting);
			const codes = emit.mock.calls.flatMap(([event, error]) =>
				event === "error" && error instanceof Error
					? [Object.getOwnPropertyDescriptor(error, "code")?.value]
					: [],
			);
			expect(codes).toEqual(["ECONNREFUSED"]);
			expect(end.mock.calls.length).toBe(0);
			expect(f.requests()).toBe(0);
			expect(f.row()).toMatchObject({ status: "active", generation: 3, cleared: 0 });
			expect(f.vault.describe(f.reference, BINDING).generation).toBe(3);
			expect(f.adapter.deadline(ACCOUNT)).toBeNull();
		} finally {
			end.mockRestore();
			emit.mockRestore();
			f.targetPort();
		}
		await expect(f.use()).resolves.not.toBe(f.original.access_token);
		expect(f.requests()).toBe(1);
		expect(f.vault.describe(f.reference, BINDING).generation).toBe(4);
	});
	it.each(["lost", "hang", "oversize", "redirect", "malformed"] as const)(
		"fails closed for %s without an accidental deletion deadline",
		async (mode) => {
			const f = await fixture(true, mode === "hang" ? 100 : 5000);
			f.mode(mode);
			await expect(f.use()).rejects.toThrow("Credential unavailable");
			expect(f.adapter.deadline(ACCOUNT)).toBeNull();
			await expectClosedAcrossReopen(f);
		},
	);
	it.each(["revoke", "disconnect", "delete"] as const)(
		"cannot restore credentials after racing %s",
		async (reason) => {
			const f = await fixture();
			const held = f.hold(),
				pending = f.use();
			const observed = expect(pending).rejects.toThrow("Credential unavailable");
			await held.entered;
			f.store.write((tx) => f.vault.invalidateInTransaction(tx, f.reference, BINDING, reason));
			held.release();
			await observed;
			expect(f.adapter.deadline(ACCOUNT)).toBeNull();
			expect(f.row()).toMatchObject({
				status:
					reason === "revoke" ? "revoked" : reason === "disconnect" ? "disconnected" : "deleted",
				cleared: 1,
			});
			f.reopen();
			await expect(f.use()).rejects.toThrow("Credential unavailable");
		},
	);
	it("cancels one caller's wait while the independent exchange may finish without revocation", async () => {
		const f = await fixture(),
			controller = new AbortController();
		const held = f.hold(),
			pending = f.use("read", controller.signal);
		const observed = expect(pending).rejects.toThrow("Credential unavailable");
		await held.entered;
		controller.abort();
		held.release();
		await observed;
		await expect(f.use()).resolves.not.toBe(f.original.access_token);
		expect(f.requests()).toBe(1);
		expect(f.adapter.deadline(ACCOUNT)).toBeNull();
	});
	it("keeps an interrupted exchange unavailable after store reopen until authorized replacement", async () => {
		const f = await fixture(),
			held = f.hold(),
			pending = f.use(),
			observed = expect(pending).rejects.toThrow("Credential unavailable");
		await held.entered;
		f.vault.destroy();
		await observed;
		held.release();
		await expectClosedAcrossReopen(f);
	});
	it("starts an ID-only deadline only for hub-observed invalid_grant and clears it atomically on reconnect", async () => {
		const f = await fixture();
		f.fake.enqueueTokenError({ error: "invalid_grant", grantType: "refresh_token" });
		const before = Date.now();
		await expect(f.use()).rejects.toThrow("Credential unavailable");
		const deadline = f.adapter.deadline(ACCOUNT);
		expect(deadline?.invalidAt).toBeGreaterThanOrEqual(before);
		expect((deadline?.deleteAt ?? 0) - (deadline?.invalidAt ?? 0)).toBe(30 * 24 * 60 * 60_000);
		expect(f.row()).toMatchObject({ status: "revoked", cleared: 1 });
		const revoked = f.row();
		f.reopen();
		expect(f.row()).toEqual(revoked);
		expect(f.adapter.deadline(ACCOUNT)).toEqual(deadline);
		expect(() => f.vault.describe(f.reference, BINDING)).toThrow("Credential unavailable");
		const committed = f.database.write((scope) =>
			f.events.page(scope, { userId: OWNER, afterSeq: 0 }),
		);
		expect(committed.events).toHaveLength(2);
		expect(
			committed.events.every(
				(event) =>
					event.kind === "accounts.changed" &&
					event.accountId === ACCOUNT &&
					event.ids.length === 1 &&
					event.ids[0] === ACCOUNT,
			),
		).toBe(true);
		f.database.write((scope) =>
			f.adapter.replaceInTransaction(scope, ACCOUNT, {
				kind: "gmail-oauth",
				accessToken: "DYTEST-reconnected",
				refreshToken: "DYTEST-reconnected-refresh",
				expiresAt: Date.now() + 60_000,
			}),
		);
		expect(f.adapter.deadline(ACCOUNT)).toBeNull();
		expect(await f.use()).toBe("DYTEST-reconnected");
		const events = f.database.write((scope) =>
			f.events.page(scope, { userId: OWNER, afterSeq: 0 }),
		);
		expect(events.events).toHaveLength(3);
		expect(
			events.events.every((event) => event.kind === "accounts.changed" && event.ids[0] === ACCOUNT),
		).toBe(true);
	});
	it("temporary endpoint errors restore a fresh generation for a later read retry", async () => {
		const f = await fixture();
		f.fake.enqueueTokenError({ error: "temporarily_unavailable", grantType: "refresh_token" });
		await expect(f.use()).rejects.toThrow("Credential unavailable");
		expect(f.adapter.deadline(ACCOUNT)).toBeNull();
		expect(f.row()).toMatchObject({ status: "active", generation: 3 });
		expect(f.vault.describe(f.reference, BINDING).generation).toBe(3);
		await expect(f.use()).resolves.not.toBe(f.original.access_token);
		expect(f.vault.describe(f.reference, BINDING).generation).toBe(4);
		expect(f.requests()).toBe(2);
	});
	it.each([
		{ status: 429, error: "temporarily_unavailable" },
		{ status: 503, error: "server_error" },
	])(
		"restores only a committed temporary $status failure and fails all its waiters",
		async ({ status, error }) => {
			const f = await fixture(),
				held = f.hold();
			f.reply(status, { error });
			const waiting = [f.use(), f.use(), f.use()].map((pending) =>
				expect(pending).rejects.toThrow("Credential unavailable"),
			);
			await held.entered;
			expect(f.row()).toMatchObject({ status: "refreshing", generation: 2 });
			held.release();
			await Promise.all(waiting);
			expect(f.requests()).toBe(1);
			expect(f.row()).toMatchObject({ status: "active", generation: 3 });
			f.reopen();
			expect(f.vault.describe(f.reference, BINDING).generation).toBe(3);
			expect(f.adapter.deadline(ACCOUNT)).toBeNull();
			f.reply(200, {
				access_token: "DYTEST-retried",
				refresh_token: "DYTEST-retried-refresh",
				token_type: "Bearer",
				expires_in: 3600,
			});
			await expect(f.use()).resolves.toBe("DYTEST-retried");
			expect(f.vault.describe(f.reference, BINDING).generation).toBe(4);
			expect(f.requests()).toBe(2);
		},
	);
	it.each([
		{ status: 503, body: { error: "unknown" } },
		{ status: 429, body: { error: "temporarily_unavailable", access_token: "DYTEST-mixed" } },
		{ status: 400, body: { error: "temporarily_unavailable" } },
		{ status: 200, body: { error: "invalid_grant" } },
	])("keeps unclassified $status envelopes unavailable across reopen", async ({ status, body }) => {
		const f = await fixture();
		f.reply(status, body);
		await expect(f.use()).rejects.toThrow("Credential unavailable");
		await expectClosedAcrossReopen(f);
	});
	it("does not turn a client lookup's branded error into refresh recovery", async () => {
		const f = await fixture();
		f.clientFailure(new CredentialRefreshError("temporary"));
		await expect(f.use()).rejects.toThrow("Credential unavailable");
		expect(f.requests()).toBe(0);
		await expectClosedAcrossReopen(f);
	});
	it("rejects partial persisted deadlines", async () => {
		const f = await fixture();
		for (const sql of [
			"UPDATE main.gmail_credentials SET invalid_at=1",
			"UPDATE main.gmail_credentials SET delete_at=1",
		])
			expect(() => f.store.write((tx) => tx.run(sql))).toThrow();
		expect(f.adapter.deadline(ACCOUNT)).toBeNull();
	});
	it("rolls back a duplicate binding even when the native caller catches its failure", async () => {
		const f = await fixture();
		expect(() =>
			f.database.write((scope) => {
				try {
					f.adapter.createInTransaction(scope, ACCOUNT, OWNER, {
						kind: "gmail-oauth",
						accessToken: "DYTEST-duplicate",
						refreshToken: "DYTEST-duplicate-refresh",
						expiresAt: Date.now() + 60_000,
					});
				} catch {
					/* A partial module operation must still abort the enclosing scope. */
				}
			}),
		).toThrow();
		expect(
			f.store.read((db) => db.get<{ n: number }>("SELECT COUNT(*) AS n FROM main.credentials"))?.n,
		).toBe(1);
	});
	it("cannot start a late invalid_grant deadline after authorized reconnect", async () => {
		const f = await fixture();
		f.fake.enqueueTokenError({ error: "invalid_grant", grantType: "refresh_token" });
		const held = f.hold(),
			pending = f.use(),
			observed = expect(pending).rejects.toThrow("Credential unavailable");
		await held.entered;
		f.database.write((scope) =>
			f.adapter.replaceInTransaction(scope, ACCOUNT, {
				kind: "gmail-oauth",
				accessToken: "DYTEST-fresh",
				refreshToken: "DYTEST-fresh-refresh",
				expiresAt: Date.now() + 60_000,
			}),
		);
		held.release();
		await observed;
		expect(f.adapter.deadline(ACCOUNT)).toBeNull();
		expect(await f.use()).toBe("DYTEST-fresh");
	});
	it("cannot install a late successful exchange over an authorized replacement", async () => {
		const f = await fixture(),
			held = f.hold(),
			pending = f.use(),
			observed = expect(pending).rejects.toThrow("Credential unavailable");
		await held.entered;
		f.replace("DYTEST-replacement");
		const current = f.vault.describe(f.reference, BINDING).generation;
		held.release();
		await observed;
		await expect(f.use()).resolves.toBe("DYTEST-replacement");
		expect(f.vault.describe(f.reference, BINDING).generation).toBe(current);
		f.reopen();
		await expect(f.use()).resolves.toBe("DYTEST-replacement");
		expect(f.adapter.deadline(ACCOUNT)).toBeNull();
		expect(f.requests()).toBe(1);
	});
	it("cascades a native purge to its Gmail binding without installing the late response", async () => {
		const f = await fixture(),
			held = f.hold(),
			pending = f.use(),
			observed = expect(pending).rejects.toThrow("Credential unavailable");
		await held.entered;
		expect(
			f.store.read((db) =>
				db.get("SELECT credential_ref FROM main.gmail_credentials WHERE account_id=?", [ACCOUNT]),
			),
		).toBeDefined();
		f.store.write((tx) => f.vault.purgeInTransaction(tx, f.reference, BINDING));
		held.release();
		await observed;
		f.reopen();
		expect(f.row()).toBeUndefined();
		expect(
			f.store.read((db) =>
				db.get("SELECT credential_ref FROM main.gmail_credentials WHERE account_id=?", [ACCOUNT]),
			),
		).toBeUndefined();
		await expect(f.use()).rejects.toThrow("Credential unavailable");
		expect(() => f.adapter.deadline(ACCOUNT)).toThrow("Credential unavailable");
		expect(f.requests()).toBe(1);
	});
	it("does not classify invalid_grant when its deadline and notification commit fails", async () => {
		const f = await fixture(),
			held = f.hold();
		f.fake.enqueueTokenError({ error: "invalid_grant", grantType: "refresh_token" });
		const pending = f.use(),
			observed = expect(pending).rejects.toThrow("Credential unavailable");
		await held.entered;
		writeFileSync(
			path.join(f.fault, "0001_failure.sql"),
			`
		CREATE TABLE gmail_fault_parent(id INTEGER PRIMARY KEY) STRICT;
		CREATE TABLE gmail_fault_child(id INTEGER REFERENCES gmail_fault_parent(id) DEFERRABLE INITIALLY DEFERRED) STRICT;
		CREATE TRIGGER gmail_deadline_failure AFTER UPDATE OF invalid_at ON gmail_credentials WHEN NEW.invalid_at IS NOT NULL
		BEGIN INSERT INTO gmail_fault_child(id) VALUES(1); END;
		`,
		);
		await f.store.migrate("fault");
		held.release();
		await observed;
		await expectClosedAcrossReopen(f);
		const events = f.database.write((scope) =>
			f.events.page(scope, { userId: OWNER, afterSeq: 0 }),
		);
		// Creation and the authorized replacement commit; the failed deadline notification does not.
		expect(events.events).toHaveLength(2);
	});
	it("never exposes a successful refresh after its persistence write fails", async () => {
		const f = await fixture(),
			held = f.hold();
		const pending = f.use(),
			observed = expect(pending).rejects.toThrow("Credential unavailable");
		await held.entered;
		const refreshing = f.row();
		expect(refreshing?.status).toBe("refreshing");
		writeFileSync(
			path.join(f.fault, "0001_failure.sql"),
			`
		CREATE TABLE gmail_fault_parent(id INTEGER PRIMARY KEY) STRICT;
		CREATE TABLE gmail_fault_child(id INTEGER REFERENCES gmail_fault_parent(id) DEFERRABLE INITIALLY DEFERRED) STRICT;
		CREATE TRIGGER gmail_refresh_failure AFTER UPDATE ON credentials WHEN NEW.status='active' AND NEW.generation=${refreshing?.generation}
		BEGIN INSERT INTO gmail_fault_child(id) VALUES(1); END;
		`,
		);
		await f.store.migrate("fault");
		held.release();
		await observed;
		expect(f.row()?.cleared).toBe(1);
		await expectClosedAcrossReopen(f);
	});
	it("redacts adapter JSON, audit, events and encrypted database files", async () => {
		const f = await fixture();
		await f.use();
		const audit = JSON.stringify(f.store.read((db) => db.all("SELECT * FROM audit_events")));
		const events = JSON.stringify(
			f.database.write((scope) => f.events.page(scope, { userId: OWNER, afterSeq: 0 })),
		);
		for (const secret of [SECRET, f.original.access_token, f.original.refresh_token]) {
			expect(JSON.stringify(f.adapter) + audit + events).not.toContain(secret);
			for (const suffix of ["", "-wal", "-shm"])
				if (existsSync(f.filename + suffix))
					expect(readFileSync(f.filename + suffix).includes(Buffer.from(secret))).toBe(false);
		}
	});
});
