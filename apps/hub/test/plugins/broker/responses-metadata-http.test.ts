import { randomBytes } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { createServer } from "node:https";
import type { AddressInfo, Socket } from "node:net";
import os from "node:os";
import path from "node:path";
import { createSecureContext } from "node:tls";
import {
	type AiCandidateRequest,
	AuditChain,
	type CredentialBinding,
	CredentialVault,
	captureResponsesMetadataInputs,
	createBuiltinAiProfileRegistry,
	createProviderHttpBroker,
	HubStore,
	MasterKey,
	ProviderHttpError,
	type ProviderHttpStream,
	type ResponsesMetadataBindingWithoutNetwork,
	snapshotVerifiedAiRequest,
	verifyCapturedAiRequest,
} from "@draftyak/hub";
import { HostFetchParams, type HostStreamChunk } from "@draftyak/protocol/host-channel";
import { MAX_INLINE_BYTES } from "@draftyak/protocol/normalized-change";
import { hostFetch } from "@draftyak/sdk/fetch";
import { memoryHost } from "@draftyak/sdk/host";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { newId } from "../../../src/kernel/ids.ts";
import { withNetworkTestHooks } from "../../../src/plugins/broker/network/test-context.ts";
import { requireLoopbackNetworkGuard } from "../../helpers/loopback-network.ts";
import { migrations, nativeBinding } from "../../store/helpers.ts";
import { createTlsFixture } from "./tls-fixture.ts";

let tls: Awaited<ReturnType<typeof createTlsFixture>>;
let defaultTls: Awaited<ReturnType<typeof createTlsFixture>>;
const cleanups: (() => void | Promise<void>)[] = [];
const pin = { address: "8.8.8.8", family: 4 as const };
const policy = { deniedAddresses: [], deniedPorts: [] };
beforeAll(async () => {
	requireLoopbackNetworkGuard().assertActive();
	tls = await createTlsFixture(["api.openai.com"]);
	defaultTls = await createTlsFixture();
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
const listBinding = (): ResponsesMetadataBindingWithoutNetwork => ({
	operation: "ai_models_list",
	configuration: { profile: "responses-api-v1", endpoint: "https://api.openai.com/v1" },
	input: {},
});
const candidate = (suffix = ""): AiCandidateRequest => ({
	method: "GET",
	url: `https://api.openai.com/v1/models${suffix}`,
	headers: [
		["accept", "application/json"],
		["authorization", "Bearer brokered"],
	],
	body: new Uint8Array(0),
});
async function fixture() {
	const dir = mkdtempSync(path.join(os.tmpdir(), "draftyak-responses-metadata-http-"));
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
	const vault = new CredentialVault(store, audit, key),
		registry = createBuiltinAiProfileRegistry();
	const credential: CredentialBinding = {
		ownerKind: "provider",
		ownerId: newId(),
		kind: "provider-key",
	};
	const secret = `DYTEST-${randomBytes(20).toString("hex")}`;
	const reference = store.write((tx) =>
		vault.createInTransaction(tx, credential, { kind: "provider-key", key: secret }),
	);
	const broker = createProviderHttpBroker({ vault, registry, networkPolicy: policy });
	const streams: ProviderHttpStream[] = [];
	cleanups.push(async () => {
		for (const stream of streams) stream.cancel();
		broker.close();
		await Promise.allSettled(streams.map((stream) => stream.completion));
		store.close();
		audit.destroy();
		key.destroy();
		rmSync(dir, { recursive: true, force: true });
	});
	const execute = (request = candidate(), binding: unknown = listBinding()) =>
		broker.execute(
			"responses-api-v1",
			request,
			binding,
			reference,
			credential,
			new AbortController().signal,
		);
	return { broker, registry, reference, credential, secret, streams, execute };
}
async function peer(reply: (response: ServerResponse) => void, certificate = tls) {
	const sockets = new Set<Socket>();
	const seen = {
		connections: 0,
		applicationBytes: 0,
		methods: [] as string[],
		paths: [] as string[],
		headers: [] as IncomingMessage["headers"][],
		bodies: [] as string[],
		sni: [] as string[],
	};
	const server = createServer(
		{
			key: certificate.key,
			cert: certificate.cert,
			SNICallback(name, callback) {
				seen.sni.push(name);
				callback(null, createSecureContext({ key: certificate.key, cert: certificate.cert }));
			},
		},
		(request, response) => {
			seen.methods.push(request.method ?? "");
			seen.paths.push(request.url ?? "");
			seen.headers.push(request.headers);
			const body: Buffer[] = [];
			request.on("data", (bytes: Buffer) => body.push(bytes));
			request.once("end", () => {
				seen.bodies.push(Buffer.concat(body).toString());
				reply(response);
			});
		},
	);
	server.on("connection", (socket) => {
		seen.connections++;
		sockets.add(socket);
		socket.once("close", () => sockets.delete(socket));
	});
	server.on("secureConnection", (socket) =>
		socket.on("data", (bytes: Buffer) => {
			seen.applicationBytes += bytes.length;
		}),
	);
	await new Promise<void>((resolve, reject) => {
		server.once("error", reject);
		server.listen(0, "127.0.0.1", resolve);
	});
	const port = (server.address() as AddressInfo).port;
	cleanups.push(async () => {
		const closed = new Promise<void>((resolve, reject) =>
			server.close((error) => (error ? reject(error) : resolve())),
		);
		for (const socket of sockets) socket.destroy();
		await closed;
	});
	return { seen, port, certificate };
}
function localTls<T>(remote: Awaited<ReturnType<typeof peer>>, run: () => T): T {
	return withNetworkTestHooks(
		{
			ca: remote.certificate.ca,
			resolve: async (host) => {
				expect(host).toBe("api.openai.com");
				return [pin];
			},
			dial: (address, port) => {
				expect(address).toEqual(pin);
				expect(port).toBe(443);
				return { address: "127.0.0.1", family: 4, port: remote.port };
			},
		},
		run,
	);
}

describe("Responses metadata through native HTTP and public integration APIs", () => {
	it("uses public capture/verify/snapshot exports for the actual empty-body GET list request", async () => {
		const f = await fixture(),
			request = candidate(),
			binding = listBinding();
		const captured = captureResponsesMetadataInputs(request, binding);
		const snapshot = snapshotVerifiedAiRequest(
			verifyCapturedAiRequest(f.registry, "responses-api-v1", captured, { answers: [pin], policy }),
		);
		expect(snapshot).toMatchObject({ method: "GET", url: request.url });
		expect(snapshot.body.byteLength).toBe(0);
		const remote = await peer((response) => {
			response.setHeader("content-type", "application/json");
			response.end('{"object":"list","data":[]}');
		});
		const result = await localTls(remote, () => f.execute(request, binding));
		expect(result.status).toBe(200);
		expect(remote.seen.methods).toEqual(["GET"]);
		expect(remote.seen.paths).toEqual(["/v1/models"]);
		expect(remote.seen.headers).toHaveLength(1);
		expect(remote.seen.headers[0]).toMatchObject({
			accept: "application/json",
			authorization: `Bearer ${f.secret}`,
			host: "api.openai.com",
			"accept-encoding": "identity",
		});
		expect(remote.seen.headers[0]).not.toHaveProperty("content-type");
		expect(remote.seen.bodies).toEqual([""]);
		expect(remote.seen.sni).toEqual(["api.openai.com"]);
		expect(JSON.stringify(result)).not.toContain(f.secret);
	});
	it.each([
		["DYTEST-model/2026", "/v1/models/DYTEST-model%2F2026"],
		["gpt-synthetic/a?b=%25#d+e", "/v1/models/gpt-synthetic%2Fa%3Fb=%2525%23d+e"],
		[
			"ft:gpt-synthetic:DYTEST-org:a1@2026+a=b$c&d,e;f",
			"/v1/models/ft:gpt-synthetic:DYTEST-org:a1@2026+a=b$c&d,e;f",
		],
	])(
		"binds the actual probe GET path for %s only to the explicit input model",
		async (model, target) => {
			const f = await fixture();
			const binding: ResponsesMetadataBindingWithoutNetwork = {
				operation: "ai_probe",
				configuration: { ...listBinding().configuration, model: "DYTEST-configured" },
				input: { model },
			};
			const remote = await peer((response) => response.end(JSON.stringify({ id: model })));
			const result = await localTls(remote, () =>
				f.execute(candidate(target.slice("/v1/models".length)), binding),
			);
			expect(result.status).toBe(200);
			expect(remote.seen.paths).toEqual([target]);
			expect(remote.seen.methods).toEqual(["GET"]);
			expect(remote.seen.bodies).toEqual([""]);
			expect(remote.seen.headers[0]).toMatchObject({
				accept: "application/json",
				authorization: `Bearer ${f.secret}`,
				host: "api.openai.com",
			});
			expect(remote.seen.sni).toEqual(["api.openai.com"]);
		},
	);
	it("opens no HTTP connection for a percent-encoded spelling of RFC 3986 path characters", async () => {
		const f = await fixture();
		const binding: ResponsesMetadataBindingWithoutNetwork = {
			operation: "ai_probe",
			configuration: listBinding().configuration,
			input: { model: "ft:gpt-synthetic:DYTEST-org:a1@2026" },
		};
		const remote = await peer((response) => response.end("unsafe"));
		await expect(
			localTls(remote, () =>
				f.execute(candidate("/ft%3Agpt-synthetic%3ADYTEST-org%3Aa1%402026"), binding),
			),
		).rejects.toThrow(ProviderHttpError);
		expect(remote.seen.connections).toBe(0);
		expect(remote.seen.applicationBytes).toBe(0);
	});
	it.each([false, true])(
		"lists models for a model-less native probe with configured model=%s",
		async (configured) => {
			const f = await fixture();
			const binding: ResponsesMetadataBindingWithoutNetwork = {
				operation: "ai_probe",
				configuration: {
					...listBinding().configuration,
					...(configured ? { model: "DYTEST-configured" } : {}),
				},
				input: {},
			};
			const remote = await peer((response) => response.end('{"object":"list","data":[]}'));
			const result = localTls(remote, () => f.execute(candidate(), binding)).catch(
				(error: unknown) => {
					// A native binding refusal must happen before a socket or credential header is sent.
					expect(remote.seen.connections).toBe(0);
					expect(remote.seen.applicationBytes).toBe(0);
					throw error;
				},
			);
			await expect(result).resolves.toMatchObject({ status: 200 });
			expect(remote.seen.methods).toEqual(["GET"]);
			expect(remote.seen.paths).toEqual(["/v1/models"]);
			expect(remote.seen.bodies).toEqual([""]);
			expect(remote.seen.sni).toEqual(["api.openai.com"]);
			expect(remote.seen.headers[0]).toMatchObject({
				accept: "application/json",
				authorization: `Bearer ${f.secret}`,
				host: "api.openai.com",
			});
		},
	);
	it.each(["configured-model path", "body"])(
		"refuses a model-less probe with a %s before HTTP",
		async (invalid) => {
			const f = await fixture();
			const binding: ResponsesMetadataBindingWithoutNetwork = {
				operation: "ai_probe",
				configuration: { ...listBinding().configuration, model: "DYTEST-configured" },
				input: {},
			};
			const input =
				invalid === "body"
					? { ...candidate(), body: Buffer.from("{}") }
					: candidate("/DYTEST-configured");
			const remote = await peer((response) => response.end("unsafe"));
			await expect(localTls(remote, () => f.execute(input, binding))).rejects.toThrow(
				ProviderHttpError,
			);
			expect(remote.seen.connections).toBe(0);
			expect(remote.seen.applicationBytes).toBe(0);
		},
	);
	it.each(["operation", "model", "headers"])(
		"opens no HTTP connection for invalid native %s",
		async (invalid) => {
			const f = await fixture(),
				request = candidate();
			let binding: unknown = listBinding();
			if (invalid === "operation") binding = { ...listBinding(), operation: "channel_sync" };
			if (invalid === "model")
				binding = {
					...listBinding(),
					operation: "ai_probe",
					input: { model: "DYTEST invalid model" },
				};
			const input =
				invalid === "headers"
					? ({
							...request,
							headers: [...request.headers, ["x-not-allowed", "DYTEST-extra"]],
						} as AiCandidateRequest)
					: request;
			const remote = await peer((response) => response.end("unsafe"));
			await expect(localTls(remote, () => f.execute(input, binding))).rejects.toThrow(
				ProviderHttpError,
			);
			expect(remote.seen.connections).toBe(0);
			expect(remote.seen.applicationBytes).toBe(0);
			expect(remote.seen.methods).toEqual([]);
		},
	);
	it("sends zero application bytes when the local fixture certificate has the wrong DNS SAN", async () => {
		const f = await fixture(),
			remote = await peer((response) => response.end("unsafe"), defaultTls);
		await expect(localTls(remote, () => f.execute())).rejects.toThrow(ProviderHttpError);
		expect(remote.seen.connections).toBe(1);
		expect(remote.seen.applicationBytes).toBe(0);
		expect(remote.seen.methods).toEqual([]);
		expect(remote.seen.bodies).toEqual([]);
		expect(remote.seen.sni).toEqual(["api.openai.com"]);
	});
	it("delivers a metadata list larger than 64 KiB progressively through the real SDK hostFetch stream", async () => {
		const f = await fixture(),
			finish = deferred<void>();
		const payload = JSON.stringify({
			object: "list",
			data: Array.from({ length: 400 }, (_, index) => ({
				id: `DYTEST-model-${index}-${"x".repeat(170)}`,
			})),
		});
		expect(Buffer.byteLength(payload)).toBeGreaterThan(MAX_INLINE_BYTES);
		let ended = false;
		const remote = await peer((response) => {
			response.setHeader("content-type", "application/json");
			response.write(payload.slice(0, 40_000));
			void finish.promise.then(() => {
				ended = true;
				response.end(payload.slice(40_000));
			});
		});
		const notifications: HostStreamChunk[] = [];
		// This binds existing output plumbing; native process/session authority stays with its owner.
		const host = memoryHost(async (method, raw, signal) => {
			if (method !== "host/fetch") throw new Error("DYTEST-unexpected-method");
			const params = HostFetchParams.parse(raw);
			if (!params.stream || params.body !== undefined)
				throw new Error("DYTEST-unexpected-metadata-shape");
			const handle = f.broker.stream(
				"responses-api-v1",
				{ method: params.method, url: params.url, headers: params.headers },
				listBinding(),
				f.reference,
				f.credential,
				signal,
				async (notification) => {
					if (notification.method !== "host/stream.chunk")
						throw new Error("DYTEST-unexpected-notification");
					notifications.push(notification.params);
					host.notify(notification);
				},
			);
			f.streams.push(handle);
			const result = await handle.response;
			setImmediate(() => handle.start());
			return result;
		});
		cleanups.push(() => {
			finish.resolve();
			for (const stream of f.streams) stream.cancel();
			host.close();
		});
		await localTls(remote, async () => {
			const response = await hostFetch(host)(candidate().url, {
				method: "GET",
				headers: { accept: "application/json", authorization: "Bearer brokered" },
				stream: true,
			});
			const reader = response.body?.getReader();
			if (!reader) throw new Error("DYTEST-no-stream");
			const first = await reader.read();
			expect(first.done).toBe(false);
			expect(first.value?.length).toBeGreaterThan(0);
			expect(ended).toBe(false);
			finish.resolve();
			const received: Uint8Array[] = first.value ? [first.value] : [];
			while (true) {
				const next = await reader.read();
				if (next.done) break;
				received.push(next.value);
			}
			expect(Buffer.concat(received).toString()).toBe(payload);
			await f.streams[0]?.completion;
		});
		expect(remote.seen.methods).toEqual(["GET"]);
		expect(remote.seen.paths).toEqual(["/v1/models"]);
		expect(remote.seen.bodies).toEqual([""]);
		for (const [sequence, chunk] of notifications.entries()) {
			expect(chunk.sequence).toBe(sequence);
			expect(Buffer.from(chunk.base64, "base64url").length).toBeLessThanOrEqual(MAX_INLINE_BYTES);
		}
		expect(notifications.at(-1)).toMatchObject({ done: true });
	});
});
