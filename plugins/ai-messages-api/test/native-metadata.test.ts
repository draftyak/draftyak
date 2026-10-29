import { randomBytes } from "node:crypto";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { createServer } from "node:https";
import type { AddressInfo, Socket } from "node:net";
import os from "node:os";
import path from "node:path";
import {
	AuditChain,
	beginMessagesMetadataCall,
	type CredentialBinding,
	CredentialVault,
	createBuiltinAiProfileRegistry,
	createProviderHttpBroker,
	HubStore,
	MasterKey,
	type MessagesMetadataBindingWithoutNetwork,
	type ProviderHttpStream,
} from "@draftyak/hub";
import { HostFetchParams, type HostStreamChunk } from "@draftyak/protocol/host-channel";
import { createPluginContext, type PluginContext } from "@draftyak/sdk/context";
import { memoryHost } from "@draftyak/sdk/host";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { newId } from "../../../apps/hub/src/kernel/ids.ts";
import { withNetworkTestHooks } from "../../../apps/hub/src/plugins/broker/network/test-context.ts";
import { createTlsFixture } from "../../../apps/hub/test/plugins/broker/tls-fixture.ts";
import { migrations, nativeBinding } from "../../../apps/hub/test/store/helpers.ts";
import { createMessagesPlugin } from "../src/index.ts";

// Only these admitted test fixtures are internal; every broker/vault operation uses its public API.
const manifest = {
	id: "@example/messages",
	version: "1.0.0",
	sdk: "1.0.0",
	kind: "ai-provider",
	contract: { extension: "io.github.draftyak/ai-provider", version: 1 },
	isolation: "standard",
	auth: { kind: "none", scopes: [], requiredGrantedScopes: [] },
	credentials: { mode: "brokered", urlSecrets: [] },
	permissions: {},
	license: "Apache-2.0",
	dataClasses: ["community.content"],
	egress: { profile: "messages-api-v1" },
};
const endpoint = "https://api.anthropic.com";
const configuredModel = "claude-configured-model";
const entry = createMessagesPlugin(manifest);
let tls: Awaited<ReturnType<typeof createTlsFixture>>;
let globalFetchCalls = 0;
const cleanups: (() => void | Promise<void>)[] = [];
const deferred = () => {
	let resolve: () => void = () => undefined;
	const promise = new Promise<void>((yes) => {
		resolve = yes;
	});
	return { resolve, promise };
};
const turn = () => new Promise<void>((resolve) => setImmediate(resolve));
const model = (id: string) => ({
	id,
	type: "model",
	display_name: "Synthetic model",
	lifecycle: "active",
	max_input_tokens: 12_345,
});
const page = (id: string, more = false) =>
	JSON.stringify({
		data: [model(id)],
		has_more: more,
		first_id: id,
		last_id: id,
	});
beforeAll(async () => {
	tls = await createTlsFixture(["api.anthropic.com"]);
});
beforeEach(() => {
	globalFetchCalls = 0;
	vi.stubGlobal("fetch", async () => {
		globalFetchCalls++;
		throw new Error("Unexpected global fetch in native metadata test");
	});
});
afterEach(async () => {
	try {
		for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
	} finally {
		vi.unstubAllGlobals();
	}
	expect(globalFetchCalls).toBe(0);
});

interface Delivery {
	readonly events: string[];
	readonly chunks: HostStreamChunk[];
	terminalAcks: number;
}
type Operation = "ai_models_list" | "ai_probe";
interface FixtureOptions {
	readonly beforeRequest?: (index: number, rotate: () => void) => void;
	readonly deliver?: (index: number, chunk: HostStreamChunk, forward: () => void) => Promise<void>;
}
async function fixture(
	operation: Operation,
	args: { model?: string } = {},
	options: FixtureOptions = {},
) {
	// Native invocation, configuration, signal and credential identity precede all SDK wire input.
	const original = new AbortController();
	const call = beginMessagesMetadataCall(
		{
			operation,
			configuration: { profile: "messages-api-v1", endpoint, model: configuredModel },
			input: args,
		},
		original.signal,
	);
	const binding: MessagesMetadataBindingWithoutNetwork = { operation, call };
	const directory = mkdtempSync(path.join(os.tmpdir(), "draftyak-messages-native-"));
	const key = new MasterKey(randomBytes(32));
	const auditKey = key.derive("audit"),
		audit = new AuditChain(auditKey);
	auditKey.fill(0);
	const store = new HubStore({
		filename: path.join(directory, "hub.db"),
		nativeBinding,
		masterKey: key,
		create: true,
		migrations: {
			audit: path.join(migrations, "audit"),
			credentials: path.resolve(
				import.meta.dirname,
				"../../../apps/hub/src/credentials/migrations",
			),
		},
	});
	const handles: ProviderHttpStream[] = [];
	const completions: Promise<"complete" | "refused">[] = [];
	let closeBroker = () => {};
	let closeHost = () => {};
	cleanups.push(async () => {
		original.abort();
		for (const handle of handles) handle.cancel();
		closeBroker();
		closeHost();
		await Promise.all(completions);
		store.close();
		audit.destroy();
		key.destroy();
		expect(path.dirname(directory)).toBe(path.resolve(os.tmpdir()));
		expect(path.basename(directory).startsWith("draftyak-messages-native-")).toBe(true);
		rmSync(directory, { recursive: true, force: true });
		expect(existsSync(directory)).toBe(false);
	});
	await store.migrate("audit");
	await store.migrate("credentials");
	const vault = new CredentialVault(store, audit);
	const credential: CredentialBinding = {
		ownerKind: "provider",
		ownerId: newId(),
		kind: "provider-key",
	};
	const secret = `DYTEST-${randomBytes(20).toString("hex")}`;
	const reference = store.write((tx) =>
		vault.createInTransaction(tx, credential, { kind: "provider-key", key: secret }),
	);
	const broker = createProviderHttpBroker({
		vault,
		registry: createBuiltinAiProfileRegistry(),
		networkPolicy: { deniedAddresses: [], deniedPorts: [] },
	});
	closeBroker = () => broker.close();
	const requests: HostFetchParams[] = [],
		deliveries: Delivery[] = [];
	const rotate = () =>
		store.write((tx) =>
			vault.replaceInTransaction(tx, reference, credential, {
				kind: "provider-key",
				key: "DYTEST-replacement-key",
			}),
		);
	const host = memoryHost(async (method, raw, perHttpSignal) => {
		expect(method).toBe("host/fetch");
		expect(perHttpSignal).not.toBe(original.signal);
		const params = HostFetchParams.parse(raw);
		expect(Object.hasOwn(params, "stream")).toBe(false);
		expect(params.body).toBeUndefined();
		const index = requests.push(params) - 1;
		options.beforeRequest?.(index, rotate);
		const delivery: Delivery = { events: [], chunks: [], terminalAcks: 0 };
		deliveries.push(delivery);
		const handle = broker.stream(
			"messages-api-v1",
			{
				method: params.method,
				url: params.url,
				headers: params.headers,
				body: new Uint8Array(0),
			},
			binding,
			reference,
			credential,
			original.signal,
			async (notification) => {
				if (notification.method !== "host/stream.chunk")
					throw new Error("Unexpected native notification");
				delivery.events.push("chunk");
				delivery.chunks.push(notification.params);
				const forward = () => host.notify(notification);
				if (options.deliver) await options.deliver(index, notification.params, forward);
				else forward();
				if (notification.params.done) delivery.terminalAcks++;
			},
		);
		handles.push(handle);
		completions.push(
			handle.completion.then(
				() => "complete",
				() => "refused",
			),
		);
		const response = await handle.response;
		delivery.events.push("response");
		expect(delivery.chunks).toEqual([]);
		setImmediate(() => {
			delivery.events.push("start");
			handle.start();
		});
		return response;
	});
	closeHost = () => host.close();
	const base = createPluginContext(
		{
			plugin: manifest.id,
			instance: { id: credential.ownerId, config: { model: configuredModel } },
		},
		host,
		original.signal,
	);
	const context: PluginContext = {
		...base,
		fetch: (input, init) => {
			expect(Object.hasOwn(init ?? {}, "stream")).toBe(false);
			return base.fetch(input, init);
		},
	};
	const tool = entry.tools.find((candidate) => candidate.name === operation);
	if (!tool) throw new Error("Missing mounted metadata tool");
	const invoke = () =>
		Promise.resolve(tool.handler(args, context, {}, { progress: async () => {} }));
	return { original, invoke, requests, deliveries, handles, completions, secret };
}

async function peer(reply: (response: ServerResponse, url: string) => void) {
	const sockets = new Set<Socket>();
	const seen = {
		paths: [] as string[],
		headers: [] as IncomingMessage["headers"][],
		bodies: [] as string[],
	};
	const server = createServer({ key: tls.key, cert: tls.cert }, (request, response) => {
		seen.paths.push(request.url ?? "");
		seen.headers.push(request.headers);
		response.setHeader("content-type", "application/json");
		const bytes: Buffer[] = [];
		request.on("data", (chunk: Buffer) => bytes.push(chunk));
		request.once("end", () => {
			seen.bodies.push(Buffer.concat(bytes).toString());
			reply(response, request.url ?? "");
		});
	});
	server.on("connection", (socket) => {
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
async function complete(f: Awaited<ReturnType<typeof fixture>>) {
	expect(await Promise.all(f.completions)).toEqual(f.completions.map(() => "complete"));
	for (const delivery of f.deliveries) {
		expect(delivery.events.slice(0, 2)).toEqual(["response", "start"]);
		expect(delivery.terminalAcks).toBe(1);
		expect(delivery.chunks.at(-1)).toMatchObject({ done: true });
		expect(delivery.chunks.at(-1)).not.toHaveProperty("error");
		for (const [sequence, chunk] of delivery.chunks.entries())
			expect(chunk.sequence).toBe(sequence);
	}
}

describe("mounted Messages metadata through the native broker", () => {
	it("paginates with omitted stream, original call identity and real sink backpressure", async () => {
		const entered = deferred(),
			release = deferred();
		const f = await fixture(
			"ai_models_list",
			{},
			{
				deliver: async (index, chunk, forward) => {
					if (index === 0 && !chunk.done) {
						entered.resolve();
						await release.promise;
					}
					forward();
				},
			},
		);
		const remote = await peer((response, url) =>
			response.end(url.includes("after_id") ? page("claude-page-2") : page("claude-page-1", true)),
		);
		cleanups.push(release.resolve);
		await withNetworkTestHooks(remote.hooks, async () => {
			let settled = false;
			const result = f.invoke().finally(() => {
				settled = true;
			});
			await Promise.race([
				entered.promise,
				result.then(() => {
					throw new Error("Metadata completed before the held ACK");
				}),
			]);
			await turn();
			expect(settled).toBe(false);
			expect(f.deliveries[0]?.chunks).toHaveLength(1);
			expect(remote.seen.paths).toEqual(["/v1/models?limit=100"]);
			release.resolve();
			await expect(result).resolves.toEqual({
				models: [
					{ id: "claude-page-1", name: "Synthetic model", contextTokens: 12_345 },
					{ id: "claude-page-2", name: "Synthetic model", contextTokens: 12_345 },
				],
			});
			await complete(f);
		});
		expect(remote.seen.paths).toEqual([
			"/v1/models?limit=100",
			"/v1/models?limit=100&after_id=claude-page-1",
		]);
		expect(remote.seen.bodies).toEqual(["", ""]);
		for (const headers of remote.seen.headers) expect(headers["x-api-key"]).toBe(f.secret);
	});
	it.each([undefined, "claude-explicit-model"])(
		"probes mounted metadata with the independent configured or explicit model %s",
		async (selected) => {
			const args = selected === undefined ? {} : { model: selected };
			const f = await fixture("ai_probe", args);
			const remote = await peer((response) =>
				response.end(JSON.stringify(model(selected ?? configuredModel))),
			);
			await withNetworkTestHooks(remote.hooks, async () => {
				await expect(f.invoke()).resolves.toEqual({ status: "ok" });
				await complete(f);
			});
			expect(remote.seen.paths).toEqual([`/v1/models/${selected ?? configuredModel}`]);
			expect(remote.seen.headers[0]?.["x-api-key"]).toBe(f.secret);
			expect(f.requests).toHaveLength(1);
		},
	);
	it("refuses the mounted next page while the actual terminal ACK is withheld", async () => {
		const ack = deferred();
		const f = await fixture(
			"ai_models_list",
			{},
			{
				deliver: async (index, chunk, forward) => {
					forward();
					if (index === 0 && chunk.done) await ack.promise;
				},
			},
		);
		const remote = await peer((response) => response.end(page("claude-page-1", true)));
		cleanups.push(ack.resolve);
		await withNetworkTestHooks(remote.hooks, async () => {
			await expect(f.invoke()).rejects.toMatchObject({ result: { code: "TRANSIENT" } });
			expect(f.requests).toHaveLength(2);
			expect(await Promise.all(f.completions)).toEqual(["refused", "refused"]);
			ack.resolve();
		});
		expect(remote.seen.paths).toEqual(["/v1/models?limit=100"]);
	});
	it("cancels the original mounted call while a real native sink ACK is pending", async () => {
		const entered = deferred(),
			release = deferred();
		const f = await fixture(
			"ai_models_list",
			{},
			{
				deliver: async (_index, chunk, forward) => {
					if (!chunk.done) {
						entered.resolve();
						await release.promise;
					}
					forward();
				},
			},
		);
		const remote = await peer((response) => response.end(page("claude-page-1", true)));
		cleanups.push(release.resolve);
		await withNetworkTestHooks(remote.hooks, async () => {
			const result = expect(f.invoke()).rejects.toMatchObject({ result: { code: "TRANSIENT" } });
			await Promise.race([
				entered.promise,
				result.then(() => {
					throw new Error("Metadata failed before the held ACK");
				}),
			]);
			f.original.abort();
			await result;
			expect(await Promise.all(f.completions)).toEqual(["refused"]);
			release.resolve();
			await expect(f.invoke()).rejects.toMatchObject({ result: { code: "TRANSIENT" } });
		});
		expect(f.requests).toHaveLength(1);
		expect(remote.seen.paths).toEqual(["/v1/models?limit=100"]);
	});
	it("refuses page two after an actual encrypted-vault generation change", async () => {
		const f = await fixture(
			"ai_models_list",
			{},
			{
				beforeRequest: (index, rotate) => {
					if (index === 1) rotate();
				},
			},
		);
		const remote = await peer((response) => response.end(page("claude-page-1", true)));
		await withNetworkTestHooks(remote.hooks, async () => {
			await expect(f.invoke()).rejects.toMatchObject({ result: { code: "TRANSIENT" } });
			expect(f.requests).toHaveLength(2);
			expect(await Promise.all(f.completions)).toEqual(["complete", "refused"]);
		});
		expect(remote.seen.paths).toEqual(["/v1/models?limit=100"]);
	});
});
