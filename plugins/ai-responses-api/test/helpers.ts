import type { ServerResponse } from "node:http";
import { fileURLToPath } from "node:url";
import type {
	AiCandidateRequest,
	AiRequestBindingWithoutNetwork,
	ProviderHttpStream,
	ResponsesMetadataBindingWithoutNetwork,
} from "@draftyak/hub";
import type { DraftOutputV1 } from "@draftyak/protocol/draft-output";
import type { HostStreamChunk } from "@draftyak/protocol/host-channel";
import type { HostHandler, MemoryHost, PluginServerOptions, StdioHost } from "@draftyak/sdk";
import type { ResponsesFetch } from "../src/client.ts";
import type { DraftRequest } from "../src/index.ts";

export const input: DraftRequest = {
	model: "gpt-synthetic",
	system: "Draft a plain-text reply.",
	prompt: "Synthetic thread; propose Tuesday.",
	contextIds: ["c1"],
};
export const draft: DraftOutputV1 = {
	body: "Tuesday works for me.",
	ownerNotes: "Synthetic note.",
	needsOwnerInput: [],
	suspectedInstructions: false,
	contextRefs: ["c1"],
};
export const CANARY = "PRIVATE_SYNTHETIC_CANARY";
export function message(overrides: Record<string, unknown> = {}): Record<string, unknown> {
	return {
		status: "completed",
		model: input.model,
		usage: { input_tokens: 100, output_tokens: 50 },
		output: [
			{ type: "reasoning", summary: [] },
			{
				type: "message",
				role: "assistant",
				status: "completed",
				content: [{ type: "output_text", text: JSON.stringify(draft), annotations: [] }],
			},
		],
		...overrides,
	};
}

export interface MountedReply {
	readonly result?: {
		readonly structuredContent?: unknown;
		readonly isError?: boolean;
		readonly tools?: readonly { readonly name: string }[];
	};
	readonly error?: unknown;
}
export type MountedAsk = (
	method: string,
	params?: Record<string, unknown>,
) => Promise<MountedReply>;

/** Exercises the real SDK server with an isolated in-memory host and MCP transport. */
export async function mountedProvider(
	handler: HostHandler,
	check: (
		ask: MountedAsk,
		host: MemoryHost,
		notifications: unknown[],
		cancel: (requestId: number) => void,
	) => Promise<void>,
	options: PluginServerOptions = {},
): Promise<void> {
	const { memoryHost } = await import("@draftyak/sdk");
	const { startPlugin } = await import("../src/plugin.ts");
	const host = memoryHost(handler);
	const ready = Promise.withResolvers<void>();
	const pending = new Map<number, ReturnType<typeof Promise.withResolvers<MountedReply>>>();
	const notifications: unknown[] = [];
	let id = 0;
	const transport: StdioHost["transport"] = {
		async start() {
			ready.resolve();
		},
		async send(value) {
			if ("id" in value && typeof value.id === "number" && !("method" in value)) {
				pending.get(value.id)?.resolve(value as MountedReply);
				pending.delete(value.id);
			} else notifications.push(value);
		},
		async close() {
			for (const item of pending.values()) item.reject(new Error("Test transport closed"));
			pending.clear();
			transport.onclose?.();
		},
	};
	const handle = startPlugin("api-key", { ...options, host: { ...host, transport } });
	try {
		await ready.promise;
		await check(
			async (method, params = {}) => {
				const current = ++id;
				const reply = Promise.withResolvers<MountedReply>();
				void reply.promise.catch(() => undefined);
				pending.set(current, reply);
				transport.onmessage?.({
					jsonrpc: "2.0",
					id: current,
					method,
					params: {
						...params,
						_meta: {
							"io.modelcontextprotocol/protocolVersion": "2026-07-28",
							"io.modelcontextprotocol/clientCapabilities": {},
							...(params._meta as object),
						},
					},
				});
				return reply.promise;
			},
			host,
			notifications,
			(requestId) =>
				transport.onmessage?.({
					jsonrpc: "2.0",
					method: "notifications/cancelled",
					params: { requestId },
				}),
		);
	} finally {
		await handle.close();
		host.close();
	}
}

export function streamBytes(host: MemoryHost, streamId: string, bytes: Uint8Array): void {
	let sequence = 0;
	for (let offset = 0; offset < bytes.length; offset += 16_384)
		host.notify({
			jsonrpc: "2.0",
			method: "host/stream.chunk",
			params: {
				streamId,
				sequence: sequence++,
				base64: Buffer.from(bytes.subarray(offset, offset + 16_384)).toString("base64url"),
				done: false,
			},
		});
	host.notify({
		jsonrpc: "2.0",
		method: "host/stream.chunk",
		params: { streamId, sequence, base64: "", done: true },
	});
}

export interface NativeProviderFixture {
	readonly caller: AbortController;
	readonly handler: HostHandler;
	readonly fetch: ResponsesFetch;
	readonly streams: ProviderHttpStream[];
	readonly notifications: HostStreamChunk[];
	readonly candidates: AiCandidateRequest[];
	readonly seen: {
		methods: string[];
		paths: string[];
		bodies: string[];
		credentialMatched: boolean[];
		sni: string[];
	};
	readonly pendingAcks: (() => void)[];
	readonly bodyWritten: Promise<void>;
	readonly peerClosed: Promise<void>;
	useHost(host: MemoryHost): void;
	run<T>(work: () => Promise<T>): Promise<T>;
	acknowledge(): void;
	generation(): number;
	rotate(): void;
	snapshot(
		candidate: AiCandidateRequest,
	): ReturnType<typeof import("@draftyak/hub").snapshotVerifiedAiRequest>;
	close(): Promise<void>;
}

/** Controlled component fixture; it does not establish a production caller or transport ACK. */
export async function nativeProviderFixture(options: {
	readonly binding: AiRequestBindingWithoutNetwork | ResponsesMetadataBindingWithoutNetwork;
	readonly reply: (response: ServerResponse) => void;
	readonly holdAck?: "all" | "terminal";
	readonly manualStart?: boolean;
	readonly mutate?: (candidate: AiCandidateRequest) => AiCandidateRequest;
}): Promise<NativeProviderFixture> {
	const [
		{ randomBytes },
		fs,
		os,
		path,
		https,
		tlsModule,
		hub,
		sdk,
		fixture,
		storeFixture,
		ids,
		network,
	] = await Promise.all([
		import("node:crypto"),
		import("node:fs"),
		import("node:os"),
		import("node:path"),
		import("node:https"),
		import("node:tls"),
		import("@draftyak/hub"),
		import("@draftyak/sdk"),
		import("../../../apps/hub/test/plugins/broker/tls-fixture.ts"),
		import("../../../apps/hub/test/store/helpers.ts"),
		import("../../../apps/hub/src/kernel/ids.ts"),
		import("../../../apps/hub/src/plugins/broker/network/test-context.ts"),
	]);
	const certificate = await fixture.createTlsFixture(["api.openai.com"]);
	const directory = fs.mkdtempSync(path.join(os.tmpdir(), "draftyak-responses-native-"));
	const key = new hub.MasterKey(randomBytes(32));
	const auditKey = key.derive("audit");
	const audit = new hub.AuditChain(auditKey);
	auditKey.fill(0);
	let store: InstanceType<typeof hub.HubStore> | undefined;
	let broker: ReturnType<typeof hub.createProviderHttpBroker> | undefined;
	let server: ReturnType<typeof https.createServer> | undefined;
	let closed = false;
	const caller = new AbortController();
	const streams: ProviderHttpStream[] = [];
	const notifications: HostStreamChunk[] = [];
	const candidates: AiCandidateRequest[] = [];
	const pendingAcks: (() => void)[] = [];
	const sockets = new Set<import("node:net").Socket>();
	const bodyWritten = Promise.withResolvers<void>();
	const peerClosed = Promise.withResolvers<void>();
	let host: MemoryHost | undefined;
	const close = async (): Promise<void> => {
		if (closed) return;
		closed = true;
		caller.abort();
		for (const stream of streams) stream.cancel();
		for (const ack of pendingAcks.splice(0)) ack();
		broker?.close();
		await Promise.allSettled(streams.map((stream) => stream.completion));
		host?.close();
		const stopped = server?.listening
			? new Promise<void>((resolve, reject) =>
					server?.close((error) => (error ? reject(error) : resolve())),
				)
			: Promise.resolve();
		for (const socket of sockets) socket.destroy();
		await stopped;
		store?.close();
		audit.destroy();
		key.destroy();
		certificate.key.fill(0);
		if (
			path.dirname(directory) !== path.resolve(os.tmpdir()) ||
			!path.basename(directory).startsWith("draftyak-responses-native-")
		)
			throw new Error("Fixture cleanup boundary refused");
		fs.rmSync(directory, { recursive: true, force: true });
	};
	try {
		store = new hub.HubStore({
			filename: path.join(directory, "hub.db"),
			nativeBinding: storeFixture.nativeBinding,
			masterKey: key,
			create: true,
			migrations: {
				audit: path.join(storeFixture.migrations, "audit"),
				credentials: fileURLToPath(
					new URL("../../../apps/hub/src/credentials/migrations/", import.meta.url),
				),
			},
		});
		await store.migrate("audit");
		await store.migrate("credentials");
		const vault = new hub.CredentialVault(store, audit);
		const registry = hub.createBuiltinAiProfileRegistry();
		const credential = {
			ownerKind: "provider" as const,
			ownerId: ids.newId(),
			kind: "provider-key" as const,
		};
		let secret = `DYTEST-${randomBytes(20).toString("hex")}`;
		const reference = store.write((tx) =>
			vault.createInTransaction(tx, credential, { kind: "provider-key", key: secret }),
		);
		const policy = { deniedAddresses: [], deniedPorts: [] };
		const pin = { address: "8.8.8.8", family: 4 as const };
		broker = hub.createProviderHttpBroker({ vault, registry, networkPolicy: policy });
		const actualBroker = broker;
		const seen = {
			methods: [] as string[],
			paths: [] as string[],
			bodies: [] as string[],
			credentialMatched: [] as boolean[],
			sni: [] as string[],
		};
		server = https.createServer(
			{
				key: certificate.key,
				cert: certificate.cert,
				SNICallback(name, callback) {
					seen.sni.push(name);
					callback(
						null,
						tlsModule.createSecureContext({ key: certificate.key, cert: certificate.cert }),
					);
				},
			},
			(request, response) => {
				seen.methods.push(request.method ?? "");
				seen.paths.push(request.url ?? "");
				seen.credentialMatched.push(request.headers.authorization === `Bearer ${secret}`);
				const chunks: Buffer[] = [];
				request.on("data", (bytes: Buffer) => chunks.push(bytes));
				request.once("end", () => {
					seen.bodies.push(Buffer.concat(chunks).toString());
					response.once("finish", () => bodyWritten.resolve());
					options.reply(response);
				});
			},
		);
		server.on("connection", (socket) => {
			sockets.add(socket);
			socket.once("close", () => {
				sockets.delete(socket);
				peerClosed.resolve();
			});
		});
		await new Promise<void>((resolve, reject) => {
			server?.once("error", reject);
			server?.listen(0, "127.0.0.1", resolve);
		});
		const port = (server.address() as import("node:net").AddressInfo).port;
		let destination: MemoryHost;
		const handler: HostHandler = async (method, raw, perHttpSignal) => {
			if (method !== "host/fetch") throw new Error("Unexpected native fixture request");
			if (perHttpSignal === caller.signal) throw new Error("Expected distinct HTTP request scope");
			const { HostFetchParams } = await import("@draftyak/protocol/host-channel");
			const params = HostFetchParams.parse(raw);
			if (params.stream !== true || (params.body && !("base64" in params.body)))
				throw new Error("Expected stream and inline request bytes");
			let candidate: AiCandidateRequest = {
				method: params.method,
				url: params.url,
				headers: params.headers,
				body:
					params.body && "base64" in params.body
						? Buffer.from(params.body.base64, "base64url")
						: new Uint8Array(),
			};
			if (options.mutate) candidate = options.mutate(candidate);
			candidates.push(candidate);
			const handle = actualBroker.stream(
				"responses-api-v1",
				candidate,
				options.binding,
				reference,
				credential,
				caller.signal,
				async (notification) => {
					if (notification.method !== "host/stream.chunk")
						throw new Error("Unexpected native notification");
					notifications.push(notification.params);
					destination.notify(notification);
					if (
						options.holdAck === "all" ||
						(options.holdAck === "terminal" && notification.params.done)
					)
						await new Promise<void>((resolve) => pendingAcks.push(resolve));
				},
			);
			streams.push(handle);
			void handle.completion.catch(() => undefined);
			const response = await handle.response;
			if (!options.manualStart) setImmediate(() => handle.start());
			return response;
		};
		host = sdk.memoryHost(handler);
		destination = host;
		const context = sdk.createPluginContext(
			{ plugin: "@draftyak/ai-responses-api" },
			host,
			caller.signal,
		);
		return {
			caller,
			handler,
			streams,
			notifications,
			candidates,
			seen,
			pendingAcks,
			bodyWritten: bodyWritten.promise,
			peerClosed: peerClosed.promise,
			fetch: (input, init) => context.fetch(input, { ...init, stream: true }),
			useHost(value) {
				destination = value;
			},
			run(work) {
				return network.withNetworkTestHooks(
					{
						ca: certificate.ca,
						resolve: async (name) => {
							if (name !== "api.openai.com") throw new Error("Unexpected fixture origin");
							return [pin];
						},
						dial: (address, requestedPort) => {
							if (address.address !== pin.address || requestedPort !== 443)
								throw new Error("Unexpected pinned fixture destination");
							return { address: "127.0.0.1", family: 4, port };
						},
					},
					work,
				);
			},
			acknowledge() {
				pendingAcks.shift()?.();
			},
			generation() {
				return vault.describe(reference, credential).generation;
			},
			rotate() {
				secret = `DYTEST-${randomBytes(20).toString("hex")}`;
				store?.write((tx) =>
					vault.replaceInTransaction(tx, reference, credential, {
						kind: "provider-key",
						key: secret,
					}),
				);
			},
			snapshot(candidate) {
				const captured =
					"operation" in options.binding
						? hub.captureResponsesMetadataInputs(candidate, options.binding)
						: hub.captureAiRequestInputs(candidate, options.binding);
				return hub.snapshotVerifiedAiRequest(
					hub.verifyCapturedAiRequest(registry, "responses-api-v1", captured, {
						answers: [pin],
						policy,
					}),
				);
			},
			close,
		};
	} catch (error) {
		await close();
		throw error;
	}
}
