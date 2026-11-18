import { AsyncLocalStorage } from "node:async_hooks";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { type AddressInfo, Socket } from "node:net";
import { setImmediate as turn } from "node:timers/promises";
import { type HostNotification, HostStreamChunk } from "@draftyak/protocol/host-channel";
import { MAX_INLINE_BYTES } from "@draftyak/protocol/normalized-change";
import { afterEach, describe, expect, it } from "vitest";
import {
	type AiCandidateRequest,
	AiVerificationError,
	aiRequestTransport,
	captureAiRequestInputs,
	createBuiltinAiProfileRegistry,
	snapshotVerifiedAiRequest,
	verifyCapturedAiRequest,
} from "../../../src/plugins/broker/ai/index.ts";
import { compatibleSchema } from "../../../src/plugins/broker/ai/schemas.ts";
import {
	BLOCKED_LOOPBACK_PORTS,
	type PinnedAddress,
} from "../../../src/plugins/broker/network/index.ts";
import { withNetworkTestHooks } from "../../../src/plugins/broker/network/test-context.ts";
import {
	createProviderHttpBroker,
	type ProviderHttpBroker,
	ProviderHttpError,
} from "../../../src/plugins/broker/provider-http.ts";

const policy = { deniedAddresses: [], deniedPorts: [], allowLocal: true };
const loopback = [{ address: "127.0.0.1", family: 4 as const }];
const credential = {
	ownerKind: "provider" as const,
	ownerId: "01ARZ3NDEKTSV4RRFFQ69G5FAV",
	kind: "provider-key" as const,
};
const encoder = new TextEncoder();
const brokers: ProviderHttpBroker[] = [];
const controllers: AbortController[] = [];
const work: Promise<unknown>[] = [];
const releases: (() => void)[] = [];
const peers: Peer[] = [];
let tearingDown = false;

function own<T>(original: Promise<T>): Promise<T> {
	void original.catch(() => undefined);
	work.push(original);
	return original;
}

function deferred<T>() {
	let resolve: (value: T) => void = () => {};
	const promise = new Promise<T>((settle) => {
		resolve = settle;
	});
	return { promise, resolve };
}

interface Received {
	readonly method: string | undefined;
	readonly url: string | undefined;
	readonly host: string | undefined;
	readonly authorization: string | undefined;
	readonly apiKey: string | undefined;
	body: Buffer;
}
interface Peer {
	origin: string;
	port: number;
	readonly received: Received[];
	readonly inboundBytes: number;
	close(): Promise<void>;
}

async function peer(
	reply: (response: ServerResponse, request: IncomingMessage) => void,
): Promise<Peer> {
	const sockets: { socket: Socket; closed: Promise<void> }[] = [];
	const messageCloses: Promise<void>[] = [];
	const received: Received[] = [];
	let inboundBytes = 0;
	let listened = false;
	let fixtureFailed = false;
	let cleanup: Promise<void> | undefined;
	const server = createServer((request, response) => {
		messageCloses.push(new Promise<void>((resolve) => request.once("close", () => resolve())));
		messageCloses.push(new Promise<void>((resolve) => response.once("close", () => resolve())));
		const record: Received = {
			method: request.method,
			url: request.url,
			host: request.headers.host,
			authorization: request.headers.authorization,
			apiKey: request.headers["x-api-key"] as string | undefined,
			body: Buffer.alloc(0),
		};
		received.push(record);
		const chunks: Buffer[] = [];
		request.on("error", () => {});
		response.on("error", () => {});
		request.on("data", (bytes: Buffer) => chunks.push(Buffer.from(bytes)));
		request.once("end", () => {
			record.body = Buffer.concat(chunks);
			try {
				reply(response, request);
			} catch {
				fixtureFailed = true;
				response.destroy();
			}
		});
	});
	server.on("error", () => {
		fixtureFailed = true;
	});
	const serverClosed = new Promise<void>((resolve) => server.once("close", resolve));
	server.on("connection", (socket) => {
		const closed = new Promise<void>((resolve) => socket.once("close", () => resolve()));
		socket.on("error", () => {});
		socket.on("data", (bytes: Buffer) => {
			inboundBytes += bytes.length;
		});
		sockets.push({ socket, closed });
	});
	const value: Peer = {
		origin: "",
		port: 0,
		received,
		get inboundBytes() {
			return inboundBytes;
		},
		close() {
			cleanup ??= (async () => {
				const closeCallback = new Promise<Error | undefined>((resolve) => {
					server.close((error) => resolve(error));
				});
				for (const { socket } of sockets) socket.destroy();
				const error = await closeCallback;
				if (listened) {
					await serverClosed;
				}
				await Promise.all(sockets.map(({ closed }) => closed));
				await Promise.all(messageCloses);
				if (listened && error) throw new Error("HTTP fixture close failed");
				if (fixtureFailed) throw new Error("HTTP fixture failed");
			})();
			return cleanup;
		},
	};
	peers.push(value);
	await new Promise<void>((resolve, reject) => {
		server.once("error", reject);
		server.listen(0, "127.0.0.1", () => {
			server.removeListener("error", reject);
			listened = true;
			resolve();
		});
	});
	value.port = (server.address() as AddressInfo).port;
	value.origin = `http://127.0.0.1:${value.port}`;
	return value;
}

function broker(): ProviderHttpBroker {
	if (tearingDown) throw new Error("Fixture is closing");
	const value = createProviderHttpBroker({
		registry: createBuiltinAiProfileRegistry(),
		networkPolicy: policy,
	});
	brokers.push(value);
	return value;
}

function signal(): AbortController {
	const controller = new AbortController();
	controllers.push(controller);
	return controller;
}

function input(origin: string) {
	const endpoint = `${origin}/v1/chat/completions`;
	const draft = {
		model: "model-2026-01",
		system: "DYTEST-system",
		prompt: "DYTEST-prompt",
		contextIds: [],
	};
	const body = {
		model: draft.model,
		messages: [
			{ role: "system", content: draft.system },
			{ role: "user", content: draft.prompt },
		],
		response_format: {
			type: "json_schema",
			json_schema: { name: "draft_output_v1", strict: true, schema: compatibleSchema() },
		},
		stream: false,
	};
	return {
		binding: {
			endpoint,
			draft,
			settings: {
				kind: "compatible" as const,
				format: "json_schema" as const,
				allowPlaintextLan: false,
			},
			authentication: "none" as "none" | "provider-key",
			expectedDestination: "local" as "local" | "local-network" | "cloud",
		},
		candidate: {
			method: "POST",
			url: endpoint,
			headers: [["content-type", "application/json"]],
			body: encoder.encode(JSON.stringify(body)),
		} satisfies AiCandidateRequest,
	};
}

function run(value: ProviderHttpBroker, data: ReturnType<typeof input>, controller = signal()) {
	return own(
		value.execute(
			"chat-completions-v1",
			data.candidate,
			data.binding,
			undefined,
			undefined,
			controller.signal,
		),
	);
}

function withFence(
	value: ProviderHttpBroker,
	data: ReturnType<typeof input>,
	fence: unknown,
	controller = signal(),
): Promise<unknown> {
	return own(
		Reflect.apply(value.execute, value, [
			"chat-completions-v1",
			data.candidate,
			data.binding,
			undefined,
			undefined,
			controller.signal,
			fence,
		]),
	);
}

async function observedBeforeSettlement(
	observation: Promise<void>,
	original: Promise<unknown>,
): Promise<void> {
	await Promise.race([
		observation,
		original.then(
			() => {
				throw new Error("Request settled before fixture observation");
			},
			() => {
				throw new Error("Request settled before fixture observation");
			},
		),
	]);
}

afterEach(async () => {
	tearingDown = true;
	const failures: unknown[] = [];
	try {
		for (const controller of controllers.splice(0)) controller.abort();
		for (const value of brokers.splice(0)) {
			try {
				value.close();
			} catch (error) {
				failures.push(error);
			}
		}
		for (const release of releases.splice(0)) release();
		const closes = peers.splice(0).map((value) => value.close());
		const outcomes = await Promise.allSettled([...work.splice(0), ...closes]);
		for (const outcome of outcomes.slice(outcomes.length - closes.length)) {
			if (outcome.status === "rejected") failures.push(outcome.reason);
		}
		if (failures.length) throw new Error("HTTP fixture cleanup failed");
	} finally {
		tearingDown = false;
	}
});

describe("compatible loopback provider broker", () => {
	it("preserves legacy keyed HTTPS local routing when both transport fields are omitted", () => {
		const data = input("https://models.example:11434");
		const captured = captureAiRequestInputs(data.candidate, {
			endpoint: data.binding.endpoint,
			draft: data.binding.draft,
			settings: data.binding.settings,
		});
		expect(aiRequestTransport(captured).authentication).toBe("provider-key");
		expect(aiRequestTransport(captured).expectedDestination).toBeUndefined();
		const registry = createBuiltinAiProfileRegistry();
		for (const answer of [
			{ address: "127.0.0.1", family: 4 },
			{ address: "::1", family: 6 },
			{ address: "192.168.199.17", family: 4 },
		] as const) {
			const verified = verifyCapturedAiRequest(registry, "chat-completions-v1", captured, {
				answers: [answer],
				policy,
			});
			expect(snapshotVerifiedAiRequest(verified).url).toBe(data.binding.endpoint);
			expect(snapshotVerifiedAiRequest(verified).body).toEqual(data.candidate.body);
		}
	});

	it("requires an explicit destination when provider-key authentication is explicitly supplied", () => {
		const data = input("https://models.example");
		expect(() =>
			captureAiRequestInputs(data.candidate, {
				endpoint: data.binding.endpoint,
				draft: data.binding.draft,
				settings: data.binding.settings,
				authentication: "provider-key",
			}),
		).toThrow(AiVerificationError);
	});

	it("keeps explicit native destinations captured across caller mutation", async () => {
		const data = input("https://models.example");
		for (const expected of ["local", "cloud"] as const) {
			const native = {
				endpoint: data.binding.endpoint,
				draft: data.binding.draft,
				settings: data.binding.settings,
				...(expected === "local" ? { authentication: "provider-key" } : {}),
				expectedDestination: expected,
			};
			const captured = captureAiRequestInputs(data.candidate, native);
			await Promise.resolve();
			native.expectedDestination = expected === "local" ? "cloud" : "local";
			expect(aiRequestTransport(captured).expectedDestination).toBe(expected);
		}
	});

	it("uses the real broker without a vault or authorization header for explicit no-key loopback HTTP", async () => {
		const body = "DYTEST-local-response brokered";
		const target = await peer((response) => response.end(body));
		const data = input(target.origin);
		const expectedBody = Buffer.from(data.candidate.body);
		const outcome = await run(broker(), data).then(
			(result) => ({ kind: "fulfilled" as const, result }),
			() => ({ kind: "refused" as const }),
		);
		expect(outcome.kind).toBe("fulfilled");
		if (outcome.kind !== "fulfilled") throw new Error("Expected the actual broker result");
		const result = outcome.result;
		expect(result.body).toEqual({ base64: Buffer.from(body).toString("base64url") });
		expect(target.received).toHaveLength(1);
		expect(target.received[0]).toMatchObject({
			method: "POST",
			url: "/v1/chat/completions",
			authorization: undefined,
			apiKey: undefined,
		});
		expect(target.received[0]?.body).toEqual(expectedBody);
	});

	it("uses HTTP port 80 and the original Host authority when the URL omits its port", async () => {
		const target = await peer((response) => response.end("default-http-port"));
		const data = input("http://models.example");
		const expectedBody = Buffer.from(data.candidate.body);
		const value = createProviderHttpBroker({
			registry: createBuiltinAiProfileRegistry(),
			networkPolicy: { ...policy, deniedPorts: [443] },
		});
		brokers.push(value);
		const requestedPorts: number[] = [];
		let resolves = 0;
		await withNetworkTestHooks(
			{
				resolve: async () => {
					resolves++;
					return loopback;
				},
				dial: (pin, port) => {
					requestedPorts.push(port);
					return { ...pin, port: target.port };
				},
			},
			async () => {
				const outcome = await run(value, data).then(
					(result) => ({ kind: "fulfilled" as const, result }),
					() => ({ kind: "refused" as const }),
				);
				expect(outcome.kind).toBe("fulfilled");
				if (outcome.kind !== "fulfilled")
					throw new Error("Expected the actual default-port response");
				expect(outcome.result.body).toEqual({
					base64: Buffer.from("default-http-port").toString("base64url"),
				});
			},
		);
		expect(resolves).toBe(1);
		expect(requestedPorts).toEqual([80]);
		expect(target.received).toHaveLength(1);
		expect(target.received[0]).toMatchObject({
			host: "models.example",
			method: "POST",
			url: "/v1/chat/completions",
			authorization: undefined,
			apiKey: undefined,
		});
		expect(target.received[0]?.body).toEqual(expectedBody);
	});

	it("refuses a captured native fence revoked while actual DNS is pending", async () => {
		const target = await peer((response) => response.end("would-succeed"));
		const entered = deferred<void>(),
			resolution = deferred<readonly PinnedAddress[]>();
		releases.push(() => resolution.resolve(loopback));
		let current = true,
			dials = 0,
			calls = 0,
			badInvocation = false;
		const fence = function (this: unknown, ...args: unknown[]): undefined {
			calls++;
			badInvocation ||= this !== undefined || args.length !== 0;
			if (!current) throw new Error("Revoked test scope");
			return undefined;
		};
		await withNetworkTestHooks(
			{
				resolve: () => {
					entered.resolve();
					return resolution.promise;
				},
				dial: (pin, port) => {
					dials++;
					return { ...pin, port };
				},
			},
			async () => {
				const request = withFence(broker(), input(`http://models.example:${target.port}`), fence);
				await observedBeforeSettlement(entered.promise, request);
				current = false;
				resolution.resolve(loopback);
				const outcome = await request.then(
					() => "fulfilled",
					(error) => (error instanceof ProviderHttpError ? "refused" : "other"),
				);
				expect(outcome).toBe("refused");
			},
		);
		expect(calls).toBeGreaterThan(0);
		expect(badInvocation).toBe(false);
		expect(dials).toBe(0);
		expect(target.inboundBytes).toBe(0);
	});

	it("rechecks native currentness at the actual peer before releasing queued HTTP bytes", async () => {
		const target = await peer((response) => response.end("would-succeed"));
		const scope = new AsyncLocalStorage<boolean>(),
			originalConnect = Socket.prototype.connect;
		const clientCloses: Promise<void>[] = [];
		const value = broker(),
			controller = signal();
		let current = true,
			connected = 0;
		const fence = (): undefined => {
			if (!current) throw new Error("Revoked test scope");
			return undefined;
		};
		Socket.prototype.connect = function (this: Socket, ...args: unknown[]) {
			if (scope.getStore()) {
				clientCloses.push(own(new Promise<void>((resolve) => this.once("close", () => resolve()))));
				this.prependOnceListener("connect", () => {
					if (this.remoteAddress === "127.0.0.1" && this.remotePort === target.port) {
						connected++;
						current = false;
					}
				});
			}
			return Reflect.apply(originalConnect, this, args);
		};
		try {
			await scope.run(true, () =>
				withNetworkTestHooks({ resolve: async () => loopback }, async () => {
					const outcome = await withFence(
						value,
						input(`http://models.example:${target.port}`),
						fence,
						controller,
					).then(
						() => "fulfilled",
						(error) => (error instanceof ProviderHttpError ? "refused" : "other"),
					);
					expect(outcome).toBe("refused");
					expect(connected).toBe(1);
				}),
			);
		} finally {
			controller.abort();
			value.close();
			try {
				await Promise.all(clientCloses);
			} finally {
				Socket.prototype.connect = originalConnect;
			}
		}
		await turn();
		expect(target.inboundBytes).toBe(0);
		expect(target.received).toEqual([]);
	});

	it.each(["non-function", "non-undefined return", "async return"] as const)(
		"refuses an invalid native fence: %s",
		async (kind) => {
			const asyncResult = own(Promise.resolve(undefined));
			const fence =
				kind === "non-function"
					? null
					: kind === "non-undefined return"
						? () => true
						: () => asyncResult;
			let resolves = 0;
			await withNetworkTestHooks(
				{
					resolve: async () => {
						resolves++;
						return loopback;
					},
				},
				async () => {
					await expect(
						withFence(broker(), input("http://models.example:8080"), fence),
					).rejects.toBeInstanceOf(ProviderHttpError);
				},
			);
			await asyncResult;
			expect(resolves).toBe(0);
		},
	);

	it("streams no-key bytes after start without withholding a fictional key suffix", async () => {
		const target = await peer((response) => {
			response.write("first-");
			response.end("last");
		});
		const data = input(target.origin);
		const notifications: HostNotification[] = [];
		const controller = signal();
		const stream = broker().stream(
			"chat-completions-v1",
			data.candidate,
			data.binding,
			undefined,
			undefined,
			controller.signal,
			async (notification) => {
				notifications.push(notification);
			},
		);
		own(stream.response);
		own(stream.completion);
		const response = await stream.response;
		expect(response.streamId).toBeDefined();
		expect(notifications).toEqual([]);
		stream.start();
		const completion = await stream.completion.then(
			() => "fulfilled",
			() => "refused",
		);
		expect(completion).toBe("fulfilled");
		const chunks = notifications.map((notification) => HostStreamChunk.parse(notification.params));
		expect(chunks.map(({ sequence }) => sequence)).toEqual(chunks.map((_, index) => index));
		expect(chunks.at(-1)).toMatchObject({ done: true });
		expect(chunks.some(({ error }) => error !== undefined)).toBe(false);
		expect(
			Buffer.concat(chunks.map(({ base64 }) => Buffer.from(base64, "base64url"))).toString(),
		).toBe("first-last");
	});

	it("withholds stream content when its native fence is revoked before start", async () => {
		const target = await peer((response) => response.end("must-not-be-delivered"));
		const data = input(target.origin),
			notifications: HostNotification[] = [];
		let current = true;
		const fence = (): undefined => {
			if (!current) throw new Error("Revoked test scope");
			return undefined;
		};
		const stream = broker().stream(
			"chat-completions-v1",
			data.candidate,
			data.binding,
			undefined,
			undefined,
			signal().signal,
			async (notification) => {
				notifications.push(notification);
			},
			fence,
		);
		own(stream.response);
		own(stream.completion);
		await stream.response;
		expect(notifications).toEqual([]);
		current = false;
		stream.start();
		const completion = await stream.completion.then(
			() => "fulfilled",
			() => "refused",
		);
		expect(completion).toBe("refused");
		const chunks = notifications.map((notification) => HostStreamChunk.parse(notification.params));
		expect(chunks).toHaveLength(1);
		expect(chunks[0]).toMatchObject({ base64: "", done: true, error: "DENIED" });
	});

	it.each(["reference", "credential"] as const)(
		"refuses an unexpected %s in explicit no-key mode",
		async (extra) => {
			const target = await peer((response) => response.end("unused"));
			const data = input(target.origin);
			const request = own(
				broker().execute(
					"chat-completions-v1",
					data.candidate,
					data.binding,
					extra === "reference" ? "DYTEST-reference" : undefined,
					extra === "credential" ? credential : undefined,
					signal().signal,
				),
			);
			const outcome = await request.then(
				() => "fulfilled",
				(error) => (error instanceof ProviderHttpError ? "refused" : "other"),
			);
			expect(outcome).toBe("refused");
			expect(target.received).toEqual([]);
		},
	);

	it("keeps keyed HTTPS fail-closed when no real vault is supplied", async () => {
		const data = input("https://compatible.example");
		data.binding.authentication = "provider-key";
		data.binding.expectedDestination = "cloud";
		let dials = 0;
		await withNetworkTestHooks(
			{
				resolve: async () => [{ address: "8.8.8.8", family: 4 }],
				dial: () => {
					dials++;
					throw new Error("Unexpected keyed dial");
				},
			},
			async () => {
				await expect(
					own(
						broker().execute(
							"chat-completions-v1",
							data.candidate,
							data.binding,
							"DYTEST-reference",
							credential,
							signal().signal,
						),
					),
				).rejects.toBeInstanceOf(ProviderHttpError);
			},
		);
		expect(dials).toBe(0);
	});

	it("requires an explicit local expectation for no-key mode before any connection", async () => {
		const target = await peer((response) => response.end("unused"));
		const data = input(target.origin);
		data.binding.expectedDestination = "cloud";
		await expect(run(broker(), data)).rejects.toBeInstanceOf(ProviderHttpError);
		expect(target.received).toEqual([]);
	});

	it.each(["authentication", "expectedDestination"] as const)(
		"refuses an omitted %s for the no-vault local invocation before DNS",
		async (field) => {
			const data = input("http://models.example:8080");
			Reflect.deleteProperty(data.binding, field);
			let resolves = 0;
			let dials = 0;
			await withNetworkTestHooks(
				{
					resolve: async () => {
						resolves++;
						return loopback;
					},
					dial: () => {
						dials++;
						throw new Error("Unexpected omitted-field dial");
					},
				},
				async () => {
					await expect(run(broker(), data)).rejects.toBeInstanceOf(ProviderHttpError);
				},
			);
			expect(resolves).toBe(0);
			expect(dials).toBe(0);
		},
	);

	it.each([
		{ field: "authentication", value: "NONE" },
		{ field: "authentication", value: null },
		{ field: "authentication", value: 1 },
		{ field: "expectedDestination", value: "loopback" },
		{ field: "expectedDestination", value: null },
		{ field: "expectedDestination", value: true },
	])("refuses malformed $field data before DNS %#", async ({ field, value }) => {
		const data = input("http://models.example:8080");
		Object.defineProperty(data.binding, field, { value, enumerable: true });
		let resolves = 0;
		let dials = 0;
		await withNetworkTestHooks(
			{
				resolve: async () => {
					resolves++;
					return loopback;
				},
				dial: () => {
					dials++;
					throw new Error("Unexpected malformed-field dial");
				},
			},
			async () => {
				await expect(run(broker(), data)).rejects.toBeInstanceOf(ProviderHttpError);
			},
		);
		expect(resolves).toBe(0);
		expect(dials).toBe(0);
	});

	it.each(["authentication", "expectedDestination"] as const)(
		"refuses accessor %s without invoking it or starting DNS",
		async (field) => {
			const data = input("http://models.example:8080");
			let hooks = 0;
			Object.defineProperty(data.binding, field, {
				enumerable: true,
				get() {
					hooks++;
					return field === "authentication" ? "none" : "local";
				},
			});
			let resolves = 0;
			let dials = 0;
			await withNetworkTestHooks(
				{
					resolve: async () => {
						resolves++;
						return loopback;
					},
					dial: () => {
						dials++;
						throw new Error("Unexpected accessor-field dial");
					},
				},
				async () => {
					await expect(run(broker(), data)).rejects.toBeInstanceOf(ProviderHttpError);
				},
			);
			expect(hooks).toBe(0);
			expect(resolves).toBe(0);
			expect(dials).toBe(0);
		},
	);

	it("refuses a proxied native binding without hooks or DNS", async () => {
		const data = input("http://models.example:8080");
		let hooks = 0;
		data.binding = new Proxy(data.binding, {
			getPrototypeOf() {
				hooks++;
				throw new Error("Unexpected binding proxy hook");
			},
			ownKeys() {
				hooks++;
				throw new Error("Unexpected binding proxy hook");
			},
			getOwnPropertyDescriptor() {
				hooks++;
				throw new Error("Unexpected binding proxy hook");
			},
		});
		let resolves = 0;
		let dials = 0;
		await withNetworkTestHooks(
			{
				resolve: async () => {
					resolves++;
					return loopback;
				},
				dial: () => {
					dials++;
					throw new Error("Unexpected proxy-binding dial");
				},
			},
			async () => {
				await expect(run(broker(), data)).rejects.toBeInstanceOf(ProviderHttpError);
			},
		);
		expect(hooks).toBe(0);
		expect(resolves).toBe(0);
		expect(dials).toBe(0);
	});

	it.each([
		{
			answers: [
				{ address: "127.0.0.1", family: 4 },
				{ address: "8.8.8.8", family: 4 },
			],
		},
		{ answers: [{ address: "::ffff:127.0.0.1", family: 6 }] },
	] satisfies readonly { answers: PinnedAddress[] }[])(
		"retains mixed and mapped answer refusal %# before dialing",
		async ({ answers }) => {
			const target = await peer((response) => response.end("unused"));
			const data = input(`http://models.example:${target.port}`);
			let dials = 0;
			await withNetworkTestHooks(
				{
					resolve: async () => answers,
					dial: () => {
						dials++;
						return { address: "127.0.0.1", family: 4, port: target.port };
					},
				},
				async () => {
					await expect(run(broker(), data)).rejects.toBeInstanceOf(ProviderHttpError);
				},
			);
			expect(dials).toBe(0);
			expect(target.received).toEqual([]);
		},
	);

	it.each(["8.8.8.8", "10.0.0.1"])(
		"refuses non-loopback HTTP answer %s before dialing",
		async (address) => {
			const target = await peer((response) => response.end("unused"));
			const data = input(`http://models.example:${target.port}`);
			let dials = 0;
			await withNetworkTestHooks(
				{
					resolve: async () => [{ address, family: 4 }],
					dial: () => {
						dials++;
						return { address: "127.0.0.1", family: 4, port: target.port };
					},
				},
				async () => {
					await expect(run(broker(), data)).rejects.toBeInstanceOf(ProviderHttpError);
				},
			);
			expect(dials).toBe(0);
			expect(target.received).toEqual([]);
		},
	);

	it("retains reserved-port refusal before DNS or socket creation", async () => {
		const port = [...BLOCKED_LOOPBACK_PORTS][0];
		if (port === undefined) throw new Error("Expected a canonical reserved port");
		const data = input(`http://models.example:${port}`);
		let resolves = 0;
		let dials = 0;
		await withNetworkTestHooks(
			{
				resolve: async () => {
					resolves++;
					return loopback;
				},
				dial: () => {
					dials++;
					throw new Error("Unexpected reserved-port dial");
				},
			},
			async () => {
				await expect(run(broker(), data)).rejects.toBeInstanceOf(ProviderHttpError);
			},
		);
		expect(resolves).toBe(0);
		expect(dials).toBe(0);
	});

	it.each(["authorization", "x-api-key"])(
		"refuses plugin-provided %s in no-key mode",
		async (header) => {
			const target = await peer((response) => response.end("unused"));
			const data = input(target.origin);
			data.candidate.headers.push([header, "DYTEST-unexpected"]);
			await expect(run(broker(), data)).rejects.toBeInstanceOf(ProviderHttpError);
			expect(target.received).toEqual([]);
		},
	);

	it("refuses redirects without sending a follow-up request", async () => {
		const target = await peer((response) => {
			response.writeHead(302, { location: "/follow-up" });
			response.end();
		});
		await expect(run(broker(), input(target.origin))).rejects.toBeInstanceOf(ProviderHttpError);
		expect(target.received.map(({ url }) => url)).toEqual(["/v1/chat/completions"]);
	});

	it("retains the inline response bound in no-key mode", async () => {
		const target = await peer((response) => response.end(Buffer.alloc(MAX_INLINE_BYTES + 1, 120)));
		await expect(run(broker(), input(target.origin))).rejects.toBeInstanceOf(ProviderHttpError);
		expect(target.received).toHaveLength(1);
	});

	it("cancels a real pending loopback response through the original caller signal", async () => {
		const entered = deferred<void>();
		const target = await peer((response) => {
			response.writeHead(200);
			response.flushHeaders();
			entered.resolve();
		});
		const controller = signal();
		const request = run(broker(), input(target.origin), controller);
		await observedBeforeSettlement(entered.promise, request);
		controller.abort();
		await expect(request).rejects.toBeInstanceOf(ProviderHttpError);
		expect(target.received).toHaveLength(1);
	});

	it("captures endpoint, authentication, expected destination and bytes before the DNS await", async () => {
		const target = await peer((response) => response.end("captured"));
		const data = input(`http://models.example:${target.port}`);
		const expectedBody = Buffer.from(data.candidate.body);
		const entered = deferred<void>();
		const resolution = deferred<readonly PinnedAddress[]>();
		releases.push(() => resolution.resolve(loopback));
		await withNetworkTestHooks(
			{
				resolve: () => {
					entered.resolve();
					return resolution.promise;
				},
			},
			async () => {
				const request = run(broker(), data);
				await observedBeforeSettlement(entered.promise, request);
				data.binding.endpoint = "http://changed.example/v1/chat/completions";
				data.binding.authentication = "provider-key";
				data.binding.expectedDestination = "cloud";
				data.candidate.url = data.binding.endpoint;
				data.candidate.body.fill(0);
				resolution.resolve(loopback);
				const result = await request;
				expect(result.body).toEqual({ base64: Buffer.from("captured").toString("base64url") });
			},
		);
		expect(target.received).toHaveLength(1);
		expect(target.received[0]?.body).toEqual(expectedBody);
		expect(target.received[0]?.authorization).toBeUndefined();
	});

	it("refuses an already-aborted caller before resolving or dialing", async () => {
		const controller = signal();
		controller.abort();
		let resolves = 0;
		await withNetworkTestHooks(
			{
				resolve: async () => {
					resolves++;
					return loopback;
				},
			},
			async () => {
				await expect(
					run(broker(), input("http://models.example:8080"), controller),
				).rejects.toBeInstanceOf(ProviderHttpError);
			},
		);
		await turn();
		expect(resolves).toBe(0);
	});
});
