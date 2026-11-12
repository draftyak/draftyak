import { AI_HTTP_PROFILES, type AiProfile } from "@draftyak/protocol/manifest/ai-http";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { type CredentialBinding, CredentialVault } from "../../../../src/credentials/vault.ts";
import { newId } from "../../../../src/kernel/ids.ts";
import {
	type AiCandidateRequest,
	type AiProfileRegistration,
	type AiProfileRegistry,
	type AiRequestBindingWithoutNetwork,
	AiVerificationError,
	createAiProfileRegistry,
	createBuiltinAiProfileRegistry,
	verifyAiRequest,
} from "../../../../src/plugins/broker/ai/index.ts";
import { builtinRegistrations } from "../../../../src/plugins/broker/ai/verifiers.ts";
import type { EgressPolicy } from "../../../../src/plugins/broker/network/index.ts";
import { withNetworkTestHooks } from "../../../../src/plugins/broker/network/test-context.ts";
import {
	createProviderHttpBroker,
	ProviderHttpError,
} from "../../../../src/plugins/broker/provider-http.ts";
import { requireLoopbackNetworkGuard } from "../../../helpers/loopback-network.ts";

// A protocol change may list a profile before any bundled plugin ships it. The mocks record
// routing and stand in for the vault; provider-http.ts captures the vault method when it loads.
const seen = vi.hoisted(() => ({
	listed: "DYTEST-unbundled-profile",
	key: `DYTEST-${crypto.randomUUID()}`,
	steps: [] as string[],
}));
vi.mock("@draftyak/protocol/manifest/ai-http", async (importOriginal) => {
	const actual = await importOriginal<typeof import("@draftyak/protocol/manifest/ai-http")>();
	return { ...actual, AI_HTTP_PROFILES: Object.freeze([...actual.AI_HTTP_PROFILES, seen.listed]) };
});
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

const unbundled = seen.listed as AiProfile;
const bundled = builtinRegistrations.map(({ profile }) => profile);
const policy: EgressPolicy = { deniedAddresses: [], deniedPorts: [] };
const pin = { address: "8.8.8.8", family: 4 as const };
const cleanups: (() => void)[] = [];

function withUnbundled(): AiProfileRegistry {
	const compatible = builtinRegistrations.filter(
		({ profile }) => profile === "chat-completions-v1",
	);
	return createAiProfileRegistry([
		...builtinRegistrations,
		...compatible.map((entry) => ({ ...entry, profile: unbundled })),
	]);
}

function request(): { candidate: AiCandidateRequest; binding: AiRequestBindingWithoutNetwork } {
	const draft = {
		model: "model-2026-01",
		system: "DYTEST-system",
		prompt: "DYTEST-prompt",
		contextIds: ["c1"] as const,
	};
	const endpoint = "https://guard.example/v1/chat/completions";
	const body = {
		model: draft.model,
		messages: [
			{ role: "system", content: draft.system },
			{ role: "user", content: draft.prompt },
		],
		response_format: { type: "json_object" },
		stream: false,
	};
	return {
		candidate: {
			method: "POST",
			url: endpoint,
			headers: [["content-type", "application/json"]],
			body: new TextEncoder().encode(JSON.stringify(body)),
		},
		binding: {
			draft,
			endpoint,
			settings: { kind: "compatible", format: "json_object", allowPlaintextLan: false },
		},
	};
}

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
	return (profile: AiProfile) => {
		const { candidate, binding } = request();
		return withNetworkTestHooks(
			{
				resolve: async () => [pin],
				dial: () => {
					seen.steps.push("connect");
					throw new Error("DYTEST-no-socket");
				},
			},
			() =>
				broker.execute(
					profile,
					candidate,
					binding,
					newId(),
					credential,
					new AbortController().signal,
				),
		);
	};
}

beforeAll(() => {
	requireLoopbackNetworkGuard().assertActive();
});
beforeEach(() => {
	seen.steps.length = 0;
});
afterEach(() => {
	for (const cleanup of cleanups.splice(0)) cleanup();
});

describe("a listed profile that no bundled plugin ships", () => {
	it("may stay unregistered while every bundled registration stays required", () => {
		expect(AI_HTTP_PROFILES).toContain(unbundled);
		expect(bundled).not.toContain(unbundled);
		expect(() => createBuiltinAiProfileRegistry()).not.toThrow();
		expect(() => withUnbundled()).not.toThrow();
		const [first] = builtinRegistrations;
		const omitting = builtinRegistrations.flatMap((omitted) => {
			const rest = builtinRegistrations.filter((entry) => entry !== omitted);
			return [rest, [...rest, { ...omitted, profile: unbundled }]];
		});
		expect(omitting).toHaveLength(bundled.length * 2);
		for (const registrations of [
			[],
			...omitting,
			[...builtinRegistrations, first],
			[...builtinRegistrations, { ...first, profile: "unavailable-profile" }],
		])
			expect(() =>
				createAiProfileRegistry(registrations as readonly AiProfileRegistration[]),
			).toThrow(AiVerificationError);
	});
	it("refuses each request under it before routing", () => {
		const registry = createBuiltinAiProfileRegistry();
		const { candidate, binding } = request();
		const network = { ...binding, answers: [pin], policy };
		expect(() => verifyAiRequest(registry, unbundled, candidate, network)).toThrow(
			AiVerificationError,
		);
		expect(seen.steps).toEqual([]);
		verifyAiRequest(withUnbundled(), unbundled, candidate, network);
		expect(seen.steps).toContain("route");
	});
	it("refuses it in the provider broker before routing, credentials or a connection", async () => {
		const execute = brokerFor(createBuiltinAiProfileRegistry());
		await expect(execute(unbundled)).rejects.toThrow(ProviderHttpError);
		expect(seen.steps).toEqual([]);
		await expect(execute("chat-completions-v1")).rejects.toThrow(ProviderHttpError);
		expect([...new Set(seen.steps)]).toEqual(["route", "credential", "connect"]);
	});
	it("sends no provider key under it until the broker names its credential header", async () => {
		const execute = brokerFor(withUnbundled());
		await expect(execute(unbundled)).rejects.toThrow(ProviderHttpError);
		expect([...new Set(seen.steps)]).toEqual(["route", "credential"]);
	});
});
