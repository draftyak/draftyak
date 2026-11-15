import {
	bindProcessPlugin,
	createMockHub,
	type MockHub,
	MockHubError,
} from "@draftyak/plugin-testkit";
import { aiProviderContract } from "@draftyak/plugin-testkit/contracts/ai-provider";
import { afterAll, expect, it } from "vitest";

import { plugin, prepareProcessContractFiles } from "./fixtures/process-contract/bundle.ts";
import { makeProcessContractFixtures } from "./fixtures/process-contract/fixture.ts";

const packed = await prepareProcessContractFiles();

try {
	// Contract registration completes now; its checks and owned children run later.
	afterAll(() => packed.dispose());
	it("refuses process mode without an explicit process binding", async () => {
		const fixtures = await makeProcessContractFixtures();
		let unexpected: MockHub | undefined;
		try {
			unexpected = createMockHub({
				mode: "process",
				plugin,
				upstreams: fixtures.upstreams,
				...(fixtures.responsesHttp === undefined ? {} : { responsesHttp: fixtures.responsesHttp }),
			});
		} catch (error) {
			expect(error).toBeInstanceOf(MockHubError);
			expect(error).toMatchObject({ code: "PROCESS_BINDING_REQUIRED" });
			return;
		} finally {
			await unexpected?.close();
		}
		throw new Error("An unbound process plugin was accepted");
	});
	const bound = bindProcessPlugin(plugin, packed.source);
	await aiProviderContract({
		plugin: bound,
		mode: "process",
		fixtures: makeProcessContractFixtures,
	});
} catch (registrationError) {
	try {
		await packed.dispose();
	} catch (cleanupError) {
		throw new AggregateError(
			[registrationError, cleanupError],
			"Process-contract registration and packing cleanup failed",
		);
	}
	throw registrationError;
}
