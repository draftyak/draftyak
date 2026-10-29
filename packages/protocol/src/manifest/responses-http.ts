import { types } from "node:util";
import { aiProviderV1, type DraftRequest, ModelId } from "../ai-provider-v1.ts";
import { DraftOutputV1 } from "../draft-output.ts";
import type { HeaderList } from "../hash.ts";
import { canonicalize, parseStrict } from "../jcs.ts";

export interface ResponsesHttpRequest {
	readonly method: string;
	readonly url: string;
	readonly headers: HeaderList;
	readonly body: Uint8Array;
}

export type ResponsesReasoningEffort =
	| "none"
	| "minimal"
	| "low"
	| "medium"
	| "high"
	| "xhigh"
	| "max";

export type ResponsesHttpBindingInput =
	| {
			readonly operation: "ai_draft_generate";
			readonly origin: "https://api.openai.com";
			readonly draft: DraftRequest;
			readonly effort?: ResponsesReasoningEffort;
	  }
	| {
			readonly operation: "ai_models_list";
			readonly origin: "https://api.openai.com";
	  }
	| {
			readonly operation: "ai_probe";
			readonly origin: "https://api.openai.com";
			readonly model?: string;
	  };

declare const bindingIdentity: unique symbol;
/** Constructor-issued comparison identity, never native dispatch or credential authority. */
export interface ResponsesHttpBinding {
	readonly [bindingIdentity]: true;
}

export type ResponsesHttpCheck =
	| { readonly ok: true }
	| { readonly ok: false; readonly code: "RESPONSES_HTTP_REQUEST_REFUSED" };
export type ResponsesHttpBindingResult =
	| { readonly ok: true; readonly binding: ResponsesHttpBinding }
	| { readonly ok: false; readonly code: "RESPONSES_HTTP_REQUEST_REFUSED" };

const pass = Object.freeze({ ok: true } as const);
const refusal = Object.freeze({ ok: false, code: "RESPONSES_HTTP_REQUEST_REFUSED" } as const);
const ORIGIN = "https://api.openai.com";
const MAX_BODY_BYTES = 8_388_608;
const EFFORTS = new Set<ResponsesReasoningEffort>([
	"none",
	"minimal",
	"low",
	"medium",
	"high",
	"xhigh",
	"max",
]);
const schema = DraftOutputV1.toJSONSchema({
	target: "draft-7",
	override: ({ jsonSchema }) => {
		delete jsonSchema.uniqueItems;
	},
});
interface Expectation {
	readonly method: "GET" | "POST";
	readonly url: string;
	readonly body?: string;
}
const bindings = new WeakMap<ResponsesHttpBinding, Expectation>();
const typedArray = Object.getPrototypeOf(Uint8Array.prototype) as object;
const bufferSlot = Object.getOwnPropertyDescriptor(typedArray, "buffer")?.get;
const offsetSlot = Object.getOwnPropertyDescriptor(typedArray, "byteOffset")?.get;
const lengthSlot = Object.getOwnPropertyDescriptor(typedArray, "byteLength")?.get;

function fail(): never {
	throw new Error("Responses request comparison refused");
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
	const result: Record<string, unknown> = Object.create(null);
	for (const key of keys) {
		if (typeof key !== "string" || (!required.includes(key) && !optional.includes(key))) fail();
		const slot = Object.getOwnPropertyDescriptor(value, key);
		if (!slot?.enumerable || !Object.hasOwn(slot, "value")) fail();
		result[key] = slot.value;
	}
	if (required.some((key) => !Object.hasOwn(result, key))) fail();
	return result;
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
	const result: unknown[] = [];
	for (let index = 0; index < length; index++) {
		const slot = Object.getOwnPropertyDescriptor(value, String(index));
		if (!slot?.enumerable || !Object.hasOwn(slot, "value")) fail();
		result.push(slot.value);
	}
	return result;
}

function model(value: unknown): string {
	if (
		typeof value !== "string" ||
		value.length < 1 ||
		value.length > 256 ||
		/[^!-~]/u.test(value) ||
		!ModelId.safeParse(value).success
	)
		fail();
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
	const parsed = aiProviderV1.tools.ai_draft_generate.input.safeParse(copied);
	if (!parsed.success) fail();
	return parsed.data;
}

function bytes(value: unknown): Uint8Array {
	if (
		types.isProxy(value) ||
		!types.isUint8Array(value) ||
		(Object.getPrototypeOf(value) !== Uint8Array.prototype &&
			Object.getPrototypeOf(value) !== Buffer.prototype)
	)
		fail();
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
	// Native slots and copying avoid a caller's iterator, accessors and constructor.
	Uint8Array.prototype.set.call(copy, new Uint8Array(buffer as ArrayBuffer, offset, length));
	return copy;
}

/** Captures trusted serving inputs; candidate fields never create or change this expectation. */
export function createResponsesHttpBinding(
	input: ResponsesHttpBindingInput,
): ResponsesHttpBindingResult {
	try {
		const tag = record(input, ["operation", "origin"], ["draft", "effort", "model"]);
		if (tag.origin !== ORIGIN) fail();
		let expected: Expectation;
		if (tag.operation === "ai_draft_generate") {
			const fields = record(input, ["operation", "origin", "draft"], ["effort"]);
			if (
				Object.hasOwn(fields, "effort") &&
				!EFFORTS.has(fields.effort as ResponsesReasoningEffort)
			)
				fail();
			const parsed = draft(fields.draft);
			expected = {
				method: "POST",
				url: `${ORIGIN}/v1/responses`,
				body: canonicalize({
					model: parsed.model,
					instructions: parsed.system,
					input: [{ role: "user", content: parsed.prompt }],
					text: { format: { type: "json_schema", name: "draft_output", strict: true, schema } },
					...(fields.effort === undefined ? {} : { reasoning: { effort: fields.effort } }),
					stream: true,
					store: false,
				}),
			};
		} else if (tag.operation === "ai_models_list" || tag.operation === "ai_probe") {
			const fields = record(
				input,
				["operation", "origin"],
				tag.operation === "ai_probe" ? ["model"] : [],
			);
			const selected = Object.hasOwn(fields, "model") ? model(fields.model) : undefined;
			if (selected === "." || selected === "..") fail();
			// The API-key client keeps RFC 3986 path characters literal and percent-encodes the rest.
			const segment =
				selected === undefined
					? ""
					: `/${selected.replace(/[^A-Za-z0-9\-._~!$&'()*+,;=:@]/gu, encodeURIComponent)}`;
			expected = {
				method: "GET",
				url: `${ORIGIN}/v1/models${segment}`,
			};
		} else fail();
		const identity = Object.freeze(Object.create(null)) as ResponsesHttpBinding;
		bindings.set(identity, Object.freeze(expected));
		return Object.freeze({ ok: true, binding: identity });
	} catch {
		return refusal;
	}
}

/** Pure field/value comparison only; success never replaces native broker authority or policy. */
export function checkResponsesHttpRequest(
	request: ResponsesHttpRequest,
	binding: ResponsesHttpBinding,
): ResponsesHttpCheck {
	try {
		if (binding === null || typeof binding !== "object") fail();
		const expected = bindings.get(binding);
		if (!expected) fail();
		const fields = record(request, ["method", "url", "headers", "body"]);
		if (
			fields.method !== expected.method ||
			typeof fields.url !== "string" ||
			fields.url.length > 4096 ||
			fields.url !== expected.url
		)
			fail();
		const headers = new Map<string, string>();
		for (const entry of vector(fields.headers, 3)) {
			const pair = vector(entry, 2);
			if (pair.length !== 2 || typeof pair[0] !== "string" || typeof pair[1] !== "string") fail();
			if (pair[0].length > 64 || pair[1].length > 64) fail();
			const name = pair[0].toLowerCase();
			if (headers.has(name)) fail();
			headers.set(name, pair[1]);
		}
		const required: Readonly<Record<string, string>> =
			expected.method === "POST"
				? { "content-type": "application/json", authorization: "Bearer brokered" }
				: { accept: "application/json", authorization: "Bearer brokered" };
		for (const [name, value] of Object.entries(required)) if (headers.get(name) !== value) fail();
		for (const [name, value] of headers)
			if (
				!(Object.hasOwn(required, name) && required[name] === value) &&
				!(expected.method === "POST" && name === "accept" && value === "application/json")
			)
				fail();
		const body = bytes(fields.body);
		if (expected.method === "GET") {
			if (body.length !== 0) fail();
		} else if (body.length === 0 || canonicalize(parseStrict(body)) !== expected.body) fail();
		return pass;
	} catch {
		return refusal;
	}
}
