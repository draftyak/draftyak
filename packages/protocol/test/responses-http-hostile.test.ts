import { Buffer } from "node:buffer";
import { describe, expect, it } from "vitest";
import {
	checkResponsesHttpRequest,
	createResponsesHttpBinding,
	type ResponsesHttpBinding,
	type ResponsesHttpBindingInput,
	type ResponsesHttpRequest,
} from "../src/manifest/responses-http.ts";

const ORIGIN = "https://api.openai.com";
const GENERATE = `${ORIGIN}/v1/responses`;
const MODELS = `${ORIGIN}/v1/models`;
const MAX_BODY_BYTES = 8_388_608;
const REFUSAL = { ok: false, code: "RESPONSES_HTTP_REQUEST_REFUSED" } as const;
const EFFORTS = ["none", "minimal", "low", "medium", "high", "xhigh", "max"] as const;

// Independently pinned from the merged broker's fixtures/responses-format.json.
// Do not derive the expected wire schema from the comparison implementation.
const FORMAT_SCHEMA = {
	$schema: "http://json-schema.org/draft-07/schema#",
	additionalProperties: false,
	description: "A model's draft: the reply body and notes for the owner.",
	properties: {
		body: { maxLength: 8000, type: "string" },
		contextRefs: {
			items: { enum: ["c1", "c2", "c3"], type: "string" },
			maxItems: 3,
			type: "array",
		},
		needsOwnerInput: {
			items: { maxLength: 300, type: "string" },
			maxItems: 5,
			type: "array",
		},
		ownerNotes: { maxLength: 1000, type: "string" },
		suspectedInstructions: { type: "boolean" },
	},
	required: ["body", "ownerNotes", "needsOwnerInput", "suspectedInstructions", "contextRefs"],
	title: "DraftOutputV1",
	type: "object",
};

function draft() {
	return {
		model: "gpt-dytest",
		system: "Follow the owner's instructions.",
		prompt: "<thread>Draft a reply.</thread>",
		contextIds: ["c1"],
	};
}

function input(effort?: (typeof EFFORTS)[number]) {
	return {
		operation: "ai_draft_generate",
		origin: ORIGIN,
		draft: draft(),
		...(effort === undefined ? {} : { effort }),
	};
}

function body(source = draft(), effort?: (typeof EFFORTS)[number]) {
	return {
		model: source.model,
		instructions: source.system,
		input: [{ role: "user", content: source.prompt }],
		text: {
			format: {
				type: "json_schema",
				name: "draft_output",
				strict: true,
				schema: structuredClone(FORMAT_SCHEMA),
			},
		},
		...(effort === undefined ? {} : { reasoning: { effort } }),
		stream: true,
		store: false,
	};
}

function bytes(value: unknown): Uint8Array {
	return new TextEncoder().encode(JSON.stringify(value));
}

function request(value: unknown = body()): ResponsesHttpRequest {
	return {
		method: "POST",
		url: GENERATE,
		headers: [
			["content-type", "application/json"],
			["authorization", "Bearer brokered"],
		],
		body: bytes(value),
	};
}

function metadata(url = MODELS): ResponsesHttpRequest {
	return {
		method: "GET",
		url,
		headers: [
			["accept", "application/json"],
			["authorization", "Bearer brokered"],
		],
		body: new Uint8Array(),
	};
}

function binding(value: unknown = input()): ResponsesHttpBinding {
	const result = createResponsesHttpBinding(value as ResponsesHttpBindingInput);
	expect(result.ok, "the independent fixture must bind").toBe(true);
	expect(Object.isFrozen(result)).toBe(true);
	if (!result.ok) throw new Error("Fixture binding refused");
	expect(Object.isFrozen(result.binding)).toBe(true);
	return result.binding;
}

function check(value: unknown, ...bindings: unknown[]) {
	const bound = bindings.length === 0 ? binding() : bindings[0];
	return checkResponsesHttpRequest(value as ResponsesHttpRequest, bound as ResponsesHttpBinding);
}

function accepted(value: unknown, bound: unknown = binding()): void {
	const result = check(value, bound);
	expect(result).toEqual({ ok: true });
	expect(Object.isFrozen(result)).toBe(true);
}

function refused(result: unknown, label?: string): void {
	expect(result, label).toEqual(REFUSAL);
	expect(Object.isFrozen(result)).toBe(true);
}

function trapped<T extends object>(target: T) {
	let calls = 0;
	const trap = (): never => {
		calls++;
		throw new Error("dytest hook must remain unobserved");
	};
	return {
		value: new Proxy(target, {
			get: trap,
			getPrototypeOf: trap,
			getOwnPropertyDescriptor: trap,
			ownKeys: trap,
			has: trap,
		}),
		calls: () => calls,
	};
}

describe("Responses HTTP detached comparison boundary", () => {
	it("accepts independently pinned generation, list and encoded probe fixtures", () => {
		accepted(request());
		for (const operation of ["ai_models_list", "ai_probe"]) {
			accepted(metadata(), binding({ operation, origin: ORIGIN }));
		}
		accepted(
			metadata(`${MODELS}/model%2Fa%3F%23%25`),
			binding({ operation: "ai_probe", origin: ORIGIN, model: "model/a?#%" }),
		);
	});

	it("keeps absent reasoning absent and binds all seven explicit efforts", () => {
		const plain = binding();
		accepted(request(), plain);
		refused(check(request({ ...body(), reasoning: { effort: "none" } }), plain));
		for (const effort of EFFORTS) {
			const bound = binding(input(effort));
			accepted(request(body(draft(), effort)), bound);
			refused(check(request(), bound), effort);
			refused(check(request({ ...body(), reasoning: { effort, summary: "auto" } }), bound));
		}
	});

	it("captures mutable constructor inputs and never adopts later nested aliases", () => {
		const source = input("low");
		const original = request(body(source.draft, "low"));
		const first = binding(source);
		source.draft.model = "different-model";
		source.draft.system = "different instructions";
		source.draft.prompt = "different prompt";
		source.draft.contextIds.push("c2");
		source.effort = "high";
		const changed = request(body(source.draft, "high"));
		const second = binding(source);
		source.origin = "https://example.test";
		source.draft.contextIds.push("invalid");
		accepted(original, first);
		accepted(changed, second);
		refused(check(changed, first));
		refused(check(original, second));
		for (const key of ["draft", "system", "prompt", "settings", "schema", "origin"])
			expect(Object.hasOwn(first, key)).toBe(false);
	});

	it("requires the actual issued identity without inspecting forged or proxied bindings", () => {
		const issued = binding();
		const copies = [
			{},
			{ ...issued },
			Object.create(issued),
			Object.create(Object.getPrototypeOf(issued), Object.getOwnPropertyDescriptors(issued)),
			null,
			undefined,
		];
		for (const copy of copies) refused(check(request(), copy));
		const proxy = trapped(issued);
		refused(check(request(), proxy.value));
		expect(proxy.calls()).toBe(0);
		accepted(request(), issued);
	});

	it("rejects invalid constructor tags, origins, models and context identifiers", () => {
		const invalid: unknown[] = [
			{ ...input(), operation: "unknown" },
			{ ...input(), origin: `${ORIGIN}/` },
			{ ...input(), origin: "http://api.openai.com" },
			{ ...input(), effort: "HIGH" },
			{ ...input(), effort: null },
			{ ...input(), effort: undefined },
			{ ...input(), extra: true },
			{ operation: "ai_models_list", origin: ORIGIN, model: "gpt-dytest" },
			{ operation: "ai_probe", origin: ORIGIN, model: undefined },
			{ operation: "ai_probe", origin: ORIGIN, model: "." },
			{ operation: "ai_probe", origin: ORIGIN, model: ".." },
			...(["", "a".repeat(257), "model\n", "model name", "model\t", "modél"] as const).map(
				(model) => ({ ...input(), draft: { ...draft(), model } }),
			),
			{ ...input(), draft: { ...draft(), contextIds: ["c1", "c1"] } },
			{ ...input(), draft: { ...draft(), contextIds: ["c4"] } },
		];
		for (const value of invalid)
			refused(createResponsesHttpBinding(value as ResponsesHttpBindingInput));
		refused(
			createResponsesHttpBinding({
				operation: "ai_probe",
				origin: ORIGIN,
				model: "model\n",
			}),
		);
	});

	it("enforces code-point bounds without rejecting valid supplementary Unicode", () => {
		const source = input();
		source.draft.system = "😀".repeat(100_000);
		source.draft.prompt = "😀".repeat(1_000_000);
		accepted(request(body(source.draft)), binding(source));
		for (const [field, value] of [
			["system", "x".repeat(100_001)],
			["prompt", "x".repeat(1_000_001)],
			["system", "\ud800"],
			["prompt", "\udfff"],
		] as const) {
			refused(
				createResponsesHttpBinding({
					...input(),
					draft: { ...draft(), [field]: value },
				} as ResponsesHttpBindingInput),
			);
		}
	});

	it("refuses constructor accessors and proxies without executing their hooks", () => {
		let calls = 0;
		const getter = (): never => {
			calls++;
			throw new Error("dytest constructor canary");
		};
		const accessor = Object.defineProperty(input(), "draft", { get: getter, enumerable: true });
		refused(createResponsesHttpBinding(accessor as ResponsesHttpBindingInput));
		const nested = { ...input(), draft: Object.defineProperty(draft(), "model", { get: getter }) };
		refused(createResponsesHttpBinding(nested as ResponsesHttpBindingInput));
		for (const target of [input(), draft(), ["c1"]]) {
			const proxy = trapped(target);
			const value = Array.isArray(target)
				? { ...input(), draft: { ...draft(), contextIds: proxy.value } }
				: "model" in target
					? { ...input(), draft: proxy.value }
					: proxy.value;
			refused(createResponsesHttpBinding(value as ResponsesHttpBindingInput));
			expect(proxy.calls()).toBe(0);
		}
		expect(calls).toBe(0);
	});

	it("requires literal methods and canonical targets for every operation", () => {
		for (const method of ["post", "GET", "POST ", "HEAD"]) refused(check({ ...request(), method }));
		for (const url of [
			"http://api.openai.com/v1/responses",
			"https://api.openai.com.example.test/v1/responses",
			"https://user@api.openai.com/v1/responses",
			"https://api.openai.com:443/v1/responses",
			"https://API.OPENAI.COM/v1/responses",
			`${GENERATE}/`,
			`${GENERATE}?`,
			`${GENERATE}?stream=true`,
			`${GENERATE}#fragment`,
			`${ORIGIN}/v1/x/../responses`,
			`${ORIGIN}/v1/%72esponses`,
			`${ORIGIN}/${"x".repeat(4096)}`,
		])
			refused(check({ ...request(), url }), url);
		const probe = binding({ operation: "ai_probe", origin: ORIGIN, model: "model/a" });
		accepted(metadata(`${MODELS}/model%2Fa`), probe);
		for (const url of [`${MODELS}/model/a`, `${MODELS}/model%2fa`, `${MODELS}/model%252Fa`, MODELS])
			refused(check(metadata(url), probe));
		refused(
			check(
				{ ...metadata(), method: "POST" },
				binding({ operation: "ai_models_list", origin: ORIGIN }),
			),
		);
	});

	it("folds header names but rejects duplicate logical names and altered values", () => {
		accepted({
			...request(),
			headers: [
				["Accept", "application/json"],
				["AUTHORIZATION", "Bearer brokered"],
				["Content-Type", "application/json"],
			],
		});
		const invalid = [
			[["content-type", "application/json"]],
			[...request().headers, ["Content-Type", "application/json"]],
			[...request().headers, ["Authorization", "Bearer different"]],
			[...request().headers, ["x-extra", "dytest-header-canary"]],
			[
				["content-type", "application/json; charset=utf-8"],
				["authorization", "Bearer brokered"],
			],
			[
				["content-type", "Application/JSON"],
				["authorization", "Bearer brokered"],
			],
			[
				["content-type", "application/json"],
				["authorization", "bearer brokered"],
			],
			[
				["content-type", "application/json"],
				["authorization", "Bearer brokered\r\nx-extra: yes"],
			],
			[...request().headers, ["accept", "application/json "]],
		];
		for (const headers of invalid) refused(check({ ...request(), headers }));
		const bound = binding({ operation: "ai_models_list", origin: ORIGIN });
		refused(
			check(
				{ ...metadata(), headers: [...metadata().headers, ["content-type", "application/json"]] },
				bound,
			),
		);
		refused(
			check(
				{ ...metadata(), headers: [...metadata().headers, ["Accept", "application/json"]] },
				bound,
			),
		);
	});

	it("pins every body field and nested format annotation", () => {
		const changes: ((value: ReturnType<typeof body>) => unknown)[] = [
			(value) => ({ ...value, model: "different-model" }),
			(value) => ({ ...value, instructions: "different instructions" }),
			(value) => ({ ...value, input: [{ role: "user", content: "different prompt" }] }),
			(value) => ({ ...value, input: [...value.input, ...value.input] }),
			(value) => ({ ...value, input: [{ role: "assistant", content: draft().prompt }] }),
			(value) => ({ ...value, stream: false }),
			(value) => ({ ...value, store: true }),
			(value) => ({ ...value, tools: [] }),
			(value) => ({ ...value, metadata: { note: "dytest-body-canary" } }),
			(value) => ({ ...value, contextIds: ["c1"] }),
			(value) => ({ ...value, text: { format: { ...value.text.format, strict: false } } }),
			(value) => ({ ...value, text: { format: { ...value.text.format, name: "other" } } }),
			(value) => ({ ...value, text: { format: { ...value.text.format, type: "json_object" } } }),
			(value) => {
				value.text.format.schema.additionalProperties = true;
				return value;
			},
			(value) => {
				value.text.format.schema.description = "dytest-schema-canary";
				return value;
			},
			(value) => {
				value.text.format.schema.properties.body.maxLength++;
				return value;
			},
			(value) => {
				value.text.format.schema.required.pop();
				return value;
			},
		];
		for (const change of changes) refused(check(request(change(body()))));
		for (const field of ["stream", "store", "instructions", "text"] as const) {
			const value: Record<string, unknown> = body();
			delete value[field];
			refused(check(request(value)), field);
		}
	});

	it("rejects duplicate JSON members even when an ordinary parser keeps the expected last value", () => {
		const original = JSON.stringify(body());
		for (const text of [
			original.replace('"store":false', '"store":true,"store":false'),
			original.replace('"store":false', '"st\\u006fre":false,"store":false'),
			original.replace('"role":"user"', '"role":"assistant","role":"user"'),
			original.replace(
				'"additionalProperties":false',
				'"additionalProperties":true,"additionalProperties":false',
			),
		]) {
			expect(JSON.parse(text)).toEqual(body());
			refused(check({ ...request(), body: new TextEncoder().encode(text) }));
		}
	});

	it("accepts semantic JSON spelling while refusing malformed UTF8, grammar and excessive depth", () => {
		const original = JSON.stringify(body());
		accepted({
			...request(),
			body: new TextEncoder().encode(` \n${original.replace('"store"', '"st\\u006fre"')}\t`),
		});
		for (const text of [
			`${original} {}`,
			original.replace(/}$/, ",}"),
			original.replace(JSON.stringify(draft().system), '"\\ud800"'),
			`${"[".repeat(65)}0${"]".repeat(65)}`,
		])
			refused(check({ ...request(), body: new TextEncoder().encode(text) }));
		for (const malformed of [
			new Uint8Array([0xc3, 0x28]),
			new Uint8Array([0xef, 0xbb, 0xbf, ...bytes(body())]),
		])
			refused(check({ ...request(), body: malformed }));
	});

	it("keeps the native raw byte ceiling inclusive and metadata bodies exactly empty", () => {
		const padded = new Uint8Array(MAX_BODY_BYTES);
		padded.fill(0x20);
		padded.set(bytes(body()));
		accepted({ ...request(), body: padded });
		const oversized = new Uint8Array(MAX_BODY_BYTES + 1);
		oversized.fill(0x20);
		oversized.set(bytes(body()));
		refused(check({ ...request(), body: oversized }));
		refused(check({ ...request(), body: new Uint8Array() }));
		const bound = binding({ operation: "ai_probe", origin: ORIGIN });
		accepted(metadata(), bound);
		refused(check({ ...metadata(), body: new Uint8Array([0x20]) }, bound));
	});

	it("reads exactly the native byte-view range and refuses shared, detached or nonnative views", () => {
		const original = bytes(body());
		const storage = new Uint8Array(original.length + 2);
		storage.set(original, 1);
		accepted({ ...request(), body: storage.subarray(1, -1) });
		accepted({ ...request(), body: Buffer.from(original) });
		const shadowed = original.slice();
		let shadowCalls = 0;
		const shadow = (): never => {
			shadowCalls++;
			throw new Error("DYTEST byte-view shadow");
		};
		for (const key of [
			"buffer",
			"byteOffset",
			"byteLength",
			"length",
			"constructor",
			Symbol.iterator,
			Symbol.toPrimitive,
			"toJSON",
		])
			Object.defineProperty(shadowed, key, { get: shadow });
		accepted({ ...request(), body: shadowed });
		expect(shadowCalls).toBe(0);
		const shared = new Uint8Array(new SharedArrayBuffer(original.length));
		shared.set(original);
		const detached = original.slice();
		structuredClone(detached, { transfer: [detached.buffer] });
		class DerivedBytes extends Uint8Array {}
		for (const value of [
			shared,
			detached,
			new DataView(original.buffer),
			new DerivedBytes(original),
		])
			refused(check({ ...request(), body: value }));
		const proxy = trapped(original);
		refused(check({ ...request(), body: proxy.value }));
		expect(proxy.calls()).toBe(0);
	});

	it("refuses noninert request and header structures without consulting accessors or proxies", () => {
		let calls = 0;
		const getter = (): never => {
			calls++;
			throw new Error("dytest request canary");
		};
		const accessor = Object.defineProperty(request(), "body", { get: getter, enumerable: true });
		refused(check(accessor));
		const row = Object.defineProperty(["content-type", "application/json"], "1", { get: getter });
		refused(check({ ...request(), headers: [row, ["authorization", "Bearer brokered"]] }));
		const sparse = new Array(2);
		sparse[1] = ["authorization", "Bearer brokered"];
		refused(check({ ...request(), headers: sparse }));
		const augmented = Object.assign([...request().headers], { extra: true });
		refused(check({ ...request(), headers: augmented }));
		refused(check(Object.assign(Object.create({ inherited: true }), request())));
		refused(check({ ...request(), [Symbol("extra")]: true }));
		refused(check(Object.defineProperty(request(), "extra", { value: true })));
		for (const target of [request(), request().headers, ["content-type", "application/json"]]) {
			const proxy = trapped(target);
			const value = Array.isArray(target)
				? typeof target[0] === "string"
					? { ...request(), headers: [proxy.value, ["authorization", "Bearer brokered"]] }
					: { ...request(), headers: proxy.value }
				: proxy.value;
			refused(check(value));
			expect(proxy.calls()).toBe(0);
		}
		expect(calls).toBe(0);
	});
});
