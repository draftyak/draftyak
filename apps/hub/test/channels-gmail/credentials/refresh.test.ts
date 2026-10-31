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
import { createServer } from "node:https";
import os from "node:os";
import path from "node:path";
import {
	createGoogleOAuthFake,
	GOOGLE_OAUTH_CLIENT_ID,
	GOOGLE_OAUTH_REDIRECT_URI,
} from "@draftyak/fakes";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { AuditChain } from "../../../src/audit/chain.ts";
import {
	GMAIL_CREDENTIAL_MIGRATIONS,
	GmailCredentials,
} from "../../../src/channels/gmail/connection/google-credentials.ts";
import { CredentialVault } from "../../../src/credentials/vault.ts";
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
	let entered = defer(),
		release: ReturnType<typeof defer> | undefined;
	const server = createServer({ cert: tls.cert, key: tls.key }, async (req, res) => {
		requests++;
		entered.resolve();
		const chunks: Buffer[] = [];
		for await (const chunk of req) chunks.push(Buffer.from(chunk));
		if (release) await release.promise;
		if (mode === "hang") return;
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
	const parent = realpathSync(os.tmpdir()),
		dir = realpathSync(mkdtempSync(path.join(parent, "draftyak-gmail-credentials-")));
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
	const store = new HubStore({ ...options, create: true }),
		stores = [store];
	cleanups.push(async () => {
		release?.resolve();
		server.closeAllConnections();
		await new Promise<void>((yes) => server.close(() => yes()));
		for (const db of stores) db.close();
		audit.destroy();
		key.destroy();
		if (
			path.dirname(dir) !== parent ||
			!path.basename(dir).startsWith("draftyak-gmail-credentials-") ||
			realpathSync(dir) !== dir
		)
			throw new Error("Fixture cleanup refused");
		rmSync(dir, { recursive: true });
		expect(existsSync(dir)).toBe(false);
	});
	for (const namespace of Object.keys(registered)) await store.migrate(namespace);
	const database = new WorkDatabase(store),
		events = new EventLog(database, Date.now),
		vault = new CredentialVault(store, audit);
	const adapter = new GmailCredentials({
		store,
		database,
		events,
		vault,
		clientFor: () => ({ clientId: GOOGLE_OAUTH_CLIENT_ID, clientSecret: SECRET }),
		egressPolicy: policy,
		timeoutMs,
	});
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
				dial: () => ({ address: "127.0.0.1", family: 4, port: address.port }),
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
		store,
		database,
		events,
		vault,
		adapter,
		reference,
		run,
		use,
		filename,
		fault,
		requests: () => requests,
		mode: (next: typeof mode) => {
			mode = next;
		},
		hold: () => {
			entered = defer();
			release = defer();
			return { entered: entered.promise, release: release.resolve };
		},
		reopen: () => {
			store.close();
			const next = new HubStore(options);
			stores.push(next);
			return new CredentialVault(next, audit);
		},
	};
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
	it.each(["lost", "hang", "oversize", "redirect", "malformed"] as const)(
		"fails closed for %s without an accidental deletion deadline",
		async (mode) => {
			const f = await fixture(true, mode === "hang" ? 100 : 5000);
			f.mode(mode);
			await expect(f.use()).rejects.toThrow("Credential unavailable");
			expect(f.adapter.deadline(ACCOUNT)).toBeNull();
			const reopened = f.reopen();
			await expect(
				reopened.withCredential(f.reference, BINDING, { requestClass: "read" }, () => "forbidden"),
			).rejects.toThrow("Credential unavailable");
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
			await expect(f.use()).rejects.toThrow("Credential unavailable");
		},
	);
	it("cancels pending exchange without starting a revocation deadline", async () => {
		const f = await fixture(),
			controller = new AbortController();
		const held = f.hold(),
			pending = f.use("read", controller.signal);
		const observed = expect(pending).rejects.toThrow("Credential unavailable");
		await held.entered;
		controller.abort();
		held.release();
		await observed;
		expect(f.adapter.deadline(ACCOUNT)).toBeNull();
	});
	it("starts an ID-only deadline only for hub-observed invalid_grant and clears it atomically on reconnect", async () => {
		const f = await fixture();
		f.fake.enqueueTokenError({ error: "invalid_grant", grantType: "refresh_token" });
		const before = Date.now();
		await expect(f.use()).rejects.toThrow("Credential unavailable");
		const deadline = f.adapter.deadline(ACCOUNT);
		expect(deadline?.invalidAt).toBeGreaterThanOrEqual(before);
		expect((deadline?.deleteAt ?? 0) - (deadline?.invalidAt ?? 0)).toBe(30 * 24 * 60 * 60_000);
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
	it("temporary endpoint errors do not establish revocation", async () => {
		const f = await fixture();
		f.fake.enqueueTokenError({ error: "temporarily_unavailable", grantType: "refresh_token" });
		await expect(f.use()).rejects.toThrow("Credential unavailable");
		expect(f.adapter.deadline(ACCOUNT)).toBeNull();
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
	it("never exposes a successful refresh after its persistence write fails", async () => {
		const f = await fixture(),
			held = f.hold();
		const pending = f.use(),
			observed = expect(pending).rejects.toThrow("Credential unavailable");
		await held.entered;
		writeFileSync(
			path.join(f.fault, "0001_failure.sql"),
			`
		CREATE TABLE gmail_fault_parent(id INTEGER PRIMARY KEY) STRICT;
		CREATE TABLE gmail_fault_child(id INTEGER REFERENCES gmail_fault_parent(id) DEFERRABLE INITIALLY DEFERRED) STRICT;
		CREATE TRIGGER gmail_refresh_failure AFTER UPDATE ON credentials WHEN NEW.status='active'
		BEGIN INSERT INTO gmail_fault_child(id) VALUES(1); END;
		`,
		);
		await f.store.migrate("fault");
		held.release();
		await observed;
		const reopened = f.reopen();
		await expect(
			reopened.withCredential(f.reference, BINDING, { requestClass: "read" }, () => "forbidden"),
		).rejects.toThrow("Credential unavailable");
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
