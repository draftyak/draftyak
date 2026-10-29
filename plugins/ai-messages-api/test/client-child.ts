import assert from "node:assert/strict";
import Anthropic from "@anthropic-ai/sdk";
import { z } from "zod";
import type { MessagesFetch, OutgoingRequest, Pin, Verdict } from "../src/index.ts";
import { canary, draft, input, message, pin } from "./helpers.ts";

const before = z.config().jitless;
await import("../src/request.ts");
assert.equal(z.config().jitless, before, "Verifier import changed global JIT configuration");
const {
	API_URL,
	buildRequest,
	createClient,
	draftCall,
	FALLBACK_BETA,
	PLATFORM_HEADERS,
	readDraft,
	verifyRequest,
} = await import("../src/index.ts");
assert.equal(z.config().jitless, before, "Package import changed global JIT configuration");
let networkCalls = 0;
globalThis.fetch = async () => {
	networkCalls++;
	throw Error("Unexpected test network request");
};

interface Recorded extends OutgoingRequest {
	readonly headers: Headers;
	readonly verdict: Verdict;
}
function completed(fields: Record<string, unknown> = {}): Record<string, unknown> {
	return {
		id: "msg_synthetic",
		type: "message",
		role: "assistant",
		stop_sequence: null,
		...message(fields),
	};
}
function streamReply(): Response {
	const events = [
		{
			type: "message_start",
			message: completed({
				content: [],
				stop_reason: null,
				usage: { input_tokens: 300, output_tokens: 0 },
			}),
		},
		{ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
		{
			type: "content_block_delta",
			index: 0,
			delta: { type: "text_delta", text: JSON.stringify(draft) },
		},
		{ type: "content_block_stop", index: 0 },
		{
			type: "message_delta",
			delta: { stop_reason: "end_turn", stop_sequence: null },
			usage: { output_tokens: 100 },
		},
		{ type: "message_stop" },
	];
	return new Response(
		events.map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(""),
		{
			headers: { "content-type": "text/event-stream" },
		},
	);
}
function recorder(
	respond: (request: Recorded, attempt: number) => Response = (request) =>
		(request.body as { stream?: boolean }).stream ? streamReply() : Response.json(completed()),
	instancePin: Pin = pin,
): { fetch: MessagesFetch; requests: Recorded[] } {
	const requests: Recorded[] = [];
	const fetch: MessagesFetch = async (target, init = {}) => {
		const url =
			typeof target === "string" ? target : target instanceof URL ? target.href : target.url;
		assert.equal(typeof init.body, "string", "Expected synthetic SDK JSON body");
		const request = {
			url,
			method: init.method ?? "GET",
			headers: new Headers(init.headers),
			body: JSON.parse(init.body as string) as unknown,
		};
		const recorded = { ...request, verdict: verifyRequest(request, instancePin) };
		requests.push(recorded);
		return recorded.verdict.ok
			? respond(recorded, requests.length)
			: Response.json(
					{
						type: "error",
						error: { type: "permission_error", message: "Synthetic request refused" },
					},
					{
						status: 403,
						headers: { "x-should-retry": "false" },
					},
				);
	};
	return { fetch, requests };
}

const mode = process.argv[2];
if (
	["parse", "beta.parse", "create", "beta.create", "stream", "beta.stream"].includes(mode ?? "")
) {
	const stub = recorder();
	const client = createClient(stub.fetch);
	const { params, headers } = draftCall(input);
	let result: unknown;
	switch (mode) {
		case "parse":
			result = await client.messages.parse(params, { headers });
			break;
		case "beta.parse":
			result = await client.beta.messages.parse(params, { headers });
			break;
		case "create":
			result = await client.messages.create(params, { headers });
			break;
		case "beta.create":
			result = await client.beta.messages.create(params, { headers });
			break;
		case "stream":
			result = await client.messages.stream(params, { headers }).finalMessage();
			break;
		case "beta.stream":
			result = await client.beta.messages.stream(params, { headers }).finalMessage();
			break;
	}
	assert.equal(readDraft(result, ["c1"]).kind, "draft");
	assert.equal(stub.requests.length, 1);
	const request = stub.requests[0];
	assert.ok(request?.verdict.ok);
	assert.equal(request.url, `${API_URL}${mode?.startsWith("beta.") ? "?beta=true" : ""}`);
	assert.equal(request.headers.get("user-agent"), "Anthropic/JS 0.135.0");
	assert.equal(request.headers.get("anthropic-beta"), FALLBACK_BETA);
	assert.equal(request.headers.get("x-stainless-retry-count"), "0");
	assert.equal(request.headers.get("x-stainless-timeout"), "600");
	for (const name of PLATFORM_HEADERS) assert.equal(request.headers.has(name), false);
	const body = request.body as Record<string, unknown>;
	if (mode?.includes("stream")) {
		assert.equal(body.stream, true);
		assert.equal(request.headers.get("x-stainless-helper-method"), "stream");
	} else assert.equal(Object.hasOwn(body, "stream"), false);
	assert.equal(body.system, input.system);
	assert.deepEqual(body.messages, [{ role: "user", content: input.prompt }]);
} else if (mode === "config") {
	let logs = 0;
	const levels = ["log", "debug", "info", "warn", "error"] as const;
	const originals = levels.map((level) => console[level]);
	try {
		for (const level of levels)
			console[level] = () => {
				logs++;
			};
		const stub = recorder();
		const client = createClient(stub.fetch);
		assert.equal(client.apiKey, "brokered");
		assert.equal(client.authToken, null);
		assert.equal(client.webhookKey, null);
		assert.equal(client.baseURL, new URL(API_URL).origin);
		assert.equal(client.logLevel, "off");
		assert.equal(client.openTelemetry.traces.enabled, false);
		assert.equal(client.openTelemetry.propagation, false);
		const { params, headers } = draftCall(input);
		await client.messages.parse(params, { headers });
		assert.equal(stub.requests[0]?.headers.get("x-api-key"), "brokered");
		assert.equal(stub.requests[0]?.headers.has("authorization"), false);
		assert.equal(
			JSON.stringify(stub.requests.map((request) => Object.fromEntries(request.headers))).includes(
				canary,
			),
			false,
		);
		assert.equal(logs, 0);
	} finally {
		for (const [index, level] of levels.entries())
			console[level] = originals[index] as typeof console.log;
	}
} else if (mode === "default-client") {
	const stub = recorder();
	const client = new Anthropic({
		fetch: stub.fetch,
		apiKey: "brokered",
		authToken: null,
		webhookKey: null,
		baseURL: new URL(API_URL).origin,
		logLevel: "off",
		openTelemetry: false,
	});
	const { params, headers } = draftCall(input);
	await assert.rejects(client.messages.parse(params, { headers }), Anthropic.PermissionDeniedError);
	assert.equal(stub.requests.length, 1);
	for (const name of PLATFORM_HEADERS) assert.equal(stub.requests[0]?.headers.has(name), true);
	assert.equal(stub.requests[0]?.verdict.ok, false);
} else if (mode === "retry") {
	const stub = recorder((_request, attempt) =>
		attempt === 1
			? Response.json(
					{ type: "error", error: { type: "rate_limit_error", message: "Synthetic retry" } },
					{ status: 429, headers: { "retry-after-ms": "1" } },
				)
			: Response.json(completed()),
	);
	const client = createClient(stub.fetch, { maxRetries: 1 });
	const { params, headers } = draftCall(input);
	await client.beta.messages.parse(params, { headers });
	assert.deepEqual(
		stub.requests.map((request) => request.headers.get("x-stainless-retry-count")),
		["0", "1"],
	);
	assert.equal(
		stub.requests.every((request) => request.verdict.ok),
		true,
	);
} else if (mode === "beta-drift") {
	const stub = recorder();
	const { params } = draftCall(input);
	await assert.rejects(
		createClient(stub.fetch).beta.messages.parse(params),
		Anthropic.PermissionDeniedError,
	);
	assert.deepEqual(stub.requests[0]?.verdict, { ok: false, problems: ["headers: refused"] });
} else if (mode === "custom-headers") {
	process.env.ANTHROPIC_CUSTOM_HEADERS = `x-draft-note: ${canary}`;
	const stub = recorder();
	const { params, headers } = draftCall(input);
	await assert.rejects(
		createClient(stub.fetch).messages.parse(params, { headers }),
		Anthropic.PermissionDeniedError,
	);
	assert.deepEqual(stub.requests[0]?.verdict, { ok: false, problems: ["headers: refused"] });
	assert.equal(JSON.stringify(stub.requests[0]?.verdict).includes(canary), false);
} else if (mode === "no-fallback") {
	const model = "claude-haiku-5-5";
	const stub = recorder(() => Response.json(completed({ model })), { ...pin, model });
	const { params, headers } = draftCall(input, { model });
	const result = await createClient(stub.fetch).beta.messages.parse(params, { headers });
	assert.equal(readDraft(result, ["c1"]).kind, "draft");
	assert.equal(Object.hasOwn(stub.requests[0]?.body as object, "fallbacks"), false);
	assert.equal(stub.requests[0]?.headers.has("anthropic-beta"), false);
	assert.equal(stub.requests[0]?.verdict.ok, true);
} else if (mode === "model-pin") {
	const stub = recorder();
	const { params, headers } = draftCall(input, { model: "claude-sonnet-5-5" });
	await assert.rejects(
		createClient(stub.fetch).messages.parse(params, { headers }),
		Anthropic.PermissionDeniedError,
	);
	assert.equal(stub.requests.length, 1);
	assert.deepEqual(stub.requests[0]?.verdict, { ok: false, problems: ["model: refused"] });
} else if (mode === "haiku-fallback") {
	const model = "claude-haiku-5-5";
	const stub = recorder(undefined, { ...pin, model });
	const { params } = draftCall(input, { model });
	await assert.rejects(
		createClient(stub.fetch).messages.parse(
			{ ...params, fallbacks: "default" },
			{
				headers: { "anthropic-beta": FALLBACK_BETA },
			},
		),
		Anthropic.PermissionDeniedError,
	);
	assert.equal(stub.requests.length, 1);
	assert.deepEqual(stub.requests[0]?.verdict, { ok: false, problems: ["fallbacks: refused"] });
} else if (mode === "max_tokens" || mode === "refusal") {
	for (const beta of [false, true]) {
		const stub = recorder(() =>
			Response.json(
				completed({ stop_reason: mode, content: [{ type: "text", text: `${canary} not JSON` }] }),
			),
		);
		const client = createClient(stub.fetch);
		const { params, headers } = draftCall(input);
		const result = await (beta
			? client.beta.messages.parse(params, { headers })
			: client.messages.parse(params, { headers }));
		assert.equal(result.parsed_output, `${canary} not JSON`);
		const outcome = readDraft(result, ["c1"]);
		assert.equal(outcome.kind, mode === "refusal" ? "refusal" : "truncated");
		assert.equal(JSON.stringify(outcome).includes(canary), false);
	}
} else if (mode === "invalid-options") {
	assert.throws(() => createClient(undefined as unknown as MessagesFetch), /INVALID_INPUT/);
	for (const maxRetries of [-1, 100, 1.5, Number.NaN, Number.POSITIVE_INFINITY])
		assert.throws(() => createClient(recorder().fetch, { maxRetries }), /INVALID_INPUT/);
} else if (mode === "jitless") {
	createClient(async () => {
		throw Error("Unused synthetic transport");
	});
	assert.equal(z.config().jitless, true);
	assert.equal(verifyRequest(buildRequest(input), pin).ok, true);
} else throw Error("Unknown synthetic SDK case");

assert.equal(networkCalls, 0);
console.log("messages-sdk-case-ok");
