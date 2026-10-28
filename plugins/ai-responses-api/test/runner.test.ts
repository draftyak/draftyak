import { PluginErrorCode } from "@draftyak/protocol/errors";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	API_URL,
	buildRequest,
	createClient,
	createCompletedTransport,
	generateDraft,
	ResponsesError,
	type ResponsesFetch,
} from "../src/index.ts";
import {
	CONSUMER_TIMEOUT_MS,
	MAX_ERROR_BYTES,
	MAX_EVENT_BYTES,
	MAX_FORWARDED_BYTES,
	MAX_RECORD_BYTES,
	MAX_WIRE_BYTES,
	MAX_WIRE_EVENTS,
	MAX_WIRE_READS,
	MAX_WIRE_RECORDS,
} from "../src/runner.ts";
import { CANARY, draft, input, message } from "./helpers.ts";

afterEach(() => vi.restoreAllMocks());

async function transportError(value: unknown): Promise<ResponsesError> {
	const error: unknown = await generateDraft(input, {}, async () => {
		throw value;
	}).catch((failure: unknown) => failure);
	expect(error).toBeInstanceOf(ResponsesError);
	const normalized = error as ResponsesError;
	expect(PluginErrorCode.safeParse(normalized.code).success).toBe(true);
	expect(normalized.message).toBe(`responses: ${normalized.code}`);
	expect(String(normalized)).not.toContain(CANARY);
	expect(JSON.stringify(normalized)).not.toContain(CANARY);
	expect(normalized).not.toHaveProperty("cause");
	expect(normalized).not.toHaveProperty("detail");
	return normalized;
}

describe("injected completed-response transport", () => {
	it("calls the injected transport once with the literal request shape and parses its completed response", async () => {
		const controller = new AbortController();
		const transport = vi.fn(async (request, options) => {
			expect(request).toEqual({
				method: "POST",
				url: API_URL,
				headers: { "content-type": "application/json", authorization: "Bearer brokered" },
				body: {
					model: input.model,
					instructions: input.system,
					input: [{ role: "user", content: input.prompt }],
					store: false,
					stream: true,
					text: {
						format: {
							type: "json_schema",
							name: "draft_output",
							strict: true,
							schema: expect.any(Object),
						},
					},
				},
			});
			expect(options.signal).toBe(controller.signal);
			return message();
		});
		expect((await generateDraft(input, {}, transport, controller.signal)).kind).toBe("draft");
		expect(transport).toHaveBeenCalledTimes(1);
	});
	it("performs no call after cancellation and exposes no transport error details", async () => {
		const transport = vi.fn(async () => {
			throw new Error(CANARY);
		});
		await expect(generateDraft(input, {}, transport)).rejects.toMatchObject({
			code: "TRANSIENT",
			message: "responses: TRANSIENT",
		});
		expect(transport).toHaveBeenCalledTimes(1);
		transport.mockClear();
		await expect(generateDraft(input, {}, transport, AbortSignal.abort())).rejects.toMatchObject({
			code: "ABORTED",
		});
		expect(transport).not.toHaveBeenCalled();
	});
	it("does not accept a response after mid-call cancellation", async () => {
		const controller = new AbortController();
		await expect(
			generateDraft(
				input,
				{},
				async () => {
					controller.abort(CANARY);
					return message();
				},
				controller.signal,
			),
		).rejects.toMatchObject({ code: "ABORTED" });
	});
	it.each([
		[{ status: 401, message: CANARY }, "AUTH_REVOKED"],
		[{ status: 403, detail: CANARY }, "PERMISSION_DENIED"],
		[{ status: 429, headers: { "retry-after": "2" } }, "RATE_LIMITED"],
		[{ status: 429, code: "insufficient_quota" }, "QUOTA_EXCEEDED"],
		[{ status: 503, cause: CANARY }, "TRANSIENT"],
		[{ name: "APIConnectionTimeoutError", message: CANARY }, "TRANSIENT"],
		[{ code: "ECONNRESET", message: CANARY }, "TRANSIENT"],
		[{ name: "AbortError", message: CANARY }, "TRANSIENT"],
		[{ code: "ABORTED", message: CANARY }, "TRANSIENT"],
		[{ error: { code: "rate_limit_exceeded", message: CANARY } }, "RATE_LIMITED"],
		[{ error: { code: "insufficient_quota", message: CANARY } }, "QUOTA_EXCEEDED"],
	])("normalizes transport failure %j to %s", async (value, code) => {
		expect((await transportError(value)).code).toBe(code);
	});
	it.each(PluginErrorCode.options)(
		"preserves canonical %s without provider details",
		async (code) => {
			const value = {
				code,
				status: 503,
				retryAfterMs: 17,
				message: CANARY,
				detail: CANARY,
				cause: new Error(CANARY),
			};
			const result = await transportError(value);
			expect(result).toMatchObject({ code, retryAfterMs: 17 });
			expect(result).not.toBe(value);
		},
	);
	it("preserves the SDK result envelope without exposing its detail or identity", async () => {
		const value = {
			result: { code: "RATE_LIMITED", retryAfterMs: 17, detail: CANARY },
			message: CANARY,
		};
		const result = await transportError(value);
		expect(result).toMatchObject({ code: "RATE_LIMITED", retryAfterMs: 17 });
		expect(result).not.toBe(value);
		expect(result).not.toHaveProperty("result");
	});
	it.each([0, Number.MAX_SAFE_INTEGER])(
		"preserves the safe direct retry boundary %s",
		async (retryAfterMs) => {
			const value = { code: "RATE_LIMITED", retryAfterMs };
			Object.defineProperty(value, "headers", {
				get: () => {
					throw new Error(CANARY);
				},
			});
			expect(await transportError(value)).toMatchObject({ code: "RATE_LIMITED", retryAfterMs });
		},
	);
	it.each([-1, Number.NaN, Number.POSITIVE_INFINITY, 1.5, Number.MAX_SAFE_INTEGER + 1, "2"])(
		"omits malformed retry hint %s without losing its valid code",
		async (retryAfterMs) => {
			const error = await transportError({ code: "QUOTA_EXCEEDED", retryAfterMs });
			expect(error.code).toBe("QUOTA_EXCEEDED");
			expect(error).not.toHaveProperty("retryAfterMs");
		},
	);
	it("parses integer and canonical HTTP-date retry metadata against a reference clock", async () => {
		const now = Date.UTC(2026, 0, 1);
		vi.spyOn(Date, "now").mockReturnValue(now);
		for (const [hint, retryAfterMs] of [
			["0", 0],
			[" \t2\t ", 2000],
			[new Date(now + 10_000).toUTCString(), 10_000],
			[new Date(now - 10_000).toUTCString(), 0],
		] as const) {
			for (const headers of [
				{ "retry-after": hint },
				{ "rEtRy-AfTeR": hint },
				new Headers({ "Retry-After": hint }),
			])
				expect(await transportError({ status: 429, headers })).toMatchObject({
					code: "RATE_LIMITED",
					retryAfterMs,
				});
		}
	});
	it("bounds plain header lookup and omits ambiguous case aliases", async () => {
		const headers = Object.fromEntries(
			Array.from({ length: 63 }, (_, index) => [`x-example-${index}`, "unused"]),
		);
		headers["RETRY-AFTER"] = "2";
		expect(await transportError({ status: 429, headers })).toMatchObject({ retryAfterMs: 2000 });
		for (const invalid of [
			{ ...headers, extra: "unused" },
			{ "retry-after": "1", "Retry-After": "2" },
		])
			expect(await transportError({ status: 429, headers: invalid })).not.toHaveProperty(
				"retryAfterMs",
			);
	});
	it.each([
		"1.5",
		"1e3",
		"+2",
		"-1",
		"Infinity",
		"9007199254740991",
		"2026-01-01",
		"Fri, 01 Jan 2026 00:00:10 GMT",
		"Thu, 32 Jan 2026 00:00:10 GMT",
		"Thu, 01 Jan 2026 00:00:10 GMT\r\n",
	])("omits unsupported Retry-After %s", async (hint) => {
		vi.spyOn(Date, "now").mockReturnValue(Date.UTC(2026, 0, 1));
		const error = await transportError({ status: 429, headers: { "retry-after": hint } });
		expect(error.code).toBe("RATE_LIMITED");
		expect(error).not.toHaveProperty("retryAfterMs");
	});
	it("keeps actual signal cancellation local even when transport throws a coded error", async () => {
		const controller = new AbortController();
		await expect(
			generateDraft(
				input,
				{},
				async () => {
					controller.abort(CANARY);
					throw { code: "RATE_LIMITED", detail: CANARY };
				},
				controller.signal,
			),
		).rejects.toMatchObject({ code: "ABORTED", message: "responses: ABORTED" });
	});
});

const encoder = new TextEncoder();
const headers = { "content-type": "text/event-stream; charset=utf-8" };
const fault = { code: "TRANSIENT", message: "responses: TRANSIENT" };
const completed = (response: Record<string, unknown> = message()): Record<string, unknown> => ({
	type: `response.${response.status}`,
	sequence_number: 0,
	response,
});
function event(value: unknown, ending = "\n", named = true): string {
	const type = typeof value === "object" && value !== null && "type" in value ? value.type : "";
	return `${named ? `event: ${type}${ending}` : ""}data: ${JSON.stringify(value)}${ending}${ending}`;
}
const terminal = (): string => event(completed());
function stream(chunks: readonly Uint8Array[], cancel?: () => void | Promise<void>): Response {
	let index = 0;
	return new Response(
		new ReadableStream<Uint8Array>(
			{
				pull(sink) {
					const chunk = chunks[index++];
					if (chunk) sink.enqueue(chunk);
					else sink.close();
				},
				cancel,
			},
			{ highWaterMark: 0 },
		),
		{ headers },
	);
}
function run(response: Response) {
	return generateDraft(
		input,
		{},
		createCompletedTransport(async () => response),
	);
}
const wire = (value: string): Response => stream([encoder.encode(value)]);

describe("bounded pinned-SDK completed transport", () => {
	beforeEach(() => {
		vi.stubGlobal(
			"fetch",
			vi.fn(() => {
				throw new Error("Global fetch forbidden");
			}),
		);
	});
	afterEach(() => {
		vi.useRealTimers();
		vi.restoreAllMocks();
		vi.unstubAllGlobals();
	});

	it("uses generateDraft's already-built request without rebuilding input or effort", async () => {
		let promptReads = 0;
		let effortReads = 0;
		const requestInput = {
			...input,
			get prompt(): string {
				return ++promptReads === 1 ? input.prompt : CANARY;
			},
		};
		const settings = {
			get effort(): "low" {
				effortReads++;
				return "low";
			},
		};
		const fetch = vi.fn<ResponsesFetch>(async (url, init) => {
			expect(String(url)).toBe("https://api.openai.com/v1/responses");
			expect(JSON.parse(String(init?.body))).toMatchObject({
				input: [{ role: "user", content: input.prompt }],
				reasoning: { effort: "low" },
				store: false,
				stream: true,
			});
			expect(init?.redirect).toBe("manual");
			expect(Object.fromEntries(new Headers(init?.headers))).toEqual({
				accept: "application/json",
				authorization: "Bearer brokered",
				"content-type": "application/json",
			});
			return wire(terminal());
		});
		await expect(
			generateDraft(requestInput, settings, createCompletedTransport(fetch)),
		).resolves.toMatchObject({ kind: "draft", output: draft });
		expect(promptReads).toBe(1);
		expect(effortReads).toBe(1);
		expect(fetch).toHaveBeenCalledTimes(1);
		expect(globalThis.fetch).not.toHaveBeenCalled();
	});
	it("sends the transport argument itself rather than captured DraftRequest values", async () => {
		const request = buildRequest({ ...input, prompt: "DYTEST separately built request" });
		const fetch = vi.fn<ResponsesFetch>(async (_url, init) => {
			expect(JSON.parse(String(init?.body))).toEqual(request.body);
			return wire(terminal());
		});
		await expect(createCompletedTransport(fetch)(request, {})).resolves.toEqual(message());
		expect(fetch).toHaveBeenCalledTimes(1);
	});
	it.each(["\n", "\r", "\r\n"])(
		"decodes %j endings split at every byte, including multibyte text",
		async (ending) => {
			const response = message({
				output: [
					{
						type: "message",
						role: "assistant",
						status: "completed",
						content: [
							{ type: "output_text", text: JSON.stringify({ ...draft, body: "Tuesday é." }) },
						],
					},
				],
			});
			const bytes = encoder.encode(event(completed(response), ending));
			await expect(
				run(stream([...bytes].map((byte) => Uint8Array.of(byte)))),
			).resolves.toMatchObject({ kind: "draft", output: { body: "Tuesday é." } });
		},
	);
	it("accepts an unnamed event and SDK's exactly-once unterminated EOF flush", async () => {
		const text = event(completed(), "\n", false).trimEnd();
		await expect(run(wire(text))).resolves.toMatchObject({ kind: "draft" });
	});
	it("accepts multiline data fields and optional DONE after one terminal", async () => {
		const json = JSON.stringify(completed());
		const firstComma = json.indexOf(",");
		const text = `data: ${json.slice(0, firstComma + 1)}\ndata: ${json.slice(firstComma + 1)}\n\ndata: [DONE]\n\n`;
		await expect(run(wire(text))).resolves.toMatchObject({ kind: "draft" });
	});
	it.each([
		[
			"invalid draft text",
			message({
				output: [
					{
						type: "message",
						role: "assistant",
						status: "completed",
						content: [{ type: "output_text", text: "{invalid" }],
					},
				],
			}),
			"invalid",
		],
		[
			"tool output",
			message({ output: [{ type: "function_call", name: "DYTEST forbidden" }] }),
			"unexpected",
		],
		[
			"refusal",
			message({ output: [{ type: "message", content: [{ type: "refusal", refusal: CANARY }] }] }),
			"refusal",
		],
		[
			"truncation",
			message({ status: "incomplete", incomplete_details: { reason: "max_output_tokens" } }),
			"truncated",
		],
		[
			"content filter",
			message({ status: "incomplete", incomplete_details: { reason: "content_filter" } }),
			"refusal",
		],
	] as const)(
		"passes %s only through the completed-response reader",
		async (_name, response, kind) => {
			await expect(run(wire(event(completed(response))))).resolves.toMatchObject({ kind });
		},
	);
	it("discards deltas without reconstructing output or executing tool calls", async () => {
		const text =
			event({ type: "response.output_text.delta", delta: CANARY }) +
			event({ type: "response.function_call_arguments.delta", delta: CANARY }) +
			terminal();
		await expect(run(wire(text))).resolves.toMatchObject({ kind: "draft", output: draft });
	});
	it("maps failed terminal errors before requiring model or usage", async () => {
		await expect(
			run(
				wire(
					event(
						completed({ status: "failed", error: { code: "insufficient_quota", message: CANARY } }),
					),
				),
			),
		).rejects.toMatchObject({ code: "QUOTA_EXCEEDED", message: "responses: QUOTA_EXCEEDED" });
	});
	it.each([
		["empty", ""],
		["no terminal", event({ type: "response.in_progress" })],
		["DONE alone", "data: [DONE]\n\n"],
		["duplicate terminal", terminal() + terminal()],
		["post-terminal delta", terminal() + event({ type: "response.output_text.delta", delta: "x" })],
		["duplicate DONE", `${terminal()}data: [DONE]\n\ndata: [DONE]\n\n`],
		["event after DONE", `${terminal()}data: [DONE]\n\n${terminal()}`],
		["named mismatch", `event: response.failed\ndata: ${JSON.stringify(completed())}\n\n`],
		[
			"status mismatch",
			event({ type: "response.completed", response: message({ status: "in_progress" }) }),
		],
		["missing response", event({ type: "response.completed" })],
		["null JSON", "data: null\n\n"],
		["bad JSON", `data: ${CANARY}\n\n`],
		["empty data", "event: response.completed\n\n"],
	] as const)("refuses %s as transport failure, never an invalid draft", async (_name, text) => {
		await expect(run(wire(text))).rejects.toMatchObject(fault);
	});
	it("refuses absent body and non-SSE successful bodies", async () => {
		await expect(run(new Response(null, { headers }))).rejects.toMatchObject(fault);
		await expect(
			run(new Response(terminal(), { headers: { "content-type": "application/json" } })),
		).rejects.toMatchObject(fault);
	});
	it.each(["invalid comment", "incomplete trailing code point"])(
		"refuses %s even beside a valid terminal",
		async (kind) => {
			const chunks =
				kind === "invalid comment"
					? [Uint8Array.of(58, 0xff, 10, 10), encoder.encode(terminal())]
					: [encoder.encode(terminal()), Uint8Array.of(58, 0xe2, 0x82)];
			await expect(run(stream(chunks))).rejects.toMatchObject(fault);
		},
	);
	it("refuses non-byte response chunks", async () => {
		const body = new ReadableStream({
			start(sink) {
				sink.enqueue("DYTEST wrong chunk type");
				sink.close();
			},
		});
		await expect(run(new Response(body, { headers }))).rejects.toMatchObject(fault);
	});
	it("bounds each forwarded slice before SDK buffering and UTF-8 decoding", async () => {
		const decode = vi.spyOn(TextDecoder.prototype, "decode");
		const text = `:${"x".repeat(MAX_FORWARDED_BYTES * 4)}\n${terminal()}`;
		await expect(run(wire(text))).resolves.toMatchObject({ kind: "draft" });
		const sizes = decode.mock.calls.flatMap(([chunk], index) => {
			const decoder = decode.mock.contexts[index] as TextDecoder | undefined;
			return decoder?.fatal && chunk && "byteLength" in chunk ? [chunk.byteLength] : [];
		});
		expect(Math.max(...sizes)).toBe(MAX_FORWARDED_BYTES);
	});
	it.each([0, 1])(
		"enforces independently reachable decoded event byte limit +%i",
		async (extra) => {
			const base = JSON.stringify({ type: "response.output_text.delta", delta: "" });
			const data = JSON.stringify({
				type: "response.output_text.delta",
				delta: "x".repeat(MAX_EVENT_BYTES - base.length + extra),
			});
			const result = run(wire(`data: ${data}\n\n${terminal()}`));
			if (extra) await expect(result).rejects.toMatchObject(fault);
			else await expect(result).resolves.toMatchObject({ kind: "draft" });
		},
	);
	it.each([0, 1])(
		"bounds a raw record containing ignored comments at exact limit +%i",
		async (extra) => {
			const end = terminal();
			const text = `:${"x".repeat(MAX_RECORD_BYTES - end.length - 2 + extra)}\n${end}`;
			const result = run(wire(text));
			if (extra) await expect(result).rejects.toMatchObject(fault);
			else await expect(result).resolves.toMatchObject({ kind: "draft" });
		},
	);
	it.each([0, 1])(
		"counts UTF-8 bytes and joined multiline LF before event JSON parsing +%i",
		async (extra) => {
			const prefix = '{"type":"response.output_text.delta",';
			const base = `${prefix}\n"delta":""}`;
			const room = MAX_EVENT_BYTES - base.length + extra;
			const delta = "é".repeat(Math.floor(room / 2)) + "x".repeat(room % 2);
			const data = `${prefix}\n"delta":${JSON.stringify(delta)}}`;
			expect(data.length).toBeLessThan(MAX_EVENT_BYTES);
			expect(Buffer.byteLength(data)).toBe(MAX_EVENT_BYTES + extra);
			const result = run(
				wire(`data: ${prefix}\ndata: "delta":${JSON.stringify(delta)}}\n\n${terminal()}`),
			);
			if (extra) await expect(result).rejects.toMatchObject(fault);
			else await expect(result).resolves.toMatchObject({ kind: "draft" });
		},
	);
	it.each([0, 1])(
		"counts the complete split CRLF delimiter in raw record limit +%i",
		async (extra) => {
			const end = event(completed(), "\r\n");
			const text = `:${"x".repeat(MAX_RECORD_BYTES - end.length - 3 + extra)}\r\n${end}`;
			const bytes = encoder.encode(text);
			const result = run(stream([bytes.subarray(0, bytes.length - 1), bytes.subarray(-1)]));
			if (extra) await expect(result).rejects.toMatchObject(fault);
			else await expect(result).resolves.toMatchObject({ kind: "draft" });
		},
	);
	it("does not mistake split CRLF single line endings for blank records", async () => {
		const line = `:${"x".repeat(1021)}\r\n`;
		const bytes = encoder.encode(
			line.repeat(Math.floor(MAX_RECORD_BYTES / line.length) + 1) + terminal(),
		);
		const chunks: Uint8Array[] = [];
		for (let offset = 0; offset < bytes.length; offset += 1023)
			chunks.push(bytes.subarray(offset, offset + 1023));
		await expect(run(stream(chunks))).rejects.toMatchObject(fault);
	});
	it.each([0, 1])("bounds total comment-only carry before a real terminal +%i", async (extra) => {
		const end = terminal();
		const unit = 1024 * 1024;
		const part = `:${"x".repeat(unit - 3)}\n\n`;
		const tail = MAX_WIRE_BYTES - part.length * 7 - end.length;
		const text = `${part.repeat(7)}:${"x".repeat(tail - 3 + extra)}\n\n${end}`;
		const result = run(wire(text));
		if (extra) await expect(result).rejects.toMatchObject(fault);
		else await expect(result).resolves.toMatchObject({ kind: "draft" });
	});
	it.each([0, 1])("counts raw comment records which emit no SDK event +%i", async (extra) => {
		const text = ":\n\n".repeat(MAX_WIRE_RECORDS - 1 + extra) + terminal();
		const result = run(wire(text));
		if (extra) await expect(result).rejects.toMatchObject(fault);
		else await expect(result).resolves.toMatchObject({ kind: "draft" });
	});
	it.each([0, 1])("counts the SDK-flushed unterminated EOF record +%i", async (extra) => {
		const text = ":\n\n".repeat(MAX_WIRE_RECORDS - 1 + extra) + terminal().trimEnd();
		const result = run(wire(text));
		if (extra) await expect(result).rejects.toMatchObject(fault);
		else await expect(result).resolves.toMatchObject({ kind: "draft" });
	});
	it.each([0, 1])(
		"bounds decoded event count independently of raw bytes/records +%i",
		async (extra) => {
			const text =
				event({ type: "response.output_text.delta", delta: "x" }).repeat(
					MAX_WIRE_EVENTS - 1 + extra,
				) + terminal();
			const result = run(wire(text));
			if (extra) await expect(result).rejects.toMatchObject(fault);
			else await expect(result).resolves.toMatchObject({ kind: "draft" });
		},
	);
	it.each([0, 1])("bounds zero-byte source reads before a valid terminal +%i", async (extra) => {
		let index = 0;
		const empty = MAX_WIRE_READS - 2 + extra;
		const body = new ReadableStream<Uint8Array>(
			{
				pull(sink) {
					if (index++ < empty) sink.enqueue(new Uint8Array());
					else if (index === empty + 1) sink.enqueue(encoder.encode(terminal()));
					else sink.close();
				},
			},
			{ highWaterMark: 0 },
		);
		const result = run(new Response(body, { headers }));
		if (extra) await expect(result).rejects.toMatchObject(fault);
		else await expect(result).resolves.toMatchObject({ kind: "draft" });
	});
	it.each([
		[401, { message: CANARY }, "AUTH_REVOKED"],
		[403, { error: { message: CANARY } }, "PERMISSION_DENIED"],
		[429, { error: { code: "insufficient_quota", message: CANARY } }, "QUOTA_EXCEEDED"],
		[503, { error: { code: "rate_limit_exceeded", message: CANARY } }, "RATE_LIMITED"],
		[503, { result: { code: "AUTH_EXPIRED", retryAfterMs: 0 } }, "AUTH_EXPIRED"],
	] as const)("maps bounded HTTP %i errors with safe retry hints", async (status, error, code) => {
		const result = run(
			new Response(JSON.stringify(error), { status, headers: { "retry-after": "2" } }),
		);
		await expect(result).rejects.toMatchObject({
			code,
			retryAfterMs: code === "AUTH_EXPIRED" ? 0 : 2000,
			message: `responses: ${code}`,
		});
	});
	it.each(["", CANARY])("maps HTTP status when its bounded body is not JSON: %s", async (text) => {
		await expect(run(new Response(text, { status: 401 }))).rejects.toMatchObject({
			code: "AUTH_REVOKED",
		});
	});
	it.each([0, 1])("bounds non-2xx body before JSON parsing +%i", async (extra) => {
		const base = JSON.stringify({ error: { code: "invalid_api_key", message: "" } });
		const text = JSON.stringify({
			error: {
				code: "invalid_api_key",
				message: "x".repeat(MAX_ERROR_BYTES - base.length + extra),
			},
		});
		await expect(run(new Response(text, { status: 401 }))).rejects.toMatchObject(
			extra ? fault : { code: "AUTH_REVOKED" },
		);
	});
	it("normalizes a provider error event and never logs provider data", async () => {
		const logs = [
			vi.spyOn(console, "debug"),
			vi.spyOn(console, "info"),
			vi.spyOn(console, "warn"),
			vi.spyOn(console, "error"),
		];
		const result: unknown = await run(
			wire(event({ type: "error", code: "rate_limit_exceeded", message: CANARY })),
		).catch((error: unknown) => error);
		expect(result).toMatchObject({ code: "RATE_LIMITED", message: "responses: RATE_LIMITED" });
		expect(result).not.toHaveProperty("cause");
		expect(result).not.toHaveProperty("detail");
		expect(JSON.stringify(result, Object.getOwnPropertyNames(result))).not.toContain(CANARY);
		for (const log of logs) expect(log).not.toHaveBeenCalled();
	});
	it("keeps trailing read failures after a valid terminal content-free", async () => {
		let reads = 0;
		const body = new ReadableStream<Uint8Array>(
			{
				pull(sink) {
					if (++reads === 1) sink.enqueue(encoder.encode(terminal()));
					else throw new Error(CANARY);
				},
			},
			{ highWaterMark: 0 },
		);
		await expect(run(new Response(body, { headers }))).rejects.toMatchObject(fault);
	});
	it("rejects malformed UTF-8 in an HTTP error before optional JSON parsing", async () => {
		await expect(run(new Response(Uint8Array.of(0xff), { status: 401 }))).rejects.toMatchObject(
			fault,
		);
	});
	it.each(["throw", "reject"])(
		"does not let a %s from cancellation replace caller abort",
		async (kind) => {
			const caller = new AbortController();
			let reading: () => void = () => {};
			const waiting = new Promise<void>((resolve) => {
				reading = resolve;
			});
			const body = new ReadableStream<Uint8Array>(
				{
					pull() {
						reading();
						return new Promise<void>(() => {});
					},
					cancel() {
						if (kind === "throw") throw new Error(CANARY);
						return Promise.reject(new Error(CANARY));
					},
				},
				{ highWaterMark: 0 },
			);
			const result = generateDraft(
				input,
				{},
				createCompletedTransport(async () => new Response(body, { headers })),
				caller.signal,
			);
			await waiting;
			caller.abort(CANARY);
			await expect(result).rejects.toMatchObject({
				code: "ABORTED",
				message: "responses: ABORTED",
			});
		},
	);
	it("waits beyond the first terminal and lets caller abort win a pending EOF", async () => {
		const caller = new AbortController();
		let reads = 0;
		let cancels = 0;
		let reading: () => void = () => {};
		const waiting = new Promise<void>((resolve) => {
			reading = resolve;
		});
		let release: () => void = () => {};
		const cleanup = new Promise<void>((resolve) => {
			release = resolve;
		});
		const body = new ReadableStream<Uint8Array>(
			{
				pull(sink) {
					if (++reads === 1) sink.enqueue(encoder.encode(terminal()));
					else {
						reading();
						return new Promise<void>(() => {});
					}
				},
				cancel() {
					cancels++;
					return cleanup;
				},
			},
			{ highWaterMark: 0 },
		);
		const result = generateDraft(
			input,
			{},
			createCompletedTransport(async () => new Response(body, { headers })),
			caller.signal,
		);
		await waiting;
		caller.abort(CANARY);
		try {
			await expect(
				Promise.race([
					result.catch((error: unknown) => error),
					new Promise((resolve) => setImmediate(() => resolve("cleanup blocked"))),
				]),
			).resolves.toMatchObject({ code: "ABORTED", message: "responses: ABORTED" });
			expect(cancels).toBe(1);
		} finally {
			release();
		}
	});
	it.each(["raw", "completed"] as const)(
		"bounds SDK timers only for the %s client path",
		async (mode) => {
			vi.useFakeTimers();
			const schedules = vi.spyOn(globalThis, "setTimeout");
			const clears = vi.spyOn(globalThis, "clearTimeout");
			let deliver: (response: Response) => void = () => {};
			let sdkHandle: ReturnType<typeof setTimeout> | undefined;
			const fetch = vi.fn<ResponsesFetch>(
				() =>
					new Promise<Response>((resolve) => {
						deliver = resolve;
					}),
			);
			const result =
				mode === "raw"
					? createClient(fetch).send(input)
					: createCompletedTransport(fetch)(buildRequest(input), {});
			let observed: unknown;
			void result.then(
				(value) => {
					observed = value;
				},
				(error: unknown) => {
					observed = error;
				},
			);
			try {
				await vi.advanceTimersByTimeAsync(0);
				expect(fetch).toHaveBeenCalledTimes(1);
				const delays = schedules.mock.calls.map(([, milliseconds]) => milliseconds);
				if (mode === "raw") expect(delays).toEqual([600_000]);
				else {
					expect(delays).not.toContain(600_000);
					expect(delays.filter((delay) => delay === CONSUMER_TIMEOUT_MS)).toHaveLength(2);
				}
				const sdkIndex = delays.lastIndexOf(mode === "raw" ? 600_000 : CONSUMER_TIMEOUT_MS);
				sdkHandle = schedules.mock.results[sdkIndex]?.value;
				expect(sdkHandle).toBeDefined();
				if (mode === "completed") {
					await vi.advanceTimersByTimeAsync(CONSUMER_TIMEOUT_MS);
					expect(observed).toMatchObject(fault);
				}
			} finally {
				deliver(new Response(null));
				await vi.advanceTimersByTimeAsync(0);
				const cleared = clears.mock.calls.some(([handle]) => handle === sdkHandle);
				schedules.mockRestore();
				clears.mockRestore();
				expect(cleared).toBe(true);
			}
		},
	);
	it.each(["deadline", "caller-abort"] as const)(
		"direct completed transport keeps %s cancellation provenance",
		async (mode) => {
			vi.useFakeTimers();
			const caller = new AbortController();
			let sdkSignal: AbortSignal | null | undefined;
			let deliver: (response: Response) => void = () => {};
			const fetch = vi.fn<ResponsesFetch>((_url, init) => {
				sdkSignal = init?.signal;
				return new Promise<Response>((resolve) => {
					deliver = resolve;
				});
			});
			let observed: unknown;
			const result = createCompletedTransport(fetch)(buildRequest(input), {
				signal: caller.signal,
			});
			void result.then(
				(value) => {
					observed = value;
				},
				(error: unknown) => {
					observed = error;
				},
			);
			try {
				await vi.advanceTimersByTimeAsync(0);
				expect(fetch).toHaveBeenCalledTimes(1);
				if (mode === "caller-abort") caller.abort(CANARY);
				await vi.advanceTimersByTimeAsync(mode === "deadline" ? CONSUMER_TIMEOUT_MS : 0);
				const code = mode === "deadline" ? "TRANSIENT" : "ABORTED";
				expect(observed).toMatchObject({ code, message: `responses: ${code}` });
				expect(caller.signal.aborted).toBe(mode === "caller-abort");
				expect(sdkSignal?.aborted).toBe(true);
				expect(observed).not.toHaveProperty("cause");
				expect(observed).not.toHaveProperty("detail");
				expect(globalThis.fetch).not.toHaveBeenCalled();
			} finally {
				deliver(new Response(null));
				await vi.advanceTimersByTimeAsync(0);
			}
		},
	);
	it("keeps internal consumer deadline TRANSIENT even when SDK fetch ignores abort", async () => {
		vi.useFakeTimers();
		let deliver: (response: Response) => void = () => {};
		let cancels = 0;
		const fetch = vi.fn<ResponsesFetch>(
			() =>
				new Promise((resolve) => {
					deliver = resolve;
				}),
		);
		const result = generateDraft(input, {}, createCompletedTransport(fetch));
		const assertion = expect(result).rejects.toMatchObject(fault);
		await vi.advanceTimersByTimeAsync(CONSUMER_TIMEOUT_MS);
		await assertion;
		expect(fetch).toHaveBeenCalledTimes(1);
		deliver(
			new Response(
				new ReadableStream(
					{
						cancel() {
							cancels++;
						},
					},
					{ highWaterMark: 0 },
				),
				{ headers },
			),
		);
		await vi.advanceTimersByTimeAsync(0);
		expect(cancels).toBe(1);
	});
	it("times out a pending body read without awaiting its cancellation", async () => {
		vi.useFakeTimers();
		let cancels = 0;
		const body = new ReadableStream(
			{
				pull: () => new Promise<void>(() => {}),
				cancel() {
					cancels++;
					return new Promise<void>(() => {});
				},
			},
			{ highWaterMark: 0 },
		);
		const result = run(new Response(body, { headers }));
		const assertion = expect(result).rejects.toMatchObject(fault);
		await vi.advanceTimersByTimeAsync(CONSUMER_TIMEOUT_MS);
		await assertion;
		expect(cancels).toBe(1);
	});
	it("keeps cancellation local to one concurrent consumer", async () => {
		const caller = new AbortController();
		const fetch = vi.fn<ResponsesFetch>(async (_url, init) => {
			if (JSON.parse(String(init?.body)).input[0].content === "first") {
				caller.abort(CANARY);
				return wire(terminal());
			}
			return wire(terminal());
		});
		const transport = createCompletedTransport(fetch);
		const outcomes = await Promise.allSettled([
			generateDraft({ ...input, prompt: "first" }, {}, transport, caller.signal),
			generateDraft({ ...input, prompt: "second" }, {}, transport),
		]);
		expect(outcomes[0]).toMatchObject({ status: "rejected", reason: { code: "ABORTED" } });
		expect(outcomes[1]).toMatchObject({ status: "fulfilled", value: { kind: "draft" } });
	});
});
