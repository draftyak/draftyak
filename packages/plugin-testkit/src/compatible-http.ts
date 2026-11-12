import { types } from "node:util";
import { aiProviderV1, type DraftRequest, ModelId } from "@draftyak/protocol/ai-provider-v1";
import { DraftOutputV1 } from "@draftyak/protocol/draft-output";
import { exportedSchema } from "@draftyak/protocol/extension";
import type { HeaderList } from "@draftyak/protocol/hash";
import { canonicalize, parseStrict } from "@draftyak/protocol/jcs";

export interface CompatibleHttpConfig {
	readonly endpoint: string;
	readonly model: string;
	readonly format: "json_schema" | "json_object" | "ollama";
}
export type CompatibleHttpBindingInput =
	| {
			readonly operation: "ai_draft_generate";
			readonly config: CompatibleHttpConfig;
			readonly draft: DraftRequest;
	  }
	| { readonly operation: "ai_models_list" | "ai_probe"; readonly config: CompatibleHttpConfig };
declare const identity: unique symbol;
/** Constructor-issued fixture comparison identity; never native egress or credential authority. */
export interface CompatibleHttpBinding {
	readonly [identity]: true;
}
export interface CompatibleHttpRequest {
	readonly method: string;
	readonly url: string;
	readonly headers: HeaderList;
	readonly body: Uint8Array;
}
type Refusal = { readonly ok: false; readonly code: "COMPATIBLE_HTTP_REQUEST_REFUSED" };
export type CompatibleHttpCheck = { readonly ok: true } | Refusal;
export type CompatibleHttpBindingResult =
	| { readonly ok: true; readonly binding: CompatibleHttpBinding }
	| Refusal;
interface Expected {
	readonly method: "GET" | "POST";
	readonly url: string;
	readonly body?: string;
}
const MAX_BODY_BYTES = 8_388_608;
const expectations = new WeakMap<CompatibleHttpBinding, Expected>();
const pass = Object.freeze({ ok: true } as const);
const refusal = Object.freeze({ ok: false, code: "COMPATIBLE_HTTP_REQUEST_REFUSED" } as const);
const typedArray = Object.getPrototypeOf(Uint8Array.prototype);
const bufferSlot = Object.getOwnPropertyDescriptor(typedArray, "buffer")?.get;
const offsetSlot = Object.getOwnPropertyDescriptor(typedArray, "byteOffset")?.get;
const lengthSlot = Object.getOwnPropertyDescriptor(typedArray, "byteLength")?.get;

function fail(): never {
	throw new Error("Compatible HTTP fixture binding refused");
}
function record(
	input: unknown,
	required: readonly string[],
	optional: readonly string[] = [],
): Record<string, unknown> {
	if (
		!input ||
		typeof input !== "object" ||
		types.isProxy(input) ||
		![Object.prototype, null].includes(Object.getPrototypeOf(input))
	)
		fail();
	const names = Reflect.ownKeys(input);
	if (names.length > required.length + optional.length) fail();
	const result: Record<string, unknown> = Object.create(null);
	for (const name of names) {
		if (typeof name !== "string" || (!required.includes(name) && !optional.includes(name))) fail();
		const slot = Object.getOwnPropertyDescriptor(input, name);
		if (!slot?.enumerable || !Object.hasOwn(slot, "value")) fail();
		result[name] = slot.value;
	}
	if (required.some((name) => !Object.hasOwn(result, name))) fail();
	return result;
}
function vector(input: unknown, maximum: number): unknown[] {
	if (
		types.isProxy(input) ||
		!Array.isArray(input) ||
		Object.getPrototypeOf(input) !== Array.prototype
	)
		fail();
	const length: unknown = Object.getOwnPropertyDescriptor(input, "length")?.value;
	if (
		typeof length !== "number" ||
		!Number.isSafeInteger(length) ||
		length < 0 ||
		length > maximum ||
		Reflect.ownKeys(input).length !== length + 1
	)
		fail();
	const result: unknown[] = [];
	for (let i = 0; i < length; i++) {
		const slot = Object.getOwnPropertyDescriptor(input, String(i));
		if (!slot?.enumerable || !Object.hasOwn(slot, "value")) fail();
		result.push(slot.value);
	}
	return result;
}
function configuration(input: unknown): CompatibleHttpConfig {
	const value = record(input, ["endpoint", "model", "format"]);
	if (
		typeof value.endpoint !== "string" ||
		value.endpoint.length > 2048 ||
		!value.endpoint.isWellFormed() ||
		typeof value.model !== "string" ||
		!ModelId.safeParse(value.model).success ||
		(value.format !== "json_schema" && value.format !== "json_object" && value.format !== "ollama")
	)
		fail();
	const url = new URL(value.endpoint);
	const suffix = value.format === "ollama" ? "/api/chat" : "/v1/chat/completions";
	if (
		(url.protocol !== "http:" && url.protocol !== "https:") ||
		url.href !== value.endpoint ||
		value.endpoint !== `${url.origin}${suffix}` ||
		url.username ||
		url.password ||
		url.search ||
		url.hash
	)
		fail();
	return Object.freeze({ endpoint: value.endpoint, model: value.model, format: value.format });
}
function draftInput(input: unknown, config: CompatibleHttpConfig): DraftRequest {
	const value = record(input, ["model", "system", "prompt", "contextIds"]);
	if (
		typeof value.model !== "string" ||
		typeof value.system !== "string" ||
		typeof value.prompt !== "string"
	)
		fail();
	const contextIds = vector(value.contextIds, 3);
	if (!contextIds.every((id) => id === "c1" || id === "c2" || id === "c3")) fail();
	const parsed = aiProviderV1.tools.ai_draft_generate.input.safeParse({
		model: value.model,
		system: value.system,
		prompt: value.prompt,
		contextIds,
	});
	if (!parsed.success || parsed.data.model !== config.model) fail();
	return Object.freeze({ ...parsed.data, contextIds: Object.freeze([...parsed.data.contextIds]) });
}

/** Copy trusted fixture DATA immediately, before another constructor option can run a hook. */
export function snapshotCompatibleHttpInput(input: unknown): CompatibleHttpBindingInput {
	try {
		const value = record(input, ["operation", "config"], ["draft"]);
		const config = configuration(value.config);
		if (value.operation === "ai_draft_generate") {
			if (!Object.hasOwn(value, "draft")) fail();
			return Object.freeze({
				operation: value.operation,
				config,
				draft: draftInput(value.draft, config),
			});
		}
		if (
			(value.operation !== "ai_models_list" && value.operation !== "ai_probe") ||
			Object.hasOwn(value, "draft")
		)
			fail();
		return Object.freeze({ operation: value.operation, config });
	} catch {
		return fail();
	}
}

const omittedSchemaKeys = new Set([
	"$id",
	"$schema",
	"maxLength",
	"minLength",
	"maxItems",
	"minItems",
	"uniqueItems",
]);
function stripSchema(input: unknown): unknown {
	if (Array.isArray(input)) return input.map(stripSchema);
	if (input === null || typeof input !== "object") return input;
	return Object.fromEntries(
		Object.entries(input)
			.filter(([name]) => !omittedSchemaKeys.has(name))
			.map(([name, value]) => [name, stripSchema(value)]),
	);
}
const outputSchema = stripSchema(
	exportedSchema("schemas/draft-output-v1.schema.json", DraftOutputV1),
);
const probeSystem =
	"Return exactly one DraftOutputV1 JSON object with body, ownerNotes, needsOwnerInput, suspectedInstructions, and contextRefs.";
const probePrompt =
	'Return exactly {"body":"","ownerNotes":"","needsOwnerInput":[],"suspectedInstructions":false,"contextRefs":[]}.';
function expected(input: CompatibleHttpBindingInput): Expected {
	const { config } = input;
	if (input.operation === "ai_models_list") {
		return Object.freeze({
			method: "GET",
			url: `${new URL(config.endpoint).origin}${config.format === "ollama" ? "/api/tags" : "/v1/models"}`,
		});
	}
	const draft =
		input.operation === "ai_draft_generate"
			? input.draft
			: { model: config.model, system: probeSystem, prompt: probePrompt };
	const messages = [
		{ role: "system", content: draft.system },
		{ role: "user", content: draft.prompt },
	];
	const body = canonicalize(
		config.format === "ollama"
			? { model: config.model, messages, format: outputSchema, stream: false }
			: {
					model: config.model,
					messages,
					response_format:
						config.format === "json_object"
							? { type: "json_object" }
							: {
									type: "json_schema",
									json_schema: { name: "draft_output_v1", strict: true, schema: outputSchema },
								},
					stream: false,
				},
	);
	if (Buffer.byteLength(body) > MAX_BODY_BYTES) fail();
	return Object.freeze({ method: "POST", url: config.endpoint, body });
}
export function createCompatibleHttpBinding(
	input: CompatibleHttpBindingInput,
): CompatibleHttpBindingResult {
	try {
		const value = expected(snapshotCompatibleHttpInput(input));
		const binding = Object.freeze(Object.create(null)) as CompatibleHttpBinding;
		expectations.set(binding, value);
		return Object.freeze({ ok: true, binding });
	} catch {
		return refusal;
	}
}
function requestBytes(input: unknown): Uint8Array {
	if (
		types.isProxy(input) ||
		!types.isUint8Array(input) ||
		![Uint8Array.prototype, Buffer.prototype].includes(Object.getPrototypeOf(input))
	)
		fail();
	Uint8Array.prototype.values.call(input);
	const buffer: unknown = bufferSlot?.call(input);
	const offset: unknown = offsetSlot?.call(input);
	const length: unknown = lengthSlot?.call(input);
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
/** Compare the original request to captured fixture facts before any Fake sees the request. */
export function checkCompatibleHttpRequest(
	request: CompatibleHttpRequest,
	binding: CompatibleHttpBinding,
): CompatibleHttpCheck {
	try {
		if (!binding || typeof binding !== "object" || types.isProxy(binding)) fail();
		const held = expectations.get(binding);
		if (!held) fail();
		const fields = record(request, ["method", "url", "headers", "body"]);
		if (fields.method !== held.method || fields.url !== held.url) fail();
		const headers = vector(fields.headers, 1);
		if (held.method === "GET") {
			if (headers.length !== 0) fail();
		} else {
			if (headers.length !== 1) fail();
			const pair = vector(headers[0], 2);
			if (
				pair.length !== 2 ||
				typeof pair[0] !== "string" ||
				pair[0].toLowerCase() !== "content-type" ||
				pair[1] !== "application/json"
			)
				fail();
		}
		const body = requestBytes(fields.body);
		if (held.method === "GET") {
			if (body.byteLength !== 0) fail();
		} else if (body.byteLength === 0 || canonicalize(parseStrict(body)) !== held.body) fail();
		return pass;
	} catch {
		return refusal;
	}
}
