import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { nativeTransportSelection } from "./native-transport.ts";
import { checkWorkflow } from "./workflow-policy.ts";
import { parseYaml } from "./yaml.ts";

const file = ".github/workflows/ci.yml";
const source = readFileSync(
	new URL("../../../.github/workflows/ci.yml", import.meta.url),
	"utf8",
).replaceAll("\r\n", "\n");
const check = (text: string) => checkWorkflow(file, text, "1.95.0");
const stepSource = (workflow: string, name: string): string => {
	const marker = `      - name: ${name}\n`;
	expect(workflow.split(marker).length).toBe(2);
	const start = workflow.indexOf(marker);
	const next = workflow.indexOf("\n      - ", start + marker.length);
	return workflow.slice(start, next < 0 ? workflow.length : next + 1);
};
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
type Step = {
	readonly run?: string;
	readonly uses?: string;
	readonly if?: string;
	readonly env?: Readonly<Record<string, string>>;
};
const steps = (name: string): readonly Step[] =>
	(parseYaml(source).value as unknown as { jobs: Record<string, { steps: readonly Step[] }> }).jobs[
		name
	]?.steps ?? [];
const selected = (expression: string, terms: Readonly<Record<string, boolean>>): boolean =>
	expression
		.split(" || ")
		.map((term) => {
			expect(Object.hasOwn(terms, term)).toBe(true);
			return terms[term];
		})
		.some(Boolean);

describe("required native transport workflow controls", () => {
	it("admits the current three-platform wiring without granting additional workflow privileges", () => {
		expect(check(source)).toEqual([]);
		const workflow = parseYaml(source).value as {
			permissions: unknown;
			jobs: Record<string, { "runs-on": string; steps: { run?: string }[]; needs?: string[] }>;
		};
		expect(workflow.permissions).toEqual({ contents: "read" });
		expect(workflow.jobs.required?.needs).toEqual(["changes", "cheap", "full", "windows", "macos"]);
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
					"needs: [changes, cheap, full, windows, macos]",
					"needs: [changes, cheap, full, windows]",
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
				"heavy: ${{ steps.areas.outputs.heavy }}",
				"heavy: ${{ steps.native.outputs.ordinary-heavy }}",
			],
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
	it("requires ordinary filters and the nonempty spike-or-ordinary guard on the real combined step", () => {
		expect(check(source)).toEqual([]);
		const combined = steps("full").filter((step) => Object.hasOwn(step.env ?? {}, "HEAVY"));
		expect(combined).toHaveLength(1);
		expect(combined[0]?.env).toMatchObject({
			HEAVY: "${{ needs.changes.outputs.ordinary-heavy }}",
			SPIKES: "${{ needs.changes.outputs.spikes }}",
			DRAFTYAK_STRICT_SKIPS: "1",
		});
		expect(combined[0]?.if).toBe(
			"needs.changes.outputs.spikes != '' || needs.changes.outputs.ordinary-heavy != ''",
		);
		const consumer = "test:heavy for the touched spikes and the selected packages";
		const producer = "Prepare authenticated offline Node fixture";
		const originalStep = stepSource(source, consumer);
		const originalCondition = /^        if: (.*)$/m.exec(originalStep)?.[1] ?? "";
		expect(originalCondition).toBe(combined[0]?.if);
		for (const [before, after] of [
			[
				"HEAVY: ${{ needs.changes.outputs.ordinary-heavy }}",
				"HEAVY: ${{ needs.changes.outputs.heavy }}",
			],
			["needs.changes.outputs.ordinary-heavy != ''", "needs.changes.outputs.heavy != ''"],
			["needs.changes.outputs.spikes != '' || ", ""],
			[" || needs.changes.outputs.ordinary-heavy != ''", ""],
		] as const) {
			const changedStep = originalStep.replace(before, after);
			expect(changedStep).not.toBe(originalStep);
			const mutated = source.replace(originalStep, changedStep);
			expect(stepSource(mutated, producer)).toBe(stepSource(source, producer));
			expect(stepSource(mutated, consumer)).toBe(changedStep);
			if (!before.startsWith("HEAVY: ")) {
				const condition = /^        if: (.*)$/m.exec(changedStep)?.[1];
				expect(condition).not.toBe(originalCondition);
				expect(condition).toBe(originalCondition.replace(before, after));
			}
			const diagnostics = check(mutated).join("\n");
			expect(diagnostics).toContain("must preserve");
			expect(diagnostics).toContain(
				"ordinary heavy suites must exclude the dedicated native selector",
			);
		}
		const duplicate = job(
			"full",
			(body) => `${body}      - run: pnpm exec node tools/ci-checks/src/native-transport.ts run\n`,
		);
		expect(check(duplicate).join("\n")).toContain("must preserve full command");
	});
	it.each([
		["no work", "", "", false],
		["native only", "", "./tools/transport-tests", false],
		["ordinary only", "", "./apps/cli", true],
		["spikes only", "spikes/kit", "", true],
		["mixed", "spikes/kit", "./tools/transport-tests\n./apps/cli", true],
	] as const)(
		"keeps the real combined step correctly selected for %s",
		(_, spikes, heavy, expected) => {
			const binding = nativeTransportSelection(
				heavy,
				heavy.includes("./tools/transport-tests") ? "crates" : "",
			);
			const [combined] = steps("full").filter((step) => Object.hasOwn(step.env ?? {}, "HEAVY"));
			expect(combined?.env?.HEAVY).toBe("${{ needs.changes.outputs.ordinary-heavy }}");
			expect(binding.ordinaryHeavy.split("\n")).not.toContain("./tools/transport-tests");
			expect(
				selected(combined?.if ?? "", {
					"needs.changes.outputs.spikes != ''": spikes !== "",
					"needs.changes.outputs.ordinary-heavy != ''": binding.ordinaryHeavy !== "",
				}),
			).toBe(expected);
		},
	);
	it("keeps one pinned Windows Rust setup for either parent condition before its native cache", () => {
		const windows = steps("windows");
		const rust = windows.filter((step) => step.uses?.startsWith("dtolnay/rust-toolchain@"));
		expect(rust).toHaveLength(1);
		const condition =
			"hashFiles('crates/Cargo.toml') != '' || needs.changes.outputs.native-transport == 'true'";
		expect(rust[0]?.if).toBe(condition);
		const rustIndex = windows.indexOf(rust[0] as Step);
		expect(rustIndex).toBeLessThan(
			windows.findIndex((step) => step.uses?.startsWith("Swatinem/rust-cache@")),
		);
		for (const [manifest, native, expected] of [
			[true, false, true],
			[false, true, true],
			[true, true, true],
			[false, false, false],
		] as const) {
			expect(
				selected(rust[0]?.if ?? "", {
					"hashFiles('crates/Cargo.toml') != ''": manifest,
					"needs.changes.outputs.native-transport == 'true'": native,
				}),
			).toBe(expected);
		}
		for (const replacement of [
			"false",
			"hashFiles('crates/Cargo.toml') != ''",
			"needs.changes.outputs.native-transport == 'true'",
			condition.replace(" || ", " && "),
		]) {
			expect(
				check(job("windows", (body) => body.replace(condition, replacement))).join("\n"),
			).toContain("pinned native Rust setup");
		}
	});
});
