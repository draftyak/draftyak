import { describe, expect, it } from "vitest";
import { isDedicatedSpikeBuild } from "../src/build-context.ts";
import { capabilities, mustBuild, spikesRun } from "../src/toolchain.ts";

const dedicated = {
	GITHUB_ACTIONS: "true",
	DRAFTYAK_STRICT_SKIPS: "1",
	GITHUB_WORKFLOW: "spikes",
	GITHUB_JOB: "run",
};
const context = (overrides: NodeJS.ProcessEnv): NodeJS.ProcessEnv => ({
	...dedicated,
	...overrides,
});

describe("the dedicated mobile build context", () => {
	it.each([
		["the actual dedicated run", context({}), true],
		["strict full CI", context({ GITHUB_WORKFLOW: "ci", GITHUB_JOB: "full" }), false],
		["the planning job", context({ GITHUB_JOB: "plan" }), false],
		["another workflow's run job", context({ GITHUB_WORKFLOW: "ci" }), false],
		["a full job in the dedicated workflow", context({ GITHUB_JOB: "full" }), false],
		["a missing workflow", context({ GITHUB_WORKFLOW: undefined }), false],
		["an empty workflow", context({ GITHUB_WORKFLOW: "" }), false],
		["a workflow with different case", context({ GITHUB_WORKFLOW: "Spikes" }), false],
		["a workflow with trailing space", context({ GITHUB_WORKFLOW: "spikes " }), false],
		["a missing job", context({ GITHUB_JOB: undefined }), false],
		["an empty job", context({ GITHUB_JOB: "" }), false],
		["a job with different case", context({ GITHUB_JOB: "Run" }), false],
		["a job with trailing space", context({ GITHUB_JOB: "run " }), false],
		["Actions disabled", context({ GITHUB_ACTIONS: "false" }), false],
		["a nonliteral Actions value", context({ GITHUB_ACTIONS: "1" }), false],
		["a missing Actions marker", context({ GITHUB_ACTIONS: undefined }), false],
		["a missing strict flag", context({ DRAFTYAK_STRICT_SKIPS: undefined }), false],
		["strict skips disabled", context({ DRAFTYAK_STRICT_SKIPS: "0" }), false],
		["an empty strict flag", context({ DRAFTYAK_STRICT_SKIPS: "" }), false],
		["a standalone run", {}, false],
		["a local strict run", { DRAFTYAK_STRICT_SKIPS: "1" }, false],
	] as const)("recognizes %s", (_name, env, expected) => {
		expect(isDedicatedSpikeBuild(env)).toBe(expected);
	});

	it.each(["true", "01", "yes"])("preserves refusal of invalid strict flag %s", (value) => {
		expect(() => isDedicatedSpikeBuild(context({ DRAFTYAK_STRICT_SKIPS: value }))).toThrow(
			/DRAFTYAK_STRICT_SKIPS is 1/,
		);
	});

	it("preserves strict flag validation in ordinary Actions jobs", () => {
		expect(() =>
			isDedicatedSpikeBuild(
				context({ GITHUB_WORKFLOW: "ci", GITHUB_JOB: "full", DRAFTYAK_STRICT_SKIPS: "true" }),
			),
		).toThrow(/DRAFTYAK_STRICT_SKIPS is 1/);
	});

	it("does not parse a strict flag outside Actions", () => {
		expect(
			isDedicatedSpikeBuild(context({ GITHUB_ACTIONS: undefined, DRAFTYAK_STRICT_SKIPS: "true" })),
		).toBe(false);
	});

	it("accepts frozen environment data without modifying it", () => {
		const env = Object.freeze(context({}));
		expect(isDedicatedSpikeBuild(env)).toBe(true);
		expect(env).toEqual(dedicated);
	});
});

describe("mobile and host capability routing", () => {
	it("keeps strict full CI outside forced mobile builds and admits host checks", () => {
		const env = context({ GITHUB_WORKFLOW: "ci", GITHUB_JOB: "full" });
		expect(spikesRun(env)).toBe(false);
		expect(mustBuild(env, process.platform)).toBe(false);
		expect(capabilities(env)["host-checks"]?.detect()).toBe(true);
	});

	it("keeps the dedicated run mandatory only on its own OS", () => {
		expect(spikesRun(dedicated)).toBe(true);
		expect(mustBuild(dedicated, process.platform)).toBe(true);
		expect(mustBuild(dedicated, process.platform === "linux" ? "darwin" : "linux")).toBe(false);
		expect(capabilities(dedicated)["host-checks"]?.detect()).toBe(false);
	});

	it("retains host checks for local strict runs", () => {
		const env = { DRAFTYAK_STRICT_SKIPS: "1" };
		expect(mustBuild(env, process.platform)).toBe(false);
		expect(capabilities(env)["host-checks"]?.detect()).toBe(true);
	});
});
