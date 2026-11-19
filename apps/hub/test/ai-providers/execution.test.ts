import type { IncomingMessage, ServerResponse } from "node:http";
import { createServer } from "node:https";
import type { AddressInfo, Socket } from "node:net";
import { HostFetchParams, type HostStreamChunk } from "@draftyak/protocol/host-channel";
import { MAX_INLINE_BYTES } from "@draftyak/protocol/normalized-change";
import { hostFetch } from "@draftyak/sdk/fetch";
import { memoryHost } from "@draftyak/sdk/host";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
	openBoundedProviderStream,
	ProviderStreamBoundaryError,
} from "../../src/ai/providers/streaming.ts";
import { type CredentialBinding, CredentialVault } from "../../src/credentials/vault.ts";
import { newId } from "../../src/kernel/ids.ts";
import { createBuiltinAiProfileRegistry } from "../../src/plugins/broker/ai/index.ts";
import { withNetworkTestHooks } from "../../src/plugins/broker/network/test-context.ts";
import { createProviderHttpBroker } from "../../src/plugins/broker/provider-http.ts";
import { requireLoopbackNetworkGuard } from "../helpers/loopback-network.ts";
import { createTlsFixture } from "../plugins/broker/tls-fixture.ts";

const credentialFixture = vi.hoisted(() => ({ key: `DYTEST-${crypto.randomUUID()}` }));
vi.mock("../../src/credentials/vault.ts", async (importOriginal) => {
	const actual = await importOriginal<typeof import("../../src/credentials/vault.ts")>();
	const withCredential: typeof actual.CredentialVault.prototype.withCredential = async (
		reference,
		binding,
		request,
		use,
	) =>
		use(
			{ kind: "provider-key", key: credentialFixture.key },
			{ reference, binding, generation: 1, signal: request.signal ?? new AbortController().signal },
		);
	actual.CredentialVault.prototype.withCredential = withCredential;
	return { ...actual };
});

type BoundaryOptions = NonNullable<Parameters<typeof openBoundedProviderStream>[3]>;
type BoundedStream = ReturnType<typeof openBoundedProviderStream>;
type Progress = Readonly<{ bytes: number; events: number }>;
const cleanups: (() => void | Promise<void>)[] = [];
const deferred = <T>() => {
	let resolve: (value: T) => void = () => undefined;
	const promise = new Promise<T>((yes) => {
		resolve = yes;
	});
	return { promise, resolve };
};
let tls: Awaited<ReturnType<typeof createTlsFixture>>;
beforeAll(async () => {
	requireLoopbackNetworkGuard().assertActive();
	tls = await createTlsFixture(["guard.example"]);
});
afterEach(async () => {
	const failures: unknown[] = [];
	for (const close of cleanups.splice(0).reverse()) {
		try {
			await close();
		} catch (error) {
			failures.push(error);
		}
	}
	if (failures.length > 0) throw new AggregateError(failures, "DYTEST-stream-cleanup");
});

const endpoint = "https://guard.example/v1/chat/completions";
const draft = {
	model: "model-2026-01",
	system: "DYTEST-system",
	prompt: "DYTEST-prompt",
	contextIds: ["c1"],
};
const requestBody = {
	model: draft.model,
	messages: [
		{ role: "system", content: draft.system },
		{ role: "user", content: draft.prompt },
	],
	response_format: { type: "json_object" },
	stream: false,
};

function fixture(options: BoundaryOptions = {}, holdFirstAck = false) {
	// Only the credential callback is synthetic; the broker, wire chunks and SDK are real.
	// No Vault, key, store, draft-job authority or native process is constructed here.
	const vault = Object.create(CredentialVault.prototype) as CredentialVault;
	const broker = createProviderHttpBroker({
		vault,
		registry: createBuiltinAiProfileRegistry(),
		networkPolicy: { deniedAddresses: [], deniedPorts: [] },
	});
	const reference = newId();
	const credential: CredentialBinding = {
		ownerKind: "provider",
		ownerId: newId(),
		kind: "provider-key",
	};
	const streams: BoundedStream[] = [],
		originalStreams: ReturnType<typeof broker.stream>[] = [],
		deliveries: Promise<void>[] = [],
		notifications: HostStreamChunk[] = [],
		progress: Progress[] = [];
	const observedBroker: typeof broker = {
		...broker,
		stream: (...args) => {
			const original = Reflect.apply(broker.stream, broker, args) as ReturnType<
				typeof broker.stream
			>;
			originalStreams.push(original);
			return original;
		},
	};
	const firstAck = deferred<void>(),
		ackEntered = deferred<void>(),
		progressed = deferred<void>();
	let held = false;
	const host = memoryHost(async (method, raw, signal) => {
		if (method !== "host/fetch") throw new Error("DYTEST-unexpected-method");
		const params = HostFetchParams.parse(raw);
		if (!params.stream || !params.body || !("base64" in params.body))
			throw new Error("DYTEST-unexpected-body");
		const stream = openBoundedProviderStream(
			observedBroker,
			[
				"chat-completions-v1",
				{
					method: params.method,
					url: params.url,
					headers: params.headers,
					body: Buffer.from(params.body.base64, "base64url"),
				},
				{
					draft,
					endpoint,
					settings: { kind: "compatible", format: "json_object", allowPlaintextLan: false },
				},
				reference,
				credential,
				signal,
			],
			(notification) => {
				const delivery = (async () => {
					if (notification.method !== "host/stream.chunk")
						throw new Error("DYTEST-unexpected-notification");
					notifications.push(notification.params);
					host.notify(notification);
					// This delayed ACK deliberately ignores delivery abort. It is not a drain fixture.
					if (holdFirstAck && !held && notification.params.base64 !== "") {
						held = true;
						ackEntered.resolve();
						await firstAck.promise;
					}
				})();
				deliveries.push(delivery);
				return delivery;
			},
			{
				...options,
				onProgress: (value) => {
					progress.push(value);
					progressed.resolve();
					return options.onProgress?.(value);
				},
			},
		);
		streams.push(stream);
		void stream.completion.catch(() => undefined);
		const response = await stream.response;
		setImmediate(() => stream.start());
		return response;
	});
	cleanups.push(async () => {
		for (const stream of streams) stream.cancel();
		firstAck.resolve();
		host.close();
		broker.close();
		await Promise.allSettled([
			...streams.map((stream) => stream.completion),
			...originalStreams.map((stream) => stream.completion),
			...deliveries,
		]);
	});
	return {
		streams,
		originalStreams,
		deliveries,
		notifications,
		progress,
		firstAck,
		ackEntered,
		progressed,
		fetch: () =>
			hostFetch(host)(endpoint, {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify(requestBody),
				stream: true,
			}),
	};
}

async function peer(reply: (request: IncomingMessage, response: ServerResponse) => void) {
	const sockets = new Set<Socket>(),
		closed = deferred<void>();
	const server = createServer({ key: tls.key, cert: tls.cert }, (request, response) => {
		response.once("close", () => closed.resolve());
		response.on("error", () => undefined);
		request.resume();
		request.once("end", () => reply(request, response));
	});
	server.on("connection", (socket) => {
		sockets.add(socket);
		socket.once("close", () => sockets.delete(socket));
	});
	cleanups.push(async () => {
		for (const socket of sockets) socket.destroy();
		if (!server.listening) return;
		await new Promise<void>((resolve, reject) =>
			server.close((error) => (error ? reject(error) : resolve())),
		);
	});
	await new Promise<void>((resolve, reject) => {
		server.once("error", reject);
		server.listen(0, "127.0.0.1", resolve);
	});
	const port = (server.address() as AddressInfo).port;
	return {
		closed: closed.promise,
		hooks: {
			ca: tls.ca,
			resolve: async () => [{ address: "8.8.8.8", family: 4 as const }],
			dial: () => ({ address: "127.0.0.1", family: 4 as const, port }),
		},
	};
}

function bodyReader(response: Response) {
	if (!response.body) throw new Error("DYTEST-missing-stream");
	return response.body.getReader();
}
function bodyBytes(notifications: readonly HostStreamChunk[]): Buffer {
	return Buffer.concat(notifications.map((chunk) => Buffer.from(chunk.base64, "base64url")));
}

describe("bounded provider transport through the existing SDK", () => {
	it("keeps ordered progress, ACK backpressure and the native chunk cap before SDK text accumulation", async () => {
		const f = fixture({ maxBytes: 200_000, maxEvents: 32 }, true),
			finish = deferred<void>();
		// The real broker retains key.length-1 bytes for its cross-chunk redaction scan.
		const first = "\n".repeat(credentialFixture.key.length),
			rest = `data: DYTEST-rest-${"y".repeat(MAX_INLINE_BYTES + 4096)}\n\n`;
		let ended = false;
		let authorization: string | undefined;
		const remote = await peer((request, response) => {
			authorization = request.headers.authorization;
			response.writeHead(200, { "content-type": "text/event-stream" });
			response.write(first);
			void finish.promise.then(() => {
				ended = true;
				response.end(rest);
			});
		});
		await withNetworkTestHooks(remote.hooks, async () => {
			const response = await f.fetch(),
				reader = bodyReader(response);
			expect(response.status).toBe(200);
			expect(authorization).toBe(`Bearer ${credentialFixture.key}`);
			expect(response.headers.get("content-type")).toBe("text/event-stream");
			const firstRead = await reader.read();
			await f.ackEntered.promise;
			expect(Buffer.from(firstRead.value ?? []).toString()).toBe("\n");
			expect(ended).toBe(false);
			expect(f.progress).toEqual([]);
			expect(f.notifications).toHaveLength(1);
			f.firstAck.resolve();
			await f.progressed.promise;
			finish.resolve();
			const chunks = [firstRead.value ?? new Uint8Array()];
			while (true) {
				const next = await reader.read();
				if (next.done) break;
				chunks.push(next.value);
			}
			await f.streams[0]?.completion;
			expect(Buffer.concat(chunks).toString()).toBe(first + rest);
			expect(Buffer.concat(chunks).length).toBeGreaterThan(MAX_INLINE_BYTES);
			expect(f.progress.at(-1)?.bytes).toBe(Buffer.byteLength(first + rest));
			for (const [sequence, chunk] of f.notifications.entries()) {
				expect(chunk.sequence).toBe(sequence);
				expect(chunk.streamId).toBe(f.notifications[0]?.streamId);
				expect(Buffer.from(chunk.base64, "base64url").length).toBeLessThanOrEqual(MAX_INLINE_BYTES);
				expect(chunk.error).toBeUndefined();
			}
			expect(f.notifications.at(-1)?.done).toBe(true);
		});
	});
	it("refuses the over-budget bytes before they can reach the SDK reader", async () => {
		const f = fixture({ maxBytes: 1, maxEvents: 8 }),
			finish = deferred<void>();
		const remote = await peer((_request, response) => {
			response.writeHead(200, { "content-type": "text/event-stream" });
			response.write("a".repeat(credentialFixture.key.length));
			void finish.promise.then(() => response.end("DYTEST-over-budget"));
		});
		await withNetworkTestHooks(remote.hooks, async () => {
			const reader = bodyReader(await f.fetch());
			expect(Buffer.from((await reader.read()).value ?? []).toString()).toBe("a");
			await f.progressed.promise;
			const stream = f.streams[0];
			if (!stream) throw new Error("DYTEST-missing-boundary");
			const refused = expect(stream.completion).rejects.toBeInstanceOf(ProviderStreamBoundaryError);
			const stoppedRead = expect(reader.read()).rejects.toMatchObject({ code: "DENIED" });
			finish.resolve();
			await refused;
			await stoppedRead;
			expect(bodyBytes(f.notifications).toString()).toBe("a");
			expect(f.notifications.at(-1)).toMatchObject({ done: true, base64: "", error: "DENIED" });
			expect(f.progress.at(-1)?.bytes).toBeLessThanOrEqual(1);
			reader.releaseLock();
		});
	});
	it("reserves the final protocol event for failure instead of forwarding another data chunk", async () => {
		const f = fixture({ maxBytes: 1024, maxEvents: 2 }),
			finish = deferred<void>();
		const remote = await peer((_request, response) => {
			response.writeHead(200, { "content-type": "text/event-stream" });
			response.write("a".repeat(credentialFixture.key.length));
			void finish.promise.then(() => response.end("b"));
		});
		await withNetworkTestHooks(remote.hooks, async () => {
			const reader = bodyReader(await f.fetch());
			expect(Buffer.from((await reader.read()).value ?? []).toString()).toBe("a");
			await f.progressed.promise;
			const stream = f.streams[0];
			if (!stream) throw new Error("DYTEST-missing-boundary");
			const refused = expect(stream.completion).rejects.toBeInstanceOf(ProviderStreamBoundaryError);
			const stoppedRead = expect(reader.read()).rejects.toMatchObject({ code: "DENIED" });
			finish.resolve();
			await refused;
			await stoppedRead;
			expect(f.notifications).toHaveLength(2);
			expect(bodyBytes(f.notifications).toString()).toBe("a");
			expect(f.notifications[1]).toMatchObject({
				streamId: f.notifications[0]?.streamId,
				sequence: 1,
				done: true,
				base64: "",
				error: "DENIED",
			});
			reader.releaseLock();
		});
	});
	it.each(["cancel", "deadline"] as const)(
		"joins the original broker and drops queued bytes after %s with an outstanding SDK ACK",
		async (stop) => {
			const f = fixture(
					{ maxBytes: 1024, maxEvents: 8, timeoutMs: stop === "deadline" ? 2000 : 30_000 },
					true,
				),
				late = deferred<void>(),
				queued = deferred<void>();
			const remote = await peer((_request, response) => {
				response.writeHead(200, { "content-type": "text/event-stream" });
				response.write("a".repeat(credentialFixture.key.length));
				void late.promise.then(() => {
					response.write("DYTEST-must-not-reach-sdk");
					queued.resolve();
				});
			});
			await withNetworkTestHooks(remote.hooks, async () => {
				const reader = bodyReader(await f.fetch());
				try {
					expect(Buffer.from((await reader.read()).value ?? []).toString()).toBe("a");
					await f.ackEntered.promise;
					const stream = f.streams[0],
						original = f.originalStreams[0];
					if (!stream || !original) throw new Error("DYTEST-missing-boundary");
					let originalCompleted = false;
					void original.completion.then(
						() => {
							originalCompleted = true;
						},
						() => {
							originalCompleted = true;
						},
					);
					const refused = expect(stream.completion).rejects.toBeInstanceOf(
						ProviderStreamBoundaryError,
					);
					late.resolve();
					await queued.promise;
					if (stop === "cancel") stream.cancel();
					await remote.closed;
					await refused;
					expect(originalCompleted).toBe(true);
					// A sink ignoring abort gets no concurrent or replayed terminal. The native
					// completion is joined; this does not claim its outstanding SDK ACK drained.
					expect(f.notifications).toHaveLength(1);
					expect(bodyBytes(f.notifications).toString()).toBe("a");
					expect(f.progress).toEqual([]);
				} finally {
					f.firstAck.resolve();
					await Promise.allSettled(f.deliveries);
					try {
						await reader.cancel();
					} finally {
						reader.releaseLock();
					}
				}
				expect(f.notifications).toHaveLength(1);
				expect(f.progress).toEqual([]);
			});
		},
	);
});
