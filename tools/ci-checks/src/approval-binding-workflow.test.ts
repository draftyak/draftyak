import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { parseYaml, type Yaml } from "./yaml.ts";

type YamlMap = Readonly<Record<string, Yaml>>;
type WorkflowName = "security" | "nightly";

function mapping(value: Yaml | undefined): YamlMap {
	if (value === null || typeof value !== "object" || Array.isArray(value)) {
		throw new TypeError("Expected a workflow mapping");
	}
	return value;
}

function workflow(name: WorkflowName): YamlMap {
	return mapping(
		parseYaml(
			readFileSync(new URL(`../../../.github/workflows/${name}.yml`, import.meta.url), "utf8"),
		).value,
	);
}

function bindingJob(value: YamlMap): YamlMap {
	const jobs = mapping(value.jobs);
	expect(Object.keys(jobs)).toEqual(["approval-binding"]);
	return mapping(jobs["approval-binding"]);
}

function steps(job: YamlMap): readonly YamlMap[] {
	if (!Array.isArray(job.steps)) throw new TypeError("Expected workflow steps");
	return job.steps.map(mapping);
}

const bindingCommand = [
	'node "$GITHUB_WORKSPACE/node_modules/vitest/vitest.mjs" run',
	"test/model/send-approval-binding.test.ts",
	"--mode test --config vitest.config.ts --no-file-parallelism",
	"--maxWorkers=1 --reporter=default",
	"--exclude '**/*siwc*/**' --exclude '**/*siwc*'",
	"--exclude '**/*dynamic-agent*' --exclude '**/*dynamic_agent*'",
].join(" ");

const cases = [
	{ name: "security", runs: "500", ref: "${{ github.sha }}" },
	{ name: "nightly", runs: "10000", ref: "m2" },
] as const;

describe("approval binding workflow selection", () => {
	it("security selects only ready pull requests targeting m2", () => {
		const value = workflow("security");
		expect(value.on).toEqual({
			pull_request: {
				branches: ["m2"],
				types: ["opened", "synchronize", "reopened", "ready_for_review"],
			},
		});
		expect(value.concurrency).toEqual({
			group: "security-${{ github.event.pull_request.number || github.ref }}",
			"cancel-in-progress": "${{ github.event_name == 'pull_request' }}",
		});
		const job = bindingJob(value);
		expect(job.if).toBe("github.event_name != 'pull_request' || !github.event.pull_request.draft");
		expect(Object.keys(job).sort()).toEqual(["if", "name", "runs-on", "steps", "timeout-minutes"]);
	});

	it("nightly selects the daily 03 UTC schedule and fixed manual route", () => {
		const value = workflow("nightly");
		expect(value.on).toEqual({
			schedule: [{ cron: "0 3 * * *" }],
			workflow_dispatch: null,
		});
		expect(value.concurrency).toEqual({
			group: "approval-binding-nightly-m2",
			"cancel-in-progress": false,
		});
		expect(Object.keys(bindingJob(value)).sort()).toEqual([
			"name",
			"runs-on",
			"steps",
			"timeout-minutes",
		]);
	});

	for (const { name, runs, ref } of cases) {
		it(`${name} uses read-only pinned setup before the frozen Hub dependency build`, () => {
			const value = workflow(name);
			expect(value.permissions).toEqual({ contents: "read" });
			expect(value.defaults).toEqual({ run: { shell: "bash" } });
			const job = bindingJob(value);
			expect(job["runs-on"]).toBe("ubuntu-24.04");
			expect(job["timeout-minutes"]).toBe(30);
			const actual = steps(job);
			expect(actual).toHaveLength(6);
			expect(actual.slice(0, 5)).toEqual([
				{
					uses: "actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1",
					with: { "persist-credentials": false, ref },
				},
				{
					uses: "actions/setup-node@949feb2413d6458794dcd2491c4babbbce0c15c1",
					with: { "node-version-file": ".node-version" },
				},
				{
					uses: "pnpm/action-setup@ea17c68df8912ef543352723c149a84f56e3d413",
					with: { cache: true },
				},
				{ run: "pnpm install --frozen-lockfile" },
				{ run: "pnpm build --filter=@draftyak/hub..." },
			]);
		});

		it(`${name} runs the complete binding property at ${runs} attempts per channel`, () => {
			const value = workflow(name);
			const env = mapping(value.env);
			expect(env.DRAFTYAK_APPROVAL_BINDING_RUNS).toBe(runs);
			expect(env).toEqual({
				CI: "true",
				DO_NOT_TRACK: "1",
				TURBO_TELEMETRY_DISABLED: "1",
				DRAFTYAK_STRICT_SKIPS: "1",
				DRAFTYAK_APPROVAL_BINDING_RUNS: runs,
			});
			const job = bindingJob(value);
			expect(job.env).toBeUndefined();
			const actual = steps(job);
			expect(actual).toHaveLength(6);
			const check = mapping(actual[5]);
			expect(Object.keys(check).sort()).toEqual(["name", "run", "working-directory"]);
			expect(check["working-directory"]).toBe("apps/hub");
			if (typeof check.run !== "string") throw new TypeError("Expected the binding command");
			// Only bash line continuations are removed; extra commands and filters remain visible.
			expect(check.run.replace(/[ \t]*\\\r?\n[ \t]*/gu, " ").trim()).toBe(bindingCommand);
		});
	}
});
