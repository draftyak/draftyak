import {
	type AiCandidateRequest,
	type AiRequestBinding,
	createBuiltinAiProfileRegistry,
	snapshotVerifiedAiRequest,
	verifyAiRequest,
} from "@draftyak/hub";
import type { DraftRequest } from "@draftyak/protocol/ai-provider-v1";
import { describe, expect, it } from "vitest";
import {
	type CompatibleFormat,
	type CompatibleRequest,
	createCompatibleCore,
} from "../src/index.ts";
import { completion, OUTPUT } from "./helpers.ts";

const registry = createBuiltinAiProfileRegistry();
const encoder = new TextEncoder();
const formats = ["json_schema", "json_object", "ollama"] as const;
const draft: DraftRequest = {
	model: "synthetic-model:1",
	system: "DYTEST trusted instructions\n\u00e9",
	prompt: "DYTEST untrusted thread\n\ud83d\ude02",
	contextIds: ["c1", "c3"],
};
const probeDraft: DraftRequest = {
	model: "synthetic-model:1",
	system:
		"Return exactly one DraftOutputV1 JSON object with body, ownerNotes, needsOwnerInput, suspectedInstructions, and contextRefs.",
	prompt:
		'Return exactly {"body":"","ownerNotes":"","needsOwnerInput":[],"suspectedInstructions":false,"contextRefs":[]}.',
	contextIds: [],
};

function trustedBinding(format: CompatibleFormat, request: DraftRequest = draft): AiRequestBinding {
	return {
		draft: structuredClone(request),
		settings: { kind: "compatible", format, allowPlaintextLan: false },
		endpoint: `http://127.0.0.1:11434/${format === "ollama" ? "api/chat" : "v1/chat/completions"}`,
		answers: [{ address: "127.0.0.1", family: 4 }],
		policy: { allowLocal: true, deniedAddresses: [], deniedPorts: [] },
	};
}

function provider(binding: AiRequestBinding) {
	if (binding.settings.kind !== "compatible") throw new Error("Invalid test binding");
	return createCompatibleCore(
		{
			endpoint: binding.endpoint,
			model: binding.draft.model,
			format: binding.settings.format,
		},
		{ hostname: new URL(binding.endpoint).hostname, destination: "local" },
	);
}

function candidate(request: CompatibleRequest): AiCandidateRequest {
	return {
		method: request.method,
		url: request.url,
		headers: Object.entries(request.headers),
		body: encoder.encode(request.body),
	};
}

function verify(request: AiCandidateRequest, binding: AiRequestBinding) {
	return snapshotVerifiedAiRequest(
		verifyAiRequest(registry, "chat-completions-v1", request, binding),
	);
}

describe("compatible requests against the earlier native verifier", () => {
	for (const format of formats) {
		it(`${format}: admits actual build and generate bytes with independent native inputs`, async () => {
			const binding = trustedBinding(format);
			const core = provider(binding);
			const built = core.build(draft);
			const builtSnapshot = verify(candidate(built), binding);
			expect(builtSnapshot.profile).toBe("chat-completions-v1");
			expect(builtSnapshot.url).toBe(binding.endpoint);
			expect(builtSnapshot.body).toEqual(encoder.encode(built.body));
			let calls = 0;
			const outcome = await core.generate(draft, async (request) => {
				calls++;
				const snapshot = verify(candidate(request), binding);
				expect(snapshot.body).toEqual(builtSnapshot.body);
				return completion(core);
			});
			expect(calls).toBe(1);
			expect(outcome).toMatchObject({ kind: "draft", output: OUTPUT });
		});

		it(`${format}: admits the actual synthetic probe against its preselected native draft`, async () => {
			const binding = trustedBinding(format, probeDraft);
			const core = provider(binding);
			let calls = 0;
			const result = await core.probe(async (request) => {
				calls++;
				const snapshot = verify(candidate(request), binding);
				expect(snapshot.method).toBe("POST");
				expect(snapshot.body).toEqual(encoder.encode(request.body));
				return completion(core, { ...OUTPUT, body: "", contextRefs: [] });
			});
			expect(calls).toBe(1);
			expect(result).toEqual({ status: "ok" });
		});

		for (const mutation of ["prompt", "model", "header", "schema"] as const) {
			it(`${format}: native authority refuses changed ${mutation} bytes`, () => {
				const binding = trustedBinding(format);
				const core = provider(binding);
				const request = candidate(core.build(draft));
				expect(verify(request, binding).profile).toBe("chat-completions-v1");
				const body = JSON.parse(new TextDecoder().decode(request.body));
				let changed: AiCandidateRequest;
				if (mutation === "header") {
					changed = { ...request, headers: [...request.headers, ["x-dytest-extra", "no"]] };
				} else {
					if (mutation === "prompt") body.messages[1].content += "DYTEST changed";
					if (mutation === "model") body.model = "synthetic-other:1";
					if (mutation === "schema") {
						if (format === "ollama") body.format.properties.body.type = "number";
						else if (format === "json_schema")
							body.response_format.json_schema.schema.properties.body.type = "number";
						else body.response_format.schema = { type: "object" };
					}
					changed = { ...request, body: encoder.encode(JSON.stringify(body)) };
				}
				expect(() => verify(changed, binding)).toThrow("Provider request refused");
			});
		}
	}

	it("refuses public plaintext falsely labelled local, then admits truthful HTTPS reclassification", () => {
		const binding: AiRequestBinding = {
			...trustedBinding("json_schema"),
			endpoint: "http://compatible.example/v1/chat/completions",
			answers: [{ address: "8.8.8.8", family: 4 }],
		};
		const localClaim = createCompatibleCore(
			{ endpoint: binding.endpoint, model: draft.model, format: "json_schema" },
			{ hostname: "compatible.example", destination: "local" },
		);
		expect(() => verify(candidate(localClaim.build(draft)), binding)).toThrow(
			"Provider request refused",
		);
		const cloudBinding: AiRequestBinding = {
			...binding,
			endpoint: "https://compatible.example/v1/chat/completions",
			policy: { ...binding.policy, allowLocal: false },
		};
		const cloud = createCompatibleCore(
			{ endpoint: cloudBinding.endpoint, model: draft.model, format: "json_schema" },
			{ hostname: "compatible.example", destination: "cloud" },
		);
		expect(verify(candidate(cloud.build(draft)), cloudBinding).url).toBe(cloudBinding.endpoint);
	});

	it("consumes the native current address and port exclusions independently of core metadata", () => {
		const binding = trustedBinding("json_schema");
		const request = candidate(provider(binding).build(draft));
		expect(verify(request, binding).profile).toBe("chat-completions-v1");
		for (const policy of [
			{ ...binding.policy, deniedAddresses: ["127.0.0.1"] },
			{ ...binding.policy, deniedPorts: [11434] },
		])
			expect(() => verify(request, { ...binding, policy })).toThrow("Provider request refused");
	});
});
