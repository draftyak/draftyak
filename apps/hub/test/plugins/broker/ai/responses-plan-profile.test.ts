import type { IncomingMessage } from "node:http";
import { createServer, type Server } from "node:https";
import type { AddressInfo, Socket } from "node:net";
import type { AiProfile } from "@draftyak/protocol/manifest/ai-http";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { type CredentialBinding, CredentialVault } from "../../../../src/credentials/vault.ts";
import { newId } from "../../../../src/kernel/ids.ts";
import {
	type AiProfileRegistration,
	type AiProfileRegistry,
	AiVerificationError,
	createAiProfileRegistry,
	createBuiltinAiProfileRegistry,
} from "../../../../src/plugins/broker/ai/index.ts";
import {
	captureResponsesMetadataBinding,
	responsesMetadataEndpoint,
} from "../../../../src/plugins/broker/ai/responses-metadata.ts";
import { responsesSchema } from "../../../../src/plugins/broker/ai/schemas.ts";
import { builtinRegistrations } from "../../../../src/plugins/broker/ai/verifiers.ts";
import type { EgressPolicy } from "../../../../src/plugins/broker/network/index.ts";
import { withNetworkTestHooks } from "../../../../src/plugins/broker/network/test-context.ts";
import {
	createProviderHttpBroker,
	ProviderHttpError,
} from "../../../../src/plugins/broker/provider-http.ts";
import { requireLoopbackNetworkGuard } from "../../../helpers/loopback-network.ts";
import { createTlsFixture } from "../tls-fixture.ts";

// The mocks record routing and stand in for the vault; provider-http.ts captures the vault method
// when it loads.
const seen = vi.hoisted(() => ({
	key: `DYTEST-${crypto.randomUUID()}`,
	steps: [] as string[],
}));
vi.mock("../../../../src/plugins/broker/network/index.ts", async (importOriginal) => {
	const actual =
		await importOriginal<typeof import("../../../../src/plugins/broker/network/index.ts")>();
	const egressHost: typeof actual.egressHost = (...args) => {
		seen.steps.push("route");
		actual.egressHost(...args);
	};
	return { ...actual, egressHost };
});
vi.mock("../../../../src/credentials/vault.ts", async (importOriginal) => {
	const actual = await importOriginal<typeof import("../../../../src/credentials/vault.ts")>();
	const withCredential: typeof actual.CredentialVault.prototype.withCredential = async (
		reference,
		binding,
		request,
		use,
	) => {
		seen.steps.push("credential");
		const signal = request.signal ?? new AbortController().signal;
		return use(
			{ kind: "provider-key", key: seen.key },
			{ reference, binding, generation: 1, signal },
		);
	};
	actual.CredentialVault.prototype.withCredential = withCredential;
	return { ...actual };
});

const origin = "https://api.openai.com/v1";
const policy: EgressPolicy = { deniedAddresses: [], deniedPorts: [] };
const pin = { address: "8.8.8.8", family: 4 as const };
const draft = {
	model: "model-2026-01",
	system: "DYTEST-system",
	prompt: "DYTEST-prompt",
	contextIds: ["c1"] as const,
};
const draftHeaders: readonly (readonly [string, string])[] = [
	["content-type", "application/json"],
	["authorization", "Bearer brokered"],
];
const listHeaders: readonly (readonly [string, string])[] = [
	["accept", "application/json"],
	["authorization", "Bearer brokered"],
];

function draftRequest(headers = draftHeaders) {
	const body = {
		model: draft.model,
		instructions: draft.system,
		input: [{ role: "user", content: draft.prompt }],
		text: {
			format: {
				type: "json_schema",
				name: "draft_output",
				strict: true,
				schema: responsesSchema(),
			},
		},
		stream: true,
		store: false,
	};
	return {
		candidate: {
			method: "POST",
			url: `${origin}/responses`,
			headers,
			body: new TextEncoder().encode(JSON.stringify(body)),
		},
		binding: { draft, settings: { kind: "responses" }, endpoint: `${origin}/responses` },
	};
}

function listRequest(profile: AiProfile, headers = listHeaders) {
	return {
		candidate: { method: "GET", url: `${origin}/models`, headers },
		binding: {
			operation: "ai_models_list",
			configuration: { profile, endpoint: origin },
			input: {},
		},
	};
}

let tls: Awaited<ReturnType<typeof createTlsFixture>>;
let server: Server | undefined;
let port = 0;
const sockets = new Set<Socket>();
const remote = {
	connections: 0,
	methods: [] as string[],
	paths: [] as string[],
	headers: [] as IncomingMessage["headers"][],
};
const cleanups: (() => void)[] = [];

beforeAll(async () => {
	requireLoopbackNetworkGuard().assertActive();
	tls = await createTlsFixture(["api.openai.com"]);
	const peer = createServer({ key: tls.key, cert: tls.cert }, (request, response) => {
		remote.methods.push(request.method ?? "");
		remote.paths.push(request.url ?? "");
		remote.headers.push(request.headers);
		request.resume();
		request.once("end", () => {
			response.setHeader("content-type", "application/json");
			response.end('{"object":"list","data":[]}');
		});
	});
	peer.on("connection", (socket: Socket) => {
		remote.connections++;
		sockets.add(socket);
		socket.once("close", () => sockets.delete(socket));
	});
	await new Promise<void>((resolve, reject) => {
		peer.once("error", reject);
		peer.listen(0, "127.0.0.1", resolve);
	});
	server = peer;
	port = (peer.address() as AddressInfo).port;
});
afterAll(async () => {
	const closed = new Promise<void>((resolve) =>
		server ? server.close(() => resolve()) : resolve(),
	);
	for (const socket of sockets) socket.destroy();
	await closed;
});
beforeEach(() => {
	seen.steps.length = 0;
	remote.connections = 0;
	remote.methods.length = 0;
	remote.paths.length = 0;
	remote.headers.length = 0;
});
afterEach(() => {
	for (const cleanup of cleanups.splice(0)) cleanup();
});

function brokerFor(registry: AiProfileRegistry) {
	const broker = createProviderHttpBroker({
		registry,
		vault: Object.create(CredentialVault.prototype) as CredentialVault,
		networkPolicy: policy,
	});
	cleanups.push(() => broker.close());
	const credential: CredentialBinding = {
		ownerKind: "provider",
		ownerId: newId(),
		kind: "provider-key",
	};
	return (profile: AiProfile, request: { candidate: unknown; binding: unknown }) =>
		withNetworkTestHooks(
			{
				ca: tls.ca,
				resolve: async () => [pin],
				dial: () => {
					seen.steps.push("connect");
					return { address: "127.0.0.1", family: 4, port };
				},
			},
			() =>
				broker.execute(
					profile,
					request.candidate,
					request.binding,
					newId(),
					credential,
					new AbortController().signal,
				),
		);
}

function planUnderBuiltinVerifiers(): AiProfileRegistry {
	const responses = builtinRegistrations.filter(({ profile }) => profile === "responses-api-v1");
	return createAiProfileRegistry([
		...builtinRegistrations,
		...responses.map((entry) => ({ ...entry, profile: "responses-plan-v1" as const })),
	]);
}

describe("the responses-plan-v1 profile in the provider broker", () => {
	it("keeps responses-plan-v1 through the model-list capture", () => {
		const plan = { profile: "responses-plan-v1", endpoint: origin };
		for (const operation of ["ai_models_list", "ai_probe"] as const) {
			const binding = captureResponsesMetadataBinding({
				operation,
				configuration: plan,
				input: {},
			});
			expect(Object.isFrozen(binding)).toBe(true);
			expect(Object.isFrozen(binding.configuration)).toBe(true);
			expect(binding).toEqual({ operation, configuration: plan, input: {} });
			expect(responsesMetadataEndpoint(binding)).toBe(`${origin}/models`);
		}
		const keyed = captureResponsesMetadataBinding({
			operation: "ai_models_list",
			configuration: { profile: "responses-api-v1", endpoint: origin },
			input: {},
		});
		expect(keyed.configuration.profile).toBe("responses-api-v1");
		for (const configuration of [
			{ profile: "messages-api-v1", endpoint: origin },
			{ profile: "chat-completions-v1", endpoint: origin },
			{ profile: "DYTEST-profile", endpoint: origin },
			{ profile: "responses-plan-v1", endpoint: "https://other.example/v1" },
			{ profile: "responses-plan-v1", endpoint: `${origin}/` },
			{ profile: "responses-plan-v1", endpoint: origin, extra: true },
		])
			expect(() =>
				captureResponsesMetadataBinding({
					operation: "ai_models_list",
					configuration,
					input: {},
				}),
			).toThrow(AiVerificationError);
		expect(() =>
			captureResponsesMetadataBinding({
				operation: "ai_models_list",
				configuration: plan,
				input: {},
				extra: true,
			}),
		).toThrow(AiVerificationError);
	});

	it("refuses responses-plan-v1 under the built-in registry before routing or any credential read", async () => {
		const execute = brokerFor(createBuiltinAiProfileRegistry());
		for (const [profile, request] of [
			["responses-plan-v1", listRequest("responses-plan-v1")],
			["responses-plan-v1", draftRequest()],
			["responses-api-v1", listRequest("responses-plan-v1")],
			["responses-plan-v1", listRequest("responses-api-v1")],
		] as const) {
			await expect(execute(profile, request)).rejects.toThrow(ProviderHttpError);
			expect(seen.steps).toEqual([]);
		}
		expect(remote.connections).toBe(0);
		await expect(
			execute("responses-api-v1", listRequest("responses-api-v1")),
		).resolves.toMatchObject({ status: 200 });
		expect(seen.steps).toEqual(["route", "credential", "connect"]);
	});

	it("sends the key only in place of the bearer placeholder under a registered responses-plan-v1", async () => {
		const execute = brokerFor(planUnderBuiltinVerifiers());
		await expect(execute("responses-plan-v1", draftRequest())).resolves.toMatchObject({
			status: 200,
		});
		await expect(
			execute("responses-plan-v1", listRequest("responses-plan-v1")),
		).resolves.toMatchObject({ status: 200 });
		expect(seen.steps).toEqual([
			"route",
			"credential",
			"connect",
			"route",
			"credential",
			"connect",
		]);
		expect(remote.connections).toBe(2);
		expect(remote.methods).toEqual(["POST", "GET"]);
		expect(remote.paths).toEqual(["/v1/responses", "/v1/models"]);
		for (const headers of remote.headers) {
			expect(headers).toMatchObject({
				authorization: `Bearer ${seen.key}`,
				"accept-encoding": "identity",
				host: "api.openai.com",
			});
			expect(headers).not.toHaveProperty("x-api-key");
		}
	});

	it("refuses any other credential header under responses-plan-v1 after the lease and before a connection", async () => {
		const permissive: AiProfileRegistration = {
			profile: "responses-plan-v1",
			verify() {},
			verifyMetadata() {},
		};
		const execute = brokerFor(createAiProfileRegistry([...builtinRegistrations, permissive]));
		const variants: readonly (readonly (readonly [string, string])[])[] = [
			[...draftHeaders, ["x-api-key", "brokered"]],
			[["content-type", "application/json"]],
			[
				["content-type", "application/json"],
				["authorization", "Bearer other"],
			],
		];
		for (const headers of variants) {
			for (const request of [
				draftRequest(headers),
				listRequest(
					"responses-plan-v1",
					headers.filter(([name]) => name !== "content-type"),
				),
			]) {
				seen.steps.length = 0;
				await expect(execute("responses-plan-v1", request)).rejects.toThrow(ProviderHttpError);
				expect(seen.steps).toEqual(["route", "credential"]);
			}
		}
		expect(remote.connections).toBe(0);
	});
});
