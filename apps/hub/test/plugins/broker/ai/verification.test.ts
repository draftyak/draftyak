import { DraftOutputV1 } from "@draftyak/protocol/draft-output";
import { canonicalize } from "@draftyak/protocol/jcs";
import { AI_HTTP_PROFILES } from "@draftyak/protocol/manifest/ai-http";
import { describe, expect, it } from "vitest";
import {
	type AiCandidateRequest,
	type AiProfileRegistration,
	type AiRequestBinding,
	AiVerificationError,
	aiRequestEndpoint,
	type CapturedAiRequestInputs,
	captureAiRequestInputs,
	createAiProfileRegistry,
	createBuiltinAiProfileRegistry,
	snapshotVerifiedAiRequest,
	type VerifiedAiRequest,
	verifyAiRequest,
	verifyCapturedAiRequest,
} from "../../../../src/plugins/broker/ai/index.ts";
import {
	compatibleSchema,
	messagesSchema,
	responsesSchema,
} from "../../../../src/plugins/broker/ai/schemas.ts";
import { builtinRegistrations } from "../../../../src/plugins/broker/ai/verifiers.ts";

const encoder = new TextEncoder();
const registry = createBuiltinAiProfileRegistry();
const bundled = builtinRegistrations.map(({ profile }) => profile);
const draft = {
	model: "model-2026-01",
	system: "DYTEST-system\n\u00e9",
	prompt: "DYTEST-prompt\n\ud83d\ude02",
	contextIds: ["c1"] as const,
};
const policy = { deniedAddresses: [], deniedPorts: [], allowLocal: true };
const network = { answers: [{ address: "8.8.8.8", family: 4 as const }], policy };

function base(profile: (typeof AI_HTTP_PROFILES)[number]): {
	binding: AiRequestBinding;
	candidate: AiCandidateRequest;
	body: Record<string, unknown>;
} {
	let binding: AiRequestBinding;
	let body: Record<string, unknown>;
	let headers: readonly (readonly [string, string])[];
	if (profile === "messages-api-v1") {
		binding = {
			...network,
			endpoint: "https://api.anthropic.com/v1/messages",
			draft,
			settings: {
				kind: "messages",
				effort: "medium",
				maxTokens: 16_000,
				stream: "omit",
				fallback: false,
			},
		};
		body = {
			model: draft.model,
			system: draft.system,
			messages: [{ role: "user", content: draft.prompt }],
			max_tokens: 16_000,
			output_config: {
				effort: "medium",
				format: { type: "json_schema", schema: messagesSchema() },
			},
		};
		headers = [
			["content-type", "application/json"],
			["anthropic-version", "2023-06-01"],
			["x-api-key", "brokered"],
		];
	} else if (profile === "responses-api-v1") {
		binding = {
			...network,
			endpoint: "https://api.openai.com/v1/responses",
			draft,
			settings: { kind: "responses" },
		};
		body = {
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
		headers = [
			["content-type", "application/json"],
			["authorization", "Bearer brokered"],
		];
	} else {
		binding = {
			...network,
			endpoint: "https://compatible.example/v1/chat/completions",
			draft,
			settings: { kind: "compatible", format: "json_schema", allowPlaintextLan: false },
		};
		body = {
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
		headers = [["content-type", "application/json"]];
	}
	return {
		binding,
		body,
		candidate: {
			method: "POST",
			url: binding.endpoint,
			headers,
			body: encoder.encode(JSON.stringify(body)),
		},
	};
}

function changedBody(candidate: AiCandidateRequest, body: unknown): AiCandidateRequest {
	return { ...candidate, body: encoder.encode(JSON.stringify(body)) };
}

describe("native profile registry", () => {
	it("requires each merged profile exactly once and rejects malformed registrations", () => {
		for (const registrations of [
			[],
			builtinRegistrations.slice(1),
			[...builtinRegistrations, builtinRegistrations[0]],
			[...builtinRegistrations.slice(0, 2), { profile: "unavailable-profile", verify() {} }],
			[...builtinRegistrations.slice(0, 2), { profile: "chat-completions-v1", verify: false }],
		]) {
			expect(() =>
				createAiProfileRegistry(registrations as readonly AiProfileRegistration[]),
			).toThrow(AiVerificationError);
		}
	});
	it("refuses requests under each listed profile that no bundled plugin ships", () => {
		for (const id of AI_HTTP_PROFILES.filter((profile) => !bundled.includes(profile)))
			for (const shape of bundled) {
				const { candidate, binding } = base(shape);
				expect(() => verifyAiRequest(registry, id, candidate, binding)).toThrow(
					AiVerificationError,
				);
			}
	});
	it("supports a native registration without adding an inferred production profile", () => {
		let calls = 0;
		const registrations = builtinRegistrations.map((entry) =>
			entry.profile === "responses-api-v1"
				? {
						profile: entry.profile,
						verify(input: Parameters<AiProfileRegistration["verify"]>[0]) {
							calls++;
							entry.verify(input);
						},
					}
				: entry,
		);
		const current = createAiProfileRegistry(registrations);
		const { candidate, binding } = base("responses-api-v1");
		expect(
			snapshotVerifiedAiRequest(verifyAiRequest(current, "responses-api-v1", candidate, binding))
				.profile,
		).toBe("responses-api-v1");
		expect(calls).toBe(1);
		for (const id of [undefined, null, "", "unavailable-profile", "responses-api-v2"])
			expect(() => verifyAiRequest(current, id, candidate, binding)).toThrow(AiVerificationError);
	});
	it("refuses registry, capture and verified-handle forgeries", () => {
		const { candidate, binding } = base("responses-api-v1");
		expect(() => verifyAiRequest({} as never, "responses-api-v1", candidate, binding)).toThrow(
			AiVerificationError,
		);
		expect(() => aiRequestEndpoint({} as CapturedAiRequestInputs)).toThrow(AiVerificationError);
		expect(() =>
			snapshotVerifiedAiRequest({ profile: "responses-api-v1" } as unknown as VerifiedAiRequest),
		).toThrow(AiVerificationError);
		const capture = captureAiRequestInputs(candidate, {
			draft: binding.draft,
			endpoint: binding.endpoint,
			settings: binding.settings,
		});
		expect(() =>
			verifyCapturedAiRequest(registry, "responses-api-v1", { ...capture }, network),
		).toThrow(AiVerificationError);
	});
	it("rejects destination facts before invoking a verifier or decoding malformed payload", () => {
		let calls = 0;
		const current = createAiProfileRegistry(
			builtinRegistrations.map((entry) => ({
				profile: entry.profile,
				verify(input) {
					calls++;
					entry.verify(input);
				},
			})),
		);
		const { candidate, binding } = base("responses-api-v1");
		const capture = captureAiRequestInputs(
			{ ...candidate, body: encoder.encode("not json") },
			{ draft: binding.draft, endpoint: binding.endpoint, settings: binding.settings },
		);
		expect(() =>
			verifyCapturedAiRequest(current, "responses-api-v1", capture, {
				...network,
				answers: [{ address: "169.254.169.254", family: 4 }],
			}),
		).toThrow(AiVerificationError);
		expect(calls).toBe(0);
	});
});

describe("bundled request verification", () => {
	it.each(bundled)("accepts exact %s bytes and returns isolated branded snapshots", (id) => {
		const { candidate, binding } = base(id);
		const before = Uint8Array.from(candidate.body);
		const handle = verifyAiRequest(registry, id, candidate, binding);
		const first = snapshotVerifiedAiRequest(handle);
		expect(first).toEqual({ ...candidate, profile: id });
		candidate.body.fill(0);
		first.body.fill(1);
		expect(snapshotVerifiedAiRequest(handle).body).toEqual(before);
		expect(Object.isFrozen(first.headers)).toBe(true);
		expect(first.headers.every(Object.isFrozen)).toBe(true);
	});
	it.each(bundled)("refuses unknown executable and disclosure fields in %s", (id) => {
		const { candidate, binding, body } = base(id);
		for (const key of [
			"tools",
			"tool_choice",
			"metadata",
			"user",
			"conversation",
			"previous_response_id",
			"include",
			"mcp_servers",
			"temperature",
			"cache_control",
			"service_tier",
			"DYTEST-extra",
		]) {
			expect(() =>
				verifyAiRequest(
					registry,
					id,
					changedBody(candidate, { ...body, [key]: "DYTEST-leak" }),
					binding,
				),
			).toThrow("Provider request refused");
		}
		for (const key of Object.keys(body)) {
			const copy = { ...body };
			delete copy[key];
			expect(() => verifyAiRequest(registry, id, changedBody(candidate, copy), binding)).toThrow(
				AiVerificationError,
			);
		}
	});
	it.each(bundled)("binds exact model, instructions and prompt for %s", (id) => {
		const { candidate, binding, body } = base(id);
		for (const change of [
			{ model: "other-model" },
			id === "responses-api-v1"
				? { instructions: `${draft.system} ` }
				: id === "messages-api-v1"
					? { system: draft.system.toUpperCase() }
					: {
							messages: [
								{ role: "system", content: draft.system },
								{ role: "user", content: `${draft.prompt} ` },
							],
						},
			id === "responses-api-v1"
				? { input: [{ role: "user", content: `${draft.prompt} ` }] }
				: { messages: [{ role: "user", content: `${draft.prompt} ` }] },
		]) {
			expect(() =>
				verifyAiRequest(registry, id, changedBody(candidate, { ...body, ...change }), binding),
			).toThrow(AiVerificationError);
		}
		expect(() =>
			verifyAiRequest(registry, id, candidate, {
				...binding,
				draft: { ...binding.draft, prompt: "different approved job" },
			}),
		).toThrow(AiVerificationError);
	});
	it.each(bundled)(
		"rejects credentials, duplicate headers and header side channels for %s",
		(id) => {
			const { candidate, binding } = base(id);
			for (const header of [
				["authorization", "Bearer DYTEST-untrusted-key"],
				["cookie", "DYTEST-leak"],
				["x-stainless-os", "DYTEST-leak"],
				["content-type", "application/json; note=DYTEST-leak"],
				["Content-Type", "application/json"],
				["x-http-method-override", "GET"],
			] as const) {
				expect(() =>
					verifyAiRequest(
						registry,
						id,
						{ ...candidate, headers: [...candidate.headers, header] },
						binding,
					),
				).toThrow(AiVerificationError);
			}
			expect(() =>
				verifyAiRequest(
					registry,
					id,
					{ ...candidate, headers: candidate.headers.slice(1) },
					binding,
				),
			).toThrow(AiVerificationError);
		},
	);
	it.each(bundled)(
		"rejects duplicate JSON members, malformed UTF-8 and body limits for %s",
		(id) => {
			const { candidate, binding } = base(id);
			for (const body of [
				encoder.encode('{"model":"one","model":"two"}'),
				new Uint8Array([0xff]),
				encoder.encode('{"x":"\\ud800"}'),
				new Uint8Array(8_388_609),
				new Uint8Array(0),
			])
				expect(() => verifyAiRequest(registry, id, { ...candidate, body }, binding)).toThrow(
					AiVerificationError,
				);
		},
	);
	it.each(bundled)("rejects inherited optional header names for %s", (id) => {
		const { candidate, binding } = base(id);
		for (const name of [
			"constructor",
			"Constructor",
			"CONSTRUCTOR",
			"__proto__",
			"prototype",
			"toString",
			"toLocaleString",
			"valueOf",
			"hasOwnProperty",
			"isPrototypeOf",
			"propertyIsEnumerable",
			"__defineGetter__",
			"__defineSetter__",
			"__lookupGetter__",
			"__lookupSetter__",
			"toJSON",
		]) {
			expect(() =>
				verifyAiRequest(
					registry,
					id,
					{ ...candidate, headers: [...candidate.headers, [name, "DYTEST-header-canary"]] },
					binding,
				),
			).toThrow(AiVerificationError);
		}
	});
	it.each(["messages-api-v1", "responses-api-v1"] as const)(
		"preserves an explicitly listed optional header for %s",
		(id) => {
			const { candidate, binding } = base(id);
			const checked = verifyAiRequest(
				registry,
				id,
				{ ...candidate, headers: [...candidate.headers, ["Accept", "application/json"]] },
				binding,
			);
			expect(snapshotVerifiedAiRequest(checked).headers).toContainEqual([
				"accept",
				"application/json",
			]);
		},
	);
	it("refuses nested schema metadata, extra turns and executable schemas", () => {
		for (const id of bundled) {
			const { candidate, binding, body } = base(id);
			const copy = structuredClone(body);
			const format =
				id === "messages-api-v1"
					? (copy.output_config as { format: { schema: Record<string, unknown> } }).format
					: id === "responses-api-v1"
						? (copy.text as { format: { schema: Record<string, unknown> } }).format
						: (copy.response_format as { json_schema: { schema: Record<string, unknown> } })
								.json_schema;
			format.schema.description = "DYTEST-untrusted-data";
			expect(() => verifyAiRequest(registry, id, changedBody(candidate, copy), binding)).toThrow(
				AiVerificationError,
			);
		}
	});
	it("pins Responses stateless streaming and optional effort without widening settings", () => {
		const { candidate, binding, body } = base("responses-api-v1");
		for (const effort of ["none", "minimal", "low", "medium", "high", "xhigh", "max"] as const) {
			const modified = { ...body, reasoning: { effort } };
			expect(() =>
				verifyAiRequest(registry, "responses-api-v1", changedBody(candidate, modified), {
					...binding,
					settings: { kind: "responses", effort },
				}),
			).not.toThrow();
			expect(() =>
				verifyAiRequest(registry, "responses-api-v1", changedBody(candidate, modified), binding),
			).toThrow(AiVerificationError);
		}
		for (const change of [
			{ store: true },
			{ stream: false },
			{ reasoning: { effort: "medium", summary: "auto" } },
		])
			expect(() =>
				verifyAiRequest(
					registry,
					"responses-api-v1",
					changedBody(candidate, { ...body, ...change }),
					binding,
				),
			).toThrow(AiVerificationError);
	});
	it("pins Messages stream omission, token budget, beta and model-supported fallback", () => {
		const { candidate, binding, body } = base("messages-api-v1");
		for (const stream of [true, false])
			expect(() =>
				verifyAiRequest(registry, "messages-api-v1", changedBody(candidate, { ...body, stream }), {
					...binding,
					settings: {
						kind: "messages",
						effort: "medium",
						maxTokens: 16_000,
						stream,
						fallback: false,
					},
				}),
			).not.toThrow();
		for (const change of [
			{ stream: false },
			{ max_tokens: 16_001 },
			{ fallbacks: "default" },
			{ output_config: { ...(body.output_config as object), effort: "high" } },
		])
			expect(() =>
				verifyAiRequest(
					registry,
					"messages-api-v1",
					changedBody(candidate, { ...body, ...change }),
					binding,
				),
			).toThrow(AiVerificationError);
		const endpoint = `${binding.endpoint}?beta=true`;
		const fallbackDraft = { ...draft, model: "claude-opus-5-5" };
		const fallbackBody = { ...body, model: fallbackDraft.model, fallbacks: "default" };
		const fallbackCandidate = {
			...changedBody(candidate, fallbackBody),
			url: endpoint,
			headers: [
				...candidate.headers,
				["anthropic-beta", "server-side-fallback-2026-07-01"] as const,
			],
		};
		const fallbackBinding: AiRequestBinding = {
			...binding,
			draft: fallbackDraft,
			endpoint,
			settings: {
				kind: "messages",
				effort: "medium",
				maxTokens: 16_000,
				stream: "omit",
				fallback: true,
			},
		};
		expect(() =>
			verifyAiRequest(registry, "messages-api-v1", fallbackCandidate, fallbackBinding),
		).not.toThrow();
		expect(() =>
			verifyAiRequest(registry, "messages-api-v1", fallbackCandidate, {
				...fallbackBinding,
				draft: { ...fallbackDraft, model: "unknown-model" },
			}),
		).toThrow(AiVerificationError);
	});
	it("accepts only the pinned SDK header values", () => {
		const { candidate, binding } = base("messages-api-v1");
		for (const [name, allowed, denied] of [
			["accept", "application/json", "text/event-stream"],
			["user-agent", "Anthropic/JS 0.135.0", "Anthropic/JS 0.135.1"],
			["x-stainless-retry-count", "2", "100"],
			["x-stainless-timeout", "600000", "1000000"],
			["x-stainless-helper-method", "stream", "parse"],
		]) {
			expect(() =>
				verifyAiRequest(
					registry,
					"messages-api-v1",
					{ ...candidate, headers: [...candidate.headers, [name as string, allowed as string]] },
					binding,
				),
			).not.toThrow();
			expect(() =>
				verifyAiRequest(
					registry,
					"messages-api-v1",
					{ ...candidate, headers: [...candidate.headers, [name as string, denied as string]] },
					binding,
				),
			).toThrow(AiVerificationError);
		}
	});
});

describe("destination and captured-input boundaries", () => {
	it("requires uniform actual address facts and native policy for local compatible endpoints", () => {
		const { candidate, binding, body } = base("chat-completions-v1");
		const endpoint = "http://127.0.0.1:11434/v1/chat/completions";
		const localBinding: AiRequestBinding = {
			...binding,
			endpoint,
			answers: [{ address: "127.0.0.1", family: 4 }],
		};
		expect(() =>
			verifyAiRequest(
				registry,
				"chat-completions-v1",
				{ ...candidate, url: endpoint },
				localBinding,
			),
		).not.toThrow();
		for (const change of [
			{ answers: [] },
			{ answers: [{ address: "169.254.169.254", family: 4 }] },
			{
				answers: [
					{ address: "8.8.8.8", family: 4 },
					{ address: "127.0.0.1", family: 4 },
				],
			},
			{ policy: { ...policy, allowLocal: false } },
			{ policy: { ...policy, deniedPorts: [11434] } },
			{ policy: { ...policy, deniedAddresses: ["127.0.0.1"] } },
		])
			expect(() =>
				verifyAiRequest(registry, "chat-completions-v1", { ...candidate, url: endpoint }, {
					...localBinding,
					...change,
				} as AiRequestBinding),
			).toThrow(AiVerificationError);
		const ollamaEndpoint = "http://127.0.0.1:11434/api/chat";
		const ollamaBody = {
			model: draft.model,
			messages: body.messages,
			format: compatibleSchema(),
			stream: false,
		};
		expect(() =>
			verifyAiRequest(
				registry,
				"chat-completions-v1",
				{ ...changedBody(candidate, ollamaBody), url: ollamaEndpoint },
				{
					...localBinding,
					endpoint: ollamaEndpoint,
					settings: { kind: "compatible", format: "ollama", allowPlaintextLan: false },
				},
			),
		).not.toThrow();
	});
	it("requires explicit plaintext LAN permission and refuses HTTP cloud", () => {
		const { candidate, binding } = base("chat-completions-v1");
		const endpoint = "http://lan-model.example:11434/v1/chat/completions";
		const lan: AiRequestBinding = {
			...binding,
			endpoint,
			answers: [{ address: "192.168.199.17", family: 4 }],
		};
		expect(() =>
			verifyAiRequest(registry, "chat-completions-v1", { ...candidate, url: endpoint }, lan),
		).toThrow(AiVerificationError);
		expect(() =>
			verifyAiRequest(
				registry,
				"chat-completions-v1",
				{ ...candidate, url: endpoint },
				{
					...lan,
					settings: { kind: "compatible", format: "json_schema", allowPlaintextLan: true },
				},
			),
		).not.toThrow();
		expect(() =>
			verifyAiRequest(
				registry,
				"chat-completions-v1",
				{ ...candidate, url: endpoint },
				{
					...lan,
					answers: network.answers,
					settings: { kind: "compatible", format: "json_schema", allowPlaintextLan: true },
				},
			),
		).toThrow(AiVerificationError);
	});
	it.each(bundled)("refuses endpoint, method and profile substitution for %s", (id) => {
		const { candidate, binding } = base(id);
		for (const endpoint of [
			`${binding.endpoint}/`,
			`${binding.endpoint}?leak=DYTEST`,
			`${binding.endpoint}#fragment`,
			"https://other.example/v1/requests",
		])
			expect(() =>
				verifyAiRequest(registry, id, { ...candidate, url: endpoint }, { ...binding, endpoint }),
			).toThrow(AiVerificationError);
		for (const method of ["GET", "post", "PUT"])
			expect(() => verifyAiRequest(registry, id, { ...candidate, method }, binding)).toThrow(
				AiVerificationError,
			);
		const other = bundled.find((profile) => profile !== id);
		expect(() => verifyAiRequest(registry, other, candidate, binding)).toThrow(AiVerificationError);
	});
	it("captures original body, header, settings, endpoint and job before a DNS await", async () => {
		const { candidate, binding } = base("responses-api-v1");
		const localDraft = { ...draft, contextIds: [...draft.contextIds] };
		const localSettings = { kind: "responses" as const, effort: "medium" as const };
		const body = JSON.parse(new TextDecoder().decode(candidate.body));
		body.reasoning = { effort: "medium" };
		const mutable = {
			...changedBody(candidate, body),
			headers: candidate.headers.map(([name, value]) => [name, value] as [string, string]),
		};
		const inputs = { endpoint: binding.endpoint, draft: localDraft, settings: localSettings };
		const capture = captureAiRequestInputs(mutable, inputs);
		await Promise.resolve();
		mutable.body.fill(0);
		mutable.headers[0] = ["cookie", "DYTEST"];
		localDraft.prompt = "changed";
		localDraft.contextIds.length = 0;
		inputs.endpoint = "https://other.example/";
		expect(aiRequestEndpoint(capture)).toBe(binding.endpoint);
		const verified = verifyCapturedAiRequest(registry, "responses-api-v1", capture, network);
		expect(
			JSON.parse(new TextDecoder().decode(snapshotVerifiedAiRequest(verified).body)).input,
		).toEqual([{ role: "user", content: draft.prompt }]);
	});
	it("refuses accessors, proxies, extra fields, array holes and shared bytes without invoking hooks", () => {
		const { candidate, binding } = base("responses-api-v1");
		let calls = 0;
		const sparseHeaders = new Array(2);
		sparseHeaders[1] = ["content-type", "application/json"];
		for (const candidateValue of [
			{ ...candidate, extra: true },
			Object.defineProperty({ ...candidate }, "body", {
				enumerable: true,
				get() {
					calls++;
					return candidate.body;
				},
			}),
			new Proxy(candidate, {
				get() {
					calls++;
					throw Error("DYTEST");
				},
			}),
			{ ...candidate, body: new Uint8Array(new SharedArrayBuffer(8)) },
			{ ...candidate, headers: sparseHeaders },
		])
			expect(() =>
				verifyAiRequest(
					registry,
					"responses-api-v1",
					candidateValue as AiCandidateRequest,
					binding,
				),
			).toThrow(AiVerificationError);
		for (const value of [
			{ ...binding, extra: true },
			{ ...binding, settings: { kind: "responses", effort: "medium", extra: true } },
			{
				...binding,
				draft: Object.defineProperty({ ...draft }, "prompt", {
					enumerable: true,
					get() {
						calls++;
						return draft.prompt;
					},
				}),
			},
		])
			expect(() =>
				verifyAiRequest(registry, "responses-api-v1", candidate, value as AiRequestBinding),
			).toThrow(AiVerificationError);
		expect(calls).toBe(0);
	});
	it("copies native byte slots without executing overridden typed-array iterators", () => {
		const { candidate, binding } = base("responses-api-v1");
		let calls = 0;
		Object.defineProperty(candidate.body, Symbol.iterator, {
			value() {
				calls++;
				throw Error("DYTEST");
			},
		});
		expect(() => verifyAiRequest(registry, "responses-api-v1", candidate, binding)).not.toThrow();
		expect(calls).toBe(0);
	});
	it("keeps fixed cloud providers public even when shared policy permits local", () => {
		for (const id of ["messages-api-v1", "responses-api-v1"] as const) {
			const { candidate, binding } = base(id);
			expect(() =>
				verifyAiRequest(registry, id, candidate, {
					...binding,
					answers: [{ address: "127.0.0.1", family: 4 }],
				}),
			).toThrow(AiVerificationError);
		}
	});
	it("keeps responses schema constraints and compatible format metadata pinned", () => {
		const raw = DraftOutputV1.toJSONSchema({
			target: "draft-7",
			override: ({ jsonSchema }) => {
				delete jsonSchema.uniqueItems;
			},
		});
		expect(canonicalize(responsesSchema())).toBe(canonicalize(raw));
		expect(JSON.stringify(compatibleSchema())).not.toContain('"$id"');
		expect(JSON.stringify(compatibleSchema())).not.toContain('"maxLength"');
	});
	it("accepts the exact serialized public Responses format from the real request builder", () => {
		const actual = JSON.parse(
			readFileSync(new URL("./fixtures/responses-format.json", import.meta.url), "utf8"),
		);
		expect(canonicalize(responsesSchema())).toBe(canonicalize(actual));
		const { candidate, binding, body } = base("responses-api-v1");
		const request = changedBody(candidate, {
			...body,
			text: { format: { type: "json_schema", name: "draft_output", strict: true, schema: actual } },
		});
		expect(() => verifyAiRequest(registry, "responses-api-v1", request, binding)).not.toThrow();
		actual.additionalProperties = true;
		expect(() =>
			verifyAiRequest(
				registry,
				"responses-api-v1",
				changedBody(candidate, {
					...body,
					text: {
						format: { type: "json_schema", name: "draft_output", strict: true, schema: actual },
					},
				}),
				binding,
			),
		).toThrow(AiVerificationError);
	});
});

import { readFileSync } from "node:fs";
