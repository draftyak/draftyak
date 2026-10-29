import { describe, expect, it } from "vitest";
import {
	type AiMetadataVerifierInput,
	AiVerificationError,
	aiRequestEndpoint,
	type CapturedAiRequestInputs,
	captureAiRequestInputs,
	captureResponsesMetadataInputs,
	createAiProfileRegistry,
	createBuiltinAiProfileRegistry,
	type ResponsesMetadataBindingWithoutNetwork,
	snapshotVerifiedAiRequest,
	verifyCapturedAiRequest,
} from "../../../../src/plugins/broker/ai/index.ts";
import { captureResponsesMetadataBinding } from "../../../../src/plugins/broker/ai/responses-metadata.ts";
import { builtinRegistrations } from "../../../../src/plugins/broker/ai/verifiers.ts";

const registry = createBuiltinAiProfileRegistry();
const origin = "https://api.openai.com/v1";
const route = {
	answers: [{ address: "8.8.8.8", family: 4 as const }],
	policy: { deniedAddresses: [], deniedPorts: [], allowLocal: true },
};
const configuration = { profile: "responses-api-v1", endpoint: origin } as const;
const headers = [
	["Accept", "application/json"],
	["Authorization", "Bearer brokered"],
] as const;

function list() {
	return {
		candidate: { method: "GET", url: `${origin}/models`, headers },
		binding: {
			operation: "ai_models_list",
			configuration,
			input: {},
		} satisfies ResponsesMetadataBindingWithoutNetwork,
	};
}

function checked(candidate: unknown, binding: unknown) {
	const capture = captureAiRequestInputs(candidate, binding);
	return snapshotVerifiedAiRequest(
		verifyCapturedAiRequest(registry, "responses-api-v1", capture, route),
	);
}

describe("native Responses metadata binding", () => {
	it("lists models without inventing a configured model or a draft body", () => {
		const { candidate, binding } = list();
		for (const request of [
			candidate,
			{ ...candidate, body: new Uint8Array(0) },
			{ ...candidate, body: Buffer.alloc(0) },
		]) {
			const result = checked(request, binding);
			expect(result).toEqual({
				profile: "responses-api-v1",
				method: "GET",
				url: `${origin}/models`,
				headers: [
					["accept", "application/json"],
					["authorization", "Bearer brokered"],
				],
				body: new Uint8Array(0),
			});
			expect(Object.isFrozen(result.headers)).toBe(true);
			expect(result.headers.every(Object.isFrozen)).toBe(true);
		}
	});
	it.each([
		["unconfigured", configuration],
		["configured", { ...configuration, model: "gpt-configured" }],
	] as const)(
		"routes a model-less Responses probe to the catalogue with %s configuration",
		(_label, nativeConfiguration) => {
			const { candidate } = list();
			const binding: ResponsesMetadataBindingWithoutNetwork = {
				operation: "ai_probe",
				configuration: nativeConfiguration,
				input: {},
			};
			const capturedBinding = captureResponsesMetadataBinding(binding);
			expect(capturedBinding.operation).toBe("ai_probe");
			expect(capturedBinding.input).toEqual({});
			expect(checked(candidate, binding)).toMatchObject({
				method: "GET",
				url: `${origin}/models`,
				body: new Uint8Array(0),
			});
		},
	);
	it("retrieves only the current probe input model and refuses cross-request targets", () => {
		const { candidate } = list();
		const binding: ResponsesMetadataBindingWithoutNetwork = {
			operation: "ai_probe",
			configuration: { ...configuration, model: "gpt-configured" },
			input: { model: "requested-model" },
		};
		expect(checked({ ...candidate, url: `${origin}/models/requested-model` }, binding).url).toBe(
			`${origin}/models/requested-model`,
		);
		for (const url of [
			candidate.url,
			`${origin}/models/gpt-configured`,
			`${origin}/models/other-request-model`,
		])
			expect(() => checked({ ...candidate, url }, binding)).toThrow(AiVerificationError);
		const withoutInput = { ...binding, input: {} };
		expect(() =>
			checked({ ...candidate, url: `${origin}/models/gpt-configured` }, withoutInput),
		).toThrow(AiVerificationError);
		expect(() =>
			checked({ ...candidate, url: `${origin}/models/requested-model` }, withoutInput),
		).toThrow(AiVerificationError);
	});
	it.each([
		["model/with%name?x#fragment", "model%2Fwith%25name%3Fx%23fragment"],
		["model:2026+pin", "model%3A2026%2Bpin"],
		["model!'()*._~-", "model!'()*._~-"],
	])("binds the exact single encoded input model %s", (model, encoded) => {
		const { candidate } = list();
		const binding: ResponsesMetadataBindingWithoutNetwork = {
			operation: "ai_probe",
			configuration: { ...configuration, model: "different-configured-model" },
			input: { model },
		};
		const result = checked({ ...candidate, url: `${origin}/models/${encoded}` }, binding);
		expect(result.url).toBe(`${origin}/models/${encoded}`);
	});
	it("validates explicit ModelId values and refuses invented probe targets", () => {
		const { candidate } = list();
		const probe = { operation: "ai_probe", configuration, input: {} };
		expect(() => checked({ ...candidate, url: `${origin}/models/default-model` }, probe)).toThrow(
			AiVerificationError,
		);
		for (const model of [
			undefined,
			"",
			"bad model",
			"\ud800",
			"\u00e9",
			"x".repeat(257),
			".",
			"..",
		]) {
			const binding = { ...probe, input: { model } };
			expect(() => checked({ ...candidate, url: `${origin}/models/model` }, binding)).toThrow(
				AiVerificationError,
			);
		}
		for (const model of [undefined, "", "bad model"])
			expect(() =>
				checked(candidate, {
					operation: "ai_models_list",
					configuration: { ...configuration, model },
					input: {},
				}),
			).toThrow(AiVerificationError);
	});
	it("requires an explicit current operation and refuses plugin-only URL or call-kind fields", () => {
		const { candidate, binding } = list();
		for (const operation of [
			undefined,
			"ai_describe",
			"ai_draft_generate",
			"models",
			"GET",
			"ai_probe ",
			"constructor",
		])
			expect(() => checked(candidate, { ...binding, operation })).toThrow(AiVerificationError);
		expect(() =>
			checked(
				{ ...candidate, url: `${origin}/models/native-model` },
				{
					operation: "ai_describe",
					configuration: { ...configuration, model: "native-model" },
					input: {},
				},
			),
		).toThrow(AiVerificationError);
		for (const native of [
			{ endpoint: candidate.url },
			{ ...binding, callback: () => true },
			{ ...binding, mode: "api-key" },
			{ ...binding, profile: "responses-api-v1" },
			{ ...binding, input: { model: "not-a-list-input" } },
		])
			expect(() => checked(candidate, native)).toThrow(AiVerificationError);
		expect(() => checked({ ...candidate, operation: "ai_models_list" }, binding)).toThrow(
			AiVerificationError,
		);
	});
	it("keeps metadata configuration fixed to the existing Responses profile and origin", () => {
		const { candidate, binding } = list();
		for (const nativeConfiguration of [
			{ ...configuration, profile: "messages-api-v1" },
			{ ...configuration, endpoint: "https://other.example/v1" },
			{ ...configuration, endpoint: `${origin}/` },
			{ ...configuration, endpoint: `${origin}?extra=1` },
			{ ...configuration, callback: () => true },
			{ endpoint: origin },
		])
			expect(() => checked(candidate, { ...binding, configuration: nativeConfiguration })).toThrow(
				AiVerificationError,
			);
	});
	it("binds list versus probe and refuses URL aliases, queries and noncanonical encoding", () => {
		const { candidate, binding } = list();
		for (const url of [
			`${origin}/models/`,
			`${origin}/models/model`,
			`${origin}/models?after=x`,
			`${origin}/models?`,
			`${origin}/models#x`,
			"https://api.openai.com:443/v1/models",
			"http://api.openai.com/v1/models",
			"https://u@api.openai.com/v1/models",
			"https://other.example/v1/models",
			"https://api.openai.com/v1/other/../models",
		])
			expect(() => checked({ ...candidate, url }, binding)).toThrow(AiVerificationError);
		const probe = { operation: "ai_probe", configuration, input: { model: "model/name" } };
		for (const url of [
			candidate.url,
			`${origin}/models/model/name`,
			`${origin}/models/model%2fname`,
			`${origin}/models/model%252Fname`,
			`${origin}/models/model%2Fname?x=1`,
			`${origin}/models/model%2Fname/extra`,
		])
			expect(() => checked({ ...candidate, url }, probe)).toThrow(AiVerificationError);
	});
	it("refuses non-GET methods and any body bytes without widening draft POST", () => {
		const { candidate, binding } = list();
		for (const method of ["POST", "HEAD", "get", "PUT", "OPTIONS"])
			expect(() => checked({ ...candidate, method }, binding)).toThrow(AiVerificationError);
		for (const body of [
			new Uint8Array([0]),
			Buffer.from("{}"),
			Buffer.from(" "),
			"",
			undefined,
			{ base64: "" },
			new Uint8Array(new SharedArrayBuffer(0)),
		])
			expect(() => checked({ ...candidate, body }, binding)).toThrow(AiVerificationError);
		expect(() =>
			checked(candidate, {
				draft: { model: "model", system: "DYTEST", prompt: "DYTEST", contextIds: [] },
				settings: { kind: "responses" },
				endpoint: candidate.url,
			}),
		).toThrow(AiVerificationError);
	});
	it("admits only actual metadata headers and preserves the inherited-header repair", () => {
		const { candidate, binding } = list();
		for (const [name, value] of [
			["content-type", "application/json"],
			["cookie", "DYTEST"],
			["constructor", "DYTEST"],
			["Constructor", "DYTEST"],
			["__proto__", "DYTEST"],
			["accept-encoding", "gzip"],
			["x-stainless-retry-count", "0"],
			["accept", "application/json"],
			["authorization", "Bearer DYTEST-key"],
		])
			expect(() =>
				checked({ ...candidate, headers: [...headers, [name, value]] }, binding),
			).toThrow(AiVerificationError);
		for (const selected of [
			headers.slice(0, 1),
			headers.slice(1),
			[["accept", "text/event-stream"], headers[1]],
			[headers[0], ["authorization", "Bearer DYTEST-key"]],
		])
			expect(() => checked({ ...candidate, headers: selected }, binding)).toThrow(
				AiVerificationError,
			);
	});
	it("requires an explicitly registered metadata verifier rather than POST callbacks alone", () => {
		const { candidate, binding } = list();
		const capture = captureResponsesMetadataInputs(candidate, binding);
		const postOnly = createAiProfileRegistry(
			builtinRegistrations.map(({ profile, verify }) => ({ profile, verify })),
		);
		expect(() => verifyCapturedAiRequest(postOnly, "responses-api-v1", capture, route)).toThrow(
			AiVerificationError,
		);
		for (const invalid of [undefined, false, "callback"])
			expect(() =>
				createAiProfileRegistry(
					builtinRegistrations.map((entry) =>
						entry.profile === "responses-api-v1"
							? ({ ...entry, verifyMetadata: invalid } as never)
							: entry,
					),
				),
			).toThrow(AiVerificationError);
		let calls = 0;
		const current = createAiProfileRegistry(
			builtinRegistrations.map((entry) =>
				entry.profile === "responses-api-v1"
					? {
							...entry,
							verifyMetadata(input: AiMetadataVerifierInput) {
								calls++;
								entry.verifyMetadata?.(input);
							},
						}
					: entry,
			),
		);
		expect(
			snapshotVerifiedAiRequest(
				verifyCapturedAiRequest(current, "responses-api-v1", capture, route),
			).method,
		).toBe("GET");
		expect(calls).toBe(1);
	});
	it("refuses other profiles and checks DNS/policy before invoking the registered metadata verifier", () => {
		const { candidate, binding } = list();
		const capture = captureResponsesMetadataInputs(candidate, binding);
		let calls = 0;
		const current = createAiProfileRegistry(
			builtinRegistrations.map((entry) =>
				entry.profile === "responses-api-v1"
					? {
							...entry,
							verifyMetadata(input: AiMetadataVerifierInput) {
								calls++;
								entry.verifyMetadata?.(input);
							},
						}
					: entry,
			),
		);
		for (const id of ["messages-api-v1", "chat-completions-v1", "unregistered"])
			expect(() => verifyCapturedAiRequest(current, id, capture, route)).toThrow(
				AiVerificationError,
			);
		for (const network of [
			{ ...route, answers: [] },
			{ ...route, answers: [{ address: "127.0.0.1", family: 4 }] },
			{ ...route, answers: [{ address: "169.254.169.254", family: 4 }] },
			{ ...route, answers: [...route.answers, { address: "10.0.0.99", family: 4 }] },
			{ ...route, policy: { ...route.policy, deniedPorts: [443] } },
			{ ...route, policy: { ...route.policy, deniedAddresses: ["8.8.8.8"] } },
		])
			expect(() =>
				verifyCapturedAiRequest(current, "responses-api-v1", capture, network as typeof route),
			).toThrow(AiVerificationError);
		expect(calls).toBe(0);
	});
	it("captures native model/config/input, headers and bytes before asynchronous resolution", async () => {
		const { candidate } = list();
		const native = {
			operation: "ai_probe",
			configuration: { ...configuration, model: "configured" },
			input: { model: "selected/model" },
		};
		const buffer = new ArrayBuffer(0, { maxByteLength: 8 });
		const mutable = {
			...candidate,
			url: `${origin}/models/selected%2Fmodel`,
			headers: headers.map(([name, value]): [string, string] => [name, value]),
			body: new Uint8Array(buffer),
		};
		const capture = captureResponsesMetadataInputs(mutable, native);
		await Promise.resolve();
		native.operation = "ai_models_list";
		native.configuration.model = "changed";
		native.input.model = "changed";
		mutable.url = "https://other.example/";
		mutable.headers[0] = ["cookie", "DYTEST"];
		buffer.resize(8);
		new Uint8Array(buffer).fill(65);
		expect(aiRequestEndpoint(capture)).toBe(`${origin}/models/selected%2Fmodel`);
		expect(
			snapshotVerifiedAiRequest(
				verifyCapturedAiRequest(registry, "responses-api-v1", capture, route),
			).body.byteLength,
		).toBe(0);
	});
	it("refuses accessors, proxy bindings and forged captures without executing hooks", () => {
		const { candidate, binding } = list();
		let calls = 0;
		for (const native of [
			Object.defineProperty({ ...binding }, "operation", {
				enumerable: true,
				get() {
					calls++;
					return "ai_models_list";
				},
			}),
			{
				...binding,
				configuration: Object.defineProperty({ ...configuration }, "model", {
					enumerable: true,
					get() {
						calls++;
						return "model";
					},
				}),
			},
			new Proxy(binding, {
				get() {
					calls++;
					throw Error("DYTEST");
				},
			}),
		])
			expect(() => checked(candidate, native)).toThrow(AiVerificationError);
		expect(() =>
			checked(
				Object.defineProperty({ ...candidate }, "body", {
					enumerable: true,
					get() {
						calls++;
						return new Uint8Array(0);
					},
				}),
				binding,
			),
		).toThrow(AiVerificationError);
		expect(() =>
			verifyCapturedAiRequest(registry, "responses-api-v1", {} as CapturedAiRequestInputs, route),
		).toThrow(AiVerificationError);
		expect(calls).toBe(0);
	});
});
