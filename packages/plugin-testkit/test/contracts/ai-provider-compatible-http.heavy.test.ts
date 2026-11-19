import { checkDraftOutcome } from "@draftyak/protocol/ai-provider-v1";
import { afterAll, expect, it } from "vitest";
import {
	checkAiProviderModels,
	checkAiProviderOutput,
	checkAiProviderProbe,
	checkAiProviderProgress,
	checkAiProviderSurface,
} from "../../src/contracts/ai-provider.ts";
import { bindProcessPlugin, createMockHub, type ProcessPluginFiles } from "../../src/index.ts";
import type { MockHubOptions, MockPlugin } from "../../src/types.ts";
import {
	compatibleBody,
	compatibleConfig,
	createCompatibleContractFixture,
	origin,
	outcome,
	probeRequest,
	request,
} from "../fixtures/ai-provider-compatible-http/fixture.ts";
import type { CompatibleFixtureFormat } from "../fixtures/ai-provider-compatible-http/plugin.ts";
import { compatibleProcessFixture } from "../fixtures/ai-provider-compatible-http/process.ts";

const formats = ["json_schema", "json_object", "ollama"] as const;
const packed = new Map<
	CompatibleFixtureFormat,
	Awaited<ReturnType<typeof compatibleProcessFixture>>
>();
async function cleanup(): Promise<void> {
	const results = await Promise.allSettled([...packed.values()].map((value) => value.cleanup()));
	if (results.some((result) => result.status === "rejected"))
		throw new Error("DYTEST compatible process fixture cleanup incomplete");
}
try {
	for (const format of formats) packed.set(format, await compatibleProcessFixture(format));
} catch (error) {
	await cleanup();
	throw error;
}
afterAll(cleanup);

function bind(plugin: MockPlugin, files: ProcessPluginFiles) {
	let parentCalls = 0;
	const bound = bindProcessPlugin(
		{
			manifest: plugin.manifest,
			entry: {
				...plugin.entry,
				tools: plugin.entry.tools.map((tool) => ({
					...tool,
					handler() {
						parentCalls++;
						throw new Error("DYTEST parent compatible handler executed");
					},
				})),
			},
		},
		files,
	);
	expect(Object.isFrozen(bound)).toBe(true);
	return { plugin: bound, parentCalls: () => parentCalls };
}
function bound(
	format: CompatibleFixtureFormat,
	fixture: ReturnType<typeof createCompatibleContractFixture>,
) {
	const bundle = packed.get(format);
	if (!bundle) throw new Error("DYTEST compatible process bundle missing");
	return bind(fixture.plugin, bundle.files);
}

const checks = [
	checkAiProviderSurface,
	checkAiProviderModels,
	checkAiProviderProbe,
	checkAiProviderOutput,
	checkAiProviderProgress,
] as const;
it.each(formats.flatMap((format) => checks.map((check) => ({ format, name: check.name, check }))))(
	"passes $format $name through a real compatible HTTP process",
	async ({ format, check }) => {
		const fixture = createCompatibleContractFixture(format);
		const running = bound(format, fixture);
		expect(
			await check({ plugin: running.plugin, mode: "process", fixtures: fixture.fixtures }),
		).toEqual({ status: "pass" });
		expect(running.parentCalls()).toBe(0);
		expect(fixture.calls).toHaveLength(check === checkAiProviderSurface ? 0 : 1);
	},
);

it.each(formats)(
	"preserves exact %s models, probe and draft requests with context references",
	async (format) => {
		const fixture = createCompatibleContractFixture(format);
		const values = fixture.fixtures();
		const running = bound(format, fixture);
		const hub = createMockHub({
			mode: "process",
			plugin: running.plugin,
			upstreams: values.upstreams,
			compatibleHttp: values.compatibleHttp,
		});
		try {
			await hub.discover();
			expect((await hub.call("ai_models_list", {})).structuredContent).toEqual({
				models: [{ id: request.model, fallbacks: false }],
			});
			expect((await hub.call("ai_probe", { model: request.model })).structuredContent).toEqual({
				status: "ok",
			});
			const result = checkDraftOutcome(
				await hub.call("ai_draft_generate", { ...request }),
				request.contextIds,
			);
			expect(result.ok).toBe(true);
			if (!result.ok || result.isError) throw new Error("DYTEST compatible draft refused");
			expect(result.value).toEqual(outcome);
			expect(fixture.calls).toEqual([
				{
					method: "GET",
					url: `${origin}${format === "ollama" ? "/api/tags" : "/v1/models"}`,
					headers: [],
					body: "",
				},
				{
					method: "POST",
					url: compatibleConfig(format).endpoint,
					headers: [["content-type", "application/json"]],
					body: compatibleBody(format, probeRequest()),
				},
				{
					method: "POST",
					url: compatibleConfig(format).endpoint,
					headers: [["content-type", "application/json"]],
					body: compatibleBody(format, request),
				},
			]);
			expect(running.parentCalls()).toBe(0);
		} finally {
			await hub.close();
		}
	},
);

it.each(
	formats.flatMap((format) => ["missing", "different-prompt"].map((fault) => ({ format, fault }))),
)("refuses $format $fault trusted binding before fake dispatch", async ({ format, fault }) => {
	const fixture = createCompatibleContractFixture(format);
	const running = bound(format, fixture);
	const values = fixture.fixtures();
	const bindings: MockHubOptions["compatibleHttp"] =
		fault === "missing"
			? undefined
			: [
					{
						operation: "ai_draft_generate",
						config: compatibleConfig(format),
						draft: { ...request, prompt: "DYTEST-This is a different constructor-owned prompt." },
					},
				];
	const result = await checkAiProviderOutput({
		plugin: running.plugin,
		mode: "process",
		fixtures: () => ({
			...values,
			compatibleHttp: bindings,
		}),
	});
	expect(result.status).toBe("fail");
	if (result.status !== "fail") throw new Error("DYTEST unbound compatible request passed");
	expect(["AI_FIXTURES_INVALID", "AI_HUB_UNAVAILABLE", "AI_CLEANUP_FAILED"]).not.toContain(
		result.code,
	);
	expect(fixture.calls).toEqual([]);
	expect(running.parentCalls()).toBe(0);
});

it("returns canonical process errors without provider text", async () => {
	const fixture = createCompatibleContractFixture("json_schema", { status: 500 });
	const values = fixture.fixtures();
	const running = bound("json_schema", fixture);
	const hub = createMockHub({
		mode: "process",
		plugin: running.plugin,
		upstreams: values.upstreams,
		compatibleHttp: values.compatibleHttp,
	});
	try {
		const result = await hub.call("ai_draft_generate", { ...request });
		expect(result).toMatchObject({ isError: true, structuredContent: { code: "TRANSIENT" } });
		expect(JSON.stringify(result)).not.toContain("DYTEST_UNTRUSTED_PROVIDER_DETAIL");
		expect(fixture.calls).toHaveLength(1);
		expect(running.parentCalls()).toBe(0);
	} finally {
		await hub.close();
	}
});

it("aborts genuine pending fake work and fences the closed process hub", async () => {
	const entered = Promise.withResolvers<AbortSignal>();
	const release = Promise.withResolvers<void>();
	const fixture = createCompatibleContractFixture("json_schema", {
		async beforeReply(input) {
			entered.resolve(input.signal);
			await release.promise;
		},
	});
	const values = fixture.fixtures();
	const running = bound("json_schema", fixture);
	const hub = createMockHub({
		mode: "process",
		plugin: running.plugin,
		upstreams: values.upstreams,
		compatibleHttp: values.compatibleHttp,
	});
	let settled = false;
	const pending = hub.call("ai_draft_generate", { ...request }).then(
		() => {
			settled = true;
		},
		() => {
			settled = true;
		},
	);
	try {
		const signal = await Promise.race([
			entered.promise,
			pending.then(() => {
				throw new Error("DYTEST draft settled before genuine fake entry");
			}),
		]);
		expect(settled).toBe(false);
		expect(signal.aborted).toBe(false);
		const closing = hub.close();
		await expect.poll(() => signal.aborted, { timeout: 2000 }).toBe(true);
		release.resolve();
		await closing;
		await pending;
		expect(settled).toBe(true);
		await expect(hub.call("ai_draft_generate", { ...request })).rejects.toMatchObject({
			code: "HOST_CLOSED",
		});
		expect(fixture.calls).toHaveLength(1);
		expect(running.parentCalls()).toBe(0);
	} finally {
		release.resolve();
		await hub.close();
		await pending;
	}
});
