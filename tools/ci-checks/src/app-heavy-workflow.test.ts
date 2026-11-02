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

function exercise(
	files: string[],
	fail = false,
	overlay: Partial<Record<"spikes" | "heavy" | "rust", readonly string[]>> = {},
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
			heavy: selected.heavy.join("\n"),
			"ordinary-heavy": split.ordinaryHeavy,
		};
		const clauses = String(step?.if)
			.split(" || ")
			.map((clause) => {
				const field = /^needs\.changes\.outputs\.([a-z-]+) != ''$/.exec(clause)?.[1];
				if (field === undefined || !Object.hasOwn(outputs, field))
					throw new Error("unknown heavy condition");
				return outputs[field] !== "";
			});
		if (!clauses.some(Boolean)) return { status: 0, calls: [] };
		const heavyField = /^\$\{\{ needs\.changes\.outputs\.([a-z-]+) \}\}$/.exec(
			String(environment.HEAVY),
		)?.[1];
		if (heavyField === undefined || !Object.hasOwn(outputs, heavyField))
			throw new Error("unknown heavy binding");
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
					CAPTURE_BROWSER_EXPECTED: browserPath,
					SPIKES: selected.spikes.join("\n"),
					HEAVY: outputs[heavyField],
					PLAYWRIGHT_BROWSERS_PATH:
						environment.PLAYWRIGHT_BROWSERS_PATH === "${{ steps.browser-setup.outputs.path }}"
							? browserPath
							: String(environment.PLAYWRIGHT_BROWSERS_PATH ?? ""),
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
		expect(step.if).toBe(
			"needs.changes.outputs.spikes != '' || needs.changes.outputs.ordinary-heavy != ''",
		);
		expect(environment.HEAVY).toBe("${{ needs.changes.outputs.ordinary-heavy }}");
		expect(environment.PLAYWRIGHT_BROWSERS_PATH).toBe("${{ steps.browser-setup.outputs.path }}");
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
						"--filter=...{./apps/cli}",
						"--filter=!./packages/create-plugin",
					],
					strict: "1",
				},
			],
		});
	});
	it("retains the actual spike-only shell execution with empty ordinary selection", () => {
		expect(exercise([], false, { spikes: ["spikes/kit"], heavy: [] })).toEqual({
			status: 0,
			calls: [
				{
					args: [
						"tools/verify/turbo.ts",
						"run",
						"test:heavy",
						"--concurrency=1",
						"--filter=./spikes/kit",
						"--filter=!./packages/create-plugin",
					],
					strict: "1",
				},
			],
		});
	});
	it("invalidates the CI test cache when either reviewed app manifest changes", () => {
		const config = JSON.parse(
			readFileSync(path.join(repository, "tools/ci-checks/turbo.json"), "utf8"),
		);
		expect(config.tasks.test.inputs).toContain("$TURBO_ROOT$/apps/cli/package.json");
		expect(config.tasks.test.inputs).toContain("$TURBO_ROOT$/apps/hub/package.json");
	});
});
