import { randomBytes } from "node:crypto";
import { getEventListeners } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { createServer, type Server } from "node:https";
import os from "node:os";
import path from "node:path";
import type { TLSSocket } from "node:tls";
import { headersSha256, sha256Hex } from "@draftyak/protocol/hash";
import type { TicketedRequest } from "@draftyak/protocol/send-ticket";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { AuditChain } from "../../src/audit/chain.ts";
import { type CredentialBinding, CredentialVault } from "../../src/credentials/vault.ts";
import { systemClock, type TimerClock } from "../../src/kernel/clock.ts";
import { newId } from "../../src/kernel/ids.ts";
import { MasterKey } from "../../src/kernel/master-key.ts";
import type { NativeHttpSendTransport } from "../../src/outbox/http-send.ts";
import { renderGmailRequest } from "../../src/outbox/renderers/gmail-rfc5322.ts";
import { type SendTicketInsert, SendTicketStorage } from "../../src/outbox/ticket-storage.ts";
import { SendTicketLedger } from "../../src/outbox/tickets.ts";
import {
	type NetworkTestHooks,
	withNetworkTestHooks,
} from "../../src/plugins/broker/network/test-context.ts";
import { HubStore } from "../../src/store/store.ts";
import { requireLoopbackNetworkGuard } from "../helpers/loopback-network.ts";
import { createTlsFixture } from "../plugins/broker/tls-fixture.ts";
import { migrations, nativeBinding } from "../store/helpers.ts";

// A hook is not a network sandbox. Refuse before creating fixtures unless the actual
// process denies every non-loopback destination independently of the resolver hooks.
function requireLoopbackIsolation(): void {
	requireLoopbackNetworkGuard().assertActive();
}
let http: typeof import("../../src/outbox/http-send.ts");
const createNativeHttpSendTransport = (
	...args: Parameters<typeof http.createNativeHttpSendTransport>
) => http.createNativeHttpSendTransport(...args);
const consumeNativeSendObservation = (
	...args: Parameters<typeof http.consumeNativeSendObservation>
) => http.consumeNativeSendObservation(...args);
const abandonNativeSendClassification = (
	...args: Parameters<typeof http.abandonNativeSendClassification>
) => http.abandonNativeSendClassification(...args);
const MAX_SEND_RESPONSE_BYTES = 1_048_576;
let tls: Awaited<ReturnType<typeof createTlsFixture>>;
beforeAll(async () => {
	requireLoopbackIsolation();
	http = await import("../../src/outbox/http-send.ts");
	tls = await createTlsFixture(["slack.com", "gmail.googleapis.com"]);
});
beforeEach(() => requireLoopbackIsolation());
afterAll(() => {
	requireLoopbackIsolation();
	tls?.key.fill(0);
});
const deferred = <T>() => {
	let resolve: (value: T) => void = () => undefined;
	const promise = new Promise<T>((yes) => {
		resolve = yes;
	});
	return { promise, resolve };
};
const turn = () => new Promise<void>((resolve) => setImmediate(resolve));
const expectedDrainFailures = new WeakSet<NativeHttpSendTransport>();
const fixtures: {
	dir: string;
	store: HubStore;
	key: MasterKey;
	audit: AuditChain;
	storage: SendTicketStorage;
	ledger: SendTicketLedger;
	transports: NativeHttpSendTransport[];
	servers: Server[];
}[] = [];
afterEach(async () => {
	requireLoopbackIsolation();
	let unexpectedDrains = 0;
	for (const f of fixtures.splice(0)) {
		for (const transport of f.transports) transport.close();
		const drains = await Promise.allSettled(f.transports.map((transport) => transport.drain()));
		for (const [index, result] of drains.entries()) {
			const transport = f.transports[index];
			if (result.status === "rejected") {
				const expected =
					transport &&
					expectedDrainFailures.has(transport) &&
					result.reason instanceof http.NativeSendHttpError &&
					result.reason.code === "SEND_HTTP_UNAVAILABLE";
				if (!expected) unexpectedDrains++;
			}
		}
		for (const server of f.servers) {
			server.closeAllConnections();
			await new Promise<void>((resolve) => server.close(() => resolve()));
		}
		f.storage.destroy();
		f.ledger.destroy();
		f.store.close();
		f.audit.destroy();
		f.key.destroy();
		rmSync(f.dir, { recursive: true, force: true });
	}
	requireLoopbackIsolation();
	expect(unexpectedDrains).toBe(0);
});
async function fixture(kind: "slack-token" | "gmail-oauth" = "slack-token", expired = false) {
	const dir = mkdtempSync(path.join(os.tmpdir(), "draftyak-ticket-http-")),
		key = new MasterKey(randomBytes(32)),
		auditKey = key.derive("audit"),
		audit = new AuditChain(auditKey);
	auditKey.fill(0);
	const store = new HubStore({
		filename: path.join(dir, "hub.db"),
		nativeBinding,
		masterKey: key,
		create: true,
		migrations: {
			audit: path.join(migrations, "audit"),
			credentials: path.resolve(import.meta.dirname, "../../src/credentials/migrations"),
			tickets: path.resolve(import.meta.dirname, "../../src/outbox/migrations"),
		},
	});
	await store.migrate("audit");
	await store.migrate("credentials");
	await store.migrate("tickets");
	const owner: CredentialBinding = { ownerKind: "account", ownerId: newId(), kind },
		secret = `DYTEST-${randomBytes(24).toString("hex")}`,
		vault = new CredentialVault(store, audit, key),
		time = { wall: 1_800_000_000_000, mono: 10_000 },
		clock = { wallMs: () => time.wall, monotonicMs: () => time.mono };
	const value = () =>
		kind === "slack-token"
			? { kind, accessToken: secret, expiresAt: expired ? Date.now() - 1 : null }
			: {
					kind,
					accessToken: secret,
					refreshToken: `DYTEST-${randomBytes(24).toString("hex")}`,
					expiresAt: Date.now() + (expired ? -1 : 60_000),
				};
	const reference = store.write((tx) => vault.createInTransaction(tx, owner, value())),
		ledger = new SendTicketLedger(store, audit, vault, key, clock),
		storage = new SendTicketStorage(store, audit, vault, key, clock),
		transports: NativeHttpSendTransport[] = [],
		servers: Server[] = [];
	fixtures.push({ dir, store, key, audit, ledger, storage, transports, servers });
	const rendered =
		kind === "gmail-oauth"
			? await renderGmailRequest({
					snapshot: {
						v: 1,
						hub: "d".repeat(64),
						epoch: 3,
						outbox: newId(),
						account: owner.ownerId,
						conversation: null,
						kind: "email",
						email: {
							from: "owner@example.test",
							to: ["recipient@example.test"],
							cc: [],
							bcc: [],
							subject: "Synthetic Gmail transport",
							threadId: "DYTEST-thread",
							references: [],
						},
						body: { text: "Synthetic Gmail body", footer: "Synthetic footer" },
						attachments: [],
						schedule: { kind: "now" },
						source: { draft: newId(), rev: 1, authors: [{ kind: "owner", id: newId() }] },
					},
					stamp: {
						messageId: "<DYTEST-native-send@example.test>",
						dateMs: time.wall,
						mimeBoundary: "ab".repeat(16),
						uploadBoundary: "DYTEST_native_upload_01",
					},
					attachments: [],
				})
			: {
					method: "POST" as const,
					url: "https://slack.com/api/chat.postMessage",
					contentType: "application/json",
					headers: [["content-type", "application/json"]] as const,
					body: Buffer.from(JSON.stringify({ channel: "C1", text: "fixture message" })),
				};
	const issue = (change: Partial<SendTicketInsert> = {}) => {
		const { headers, body } = rendered;
		const input: SendTicketInsert = {
			accountId: owner.ownerId,
			credentialReference: reference,
			credentialGeneration: 1,
			credentialKind: kind,
			epoch: 3,
			contentHash: sha256Hex("fixture snapshot"),
			flagsHash: sha256Hex("fixture flags"),
			notBefore: null,
			deliverBy: time.wall + 120_000,
			outboxId: newId(),
			instanceId: newId(),
			method: rendered.method,
			url: rendered.url,
			contentType: rendered.contentType,
			headers,
			body,
			approvedHeadersSha256: headersSha256(headers),
			approvedBodySha256: sha256Hex(body),
			...change,
		};
		// Only storage DML issues these test tickets. No device/principal/approval is fabricated.
		const ticket = store.write((tx) => storage.insertInTransaction(tx, input)),
			request: TicketedRequest = {
				ticket,
				instanceId: input.instanceId,
				method: input.method,
				url: input.url,
				contentType: input.contentType,
				headers: input.headers,
				body: input.body,
			};
		return { input, ticket, redemption: ledger.redeem(request) };
	};
	const transport = (
		options: { timeoutMs?: number; classificationTimeoutMs?: number; clock?: TimerClock } = {},
	) => {
		const http = createNativeHttpSendTransport({
			ledger,
			vault,
			networkPolicy: { deniedAddresses: [], deniedPorts: [] },
			...options,
		});
		transports.push(http);
		return http;
	};
	const server = async (
		handler: (req: IncomingMessage, res: ServerResponse) => void,
		wrongCert = false,
	) => {
		let applicationBytes = 0,
			requests = 0;
		const observedSni: string[] = [];
		const https = createServer(
			{ key: tls.key, cert: wrongCert ? tls.ipCert : tls.cert },
			(req, res) => {
				requests++;
				handler(req, res);
			},
		);
		servers.push(https);
		https.on("tlsClientError", () => undefined);
		https.on("secureConnection", (socket) => {
			observedSni.push((socket as TLSSocket).servername as string);
			socket.on("data", (raw) => {
				applicationBytes += raw.length;
			});
		});
		await new Promise<void>((resolve) => https.listen(0, "127.0.0.1", resolve));
		const address = https.address();
		if (!address || typeof address === "string") throw new Error("fixture bind failed");
		const hooks: NetworkTestHooks = {
			ca: tls.ca,
			resolve: async () => [{ address: "8.8.8.8", family: 4 }],
			dial: () => ({ address: "127.0.0.1", family: 4, port: address.port }),
		};
		return {
			https,
			hooks,
			requests: () => requests,
			applicationBytes: () => applicationBytes,
			sni: () => observedSni,
		};
	};
	return {
		store,
		key,
		audit,
		vault,
		owner,
		secret,
		reference,
		time,
		ledger,
		storage,
		issue,
		transport,
		server,
	};
}
describe("ticket-gated native HTTP send observations", () => {
	it.each(["slack-token", "gmail-oauth"] as const)(
		"sends exact stored %s bytes only after durable fencing and verified TLS, without treating HTTP200 as SENT",
		async (kind) => {
			const f = await fixture(kind),
				issued = f.issue();
			let wireBody = Buffer.alloc(0),
				wireAuth: string | undefined,
				wireHost: string | undefined,
				wirePath: string | undefined,
				wireMethod: string | undefined,
				wireType: string | undefined;
			const upstream = await f.server((req, res) => {
				expect(f.ledger.getAttempt(issued.input.outboxId)?.state).toBe("SENDING");
				wireAuth = req.headers.authorization;
				wireHost = req.headers.host;
				wirePath = req.url;
				wireMethod = req.method;
				wireType = req.headers["content-type"];
				const parts: Buffer[] = [];
				req.on("data", (raw) => parts.push(raw));
				req.on("end", () => {
					wireBody = Buffer.concat(parts);
					res.setHeader("content-type", "application/json");
					res.end('{"ok":true}');
				});
			});
			const http = f.transport(),
				handle = await withNetworkTestHooks(upstream.hooks, () =>
					http.send(issued.redemption, new AbortController().signal),
				),
				observed = consumeNativeSendObservation(handle);
			expect(observed.kind).toBe("response");
			if (observed.kind !== "response") throw new Error("missing response");
			expect(observed.status).toBe(200);
			expect(Buffer.from(observed.body).toString()).toBe('{"ok":true}');
			expect(wireBody).toEqual(Buffer.from(issued.input.body));
			expect(wireAuth).toBe(`Bearer ${f.secret}`);
			expect(wireHost).toBe(new URL(issued.input.url).hostname);
			expect(wirePath).toBe(
				kind === "gmail-oauth"
					? "/upload/gmail/v1/users/me/messages/send?uploadType=multipart"
					: "/api/chat.postMessage",
			);
			expect(wireType).toBe(
				kind === "gmail-oauth"
					? 'multipart/related; boundary="DYTEST_native_upload_01"'
					: "application/json",
			);
			expect(wireMethod).toBe("POST");
			expect(upstream.sni()).toContain(wireHost);
			expect(f.ledger.getAttempt(issued.input.outboxId)?.state).toBe("SENDING");
			expect(() => consumeNativeSendObservation(handle)).toThrow("Send request unavailable");
			abandonNativeSendClassification(observed.pending);
			expect(f.ledger.getAttempt(issued.input.outboxId)?.state).toBe("UNKNOWN");
			expect(upstream.requests()).toBe(1);
		},
	);
	it.each([
		"https://slack.com/api/other",
		"https://example.test/api/chat.postMessage",
		"https://slack.com/api/chat.postMessage?x=1",
		"https://gmail.googleapis.com/gmail/v1/users/me/messages/send",
		"https://gmail.googleapis.com/upload/gmail/v1/users/me/messages/send?uploadType=multipart",
	])("refuses unbound send route %s before any DNS or socket", async (url) => {
		const f = await fixture(),
			issued = f.issue({ url });
		let dns = 0;
		const handle = await withNetworkTestHooks(
				{
					resolve: async () => {
						dns++;
						throw new Error("unexpected network");
					},
				},
				() => f.transport().send(issued.redemption, new AbortController().signal),
			),
			observed = consumeNativeSendObservation(handle);
		expect(observed).toMatchObject({
			kind: "transport",
			written: "none",
			error: "SEND_HTTP_UNAVAILABLE",
			attempt: { state: "FAILED" },
		});
		expect(dns).toBe(0);
	});
	it.each([
		{
			name: "legacy JSON endpoint",
			url: "https://gmail.googleapis.com/gmail/v1/users/me/messages/send",
			contentType: "application/json",
		},
		{
			name: "media upload",
			url: "https://gmail.googleapis.com/upload/gmail/v1/users/me/messages/send?uploadType=media",
		},
		{
			name: "extra query",
			url: "https://gmail.googleapis.com/upload/gmail/v1/users/me/messages/send?uploadType=multipart&extra=1",
		},
		{
			name: "duplicate query",
			url: "https://gmail.googleapis.com/upload/gmail/v1/users/me/messages/send?uploadType=multipart&uploadType=multipart",
		},
		{
			name: "encoded query",
			url: "https://gmail.googleapis.com/upload/gmail/v1/users/me/messages/send?uploadType=multipart%2F",
		},
		{
			name: "unquoted boundary",
			contentType: "multipart/related; boundary=DYTEST_native_upload_01",
		},
		{ name: "short boundary", contentType: 'multipart/related; boundary="short"' },
		{ name: "long boundary", contentType: `multipart/related; boundary="${"a".repeat(65)}"` },
		{ name: "wrong subtype", contentType: 'multipart/mixed; boundary="DYTEST_native_upload_01"' },
		{
			name: "extra parameter",
			contentType: 'multipart/related; boundary="DYTEST_native_upload_01"; charset=UTF-8',
		},
		{ name: "method override", method: "PATCH" as const },
	])("refuses Gmail $name before any DNS or socket", async (change) => {
		const f = await fixture("gmail-oauth");
		const url = "url" in change && typeof change.url === "string" ? change.url : undefined,
			method = "method" in change && change.method === "PATCH" ? change.method : undefined,
			contentType =
				"contentType" in change && typeof change.contentType === "string"
					? change.contentType
					: undefined,
			headers = contentType === undefined ? undefined : ([["content-type", contentType]] as const);
		const overrides: Partial<SendTicketInsert> = {
			...(url === undefined ? {} : { url }),
			...(method === undefined ? {} : { method }),
			...(headers === undefined
				? {}
				: { contentType: headers[0][1], headers, approvedHeadersSha256: headersSha256(headers) }),
		};
		const issued = f.issue(overrides);
		let dns = 0;
		const handle = await withNetworkTestHooks(
			{
				resolve: async () => {
					dns++;
					throw new Error("unexpected network");
				},
			},
			() => f.transport().send(issued.redemption, new AbortController().signal),
		);
		expect(consumeNativeSendObservation(handle)).toMatchObject({
			kind: "transport",
			written: "none",
			attempt: { state: "FAILED" },
		});
		expect(dns).toBe(0);
	});
	it("refuses non-POST and altered approved content type before network", async () => {
		const f = await fixture();
		for (const change of [
			{ method: "PUT" as const },
			{
				contentType: "text/plain",
				headers: [["content-type", "text/plain"]] as const,
				approvedHeadersSha256: headersSha256([["content-type", "text/plain"]]),
			},
		]) {
			const issued = f.issue(change),
				handle = await f.transport().send(issued.redemption, new AbortController().signal);
			expect(consumeNativeSendObservation(handle)).toMatchObject({
				kind: "transport",
				written: "none",
				attempt: { state: "FAILED" },
			});
		}
	});
	it("refuses forbidden DNS answers and preserves a truthful no-write outcome", async () => {
		const f = await fixture(),
			issued = f.issue(),
			upstream = await f.server((_req, res) => res.end("unreachable"));
		const handle = await withNetworkTestHooks(
			{ ...upstream.hooks, resolve: async () => [{ address: "127.0.0.1", family: 4 }] },
			() => f.transport().send(issued.redemption, new AbortController().signal),
		);
		expect(consumeNativeSendObservation(handle)).toMatchObject({
			kind: "transport",
			written: "none",
			attempt: { state: "FAILED" },
		});
		expect(upstream.requests()).toBe(0);
		expect(upstream.applicationBytes()).toBe(0);
	});
	it.each(["replace", "stored-generation"] as const)(
		"checks real credential generation after DNS %s",
		async (mode) => {
			const f = await fixture(),
				issued = f.issue(),
				dns = deferred<readonly { address: string; family: 4 }[]>(),
				started = deferred<void>(),
				controller = new AbortController();
			let dials = 0;
			const pending = withNetworkTestHooks(
				{
					resolve: async () => {
						started.resolve();
						return dns.promise;
					},
					dial: () => {
						dials++;
						throw new Error("unexpected dial");
					},
				},
				() => f.transport().send(issued.redemption, controller.signal),
			);
			try {
				await started.promise;
				f.store.write((tx) => {
					if (mode === "replace")
						f.vault.replaceInTransaction(tx, f.reference, f.owner, {
							kind: "slack-token",
							accessToken: `DYTEST-${randomBytes(24).toString("hex")}`,
							expiresAt: null,
						});
					else tx.run("UPDATE credentials SET generation=generation+1 WHERE id=?", [f.reference]);
				});
				dns.resolve([{ address: "8.8.8.8", family: 4 }]);
				expect(consumeNativeSendObservation(await pending)).toMatchObject({
					kind: "transport",
					written: "none",
					attempt: { state: "FAILED" },
				});
				expect(dials).toBe(0);
			} finally {
				controller.abort();
				dns.resolve([{ address: "8.8.8.8", family: 4 }]);
				await Promise.allSettled([pending]);
			}
		},
	);
	it("revokes an actual lease before TLS validation without writing credentials or body", async () => {
		const f = await fixture(),
			issued = f.issue(),
			upstream = await f.server((_req, res) => res.end("unreachable"));
		const handle = await withNetworkTestHooks(
			{
				...upstream.hooks,
				lookupObserved: () =>
					f.store.write((tx) =>
						f.vault.invalidateInTransaction(tx, f.reference, f.owner, "revoke"),
					),
			},
			() => f.transport().send(issued.redemption, new AbortController().signal),
		);
		expect(consumeNativeSendObservation(handle)).toMatchObject({
			kind: "transport",
			written: "none",
			attempt: { state: "FAILED" },
		});
		expect(upstream.requests()).toBe(0);
		expect(upstream.applicationBytes()).toBe(0);
	});
	it("writes zero HTTP bytes under a real wrong-host TLS certificate", async () => {
		const f = await fixture(),
			issued = f.issue(),
			upstream = await f.server((_req, res) => res.end("unreachable"), true),
			handle = await withNetworkTestHooks(upstream.hooks, () =>
				f.transport().send(issued.redemption, new AbortController().signal),
			);
		expect(consumeNativeSendObservation(handle)).toMatchObject({
			kind: "transport",
			written: "none",
			attempt: { state: "FAILED" },
		});
		expect(upstream.requests()).toBe(0);
		expect(upstream.applicationBytes()).toBe(0);
	});
	it.each(["cancel", "close", "deadline"] as const)(
		"settles stalled DNS on %s before any write",
		async (action) => {
			const f = await fixture(),
				issued = f.issue(),
				controller = new AbortController(),
				dns = deferred<readonly { address: string; family: 4 }[]>(),
				started = deferred<void>(),
				http = f.transport({ timeoutMs: 50 });
			const pending = withNetworkTestHooks(
				{
					resolve: async () => {
						started.resolve();
						return dns.promise;
					},
				},
				() => http.send(issued.redemption, controller.signal),
			);
			try {
				await started.promise;
				if (action === "cancel") controller.abort(new Error("untrusted reason"));
				if (action === "close") http.close();
				expect(consumeNativeSendObservation(await pending)).toMatchObject({
					kind: "transport",
					written: "none",
					attempt: { state: "FAILED" },
				});
			} finally {
				dns.resolve([{ address: "8.8.8.8", family: 4 }]);
				await Promise.allSettled([pending, http.drain()]);
			}
		},
	);
	it("rechecks actual ticket expiry at the write boundary after DNS", async () => {
		const f = await fixture(),
			issued = f.issue(),
			upstream = await f.server((_req, res) => res.end("unreachable")),
			hooks = {
				...upstream.hooks,
				resolve: async () => {
					f.time.mono += 60_001;
					return [{ address: "8.8.8.8", family: 4 as const }];
				},
			},
			handle = await withNetworkTestHooks(hooks, () =>
				f.transport().send(issued.redemption, new AbortController().signal),
			);
		expect(consumeNativeSendObservation(handle)).toMatchObject({
			kind: "transport",
			written: "none",
			attempt: { state: "FAILED" },
		});
		expect(upstream.requests()).toBe(0);
	});
	it("never refreshes expired Gmail credentials for send", async () => {
		const f = await fixture("gmail-oauth", true),
			issued = f.issue(),
			upstream = await f.server((_req, res) => res.end("unreachable")),
			handle = await withNetworkTestHooks(upstream.hooks, () =>
				f.transport().send(issued.redemption, new AbortController().signal),
			);
		expect(consumeNativeSendObservation(handle)).toMatchObject({
			kind: "transport",
			written: "none",
			attempt: { state: "FAILED" },
		});
		expect(f.vault.describe(f.reference, f.owner).generation).toBe(1);
		expect(upstream.requests()).toBe(0);
	});
	it("persists UNKNOWN on cancellation after a real request end boundary", async () => {
		const f = await fixture(),
			issued = f.issue(),
			received = deferred<void>(),
			controller = new AbortController(),
			upstream = await f.server((req, _res) => {
				req.resume();
				req.once("end", () => received.resolve());
			});
		const pending = withNetworkTestHooks(upstream.hooks, () =>
			f.transport().send(issued.redemption, controller.signal),
		);
		await received.promise;
		controller.abort();
		expect(consumeNativeSendObservation(await pending)).toMatchObject({
			kind: "transport",
			written: "maybe",
			attempt: { state: "UNKNOWN" },
		});
		expect(upstream.requests()).toBe(1);
	});
	it.each(["body", "header"] as const)(
		"refuses exact credential echo in response %s including split chunks",
		async (where) => {
			const f = await fixture(),
				issued = f.issue(),
				upstream = await f.server((_req, res) => {
					if (where === "header") {
						res.setHeader("x-echo", f.secret);
						res.end("synthetic");
					} else {
						const cut = Math.floor(f.secret.length / 2);
						res.write(f.secret.slice(0, cut));
						void systemClock.after(5).then(() => res.end(f.secret.slice(cut)));
					}
				}),
				handle = await withNetworkTestHooks(upstream.hooks, () =>
					f.transport().send(issued.redemption, new AbortController().signal),
				);
			const observed = consumeNativeSendObservation(handle);
			expect(observed).toMatchObject({
				kind: "transport",
				written: "maybe",
				error: "SEND_HTTP_UNAVAILABLE",
				attempt: { state: "UNKNOWN" },
			});
			expect(JSON.stringify(observed)).not.toContain(f.secret);
		},
	);
	it.each([429, 500])(
		"preserves actual HTTP%s data as pending, then watchdog records UNKNOWN",
		async (status) => {
			const f = await fixture(),
				issued = f.issue(),
				upstream = await f.server((_req, res) => {
					res.statusCode = status;
					res.setHeader("retry-after", "5");
					res.end("synthetic failure");
				}),
				handle = await withNetworkTestHooks(upstream.hooks, () =>
					f
						.transport({ classificationTimeoutMs: 25 })
						.send(issued.redemption, new AbortController().signal),
				),
				observed = consumeNativeSendObservation(handle);
			expect(observed.kind).toBe("response");
			if (observed.kind !== "response") throw new Error("missing response");
			expect(observed.status).toBe(status);
			expect(observed.headers).toContainEqual(["retry-after", "5"]);
			expect(f.ledger.getAttempt(issued.input.outboxId)?.state).toBe("SENDING");
			await systemClock.after(50);
			expect(f.ledger.getAttempt(issued.input.outboxId)?.state).toBe("UNKNOWN");
		},
	);
	it.each(["redirect", "compression", "oversize"] as const)(
		"refuses %s responses after possible effect",
		async (mode) => {
			const f = await fixture(),
				issued = f.issue(),
				upstream = await f.server((_req, res) => {
					if (mode === "redirect") {
						res.statusCode = 302;
						res.setHeader("location", "https://example.test/");
						res.end();
					} else if (mode === "compression") {
						res.setHeader("content-encoding", "gzip");
						res.end("not admitted");
					} else res.end(Buffer.alloc(MAX_SEND_RESPONSE_BYTES + 1, 120));
				}),
				handle = await withNetworkTestHooks(upstream.hooks, () =>
					f.transport().send(issued.redemption, new AbortController().signal),
				);
			expect(consumeNativeSendObservation(handle)).toMatchObject({
				kind: "transport",
				written: "maybe",
				attempt: { state: "UNKNOWN" },
			});
			expect(upstream.requests()).toBe(1);
		},
	);
	it("keeps a timely complete response pending after ticket expiration and rotation, with no second write", async () => {
		const f = await fixture(),
			issued = f.issue(),
			upstream = await f.server((req, res) => {
				req.resume();
				req.once("end", () => {
					f.time.wall += 60_001;
					f.time.mono += 60_001;
					res.end("synthetic complete");
				});
			}),
			http = f.transport(),
			handle = await withNetworkTestHooks(upstream.hooks, () =>
				http.send(issued.redemption, new AbortController().signal),
			),
			observed = consumeNativeSendObservation(handle);
		expect(observed.kind).toBe("response");
		f.store.write((tx) => f.vault.invalidateInTransaction(tx, f.reference, f.owner, "revoke"));
		expect(f.ledger.getAttempt(issued.input.outboxId)?.state).toBe("SENDING");
		await expect(
			withNetworkTestHooks(upstream.hooks, () =>
				http.send(issued.redemption, new AbortController().signal),
			),
		).rejects.toThrow("Send request unavailable");
		expect(upstream.requests()).toBe(1);
		http.close();
		expect(f.ledger.getAttempt(issued.input.outboxId)?.state).toBe("UNKNOWN");
	});
	it("settles a real send queued behind an indefinitely pending native credential refresh", async () => {
		const f = await fixture("gmail-oauth", true),
			issued = f.issue(),
			dns = deferred<readonly { address: string; family: 4 }[]>(),
			dnsStarted = deferred<void>(),
			refreshStarted = deferred<void>(),
			rotated = deferred<{
				kind: "gmail-oauth";
				accessToken: string;
				refreshToken: string;
				expiresAt: number;
			}>(),
			controller = new AbortController();
		const pending = withNetworkTestHooks(
			{
				resolve: async () => {
					dnsStarted.resolve();
					return dns.promise;
				},
			},
			() => f.transport().send(issued.redemption, controller.signal),
		);
		const replacement = {
			kind: "gmail-oauth",
			accessToken: `DYTEST-${randomBytes(24).toString("hex")}`,
			refreshToken: `DYTEST-${randomBytes(24).toString("hex")}`,
			expiresAt: Date.now() + 60_000,
		} as const;
		let refreshing: Promise<string> | undefined;
		try {
			await dnsStarted.promise;
			refreshing = f.vault.withCredential(
				f.reference,
				f.owner,
				{
					requestClass: "read",
					refresh: async () => {
						refreshStarted.resolve();
						return rotated.promise;
					},
				},
				() => "refreshed",
			);
			void refreshing.catch(() => undefined);
			await refreshStarted.promise;
			dns.resolve([{ address: "8.8.8.8", family: 4 }]);
			await systemClock.after(5);
			controller.abort();
			expect(consumeNativeSendObservation(await pending)).toMatchObject({
				kind: "transport",
				written: "none",
				attempt: { state: "FAILED" },
			});
			rotated.resolve(replacement);
			expect(await refreshing).toBe("refreshed");
		} finally {
			controller.abort();
			dns.resolve([{ address: "8.8.8.8", family: 4 }]);
			rotated.resolve(replacement);
			await Promise.allSettled([pending, ...(refreshing ? [refreshing] : [])]);
		}
	});
	it("delivers the exact maximum bounded response through an authentic pending handle", async () => {
		const f = await fixture(),
			issued = f.issue(),
			upstream = await f.server((_req, res) => res.end(Buffer.alloc(MAX_SEND_RESPONSE_BYTES, 120))),
			handle = await withNetworkTestHooks(upstream.hooks, () =>
				f.transport().send(issued.redemption, new AbortController().signal),
			),
			observed = consumeNativeSendObservation(handle);
		expect(observed.kind).toBe("response");
		if (observed.kind !== "response") throw new Error("missing response");
		expect(observed.body.byteLength).toBe(MAX_SEND_RESPONSE_BYTES);
		abandonNativeSendClassification(observed.pending);
	});
	it("refuses a credential copied into approved request bytes before actual request end", async () => {
		const f = await fixture(),
			body = Buffer.from(JSON.stringify({ text: f.secret })),
			issued = f.issue({ body, approvedBodySha256: sha256Hex(body) }),
			upstream = await f.server((_req, res) => res.end("unreachable")),
			handle = await withNetworkTestHooks(upstream.hooks, () =>
				f.transport().send(issued.redemption, new AbortController().signal),
			);
		expect(consumeNativeSendObservation(handle)).toMatchObject({
			kind: "transport",
			written: "none",
			attempt: { state: "FAILED" },
		});
		expect(upstream.requests()).toBe(0);
		expect(upstream.applicationBytes()).toBe(0);
	});
});

describe("owned native HTTP transport drain", () => {
	it("joins the original DNS promise and watcher finally after the send has already failed", async () => {
		for (const first of ["watch", "dns"] as const) {
			const f = await fixture(),
				issued = f.issue(),
				dns = deferred<readonly { address: string; family: 4 }[]>(),
				started = deferred<void>(),
				watchAborted = deferred<void>(),
				releaseWatch = deferred<void>(),
				watchDone = deferred<void>(),
				dnsDone = deferred<void>();
			let dnsFinished = 0,
				watchFinished = 0,
				dials = 0;
			let watchEntered = false,
				dnsEntered = false;
			const clock: TimerClock = {
				wallMs: () => systemClock.wallMs(),
				monotonicMs: () => systemClock.monotonicMs(),
				after: async (_ms, signal) => {
					if (!signal) throw new Error("Synthetic missing watch signal");
					watchEntered = true;
					const stopped = deferred<void>();
					const stop = () => stopped.resolve();
					signal.addEventListener("abort", stop, { once: true });
					if (signal.aborted) stop();
					try {
						await stopped.promise;
						watchAborted.resolve();
						await releaseWatch.promise;
						throw new Error("Synthetic watch stopped");
					} finally {
						signal.removeEventListener("abort", stop);
						watchFinished++;
						watchDone.resolve();
					}
				},
			};
			const transport = f.transport({ clock });
			const pending = withNetworkTestHooks(
				{
					resolve: async () => {
						dnsEntered = true;
						started.resolve();
						try {
							return await dns.promise;
						} finally {
							dnsFinished++;
							dnsDone.resolve();
						}
					},
					dial: () => {
						dials++;
						throw new Error("Synthetic forbidden late dial");
					},
				},
				() => transport.send(issued.redemption, new AbortController().signal),
			);
			let draining: Promise<void> | undefined;
			try {
				await started.promise;
				draining = transport.drain();
				expect(transport.drain()).toBe(draining);
				let completed = false;
				void draining.then(
					() => {
						completed = true;
					},
					() => {
						completed = true;
					},
				);
				expect(consumeNativeSendObservation(await pending)).toMatchObject({
					kind: "transport",
					written: "none",
					attempt: { state: "FAILED" },
				});
				await watchAborted.promise;
				await turn();
				expect(completed).toBe(false);
				if (first === "watch") {
					releaseWatch.resolve();
					await watchDone.promise;
					await turn();
					expect(watchFinished).toBe(1);
					expect(dnsFinished).toBe(0);
					expect(completed).toBe(false);
					dns.resolve([{ address: "8.8.8.8", family: 4 }]);
				} else {
					dns.resolve([{ address: "8.8.8.8", family: 4 }]);
					await dnsDone.promise;
					await turn();
					expect(dnsFinished).toBe(1);
					expect(watchFinished).toBe(0);
					expect(completed).toBe(false);
					releaseWatch.resolve();
				}
				await draining;
				await Promise.all([dnsDone.promise, watchDone.promise]);
				expect(dnsFinished).toBe(1);
				expect(watchFinished).toBe(1);
				expect(dials).toBe(0);
			} finally {
				releaseWatch.resolve();
				dns.resolve([{ address: "8.8.8.8", family: 4 }]);
				transport.close();
				await Promise.allSettled([pending, draining ?? transport.drain()]);
				await Promise.all([
					...(dnsEntered ? [dnsDone.promise] : []),
					...(watchEntered ? [watchDone.promise] : []),
				]);
			}
		}
	});

	it("joins the classification timer after close records UNKNOWN without erasing detached response data", async () => {
		const f = await fixture(),
			issued = f.issue(),
			upstream = await f.server((_req, res) => res.end("Synthetic pending response")),
			classificationStarted = deferred<void>(),
			classificationAborted = deferred<void>(),
			releaseClassification = deferred<void>();
		let watchSignal: AbortSignal | undefined;
		let classificationFinished = 0;
		const clock: TimerClock = {
			wallMs: () => systemClock.wallMs(),
			monotonicMs: () => systemClock.monotonicMs(),
			after: async (ms, signal) => {
				if (!signal) throw new Error("Synthetic missing timer signal");
				watchSignal ??= signal;
				if (signal === watchSignal) return systemClock.after(ms, signal);
				classificationStarted.resolve();
				const stopped = deferred<void>();
				const stop = () => stopped.resolve();
				signal.addEventListener("abort", stop, { once: true });
				if (signal.aborted) stop();
				try {
					await stopped.promise;
					classificationAborted.resolve();
					await releaseClassification.promise;
					throw new Error("Synthetic classification timer stopped");
				} finally {
					signal.removeEventListener("abort", stop);
					classificationFinished++;
				}
			},
		};
		const transport = f.transport({ clock });
		let draining: Promise<void> | undefined;
		try {
			const handle = await withNetworkTestHooks(upstream.hooks, () =>
				transport.send(issued.redemption, new AbortController().signal),
			);
			const observed = consumeNativeSendObservation(handle);
			expect(observed.kind).toBe("response");
			if (observed.kind !== "response") throw new Error("Synthetic missing response");
			await classificationStarted.promise;
			draining = transport.drain();
			expect(transport.drain()).toBe(draining);
			let completed = false;
			void draining.then(
				() => {
					completed = true;
				},
				() => {
					completed = true;
				},
			);
			await classificationAborted.promise;
			await turn();
			expect(completed).toBe(false);
			expect(classificationFinished).toBe(0);
			expect(f.ledger.getAttempt(issued.input.outboxId)?.state).toBe("UNKNOWN");
			releaseClassification.resolve();
			await draining;
			expect(classificationFinished).toBe(1);
			expect(Buffer.from(observed.body).toString()).toBe("Synthetic pending response");
			const auditCount = f.store.read(
				(db) => db.get<{ n: number }>("SELECT count(*) n FROM main.audit_events")?.n,
			);
			expect(typeof auditCount).toBe("number");
			await transport.drain();
			expect(
				f.store.read((db) => db.get<{ n: number }>("SELECT count(*) n FROM main.audit_events")?.n),
			).toBe(auditCount);
			expect(upstream.requests()).toBe(1);
		} finally {
			releaseClassification.resolve();
			transport.close();
			await Promise.allSettled([draining ?? transport.drain()]);
		}
	});

	it("keeps terminal row integrity refusal visible without replay after restoring the original row", async () => {
		const f = await fixture(),
			issued = f.issue(),
			upstream = await f.server((_req, res) => res.end("Synthetic uncertain response"));
		const clock: TimerClock = {
			wallMs: () => systemClock.wallMs(),
			monotonicMs: () => systemClock.monotonicMs(),
			after: (_ms, signal) =>
				new Promise<void>((_resolve, reject) => {
					if (!signal) {
						reject(new Error("Synthetic missing durable-failure timer signal"));
						return;
					}
					const stop = () => {
						signal.removeEventListener("abort", stop);
						reject(new Error("Synthetic durable-failure timer stopped"));
					};
					signal.addEventListener("abort", stop, { once: true });
					if (signal.aborted) stop();
				}),
		};
		const transport = f.transport({ clock });
		const handle = await withNetworkTestHooks(upstream.hooks, () =>
			transport.send(issued.redemption, new AbortController().signal),
		);
		expect(consumeNativeSendObservation(handle).kind).toBe("response");
		const originalMac = f.store.read(
			(db) =>
				db.get<{ mac: string }>("SELECT mac FROM main.native_send_attempts WHERE outbox_id=?", [
					issued.input.outboxId,
				])?.mac,
		);
		if (typeof originalMac !== "string" || !/^[0-9a-f]{64}$/.test(originalMac))
			throw new Error("Synthetic owned attempt MAC unavailable");
		const invalidMac = `${originalMac[0] === "0" ? "1" : "0"}${originalMac.slice(1)}`;
		const changed = f.store.write(
			(tx) =>
				tx.run("UPDATE main.native_send_attempts SET mac=? WHERE outbox_id=?", [
					invalidMac,
					issued.input.outboxId,
				]).changes,
		);
		let restoreRequired = true;
		const restoreMac = (): void => {
			if (!restoreRequired) return;
			const restored = f.store.write(
				(tx) =>
					tx.run("UPDATE main.native_send_attempts SET mac=? WHERE outbox_id=?", [
						originalMac,
						issued.input.outboxId,
					]).changes,
			);
			expect(restored).toBe(1);
			restoreRequired = false;
		};
		expectedDrainFailures.add(transport);
		try {
			expect(changed).toBe(1);
			const draining = transport.drain();
			expect(transport.drain()).toBe(draining);
			await expect(draining).rejects.toBeInstanceOf(http.NativeSendHttpError);
			await expect(draining).rejects.toMatchObject({ code: "SEND_HTTP_UNAVAILABLE" });
			restoreMac();
			const auditCount = f.store.read(
				(db) => db.get<{ n: number }>("SELECT count(*) n FROM main.audit_events")?.n,
			);
			expect(typeof auditCount).toBe("number");
			await expect(transport.drain()).rejects.toBeInstanceOf(http.NativeSendHttpError);
			expect(f.ledger.getAttempt(issued.input.outboxId)?.state).toBe("SENDING");
			expect(
				f.store.read((db) => db.get<{ n: number }>("SELECT count(*) n FROM main.audit_events")?.n),
			).toBe(auditCount);
			expect(upstream.requests()).toBe(1);
		} finally {
			restoreMac();
			transport.close();
			await Promise.allSettled([transport.drain()]);
		}
	});

	it.each(["wall", "monotonic"] as const)(
		"cleans admitted resources when the initial %s clock read throws",
		async (kind) => {
			const f = await fixture(),
				issued = f.issue(),
				controller = new AbortController();
			let resolutions = 0,
				dials = 0;
			const clock: TimerClock = {
				wallMs: () => {
					if (kind === "wall") throw new Error("Synthetic initial wall failure");
					return systemClock.wallMs();
				},
				monotonicMs: () => {
					if (kind === "monotonic") throw new Error("Synthetic initial monotonic failure");
					return systemClock.monotonicMs();
				},
				after: (ms, signal) => systemClock.after(ms, signal),
			};
			const transport = f.transport({ clock });
			const pending = withNetworkTestHooks(
				{
					resolve: async () => {
						resolutions++;
						return [{ address: "8.8.8.8", family: 4 }];
					},
					dial: () => {
						dials++;
						throw new Error("Synthetic unexpected clock-failure dial");
					},
				},
				() => transport.send(issued.redemption, controller.signal),
			);
			await expect(pending).rejects.toBeInstanceOf(http.NativeSendHttpError);
			await transport.drain();
			expect(getEventListeners(controller.signal, "abort")).toHaveLength(0);
			expect(resolutions).toBe(0);
			expect(dials).toBe(0);
		},
	);
});
