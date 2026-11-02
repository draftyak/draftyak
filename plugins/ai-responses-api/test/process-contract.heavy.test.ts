import { existsSync } from "node:fs";
import {
	type AiProviderFixtures,
	aiProviderContract,
	bindProcessPlugin,
	checkAiProviderModels,
	checkAiProviderOutput,
	checkAiProviderProbe,
} from "@draftyak/plugin-testkit";
import type { ResponsesHttpBindingInput } from "@draftyak/protocol/manifest/responses-http";
import { afterAll, afterEach, expect, it } from "vitest";
import manifest from "../draftyak.plugin.json" with { type: "json" };
import { createPlugin } from "../src/plugin.ts";
import { processContractBundle } from "./fixtures/process-contract/bundle.ts";
import {
	expectedPost,
	origin,
	processContractFixture,
	request,
	resources,
} from "./fixtures/process-contract/fixture.ts";

const packed = await processContractBundle();
afterAll(async () => {
	await packed.cleanup();
	await packed.cleanup();
	expect(existsSync(packed.files.directory)).toBe(false);
});
let parentCalls = 0;
const parent = createPlugin();
const plugin = bindProcessPlugin(
	{
		manifest,
		entry: {
			...parent,
			tools: parent.tools.map((tool) => ({
				...tool,
				handler() {
					parentCalls++;
					throw new Error("Parent provider handler executed");
				},
			})),
		},
	},
	packed.files,
);
if (!Object.isFrozen(plugin)) throw new Error("Process binding must remain frozen");

const created: ReturnType<typeof processContractFixture>[] = [];
function fresh() {
	const fixture = processContractFixture();
	created.push(fixture);
	return fixture;
}
const targets = new Map([
	["checkAiProviderSurface", null],
	["checkAiProviderModels", "/v1/models"],
	["checkAiProviderProbe", `/v1/models/${request.model}`],
	["checkAiProviderOutput", "/v1/responses"],
	["checkAiProviderProgress", "/v1/responses"],
]);
afterEach(async ({ task }) => {
	for (const fixture of created.splice(0)) {
		if (targets.has(task.name)) {
			const target = targets.get(task.name);
			expect(fixture.calls.map(({ url }) => url)).toEqual(target ? [origin + target] : []);
			for (const call of fixture.calls) {
				expect(call.processes).toBeGreaterThan(fixture.before.ProcessWrap ?? 0);
				expect(call.method).toBe(target === "/v1/responses" ? "POST" : "GET");
				expect(call.body && JSON.parse(call.body)).toEqual(
					target === "/v1/responses" ? expectedPost() : "",
				);
			}
		}
		await new Promise<void>((resolve) => setImmediate(resolve));
		expect(resources()).toEqual(fixture.before);
	}
	expect(parentCalls).toBe(0);
});

// Keep the constructor-issued process binding unchanged; the contract creates a fresh hub per case.
await aiProviderContract({ plugin, mode: "process", fixtures: () => fresh().fixtures });

it.each([
	["models", checkAiProviderModels],
	["probe", checkAiProviderProbe],
	["draft", checkAiProviderOutput],
] as const)(
	"refuses %s without trusted HTTP bindings before fake dispatch",
	async (_operation, check) => {
		const fixture = fresh();
		const { responsesHttp: _bindings, ...unbound } = fixture.fixtures;
		const result = await check({ plugin, mode: "process", fixtures: () => unbound });
		expect(result).toMatchObject({ status: "fail" });
		expect(result).not.toMatchObject({ code: "AI_FIXTURES_INVALID" });
		expect(result).not.toMatchObject({ code: "AI_HUB_UNAVAILABLE" });
		expect(fixture.calls).toEqual([]);
	},
);

it.each([
	["models", checkAiProviderModels, [{ operation: "ai_probe", origin, model: request.model }]],
	["probe", checkAiProviderProbe, [{ operation: "ai_probe", origin, model: "gpt-other-fixture" }]],
	[
		"draft",
		checkAiProviderOutput,
		[
			{
				operation: "ai_draft_generate",
				origin,
				draft: { ...request, prompt: "Different trusted prompt." },
			},
		],
	],
] as const)(
	"refuses %s with a different trusted HTTP binding before fake dispatch",
	async (_operation, check, bindings) => {
		const fixture = fresh();
		const fixtures: AiProviderFixtures = {
			...fixture.fixtures,
			responsesHttp: bindings as readonly ResponsesHttpBindingInput[],
		};
		const result = await check({ plugin, mode: "process", fixtures: () => fixtures });
		expect(result).toMatchObject({ status: "fail" });
		expect(result).not.toMatchObject({ code: "AI_FIXTURES_INVALID" });
		expect(result).not.toMatchObject({ code: "AI_HUB_UNAVAILABLE" });
		expect(fixture.calls).toEqual([]);
	},
);
