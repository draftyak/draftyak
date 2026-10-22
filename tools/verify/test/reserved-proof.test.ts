import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import { biomeNegations, RESERVED_TESTS, reservedWord, testTier } from "../../../reserved-tests.ts";
import { START_STOP_LINE } from "../lib/bootstrap.ts";
import {
	biomeArgs,
	type CountsReport,
	check,
	type Deps,
	describeProblem,
	type FileCounts,
	filteredDirs,
	INVENTORY,
	KIT_RUN,
	main,
	type ProofTier,
	packageOf,
	parseInventory,
	type Row,
	reservedBiomeConfig,
	reservedOwners,
	type TierRun,
	TYPECHECK_MARKS,
	tierArgs,
	typecheckArgs,
	wiring,
} from "../lib/proof.ts";
import { loadProfiles, loadSteps, type Profile, type StepContext } from "../lib/registry.ts";
import { step as reservedStep } from "../steps/reserved.ts";

// The proof with every tool stubbed (turbo, biome, the tracked list, the gate's result and the
// marks folder), on synthetic names: a reserved-only package and a mixed one. The reserved words are
// built here, so this file never spells one; titles and assertion values stay neutral (row numbers,
// kinds and counts), and compared values are scrubbed, so a failure prints no reserved word.
const verify = path.resolve(import.meta.dirname, "..");
const repo = path.resolve(verify, "..", "..");
const word = ["si", "wc"].join("");
const parts = ["dynamic", "agent"];
const spikeNumber = ["s0", "7"].join("");
const reservedText = new RegExp(`${word}|${spikeNumber}[-_]|${parts.join("[-_]")}`, "gi");
const scrub = (text: string): string => text.replace(reservedText, "<reserved>");

// Compares as JSON; a failure prints both sides scrubbed.
function same(actual: unknown, expected: unknown): void {
	const json = (value: unknown): string =>
		JSON.stringify(value, (_, inner) => (inner instanceof Set ? [...inner] : inner));
	const [a, b] = [json(actual), json(expected)];
	expect(a === b ? "same" : `${scrub(a)}\n  is not\n${scrub(b)}`).toBe("same");
}

// The proven line the tools accept (3.0), and the four final forms of which a run prints one.
const PROVEN =
	/^reserved proof: proven: unit (\d+)\/(\d+)(?:, heavy (\d+)\/(\d+))?; typecheck marks (\d+)\/(\d+)$/;
const finals = (lines: readonly string[]): string[] =>
	lines.filter((line) => /^reserved proof: (?:proven|complete|partial|not proven):/.test(line));
const named = (lines: readonly string[]): number =>
	lines.filter((line) => reservedWord.test(line)).length;

const only = `pkgs/${word}-only`;
const tracked = [
	"package.json",
	`${only}/package.json`,
	`${only}/test/a.test.ts`,
	`${only}/test/b.test.ts`,
	`${only}/test/c.heavy.test.ts`,
	`${only}/test/d.live.test.ts`,
	`${only}/test/helper.ts`,
	"pkgs/mixed/package.json",
	`pkgs/mixed/test/x-${word}.test.ts`,
	"pkgs/mixed/test/plain.test.ts",
];
const rows: Row[] = [
	{ file: `${only}/test/a.test.ts`, tier: "unit", minPassed: 3 },
	{ file: `${only}/test/b.test.ts`, tier: "unit", minPassed: 2 },
	{ file: `${only}/test/c.heavy.test.ts`, tier: "heavy", minPassed: 1 },
	{ file: `${only}/test/d.live.test.ts`, tier: "live", minPassed: 1 },
	{ file: `pkgs/mixed/test/x-${word}.test.ts`, tier: "unit", minPassed: 4 },
];
const counts = (file: string, passed: number, more: Partial<FileCounts> = {}): FileCounts => ({
	file,
	state: "passed",
	errors: 0,
	passed,
	failed: 0,
	skipped: 0,
	todo: 0,
	...more,
});
const report = (
	root: string,
	files: FileCounts[],
	more: Partial<CountsReport> = {},
): CountsReport => ({
	version: 1,
	tier: "unit",
	optIn: true,
	root,
	reason: "passed",
	unhandledErrors: 0,
	files,
	...more,
});
const unitReports = (): CountsReport[] => [
	report(only, [counts(rows[0]?.file ?? "", 3), counts(rows[1]?.file ?? "", 2)]),
	report("pkgs/mixed", [
		counts(rows[4]?.file ?? "", 4),
		counts("pkgs/mixed/test/plain.test.ts", 9),
	]),
];
const heavyReports = (): CountsReport[] => [
	report(only, [counts(rows[2]?.file ?? "", 1)], { tier: "heavy" }),
];
const unitRun = (reports = unitReports(), code = 0): ReadonlyMap<ProofTier, TierRun> =>
	new Map([["unit", { code, reports }]]);
const kinds = (input: Parameters<typeof check>[0]) =>
	check(input).map((problem) =>
		"row" in problem ? `${problem.kind} ${problem.row}` : problem.kind,
	);

describe("the inventory", () => {
	it("reads rows of file, tier, minPassed and an optional maxSkipped, under about and files", () => {
		same(parseInventory(JSON.stringify({ about: "x", files: rows })), { rows });
		same(parseInventory(JSON.stringify({ files: rows })), { rows });
		const skippy = JSON.stringify({ files: [{ ...rows[0], maxSkipped: 2 }] });
		same(parseInventory(skippy), { rows: [{ ...rows[0], maxSkipped: 2 }] });
	});

	it.each([
		["not JSON", "{", "isn't valid JSON"],
		["no files array", "{}", 'needs a "files" array'],
		["an array", "[]", 'needs a "files" array'],
		["a row without a tier", '{"files":[{"file":"a","minPassed":1}]}', "row 1 needs"],
		["an unknown tier", '{"files":[{"file":"a","tier":"x","minPassed":1}]}', "row 1 needs"],
	])("refuses %s", (_, text, message) => {
		expect(String(parseInventory(text)).includes(message)).toBe(true);
	});

	it("refuses a rust key: no Rust row is proven", () => {
		const rust = [{ package: "p", target: "t", module: "m", tier: "unit", minPassed: 2 }];
		for (const value of [
			{ about: "x", files: rows, rust },
			{ files: [], rust: [] },
			{ rust: [] },
		]) {
			expect(parseInventory(JSON.stringify(value))).toBe(
				'has a "rust" key; the proof runs no Rust rows',
			);
		}
	});

	it("refuses any key but about and files", () => {
		for (const value of [
			{ about: "x", files: rows, notes: "x" },
			{ About: "x", files: rows },
			{ files: rows, "": 1 },
		]) {
			expect(parseInventory(JSON.stringify(value))).toBe('has keys other than "about" and "files"');
		}
	});

	it("reads the maintainer's inventory: about and files only, and every row whole", () => {
		const parsed = parseInventory(readFileSync(path.join(repo, INVENTORY), "utf8"));
		expect(typeof parsed === "string" ? parsed : "parsed").toBe("parsed");
	});
});

describe("check", () => {
	it("passes when every selected row ran at or above its minimum", () => {
		expect(kinds({ tracked, rows, runs: unitRun() })).toEqual([]);
	});

	it("finds packages by their tracked package.json", () => {
		same(
			[packageOf(`${only}/test/a.test.ts`, tracked), packageOf("loose.test.ts", tracked)],
			[only, null],
		);
	});

	it("needs a row for every tracked reserved test file, and a tracked file for every row", () => {
		const extra = [...tracked, `${only}/test/new.test.ts`];
		expect(kinds({ tracked: extra, rows, runs: unitRun() })).toEqual(["missing-row"]);
		const stale = [
			...rows,
			{ file: `${only}/test/gone.test.ts`, tier: "unit", minPassed: 1 } as const,
		];
		expect(kinds({ tracked, rows: stale, runs: new Map() })).toEqual(["stale-row 6"]);
	});

	it("refuses a row whose tier isn't the file name's, and a minimum below 1 or fractional", () => {
		const bad = rows.map((row, index) =>
			index === 0
				? { ...row, tier: "heavy" as const }
				: index === 1
					? { ...row, minPassed: 0 }
					: row,
		);
		bad[4] = { ...rows[4], minPassed: 1.5 } as Row;
		bad[2] = { ...rows[2], maxSkipped: -1 } as Row;
		expect(kinds({ tracked, rows: bad, runs: new Map() })).toEqual([
			"tier-mismatch 1",
			"bad-minimum 2",
			"bad-minimum 3",
			"bad-minimum 5",
		]);
	});

	it("fails on the tier run's exit status even when every count looks right", () => {
		expect(kinds({ tracked, rows, runs: unitRun(unitReports(), 1) })).toEqual(["run-exit"]);
	});

	it("fails a run that ended with failures, unhandled errors or an interruption", () => {
		for (const more of [{ reason: "failed" }, { unhandledErrors: 1 }, { reason: "interrupted" }]) {
			const reports = unitReports();
			reports[1] = { ...(reports[1] as CountsReport), ...more };
			expect(kinds({ tracked, rows, runs: unitRun(reports) })).toEqual(["run-outcome"]);
		}
	});

	it("fails a run made without the flag", () => {
		const reports = unitReports().map((r) => ({ ...r, optIn: false }));
		expect(kinds({ tracked, rows, runs: unitRun(reports) })).toEqual(["not-opted-in"]);
	});

	it("fails a row that never ran, as when its package was left out or disabled", () => {
		const reports = unitReports().slice(1);
		expect(kinds({ tracked, rows, runs: unitRun(reports) })).toEqual(["not-run 1", "not-run 2"]);
	});

	it("fails an empty collection and a failing or unloadable file", () => {
		const reports = unitReports();
		reports[0] = report(only, [
			counts(rows[0]?.file ?? "", 0),
			counts(rows[1]?.file ?? "", 2, { failed: 1, state: "failed" }),
		]);
		reports[1] = report("pkgs/mixed", [counts(rows[4]?.file ?? "", 4, { errors: 1 })]);
		expect(kinds({ tracked, rows, runs: unitRun(reports) })).toEqual([
			"empty 1",
			"below-minimum 1",
			"failed 2",
			"failed 5",
		]);
	});

	it("never counts skipped or todo tests toward a minimum, and fails them beyond maxSkipped", () => {
		const reports = unitReports();
		reports[1] = report("pkgs/mixed", [counts(rows[4]?.file ?? "", 4, { skipped: 2, todo: 1 })]);
		expect(check({ tracked, rows, runs: unitRun(reports) })).toEqual([
			{ kind: "skipped", row: 5, skipped: 3, max: 0 },
		]);
		const allowed = rows.map((row, index) => (index === 4 ? { ...row, maxSkipped: 3 } : row));
		expect(kinds({ tracked, rows: allowed, runs: unitRun(reports) })).toEqual([]);
		reports[1] = report("pkgs/mixed", [counts(rows[4]?.file ?? "", 2, { skipped: 40 })]);
		expect(kinds({ tracked, rows, runs: unitRun(reports) })).toEqual([
			"below-minimum 5",
			"skipped 5",
		]);
	});

	it("refuses a file that two count reports hold instead of adding them up", () => {
		const reports = [...unitReports(), report("pkgs/mixed", [counts(rows[4]?.file ?? "", 4)])];
		expect(kinds({ tracked, rows, runs: unitRun(reports) })).toEqual(["duplicate 5"]);
	});

	it("checks only the rows of the tiers that ran and, in a filtered run, the packages selected", () => {
		const selected = (file: string) => file.startsWith("pkgs/mixed/");
		const reports = [report("pkgs/mixed", [counts(rows[4]?.file ?? "", 4)])];
		expect(kinds({ tracked, rows, runs: unitRun(reports), selected, filtered: true })).toEqual([]);
		const heavy = new Map([["heavy", { code: 0, reports: [] }]] as const);
		expect(kinds({ tracked, rows, runs: heavy })).toEqual(["not-run 3"]);
	});

	it("fails a run without --within or --filter that leaves a row of a tier it ran unchecked", () => {
		const selected = (file: string) => file.startsWith("pkgs/mixed/");
		const reports = [report("pkgs/mixed", [counts(rows[4]?.file ?? "", 4)])];
		same(check({ tracked, rows, runs: unitRun(reports), selected }), [
			{ kind: "unchecked", tier: "unit", count: 2 },
		]);
		expect(kinds({ tracked, rows, runs: unitRun(reports), selected, filtered: false })).toEqual([
			"unchecked",
		]);
		// The heavy and live rows belong to tiers this run didn't run.
		expect(kinds({ tracked, rows, runs: unitRun() })).toEqual([]);
	});

	it("fails a --complete run that leaves a row of a tier it ran unchecked, even with --within or --filter", () => {
		const selected = (file: string) => file.startsWith("pkgs/mixed/");
		const reports = [report("pkgs/mixed", [counts(rows[4]?.file ?? "", 4)])];
		const narrowed = { tracked, rows, runs: unitRun(reports), selected, filtered: true };
		same(check({ ...narrowed, complete: true }), [{ kind: "incomplete", tier: "unit", count: 2 }]);
		// Without --complete the same narrowed run passes, as before.
		expect(kinds(narrowed)).toEqual([]);
		// Unfiltered, the rows already fail the run; --complete adds nothing.
		expect(kinds({ ...narrowed, filtered: false, complete: true })).toEqual(["unchecked"]);
		// Every row of the tier checked.
		expect(kinds({ tracked, rows, runs: unitRun(), filtered: true, complete: true })).toEqual([]);
	});

	it("words every problem without a file name unless --names asks", () => {
		const files = [`${only}/test/a.test.ts`];
		for (const kind of ["missing-row", "no-package"] as const) {
			expect(reservedWord.test(describeProblem({ kind, files }))).toBe(false);
			expect(reservedWord.test(describeProblem({ kind, files }, true))).toBe(true);
		}
	});

	it("words the typecheck, wiring and coverage problems as the contract pins them", () => {
		expect(
			[
				{ kind: "no-mark", count: 1 },
				{ kind: "no-typecheck-script", count: 2 },
				{ kind: "wiring", scripts: 3, configs: 4 },
				{ kind: "unchecked", tier: "unit", count: 5 },
				{ kind: "incomplete", tier: "heavy", count: 6 },
				{ kind: "none-selected", tier: "heavy" },
			].map((problem) => describeProblem(problem as Parameters<typeof describeProblem>[0])),
		).toEqual([
			"unit: 1 reserved-only package(s) wrote no typecheck mark with exit 0",
			"unit: 2 reserved-only package(s) have no typecheck script",
			"unit: reserved-only packages: 3 script(s) don't start with node <kit>/run.ts or are install, prepare or pre/post scripts, 4 Vitest config(s) import more than the kit's off.ts up front",
			"unit: 5 inventory row(s) of the tier went unchecked in a run without --within or --filter",
			"heavy: 6 inventory row(s) of the tier went unchecked in a --complete run",
			"heavy: a --complete run selected no package holding reserved files",
		]);
	});

	it("answers for every reserved file but docs, through the package that holds it", () => {
		const files = [
			...tracked,
			"packages/protocol/package.json",
			`packages/protocol/scripts/x-${word}/gen.ts`,
			`spec/vectors/x-${word}/a.json`,
			`spec/x-${word}.md`,
			`crates/p/src/x_${word}.rs`,
			`loose/x-${word}.json`,
		];
		const { owned, unowned } = reservedOwners(files);
		same(
			[...owned].toSorted(),
			[
				[`packages/protocol/scripts/x-${word}/gen.ts`, "packages/protocol"],
				[`${only}/package.json`, only],
				[`${only}/test/a.test.ts`, only],
				[`${only}/test/b.test.ts`, only],
				[`${only}/test/c.heavy.test.ts`, only],
				[`${only}/test/d.live.test.ts`, only],
				[`${only}/test/helper.ts`, only],
				[`pkgs/mixed/test/x-${word}.test.ts`, "pkgs/mixed"],
			].toSorted(),
		);
		// Reserved data outside every package and reserved Rust have no package to run them.
		same(unowned, [
			`spec/vectors/x-${word}/a.json`,
			`crates/p/src/x_${word}.rs`,
			`loose/x-${word}.json`,
		]);
	});

	it("needs a reserved-only package's scripts to start through the kit and its config to import only off.ts up front", () => {
		const dir = `spikes/${word}-only`;
		const texts: Record<string, string> = {
			[`${dir}/package.json`]: JSON.stringify({
				scripts: {
					test: "node ../kit/run.ts",
					"test:heavy": "node ../kit/run.ts --heavy",
					typecheck: "node ../kit/run.ts --typecheck",
				},
			}),
			[`${dir}/vitest.config.ts`]:
				'import type { ConfigEnv } from "vitest/config";\nimport { reservedOffConfig, reservedSpikeOff } from "../kit/off.ts";\nexport default async (env: ConfigEnv) => reservedSpikeOff(import.meta.dirname) ? reservedOffConfig() : (await import("@draftyak/spike-kit/vitest")).spikeVitestConfig(env);\n',
		};
		const files = Object.keys(texts);
		same(
			wiring([dir], files, (file) => texts[file]),
			{ scripts: 0, configs: 0 },
		);
		texts[`${dir}/package.json`] = JSON.stringify({
			scripts: { test: "node ../kit/run.ts", typecheck: "tsc -b", lint: "node ../kit/run.tsx" },
		});
		texts[`${dir}/vitest.config.ts`] =
			'import { spikeVitestConfig } from "@draftyak/spike-kit/vitest";\nexport default (env) => spikeVitestConfig(env);\n';
		same(
			wiring([dir], files, (file) => texts[file]),
			{ scripts: 2, configs: 1 },
		);
	});

	it("counts install, prepare, pre/post and pnpm: scripts, even through the kit", () => {
		const dir = `spikes/${word}-only`;
		const kit = "node ../kit/run.ts";
		const scripts = (more: Record<string, string>): number =>
			wiring([dir], [], () => JSON.stringify({ scripts: { test: kit, ...more } })).scripts;
		const plain = {
			"test:heavy": `${kit} --heavy`,
			"test:live": `${kit} --live`,
			"test:device": `${kit} --device`,
			typecheck: `${kit} --typecheck`,
		};
		expect(scripts(plain)).toBe(0);
		for (const key of [
			"preinstall",
			"install",
			"postinstall",
			"preprepare",
			"prepare",
			"postprepare",
			"dependencies",
			"pretest",
			"posttest",
			"pnpm:devPreinstall",
		]) {
			expect([key, scripts({ ...plain, [key]: kit })]).toEqual([key, 1]);
		}
	});

	it("counts a script that runs on past the kit's own arguments, and a manifest it can't read", () => {
		const dir = `spikes/${word}-only`;
		const count = (text: string | undefined): number => wiring([dir], [], () => text).scripts;
		const manifest = (test: unknown): string => JSON.stringify({ scripts: { test } });
		for (const value of [
			"node ../kit/run.ts",
			"node ../kit/run.ts --heavy",
			"node ../kit/run.ts --typecheck",
		]) {
			expect([value, count(manifest(value))]).toEqual([value, 0]);
		}
		for (const value of [
			"node ../kit/run.tsx",
			"node ../kit/run.ts;x",
			"node ../kit/run.ts\nx",
			"node ../kit/run.ts\tx",
			" node ../kit/run.ts",
			"node ./run.ts",
			1,
			null,
		]) {
			expect([value, count(manifest(value))]).toEqual([value, 1]);
		}
		expect(count(JSON.stringify({}))).toBe(0);
		for (const text of [
			undefined,
			"{",
			"[]",
			JSON.stringify({ scripts: ["x"] }),
			'{"scripts":"x"}',
		]) {
			expect([text, count(text)]).toEqual([text, 1]);
		}
	});

	it("counts a config that loads anything but off.ts up front, however it loads it", () => {
		const dir = `spikes/${word}-only`;
		const config = `${dir}/vitest.config.ts`;
		const configs = (text: string): number =>
			wiring([dir], [config], (file) => (file === config ? text : JSON.stringify({ scripts: {} })))
				.configs;
		const off = 'import { reservedSpikeOff } from "../kit/off.ts";\n';
		expect(
			configs(
				`${off}import type { ConfigEnv } from "vitest/config";\nimport { createRequire } from "node:module";\nexport default async (env: ConfigEnv) => (await import("@draftyak/spike-kit/vitest")).x(env);\n`,
			),
		).toBe(0);
		for (const load of [
			'import "./setup.ts";',
			'import { x } from "../kit/vitest.ts";',
			'export * from "./other.ts";',
			'const x = require("./other.cjs");',
			'import { createRequire } from "node:module";\nconst x = createRequire(import.meta.url)("./other.cjs");',
		]) {
			expect([load, configs(`${off}${load}\n`)]).toEqual([load, 1]);
		}
	});

	it("lints and format-checks reserved files under biome.json without its reserved negations", () => {
		const config = JSON.stringify({
			$schema: "x",
			files: { includes: ["**", "!**/fixtures", ...biomeNegations] },
			formatter: { lineWidth: 100 },
		});
		same(JSON.parse(reservedBiomeConfig(config)), {
			files: { includes: ["**", "!**/fixtures"] },
			formatter: { lineWidth: 100 },
		});
		const args = biomeArgs("C:/tmp/b", ["a.ts"]);
		same(args.slice(0, 2), ["ci", "--config-path=C:/tmp/b"]);
		expect(args.at(-1)).toBe("a.ts");
	});
});

describe("the proof's main", () => {
	const scratch = mkdtempSync(path.join(tmpdir(), "draftyak-proof-"));
	afterAll(() => rmSync(scratch, { recursive: true, force: true }));
	const kit = `node ${path.posix.relative(only, KIT_RUN)}`;
	const manifests: Readonly<Record<string, unknown>> = {
		[only]: {
			scripts: { test: kit, "test:heavy": `${kit} --heavy`, typecheck: `${kit} --typecheck` },
		},
		"pkgs/mixed": { scripts: { test: "vitest run" } },
	};
	// A checkout folder holding the inventory and the packages' manifests (undefined: none).
	function checkout(
		inventory: unknown = { files: rows },
		more: Readonly<Record<string, unknown>> = {},
	): string {
		const at = mkdtempSync(path.join(scratch, "root-"));
		const write = (file: string, text: string): void => {
			mkdirSync(path.dirname(path.join(at, file)), { recursive: true });
			writeFileSync(path.join(at, file), text);
		};
		write(INVENTORY, JSON.stringify(inventory));
		for (const [dir, manifest] of Object.entries({ ...manifests, ...more })) {
			if (manifest !== undefined) write(`${dir}/package.json`, JSON.stringify(manifest));
		}
		return at;
	}
	const root = checkout();

	// The gate's check line (reserved-tripwire.ts's checkLine), as the gate prints it on a pass.
	const checkLine =
		"reserved check: 10 path(s), 0 untracked file(s), 4 folder(s), 0 Cargo file(s), 0 Rust source(s) and 2 module(s) and config(s) checked, with their folders, references and scanned folders; no problem found in them";
	const stopped = "reserved proof: not proven: the reserved check stopped it before any run";
	const ownMarks = (packages: readonly string[]): object[] =>
		packages.map((dir) => ({ version: 1, package: dir, code: 0 }));

	interface Call {
		readonly args: readonly string[];
		readonly env: NodeJS.ProcessEnv;
	}
	interface Stubs {
		readonly write?: (call: Call) => readonly CountsReport[];
		readonly code?: number;
		readonly files?: readonly string[];
		readonly typecheck?: number;
		// The marks each reserved-only package's kit writes: objects as JSON, strings as they are.
		readonly marks?: (packages: readonly string[]) => readonly (object | string)[];
		// Marks already in the marks folder before the typecheck call.
		readonly seed?: readonly object[];
		readonly dry?: string;
		readonly biome?: number;
		readonly root?: string;
		readonly gate?: Deps["gate"];
	}
	function deps(env: NodeJS.ProcessEnv, stubs: Stubs = {}) {
		const lines: string[] = [];
		const calls: Call[] = [];
		// Every dependency call, in order.
		const order: string[] = [];
		const linted: { args: readonly string[]; config: string }[] = [];
		const folders: string[] = [];
		const value: Deps = {
			root: stubs.root ?? root,
			env,
			print: (line) => lines.push(...line.split("\n")),
			async gate() {
				order.push("gate");
				return stubs.gate ? stubs.gate() : { ok: true, lines: [checkLine] };
			},
			async tracked() {
				order.push("tracked");
				return stubs.files ?? tracked;
			},
			async turbo(args, childEnv) {
				order.push("turbo");
				const call = { args, env: childEnv };
				calls.push(call);
				if (args[1] === "typecheck") {
					const dir = String(childEnv[TYPECHECK_MARKS]);
					const packages = args
						.filter((arg) => arg.startsWith("--filter=./"))
						.map((arg) => arg.slice("--filter=./".length));
					for (const [index, mark] of (stubs.marks ?? ownMarks)(packages).entries()) {
						const text = typeof mark === "string" ? mark : JSON.stringify(mark);
						writeFileSync(path.join(dir, `typecheck-${index}.json`), text);
					}
					return stubs.typecheck ?? 0;
				}
				const dir = String(childEnv.DRAFTYAK_TEST_COUNTS_DIR);
				for (const [index, written] of (stubs.write ?? unitReports)(call).entries()) {
					writeFileSync(path.join(dir, `r${index}.json`), JSON.stringify(written));
				}
				return stubs.code ?? 0;
			},
			async turboDry(args) {
				order.push("turboDry");
				calls.push({ args, env: {} });
				return stubs.dry ?? '{"tasks":[]}';
			},
			async biome(args) {
				order.push("biome");
				const at = String(args.find((arg) => arg.startsWith("--config-path=")) ?? "").slice(14);
				linted.push({ args, config: readFileSync(path.join(at, "biome.json"), "utf8") });
				return { code: stubs.biome ?? 0, output: `x-${word} lint output` };
			},
			marksDir() {
				order.push("marksDir");
				const dir = mkdtempSync(path.join(scratch, "marks-"));
				for (const [index, mark] of (stubs.seed ?? []).entries()) {
					writeFileSync(path.join(dir, `earlier-${index}.json`), JSON.stringify(mark));
				}
				folders.push(dir);
				return dir;
			},
		};
		const runs = () =>
			calls.filter(
				(call) =>
					(call.args[1] === "test" || call.args[1] === "test:heavy") &&
					!call.args.includes("--dry=json"),
			);
		return { value, lines, calls, order, runs, linted, folders };
	}
	const on = { [RESERVED_TESTS]: "1", PATH: "x" };

	it("typechecks reserved-only packages, runs the unit tier of each package holding reserved unit files opted in, then proves it", async () => {
		const { value, lines, calls, runs, folders } = deps(on);
		expect(await main(["--tier", "unit"], value)).toBe(0);
		same(calls[0]?.args, [
			...["run", "typecheck", "build", `--filter=./${only}`, "--force", "--output-logs=none"],
			"--continue=dependencies-successful",
		]);
		same(
			runs().map(({ args }) => args),
			[
				[
					...["run", "test", "--filter=./pkgs/mixed", `--filter=./${only}`, "--force"],
					...["--output-logs=none", "--continue=dependencies-successful", "--", "--silent"],
				],
			],
		);
		expect(runs()[0]?.env[RESERVED_TESTS]).toBe("1");
		expect(path.isAbsolute(String(runs()[0]?.env.DRAFTYAK_TEST_COUNTS_DIR))).toBe(true);
		expect([folders.length, calls[0]?.env[TYPECHECK_MARKS] === folders[0]]).toEqual([1, true]);
		same(lines[0], checkLine);
		same(lines.at(-1), "reserved proof: proven: unit 3/3; typecheck marks 1/1");
		expect(PROVEN.test(lines.at(-1) ?? "")).toBe(true);
		same(finals(lines), [lines.at(-1)]);
		expect(named(lines)).toBe(0);
	});

	it("gives the marks folder to the typecheck call alone, whatever the caller's env held", async () => {
		const held = {
			...on,
			[TYPECHECK_MARKS]: path.join(scratch, "held"),
			draftyak_typecheck_marks: "x",
		};
		const { value, calls, runs, folders } = deps(held);
		expect(await main(["--tier", "unit"], value)).toBe(0);
		expect([calls[0]?.args[1], calls[0]?.env[TYPECHECK_MARKS] === folders[0]]).toEqual([
			"typecheck",
			true,
		]);
		expect(calls[0]?.env.draftyak_typecheck_marks).toBeUndefined();
		expect(runs().map(({ env }) => [env[TYPECHECK_MARKS], env.draftyak_typecheck_marks])).toEqual([
			[undefined, undefined],
		]);
	});

	it("fails unless each reserved-only package wrote exactly one typecheck mark, with exit 0", async () => {
		const problem =
			"reserved proof: problem: unit: 1 reserved-only package(s) wrote no typecheck mark with exit 0";
		const cases: [string, NonNullable<Stubs["marks"]>][] = [
			["no mark", () => []],
			[
				"a failing tsc",
				(packages) => packages.map((dir) => ({ version: 1, package: dir, code: 2 })),
			],
			["two runs", (packages) => [...ownMarks(packages), ...ownMarks(packages)]],
			["another package's mark", () => [{ version: 1, package: "pkgs/mixed", code: 0 }]],
			["an unreadable mark beside it", (packages) => [...ownMarks(packages), "{"]],
			[
				"another version",
				(packages) => packages.map((dir) => ({ version: 2, package: dir, code: 0 })),
			],
		];
		for (const [label, marks] of cases) {
			const { value, lines } = deps(on, { marks });
			expect([label, await main(["--tier", "unit"], value)]).toEqual([label, 1]);
			expect([label, lines.filter((line) => line === problem).length]).toEqual([label, 1]);
			expect([label, lines.at(-1)]).toEqual([label, "reserved proof: not proven: 1 problem(s)"]);
		}
	});

	it("counts no mark from a marks folder that held something before the typecheck call", async () => {
		const seed = [{ version: 1, package: only, code: 0 }];
		const earlier = deps(on, { seed, marks: () => [] });
		expect(await main(["--tier", "unit"], earlier.value)).toBe(1);
		same(
			earlier.lines.at(-2),
			"reserved proof: problem: unit: 1 reserved-only package(s) wrote no typecheck mark with exit 0",
		);
		const empty = deps(on, { seed: [], marks: ownMarks });
		expect(await main(["--tier", "unit"], empty.value)).toBe(0);
	});

	it("fails a reserved-only package without a typecheck script", async () => {
		const at = checkout(undefined, {
			[only]: { scripts: { test: kit, "test:heavy": `${kit} --heavy` } },
		});
		const { value, lines } = deps(on, { root: at, marks: () => [] });
		expect(await main(["--tier", "unit"], value)).toBe(1);
		const problem =
			"reserved proof: problem: unit: 1 reserved-only package(s) have no typecheck script";
		expect(lines.filter((line) => line === problem)).toHaveLength(1);
	});

	it("fails when the reserved-only packages' typecheck or build fails", async () => {
		const { value, lines } = deps(on, { typecheck: 2 });
		expect(await main(["--tier", "unit"], value)).toBe(1);
		expect(
			lines.some((line) =>
				line.includes("typecheck and build of the reserved-only packages exited 2"),
			),
		).toBe(true);
	});

	it("names files, and lets turbo print a failing task's log, only when --names asks", async () => {
		const { value, lines, calls, runs } = deps(on);
		expect(await main(["--tier", "unit", "--names"], value)).toBe(0);
		expect(named(lines)).toBe(3);
		same(calls[0]?.args.slice(4), [
			...["--force", "--output-logs=errors-only", "--log-prefix=task"],
			"--continue=dependencies-successful",
		]);
		same(runs()[0]?.args.slice(4), [
			...["--force", "--output-logs=errors-only", "--log-prefix=task"],
			...["--continue=dependencies-successful", "--", "--silent"],
		]);
	});

	it("runs turbo forced and serial for heavy, with no task output unless --names asks", () => {
		expect(tierArgs("unit", ["pkgs/a", "pkgs/b"], false)).toEqual([
			...["run", "test", "--filter=./pkgs/a", "--filter=./pkgs/b", "--force", "--output-logs=none"],
			...["--continue=dependencies-successful", "--", "--silent"],
		]);
		expect(tierArgs("heavy", ["pkgs/a"], false)).toEqual([
			...["run", "test:heavy", "--filter=./pkgs/a", "--force", "--output-logs=none"],
			...["--continue=dependencies-successful", "--concurrency=1", "--", "--silent"],
		]);
		expect(tierArgs("heavy", ["pkgs/a"], true)).toEqual([
			...["run", "test:heavy", "--filter=./pkgs/a", "--force", "--output-logs=errors-only"],
			...["--log-prefix=task", "--continue=dependencies-successful", "--concurrency=1"],
			...["--", "--silent"],
		]);
		expect(typecheckArgs(["pkgs/a"], false)).toEqual([
			...["run", "typecheck", "build", "--filter=./pkgs/a", "--force", "--output-logs=none"],
			"--continue=dependencies-successful",
		]);
		expect(typecheckArgs(["pkgs/a", "pkgs/b"], true)).toEqual([
			...["run", "typecheck", "build", "--filter=./pkgs/a", "--filter=./pkgs/b", "--force"],
			...["--output-logs=errors-only", "--log-prefix=task", "--continue=dependencies-successful"],
		]);
	});

	it("checks the gate's result once, before any other call, and stops on a failed one", async () => {
		const g1 =
			"reserved tripwire: 1 path(s) name a reserved word outside the allowed reserved roots, or spell it in upper case";
		const stop = START_STOP_LINE;
		const failed = deps(on, { gate: async () => ({ ok: false, lines: [g1, stop] }) });
		expect(await main(["--tier", "unit", "--tier", "heavy"], failed.value)).toBe(1);
		expect([failed.order, failed.calls.length, failed.folders.length]).toEqual([["gate"], 0, 0]);
		same(failed.lines, [g1, stop, stopped]);
		same(finals(failed.lines), [stopped]);
		const passed = deps(on);
		expect(await main(["--tier", "unit"], passed.value)).toBe(0);
		expect(passed.order.slice(0, 2)).toEqual(["gate", "tracked"]);
		expect(passed.order.filter((name) => name === "gate")).toEqual(["gate"]);
	});

	it("stops on a gate that throws, or that answers anything but ok", async () => {
		const answers = [
			async () => {
				throw new Error("gate");
			},
			async () => ({ ok: "yes", lines: [] }),
			async () => ({ lines: [] }),
		] as unknown as Deps["gate"][];
		for (const gate of answers) {
			const { value, order, lines } = deps(on, { gate });
			expect(await main(["--tier", "unit"], value)).toBe(1);
			expect(order).toEqual(["gate"]);
			same(lines, [stopped]);
		}
	});

	it("reads its arguments and the flag before it consults the gate", async () => {
		const cases: [string[], NodeJS.ProcessEnv, number][] = [
			[["--tier", "unit"], {}, 1],
			[["--tier", "unit"], { [RESERVED_TESTS]: "true" }, 1],
			[["--tier", "x"], on, 2],
			[["--tier", "live"], on, 2],
			[["--bogus"], on, 2],
			[["--tier", "unit", "--within", "pkgs", "--filter", "x"], on, 2],
		];
		for (const [argv, env, code] of cases) {
			const { value, order } = deps(env, { gate: async () => ({ ok: false, lines: [] }) });
			expect([argv, await main(argv, value), order]).toEqual([argv, code, []]);
		}
	});

	it("refuses the live and device tiers and an unknown or missing tier", async () => {
		const owner = "reserved proof: live and device tiers run only in owner sessions, never here";
		for (const argv of [
			["--tier", "live"],
			["--tier", "device"],
			["--tier", "unit", "--tier", "live"],
		]) {
			const { value, calls, lines } = deps(on);
			expect(await main(argv, value)).toBe(2);
			expect([calls.length, lines]).toEqual([0, [owner]]);
		}
		for (const argv of [["--tier", "x"], []]) {
			const { value, calls } = deps(on);
			expect(await main(argv, value)).toBe(2);
			expect(calls.length).toBe(0);
		}
	});

	it("ignores counts from runs rooted elsewhere, such as a test's own child Vitest", async () => {
		const stray = report("C:/elsewhere", [counts(rows[0]?.file ?? "", 99)], { reason: "failed" });
		const { value } = deps(on, { write: () => [...unitReports(), stray] });
		expect(await main(["--tier", "unit"], value)).toBe(0);
	});

	it("fails when the tier run exits non-zero, or writes nothing", async () => {
		expect(await main(["--tier", "unit"], deps(on, { code: 1 }).value)).toBe(1);
		expect(await main(["--tier", "unit"], deps(on, { write: () => [] }).value)).toBe(1);
	});

	it("prints a tier without inventory rows as 0/0, never a proven line without counts", async () => {
		// No reserved unit test file and no unit row: the reserved-only package still typechecks.
		const files = tracked.filter((file) => testTier(file) !== "unit" || !reservedWord.test(file));
		const heavyAndLive = rows.filter((row) => row.tier !== "unit");
		const unitless = deps(on, {
			files,
			root: checkout({ files: heavyAndLive }),
			write: () => [report(only, [])],
		});
		expect(await main(["--tier", "unit"], unitless.value)).toBe(0);
		same(unitless.lines.at(-1), "reserved proof: proven: unit 0/0; typecheck marks 1/1");
		expect(PROVEN.test(unitless.lines.at(-1) ?? "")).toBe(true);
		// No heavy test file and no heavy row: the heavy tier still runs and is counted.
		const heavyless = deps(on, {
			files: tracked.filter((file) => !file.endsWith(".heavy.test.ts")),
			root: checkout({ files: rows.filter((row) => row.tier !== "heavy") }),
			write: (call) =>
				call.args[1] === "test" ? unitReports() : [report(only, [], { tier: "heavy" })],
		});
		expect(await main(["--tier", "heavy", "--tier", "unit"], heavyless.value)).toBe(0);
		same(
			heavyless.lines.at(-1),
			"reserved proof: proven: unit 3/3, heavy 0/0; typecheck marks 1/1",
		);
		expect(PROVEN.test(heavyless.lines.at(-1) ?? "")).toBe(true);
		same(finals(heavyless.lines), [heavyless.lines.at(-1)]);
	});

	it("proves the unit tier with the heavy tier, and never proves without the unit tier", async () => {
		const both = deps(on, {
			write: (call) => (call.args[1] === "test" ? unitReports() : heavyReports()),
		});
		expect(await main(["--tier", "unit", "--tier", "heavy"], both.value)).toBe(0);
		same(both.lines.at(-1), "reserved proof: proven: unit 3/3, heavy 1/1; typecheck marks 1/1");
		expect(PROVEN.test(both.lines.at(-1) ?? "")).toBe(true);
		const heavy = deps(on, { write: heavyReports });
		expect(await main(["--tier", "heavy"], heavy.value)).toBe(0);
		same(heavy.lines.at(-1), "reserved proof: partial: heavy 1/1");
	});

	it("runs only the packages under --within, read without a leading ./, and prints partial", async () => {
		const { value, runs, lines } = deps(on, { write: () => unitReports().slice(1) });
		expect(await main(["--tier", "unit", "--within", "./pkgs/mixed/"], value)).toBe(0);
		same(
			runs().map(({ args }) => args),
			[tierArgs("unit", ["pkgs/mixed"], false)],
		);
		same(lines.at(-1), "reserved proof: partial: unit 1/3; typecheck marks 0/0");
		same(finals(lines), [lines.at(-1)]);
		// A --within that takes in every package still checks only what it selected: never proven.
		const all = deps(on);
		expect(await main(["--tier", "unit", "--within", "pkgs"], all.value)).toBe(0);
		same(all.lines.at(-1), "reserved proof: partial: unit 3/3; typecheck marks 1/1");
	});

	it("refuses a --within value that names no tracked file or folder, case included", async () => {
		for (const within of ["pkgs/other", "Pkgs/mixed", "pkgs/mix", ""]) {
			const { value, calls, lines } = deps(on);
			expect(await main(["--tier", "unit", "--within", within], value)).toBe(2);
			expect(calls.length).toBe(0);
			expect(named(lines)).toBe(0);
		}
	});

	it("proves the packages a turbo filter selects, as turbo's dry run resolves them, as partial", async () => {
		const dry = JSON.stringify({
			tasks: [
				{ task: "test:heavy", directory: only.replaceAll("/", "\\") },
				{ task: "build", directory: "pkgs\\mixed" },
			],
		});
		const { value, calls, runs, lines } = deps(on, { write: heavyReports, dry });
		expect(await main(["--tier", "heavy", "--filter", "...{./pkgs/mixed}"], value)).toBe(0);
		same(calls[0]?.args, ["run", "test:heavy", "--filter=...{./pkgs/mixed}", "--dry=json"]);
		same(
			runs().map(({ args }) => args),
			[tierArgs("heavy", [only], false)],
		);
		same(filteredDirs(dry, "test:heavy"), new Set([only]));
		same(lines.at(-1), "reserved proof: partial: heavy 1/1");
		const none = deps(on, { write: heavyReports, dry: '{"tasks":[]}' });
		expect(await main(["--tier", "heavy", "--filter", "./pkgs/mixed"], none.value)).toBe(0);
		expect(none.runs().length).toBe(0);
		same(none.lines.at(-1), "reserved proof: partial: heavy 0/1");
		const both = deps(on);
		expect(await main(["--tier", "heavy", "--filter", "x", "--within", "pkgs"], both.value)).toBe(
			2,
		);
	});

	// A turbo dry run whose test:heavy tasks sit in `dirs`.
	const heavyDry = (dirs: readonly string[]): string =>
		JSON.stringify({ tasks: dirs.map((directory) => ({ task: "test:heavy", directory })) });
	const bothTiers = (call: Call): readonly CountsReport[] =>
		call.args[1] === "test" ? unitReports() : heavyReports();

	it("never proves a narrowed run: --within, --filter and a run that selects nothing are partial", async () => {
		const cases: [string[], Stubs, string][] = [
			[
				["--tier", "unit", "--within", "pkgs/mixed"],
				{ write: () => unitReports().slice(1) },
				"reserved proof: partial: unit 1/3; typecheck marks 0/0",
			],
			[
				["--tier", "unit", "--within", "pkgs"],
				{},
				"reserved proof: partial: unit 3/3; typecheck marks 1/1",
			],
			[
				["--tier", "unit", "--within", "package.json"],
				{},
				"reserved proof: partial: unit 0/3; typecheck marks 0/0",
			],
			[
				["--tier", "heavy", "--filter", "./pkgs/*"],
				{ write: heavyReports, dry: heavyDry([only]) },
				"reserved proof: partial: heavy 1/1",
			],
			[
				["--tier", "unit", "--tier", "heavy", "--filter", "./pkgs/mixed"],
				{ write: bothTiers, dry: heavyDry([]) },
				"reserved proof: partial: unit 0/3, heavy 0/1; typecheck marks 0/0",
			],
		];
		for (const [argv, stubs, last] of cases) {
			const { value, lines } = deps(on, stubs);
			expect([argv, await main(argv, value)]).toEqual([argv, 0]);
			expect([argv, lines.at(-1)]).toEqual([argv, last]);
			expect([argv, lines.filter((line) => /proven:/.test(line))]).toEqual([argv, []]);
			same(finals(lines), [last]);
		}
	});

	it("fails a narrowed --complete run that leaves a row of its tiers unchecked or selects no package", async () => {
		const unchecked = (tier: string, count: number): string =>
			`reserved proof: problem: ${tier}: ${count} inventory row(s) of the tier went unchecked in a --complete run`;
		const none = (tier: string): string =>
			`reserved proof: problem: ${tier}: a --complete run selected no package holding reserved files`;
		const cases: [string[], Stubs, string[]][] = [
			[
				["--tier", "unit", "--within", "pkgs/mixed", "--complete"],
				{ write: () => unitReports().slice(1) },
				[unchecked("unit", 2)],
			],
			[
				["--tier", "unit", "--within", "package.json", "--complete"],
				{},
				[none("unit"), unchecked("unit", 3)],
			],
			[
				["--tier", "heavy", "--filter", "./pkgs/mixed", "--complete"],
				{ write: heavyReports, dry: heavyDry([]) },
				[none("heavy"), unchecked("heavy", 1)],
			],
		];
		for (const [argv, stubs, problems] of cases) {
			const { value, lines } = deps(on, stubs);
			expect([argv, await main(argv, value)]).toEqual([argv, 1]);
			expect([argv, lines.filter((line) => line.includes(" problem: "))]).toEqual([argv, problems]);
			const last = `reserved proof: not proven: ${problems.length} problem(s)`;
			same(finals(lines), [last]);
		}
	});

	it("pins the three verdicts: proven needs an unfiltered unit run, complete a --complete run that checked every row", async () => {
		const cases: [string[], Stubs, string][] = [
			[["--tier", "unit"], {}, "reserved proof: proven: unit 3/3; typecheck marks 1/1"],
			[
				["--tier", "unit", "--complete"],
				{},
				"reserved proof: proven: unit 3/3; typecheck marks 1/1",
			],
			[
				["--tier", "unit", "--tier", "heavy", "--complete"],
				{ write: bothTiers },
				"reserved proof: proven: unit 3/3, heavy 1/1; typecheck marks 1/1",
			],
			[["--tier", "heavy"], { write: heavyReports }, "reserved proof: partial: heavy 1/1"],
			[
				["--tier", "heavy", "--complete"],
				{ write: heavyReports },
				"reserved proof: complete: heavy 1/1",
			],
			[
				["--tier", "unit", "--within", "pkgs", "--complete"],
				{},
				"reserved proof: complete: unit 3/3; typecheck marks 1/1",
			],
			[
				["--tier", "heavy", "--filter", "./pkgs/*", "--complete"],
				{ write: heavyReports, dry: heavyDry([only]) },
				"reserved proof: complete: heavy 1/1",
			],
		];
		for (const [argv, stubs, last] of cases) {
			const { value, lines } = deps(on, stubs);
			expect([argv, await main(argv, value)]).toEqual([argv, 0]);
			expect([argv, lines.at(-1)]).toEqual([argv, last]);
			same(finals(lines), [last]);
			// Only a proven line is the one the tools accept.
			expect([argv, PROVEN.test(last)]).toEqual([argv, last.includes(" proven: ")]);
		}
	});

	it("fails on a reserved file, test or not, that no workspace package holds", async () => {
		for (const loose of [`loose/x-${word}.test.ts`, `loose/x-${word}.json`]) {
			const files = [...tracked, loose];
			const inventory = {
				files: [
					...rows,
					...(loose.endsWith(".test.ts") ? [{ file: loose, tier: "unit", minPassed: 1 }] : []),
				],
			};
			const { value, lines } = deps(on, { files, root: checkout(inventory) });
			expect(await main(["--tier", "unit"], value)).toBe(1);
			expect(lines.filter((line) => line.includes("sit in no workspace package"))).toHaveLength(1);
			expect(named(lines)).toBe(0);
		}
	});

	it("fails on an inventory with a rust key, or with any key but about and files", async () => {
		for (const [inventory, detail] of [
			[{ about: "x", files: rows, rust: [] }, 'has a "rust" key; the proof runs no Rust rows'],
			[{ files: rows, notes: "x" }, 'has keys other than "about" and "files"'],
		] as const) {
			const { value, lines } = deps(on, { root: checkout(inventory) });
			expect(await main(["--tier", "unit"], value)).toBe(1);
			const problem = `reserved proof: problem: ${INVENTORY}: ${detail}`;
			expect(lines.filter((line) => line === problem)).toHaveLength(1);
			same(finals(lines), [lines.at(-1)]);
		}
	});

	it("runs opted in every package holding reserved files, test files or not, and fails one that never ran", async () => {
		const files = [
			...tracked,
			"packages/protocol/package.json",
			`packages/protocol/vectors/x-${word}/a.json`,
			"pkgs/data/package.json",
			`pkgs/data/vectors/x-${word}.json`,
		];
		const at = checkout(undefined, {
			"packages/protocol": { scripts: { test: "vitest run" } },
			"pkgs/data": { scripts: { test: "vitest run" } },
		});
		const reports = () => [
			...unitReports(),
			report("packages/protocol", [counts("packages/protocol/test/v.test.ts", 5)]),
			report("pkgs/data", [counts("pkgs/data/test/v.test.ts", 2)]),
		];
		const ran = deps(on, { write: reports, files, root: at });
		expect(await main(["--tier", "unit"], ran.value)).toBe(0);
		same(
			ran.runs().map(({ args }) => args),
			[tierArgs("unit", ["packages/protocol", "pkgs/data", "pkgs/mixed", only], false)],
		);
		// A package whose suites never wrote counts never ran opted in.
		const silent = deps(on, { write: () => reports().slice(0, 3), files, root: at });
		expect(await main(["--tier", "unit"], silent.value)).toBe(1);
		expect(
			silent.lines.filter((line) =>
				line.includes("1 package(s) holding reserved files wrote no counts"),
			),
		).toHaveLength(1);
	});

	it("checks reserved-only packages' wiring, and lints their files with the reserved negations dropped", async () => {
		const at = checkout(undefined, { [only]: { scripts: { typecheck: "tsc -b" } } });
		writeFileSync(
			path.join(at, "biome.json"),
			JSON.stringify({ files: { includes: ["**", ...biomeNegations] } }),
		);
		const { value, lines, linted } = deps(on, { root: at, biome: 1 });
		expect(await main(["--tier", "unit"], value)).toBe(1);
		expect(linted.length).toBe(1);
		expect(biomeNegations.some((glob) => linted[0]?.config.includes(glob))).toBe(false);
		// The reserved files of the packages under proof, the docs-free ones.
		expect(linted[0]?.args.filter((arg) => reservedWord.test(arg)).length).toBe(7);
		const problems = lines.filter((line) => line.includes("problem:"));
		expect(
			problems.some((line) =>
				line.includes(
					"1 script(s) don't start with node <kit>/run.ts or are install, prepare or pre/post scripts",
				),
			),
		).toBe(true);
		expect(
			problems.some((line) =>
				line.includes("lint and format check of the reserved files exited 1"),
			),
		).toBe(true);
		// Biome's code frames name no path, so its output is printed only with --names.
		expect(named(lines)).toBe(0);
		const names = deps(on, { root: at, biome: 1 });
		expect(await main(["--tier", "unit", "--names"], names.value)).toBe(1);
		expect(names.lines.some((line) => line.includes("lint output"))).toBe(true);
	});

	it("removes the marks, lint config and counts folders it made once read, also when a tool throws", async () => {
		const at = checkout();
		writeFileSync(path.join(at, "biome.json"), JSON.stringify({ files: { includes: ["**"] } }));
		const configOf = (args: readonly string[]): string =>
			String(args.find((arg) => arg.startsWith("--config-path=")) ?? "").slice(14);
		const write = (call: Call): readonly CountsReport[] =>
			call.args[1] === "test" ? unitReports() : heavyReports();
		const both = deps(on, { root: at, write });
		expect(await main(["--tier", "unit", "--tier", "heavy"], both.value)).toBe(0);
		const made = [
			...both.folders,
			...both.linted.map(({ args }) => configOf(args)),
			...both.runs().map(({ env }) => String(env.DRAFTYAK_TEST_COUNTS_DIR)),
		];
		expect(made.length).toBe(4);
		expect(made.filter((dir) => existsSync(dir))).toEqual([]);

		const thrown = new Error("a stubbed tool failure");
		const throwing: [string, (stubs: ReturnType<typeof deps>, seen: string[]) => Deps][] = [
			[
				"typecheck",
				({ value }, seen) => ({
					...value,
					turbo: async (_, env) => {
						seen.push(String(env[TYPECHECK_MARKS]));
						throw thrown;
					},
				}),
			],
			[
				"lint",
				({ value }, seen) => ({
					...value,
					biome: async (args) => {
						seen.push(configOf(args));
						throw thrown;
					},
				}),
			],
			[
				"test",
				({ value }, seen) => ({
					...value,
					turbo: async (args, env) => {
						if (args[1] === "typecheck") return value.turbo(args, env);
						seen.push(String(env.DRAFTYAK_TEST_COUNTS_DIR));
						throw thrown;
					},
				}),
			],
		];
		for (const [tool, change] of throwing) {
			const seen: string[] = [];
			await expect(main(["--tier", "unit"], change(deps(on, { root: at }), seen))).rejects.toBe(
				thrown,
			);
			expect([tool, seen.length, seen.filter((dir) => existsSync(dir))]).toEqual([tool, 1, []]);
		}

		// A marks folder that already held something isn't the run's to remove.
		const seeded = deps(on, { root: at, seed: [{ version: 1, package: only, code: 0 }] });
		expect(await main(["--tier", "unit"], seeded.value)).toBe(1);
		expect(seeded.folders.map((dir) => existsSync(dir))).toEqual([true]);
	});
});

describe("verify's reserved step and profile", () => {
	function context(
		env: NodeJS.ProcessEnv,
		heavyFilters?: readonly string[],
		profile: string = heavyFilters ? "m0" : "reserved",
	) {
		const calls: { kind: string; args: readonly string[]; env?: NodeJS.ProcessEnv }[] = [];
		const record =
			(kind: string) => async (args: readonly string[], options?: { env?: NodeJS.ProcessEnv }) => {
				calls.push({ kind, args, env: options?.env });
				return 0;
			};
		const ctx = {
			root: repo,
			profile,
			env,
			...(heavyFilters === undefined ? {} : { heavyFilters }),
			node: record("node"),
			turbo: record("turbo"),
		} as unknown as StepContext;
		return { ctx, calls };
	}

	it("belongs to the reserved profile and the gate profiles only, never default or cheap", () => {
		expect(reservedStep.profiles).toEqual(["reserved", "m0", "m1"]);
	});

	it("without the flag, is incomplete in a gate profile and fails in CI or the reserved profile, running nothing", async () => {
		const incomplete = {
			status: "incomplete",
			reason: `the gate needs the reserved files' maintainer's run with ${RESERVED_TESTS}=1`,
		};
		const ci = { status: "failed", reason: `CI sets ${RESERVED_TESTS}=1 on this step` };
		const cases = [
			[context({}, ["./spikes/*"]), incomplete],
			// A gate profile whose folders don't exist yet is still a gate profile.
			[context({}, []), incomplete],
			[context({}), { status: "failed", reason: `opt-in only: ${RESERVED_TESTS}=1 runs it` }],
			[context({ GITHUB_ACTIONS: "true" }), ci],
			[context({ GITHUB_ACTIONS: "true" }, ["./spikes/*"]), ci],
		] as const;
		for (const [{ ctx, calls }, outcome] of cases) {
			expect(await reservedStep.run(ctx)).toEqual(outcome);
			expect(calls).toEqual([]);
		}
		const refused = context({ [RESERVED_TESTS]: "yes" }, ["./spikes/*"]);
		expect(await reservedStep.run(refused.ctx)).toEqual({
			status: "failed",
			reason: `${RESERVED_TESTS} must be unset (off) or exactly 1 (on), not "yes"`,
		});
		expect(refused.calls).toEqual([]);
	});

	it("proves the unit tier, and under a gate profile the heavy tier of its heavy step's own filters", async () => {
		const on = { [RESERVED_TESTS]: "1" };
		const proof = "tools/verify/reserved-proof.ts";
		// verify strips the flag from its children, so each proof call sets it again.
		const unit = { kind: "node", args: [proof, "--tier", "unit"], env: on };
		const heavy = (...filters: string[]) => ({
			kind: "node",
			args: [
				proof,
				"--tier",
				"heavy",
				...filters.flatMap((filter) => ["--filter", filter]),
				"--complete",
			],
			env: { ...on, DRAFTYAK_STRICT_SKIPS: "1" },
		});
		const calls = async (filters?: readonly string[]) => {
			const { ctx, calls } = context(on, filters);
			expect(await reservedStep.run(ctx)).toEqual({ status: "passed" });
			return calls;
		};
		expect(await calls()).toEqual([unit]);
		expect(await calls(["./spikes/*", "./tools/*"])).toEqual([
			unit,
			heavy("./spikes/*", "./tools/*"),
		]);
		// A gate profile whose folders don't exist yet has no heavy suites to prove.
		expect(await calls([])).toEqual([unit]);
	});

	it("fails when either proof fails", async () => {
		const { ctx } = context({ [RESERVED_TESTS]: "1" }, ["./spikes/*"]);
		let call = 0;
		const failing = { ...ctx, node: async () => (++call === 2 ? 1 : 0) } as StepContext;
		expect(await reservedStep.run(failing)).toEqual({ status: "failed", reason: "exit code 1" });
	});

	it("is the reserved profile's only step, and every gate profile selects it with its heavy step", async () => {
		const steps = await loadSteps(path.join(verify, "steps"));
		const profiles = await loadProfiles(path.join(verify, "profiles"));
		const names = (profile: string): string[] =>
			(profiles.find((candidate) => candidate.name === profile)?.select(steps) ?? []).map(
				(step) => step.name,
			);
		expect(names("reserved")).toEqual(["reserved"]);
		for (const profile of ["default", "cheap", "docs"]) {
			expect([profile, names(profile).includes("reserved")]).toEqual([profile, false]);
		}
		const dir = path.join(verify, "profiles");
		const gates = readdirSync(dir).filter((file) => /^m\d+[a-z]?\.ts$/.test(file));
		expect(gates.length).toBeGreaterThan(0);
		for (const file of gates) {
			const gate = (await import(pathToFileURL(path.join(dir, file)).href)) as {
				profile?: Profile;
			};
			const selected = (gate.profile?.select(steps) ?? []).map((step) => step.name);
			expect([file, selected.includes("reserved"), selected.includes("test:heavy")]).toEqual([
				file,
				true,
				true,
			]);
		}
	});
});
