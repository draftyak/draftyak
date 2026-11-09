import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { checkWorkflow } from "./workflow-policy.ts";
import { parseYaml } from "./yaml.ts";

const file = ".github/workflows/ci.yml";
const source = readFileSync(
	new URL("../../../.github/workflows/ci.yml", import.meta.url),
	"utf8",
).replaceAll("\r\n", "\n");
const check = (text: string) => checkWorkflow(file, text, "1.95.0");
const job = (name: string, change: (text: string) => string): string => {
	const expression = new RegExp(`(  ${name}:\\n)([\\s\\S]*?)(?=\\n  [a-z][a-z-]*:\\n|$)`);
	let changed = false;
	const result = source.replace(expression, (_, prefix: string, body: string) => {
		const value = change(body);
		expect(value).not.toBe(body);
		changed = true;
		return prefix + value;
	});
	expect(changed).toBe(true);
	return result;
};

describe("required native transport workflow controls", () => {
	it("admits the current three-platform wiring without granting additional workflow privileges", () => {
		expect(check(source)).toEqual([]);
		const workflow = parseYaml(source).value as {
			permissions: unknown;
			jobs: Record<string, { "runs-on": string; steps: { run?: string }[]; needs?: string[] }>;
		};
		expect(workflow.permissions).toEqual({ contents: "read" });
		expect(workflow.jobs.required?.needs).toEqual([
			"changes",
			"cheap",
			"full",
			"spikes",
			"heavy",
			"windows",
			"macos",
		]);
		expect(workflow.jobs.macos?.["runs-on"]).toBe("macos-15");
		for (const name of ["full", "windows", "macos"]) {
			expect(
				workflow.jobs[name]?.steps.filter(
					(step) => step.run === "pnpm exec node tools/ci-checks/src/native-transport.ts run",
				),
			).toHaveLength(1);
		}
	});
	it.each(["full", "windows", "macos"])(
		"refuses a missing or replaced %s native execution",
		(name) => {
			const text = job(name, (body) =>
				body.replace("pnpm exec node tools/ci-checks/src/native-transport.ts run", "pnpm verify"),
			);
			expect(check(text).join("\n")).toContain("must preserve");
		},
	);
	it.each(["full", "windows", "macos"])("refuses a forged %s completion mapping", (name) => {
		const text = job(name, (body) =>
			body.replace(
				"native-transport: ${{ steps.native.outputs.native-transport }}",
				"native-transport: passed",
			),
		);
		expect(check(text).join("\n")).toContain("completion outputs");
	});
	it.each(["full", "windows", "macos"])("refuses an absent %s source capture", (name) => {
		const text = job(name, (body) =>
			body.replace("node tools/ci-checks/src/verification-receipt.ts capture", "echo source"),
		);
		expect(check(text).join("\n")).toContain("must preserve");
	});
	it("refuses removing Mac from required aggregation", () => {
		expect(
			check(
				source.replace(
					"needs: [changes, cheap, full, spikes, heavy, windows, macos]",
					"needs: [changes, cheap, full, spikes, heavy, windows]",
				),
			).join("\n"),
		).toContain("required job execution controls");
	});
	it("refuses using an Intel Mac or a claimed architecture without actual platform preflight", () => {
		for (const [before, after] of [
			["NATIVE_ARCHITECTURE: arm64", "NATIVE_ARCHITECTURE: x64"],
			["native-transport.ts platform", "native-transport.ts select"],
			["runs-on: macos-15", "runs-on: ubuntu-24.04"],
		] as const) {
			expect(check(job("macos", (body) => body.replaceAll(before, after))).length).toBeGreaterThan(
				0,
			);
		}
	});
	it("refuses filtering away selected native work, continuing after failure or changing the toolchain", () => {
		for (const [before, after] of [
			["!github.event.pull_request.draft", "github.event.pull_request.draft"],
			["id: native", "id: native\n        continue-on-error: true"],
			["toolchain: 1.95.0", "toolchain: 1.94.0"],
			["timeout-minutes: 30", "timeout-minutes: 60"],
		] as const) {
			expect(check(job("macos", (body) => body.replaceAll(before, after))).length).toBeGreaterThan(
				0,
			);
		}
	});
	it("requires the exact native selector output and preserves ordinary heavy selection", () => {
		for (const [before, after] of [
			[
				"native-transport: ${{ steps.native.outputs.native-transport }}",
				"native-transport: 'false'",
			],
			["ordinary-heavy: ${{ steps.native.outputs.ordinary-heavy }}", "ordinary-heavy: ''"],
			["native-transport.ts select", "native-transport.ts platform"],
		] as const) {
			expect(check(job("changes", (body) => body.replace(before, after))).length).toBeGreaterThan(
				0,
			);
		}
	});
	it("keeps ordinary heavy execution separate from the three-platform native selectors", () => {
		expect(check(source)).toEqual([]);
		for (const [before, after] of [
			["needs.changes.outputs.ordinary-heavy != ''", "needs.changes.outputs.heavy != ''"],
			[
				"HEAVY: ${{ needs.changes.outputs.ordinary-heavy }}",
				"HEAVY: ${{ needs.changes.outputs.heavy }}",
			],
			["test:heavy --concurrency=1", "test:heavy --concurrency=2"],
			["${{ steps.heavy-test.outcome }}", "success"],
		] as const) {
			expect(check(job("heavy", (body) => body.replaceAll(before, after))).length).toBeGreaterThan(
				0,
			);
		}
		for (const group of ["spikes", "heavy"]) {
			expect(
				check(job("required", (body) => body.replace(`, ${group}`, ""))).length,
			).toBeGreaterThan(0);
		}
	});
});
