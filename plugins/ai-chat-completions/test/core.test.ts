import { describe, expect, it } from "vitest";
import { CompatibleError, type CompatibleRequest } from "../src/index.ts";
import { completion, core, OUTPUT, REQUEST, response } from "./helpers.ts";

describe("injected compatible runner", () => {
	it("uses a caller-rebuilt repair prompt only in a separate provider call", async () => {
		const provider = core();
		const seen: CompatibleRequest[] = [];
		const transport = async (request: CompatibleRequest) => {
			seen.push(request);
			return seen.length === 1
				? completion(provider, "PRIVATE_CANARY invalid JSON")
				: completion(provider);
		};
		const invalid = await provider.generate(REQUEST, transport);
		expect(seen).toHaveLength(1);
		expect(invalid.kind).toBe("invalid");
		if (invalid.kind !== "invalid") throw Error("Expected invalid synthetic draft");
		const repairInput = {
			...REQUEST,
			system: `${REQUEST.system}\nHub-owned repair issues: ${invalid.problems.join("; ")}.`,
		};
		const result = await provider.generate(repairInput, transport);
		expect(result.kind).toBe("draft");
		expect(result.usage).toEqual({ input: 10, output: 3 });
		expect(seen).toHaveLength(2);
		expect(seen.map((request) => request.url)).toEqual([
			provider.config.endpoint,
			provider.config.endpoint,
		]);
		const repaired = JSON.parse(seen[1]?.body ?? "{}");
		expect(repaired.messages[0].content).toBe(repairInput.system);
		expect(repaired.messages[1].content).toBe(REQUEST.prompt);
		expect(JSON.stringify(repaired)).not.toContain("PRIVATE_CANARY");
	});
	it("does not retry an invalid-schema outcome inside a provider call", async () => {
		const provider = core("json_object");
		let calls = 0;
		const result = await provider.generate(REQUEST, async () => {
			calls++;
			return completion(provider, { ...OUTPUT, body: 1 });
		});
		expect(calls).toBe(1);
		expect(result.kind).toBe("invalid");
	});
	it.each(["length", "content_filter", "PRIVATE_CANARY"])(
		"does not repair stop reason %s",
		async (reason) => {
			const provider = core();
			let calls = 0;
			await provider.generate(REQUEST, async () => {
				calls++;
				return completion(provider, "not JSON", reason);
			});
			expect(calls).toBe(1);
		},
	);
	it("returns content-free transport failures without fallback or retry", async () => {
		const provider = core();
		let calls = 0;
		const result = await provider.generate(REQUEST, async () => {
			calls++;
			throw new Error("PRIVATE_CANARY");
		});
		expect(result).toMatchObject({
			kind: "unexpected",
			fallback: false,
			stopReason: "transport_error",
		});
		expect(JSON.stringify(result)).not.toContain("PRIVATE_CANARY");
		expect(calls).toBe(1);
	});
	it("honors cancellation before and after a transport completes", async () => {
		const provider = core();
		const first = new AbortController();
		first.abort();
		let calls = 0;
		await expect(
			provider.generate(
				REQUEST,
				async () => {
					calls++;
					return completion(provider);
				},
				first.signal,
			),
		).rejects.toThrow(CompatibleError);
		expect(calls).toBe(0);
		const second = new AbortController();
		await expect(
			provider.generate(
				REQUEST,
				async () => {
					second.abort();
					return completion(provider);
				},
				second.signal,
			),
		).rejects.toMatchObject({ code: "ABORTED" });
	});
	it("probes with synthetic content and returns status without draft data", async () => {
		const provider = core("ollama");
		expect(
			await provider.probe(async () => completion(provider, { ...OUTPUT, contextRefs: [] })),
		).toEqual({ status: "ok" });
		expect(await provider.probe(async () => response(provider, {}, 401))).toEqual({
			status: "degraded",
			detail: "probe: unexpected",
		});
	});
});
