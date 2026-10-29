import { randomBytes } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { createServer } from "node:https";
import type { AddressInfo, Socket } from "node:net";
import os from "node:os";
import path from "node:path";
import {
	HOST_MAX_ACTIVE_REQUESTS,
	HOST_MAX_STREAM_BYTES,
	HOST_REQUEST_TIMEOUT_MS,
	type HostNotification,
	HostStreamChunk,
} from "@draftyak/protocol/host-channel";
import { MAX_INLINE_BYTES } from "@draftyak/protocol/normalized-change";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { AuditChain } from "../../../src/audit/chain.ts";
import { type CredentialBinding, CredentialVault } from "../../../src/credentials/vault.ts";
import { newId } from "../../../src/kernel/ids.ts";
import { MasterKey } from "../../../src/kernel/master-key.ts";
import { createBuiltinAiProfileRegistry } from "../../../src/plugins/broker/ai/index.ts";
import type { EgressPolicy, PinnedAddress } from "../../../src/plugins/broker/network/index.ts";
import {
	type NetworkTestHooks,
	withNetworkTestHooks,
} from "../../../src/plugins/broker/network/test-context.ts";
import {
	createProviderHttpBroker,
	ProviderHttpError,
	type ProviderStreamSink,
} from "../../../src/plugins/broker/provider-http.ts";
import { HubStore } from "../../../src/store/store.ts";
import { migrations, nativeBinding } from "../../store/helpers.ts";
import { createTlsFixture } from "./tls-fixture.ts";

let tls: Awaited<ReturnType<typeof createTlsFixture>>;
const cleanups: (() => void | Promise<void>)[] = [];
beforeAll(async () => {
	tls = await createTlsFixture();
});

afterEach(async () => {
	vi.restoreAllMocks();
	for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});
const pin = { address: "8.8.8.8", family: 4 as const };
const policy: EgressPolicy = { deniedAddresses: [], deniedPorts: [] };
const deferred = <T>() => {
	let resolve: (value: T) => void = () => undefined;
	const promise = new Promise<T>((yes) => {
		resolve = yes;
	});
	return { resolve, promise };
};
function inputs() {
	const draft = {
		model: "model-2026-01",
		system: "DYTEST-system",
		prompt: "DYTEST-prompt",
		contextIds: ["c1"],
	};
	const body = {
		model: draft.model,
		messages: [
			{ role: "system", content: draft.system },
			{ role: "user", content: draft.prompt },
		],
		response_format: { type: "json_object" },
		stream: false,
	};
	const endpoint = "https://guard.example/v1/chat/completions";
	return {
		body,
		candidate: {
			method: "POST",
			url: endpoint,
			headers: [["content-type", "application/json"]],
			body: Buffer.from(JSON.stringify(body)),
		},
		binding: {
			draft,
			endpoint,
			settings: { kind: "compatible", format: "json_object", allowPlaintextLan: false },
		},
	};
}
async function fixture(networkPolicy: EgressPolicy = policy) {
	const dir = mkdtempSync(path.join(os.tmpdir(), "draftyak-provider-http-"));
	const key = new MasterKey(randomBytes(32)),
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
			credentials: path.resolve(import.meta.dirname, "../../../src/credentials/migrations"),
		},
	});
	await store.migrate("audit");
	await store.migrate("credentials");
	const vault = new CredentialVault(store, audit),
		secret = `DYTEST-${randomBytes(20).toString("hex")}`;
	const credential: CredentialBinding = {
		ownerKind: "provider",
		ownerId: newId(),
		kind: "provider-key",
	};
	const reference = store.write((tx) =>
		vault.createInTransaction(tx, credential, { kind: "provider-key", key: secret }),
	);
	const broker = createProviderHttpBroker({
		vault,
		registry: createBuiltinAiProfileRegistry(),
		networkPolicy,
	});
	cleanups.push(() => {
		broker.close();
		store.close();
		audit.destroy();
		key.destroy();
		rmSync(dir, { recursive: true, force: true });
	});
	const execute = (
		input = inputs(),
		signal = new AbortController().signal,
		owner: CredentialBinding = credential,
	) =>
		broker.execute("chat-completions-v1", input.candidate, input.binding, reference, owner, signal);
	return { broker, vault, store, secret, credential, reference, execute };
}
async function peer(
	reply: (req: IncomingMessage, response: ServerResponse) => void,
	certificate = tls.cert,
	bind = "127.0.0.1",
) {
	const sockets = new Set<Socket>();
	const seen = {
		connections: 0,
		httpBytes: 0,
		bodies: [] as string[],
		headers: [] as IncomingMessage["headers"][],
	};
	const server = createServer({ key: tls.key, cert: certificate }, (req, response) => {
		const chunks: Buffer[] = [];
		req.on("data", (chunk: Buffer) => chunks.push(chunk));
		req.once("end", () => {
			seen.bodies.push(Buffer.concat(chunks).toString());
			seen.headers.push(req.headers);
			reply(req, response);
		});
	});
	server.on("connection", (socket) => {
		seen.connections++;
		sockets.add(socket);
		socket.once("close", () => sockets.delete(socket));
	});
	server.on("secureConnection", (socket) =>
		socket.on("data", (chunk: Buffer) => {
			seen.httpBytes += chunk.length;
		}),
	);
	await new Promise<void>((resolve, reject) => {
		server.once("error", reject);
		server.listen(0, bind, resolve);
	});
	const port = (server.address() as AddressInfo).port;
	cleanups.push(async () => {
		const stopped = new Promise<void>((resolve, reject) =>
			server.close((error) => (error ? reject(error) : resolve())),
		);
		for (const socket of sockets) socket.destroy();
		await stopped;
	});
	return { port, seen };
}
function hooks(port: number, extra: Partial<NetworkTestHooks> = {}): NetworkTestHooks {
	return {
		ca: tls.ca,
		resolve: async () => [pin],
		dial: (checked, requestedPort) => {
			expect(checked).toEqual(pin);
			expect(requestedPort).toBe(443);
			return { address: "127.0.0.1", family: 4, port };
		},
		...extra,
	};
}

describe("native provider HTTP transport", () => {
	it("connects to a permitted IPv6 literal with its IP SAN and bracketed HTTP authority", async () => {
		const f = await fixture({ ...policy, allowLocal: true }),
			input = inputs();
		const remote = await peer((_, response) => response.end("DYTEST-ipv6"), tls.ipCert, "::1");
		input.candidate.url = "https://[::1]/v1/chat/completions";
		input.binding.endpoint = input.candidate.url;
		const result = await withNetworkTestHooks(
			{
				ca: tls.ca,
				dial: (checked, port) => {
					expect(checked).toEqual({ address: "::1", family: 6 });
					expect(port).toBe(443);
					return { address: "::1", family: 6, port: remote.port };
				},
			},
			() => f.execute(input),
		);
		expect(result.status).toBe(200);
		expect(remote.seen.headers[0]?.host).toBe("[::1]");
		expect(remote.seen.bodies).toEqual([JSON.stringify(input.body)]);
	});
	it.each([200, 400, 429, 503])(
		"returns useful HTTP %s without exposing credentials",
		async (status) => {
			const f = await fixture(),
				input = inputs();
			const remote = await peer((_, response) => {
				response.writeHead(status, {
					"content-type": "application/json",
					"retry-after": "7",
					"x-private": "DYTEST-omitted",
				});
				response.end('{"result":"DYTEST-result"}');
			});
			const result = await withNetworkTestHooks(hooks(remote.port), () => f.execute(input));
			expect(result.status).toBe(status);
			expect(result.headers).toEqual([
				["content-type", "application/json"],
				["retry-after", "7"],
			]);
			const bytes = result.body && "base64" in result.body ? result.body.base64 : "";
			expect(Buffer.from(bytes, "base64url").toString()).toBe('{"result":"DYTEST-result"}');
			expect(remote.seen.headers[0]).toMatchObject({
				authorization: `Bearer ${f.secret}`,
				host: "guard.example",
				"accept-encoding": "identity",
			});
			expect(remote.seen.bodies).toEqual([JSON.stringify(input.body)]);
			expect(JSON.stringify(result)).not.toContain(f.secret);
		},
	);
	it("retains captured request, prompt and credential binding across a delayed DNS result", async () => {
		const f = await fixture(),
			input = inputs(),
			expected = input.candidate.body.toString();
		const gate = deferred<readonly PinnedAddress[]>(),
			started = deferred<void>();
		const remote = await peer((_, response) => response.end("DYTEST-snapshot"));
		const pending = withNetworkTestHooks(
			hooks(remote.port, {
				resolve: async () => {
					started.resolve();
					return gate.promise;
				},
			}),
			() => f.execute(input),
		);
		await started.promise;
		input.candidate.body.fill(0);
		input.candidate.url = "https://changed.example/v1/chat/completions";
		input.candidate.headers[0] = ["authorization", "changed"];
		input.binding.draft.prompt = "DYTEST-changed";
		input.binding.endpoint = input.candidate.url;
		input.binding.settings.format = "ollama";
		Object.assign(f.credential, { ownerId: newId() });
		gate.resolve([pin]);
		await expect(pending).resolves.toMatchObject({ status: 200 });
		expect(remote.seen.bodies).toEqual([expected]);
		expect(remote.seen.headers[0]?.authorization).toBe(`Bearer ${f.secret}`);
	});
	it.each(["untrusted", "wrong-host"])(
		"sends no credential headers or body before %s TLS refusal",
		async (mode) => {
			const f = await fixture(),
				remote = await peer(
					(_, response) => response.end("unsafe"),
					mode === "wrong-host" ? tls.ipCert : tls.cert,
				);
			await expect(
				withNetworkTestHooks(hooks(remote.port, { ca: mode === "untrusted" ? "" : tls.ca }), () =>
					f.execute(),
				),
			).rejects.toThrow(ProviderHttpError);
			expect(remote.seen.connections).toBe(1);
			expect(remote.seen.httpBytes).toBe(0);
			expect(remote.seen.headers).toEqual([]);
			expect(remote.seen.bodies).toEqual([]);
		},
	);
	it.each(["loopback", "mixed", "native-denied"])(
		"refuses %s DNS destinations before opening a socket",
		async (mode) => {
			const f = await fixture(
				mode === "native-denied" ? { ...policy, deniedAddresses: [pin.address] } : policy,
			);
			const dial = vi.fn();
			const answers: readonly PinnedAddress[] =
				mode === "loopback"
					? [{ address: "127.0.0.1", family: 4 }]
					: mode === "mixed"
						? [pin, { address: "127.0.0.1", family: 4 }]
						: [pin];
			await expect(
				withNetworkTestHooks({ resolve: async () => answers, dial }, () => f.execute()),
			).rejects.toThrow(ProviderHttpError);
			expect(dial).not.toHaveBeenCalled();
		},
	);
	it("opens no socket when the body diverges from the pinned prompt", async () => {
		const f = await fixture(),
			input = inputs(),
			dial = vi.fn();
		input.body.messages[1] = { role: "user", content: "DYTEST-unpinned" };
		input.candidate.body = Buffer.from(JSON.stringify(input.body));
		await expect(
			withNetworkTestHooks({ resolve: async () => [pin], dial }, () => f.execute(input)),
		).rejects.toThrow(ProviderHttpError);
		expect(dial).not.toHaveBeenCalled();
	});
	it("refuses wrong credential owners and account token roles before any connection", async () => {
		const f = await fixture(),
			dial = vi.fn();
		const other: CredentialBinding = { ...f.credential, ownerId: newId() };
		const account: CredentialBinding = {
			ownerKind: "account",
			ownerId: newId(),
			kind: "slack-token",
		};
		for (const owner of [other, account]) {
			await expect(
				withNetworkTestHooks({ resolve: async () => [pin], dial }, () =>
					f.execute(inputs(), new AbortController().signal, owner),
				),
			).rejects.toThrow(ProviderHttpError);
		}
		expect(dial).not.toHaveBeenCalled();
	});
	it("refuses accessor credential bindings without evaluating caller code", async () => {
		const f = await fixture(),
			dial = vi.fn();
		let reads = 0;
		const owner = Object.defineProperty({ ...f.credential }, "ownerId", {
			get() {
				reads++;
				return f.credential.ownerId;
			},
			enumerable: true,
		});
		await expect(
			withNetworkTestHooks({ resolve: async () => [pin], dial }, () =>
				f.execute(inputs(), new AbortController().signal, owner),
			),
		).rejects.toThrow(ProviderHttpError);
		expect(reads).toBe(0);
		expect(dial).not.toHaveBeenCalled();
	});
	it.each(["body", "header"])(
		"refuses exact credential echoes in the response %s",
		async (location) => {
			const f = await fixture();
			const remote = await peer((_, response) => {
				if (location === "header") response.setHeader("x-unused", f.secret);
				response.end(location === "body" ? `DYTEST-prefix ${f.secret} suffix` : "DYTEST-safe");
			});
			const error = await withNetworkTestHooks(hooks(remote.port), () => f.execute()).catch(
				(error: unknown) => error,
			);
			expect(error).toBeInstanceOf(ProviderHttpError);
			expect(error).toMatchObject({ message: "Provider request unavailable" });
			expect(error).not.toHaveProperty("cause");
		},
	);
	it.each(["redirect", "compression", "headers"])(
		"refuses %s without following or expanding it",
		async (mode) => {
			const f = await fixture();
			const remote = await peer((_, response) => {
				if (mode === "redirect") response.writeHead(302, { location: "https://redirect.example/" });
				if (mode === "compression") response.setHeader("content-encoding", "gzip");
				if (mode === "headers") response.setHeader("x-long", "x".repeat(17_000));
				response.end("DYTEST-refused");
			});
			await expect(withNetworkTestHooks(hooks(remote.port), () => f.execute())).rejects.toThrow(
				ProviderHttpError,
			);
			expect(remote.seen.connections).toBe(1);
		},
	);
	it("accepts exactly the inline protocol byte limit", async () => {
		const f = await fixture();
		const remote = await peer((_, response) => response.end(Buffer.alloc(MAX_INLINE_BYTES, 120)));
		const result = await withNetworkTestHooks(hooks(remote.port), () => f.execute());
		const bytes = result.body && "base64" in result.body ? result.body.base64 : "";
		expect(Buffer.from(bytes, "base64url").length).toBe(MAX_INLINE_BYTES);
	});
	it("refuses the first byte beyond the inline limit before the server finishes its stream", async () => {
		const f = await fixture();
		let completed = false;
		const remote = await peer((_, response) => {
			response.write(Buffer.alloc(MAX_INLINE_BYTES + 1, 120));
			const timer = setTimeout(() => {
				completed = true;
				response.end();
			}, 750);
			response.once("close", () => clearTimeout(timer));
		});
		await expect(withNetworkTestHooks(hooks(remote.port), () => f.execute())).rejects.toThrow(
			ProviderHttpError,
		);
		expect(completed).toBe(false);
	});
	it.each(["revoke", "abort", "close"])(
		"cancels an active TLS response on %s and rejects its partial body",
		async (cause) => {
			const f = await fixture(),
				started = deferred<void>(),
				stopped = deferred<void>(),
				external = new AbortController();
			const remote = await peer((_, response) => {
				response.on("close", () => stopped.resolve());
				response.write("DYTEST-partial");
				started.resolve();
			});
			const result = withNetworkTestHooks(hooks(remote.port), () =>
				f.execute(inputs(), external.signal),
			);
			const rejection = expect(result).rejects.toThrow(ProviderHttpError);
			await started.promise;
			if (cause === "revoke")
				f.store.write((tx) =>
					f.vault.invalidateInTransaction(tx, f.reference, f.credential, "revoke"),
				);
			if (cause === "abort") external.abort();
			if (cause === "close") f.broker.close();
			await rejection;
			await stopped.promise;
		},
	);
	it("enforces the configured request deadline on a real stalled TLS response", async () => {
		const f = await fixture(),
			remote = await peer((_, response) => response.write("DYTEST-partial"));
		const nativeSetTimeout = globalThis.setTimeout;
		let armed = 0;
		vi.spyOn(globalThis, "setTimeout").mockImplementation(((handler: () => void, delay: number) => {
			if (delay === HOST_REQUEST_TIMEOUT_MS) {
				armed++;
				return nativeSetTimeout(handler, 500);
			}
			return nativeSetTimeout(handler, delay);
		}) as typeof setTimeout);
		await expect(withNetworkTestHooks(hooks(remote.port), () => f.execute())).rejects.toThrow(
			ProviderHttpError,
		);
		expect(armed).toBe(1);
		expect(remote.seen.headers).toHaveLength(1);
	});
	it("cancels a misbound invocation waiting behind a real credential refresh without waiting for its adapter", async () => {
		const f = await fixture(),
			started = deferred<void>(),
			gate = deferred<void>();
		const owner: CredentialBinding = {
			ownerKind: "account",
			ownerId: newId(),
			kind: "gmail-oauth",
		};
		const value = {
			kind: "gmail-oauth" as const,
			accessToken: "DYTEST-access",
			refreshToken: "DYTEST-refresh",
			expiresAt: 0,
		};
		const reference = f.store.write((tx) => f.vault.createInTransaction(tx, owner, value));
		const refresh = f.vault.withCredential(
			reference,
			owner,
			{
				requestClass: "read",
				refresh: async () => {
					started.resolve();
					await gate.promise;
					return { ...value, expiresAt: Date.now() + 60_000 };
				},
			},
			() => "owner",
		);
		await started.promise;
		const input = inputs();
		const pending = withNetworkTestHooks({ resolve: async () => [pin] }, () =>
			f.broker.execute(
				"chat-completions-v1",
				input.candidate,
				input.binding,
				reference,
				f.credential,
				new AbortController().signal,
			),
		).catch((error: unknown) => error);
		await new Promise<void>((resolve) => setImmediate(resolve));
		f.broker.close();
		let timeout: ReturnType<typeof setTimeout> | undefined;
		const result = await Promise.race([
			pending.then((error) => ({ settled: true, error })),
			new Promise<{ settled: false; error?: unknown }>((resolve) => {
				timeout = setTimeout(() => resolve({ settled: false }), 1000);
			}),
		]);
		if (timeout) clearTimeout(timeout);
		gate.resolve();
		await refresh;
		await pending;
		expect(result.settled).toBe(true);
		expect(result.error).toBeInstanceOf(ProviderHttpError);
	});
	it("bounds concurrent DNS waits and permanently closes native admission", async () => {
		const f = await fixture(),
			gate = deferred<readonly PinnedAddress[]>();
		const controllers = Array.from(
			{ length: HOST_MAX_ACTIVE_REQUESTS },
			() => new AbortController(),
		);
		const runs = controllers.map((controller) =>
			withNetworkTestHooks({ resolve: () => gate.promise }, () =>
				f.execute(inputs(), controller.signal),
			).catch((error: unknown) => error),
		);
		await expect(f.execute()).rejects.toThrow(ProviderHttpError);
		f.broker.close();
		gate.resolve([pin]);
		const errors = await Promise.all(runs);
		expect(errors.every((error) => error instanceof ProviderHttpError)).toBe(true);
		await expect(f.execute()).rejects.toThrow(ProviderHttpError);
	});
});

describe("native provider stream lifecycle", () => {
	function stream(f: Awaited<ReturnType<typeof fixture>>, port: number, sink: ProviderStreamSink) {
		const input = inputs();
		return withNetworkTestHooks(hooks(port), () =>
			f.broker.stream(
				"chat-completions-v1",
				input.candidate,
				input.binding,
				f.reference,
				f.credential,
				new AbortController().signal,
				sink,
			),
		);
	}
	it.each(["cancel", "revoke", "close", "deadline"])(
		"closes a real idle socket on %s after the prior output acknowledgment completed",
		async (cause) => {
			const f = await fixture(),
				first = deferred<void>(),
				stopped = deferred<void>();
			const remote = await peer((_, response) => {
				response.once("close", () => stopped.resolve());
				response.write(Buffer.alloc(4096, 120));
			});
			if (cause === "deadline") {
				const nativeSetTimeout = globalThis.setTimeout;
				vi.spyOn(globalThis, "setTimeout").mockImplementation(((
					handler: () => void,
					delay: number,
				) =>
					nativeSetTimeout(
						handler,
						delay === HOST_REQUEST_TIMEOUT_MS ? 500 : delay,
					)) as typeof setTimeout);
			}
			const handle = stream(f, remote.port, async () => {
				first.resolve();
			});
			await handle.response;
			handle.start();
			await first.promise;
			await new Promise<void>((resolve) => setImmediate(resolve));
			await new Promise<void>((resolve) => setImmediate(resolve));
			const rejected = expect(handle.completion).rejects.toThrow(ProviderHttpError);
			if (cause === "cancel") handle.cancel();
			if (cause === "close") f.broker.close();
			if (cause === "revoke")
				f.store.write((tx) =>
					f.vault.invalidateInTransaction(tx, f.reference, f.credential, "revoke"),
				);
			await rejected;
			let timeout: ReturnType<typeof setTimeout> | undefined;
			const closed = await Promise.race([
				stopped.promise.then(() => true),
				new Promise<boolean>((resolve) => {
					timeout = setTimeout(() => resolve(false), 1000);
				}),
			]);
			if (timeout) clearTimeout(timeout);
			expect(closed).toBe(true);
		},
	);
	it("keeps the credential lease until the terminal notification acknowledgment", async () => {
		const f = await fixture(),
			terminal = deferred<void>(),
			acknowledgment = deferred<void>();
		const remote = await peer((_, response) => response.end("DYTEST-finished"));
		let signal: AbortSignal | undefined,
			completed = false;
		const handle = stream(f, remote.port, async (notification, useSignal) => {
			if (notification.method === "host/stream.chunk" && notification.params.done) {
				signal = useSignal;
				terminal.resolve();
				await acknowledgment.promise;
			}
		});
		await handle.response;
		handle.start();
		await terminal.promise;
		void handle.completion.then(
			() => {
				completed = true;
			},
			() => {
				completed = true;
			},
		);
		await new Promise<void>((resolve) => setImmediate(resolve));
		expect(completed).toBe(false);
		const rejected = expect(handle.completion).rejects.toThrow(ProviderHttpError);
		f.store.write((tx) => f.vault.invalidateInTransaction(tx, f.reference, f.credential, "revoke"));
		await rejected;
		expect(signal?.aborted).toBe(true);
		acknowledgment.resolve();
	});
	it("delivers a fixed terminal error after start when upstream fails after headers but before start", async () => {
		const f = await fixture(),
			destroy = deferred<void>(),
			stopped = deferred<void>();
		const remote = await peer((_, response) => {
			response.flushHeaders();
			response.once("close", () => stopped.resolve());
			void destroy.promise.then(() => response.destroy());
		});
		const notifications: HostNotification[] = [];
		const handle = stream(f, remote.port, async (notification) => {
			notifications.push(notification);
		});
		await handle.response;
		destroy.resolve();
		await stopped.promise;
		await new Promise<void>((resolve) => setImmediate(resolve));
		expect(notifications).toEqual([]);
		handle.start();
		await expect(handle.completion).rejects.toThrow(ProviderHttpError);
		expect(notifications).toHaveLength(1);
		expect(notifications[0]?.params).toMatchObject({
			sequence: 0,
			base64: "",
			done: true,
			error: "DENIED",
		});
	});
	it("sends nothing before start and waits for each output acknowledgment", async () => {
		const f = await fixture(),
			first = deferred<void>(),
			acknowledgment = deferred<void>();
		const remote = await peer((_, response) => response.end(Buffer.alloc(160_000, 120)));
		const notifications: HostNotification[] = [];
		const handle = stream(f, remote.port, async (notification) => {
			notifications.push(notification);
			first.resolve();
			if (notifications.length === 1) await acknowledgment.promise;
		});
		const result = await handle.response;
		expect(result.streamId).toBeTypeOf("string");
		expect(result).not.toHaveProperty("body");
		await new Promise<void>((resolve) => setImmediate(resolve));
		expect(notifications).toEqual([]);
		handle.start();
		await first.promise;
		await new Promise<void>((resolve) => setImmediate(resolve));
		expect(notifications).toHaveLength(1);
		acknowledgment.resolve();
		await handle.completion;
		let bytes = 0;
		for (const [index, notification] of notifications.entries()) {
			if (notification.method !== "host/stream.chunk") throw new Error("Unexpected notification");
			const chunk = HostStreamChunk.parse(notification.params),
				decoded = Buffer.from(chunk.base64, "base64url");
			expect(chunk.sequence).toBe(index);
			expect(chunk.streamId).toBe(result.streamId);
			expect(decoded.length).toBeLessThanOrEqual(MAX_INLINE_BYTES);
			bytes += decoded.length;
		}
		expect(bytes).toBe(160_000);
		expect(notifications.at(-1)?.params).toMatchObject({ done: true });
	});
	it("holds the generation lease through a paused sink and aborts on replacement", async () => {
		const f = await fixture(),
			first = deferred<void>(),
			acknowledgment = deferred<void>(),
			stopped = deferred<void>();
		const remote = await peer((_, response) => {
			response.once("close", () => stopped.resolve());
			response.end(Buffer.alloc(160_000, 120));
		});
		let calls = 0,
			observed: AbortSignal | undefined;
		const handle = stream(f, remote.port, async (_, signal) => {
			calls++;
			observed = signal;
			first.resolve();
			await acknowledgment.promise;
		});
		await handle.response;
		handle.start();
		await first.promise;
		const rejected = expect(handle.completion).rejects.toThrow(ProviderHttpError);
		f.store.write((tx) =>
			f.vault.replaceInTransaction(tx, f.reference, f.credential, {
				kind: "provider-key",
				key: "DYTEST-replaced",
			}),
		);
		await rejected;
		await stopped.promise;
		expect(observed?.aborted).toBe(true);
		expect(calls).toBe(1);
		acknowledgment.resolve();
		expect(f.vault.describe(f.reference, f.credential).generation).toBe(2);
	});
	it.each(["cancel", "close"])(
		"settles and releases admission when a sink ignores %s",
		async (cause) => {
			const f = await fixture();
			const remote = await peer((_, response) => response.write(Buffer.alloc(80_000, 120)));
			for (
				let index = 0;
				index < (cause === "cancel" ? HOST_MAX_ACTIVE_REQUESTS + 1 : 1);
				index++
			) {
				const first = deferred<void>(),
					acknowledgment = deferred<void>();
				const handle = stream(f, remote.port, async () => {
					first.resolve();
					await acknowledgment.promise;
				});
				await handle.response;
				handle.start();
				await first.promise;
				const rejected = expect(handle.completion).rejects.toThrow(ProviderHttpError);
				if (cause === "cancel") handle.cancel();
				else f.broker.close();
				await rejected;
				acknowledgment.resolve();
			}
			expect(remote.seen.connections).toBe(cause === "cancel" ? HOST_MAX_ACTIVE_REQUESTS + 1 : 1);
		},
	);
	it("bounds waiting for start by the total deadline without early notifications", async () => {
		const f = await fixture(),
			stopped = deferred<void>();
		const remote = await peer((_, response) => {
			response.once("close", () => stopped.resolve());
			response.write(Buffer.alloc(80_000, 120));
		});
		const nativeSetTimeout = globalThis.setTimeout;
		vi.spyOn(globalThis, "setTimeout").mockImplementation(((handler: () => void, delay: number) =>
			nativeSetTimeout(
				handler,
				delay === HOST_REQUEST_TIMEOUT_MS ? 500 : delay,
			)) as typeof setTimeout);
		const notifications: HostNotification[] = [];
		const handle = stream(f, remote.port, async (notification) => {
			notifications.push(notification);
		});
		await handle.response;
		await expect(handle.completion).rejects.toThrow(ProviderHttpError);
		await stopped.promise;
		expect(notifications).toEqual([]);
	});
	it("refuses a credential split across TCP and output chunk boundaries", async () => {
		const f = await fixture(),
			first = deferred<void>();
		const prefix = "x".repeat(80_000),
			split = Math.floor(f.secret.length / 2);
		const remote = await peer((_, response) => {
			response.write(prefix + f.secret.slice(0, split));
			void first.promise.then(() => response.end(f.secret.slice(split)));
		});
		const notifications: HostNotification[] = [];
		let emitted = 0;
		const handle = stream(f, remote.port, async (notification) => {
			notifications.push(notification);
			if (notification.method === "host/stream.chunk")
				emitted += Buffer.from(notification.params.base64, "base64url").length;
			if (emitted >= prefix.length + split - (f.secret.length - 1)) first.resolve();
		});
		await handle.response;
		handle.start();
		await expect(handle.completion).rejects.toThrow(ProviderHttpError);
		const chunks = notifications.map((notification) => {
			if (notification.method !== "host/stream.chunk") throw new Error("Unexpected notification");
			return notification.params;
		});
		const actual = chunks
			.map((chunk) => Buffer.from(chunk.base64, "base64url").toString())
			.join("");
		expect(actual).not.toContain(f.secret);
		expect(actual).not.toContain(f.secret.slice(0, split));
		expect(chunks.at(-1)).toMatchObject({ done: true, error: "DENIED", base64: "" });
	});
	it.each([HOST_MAX_STREAM_BYTES, HOST_MAX_STREAM_BYTES + 1])(
		"enforces the actual total stream byte boundary at %s",
		async (size) => {
			const f = await fixture();
			const remote = await peer((_, response) => response.end(Buffer.alloc(size, 120)));
			let total = 0,
				terminal: unknown;
			const handle = stream(f, remote.port, async (notification) => {
				if (notification.method !== "host/stream.chunk") throw new Error("Unexpected notification");
				const chunk = HostStreamChunk.parse(notification.params);
				total += Buffer.from(chunk.base64, "base64url").length;
				if (chunk.done) terminal = chunk;
			});
			await handle.response;
			handle.start();
			if (size === HOST_MAX_STREAM_BYTES) {
				await handle.completion;
				expect(total).toBe(size);
				expect(terminal).toMatchObject({ done: true });
			} else {
				await expect(handle.completion).rejects.toThrow(ProviderHttpError);
				expect(total).toBeLessThanOrEqual(HOST_MAX_STREAM_BYTES);
				expect(terminal).toMatchObject({ done: true, error: "DENIED" });
			}
		},
	);
});
