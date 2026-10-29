import { aiProviderV1 } from "@draftyak/protocol/ai-provider-v1";
import type { HostFetchParams, HostFetchResult } from "@draftyak/protocol/host-channel";
import { createPluginContext, type PluginContext } from "@draftyak/sdk/context";
import { PluginError, pluginErrorResult } from "@draftyak/sdk/errors";
import { HostError, memoryHost } from "@draftyak/sdk/host";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_MODEL, PLATFORM_HEADERS, verifyRequest } from "../src/index.ts";
import { createMessagesPlugin } from "../src/plugin.ts";
import { canary, draft, input, message, pin } from "./helpers.ts";

const manifest = {
	id: "@example/messages",
	version: "1.0.0",
	sdk: "1.0.0",
	kind: "ai-provider",
	contract: { extension: "io.github.draftyak/ai-provider", version: 1 },
	isolation: "standard",
	auth: { kind: "none", scopes: [], requiredGrantedScopes: [] },
	credentials: { mode: "brokered", urlSecrets: [] },
	permissions: {},
	license: "Apache-2.0",
	dataClasses: ["community.content"],
	egress: { profile: "messages-api-v1" },
};
const entry = createMessagesPlugin(manifest);
function reply(value: unknown, status = 200): HostFetchResult {
	return {
		status,
		headers: [["content-type", "application/json"]],
		body: { base64: Buffer.from(JSON.stringify(value)).toString("base64url") },
	};
}
const model = (id = "claude-model-1", fields: Record<string, unknown> = {}) => ({
	id,
	type: "model",
	display_name: "Synthetic model",
	lifecycle: "active",
	max_input_tokens: 12_345,
	...fields,
});
function page(data: ReturnType<typeof model>[], more = false): Record<string, unknown> {
	return { data, has_more: more, first_id: data[0]?.id ?? null, last_id: data.at(-1)?.id ?? null };
}
function fixture(
	respond: (
		request: HostFetchParams,
		index: number,
		signal: AbortSignal,
	) => HostFetchResult | Promise<HostFetchResult> = () => reply(message()),
	config: Readonly<Record<string, unknown>> = {},
) {
	const requests: HostFetchParams[] = [];
	const controller = new AbortController();
	const host = memoryHost((method, params, signal) => {
		expect(method).toBe("host/fetch");
		const request = params as HostFetchParams;
		requests.push(request);
		return respond(request, requests.length, signal);
	});
	const context = createPluginContext(
		{ plugin: manifest.id, instance: { id: "synthetic-instance", config } },
		host,
		controller.signal,
	);
	return { requests, context, controller };
}
function invoke(
	name: string,
	args: unknown,
	context: PluginContext,
	progress: (value: number, total?: number) => Promise<void> = async () => {},
): Promise<unknown> {
	const tool = entry.tools.find((candidate) => candidate.name === name);
	if (!tool) throw new Error("Missing provider tool");
	return Promise.resolve(tool.handler(args, context, {}, { progress }));
}
function checkHeaders(request: HostFetchParams): void {
	const headers = new Headers(
		request.headers.map(([name, value]): [string, string] => [name, value]),
	);
	expect(headers.get("x-api-key")).toBe("brokered");
	expect(headers.get("anthropic-version")).toBe("2023-06-01");
	expect(headers.get("authorization")).toBeNull();
	for (const name of PLATFORM_HEADERS) expect(headers.has(name)).toBe(false);
}
afterEach(() => vi.useRealTimers());

describe("Messages provider SDK component", () => {
	it("mounts exactly the four checked provider handlers without a network call", async () => {
		expect(entry.tools.map((tool) => tool.name).sort()).toEqual(
			Object.keys(aiProviderV1.tools).sort(),
		);
		const f = fixture();
		await expect(invoke("ai_describe", {}, f.context)).resolves.toEqual({
			name: "Anthropic Messages",
			structuredOutput: "native",
		});
		expect(f.requests).toEqual([]);
		for (const invalid of [null, { ...manifest, egress: { profile: "responses-api-v1" } }])
			expect(() => createMessagesPlugin(invalid)).toThrow("manifest refused");
	});
	it("lists only actual returned model metadata over bounded SDK pagination", async () => {
		const f = fixture((_request, index) =>
			reply(
				page(
					[model(`claude-model-${index}`, index === 2 ? { max_input_tokens: null } : {})],
					index === 1,
				),
			),
		);
		await expect(invoke("ai_models_list", {}, f.context)).resolves.toEqual({
			models: [
				{ id: "claude-model-1", name: "Synthetic model", contextTokens: 12_345 },
				{ id: "claude-model-2", name: "Synthetic model" },
			],
		});
		expect(f.requests.map((request) => [request.method, request.url, request.body])).toEqual([
			["GET", "https://api.anthropic.com/v1/models?limit=100", undefined],
			["GET", "https://api.anthropic.com/v1/models?limit=100&after_id=claude-model-1", undefined],
		]);
		for (const request of f.requests) checkHeaders(request);
	});
	it.each([
		page([model(), model()]),
		page([model("claude-model-1", { lifecycle: "retired" })]),
		page([model("not-a-messages-model")]),
		page([model("claude-model-1", { display_name: "x".repeat(129) })]),
		page([model("claude-model-1", { max_input_tokens: -1 })]),
		page(Array.from({ length: 101 }, (_, index) => model(`claude-model-${index}`))),
		page([], true),
		{ ...page([model()], true), last_id: "different-cursor" },
	])("refuses malformed, duplicate or oversized model metadata %#", async (body) => {
		const f = fixture(() => reply(body));
		await expect(invoke("ai_models_list", {}, f.context)).rejects.toMatchObject({
			result: { code: "TRANSIENT" },
		});
		expect(f.requests).toHaveLength(1);
	});
	it("refuses repeated IDs across pages and caps total model page requests", async () => {
		const duplicate = fixture((_request, index) => reply(page([model()], index === 1)));
		await expect(invoke("ai_models_list", {}, duplicate.context)).rejects.toMatchObject({
			result: { code: "TRANSIENT" },
		});
		expect(duplicate.requests).toHaveLength(2);
		const unending = fixture((_request, index) =>
			reply(page([model(`claude-model-${index}`)], true)),
		);
		await expect(invoke("ai_models_list", {}, unending.context)).rejects.toMatchObject({
			result: { code: "TRANSIENT" },
		});
		expect(unending.requests).toHaveLength(5);
	});
	it.each([undefined, "claude-explicit-model"])(
		"probes actual model metadata with status only (%s)",
		async (selected) => {
			const f = fixture(() => reply(model("claude-resolved-model", { extra: canary })), {
				model: "claude-configured-model",
			});
			await expect(
				invoke("ai_probe", selected ? { model: selected } : {}, f.context),
			).resolves.toEqual({ status: "ok" });
			expect(f.requests).toHaveLength(1);
			expect(f.requests[0]?.url).toBe(
				`https://api.anthropic.com/v1/models/${selected ?? "claude-configured-model"}`,
			);
			expect(f.requests[0]?.method).toBe("GET");
			checkHeaders(f.requests[0] as HostFetchParams);
		},
	);
	it("uses the existing default only for an unconfigured probe and reports retired metadata as degraded", async () => {
		const f = fixture(() => reply(model("claude-retired", { lifecycle: "retired" })));
		await expect(invoke("ai_probe", {}, f.context)).resolves.toEqual({
			status: "degraded",
			detail: "MODEL_RETIRED",
		});
		expect(f.requests[0]?.url).toBe(`https://api.anthropic.com/v1/models/${DEFAULT_MODEL}`);
	});
	it.each(
		(["ai_models_list", "ai_probe"] as const).flatMap((tool) =>
			["active", "deprecated", "retired"].map((lifecycle) => ({ tool, lifecycle })),
		),
	)("preserves the $lifecycle lifecycle result in $tool", async ({ tool, lifecycle }) => {
		const value = model("claude-model-1", { lifecycle });
		const f = fixture(() => reply(tool === "ai_models_list" ? page([value]) : value));
		const args = tool === "ai_probe" ? { model: value.id } : {};
		if (tool === "ai_models_list" && lifecycle === "retired")
			await expect(invoke(tool, args, f.context)).rejects.toMatchObject({
				result: { code: "TRANSIENT" },
			});
		else
			await expect(invoke(tool, args, f.context)).resolves.toEqual(
				tool === "ai_models_list"
					? { models: [{ id: value.id, name: "Synthetic model", contextTokens: 12_345 }] }
					: lifecycle === "retired"
						? { status: "degraded", detail: "MODEL_RETIRED" }
						: { status: "ok" },
			);
		expect(f.requests).toHaveLength(1);
	});
	it.each(
		(["ai_models_list", "ai_probe"] as const).flatMap((tool) =>
			[
				{ label: "array", lifecycle: ["retired"] },
				{ label: "object", lifecycle: { state: "retired" } },
				{ label: "missing", lifecycle: undefined },
			].map((value) => ({ tool, ...value })),
		),
	)("refuses $label lifecycle metadata in $tool", async ({ tool, lifecycle }) => {
		const value = model("claude-model-1", { lifecycle });
		const f = fixture(() => reply(tool === "ai_models_list" ? page([value]) : value));
		const observed = await invoke(
			tool,
			tool === "ai_probe" ? { model: value.id } : {},
			f.context,
		).then(
			(value) => ({ kind: "returned", value }),
			(error: unknown) => ({
				kind: "rejected",
				result: error instanceof PluginError ? error.result : undefined,
			}),
		);
		expect(f.requests).toHaveLength(1);
		expect(observed).toEqual({ kind: "rejected", result: { code: "TRANSIENT" } });
	});
	it.each([
		[message(), "draft"],
		[message({ stop_reason: "refusal", content: [{ type: "text", text: "not JSON" }] }), "refusal"],
		[
			message({ stop_reason: "max_tokens", content: [{ type: "text", text: "not JSON" }] }),
			"truncated",
		],
		[message({ content: [{ type: "text", text: "not JSON" }] }), "invalid"],
		[message({ stop_reason: "tool_use", content: [{ type: "tool_use" }] }), "unexpected"],
	])("returns the canonical %s draft outcome as %s", async (body, kind) => {
		const f = fixture(() => reply(body), {
			effort: "high",
			maxTokens: 123,
			model: "claude-other-default",
		});
		const value = await invoke("ai_draft_generate", { ...input, model: pin.model }, f.context);
		expect(value).toMatchObject({ kind, model: pin.model, usage: { input: 300, output: 100 } });
		expect(aiProviderV1.tools.ai_draft_generate.output.safeParse(value).success).toBe(true);
		expect(f.requests).toHaveLength(1);
		const request = f.requests[0] as HostFetchParams;
		const bytes = request.body && "base64" in request.body ? request.body.base64 : "";
		const outgoing = {
			...request,
			headers: new Headers(request.headers.map(([name, value]): [string, string] => [name, value])),
			body: JSON.parse(Buffer.from(bytes, "base64url").toString()),
		};
		expect(verifyRequest(outgoing, { ...pin, effort: "high" }).ok).toBe(true);
		expect(outgoing.body).toMatchObject({
			model: pin.model,
			system: input.system,
			messages: [{ role: "user", content: input.prompt }],
			max_tokens: 123,
		});
		checkHeaders(request);
	});
	it("normalizes references through the real shared parser instead of the SDK output parser", async () => {
		const f = fixture(() =>
			reply(
				message({
					content: [
						{ type: "text", text: JSON.stringify({ ...draft, contextRefs: ["c99", "C1", "c1"] }) },
					],
				}),
			),
		);
		await expect(
			invoke("ai_draft_generate", { ...input, model: pin.model }, f.context),
		).resolves.toMatchObject({ kind: "draft", output: { ...draft, contextRefs: ["c1"] } });
	});
	it.each(["apiKey", "authToken", "baseURL", "headers", "unknown"])(
		"refuses config override %s before I/O",
		async (key) => {
			const f = fixture(
				(request) =>
					reply(
						request.method === "POST"
							? message()
							: request.url.includes("?")
								? page([model()])
								: model(),
					),
				{ [key]: canary },
			);
			for (const [name, args] of [
				["ai_models_list", {}],
				["ai_probe", {}],
				["ai_draft_generate", { ...input, model: pin.model }],
			] as const) {
				let error: unknown;
				try {
					await invoke(name, args, f.context);
				} catch (caught) {
					error = caught;
				}
				expect({
					result: error instanceof PluginError ? error.result : undefined,
					requests: f.requests.length,
				}).toEqual({
					result: { code: "INVALID_INPUT" },
					requests: 0,
				});
			}
			expect(f.requests).toEqual([]);
		},
	);
	it("refuses behavioral configuration without executing hooks or making a request", async () => {
		let hooks = 0;
		for (const config of [
			Object.defineProperty({}, "baseURL", {
				enumerable: true,
				get() {
					hooks++;
					return canary;
				},
			}),
			new Proxy(
				{},
				{
					ownKeys() {
						hooks++;
						return [];
					},
				},
			),
		]) {
			const f = fixture(undefined, config);
			await expect(invoke("ai_probe", {}, f.context)).rejects.toMatchObject({
				result: { code: "INVALID_INPUT" },
			});
			expect(f.requests).toEqual([]);
		}
		expect(hooks).toBe(0);
	});
	it("rejects malformed configuration and draft inputs before transport", async () => {
		for (const config of [
			{ effort: "unbounded" },
			{ maxTokens: 0 },
			{ maxTokens: 16_001 },
			{ model: "unsupported" },
		]) {
			const f = fixture(undefined, config);
			await expect(invoke("ai_probe", {}, f.context)).rejects.toMatchObject({
				result: { code: "INVALID_INPUT" },
			});
			expect(f.requests).toEqual([]);
		}
		const f = fixture();
		for (const args of [
			{ system: "x", prompt: "x", model: pin.model },
			{ ...input, model: "unsupported" },
		])
			await expect(invoke("ai_draft_generate", args, f.context)).rejects.toMatchObject({
				result: { code: "INVALID_INPUT" },
			});
		expect(f.requests).toEqual([]);
	});
	it.each([
		[400, "INVALID_INPUT"],
		[401, "AUTH_EXPIRED"],
		[403, "PERMISSION_DENIED"],
		[404, "NOT_FOUND"],
		[429, "RATE_LIMITED"],
		[503, "TRANSIENT"],
	] as const)("maps HTTP %s to content-free %s without retrying", async (status, code) => {
		const f = fixture(() =>
			reply({ type: "error", error: { type: "synthetic_error", message: canary } }, status),
		);
		let error: unknown;
		try {
			await invoke("ai_probe", {}, f.context);
		} catch (caught) {
			error = caught;
		}
		expect(error).toBeInstanceOf(PluginError);
		expect(pluginErrorResult(error)).toMatchObject({ isError: true, structuredContent: { code } });
		expect(JSON.stringify(pluginErrorResult(error))).not.toContain(canary);
		expect(f.requests).toHaveLength(1);
	});
	it.each([
		[429, "3", 3_000],
		[429, "0", 0],
		[503, "2", 2_000],
		[500, "0", 0],
		[529, "4", 4_000],
		[429, "9007199254740", 9_007_199_254_740_000],
		[429, "9007199254741", undefined],
		[429, "-1", undefined],
		[429, "NaN", undefined],
		[429, "1e2", undefined],
		[429, "1.5", undefined],
		[429, "3, 4", undefined],
		[429, "x".repeat(129), undefined],
		[429, "Mon, 19 Oct 2026 09:30:18 GMT", 3_000],
		[503, "Mon, 19 Oct 2026 09:30:14 GMT", 0],
		[429, "Tue, 19 Oct 2026 09:30:18 GMT", undefined],
	] as const)(
		"preserves only a bounded HTTP %s Retry-After %s as %s",
		async (status, hint, expected) => {
			vi.useFakeTimers({ now: Date.UTC(2026, 9, 19, 9, 30, 15) });
			const f = fixture(() => {
				const response = reply(
					{ type: "error", error: { type: "rate_limit_error", message: canary } },
					status,
				);
				return { ...response, headers: [...response.headers, ["retry-after", hint]] };
			});
			let error: unknown;
			try {
				await invoke("ai_probe", {}, f.context);
			} catch (caught) {
				error = caught;
			}
			const code = status === 429 ? "RATE_LIMITED" : "TRANSIENT";
			expect(error).toBeInstanceOf(PluginError);
			expect(pluginErrorResult(error).structuredContent).toEqual(
				expected === undefined ? { code } : { code, retryAfterMs: expected },
			);
			expect(JSON.stringify(pluginErrorResult(error))).not.toContain(canary);
			expect(f.requests).toHaveLength(1);
			checkHeaders(f.requests[0] as HostFetchParams);
		},
	);
	it.each([
		["billing_error", "QUOTA_EXCEEDED"],
		["unrecognized_error", "TRANSIENT"],
	] as const)("maps the scripted HTTP402 %s envelope to %s", async (type, code) => {
		const f = fixture(() => reply({ type: "error", error: { type, message: canary } }, 402));
		let error: unknown;
		try {
			await invoke("ai_probe", {}, f.context);
		} catch (caught) {
			error = caught;
		}
		expect(pluginErrorResult(error).structuredContent).toEqual({ code });
		expect(JSON.stringify(pluginErrorResult(error))).not.toContain(canary);
		expect(f.requests).toHaveLength(1);
	});
	it("preserves broker and typed plugin errors even after SDK connection wrapping", async () => {
		for (const [error, result] of [
			[new HostError("DENIED"), { code: "PERMISSION_DENIED" }],
			[new PluginError("QUOTA_EXCEEDED"), { code: "QUOTA_EXCEEDED" }],
			[
				new PluginError("RATE_LIMITED", { retryAfterMs: 42 }),
				{ code: "RATE_LIMITED", retryAfterMs: 42 },
			],
		] as const) {
			const f = fixture(() => {
				throw error;
			});
			await expect(invoke("ai_probe", {}, f.context)).rejects.toMatchObject({ result });
			expect(f.requests).toHaveLength(1);
		}
	});
	it("cancels before transport and during an actual context fetch", async () => {
		const before = fixture();
		before.controller.abort();
		await expect(invoke("ai_probe", {}, before.context)).rejects.toMatchObject({
			result: { code: "TRANSIENT" },
		});
		expect(before.requests).toEqual([]);
		const started = Promise.withResolvers<AbortSignal>();
		const during = fixture((_request, _index, signal) => {
			started.resolve(signal);
			return new Promise(() => {});
		});
		const pending = invoke("ai_probe", {}, during.context);
		const hostSignal = await started.promise;
		during.controller.abort();
		await expect(pending).rejects.toMatchObject({ result: { code: "TRANSIENT" } });
		expect(hostSignal.aborted).toBe(true);
		expect(during.requests).toHaveLength(1);
	});
	it("refuses a response that arrives after cancellation even when an adapter ignores the signal", async () => {
		const f = fixture();
		const context: PluginContext = {
			...f.context,
			fetch: async () => {
				f.controller.abort();
				return Response.json(model());
			},
		};
		await expect(invoke("ai_probe", {}, context)).rejects.toMatchObject({
			result: { code: "TRANSIENT" },
		});
	});
	it("emits request-scoped heartbeat progress only while the draft call is active", async () => {
		vi.useFakeTimers();
		const waiting = Promise.withResolvers<HostFetchResult>();
		const f = fixture(() => waiting.promise);
		const progress = vi.fn(async (_value: number) => {});
		const pending = invoke(
			"ai_draft_generate",
			{ ...input, model: pin.model },
			f.context,
			progress,
		);
		await vi.advanceTimersByTimeAsync(5_000);
		expect(progress.mock.calls).toEqual([[0], [0]]);
		waiting.resolve(reply(message()));
		await expect(pending).resolves.toMatchObject({ kind: "draft" });
		await vi.advanceTimersByTimeAsync(10_000);
		expect(progress.mock.calls).toEqual([[0], [0]]);
	});
	it("does not report draft success after a progress failure", async () => {
		vi.useFakeTimers();
		const waiting = Promise.withResolvers<HostFetchResult>();
		const f = fixture(() => waiting.promise);
		const progress = vi.fn(async (_value: number) => {}).mockRejectedValueOnce(new Error(canary));
		await expect(
			invoke("ai_draft_generate", { ...input, model: pin.model }, f.context, progress),
		).rejects.toMatchObject({ result: { code: "TRANSIENT" } });
		expect(f.requests).toEqual([]);
		progress.mockResolvedValueOnce(undefined).mockRejectedValueOnce(new Error(canary));
		const pending = invoke(
			"ai_draft_generate",
			{ ...input, model: pin.model },
			f.context,
			progress,
		);
		const checked = expect(pending).rejects.toMatchObject({ result: { code: "TRANSIENT" } });
		await vi.advanceTimersByTimeAsync(5_000);
		waiting.resolve(reply(message()));
		await checked;
	});
	it.each(["initial", "periodic"] as const)(
		"cancels while %s progress is pending without leaving callbacks or timers active",
		async (phase) => {
			vi.useFakeTimers();
			const progressWait = Promise.withResolvers<void>();
			const progressStarted = Promise.withResolvers<void>();
			const responseWait = Promise.withResolvers<HostFetchResult>();
			const f = fixture(() => responseWait.promise);
			const added = vi.spyOn(f.controller.signal, "addEventListener");
			const removed = vi.spyOn(f.controller.signal, "removeEventListener");
			const progress = vi.fn(async (_value: number) => {
				if (phase === "periodic" && progress.mock.calls.length === 1) return;
				progressStarted.resolve();
				await progressWait.promise;
			});
			const settled = invoke(
				"ai_draft_generate",
				{ ...input, model: pin.model },
				f.context,
				progress,
			).then(
				() => ({ state: "returned" }),
				(error: unknown) => ({
					state: "refused",
					result: error instanceof PluginError ? error.result : undefined,
				}),
			);
			if (phase === "periodic") await vi.advanceTimersByTimeAsync(5_000);
			await progressStarted.promise;
			f.controller.abort();
			const backstop = Promise.withResolvers<{ state: string }>();
			const timer = setTimeout(() => backstop.resolve({ state: "still pending" }), 25);
			const observed = Promise.race([settled, backstop.promise]);
			try {
				await vi.advanceTimersByTimeAsync(25);
				expect(await observed).toEqual({ state: "refused", result: { code: "TRANSIENT" } });
				expect(f.requests).toHaveLength(phase === "initial" ? 0 : 1);
				expect(progress).toHaveBeenCalledTimes(phase === "initial" ? 1 : 2);
				if (phase === "initial") {
					const listeners = added.mock.calls.filter(([name]) => name === "abort");
					expect(listeners.length).toBeGreaterThan(0);
					for (const [, listener] of listeners)
						expect(
							removed.mock.calls.some(([name, value]) => name === "abort" && value === listener),
						).toBe(true);
				}
				progressWait.reject(new Error(canary));
				responseWait.resolve(reply(message()));
				await vi.advanceTimersByTimeAsync(15_000);
				expect(progress).toHaveBeenCalledTimes(phase === "initial" ? 1 : 2);
				expect(f.requests).toHaveLength(phase === "initial" ? 0 : 1);
				expect(vi.getTimerCount()).toBe(0);
			} finally {
				clearTimeout(timer);
				progressWait.resolve();
				responseWait.resolve(reply(message()));
				await settled;
				added.mockRestore();
				removed.mockRestore();
			}
		},
	);
});
