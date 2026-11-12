import { createHash } from "node:crypto";
import type { DraftOutcome } from "@draftyak/protocol/ai-provider-v1";
import { headersSha256 } from "@draftyak/protocol/hash";
import { HOST_MAX_ACTIVE_REQUESTS, HOST_REQUEST_TIMEOUT_MS } from "@draftyak/protocol/host-channel";
import {
	createPluginContext,
	HostError,
	type HostFetch,
	type HostFetchInit,
	memoryHost,
	type PluginContext,
	PluginError,
	type PluginRequestContext,
} from "@draftyak/sdk";
import { describe, expect, it, vi } from "vitest";
import { type CompatibleFormat, MAX_RESPONSE_BYTES } from "../src/index.ts";
import {
	COMPATIBLE_CALL_TIMEOUT_MS,
	COMPATIBLE_MAX_ACTIVE_CALLS,
	COMPATIBLE_PROGRESS_INTERVAL_MS,
	createPlugin,
} from "../src/plugin.ts";
import { core, MODEL, OUTPUT, REQUEST } from "./helpers.ts";

const formats = ["json_schema", "json_object", "ollama"] as const;
const prompt = {
	...REQUEST,
	system: "DYTEST trusted\r\nCaf\u00e9",
	prompt: "DYTEST thread\n\u{1f98a}",
};

function deferred<T>() {
	let resolve!: (value: T) => void;
	const promise = new Promise<T>((done) => {
		resolve = done;
	});
	return { promise, resolve };
}
function envelope(format: CompatibleFormat, output: unknown = OUTPUT, reason = "stop") {
	const message = { role: "assistant", content: JSON.stringify(output) };
	return format === "ollama"
		? {
				model: MODEL,
				message,
				done: true,
				done_reason: reason,
				prompt_eval_count: 7,
				eval_count: 3,
			}
		: {
				model: MODEL,
				choices: [{ message, finish_reason: reason }],
				usage: { prompt_tokens: 7, completion_tokens: 3 },
			};
}
function reply(value: unknown, status = 200, headers: Record<string, string> = {}) {
	return new Response(JSON.stringify(value), {
		status,
		headers: { "content-type": "application/json", ...headers },
	});
}
function mounted(format: CompatibleFormat = "json_schema", transport?: HostFetch) {
	const config = {
		endpoint: `http://127.0.0.1:11434/${format === "ollama" ? "api/chat" : "v1/chat/completions"}`,
		model: MODEL,
		format,
		resolution: { hostname: "127.0.0.1", destination: "local" },
	};
	const instance = { id: "DYTEST-compatible-instance", config };
	const plugin = createPlugin(instance);
	const controller = new AbortController();
	const calls: { url: string; init: HostFetchInit }[] = [];
	const host = memoryHost(() => {
		throw new Error("Unexpected host operation");
	});
	const fetch: HostFetch = async (input, init = {}) => {
		calls.push({ url: input.toString(), init });
		return transport ? transport(input, init) : reply(envelope(format));
	};
	const context: PluginContext = {
		...createPluginContext({ plugin: plugin.plugin, instance }, host, controller.signal),
		fetch,
	};
	const invoke = (
		name: string,
		args: unknown = {},
		request?: PluginRequestContext,
		ctx = context,
	) => {
		const tool = plugin.tools.find((entry) => entry.name === name);
		if (!tool) throw new Error(`Missing tool ${name}`);
		return Promise.resolve(tool.handler(args, ctx, {}, request));
	};
	return { config, plugin, controller, calls, context, invoke, close: () => host.close() };
}

describe("compatible provider SDK tools", () => {
	it("mounts exactly the provider contract and describes without network activity", async () => {
		const h = mounted();
		try {
			expect(h.plugin.plugin).toBe("@draftyak/ai-chat-completions");
			expect(h.plugin.tools.map(({ name }) => name).sort()).toEqual([
				"ai_describe",
				"ai_draft_generate",
				"ai_models_list",
				"ai_probe",
			]);
			expect(await h.invoke("ai_describe")).toEqual({
				name: "Chat Completions-compatible endpoint",
				structuredOutput: "validated",
			});
			expect(h.calls).toHaveLength(0);
		} finally {
			h.close();
		}
	});

	it.each(formats)(
		"preserves %s bytes, context and per-request progress through the SDK",
		async (format) => {
			const received = { ...OUTPUT, contextRefs: ["c1", "c2", "c3"] };
			const response = reply(envelope(format, received));
			const h = mounted(format, async () => response);
			const progress = vi.fn(async (_value: number, _total?: number) => {});
			const unrelated = vi.fn(async () => {});
			try {
				const expected = core(format).build(prompt);
				h.config.endpoint = "http://127.0.0.1:9931/v1/chat/completions";
				h.config.model = "DYTEST-other-model";
				const outcome = await h.invoke(
					"ai_draft_generate",
					prompt,
					{ progress },
					{
						...h.context,
						progress: unrelated,
					},
				);
				expect(outcome).toEqual({
					kind: "draft",
					model: MODEL,
					fallback: false,
					usage: { input: 7, output: 3 },
					output: { ...OUTPUT, contextRefs: ["c1", "c3"] },
				});
				expect(h.calls).toHaveLength(1);
				const call = h.calls[0];
				expect(call?.url).toBe(expected.url);
				expect(call?.init).toMatchObject({ method: "POST", stream: true, redirect: "error" });
				expect(call?.init.signal).toBeInstanceOf(AbortSignal);
				expect(call?.init.body).toBe(expected.body);
				expect(createHash("sha256").update(String(call?.init.body)).digest("hex")).toBe(
					expected.bodySha256,
				);
				expect(headersSha256([...new Headers(call?.init.headers).entries()])).toBe(
					expected.headersSha256,
				);
				expect(JSON.parse(String(call?.init.body))).toMatchObject({
					model: MODEL,
					stream: false,
					messages: [
						{ role: "system", content: prompt.system },
						{ role: "user", content: prompt.prompt },
					],
				});
				expect(progress.mock.calls).toEqual([
					[0, 1],
					[1, 1],
				]);
				expect(unrelated).not.toHaveBeenCalled();
				expect(response.bodyUsed).toBe(true);
				expect(response.body?.locked).toBe(false);
			} finally {
				h.close();
			}
		},
	);

	it.each(formats)("uses the %s models endpoint without sending a draft body", async (format) => {
		const body = format === "ollama" ? { models: [{ name: MODEL }] } : { data: [{ id: MODEL }] };
		const response = reply(body);
		const h = mounted(format, async () => response);
		try {
			expect(await h.invoke("ai_models_list")).toEqual({
				models: [{ id: MODEL, fallbacks: false }],
			});
			expect(h.calls).toHaveLength(1);
			expect(h.calls[0]?.url).toBe(
				`http://127.0.0.1:11434/${format === "ollama" ? "api/tags" : "v1/models"}`,
			);
			expect(h.calls[0]?.init).toMatchObject({ method: "GET", stream: true, redirect: "error" });
			expect(h.calls[0]?.init.body).toBeUndefined();
			expect([...new Headers(h.calls[0]?.init.headers)]).toEqual([]);
			expect(response.body?.locked).toBe(false);
		} finally {
			h.close();
		}
	});

	it("runs a synthetic probe and rejects another model before fetching", async () => {
		const empty = { ...OUTPUT, body: "", contextRefs: [] };
		const h = mounted("json_object", async () => reply(envelope("json_object", empty)));
		try {
			expect(await h.invoke("ai_probe", { model: MODEL })).toEqual({ status: "ok" });
			const body = JSON.parse(String(h.calls[0]?.init.body));
			expect(body.messages[1].content).toBe(
				`Return exactly ${JSON.stringify({ ...empty, ownerNotes: "", needsOwnerInput: [], suspectedInstructions: false })}.`,
			);
			await expect(h.invoke("ai_probe", { model: "DYTEST-other-model" })).rejects.toMatchObject({
				result: { code: "INVALID_INPUT" },
			});
			expect(h.calls).toHaveLength(1);
		} finally {
			h.close();
		}
	});

	it("probes the configured model when the optional model argument is omitted", async () => {
		const h = mounted("json_schema", async () =>
			reply(envelope("json_schema", { ...OUTPUT, body: "", contextRefs: [] })),
		);
		try {
			expect(await h.invoke("ai_probe")).toEqual({ status: "ok" });
			expect(h.calls).toHaveLength(1);
			expect(JSON.parse(String(h.calls[0]?.init.body)).model).toBe(MODEL);
		} finally {
			h.close();
		}
	});

	it.each([
		{ ...REQUEST, model: "DYTEST-other-model" },
		{ ...REQUEST, prompt: 7 },
		{ ...REQUEST, extra: "DYTEST-unexpected" },
	])("refuses invalid SDK input before transport", async (request) => {
		const h = mounted();
		try {
			await expect(h.invoke("ai_draft_generate", request)).rejects.toMatchObject({
				result: { code: "INVALID_INPUT" },
			});
			expect(h.calls).toHaveLength(0);
		} finally {
			h.close();
		}
	});

	it.each([
		{ reason: "length", kind: "truncated" },
		{ reason: "content_filter", kind: "refusal" },
		{ reason: "stop", kind: "invalid" },
	])("keeps a $kind outcome as data without an internal repair call", async ({ reason, kind }) => {
		const h = mounted("json_schema", async () =>
			reply(envelope("json_schema", { ...OUTPUT, body: 9 }, reason)),
		);
		try {
			expect(await h.invoke("ai_draft_generate", REQUEST)).toMatchObject({
				kind,
				model: MODEL,
				fallback: false,
			});
			expect(h.calls).toHaveLength(1);
		} finally {
			h.close();
		}
	});

	it.each([
		{ status: 401, code: "AUTH_REVOKED" },
		{ status: 403, code: "PERMISSION_DENIED" },
		{ status: 429, code: "RATE_LIMITED" },
		{ status: 503, code: "TRANSIENT" },
	])("maps HTTP $status to a content-free SDK error", async ({ status, code }) => {
		const response = reply({ error: { message: "DYTEST-private-provider-detail" } }, status, {
			"retry-after": "2",
		});
		const h = mounted("json_schema", async () => response);
		try {
			await expect(h.invoke("ai_draft_generate", REQUEST)).rejects.toSatisfy(
				(error: unknown) =>
					error instanceof PluginError &&
					error.message === code &&
					error.result.code === code &&
					!JSON.stringify(error.result).includes("DYTEST-private") &&
					(status !== 429 || error.result.retryAfterMs === 2000),
			);
			expect(h.calls).toHaveLength(1);
			expect(response.body?.locked).toBe(false);
		} finally {
			h.close();
		}
	});

	it.each([
		{ failure: new HostError("DENIED"), code: "PERMISSION_DENIED" },
		{ failure: new Error("DYTEST-private-transport-detail"), code: "TRANSIENT" },
	])("sanitizes a rejected transport as $code without retrying", async ({ failure, code }) => {
		failure.message = "DYTEST-private-transport-detail";
		const h = mounted("json_schema", async () => {
			throw failure;
		});
		try {
			await expect(h.invoke("ai_draft_generate", REQUEST)).rejects.toSatisfy(
				(error: unknown) =>
					error instanceof PluginError &&
					error.message === code &&
					error.result.code === code &&
					!JSON.stringify(error.result).includes("DYTEST-private"),
			);
			expect(h.calls).toHaveLength(1);
		} finally {
			h.close();
		}
	});

	it.each(["redirected", "url"])(
		"refuses response %s substitution and releases its body",
		async (field) => {
			const response = reply(envelope("json_schema"));
			Object.defineProperty(response, field, {
				value: field === "url" ? "https://other.example.test/" : true,
			});
			const h = mounted("json_schema", async () => response);
			try {
				await expect(h.invoke("ai_draft_generate", REQUEST)).rejects.toMatchObject({
					result: { code: "TRANSIENT" },
				});
				expect(response.body?.locked).toBe(false);
				expect(h.calls).toHaveLength(1);
			} finally {
				h.close();
			}
		},
	);

	it("cancels an oversized actual response stream without reading another chunk", async () => {
		let cancelled = 0;
		let readsPastLimit = 0;
		const response = new Response(
			new ReadableStream<Uint8Array>(
				{
					start(controller) {
						controller.enqueue(new Uint8Array(MAX_RESPONSE_BYTES + 1));
					},
					pull(controller) {
						readsPastLimit++;
						controller.close();
					},
					cancel() {
						cancelled++;
					},
				},
				{ highWaterMark: 0 },
			),
			{ headers: { "content-type": "application/json" } },
		);
		const h = mounted("json_schema", async () => response);
		try {
			await expect(h.invoke("ai_draft_generate", REQUEST)).rejects.toMatchObject({
				result: { code: "TRANSIENT" },
			});
			expect(cancelled).toBe(1);
			expect(readsPastLimit).toBe(0);
			expect(response.body?.locked).toBe(false);
			expect(h.calls).toHaveLength(1);
		} finally {
			h.close();
		}
	});

	it("propagates caller cancellation to a pending body read and releases the reader", async () => {
		const reading = deferred<void>();
		const cancellation = deferred<void>();
		let cancelled = 0;
		let body!: ReadableStream<Uint8Array>;
		body = new ReadableStream<Uint8Array>({
			pull() {
				if (body.locked) reading.resolve();
			},
			cancel() {
				cancelled++;
				cancellation.resolve();
			},
		});
		const response = new Response(body, { headers: { "content-type": "application/json" } });
		const h = mounted("json_schema", async () => response);
		try {
			const result = h.invoke("ai_draft_generate", REQUEST);
			const observed = result.catch((error: unknown) => error);
			await reading.promise;
			expect(response.body?.locked).toBe(true);
			h.controller.abort();
			expect(await observed).toMatchObject({ result: { code: "TRANSIENT" } });
			await cancellation.promise;
			expect(h.calls[0]?.init.signal?.aborted).toBe(true);
			expect(cancelled).toBe(1);
			await vi.waitFor(() => expect(response.body?.locked).toBe(false));
		} finally {
			h.close();
		}
	});

	it("refuses an already-cancelled caller without transport", async () => {
		const h = mounted();
		try {
			h.controller.abort();
			await expect(h.invoke("ai_draft_generate", REQUEST)).rejects.toMatchObject({
				result: { code: "TRANSIENT" },
			});
			expect(h.calls).toHaveLength(0);
		} finally {
			h.close();
		}
	});

	it("keeps request progress alive while pending and enforces the whole-call deadline", async () => {
		vi.useFakeTimers({
			toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "performance"],
		});
		const started = deferred<void>();
		const pending = deferred<Response>();
		const cancellation = deferred<void>();
		const response = new Response(
			new ReadableStream<Uint8Array>({
				cancel() {
					cancellation.resolve();
				},
			}),
		);
		const progress = vi.fn(async (_value: number, _total?: number) => {});
		const h = mounted("json_schema", async () => {
			started.resolve();
			return pending.promise;
		});
		const result = h.invoke("ai_draft_generate", REQUEST, { progress });
		let ended = false;
		const observed = result.then(
			(value) => {
				ended = true;
				return value;
			},
			(error: unknown) => {
				ended = true;
				return error;
			},
		);
		try {
			await started.promise;
			expect(COMPATIBLE_CALL_TIMEOUT_MS).toBe(HOST_REQUEST_TIMEOUT_MS);
			await vi.advanceTimersByTimeAsync(COMPATIBLE_PROGRESS_INTERVAL_MS);
			expect(progress.mock.calls).toEqual([
				[0, 1],
				[0, 1],
			]);
			await vi.advanceTimersByTimeAsync(HOST_REQUEST_TIMEOUT_MS - COMPATIBLE_PROGRESS_INTERVAL_MS);
			expect(ended).toBe(true);
			expect(await observed).toMatchObject({ result: { code: "TRANSIENT" } });
			expect(h.calls).toHaveLength(1);
			expect(h.calls[0]?.init.signal?.aborted).toBe(true);
			expect(progress.mock.calls.some(([value]) => value === 1)).toBe(false);
		} finally {
			h.controller.abort();
			pending.resolve(response);
			try {
				await observed;
				await cancellation.promise;
				await vi.waitFor(() => expect(response.body?.locked).toBe(false));
			} finally {
				h.close();
				vi.useRealTimers();
			}
		}
	});

	it("holds factory capacity until actual calls settle and then admits another call", async () => {
		const started = deferred<void>();
		const pending: ReturnType<typeof deferred<Response>>[] = [];
		let released = false;
		const h = mounted("json_schema", async () => {
			if (released || pending.length >= HOST_MAX_ACTIVE_REQUESTS)
				return reply(envelope("json_schema"));
			const call = deferred<Response>();
			pending.push(call);
			if (pending.length === COMPATIBLE_MAX_ACTIVE_CALLS) started.resolve();
			return call.promise;
		});
		expect(COMPATIBLE_MAX_ACTIVE_CALLS).toBe(HOST_MAX_ACTIVE_REQUESTS);
		const work = Array.from({ length: COMPATIBLE_MAX_ACTIVE_CALLS }, () =>
			h.invoke("ai_draft_generate", REQUEST),
		);
		const settled = Promise.allSettled(work);
		try {
			try {
				await started.promise;
				await expect(h.invoke("ai_draft_generate", REQUEST)).rejects.toMatchObject({
					result: { code: "TRANSIENT" },
				});
				expect(h.calls).toHaveLength(COMPATIBLE_MAX_ACTIVE_CALLS);
			} finally {
				released = true;
				for (const call of pending) call.resolve(reply(envelope("json_schema")));
				const outcomes = await settled;
				expect(
					outcomes.every(
						(outcome) =>
							outcome.status === "fulfilled" && (outcome.value as DraftOutcome).kind === "draft",
					),
				).toBe(true);
			}
			expect(await h.invoke("ai_draft_generate", REQUEST)).toMatchObject({ kind: "draft" });
			expect(h.calls).toHaveLength(COMPATIBLE_MAX_ACTIVE_CALLS + 1);
		} finally {
			h.close();
		}
	});

	it("retains cancelled calls until their actual fetches and body cleanup settle", async () => {
		const started = deferred<void>();
		const pending: ReturnType<typeof deferred<Response>>[] = [];
		const cleaned = Array.from({ length: HOST_MAX_ACTIVE_REQUESTS }, () => deferred<void>());
		const releaseCancellation = deferred<void>();
		const bodies: ReadableStream<Uint8Array>[] = [];
		const h = mounted("json_schema", async () => {
			if (pending.length >= HOST_MAX_ACTIVE_REQUESTS) return reply(envelope("json_schema"));
			const call = deferred<Response>();
			pending.push(call);
			if (pending.length === HOST_MAX_ACTIVE_REQUESTS) started.resolve();
			return call.promise;
		});
		const work = Array.from({ length: HOST_MAX_ACTIVE_REQUESTS }, () =>
			h.invoke("ai_draft_generate", REQUEST),
		);
		const settled = Promise.allSettled(work);
		try {
			try {
				await started.promise;
				h.controller.abort();
				const outcomes = await settled;
				expect(
					outcomes.every(
						(outcome) =>
							outcome.status === "rejected" &&
							outcome.reason instanceof PluginError &&
							outcome.reason.result.code === "TRANSIENT",
					),
				).toBe(true);
				await expect(
					h.invoke("ai_draft_generate", REQUEST, undefined, {
						...h.context,
						signal: new AbortController().signal,
					}),
				).rejects.toMatchObject({ result: { code: "TRANSIENT" } });
				expect(h.calls).toHaveLength(HOST_MAX_ACTIVE_REQUESTS);
				for (const [index, call] of pending.entries()) {
					const body = new ReadableStream<Uint8Array>({
						cancel() {
							cleaned[index]?.resolve();
							return releaseCancellation.promise;
						},
					});
					bodies.push(body);
					call.resolve(new Response(body));
				}
				await Promise.all(cleaned.map(({ promise }) => promise));
				await expect(
					h.invoke("ai_draft_generate", REQUEST, undefined, {
						...h.context,
						signal: new AbortController().signal,
					}),
				).rejects.toMatchObject({ result: { code: "TRANSIENT" } });
				expect(h.calls).toHaveLength(HOST_MAX_ACTIVE_REQUESTS);
			} finally {
				releaseCancellation.resolve();
				for (const call of pending) call.resolve(reply(envelope("json_schema")));
				await settled;
				await vi.waitFor(() => expect(bodies.every((body) => !body.locked)).toBe(true));
			}
			const live = { ...h.context, signal: new AbortController().signal };
			await vi.waitFor(async () =>
				expect(await h.invoke("ai_draft_generate", REQUEST, undefined, live)).toMatchObject({
					kind: "draft",
				}),
			);
			expect(h.calls).toHaveLength(HOST_MAX_ACTIVE_REQUESTS + 1);
		} finally {
			h.close();
		}
	});
});
