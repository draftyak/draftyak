import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { parseYaml, type Yaml } from "./yaml.ts";

const source = readFileSync(new URL("../../../.github/workflows/ci.yml", import.meta.url), "utf8");
const hub =
	"(contains(fromJSON(needs.changes.outputs.areas), 'heavy:...{./apps/hub}') || contains(fromJSON(needs.changes.outputs.areas), 'heavy:./apps/hub'))";
const nonDocs = "needs.changes.outputs.docs-only != 'true'";
const ready = "(github.event_name != 'pull_request' || !github.event.pull_request.draft)";
const native = "needs.changes.outputs.native-transport == 'true'";
const selected = `${nonDocs} && ${ready} && ${hub}`;
const run = [
	'node "$GITHUB_WORKSPACE/node_modules/vitest/vitest.mjs" run \\',
	"  test/model/store-crash-recovery.heavy.test.ts \\",
	"  --mode heavy --maxWorkers=1 --reporter=default --passWithNoTests=false \\",
	"  --exclude '**/*siwc*/**' --exclude '**/*siwc*' \\",
	"  --exclude '**/*dynamic-agent*' --exclude '**/*dynamic_agent*'",
	"",
].join("\n");

function map(value: Yaml | undefined): Record<string, Yaml> {
	if (value === null || typeof value !== "object" || Array.isArray(value)) {
		throw new Error("Expected workflow mapping");
	}
	return value;
}

const workflow = map(parseYaml(source).value);
const jobs = map(workflow.jobs);

function definition(name: string) {
	return map(jobs[name]);
}

function steps(name: string) {
	const value = definition(name).steps;
	if (!Array.isArray(value)) throw new Error("Missing workflow steps");
	return value.map(map);
}

describe("selected Hub store process-crash coverage", () => {
	it("keeps the ordinary shell, existing jobs and source-bound aggregation", () => {
		expect(map(map(workflow.defaults).run).shell).toBe("bash");
		expect(Object.keys(jobs)).toEqual([
			"changes",
			"cheap",
			"full",
			"spike-run",
			"spikes",
			"heavy",
			"windows",
			"macos",
			"inventory-physical-macos",
			"required",
		]);
		expect(definition("required").needs).toEqual([
			"changes",
			"cheap",
			"full",
			"spikes",
			"heavy",
			"windows",
			"macos",
			"inventory-physical-macos",
		]);
		expect(definition("required").if).toBe("always()");
		expect(definition("windows")["runs-on"]).toBe("windows-2025");
		expect(definition("macos")["runs-on"]).toBe("macos-15");
	});

	it("admits selected Hub work without weakening draft or documentation conditions", () => {
		expect(definition("windows").if).toBe(
			`${nonDocs} && (github.ref == 'refs/heads/main' || (github.event_name == 'pull_request' && !github.event.pull_request.draft) || (github.event_name != 'pull_request' && (${native} || ${hub})))`,
		);
		expect(definition("macos").if).toBe(`${nonDocs} && ${ready} && (${native} || ${hub})`);
	});

	it.each(["windows", "macos"])(
		"runs the exact selected heavy file on %s and refuses zero tests",
		(name) => {
			const all = steps(name);
			const selectedSteps = all.filter((step) => step.id === "store-crash");
			expect(selectedSteps).toHaveLength(1);
			expect(
				Object.fromEntries(
					Object.entries(selectedSteps[0] ?? {}).filter(([key]) => key !== "name"),
				),
			).toEqual({
				id: "store-crash",
				if: hub,
				"working-directory": "apps/hub",
				env: { DRAFTYAK_STRICT_SKIPS: "1" },
				run,
			});
			const install = all.findIndex((step) => step.run === "pnpm install --frozen-lockfile --ignore-scripts");
			expect(install).toBeGreaterThanOrEqual(0);
			expect(install).toBeLessThan(all.findIndex((step) => step.id === "store-crash"));
			expect(all.find((step) => step.id === "native")?.if).toBe(native);
		},
	);

	it("keeps Mac native work conditional when only the Hub suite is selected", () => {
		const all = steps("macos");
		for (const predicate of [
			(step: Record<string, Yaml>) =>
				step.run === "node tools/ci-checks/src/native-transport.ts platform",
			(step: Record<string, Yaml>) => String(step.uses).startsWith("dtolnay/rust-toolchain@"),
			(step: Record<string, Yaml>) => String(step.uses).startsWith("Swatinem/rust-cache@"),
			(step: Record<string, Yaml>) => step.id === "native",
		]) {
			const matching = all.filter(predicate);
			expect(matching).toHaveLength(1);
			expect(matching[0]?.if).toBe(native);
		}
	});

	it("requires both selected platforms before the unchanged receipt report", () => {
		const all = steps("required");
		const gate = all.findIndex(
			(step) => step.name === "Require selected Hub crash recovery on Windows and macOS",
		);
		const report = all.findIndex(
			(step) => step.run === "node tools/ci-checks/src/verification-receipt.ts report",
		);
		expect(gate).toBeGreaterThanOrEqual(0);
		expect(report).toBeGreaterThan(gate);
		expect(all[gate]?.if).toBe(selected);
		expect(all[gate]?.env).toEqual({
			WINDOWS_RESULT: "${{ needs.windows.result }}",
			MACOS_RESULT: "${{ needs.macos.result }}",
		});
		expect(all[gate]?.run).toBe(
			`node --input-type=module -e 'if (process.env.WINDOWS_RESULT !== "success" || process.env.MACOS_RESULT !== "success") process.exit(1)'`,
		);
		expect(all[report]?.env).toEqual({
			CI_NEEDS: "${{ toJSON(needs) }}",
			CI_HEAD_SHA: "${{ github.event.pull_request.head.sha || github.sha }}",
			CI_BASE_SHA: "${{ github.event.pull_request.base.sha || github.event.before }}",
			CI_PR_DRAFT: "${{ github.event.pull_request.draft == true }}",
		});
	});

	it.each([
		["both successful", "success", "success", 0],
		["Windows failure", "failure", "success", 1],
		["macOS failure", "success", "failure", 1],
		["Windows skipped", "skipped", "success", 1],
		["macOS skipped", "success", "skipped", 1],
		["Windows empty", "", "success", 1],
		["macOS empty", "success", "", 1],
	] as const)(
		"enforces %s through the actual required Hub crash gate",
		(_name, windows, macos, status) => {
			const gate = steps("required").find(
				(step) => step.name === "Require selected Hub crash recovery on Windows and macOS",
			);
			const program =
				/^node --input-type=module -e '(if \(process\.env\.WINDOWS_RESULT !== "success" (?:\|\||&&) process\.env\.MACOS_RESULT !== "success"\) process\.exit\(1\))'$/.exec(
					String(gate?.run),
				)?.[1];
			if (program === undefined) throw new Error("Unknown fixed Hub crash gate program");
			const result = spawnSync(process.execPath, ["--input-type=module", "-e", program], {
				env: { WINDOWS_RESULT: windows, MACOS_RESULT: macos },
				windowsHide: true,
				stdio: ["ignore", "pipe", "pipe"],
				encoding: "utf8",
			});
			expect(result.error).toBeUndefined();
			expect(result.signal).toBeNull();
			expect(result.status).toBe(status);
			expect(result.stdout).toBe("");
			expect(result.stderr).toBe("");
		},
	);
});
