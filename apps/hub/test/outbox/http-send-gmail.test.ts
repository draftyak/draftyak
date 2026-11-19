import { randomBytes } from "node:crypto";
import { getEventListeners } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { ClientRequest, type IncomingMessage, type ServerResponse } from "node:http";
import { createServer, type Server } from "node:https";
import os from "node:os";
import path from "node:path";
import { headersSha256, sha256Hex } from "@draftyak/protocol/hash";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type {
	CredentialBinding,
	CredentialRequest,
	CredentialUse,
	CredentialValue,
	CredentialVault,
} from "../../src/credentials/vault.ts";
import type { TimerClock } from "../../src/kernel/clock.ts";
import type {
	NativeHttpSendTransport,
	PendingNativeSendClassification,
} from "../../src/outbox/http-send.ts";
import type { SendTicketInsert } from "../../src/outbox/ticket-storage.ts";
import type { NetworkTestHooks } from "../../src/plugins/broker/network/test-context.ts";

let http: typeof import("../../src/outbox/http-send.ts");
let auditModule: typeof import("../../src/audit/chain.ts");
let vaultModule: typeof import("../../src/credentials/vault.ts");
let ids: typeof import("../../src/kernel/ids.ts");
let masterKeys: typeof import("../../src/kernel/master-key.ts");
let storageModule: typeof import("../../src/outbox/ticket-storage.ts");
let tickets: typeof import("../../src/outbox/tickets.ts");
let stores: typeof import("../../src/store/store.ts");
let hooksModule: typeof import("../../src/plugins/broker/network/test-context.ts");
let storeHelpers: typeof import("../store/helpers.ts");
let isolation: typeof import("../helpers/loopback-network.ts");
let tls: Awaited<ReturnType<typeof import("../plugins/broker/tls-fixture.ts").createTlsFixture>>;
const requests: string[] = [];
let afterActualRead: (() => void) | undefined;
const cleanup: (() => Promise<void>)[] = [];
const turn = () => new Promise<void>((resolve) => setImmediate(resolve));
const deferred = <T>() => Promise.withResolvers<T>();

beforeAll(async () => {
	vi.resetModules();
	isolation = await import("../helpers/loopback-network.ts");
	isolation.requireLoopbackNetworkGuard().assertActive();
	[
		auditModule,
		vaultModule,
		ids,
		masterKeys,
		storageModule,
		tickets,
		stores,
		hooksModule,
		storeHelpers,
	] = await Promise.all([
		import("../../src/audit/chain.ts"),
		import("../../src/credentials/vault.ts"),
		import("../../src/kernel/ids.ts"),
		import("../../src/kernel/master-key.ts"),
		import("../../src/outbox/ticket-storage.ts"),
		import("../../src/outbox/tickets.ts"),
		import("../../src/store/store.ts"),
		import("../../src/plugins/broker/network/test-context.ts"),
		import("../store/helpers.ts"),
	]);
	const prototype = vaultModule.CredentialVault.prototype;
	const descriptor = Object.getOwnPropertyDescriptor(prototype, "withCredential");
	if (!descriptor) throw new Error("missing credential operation");
	const original = prototype.withCredential;
	// Delegate to the unchanged real vault. Only observe class and schedule a real post-IO revoke.
	Object.defineProperty(prototype, "withCredential", {
		...descriptor,
		value: function <T>(
			this: CredentialVault,
			reference: string,
			owner: CredentialBinding,
			request: CredentialRequest,
			use: (value: CredentialValue, context: CredentialUse) => T | Promise<T>,
		): Promise<T> {
			requests.push(request.requestClass);
			return Reflect.apply(original, this, [
				reference,
				owner,
				request,
				async (value: CredentialValue, context: CredentialUse) => {
					const result = await use(value, context);
					if (request.requestClass === "read") afterActualRead?.();
					return result;
				},
			]);
		},
	});
	try {
		http = await import("../../src/outbox/http-send.ts");
	} finally {
		Object.defineProperty(prototype, "withCredential", descriptor);
	}
	const fixtures = await import("../plugins/broker/tls-fixture.ts");
	tls = await fixtures.createTlsFixture(["gmail.googleapis.com"]);
});
beforeEach(() => {
	isolation.requireLoopbackNetworkGuard().assertActive();
	requests.length = 0;
	afterActualRead = undefined;
});
afterEach(async () => {
	afterActualRead = undefined;
	const results = await Promise.allSettled(
		cleanup
			.splice(0)
			.reverse()
			.map((close) => close()),
	);
	isolation.requireLoopbackNetworkGuard().assertActive();
	const errors = results
		.filter((result) => result.status === "rejected")
		.map((result) => result.reason);
	if (errors.length) throw new AggregateError(errors, "fixture cleanup failed");
});
afterAll(() => {
	tls?.key.fill(0);
	// Discard the module that captured the temporary genuine-delegate observer.
	vi.resetModules();
});

async function fixture() {
	const dir = mkdtempSync(path.join(os.tmpdir(), "draftyak-gmail-completion-"));
	const key = new masterKeys.MasterKey(randomBytes(32));
	const auditKey = key.derive("audit");
	const audit = new auditModule.AuditChain(auditKey);
	auditKey.fill(0);
	const store = new stores.HubStore({
		filename: path.join(dir, "hub.db"),
		nativeBinding: storeHelpers.nativeBinding,
		masterKey: key,
		create: true,
		migrations: {
			audit: path.join(storeHelpers.migrations, "audit"),
			credentials: path.resolve(import.meta.dirname, "../../src/credentials/migrations"),
			tickets: path.resolve(import.meta.dirname, "../../src/outbox/migrations"),
		},
	});
	for (const namespace of ["audit", "credentials", "tickets"]) await store.migrate(namespace);
	const time = { wall: 1_800_000_000_000, mono: 10_000 };
	const clock = { wallMs: () => time.wall, monotonicMs: () => time.mono };
	const owner: CredentialBinding = {
		ownerKind: "account",
		ownerId: ids.newId(),
		kind: "gmail-oauth",
	};
	const secret = `DYTEST-${randomBytes(24).toString("hex")}`;
	const value = (): CredentialValue => ({
		kind: "gmail-oauth",
		accessToken: secret,
		refreshToken: `DYTEST-${randomBytes(24).toString("hex")}`,
		expiresAt: Date.now() + 60_000,
	});
	const vault = new vaultModule.CredentialVault(store, audit, key);
	const reference = store.write((tx) => vault.createInTransaction(tx, owner, value()));
	const ledger = new tickets.SendTicketLedger(store, audit, vault, key, clock);
	const storage = new storageModule.SendTicketStorage(store, audit, vault, key, clock);
	const transports: NativeHttpSendTransport[] = [];
	const servers: Server[] = [];
	cleanup.push(async () => {
		const errors: unknown[] = [];
		const attempt = async (operation: () => unknown | Promise<unknown>) => {
			try {
				await operation();
			} catch (error) {
				errors.push(error);
			}
		};
		for (const transport of transports) await attempt(() => transport.close());
		for (const transport of transports) await attempt(() => transport.drain());
		await attempt(() => vault.destroy());
		await attempt(() => vault.drain());
		for (const server of servers) {
			await attempt(() => server.closeAllConnections());
			await attempt(
				() =>
					new Promise<void>((resolve, reject) =>
						server.close((error) => (error ? reject(error) : resolve())),
					),
			);
		}
		await attempt(() => storage.destroy());
		await attempt(() => ledger.destroy());
		await attempt(() => store.close());
		await attempt(() => audit.destroy());
		await attempt(() => key.destroy());
		await attempt(() => {
			const parent = path.resolve(os.tmpdir()),
				resolved = path.resolve(dir);
			if (
				path.dirname(resolved) !== parent ||
				!path.basename(resolved).startsWith("draftyak-gmail-completion-")
			)
				throw new Error("fixture cleanup path refused");
			rmSync(resolved, { recursive: true, force: true });
		});
		if (errors.length) throw new AggregateError(errors, "fixture cleanup failed");
	});
	const contentType = `multipart/related; boundary="DYTEST-${randomBytes(12).toString("hex")}"`;
	const headers = [["content-type", contentType]] as const;
	const body = Buffer.from("DYTEST approved multipart bytes");
	const input: SendTicketInsert = {
		accountId: owner.ownerId,
		credentialReference: reference,
		credentialGeneration: 1,
		credentialKind: "gmail-oauth",
		epoch: 3,
		contentHash: sha256Hex("DYTEST approved snapshot"),
		flagsHash: sha256Hex("DYTEST approved flags"),
		notBefore: null,
		deliverBy: time.wall + 120_000,
		outboxId: ids.newId(),
		instanceId: ids.newId(),
		method: "POST",
		url: "https://gmail.googleapis.com/upload/gmail/v1/users/me/messages/send?uploadType=multipart",
		contentType,
		headers,
		body,
		approvedHeadersSha256: headersSha256(headers),
		approvedBodySha256: sha256Hex(body),
	};
	// Internal persistence setup exercises native IO completion; it grants no approval authority.
	const ticket = store.write((tx) => storage.insertInTransaction(tx, input));
	const redemption = ledger.redeem({
		ticket,
		instanceId: input.instanceId,
		method: input.method,
		url: input.url,
		contentType,
		headers,
		body,
	});
	const transport = (options: { clock?: TimerClock; classificationTimeoutMs?: number } = {}) => {
		const result = http.createNativeHttpSendTransport({
			ledger,
			vault,
			networkPolicy: { deniedAddresses: [], deniedPorts: [] },
			...options,
		});
		transports.push(result);
		return result;
	};
	const server = async (
		options: {
			status?: number;
			candidate?: string;
			metadata?: string;
			get?: (request: IncomingMessage, response: ServerResponse) => void;
		} = {},
	) => {
		const observed: {
			method: string | undefined;
			url: string | undefined;
			authorization: string | undefined;
		}[] = [];
		const upstream = createServer({ key: tls.key, cert: tls.cert }, (request, response) => {
			observed.push({
				method: request.method,
				url: request.url,
				authorization: request.headers.authorization,
			});
			request.resume();
			if (request.method === "GET" && options.get) options.get(request, response);
			else {
				response.statusCode = request.method === "POST" ? (options.status ?? 200) : 200;
				response.setHeader("content-type", "application/json");
				response.end(
					request.method === "POST"
						? (options.candidate ?? '{"id":"DYTEST-message"}')
						: (options.metadata ?? metadata()),
				);
			}
		});
		upstream.on("tlsClientError", () => undefined);
		servers.push(upstream);
		await new Promise<void>((resolve) => upstream.listen(0, "127.0.0.1", resolve));
		const address = upstream.address();
		if (!address || typeof address === "string") throw new Error("fixture bind failed");
		const hooks: NetworkTestHooks = {
			ca: tls.ca,
			resolve: async () => [{ address: "8.8.8.8", family: 4 }],
			dial: () => ({ address: "127.0.0.1", family: 4, port: address.port }),
		};
		return { hooks, observed };
	};
	return {
		input,
		owner,
		secret,
		vault,
		reference,
		ledger,
		storage,
		store,
		time,
		redemption,
		transport,
		server,
		revoke: () =>
			store.write((tx) => vault.invalidateInTransaction(tx, reference, owner, "revoke")),
		rotate: () => store.write((tx) => vault.replaceInTransaction(tx, reference, owner, value())),
	};
}

const literalMessageId = "literal different\r\n folded Message-ID value";
function metadata(providerId = "DYTEST-message"): string {
	return JSON.stringify({
		id: providerId,
		threadId: "DYTEST-thread",
		internalDate: "1800000000000",
		labelIds: ["SENT", "DYTEST-label"],
		sizeEstimate: 321,
		payload: { headers: [{ name: "Message-ID", value: literalMessageId }] },
	});
}
function pending(handle: ReturnType<typeof http.consumeNativeSendObservation>) {
	if (handle.kind !== "response") throw new Error("expected complete native response");
	return handle;
}
function delayedClock() {
	const time = { wall: Date.now(), mono: 10_000 };
	const clock: TimerClock = {
		wallMs: () => time.wall,
		monotonicMs: () => time.mono,
		after: (_ms, signal) =>
			new Promise<void>((_resolve, reject) => {
				if (signal?.aborted) reject(new Error("aborted timer"));
				else
					signal?.addEventListener("abort", () => reject(new Error("aborted timer")), {
						once: true,
					});
			}),
	};
	return {
		clock,
		advance: (ms: number) => {
			time.wall += ms;
			time.mono += ms;
		},
	};
}

describe("native Gmail receipt completion", () => {
	it("refuses a fabricated pending handle before any credential or network operation", async () => {
		await expect(
			http.completeNativeGmailSendClassification(
				Object.freeze(Object.create(null)) as PendingNativeSendClassification,
			),
		).rejects.toMatchObject({ code: "SEND_HTTP_UNAVAILABLE" });
		expect(requests).toEqual([]);
	});
	it("joins original bytes and account to one READ, persists literal receipt and consumes once", async () => {
		const f = await fixture(),
			upstream = await f.server(),
			transport = f.transport();
		const foreign: CredentialBinding = {
			ownerKind: "account",
			ownerId: ids.newId(),
			kind: "gmail-oauth",
		};
		f.store.write((tx) =>
			f.vault.createInTransaction(tx, foreign, {
				kind: "gmail-oauth",
				accessToken: `DYTEST-${randomBytes(24).toString("hex")}`,
				refreshToken: `DYTEST-${randomBytes(24).toString("hex")}`,
				expiresAt: Date.now() + 60_000,
			}),
		);
		await hooksModule.withNetworkTestHooks(upstream.hooks, async () => {
			const original = await transport.send(f.redemption, new AbortController().signal);
			const observation = pending(http.consumeNativeSendObservation(original));
			observation.body.fill(0);
			// A caller-supplied receiver cannot select a different real account for this handle.
			const completed = await Reflect.apply(http.completeNativeGmailSendClassification, foreign, [
				observation.pending,
			]);
			expect(completed.attempt.state).toBe("SENT");
			expect(completed.attempt.outboxId).toBe(f.input.outboxId);
			expect(completed.receipt?.message.providerId).toBe("DYTEST-message");
			expect(completed.receipt?.messageIdHeader).toBe(literalMessageId);
			expect(f.ledger.getAttempt(f.input.outboxId)?.state).toBe("SENT");
			expect(requests).toEqual(["send", "read"]);
			expect(upstream.observed).toEqual([
				{
					method: "POST",
					url: "/upload/gmail/v1/users/me/messages/send?uploadType=multipart",
					authorization: `Bearer ${f.secret}`,
				},
				{
					method: "GET",
					url: "/gmail/v1/users/me/messages/DYTEST-message?format=metadata",
					authorization: `Bearer ${f.secret}`,
				},
			]);
			await expect(
				http.completeNativeGmailSendClassification(observation.pending),
			).rejects.toMatchObject({ code: "SEND_HTTP_UNAVAILABLE" });
			expect(() => http.consumeNativeSendObservation(original)).toThrow(http.NativeSendHttpError);
			expect(upstream.observed).toHaveLength(2);
		});
	});
	it.each([{ status: 403 }, { status: 500 }, { candidate: '{"id":42}' }])(
		"keeps uncertain send response UNKNOWN without inferring no-effect: %j",
		async (options) => {
			const f = await fixture(),
				upstream = await f.server(options),
				transport = f.transport();
			await hooksModule.withNetworkTestHooks(upstream.hooks, async () => {
				const observation = pending(
					http.consumeNativeSendObservation(
						await transport.send(f.redemption, new AbortController().signal),
					),
				);
				const result = await http.completeNativeGmailSendClassification(observation.pending);
				expect(result).toMatchObject({ attempt: { state: "UNKNOWN" } });
				expect(result.receipt).toBeUndefined();
				expect(upstream.observed.map((request) => request.method)).toEqual(["POST"]);
			});
		},
	);
	it("keeps a mismatched metadata response UNKNOWN and never retries", async () => {
		const f = await fixture(),
			upstream = await f.server({ metadata: metadata("DYTEST-other") }),
			transport = f.transport();
		await hooksModule.withNetworkTestHooks(upstream.hooks, async () => {
			const observation = pending(
				http.consumeNativeSendObservation(
					await transport.send(f.redemption, new AbortController().signal),
				),
			);
			const result = await http.completeNativeGmailSendClassification(observation.pending);
			expect(result.attempt.state).toBe("UNKNOWN");
			expect(result.receipt).toBeUndefined();
			expect(upstream.observed.map((request) => request.method)).toEqual(["POST", "GET"]);
		});
	});
	it.each(["revoke", "rotate"] as const)(
		"refuses new READ after original credential %s",
		async (change) => {
			const f = await fixture(),
				upstream = await f.server(),
				transport = f.transport();
			await hooksModule.withNetworkTestHooks(upstream.hooks, async () => {
				const observation = pending(
					http.consumeNativeSendObservation(
						await transport.send(f.redemption, new AbortController().signal),
					),
				);
				f[change]();
				const result = await http.completeNativeGmailSendClassification(observation.pending);
				expect(result.attempt.state).toBe("UNKNOWN");
				expect(upstream.observed).toHaveLength(1);
			});
		},
	);
	it("records already completed IO after ticket expiry without minting another write", async () => {
		const f = await fixture(),
			upstream = await f.server(),
			transport = f.transport();
		await hooksModule.withNetworkTestHooks(upstream.hooks, async () => {
			const observation = pending(
				http.consumeNativeSendObservation(
					await transport.send(f.redemption, new AbortController().signal),
				),
			);
			f.time.wall += 121_000;
			f.time.mono += 121_000;
			const result = await http.completeNativeGmailSendClassification(observation.pending);
			expect(result.attempt.state).toBe("SENT");
			expect(upstream.observed.map((request) => request.method)).toEqual(["POST", "GET"]);
		});
	});
	it("preserves actual complete readback when the real vault post-check observes later revocation", async () => {
		const f = await fixture(),
			upstream = await f.server(),
			transport = f.transport();
		await hooksModule.withNetworkTestHooks(upstream.hooks, async () => {
			const observation = pending(
				http.consumeNativeSendObservation(
					await transport.send(f.redemption, new AbortController().signal),
				),
			);
			afterActualRead = () => {
				afterActualRead = undefined;
				f.revoke();
			};
			const result = await http.completeNativeGmailSendClassification(observation.pending);
			expect(result.attempt.state).toBe("SENT");
			expect(result.receipt?.messageIdHeader).toBe(literalMessageId);
			expect(() => f.vault.describe(f.reference, f.owner)).toThrow();
		});
	});
	it("checks classification deadline before READ even while its timer callback is delayed", async () => {
		const f = await fixture(),
			upstream = await f.server(),
			clock = delayedClock(),
			transport = f.transport({ clock: clock.clock });
		await hooksModule.withNetworkTestHooks(upstream.hooks, async () => {
			const observation = pending(
				http.consumeNativeSendObservation(
					await transport.send(f.redemption, new AbortController().signal),
				),
			);
			clock.advance(15_000);
			const result = await http.completeNativeGmailSendClassification(observation.pending);
			expect(result.attempt.state).toBe("UNKNOWN");
			expect(upstream.observed).toHaveLength(1);
		});
	});
	it("refuses a late completed READ after the same explicit classification deadline", async () => {
		const arrived = deferred<ServerResponse>();
		const f = await fixture(),
			upstream = await f.server({ get: (_request, response) => arrived.resolve(response) }),
			clock = delayedClock(),
			transport = f.transport({ clock: clock.clock });
		await hooksModule.withNetworkTestHooks(upstream.hooks, async () => {
			const observation = pending(
				http.consumeNativeSendObservation(
					await transport.send(f.redemption, new AbortController().signal),
				),
			);
			const completion = http.completeNativeGmailSendClassification(observation.pending);
			const response = await arrived.promise;
			clock.advance(15_000);
			response.end(metadata());
			expect((await completion).attempt.state).toBe("UNKNOWN");
			expect(f.ledger.getAttempt(f.input.outboxId)?.state).toBe("UNKNOWN");
		});
	});
	it("checks the classification deadline again after actual readback and before durable SENT", async () => {
		const f = await fixture(),
			upstream = await f.server(),
			clock = delayedClock(),
			transport = f.transport({ clock: clock.clock });
		await hooksModule.withNetworkTestHooks(upstream.hooks, async () => {
			const observation = pending(
				http.consumeNativeSendObservation(
					await transport.send(f.redemption, new AbortController().signal),
				),
			);
			afterActualRead = () => {
				afterActualRead = undefined;
				clock.advance(15_000);
			};
			const result = await http.completeNativeGmailSendClassification(observation.pending);
			expect(result.attempt.state).toBe("UNKNOWN");
			expect(result.receipt).toBeUndefined();
			expect(f.ledger.getAttempt(f.input.outboxId)?.state).toBe("UNKNOWN");
		});
	});
	it("abandon consumes the real pending handle and forbids subsequent completion", async () => {
		const f = await fixture(),
			upstream = await f.server(),
			transport = f.transport();
		await hooksModule.withNetworkTestHooks(upstream.hooks, async () => {
			const observation = pending(
				http.consumeNativeSendObservation(
					await transport.send(f.redemption, new AbortController().signal),
				),
			);
			http.abandonNativeSendClassification(observation.pending);
			await expect(
				http.completeNativeGmailSendClassification(observation.pending),
			).rejects.toMatchObject({ code: "SEND_HTTP_UNAVAILABLE" });
			expect(f.ledger.getAttempt(f.input.outboxId)?.state).toBe("UNKNOWN");
			expect(upstream.observed).toHaveLength(1);
		});
	});
	it("close cancels an admitted READ and drain joins its cleanup without a later SENT", async () => {
		const arrived = deferred<ServerResponse>();
		const f = await fixture(),
			upstream = await f.server({ get: (_request, response) => arrived.resolve(response) }),
			transport = f.transport();
		const signal = new AbortController().signal;
		await hooksModule.withNetworkTestHooks(upstream.hooks, async () => {
			const observation = pending(
				http.consumeNativeSendObservation(await transport.send(f.redemption, signal)),
			);
			const completion = http.completeNativeGmailSendClassification(observation.pending);
			const response = await arrived.promise;
			transport.close();
			const result = await Promise.allSettled([completion, transport.drain()]);
			expect(result[1]?.status).toBe("fulfilled");
			response.end(metadata());
			await turn();
			expect(f.ledger.getAttempt(f.input.outboxId)?.state).toBe("UNKNOWN");
			expect(getEventListeners(signal, "abort")).toHaveLength(0);
			expect(upstream.observed).toHaveLength(2);
		});
	});
	it("destroys and joins a genuine late response callback after abort before drain completes", async () => {
		const f = await fixture(),
			upstream = await f.server(),
			transport = f.transport();
		const prototype = ClientRequest.prototype;
		const descriptor = Object.getOwnPropertyDescriptor(prototype, "once");
		const original = prototype.once;
		const responseHeld = deferred<void>();
		let releaseResponse: (() => void) | undefined;
		const releaseClose: (() => void)[] = [];
		let destroyCalls = 0;
		let restoreResponse: (() => void) | undefined;
		Object.defineProperty(prototype, "once", {
			configurable: true,
			writable: true,
			value: function (
				this: ClientRequest,
				event: string | symbol,
				listener: (...args: unknown[]) => void,
			) {
				if (this.method !== "GET" || (event !== "response" && event !== "close"))
					return Reflect.apply(original, this, [event, listener]);
				return Reflect.apply(original, this, [
					event,
					(...args: unknown[]) => {
						if (event === "close") releaseClose.push(() => Reflect.apply(listener, this, args));
						else {
							const response = args[0] as IncomingMessage;
							const own = Object.getOwnPropertyDescriptor(response, "destroy");
							const destroy = response.destroy;
							Object.defineProperty(response, "destroy", {
								configurable: true,
								writable: true,
								value: (...values: unknown[]) => {
									destroyCalls++;
									return Reflect.apply(destroy, response, values);
								},
							});
							restoreResponse = () => {
								if (own) Object.defineProperty(response, "destroy", own);
								else Reflect.deleteProperty(response, "destroy");
							};
							releaseResponse = () => {
								releaseResponse = undefined;
								Reflect.apply(listener, this, args);
							};
							responseHeld.resolve();
						}
					},
				]);
			},
		});
		try {
			await hooksModule.withNetworkTestHooks(upstream.hooks, async () => {
				const observation = pending(
					http.consumeNativeSendObservation(
						await transport.send(f.redemption, new AbortController().signal),
					),
				);
				const completion = http.completeNativeGmailSendClassification(observation.pending);
				const completionResult = Promise.allSettled([completion]);
				await responseHeld.promise;
				transport.close();
				let drained = false;
				const drain = transport.drain().then(() => {
					drained = true;
				});
				await turn();
				expect(drained).toBe(false);
				const before = destroyCalls;
				releaseResponse?.();
				expect(destroyCalls).toBeGreaterThan(before);
				for (const close of releaseClose.splice(0)) close();
				await Promise.all([completionResult, drain]);
				expect(drained).toBe(true);
				expect(f.ledger.getAttempt(f.input.outboxId)?.state).toBe("UNKNOWN");
			});
		} finally {
			releaseResponse?.();
			for (const close of releaseClose.splice(0)) close();
			restoreResponse?.();
			if (descriptor) Object.defineProperty(prototype, "once", descriptor);
			else Reflect.deleteProperty(prototype, "once");
		}
		expect(Object.getOwnPropertyDescriptor(prototype, "once")).toEqual(descriptor);
	});
});
