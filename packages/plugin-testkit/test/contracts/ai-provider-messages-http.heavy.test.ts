import { checkDraftOutcome } from "@draftyak/protocol/ai-provider-v1";
import { afterAll, expect, it } from "vitest";
import {
	checkAiProviderModels,
	checkAiProviderOutput,
	checkAiProviderProbe,
	checkAiProviderProgress,
	checkAiProviderSurface,
} from "../../src/contracts/ai-provider.ts";
import { bindProcessPlugin, createMockHub } from "../../src/index.ts";
import {
	createMessagesContractFixture,
	messagesBody,
	origin,
	outcome,
	request,
} from "../fixtures/ai-provider-messages-http/fixture.ts";
import { messagesProcessFixture } from "../fixtures/ai-provider-messages-http/process.ts";

const packed = await messagesProcessFixture();
afterAll(() => packed.cleanup());

function bound(fixture: ReturnType<typeof createMessagesContractFixture>) {
	let parentCalls = 0;
	const plugin = bindProcessPlugin(
		{
			manifest: fixture.plugin.manifest,
			entry: {
				...fixture.plugin.entry,
				tools: fixture.plugin.entry.tools.map((tool) => ({
					...tool,
					handler() {
						parentCalls++;
						throw new Error("DYTEST parent Messages handler executed");
					},
				})),
			},
		},
		packed.files,
	);
	expect(Object.isFrozen(plugin)).toBe(true);
	return { plugin, parentCalls: () => parentCalls };
}

const checks = [
	checkAiProviderSurface,
	checkAiProviderModels,
	checkAiProviderProbe,
	checkAiProviderOutput,
	checkAiProviderProgress,
] as const;
it.each(checks.map((check) => ({ name: check.name, check })))(
	"passes real Messages process contract $name with fresh fixture DATA",
	async ({ check }) => {
		const fixture = createMessagesContractFixture();
		const running = bound(fixture);
		expect(
			await check({ plugin: running.plugin, mode: "process", fixtures: fixture.fixtures }),
		).toEqual({ status: "pass" });
		expect(running.parentCalls()).toBe(0);
		expect(fixture.calls).toHaveLength(check === checkAiProviderSurface ? 0 : 1);
	},
);

it("preserves exact metadata pages, probe and stable completed draft through the child", async () => {
	const fixture = createMessagesContractFixture({ pages: true });
	const values = fixture.fixtures();
	const running = bound(fixture);
	const hub = createMockHub({
		mode: "process",
		plugin: running.plugin,
		upstreams: values.upstreams,
		messagesHttp: values.messagesHttp,
	});
	try {
		await hub.discover();
		expect((await hub.call("ai_models_list", {})).structuredContent).toEqual({
			models: [
				{ id: request.model, name: "DYTEST Messages model", contextTokens: 12345 },
				{ id: "claude-page-2", name: "DYTEST Messages model", contextTokens: 12345 },
			],
		});
		expect((await hub.call("ai_probe", { model: request.model })).structuredContent).toEqual({
			status: "ok",
		});
		const result = checkDraftOutcome(
			await hub.call("ai_draft_generate", { ...request }),
			request.contextIds,
		);
		expect(result.ok).toBe(true);
		if (!result.ok || result.isError) throw new Error("DYTEST Messages outcome refused");
		expect(result.value).toEqual(outcome);
		expect(fixture.calls.map(({ method, url }) => ({ method, url }))).toEqual([
			{ method: "GET", url: `${origin}/v1/models?limit=100` },
			{ method: "GET", url: `${origin}/v1/models?limit=100&after_id=${request.model}` },
			{ method: "GET", url: `${origin}/v1/models/${request.model}` },
			{ method: "POST", url: `${origin}/v1/messages` },
		]);
		for (const call of fixture.calls) {
			expect(call.headers["x-api-key"]).toBe("brokered");
			expect(call.headers["user-agent"]).toBe("Anthropic/JS 0.135.0");
			expect(call.headers.authorization).toBeUndefined();
		}
		expect(JSON.parse(fixture.calls[3]!.body)).toEqual(messagesBody());
		expect(running.parentCalls()).toBe(0);
	} finally {
		await hub.close();
	}
});

it("refuses absent and wrong draft bindings before the fake and then permits the matching process", async () => {
	const fixture = createMessagesContractFixture();
	const values = fixture.fixtures();
	for (const messagesHttp of [
		undefined,
		[
			{
				operation: "ai_probe" as const,
				origin: "https://api.anthropic.com" as const,
				model: request.model,
			},
		],
	]) {
		const running = bound(fixture);
		const hub = createMockHub({
			mode: "process",
			plugin: running.plugin,
			upstreams: values.upstreams,
			...(messagesHttp === undefined ? {} : { messagesHttp }),
		});
		try {
			await hub.discover();
			const result = await hub.call("ai_draft_generate", { ...request });
			expect(result.isError).toBe(true);
			expect(fixture.calls).toHaveLength(0);
			expect(running.parentCalls()).toBe(0);
		} finally {
			await hub.close();
		}
	}
	const running = bound(fixture);
	expect(
		await checkAiProviderOutput({
			plugin: running.plugin,
			mode: "process",
			fixtures: fixture.fixtures,
		}),
	).toEqual({ status: "pass" });
	expect(fixture.calls).toHaveLength(1);
	expect(running.parentCalls()).toBe(0);
});

it("requires the returned bindProcessPlugin identity instead of merely copying its fields", async () => {
	const fixture = createMessagesContractFixture();
	const running = bound(fixture);
	const result = await checkAiProviderSurface({
		plugin: { ...running.plugin },
		mode: "process",
		fixtures: fixture.fixtures,
	});
	expect(result.status).toBe("fail");
	expect(result).not.toEqual({ status: "fail", code: "AI_FIXTURES_INVALID" });
	expect(fixture.calls).toHaveLength(0);
	expect(running.parentCalls()).toBe(0);
	expect(
		await checkAiProviderSurface({
			plugin: running.plugin,
			mode: "process",
			fixtures: fixture.fixtures,
		}),
	).toEqual({ status: "pass" });
});

it("redacts a failed Messages response through the actual child contract", async () => {
	const fixture = createMessagesContractFixture({
		async draftResponse() {
			return Response.json({ error: "DYTEST-private-response-marker" }, { status: 429 });
		},
	});
	const values = fixture.fixtures();
	const running = bound(fixture);
	const hub = createMockHub({
		mode: "process",
		plugin: running.plugin,
		upstreams: values.upstreams,
		messagesHttp: values.messagesHttp,
	});
	try {
		await hub.discover();
		const result = await hub.call("ai_draft_generate", { ...request });
		expect(result.isError).toBe(true);
		expect(result.structuredContent).toMatchObject({ code: "TRANSIENT" });
		expect(JSON.stringify(result)).not.toContain("DYTEST-private-response-marker");
		expect(fixture.calls).toHaveLength(1);
		expect(running.parentCalls()).toBe(0);
	} finally {
		await hub.close();
	}
});

it("aborts a held real child request on close and refuses later calls", async () => {
	let started: () => void = () => undefined;
	const entered = new Promise<void>((resolve) => {
		started = resolve;
	});
	let release: () => void = () => undefined;
	const gate = new Promise<void>((resolve) => {
		release = resolve;
	});
	let signal: AbortSignal | undefined;
	const fixture = createMessagesContractFixture({
		async draftResponse(request) {
			signal = request.signal;
			started();
			await gate;
			return Response.json({});
		},
	});
	const running = bound(fixture);
	const values = fixture.fixtures();
	const hub = createMockHub({
		mode: "process",
		plugin: running.plugin,
		upstreams: values.upstreams,
		messagesHttp: values.messagesHttp,
	});
	let pending: Promise<unknown> | undefined;
	try {
		await hub.discover();
		pending = hub.call("ai_draft_generate", { ...request }).then(
			(value) => ({ value }),
			(error: unknown) => ({ error }),
		);
		await entered;
		if (!signal) throw new Error("DYTEST held Messages signal missing");
		const aborted = signal.aborted
			? Promise.resolve()
			: new Promise<void>((resolve) => {
					signal!.addEventListener("abort", () => resolve(), { once: true });
				});
		const closing = hub.close();
		await aborted;
		expect(signal?.aborted).toBe(true);
		release();
		await closing;
		await pending;
		await expect(hub.call("ai_describe", {})).rejects.toMatchObject({ code: "HOST_CLOSED" });
		expect(running.parentCalls()).toBe(0);
	} finally {
		release();
		await pending;
		await hub.close();
	}
});
