import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { classify } from "./changes.ts";
import { parseYaml } from "./yaml.ts";

const repository = path.resolve(import.meta.dirname, "..", "..", "..");
interface Step {
	readonly name?: string;
	readonly run?: string;
	readonly if?: string;
	readonly env?: Record<string, unknown>;
}
const workflow = parseYaml(readFileSync(path.join(repository, ".github/workflows/ci.yml"), "utf8"))
	.value as unknown as { jobs: { full: { steps: Step[] } } };
const steps = workflow.jobs.full.steps;
const step = steps.find((entry) => entry.name?.startsWith("test:heavy for"));
if (!step?.run || !step.env) throw new Error("missing selected-heavy workflow step");
const run = step.run;
const environment = step.env;
const bash = process.platform === "win32" ? "C:/Program Files/Git/bin/bash.exe" : "/bin/bash";

function exercise(files: string[], fail = false): { status: number | null; calls: unknown[] } {
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
		writeFileSync(
			path.join(root, "pnpm-lock.yaml"),
			"lockfileVersion: '9.0'\nimporters:\n  .: {}\n  apps/cli: {}\n  apps/hub: {}\n  packages/create-plugin: {}\n",
		);
		const selected = classify(files, root, () => []);
		const capture = path.join(root, "capture.mjs");
		const output = path.join(root, "calls.jsonl");
		writeFileSync(
			capture,
			[
				'import {appendFileSync} from "node:fs";',
				'appendFileSync(process.env.CAPTURE_OUTPUT, JSON.stringify({args:process.argv.slice(2), strict:process.env.DRAFTYAK_STRICT_SKIPS})+"\\n");',
				'if(process.env.CAPTURE_FAIL==="1")process.exit(23);',
			].join("\n"),
		);
		// Absolute executable and script, no PATH interception or fallback. Only fixed argv metadata
		// reaches this stand-in: neither Turbo nor an application/heavy/live command is executed.
		const command = `node() { "$CAPTURE_NODE" "$CAPTURE_SCRIPT" "$@"; }\nreadonly -f node\n${run}`;
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
					SPIKES: selected.spikes.join("\n"),
					HEAVY: selected.heavy.join("\n"),
					SMOKE: String(selected.templateSmoke),
					DRAFTYAK_STRICT_SKIPS: String(environment.DRAFTYAK_STRICT_SKIPS ?? ""),
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
		expect(step.if).toBe("needs.changes.outputs.spikes != '' || needs.changes.outputs.heavy != ''");
		expect(environment.DRAFTYAK_STRICT_SKIPS).toBe("1");
		expect(steps.findIndex((entry) => entry.run === "pnpm build")).toBeGreaterThan(-1);
		expect(steps.findIndex((entry) => entry.run === "pnpm build")).toBeLessThan(
			steps.indexOf(step),
		);
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
	it("invalidates the CI test cache when either reviewed app manifest changes", () => {
		const config = JSON.parse(
			readFileSync(path.join(repository, "tools/ci-checks/turbo.json"), "utf8"),
		);
		expect(config.tasks.test.inputs).toContain("$TURBO_ROOT$/apps/cli/package.json");
		expect(config.tasks.test.inputs).toContain("$TURBO_ROOT$/apps/hub/package.json");
	});
});
