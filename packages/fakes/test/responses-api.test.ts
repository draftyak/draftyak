import { createHash } from "node:crypto";
import { request as httpRequest } from "node:http";
import { setImmediate } from "node:timers/promises";
import { describe, expect, it, vi } from "vitest";
import { manualClock } from "../src/faults.ts";
import { createRecorder, type Recorder } from "../src/recorder.ts";
import {
	createResponsesApiDraftFake,
	createResponsesApiFake,
	RESPONSES_API_HOST,
	RESPONSES_API_PATH,
	type ResponsesApiStep,
} from "../src/responses-api.ts";
import { createFake } from "../src/server.ts";
import { withTarget } from "../src/target.ts";

const START = Date.UTC(2026, 9, 19, 8);
const draft = {
	body: "Synthetic Tuesday works.",
	ownerNotes: "Synthetic note.",
	needsOwnerInput: [],
	suspectedInstructions: false,
	contextRefs: ["c1"],
};
const completed = (text = JSON.stringify(draft)) => ({
	id: "resp_synthetic",
	object: "response",
	status: "completed",
	model: "gpt-synthetic",
	usage: { input_tokens: 12, output_tokens: 8, total_tokens: 20 },
	output: [
		{
			id: "msg_synthetic",
			type: "message",
			role: "assistant",
			status: "completed",
			content: [{ type: "output_text", text, annotations: [] }],
		},
	],
});

describe("shared intake and public request-handler composition", () => {
	const cap = 1_048_576;
	const answer: ResponsesApiStep = { kind: "json", body: { synthetic: true } };
	const uploadRequest = (body: ReadableStream<Uint8Array>, signal?: AbortSignal) =>
		new Request(`https://${RESPONSES_API_HOST}${RESPONSES_API_PATH}`, {
			method: "POST",
			body,
			signal,
			duplex: "half",
		} as RequestInit & { duplex: "half" });

	it("passes the original Request unchanged through ordinary generic composition and exposed recording", async () => {
		const recorder = createRecorder({
			headerValues: ["content-type", "x-synthetic"],
			maxBodyBytes: 2048,
		});
		const fake = createResponsesApiFake({ recorder, steps: [answer] });
		const wire = ' { "model":"synthetic", "input":"first", "input":"DYTEST \\u00e9" }\n';
		const original = withTarget(
			new Request(`https://${RESPONSES_API_HOST}${RESPONSES_API_PATH}`, {
				method: "POST",
				headers: {
					"content-type": "application/json",
					"x-synthetic": "exact",
					authorization: "Bearer synthetic",
				},
				body: wire,
			}),
			RESPONSES_API_PATH,
		);
		let received: Request | undefined;
		const composed = createFake(
			{
				fetch(request) {
					received = request;
					return fake.handler(request);
				},
			},
			{
				host: RESPONSES_API_HOST,
				recorder: fake.recorder,
			},
		);
		expect(await (await composed.fetch(original)).json()).toEqual({ synthetic: true });
		expect(received).toBe(original);
		expect(original.bodyUsed).toBe(true);
		expect(fake.recorder).toBe(recorder);
		const [record] = recorder.takeRequests();
		expect(record).toMatchObject({
			target: RESPONSES_API_PATH,
			bodyLength: Buffer.byteLength(wire),
			bodySha256: createHash("sha256").update(wire).digest("hex"),
			headers: { "content-type": "application/json", "x-synthetic": "exact" },
		});
		expect(Buffer.from(record?.body ?? []).toString()).toBe(wire);
		expect(original.headers.get("authorization")).toBe("Bearer synthetic");
	});

	it("keeps raw handler calls independent of shared recording, host and fault policy", async () => {
		const fake = createResponsesApiFake({ steps: [answer, answer] });
		fake.faults.add({ kind: "server-error" });
		const original = new Request(`https://synthetic.invalid${RESPONSES_API_PATH}`, post());
		expect(await (await fake.handler(original)).json()).toEqual({ synthetic: true });
		expect(fake.recorder.takeRequests()).toEqual([]);
		expect(fake.faults.pending()).toHaveLength(1);
		expect((await fake.fetch(RESPONSES_API_PATH, post())).status).toBe(503);
		expect(fake.pending()).toBe(1);
	});

	it.each(["/v1/%72esponses", "/v1/./responses", "/v1/responses?", "/v1/responses#x"])(
		"preserves and rejects noncanonical raw target %s without app admission",
		async (target) => {
			const fake = createResponsesApiFake({ steps: [answer] });
			const original = withTarget(
				new Request(`https://${RESPONSES_API_HOST}${RESPONSES_API_PATH}`, post()),
				target,
			);
			expect((await fake.handler(original)).status).toBe(404);
			expect(original.bodyUsed).toBe(false);
			expect(fake.pending()).toBe(1);
			expect((await fake.fetch(target, post())).status).toBe(404);
			expect(fake.recorder.takeRequests()[0]?.target).toBe(target);
			expect(fake.pending()).toBe(1);
		},
	);

	it.each([createResponsesApiFake, createResponsesApiDraftFake])(
		"enforces shared intake before handler consumption with received-prefix evidence",
		async (factory) => {
			const recorder = createRecorder({ maxBodyBytes: 17 });
			const fake = factory({ recorder, steps: [answer] });
			const first = Buffer.alloc(cap, 0x61);
			const crossing = Buffer.from([0x62]);
			let sent = 0,
				canceled = false;
			const source = new ReadableStream<Uint8Array>({
				pull(controller) {
					controller.enqueue(sent++ === 0 ? first : sent === 2 ? crossing : Buffer.alloc(9, 0x63));
				},
				cancel() {
					canceled = true;
				},
			});
			const original = uploadRequest(source);
			const clone = vi.spyOn(original, "clone");
			const response = await fake.fetch(original);
			expect(response.status).toBe(413);
			expect(await response.json()).toEqual({ error: "request_body_too_large" });
			expect(clone).not.toHaveBeenCalled();
			expect(fake.pending()).toBe(1);
			expect(canceled).toBe(true);
			const [record] = recorder.takeRequests();
			expect(record).toMatchObject({
				refused: "request_body_too_large",
				bodyLength: cap + 1,
				bodySha256: createHash("sha256").update(first).update(crossing).digest("hex"),
			});
			expect(record?.body).toEqual(new Uint8Array(first.subarray(0, 17)));
		},
	);

	it("admits exactly one MiB in generic shared intake and records its complete hash", async () => {
		const fake = createResponsesApiFake({ steps: [answer] });
		const bytes = Buffer.alloc(cap, 0x61);
		expect(
			await (await fake.fetch(RESPONSES_API_PATH, { method: "POST", body: bytes })).json(),
		).toEqual({ synthetic: true });
		expect(fake.recorder.takeRequests()[0]).toMatchObject({
			bodyLength: cap,
			bodySha256: createHash("sha256").update(bytes).digest("hex"),
		});
		expect(fake.pending()).toBe(0);
	});

	it.each([false, true])(
		"reserves and consumes arrival faults on refused intake, after=%s",
		async (after) => {
			const fake = createResponsesApiFake({ clock: manualClock(START), steps: [answer] });
			fake.faults.add({ kind: "server-error", status: 502, after });
			expect(
				(await fake.fetch(RESPONSES_API_PATH, { method: "POST", body: Buffer.alloc(cap + 1) }))
					.status,
			).toBe(502);
			expect(fake.faults.pending()).toEqual([]);
			expect(fake.pending()).toBe(1);
			expect(fake.recorder.takeRequests()[0]?.refused).toBe("request_body_too_large");
			expect(await (await fake.fetch(RESPONSES_API_PATH, post())).json()).toEqual({
				synthetic: true,
			});
		},
	);

	it.each(["malformed", "error", "abort"] as const)(
		"discards incomplete %s intake without consuming the app script",
		async (kind) => {
			const fake = createResponsesApiFake({ steps: [answer] });
			const controller = new AbortController();
			let upload!: ReadableStreamDefaultController<Uint8Array>;
			let canceled = false;
			const source = new ReadableStream<Uint8Array>({
				start(value) {
					upload = value;
				},
				cancel() {
					canceled = true;
				},
			});
			const pending = fake.fetch(uploadRequest(source, controller.signal));
			const rejected = expect(pending).rejects.toBeDefined();
			if (kind === "malformed") upload.enqueue("not bytes" as unknown as Uint8Array);
			else if (kind === "error") upload.error(new Error("DYTEST source error"));
			else controller.abort("DYTEST shared intake abort");
			await rejected;
			expect(fake.pending()).toBe(1);
			expect(fake.recorder.takeRequests()).toEqual([]);
			if (kind !== "error") expect(canceled).toBe(true);
			expect(await (await fake.fetch(RESPONSES_API_PATH, post())).json()).toEqual({
				synthetic: true,
			});
		},
	);

	it("requires custom begin and preserves its receiver without calling record", async () => {
		const base = createRecorder();
		const recorder: Recorder = {
			begin(request) {
				expect(this).toBe(recorder);
				return base.begin(request);
			},
			record() {
				throw new Error("Capped intake must use begin");
			},
			takeRequests: () => base.takeRequests(),
		};
		const fake = createResponsesApiFake({ recorder, steps: [answer] });
		await (await fake.fetch(RESPONSES_API_PATH, post())).body?.cancel();
		expect(recorder.takeRequests()).toHaveLength(1);
		const incomplete: Recorder = { record: async () => {}, takeRequests: () => [] };
		expect(() => createResponsesApiFake({ recorder: incomplete })).toThrow(/recorder.begin/);
		expect(() => createResponsesApiDraftFake({ recorder: incomplete })).toThrow(/recorder.begin/);
	});

	it.each([createResponsesApiFake, createResponsesApiDraftFake])(
		"cancels a malformed direct-handler chunk and removes its listener",
		async (factory) => {
			const fake = factory({ steps: [answer] });
			let canceled = false;
			const source = new ReadableStream<Uint8Array>({
				start(controller) {
					controller.enqueue("bad" as unknown as Uint8Array);
				},
				cancel() {
					canceled = true;
				},
			});
			const original = uploadRequest(source);
			original.headers.set("content-type", "application/json");
			const added = vi.spyOn(original.signal, "addEventListener");
			const removed = vi.spyOn(original.signal, "removeEventListener");
			await expect(fake.handler(original)).rejects.toThrow(/Invalid request body chunk/);
			expect(canceled).toBe(true);
			for (const [name, callback] of added.mock.calls)
				if (name === "abort")
					expect(removed.mock.calls.some(([n, old]) => n === name && old === callback)).toBe(true);
			expect(fake.pending()).toBe(0);
			expect(fake.recorder.takeRequests()).toEqual([]);
		},
	);

	it.each([cap, cap + 1])("retains direct generic defensive byte cap at %i", async (bytes) => {
		const fake = createResponsesApiFake({ steps: [answer] });
		const response = await fake.handler(
			new Request(`https://${RESPONSES_API_HOST}${RESPONSES_API_PATH}`, {
				method: "POST",
				body: Buffer.alloc(bytes),
			}),
		);
		expect(response.status).toBe(bytes === cap ? 200 : 413);
		await response.body?.cancel();
		expect(fake.pending()).toBe(0);
	});

	it("applies the same exact and excess shared intake cap over loopback", async () => {
		const fake = createResponsesApiFake({ steps: [answer, answer] });
		const listener = await fake.listen();
		try {
			expect(
				await (
					await fetch(`${listener.origin}${RESPONSES_API_PATH}`, {
						method: "POST",
						body: Buffer.alloc(cap),
					})
				).json(),
			).toEqual({ synthetic: true });
			expect(
				(
					await fetch(`${listener.origin}${RESPONSES_API_PATH}`, {
						method: "POST",
						body: Buffer.alloc(cap + 1),
					})
				).status,
			).toBe(413);
			expect(fake.pending()).toBe(1);
			const records = fake.recorder.takeRequests();
			expect(records.map(({ bodyLength }) => bodyLength)).toEqual([cap, cap + 1]);
			expect(records[1]?.refused).toBe("request_body_too_large");
		} finally {
			await listener.close();
		}
	});

	it("retains an encoded raw route over the numeric loopback listener", async () => {
		const fake = createResponsesApiFake({ steps: [answer] });
		const listener = await fake.listen();
		try {
			const status = await new Promise<number>((resolve, reject) => {
				const request = httpRequest(
					{ hostname: "127.0.0.1", port: listener.port, path: "/v1/%72esponses", method: "POST" },
					(response) => {
						response.resume();
						response.on("end", () => resolve(response.statusCode ?? 0));
					},
				);
				request.on("error", reject);
				request.end("DYTEST raw path");
			});
			expect(status).toBe(404);
			expect(fake.pending()).toBe(1);
			expect(fake.recorder.takeRequests()[0]?.target).toBe("/v1/%72esponses");
		} finally {
			await listener.close();
		}
	});
});

describe("aggregate scripted response-byte budget", () => {
	const block = "x".repeat(16 * 1024 * 1024);
	const raw: ResponsesApiStep = { kind: "raw", body: block };
	it("admits exactly 64 MiB, rejects an extra byte atomically, and stops preparing later input", async () => {
		const fake = createResponsesApiFake({ steps: [raw, raw, raw] });
		let reachedLater = false;
		const later: ResponsesApiStep = {
			kind: "json",
			body: {
				toJSON() {
					reachedLater = true;
					return {};
				},
			},
		};
		expect(() => fake.enqueue(raw, { kind: "raw", body: "x" }, later)).toThrow(RangeError);
		expect(reachedLater).toBe(false);
		expect(fake.pending()).toBe(3);
		fake.enqueue(raw);
		expect(fake.pending()).toBe(4);
		expect(() => fake.enqueue({ kind: "raw", body: "x" })).toThrow(RangeError);
		expect(fake.pending()).toBe(4);
		const response = await fake.fetch(RESPONSES_API_PATH, post());
		await response.body?.cancel();
		fake.enqueue(raw);
		expect(fake.pending()).toBe(4);
	});

	it("counts multibyte JSON and SSE framing in the remaining budget", () => {
		for (const step of [
			{ kind: "json", body: "é" },
			{ kind: "sse", events: [{ event: "x", data: "é" }] },
		] as const) {
			const bytes = Buffer.byteLength(
				step.kind === "json" ? JSON.stringify(step.body) : 'event: x\ndata: "é"\n\n',
			);
			const tooTight = createResponsesApiFake({
				steps: [raw, raw, raw, { kind: "raw", body: block.slice(bytes - 1) }],
			});
			expect(() => tooTight.enqueue(step)).toThrow(RangeError);
			expect(tooTight.pending()).toBe(4);
			const fake = createResponsesApiFake({
				steps: [raw, raw, raw, { kind: "raw", body: block.slice(bytes) }],
			});
			expect(() => fake.enqueue(step, { kind: "raw", body: "x" })).toThrow(RangeError);
			expect(fake.pending()).toBe(4);
			fake.enqueue(step);
			expect(fake.pending()).toBe(5);
		}
	});

	it("releases bytes at app admission before header waits, not on completion", async () => {
		const fake = createResponsesApiFake({ steps: [{ ...raw, delayMs: Infinity }, raw, raw, raw] });
		const controller = new AbortController();
		const pending = fake.fetch(RESPONSES_API_PATH, { ...post(), signal: controller.signal });
		const rejected = expect(pending).rejects.toBe("DYTEST queue delay cleanup");
		try {
			await setImmediate();
			expect(fake.pending()).toBe(3);
			fake.enqueue(raw);
			expect(fake.pending()).toBe(4);
		} finally {
			controller.abort("DYTEST queue delay cleanup");
			await rejected;
		}
	});

	it("rejects reentrant enqueue during serialization and rolls back the outer batch", () => {
		const fake = createResponsesApiFake();
		expect(() =>
			fake.enqueue({
				kind: "json",
				body: {
					toJSON() {
						fake.enqueue(raw);
						return {};
					},
				},
			}),
		).toThrow(/while preparing/);
		expect(fake.pending()).toBe(0);
		fake.enqueue(raw, raw, raw, raw);
		expect(fake.pending()).toBe(4);
	});

	it("retains the full queued budget for pre-handler faults and intake refusals", async () => {
		const fake = createResponsesApiFake({ steps: [raw, raw, raw, raw] });
		fake.faults.add({ kind: "server-error" });
		expect((await fake.fetch(RESPONSES_API_PATH, post())).status).toBe(503);
		expect(() => fake.enqueue({ kind: "raw", body: "x" })).toThrow(RangeError);
		expect(
			(await fake.fetch(RESPONSES_API_PATH, { method: "POST", body: Buffer.alloc(1_048_577) }))
				.status,
		).toBe(413);
		expect(() => fake.enqueue({ kind: "raw", body: "x" })).toThrow(RangeError);
		expect(fake.pending()).toBe(4);
	});
});

describe("positive finite work boundaries", () => {
	describe.each([createResponsesApiFake, createResponsesApiDraftFake])(
		"actual SSE work bounds",
		(factory) => {
			it.each([4096, 4097])(
				"bounds actual yielded SSE events at %i independently of array length",
				async (count) => {
					let observedExcess = false,
						reachedLaterEvent = false,
						preparedLaterStep = false;
					const events: { event: string; data: unknown }[] = [{ event: "x", data: 1 }];
					events[Symbol.iterator] = function* (): Generator<
						{ event: string; data: unknown },
						undefined,
						unknown
					> {
						for (let index = 0; index < count; index++) {
							if (index < 4096) yield { event: "x", data: index };
							else
								yield {
									get event() {
										observedExcess = true;
										return "x";
									},
									get data() {
										observedExcess = true;
										return 1;
									},
								};
						}
						if (count === 4097) {
							reachedLaterEvent = true;
							yield { event: "x", data: 1 };
						}
						return undefined;
					};
					const request = {
						model: "synthetic",
						instructions: "",
						input: [{ role: "user", content: "" }],
						text: {
							format: { type: "json_schema", name: "draft_output", strict: true, schema: {} },
						},
						store: false,
						stream: true,
					};
					const fake = factory({ steps: [{ kind: "json", body: { seed: true } }] });
					if (count === 4097) {
						expect(() =>
							fake.enqueue(
								{ kind: "raw", body: "staged" },
								{ kind: "sse", events },
								{
									kind: "json",
									body: {
										toJSON() {
											preparedLaterStep = true;
											return {};
										},
									},
								},
							),
						).toThrow(RangeError);
						expect(fake.pending()).toBe(1);
						expect([observedExcess, reachedLaterEvent, preparedLaterStep]).toEqual([
							false,
							false,
							false,
						]);
						expect(await (await fake.fetch(RESPONSES_API_PATH, post(request))).json()).toEqual({
							seed: true,
						});
					} else {
						await (await fake.fetch(RESPONSES_API_PATH, post(request))).body?.cancel();
						fake.enqueue({ kind: "sse", events });
						const wire = await (await fake.fetch(RESPONSES_API_PATH, post(request))).text();
						expect(wire.match(/^event: x$/gm)).toHaveLength(4096);
					}
				},
			);
		},
	);
	it.each(["a", "a".repeat(128)])("accepts an ASCII event name of length %s", async (event) => {
		const fake = createResponsesApiFake({ steps: [{ kind: "sse", events: [{ event, data: 1 }] }] });
		expect(await (await fake.fetch(RESPONSES_API_PATH, post())).text()).toBe(
			`event: ${event}\ndata: 1\n\n`,
		);
	});
	it.each(["", "a".repeat(129), "a\n", "a\r", "a\r\n", "a\u2028", "a\u2029", "é"])(
		"rejects an event name outside exact ASCII bounds: %j",
		(event) => {
			const fake = createResponsesApiFake();
			expect(() => fake.enqueue({ kind: "sse", events: [{ event, data: 1 }] })).toThrow(TypeError);
			expect(fake.pending()).toBe(0);
		},
	);
	it("serves exactly 4096 SSE events with intact framing", async () => {
		const fake = createResponsesApiFake({
			steps: [
				{
					kind: "sse",
					events: Array.from({ length: 4096 }, (_, index) => ({ event: "x", data: index })),
				},
			],
		});
		const wire = await (await fake.fetch(RESPONSES_API_PATH, post())).text();
		expect(wire.match(/^event: x$/gm)).toHaveLength(4096);
		expect(wire.endsWith("event: x\ndata: 4095\n\n")).toBe(true);
	});

	it("serves exactly 65536 response chunks and refuses the next chunk in configuration", async () => {
		const fake = createResponsesApiFake({
			steps: [{ kind: "raw", body: "x".repeat(65_536), chunkBytes: 1 }],
		});
		const response = await fake.handler(
			new Request(`https://${RESPONSES_API_HOST}${RESPONSES_API_PATH}`, post()),
		);
		const reader = readerOf(response);
		let bytes = 0,
			chunks = 0;
		for (;;) {
			const next = await reader.read();
			if (next.done) break;
			bytes += next.value.byteLength;
			chunks++;
		}
		expect([bytes, chunks]).toEqual([65_536, 65_536]);
		expect(() => fake.enqueue({ kind: "raw", body: "x".repeat(65_537), chunkBytes: 1 })).toThrow(
			RangeError,
		);
	});

	it.each([65_536, 65_537])(
		"bounds the generic raw handler at %i yielded request chunks",
		async (chunks) => {
			let emitted = 0;
			const source = new ReadableStream<Uint8Array>({
				pull(controller) {
					if (emitted === chunks) controller.close();
					else {
						emitted++;
						controller.enqueue(new Uint8Array(0));
					}
				},
			});
			const fake = createResponsesApiFake({ steps: [{ kind: "json", body: {} }] });
			const original = new Request(`https://${RESPONSES_API_HOST}${RESPONSES_API_PATH}`, {
				method: "POST",
				body: source,
				duplex: "half",
			} as RequestInit & { duplex: "half" });
			expect((await fake.handler(original)).status).toBe(chunks === 65_536 ? 200 : 413);
			expect(emitted).toBe(chunks);
		},
	);

	it("does not claim a count of original ingress chunks after shared buffering", async () => {
		let emitted = 0;
		const source = new ReadableStream<Uint8Array>({
			pull(controller) {
				if (emitted === 65_537) controller.close();
				else {
					emitted++;
					controller.enqueue(new Uint8Array(0));
				}
			},
		});
		const fake = createResponsesApiFake({ steps: [{ kind: "json", body: {} }] });
		const response = await fake.fetch(RESPONSES_API_PATH, {
			method: "POST",
			body: source,
			duplex: "half",
		} as RequestInit & { duplex: "half" });
		expect(response.status).toBe(200);
		expect(emitted).toBe(65_537);
	});
});

const post = (body: unknown = { model: "gpt-synthetic", stream: false }): RequestInit => ({
	method: "POST",
	headers: { "content-type": "application/json", authorization: "Bearer synthetic" },
	body: JSON.stringify(body),
});
const error = (code: string, type = code) => ({
	error: { code, type, message: "Synthetic failure" },
});
const timers = () => process.getActiveResourcesInfo().filter((kind) => kind === "Timeout").length;
const readerOf = (response: Response): ReadableStreamDefaultReader<Uint8Array> => {
	if (!response.body) throw new Error("Expected a synthetic response body");
	return response.body.getReader();
};

describe("Responses reply kind snapshots", () => {
	const body = "abc";
	const observe = async (step: ResponsesApiStep) => {
		const fake = createResponsesApiFake({ steps: [step] });
		expect(fake.pending()).toBe(1);
		const response = await fake.handler(
			new Request(`https://${RESPONSES_API_HOST}${RESPONSES_API_PATH}`, post()),
		);
		expect(fake.pending()).toBe(0);
		expect(response.status).toBe(200);
		expect(response.headers.get("content-type")).toBe("application/json");
		const reader = readerOf(response);
		const chunks: Uint8Array[] = [];
		try {
			for (;;) {
				const next = await reader.read();
				if (next.done) break;
				chunks.push(next.value);
			}
		} finally {
			await reader.cancel();
			reader.releaseLock();
		}
		return {
			lengths: chunks.map((chunk) => chunk.byteLength),
			text: Buffer.concat(chunks).toString("utf8"),
		};
	};

	it("uses one raw kind snapshot for exact response chunks and bytes", async () => {
		const kinds = ["raw", "json", "raw"] as const;
		let reads = 0;
		const step: ResponsesApiStep = {
			get kind() {
				return kinds[reads++] ?? "raw";
			},
			body,
			chunkBytes: 1,
		};
		const observed = await observe(step);
		expect(observed.lengths).toEqual([1, 1, 1]);
		expect(observed.text).toBe(body);
		expect(reads).toBe(1);
	});

	it("preserves stable raw chunks and explicit JSON media", async () => {
		const observed = await observe({
			kind: "raw",
			body,
			chunkBytes: 1,
			contentType: "application/json",
		});
		expect(observed.lengths).toEqual([1, 1, 1]);
		expect(observed.text).toBe(body);
		expect(() => JSON.parse(observed.text)).toThrow(SyntaxError);
	});

	it("preserves stable JSON string serialization and default chunks", async () => {
		const observed = await observe({ kind: "json", body });
		expect(observed.lengths).toEqual([5]);
		expect(observed.text).toBe(JSON.stringify(body));
		expect(JSON.parse(observed.text)).toBe(body);
	});
});

describe("scripted Responses provider", () => {
	it.each([
		["valid", { kind: "json", body: completed() }, 200, completed()],
		[
			"obedient",
			{
				kind: "json",
				body: completed(
					JSON.stringify({
						...draft,
						body: "OBEYED_SYNTHETIC_INSTRUCTION",
						suspectedInstructions: false,
					}),
				),
			},
			200,
			completed(
				JSON.stringify({
					...draft,
					body: "OBEYED_SYNTHETIC_INSTRUCTION",
					suspectedInstructions: false,
				}),
			),
		],
		[
			"schema-breaking",
			{
				kind: "json",
				body: completed(JSON.stringify({ body: 7, recipient: "synthetic@example.invalid" })),
			},
			200,
			completed(JSON.stringify({ body: 7, recipient: "synthetic@example.invalid" })),
		],
		[
			"refusing",
			{
				kind: "json",
				body: {
					...completed(),
					output: [
						{
							type: "message",
							role: "assistant",
							status: "completed",
							content: [{ type: "refusal", refusal: "Synthetic refusal" }],
						},
					],
				},
			},
			200,
			undefined,
		],
		[
			"provider-failed",
			{
				kind: "json",
				body: {
					...completed(),
					status: "failed",
					error: { code: "server_error", message: "Synthetic" },
				},
			},
			200,
			undefined,
		],
		[
			"tool",
			{
				kind: "json",
				body: {
					...completed(),
					output: [{ type: "function_call", name: "synthetic_tool", arguments: "{}" }],
				},
			},
			200,
			undefined,
		],
		[
			"truncated",
			{
				kind: "json",
				body: {
					...completed("{"),
					status: "incomplete",
					incomplete_details: { reason: "max_output_tokens" },
				},
			},
			200,
			undefined,
		],
		[
			"auth",
			{ kind: "json", body: error("invalid_api_key"), status: 401 },
			401,
			error("invalid_api_key"),
		],
		[
			"rate",
			{
				kind: "json",
				body: error("rate_limit_exceeded"),
				status: 429,
				headers: { "retry-after": "2" },
			},
			429,
			error("rate_limit_exceeded"),
		],
		[
			"quota",
			{ kind: "json", body: error("insufficient_quota"), status: 429 },
			429,
			error("insufficient_quota"),
		],
	] as const)("serves a distinct literal %s scenario", async (_name, step, status, expected) => {
		const fake = createResponsesApiFake({ clock: manualClock(START), steps: [step] });
		const response = await fake.fetch(RESPONSES_API_PATH, post());
		expect(response.status).toBe(status);
		expect(response.headers.get("date")).toBe("Mon, 19 Oct 2026 08:00:00 GMT");
		expect(response.headers.get("content-type")).toBe("application/json");
		const body = await response.json();
		expect(body).toEqual(expected ?? step.body);
		if (_name === "rate") expect(response.headers.get("retry-after")).toBe("2");
		expect(fake.pending()).toBe(0);
	});

	it("preserves malformed raw JSON as wire bytes rather than repairing it", async () => {
		const fake = createResponsesApiFake({
			steps: [{ kind: "raw", body: '{"status":"completed"' }],
		});
		const response = await fake.fetch(RESPONSES_API_PATH, post());
		expect(await response.text()).toBe('{"status":"completed"');
	});

	it("emits finite exact SSE frames and splits UTF-8 independently of character boundaries", async () => {
		const text = JSON.stringify({ ...draft, body: "Synthetic \u00e9\ud83d\ude00" });
		const part = { type: "output_text", text, annotations: [] };
		const events = [
			{
				event: "response.created",
				data: {
					type: "response.created",
					sequence_number: 0,
					response: { ...completed(), status: "in_progress", output: [] },
				},
			},
			{
				event: "response.output_item.added",
				data: {
					type: "response.output_item.added",
					sequence_number: 1,
					output_index: 0,
					item: {
						id: "msg_synthetic",
						type: "message",
						role: "assistant",
						status: "in_progress",
						content: [],
					},
				},
			},
			{
				event: "response.content_part.added",
				data: {
					type: "response.content_part.added",
					sequence_number: 2,
					item_id: "msg_synthetic",
					output_index: 0,
					content_index: 0,
					part: { ...part, text: "" },
				},
			},
			{
				event: "response.output_text.delta",
				data: {
					type: "response.output_text.delta",
					sequence_number: 3,
					item_id: "msg_synthetic",
					output_index: 0,
					content_index: 0,
					delta: text,
				},
			},
			{
				event: "response.output_text.done",
				data: {
					type: "response.output_text.done",
					sequence_number: 4,
					item_id: "msg_synthetic",
					output_index: 0,
					content_index: 0,
					text,
				},
			},
			{
				event: "response.content_part.done",
				data: {
					type: "response.content_part.done",
					sequence_number: 5,
					item_id: "msg_synthetic",
					output_index: 0,
					content_index: 0,
					part,
				},
			},
			{
				event: "response.output_item.done",
				data: {
					type: "response.output_item.done",
					sequence_number: 6,
					output_index: 0,
					item: completed(text).output[0],
				},
			},
			{
				event: "response.completed",
				data: { type: "response.completed", sequence_number: 7, response: completed(text) },
			},
		];
		const expected = events
			.map(({ event, data }) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`)
			.join("");
		const fake = createResponsesApiFake({ steps: [{ kind: "sse", events, chunkBytes: 1 }] });
		const response = await fake.fetch(
			RESPONSES_API_PATH,
			post({ model: "gpt-synthetic", stream: true }),
		);
		expect(response.headers.get("content-type")).toBe("text/event-stream");
		const reader = readerOf(response);
		const parts: Uint8Array[] = [];
		for (;;) {
			const value = await reader.read();
			if (value.done) break;
			expect(value.value.byteLength).toBe(1);
			parts.push(value.value);
		}
		expect(Buffer.concat(parts).toString("utf8")).toBe(expected);
	});

	it("never calls global fetch to answer the logical vendor host in memory", async () => {
		const fetch = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("No egress"));
		try {
			const fake = createResponsesApiFake({ steps: [{ kind: "json", body: completed() }] });
			expect(
				await (
					await fake.fetch(`https://${RESPONSES_API_HOST}${RESPONSES_API_PATH}`, post())
				).json(),
			).toEqual(completed());
			expect(fetch).not.toHaveBeenCalled();
		} finally {
			fetch.mockRestore();
		}
	});

	it("streams an oversized output incrementally for consumer byte-cap tests", async () => {
		const text = "x".repeat(262_145);
		const fake = createResponsesApiFake({ steps: [{ kind: "raw", body: text, chunkBytes: 1024 }] });
		const response = await fake.fetch(RESPONSES_API_PATH, post());
		const reader = readerOf(response);
		let bytes = 0;
		let chunks = 0;
		for (;;) {
			const next = await reader.read();
			if (next.done) break;
			bytes += next.value.byteLength;
			chunks++;
			expect(next.value.byteLength).toBeLessThanOrEqual(1024);
		}
		expect([bytes, chunks]).toEqual([262_145, 257]);
	});

	it("records exact request fields, bytes and hash without retaining credential values by default", async () => {
		const body = {
			model: "gpt-synthetic",
			instructions: "Synthetic system",
			input: [{ role: "user", content: "Synthetic prompt" }],
			text: { format: { type: "json_schema", name: "synthetic", strict: true, schema: {} } },
			stream: true,
			store: false,
		};
		const fake = createResponsesApiFake({ steps: [{ kind: "json", body: completed() }] });
		await (await fake.fetch(RESPONSES_API_PATH, post(body))).body?.cancel();
		const [request] = fake.recorder.takeRequests();
		if (!request) throw new Error("Expected a recorded synthetic request");
		const bytes = Buffer.from(JSON.stringify(body));
		expect(request).toMatchObject({
			method: "POST",
			host: RESPONSES_API_HOST,
			target: RESPONSES_API_PATH,
			headerNames: ["authorization", "content-type"],
			headers: {},
			bodyLength: bytes.length,
			bodySha256: createHash("sha256").update(bytes).digest("hex"),
		});
		expect(request?.body).toEqual(new Uint8Array(bytes));
		expect(JSON.parse(Buffer.from(request.body).toString("utf8"))).toEqual(body);
	});

	it("supports the existing recorder's explicit header selection and body-prefix cap", async () => {
		const recorder = createRecorder({ headerValues: ["content-type"], maxBodyBytes: 2 });
		const fake = createResponsesApiFake({ recorder, steps: [{ kind: "json", body: completed() }] });
		await (await fake.fetch(RESPONSES_API_PATH, post())).body?.cancel();
		const [request] = recorder.takeRequests();
		if (!request) throw new Error("Expected a recorded synthetic request");
		expect(request?.headers).toEqual({ "content-type": "application/json" });
		expect(request?.body.byteLength).toBe(2);
		expect(request.bodyLength).toBeGreaterThan(2);
	});

	it("admits after bounded uploads finish while recording in arrival order", async () => {
		const fake = createResponsesApiFake({
			steps: [
				{ kind: "json", body: { step: 1 } },
				{ kind: "json", body: { step: 2 } },
			],
		});
		let upload!: ReadableStreamDefaultController<Uint8Array>;
		const body = new ReadableStream<Uint8Array>({
			start(controller) {
				upload = controller;
			},
		});
		const init: RequestInit & { duplex: "half" } = { method: "POST", body, duplex: "half" };
		const first = fake.fetch(
			new Request(`https://${RESPONSES_API_HOST}${RESPONSES_API_PATH}`, init),
		);
		const second = fake.fetch(RESPONSES_API_PATH, post({ request: 2 }));
		let released = false;
		const release = () => {
			if (released) return;
			released = true;
			upload.enqueue(new TextEncoder().encode('{"request":1}'));
			upload.close();
		};
		try {
			expect(fake.pending()).toBe(2);
			expect(await (await second).json()).toEqual({ step: 1 });
			expect(fake.recorder.takeRequests()).toEqual([]);
			release();
			expect(await (await first).json()).toEqual({ step: 2 });
			expect(
				fake.recorder.takeRequests().map((value) => JSON.parse(Buffer.from(value.body).toString())),
			).toEqual([{ request: 1 }, { request: 2 }]);
		} finally {
			release();
			await Promise.allSettled([first, second]);
		}
	});

	it("does not consume on wrong host, target or method, and refuses exhausted scripts", async () => {
		const fake = createResponsesApiFake({ steps: [{ kind: "json", body: { step: 1 } }] });
		for (const [target, method, status] of [
			["/other", "POST", 404],
			["/v1/responses?beta=true", "POST", 404],
			[RESPONSES_API_PATH, "GET", 405],
		] as const) {
			expect((await fake.fetch(target, method === "POST" ? post() : { method })).status).toBe(
				status,
			);
			expect(fake.pending()).toBe(1);
		}
		expect((await fake.fetch("https://other.example/v1/responses", post())).status).toBe(421);
		expect(fake.pending()).toBe(1);
		expect(await (await fake.fetch(RESPONSES_API_PATH, post())).json()).toEqual({ step: 1 });
		const empty = await fake.fetch(RESPONSES_API_PATH, post());
		expect(empty.status).toBe(503);
		expect(await empty.json()).toEqual({
			error: { type: "server_error", code: "script_exhausted", message: "Synthetic exhaustion" },
		});
	});

	it("discards incomplete intake and preserves the step without an orphaned response stream", async () => {
		const fake = createResponsesApiFake({
			steps: [{ kind: "raw", body: "abc", chunkBytes: 1, chunkDelayMs: Infinity }],
		});
		const controller = new AbortController();
		let upload!: ReadableStreamDefaultController<Uint8Array>;
		const body = new ReadableStream<Uint8Array>({
			start(value) {
				upload = value;
			},
		});
		const init: RequestInit & { duplex: "half" } = {
			method: "POST",
			body,
			signal: controller.signal,
			duplex: "half",
		};
		const request = new Request(`https://${RESPONSES_API_HOST}${RESPONSES_API_PATH}`, init);
		const added = vi.spyOn(request.signal, "addEventListener");
		const removed = vi.spyOn(request.signal, "removeEventListener");
		try {
			const failure = new Error("Synthetic upload failure");
			const pending = fake.fetch(request);
			const rejected = expect(pending).rejects.toBe(failure);
			expect(fake.pending()).toBe(1);
			upload.error(failure);
			await rejected;
			await setImmediate();
			expect(fake.recorder.takeRequests()).toEqual([]);
			for (const [type, listener] of added.mock.calls)
				if (type === "abort")
					expect(removed.mock.calls.some(([name, old]) => name === type && old === listener)).toBe(
						true,
					);
			fake.enqueue({ kind: "json", body: { next: true } });
			await (await fake.fetch(RESPONSES_API_PATH, post())).body?.cancel();
			expect(await (await fake.fetch(RESPONSES_API_PATH, post())).json()).toEqual({ next: true });
		} finally {
			controller.abort();
			added.mockRestore();
			removed.mockRestore();
		}
	});

	it("inherits before/after faults without conflating them with scripted provider errors", async () => {
		const fake = createResponsesApiFake({
			clock: manualClock(START),
			steps: [
				{ kind: "json", body: { step: 1 } },
				{ kind: "json", body: { step: 2 } },
			],
		});
		fake.faults.add({ kind: "rate-limit", retryAfter: 3 });
		const before = await fake.fetch(RESPONSES_API_PATH, post());
		expect([before.status, before.headers.get("retry-after"), fake.pending()]).toEqual([
			429,
			"3",
			2,
		]);
		fake.faults.add({ kind: "server-error", after: true });
		expect((await fake.fetch(RESPONSES_API_PATH, post())).status).toBe(503);
		expect(fake.pending()).toBe(1);
		expect(await (await fake.fetch(RESPONSES_API_PATH, post())).json()).toEqual({ step: 2 });
	});

	it("aborts a slow header wait and never restores its consumed step", async () => {
		const fake = createResponsesApiFake({
			steps: [
				{ kind: "json", body: completed(), delayMs: Infinity },
				{ kind: "json", body: { next: true } },
			],
		});
		const controller = new AbortController();
		const pending = fake.fetch(RESPONSES_API_PATH, { ...post(), signal: controller.signal });
		const rejected = expect(pending).rejects.toBe("synthetic cancellation");
		try {
			await setImmediate();
			expect(fake.pending()).toBe(1);
		} finally {
			controller.abort("synthetic cancellation");
			await rejected;
		}
		expect(await (await fake.fetch(RESPONSES_API_PATH, post())).json()).toEqual({ next: true });
	});

	it.each(["server-error", "drop"] as const)(
		"releases a discarded stream when an after-app %s fault replaces it",
		async (kind) => {
			const fake = createResponsesApiFake({
				steps: [{ kind: "raw", body: "abc", chunkBytes: 1, chunkDelayMs: Infinity }],
			});
			const controller = new AbortController();
			const request = new Request(`https://${RESPONSES_API_HOST}${RESPONSES_API_PATH}`, {
				...post(),
				signal: controller.signal,
			});
			const added = vi.spyOn(request.signal, "addEventListener");
			const removed = vi.spyOn(request.signal, "removeEventListener");
			try {
				fake.faults.add({ kind, after: true });
				const response = fake.faults.run(request, fake.handler);
				if (kind === "drop") await expect(response).rejects.toThrow("connection dropped");
				else {
					const fault = await response;
					expect(fault.status).toBe(503);
					await fault.arrayBuffer();
				}
				expect(fake.pending()).toBe(0);
				await setImmediate();
				for (const [type, listener] of added.mock.calls)
					if (type === "abort")
						expect(
							removed.mock.calls.some(([name, old]) => name === type && old === listener),
						).toBe(true);
				fake.enqueue({ kind: "json", body: { next: true } });
				expect(await (await fake.fetch(RESPONSES_API_PATH, post())).json()).toEqual({ next: true });
			} finally {
				controller.abort();
				added.mockRestore();
				removed.mockRestore();
			}
		},
	);

	it.each(["cancel", "abort"] as const)(
		"cleans up a direct handler's unanswered inter-chunk wait on %s",
		async (mode) => {
			const before = timers();
			const fake = createResponsesApiFake({
				steps: [{ kind: "raw", body: "abc", chunkBytes: 1, chunkDelayMs: Infinity }],
			});
			const controller = new AbortController();
			const request = new Request(`https://${RESPONSES_API_HOST}${RESPONSES_API_PATH}`, {
				...post(),
				signal: controller.signal,
			});
			const added = vi.spyOn(request.signal, "addEventListener");
			const removed = vi.spyOn(request.signal, "removeEventListener");
			try {
				const response = await fake.handler(request);
				const reader = readerOf(response);
				expect(new TextDecoder().decode((await reader.read()).value)).toBe("a");
				await setImmediate();
				expect(timers()).toBeGreaterThan(before);
				if (mode === "cancel") await reader.cancel("synthetic cancel");
				else {
					const next = reader.read();
					const failed = expect(next).rejects.toBe("synthetic abort");
					controller.abort("synthetic abort");
					await failed;
				}
				await setImmediate();
				expect(timers()).toBeLessThanOrEqual(before);
				for (const [type, listener] of added.mock.calls)
					if (type === "abort")
						expect(
							removed.mock.calls.some(
								([kind, removedListener]) => kind === type && removedListener === listener,
							),
						).toBe(true);
			} finally {
				controller.abort();
				added.mockRestore();
				removed.mockRestore();
			}
		},
	);

	it("snapshots scripts, validates enqueue atomically and bounds finite wire configuration", async () => {
		const body = { value: 1 };
		const fake = createResponsesApiFake({ steps: [{ kind: "json", body }] });
		body.value = 9;
		expect(await (await fake.fetch(RESPONSES_API_PATH, post())).json()).toEqual({ value: 1 });
		const invalid: ResponsesApiStep[] = [
			{ kind: "raw", body: "a", chunkBytes: 0 },
			{ kind: "raw", body: "a", chunkBytes: 65_537 },
			{ kind: "raw", body: "x".repeat(65_537), chunkBytes: 1 },
			{ kind: "json", body: {}, delayMs: NaN },
			{ kind: "json", body: {}, status: 204 },
			{ kind: "json", body: undefined },
			{ kind: "sse", events: [{ event: "bad\nname", data: {} }] },
			{
				kind: "sse",
				events: Array.from({ length: 4097 }, () => ({ event: "response.created", data: {} })),
			},
			{ kind: "raw", body: "x".repeat(16 * 1024 * 1024 + 1) },
		];
		for (const step of invalid) {
			expect(() => fake.enqueue({ kind: "json", body: {} }, step)).toThrow();
			expect(fake.pending()).toBe(0);
		}
		fake.enqueue(
			...Array.from({ length: 1024 }, (): ResponsesApiStep => ({ kind: "json", body: {} })),
		);
		expect(() => fake.enqueue({ kind: "json", body: {} })).toThrow(RangeError);
		expect(fake.pending()).toBe(1024);
	});

	it("serves the same scripted protocol on a loopback-only listener", async () => {
		const fake = createResponsesApiFake({ steps: [{ kind: "json", body: completed() }] });
		const listening = await fake.listen();
		try {
			expect(listening.origin).toMatch(/^http:\/\/127\.0\.0\.1:/);
			const response = await fetch(`${listening.origin}${RESPONSES_API_PATH}`, post());
			expect(await response.json()).toEqual(completed());
			expect(fake.pending()).toBe(0);
		} finally {
			await listening.close();
		}
	});
});

describe("strict API-key drafting request fixture", () => {
	const canary = "DYTEST_REQUEST_REFUSAL_CANARY";
	const refused = {
		error: {
			type: "invalid_request_error",
			code: "request_refused",
			message: "Synthetic request refused",
		},
	};
	const requestBody = () => ({
		model: "gpt-synthetic",
		instructions: "DYTEST strict system",
		input: [{ role: "user", content: "DYTEST strict prompt" }],
		text: {
			format: {
				type: "json_schema",
				name: "draft_output",
				strict: true,
				schema: {
					type: "object",
					properties: { synthetic: { type: "integer" } },
					required: ["synthetic"],
					additionalProperties: false,
				},
			},
		},
		stream: true,
		store: false,
	});
	const steps = (): ResponsesApiStep[] => [
		{ kind: "json", body: { reserved: 1 } },
		{ kind: "json", body: { reserved: 2 } },
	];
	async function refusesWire(wire: BodyInit, contentType: string | null = "application/json") {
		const fake = createResponsesApiDraftFake({ steps: steps() });
		const response = await fake.fetch(RESPONSES_API_PATH, {
			method: "POST",
			headers: contentType === null ? {} : { "content-type": contentType },
			body: wire,
		});
		expect(response.status).toBe(400);
		const text = await response.text();
		expect(JSON.parse(text)).toEqual(refused);
		expect(text).not.toContain(canary);
		expect(fake.pending()).toBe(1);
		expect(await (await fake.fetch(RESPONSES_API_PATH, post(requestBody()))).json()).toEqual({
			reserved: 2,
		});
		expect(fake.pending()).toBe(0);
	}
	const refusesBody = (value: unknown) => {
		const wire = JSON.stringify(value);
		if (wire === undefined) throw new Error("Expected a serialized fixture");
		return refusesWire(wire);
	};
	const valid = requestBody();

	it("accepts an independent literal drafting request without credential or schema authority", async () => {
		const outgoing = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("No egress"));
		try {
			const fake = createResponsesApiDraftFake({ steps: [{ kind: "json", body: completed() }] });
			const response = await fake.fetch(RESPONSES_API_PATH, {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify(requestBody()),
			});
			expect(response.status).toBe(200);
			expect(await response.json()).toEqual(completed());
			expect(outgoing).not.toHaveBeenCalled();
		} finally {
			outgoing.mockRestore();
		}
	});

	it("treats schema contents and nonempty effort as opaque fixture data", async () => {
		const fake = createResponsesApiDraftFake({ steps: [{ kind: "json", body: { opaque: true } }] });
		const body = {
			...valid,
			model: " ",
			instructions: "",
			input: [{ role: "user", content: "" }],
			text: { format: { ...valid.text.format, schema: { arbitrary: [canary] } } },
			reasoning: { effort: "DYTEST-not-a-vendor-enum" },
		};
		expect(await (await fake.fetch(RESPONSES_API_PATH, post(body))).json()).toEqual({
			opaque: true,
		});
	});

	it("retains generic malformed-body compatibility outside the strict factory", async () => {
		const fake = createResponsesApiFake({ steps: [{ kind: "json", body: { generic: true } }] });
		expect(
			await (await fake.fetch(RESPONSES_API_PATH, { method: "POST", body: "not JSON" })).json(),
		).toEqual({ generic: true });
	});

	it.each([
		"metadata",
		"user",
		"tools",
		"tool_choice",
		"previous_response_id",
		"conversation",
		"background",
		"max_output_tokens",
		"temperature",
		"service_tier",
		"__proto__",
	])("refuses non-allowlisted top-level field %s", async (field) => {
		await refusesBody({ ...valid, [field]: canary });
	});

	it.each(["model", "instructions", "input", "text", "stream", "store"])(
		"refuses a missing required field %s",
		async (field) => {
			await refusesBody(Object.fromEntries(Object.entries(valid).filter(([key]) => key !== field)));
		},
	);

	it("refuses retained provider state even when every other field is valid", async () => {
		await refusesBody({ ...valid, store: true });
	});

	it("refuses non-streaming requests even when every other field is valid", async () => {
		await refusesBody({ ...valid, stream: false });
	});

	it.each([
		["model number", { ...valid, model: 7 }],
		["model empty", { ...valid, model: "" }],
		["model null", { ...valid, model: null }],
		["instructions number", { ...valid, instructions: 7 }],
		["instructions null", { ...valid, instructions: null }],
		["input object", { ...valid, input: {} }],
		["input null", { ...valid, input: null }],
		["input empty", { ...valid, input: [] }],
		["input multiple", { ...valid, input: [...valid.input, ...valid.input] }],
		["input item string", { ...valid, input: [canary] }],
		["input item null", { ...valid, input: [null] }],
		["input item array", { ...valid, input: [[]] }],
		["input missing role", { ...valid, input: [{ content: canary }] }],
		["input missing content", { ...valid, input: [{ role: "user" }] }],
		["input wrong role", { ...valid, input: [{ role: "assistant", content: canary }] }],
		["input nonstring content", { ...valid, input: [{ role: "user", content: 7 }] }],
		["input extra field", { ...valid, input: [{ ...valid.input[0], extra: canary }] }],
		["text null", { ...valid, text: null }],
		["text array", { ...valid, text: [] }],
		["text missing format", { ...valid, text: {} }],
		["text extra field", { ...valid, text: { ...valid.text, verbosity: canary } }],
		["format null", { ...valid, text: { format: null } }],
		["format array", { ...valid, text: { format: [] } }],
		[
			"format wrong type",
			{ ...valid, text: { format: { ...valid.text.format, type: "json_object" } } },
		],
		["format wrong name", { ...valid, text: { format: { ...valid.text.format, name: canary } } }],
		[
			"format false strict",
			{ ...valid, text: { format: { ...valid.text.format, strict: false } } },
		],
		[
			"format string strict",
			{ ...valid, text: { format: { ...valid.text.format, strict: "true" } } },
		],
		["format extra field", { ...valid, text: { format: { ...valid.text.format, extra: canary } } }],
		["schema array", { ...valid, text: { format: { ...valid.text.format, schema: [] } } }],
		["schema null", { ...valid, text: { format: { ...valid.text.format, schema: null } } }],
		["schema string", { ...valid, text: { format: { ...valid.text.format, schema: canary } } }],
		["reasoning null", { ...valid, reasoning: null }],
		["reasoning array", { ...valid, reasoning: [] }],
		["reasoning missing effort", { ...valid, reasoning: {} }],
		["reasoning empty effort", { ...valid, reasoning: { effort: "" } }],
		["reasoning nonstring effort", { ...valid, reasoning: { effort: 7 } }],
		["reasoning extra field", { ...valid, reasoning: { effort: "low", summary: canary } }],
		["stream string", { ...valid, stream: "true" }],
		["stream null", { ...valid, stream: null }],
		["store string", { ...valid, store: "false" }],
		["store null", { ...valid, store: null }],
	] as const)("refuses malformed closed drafting shape: %s", async (_name, body) => {
		await refusesBody(body);
	});

	it.each(["type", "name", "strict", "schema"])(
		"refuses a missing format field %s",
		async (field) => {
			const format = Object.fromEntries(
				Object.entries(valid.text.format).filter(([key]) => key !== field),
			);
			await refusesBody({ ...valid, text: { format } });
		},
	);

	it.each(["{", "null", "[]", "7", '"DYTEST_REQUEST_REFUSAL_CANARY"', ""])(
		"refuses malformed or nonobject JSON %s",
		async (wire) => {
			await refusesWire(wire);
		},
	);

	it.each([
		"application/json",
		"Application/JSON; charset=UTF-8",
		'application/json;charset="utf-8"',
	])("admits JSON content type %s", async (contentType) => {
		const fake = createResponsesApiDraftFake({ steps: [{ kind: "json", body: { valid: true } }] });
		expect(
			await (
				await fake.fetch(RESPONSES_API_PATH, {
					method: "POST",
					headers: { "content-type": contentType },
					body: JSON.stringify(valid),
				})
			).json(),
		).toEqual({ valid: true });
	});

	it.each([
		null,
		"text/plain",
		"application/jsonish",
		"application/json; charset=latin1",
		"application/json; extra=x",
	])("refuses unsupported content type %s", async (contentType) => {
		await refusesWire(new TextEncoder().encode(JSON.stringify(valid)), contentType);
	});

	it("rejects malformed UTF-8 that a lossy decoder would turn into valid JSON", async () => {
		const wire = Buffer.from(JSON.stringify(valid));
		const marker = Buffer.from(valid.instructions);
		const at = wire.indexOf(marker);
		expect(at).toBeGreaterThanOrEqual(0);
		await refusesWire(
			Buffer.concat([
				wire.subarray(0, at),
				Buffer.from([0xc3, 0x28]),
				wire.subarray(at + marker.length),
			]),
		);
	});

	it("counts UTF-8 request bytes at the inclusive one-MiB boundary", async () => {
		const empty = { ...valid, instructions: "" };
		const available = 1_048_576 - Buffer.byteLength(JSON.stringify(empty));
		const instructions = "é".repeat(Math.floor(available / 2)) + "x".repeat(available % 2);
		const exact = JSON.stringify({ ...empty, instructions });
		expect(Buffer.byteLength(exact)).toBe(1_048_576);
		const fake = createResponsesApiDraftFake({
			steps: [{ kind: "json", body: { atLimit: true } }],
		});
		expect(await (await fake.fetch(RESPONSES_API_PATH, { ...post(), body: exact })).json()).toEqual(
			{
				atLimit: true,
			},
		);
		const excess = JSON.stringify({ ...empty, instructions: `${instructions}x` });
		expect(Buffer.byteLength(excess)).toBe(1_048_577);
		const direct = createResponsesApiDraftFake({ steps: steps() });
		expect(
			(
				await direct.handler(
					new Request(`https://${RESPONSES_API_HOST}${RESPONSES_API_PATH}`, {
						...post(),
						body: exact,
					}),
				)
			).status,
		).toBe(200);
		expect(
			(
				await direct.handler(
					new Request(`https://${RESPONSES_API_HOST}${RESPONSES_API_PATH}`, {
						...post(),
						body: excess,
					}),
				)
			).status,
		).toBe(400);
		expect(direct.pending()).toBe(0);
		const capped = createResponsesApiDraftFake({ steps: steps() });
		expect((await capped.fetch(RESPONSES_API_PATH, { ...post(), body: excess })).status).toBe(413);
		expect(capped.pending()).toBe(2);
	});

	it("decodes valid UTF-8 across incremental upload chunk boundaries", async () => {
		const body = { ...valid, instructions: "DYTEST é😀" };
		const bytes = Buffer.from(JSON.stringify(body));
		let offset = 0;
		const upload = new ReadableStream<Uint8Array>({
			pull(controller) {
				if (offset === bytes.length) controller.close();
				else controller.enqueue(bytes.subarray(offset, ++offset));
			},
		});
		const init: RequestInit & { duplex: "half" } = {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: upload,
			duplex: "half",
		};
		const fake = createResponsesApiDraftFake({
			steps: [{ kind: "json", body: { chunked: true } }],
		});
		expect(await (await fake.fetch(RESPONSES_API_PATH, init)).json()).toEqual({ chunked: true });
	});

	it("uses ordinary last-member JSON semantics without claiming duplicate-member refusal", async () => {
		const wire = JSON.stringify(valid).replace('"store":false', '"store":true,"store":false');
		const fake = createResponsesApiDraftFake({ steps: [{ kind: "json", body: { last: true } }] });
		expect(await (await fake.fetch(RESPONSES_API_PATH, { ...post(), body: wire })).json()).toEqual({
			last: true,
		});
	});

	it.each([65_536, 65_537])(
		"bounds direct handler read work at %i value chunks including empty chunks",
		async (chunks) => {
			const bytes = Buffer.from(JSON.stringify(valid));
			let emitted = 0;
			const upload = new ReadableStream<Uint8Array>({
				pull(controller) {
					if (emitted === chunks) controller.close();
					else controller.enqueue(emitted++ === 0 ? bytes : new Uint8Array(0));
				},
			});
			const init: RequestInit & { duplex: "half" } = {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: upload,
				duplex: "half",
			};
			const fake = createResponsesApiDraftFake({ steps: steps() });
			const response = await fake.handler(
				new Request(`https://${RESPONSES_API_HOST}${RESPONSES_API_PATH}`, init),
			);
			expect(response.status).toBe(chunks === 65_536 ? 200 : 400);
			expect(await response.json()).toEqual(chunks === 65_536 ? { reserved: 1 } : refused);
			expect(emitted).toBe(chunks);
			expect(fake.pending()).toBe(1);
			expect(await (await fake.fetch(RESPONSES_API_PATH, post(valid))).json()).toEqual({
				reserved: 2,
			});
		},
	);

	it("returns exhaustion before attempting strict request validation", async () => {
		const fake = createResponsesApiDraftFake();
		const response = await fake.fetch(RESPONSES_API_PATH, { method: "POST", body: "not JSON" });
		expect(response.status).toBe(503);
		expect(await response.json()).toEqual({
			error: { type: "server_error", code: "script_exhausted", message: "Synthetic exhaustion" },
		});
	});

	it("consumes strict steps on app admission after intake, including a concurrent refusal", async () => {
		const fake = createResponsesApiDraftFake({
			steps: [...steps(), { kind: "json", body: { reserved: 3 } }],
		});
		let upload!: ReadableStreamDefaultController<Uint8Array>;
		const body = new ReadableStream<Uint8Array>({
			start: (controller) => {
				upload = controller;
			},
		});
		const init: RequestInit & { duplex: "half" } = {
			method: "POST",
			headers: { "content-type": "application/json" },
			body,
			duplex: "half",
		};
		const first = fake.fetch(RESPONSES_API_PATH, init);
		const second = fake.fetch(RESPONSES_API_PATH, post({ ...valid, store: true }));
		let released = false;
		const release = () => {
			if (released) return;
			released = true;
			upload.enqueue(Buffer.from(JSON.stringify(valid)));
			upload.close();
		};
		try {
			expect(fake.pending()).toBe(3);
			expect(await (await second).json()).toEqual(refused);
			expect(fake.recorder.takeRequests()).toEqual([]);
			release();
			expect(await (await first).json()).toEqual({ reserved: 2 });
			expect(await (await fake.fetch(RESPONSES_API_PATH, post(valid))).json()).toEqual({
				reserved: 3,
			});
		} finally {
			release();
			await Promise.allSettled([first, second]);
		}
	});

	it("rejects a direct handler's aborted strict upload and cleans reader listeners", async () => {
		const before = timers();
		const fake = createResponsesApiDraftFake({ steps: steps() });
		const controller = new AbortController();
		let upload!: ReadableStreamDefaultController<Uint8Array>;
		let released = false;
		let canceled = false;
		let producerClosed = false;
		const body = new ReadableStream<Uint8Array>({
			start: (value) => {
				upload = value;
			},
			cancel: () => {
				canceled = true;
				released = true;
			},
		});
		const init: RequestInit & { duplex: "half" } = {
			method: "POST",
			headers: { "content-type": "application/json" },
			body,
			signal: controller.signal,
			duplex: "half",
		};
		const request = new Request(`https://${RESPONSES_API_HOST}${RESPONSES_API_PATH}`, init);
		const added = vi.spyOn(request.signal, "addEventListener");
		const removed = vi.spyOn(request.signal, "removeEventListener");
		const pending = fake.handler(request);
		const rejected = expect(pending).rejects.toBe("DYTEST active upload abort");
		const release = () => {
			if (released) return;
			released = true;
			producerClosed = true;
			upload.close();
		};
		try {
			expect(fake.pending()).toBe(1);
			await setImmediate();
			controller.abort("DYTEST active upload abort");
			// The raw handler has no recorder or shared intake wrapper.
			expect(canceled).toBe(true);
			expect(producerClosed).toBe(false);
			await rejected;
			expect(producerClosed).toBe(false);
			await setImmediate();
			expect(timers()).toBeLessThanOrEqual(before);
			for (const [type, listener] of added.mock.calls)
				if (type === "abort")
					expect(removed.mock.calls.some(([name, old]) => name === type && old === listener)).toBe(
						true,
					);
			expect(await (await fake.fetch(RESPONSES_API_PATH, post(valid))).json()).toEqual({
				reserved: 2,
			});
		} finally {
			controller.abort("DYTEST active upload cleanup");
			release();
			await Promise.allSettled([pending]);
			await rejected;
			added.mockRestore();
			removed.mockRestore();
		}
	});

	it("preserves a direct strict handler's upload source error instead of a fixed refusal", async () => {
		const before = timers();
		const fake = createResponsesApiDraftFake({
			steps: [
				{ kind: "raw", body: "abc", chunkBytes: 1, chunkDelayMs: Infinity },
				{ kind: "json", body: { reserved: 2 } },
			],
		});
		const controller = new AbortController();
		let upload!: ReadableStreamDefaultController<Uint8Array>;
		const body = new ReadableStream<Uint8Array>({
			start: (value) => {
				upload = value;
			},
		});
		const init: RequestInit & { duplex: "half" } = {
			method: "POST",
			headers: { "content-type": "application/json" },
			body,
			signal: controller.signal,
			duplex: "half",
		};
		const request = new Request(`https://${RESPONSES_API_HOST}${RESPONSES_API_PATH}`, init);
		const added = vi.spyOn(request.signal, "addEventListener");
		const removed = vi.spyOn(request.signal, "removeEventListener");
		const failure = new Error("DYTEST strict upload failure");
		const pending = fake.handler(request);
		const rejected = expect(pending).rejects.toBe(failure);
		let failed = false;
		const fail = () => {
			if (failed) return;
			failed = true;
			upload.error(failure);
		};
		try {
			expect(fake.pending()).toBe(1);
			await setImmediate();
			fail();
			await rejected;
			await setImmediate();
			expect(timers()).toBeLessThanOrEqual(before);
			expect(fake.recorder.takeRequests()).toEqual([]);
			for (const [type, listener] of added.mock.calls)
				if (type === "abort")
					expect(removed.mock.calls.some(([name, old]) => name === type && old === listener)).toBe(
						true,
					);
			expect(await (await fake.fetch(RESPONSES_API_PATH, post(valid))).json()).toEqual({
				reserved: 2,
			});
		} finally {
			fail();
			controller.abort("DYTEST strict failure cleanup");
			await Promise.allSettled([pending]);
			added.mockRestore();
			removed.mockRestore();
		}
	});

	it("preserves strict response cancellation and the consumed reservation", async () => {
		const before = timers();
		const fake = createResponsesApiDraftFake({
			steps: [
				{ kind: "json", body: { reserved: 1 }, delayMs: Infinity },
				{ kind: "json", body: { reserved: 2 } },
			],
		});
		const controller = new AbortController();
		const pending = fake.fetch(RESPONSES_API_PATH, { ...post(valid), signal: controller.signal });
		const rejection = expect(pending).rejects.toBe("DYTEST strict abort");
		try {
			await setImmediate();
			expect(fake.pending()).toBe(1);
			controller.abort("DYTEST strict abort");
			await rejection;
			await setImmediate();
			expect(timers()).toBeLessThanOrEqual(before);
			expect(await (await fake.fetch(RESPONSES_API_PATH, post(valid))).json()).toEqual({
				reserved: 2,
			});
		} finally {
			controller.abort("DYTEST strict cleanup");
			await Promise.allSettled([pending]);
		}
	});

	it("preserves before and after fault ownership for strict admitted requests", async () => {
		const fake = createResponsesApiDraftFake({ steps: steps() });
		fake.faults.add({ kind: "rate-limit", retryAfter: 3 });
		const before = await fake.fetch(RESPONSES_API_PATH, post({ ...valid, store: true }));
		expect(before.status).toBe(429);
		await before.arrayBuffer();
		expect(fake.pending()).toBe(2);
		fake.faults.add({ kind: "server-error", after: true });
		const after = await fake.fetch(RESPONSES_API_PATH, post(valid));
		expect(after.status).toBe(503);
		await after.arrayBuffer();
		expect(fake.pending()).toBe(1);
		expect(await (await fake.fetch(RESPONSES_API_PATH, post(valid))).json()).toEqual({
			reserved: 2,
		});
	});
});
