import { describe, expect, it } from "vitest";
import type { Step } from "../lib/registry.ts";
import { profile as core } from "../profiles/windows-core.ts";
import { profile as tests } from "../profiles/windows-tests.ts";

function check(name: string, order: number, profiles: readonly string[] = ["default"]): Step {
	return Object.freeze({
		name,
		order,
		profiles,
		run: async () => ({ status: "passed" as const }),
	});
}

describe("Windows verification profiles", () => {
	it("covers every default check and runs tests once, sharing only the typecheck prerequisite", () => {
		const steps = [
			check("build", 40),
			check("test", 30),
			check("lint", 10),
			check("zizmor", 50),
			check("typecheck", 20),
			check("rust", 35),
			check("vendor-guard", 15),
		];
		const originalOrder = steps.map((step) => step.name);
		const coreNames = core.select(steps).map((step) => step.name);
		const testNames = tests.select(steps).map((step) => step.name);
		expect(coreNames).toEqual(["lint", "vendor-guard", "typecheck", "rust", "build", "zizmor"]);
		expect(testNames).toEqual(["typecheck", "test"]);
		expect([...new Set([...coreNames, ...testNames])].sort()).toEqual(
			["lint", "vendor-guard", "typecheck", "test", "rust", "build", "zizmor"].sort(),
		);
		expect(coreNames.filter((name) => testNames.includes(name))).toEqual(["typecheck"]);
		expect([...coreNames, ...testNames].filter((name) => name === "test")).toHaveLength(1);
		expect(steps.map((step) => step.name)).toEqual(originalOrder);
	});

	it("retains future default checks and original callbacks without admitting other profiles", () => {
		let runs = 0;
		const future = Object.freeze({
			...check("future-check", 25),
			run: async () => {
				runs += 1;
				return { status: "passed" as const };
			},
		});
		const steps = Object.freeze([
			check("test", 30),
			check("other-profile", 1, ["cheap"]),
			future,
			check("typecheck", 20),
		]);
		const coreSteps = core.select(steps);
		expect(coreSteps.map((step) => step.name)).toEqual(["typecheck", "future-check"]);
		expect(coreSteps[1]).toBe(future);
		expect(tests.select(steps).map((step) => step.name)).toEqual(["typecheck", "test"]);
		expect(runs).toBe(0);
	});
});
