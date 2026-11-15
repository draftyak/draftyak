import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { classify } from "./changes.ts";
import { nativeTransportSelection } from "./native-transport.ts";
import { parseYaml } from "./yaml.ts";

const repository = path.resolve(import.meta.dirname, "..", "..", "..");
interface Step {
	readonly id?: string;
	readonly name?: string;
	readonly run?: string;
	readonly if?: string;
	readonly env?: Record<string, unknown>;
}
interface Job {
	readonly if?: string;
	readonly env?: Record<string, unknown>;
	readonly steps: Step[];
}
const workflow = parseYaml(readFileSync(path.join(repository, ".github/workflows/ci.yml"), "utf8"))
	.value as unknown as { jobs: Record<"heavy" | "spike-run", Job> };
const ordinary = workflow.jobs.heavy;
const shard = workflow.jobs["spike-run"];
const step = ordinary.steps.find((entry) => entry.id === "heavy-test");
const shardStep = shard.steps.find((entry) => entry.id === "heavy-test");
if (!step?.run || !step.env || !shardStep?.run)
	throw new Error("missing selected-heavy workflow step");
const environment = { ...ordinary.env, ...step.env };
const readySelection =
	"needs.changes.outputs.docs-only != 'true' && (github.event_name != 'pull_request' || !github.event.pull_request.draft) && ";
const bash = process.platform === "win32" ? "C:/Program Files/Git/bin/bash.exe" : "/bin/bash";

function exercise(
	files: string[],
	fail = false,
	overlay: Partial<Record<"spikes" | "heavy" | "rust", readonly string[]>> = {},
	sharded = false,
): { status: number | null; calls: unknown[] } {
	const root = mkdtempSync(path.join(tmpdir(), "draftyak-app-heavy-shell-"));
	try {
		for (const app of ["cli", "hub"]) {
			const directory = path.join(root, "apps", app);
			mkdirSync(directory, { recursive: true });
			writeFileSync(
				path.join(directory, "package.json"),
				JSON.stringify({
					name: `@draftyak/${app}`,
					scripts: { "test:heavy": "vitest run --mode heavy" },
				}),
			);
		}
		mkdirSync(path.join(root, "packages", "create-plugin"), { recursive: true });
		writeFileSync(path.join(root, "packages", "create-plugin", "package.json"), "{}");
		const selected = {
			...classify(
				files,
				root,
				() => [],
				() => [],
			),
			...overlay,
		};
		const split = nativeTransportSelection(selected.heavy.join("\n"), selected.rust.join("\n"));
		const outputs: Record<string, string> = {
			spikes: selected.spikes.join("\n"),
			"spike-count": String(selected.spikes.length),
			heavy: selected.heavy.join("\n"),
			"ordinary-heavy": split.ordinaryHeavy,
		};
		const job = sharded ? shard : ordinary;
		const commandStep = sharded ? shardStep : step;
		const effective = { ...job.env, ...commandStep?.env };
		const condition = String(job.if);
		if (!condition.startsWith(readySelection)) throw new Error("unknown heavy admission");
		const guard = /^needs\.changes\.outputs\.([a-z-]+) != '([^']*)'$/.exec(
			condition.slice(readySelection.length),
		);
		if (!guard || !Object.hasOwn(outputs, guard[1] ?? ""))
			throw new Error("unknown heavy condition");
		if (outputs[guard[1] ?? ""] === guard[2]) return { status: 0, calls: [] };
		let heavy = "";
		if (!sharded) {
			const field = /^\$\{\{ needs\.changes\.outputs\.([a-z-]+) \}\}$/.exec(
				String(effective.HEAVY),
			)?.[1];
			if (field === undefined || !Object.hasOwn(outputs, field))
				throw new Error("unknown heavy binding");
			heavy = outputs[field] ?? "";
		} else if (effective.SPIKE !== "${{ matrix.spike }}" || selected.spikes.length !== 1) {
			throw new Error("expected one selected shard importer");
		}
		const browserPath = path.join(root, "browsers");
		const capture = path.join(root, "capture.mjs");
		const output = path.join(root, "calls.jsonl");
		writeFileSync(
			capture,
			[
				'import {appendFileSync} from "node:fs";',
				"if(process.env.PLAYWRIGHT_BROWSERS_PATH!==process.env.CAPTURE_BROWSER_EXPECTED)process.exit(24);",
				'appendFileSync(process.env.CAPTURE_OUTPUT, JSON.stringify({args:process.argv.slice(2), strict:process.env.DRAFTYAK_STRICT_SKIPS})+"\\n");',
				'if(process.env.CAPTURE_FAIL==="1")process.exit(23);',
			].join("\n"),
		);
		// Absolute executable and script, no PATH interception or fallback. Only fixed argv metadata
		// reaches this stand-in: neither Turbo nor an application/heavy/live command is executed.
		const command = `node() { "$CAPTURE_NODE" "$CAPTURE_SCRIPT" "$@"; }\nreadonly -f node\n${commandStep?.run}`;
		const result = spawnSync(
			bash,
			["--noprofile", "--norc", "-e", "-o", "pipefail", "-c", command],
			{
				cwd: root,
				encoding: "utf8",
				env: {
					...(process.platform === "win32"
						? { SystemRoot: process.env.SystemRoot, WINDIR: process.env.WINDIR }
						: {}),
					PATH: "",
					CAPTURE_NODE: process.execPath.replaceAll("\\", "/"),
					CAPTURE_SCRIPT: capture.replaceAll("\\", "/"),
					CAPTURE_OUTPUT: output,
					CAPTURE_FAIL: fail ? "1" : "0",
					CAPTURE_BROWSER_EXPECTED: browserPath,
					SPIKES: selected.spikes.join("\n"),
					SPIKE: selected.spikes[0] ?? "",
					HEAVY: heavy,
					PLAYWRIGHT_BROWSERS_PATH:
						effective.PLAYWRIGHT_BROWSERS_PATH === "${{ steps.browser-setup.outputs.path }}"
							? browserPath
							: String(effective.PLAYWRIGHT_BROWSERS_PATH ?? ""),
					SMOKE: String(selected.templateSmoke),
					DRAFTYAK_STRICT_SKIPS: String(effective.DRAFTYAK_STRICT_SKIPS ?? ""),
				},
			},
		);
		expect(result.error).toBeUndefined();
		expect(result.stderr).toBe("");
		const calls = existsSync(output)
			? readFileSync(output, "utf8")
					.trim()
					.split("\n")
					.map((line) => JSON.parse(line))
			: [];
		return { status: result.status, calls };
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
}

describe("actual selected-heavy workflow application arguments", () => {
	it("keeps the existing condition, build prerequisite and explicit strict skips", () => {
		expect(ordinary.if).toBe(`${readySelection}needs.changes.outputs.ordinary-heavy != ''`);
		expect(shard.if).toBe(`${readySelection}needs.changes.outputs.spike-count != '0'`);
		expect(step.if).toBeUndefined();
		expect(shardStep.if).toBeUndefined();
		expect(environment.HEAVY).toBe("${{ needs.changes.outputs.ordinary-heavy }}");
		expect(environment.PLAYWRIGHT_BROWSERS_PATH).toBe("${{ steps.browser-setup.outputs.path }}");
		expect(environment.DRAFTYAK_STRICT_SKIPS).toBe("1");
		expect(shard.env?.SPIKE).toBe("${{ matrix.spike }}");
		for (const [job, commandStep] of [
			[ordinary, step],
			[shard, shardStep],
		] as const) {
			expect(job.env?.DRAFTYAK_STRICT_SKIPS).toBe("1");
			expect(commandStep.env?.DRAFTYAK_STRICT_SKIPS).toBeUndefined();
			const build = job.steps.findIndex((entry) => entry.run === "pnpm build");
			expect(build).toBeGreaterThan(-1);
			expect(build).toBeLessThan(job.steps.indexOf(commandStep));
		}
	});
	it.each(["cli", "hub"])("passes the dependent %s filter as one literal argument", (app) => {
		expect(exercise([`apps/${app}/src/main.ts`])).toEqual({
			status: 0,
			calls: [
				{
					args: [
						"tools/verify/turbo.ts",
						"run",
						"test:heavy",
						"--concurrency=1",
						"--log-order=stream",
						"--log-prefix=task",
						`--filter=...{./apps/${app}}`,
						"--filter=!./packages/create-plugin",
					],
					strict: "1",
				},
			],
		});
	});
	it("passes the exact bounded global targets without the optional-smoke exclusion", () => {
		expect(exercise(["package.json"])).toEqual({
			status: 0,
			calls: [
				{
					args: [
						"tools/verify/turbo.ts",
						"run",
						"test:heavy",
						"--concurrency=1",
						"--log-order=stream",
						"--log-prefix=task",
						"--filter=./apps/cli",
						"--filter=./apps/hub",
					],
					strict: "1",
				},
			],
		});
	});
	it("preserves the real command failure instead of accepting a summary-only result", () => {
		const result = exercise(["apps/hub/src/main.ts"], true);
		expect(result.status).toBe(23);
		expect(result.calls).toHaveLength(1);
	});
	it.each([
		["no work", { heavy: [] }],
		["native only", { heavy: ["./tools/transport-tests"], rust: ["crates"] }],
	] as const)("does not run an empty-filter ordinary command for %s", (_, overlay) => {
		expect(exercise([], false, overlay)).toEqual({ status: 0, calls: [] });
	});
	it("excludes the dedicated native wrapper from real ordinary shell arguments", () => {
		const result = exercise([], false, {
			heavy: ["./tools/transport-tests", "...{./apps/cli}"],
			rust: ["crates"],
		});
		expect(result).toEqual({
			status: 0,
			calls: [
				{
					args: [
						"tools/verify/turbo.ts",
						"run",
						"test:heavy",
						"--concurrency=1",
						"--log-order=stream",
						"--log-prefix=task",
						"--filter=...{./apps/cli}",
						"--filter=!./packages/create-plugin",
					],
					strict: "1",
				},
			],
		});
	});
	it("retains the actual spike-only shell execution with empty ordinary selection", () => {
		const selected = { spikes: ["spikes/kit"], heavy: [] };
		expect(exercise([], false, selected)).toEqual({ status: 0, calls: [] });
		expect(exercise([], false, selected, true)).toEqual({
			status: 0,
			calls: [
				{
					args: [
						"tools/verify/turbo.ts",
						"run",
						"test:heavy",
						"--concurrency=1",
						"--log-order=stream",
						"--log-prefix=task",
						"--filter=./spikes/kit",
					],
					strict: "1",
				},
			],
		});
		const failure = exercise([], true, selected, true);
		expect(failure.status).toBe(23);
		expect(failure.calls).toHaveLength(1);
	});
	it("invalidates the CI test cache when either reviewed app manifest changes", () => {
		const config = JSON.parse(
			readFileSync(path.join(repository, "tools/ci-checks/turbo.json"), "utf8"),
		);
		expect(config.tasks.test.inputs).toContain("$TURBO_ROOT$/apps/cli/package.json");
		expect(config.tasks.test.inputs).toContain("$TURBO_ROOT$/apps/hub/package.json");
	});
});
