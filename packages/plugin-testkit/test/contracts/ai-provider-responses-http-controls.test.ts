import type { ResponsesHttpBindingInput } from "@draftyak/protocol/manifest/responses-http";
import { describe, expect, it, vi } from "vitest";
import {
	type AiProviderContractOptions,
	type AiProviderFixtures,
	checkAiProviderOutput,
} from "../../src/contracts/ai-provider.ts";
import * as mockHub from "../../src/mock-hub.ts";
import type { MockHub } from "../../src/types.ts";
import { createResponsesContractFixture } from "../fixtures/ai-provider-responses-http/fixture.ts";

const origin = "https://api.openai.com" as const;
type FixtureSet = ReturnType<typeof createResponsesContractFixture>;

function options(
	set: FixtureSet,
	fixtures: AiProviderContractOptions["fixtures"] = set.fixtures,
): AiProviderContractOptions {
	return { plugin: set.plugin, mode: "in-memory", fixtures };
}

describe("Responses provider contract binding controls", () => {
	it.each(["absent", "mismatched"] as const)(
		"refuses %s trusted bindings before upstream dispatch",
		async (kind) => {
			const set = createResponsesContractFixture();
			const { responsesHttp: _bindings, ...fixtures } = set.fixtures();
			const input =
				kind === "absent"
					? fixtures
					: {
							...fixtures,
							responsesHttp: [
								{
									operation: "ai_draft_generate" as const,
									origin,
									draft: { ...fixtures.request, prompt: "DYTEST-Different trusted prompt." },
								},
							],
						};
			expect(await checkAiProviderOutput(options(set, () => input))).toMatchObject({
				status: "fail",
			});
			expect(set.calls).toEqual([]);
		},
	);

	it("does not take trusted bindings from fixture metadata or contract options", async () => {
		const set = createResponsesContractFixture();
		const { responsesHttp, ...ordinary } = set.fixtures();
		const input = {
			...options(set, () => ({
				...ordinary,
				metadata: { responsesHttp },
				instance: { config: { responsesHttp } },
			})),
			responsesHttp,
		};
		expect(await checkAiProviderOutput(input)).toMatchObject({ status: "fail" });
		expect(set.calls).toEqual([]);
	});

	it("refuses an accessor binding property without invoking it", async () => {
		const set = createResponsesContractFixture();
		const fixtures = set.fixtures();
		const bindings = fixtures.responsesHttp;
		let reads = 0;
		Object.defineProperty(fixtures, "responsesHttp", {
			enumerable: true,
			get() {
				reads++;
				return bindings;
			},
		});
		expect(await checkAiProviderOutput(options(set, () => fixtures))).toMatchObject({
			status: "fail",
		});
		expect(reads).toBe(0);
		expect(set.calls).toEqual([]);
	});

	it("refuses a proxy binding array without invoking its traps", async () => {
		const set = createResponsesContractFixture();
		const fixtures = set.fixtures();
		let traps = 0;
		const hook = (): never => {
			traps++;
			throw new Error("DYTEST-Binding proxy trap executed.");
		};
		const bindings = new Proxy([...fixtures.responsesHttp], {
			get: hook,
			ownKeys: hook,
			getOwnPropertyDescriptor: hook,
		});
		expect(
			await checkAiProviderOutput(options(set, () => ({ ...fixtures, responsesHttp: bindings }))),
		).toMatchObject({ status: "fail" });
		expect(traps).toBe(0);
		expect(set.calls).toEqual([]);
	});

	it("refuses a fixture proxy before its descriptor trap", async () => {
		const set = createResponsesContractFixture();
		let traps = 0;
		const hook = (): never => {
			traps++;
			throw new Error("DYTEST-Fixture proxy trap executed.");
		};
		const fixtures = new Proxy(set.fixtures(), {
			getOwnPropertyDescriptor: hook,
		});
		expect(await checkAiProviderOutput(options(set, () => fixtures))).toMatchObject({
			status: "fail",
		});
		expect(traps).toBe(0);
		expect(set.calls).toEqual([]);
	});

	it.each(["request", "upstreams"] as const)(
		"captures binding membership before reading effectful %s fixtures",
		async (field) => {
			const set = createResponsesContractFixture();
			const prepared = set.fixtures();
			const bindings = [...prepared.responsesHttp];
			const fixtures = { ...prepared, responsesHttp: bindings };
			let reads = 0;
			Object.defineProperty(fixtures, field, {
				enumerable: true,
				get() {
					reads++;
					bindings.length = 0;
					return prepared[field];
				},
			});
			expect(await checkAiProviderOutput(options(set, () => fixtures))).toEqual({ status: "pass" });
			expect(reads).toBeGreaterThan(0);
			expect(bindings).toEqual([]);
			expect(set.calls).toHaveLength(1);
		},
	);

	it("retains the issued request expectation after its original binding entry changes", async () => {
		let mutate = (): void => {};
		let observed = false;
		const set = createResponsesContractFixture(() => {
			observed = true;
			mutate();
		});
		const fixtures = set.fixtures();
		const binding = {
			operation: "ai_draft_generate" as const,
			origin,
			draft: { ...structuredClone(fixtures.request) },
		};
		mutate = () => {
			binding.draft.prompt = "DYTEST-Mutated after the host issued its binding.";
		};
		const responsesHttp: ResponsesHttpBindingInput[] = [binding];
		expect(
			await checkAiProviderOutput(options(set, () => ({ ...fixtures, responsesHttp }))),
		).toEqual({ status: "pass" });
		expect(observed).toBe(true);
		expect(set.calls).toHaveLength(1);
	});

	it("uses fresh fixtures for each check and closes their accepted host requests", async () => {
		const construct = mockHub.createMockHub;
		const hubs: MockHub[] = [];
		const spy = vi.spyOn(mockHub, "createMockHub").mockImplementation((input) => {
			const hub = construct(input);
			hubs.push(hub);
			return hub;
		});
		const set = createResponsesContractFixture();
		let prepared = 0;
		const fresh = (): AiProviderFixtures => {
			prepared++;
			return set.fixtures();
		};
		try {
			for (let index = 0; index < 2; index++) {
				expect(await checkAiProviderOutput(options(set, fresh))).toEqual({ status: "pass" });
				const hub = hubs[index];
				if (!hub) throw new Error("DYTEST-Fresh fixture hub missing.");
				await expect(
					hub.call("ai_draft_generate", { ...set.fixtures().request }),
				).rejects.toMatchObject({ code: "HOST_CLOSED" });
				expect(set.calls).toHaveLength(index + 1);
			}
			expect(prepared).toBe(2);
			expect(hubs).toHaveLength(2);
			expect(hubs[0]).not.toBe(hubs[1]);
		} finally {
			spy.mockRestore();
			await Promise.all(hubs.map((hub) => hub.close()));
		}
	});
});
