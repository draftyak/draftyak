import { spawnSync } from "node:child_process";
import { setImmediate as nextTurn } from "node:timers/promises";
import type { AiRequestBindingWithoutNetwork } from "@draftyak/hub";
import { APIConnectionError } from "openai";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createClient, EFFORTS, ResponsesError, type ResponsesFetch } from "../src/index.ts";
import { CANARY, input, message, nativeProviderFixture } from "./helpers.ts";

afterEach(() => {
	vi.restoreAllMocks();
	vi.unstubAllGlobals();
});

function noGlobalFetch(): ReturnType<typeof vi.fn> {
	const tripwire = vi.fn(() => {
		throw new Error("Global fetch forbidden");
	});
	vi.stubGlobal("fetch", tripwire);
	return tripwire;
}

function child(code: string, env: Record<string, string> = {}, flags: string[] = []): void {
	const result = spawnSync(process.execPath, [...flags, "--input-type=module", "-e", code], {
		cwd: import.meta.dirname,
		env,
		encoding: "utf8",
		windowsHide: true,
		shell: false,
		timeout: 15_000,
		maxBuffer: 128 * 1024,
	});
	expect(result.error).toBeUndefined();
	expect(result.signal).toBeNull();
	expect(result.stderr).toBe("");
	expect(result.status, result.stdout).toBe(0);
}

const factoryUrl = new URL("../src/client.ts", import.meta.url).href;
const requestUrl = new URL("../src/request.ts", import.meta.url).href;
const indexUrl = new URL("../src/index.ts", import.meta.url).href;

describe("native SDK lifecycle", () => {
	function binding(): AiRequestBindingWithoutNetwork {
		return {
			draft: {
				model: "gpt-synthetic",
				system: "Draft a plain-text reply.",
				prompt: "Synthetic thread; propose Tuesday.",
				contextIds: ["c1"],
			},
			settings: { kind: "responses", effort: "low" },
			endpoint: "https://api.openai.com/v1/responses",
		};
	}
	const terminal = (): Uint8Array =>
		new TextEncoder().encode(
			`data: ${JSON.stringify({ type: "response.completed", response: message() })}\n\n`,
		);

	it("returns native headers before start and waits for controlled ACKs after actual body delivery", async () => {
		const global = noGlobalFetch();
		const bytes = terminal();
		const native = await nativeProviderFixture({
			binding: binding(),
			manualStart: true,
			holdAck: "all",
			reply(response) {
				response.setHeader("content-type", "text/event-stream");
				response.end(bytes);
			},
		});
		try {
			await native.run(async () => {
				const response = await createClient(native.fetch).send(
					input,
					{ effort: "low" },
					native.caller.signal,
				);
				const stream = native.streams[0];
				if (!stream) throw new Error("Expected native stream");
				let completion = "pending";
				const finished = stream.completion.then(
					() => {
						completion = "completed";
					},
					() => {
						completion = "refused";
					},
				);
				await native.bodyWritten;
				await nextTurn();
				expect(response.status).toBe(200);
				expect(response.bodyUsed).toBe(false);
				expect(native.notifications).toEqual([]);
				expect(completion).toBe("pending");
				const reader = response.body?.getReader();
				if (!reader) throw new Error("Expected native response body");
				stream.start();
				const received: Uint8Array[] = [];
				let readFrames = 0;
				let next = await reader.read();
				while (!next.done) {
					if (!next.value.byteLength) throw new Error("Expected delivered bytes");
					received.push(next.value);
					const frame = native.notifications[readFrames++];
					if (!frame) throw new Error("Expected delivered native frame");
					expect(Buffer.from(frame.base64, "base64url")).toEqual(Buffer.from(next.value));
					expect(native.pendingAcks).toHaveLength(1);
					expect(completion).toBe("pending");
					if (readFrames === 1) {
						expect(native.notifications).toHaveLength(1);
						await nextTurn();
						expect(native.notifications).toHaveLength(1);
						expect(completion).toBe("pending");
					}
					if (frame.done) {
						expect((await reader.read()).done).toBe(true);
						break;
					}
					// This fixture ACK follows the actual reader receipt, not notification preparation.
					native.acknowledge();
					next = await reader.read();
				}
				expect(readFrames).toBeGreaterThan(0);
				expect(Buffer.concat(received)).toEqual(Buffer.from(bytes));
				expect(native.notifications.at(-1)).toMatchObject({ done: true });
				await nextTurn();
				expect(native.pendingAcks).toHaveLength(1);
				expect(completion).toBe("pending");
				native.acknowledge();
				await finished;
				expect(completion).toBe("completed");
				expect(native.pendingAcks).toEqual([]);
				expect(native.notifications.map(({ sequence }) => sequence)).toEqual(
					native.notifications.map((_frame, index) => index),
				);
				expect(native.seen.methods).toEqual(["POST"]);
				expect(native.seen.paths).toEqual(["/v1/responses"]);
				expect(native.seen.credentialMatched).toEqual([true]);
				expect(native.seen.sni).toEqual(["api.openai.com"]);
				expect(global).not.toHaveBeenCalled();
				reader.releaseLock();
			});
		} finally {
			await native.close();
		}
	});

	it("propagates original caller abort after headers into a pending native body without retry", async () => {
		const global = noGlobalFetch();
		const native = await nativeProviderFixture({
			binding: binding(),
			reply(response) {
				response.setHeader("content-type", "text/event-stream");
				response.flushHeaders();
			},
		});
		try {
			await native.run(async () => {
				const response = await createClient(native.fetch).send(
					input,
					{ effort: "low" },
					native.caller.signal,
				);
				const stream = native.streams[0];
				const reader = response.body?.getReader();
				if (!stream || !reader) throw new Error("Expected native streamed response");
				expect(response.status).toBe(200);
				expect(native.caller.signal.aborted).toBe(false);
				await nextTurn();
				const read = reader.read();
				void read.catch(() => undefined);
				native.caller.abort(CANARY);
				await expect(read).rejects.toMatchObject({ code: "DENIED" });
				await expect(stream.completion).rejects.toMatchObject({ code: "PROVIDER_HTTP_REFUSED" });
				await native.peerClosed;
				await nextTurn();
				expect(native.caller.signal.aborted).toBe(true);
				expect(native.streams).toHaveLength(1);
				expect(native.candidates).toHaveLength(1);
				expect(native.seen.methods).toEqual(["POST"]);
				expect(native.seen.credentialMatched).toEqual([true]);
				expect(global).not.toHaveBeenCalled();
				reader.releaseLock();
			});
		} finally {
			await native.close();
		}
	});

	it("retires an old vault generation after body delivery while the original caller stays live", async () => {
		const global = noGlobalFetch();
		const bytes = terminal();
		const native = await nativeProviderFixture({
			binding: binding(),
			reply(response) {
				response.setHeader("content-type", "text/event-stream");
				response.write(bytes.subarray(0, Math.floor(bytes.length / 2)));
			},
		});
		try {
			await native.run(async () => {
				const response = await createClient(native.fetch).send(
					input,
					{ effort: "low" },
					native.caller.signal,
				);
				const stream = native.streams[0];
				const reader = response.body?.getReader();
				if (!stream || !reader) throw new Error("Expected native streamed response");
				const first = await reader.read();
				if (first.done || !first.value.byteLength)
					throw new Error("Expected delivered native bytes");
				expect(Buffer.from(first.value)).toEqual(
					Buffer.from(bytes.subarray(0, first.value.length)),
				);
				await nextTurn();
				const generation = native.generation();
				const read = reader.read();
				void read.catch(() => undefined);
				native.rotate();
				expect(native.generation()).toBe(generation + 1);
				expect(native.caller.signal.aborted).toBe(false);
				await expect(read).rejects.toMatchObject({ code: "DENIED" });
				await expect(stream.completion).rejects.toMatchObject({ code: "PROVIDER_HTTP_REFUSED" });
				await native.peerClosed;
				await nextTurn();
				expect(native.caller.signal.aborted).toBe(false);
				expect(native.streams).toHaveLength(1);
				expect(native.candidates).toHaveLength(1);
				expect(native.seen.methods).toEqual(["POST"]);
				expect(native.seen.credentialMatched).toEqual([true]);
				expect(global).not.toHaveBeenCalled();
				reader.releaseLock();
			});
		} finally {
			await native.close();
		}
	});
});

describe("pinned injected-fetch Responses SDK", () => {
	it.each([undefined, null, {}, "fetch", 7])(
		"requires injected fetch before any I/O: %j",
		(value) => {
			const global = noGlobalFetch();
			expect(() => createClient(value as ResponsesFetch)).toThrowError(
				expect.objectContaining({ code: "INVALID_INPUT" }),
			);
			expect(global).not.toHaveBeenCalled();
		},
	);
	it.each([undefined, ...EFFORTS])(
		"records literal SDK wire fields with effort %s",
		async (effort) => {
			const global = noGlobalFetch();
			const response = new Response("data: [DONE]\n\n", {
				headers: { "content-type": "text/event-stream" },
			});
			const fetch = vi.fn<ResponsesFetch>(async (url, init) => {
				expect(String(url)).toBe("https://api.openai.com/v1/responses");
				expect(init?.method).toBe("POST");
				expect(init?.redirect).toBe("manual");
				expect(Object.fromEntries(new Headers(init?.headers))).toEqual({
					accept: "application/json",
					authorization: "Bearer brokered",
					"content-type": "application/json",
				});
				expect(JSON.parse(String(init?.body))).toEqual({
					model: input.model,
					instructions: input.system,
					input: [{ role: "user", content: input.prompt }],
					stream: true,
					store: false,
					text: {
						format: {
							type: "json_schema",
							name: "draft_output",
							strict: true,
							schema: expect.objectContaining({ type: "object", additionalProperties: false }),
						},
					},
					...(effort === undefined ? {} : { reasoning: { effort } }),
				});
				return response;
			});
			const client = createClient(fetch);
			expect(fetch).not.toHaveBeenCalled();
			expect(Object.isFrozen(client)).toBe(true);
			expect(Object.keys(client)).toEqual(["send"]);
			expect(await client.send(input, { effort })).toBe(response);
			expect(response.bodyUsed).toBe(false);
			expect(fetch).toHaveBeenCalledTimes(1);
			expect(global).not.toHaveBeenCalled();
			await response.body?.cancel();
		},
	);
	it.each([200, 301, 401, 429, 503])(
		"returns original %i response without reading its body or retrying",
		async (status) => {
			const global = noGlobalFetch();
			let reads = 0;
			const body = new ReadableStream(
				{
					pull() {
						reads++;
						throw new Error(CANARY);
					},
				},
				{ highWaterMark: 0 },
			);
			const response = new Response(body, {
				status,
				headers: { "content-type": "text/event-stream", "x-synthetic-response": "retained" },
			});
			const fetch = vi.fn<ResponsesFetch>(async () => response);
			expect(await createClient(fetch).send(input)).toBe(response);
			expect(response.status).toBe(status);
			expect(response.headers.get("x-synthetic-response")).toBe("retained");
			expect(response.bodyUsed).toBe(false);
			expect(reads).toBe(0);
			expect(fetch).toHaveBeenCalledTimes(1);
			expect(global).not.toHaveBeenCalled();
			await body.cancel();
		},
	);
	it("normalizes genuine fetch errors without retries, details, logging or fallback", async () => {
		const global = noGlobalFetch();
		const logs = [
			vi.spyOn(console, "debug"),
			vi.spyOn(console, "info"),
			vi.spyOn(console, "warn"),
			vi.spyOn(console, "error"),
		];
		const fetch = vi.fn<ResponsesFetch>(async () => {
			throw new Error(CANARY);
		});
		const error: unknown = await createClient(fetch)
			.send(input)
			.catch((failure: unknown) => failure);
		expect(error).toBeInstanceOf(ResponsesError);
		expect(error).toMatchObject({ code: "TRANSIENT", message: "responses: TRANSIENT" });
		expect(error).not.toHaveProperty("cause");
		expect(JSON.stringify(error, Object.getOwnPropertyNames(error))).not.toContain(CANARY);
		expect(fetch).toHaveBeenCalledTimes(1);
		expect(global).not.toHaveBeenCalled();
		for (const log of logs) expect(log).not.toHaveBeenCalled();
	});
	it("preserves canonical injected-fetch failures through the actual SDK wrapper", async () => {
		const value = {
			code: "AUTH_REVOKED",
			retryAfterMs: 0,
			message: CANARY,
			detail: CANARY,
			cause: new Error(CANARY),
		};
		const fetch = vi.fn<ResponsesFetch>(async () => {
			throw value;
		});
		const error: unknown = await createClient(fetch)
			.send(input)
			.catch((failure: unknown) => failure);
		expect(error).toBeInstanceOf(ResponsesError);
		expect(error).toMatchObject({
			code: "AUTH_REVOKED",
			retryAfterMs: 0,
			message: "responses: AUTH_REVOKED",
		});
		expect(error).not.toBe(value);
		for (const key of ["cause", "detail", "result"]) expect(error).not.toHaveProperty(key);
		expect(JSON.stringify(error, Object.getOwnPropertyNames(error))).not.toContain(CANARY);
		expect(fetch).toHaveBeenCalledTimes(1);
	});
	it("does not unwrap unrelated or counterfeit response causes", async () => {
		const response = new Response(CANARY, { status: 401 });
		const fetch = vi.fn<ResponsesFetch>(async () => {
			throw new APIConnectionError({ cause: Object.assign(new Error(CANARY), { response }) });
		});
		await expect(createClient(fetch).send(input)).rejects.toMatchObject({
			code: "TRANSIENT",
			message: "responses: TRANSIENT",
		});
		expect(fetch).toHaveBeenCalledTimes(1);
		expect(response.bodyUsed).toBe(false);
		await response.body?.cancel();
	});
	it("requires actual caller cancellation and propagates it to the SDK fetch signal", async () => {
		const controller = new AbortController();
		const fetch = vi.fn<ResponsesFetch>(async (_url, init) => {
			expect(init?.signal?.aborted).toBe(false);
			controller.abort(CANARY);
			expect(init?.signal?.aborted).toBe(true);
			throw new Error(CANARY);
		});
		await expect(createClient(fetch).send(input, {}, controller.signal)).rejects.toMatchObject({
			code: "ABORTED",
			message: "responses: ABORTED",
		});
		expect(fetch).toHaveBeenCalledTimes(1);
		fetch.mockClear();
		await expect(
			createClient(fetch).send(input, {}, AbortSignal.abort(CANARY)),
		).rejects.toMatchObject({ code: "ABORTED" });
		expect(fetch).not.toHaveBeenCalled();
		await expect(
			createClient(async () => {
				throw Object.assign(new Error(CANARY), { name: "AbortError" });
			}).send(input),
		).rejects.toMatchObject({ code: "TRANSIENT" });
	});
	it("lets actual cancellation win a non-2xx response race", async () => {
		const controller = new AbortController();
		const response = new Response(CANARY, { status: 429 });
		const fetch = vi.fn<ResponsesFetch>(async () => {
			controller.abort(CANARY);
			return response;
		});
		await expect(createClient(fetch).send(input, {}, controller.signal)).rejects.toMatchObject({
			code: "ABORTED",
			message: "responses: ABORTED",
		});
		expect(fetch).toHaveBeenCalledTimes(1);
		expect(response.bodyUsed).toBe(true);
	});
	it("cleans an owned response when unexpected SDK processing cannot return it", async () => {
		let cancels = 0;
		const body = new ReadableStream(
			{
				cancel() {
					cancels++;
				},
			},
			{ highWaterMark: 0 },
		);
		const response = new Response(body);
		Object.defineProperty(response, "ok", {
			get: () => {
				throw new Error(CANARY);
			},
		});
		try {
			await expect(createClient(async () => response).send(input)).rejects.toMatchObject({
				code: "TRANSIENT",
				message: "responses: TRANSIENT",
			});
			expect(cancels).toBe(1);
		} finally {
			await body.cancel();
		}
	});
	it("retains response cleanup ownership when the SDK drops the aborted sentinel cause", async () => {
		const controller = new AbortController();
		let cancels = 0;
		const body = new ReadableStream(
			{
				cancel() {
					cancels++;
				},
			},
			{ highWaterMark: 0 },
		);
		const response = new Response(body, { status: 429 });
		Object.defineProperty(response, "ok", {
			get: () => {
				controller.abort(CANARY);
				return false;
			},
		});
		try {
			await expect(
				createClient(async () => response).send(input, {}, controller.signal),
			).rejects.toMatchObject({ code: "ABORTED" });
			expect(cancels).toBe(1);
		} finally {
			await body.cancel();
		}
	});
	it("keeps concurrent response ownership separate when only one caller aborts", async () => {
		const controller = new AbortController();
		const cancels = [0, 0];
		const bodies = [0, 1].map(
			(index) =>
				new ReadableStream(
					{
						cancel() {
							cancels[index] = (cancels[index] ?? 0) + 1;
						},
					},
					{ highWaterMark: 0 },
				),
		);
		const first = new Response(bodies[0], { status: 429 });
		const second = new Response(bodies[1]);
		Object.defineProperty(first, "ok", {
			get: () => {
				queueMicrotask(() => controller.abort(CANARY));
				return false;
			},
		});
		const client = createClient(async (_url, init) =>
			JSON.parse(String(init?.body)).input[0].content === "first" ? first : second,
		);
		try {
			const outcomes = await Promise.allSettled([
				client.send({ ...input, prompt: "first" }, {}, controller.signal),
				client.send({ ...input, prompt: "second" }),
			]);
			expect(outcomes[0]).toMatchObject({ status: "rejected", reason: { code: "ABORTED" } });
			expect(outcomes[1]).toEqual({ status: "fulfilled", value: second });
			expect(cancels).toEqual([1, 0]);
			expect(second.bodyUsed).toBe(false);
		} finally {
			await Promise.all(bodies.map((body) => body.cancel()));
		}
	});
	it("snapshots effort before validation and actual SDK serialization", async () => {
		let reads = 0;
		const settings = Object.defineProperty({}, "effort", {
			get: () => (++reads === 1 ? "low" : CANARY),
		});
		const fetch = vi.fn<ResponsesFetch>(async (_url, init) => {
			expect(JSON.parse(String(init?.body)).reasoning).toEqual({ effort: "low" });
			return new Response("");
		});
		const response = await createClient(fetch).send(input, settings);
		expect(reads).toBe(1);
		await response.body?.cancel();
	});
	it("settles cancellation before a controlled pending body cleanup", async () => {
		const controller = new AbortController();
		let release: () => void = () => {};
		let cancels = 0;
		const gate = new Promise<void>((resolve) => {
			release = resolve;
		});
		const body = new ReadableStream(
			{
				cancel() {
					cancels++;
					return gate;
				},
			},
			{ highWaterMark: 0 },
		);
		const response = new Response(body, { status: 429 });
		const result = createClient(async () => {
			controller.abort(CANARY);
			return response;
		})
			.send(input, {}, controller.signal)
			.then(
				() => "unexpected success",
				(error: ResponsesError) => error.code,
			);
		try {
			const outcome = await Promise.race([
				result,
				new Promise<string>((resolve) => {
					setImmediate(() => resolve("cleanup blocked"));
				}),
			]);
			expect(outcome).toBe("ABORTED");
			expect(cancels).toBe(1);
		} finally {
			release();
			await result;
		}
	});
	it("does not replace cancellation with a synchronous body getter failure", async () => {
		const controller = new AbortController();
		const response = new Response("");
		const body = response.body;
		Object.defineProperty(response, "body", {
			get: () => {
				throw new Error(CANARY);
			},
		});
		await expect(
			createClient(async () => {
				controller.abort(CANARY);
				return response;
			}).send(input, {}, controller.signal),
		).rejects.toMatchObject({ code: "ABORTED", message: "responses: ABORTED" });
		await body?.cancel();
	});
	it("ignores synthetic ambient credentials, destination, tenant and logging settings", () => {
		child(
			`
			import assert from "node:assert/strict";
			const reads = [];
			const synthetic = process.env;
			process.env = new Proxy(synthetic, { get(target, key) { if (String(key).startsWith("OPENAI_")) reads.push(key); return Reflect.get(target, key); } });
			const { createClient } = await import(${JSON.stringify(factoryUrl)});
			globalThis.fetch = () => { throw new Error("Global fetch forbidden"); };
			let calls = 0;
			for (const name of ["debug", "info", "warn", "error"]) console[name] = () => { throw new Error("Logging forbidden"); };
			const result = await createClient(async (url, init) => {
				calls++;
				assert.equal(String(url), "https://api.openai.com/v1/responses");
				assert.deepEqual(Object.fromEntries(new Headers(init.headers)), { accept: "application/json", authorization: "Bearer brokered", "content-type": "application/json" });
				return new Response("", { status: 200 });
			}).send(${JSON.stringify(input)});
			assert.equal(calls, 1);
			assert.deepEqual(reads.filter((name) => name !== "OPENAI_CUSTOM_HEADERS"), []);
			await result.body.cancel();
		`,
			{
				OPENAI_API_KEY: "SYNTHETIC_KEY",
				OPENAI_ADMIN_KEY: "SYNTHETIC_ADMIN",
				OPENAI_ORG_ID: "SYNTHETIC_ORG",
				OPENAI_PROJECT_ID: "SYNTHETIC_PROJECT",
				OPENAI_WEBHOOK_SECRET: "SYNTHETIC_WEBHOOK",
				OPENAI_BASE_URL: "https://synthetic.invalid/v1?synthetic=1",
				OPENAI_LOG: "debug",
			},
		);
	});
	it.each(["own", "inherited", "getter"])(
		"refuses a synthetic %s custom-header name without reading its value",
		(kind) => {
			child(`
			import assert from "node:assert/strict";
			const target = {};
			let reads = 0;
			if (${JSON.stringify(kind)} === "getter") Object.defineProperty(target, "OPENAI_CUSTOM_HEADERS", { get() { reads++; throw new Error("Synthetic getter forbidden"); } });
			else target.OPENAI_CUSTOM_HEADERS = "x-synthetic: SYNTHETIC_ONLY";
			process.env = ${JSON.stringify(kind)} === "inherited" ? Object.create(target) : target;
			const { createClient } = await import(${JSON.stringify(factoryUrl)});
			let calls = 0;
			assert.throws(() => createClient(async () => { calls++; return new Response(""); }), (error) => error.code === "INVALID_INPUT");
			assert.equal(calls, 0);
			assert.equal(reads, 0);
		`);
		},
	);
	it("rechecks the custom-header name before each actual SDK construction", () => {
		child(`
			import assert from "node:assert/strict";
			const synthetic = {};
			process.env = synthetic;
			const { createClient } = await import(${JSON.stringify(factoryUrl)});
			let calls = 0;
			let reads = 0;
			const client = createClient(async () => { calls++; return new Response(""); });
			Object.defineProperty(synthetic, "OPENAI_CUSTOM_HEADERS", { get() { reads++; throw new Error("Synthetic header getter forbidden"); } });
			await assert.rejects(client.send(${JSON.stringify(input)}), (error) => error.code === "INVALID_INPUT");
			assert.equal(calls, 0);
			assert.equal(reads, 0);
		`);
	});
	it("cold imports preserve Zod configuration and build requests without dynamic code generation", () => {
		child(
			`
			import assert from "node:assert/strict";
			const { z } = await import(${JSON.stringify(import.meta.resolve("zod"))});
			await import(${JSON.stringify(import.meta.resolve("openai/helpers/zod"))});
			await import(${JSON.stringify(import.meta.resolve("@draftyak/protocol/ai-provider-v1"))});
			z.config({ jitless: false });
			const before = { ...z.config() };
			const { buildRequest } = await import(${JSON.stringify(requestUrl)});
			assert.deepEqual(z.config(), before);
			const { createClient } = await import(${JSON.stringify(indexUrl)});
			assert.deepEqual(z.config(), before);
			assert.equal(buildRequest(${JSON.stringify(input)}).body.store, false);
			const response = await createClient(async () => new Response("")).send(${JSON.stringify(input)});
			assert.deepEqual(z.config(), before);
			await response.body.cancel();
		`,
			{},
			["--disallow-code-generation-from-strings"],
		);
	});
});
