import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { HELPERS, START_CHECK } from "./bootstrap.ts";
import { runtimeSpecifiers } from "./imports.ts";
import { loadProfiles, loadSteps } from "./registry.ts";

const here = path.resolve(import.meta.dirname, "..");
const steps = await loadSteps(path.join(here, "steps"));
const profiles = await loadProfiles(path.join(here, "profiles"));

function selected(profile: string, among: readonly string[]): string[] {
	const chosen = profiles.find((candidate) => candidate.name === profile)?.select(steps) ?? [];
	return chosen.map((step) => step.name).filter((name) => among.includes(name));
}

describe("steps and profiles", () => {
	it("has the default, cheap and docs profiles", () => {
		expect(profiles.map((profile) => profile.name)).toEqual(
			expect.arrayContaining(["cheap", "default", "docs"]),
		);
	});

	it("runs lint, typecheck, test and build in that order by default", () => {
		const expected = ["lint", "typecheck", "test", "build"];
		expect(selected("default", expected)).toEqual(expected);
	});

	it("leaves build out of the cheap profile", () => {
		expect(selected("cheap", ["lint", "typecheck", "test", "build"])).toEqual([
			"lint",
			"typecheck",
			"test",
		]);
	});

	it("imports only node: built-ins and relative files, so verify runs before pnpm install", () => {
		const files = ["lib", "steps", "profiles"].flatMap((dir) =>
			readdirSync(path.join(here, dir))
				.filter((file) => file.endsWith(".ts") && !file.endsWith(".test.ts"))
				.map((file) => path.join(dir, file)),
		);
		const bare = ["verify.ts", ...files].flatMap((file) =>
			[
				...readFileSync(path.join(here, file), "utf8").matchAll(
					/\b(?:from|import)\s*\(?\s*["']([^"']+)/g,
				),
			]
				.map((match) => match[1] ?? "")
				.filter((specifier) => !/^(?:node:|\.\.?\/)/.test(specifier))
				.map((specifier) => `${file}: ${specifier}`),
		);
		expect(bare).toEqual([]);
	});
});

// Every gated entry imports only node: built-ins (and types) up front, inlines the same start
// check, checks exactly the helpers it loads, and runs its start check, flag check and gate in that
// order, before its first child.
describe("the gated entries", () => {
	const repo = path.resolve(here, "..", "..");
	const read = (rel: string): string =>
		readFileSync(path.join(repo, rel), "utf8").replaceAll("\r\n", "\n");
	type HelperSet = keyof typeof HELPERS;
	const ENTRIES: Readonly<Record<string, readonly HelperSet[]>> = {
		"tools/verify/gate.ts": ["gate"],
		"tools/verify/preinstall.ts": ["preinstall"],
		"tools/verify/reserved-proof.ts": ["proof"],
		"tools/verify/turbo.ts": ["turbo"],
		"tools/verify/verify.ts": ["verify"],
		"tools/verify/m0-prefetch.ts": ["prefetch"],
		"spikes/kit/run.ts": ["kitOff", "kitRun"],
	};
	const entries = Object.keys(ENTRIES);
	// The kinds that load code. tools.ts resolves installed tools' package.json files (resolve), which
	// runs nothing.
	const LOADS = new Set(["static", "bare", "dynamic", "require"]);

	it("start the root typecheck, test and build through turbo.ts, and verify and m0:prefetch gated", () => {
		const { scripts } = JSON.parse(read("package.json")) as { scripts: Record<string, string> };
		expect(["typecheck", "test", "build"].map((name) => scripts[name])).toEqual(
			["typecheck", "test", "build"].map((task) => `node tools/verify/turbo.ts run ${task}`),
		);
		expect([scripts.verify, scripts["verify:m0"]]).toEqual([
			"node tools/verify/verify.ts",
			"node tools/verify/verify.ts --profile m0",
		]);
		const verify = JSON.parse(read("tools/verify/package.json")) as {
			scripts: Record<string, string>;
		};
		expect(verify.scripts["m0:prefetch"]).toBe("node m0-prefetch.ts");
	});

	it("import only node: built-ins and types statically", () => {
		const statics = entries.flatMap((entry) =>
			runtimeSpecifiers(read(entry))
				.filter(({ kind }) => kind === "static" || kind === "bare")
				.filter(({ value }) => !value.startsWith("node:"))
				.map(({ value }) => `${entry}: ${value}`),
		);
		expect(statics).toEqual([]);
	});

	it("check exactly the helpers they load, which import only node: built-ins and relative files", () => {
		for (const [entry, sets] of Object.entries(ENTRIES)) {
			const seen = new Set<string>();
			const bare = new Set<string>();
			const visit = (rel: string): void => {
				if (seen.has(rel)) return;
				seen.add(rel);
				for (const { value, kind } of runtimeSpecifiers(read(rel))) {
					if (value.startsWith(".")) {
						visit(path.posix.normalize(path.posix.join(path.posix.dirname(rel), value)));
					} else if (!value.startsWith("node:") && LOADS.has(kind)) bare.add(`${rel}: ${value}`);
				}
			};
			visit(entry);
			// The entry itself is trusted as started, and bootstrap.ts is checked by the inline copy.
			seen.delete(entry);
			seen.delete("tools/verify/lib/bootstrap.ts");
			const helpers = new Set(sets.flatMap((set) => HELPERS[set]));
			expect([...seen].toSorted(), entry).toEqual([...helpers].toSorted());
			expect([...bare], entry).toEqual([]);
		}
	});

	it("inline START_CHECK byte for byte", () => {
		expect(START_CHECK.length).toBeGreaterThan(0);
		const pattern = /\n\/\/ start check\n([\s\S]*?)\n\/\/ end start check\n/;
		for (const entry of entries) {
			expect(pattern.exec(read(entry))?.[1], entry).toBe(START_CHECK);
		}
	});

	// Each text must be in the function once, and the texts in this order: the start check, the flag
	// check, the input gate, then what the entry runs.
	const order = (rel: string, fn: string, texts: readonly string[]): string[] => {
		const source = read(rel);
		const start = source.indexOf(fn);
		const end = source.indexOf("\n}\n", start);
		const body = source.slice(start, end);
		const at = texts.map((text) => {
			const first = body.indexOf(text);
			return first >= 0 && body.indexOf(text, first + 1) < 0 ? first : -1;
		});
		const position = (index: number): number => at[index] ?? -1;
		return texts.filter(
			(_, index) => position(index) === -1 || (index > 0 && position(index) < position(index - 1)),
		);
	};

	it("start check, then flag, then gate, then the first child", () => {
		expect(
			order("tools/verify/turbo.ts", "export async function turboMain(", [
				"deps.startCheck()",
				'import("../../reserved-tests.ts")',
				"reservedTestsOn(env)",
				"deps.gate()",
				"deps.launch(",
			]),
		).toEqual([]);
		expect(
			order("tools/verify/verify.ts", "export async function main(", [
				"startCheckLines(root)",
				"startCheck()",
				'import("../../reserved-tests.ts")',
				"reservedTestsOn(process.env)",
				"await gate()",
				'import("./lib/registry.ts")',
				"context(profile, run,",
			]),
		).toEqual([]);
		expect(
			order("tools/verify/m0-prefetch.ts", "export async function prefetchEntry(", [
				"startCheckLines(deps.root)",
				"startCheck()",
				'import("../../reserved-tests.ts")',
				"reservedTestsOn(env)",
				"deps.gate()",
				"deps.prefetch(",
			]),
		).toEqual([]);
		expect(
			order("tools/verify/reserved-proof.ts", "export async function proofEntry(", [
				'import("../../reserved-tests.ts")',
				"reservedTestsOn(deps.env)",
				"deps.gate()",
				"deps.loadProof()",
			]),
		).toEqual([]);
		expect(
			order("spikes/kit/run.ts", "export async function kitMain(", [
				'deps.startCheck("kitOff")',
				"aliasedCwd(deps.root, deps.cwd)",
				"reservedSpikeOff(deps.cwd, env)",
				'deps.startCheck("kitGate")',
				"deps.gate()",
				'deps.startCheck("kitRun")',
				"deps.runner()",
			]),
		).toEqual([]);
		// The main blocks that run the inline check before anything loads; the first three also run
		// checkStart there, the other two hand it to their main function, which calls it first.
		for (const [rel, block] of [
			["tools/verify/gate.ts", ["startCheckLines(", "checkStart(", "gateCli("]],
			["tools/verify/preinstall.ts", ["startCheckLines(", "checkStart(", "preinstallMain("]],
			["tools/verify/reserved-proof.ts", ["startCheckLines(", "checkStart(", "proofEntry("]],
			["tools/verify/turbo.ts", ["startCheckLines(", 'import("./lib/bootstrap.ts")', "turboMain("]],
			["spikes/kit/run.ts", ["startCheckLines(", 'lib/bootstrap.ts")', "kitMain("]],
		] as const) {
			expect(order(rel, "if (import.meta.main) {", block), rel).toEqual([]);
		}
	});
});
