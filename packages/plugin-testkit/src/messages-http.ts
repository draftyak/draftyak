import { types } from "node:util";
import { aiProviderV1, type DraftRequest } from "@draftyak/protocol/ai-provider-v1";
import type { HeaderList } from "@draftyak/protocol/hash";
import { canonicalize, parseStrict } from "@draftyak/protocol/jcs";

export type MessagesEffort = "low" | "medium" | "high" | "xhigh" | "max";
export type MessagesHttpBindingInput =
	| {
			readonly operation: "ai_models_list";
			readonly origin: "https://api.anthropic.com";
			readonly afterId?: string;
	  }
	| {
			readonly operation: "ai_probe";
			readonly origin: "https://api.anthropic.com";
			readonly model: string;
	  }
	| {
			readonly operation: "ai_draft_generate";
			readonly origin: "https://api.anthropic.com";
			readonly draft: DraftRequest;
			/** Actual provider-format schema supplied by the fixture, never by the request. */
			readonly schema: Readonly<Record<string, unknown>>;
			readonly effort?: MessagesEffort;
			readonly maxTokens?: number;
	  };

export interface MessagesHttpRequest {
	readonly method: string;
	readonly url: string;
	readonly headers: HeaderList;
	readonly body: Uint8Array;
}
declare const bindingIdentity: unique symbol;
/** Constructor-issued fixture comparison only; never broker or credential authority. */
export interface MessagesHttpBinding {
	readonly [bindingIdentity]: true;
}
export type MessagesHttpCheck =
	| { readonly ok: true }
	| { readonly ok: false; readonly code: "MESSAGES_HTTP_REQUEST_REFUSED" };
export type MessagesHttpBindingResult =
	| { readonly ok: true; readonly binding: MessagesHttpBinding }
	| { readonly ok: false; readonly code: "MESSAGES_HTTP_REQUEST_REFUSED" };

const ORIGIN = "https://api.anthropic.com";
const MAX_BODY_BYTES = 8_388_608;
const EFFORTS = ["low", "medium", "high", "xhigh", "max"] as const;
const FALLBACK_BETA = "server-side-fallback-2026-07-01";
const FALLBACK_MODELS = new Set([
	"claude-fable-5-1",
	"claude-fable-5",
	"claude-opus-5-5",
	"claude-opus-5",
	"claude-sonnet-5-5",
]);
const pass = Object.freeze({ ok: true } as const);
const refusal = Object.freeze({ ok: false, code: "MESSAGES_HTTP_REQUEST_REFUSED" } as const);
interface Expectation {
	readonly method: "GET" | "POST";
	readonly url: string;
	readonly fallback: boolean;
	readonly body?: string;
}
const bindings = new WeakMap<MessagesHttpBinding, Expectation>();
const typedArray = Object.getPrototypeOf(Uint8Array.prototype) as object;
const bufferSlot = Object.getOwnPropertyDescriptor(typedArray, "buffer")?.get;
const offsetSlot = Object.getOwnPropertyDescriptor(typedArray, "byteOffset")?.get;
const lengthSlot = Object.getOwnPropertyDescriptor(typedArray, "byteLength")?.get;
const validateView = Uint8Array.prototype.values;

function fail(): never {
	throw new Error("Messages HTTP fixture binding refused");
}

function record(
	value: unknown,
	required: readonly string[],
	optional: readonly string[] = [],
): Record<string, unknown> {
	if (value === null || typeof value !== "object" || types.isProxy(value)) fail();
	const prototype = Object.getPrototypeOf(value);
	if (prototype !== Object.prototype && prototype !== null) fail();
	const keys = Reflect.ownKeys(value);
	if (keys.length > required.length + optional.length) fail();
	const copied: Record<string, unknown> = Object.create(null);
	for (const key of keys) {
		if (typeof key !== "string" || (!required.includes(key) && !optional.includes(key))) fail();
		const slot = Object.getOwnPropertyDescriptor(value, key);
		if (!slot?.enumerable || !Object.hasOwn(slot, "value")) fail();
		copied[key] = slot.value;
	}
	if (required.some((key) => !Object.hasOwn(copied, key))) fail();
	return copied;
}

function vector(value: unknown, maximum: number): unknown[] {
	if (
		types.isProxy(value) ||
		!Array.isArray(value) ||
		Object.getPrototypeOf(value) !== Array.prototype
	)
		fail();
	const length: unknown = Object.getOwnPropertyDescriptor(value, "length")?.value;
	if (
		typeof length !== "number" ||
		!Number.isSafeInteger(length) ||
		length < 0 ||
		length > maximum ||
		Reflect.ownKeys(value).length !== length + 1
	)
		fail();
	const copied: unknown[] = [];
	for (let index = 0; index < length; index++) {
		const slot = Object.getOwnPropertyDescriptor(value, String(index));
		if (!slot?.enumerable || !Object.hasOwn(slot, "value")) fail();
		copied.push(slot.value);
	}
	return copied;
}

function model(value: unknown): string {
	if (typeof value !== "string" || !/^claude-[a-z0-9.-]{1,64}$/.test(value)) fail();
	return value;
}

function draft(value: unknown): DraftRequest {
	const fields = record(value, ["model", "system", "prompt", "contextIds"]);
	const copied = {
		model: model(fields.model),
		system: fields.system,
		prompt: fields.prompt,
		contextIds: vector(fields.contextIds, 3),
	};
	if (typeof copied.system !== "string" || typeof copied.prompt !== "string") fail();
	if (!copied.contextIds.every((id) => id === "c1" || id === "c2" || id === "c3")) fail();
	const result = aiProviderV1.tools.ai_draft_generate.input.safeParse(copied);
	if (!result.success) fail();
	return Object.freeze({ ...result.data, contextIds: Object.freeze([...result.data.contextIds]) });
}

function schema(value: unknown): Readonly<Record<string, unknown>> {
	let nodes = 16_384;
	let units = 262_144;
	const active = new Set<object>();
	function copy(input: unknown, depth: number): unknown {
		if (--nodes < 0 || depth > 64 || types.isProxy(input)) fail();
		if (input === null || typeof input === "boolean") return input;
		if (typeof input === "number" && Number.isFinite(input)) return input;
		if (typeof input === "string") {
			units -= input.length;
			if (units < 0 || !input.isWellFormed()) fail();
			return input;
		}
		if (typeof input !== "object" || active.has(input)) fail();
		active.add(input);
		try {
			if (Array.isArray(input))
				return Object.freeze(vector(input, 16_384).map((value) => copy(value, depth + 1)));
			const keys = Reflect.ownKeys(input);
			if (keys.length > nodes || keys.some((key) => typeof key !== "string")) fail();
			const fields = record(input, [], keys as string[]);
			const result: Record<string, unknown> = Object.create(null);
			for (const [key, entry] of Object.entries(fields)) {
				units -= key.length;
				if (units < 0 || !key.isWellFormed()) fail();
				result[key] = copy(entry, depth + 1);
			}
			return Object.freeze(result);
		} finally {
			active.delete(input);
		}
	}
	const result = copy(value, 0);
	if (result === null || typeof result !== "object" || Array.isArray(result)) fail();
	if (new TextEncoder().encode(canonicalize(result)).byteLength > 1_048_576) fail();
	return result as Readonly<Record<string, unknown>>;
}

/** Copies only inert expected fixture data, before reading any plugin or candidate fields. */
export function snapshotMessagesHttpInput(raw: unknown): MessagesHttpBindingInput {
	try {
		const tag = record(
			raw,
			["operation", "origin"],
			["model", "afterId", "draft", "schema", "effort", "maxTokens"],
		);
		if (tag.origin !== ORIGIN) fail();
		if (tag.operation === "ai_models_list") {
			const fields = record(raw, ["operation", "origin"], ["afterId"]);
			const afterId = Object.hasOwn(fields, "afterId") ? model(fields.afterId) : undefined;
			return Object.freeze({
				operation: "ai_models_list",
				origin: ORIGIN,
				...(afterId === undefined ? {} : { afterId }),
			});
		}
		if (tag.operation === "ai_probe") {
			const fields = record(raw, ["operation", "origin", "model"]);
			return Object.freeze({ operation: "ai_probe", origin: ORIGIN, model: model(fields.model) });
		}
		if (tag.operation !== "ai_draft_generate") fail();
		const fields = record(raw, ["operation", "origin", "draft", "schema"], ["effort", "maxTokens"]);
		const effort = Object.hasOwn(fields, "effort") ? fields.effort : "medium";
		if (!EFFORTS.some((value) => value === effort)) fail();
		const maxTokens = Object.hasOwn(fields, "maxTokens") ? fields.maxTokens : 16_000;
		if (
			typeof maxTokens !== "number" ||
			!Number.isSafeInteger(maxTokens) ||
			maxTokens < 1 ||
			maxTokens > 16_000
		)
			fail();
		return Object.freeze({
			operation: "ai_draft_generate",
			origin: ORIGIN,
			draft: draft(fields.draft),
			schema: schema(fields.schema),
			effort: effort as MessagesEffort,
			maxTokens,
		});
	} catch {
		return fail();
	}
}

/** Issues an immutable comparison expectation; it grants no native authority. */
export function createMessagesHttpBinding(
	input: MessagesHttpBindingInput,
): MessagesHttpBindingResult {
	try {
		const selected = snapshotMessagesHttpInput(input);
		let expected: Expectation;
		if (selected.operation === "ai_models_list") {
			expected = {
				method: "GET",
				url: `${ORIGIN}/v1/models?limit=100${selected.afterId === undefined ? "" : `&after_id=${encodeURIComponent(selected.afterId)}`}`,
				fallback: false,
			};
		} else if (selected.operation === "ai_probe") {
			expected = {
				method: "GET",
				url: `${ORIGIN}/v1/models/${selected.model}`,
				fallback: false,
			};
		} else {
			const fallback = FALLBACK_MODELS.has(selected.draft.model);
			expected = {
				method: "POST",
				url: `${ORIGIN}/v1/messages`,
				fallback,
				body: canonicalize({
					model: selected.draft.model,
					system: selected.draft.system,
					messages: [{ role: "user", content: selected.draft.prompt }],
					max_tokens: selected.maxTokens,
					output_config: {
						effort: selected.effort,
						format: { type: "json_schema", schema: selected.schema },
					},
					...(fallback ? { fallbacks: "default" } : {}),
				}),
			};
		}
		const identity = Object.freeze(Object.create(null)) as MessagesHttpBinding;
		bindings.set(identity, Object.freeze(expected));
		return Object.freeze({ ok: true, binding: identity });
	} catch {
		return refusal;
	}
}

function bytes(value: unknown): Uint8Array {
	if (
		types.isProxy(value) ||
		!types.isUint8Array(value) ||
		(Object.getPrototypeOf(value) !== Uint8Array.prototype &&
			Object.getPrototypeOf(value) !== Buffer.prototype)
	)
		fail();
	validateView.call(value);
	const buffer: unknown = bufferSlot?.call(value);
	const offset: unknown = offsetSlot?.call(value);
	const length: unknown = lengthSlot?.call(value);
	if (
		!types.isAnyArrayBuffer(buffer) ||
		types.isSharedArrayBuffer(buffer) ||
		typeof offset !== "number" ||
		typeof length !== "number" ||
		length > MAX_BODY_BYTES
	)
		fail();
	const copy = new Uint8Array(length);
	Uint8Array.prototype.set.call(copy, new Uint8Array(buffer as ArrayBuffer, offset, length));
	return copy;
}

/** Compares complete raw request data before a fixture is called. */
export function checkMessagesHttpRequest(
	request: MessagesHttpRequest,
	binding: MessagesHttpBinding,
): MessagesHttpCheck {
	try {
		if (binding === null || typeof binding !== "object") fail();
		const expected = bindings.get(binding);
		if (!expected) fail();
		const fields = record(request, ["method", "url", "headers", "body"]);
		if (fields.method !== expected.method || fields.url !== expected.url) fail();
		const required: Record<string, string> = {
			accept: "application/json",
			"anthropic-version": "2023-06-01",
			"x-api-key": "brokered",
			"user-agent": "Anthropic/JS 0.135.0",
			"x-stainless-retry-count": "0",
			"x-stainless-timeout": "600",
		};
		if (expected.method === "POST") required["content-type"] = "application/json";
		if (expected.fallback) required["anthropic-beta"] = FALLBACK_BETA;
		const headers = new Map<string, string>();
		for (const entry of vector(fields.headers, 8)) {
			const pair = vector(entry, 2);
			if (
				pair.length !== 2 ||
				typeof pair[0] !== "string" ||
				typeof pair[1] !== "string" ||
				pair[0].length > 64 ||
				pair[1].length > 128
			)
				fail();
			const name = pair[0].toLowerCase();
			if (headers.has(name) || !Object.hasOwn(required, name) || required[name] !== pair[1]) fail();
			headers.set(name, pair[1]);
		}
		if (headers.size !== Object.keys(required).length) fail();
		const body = bytes(fields.body);
		if (expected.method === "GET") {
			if (body.length !== 0) fail();
		} else if (body.length === 0 || canonicalize(parseStrict(body)) !== expected.body) fail();
		return pass;
	} catch {
		return refusal;
	}
}
