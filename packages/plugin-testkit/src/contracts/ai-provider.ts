import type { Fake } from "@draftyak/fakes";
import {
	aiProviderV1,
	checkDraftOutcome,
	DraftOutcome,
	type DraftRequest,
} from "@draftyak/protocol/ai-provider-v1";
import { checkPluginSurface, checkToolResult } from "@draftyak/protocol/extension";
import { canonicalize } from "@draftyak/protocol/jcs";
import { createPluginServer } from "@draftyak/sdk";
import { parseJSONRPCMessage, type Transport } from "@modelcontextprotocol/server";
import { serveStdio } from "@modelcontextprotocol/server/stdio";
import { createMockHub } from "../mock-hub.ts";
import type { MockHub, MockHubOptions, MockPlugin } from "../types.ts";

export interface AiProviderFixtures {
	readonly upstreams: readonly Fake[];
	readonly request: DraftRequest;
	/** The successful scripted response for this request, including its usage. */
	readonly expected: Extract<DraftOutcome, { kind: "draft" }>;
	readonly progress: readonly { readonly progress: number; readonly total?: number }[];
}

export interface AiProviderContractOptions {
	readonly plugin: MockPlugin;
	readonly mode?: MockHubOptions["mode"];
	/** A fresh set for each check; no state is shared between registered tests. */
	readonly fixtures: () => AiProviderFixtures | Promise<AiProviderFixtures>;
}

export type AiProviderFailureCode =
	| "AI_FIXTURES_INVALID"
	| "AI_HUB_UNAVAILABLE"
	| "AI_CHECK_FAILED"
	| "AI_CLEANUP_FAILED"
	| "AI_SURFACE_INVALID"
	| "AI_TOOLS_UNSTABLE"
	| "AI_DESCRIPTION_INVALID"
	| "AI_MODELS_INVALID"
	| "AI_MODEL_MISSING"
	| "AI_PROBE_INVALID"
	| "AI_PROBE_UNHEALTHY"
	| "AI_DRAFT_OUTPUT_INVALID"
	| "AI_DRAFT_NOT_GENERATED"
	| "AI_DRAFT_MISMATCH"
	| "AI_PROGRESS_MISSING"
	| "AI_PROGRESS_INVALID";

export type AiProviderCheckResult =
	| { readonly status: "pass" }
	| { readonly status: "fail"; readonly code: AiProviderFailureCode };

const pass: AiProviderCheckResult = Object.freeze({ status: "pass" });
const fail = (code: AiProviderFailureCode): AiProviderCheckResult => ({ status: "fail", code });

async function run(
	options: AiProviderContractOptions,
	check: (hub: MockHub, fixtures: AiProviderFixtures) => Promise<AiProviderCheckResult>,
): Promise<AiProviderCheckResult> {
	let hub: MockHub | undefined;
	let result = fail("AI_FIXTURES_INVALID");
	let failure: AiProviderFailureCode = "AI_FIXTURES_INVALID";
	try {
		const fixtures = await options.fixtures();
		const request = aiProviderV1.tools.ai_draft_generate.input.safeParse(fixtures.request);
		const expected = DraftOutcome.safeParse(fixtures.expected);
		if (!request.success || !expected.success || expected.data.kind !== "draft") return result;
		failure = "AI_HUB_UNAVAILABLE";
		hub = createMockHub({
			mode: options.mode ?? "process",
			plugin: options.plugin,
			upstreams: fixtures.upstreams,
		});
		failure = "AI_CHECK_FAILED";
		result = await check(hub, fixtures);
	} catch {
		result = fail(failure);
	} finally {
		try {
			await hub?.close();
		} catch {
			result = fail("AI_CLEANUP_FAILED");
		}
	}
	return result;
}

export async function checkAiProviderSurface(
	options: AiProviderContractOptions,
): Promise<AiProviderCheckResult> {
	return run(options, async (hub) => {
		const discover = await hub.discover();
		const first = await hub.listTools();
		const second = await hub.listTools();
		if (
			hub.manifest.kind !== "ai-provider" ||
			checkPluginSurface(discover, first, aiProviderV1).length > 0 ||
			checkPluginSurface(discover, second, aiProviderV1).length > 0
		)
			return fail("AI_SURFACE_INVALID");
		if (canonicalize(first) !== canonicalize(second)) return fail("AI_TOOLS_UNSTABLE");
		const description = checkToolResult(
			aiProviderV1,
			"ai_describe",
			await hub.call("ai_describe", {}),
		);
		return description.ok && !description.isError ? pass : fail("AI_DESCRIPTION_INVALID");
	});
}

export async function checkAiProviderModels(
	options: AiProviderContractOptions,
): Promise<AiProviderCheckResult> {
	return run(options, async (hub, fixtures) => {
		const checked = checkToolResult(
			aiProviderV1,
			"ai_models_list",
			await hub.call("ai_models_list", {}),
		);
		if (!checked.ok || checked.isError) return fail("AI_MODELS_INVALID");
		const parsed = aiProviderV1.tools.ai_models_list.output.safeParse(checked.value);
		if (!parsed.success) return fail("AI_MODELS_INVALID");
		const ids = parsed.data.models.map((model) => model.id);
		if (ids.length !== new Set(ids).size) return fail("AI_MODELS_INVALID");
		return ids.includes(fixtures.request.model) && ids.includes(fixtures.expected.model)
			? pass
			: fail("AI_MODEL_MISSING");
	});
}

export async function checkAiProviderProbe(
	options: AiProviderContractOptions,
): Promise<AiProviderCheckResult> {
	return run(options, async (hub, fixtures) => {
		const checked = checkToolResult(
			aiProviderV1,
			"ai_probe",
			await hub.call("ai_probe", { model: fixtures.request.model }),
		);
		if (!checked.ok || checked.isError) return fail("AI_PROBE_INVALID");
		const parsed = aiProviderV1.tools.ai_probe.output.safeParse(checked.value);
		if (!parsed.success) return fail("AI_PROBE_INVALID");
		return parsed.data.status === "ok" ? pass : fail("AI_PROBE_UNHEALTHY");
	});
}

export async function checkAiProviderOutput(
	options: AiProviderContractOptions,
): Promise<AiProviderCheckResult> {
	return run(options, async (hub, fixtures) => {
		const checked = checkDraftOutcome(
			await hub.call("ai_draft_generate", { ...fixtures.request }),
			fixtures.request.contextIds,
		);
		if (!checked.ok || checked.isError) return fail("AI_DRAFT_OUTPUT_INVALID");
		const outcome = DraftOutcome.safeParse(checked.value);
		if (!outcome.success) return fail("AI_DRAFT_OUTPUT_INVALID");
		// A schema-valid refusal or SDK-normalized invalid result is not this fixture's draft.
		if (outcome.data.kind !== "draft") return fail("AI_DRAFT_NOT_GENERATED");
		return canonicalize(outcome.data) === canonicalize(fixtures.expected)
			? pass
			: fail("AI_DRAFT_MISMATCH");
	});
}

export async function checkAiProviderProgress(
	options: AiProviderContractOptions,
): Promise<AiProviderCheckResult> {
	return run(options, async (hub, fixtures) => {
		if (
			!Array.isArray(fixtures.progress) ||
			fixtures.progress.length === 0 ||
			fixtures.progress.some(
				(event) =>
					!Number.isFinite(event.progress) ||
					(event.total !== undefined && !Number.isFinite(event.total)),
			)
		)
			return fail("AI_FIXTURES_INVALID");
		const token = "provider-contract-progress";
		const notifications: unknown[] = [];
		const notificationLimit = fixtures.progress.length + 1;
		let overflow = false;
		let previousAt: number | undefined;
		let invalidGap = false;
		const start = (): void => {
			previousAt = performance.now();
		};
		const gapValid = (now: number): boolean =>
			previousAt !== undefined &&
			Number.isFinite(now) &&
			now >= previousAt &&
			now - previousAt <= 10_000;
		const receive = (notification: unknown): void => {
			const now = performance.now();
			if (!gapValid(now)) invalidGap = true;
			previousAt = now;
			if (notifications.length < notificationLimit) notifications.push(notification);
			else overflow = true;
		};
		const inspect = (reply: { result?: unknown; error?: unknown }): AiProviderCheckResult => {
			const checked = checkDraftOutcome(reply.result, fixtures.request.contextIds);
			if (reply.error !== undefined || !checked.ok || checked.isError)
				return fail("AI_DRAFT_OUTPUT_INVALID");
			if (canonicalize(checked.value) !== canonicalize(fixtures.expected))
				return fail("AI_DRAFT_MISMATCH");
			if (notifications.length === 0) return fail("AI_PROGRESS_MISSING");
			if (overflow || invalidGap || !gapValid(performance.now()))
				return fail("AI_PROGRESS_INVALID");
			const expected = fixtures.progress.map((event) => ({
				jsonrpc: "2.0",
				method: "notifications/progress",
				params: { progressToken: token, ...event },
			}));
			return canonicalize(notifications) === canonicalize(expected)
				? pass
				: fail("AI_PROGRESS_INVALID");
		};
		if (options.mode !== "in-memory") {
			await hub.discover();
			start();
			const result = await hub.call(
				"ai_draft_generate",
				{ ...fixtures.request },
				{ progressToken: token },
				{ onProgress: receive },
			);
			return inspect({ result });
		}
		// In-memory JSON responses omit mid-call notifications. Keep the SDK's actual
		// in-memory notification transport, sharing this fixture's policy host.
		const ready = Promise.withResolvers<void>();
		const response = Promise.withResolvers<{ result?: unknown; error?: unknown }>();
		const transport: Transport = {
			async start() {
				ready.resolve();
			},
			async send(message) {
				if ("method" in message && message.method === "notifications/progress") receive(message);
				else if (!("method" in message) && message.id === 1) response.resolve(message);
			},
			async close() {
				transport.onclose?.();
			},
		};
		const handle = serveStdio(createPluginServer(options.plugin.entry, hub.host), {
			legacy: "reject",
			transport,
		});
		try {
			await ready.promise;
			start();
			transport.onmessage?.(
				parseJSONRPCMessage({
					jsonrpc: "2.0",
					id: 1,
					method: "tools/call",
					params: {
						name: "ai_draft_generate",
						arguments: { ...fixtures.request },
						_meta: {
							"io.modelcontextprotocol/protocolVersion": "2026-07-28",
							"io.modelcontextprotocol/clientCapabilities": {},
							progressToken: token,
						},
					},
				}),
			);
			const reply = await response.promise;
			return inspect(reply);
		} finally {
			await handle.close();
		}
	});
}

/** Await at test-file scope so registration completes before Vitest collects the suite. */
export async function aiProviderContract(options: AiProviderContractOptions): Promise<void> {
	const { describe, expect, it } = await import("vitest");
	describe("provider contract", () => {
		for (const check of [
			checkAiProviderSurface,
			checkAiProviderModels,
			checkAiProviderProbe,
			checkAiProviderOutput,
			checkAiProviderProgress,
		]) {
			it(check.name, async () => {
				expect(await check(options)).toEqual(pass);
			});
		}
	});
}
