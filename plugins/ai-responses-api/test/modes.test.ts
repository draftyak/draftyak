import { performance } from "node:perf_hooks";
import type { AiProviderContext } from "@draftyak/sdk/ai-provider";
import { createPluginContext } from "@draftyak/sdk/context";
import { PluginError } from "@draftyak/sdk/errors";
import { memoryHost } from "@draftyak/sdk/host";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { modelMetadata } from "../src/client.ts";
import { MODES } from "../src/modes.ts";
import { createPlugin } from "../src/plugin.ts";
import { CONSUMER_TIMEOUT_MS, MAX_ERROR_BYTES, MAX_METADATA_BYTES } from "../src/runner.ts";
import { CANARY, input, mountedProvider } from "./helpers.ts";

const catalog = (count = 1): unknown => ({
	object: "list",
	data: Array.from({ length: count }, (_, index) => ({ object: "model", id: `model-${index}` })),
});
const response = (value: unknown, status = 200, headers: HeadersInit = {}): Response =>
	new Response(JSON.stringify(value), {
		status,
		headers: { "content-type": "application/json", ...headers },
	});
const mode = MODES["api-key"];
if (!mode) throw new Error("API-key handlers missing");
function context(
	fetch: AiProviderContext["fetch"],
	signal: AbortSignal = new AbortController().signal,
): AiProviderContext {
	return {
		...createPluginContext(
			{ plugin: "@draftyak/ai-responses-api" },
			memoryHost(() => {
				throw new Error("Unexpected host request");
			}),
			signal,
		),
		fetch,
		progress: async () => {},
	};
}
function padded(bytes: number, character = "x"): string {
	const base = JSON.stringify({ object: "list", data: [], padding: "" });
	const room = bytes - Buffer.byteLength(base);
	const count = Math.floor(room / Buffer.byteLength(character));
	return base.replace(
		'"padding":""',
		`"padding":"${character.repeat(count)}${" ".repeat(room - count * Buffer.byteLength(character))}"`,
	);
}

beforeEach(() => {
	vi.stubGlobal(
		"fetch",
		vi.fn(() => {
			throw new Error("Global fetch forbidden");
		}),
	);
});
afterEach(() => {
	expect(globalThis.fetch).not.toHaveBeenCalled();
	vi.restoreAllMocks();
	vi.unstubAllGlobals();
	vi.useRealTimers();
});

describe("API-key mode boundaries", () => {
	it.each(["unknown", "toString", "__proto__", "", null, 1])(
		"refuses an unknown mode without selecting API-key or starting I/O: %s",
		(value) => {
			expect(() => createPlugin(value as string)).toThrowError(
				expect.objectContaining({ result: { code: "UNSUPPORTED" } }),
			);
			expect(Object.keys(MODES)).toEqual(["api-key"]);
			expect(Object.isFrozen(MODES)).toBe(true);
			expect(Object.isFrozen(mode)).toBe(true);
		},
	);
	it.each([0, 500])(
		"returns the actual catalog at its allowed count boundary: %s",
		async (count) => {
			const fetch = vi.fn(async () => response(catalog(count)));
			const result = await mode.listModels({}, context(fetch));
			expect(result.models).toHaveLength(count);
			expect(result.models.at(-1)).toEqual(count ? { id: `model-${count - 1}` } : undefined);
			expect(fetch).toHaveBeenCalledTimes(1);
		},
	);
	it.each([
		["over-count", catalog(501)],
		[
			"duplicate",
			{
				object: "list",
				data: [
					{ object: "model", id: "same" },
					{ object: "model", id: "same" },
				],
			},
		],
		["malformed-envelope", { data: [] }],
		["wrong-record-kind", { object: "list", data: [{ object: "other", id: "m" }] }],
		["missing-id", { object: "list", data: [{ object: "model" }] }],
		["invalid-id", { object: "list", data: [{ object: "model", id: "bad id" }] }],
		["overlong-id", { object: "list", data: [{ object: "model", id: "x".repeat(257) }] }],
	])("refuses a %s catalog instead of a fabricated or truncated fallback", async (_name, value) => {
		await expect(
			mode.listModels(
				{},
				context(async () => response(value)),
			),
		).rejects.toMatchObject({ result: { code: "TRANSIENT" } });
	});
	it("accepts the exact 256-character model ID without deriving unsupported capability facts", async () => {
		const id = "m".repeat(256);
		expect(
			await mode.listModels(
				{},
				context(async () =>
					response({
						object: "list",
						data: [{ object: "model", id, name: CANARY, fallbacks: true, contextTokens: 10 }],
					}),
				),
			),
		).toEqual({ models: [{ id }] });
	});
	it("refuses mismatched probe metadata and maps an actual missing model without reading its body", async () => {
		await expect(
			mode.probe(
				{ model: "requested" },
				context(async () => response({ object: "model", id: "different" })),
			),
		).rejects.toMatchObject({ result: { code: "TRANSIENT" } });
		const cancel = vi.fn();
		const pull = vi.fn();
		const missing = new Response(new ReadableStream({ pull, cancel }), { status: 404 });
		await expect(
			mode.probe(
				{ model: "missing" },
				context(async () => missing),
			),
		).rejects.toMatchObject({ result: { code: "INVALID_INPUT" } });
		expect(cancel).toHaveBeenCalledTimes(1);
		expect(pull.mock.calls.length).toBeLessThanOrEqual(1);
	});
	it.each(["ai_models_list", "ai_probe", "ai_draft_generate"])(
		"preserves canonical error codes and safe retry hints through the mounted %s envelope",
		async (tool) => {
			for (const fault of [
				{ status: 401, code: "AUTH_REVOKED", retry: undefined },
				{ status: 403, code: "PERMISSION_DENIED", retry: undefined },
				{ status: 429, code: "RATE_LIMITED", retry: 0 },
				{
					status: 429,
					code: "QUOTA_EXCEEDED",
					retry: 1000,
					body: { error: { code: "insufficient_quota", message: CANARY } },
				},
				{ status: 500, code: "TRANSIENT", retry: undefined },
				{
					status: 400,
					code: "AUTH_EXPIRED",
					retry: Number.MAX_SAFE_INTEGER,
					body: {
						result: { code: "AUTH_EXPIRED", retryAfterMs: Number.MAX_SAFE_INTEGER, detail: CANARY },
					},
				},
			]) {
				await mountedProvider(
					() => ({
						status: fault.status,
						headers: [
							["content-type", "application/json"],
							...(fault.retry === undefined || fault.retry === Number.MAX_SAFE_INTEGER
								? []
								: [["retry-after", String(fault.retry / 1000)]]),
						],
						body: {
							base64: Buffer.from(
								JSON.stringify(fault.body ?? { error: { message: CANARY } }),
							).toString("base64url"),
						},
					}),
					async (ask) => {
						const result = (
							await ask("tools/call", {
								name: tool,
								arguments: tool === "ai_draft_generate" ? input : {},
							})
						).result;
						expect(result).toMatchObject({
							isError: true,
							structuredContent: {
								code: fault.code,
								...(fault.retry === undefined ? {} : { retryAfterMs: fault.retry }),
							},
						});
						expect(JSON.stringify(result)).not.toContain(CANARY);
						expect(result?.structuredContent).toEqual({
							code: fault.code,
							...(fault.retry === undefined ? {} : { retryAfterMs: fault.retry }),
						});
					},
				);
			}
		},
	);
});

describe("bounded SDK metadata consumer", () => {
	it.each(["x", "é"])(
		"admits exactly the UTF-8 budget and rejects +1 before JSON decoding: %s",
		async (character) => {
			const exact = padded(MAX_METADATA_BYTES, character);
			expect(Buffer.byteLength(exact)).toBe(MAX_METADATA_BYTES);
			const good = new Response(exact, {
				headers: { "content-type": "application/json", "content-length": "1" },
			});
			const sdkJson = vi.spyOn(good, "json");
			expect(await modelMetadata(async () => good)).toMatchObject({ object: "list", data: [] });
			expect(sdkJson).not.toHaveBeenCalled();
			const bytes = new TextEncoder().encode(`${exact} `);
			const bad = new Response(
				new ReadableStream({
					start(controller) {
						controller.enqueue(bytes.subarray(0, 400_000));
						controller.enqueue(bytes.subarray(400_000));
						controller.close();
					},
				}),
				{ headers: { "content-type": "application/json", "content-length": "1" } },
			);
			const outcome = await modelMetadata(async () => bad).then(
				() => ({ accepted: true }),
				(error: unknown) => ({ code: (error as { code: string }).code }),
			);
			expect(outcome).toEqual({ code: "TRANSIENT" });
		},
	);
	it.each([
		["ordinary whitespace and key order", ' \n { "data" : [], "object" : "list" } \t', true],
		["duplicate JSON field", '{"object":"list","data":[],"data":[]}', false],
		["malformed JSON", '{"object":"list","data":[}', false],
		[
			"excessive closed depth",
			`{"object":"list","data":[],"extra":${"[".repeat(65)}0${"]".repeat(65)}}`,
			false,
		],
	])(
		"uses strict JSON without requiring canonical serialization: %s",
		async (_name, text, accepted) => {
			const task = modelMetadata(
				async () =>
					new Response(text as string, { headers: { "content-type": "application/json" } }),
			);
			if (accepted) expect(await task).toEqual({ object: "list", data: [] });
			else await expect(task).rejects.toMatchObject({ code: "TRANSIENT" });
		},
	);
	it.each([new Uint8Array([0x80]), new Uint8Array([0xc3])])(
		"refuses malformed and truncated UTF-8",
		async (bytes) => {
			await expect(
				modelMetadata(
					async () => new Response(bytes, { headers: { "content-type": "application/json" } }),
				),
			).rejects.toMatchObject({ code: "TRANSIENT" });
		},
	);
	it.each([MAX_ERROR_BYTES, MAX_ERROR_BYTES + 1])(
		"bounds non-2xx before SDK parsing and preserves known status/hint: %i",
		async (size) => {
			const base = JSON.stringify({ error: { code: "AUTH_REVOKED", message: "" } });
			const raw = base.replace(
				'"message":""',
				`"message":"${"x".repeat(size - Buffer.byteLength(base))}"`,
			);
			expect(Buffer.byteLength(raw)).toBe(size);
			const received = new Response(raw, {
				status: 429,
				headers: { "content-type": "application/json", "retry-after": "0", "content-length": "1" },
			});
			const json = vi.spyOn(received, "json").mockRejectedValue(new Error(CANARY));
			const code = size === MAX_ERROR_BYTES ? "AUTH_REVOKED" : "RATE_LIMITED";
			await expect(modelMetadata(async () => received)).rejects.toMatchObject({
				code,
				retryAfterMs: 0,
				message: `responses: ${code}`,
			});
			expect(json).not.toHaveBeenCalled();
		},
	);
	it.each([false, true])(
		"interrupts a nonsettling metadata read and cancellation hook; caller abort=%s",
		async (callerAbort) => {
			vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
			const idleTimers = vi.getTimerCount();
			const caller = new AbortController();
			const reading = Promise.withResolvers<void>();
			const received = new Response(new ReadableStream<Uint8Array>(), {
				headers: { "content-type": "application/json" },
			});
			const body = received.body;
			if (!body) throw new Error("Expected stream body");
			const reader = body.getReader();
			vi.spyOn(reader, "read").mockImplementation(() => {
				reading.resolve();
				return new Promise(() => {});
			});
			const cancel = vi.spyOn(reader, "cancel").mockImplementation(() => new Promise(() => {}));
			vi.spyOn(body, "getReader").mockReturnValue(reader);
			let ownedSignal: AbortSignal | null | undefined;
			const task = modelMetadata(
				async (_url, init) => {
					ownedSignal = init?.signal;
					return received;
				},
				undefined,
				caller.signal,
			);
			const observed = task.then(
				() => "unexpected success",
				(error: unknown) => error,
			);
			await reading.promise;
			if (callerAbort) caller.abort();
			else await vi.advanceTimersByTimeAsync(CONSUMER_TIMEOUT_MS);
			expect(await observed).toMatchObject({ code: callerAbort ? "ABORTED" : "TRANSIENT" });
			expect(caller.signal.aborted).toBe(callerAbort);
			expect(ownedSignal?.aborted).toBe(true);
			expect(cancel).toHaveBeenCalledTimes(1);
			expect(body.locked).toBe(false);
			expect(vi.getTimerCount()).toBe(idleTimers);
			await vi.advanceTimersByTimeAsync(CONSUMER_TIMEOUT_MS);
			expect(cancel).toHaveBeenCalledTimes(1);
		},
	);
	it("retains HTTP authentication mapping for malformed optional JSON/UTF8 and rejects a non-JSON successful response", async () => {
		for (const body of ["not JSON", new Uint8Array([0x80])])
			await expect(
				modelMetadata(async () => new Response(body, { status: 401 })),
			).rejects.toMatchObject({ code: "AUTH_REVOKED" });
		await expect(
			modelMetadata(
				async () =>
					new Response(JSON.stringify(catalog()), { headers: { "content-type": "text/plain" } }),
			),
		).rejects.toMatchObject({ code: "TRANSIENT" });
	});
	it.each([false, true])(
		"interrupts pending fetch/body cleanup without waiting; actual caller abort=%s",
		async (callerAbort) => {
			vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
			const caller = new AbortController();
			const fetched = Promise.withResolvers<void>();
			const late = Promise.withResolvers<Response>();
			const pending = modelMetadata(
				async () => {
					fetched.resolve();
					return late.promise;
				},
				undefined,
				caller.signal,
			);
			const observed = pending.then(
				() => "success",
				(error: unknown) => error,
			);
			await fetched.promise;
			if (callerAbort) caller.abort();
			else await vi.advanceTimersByTimeAsync(CONSUMER_TIMEOUT_MS);
			expect(await observed).toMatchObject({ code: callerAbort ? "ABORTED" : "TRANSIENT" });
			const cancel = vi.fn(() => new Promise<void>(() => {}));
			late.resolve(new Response(new ReadableStream({ cancel })));
			await vi.advanceTimersByTimeAsync(0);
			expect(cancel).toHaveBeenCalledTimes(1);
		},
	);
	it("applies the monotonic deadline to late headers and a final cleanup hook without timer delivery", async () => {
		let now = 0;
		vi.spyOn(performance, "now").mockImplementation(() => now);
		const cancel = vi.fn();
		await expect(
			modelMetadata(async () => {
				now = CONSUMER_TIMEOUT_MS;
				return new Response(new ReadableStream({ cancel }));
			}),
		).rejects.toMatchObject({ code: "TRANSIENT" });
		expect(cancel).toHaveBeenCalledTimes(1);
		now = 0;
		await expect(
			modelMetadata(async (_url, init) => {
				init?.signal?.addEventListener("abort", () => {
					now = CONSUMER_TIMEOUT_MS;
				});
				return response(catalog());
			}),
		).rejects.toMatchObject({ code: "TRANSIENT" });
	});
	it("keeps local cancellation out of the canonical mounted error vocabulary", async () => {
		const controller = new AbortController();
		controller.abort();
		const fetch = vi.fn(async () => response(catalog()));
		await expect(modelMetadata(fetch, undefined, controller.signal)).rejects.toMatchObject({
			code: "ABORTED",
		});
		await expect(mode.listModels({}, context(fetch, controller.signal))).rejects.toEqual(
			new PluginError("TRANSIENT"),
		);
		expect(fetch).not.toHaveBeenCalled();
	});
});
