import { spawnSync } from "node:child_process";
import { setImmediate } from "node:timers/promises";
import type { AiRequestBindingWithoutNetwork } from "@draftyak/hub";
import type { HostFetchParams } from "@draftyak/protocol/host-channel";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createPlugin } from "../src/plugin.ts";
import {
	CANARY,
	draft,
	input,
	message,
	mountedProvider,
	nativeProviderFixture,
	streamBytes,
} from "./helpers.ts";

const encoded = (value: unknown): string =>
	Buffer.from(JSON.stringify(value)).toString("base64url");
const terminal = (value: unknown): Uint8Array =>
	new TextEncoder().encode(
		`data: ${JSON.stringify({ type: "response.completed", response: value })}\n\n`,
	);
const metadata = { status: 200, headers: [["content-type", "application/json"]] };
const calls: HostFetchParams[] = [];

beforeEach(() => {
	calls.length = 0;
	vi.stubGlobal(
		"fetch",
		vi.fn(() => {
			throw new Error("Global fetch forbidden");
		}),
	);
});

describe("native provider composition", () => {
	const binding: AiRequestBindingWithoutNetwork = {
		draft: {
			model: "gpt-synthetic",
			system: "Draft a plain-text reply.",
			prompt: "Synthetic thread; propose Tuesday.",
			contextIds: ["c1"],
		},
		settings: { kind: "responses" as const, effort: "low" as const },
		endpoint: "https://api.openai.com/v1/responses",
	};
	it("mounts the actual SDK POST through the public verifier, credential vault and pinned TLS broker", async () => {
		const native = await nativeProviderFixture({
			binding,
			holdAck: "terminal",
			reply(response) {
				response.setHeader("content-type", "text/event-stream");
				response.end(terminal(message()));
			},
		});
		try {
			const generation = native.generation();
			await mountedProvider(
				native.handler,
				async (ask, host) => {
					native.useHost(host);
					const result = await native.run(() =>
						ask("tools/call", { name: "ai_draft_generate", arguments: input }),
					);
					expect(result.result?.isError).not.toBe(true);
					expect(result.result?.structuredContent).toMatchObject({ kind: "draft", output: draft });
				},
				{ instance: { id: "native-fixture-instance", config: { effort: "low" } } },
			);
			expect(native.candidates).toHaveLength(1);
			const candidate = native.candidates[0];
			if (!candidate) throw new Error("Expected recorded SDK request");
			const verified = native.snapshot(candidate);
			expect(verified).toMatchObject({
				profile: "responses-api-v1",
				method: "POST",
				url: binding.endpoint,
			});
			const posted = JSON.parse(native.seen.bodies[0] ?? "");
			expect(posted).toMatchObject({
				model: binding.draft.model,
				instructions: binding.draft.system,
				input: [{ role: "user", content: binding.draft.prompt }],
				reasoning: { effort: "low" },
				stream: true,
				store: false,
			});
			expect(posted.text.format).toMatchObject({
				type: "json_schema",
				name: "draft_output",
				strict: true,
			});
			expect(native.seen.methods).toEqual(["POST"]);
			expect(native.seen.paths).toEqual(["/v1/responses"]);
			expect(native.seen.sni).toEqual(["api.openai.com"]);
			expect(native.seen.credentialMatched).toEqual([true]);
			expect(native.notifications.at(-1)).toMatchObject({ done: true });
			expect(native.pendingAcks).toHaveLength(1);
			const stream = native.streams[0];
			if (!stream) throw new Error("Expected native stream");
			let completed = false;
			void stream.completion.then(
				() => {
					completed = true;
				},
				() => {},
			);
			await setImmediate();
			expect(completed).toBe(false);
			// This controlled ACK follows the real consumer outcome, not buffered preparation.
			native.acknowledge();
			await stream.completion;
			expect(native.generation()).toBe(generation);
		} finally {
			await native.close();
		}
	});

	it.each([
		["ai_models_list", {}, "configured-only", "/v1/models"],
		["ai_probe", {}, "configured-only", "/v1/models"],
		[
			"ai_probe",
			{ model: "org/model?x#z" },
			"different-configured",
			"/v1/models/org%2Fmodel%3Fx%23z",
		],
	] as const)(
		"uses actual native metadata selection for %s with input %j",
		async (operation, args, configured, expectedPath) => {
			const model = "model" in args ? args.model : undefined;
			const native = await nativeProviderFixture({
				binding: {
					operation,
					configuration: {
						profile: "responses-api-v1",
						endpoint: "https://api.openai.com/v1",
						model: configured,
					},
					input: args,
				},
				reply(response) {
					response.setHeader("content-type", "application/json");
					response.end(
						JSON.stringify(
							model === undefined
								? { object: "list", data: [{ object: "model", id: "listed-model" }] }
								: { object: "model", id: model },
						),
					);
				},
			});
			try {
				await mountedProvider(native.handler, async (ask, host) => {
					native.useHost(host);
					const result = await native.run(() =>
						ask("tools/call", { name: operation, arguments: args }),
					);
					expect(result.result?.isError).not.toBe(true);
					expect(result.result?.structuredContent).toEqual(
						operation === "ai_models_list"
							? { models: [{ id: "listed-model" }] }
							: { status: "ok" },
					);
				});
				expect(native.seen.methods).toEqual(["GET"]);
				expect(native.seen.paths).toEqual([expectedPath]);
				expect(native.seen.bodies).toEqual([""]);
				expect(native.seen.credentialMatched).toEqual([true]);
				const candidate = native.candidates[0];
				if (!candidate) throw new Error("Expected recorded metadata request");
				expect(native.snapshot(candidate).body.byteLength).toBe(0);
				await Promise.all(native.streams.map((stream) => stream.completion));
			} finally {
				await native.close();
			}
		},
	);

	it.each(["model", "instructions", "prompt", "effort", "schema", "extra-header", "extra-body"])(
		"the actual broker refuses changed SDK %s independently of the trusted invocation",
		async (changed) => {
			const native = await nativeProviderFixture({
				binding,
				reply(response) {
					response.end("must not reach peer");
				},
				mutate(candidate) {
					if (changed === "extra-header")
						return {
							...candidate,
							headers: [...candidate.headers, ["x-not-allowed", "DYTEST-extra"]],
						};
					const value = JSON.parse(Buffer.from(candidate.body).toString());
					if (changed === "model") value.model = "different-model";
					if (changed === "instructions") value.instructions = "DYTEST-changed-system";
					if (changed === "prompt") value.input[0].content = "DYTEST-changed-prompt";
					if (changed === "effort") value.reasoning.effort = "high";
					if (changed === "schema") value.text.format.schema.additionalProperties = true;
					if (changed === "extra-body") value.metadata = { label: "DYTEST-extra" };
					return { ...candidate, body: Buffer.from(JSON.stringify(value)) };
				},
			});
			try {
				await mountedProvider(
					native.handler,
					async (ask, host) => {
						native.useHost(host);
						const result = await native.run(() =>
							ask("tools/call", { name: "ai_draft_generate", arguments: input }),
						);
						expect(result.result).toMatchObject({
							isError: true,
							structuredContent: { code: "TRANSIENT" },
						});
					},
					{ instance: { id: "native-fixture-instance", config: { effort: "low" } } },
				);
				expect(native.seen.methods).toEqual([]);
				expect(native.candidates).toHaveLength(1);
				expect(() =>
					native.snapshot(native.candidates[0] as import("@draftyak/hub").AiCandidateRequest),
				).toThrow();
			} finally {
				await native.close();
			}
		},
	);
	it.each(["different-model-path", "body", "extra-header"])(
		"the broker refuses changed SDK metadata %s against native invocation inputs",
		async (changed) => {
			const model = "pinned-model";
			const native = await nativeProviderFixture({
				binding: {
					operation: "ai_probe",
					configuration: {
						profile: "responses-api-v1",
						endpoint: "https://api.openai.com/v1",
						model: "different-configured",
					},
					input: { model },
				},
				reply(response) {
					response.end("must not reach peer");
				},
				mutate(candidate) {
					if (changed === "different-model-path")
						return { ...candidate, url: "https://api.openai.com/v1/models/different-model" };
					if (changed === "body") return { ...candidate, body: Buffer.from("{}") };
					return {
						...candidate,
						headers: [...candidate.headers, ["x-not-allowed", "DYTEST-extra"]],
					};
				},
			});
			try {
				await mountedProvider(native.handler, async (ask, host) => {
					native.useHost(host);
					const result = await native.run(() =>
						ask("tools/call", { name: "ai_probe", arguments: { model } }),
					);
					expect(result.result).toMatchObject({
						isError: true,
						structuredContent: { code: "TRANSIENT" },
					});
				});
				expect(native.seen.methods).toEqual([]);
				expect(native.candidates).toHaveLength(1);
				expect(() =>
					native.snapshot(native.candidates[0] as import("@draftyak/hub").AiCandidateRequest),
				).toThrow();
			} finally {
				await native.close();
			}
		},
	);
});
afterEach(() => {
	expect(globalThis.fetch).not.toHaveBeenCalled();
	vi.restoreAllMocks();
	vi.unstubAllGlobals();
	vi.useRealTimers();
});

describe("accepted SDK provider mount", () => {
	it.each([undefined, "low"])(
		"uses only trusted instance effort and ignores MCP metadata settings: %s",
		async (effort) => {
			await mountedProvider(
				(_method, params) => {
					calls.push(params as HostFetchParams);
					return {
						status: 200,
						headers: [["content-type", "text/event-stream"]],
						body: { base64: Buffer.from(terminal(message())).toString("base64url") },
					};
				},
				async (ask) => {
					const reply = await ask("tools/call", {
						name: "ai_draft_generate",
						arguments: input,
						_meta: { effort: "max", instance: { config: { effort: "high" } } },
					});
					expect(reply.result?.structuredContent).toMatchObject({ kind: "draft" });
				},
				effort === undefined ? {} : { instance: { id: "trusted-instance", config: { effort } } },
			);
			expect(calls).toHaveLength(1);
			const sent = calls[0];
			if (!sent?.body || !("base64" in sent.body)) throw new Error("Expected inline request body");
			const body = JSON.parse(Buffer.from(sent.body.base64, "base64url").toString());
			if (effort === undefined) expect(body).not.toHaveProperty("reasoning");
			else expect(body.reasoning).toEqual({ effort: "low" });
			expect(body.model).toBe(input.model);
		},
	);

	it.each([null, "invalid", 1, {}])(
		"refuses invalid trusted instance effort before fetching: %j",
		async (effort) => {
			await mountedProvider(
				() => {
					throw new Error("Unexpected host request");
				},
				async (ask) => {
					expect(
						(await ask("tools/call", { name: "ai_draft_generate", arguments: input })).result,
					).toMatchObject({ isError: true, structuredContent: { code: "INVALID_INPUT" } });
				},
				{ instance: { id: "trusted-instance", config: { effort } } },
			);
		},
	);

	it("keeps cold root/client imports pure and initializes only the production entry under disabled code generation", () => {
		const root = new URL("../src/index.ts", import.meta.url).href;
		const client = new URL("../src/client.ts", import.meta.url).href;
		const plugin = new URL("../src/plugin.ts", import.meta.url).href;
		const code = `
			import assert from 'node:assert/strict';
			import * as z from 'zod';
			z.config({jitless:false});
			globalThis.fetch=()=>{throw new Error('Network forbidden')};
			await import(${JSON.stringify(root)});
			await import(${JSON.stringify(client)});
			assert.equal(z.config().jitless,false);
			const {createPlugin}=await import(${JSON.stringify(plugin)});
			assert.equal(z.config().jitless,true);
			assert.equal(createPlugin().tools.length,4);
		`;
		const result = spawnSync(
			process.execPath,
			["--disallow-code-generation-from-strings", "--input-type=module", "-e", code],
			{
				cwd: import.meta.dirname,
				env: {},
				encoding: "utf8",
				shell: false,
				windowsHide: true,
				timeout: 15_000,
				maxBuffer: 128 * 1024,
			},
		);
		expect(result.error).toBeUndefined();
		expect(result.signal).toBeNull();
		expect(result.stderr).toBe("");
		expect(result.status, result.stdout).toBe(0);
	});

	it("serves exactly the four accepted tools and describes itself without host I/O", async () => {
		expect(createPlugin().plugin).toBe("@draftyak/ai-responses-api");
		await mountedProvider(
			() => {
				throw new Error("Unexpected host request");
			},
			async (ask) => {
				const list = await ask("tools/list");
				expect(list.result?.tools?.map(({ name }) => name).sort()).toEqual([
					"ai_describe",
					"ai_draft_generate",
					"ai_models_list",
					"ai_probe",
				]);
				expect(
					(await ask("tools/call", { name: "ai_describe", arguments: {} })).result,
				).toMatchObject({
					structuredContent: { name: "Responses API-key", structuredOutput: "native" },
				});
			},
		);
	});

	it("uses the pinned metadata SDK through the actual host context and maps only reported IDs", async () => {
		await mountedProvider(
			(method, params) => {
				expect(method).toBe("host/fetch");
				calls.push(params as HostFetchParams);
				return {
					...metadata,
					body: {
						base64: encoded({
							object: "list",
							data: [
								{
									object: "model",
									id: "provider-model",
									owned_by: CANARY,
									created: 123,
									name: "Unspecified capability",
									contextTokens: 99,
									fallbacks: true,
								},
							],
						}),
					},
				};
			},
			async (ask) => {
				expect(
					(await ask("tools/call", { name: "ai_models_list", arguments: {} })).result
						?.structuredContent,
				).toEqual({ models: [{ id: "provider-model" }] });
			},
		);
		expect(calls).toHaveLength(1);
		expect(calls[0]).toEqual({
			method: "GET",
			url: "https://api.openai.com/v1/models",
			headers: [
				["accept", "application/json"],
				["authorization", "Bearer brokered"],
			],
			stream: true,
		});
	});

	it.each([undefined, "org/model?query#fragment%"])(
		"probes actual credential/model metadata without generating a prompt: %s",
		async (model) => {
			await mountedProvider(
				(method, params) => {
					expect(method).toBe("host/fetch");
					calls.push(params as HostFetchParams);
					return {
						...metadata,
						body: {
							base64: encoded(
								model === undefined ? { object: "list", data: [] } : { object: "model", id: model },
							),
						},
					};
				},
				async (ask) => {
					const result = await ask("tools/call", {
						name: "ai_probe",
						arguments: model === undefined ? {} : { model },
					});
					expect(result.result?.structuredContent).toEqual({ status: "ok" });
				},
			);
			expect(calls).toHaveLength(1);
			expect(calls[0]?.method).toBe("GET");
			expect(calls[0]?.body).toBeUndefined();
			expect(calls[0]?.url).toBe(
				model === undefined
					? "https://api.openai.com/v1/models"
					: "https://api.openai.com/v1/models/org%2Fmodel%3Fquery%23fragment%25",
			);
		},
	);

	it.each([
		["ai_models_list", { extra: true }],
		["ai_probe", { model: "bad model" }],
		["ai_draft_generate", { ...input, tools: [CANARY] }],
	])("rejects invalid mounted %s input before fetching", async (name, args) => {
		await mountedProvider(
			() => {
				throw new Error("Unexpected host request");
			},
			async (ask) => {
				const reply = await ask("tools/call", { name, arguments: args });
				expect(reply.result?.isError).toBe(true);
				expect(JSON.stringify(reply)).not.toContain(CANARY);
			},
		);
	});

	it.each([
		["draft", message()],
		[
			"invalid",
			message({
				output: [
					{
						type: "message",
						role: "assistant",
						status: "completed",
						content: [{ type: "output_text", text: "{}" }],
					},
				],
			}),
		],
		[
			"refusal",
			message({
				output: [
					{
						type: "message",
						role: "assistant",
						status: "completed",
						content: [{ type: "refusal", refusal: "Declined" }],
					},
				],
			}),
		],
		["unexpected", message({ output: [{ type: "function_call", name: "forbidden" }] })],
	])(
		"streams real host chunks through the mounted handler into an unchanged %s outcome",
		async (kind, response) => {
			const fetched = Promise.withResolvers<void>();
			await mountedProvider(
				(method, params) => {
					expect(method).toBe("host/fetch");
					calls.push(params as HostFetchParams);
					fetched.resolve();
					return {
						status: 200,
						headers: [["content-type", "text/event-stream"]],
						streamId: "draft-stream",
					};
				},
				async (ask, host, notifications) => {
					const reply = ask("tools/call", { name: "ai_draft_generate", arguments: input });
					await fetched.promise;
					await setImmediate();
					streamBytes(host, "draft-stream", terminal(response));
					const result = (await reply).result;
					expect(result?.isError).not.toBe(true);
					expect(result?.structuredContent).toMatchObject({
						kind,
						model: input.model,
						fallback: false,
						usage: { input: 100, output: 50 },
					});
					if (kind === "draft") expect(result?.structuredContent).toMatchObject({ output: draft });
					expect(notifications).toEqual([]);
				},
			);
			expect(calls).toHaveLength(1);
			expect(calls[0]?.stream).toBe(true);
			const sent = calls[0];
			if (!sent?.body || !("base64" in sent.body)) throw new Error("Expected inline request body");
			const body = JSON.parse(Buffer.from(sent.body.base64, "base64url").toString());
			expect(body).toMatchObject({
				model: input.model,
				instructions: input.system,
				input: [{ role: "user", content: input.prompt }],
				stream: true,
				store: false,
			});
		},
	);

	it.each([0, "request-progress"])(
		"reports request-bound progress every ten seconds and cleans each concurrent call independently: %s",
		async (token) => {
			vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval"] });
			const bothFetched = Promise.withResolvers<void>();
			await mountedProvider(
				(_method, params) => {
					calls.push(params as HostFetchParams);
					if (calls.length === 2) bothFetched.resolve();
					return {
						status: 200,
						headers: [["content-type", "text/event-stream"]],
						streamId: `stream-${calls.length}`,
					};
				},
				async (ask, host, notifications) => {
					const idleTimers = vi.getTimerCount();
					const first = ask("tools/call", {
						name: "ai_draft_generate",
						arguments: input,
						_meta: { progressToken: token },
					});
					const second = ask("tools/call", {
						name: "ai_draft_generate",
						arguments: input,
						_meta: { progressToken: "other-call" },
					});
					await bothFetched.promise;
					await vi.advanceTimersByTimeAsync(10_000);
					const progress = (): unknown[] =>
						notifications.map((value) => (value as { params: unknown }).params);
					expect(progress()).toEqual([
						{ progressToken: token, progress: 0 },
						{ progressToken: "other-call", progress: 0 },
						{ progressToken: token, progress: 1 },
						{ progressToken: "other-call", progress: 1 },
					]);
					streamBytes(host, "stream-1", terminal(message()));
					expect((await first).result?.structuredContent).toMatchObject({ kind: "draft" });
					await vi.advanceTimersByTimeAsync(10_000);
					expect(progress().at(-1)).toEqual({ progressToken: "other-call", progress: 2 });
					expect(progress()).toHaveLength(5);
					streamBytes(host, "stream-2", terminal(message()));
					expect((await second).result?.structuredContent).toMatchObject({ kind: "draft" });
					expect(vi.getTimerCount()).toBe(idleTimers);
					await vi.advanceTimersByTimeAsync(30_000);
					expect(progress()).toHaveLength(5);
				},
			);
		},
	);

	it.each(["provider-error", "caller-cancel"])(
		"retires its progress timer after a positive tick and %s",
		async (cause) => {
			vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval"] });
			const entered = Promise.withResolvers<void>();
			const aborted = Promise.withResolvers<void>();
			const release = Promise.withResolvers<unknown>();
			await mountedProvider(
				async (_method, _params, signal) => {
					signal.addEventListener("abort", () => aborted.resolve(), { once: true });
					entered.resolve();
					return release.promise;
				},
				async (ask, _host, notifications, cancel) => {
					const idleTimers = vi.getTimerCount();
					const request = ask("tools/call", {
						name: "ai_draft_generate",
						arguments: input,
						_meta: { progressToken: "active" },
					});
					void request.catch(() => undefined);
					await entered.promise;
					await vi.advanceTimersByTimeAsync(10_000);
					expect(notifications).toHaveLength(2);
					if (cause === "caller-cancel") {
						cancel(1);
						await aborted.promise;
						await vi.advanceTimersByTimeAsync(0);
					} else {
						release.resolve({
							status: 429,
							headers: [["retry-after", "0"]],
							body: { base64: encoded({ error: { message: CANARY } }) },
						});
						expect((await request).result).toMatchObject({
							isError: true,
							structuredContent: { code: "RATE_LIMITED", retryAfterMs: 0 },
						});
					}
					expect(vi.getTimerCount()).toBe(idleTimers);
					await vi.advanceTimersByTimeAsync(30_000);
					expect(notifications).toHaveLength(2);
				},
			);
		},
	);
});
