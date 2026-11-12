import {
	type AiProviderFixtures,
	checkAiProviderModels,
	checkAiProviderOutput,
	checkAiProviderProbe,
	checkAiProviderProgress,
	checkAiProviderSurface,
	createMockHub,
} from "@draftyak/plugin-testkit";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type CompatibleFormat, MAX_RESPONSE_BYTES } from "../src/index.ts";
import {
	type CompatibleProcessFixture,
	compatibleProcessFixture,
} from "./fixtures/compatible-process/fixture.ts";

const checks = [
	{ check: checkAiProviderSurface, fetches: 0 },
	{ check: checkAiProviderModels, fetches: 1 },
	{ check: checkAiProviderProbe, fetches: 1 },
	{ check: checkAiProviderOutput, fetches: 1 },
	{ check: checkAiProviderProgress, fetches: 1 },
] as const;

async function bounded<T>(stage: string, promise: Promise<T>): Promise<T> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	try {
		return await Promise.race([
			promise,
			new Promise<never>((_resolve, reject) => {
				timer = setTimeout(
					() => reject(new Error(`DYTEST process observation timed out: ${stage}`)),
					10_000,
				);
			}),
		]);
	} finally {
		if (timer) clearTimeout(timer);
	}
}

function hubFor(fixture: CompatibleProcessFixture, data: AiProviderFixtures) {
	return createMockHub({
		mode: "process",
		plugin: fixture.plugin,
		upstreams: data.upstreams,
		...(data.compatibleHttp === undefined ? {} : { compatibleHttp: data.compatibleHttp }),
	});
}

for (const format of ["json_schema", "json_object", "ollama"] satisfies CompatibleFormat[]) {
	describe(`compatible factory process contract (${format})`, () => {
		let fixture: CompatibleProcessFixture | undefined;
		beforeAll(async () => {
			fixture = await compatibleProcessFixture(format);
		});
		afterAll(async () => {
			await fixture?.cleanup();
		});
		for (const { check, fetches } of checks) {
			it(check.name, async () => {
				if (!fixture) throw new Error("Compatible process fixture unavailable.");
				const result = await check({
					plugin: fixture.plugin,
					mode: "process",
					fixtures: fixture.fixtures,
				});
				expect(fixture.parentCalls()).toBe(0);
				// This assertion comes first so a missing binding cannot masquerade as a transport failure.
				expect(fixture.calls()).toHaveLength(fetches);
				if (fetches !== 0) {
					const call = fixture.calls()[0];
					const models = check === checkAiProviderModels;
					expect(call?.method).toBe(models ? "GET" : "POST");
					expect(call?.url).toBe(
						`http://127.0.0.1/${
							models
								? format === "ollama"
									? "api/tags"
									: "v1/models"
								: format === "ollama"
									? "api/chat"
									: "v1/chat/completions"
						}`,
					);
				}
				expect(result).toEqual({ status: "pass" });
			});
		}
		if (format === "json_schema") {
			it("refuses an independently mismatched request before the upstream sees it", async () => {
				if (!fixture) throw new Error("Compatible process fixture unavailable.");
				const data = fixture.fixtures();
				const bindings = data.compatibleHttp;
				if (!bindings) throw new Error("DYTEST independent request comparisons required");
				const hub = hubFor(fixture, {
					...data,
					compatibleHttp: bindings.map((binding) =>
						binding.operation === "ai_draft_generate"
							? {
									...binding,
									draft: { ...binding.draft, prompt: "DYTEST different independent prompt" },
								}
							: binding,
					),
				});
				try {
					const result = await hub.call("ai_draft_generate", { ...data.request });
					expect(fixture.parentCalls()).toBe(0);
					expect(fixture.calls()).toHaveLength(0);
					expect(result).toMatchObject({
						isError: true,
						structuredContent: { code: "PERMISSION_DENIED" },
					});
				} finally {
					await hub.close();
				}
			});

			it("rejects an incorrect expected progress sequence from actual process notifications", async () => {
				if (!fixture) throw new Error("Compatible process fixture unavailable.");
				const current = fixture;
				const result = await checkAiProviderProgress({
					plugin: current.plugin,
					mode: "process",
					fixtures: () => ({
						...current.fixtures(),
						progress: [
							{ progress: 0, total: 1 },
							{ progress: 1, total: 2 },
						],
					}),
				});
				expect(current.parentCalls()).toBe(0);
				expect(current.calls()).toHaveLength(1);
				expect(result).toEqual({ status: "fail", code: "AI_PROGRESS_INVALID" });
			});

			it("cancels an oversized provider body without waiting for upstream EOF", async () => {
				if (!fixture) throw new Error("Compatible process fixture unavailable.");
				expect(MAX_RESPONSE_BYTES).toBe(262_144);
				const data = fixture.fixtures("oversize");
				const hub = hubFor(fixture, data);
				try {
					await hub.discover();
					const result = await hub.call("ai_draft_generate", { ...data.request });
					expect(fixture.parentCalls()).toBe(0);
					expect(fixture.calls()).toHaveLength(1);
					expect(result).toMatchObject({ isError: true, structuredContent: { code: "TRANSIENT" } });
					await bounded("oversize upstream cancellation", fixture.cancelled());
					expect(fixture.cancellations()).toBe(1);
				} finally {
					await hub.close();
				}
			});

			it("closes an in-flight process read and rejects later calls without another dispatch", async () => {
				if (!fixture) throw new Error("Compatible process fixture unavailable.");
				const data = fixture.fixtures("stall");
				const hub = hubFor(fixture, data);
				try {
					await hub.discover();
					const pending = hub.call("ai_draft_generate", { ...data.request }).then(
						(result) => ({ kind: "result" as const, result }),
						() => ({ kind: "rejected" as const }),
					);
					await bounded("request reached upstream", fixture.started());
					await bounded("upstream body reader attached", fixture.reading());
					expect(fixture.calls()).toHaveLength(1);
					await hub.close();
					const settled = await bounded("closed request settlement", pending);
					if (settled.kind === "result") expect(settled.result).toMatchObject({ isError: true });
					await bounded("closed upstream cancellation", fixture.cancelled());
					expect(fixture.cancellations()).toBe(1);
					expect(fixture.parentCalls()).toBe(0);
					await expect(hub.call("ai_describe", {})).rejects.toMatchObject({ code: "HOST_CLOSED" });
					expect(fixture.calls()).toHaveLength(1);
					await hub.close();
				} finally {
					await hub.close();
				}
			});
		}
	});
}
