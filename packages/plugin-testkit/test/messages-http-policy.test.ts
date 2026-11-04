import { createFake } from "@draftyak/fakes";
import type { DraftRequest } from "@draftyak/protocol/ai-provider-v1";
import type { HeaderList } from "@draftyak/protocol/hash";
import { describe, expect, it } from "vitest";
import {
	checkMessagesHttpRequest,
	createMessagesHttpBinding,
	type MessagesHttpBinding,
	type MessagesHttpBindingInput,
	type MessagesHttpRequest,
	snapshotMessagesHttpInput,
} from "../src/messages-http.ts";

const origin = "https://api.anthropic.com" as const;
const encoder = new TextEncoder();
const refusal = { ok: false, code: "MESSAGES_HTTP_REQUEST_REFUSED" };
const request: DraftRequest = {
	model: "claude-opus-5-5",
	system: "DYTEST-Use only the fictional context.",
	prompt: "DYTEST-Write a fictional reply.",
	contextIds: ["c1"],
};
// The pure comparison tests supply expected schema DATA. They do not implement the SDK transform.
const schema = {
	type: "object",
	properties: { body: { type: "string" } },
	required: ["body"],
	additionalProperties: false,
};

function issue(input: MessagesHttpBindingInput): MessagesHttpBinding {
	const result = createMessagesHttpBinding(input);
	if (!result.ok) throw new Error("DYTEST-Messages comparison fixture refused");
	return result.binding;
}

function draftInput(): Extract<MessagesHttpBindingInput, { operation: "ai_draft_generate" }> {
	return {
		operation: "ai_draft_generate",
		origin,
		draft: structuredClone(request),
		schema: structuredClone(schema),
	};
}

function headers(post = false, fallback = false): HeaderList {
	return [
		["accept", "application/json"],
		["anthropic-version", "2023-06-01"],
		["x-api-key", "brokered"],
		["user-agent", "Anthropic/JS 0.135.0"],
		["x-stainless-retry-count", "0"],
		["x-stainless-timeout", "600"],
		...(post ? [["content-type", "application/json"] as const] : []),
		...(fallback ? [["anthropic-beta", "server-side-fallback-2026-07-01"] as const] : []),
	];
}

function body() {
	return {
		model: request.model,
		system: request.system,
		messages: [{ role: "user", content: request.prompt }],
		max_tokens: 16_000,
		output_config: {
			effort: "medium",
			format: { type: "json_schema", schema: structuredClone(schema) },
		},
		fallbacks: "default",
	};
}

function post(value: unknown = body()): MessagesHttpRequest {
	return {
		method: "POST",
		url: `${origin}/v1/messages`,
		headers: headers(true, true),
		body: encoder.encode(JSON.stringify(value)),
	};
}

function get(url: string): MessagesHttpRequest {
	return { method: "GET", url, headers: headers(), body: new Uint8Array() };
}

describe("constructor-bound Messages HTTP comparison", () => {
	it("accepts the actual stable completed-call envelope and captured schema data", () => {
		const selected = issue(draftInput());
		expect(checkMessagesHttpRequest(post(), selected)).toEqual({ ok: true });
		expect(
			checkMessagesHttpRequest(
				{ ...post(), body: encoder.encode(JSON.stringify(body(), null, 2)) },
				selected,
			),
		).toEqual({ ok: true });
	});

	it("binds explicit effort and token ceiling independently of model fallback support", () => {
		const input = draftInput();
		const selected = issue({
			...input,
			draft: { ...input.draft, model: "claude-haiku-4" },
			effort: "low",
			maxTokens: 100,
		});
		const { fallbacks: _fallbacks, ...plain } = body();
		const candidate = {
			...plain,
			model: "claude-haiku-4",
			max_tokens: 100,
			output_config: { ...plain.output_config, effort: "low" },
		};
		expect(
			checkMessagesHttpRequest({ ...post(candidate), headers: headers(true) }, selected),
		).toEqual({ ok: true });
		expect(checkMessagesHttpRequest(post(candidate), selected)).toEqual(refusal);
	});

	it("snapshots nested draft, context and schema arrays before later mutations", () => {
		const input = {
			...draftInput(),
			draft: { ...request, contextIds: ["c1"] as ("c1" | "c2" | "c3")[] },
			schema: structuredClone(schema),
		};
		const selected = issue(input);
		input.draft.prompt = "DYTEST-changed";
		input.draft.contextIds[0] = "c2";
		input.schema.required.push("other");
		input.schema.properties.body.type = "number";
		expect(checkMessagesHttpRequest(post(), selected)).toEqual({ ok: true });
		const changed = body();
		changed.output_config.format.schema = input.schema;
		expect(checkMessagesHttpRequest(post(changed), selected)).toEqual(refusal);
	});

	it("returns deeply frozen inert inputs for the future host constructor", () => {
		const captured = snapshotMessagesHttpInput(draftInput());
		expect(Object.isFrozen(captured)).toBe(true);
		if (captured.operation !== "ai_draft_generate")
			throw new Error("DYTEST-draft fixture required");
		expect(Object.isFrozen(captured.draft)).toBe(true);
		expect(Object.isFrozen(captured.draft.contextIds)).toBe(true);
		expect(Object.isFrozen(captured.schema)).toBe(true);
		expect(Object.isFrozen(captured.schema.required)).toBe(true);
	});

	it("binds each list page independently and refuses candidate-selected pagination", () => {
		const initial = issue({ operation: "ai_models_list", origin });
		const next = issue({ operation: "ai_models_list", origin, afterId: "claude-page-1" });
		const firstRequest = get(`${origin}/v1/models?limit=100`);
		const nextRequest = get(`${origin}/v1/models?limit=100&after_id=claude-page-1`);
		expect(checkMessagesHttpRequest(firstRequest, initial)).toEqual({ ok: true });
		expect(checkMessagesHttpRequest(nextRequest, next)).toEqual({ ok: true });
		expect(checkMessagesHttpRequest(nextRequest, initial)).toEqual(refusal);
		expect(checkMessagesHttpRequest(firstRequest, next)).toEqual(refusal);
		expect(
			checkMessagesHttpRequest(get(`${origin}/v1/models?limit=100&after_id=claude-page-2`), next),
		).toEqual(refusal);
	});

	it("binds the exact configured probe model without query or path alternatives", () => {
		const selected = issue({ operation: "ai_probe", origin, model: "claude-probe" });
		expect(checkMessagesHttpRequest(get(`${origin}/v1/models/claude-probe`), selected)).toEqual({
			ok: true,
		});
		for (const target of [
			"claude-other",
			"claude-probe?beta=true",
			"%63laude-probe",
			"claude-probe/",
		])
			expect(checkMessagesHttpRequest(get(`${origin}/v1/models/${target}`), selected)).toEqual(
				refusal,
			);
	});

	it.each([
		[
			"model",
			(value: ReturnType<typeof body>) => {
				value.model = "claude-other";
			},
		],
		[
			"system",
			(value: ReturnType<typeof body>) => {
				value.system = "DYTEST-other trusted instructions";
			},
		],
		[
			"prompt",
			(value: ReturnType<typeof body>) => {
				value.messages[0]!.content = "DYTEST-other prompt";
			},
		],
		[
			"token ceiling",
			(value: ReturnType<typeof body>) => {
				value.max_tokens = 15_999;
			},
		],
		[
			"effort",
			(value: ReturnType<typeof body>) => {
				value.output_config.effort = "high";
			},
		],
		[
			"schema",
			(value: ReturnType<typeof body>) => {
				value.output_config.format.schema.properties.body.type = "number";
			},
		],
		[
			"schema required",
			(value: ReturnType<typeof body>) => {
				value.output_config.format.schema.required = [];
			},
		],
	] as const)("refuses a changed %s against the captured draft", (_name, change) => {
		const value = body();
		change(value);
		expect(checkMessagesHttpRequest(post(value), issue(draftInput()))).toEqual(refusal);
	});

	it.each([
		["beta URL", { url: `${origin}/v1/messages?beta=true` }],
		["another origin", { url: "https://example.invalid/v1/messages" }],
		["method", { method: "GET" }],
		["stream mode", { body: encoder.encode(JSON.stringify({ ...body(), stream: true })) }],
		[
			"explicit completed mode",
			{ body: encoder.encode(JSON.stringify({ ...body(), stream: false })) },
		],
		[
			"extra field",
			{ body: encoder.encode(JSON.stringify({ ...body(), metadata: { user_id: "DYTEST" } })) },
		],
		["empty body", { body: new Uint8Array() }],
		[
			"duplicate member",
			{ body: encoder.encode('{"model":"claude-other",' + JSON.stringify(body()).slice(1)) },
		],
		["invalid UTF-8", { body: new Uint8Array([0xff]) }],
	] as const)("refuses an unbound %s", (_name, change) => {
		expect(checkMessagesHttpRequest({ ...post(), ...change }, issue(draftInput()))).toEqual(
			refusal,
		);
	});

	it.each([
		["api key", "x-api-key", "DYTEST-not-brokered"],
		["version", "anthropic-version", "2023-06-02"],
		["SDK version", "user-agent", "Anthropic/JS 0.135.1"],
		["retry", "x-stainless-retry-count", "1"],
		["timeout", "x-stainless-timeout", "601"],
		["beta", "anthropic-beta", "other-beta"],
	] as const)("refuses changed %s headers", (_name, field, value) => {
		const changed = headers(true, true).map(
			([name, current]) => [name, name === field ? value : current] as const,
		);
		expect(checkMessagesHttpRequest({ ...post(), headers: changed }, issue(draftInput()))).toEqual(
			refusal,
		);
	});

	it("rejects duplicate, extra, missing and accessor header fields without coercion", () => {
		const selected = issue(draftInput());
		for (const changed of [
			headers(true, true).slice(1),
			[...headers(true, true), ["authorization", "Bearer DYTEST"] as const],
			[...headers(true, true), ["X-API-Key", "brokered"] as const],
		])
			expect(checkMessagesHttpRequest({ ...post(), headers: changed }, selected)).toEqual(refusal);
		let calls = 0;
		const pair: [string, string] = ["accept", "application/json"];
		Object.defineProperty(pair, "1", {
			get() {
				calls++;
				return "application/json";
			},
		});
		expect(checkMessagesHttpRequest({ ...post(), headers: [pair] }, selected)).toEqual(refusal);
		expect(calls).toBe(0);
	});

	it("requires empty metadata request bodies and the same pinned SDK header set", () => {
		const selected = issue({ operation: "ai_models_list", origin });
		const candidate = get(`${origin}/v1/models?limit=100`);
		expect(
			checkMessagesHttpRequest({ ...candidate, body: encoder.encode("{}") }, selected),
		).toEqual(refusal);
		expect(checkMessagesHttpRequest({ ...candidate, headers: headers(true) }, selected)).toEqual(
			refusal,
		);
	});

	it.each([
		{ operation: "ai_probe", origin, model: "other-model" },
		{ operation: "ai_probe", origin, model: "claude-model/other" },
		{ operation: "ai_models_list", origin, afterId: undefined },
		{ operation: "ai_models_list", origin, afterId: "opaque/cursor" },
		{ ...draftInput(), maxTokens: 16_001 },
		{ ...draftInput(), maxTokens: 0 },
		{ ...draftInput(), effort: "none" },
		{ ...draftInput(), effort: undefined },
		{ ...draftInput(), origin: "https://example.invalid" },
		{ ...draftInput(), nativeAuthority: true },
	])("refuses malformed or authority-shaped fixture data %#", (input) => {
		expect(createMessagesHttpBinding(input as MessagesHttpBindingInput)).toEqual(refusal);
	});

	it("does not invoke proxy traps, accessors or toJSON during constructor capture", () => {
		let hooks = 0;
		const accessor = Object.defineProperty(draftInput(), "schema", {
			enumerable: true,
			get() {
				hooks++;
				return schema;
			},
		});
		const proxy = new Proxy(draftInput(), {
			ownKeys() {
				hooks++;
				return [];
			},
			getPrototypeOf() {
				hooks++;
				return Object.prototype;
			},
		});
		const schemaHook = {
			...schema,
			toJSON() {
				hooks++;
				return schema;
			},
		};
		const nested = Object.defineProperty({}, "type", {
			enumerable: true,
			get() {
				hooks++;
				return "string";
			},
		});
		for (const input of [
			accessor,
			proxy,
			{ ...draftInput(), schema: schemaHook },
			{ ...draftInput(), schema: { properties: { body: nested } } },
		])
			expect(createMessagesHttpBinding(input)).toEqual(refusal);
		expect(hooks).toBe(0);
	});

	it("refuses cyclic, sparse, excessively deep and oversized schemas", () => {
		const cycle: Record<string, unknown> = {};
		cycle.self = cycle;
		let deep: unknown = {};
		for (let index = 0; index < 66; index++) deep = { next: deep };
		const sparse = { values: new Array(2) };
		const huge = { description: "x".repeat(262_145) };
		const encodedHuge = { description: "\u0000".repeat(175_000) };
		const manyNodes = { values: Array.from({ length: 16_384 }, () => null) };
		for (const candidate of [cycle, deep, sparse, huge, encodedHuge, manyNodes])
			expect(
				createMessagesHttpBinding({
					...draftInput(),
					schema: candidate as Record<string, unknown>,
				}),
			).toEqual(refusal);
	});

	it("rejects forged comparison identities and candidate getters without calling them", () => {
		let hooks = 0;
		const candidate = Object.defineProperty(post(), "body", {
			enumerable: true,
			get() {
				hooks++;
				return post().body;
			},
		});
		expect(checkMessagesHttpRequest(candidate, issue(draftInput()))).toEqual(refusal);
		expect(checkMessagesHttpRequest(post(), {} as MessagesHttpBinding)).toEqual(refusal);
		expect(
			checkMessagesHttpRequest(post(), new Proxy(issue(draftInput()), {}) as MessagesHttpBinding),
		).toEqual(refusal);
		expect(hooks).toBe(0);
	});

	it("refuses detached/shared or oversized request byte storage", () => {
		const detached = new Uint8Array(1);
		structuredClone(detached.buffer, { transfer: [detached.buffer] });
		for (const candidate of [
			detached,
			new Uint8Array(new SharedArrayBuffer(1)),
			new Uint8Array(8_388_609),
		])
			expect(checkMessagesHttpRequest({ ...post(), body: candidate }, issue(draftInput()))).toEqual(
				refusal,
			);
	});

	it("rejects missing or mismatched bindings before the fake, then allows the matching request", async () => {
		let fakeCalls = 0;
		const fake = createFake(
			{
				fetch: () => {
					fakeCalls++;
					return Response.json({ ok: true });
				},
			},
			{ host: "api.anthropic.com" },
		);
		const selected = issue(draftInput());
		async function dispatch(
			candidate: MessagesHttpRequest,
			supplied: readonly MessagesHttpBinding[],
		) {
			if (!supplied.some((binding) => checkMessagesHttpRequest(candidate, binding).ok))
				return false;
			await fake.fetch(candidate.url, {
				method: candidate.method,
				headers: candidate.headers.map(([name, value]): [string, string] => [name, value]),
				body: new TextDecoder().decode(candidate.body),
			});
			return true;
		}
		expect(await dispatch(post(), [])).toBe(false);
		expect(await dispatch(post({ ...body(), model: "claude-other" }), [selected])).toBe(false);
		const changed = body();
		changed.output_config.format.schema.required = [];
		expect(await dispatch(post(changed), [selected])).toBe(false);
		expect(fakeCalls).toBe(0);
		expect(fake.recorder.takeRequests()).toHaveLength(0);
		expect(await dispatch(post(), [selected])).toBe(true);
		expect(fakeCalls).toBe(1);
		expect(fake.recorder.takeRequests()).toHaveLength(1);
	});
});
