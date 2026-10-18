import { randomBytes } from "node:crypto";
import type { Access } from "./fake-auth.ts";
import { json, type Served, serve } from "./serve.ts";

// A loopback stand-in for POST /v1/responses and GET /v1/models under ChatGPT plan usage, from the
// public docs (notes/sources.md). It refuses every body field outside plan §4's SIWC allowlist,
// the documented unsupported fields with subscription_sharing_unsupported_capability, then lets a
// script pick the reply: an SSE stream, a stream that breaks off, or an error status.

const PLAN = "chatgpt.tokens.use.direct";
// The fake's own copy of the allowlist and of the docs' unsupported list.
export const ALLOWED: readonly string[] = [
	"model",
	"instructions",
	"input",
	"tools",
	"tool_choice",
	"text",
	"reasoning",
	"stream",
	"store",
];
export const DOCUMENTED_UNSUPPORTED: readonly string[] = [
	"background",
	"conversation",
	"max_output_tokens",
	"max_tool_calls",
	"metadata",
	"moderation",
	"multi_agent",
	"prompt",
	"prompt_cache_retention",
	"safety_identifier",
	"temperature",
	"top_logprobs",
	"top_p",
	"truncation",
	"user",
];
export const MODELS: readonly Readonly<Record<string, string>>[] = [
	{ slug: "gpt-fake-plan", display_name: "Fake Plan Model", visibility: "list" },
	{ slug: "gpt-fake-hidden", display_name: "Hidden", visibility: "hide" },
];
const UNSUPPORTED_TOOLS = new Set([
	"image_generation",
	"file_search",
	"code_interpreter",
	"computer",
	"computer_use_preview",
	"mcp",
	"tool_search",
	"programmatic_tool_calling",
]);
const COMPOSITION = ["allOf", "not", "dependentRequired", "dependentSchemas", "if", "then", "else"];

export type SseEvent = Record<string, unknown> & { readonly type: string };

export type Reply =
	| {
			readonly kind: "events";
			readonly events: readonly SseEvent[];
			// Bytes sent before the connection drops, with no terminal event.
			readonly cutAfter?: number;
			readonly crlf?: boolean;
			// data: lines only, so the SDK hands every event to the caller, an error event too.
			readonly dataOnly?: boolean;
	  }
	| {
			readonly kind: "status";
			readonly status: number;
			readonly body?: unknown;
			readonly headers?: Readonly<Record<string, string>>;
	  };

export interface Received {
	readonly method: string;
	readonly path: string;
	readonly headers: Headers;
	readonly body: Record<string, unknown>;
	// The body as sent, before the fake's own JSON.parse.
	readonly raw: string;
}

export interface FakeResponses extends Served {
	readonly received: Received[];
	readonly problems: string[];
	topLevelFunctions: "reject" | "accept";
	script: (request: Received) => Reply;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
	typeof value === "object" && value !== null && !Array.isArray(value);
export const requestId = (): string => `req_${randomBytes(12).toString("hex")}`;

export const structured = (status: number, code: string, param: string | null = null): Reply => ({
	kind: "status",
	status,
	body: { error: { message: `fake ${code}`, type: "invalid_request_error", param, code } },
	headers: { "x-request-id": requestId() },
});
export const admission = (status: number): Reply => ({
	kind: "status",
	status,
	body: { detail: "fake direct admission refusal" },
	headers: { "x-request-id": requestId() },
});

// Strict structured outputs (Supported schemas): an object root, additionalProperties false and
// every property required on each object, no composition keywords.
export function strictProblem(schema: unknown, at: string): string | undefined {
	if (Array.isArray(schema)) {
		for (const [index, item] of schema.entries()) {
			const found = strictProblem(item, `${at}[${index}]`);
			if (found) return found;
		}
		return undefined;
	}
	if (!isRecord(schema)) return undefined;
	const keyword = COMPOSITION.find((name) => name in schema);
	if (keyword) return `${at}.${keyword}`;
	if (schema.type === "object") {
		const properties = isRecord(schema.properties) ? Object.keys(schema.properties) : [];
		const required = Array.isArray(schema.required) ? schema.required : [];
		if (schema.additionalProperties !== false) return `${at}.additionalProperties`;
		if (properties.some((name) => !required.includes(name))) return `${at}.required`;
	}
	for (const [key, value] of Object.entries(schema)) {
		const found = strictProblem(value, `${at}.${key}`);
		if (found) return found;
	}
	return undefined;
}

function functionProblem(tool: unknown, at: string): string | undefined {
	if (!isRecord(tool) || tool.type !== "function" || typeof tool.name !== "string")
		return `${at}.type`;
	if (tool.strict === true) return strictProblem(tool.parameters, `${at}.parameters`);
	return undefined;
}

function toolProblem(
	tool: unknown,
	at: string,
	topLevel: boolean,
	accept: boolean,
): string | undefined {
	if (!isRecord(tool)) return at;
	if (typeof tool.type === "string" && UNSUPPORTED_TOOLS.has(tool.type)) return `${at}.type`;
	if (tool.type === "namespace") {
		const tools = Array.isArray(tool.tools) ? tool.tools : [];
		if (typeof tool.name !== "string" || tools.length === 0) return at;
		for (const [index, inner] of tools.entries()) {
			const found = functionProblem(inner, `${at}.tools[${index}]`);
			if (found) return found;
		}
		return undefined;
	}
	if (tool.type === "function" && topLevel && !accept) return at;
	return functionProblem(tool, at);
}

// The 400 a body earns, or undefined. Field names are checked first: the fake rejects every key
// outside the allowlist, so a request that passes carries nothing else.
function bodyProblem(body: Record<string, unknown>, fake: FakeResponses): Reply | undefined {
	const unsupported = (param: string): Reply => {
		fake.problems.push(param);
		return structured(400, "subscription_sharing_unsupported_capability", param);
	};
	for (const key of Object.keys(body)) if (!ALLOWED.includes(key)) return unsupported(key);
	if (body.store !== false) return unsupported("store");
	if (body.stream !== true) return unsupported("stream");
	if (!MODELS.some((model) => model.slug === body.model)) return unsupported("model");
	const input = Array.isArray(body.input) ? body.input : [];
	if (input.length === 0) return unsupported("input");
	for (const [index, item] of input.entries()) {
		const at = `input[${index}]`;
		if (!isRecord(item)) return unsupported(at);
		if (item.type === "additional_tools") {
			const tools = Array.isArray(item.tools) ? item.tools : [];
			if (item.role !== "developer" || tools.length === 0) return unsupported(at);
			for (const [inner, tool] of tools.entries()) {
				const found = toolProblem(tool, `${at}.tools[${inner}]`, false, true);
				if (found) return unsupported(found);
			}
		} else if (item.type === "message" || item.type === undefined) {
			if (item.role === "system") return unsupported(`${at}.role`);
			if (!["user", "assistant", "developer"].includes(String(item.role))) return unsupported(at);
		} else {
			return unsupported(`${at}.type`);
		}
	}
	const tools = Array.isArray(body.tools) ? body.tools : [];
	for (const [index, tool] of tools.entries()) {
		const found = toolProblem(tool, `tools[${index}]`, true, fake.topLevelFunctions === "accept");
		if (found) return unsupported(found);
	}
	const format = isRecord(body.text) ? body.text.format : undefined;
	if (isRecord(format) && format.type === "json_schema" && format.strict === true) {
		const found = strictProblem(format.schema, "text.format.schema");
		if (found) return unsupported(found);
	}
	return undefined;
}

// The wire format: `event:` and `data:` lines, sequence numbers added in order.
export function sse(events: readonly SseEvent[], crlf = false, dataOnly = false): string {
	const text = events
		.map((event, index) => {
			const data = JSON.stringify({ ...event, sequence_number: index + 1 });
			return `${dataOnly ? "" : `event: ${event.type}\n`}data: ${data}\n\n`;
		})
		.join("");
	return crlf ? text.replaceAll("\n", "\r\n") : text;
}

export async function startFakeResponses(
	access: ReadonlyMap<string, Access>,
	script: (request: Received) => Reply,
): Promise<FakeResponses> {
	const fake: FakeResponses = {
		url: "",
		close: async () => {},
		received: [],
		problems: [],
		topLevelFunctions: "reject",
		script,
	};
	const served = await serve(async (request) => {
		const url = new URL(request.url);
		const raw = await request.text();
		let body: Record<string, unknown> = {};
		try {
			const parsed: unknown = JSON.parse(raw);
			if (isRecord(parsed)) body = parsed;
		} catch {}
		const { method, headers } = request;
		const received = { method, path: url.pathname, headers, body, raw };
		fake.received.push(received);
		const route = `${request.method} ${url.pathname}`;
		if (route !== "POST /v1/responses" && route !== "GET /v1/models") {
			return reply(structured(403, "subscription_sharing_route_not_supported"));
		}
		const bearer = /^Bearer (\S+)$/.exec(request.headers.get("authorization") ?? "")?.[1];
		const grant = bearer === undefined ? undefined : access.get(bearer);
		if (!grant || grant.family.revoked || grant.expiresAt <= Date.now())
			return reply(admission(401));
		if (!grant.scopes.includes(PLAN))
			return reply(structured(403, "chatpass_v2_scope_not_authorized"));
		if (route === "GET /v1/models") return json(200, { models: MODELS });
		return reply(bodyProblem(body, fake) ?? fake.script(received));
	});
	return Object.assign(fake, { url: served.url, close: served.close });
}

function reply(answer: Reply): Response {
	if (answer.kind === "status") {
		const body = answer.body === undefined ? null : JSON.stringify(answer.body);
		return new Response(body, {
			status: answer.status,
			headers: { "content-type": "application/json", ...answer.headers },
		});
	}
	const bytes = Buffer.from(sse(answer.events, answer.crlf, answer.dataOnly));
	const cut = answer.cutAfter;
	let sent = false;
	const stream = new ReadableStream<Uint8Array>({
		pull(controller) {
			if (sent) {
				controller.error(new Error("connection dropped"));
				return;
			}
			sent = true;
			controller.enqueue(new Uint8Array(cut === undefined ? bytes : bytes.subarray(0, cut)));
			if (cut === undefined) controller.close();
		},
	});
	return new Response(stream, {
		status: 200,
		headers: { "content-type": "text/event-stream; charset=utf-8", "x-request-id": requestId() },
	});
}

// Event sequences as the streaming reference shows them.
let counter = 0;
const id = (prefix: string): string => `${prefix}_fake${String(++counter).padStart(6, "0")}`;

function response(
	model: string,
	status: string,
	output: unknown[],
	extra = {},
): Record<string, unknown> {
	return {
		id: id("resp"),
		object: "response",
		created_at: 1_790_032_532,
		status,
		error: null,
		incomplete_details: null,
		model,
		output,
		store: false,
		usage: null,
		...extra,
	};
}

// Text cut into deltas that split multi-byte characters' strings (the bytes split in the frames).
export function pieces(text: string, size = 5): string[] {
	const parts: string[] = [];
	const characters = [...text];
	for (let at = 0; at < characters.length; at += size) {
		parts.push(characters.slice(at, at + size).join(""));
	}
	return parts;
}

export function textEvents(model: string, text: string): SseEvent[] {
	const item = id("msg");
	const done = { type: "output_text", text, annotations: [], logprobs: [] };
	const message = {
		id: item,
		type: "message",
		role: "assistant",
		status: "completed",
		content: [done],
	};
	return [
		{ type: "response.created", response: response(model, "in_progress", []) },
		{ type: "response.in_progress", response: response(model, "in_progress", []) },
		{
			type: "response.output_item.added",
			output_index: 0,
			item: { ...message, status: "in_progress", content: [] },
		},
		{
			type: "response.content_part.added",
			item_id: item,
			output_index: 0,
			content_index: 0,
			part: { ...done, text: "" },
		},
		...pieces(text).map((delta) => ({
			type: "response.output_text.delta",
			item_id: item,
			output_index: 0,
			content_index: 0,
			delta,
			logprobs: [],
		})),
		{
			type: "response.output_text.done",
			item_id: item,
			output_index: 0,
			content_index: 0,
			text,
			logprobs: [],
		},
		{
			type: "response.content_part.done",
			item_id: item,
			output_index: 0,
			content_index: 0,
			part: done,
		},
		{ type: "response.output_item.done", output_index: 0, item: message },
		{ type: "response.completed", response: response(model, "completed", [message]) },
	];
}

export function toolEvents(
	model: string,
	args: string,
	namespace?: string,
	name = "submit_draft",
): SseEvent[] {
	const item = id("fc");
	const call = {
		id: item,
		type: "function_call",
		status: "completed",
		call_id: id("call"),
		name,
		...(namespace === undefined ? {} : { namespace }),
		arguments: args,
	};
	return [
		{ type: "response.created", response: response(model, "in_progress", []) },
		{
			type: "response.output_item.added",
			output_index: 0,
			item: { ...call, status: "in_progress", arguments: "" },
		},
		...pieces(args, 7).map((delta) => ({
			type: "response.function_call_arguments.delta",
			item_id: item,
			output_index: 0,
			delta,
		})),
		{
			type: "response.function_call_arguments.done",
			item_id: item,
			output_index: 0,
			arguments: args,
		},
		{ type: "response.output_item.done", output_index: 0, item: call },
		{ type: "response.completed", response: response(model, "completed", [call]) },
	];
}

export function refusalEvents(model: string): SseEvent[] {
	const item = id("msg");
	const refusal = { type: "refusal", refusal: "I can't help with that." };
	const message = {
		id: item,
		type: "message",
		role: "assistant",
		status: "completed",
		content: [refusal],
	};
	return [
		{ type: "response.created", response: response(model, "in_progress", []) },
		{ type: "response.output_item.added", output_index: 0, item: { ...message, content: [] } },
		{
			type: "response.refusal.delta",
			item_id: item,
			output_index: 0,
			content_index: 0,
			delta: "I can't",
		},
		{
			type: "response.refusal.done",
			item_id: item,
			output_index: 0,
			content_index: 0,
			refusal: refusal.refusal,
		},
		{ type: "response.output_item.done", output_index: 0, item: message },
		{ type: "response.completed", response: response(model, "completed", [message]) },
	];
}

export function incompleteEvents(model: string, reason: string): SseEvent[] {
	const details = { incomplete_details: { reason } };
	return [
		{ type: "response.created", response: response(model, "in_progress", []) },
		{ type: "response.incomplete", response: response(model, "incomplete", [], details) },
	];
}

// A usage limit after streaming began (Models and inference, step 3).
export function failedEvents(model: string, code: string): SseEvent[] {
	const error = { code, message: `fake ${code}` };
	return [
		...textEvents(model, "Partial").slice(0, 5),
		{ type: "response.failed", response: response(model, "failed", [], { error }) },
	];
}

export function errorEvents(model: string, code: string, param: string | null = null): SseEvent[] {
	return [
		{ type: "response.created", response: response(model, "in_progress", []) },
		{ type: "error", code, message: `fake ${code}`, param },
	];
}
