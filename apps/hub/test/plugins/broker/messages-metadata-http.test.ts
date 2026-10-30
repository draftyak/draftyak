import { randomBytes } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { createServer } from "node:https";
import type { AddressInfo, Socket } from "node:net";
import os from "node:os";
import path from "node:path";
import {
	type AiCandidateRequest,
	AuditChain,
	beginMessagesMetadataCall,
	type CredentialBinding,
	CredentialVault,
	createBuiltinAiProfileRegistry,
	createProviderHttpBroker,
	HubStore,
	MasterKey,
	type MessagesMetadataBindingWithoutNetwork,
	ProviderHttpError,
	type ProviderHttpStream,
	type ProviderStreamSink,
} from "@draftyak/hub";
import { HostFetchParams, type HostStreamChunk } from "@draftyak/protocol/host-channel";
import { hostFetch } from "@draftyak/sdk/fetch";
import { memoryHost } from "@draftyak/sdk/host";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { newId } from "../../../src/kernel/ids.ts";
import { withNetworkTestHooks } from "../../../src/plugins/broker/network/test-context.ts";
import { requireLoopbackNetworkGuard } from "../../helpers/loopback-network.ts";
import { migrations, nativeBinding } from "../../store/helpers.ts";
import { createTlsFixture } from "./tls-fixture.ts";

let tls: Awaited<ReturnType<typeof createTlsFixture>>;
const cleanups: (() => void | Promise<void>)[] = [];
const endpoint = "https://api.anthropic.com";
const firstUrl = `${endpoint}/v1/models?limit=100`;
const nextUrl = `${firstUrl}&after_id=DYTEST-last`;
const policy = { deniedAddresses: [], deniedPorts: [] };
beforeAll(async () => {
	requireLoopbackNetworkGuard().assertActive();
	tls = await createTlsFixture(["api.anthropic.com"]);
});
afterEach(async () => {
	for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});
const deferred = <T>() => {
	let resolve: (value: T) => void = () => undefined;
	const promise = new Promise<T>((yes) => {
		resolve = yes;
	});
	return { resolve, promise };
};
function nativeCall(operation: "ai_models_list" | "ai_probe" = "ai_models_list", model?: string) {
	const original = new AbortController();
	const call = beginMessagesMetadataCall(
		{
			operation,
			configuration: {
				profile: "messages-api-v1",
				endpoint,
				...(operation === "ai_probe" ? { model: "DYTEST-configured" } : {}),
			},
			input: model === undefined ? {} : { model },
		},
		original.signal,
	);
	const binding: MessagesMetadataBindingWithoutNetwork = { operation, call };
	cleanups.push(() => original.abort());
	return { original, binding };
}
const candidate = (url = firstUrl): AiCandidateRequest => ({
	method: "GET",
	url,
	headers: [
		["accept", "application/json"],
		["anthropic-version", "2023-06-01"],
		["user-agent", "Anthropic/JS 0.135.0"],
		["x-api-key", "brokered"],
		["x-stainless-retry-count", "0"],
		["x-stainless-timeout", "600"],
	],
	body: new Uint8Array(0),
});
const model = (id: string) => ({
	id,
	display_name: "DYTEST Model",
	lifecycle: "active",
	max_input_tokens: null,
});
const page = (hasMore = false, id = "DYTEST-last") =>
	JSON.stringify({ data: [model(id)], has_more: hasMore, ...(hasMore ? { last_id: id } : {}) });
async function fixture() {
	const dir = mkdtempSync(path.join(os.tmpdir(), "draftyak-messages-metadata-http-"));
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
		registry = createBuiltinAiProfileRegistry();
	const credential: CredentialBinding = {
		ownerKind: "provider",
		ownerId: newId(),
		kind: "provider-key",
	};
	const secret = `DYTEST-${randomBytes(20).toString("hex")}`;
	const create = () =>
		store.write((tx) =>
			vault.createInTransaction(tx, credential, { kind: "provider-key", key: secret }),
		);
	const reference = create(),
		broker = createProviderHttpBroker({ vault, registry, networkPolicy: policy });
	const streams: ProviderHttpStream[] = [],
		brokers = [broker];
	const otherBroker = () => {
		const next = createProviderHttpBroker({
			vault: new CredentialVault(store, audit),
			registry,
			networkPolicy: policy,
		});
		brokers.push(next);
		return next;
	};
	cleanups.push(async () => {
		for (const stream of streams) stream.cancel();
		for (const owned of brokers) owned.close();
		await Promise.allSettled(streams.map((stream) => stream.completion));
		store.close();
		audit.destroy();
		key.destroy();
		rmSync(dir, { recursive: true, force: true });
	});
	const execute = (
		call: ReturnType<typeof nativeCall>,
		url = firstUrl,
		options: { reference?: string; broker?: typeof broker; signal?: AbortSignal } = {},
	) =>
		(options.broker ?? broker).execute(
			"messages-api-v1",
			candidate(url),
			call.binding,
			options.reference ?? reference,
			credential,
			options.signal ?? call.original.signal,
		);
	const stream = (
		call: ReturnType<typeof nativeCall>,
		sink: ProviderStreamSink,
		url = firstUrl,
	) => {
		const handle = broker.stream(
			"messages-api-v1",
			candidate(url),
			call.binding,
			reference,
			credential,
			call.original.signal,
			sink,
		);
		streams.push(handle);
		return handle;
	};
	return {
		vault,
		store,
		credential,
		secret,
		reference,
		broker,
		streams,
		create,
		otherBroker,
		execute,
		stream,
	};
}
async function peer(reply: (response: ServerResponse, path: string) => void) {
	const sockets = new Set<Socket>();
	const seen = {
		connections: 0,
		paths: [] as string[],
		headers: [] as IncomingMessage["headers"][],
		methods: [] as string[],
		bodies: [] as string[],
	};
	const server = createServer({ key: tls.key, cert: tls.cert }, (request, response) => {
		seen.paths.push(request.url ?? "");
		seen.headers.push(request.headers);
		seen.methods.push(request.method ?? "");
		const bytes: Buffer[] = [];
		request.on("data", (chunk: Buffer) => bytes.push(chunk));
		request.once("end", () => {
			seen.bodies.push(Buffer.concat(bytes).toString());
			reply(response, request.url ?? "");
		});
	});
	server.on("connection", (socket) => {
		seen.connections++;
		sockets.add(socket);
		socket.once("close", () => sockets.delete(socket));
	});
	await new Promise<void>((resolve, reject) => {
		server.once("error", reject);
		server.listen(0, "127.0.0.1", resolve);
	});
	cleanups.push(async () => {
		const stopped = new Promise<void>((resolve, reject) =>
			server.close((error) => (error ? reject(error) : resolve())),
		);
		for (const socket of sockets) socket.destroy();
		await stopped;
	});
	const port = (server.address() as AddressInfo).port;
	return {
		seen,
		hooks: {
			ca: tls.ca,
			resolve: async (host: string) => {
				expect(host).toBe("api.anthropic.com");
				return [{ address: "8.8.8.8", family: 4 as const }];
			},
			dial: () => ({ address: "127.0.0.1", family: 4 as const, port }),
		},
	};
}
describe("Messages metadata through native HTTP and SDK lifecycle", () => {
	it("accepts real pages and binds the exact RFC3986 next query and metadata headers", async () => {
		const f = await fixture(),
			call = nativeCall();
		const cursor = "DYTEST-cursor/2026!'()*?#[]";
		const encodedPath =
			"/v1/models?limit=100&after_id=DYTEST-cursor%2F2026%21%27%28%29%2A%3F%23%5B%5D";
		const remote = await peer((response, path) =>
			response.end(
				path === "/v1/models?limit=100" ? page(true, cursor) : page(false, "DYTEST-final"),
			),
		);
		await withNetworkTestHooks(remote.hooks, async () => {
			expect((await f.execute(call)).status).toBe(200);
			expect((await f.execute(call, endpoint + encodedPath)).status).toBe(200);
		});
		expect(remote.seen.paths).toEqual(["/v1/models?limit=100", encodedPath]);
		expect(remote.seen.methods).toEqual(["GET", "GET"]);
		expect(remote.seen.bodies).toEqual(["", ""]);
		expect(remote.seen.headers[0]).toMatchObject({
			accept: "application/json",
			"anthropic-version": "2023-06-01",
			"user-agent": "Anthropic/JS 0.135.0",
			"x-api-key": f.secret,
			"x-stainless-retry-count": "0",
			"x-stainless-timeout": "600",
			host: "api.anthropic.com",
		});
		expect(remote.seen.headers[0]).not.toHaveProperty("authorization");
	});
	it.each([
		["DYTEST-model/2026", "/v1/models/DYTEST-model%2F2026"],
		["gpt-synthetic/a?b=%25#d+e", "/v1/models/gpt-synthetic%2Fa%3Fb=%2525%23d+e"],
		[
			"ft:claude-synthetic:DYTEST-org@2026+a=b$c&d,e;f",
			"/v1/models/ft:claude-synthetic:DYTEST-org@2026+a=b$c&d,e;f",
		],
		["claude-synthetic:@!$&'()*+,;=", "/v1/models/claude-synthetic:@!$&'()*+,;="],
	])(
		"binds an actual probe for %s to the input model rather than the configured fallback",
		async (selected, target) => {
			const f = await fixture(),
				call = nativeCall("ai_probe", selected);
			const remote = await peer((response) =>
				response.end(JSON.stringify({ ...model(selected), max_input_tokens: 32_768 })),
			);
			await expect(
				withNetworkTestHooks(remote.hooks, () => f.execute(call, `${endpoint}${target}`)),
			).resolves.toMatchObject({ status: 200 });
			expect(remote.seen.paths).toEqual([target]);
		},
	);
	it("opens no HTTP connection for a percent-encoded spelling of RFC 3986 path characters", async () => {
		const f = await fixture(),
			call = nativeCall("ai_probe", "ft:claude-synthetic:DYTEST-org@2026");
		const remote = await peer((response) => response.end("unsafe"));
		await expect(
			withNetworkTestHooks(remote.hooks, () =>
				f.execute(call, `${endpoint}/v1/models/ft%3Aclaude-synthetic%3ADYTEST-org%402026`),
			),
		).rejects.toThrow(ProviderHttpError);
		expect(remote.seen.connections).toBe(0);
	});
	it.each(["generation", "reference", "vault", "signal"])(
		"pins the real %s across accepted pages",
		async (changed) => {
			const f = await fixture(),
				call = nativeCall(),
				remote = await peer((response) => response.end(page(true)));
			await withNetworkTestHooks(remote.hooks, async () => {
				await f.execute(call);
				const options: Parameters<typeof f.execute>[2] = {};
				if (changed === "generation")
					f.store.write((tx) =>
						f.vault.replaceInTransaction(tx, f.reference, f.credential, {
							kind: "provider-key",
							key: "DYTEST-replaced",
						}),
					);
				if (changed === "reference") options.reference = f.create();
				if (changed === "vault") options.broker = f.otherBroker();
				if (changed === "signal") options.signal = new AbortController().signal;
				await expect(f.execute(call, nextUrl, options)).rejects.toThrow(ProviderHttpError);
				await expect(f.execute(call, nextUrl)).rejects.toThrow(ProviderHttpError);
			});
			expect(remote.seen.paths).toEqual(["/v1/models?limit=100"]);
		},
	);
	it.each(["replay", "forged cursor"])(
		"closes the call on a %s instead of permitting a later retry",
		async (changed) => {
			const f = await fixture(),
				call = nativeCall(),
				remote = await peer((response) => response.end(page(true)));
			await withNetworkTestHooks(remote.hooks, async () => {
				await f.execute(call);
				await expect(
					f.execute(call, changed === "replay" ? firstUrl : `${firstUrl}&after_id=DYTEST-forged`),
				).rejects.toThrow(ProviderHttpError);
				await expect(f.execute(call, nextUrl)).rejects.toThrow(ProviderHttpError);
			});
			expect(remote.seen.connections).toBe(1);
		},
	);
	it("rejects a next page while the prior terminal output ACK is pending and invalidates both uses", async () => {
		const f = await fixture(),
			call = nativeCall(),
			terminal = deferred<void>(),
			ack = deferred<void>();
		const remote = await peer((response) => response.end(page(true)));
		cleanups.push(() => ack.resolve());
		await withNetworkTestHooks(remote.hooks, async () => {
			const handle = f.stream(call, async (notification) => {
				if (notification.method === "host/stream.chunk" && notification.params.done) {
					terminal.resolve();
					await ack.promise;
				}
			});
			await handle.response;
			handle.start();
			await terminal.promise;
			const rejected = expect(handle.completion).rejects.toThrow(ProviderHttpError);
			await expect(f.execute(call, nextUrl)).rejects.toThrow(ProviderHttpError);
			await rejected;
			ack.resolve();
			await expect(f.execute(call, nextUrl)).rejects.toThrow(ProviderHttpError);
		});
		expect(remote.seen.connections).toBe(1);
	});
	it("honors original-call cancellation between pages", async () => {
		const f = await fixture(),
			call = nativeCall(),
			remote = await peer((response) => response.end(page(true)));
		await withNetworkTestHooks(remote.hooks, async () => {
			await f.execute(call);
			call.original.abort();
			await expect(f.execute(call, nextUrl)).rejects.toThrow(ProviderHttpError);
		});
		expect(remote.seen.connections).toBe(1);
	});
	it.each([200, 429])(
		"closes an oversized HTTP %s page before server end and closes call reuse",
		async (status) => {
			const f = await fixture(),
				call = nativeCall(),
				stopped = deferred<void>();
			let ended = false;
			const remote = await peer((response) => {
				response.writeHead(status);
				response.write(Buffer.alloc(1_048_577, 120));
				const timer = setTimeout(() => {
					ended = true;
					response.end();
				}, 750);
				response.once("close", () => {
					clearTimeout(timer);
					stopped.resolve();
				});
			});
			await withNetworkTestHooks(remote.hooks, async () => {
				const handle = f.stream(call, async () => undefined);
				await handle.response;
				handle.start();
				await expect(handle.completion).rejects.toThrow(ProviderHttpError);
				await stopped.promise;
				await expect(f.execute(call)).rejects.toThrow(ProviderHttpError);
			});
			expect(ended).toBe(false);
			expect(remote.seen.connections).toBe(1);
		},
	);
	it.each(["invalid", "rejecting"])(
		"closes the native call after an %s output sink",
		async (kind) => {
			const f = await fixture(),
				call = nativeCall(),
				remote = await peer((response) => response.end(page(true)));
			await withNetworkTestHooks(remote.hooks, async () => {
				const sink =
					kind === "invalid"
						? (null as unknown as ProviderStreamSink)
						: async () => {
								throw new Error("DYTEST-sink-refused");
							};
				const handle = f.stream(call, sink);
				const rejected = expect(handle.completion).rejects.toThrow(ProviderHttpError);
				if (kind === "invalid") await expect(handle.response).rejects.toThrow(ProviderHttpError);
				else {
					await handle.response;
					handle.start();
				}
				await rejected;
				await expect(f.execute(call)).rejects.toThrow(ProviderHttpError);
			});
			expect(remote.seen.connections).toBe(kind === "invalid" ? 0 : 1);
		},
	);
	it("accepts five genuine 100-model pages then refuses a sixth even when the fifth has_more", async () => {
		const f = await fixture(),
			call = nativeCall();
		let pageNumber = 0;
		const remote = await peer((response) => {
			pageNumber++;
			const data = Array.from({ length: 100 }, (_, index) =>
				model(`DYTEST-page-${pageNumber}-${index}`),
			);
			response.end(JSON.stringify({ data, has_more: true, last_id: data.at(-1)?.id }));
		});
		await withNetworkTestHooks(remote.hooks, async () => {
			for (let index = 1; index <= 5; index++)
				expect(
					(
						await f.execute(
							call,
							index === 1 ? firstUrl : `${firstUrl}&after_id=DYTEST-page-${index - 1}-99`,
						)
					).status,
				).toBe(200);
			await expect(f.execute(call, `${firstUrl}&after_id=DYTEST-page-5-99`)).rejects.toThrow(
				ProviderHttpError,
			);
		});
		expect(pageNumber).toBe(5);
		expect(remote.seen.connections).toBe(5);
	});
	it("delivers a current 429 page through normal terminal ACK then refuses another request", async () => {
		const f = await fixture(),
			call = nativeCall(),
			chunks: HostStreamChunk[] = [];
		const remote = await peer((response) => {
			response.writeHead(429, { "retry-after": "7" });
			response.end("DYTEST-rate-limited");
		});
		await withNetworkTestHooks(remote.hooks, async () => {
			const handle = f.stream(call, async (notification) => {
				if (notification.method === "host/stream.chunk") chunks.push(notification.params);
			});
			expect((await handle.response).status).toBe(429);
			handle.start();
			await handle.completion;
			await expect(f.execute(call)).rejects.toThrow(ProviderHttpError);
		});
		expect(chunks.at(-1)).toMatchObject({ done: true });
		expect(chunks.at(-1)).not.toHaveProperty("error");
		expect(
			Buffer.concat(chunks.map((chunk) => Buffer.from(chunk.base64, "base64url"))).toString(),
		).toBe("DYTEST-rate-limited");
	});
	it("supports immediate two-page SDK hostFetch sequencing on one original native call signal", async () => {
		const f = await fixture(),
			call = nativeCall(),
			notifications: HostStreamChunk[] = [];
		const bodies = [page(true), page(false, "DYTEST-final")];
		let number = 0;
		const remote = await peer((response) => response.end(bodies[number++]));
		const host = memoryHost(async (method, raw, perHttpSignal) => {
			if (method !== "host/fetch") throw new Error("DYTEST-unexpected-method");
			expect(perHttpSignal).not.toBe(call.original.signal);
			const params = HostFetchParams.parse(raw);
			const handle = f.broker.stream(
				"messages-api-v1",
				{ method: params.method, url: params.url, headers: params.headers },
				call.binding,
				f.reference,
				f.credential,
				call.original.signal,
				async (notification) => {
					if (notification.method === "host/stream.chunk") notifications.push(notification.params);
					host.notify(notification);
				},
			);
			f.streams.push(handle);
			const response = await handle.response;
			setImmediate(() => handle.start());
			return response;
		});
		cleanups.push(() => {
			for (const stream of f.streams) stream.cancel();
			host.close();
		});
		const fetch = hostFetch(host),
			headers = candidate().headers as [string, string][];
		await withNetworkTestHooks(remote.hooks, async () => {
			const first = await fetch(firstUrl, { method: "GET", headers, stream: true });
			expect(await first.text()).toBe(bodies[0]);
			const second = await fetch(nextUrl, { method: "GET", headers, stream: true });
			expect(await second.text()).toBe(bodies[1]);
			await Promise.all(f.streams.map((stream) => stream.completion));
		});
		expect(remote.seen.paths).toEqual([
			"/v1/models?limit=100",
			"/v1/models?limit=100&after_id=DYTEST-last",
		]);
		expect(new Set(notifications.map((chunk) => chunk.streamId)).size).toBe(2);
		for (const id of new Set(notifications.map((chunk) => chunk.streamId))) {
			const chunks = notifications.filter((chunk) => chunk.streamId === id);
			for (const [sequence, chunk] of chunks.entries()) expect(chunk.sequence).toBe(sequence);
			expect(chunks.at(-1)).toMatchObject({ done: true });
		}
	});
});
