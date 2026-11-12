import { expect, it } from "vitest";
import {
	checkAiProviderModels,
	checkAiProviderOutput,
	checkAiProviderProbe,
	checkAiProviderProgress,
	checkAiProviderSurface,
} from "../../src/contracts/ai-provider.ts";
import { createResponsesContractFixture } from "../fixtures/ai-provider-responses-http/fixture.ts";
import { origin, request, responseBody } from "../fixtures/ai-provider-responses-http/plugin.ts";

it.each([
	[checkAiProviderSurface, undefined],
	[checkAiProviderModels, "/v1/models"],
	[checkAiProviderProbe, `/v1/models/${request.model}`],
	[checkAiProviderOutput, "/v1/responses"],
	[checkAiProviderProgress, "/v1/responses"],
] as const)("passes %s through the SDK with only constructor-bound HTTP", async (check, target) => {
	const fixture = createResponsesContractFixture();
	expect(await check({ ...fixture, mode: "in-memory" })).toEqual({ status: "pass" });
	expect(fixture.calls.map((call) => call.url)).toEqual(target ? [origin + target] : []);
	if (target === "/v1/responses") {
		expect(fixture.calls[0]).toEqual({
			method: "POST",
			url: origin + target,
			body: responseBody(request),
		});
	}
});
