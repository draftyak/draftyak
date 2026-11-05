import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { planHeavyShards } from "./heavy-shards.ts";
import { nativeTransportSelection } from "./native-transport.ts";
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
const replaceOnce = (body: string, before: string, after: string): string => {
	expect(body.split(before)).toHaveLength(2);
	const changed = body.replace(before, after);
	expect(changed).not.toBe(body);
	return changed;
};
const heavyStep = (body: string, change: (text: string) => string): string => {
	const marker = "      - name: test:heavy for ordinary product suites\n";
	expect(body.split(marker)).toHaveLength(2);
	const start = body.indexOf(marker);
	const end = body.indexOf("\n      - ", start + marker.length);
	expect(end).toBeGreaterThan(start);
	const original = body.slice(start, end);
	const changed = change(original);
	expect(changed).not.toBe(original);
	return body.slice(0, start) + changed + body.slice(end);
};
type Step = {
	readonly run?: string;
	readonly uses?: string;
	readonly if?: string;
	readonly env?: Readonly<Record<string, string>>;
};
type Job = {
	readonly if?: string;
	readonly env?: Readonly<Record<string, string>>;
	readonly steps: readonly Step[];
};
const definition = (name: string): Job => {
	const jobs = (parseYaml(source).value as unknown as { jobs: Record<string, Job> }).jobs;
	expect(Object.hasOwn(jobs, name)).toBe(true);
	return jobs[name] as Job;
};
const selected = (expression: string, terms: Readonly<Record<string, boolean>>): boolean =>
	expression
		.split(" || ")
		.map((term) => {
			expect(Object.hasOwn(terms, term)).toBe(true);
			return terms[term];
		})
		.some(Boolean);
const readySelection =
	"needs.changes.outputs.docs-only != 'true' && (github.event_name != 'pull_request' || !github.event.pull_request.draft) && ";

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
	it("requires ordinary filters and independent spike and ordinary job guards", () => {
		expect(check(source)).toEqual([]);
		const ordinary = definition("heavy");
		const consumers = ordinary.steps.filter((step) => Object.hasOwn(step.env ?? {}, "SMOKE"));
		expect(consumers).toHaveLength(1);
		expect(consumers[0]?.env?.HEAVY).toBe("${{ needs.changes.outputs.ordinary-heavy }}");
		expect(ordinary.env?.DRAFTYAK_STRICT_SKIPS).toBe("1");
		expect(definition("spike-run").env).toMatchObject({
			SPIKE: "${{ matrix.spike }}",
			SPIKES: "${{ needs.changes.outputs.spikes }}",
			DRAFTYAK_STRICT_SKIPS: "1",
		});
		for (const [name, before, after, diagnostic] of [
			[
				"heavy",
				"needs.changes.outputs.ordinary-heavy != ''",
				"needs.changes.outputs.heavy != ''",
				"must preserve heavy job execution controls",
			],
			[
				"heavy",
				"needs.changes.outputs.ordinary-heavy != ''",
				"needs.changes.outputs.spike-count != '0'",
				"must preserve heavy job execution controls",
			],
			[
				"spike-run",
				"needs.changes.outputs.spike-count != '0'",
				"needs.changes.outputs.ordinary-heavy != ''",
				"must preserve spike-run job execution controls",
			],
		] as const) {
			expect(check(job(name, (body) => replaceOnce(body, before, after))).join("\n")).toContain(
				diagnostic,
			);
		}
		const changed = job("heavy", (body) =>
			heavyStep(body, (step) =>
				replaceOnce(
					step,
					"HEAVY: ${{ needs.changes.outputs.ordinary-heavy }}",
					"HEAVY: ${{ needs.changes.outputs.heavy }}",
				),
			),
		);
		expect(check(changed).join("\n")).toContain("must preserve heavy command");
		const duplicate = job(
			"full",
			(body) => `${body}      - run: pnpm exec node tools/ci-checks/src/native-transport.ts run\n`,
		);
		expect(check(duplicate).join("\n")).toContain("must preserve full command");
	});
	it.each([
		["no work", "", "", false, false],
		["native only", "", "./tools/transport-tests", false, false],
		["ordinary only", "", "./apps/cli", true, false],
		["spikes only", "spikes/kit", "", false, true],
		["mixed", "spikes/kit", "./tools/transport-tests\n./apps/cli", true, true],
	] as const)(
		"keeps the two real heavy jobs correctly selected for %s",
		(_, spikes, heavy, expectedOrdinary, expectedSpikes) => {
			const binding = nativeTransportSelection(
				heavy,
				heavy.includes("./tools/transport-tests") ? "crates" : "",
			);
			const plan = planHeavyShards(spikes);
			const ordinary = definition("heavy");
			const shard = definition("spike-run");
			expect(ordinary.if).toBe(`${readySelection}needs.changes.outputs.ordinary-heavy != ''`);
			expect(shard.if).toBe(`${readySelection}needs.changes.outputs.spike-count != '0'`);
			expect(binding.ordinaryHeavy.split("\n")).not.toContain("./tools/transport-tests");
			expect(
				selected((ordinary.if ?? "").slice(readySelection.length), {
					"needs.changes.outputs.ordinary-heavy != ''": binding.ordinaryHeavy !== "",
				}),
			).toBe(expectedOrdinary);
			expect(
				selected((shard.if ?? "").slice(readySelection.length), {
					"needs.changes.outputs.spike-count != '0'": plan.count !== 0,
				}),
			).toBe(expectedSpikes);
		},
	);
	it("keeps one pinned Windows Rust setup for either parent condition before its native cache", () => {
		const windows = definition("windows").steps;
		const rust = windows.filter((step) => step.uses?.startsWith("dtolnay/rust-toolchain@"));
		expect(rust).toHaveLength(1);
		const condition =
			"hashFiles('crates/Cargo.toml') != '' || needs.changes.outputs.native-transport == 'true'";
		expect(rust[0]?.if).toBe(condition);
		expect(windows.indexOf(rust[0] as Step)).toBeLessThan(
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
				check(job("windows", (body) => replaceOnce(body, condition, replacement))).join("\n"),
			).toContain("pinned native Rust setup");
		}
	});
	it("requires ordinary filters and the nonempty ordinary guard for later product-heavy composition", () => {
		expect(check(source)).toEqual([]);
		for (const replacement of [
			"needs.changes.outputs.heavy != ''",
			"needs.changes.outputs.spikes != '' || needs.changes.outputs.ordinary-heavy != ''",
		]) {
			expect(
				check(
					job("heavy", (body) =>
						replaceOnce(
							body,
							`${readySelection}needs.changes.outputs.ordinary-heavy != ''`,
							`${readySelection}${replacement}`,
						),
					),
				).join("\n"),
			).toContain("must preserve heavy job execution controls");
		}
		const combined = job("heavy", (body) =>
			heavyStep(body, (step) =>
				replaceOnce(
					step,
					"          HEAVY: ${{ needs.changes.outputs.ordinary-heavy }}",
					"          HEAVY: ${{ needs.changes.outputs.ordinary-heavy }}\n          SPIKES: ${{ needs.changes.outputs.spikes }}",
				),
			),
		);
		expect(check(combined).join("\n")).toContain("must preserve heavy command");
		const misplaced = job(
			"full",
			(body) => `${body}      - run: node tools/verify/turbo.ts run test:heavy --concurrency=1\n`,
		);
		expect(check(misplaced).join("\n")).toContain(
			"test:heavy must preserve the selected shard or ordinary-heavy command",
		);
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
