import { createHash } from "node:crypto";
import { getEventListeners } from "node:events";
import { setImmediate } from "node:timers/promises";
import { describe, expect, it, vi } from "vitest";
import { httpDate, manualClock } from "../src/faults.ts";
import {
	createMessagesApiDraftFake,
	createMessagesApiFake,
	type MessagesApiEvent,
	type MessagesApiStep,
} from "../src/messages-api.ts";
import { createRecorder } from "../src/recorder.ts";

const START = Date.UTC(2026, 9, 19, 8);
const DRAFT = {
	body: "Synthetic reply with café and 🦬.",
	ownerNotes: "Synthetic note.",
	needsOwnerInput: [],
	suspectedInstructions: false,
	contextRefs: [],
};
const REQUEST = {
	model: "claude-opus-5-5",
	max_tokens: 128,
	stream: false,
	system: "Synthetic owner instruction.",
	messages: [{ role: "user", content: "Synthetic incoming message." }],
};

function message(text: string = JSON.stringify(DRAFT), stopReason: string = "end_turn") {
	return {
		id: "msg_synthetic",
		type: "message",
		role: "assistant",
		model: "claude-opus-5-5",
		content: [{ type: "text", text }],
		stop_reason: stopReason,
		stop_sequence: null,
		usage: { input_tokens: 30, output_tokens: 12 },
	};
}

function events(): MessagesApiEvent[] {
	const text = JSON.stringify(DRAFT);
	return [
		{
			event: "message_start",
			data: {
				type: "message_start",
				message: {
					...message(),
					content: [],
					stop_reason: null,
					usage: { input_tokens: 30, output_tokens: 0 },
				},
			},
		},
		{ event: "ping", data: { type: "ping" } },
		{
			event: "content_block_start",
			data: { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
		},
		{
			event: "content_block_delta",
			data: { type: "content_block_delta", index: 0, delta: { type: "text_delta", text } },
		},
		{ event: "content_block_stop", data: { type: "content_block_stop", index: 0 } },
		{
			event: "message_delta",
			data: {
				type: "message_delta",
				delta: { stop_reason: "end_turn", stop_sequence: null },
				usage: { output_tokens: 12 },
			},
		},
		{ event: "message_stop", data: { type: "message_stop" } },
	];
}

function wire(input: readonly MessagesApiEvent[]): string {
	return input
		.map(({ event, data }) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`)
		.join("");
}

function post(extra: RequestInit = {}): RequestInit {
	return {
		method: "POST",
		headers: {
			"content-type": "application/json",
			"x-api-key": "brokered",
			"anthropic-version": "2023-06-01",
		},
		body: JSON.stringify(REQUEST),
		...extra,
	};
}

describe("Messages API wire fake", () => {
	it.each(["/v1/messages", "/v1/messages?beta=true"])(
		"answers the exact stable and beta target %s without vendor traffic",
		async (target) => {
			const realFetch = vi
				.spyOn(globalThis, "fetch")
				.mockRejectedValue(new Error("No vendor egress"));
			try {
				const fake = createMessagesApiFake({
					clock: manualClock(START),
					steps: [{ kind: "json", body: message() }],
				});
				const response = await fake.fetch(target, post());
				expect(response.status).toBe(200);
				expect(response.headers.get("content-type")).toBe("application/json");
				expect(response.headers.get("date")).toBe(httpDate(START));
				expect(await response.json()).toEqual(message());
				expect(fake.host).toBe("api.anthropic.com");
				expect(fake.pending()).toBe(0);
				expect(realFetch).not.toHaveBeenCalled();
			} finally {
				realFetch.mockRestore();
			}
		},
	);

	it.each([
		["GET", "/v1/messages", 405],
		["DELETE", "/v1/messages?beta=true", 405],
		["POST", "/v1/messages?", 404],
		["POST", "/v1/messages?beta=false", 404],
		["POST", "/v1/messages?beta=true&extra=1", 404],
		["POST", "/v1/%6dessages", 404],
		["POST", "/v1/extra/../messages", 404],
		["POST", "/v1/messages#fragment", 404],
	] as const)("does not consume a step for %s %s", async (method, target, status) => {
		const fake = createMessagesApiFake({ steps: [{ kind: "json", body: message() }] });
		const response = await fake.fetch(target, { method });
		expect(response.status).toBe(status);
		expect(fake.pending()).toBe(1);
		expect((await fake.fetch("/v1/messages", post())).status).toBe(200);
	});

	it("uses the shared loopback listener and closes it after an actual HTTP request", async () => {
		const fake = createMessagesApiFake({ steps: [{ kind: "json", body: message() }] });
		const listening = await fake.listen();
		try {
			expect(listening.origin).toBe(`http://127.0.0.1:${listening.port}`);
			const response = await fetch(`${listening.origin}/v1/messages?beta=true`, post());
			expect(await response.json()).toEqual(message());
			expect(
				fake.recorder.takeRequests().map(({ method, target }) => ({ method, target })),
			).toEqual([{ method: "POST", target: "/v1/messages?beta=true" }]);
		} finally {
			await listening.close();
		}
		await listening.close();
	});

	it.each([
		["benign", message(), 0],
		[
			"obedient",
			message(JSON.stringify({ ...DRAFT, body: "Synthetic injected instruction followed." })),
			0,
		],
		["schema-breaking", message(JSON.stringify({ unexpected: true })), 0],
		["refusing", message("Synthetic refusal.", "refusal"), 0],
		["slow", message(), 5],
	] as const)(
		"produces the %s profile as actual JSON wire bytes",
		async (_name, expected, delayMs) => {
			const fake = createMessagesApiFake({ steps: [{ kind: "json", body: expected, delayMs }] });
			const response = await fake.fetch("/v1/messages", post());
			expect(await response.json()).toEqual(expected);
		},
	);

	it.each([
		[401, "authentication_error"],
		[403, "permission_error"],
		[402, "billing_error"],
		[429, "rate_limit_error"],
		[500, "api_error"],
		[529, "overloaded_error"],
	] as const)(
		"produces a scripted %s %s envelope without rewriting error data",
		async (status, type) => {
			const expected = { type: "error", error: { type, message: "Synthetic provider error" } };
			const fake = createMessagesApiFake({ steps: [{ kind: "json", status, body: expected }] });
			const response = await fake.fetch("/v1/messages", post());
			expect([response.status, await response.json()]).toEqual([status, expected]);
		},
	);

	it.each(["3", httpDate(START + 3_000)])(
		"keeps scripted Retry-After %s and a deterministic Date",
		async (hint) => {
			const fake = createMessagesApiFake({
				clock: manualClock(START),
				steps: [
					{
						kind: "json",
						status: 429,
						headers: { "retry-after": hint },
						body: {
							type: "error",
							error: { type: "rate_limit_error", message: "Synthetic limit" },
						},
					},
				],
			});
			const response = await fake.fetch("/v1/messages", post());
			expect(response.headers.get("retry-after")).toBe(hint);
			expect(response.headers.get("date")).toBe(httpDate(START));
		},
	);

	it.each(["max_tokens", "tool_use", "pause_turn", "refusal"])(
		"preserves stop_reason %s for the consumer",
		async (reason) => {
			const fake = createMessagesApiFake({
				steps: [{ kind: "json", body: message("Synthetic text", reason) }],
			});
			expect(await (await fake.fetch("/v1/messages", post())).json()).toEqual(
				message("Synthetic text", reason),
			);
		},
	);

	it("produces tool blocks, malformed JSON and a truncated SSE without repairing them", async () => {
		const tool = {
			...message("", "tool_use"),
			content: [
				{
					type: "tool_use",
					id: "tool_synthetic",
					name: "synthetic_tool",
					input: { synthetic: true },
				},
			],
		};
		const truncated = wire(events().slice(0, -2));
		const fake = createMessagesApiFake({
			steps: [
				{ kind: "json", body: tool },
				{ kind: "raw", body: '{"type":"message",', contentType: "application/json" },
				{ kind: "raw", body: truncated, contentType: "text/event-stream" },
			],
		});
		expect(await (await fake.fetch("/v1/messages", post())).json()).toEqual(tool);
		expect(await (await fake.fetch("/v1/messages", post())).text()).toBe('{"type":"message",');
		expect(await (await fake.fetch("/v1/messages", post())).text()).toBe(truncated);
		expect(truncated).not.toContain("event: message_stop");
	});

	it("emits scripted finite SSE event order with byte-fragmented UTF-8 data", async () => {
		const expected = events();
		const fake = createMessagesApiFake({
			steps: [{ kind: "sse", events: expected, chunkBytes: 1 }],
		});
		const response = await fake.fetch(
			"/v1/messages",
			post({ body: JSON.stringify({ ...REQUEST, stream: true }) }),
		);
		expect(response.headers.get("content-type")).toBe("text/event-stream; charset=utf-8");
		const text = await response.text();
		expect(text).toBe(wire(expected));
		const parsed = text
			.trimEnd()
			.split("\n\n")
			.map((frame) => {
				const [event, data] = frame.split("\n");
				return { event: event?.slice(7), data: JSON.parse(data?.slice(6) ?? "null") };
			});
		expect(parsed).toEqual(expected);
		expect(text).toContain("café and 🦬");
	});

	it("preserves streaming tool input and error events in their exact order", async () => {
		const scripted = [
			{
				event: "content_block_start",
				data: {
					type: "content_block_start",
					index: 0,
					content_block: {
						type: "tool_use",
						id: "tool_synthetic",
						name: "synthetic_tool",
						input: {},
					},
				},
			},
			{
				event: "content_block_delta",
				data: {
					type: "content_block_delta",
					index: 0,
					delta: { type: "input_json_delta", partial_json: '{"synthetic":true}' },
				},
			},
			{
				event: "error",
				data: {
					type: "error",
					error: { type: "overloaded_error", message: "Synthetic stream stop" },
				},
			},
		];
		const fake = createMessagesApiFake({
			steps: [{ kind: "sse", events: scripted, chunkBytes: 17, chunkDelayMs: 1 }],
		});
		expect(await (await fake.fetch("/v1/messages", post())).text()).toBe(wire(scripted));
	});

	it("records exact fields, body bytes and full hash while header values are opt-in", async () => {
		const text = JSON.stringify(REQUEST);
		const recorder = createRecorder({ headerValues: ["anthropic-version"], maxBodyBytes: 7 });
		const fake = createMessagesApiFake({ recorder, steps: [{ kind: "json", body: message() }] });
		await fake.fetch("/v1/messages?beta=true", post());
		const [recorded] = recorder.takeRequests();
		expect(recorded).toMatchObject({
			method: "POST",
			host: "api.anthropic.com",
			target: "/v1/messages?beta=true",
			path: "/v1/messages",
			query: "beta=true",
			headerNames: ["anthropic-version", "content-type", "x-api-key"],
			headers: { "anthropic-version": "2023-06-01" },
			bodyLength: Buffer.byteLength(text),
			bodySha256: createHash("sha256").update(text).digest("hex"),
		});
		expect(recorded?.body).toEqual(new TextEncoder().encode(text).slice(0, 7));
		expect(JSON.stringify(recorded?.headers)).not.toContain("brokered");
		expect(recorder.takeRequests()).toEqual([]);
	});

	it("detaches JSON, SSE, headers and the initial array at enqueue", async () => {
		const payload = { value: "before" };
		const event = { event: "message_stop", data: { type: "message_stop", value: "before" } };
		const headers = new Headers({ "x-synthetic": "before" });
		const initial: MessagesApiStep[] = [{ kind: "json", body: payload, headers }];
		const fake = createMessagesApiFake({ steps: initial });
		fake.enqueue({ kind: "sse", events: [event] });
		initial.length = 0;
		payload.value = "after";
		event.data.value = "after";
		headers.set("x-synthetic", "after");
		const response = await fake.fetch("/v1/messages", post());
		expect(response.headers.get("x-synthetic")).toBe("before");
		expect(await response.json()).toEqual({ value: "before" });
		expect(await (await fake.fetch("/v1/messages", post())).text()).toBe(
			wire([{ event: "message_stop", data: { type: "message_stop", value: "before" } }]),
		);
	});

	it("admits after bounded upload completion while the recorder keeps original arrival order", async () => {
		const fake = createMessagesApiFake({
			steps: [
				{ kind: "json", body: { slot: 1 } },
				{ kind: "json", body: { slot: 2 } },
			],
		});
		let upload: ReadableStreamDefaultController<Uint8Array> | undefined;
		const first = fake.fetch("/v1/messages", {
			method: "POST",
			body: new ReadableStream<Uint8Array>({
				start(controller) {
					upload = controller;
				},
			}),
			duplex: "half",
		} as RequestInit);
		try {
			expect(fake.pending()).toBe(2);
			const second = await fake.fetch("/v1/messages?beta=true", post());
			expect(await second.json()).toEqual({ slot: 1 });
			expect(fake.recorder.takeRequests()).toEqual([]);
		} finally {
			upload?.enqueue(new TextEncoder().encode('{"synthetic":true}'));
			upload?.close();
			await first;
		}
		expect(await (await first).json()).toEqual({ slot: 2 });
		expect(fake.recorder.takeRequests().map(({ target }) => target)).toEqual([
			"/v1/messages",
			"/v1/messages?beta=true",
		]);
	});

	it("discards a failed intake record without consuming a script or constructing a stream", async () => {
		const fake = createMessagesApiFake({
			steps: [{ kind: "raw", body: "abcdef", chunkBytes: 1, chunkDelayMs: Infinity }],
		});
		const failure = new Error("Synthetic upload failed");
		const request = new Request("https://api.anthropic.com/v1/messages", {
			...post(),
			body: new ReadableStream<Uint8Array>({
				start(controller) {
					controller.error(failure);
				},
			}),
			duplex: "half",
		} as RequestInit);
		await expect(fake.fetch(request)).rejects.toBe(failure);
		await setImmediate();
		expect(fake.pending()).toBe(1);
		expect(fake.recorder.takeRequests()).toEqual([]);
		expect(
			getEventListeners(request.signal, "abort").filter((listener) => listener.name === "abort"),
		).toEqual([]);
	});

	it("takes scripts at app admission, so a before-fault bypasses but an after-fault consumes", async () => {
		const fake = createMessagesApiFake({
			steps: [
				{ kind: "json", body: { slot: 1 } },
				{ kind: "json", body: { slot: 2 } },
			],
		});
		fake.faults.add({ kind: "rate-limit", retryAfter: 2 });
		expect((await fake.fetch("/v1/messages", post())).status).toBe(429);
		expect(fake.pending()).toBe(2);
		fake.faults.add({ kind: "server-error", after: true });
		expect((await fake.fetch("/v1/messages", post())).status).toBe(503);
		expect(fake.pending()).toBe(1);
		expect(await (await fake.fetch("/v1/messages", post())).json()).toEqual({ slot: 2 });
	});

	it("does not claim whole-Fake FIFO when a pre-app latency fault reorders admission", async () => {
		const fake = createMessagesApiFake({
			steps: [
				{ kind: "json", body: { slot: 1 } },
				{ kind: "json", body: { slot: 2 } },
			],
		});
		fake.faults.add({ kind: "latency", ms: 10 });
		const first = fake.fetch("/v1/messages", post());
		const second = fake.fetch("/v1/messages?beta=true", post());
		expect(await (await second).json()).toEqual({ slot: 1 });
		expect(await (await first).json()).toEqual({ slot: 2 });
		expect(fake.recorder.takeRequests().map(({ target }) => target)).toEqual([
			"/v1/messages",
			"/v1/messages?beta=true",
		]);
	});

	it.each(["server-error", "drop"] as const)(
		"cancels an unobserved stream replaced by an after %s fault",
		async (kind) => {
			const fake = createMessagesApiFake({
				steps: [{ kind: "raw", body: "abcdef", chunkBytes: 1, chunkDelayMs: Infinity }],
			});
			const cancel = vi.spyOn(ReadableStream.prototype, "cancel");
			try {
				fake.faults.add({ kind, after: true });
				if (kind === "drop")
					await expect(fake.fetch("/v1/messages", post())).rejects.toThrow("fetch failed");
				else {
					const response = await fake.fetch("/v1/messages", post());
					expect(response.status).toBe(503);
					await response.text();
				}
				await setImmediate();
				expect(cancel).toHaveBeenCalledOnce();
				const discarded = cancel.mock.contexts[0];
				if (!(discarded instanceof ReadableStream)) throw new Error("No discarded stream");
				expect(await discarded.getReader().read()).toEqual({ done: true, value: undefined });
				expect(fake.pending()).toBe(0);
			} finally {
				cancel.mockRestore();
			}
		},
	);

	it("finishes when scripts run out and supports later explicit enqueue", async () => {
		const fake = createMessagesApiFake();
		const empty = await fake.fetch("/v1/messages", post());
		expect([empty.status, await empty.json()]).toEqual([
			503,
			{ type: "error", error: { type: "overloaded_error", message: "Synthetic script exhausted" } },
		]);
		expect(fake.pending()).toBe(0);
		fake.enqueue({ kind: "json", body: message() });
		expect(await (await fake.fetch("/v1/messages", post())).json()).toEqual(message());
	});

	it("aborts a slow pre-response wait and retains no script reservation", async () => {
		const fake = createMessagesApiFake({
			steps: [{ kind: "json", body: message(), delayMs: Infinity }],
		});
		const abort = new AbortController();
		const reason = new Error("Synthetic request stopped");
		const pending = fake.fetch("/v1/messages", post({ signal: abort.signal }));
		const refused = expect(pending).rejects.toBe(reason);
		await setImmediate();
		abort.abort(reason);
		await refused;
		expect(fake.pending()).toBe(0);
		fake.enqueue({ kind: "json", body: message() });
		expect((await fake.fetch("/v1/messages", post())).status).toBe(200);
	});

	it("request abort rejects a chunk wait and prevents late response bytes", async () => {
		const fake = createMessagesApiFake({
			steps: [{ kind: "raw", body: "abcdef", chunkBytes: 1, chunkDelayMs: Infinity }],
		});
		const abort = new AbortController();
		const response = await fake.fetch("/v1/messages", post({ signal: abort.signal }));
		const reader = response.body?.getReader();
		expect(await reader?.read()).toEqual({ done: false, value: new TextEncoder().encode("a") });
		const reason = new Error("Synthetic stream stopped");
		const refused = expect(reader?.read()).rejects.toBe(reason);
		abort.abort(reason);
		await refused;
		await expect(reader?.read()).rejects.toBe(reason);
		expect(fake.pending()).toBe(0);
	});

	it("reader cancellation clears an until-abort chunk wait and allows another scripted request", async () => {
		const fake = createMessagesApiFake({
			steps: [
				{ kind: "raw", body: "abcdef", chunkBytes: 1, chunkDelayMs: Infinity },
				{ kind: "json", body: message() },
			],
		});
		const response = await fake.fetch("/v1/messages", post());
		const reader = response.body?.getReader();
		expect((await reader?.read())?.value).toEqual(new TextEncoder().encode("a"));
		const pending = reader?.read();
		await reader?.cancel("Synthetic reader cancelled");
		expect(await pending).toEqual({ done: true, value: undefined });
		expect(await reader?.read()).toEqual({ done: true, value: undefined });
		expect(await (await fake.fetch("/v1/messages", post())).json()).toEqual(message());
	});

	it("can produce consumer-oversize bodies and event counts without claiming to accept them", async () => {
		const large = "x".repeat(262_145);
		const many = Array.from({ length: 1_025 }, () => ({ event: "ping", data: { type: "ping" } }));
		const fake = createMessagesApiFake({
			steps: [
				{ kind: "raw", body: large, chunkBytes: 4_096 },
				{ kind: "sse", events: many },
			],
		});
		expect(await (await fake.fetch("/v1/messages", post())).text()).toBe(large);
		expect(await (await fake.fetch("/v1/messages", post())).text()).toBe(wire(many));
	});

	it("stops encoding later SSE events as soon as the aggregate byte limit is exceeded", () => {
		const fake = createMessagesApiFake();
		const large = "x".repeat(8 * 1_024 * 1_024);
		let laterReads = 0;
		expect(() =>
			fake.enqueue({
				kind: "sse",
				events: [
					{ event: "ping", data: large },
					{ event: "ping", data: large },
					{
						event: "ping",
						get data() {
							laterReads += 1;
							return {};
						},
					},
				],
			}),
		).toThrow("byte limit");
		expect(laterReads).toBe(0);
		expect(fake.pending()).toBe(0);
	});

	it("bounds queue, event, byte and chunk work atomically before admission", () => {
		const fake = createMessagesApiFake({ steps: [{ kind: "json", body: message() }] });
		const invalid: MessagesApiStep[] = [
			{ kind: "raw", body: "x", chunkBytes: 0 },
			{ kind: "raw", body: "x", chunkBytes: 65_537 },
			{ kind: "raw", body: "x".repeat(65_537), chunkBytes: 1 },
			{ kind: "raw", body: "x".repeat(16 * 1_024 * 1_024 + 1) },
			{ kind: "sse", events: Array.from({ length: 4_097 }, () => ({ event: "ping", data: {} })) },
			{ kind: "sse", events: [{ event: "ping\ndata: injected", data: {} }] },
			{ kind: "json", body: undefined },
			{ kind: "json", body: {}, delayMs: -1 },
			{ kind: "raw", body: "", chunkDelayMs: 0.5 },
			{ kind: "json", body: {}, status: 204 },
		];
		for (const step of invalid) {
			expect(() => fake.enqueue({ kind: "json", body: { appended: false } }, step)).toThrow();
			expect(fake.pending()).toBe(1);
		}
		const rest: MessagesApiStep[] = Array.from({ length: 1_023 }, () => ({
			kind: "json",
			body: null,
		}));
		fake.enqueue(...rest);
		expect(fake.pending()).toBe(1_024);
		expect(() => fake.enqueue({ kind: "json", body: null })).toThrow("queue limit");
		expect(fake.pending()).toBe(1_024);
	});
});

describe("Messages shared intake and queued bytes", () => {
	const cap = 1_048_576;
	const large = "x".repeat(16_777_216);
	const step = (): MessagesApiStep => ({ kind: "json", body: { slot: 1 } });
	const streamPost = (body: ReadableStream<Uint8Array>, signal?: AbortSignal): RequestInit =>
		post({ body, signal, duplex: "half" } as RequestInit);

	it("exports both usable factories from the root and Messages subpath", async () => {
		const root = await import("@draftyak/fakes");
		const subpath = await import("@draftyak/fakes/messages-api");
		expect(root.createMessagesApiFake).toBe(createMessagesApiFake);
		expect(subpath.createMessagesApiDraftFake).toBe(createMessagesApiDraftFake);
	});

	it.each([0, 1])(
		"keeps generic malformed-body scripts within literal intake bytes (+%i)",
		async (extra) => {
			const fake = createMessagesApiFake({ steps: [step()] });
			const raw = "{".padEnd(cap + extra, " ");
			const response = await fake.fetch("/v1/messages", post({ body: raw }));
			expect(response.status).toBe(extra ? 413 : 200);
			expect(fake.pending()).toBe(extra ? 1 : 0);
			const [record] = fake.recorder.takeRequests();
			expect(record?.bodyLength).toBe(cap + extra);
			expect(record?.refused).toBe(extra ? "request_body_too_large" : undefined);
		},
	);

	it("records the received crossing chunk, cancels unread input and never clones a refused upload", async () => {
		const recorder = createRecorder({ maxBodyBytes: 7 });
		const fake = createMessagesApiFake({ recorder, steps: [step()] });
		const first = new Uint8Array(cap - 1).fill(120);
		const crossing = new Uint8Array([121, 122]);
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
			const response = await fake.fetch("/v1/messages", streamPost(stream));
			expect(response.status).toBe(413);
			expect(await response.json()).toEqual({ error: "request_body_too_large" });
			expect(clone).not.toHaveBeenCalled();
			await setImmediate();
			expect(cancelled).toBe(1);
			const [record] = recorder.takeRequests();
			expect(record?.body).toEqual(first.slice(0, 7));
			expect(record?.bodyLength).toBe(cap + 1);
			expect(record?.bodySha256).toBe(
				createHash("sha256").update(first).update(crossing).digest("hex"),
			);
			expect(record?.refused).toBe("request_body_too_large");
			expect(fake.pending()).toBe(1);
		} finally {
			clone.mockRestore();
		}
	});

	it.each([false, true])(
		"reserves arrival faults even when shared intake refuses (after=%s)",
		async (after) => {
			const fake = createMessagesApiFake({ clock: manualClock(START), steps: [step()] });
			fake.faults.add(
				after ? { kind: "server-error", after: true } : { kind: "rate-limit", retryAfter: 3 },
			);
			const response = await fake.fetch("/v1/messages", post({ body: "x".repeat(cap + 1) }));
			expect(response.status).toBe(after ? 503 : 429);
			expect(response.headers.get("date")).toBe(httpDate(START));
			expect(fake.pending()).toBe(1);
			expect(fake.recorder.takeRequests()[0]?.refused).toBe("request_body_too_large");
			expect(await (await fake.fetch("/v1/messages", post())).json()).toEqual({ slot: 1 });
		},
	);

	it.each(["abort", "source-error", "non-byte"] as const)(
		"discards partial %s intake and consumes no script",
		async (kind) => {
			const fake = createMessagesApiFake({ steps: [step()] });
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
			const pending = fake.fetch("/v1/messages", streamPost(stream, abort.signal));
			const rejection = expect(pending).rejects.toThrow();
			upload.enqueue(new Uint8Array([123]));
			await setImmediate();
			if (kind === "abort") abort.abort(new Error("DYTEST aborted intake"));
			else if (kind === "source-error") upload.error(new Error("DYTEST failed intake"));
			else upload.enqueue("DYTEST invalid chunk" as unknown as Uint8Array);
			await rejection;
			await setImmediate();
			expect(fake.pending()).toBe(1);
			expect(fake.recorder.takeRequests()).toEqual([]);
			if (kind !== "source-error") expect(cancelled).toBe(1);
		},
	);

	it("requires custom begin, keeps the same wire request, and never falls back to record", async () => {
		const recorder = createRecorder({ headerValues: ["x-api-key", "anthropic-version"] });
		expect(() =>
			createMessagesApiFake({
				recorder: { record: recorder.record, takeRequests: recorder.takeRequests },
			}),
		).toThrow("recorder.begin");
		let begun = 0;
		const record = vi.fn(async () => {
			throw new Error("DYTEST unexpected legacy record");
		});
		const fake = createMessagesApiFake({
			recorder: {
				begin(request) {
					begun++;
					return recorder.begin(request);
				},
				record,
				takeRequests: recorder.takeRequests,
			},
			steps: [step()],
		});
		const raw = '{ "model": "synthetic-model", "unexpected": [1,2] }';
		const request = new Request(
			"https://api.anthropic.com/v1/messages?beta=true",
			post({
				body: raw,
				headers: {
					"x-api-key": "DYTEST_KEY",
					"anthropic-version": "DYTEST_VERSION",
					"content-type": "application/json",
				},
			}),
		);
		expect((await fake.fetch(request)).status).toBe(200);
		expect(begun).toBe(1);
		expect(record).not.toHaveBeenCalled();
		const [captured] = recorder.takeRequests();
		expect(captured?.target).toBe("/v1/messages?beta=true");
		expect(captured?.headers).toEqual({
			"x-api-key": "DYTEST_KEY",
			"anthropic-version": "DYTEST_VERSION",
		});
		expect(captured?.body).toEqual(new TextEncoder().encode(raw));
		expect(captured?.bodySha256).toBe(createHash("sha256").update(raw).digest("hex"));
	});

	it("refuses malformed UTF-8 inside an otherwise valid literal draft string", async () => {
		const raw = new TextEncoder().encode(
			'{"model":"synthetic","max_tokens":1,"system":"Z","messages":[{"role":"user","content":""}],"output_config":{"effort":"low","format":{"type":"json_schema","schema":{}}}}',
		);
		raw[raw.indexOf(90)] = 255;
		const fake = createMessagesApiDraftFake({ steps: [step()] });
		const response = await fake.fetch("/v1/messages", post({ body: raw }));
		expect(response.status).toBe(400);
		expect(fake.pending()).toBe(0);
	});

	it("applies intake before malformed routes while wrong hosts retain shared fault ownership", async () => {
		const fake = createMessagesApiFake({ steps: [step()] });
		expect(
			(await fake.fetch("/v1/extra/../messages", post({ body: "x".repeat(cap + 1) }))).status,
		).toBe(413);
		expect(fake.pending()).toBe(1);
		fake.faults.add({ kind: "rate-limit", retryAfter: 2 });
		expect((await fake.fetch("https://wrong.draftyak.example/v1/messages", post())).status).toBe(
			421,
		);
		expect((await fake.fetch("/v1/messages", post())).status).toBe(429);
		expect(fake.pending()).toBe(1);
	});

	it.each([0, 1])(
		"enforces the shared literal intake boundary over loopback (+%i)",
		async (extra) => {
			const fake = createMessagesApiFake({ steps: [step()] });
			const server = await fake.listen();
			try {
				const response = await fetch(
					`${server.origin}/v1/messages`,
					post({ body: "{".padEnd(cap + extra, " "), signal: AbortSignal.timeout(3_000) }),
				);
				expect(response.status).toBe(extra ? 413 : 200);
				expect(fake.pending()).toBe(extra ? 1 : 0);
				expect(fake.recorder.takeRequests()[0]?.refused).toBe(
					extra ? "request_body_too_large" : undefined,
				);
			} finally {
				await server.close();
			}
		},
	);

	it("accepts exact response event/chunk work and counts UTF-8 response bytes", () => {
		const fake = createMessagesApiFake();
		fake.enqueue(
			{ kind: "sse", events: Array.from({ length: 4_096 }, () => ({ event: "ping", data: {} })) },
			{ kind: "raw", body: "x".repeat(65_536), chunkBytes: 1 },
			{ kind: "raw", body: "x", chunkBytes: 65_536 },
			{ kind: "raw", body: "é".repeat(8_388_608) },
		);
		expect(fake.pending()).toBe(4);
		expect(() => fake.enqueue({ kind: "raw", body: `${"é".repeat(8_388_608)}x` })).toThrow(
			"byte limit",
		);
		expect(fake.pending()).toBe(4);
	});

	it("accepts exactly 4096 events yielded by a short array's custom iterator", async () => {
		const source: MessagesApiEvent[] = [{ event: "ping", data: {} }];
		Object.defineProperty(source, Symbol.iterator, {
			value: function* () {
				for (let n = 0; n < 4_096; n++) yield { event: "ping", data: { n } };
			},
		});
		const fake = createMessagesApiFake({ steps: [{ kind: "sse", events: source }] });
		const response = await fake.fetch("/v1/messages", post());
		expect((await response.text()).match(/^event: ping$/gm)).toHaveLength(4_096);
	});

	it("bounds actual yielded events before excess fields and rolls back the whole batch", () => {
		let fields = 0,
			laterSteps = 0,
			yielded = 0,
			closed = false;
		const source: MessagesApiEvent[] = [{ event: "ping", data: {} }];
		Object.defineProperty(source, Symbol.iterator, {
			value: function* () {
				try {
					for (let n = 0; n < 4_098; n++) {
						yielded++;
						yield n < 4_096
							? { event: "ping", data: {} }
							: {
									get event() {
										fields++;
										return "ping";
									},
									get data() {
										fields++;
										return {};
									},
								};
					}
				} finally {
					closed = true;
				}
			},
		});
		const fake = createMessagesApiFake({ steps: [step()] });
		expect(() =>
			fake.enqueue(
				{ kind: "json", body: { staged: true } },
				{ kind: "sse", events: source },
				{
					kind: "json",
					get body() {
						laterSteps++;
						return {};
					},
				},
			),
		).toThrow("event limit");
		expect({ fields, laterSteps, yielded, closed }).toEqual({
			fields: 0,
			laterSteps: 0,
			yielded: 4_097,
			closed: true,
		});
		expect(fake.pending()).toBe(1);
		fake.enqueue({ kind: "json", body: { recovered: true } });
		expect(fake.pending()).toBe(2);
	});

	it("bounds queue preparation before iterating an oversized declared event array", () => {
		let iterators = 0;
		const source = new Array<MessagesApiEvent>(4_097);
		Object.defineProperty(source, Symbol.iterator, {
			get() {
				iterators++;
				throw new Error("DYTEST iterator must not run");
			},
		});
		const fake = createMessagesApiFake({ steps: [step()] });
		expect(() => fake.enqueue({ kind: "sse", events: source })).toThrow("event limit");
		expect(iterators).toBe(0);
		expect(fake.pending()).toBe(1);
	});

	it.each(["body", "toJSON", "SSE data"] as const)(
		"rejects nested enqueue from %s atomically and recovers",
		async (kind) => {
			const fake = createMessagesApiFake({ steps: [step()] });
			const nested = () => {
				fake.enqueue({ kind: "json", body: { nested: true } });
				return {};
			};
			const fixture: MessagesApiStep =
				kind === "body"
					? {
							kind: "json",
							get body() {
								return nested();
							},
						}
					: kind === "toJSON"
						? { kind: "json", body: { toJSON: nested } }
						: {
								kind: "sse",
								events: [
									{
										event: "ping",
										get data() {
											return nested();
										},
									},
								],
							};
			expect(() => fake.enqueue({ kind: "json", body: { staged: true } }, fixture)).toThrow(
				"enqueue reentrancy",
			);
			expect(fake.pending()).toBe(1);
			fake.enqueue({ kind: "json", body: { recovered: true } });
			expect(await (await fake.fetch("/v1/messages", post())).json()).toEqual({ slot: 1 });
			expect(await (await fake.fetch("/v1/messages", post())).json()).toEqual({ recovered: true });
			expect(fake.pending()).toBe(0);
		},
	);

	it("can finish an outer fixture that catches nested rejection without publishing a nested step", async () => {
		const fake = createMessagesApiFake();
		let refused = 0;
		fake.enqueue({
			kind: "json",
			body: {
				toJSON() {
					try {
						fake.enqueue({ kind: "json", body: { nested: true } });
					} catch (error) {
						if (!(error instanceof TypeError)) throw error;
						refused++;
					}
					return { outer: true };
				},
			},
		});
		expect(refused).toBe(1);
		expect(fake.pending()).toBe(1);
		expect(await (await fake.fetch("/v1/messages", post())).json()).toEqual({ outer: true });
		expect(fake.pending()).toBe(0);
	});

	it("stages at most 64MiB of queued response bodies atomically and releases bytes at app admission", async () => {
		const fake = createMessagesApiFake({
			steps: [
				{ kind: "raw", body: large, delayMs: Infinity },
				{ kind: "raw", body: large },
				{ kind: "raw", body: large },
				{ kind: "raw", body: large.slice(1) },
			],
		});
		let laterReads = 0;
		const later: MessagesApiStep = {
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
		const abort = new AbortController();
		const active = fake.fetch("/v1/messages", post({ signal: abort.signal }));
		const rejected = expect(active).rejects.toThrow("DYTEST stop");
		try {
			await setImmediate();
			expect(fake.pending()).toBe(4);
			fake.enqueue({ kind: "raw", body: large });
			expect(fake.pending()).toBe(5);
		} finally {
			abort.abort(new Error("DYTEST stop"));
			await rejected;
		}
	});

	it("stops SSE preparation when the remaining aggregate queued-byte budget is exceeded", () => {
		const fake = createMessagesApiFake({
			steps: [
				{ kind: "raw", body: large },
				{ kind: "raw", body: large },
				{ kind: "raw", body: large },
				{ kind: "raw", body: large.slice(1) },
			],
		});
		let laterReads = 0;
		expect(() =>
			fake.enqueue({
				kind: "sse",
				events: [
					{ event: "ping", data: {} },
					{
						event: "ping",
						get data() {
							laterReads++;
							return {};
						},
					},
				],
			}),
		).toThrow("byte limit");
		expect(laterReads).toBe(0);
		expect(fake.pending()).toBe(4);
		fake.enqueue({ kind: "raw", body: "x" });
	});
});

describe("Messages draft-request fixture", () => {
	const valid = {
		...REQUEST,
		output_config: { effort: "medium", format: { type: "json_schema", schema: {} } },
	};
	const refused = {
		type: "error",
		error: { type: "invalid_request_error", message: "Synthetic request refused" },
	};
	const request = (value: unknown, extra: RequestInit = {}): RequestInit =>
		post({ body: JSON.stringify(value), ...extra });
	const steps = (): MessagesApiStep[] => [
		{ kind: "json", body: { reserved: 1 } },
		{ kind: "json", body: { reserved: 2 } },
	];

	it.each(["/v1/messages", "/v1/messages?beta=true"])(
		"accepts the retained draft envelope at %s without asserting header or pin authority",
		async (target) => {
			const fake = createMessagesApiDraftFake({ steps: steps() });
			const response = await fake.fetch(
				target,
				request(valid, { headers: { "content-type": "application/json" } }),
			);
			expect(response.status).toBe(200);
			expect(await response.json()).toEqual({ reserved: 1 });
			expect(fake.pending()).toBe(1);
		},
	);

	it.each(["low", "medium", "high", "xhigh", "max"])(
		"accepts effort %s and opaque schema data",
		async (effort) => {
			const fake = createMessagesApiDraftFake({ steps: steps() });
			const value = {
				...valid,
				stream: true,
				fallbacks: "default",
				output_config: {
					effort,
					format: { type: "json_schema", schema: { arbitrary: ["opaque"] } },
				},
			};
			expect((await fake.fetch("/v1/messages", request(value))).status).toBe(200);
		},
	);

	it("accepts omitted stream/fallbacks and both token-count boundaries", async () => {
		const { stream: _stream, ...withoutStream } = valid;
		for (const max_tokens of [1, 16_000]) {
			const fake = createMessagesApiDraftFake({ steps: steps() });
			expect(
				(await fake.fetch("/v1/messages", request({ ...withoutStream, max_tokens }))).status,
			).toBe(200);
		}
	});

	it.each([
		["unknown root", { ...valid, tools: [] }],
		["missing format", { ...valid, output_config: { effort: "medium" } }],
		["unknown output", { ...valid, output_config: { ...valid.output_config, budget: 1 } }],
		[
			"unknown format",
			{
				...valid,
				output_config: {
					effort: "medium",
					format: { ...valid.output_config.format, name: "extra" },
				},
			},
		],
		[
			"wrong role",
			{ ...valid, messages: [{ role: "assistant", content: "DYTEST refusal canary" }] },
		],
		["unknown message", { ...valid, messages: [{ ...valid.messages[0], extra: true }] }],
		["multiple messages", { ...valid, messages: [...valid.messages, ...valid.messages] }],
		[
			"structured content",
			{ ...valid, messages: [{ role: "user", content: [{ type: "text", text: "no" }] }] },
		],
		["missing model", { ...valid, model: undefined }],
		["empty model", { ...valid, model: "" }],
		["wrong system", { ...valid, system: [] }],
		["wrong effort", { ...valid, output_config: { ...valid.output_config, effort: ["medium"] } }],
		["unknown effort", { ...valid, output_config: { ...valid.output_config, effort: "invalid" } }],
		[
			"wrong schema",
			{
				...valid,
				output_config: { effort: "medium", format: { type: "json_schema", schema: [] } },
			},
		],
		[
			"wrong format",
			{
				...valid,
				output_config: { effort: "medium", format: { type: "json_object", schema: {} } },
			},
		],
		["zero tokens", { ...valid, max_tokens: 0 }],
		["fractional tokens", { ...valid, max_tokens: 1.5 }],
		["too many tokens", { ...valid, max_tokens: 16_001 }],
		["wrong stream", { ...valid, stream: "true" }],
		["wrong fallback", { ...valid, fallbacks: [] }],
		["array", [valid]],
		["null", null],
	] as const)(
		"refuses %s, records it without an echo and consumes one reserved step",
		async (_name, value) => {
			const fake = createMessagesApiDraftFake({ steps: steps() });
			const response = await fake.fetch("/v1/messages", request(value));
			expect(response.status).toBe(400);
			expect(await response.json()).toEqual(refused);
			const entries = fake.recorder.takeRequests();
			expect(entries).toHaveLength(1);
			expect(entries[0]?.bodySha256).toBe(
				createHash("sha256").update(JSON.stringify(value)).digest("hex"),
			);
			expect(entries[0]?.headers).toEqual({});
			expect(await (await fake.fetch("/v1/messages", request(valid))).json()).toEqual({
				reserved: 2,
			});
		},
	);

	it.each([
		"application/json",
		"application/json; charset=utf-8",
		'Application/JSON; charset="UTF-8"',
	])("accepts JSON content type %s", async (contentType) => {
		const fake = createMessagesApiDraftFake({ steps: steps() });
		expect(
			(
				await fake.fetch(
					"/v1/messages",
					request(valid, { headers: { "content-type": contentType } }),
				)
			).status,
		).toBe(200);
	});

	it.each(["text/plain", "application/json; charset=latin1", "application/json; extra=yes", ""])(
		"refuses content type %s",
		async (contentType) => {
			const fake = createMessagesApiDraftFake({ steps: steps() });
			const response = await fake.fetch(
				"/v1/messages",
				request(valid, { headers: { "content-type": contentType } }),
			);
			expect(response.status).toBe(400);
			expect(await response.json()).toEqual(refused);
		},
	);

	it.each(["", "{", "null", '\u007b"private":"DYTEST"}', new Uint8Array([0xff])])(
		"refuses empty, malformed or invalid-UTF8 JSON without echoing it",
		async (raw) => {
			const fake = createMessagesApiDraftFake({ steps: steps() });
			const response = await fake.fetch("/v1/messages", post({ body: raw }));
			expect(response.status).toBe(400);
			expect(await response.json()).toEqual(refused);
		},
	);

	it("keeps generic script-only requests and strict route/exhaustion behavior", async () => {
		const generic = createMessagesApiFake({ steps: steps() });
		expect((await generic.fetch("/v1/messages", post())).status).toBe(200);
		const fake = createMessagesApiDraftFake({ steps: [{ kind: "json", body: {} }] });
		expect((await fake.fetch("/v1/messages?beta=false", request(valid))).status).toBe(404);
		expect((await fake.fetch("/v1/messages", { method: "GET" })).status).toBe(405);
		expect(fake.pending()).toBe(1);
		expect((await fake.fetch("/v1/messages", request(valid))).status).toBe(200);
		expect((await fake.fetch("/v1/messages", post({ body: "{" }))).status).toBe(503);
	});

	it("accepts split UTF-8 bytes and JSON.parse last-member semantics", async () => {
		const raw = JSON.stringify({ ...valid, system: "Synthetic café 🦬" });
		const encoded = new TextEncoder().encode(raw);
		let offset = 0;
		const upload = new ReadableStream<Uint8Array>({
			pull(controller) {
				if (offset === encoded.length) controller.close();
				else controller.enqueue(encoded.subarray(offset, ++offset));
			},
		});
		const fake = createMessagesApiDraftFake({ steps: steps() });
		expect(
			(await fake.fetch("/v1/messages", post({ body: upload, duplex: "half" } as RequestInit)))
				.status,
		).toBe(200);
		const duplicate = raw.replace('"model":', '"model":"ignored","model":');
		expect((await fake.fetch("/v1/messages", post({ body: duplicate }))).status).toBe(200);
	});

	it.each([0, 1])(
		"enforces shared inclusive 1MiB intake before script admission (overflow=%i)",
		async (overflow) => {
			const empty = { ...valid, system: "" };
			const prefixLength = Buffer.byteLength(JSON.stringify(empty));
			const value = { ...empty, system: "x".repeat(1_024 * 1_024 - prefixLength + overflow) };
			const fake = createMessagesApiDraftFake({ steps: steps() });
			const response = await fake.fetch("/v1/messages", request(value));
			expect(response.status).toBe(overflow ? 413 : 200);
			expect(fake.pending()).toBe(overflow ? 2 : 1);
			expect(fake.recorder.takeRequests()[0]?.bodyLength).toBe(1_024 * 1_024 + overflow);
		},
	);

	it.each([65_536, 65_537])(
		"does not claim original empty-upload-chunk limits after shared buffering (%i)",
		async (count) => {
			let emitted = 0;
			const encoded = new TextEncoder().encode(JSON.stringify(valid));
			const upload = new ReadableStream<Uint8Array>({
				pull(controller) {
					if (emitted === count) controller.close();
					else controller.enqueue(emitted++ === 0 ? encoded : new Uint8Array());
				},
			});
			const fake = createMessagesApiDraftFake({ steps: steps() });
			const response = await fake.fetch(
				"/v1/messages",
				post({ body: upload, duplex: "half" } as RequestInit),
			);
			expect(response.status).toBe(200);
			expect(fake.pending()).toBe(1);
		},
	);

	it("admits strict requests after intake, consuming invalid shape only at app admission", async () => {
		const fake = createMessagesApiDraftFake({ steps: steps() });
		let upload!: ReadableStreamDefaultController<Uint8Array>;
		const stream = new ReadableStream<Uint8Array>({
			start(controller) {
				upload = controller;
			},
		});
		const first = fake.fetch("/v1/messages", post({ body: stream, duplex: "half" } as RequestInit));
		try {
			expect(fake.pending()).toBe(2);
			expect(await (await fake.fetch("/v1/messages", request(valid))).json()).toEqual({
				reserved: 1,
			});
			expect(fake.recorder.takeRequests()).toEqual([]);
		} finally {
			upload.enqueue(new TextEncoder().encode(JSON.stringify({ ...valid, tools: [] })));
			upload.close();
		}
		expect(await (await first).json()).toEqual(refused);
		expect(fake.recorder.takeRequests()).toHaveLength(2);
	});

	it.each(["abort", "source-error"] as const)(
		"preserves intake %s and leaves every script unconsumed",
		async (kind) => {
			const fake = createMessagesApiDraftFake({ steps: steps() });
			const controller = new AbortController();
			let upload!: ReadableStreamDefaultController<Uint8Array>;
			const stream = new ReadableStream<Uint8Array>({
				start(value) {
					upload = value;
				},
			});
			const pending = fake.fetch(
				"/v1/messages",
				post({ body: stream, signal: controller.signal, duplex: "half" } as RequestInit),
			);
			const reason = new Error(`DYTEST strict ${kind}`);
			const rejection = expect(pending).rejects.toBe(reason);
			let settled = false;
			try {
				await setImmediate();
				if (kind === "abort") {
					controller.abort(reason);
				} else upload.error(reason);
				settled = true;
				await rejection;
				expect(await (await fake.fetch("/v1/messages", request(valid))).json()).toEqual({
					reserved: 1,
				});
			} finally {
				if (!settled) upload.close();
				controller.abort(reason);
				await Promise.allSettled([pending]);
			}
		},
	);

	it("preserves before/after fault ownership for strict matching requests", async () => {
		const fake = createMessagesApiDraftFake({ steps: steps() });
		fake.faults.add({ kind: "rate-limit", retryAfter: 3 });
		expect((await fake.fetch("/v1/messages", request({ ...valid, tools: [] }))).status).toBe(429);
		expect(fake.pending()).toBe(2);
		fake.faults.add({ kind: "server-error", after: true });
		expect((await fake.fetch("/v1/messages", request(valid))).status).toBe(503);
		expect(fake.pending()).toBe(1);
		expect(await (await fake.fetch("/v1/messages", request(valid))).json()).toEqual({
			reserved: 2,
		});
	});
});
