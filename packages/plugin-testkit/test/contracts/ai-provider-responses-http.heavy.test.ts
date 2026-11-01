import { afterAll, expect, it } from "vitest";
import {
	checkAiProviderModels,
	checkAiProviderOutput,
	checkAiProviderProbe,
	checkAiProviderProgress,
	checkAiProviderSurface,
} from "../../src/contracts/ai-provider.ts";
import { bindProcessPlugin } from "../../src/index.ts";
import { createResponsesContractFixture } from "../fixtures/ai-provider-responses-http/fixture.ts";
import { origin, request, responseBody } from "../fixtures/ai-provider-responses-http/plugin.ts";
import { responsesProcessFixture } from "../fixtures/ai-provider-responses-http/process.ts";

const packed = await responsesProcessFixture();
afterAll(packed.cleanup);

it.each([
	[checkAiProviderSurface, undefined],
	[checkAiProviderModels, "/v1/models"],
	[checkAiProviderProbe, `/v1/models/${request.model}`],
	[checkAiProviderOutput, "/v1/responses"],
	[checkAiProviderProgress, "/v1/responses"],
] as const)("passes %s with bound HTTP from the production process", async (check, target) => {
	const fixture = createResponsesContractFixture();
	const plugin = bindProcessPlugin(
		{
			...fixture.plugin,
			entry: {
				...fixture.plugin.entry,
				tools: fixture.plugin.entry.tools.map((tool) => ({
					...tool,
					handler() {
						throw new Error("Parent bound provider handler executed");
					},
				})),
			},
		},
		packed.files,
	);
	expect(await check({ plugin, fixtures: fixture.fixtures })).toEqual({ status: "pass" });
	expect(fixture.calls.map((call) => call.url)).toEqual(target ? [origin + target] : []);
	if (target === "/v1/responses") {
		expect(fixture.calls[0]).toEqual({
			method: "POST",
			url: origin + target,
			body: responseBody(request),
		});
	}
});
