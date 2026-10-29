import { getEventListeners } from "node:events";
import { syncBuiltinESMExports } from "node:module";
import type { TimerOptions } from "node:timers";
import timerPromises, { setImmediate } from "node:timers/promises";
import { describe, expect, it, vi } from "vitest";
import { createScript, streamed } from "../src/compatible/script.ts";
import {
	COMPATIBLE_CHAT_PATH,
	COMPATIBLE_DRAFT,
	COMPATIBLE_HOST,
	COMPATIBLE_MODEL,
	COMPATIBLE_MODELS_PATH,
	COMPATIBLE_OLLAMA_PATH,
	COMPATIBLE_TAGS_PATH,
	type CompatibleStep,
	chatCompletionBody,
	createCompatibleDraftFake,
	createCompatibleFake,
	ollamaChatBody,
} from "../src/compatible.ts";
import { httpDate, manualClock } from "../src/faults.ts";
import { createRecorder } from "../src/recorder.ts";
import { resolveFakeTransport } from "../src/server.ts";
import { getWithHost, json, listeners, rawGet, sha256, tryConnect } from "./helpers.ts";

const START = Date.UTC(2026, 9, 19, 8);
const CHAT = COMPATIBLE_CHAT_PATH;
const OLLAMA = COMPATIBLE_OLLAMA_PATH;
const MODELS = COMPATIBLE_MODELS_PATH;
const TAGS = COMPATIBLE_TAGS_PATH;
const CAP = 8 * 1_024 * 1_024;
const encoder = new TextEncoder();

// The compatible core's request bodies, member for member.
const SCHEMA = {
	type: "object",
	additionalProperties: false,
	required: ["body"],
	properties: { body: { type: "string" } },
};
const SYSTEM = { role: "system", content: "DYTEST trusted drafting instructions." };
const USER = { role: "user", content: "DYTEST thread data." };
const SCHEMA_FORMAT = {
	type: "json_schema",
	json_schema: { name: "draft_output_v1", strict: true, schema: SCHEMA },
};
const SCHEMA_REQUEST = {
	model: COMPATIBLE_MODEL,
	messages: [SYSTEM, USER],
	response_format: SCHEMA_FORMAT,
	stream: false,
};
const OBJECT_REQUEST = { ...SCHEMA_REQUEST, response_format: { type: "json_object" } };
const OLLAMA_REQUEST = {
	model: COMPATIBLE_MODEL,
	messages: [SYSTEM, USER],
	format: SCHEMA,
	stream: false,
};
const LISTED = { object: "list", data: [{ id: COMPATIBLE_MODEL, object: "model" }] };
const TAGGED = { models: [{ name: COMPATIBLE_MODEL, model: COMPATIBLE_MODEL }] };

const post = (extra: RequestInit = {}): RequestInit => ({
	method: "POST",
	headers: { "content-type": "application/json" },
	body: JSON.stringify(SCHEMA_REQUEST),
	...extra,
});
const request = (value: unknown, extra: RequestInit = {}): RequestInit =>
	post({ body: JSON.stringify(value), ...extra });
const streamPost = (body: ReadableStream<Uint8Array>, signal?: AbortSignal): RequestInit =>
	post({ body, signal, duplex: "half" } as RequestInit);
const reply = (body: unknown): CompatibleStep => ({ kind: "json", body });

function readerOf(response: Response): ReadableStreamDefaultReader<Uint8Array> {
	if (!response.body) throw new Error("DYTEST response without a body");
	return response.body.getReader();
}

// Lets in-memory requests reach the app without timing assumptions.
async function settle(done: () => boolean): Promise<void> {
	for (let turn = 0; turn < 100 && !done(); turn++) await setImmediate();
}

describe("compatible wire formats", () => {
	it.each([
		["chat completions", CHAT, chatCompletionBody()],
		["Ollama chat", OLLAMA, ollamaChatBody()],
	] as const)(
		"answers %s with the scripted JSON and no outside traffic",
		async (_name, path, body) => {
			const realFetch = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("DYTEST egress"));
			try {
				const fake = createCompatibleFake({ clock: manualClock(START), steps: [reply(body)] });
				const response = await fake.fetch(path, post());
				expect(response.status).toBe(200);
				expect(response.headers.get("content-type")).toBe("application/json");
				expect(response.headers.get("date")).toBe(httpDate(START));
				expect(await response.text()).toBe(JSON.stringify(body));
				expect(fake.host).toBe(COMPATIBLE_HOST);
				expect(fake.pending()).toBe(0);
				expect(realFetch).not.toHaveBeenCalled();
			} finally {
				realFetch.mockRestore();
			}
		},
	);

	it("lists models in both dialects without taking a step", async () => {
		const fake = createCompatibleFake({ clock: manualClock(START), steps: [reply({})] });
		const listed = await fake.fetch(MODELS);
		expect(listed.status).toBe(200);
		expect(listed.headers.get("content-type")).toBe("application/json");
		expect(listed.headers.get("date")).toBe(httpDate(START));
		expect(await listed.json()).toEqual(LISTED);
		expect(await json(fake.fetch(TAGS))).toEqual(TAGGED);
		expect(fake.pending()).toBe(1);
	});

	it("serves up to 500 listed ids, copied when the fake is made", async () => {
		const ids = Array.from({ length: 500 }, (_, n) => `dytest-model:${n}`);
		const expected = [...ids];
		const fake = createCompatibleFake({ models: ids });
		ids.length = 0;
		const listed = await json<{ data: { id: string; object: string }[] }>(fake.fetch(MODELS));
		expect(listed.data.map(({ id }) => id)).toEqual(expected);
		const tagged = await json<{ models: { name: string; model: string }[] }>(fake.fetch(TAGS));
		expect(tagged.models.map(({ name }) => name)).toEqual(expected);
		const other = createCompatibleFake({ model: "dytest-other:1" });
		expect(await json(other.fetch(TAGS))).toEqual({
			models: [{ name: "dytest-other:1", model: "dytest-other:1" }],
		});
		expect(await json(createCompatibleFake({ models: [] }).fetch(MODELS))).toEqual({
			object: "list",
			data: [],
		});
		const longest = "x".repeat(256);
		expect(await json(createCompatibleFake({ models: [longest, "!~"] }).fetch(MODELS))).toEqual({
			object: "list",
			data: [
				{ id: longest, object: "model" },
				{ id: "!~", object: "model" },
			],
		});
	});

	it.each([
		["501 ids", { models: Array.from({ length: 501 }, (_, n) => `dytest-${n}`) }, RangeError],
		["an empty id", { models: [""] }, TypeError],
		["a space", { models: ["dytest model"] }, TypeError],
		["a non-ASCII id", { models: ["dytest-é"] }, TypeError],
		["a 257-character id", { models: ["x".repeat(257)] }, TypeError],
		["a non-string id", { models: [7 as unknown as string] }, TypeError],
		["an invalid model", { model: "dytest model" }, TypeError],
	] as const)("refuses a listing with %s when the fake is made", (_name, options, error) => {
		expect(() => createCompatibleFake(options)).toThrow(error);
		expect(() => createCompatibleDraftFake(options)).toThrow(error);
	});

	it("bounds the ids a listing's iterator yields, not only its length", () => {
		const ids = ["dytest-0"];
		Object.defineProperty(ids, Symbol.iterator, {
			value: function* () {
				for (let n = 0; n < 501; n++) yield `dytest-${n}`;
			},
		});
		expect(() => createCompatibleFake({ models: ids })).toThrow("model listing limit");
	});

	it("sends a scripted listing, snapshotted when the fake is made, on both routes and every request", async () => {
		const text = '{"object":"list","data":[{"id":"dytest bad id","object":"model"}';
		const bytes = encoder.encode(text);
		const fake = createCompatibleFake({
			clock: manualClock(START),
			listing: { kind: "raw", body: bytes, status: 502, headers: { "x-dytest": "listing" } },
			steps: [reply({ order: 1 })],
		});
		bytes.fill(0x21);
		for (const path of [MODELS, TAGS, MODELS]) {
			const response = await fake.fetch(path);
			expect([
				response.status,
				response.headers.get("content-type"),
				response.headers.get("x-dytest"),
				response.headers.get("date"),
				await response.text(),
			]).toEqual([502, "application/json", "listing", httpDate(START), text]);
		}
		expect(fake.pending()).toBe(1);
		expect(await json(fake.fetch(CHAT, post()))).toEqual({ order: 1 });
		expect(await (await fake.fetch(TAGS)).text()).toBe(text);
		expect((await fake.fetch(MODELS, { method: "HEAD" })).status).toBe(405);
	});

	it.each([
		[
			"an invalid listing step",
			{ listing: { kind: "json", body: {}, status: 204 } },
			"allows a body",
		],
		["models and a listing", { models: [COMPATIBLE_MODEL], listing: reply({}) }, "not both"],
	] as const)("refuses %s when the fake is made", (_name, options, message) => {
		expect(() => createCompatibleFake(options)).toThrow(message);
		expect(() => createCompatibleDraftFake(options)).toThrow(message);
	});

	it("builds each dialect's completed, non-streamed default reply", () => {
		const content = JSON.stringify(COMPATIBLE_DRAFT);
		expect(chatCompletionBody()).toEqual({
			id: "chatcmpl-dytest",
			object: "chat.completion",
			model: COMPATIBLE_MODEL,
			choices: [{ index: 0, message: { role: "assistant", content }, finish_reason: "stop" }],
			usage: { prompt_tokens: 12, completion_tokens: 8, total_tokens: 20 },
		});
		expect(ollamaChatBody()).toEqual({
			model: COMPATIBLE_MODEL,
			message: { role: "assistant", content },
			done: true,
			done_reason: "stop",
			prompt_eval_count: 12,
			eval_count: 8,
		});
		expect(JSON.parse(content)).toEqual({
			body: expect.stringMatching(/^DYTEST /),
			ownerNotes: "",
			needsOwnerInput: [],
			suspectedInstructions: false,
			contextRefs: [],
		});
		expect(Object.isFrozen(COMPATIBLE_DRAFT)).toBe(true);
		expect(chatCompletionBody()).not.toBe(chatCompletionBody());
	});

	it("builds refusal, truncation, usage and tool-call replies for chat completions", () => {
		const call = { name: "dytest_lookup", arguments: { query: "DYTEST" } };
		const wireCall = { name: "dytest_lookup", arguments: '{"query":"DYTEST"}' };
		expect(chatCompletionBody({ content: null, refusal: "DYTEST refusal" })).toMatchObject({
			choices: [
				{
					message: { role: "assistant", content: null, refusal: "DYTEST refusal" },
					finish_reason: "stop",
				},
			],
		});
		expect(chatCompletionBody({ finishReason: "content_filter" })).toMatchObject({
			choices: [{ finish_reason: "content_filter" }],
		});
		expect(
			chatCompletionBody({ content: '{"body":"DYTEST', finishReason: "length" }),
		).toMatchObject({
			choices: [{ message: { content: '{"body":"DYTEST' }, finish_reason: "length" }],
		});
		expect(chatCompletionBody({ finishReason: null })).toMatchObject({
			choices: [{ finish_reason: null }],
		});
		expect(chatCompletionBody({ usage: { input: 3, output: 4 } })).toMatchObject({
			usage: { prompt_tokens: 3, completion_tokens: 4, total_tokens: 7 },
		});
		expect(chatCompletionBody({ usage: null })).not.toHaveProperty("usage");
		expect(chatCompletionBody({ toolCalls: [call, call] })).toMatchObject({
			choices: [
				{
					message: {
						tool_calls: [
							{ id: "call_dytest_1", type: "function", function: wireCall },
							{ id: "call_dytest_2", type: "function", function: wireCall },
						],
					},
				},
			],
		});
		expect(chatCompletionBody({ functionCall: call })).toMatchObject({
			choices: [{ message: { function_call: wireCall } }],
		});
		expect(chatCompletionBody({ model: "dytest-other:1" }).model).toBe("dytest-other:1");
	});

	it("builds truncated, unfinished, usage and tool-call replies for Ollama", () => {
		const call = { name: "dytest_lookup", arguments: { query: "DYTEST" } };
		expect(ollamaChatBody({ content: '{"body":"DYTEST', doneReason: "length" })).toMatchObject({
			message: { content: '{"body":"DYTEST' },
			done: true,
			done_reason: "length",
		});
		expect(ollamaChatBody({ done: false })).toMatchObject({ done: false });
		expect(ollamaChatBody({ usage: { input: 3, output: 4 } })).toMatchObject({
			prompt_eval_count: 3,
			eval_count: 4,
		});
		const bare = ollamaChatBody({ usage: null });
		expect(bare).not.toHaveProperty("prompt_eval_count");
		expect(bare).not.toHaveProperty("eval_count");
		expect(ollamaChatBody({ toolCalls: [call] })).toMatchObject({
			message: { tool_calls: [{ function: call }] },
		});
		expect(ollamaChatBody({ model: "dytest-other:1" }).model).toBe("dytest-other:1");
	});

	it("serves every scripted profile as its exact JSON bytes, in order", async () => {
		const obedient = { ...COMPATIBLE_DRAFT, body: "DYTEST obeyed the injected instruction." };
		const call = { name: "dytest_lookup", arguments: {} };
		const profiles: [string, Record<string, unknown>][] = [
			[CHAT, chatCompletionBody()],
			[OLLAMA, ollamaChatBody({ content: JSON.stringify(obedient) })],
			[CHAT, chatCompletionBody({ content: '{"unexpected":true}' })],
			[CHAT, chatCompletionBody({ content: null, refusal: "DYTEST refusal" })],
			[CHAT, chatCompletionBody({ finishReason: "content_filter" })],
			[CHAT, chatCompletionBody({ finishReason: "length" })],
			[OLLAMA, ollamaChatBody({ doneReason: "length" })],
			[OLLAMA, ollamaChatBody({ done: false })],
			[CHAT, chatCompletionBody({ toolCalls: [call] })],
			[CHAT, chatCompletionBody({ functionCall: call })],
			[OLLAMA, ollamaChatBody({ toolCalls: [call], usage: null })],
		];
		const fake = createCompatibleFake({ steps: profiles.map(([, body]) => reply(body)) });
		for (const [path, body] of profiles)
			expect(await (await fake.fetch(path, post())).text()).toBe(JSON.stringify(body));
		expect(fake.pending()).toBe(0);
	});

	it("sends malformed bytes and wrong media types exactly as scripted", async () => {
		const invalid = new Uint8Array([0x7b, 0xff, 0xfe, 0x7d]);
		const fake = createCompatibleFake({
			steps: [
				{ kind: "raw", body: '{"choices":' },
				{ kind: "raw", body: invalid },
				{ kind: "raw", body: "DYTEST plain text", contentType: "text/plain" },
				{ kind: "json", body: chatCompletionBody(), headers: { "content-type": "text/html" } },
				{ kind: "raw", body: "" },
			],
		});
		const first = await fake.fetch(CHAT, post());
		expect(first.headers.get("content-type")).toBe("application/json");
		const text = await first.text();
		expect(text).toBe('{"choices":');
		expect(() => JSON.parse(text)).toThrow(SyntaxError);
		const second = await fake.fetch(OLLAMA, post());
		expect(second.headers.get("content-type")).toBe("application/json");
		expect(new Uint8Array(await second.arrayBuffer())).toEqual(invalid);
		const third = await fake.fetch(CHAT, post());
		expect([third.headers.get("content-type"), await third.text()]).toEqual([
			"text/plain",
			"DYTEST plain text",
		]);
		const fourth = await fake.fetch(CHAT, post());
		expect(fourth.headers.get("content-type")).toBe("text/html");
		expect(await fourth.json()).toEqual(chatCompletionBody());
		const empty = await fake.fetch(OLLAMA, post());
		expect([empty.status, empty.headers.get("content-type"), await empty.text()]).toEqual([
			200,
			"application/json",
			"",
		]);
		expect(fake.pending()).toBe(0);
	});

	it.each([400, 401, 403, 404, 408, 500, 502, 503, 504])(
		"sends a scripted %i with its error body unchanged",
		async (status) => {
			const body = { error: { message: "DYTEST error", type: "dytest", code: `dytest_${status}` } };
			const fake = createCompatibleFake({
				clock: manualClock(START),
				steps: [{ kind: "json", status, body }],
			});
			const response = await fake.fetch(status === 404 ? OLLAMA : CHAT, post());
			expect([response.status, response.headers.get("date"), await response.json()]).toEqual([
				status,
				httpDate(START),
				body,
			]);
			expect(fake.pending()).toBe(0);
		},
	);

	it.each([
		["seconds", "3"],
		["an HTTP date", httpDate(START + 3_000)],
	])("sends a scripted 429 with Retry-After in %s", async (_name, hint) => {
		const body = {
			error: { message: "DYTEST limit", type: "requests", code: "rate_limit_exceeded" },
		};
		const fake = createCompatibleFake({
			clock: manualClock(START),
			steps: [{ kind: "json", status: 429, headers: { "retry-after": hint }, body }],
		});
		const response = await fake.fetch(CHAT, post());
		expect(response.status).toBe(429);
		expect(response.headers.get("retry-after")).toBe(hint);
		expect(response.headers.get("date")).toBe(httpDate(START));
		expect(await response.json()).toEqual(body);
	});

	it("sends the insufficient-quota 429 body byte for byte", async () => {
		const fake = createCompatibleFake({
			steps: [{ kind: "json", status: 429, body: { error: { code: "insufficient_quota" } } }],
		});
		const response = await fake.fetch(OLLAMA, post());
		expect(response.status).toBe(429);
		expect(response.headers.get("retry-after")).toBeNull();
		expect(await response.text()).toBe('{"error":{"code":"insufficient_quota"}}');
	});

	it("serves bodies and content past the core's limits unchanged, leaving acceptance to the consumer", async () => {
		const body = " ".repeat(262_145);
		const content = "x".repeat(131_073);
		const fake = createCompatibleFake({
			steps: [
				{ kind: "raw", body, chunkBytes: 4_096 },
				reply(chatCompletionBody({ content })),
				reply(ollamaChatBody({ content })),
			],
		});
		expect(await (await fake.fetch(CHAT, post())).text()).toBe(body);
		expect(await json(fake.fetch(CHAT, post()))).toEqual(chatCompletionBody({ content }));
		expect(await json(fake.fetch(OLLAMA, post()))).toEqual(ollamaChatBody({ content }));
	});
});

describe("routes, hosts and records", () => {
	it.each([
		["GET", CHAT, 405, "POST"],
		["PUT", OLLAMA, 405, "POST"],
		["HEAD", CHAT, 405, "POST"],
		["POST", MODELS, 405, "GET"],
		["HEAD", MODELS, 405, "GET"],
		["HEAD", TAGS, 405, "GET"],
		["DELETE", TAGS, 405, "GET"],
		["POST", `${CHAT}?`, 404, null],
		["POST", `${CHAT}?stream=true`, 404, null],
		["POST", "/v1/%63hat/completions", 404, null],
		["POST", "/v1/x/../chat/completions", 404, null],
		["POST", `${OLLAMA}#fragment`, 404, null],
		["POST", "/v1/completions", 404, null],
		["POST", "/api/generate", 404, null],
		["GET", `${MODELS}/${COMPATIBLE_MODEL}`, 404, null],
		["GET", `${TAGS}/`, 404, null],
		["GET", "/", 404, null],
	] as const)("refuses %s %s with %i and takes no step", async (method, target, status, allow) => {
		const fake = createCompatibleFake({ steps: [reply(chatCompletionBody())] });
		const bodyless = method === "GET" || method === "HEAD";
		const response = await fake.fetch(target, bodyless ? { method } : { method, body: "{}" });
		expect(response.status).toBe(status);
		expect(response.headers.get("allow")).toBe(allow);
		if (method !== "HEAD")
			expect(await response.json()).toEqual({
				error: status === 404 ? "not_found" : "method_not_allowed",
			});
		expect(fake.pending()).toBe(1);
		expect(fake.recorder.takeRequests().map((entry) => [entry.method, entry.target])).toEqual([
			[method, target],
		]);
		expect(await json(fake.fetch(CHAT, post()))).toEqual(chatCompletionBody());
	});

	it("answers another host 421 before any step or fault", async () => {
		const fake = createCompatibleFake({
			clock: manualClock(START),
			steps: [reply(chatCompletionBody())],
		});
		fake.faults.add({ kind: "server-error" });
		const response = await fake.fetch(`https://other.draftyak.example${CHAT}`, post());
		expect([response.status, await response.json()]).toEqual([
			421,
			{ error: "misdirected_request", host: "other.draftyak.example" },
		]);
		expect(response.headers.get("date")).toBe(httpDate(START));
		expect(fake.pending()).toBe(1);
		expect(fake.faults.pending()).toHaveLength(1);
		expect((await fake.fetch(CHAT, post())).status).toBe(503);
		expect(await json(fake.fetch(CHAT, post()))).toEqual(chatCompletionBody());
	});

	it("records exact fields, a body prefix and the full hash, with header values only on request", async () => {
		const recorder = createRecorder({ headerValues: ["content-type"], maxBodyBytes: 7 });
		const fake = createCompatibleFake({
			recorder,
			steps: [reply(chatCompletionBody()), reply(ollamaChatBody())],
		});
		const headers = { "content-type": "application/json", authorization: "Bearer DYTEST-token" };
		const chat = JSON.stringify(SCHEMA_REQUEST);
		const ollama = JSON.stringify(OLLAMA_REQUEST);
		await (await fake.fetch(CHAT, post({ body: chat, headers }))).text();
		await (await fake.fetch(OLLAMA, post({ body: ollama }))).text();
		await (await fake.fetch(TAGS)).text();
		const entry = (method: string, path: string, body: string, headerNames: string[]) => ({
			method,
			host: COMPATIBLE_HOST,
			target: path,
			path,
			query: "",
			headerNames,
			headers: method === "GET" ? {} : { "content-type": "application/json" },
			body: encoder.encode(body).slice(0, 7),
			bodyLength: Buffer.byteLength(body),
			bodySha256: sha256(body),
		});
		const records = recorder.takeRequests();
		expect(records).toEqual([
			entry("POST", CHAT, chat, ["authorization", "content-type"]),
			entry("POST", OLLAMA, ollama, ["content-type"]),
			entry("GET", TAGS, "", []),
		]);
		expect(JSON.stringify(records[0]?.headers)).not.toContain("DYTEST-token");
		expect(recorder.takeRequests()).toEqual([]);
	});

	it("answers 503 once the script runs out and serves steps enqueued later, in either dialect", async () => {
		const fake = createCompatibleFake();
		for (const path of [CHAT, OLLAMA]) {
			const empty = await fake.fetch(path, post());
			expect([empty.status, await empty.json()]).toEqual([503, { error: "script_exhausted" }]);
		}
		expect(fake.pending()).toBe(0);
		fake.enqueue(reply(chatCompletionBody()), reply(ollamaChatBody()));
		expect(fake.pending()).toBe(2);
		expect(await json(fake.fetch(CHAT, post()))).toEqual(chatCompletionBody());
		expect(await json(fake.fetch(OLLAMA, post()))).toEqual(ollamaChatBody());
		expect((await fake.fetch(CHAT, post())).status).toBe(503);
	});

	it("is exported from the package root and subpath and resolves as a genuine fake transport", async () => {
		const root = await import("@draftyak/fakes");
		const subpath = await import("@draftyak/fakes/compatible");
		expect(root.createCompatibleFake).toBe(createCompatibleFake);
		expect(root.ollamaChatBody).toBe(ollamaChatBody);
		expect(subpath.createCompatibleDraftFake).toBe(createCompatibleDraftFake);
		const fake = createCompatibleFake({ steps: [reply(ollamaChatBody())] });
		const transport = resolveFakeTransport(fake);
		if (!transport) throw new Error("DYTEST expected a genuine transport");
		expect(transport.host).toBe(COMPATIBLE_HOST);
		expect(await json(transport.fetch(OLLAMA, post()))).toEqual(ollamaChatBody());
		expect(fake.pending()).toBe(0);
	});

	it("needs a recorder that can record capped intake", () => {
		const legacy = { record: async () => {}, takeRequests: () => [] };
		expect(() => createCompatibleFake({ recorder: legacy })).toThrow("recorder.begin");
		expect(() => createCompatibleDraftFake({ recorder: legacy })).toThrow("recorder.begin");
	});
});

describe("script admission", () => {
	it("reads a step's kind once, so a changing getter cannot split its encoding", async () => {
		const kinds = ["json", "raw", "raw"] as const;
		let reads = 0;
		const step: CompatibleStep = {
			get kind() {
				return kinds[reads++] ?? "raw";
			},
			body: "DYTEST text",
		};
		const fake = createCompatibleFake({ steps: [step] });
		const response = await fake.fetch(CHAT, post());
		expect(response.headers.get("content-type")).toBe("application/json");
		expect(await response.text()).toBe(JSON.stringify("DYTEST text"));
		expect(reads).toBe(1);
	});

	it("snapshots JSON, raw bytes, headers and the initial array at enqueue", async () => {
		const payload = { value: "DYTEST before" };
		const bytes = encoder.encode("DYTEST bytes before");
		const headers = new Headers({ "x-dytest": "before" });
		const initial: CompatibleStep[] = [{ kind: "json", body: payload, headers }];
		const fake = createCompatibleFake({ steps: initial });
		fake.enqueue({ kind: "raw", body: bytes, contentType: "text/plain" });
		initial.length = 0;
		payload.value = "after";
		bytes.fill(0x21);
		headers.set("x-dytest", "after");
		const first = await fake.fetch(CHAT, post());
		expect(first.headers.get("x-dytest")).toBe("before");
		expect(await first.json()).toEqual({ value: "DYTEST before" });
		expect(await (await fake.fetch(OLLAMA, post())).text()).toBe("DYTEST bytes before");
		expect(fake.pending()).toBe(0);
	});

	it.each(["body getter", "toJSON"] as const)(
		"refuses an enqueue nested in a step's %s and adds nothing from that batch",
		async (where) => {
			const fake = createCompatibleFake({ steps: [reply({ order: 1 })] });
			const nested = () => {
				fake.enqueue(reply({ nested: true }));
				return {};
			};
			const step: CompatibleStep =
				where === "toJSON"
					? { kind: "json", body: { toJSON: nested } }
					: {
							kind: "json",
							get body() {
								return nested();
							},
						};
			expect(() => fake.enqueue(reply({ staged: true }), step)).toThrow("enqueue reentrancy");
			expect(fake.pending()).toBe(1);
			fake.enqueue(reply({ recovered: true }));
			expect(await json(fake.fetch(CHAT, post()))).toEqual({ order: 1 });
			expect(await json(fake.fetch(CHAT, post()))).toEqual({ recovered: true });
		},
	);

	const invalid: [string, CompatibleStep, string | typeof TypeError][] = [
		["JSON that encodes nothing", { kind: "json", body: undefined }, "JSON must encode"],
		["a function as JSON", { kind: "json", body: () => "DYTEST" }, "JSON must encode"],
		["status 204", { kind: "json", body: {}, status: 204 }, "allows a body"],
		["status 205", { kind: "json", body: {}, status: 205 }, "allows a body"],
		["status 304", { kind: "json", body: {}, status: 304 }, "allows a body"],
		["status 199", { kind: "json", body: {}, status: 199 }, "allows a body"],
		["status 600", { kind: "json", body: {}, status: 600 }, "allows a body"],
		["status 200.5", { kind: "json", body: {}, status: 200.5 }, "allows a body"],
		["delayMs -1", { kind: "json", body: {}, delayMs: -1 }, "fake delayMs"],
		["delayMs NaN", { kind: "json", body: {}, delayMs: Number.NaN }, "fake delayMs"],
		["delayMs 2^31", { kind: "json", body: {}, delayMs: 2 ** 31 }, "fake delayMs"],
		["chunkDelayMs 0.5", { kind: "raw", body: "x", chunkDelayMs: 0.5 }, "fake chunkDelayMs"],
		["chunkBytes 0", { kind: "raw", body: "x", chunkBytes: 0 }, "chunkBytes must"],
		["chunkBytes 65,537", { kind: "raw", body: "x", chunkBytes: 65_537 }, "chunkBytes must"],
		["chunkBytes 1.5", { kind: "raw", body: "x", chunkBytes: 1.5 }, "chunkBytes must"],
		["65,537 chunks", { kind: "raw", body: "x".repeat(65_537), chunkBytes: 1 }, "chunk work limit"],
		["text past 16 MiB", { kind: "raw", body: "x".repeat(16 * 1_024 * 1_024 + 1) }, "byte limit"],
		[
			"bytes past 16 MiB",
			{ kind: "raw", body: new Uint8Array(16 * 1_024 * 1_024 + 1) },
			"byte limit",
		],
		["a number as raw body", { kind: "raw", body: 7 as unknown as string }, "text or bytes"],
		["an unknown kind", { kind: "sse", body: "" } as unknown as CompatibleStep, "step kind"],
		[
			"an invalid header name",
			{ kind: "json", body: {}, headers: { "bad header": "DYTEST" } },
			TypeError,
		],
		[
			"Content-Length",
			{ kind: "json", body: {}, headers: { "content-length": "2" } },
			"framing headers",
		],
		[
			"Transfer-Encoding",
			{ kind: "raw", body: "x", headers: { "Transfer-Encoding": "chunked" } },
			"framing headers",
		],
	];

	it.each(invalid)("refuses a step with %s and adds none of its batch", (_name, step, error) => {
		const fake = createCompatibleFake({ steps: [reply({ order: 1 })] });
		expect(() => fake.enqueue(reply({ appended: false }), step)).toThrow(error);
		expect(fake.pending()).toBe(1);
	});

	it("accepts the exact per-step chunk and byte boundaries", async () => {
		const fake = createCompatibleFake();
		fake.enqueue(
			{ kind: "raw", body: "x".repeat(65_536), chunkBytes: 1 },
			{ kind: "raw", body: "x", chunkBytes: 65_536 },
			{ kind: "raw", body: "é".repeat(8 * 1_024 * 1_024) },
			{ kind: "json", body: {}, status: 599, delayMs: 0 },
		);
		expect(fake.pending()).toBe(4);
		expect(() => fake.enqueue({ kind: "raw", body: `${"é".repeat(8 * 1_024 * 1_024)}x` })).toThrow(
			"byte limit",
		);
		expect(fake.pending()).toBe(4);
		const chunks = readerOf(await fake.fetch(CHAT, post()));
		let count = 0;
		for (let next = await chunks.read(); !next.done; next = await chunks.read()) {
			expect(next.value.byteLength).toBe(1);
			count++;
		}
		expect(count).toBe(65_536);
	});

	it("holds at most 1,024 steps and refuses a batch past them", () => {
		const fake = createCompatibleFake({ steps: [reply(null)] });
		fake.enqueue(...Array.from({ length: 1_023 }, () => reply(null)));
		expect(fake.pending()).toBe(1_024);
		expect(() => fake.enqueue(reply(null))).toThrow("queue limit");
		expect(fake.pending()).toBe(1_024);
	});

	it("stages at most 64 MiB of queued bodies atomically and releases them at app admission", async () => {
		const large = "x".repeat(16 * 1_024 * 1_024);
		const fake = createCompatibleFake({
			steps: [
				{ kind: "raw", body: large, delayMs: Infinity },
				{ kind: "raw", body: large },
				{ kind: "raw", body: large },
				{ kind: "raw", body: large.slice(1) },
			],
		});
		let laterReads = 0;
		const later: CompatibleStep = {
			kind: "json",
			get body() {
				laterReads++;
				return {};
			},
		};
		expect(() => fake.enqueue({ kind: "raw", body: "é" })).toThrow("byte limit");
		expect(() =>
			fake.enqueue({ kind: "raw", body: "x" }, { kind: "raw", body: "x" }, later),
		).toThrow("byte limit");
		expect(laterReads).toBe(0);
		expect(fake.pending()).toBe(4);
		fake.enqueue({ kind: "raw", body: "x" });
		expect(fake.pending()).toBe(5);
		expect(() => fake.enqueue({ kind: "raw", body: "x" })).toThrow("byte limit");
		expect(() => fake.enqueue({ kind: "raw", body: new Uint8Array(1) })).toThrow("byte limit");
		expect(fake.pending()).toBe(5);
		const abort = new AbortController();
		const active = fake.fetch(CHAT, post({ signal: abort.signal }));
		const rejected = expect(active).rejects.toThrow("DYTEST stop");
		try {
			await settle(() => fake.pending() === 4);
			expect(fake.pending()).toBe(4);
			fake.enqueue({ kind: "raw", body: large });
			expect(fake.pending()).toBe(5);
		} finally {
			abort.abort(new Error("DYTEST stop"));
			await rejected;
		}
	});
});

describe("shared request intake", () => {
	it.each([0, 1])("keeps the core's 8 MiB request cap inclusive (+%i)", async (extra) => {
		const fake = createCompatibleFake({ steps: [reply({ order: 1 })] });
		const response = await fake.fetch(CHAT, post({ body: "{".padEnd(CAP + extra, " ") }));
		expect(response.status).toBe(extra ? 413 : 200);
		expect(await response.json()).toEqual(
			extra ? { error: "request_body_too_large" } : { order: 1 },
		);
		expect(fake.pending()).toBe(extra);
		const [record] = fake.recorder.takeRequests();
		expect(record?.bodyLength).toBe(CAP + extra);
		expect(record?.refused).toBe(extra ? "request_body_too_large" : undefined);
	});

	it("records the crossing chunk, cancels unread input and never clones a refused upload", async () => {
		const recorder = createRecorder({ maxBodyBytes: 7 });
		const fake = createCompatibleFake({ recorder, steps: [reply({ order: 1 })] });
		const first = new Uint8Array(CAP - 1).fill(0x78);
		const crossing = new Uint8Array([0x79, 0x7a]);
		let index = 0;
		let cancelled = 0;
		const stream = new ReadableStream<Uint8Array>(
			{
				pull(controller) {
					controller.enqueue(index++ === 0 ? first : index === 2 ? crossing : new Uint8Array([9]));
				},
				cancel() {
					cancelled++;
				},
			},
			{ highWaterMark: 0 },
		);
		const clone = vi.spyOn(Request.prototype, "clone").mockImplementation(() => {
			throw new Error("DYTEST premature clone");
		});
		try {
			const response = await fake.fetch(OLLAMA, streamPost(stream));
			expect(response.status).toBe(413);
			expect(clone).not.toHaveBeenCalled();
			await settle(() => cancelled === 1);
			expect(cancelled).toBe(1);
			const [record] = recorder.takeRequests();
			expect(record?.body).toEqual(first.slice(0, 7));
			expect(record?.bodyLength).toBe(CAP + 1);
			expect(record?.bodySha256).toBe(sha256(Buffer.concat([first, crossing])));
			expect(record?.refused).toBe("request_body_too_large");
			expect(fake.pending()).toBe(1);
		} finally {
			clone.mockRestore();
		}
	});

	it.each([false, true])(
		"still runs an arrival fault when intake refuses the upload (after=%s)",
		async (after) => {
			const fake = createCompatibleFake({
				clock: manualClock(START),
				steps: [reply({ order: 1 })],
			});
			fake.faults.add(
				after ? { kind: "server-error", after: true } : { kind: "rate-limit", retryAfter: 3 },
			);
			const response = await fake.fetch(CHAT, post({ body: "x".repeat(CAP + 1) }));
			expect(response.status).toBe(after ? 503 : 429);
			expect(response.headers.get("date")).toBe(httpDate(START));
			expect(fake.pending()).toBe(1);
			expect(fake.recorder.takeRequests()[0]?.refused).toBe("request_body_too_large");
			expect(await json(fake.fetch(CHAT, post()))).toEqual({ order: 1 });
		},
	);

	it.each(["abort", "source-error", "non-byte"] as const)(
		"discards a partial %s upload and takes no step",
		async (kind) => {
			const fake = createCompatibleFake({ steps: [reply({ order: 1 })] });
			const abort = new AbortController();
			let upload!: ReadableStreamDefaultController<Uint8Array>;
			let cancelled = 0;
			const stream = new ReadableStream<Uint8Array>({
				start(controller) {
					upload = controller;
				},
				cancel() {
					cancelled++;
				},
			});
			const original = new Request(
				`https://${COMPATIBLE_HOST}${CHAT}`,
				streamPost(stream, abort.signal),
			);
			const pending = fake.fetch(original);
			const rejection = expect(pending).rejects.toThrow();
			upload.enqueue(new Uint8Array([0x7b]));
			await setImmediate();
			if (kind === "abort") abort.abort(new Error("DYTEST aborted upload"));
			else if (kind === "source-error") upload.error(new Error("DYTEST failed upload"));
			else upload.enqueue("DYTEST not bytes" as unknown as Uint8Array);
			await rejection;
			await setImmediate();
			expect(fake.pending()).toBe(1);
			expect(fake.recorder.takeRequests()).toEqual([]);
			if (kind !== "source-error") expect(cancelled).toBe(1);
			expect(
				getEventListeners(original.signal, "abort").filter((listener) => listener.name === "abort"),
			).toEqual([]);
			expect(await json(fake.fetch(CHAT, post()))).toEqual({ order: 1 });
		},
	);

	it("takes steps when uploads finish while the recorder keeps arrival order", async () => {
		const fake = createCompatibleFake({ steps: [reply({ order: 1 }), reply({ order: 2 })] });
		let upload!: ReadableStreamDefaultController<Uint8Array>;
		const first = fake.fetch(
			CHAT,
			streamPost(
				new ReadableStream<Uint8Array>({
					start(controller) {
						upload = controller;
					},
				}),
			),
		);
		try {
			expect(fake.pending()).toBe(2);
			expect(await json(fake.fetch(OLLAMA, post()))).toEqual({ order: 1 });
			expect(fake.recorder.takeRequests()).toEqual([]);
		} finally {
			upload.enqueue(encoder.encode(JSON.stringify(SCHEMA_REQUEST)));
			upload.close();
		}
		expect(await json(first)).toEqual({ order: 2 });
		expect(fake.recorder.takeRequests().map(({ target }) => target)).toEqual([CHAT, OLLAMA]);
	});
});

describe("shared faults", () => {
	it.each([
		["seconds", 30, "30"],
		["an HTTP date", { at: START + 30_000 }, httpDate(START + 30_000)],
	] as const)(
		"rate-limits with Retry-After in %s before a step is taken",
		async (_name, retryAfter, hint) => {
			const fake = createCompatibleFake({
				clock: manualClock(START),
				steps: [reply(chatCompletionBody())],
			});
			fake.faults.add({ kind: "rate-limit", retryAfter });
			const response = await fake.fetch(CHAT, post());
			expect([
				response.status,
				response.headers.get("retry-after"),
				response.headers.get("date"),
				await response.json(),
			]).toEqual([429, hint, httpDate(START), { error: "rate_limited" }]);
			expect(fake.pending()).toBe(1);
			expect(await json(fake.fetch(CHAT, post()))).toEqual(chatCompletionBody());
		},
	);

	it.each([
		[undefined, 503],
		[500, 500],
		[502, 502],
		[504, 504],
	] as const)("answers a server-error fault of %s with %i", async (status, expected) => {
		const fake = createCompatibleFake({ steps: [reply(ollamaChatBody())] });
		fake.faults.add({ kind: "server-error", status });
		const response = await fake.fetch(OLLAMA, post());
		expect([response.status, await response.json()]).toEqual([expected, { error: "server_error" }]);
		expect(fake.pending()).toBe(1);
	});

	it("lets the app answer after a finite latency fault", async () => {
		const fake = createCompatibleFake({ steps: [reply(chatCompletionBody())] });
		fake.faults.add({ kind: "latency", ms: 5 });
		expect(await json(fake.fetch(CHAT, post()))).toEqual(chatCompletionBody());
		expect(fake.pending()).toBe(0);
		expect(fake.faults.pending()).toEqual([]);
	});

	it("drops a connection before the app takes a step, or after it took one", async () => {
		const fake = createCompatibleFake({ steps: [reply({ order: 1 }), reply({ order: 2 })] });
		fake.faults.add({ kind: "drop" });
		await expect(fake.fetch(CHAT, post())).rejects.toThrow("fetch failed");
		expect(fake.pending()).toBe(2);
		fake.faults.add({ kind: "drop", after: true });
		await expect(fake.fetch(OLLAMA, post())).rejects.toThrow("fetch failed");
		expect(fake.pending()).toBe(1);
		expect(await json(fake.fetch(CHAT, post()))).toEqual({ order: 2 });
	});

	it("scopes faults to a listing's path and method without touching completions", async () => {
		const fake = createCompatibleFake({ steps: [reply({ order: 1 })] });
		fake.faults.add({ kind: "server-error", path: MODELS, method: "get", times: 2 });
		expect((await fake.fetch(MODELS)).status).toBe(503);
		expect(await json(fake.fetch(CHAT, post()))).toEqual({ order: 1 });
		expect(await json(fake.fetch(TAGS))).toEqual(TAGGED);
		expect((await fake.fetch(MODELS)).status).toBe(503);
		expect(await json(fake.fetch(MODELS))).toEqual(LISTED);
	});

	it("uses a step on an after-fault but not on a before-fault", async () => {
		const fake = createCompatibleFake({ steps: [reply({ order: 1 }), reply({ order: 2 })] });
		fake.faults.add({ kind: "rate-limit", retryAfter: 2 });
		expect((await fake.fetch(CHAT, post())).status).toBe(429);
		expect(fake.pending()).toBe(2);
		fake.faults.add({ kind: "server-error", after: true });
		expect((await fake.fetch(CHAT, post())).status).toBe(503);
		expect(fake.pending()).toBe(1);
		expect(await json(fake.fetch(CHAT, post()))).toEqual({ order: 2 });
	});

	it.each(["server-error", "drop"] as const)(
		"cancels the scripted body an after-app %s fault replaces",
		async (kind) => {
			const fake = createCompatibleFake({
				steps: [{ kind: "raw", body: "abcdef", chunkBytes: 1, chunkDelayMs: Infinity }],
			});
			const cancel = vi.spyOn(ReadableStream.prototype, "cancel");
			try {
				fake.faults.add({ kind, after: true });
				if (kind === "drop") await expect(fake.fetch(CHAT, post())).rejects.toThrow("fetch failed");
				else {
					const response = await fake.fetch(CHAT, post());
					expect(response.status).toBe(503);
					await response.text();
				}
				await settle(() => cancel.mock.calls.length > 0);
				expect(cancel).toHaveBeenCalledOnce();
				const discarded = cancel.mock.contexts[0];
				if (!(discarded instanceof ReadableStream)) throw new Error("DYTEST no discarded body");
				expect(await discarded.getReader().read()).toEqual({ done: true, value: undefined });
				expect(fake.pending()).toBe(0);
			} finally {
				cancel.mockRestore();
			}
		},
	);
});

describe("slow and cancellable responses", () => {
	it("rejects a slow pre-response wait with the abort's reason and keeps its step used", async () => {
		const clock = manualClock(START);
		const fake = createCompatibleFake({
			clock,
			steps: [
				{ kind: "json", body: chatCompletionBody(), delayMs: Infinity },
				reply(ollamaChatBody()),
			],
		});
		const controller = new AbortController();
		const reason = new Error("DYTEST slow model stopped");
		const pending = fake.fetch(CHAT, post({ signal: controller.signal }));
		let settled = false;
		void pending.then(
			() => {
				settled = true;
			},
			() => {
				settled = true;
			},
		);
		const rejected = expect(pending).rejects.toBe(reason);
		await settle(() => fake.pending() === 1);
		clock.advance(86_400_000);
		await setImmediate();
		expect(settled).toBe(false);
		expect(fake.pending()).toBe(1);
		controller.abort(reason);
		await rejected;
		const next = await fake.fetch(OLLAMA, post());
		expect(next.headers.get("date")).toBe(httpDate(START + 86_400_000));
		expect(await next.json()).toEqual(ollamaChatBody());
	});

	it("ends a slow body at an abort, with no bytes after it", async () => {
		const fake = createCompatibleFake({
			clock: manualClock(START),
			steps: [{ kind: "raw", body: "abcdef", chunkBytes: 1, chunkDelayMs: Infinity }],
		});
		const controller = new AbortController();
		const response = await fake.fetch(OLLAMA, post({ signal: controller.signal }));
		expect(response.headers.get("date")).toBe(httpDate(START));
		const reader = readerOf(response);
		expect(await reader.read()).toEqual({ done: false, value: encoder.encode("a") });
		const reason = new Error("DYTEST body stopped");
		const refused = expect(reader.read()).rejects.toBe(reason);
		controller.abort(reason);
		await refused;
		await expect(reader.read()).rejects.toBe(reason);
		expect(fake.pending()).toBe(0);
	});

	it("ends a chunk wait when the reader cancels, and serves the next step", async () => {
		const fake = createCompatibleFake({
			steps: [
				{ kind: "raw", body: "abcdef", chunkBytes: 1, chunkDelayMs: Infinity },
				reply(chatCompletionBody()),
			],
		});
		const reader = readerOf(await fake.fetch(CHAT, post()));
		expect((await reader.read()).value).toEqual(encoder.encode("a"));
		const pending = reader.read();
		await reader.cancel("DYTEST reader done");
		expect(await pending).toEqual({ done: true, value: undefined });
		expect(await json(fake.fetch(CHAT, post()))).toEqual(chatCompletionBody());
	});

	it("delivers a finite slow body in its scripted chunks", async () => {
		const body = JSON.stringify(ollamaChatBody());
		const fake = createCompatibleFake({
			steps: [{ kind: "json", body: ollamaChatBody(), chunkBytes: 16, chunkDelayMs: 1 }],
		});
		const reader = readerOf(await fake.fetch(OLLAMA, post()));
		const sizes: number[] = [];
		const parts: Uint8Array[] = [];
		for (let next = await reader.read(); !next.done; next = await reader.read()) {
			sizes.push(next.value.byteLength);
			parts.push(next.value);
		}
		expect(Buffer.concat(parts).toString("utf8")).toBe(body);
		expect(sizes.slice(0, -1).every((size) => size === 16)).toBe(true);
		expect(sizes).toHaveLength(Math.ceil(Buffer.byteLength(body) / 16));
	});

	it("holds the headers for a finite delayMs and each later chunk for a finite chunkDelayMs", async () => {
		const originalDelay = timerPromises.setTimeout;
		const waits: { ms: number; release(): void }[] = [];
		const delay = vi
			.spyOn(timerPromises, "setTimeout")
			.mockImplementation(<T>(ms?: number, value?: T, options?: TimerOptions): Promise<T> => {
				const signal = options?.signal;
				if (signal === undefined || (ms !== 50 && ms !== 40))
					return originalDelay(ms, value, options);
				return new Promise<T>((resolve, reject) => {
					waits.push({ ms, release: () => resolve(value as T) });
					signal.addEventListener("abort", () => reject(signal.reason), { once: true });
				});
			});
		syncBuiltinESMExports();
		const settled = <T>(promise: Promise<T>) => {
			const state = { done: false, promise };
			const done = (): void => {
				state.done = true;
			};
			void promise.then(done, done);
			return state;
		};
		try {
			const fake = createCompatibleFake({
				steps: [
					{ kind: "json", body: { order: 1 }, delayMs: 50 },
					{ kind: "raw", body: "abc", chunkBytes: 1, chunkDelayMs: 40 },
				],
			});
			const headers = settled(fake.fetch(CHAT, post()));
			await settle(() => headers.done);
			expect([headers.done, waits.map(({ ms }) => ms)]).toEqual([false, [50]]);
			waits[0]?.release();
			expect(await json(headers.promise)).toEqual({ order: 1 });
			const reader = readerOf(await fake.fetch(CHAT, post()));
			for (const [index, letter] of ["a", "b", "c"].entries()) {
				const read = settled(reader.read());
				await settle(() => read.done);
				if (index === 0) expect(read.done).toBe(true);
				else {
					expect([read.done, waits.length]).toEqual([false, index + 1]);
					waits[index]?.release();
				}
				expect(await read.promise).toEqual({ done: false, value: encoder.encode(letter) });
			}
			expect(await reader.read()).toEqual({ done: true, value: undefined });
			expect(waits.map(({ ms }) => ms)).toEqual([50, 40, 40]);
		} finally {
			for (const { release } of waits) release();
			delay.mockRestore();
			syncBuiltinESMExports();
		}
	});

	it.each(["header", "chunk", "cancel", "latency"] as const)(
		"clears the timer of a pending %s wait when it ends",
		async (mode) => {
			const originalDelay = timerPromises.setTimeout;
			// Releases a leaked wait after a failed assertion, so the run still ends.
			const cleanup = new AbortController();
			const armed = new Set<Promise<unknown>>();
			const delay = vi
				.spyOn(timerPromises, "setTimeout")
				.mockImplementation(<T>(ms?: number, value?: T, options?: TimerOptions): Promise<T> => {
					if (ms !== 2_147_483_647 || !options?.signal) return originalDelay(ms, value, options);
					const promise = originalDelay(ms, value, {
						...options,
						signal: AbortSignal.any([options.signal, cleanup.signal]),
					});
					armed.add(promise);
					void promise.then(
						() => armed.delete(promise),
						() => armed.delete(promise),
					);
					return promise;
				});
			syncBuiltinESMExports();
			const controller = new AbortController();
			const reason = new Error(`DYTEST ${mode} stopped`);
			const step: CompatibleStep =
				mode === "header"
					? { kind: "json", body: {}, delayMs: Infinity }
					: { kind: "raw", body: "abc", chunkBytes: 1, chunkDelayMs: Infinity };
			const fake = createCompatibleFake({ clock: manualClock(START), steps: [step] });
			if (mode === "latency") fake.faults.add({ kind: "latency", ms: Infinity });
			try {
				if (mode === "header" || mode === "latency") {
					const pending = fake.fetch(CHAT, post({ signal: controller.signal }));
					const rejected = expect(pending).rejects.toBe(reason);
					await settle(() => armed.size === 1);
					expect(armed.size).toBe(1);
					expect(fake.pending()).toBe(mode === "header" ? 0 : 1);
					controller.abort(reason);
					await rejected;
				} else {
					const reader = readerOf(await fake.fetch(CHAT, post({ signal: controller.signal })));
					expect((await reader.read()).value).toEqual(encoder.encode("a"));
					const next = reader.read();
					await settle(() => armed.size === 1);
					expect(armed.size).toBe(1);
					if (mode === "cancel") {
						await reader.cancel("DYTEST cancelled");
						expect(await next).toEqual({ done: true, value: undefined });
					} else {
						const failed = expect(next).rejects.toBe(reason);
						controller.abort(reason);
						await failed;
					}
				}
				await settle(() => armed.size === 0);
				expect(armed.size).toBe(0);
			} finally {
				controller.abort();
				cleanup.abort();
				await Promise.allSettled(armed);
				delay.mockRestore();
				syncBuiltinESMExports();
			}
		},
	);

	it("errors a scripted body with the abort's reason, in a chunk wait or before the first chunk", async () => {
		const script = createScript();
		const slow: CompatibleStep = { kind: "raw", body: "ab", chunkBytes: 1, chunkDelayMs: Infinity };
		script.enqueue(slow, slow);
		const [waiting, late] = [script.take(), script.take()];
		if (!waiting || !late) throw new Error("DYTEST expected two steps");
		const controller = new AbortController();
		const reason = new Error("DYTEST body aborted");
		const reader = streamed(waiting, controller.signal).getReader();
		try {
			expect(await reader.read()).toEqual({ done: false, value: encoder.encode("a") });
			let outcome: unknown = "pending";
			void reader.read().then(
				(value) => {
					outcome = value;
				},
				(error: unknown) => {
					outcome = error;
				},
			);
			await setImmediate();
			controller.abort(reason);
			await settle(() => outcome !== "pending");
			expect(outcome).toBe(reason);
			await expect(streamed(late, controller.signal).getReader().read()).rejects.toBe(reason);
		} finally {
			await reader.cancel().catch(() => {});
		}
	});
});

describe("draft-request fixture", () => {
	const refused = { error: "request_refused" };
	const steps = (): CompatibleStep[] => [reply({ reserved: 1 }), reply({ reserved: 2 })];
	const valid = (path: string) => (path === OLLAMA ? OLLAMA_REQUEST : SCHEMA_REQUEST);

	it.each([
		["json_schema", CHAT, SCHEMA_REQUEST],
		["json_object", CHAT, OBJECT_REQUEST],
		["Ollama schema", OLLAMA, OLLAMA_REQUEST],
		[
			"reordered",
			CHAT,
			{
				stream: false,
				response_format: SCHEMA_FORMAT,
				messages: [SYSTEM, USER],
				model: COMPATIBLE_MODEL,
			},
		],
		[
			"empty-text",
			OLLAMA,
			{
				...OLLAMA_REQUEST,
				messages: [
					{ role: "system", content: "" },
					{ role: "user", content: "" },
				],
			},
		],
	] as const)("accepts the core's %s request", async (_name, path, value) => {
		const fake = createCompatibleDraftFake({ steps: steps() });
		const response = await fake.fetch(path, request(value));
		expect([response.status, await response.json()]).toEqual([200, { reserved: 1 }]);
		expect(fake.pending()).toBe(1);
	});

	it("requires exactly the configured model, which the listings name", async () => {
		const model = "dytest-other:1";
		const fake = createCompatibleDraftFake({ model, steps: steps() });
		expect((await fake.fetch(CHAT, request(SCHEMA_REQUEST))).status).toBe(400);
		expect((await fake.fetch(OLLAMA, request({ ...OLLAMA_REQUEST, model }))).status).toBe(200);
		expect(await json(fake.fetch(MODELS))).toEqual({
			object: "list",
			data: [{ id: model, object: "model" }],
		});
	});

	it.each([
		["another model", CHAT, { ...SCHEMA_REQUEST, model: "synthetic-model:2" }],
		["an extra member", CHAT, { ...SCHEMA_REQUEST, temperature: 0 }],
		["tools", CHAT, { ...SCHEMA_REQUEST, tools: [] }],
		["stream options", CHAT, { ...SCHEMA_REQUEST, stream_options: { include_usage: true } }],
		[
			"no stream member",
			CHAT,
			{ model: COMPATIBLE_MODEL, messages: [SYSTEM, USER], response_format: SCHEMA_FORMAT },
		],
		["a streamed request", OLLAMA, { ...OLLAMA_REQUEST, stream: true }],
		["stream as text", CHAT, { ...SCHEMA_REQUEST, stream: "false" }],
		["no format", CHAT, { model: COMPATIBLE_MODEL, messages: [SYSTEM, USER], stream: false }],
		["Ollama's format on chat completions", CHAT, OLLAMA_REQUEST],
		["chat completions' format on Ollama", OLLAMA, SCHEMA_REQUEST],
		["a text format", CHAT, { ...SCHEMA_REQUEST, response_format: { type: "text" } }],
		[
			"json_object with a schema",
			CHAT,
			{ ...SCHEMA_REQUEST, response_format: { type: "json_object", schema: SCHEMA } },
		],
		[
			"another schema name",
			CHAT,
			{
				...SCHEMA_REQUEST,
				response_format: {
					type: "json_schema",
					json_schema: { ...SCHEMA_FORMAT.json_schema, name: "draft_output" },
				},
			},
		],
		[
			"a non-strict schema",
			CHAT,
			{
				...SCHEMA_REQUEST,
				response_format: {
					type: "json_schema",
					json_schema: { ...SCHEMA_FORMAT.json_schema, strict: false },
				},
			},
		],
		[
			"an extra json_schema member",
			CHAT,
			{
				...SCHEMA_REQUEST,
				response_format: {
					type: "json_schema",
					json_schema: { ...SCHEMA_FORMAT.json_schema, description: "DYTEST" },
				},
			},
		],
		[
			"a schema that is no object",
			CHAT,
			{
				...SCHEMA_REQUEST,
				response_format: {
					type: "json_schema",
					json_schema: { ...SCHEMA_FORMAT.json_schema, schema: [] },
				},
			},
		],
		[
			"an extra response_format member",
			CHAT,
			{ ...SCHEMA_REQUEST, response_format: { ...SCHEMA_FORMAT, strict: true } },
		],
		["Ollama's JSON mode", OLLAMA, { ...OLLAMA_REQUEST, format: "json" }],
		["Ollama options", OLLAMA, { ...OLLAMA_REQUEST, options: { temperature: 0 } }],
		["one message", CHAT, { ...SCHEMA_REQUEST, messages: [USER] }],
		["three messages", CHAT, { ...SCHEMA_REQUEST, messages: [SYSTEM, USER, USER] }],
		["swapped roles", OLLAMA, { ...OLLAMA_REQUEST, messages: [USER, SYSTEM] }],
		[
			"an assistant message",
			CHAT,
			{ ...SCHEMA_REQUEST, messages: [SYSTEM, { role: "assistant", content: "DYTEST" }] },
		],
		[
			"an extra message member",
			CHAT,
			{ ...SCHEMA_REQUEST, messages: [{ ...SYSTEM, name: "dytest" }, USER] },
		],
		[
			"structured content",
			OLLAMA,
			{ ...OLLAMA_REQUEST, messages: [SYSTEM, { role: "user", content: [{ type: "text" }] }] },
		],
		["an array", CHAT, [SCHEMA_REQUEST]],
		["null", OLLAMA, null],
	] as const)("refuses %s with a fixed 400, using up one step", async (_name, path, value) => {
		const fake = createCompatibleDraftFake({ steps: steps() });
		const response = await fake.fetch(path, request(value));
		expect([response.status, await response.json()]).toEqual([400, refused]);
		const [record] = fake.recorder.takeRequests();
		expect(record?.bodySha256).toBe(sha256(JSON.stringify(value)));
		expect(record?.headers).toEqual({});
		expect(fake.pending()).toBe(1);
		expect(await json(fake.fetch(path, request(valid(path))))).toEqual({ reserved: 2 });
	});

	it.each([
		"application/json",
		"application/json; charset=utf-8",
		'Application/JSON; charset="UTF-8"',
	])("accepts content type %s", async (contentType) => {
		const fake = createCompatibleDraftFake({ steps: steps() });
		const init = request(SCHEMA_REQUEST, { headers: { "content-type": contentType } });
		expect((await fake.fetch(CHAT, init)).status).toBe(200);
	});

	// Bytes, so fetch adds no text/plain type of its own when the header is left out.
	it.each(["text/plain", "application/json; charset=latin1", "application/json; x=1", "", null])(
		"refuses content type %s",
		async (contentType) => {
			const fake = createCompatibleDraftFake({ steps: steps() });
			const response = await fake.fetch(
				OLLAMA,
				post({
					body: encoder.encode(JSON.stringify(OLLAMA_REQUEST)),
					headers: contentType === null ? {} : { "content-type": contentType },
				}),
			);
			expect([response.status, await response.json()]).toEqual([400, refused]);
			expect(fake.pending()).toBe(1);
			const [record] = fake.recorder.takeRequests();
			expect(record?.headerNames).toEqual(contentType === null ? [] : ["content-type"]);
		},
	);

	it.each(["", "{", "null", "[]", '"DYTEST"', new Uint8Array([0xff])])(
		"refuses empty, malformed or non-UTF-8 JSON without echoing it",
		async (raw) => {
			const fake = createCompatibleDraftFake({ steps: steps() });
			const response = await fake.fetch(CHAT, post({ body: raw }));
			expect([response.status, await response.json()]).toEqual([400, refused]);
		},
	);

	it("refuses invalid UTF-8 a lossy decoder would turn into an exact request", async () => {
		const raw = encoder.encode(
			JSON.stringify({ ...SCHEMA_REQUEST, messages: [SYSTEM, { role: "user", content: "Z" }] }),
		);
		raw[raw.lastIndexOf(0x5a)] = 0xff;
		const fake = createCompatibleDraftFake({ steps: steps() });
		expect((await fake.fetch(CHAT, post({ body: raw }))).status).toBe(400);
		expect(fake.pending()).toBe(1);
	});

	it("refuses the core's exact request behind a UTF-8 byte order mark", async () => {
		const exact = encoder.encode(JSON.stringify(SCHEMA_REQUEST));
		const fake = createCompatibleDraftFake({ steps: steps() });
		const marked = await fake.fetch(
			CHAT,
			post({ body: new Uint8Array([0xef, 0xbb, 0xbf, ...exact]) }),
		);
		expect([marked.status, await marked.json()]).toEqual([400, refused]);
		expect(await json(fake.fetch(CHAT, post({ body: exact })))).toEqual({ reserved: 2 });
	});

	it("decodes UTF-8 split across upload chunks and keeps JSON.parse's last member", async () => {
		const text = JSON.stringify({
			...OLLAMA_REQUEST,
			messages: [SYSTEM, { role: "user", content: "DYTEST café 🦬" }],
		});
		const bytes = encoder.encode(text);
		let offset = 0;
		const upload = new ReadableStream<Uint8Array>({
			pull(controller) {
				if (offset === bytes.length) controller.close();
				else controller.enqueue(bytes.subarray(offset, ++offset));
			},
		});
		const fake = createCompatibleDraftFake({ steps: steps() });
		expect((await fake.fetch(OLLAMA, streamPost(upload))).status).toBe(200);
		const duplicate = text.replace('"model":', '"model":"dytest-ignored","model":');
		expect((await fake.fetch(OLLAMA, post({ body: duplicate }))).status).toBe(200);
	});

	it.each([0, 1])("admits the core's largest request whole (+%i)", async (extra) => {
		const empty = JSON.stringify({
			...SCHEMA_REQUEST,
			messages: [SYSTEM, { ...USER, content: "" }],
		});
		const content = "x".repeat(CAP - Buffer.byteLength(empty) + extra);
		const value = { ...SCHEMA_REQUEST, messages: [SYSTEM, { ...USER, content }] };
		const fake = createCompatibleDraftFake({ steps: steps() });
		const response = await fake.fetch(CHAT, request(value));
		expect(response.status).toBe(extra ? 413 : 200);
		expect(fake.pending()).toBe(extra ? 2 : 1);
		expect(fake.recorder.takeRequests()[0]?.bodyLength).toBe(CAP + extra);
	});

	it("answers exhaustion before checking a request and keeps routes and listings", async () => {
		const fake = createCompatibleDraftFake({ steps: [reply({})] });
		expect((await fake.fetch(`${CHAT}?`, request(SCHEMA_REQUEST))).status).toBe(404);
		expect((await fake.fetch(OLLAMA, { method: "GET" })).status).toBe(405);
		expect(await json(fake.fetch(TAGS))).toEqual(TAGGED);
		expect(fake.pending()).toBe(1);
		expect((await fake.fetch(OLLAMA, request(OLLAMA_REQUEST))).status).toBe(200);
		const exhausted = await fake.fetch(CHAT, post({ body: "{" }));
		expect([exhausted.status, await exhausted.json()]).toEqual([
			503,
			{ error: "script_exhausted" },
		]);
	});

	it("keeps before and after fault ownership for draft requests", async () => {
		const fake = createCompatibleDraftFake({ steps: steps() });
		fake.faults.add({ kind: "rate-limit", retryAfter: 3 });
		expect((await fake.fetch(CHAT, request({ ...SCHEMA_REQUEST, tools: [] }))).status).toBe(429);
		expect(fake.pending()).toBe(2);
		fake.faults.add({ kind: "server-error", after: true });
		expect((await fake.fetch(CHAT, request(SCHEMA_REQUEST))).status).toBe(503);
		expect(fake.pending()).toBe(1);
		expect(await json(fake.fetch(OLLAMA, request(OLLAMA_REQUEST)))).toEqual({ reserved: 2 });
	});

	it("leaves the generic fake script-only", async () => {
		const fake = createCompatibleFake({ steps: steps() });
		expect((await fake.fetch(CHAT, post({ body: "DYTEST not JSON" }))).status).toBe(200);
		expect((await fake.fetch(OLLAMA, request(SCHEMA_REQUEST))).status).toBe(200);
	});
});

describe("loopback listener", () => {
	it("serves both dialects and listings to real HTTP clients, then closes", async () => {
		const open = listeners();
		const fake = createCompatibleFake({
			steps: [
				reply(chatCompletionBody()),
				{ kind: "raw", body: "abcdef", chunkBytes: 2, chunkDelayMs: 1 },
			],
		});
		try {
			const listening = open.keep(await fake.listen());
			const { origin, port } = listening;
			expect(origin).toBe(`http://127.0.0.1:${port}`);
			expect(await json(fetch(`${origin}${CHAT}`, post()))).toEqual(chatCompletionBody());
			expect(await (await fetch(`${origin}${OLLAMA}`, post())).text()).toBe("abcdef");
			expect(await json(fetch(`${origin}${TAGS}`))).toEqual(TAGGED);
			expect(await getWithHost(listening, MODELS, `localhost:${port}`)).toEqual({
				status: 200,
				body: JSON.stringify(LISTED),
			});
			expect(
				fake.recorder.takeRequests().map(({ method, host, target }) => [method, host, target]),
			).toEqual([
				["POST", `127.0.0.1:${port}`, CHAT],
				["POST", `127.0.0.1:${port}`, OLLAMA],
				["GET", `127.0.0.1:${port}`, TAGS],
				["GET", `localhost:${port}`, MODELS],
			]);
			expect(fake.pending()).toBe(0);
			await listening.close();
			await listening.close();
			await expect(tryConnect("127.0.0.1", port)).rejects.toThrow();
		} finally {
			await open.closeAll();
		}
	});

	it("keeps raw targets and hosts over loopback", async () => {
		const open = listeners();
		const fake = createCompatibleFake({ steps: [reply({ order: 1 })] });
		try {
			const listening = open.keep(await fake.listen());
			expect(await rawGet(listening, "/v1/%6dodels", COMPATIBLE_HOST)).toBe(404);
			expect(await rawGet(listening, MODELS, COMPATIBLE_HOST)).toBe(200);
			expect((await getWithHost(listening, MODELS, "other.draftyak.example")).status).toBe(421);
			expect(fake.recorder.takeRequests().map(({ target }) => target)).toEqual([
				"/v1/%6dodels",
				MODELS,
				MODELS,
			]);
			expect(fake.pending()).toBe(1);
		} finally {
			await open.closeAll();
		}
	});

	it.each([0, 1])("applies the inclusive 8 MiB intake over loopback (+%i)", async (extra) => {
		const open = listeners();
		const fake = createCompatibleFake({ steps: [reply({ order: 1 })] });
		try {
			const { origin } = open.keep(await fake.listen());
			const response = await fetch(
				`${origin}${OLLAMA}`,
				post({ body: "{".padEnd(CAP + extra, " "), signal: AbortSignal.timeout(10_000) }),
			);
			expect(response.status).toBe(extra ? 413 : 200);
			await response.arrayBuffer();
			expect(fake.pending()).toBe(extra);
			expect(fake.recorder.takeRequests()[0]?.refused).toBe(
				extra ? "request_body_too_large" : undefined,
			);
		} finally {
			await open.closeAll();
		}
	});

	it("drops a loopback connection without taking a step", async () => {
		const open = listeners();
		const fake = createCompatibleFake({ steps: [reply({ order: 1 })] });
		try {
			const { origin } = open.keep(await fake.listen());
			fake.faults.add({ kind: "drop" });
			await expect(fetch(`${origin}${CHAT}`, post())).rejects.toThrow(TypeError);
			expect(fake.pending()).toBe(1);
			expect(await json(fetch(`${origin}${CHAT}`, post()))).toEqual({ order: 1 });
		} finally {
			await open.closeAll();
		}
	});
});
