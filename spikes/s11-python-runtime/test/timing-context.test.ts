import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import { timingContextAvailable } from "../src/timing-context.ts";
import config from "../vitest.config.ts";

const actions = {
	GITHUB_ACTIONS: "true",
	GITHUB_WORKFLOW: "spikes",
	GITHUB_JOB: "run",
	CI: "true",
	DRAFTYAK_STRICT_SKIPS: "1",
};
const context = (overrides: NodeJS.ProcessEnv): NodeJS.ProcessEnv => ({
	...actions,
	...overrides,
});
afterEach(() => vi.unstubAllEnvs());

describe("S11 timing context", () => {
	it.each([
		["a local run", {}, true],
		["local CI strict0", { CI: "true", DRAFTYAK_STRICT_SKIPS: "0" }, true],
		["local CI strict1", { CI: "true", DRAFTYAK_STRICT_SKIPS: "1" }, true],
		["a non-Actions marker", context({ GITHUB_ACTIONS: "false" }), true],
		[
			"shared Actions strict0",
			context({ GITHUB_WORKFLOW: "ci", GITHUB_JOB: "full", DRAFTYAK_STRICT_SKIPS: "0" }),
			false,
		],
		["shared Actions strict1", context({ GITHUB_WORKFLOW: "ci", GITHUB_JOB: "full" }), false],
		["the dedicated run", context({}), true],
		["the dedicated run strict0", context({ DRAFTYAK_STRICT_SKIPS: "0" }), true],
		["another workflow's run job", context({ GITHUB_WORKFLOW: "ci" }), false],
		["the planning job", context({ GITHUB_JOB: "plan" }), false],
		["the dedicated workflow's full job", context({ GITHUB_JOB: "full" }), false],
		["a missing workflow", context({ GITHUB_WORKFLOW: undefined }), false],
		["a missing job", context({ GITHUB_JOB: undefined }), false],
		["workflow case", context({ GITHUB_WORKFLOW: "Spikes" }), false],
		["job case", context({ GITHUB_JOB: "Run" }), false],
		["workflow trailing space", context({ GITHUB_WORKFLOW: "spikes " }), false],
		["job trailing space", context({ GITHUB_JOB: "run " }), false],
	] as const)("routes %s", (_name, env, eligible) => {
		expect(timingContextAvailable(env)).toBe(eligible);
	});

	it.each([
		[
			"shared strict0",
			context({ GITHUB_WORKFLOW: "ci", GITHUB_JOB: "full", DRAFTYAK_STRICT_SKIPS: "0" }),
			false,
		],
		["shared strict1", context({ GITHUB_WORKFLOW: "ci", GITHUB_JOB: "full" }), false],
		["dedicated", context({}), true],
		["planning", context({ GITHUB_JOB: "plan" }), false],
		["local CI strict0", { CI: "true", DRAFTYAK_STRICT_SKIPS: "0" }, true],
		["local CI strict1", { CI: "true", DRAFTYAK_STRICT_SKIPS: "1" }, true],
	] as const)("wires the actual package capability for %s", (_name, env, eligible) => {
		const controlled: NodeJS.ProcessEnv = env;
		for (const name of Object.keys(actions)) vi.stubEnv(name, controlled[name]);
		const actual = config({ command: "serve", mode: "heavy" });
		const tag = actual.test?.tags?.find((entry) => entry.name === "requires:s11-timing-context");
		expect(tag).toBeDefined();
		expect(tag?.skip ?? false).toBe(!eligible);
		expect(actual.test?.fileParallelism).toBe(false);
		const strict = env.DRAFTYAK_STRICT_SKIPS === "1";
		expect(actual.plugins).toHaveLength(strict ? 1 : 0);
	});

	it("carries Actions identity through the actual uncached heavy task", () => {
		const declared = JSON.parse(readFileSync(new URL("../turbo.json", import.meta.url), "utf8"));
		expect(declared.extends).toEqual(["//"]);
		expect(declared.tasks["test:heavy"]).toEqual({
			passThroughEnv: ["GITHUB_ACTIONS", "GITHUB_WORKFLOW", "GITHUB_JOB"],
		});
		const root = JSON.parse(readFileSync(new URL("../../../turbo.json", import.meta.url), "utf8"));
		expect(root.tasks["test:heavy"]).toMatchObject({
			cache: false,
			dependsOn: ["^build"],
			env: ["DRAFTYAK_*"],
		});
	});

	it("tags only the timing case in the actual heavy source", () => {
		const source = readFileSync(new URL("./budgets.heavy.test.ts", import.meta.url), "utf8");
		const timing =
			/it\("holds cold start, idle RSS and the 1 MiB round trip to the budgets",\s*\{\s*tags:\s*\[([^\]]+)\],\s*timeout:\s*benchTimeout\(TIMING_WORK_MS\) \+ PROVISIONAL_LOCK_MS,\s*\}, async/.exec(
				source,
			);
		expect(timing).not.toBeNull();
		expect(timing?.[1]).toContain("`requires:${capTag}`");
		expect(timing?.[1]).toContain('"requires:s11-timing-context"');
		expect(source.match(/"requires:s11-timing-context"/g)).toHaveLength(1);
		expect(source).toContain("if (process.env.CI && !strictSkips())");
	});
});
