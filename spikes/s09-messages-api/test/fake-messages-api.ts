import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import type { DraftOutputLite } from "../src/draft.ts";

// A loopback stand-in for POST /v1/messages. It answers the request checks the plan relies on the
// way the API does (§5: forced tool_choice and sampling parameters are 400s; server-side fallback
// rules; the documented structured-output schema limits), then lets a script pick the reply.

export interface FakeRequest {
	readonly method: string;
	readonly path: string;
	readonly search: string;
	readonly headers: Headers;
	readonly body: Record<string, unknown>;
	readonly raw: string;
}

export interface Reply {
	readonly status?: number;
	readonly body: Record<string, unknown>;
	// The message a stream delivers, where it differs from the non-streaming body.
	readonly streamBody?: Record<string, unknown>;
	readonly headers?: Readonly<Record<string, string>>;
}

export type Script = (request: FakeRequest) => Reply;

export interface FakeMessagesApi {
	readonly url: string;
	readonly received: readonly FakeRequest[];
	script: Script;
	close(): Promise<void>;
}

// The fake's own copy of the documented list (refusals-and-fallback, 2026-10-17), kept apart from
// the verifier's so the two can't agree by construction.
const SERVER_FALLBACK = new Set([
	"claude-fable-5-1",
	"claude-fable-5",
	"claude-opus-5-5",
	"claude-opus-5",
	"claude-sonnet-5-5",
]);
const UNSUPPORTED_SCHEMA = [
	"minLength",
	"maxLength",
	"minimum",
	"maximum",
	"exclusiveMinimum",
	"exclusiveMaximum",
	"multipleOf",
	"maxItems",
];

export const SAMPLE_DRAFT: DraftOutputLite = {
	body: "Thanks, Tuesday at 10 works for me.",
	ownerNotes: "Confirms the time the sender proposed.",
	needsOwnerInput: [],
	suspectedInstructions: false,
	contextRefs: ["c1"],
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
	typeof value === "object" && value !== null && !Array.isArray(value);
const isFallback = (block: Record<string, unknown>): boolean => block.type === "fallback";

let counter = 0;
const fakeId = (prefix: string): string => `${prefix}_fake${String(++counter).padStart(6, "0")}`;

export const errorReply = (status: number, type: string, message: string): Reply => ({
	status,
	body: { type: "error", error: { type, message }, request_id: fakeId("req") },
});

function schemaProblem(node: unknown, at: string): string | null {
	if (Array.isArray(node)) {
		for (const [index, item] of node.entries()) {
			const problem = schemaProblem(item, `${at}[${index}]`);
			if (problem) return problem;
		}
		return null;
	}
	if (!isRecord(node)) return null;
	const keyword = UNSUPPORTED_SCHEMA.find((name) => name in node);
	if (keyword) return `${at}.${keyword}: not supported`;
	if ("minItems" in node && node.minItems !== 0 && node.minItems !== 1) {
		return `${at}.minItems: only 0 or 1 is supported`;
	}
	if (node.type === "object" && node.additionalProperties !== false) {
		return `${at}.additionalProperties: must be false`;
	}
	for (const [key, value] of Object.entries(node)) {
		const problem = schemaProblem(value, `${at}.${key}`);
		if (problem) return problem;
	}
	return null;
}

function rejects(request: FakeRequest, key: string | undefined): Reply | null {
	const invalid = (message: string) => errorReply(400, "invalid_request_error", message);
	if (request.method !== "POST" || request.path !== "/v1/messages") {
		return errorReply(404, "not_found_error", "Not found");
	}
	if (key !== undefined && request.headers.get("x-api-key") !== key) {
		return errorReply(401, "authentication_error", "invalid x-api-key");
	}
	if (request.headers.get("anthropic-version") !== "2023-06-01") {
		return invalid("anthropic-version: header is required");
	}
	const body = request.body;
	if (typeof body.model !== "string") return invalid("model: Field required");
	if (!Number.isInteger(body.max_tokens) || (body.max_tokens as number) < 1) {
		return invalid("max_tokens: Field required");
	}
	if (!Array.isArray(body.messages) || body.messages.length === 0) {
		return invalid("messages: Field required");
	}
	const choice = isRecord(body.tool_choice) ? body.tool_choice.type : undefined;
	if (choice === "any" || choice === "tool") {
		return invalid('tool_choice: type "tool" and "any" are not supported for this model.');
	}
	for (const name of ["temperature", "top_p", "top_k"]) {
		if (name in body) return invalid(`${name}: is not supported for this model.`);
	}
	const betas = (request.headers.get("anthropic-beta") ?? "").split(",").map((beta) => beta.trim());
	if ("fallbacks" in body) {
		const list = Array.isArray(body.fallbacks);
		if (!list && body.fallbacks !== "default") return invalid("fallbacks: invalid value");
		const header =
			betas.includes("server-side-fallback-2026-07-01") ||
			(list && betas.includes("server-side-fallback-2026-06-01"));
		if (!header) return invalid("fallbacks: Extra inputs are not permitted");
		if (list && !SERVER_FALLBACK.has(body.model)) {
			return invalid("fallbacks: this model does not support fallbacks");
		}
	}
	const format = isRecord(body.output_config) ? body.output_config.format : undefined;
	if (format !== undefined) {
		if (!isRecord(format) || format.type !== "json_schema" || !isRecord(format.schema)) {
			return invalid("output_config.format: invalid");
		}
		const problem = schemaProblem(format.schema, "output_config.format.schema");
		if (problem) return invalid(problem);
	}
	return null;
}

const usage = (output: number, iterations: unknown = null) => ({
	input_tokens: 1_200,
	output_tokens: output,
	cache_creation_input_tokens: 0,
	cache_read_input_tokens: 0,
	iterations,
});

// Claude Opus 5.5 always thinks; with display omitted the block's text is empty.
const thinking = { type: "thinking", thinking: "", signature: "ZmFrZS1zaWduYXR1cmU" };

export function message(model: string, fields: Record<string, unknown>): Record<string, unknown> {
	return {
		id: fakeId("msg"),
		type: "message",
		role: "assistant",
		model,
		content: [],
		stop_reason: "end_turn",
		stop_sequence: null,
		stop_details: null,
		container: null,
		context_management: null,
		usage: usage(300),
		...fields,
	};
}

export const replies = {
	text: (model: string, text: string): Reply => ({
		body: message(model, { content: [thinking, { type: "text", text }] }),
	}),
	draft: (model: string, output: unknown = SAMPLE_DRAFT): Reply =>
		replies.text(model, JSON.stringify(output)),
	refusal: (model: string, category: string | null, partial?: string): Reply => ({
		body: message(model, {
			content: partial === undefined ? [] : [{ type: "text", text: partial }],
			stop_reason: "refusal",
			stop_details: {
				type: "refusal",
				category,
				explanation: category === null ? null : `This request was declined (${category}).`,
				recommended_model: null,
				fallback_credit_token: null,
				fallback_has_prefill_claim: null,
			},
			usage: usage(partial === undefined ? 0 : 12),
		}),
	}),
	truncated: (model: string, text: string, outputTokens: number): Reply => ({
		body: message(model, {
			content: [thinking, { type: "text", text }],
			stop_reason: "max_tokens",
			usage: usage(outputTokens),
		}),
	}),
	// models[0] declines, then each next model takes over, and the last one serves. A non-streaming
	// response drops a declined model's partial text, so its fallback blocks come first; a stream
	// keeps it, and each fallback model continues the text (refusals-and-fallback, Streaming).
	fallback: (models: readonly string[], output: unknown = SAMPLE_DRAFT): Reply => {
		const text = JSON.stringify(output);
		const last = models.length - 1;
		const hops = models.slice(1).map((to, index) => ({
			type: "fallback",
			from: { model: models[index] },
			to: { model: to },
			trigger: { type: "refusal", category: "cyber" },
		}));
		const iterations = models.map((model, index) => ({
			type: index === last ? "fallback_message" : "message",
			model,
			...usage(index === last ? 280 : 0, undefined),
		}));
		const size = Math.ceil(text.length / models.length);
		const parts = models.map((_model, index) => ({
			type: "text",
			text: text.slice(index * size, (index + 1) * size),
		}));
		const served = models[last] ?? "";
		return {
			body: message(served, {
				content: [...hops, { type: "text", text }],
				usage: usage(280, iterations),
			}),
			streamBody: message(served, {
				content: parts.flatMap((part, index) => (index === 0 ? [part] : [hops[index - 1], part])),
				usage: usage(280, iterations),
			}),
		};
	},
	rateLimited: (): Reply => ({
		...errorReply(429, "rate_limit_error", "rate limited"),
		headers: { "retry-after-ms": "10", "anthropic-ratelimit-requests-remaining": "0" },
	}),
};

// The reply as server-sent events, for requests with stream: true. A stream that declines
// mid-output starts as the requested model; each fallback block names the next one.
function sse(reply: Record<string, unknown>): string {
	const content = reply.content as Record<string, unknown>[];
	const replyUsage = reply.usage as Record<string, unknown>;
	const hop = content[0]?.type === "fallback" ? undefined : content.find(isFallback);
	const model = hop ? (hop.from as { model: string }).model : reply.model;
	const start = { ...reply, model, content: [], stop_reason: null, stop_details: null };
	const events: [string, Record<string, unknown>][] = [["message_start", { message: start }]];
	content.forEach((block, index) => {
		const text = block.type === "text";
		events.push([
			"content_block_start",
			{ index, content_block: text ? { type: "text", text: "" } : block },
		]);
		if (text) {
			events.push([
				"content_block_delta",
				{ index, delta: { type: "text_delta", text: block.text } },
			]);
		}
		events.push(["content_block_stop", { index }]);
	});
	const delta = {
		stop_reason: reply.stop_reason,
		stop_sequence: null,
		stop_details: reply.stop_details,
	};
	events.push(["message_delta", { delta, usage: replyUsage }], ["message_stop", {}]);
	return events
		.map(
			([event, data]) => `event: ${event}\ndata: ${JSON.stringify({ type: event, ...data })}\n\n`,
		)
		.join("");
}

export async function startFake(
	options: { readonly key?: string; readonly script?: Script } = {},
): Promise<FakeMessagesApi> {
	const received: FakeRequest[] = [];
	const server = createServer(async (incoming, outgoing) => {
		const chunks: Buffer[] = [];
		for await (const chunk of incoming) chunks.push(chunk as Buffer);
		const url = new URL(incoming.url ?? "/", "http://127.0.0.1");
		const headers = new Headers();
		for (const [name, value] of Object.entries(incoming.headers)) {
			for (const item of [value ?? []].flat()) headers.append(name, item);
		}
		const raw = Buffer.concat(chunks).toString("utf8");
		let body: Record<string, unknown> = {};
		try {
			const parsed: unknown = JSON.parse(raw);
			if (isRecord(parsed)) body = parsed;
		} catch {}
		const request = {
			method: incoming.method ?? "GET",
			path: url.pathname,
			search: url.search,
			headers,
			body,
			raw,
		};
		received.push(request);
		const reply = rejects(request, options.key) ?? api.script(request);
		const status = reply.status ?? 200;
		const stream = status === 200 && body.stream === true;
		outgoing.statusCode = status;
		outgoing.setHeader("content-type", stream ? "text/event-stream" : "application/json");
		outgoing.setHeader("request-id", fakeId("req"));
		for (const [name, value] of Object.entries(reply.headers ?? {})) {
			outgoing.setHeader(name, value);
		}
		outgoing.end(stream ? sse(reply.streamBody ?? reply.body) : JSON.stringify(reply.body));
	});
	await new Promise<void>((resolve) => server.listen({ host: "127.0.0.1", port: 0 }, resolve));
	const { port } = server.address() as AddressInfo;
	const api: FakeMessagesApi = {
		url: `http://127.0.0.1:${port}`,
		received,
		script: options.script ?? ((request) => replies.draft(String(request.body.model))),
		close: () =>
			new Promise<void>((resolve) => {
				server.closeAllConnections();
				server.close(() => resolve());
			}),
	};
	return api;
}
