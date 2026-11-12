import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { parseArgs } from "node:util";
import {
	biomeNegations,
	RESERVED_TESTS,
	reservedTestsOn,
	reservedWord,
	type TestTier,
	testTier,
	windowsChildEnv,
	withoutReservedTests,
} from "../../../reserved-tests.ts";
import { hookKey } from "./hooks.ts";
import { literals } from "./imports.ts";
import { capture, run } from "./spawn.ts";
import { resolveBiome, resolveTurbo, telemetryOff } from "./tools.ts";

// The execution proof. With DRAFTYAK_RESERVED_TESTS=1 it runs the unit or heavy tier of every
// workspace package holding a reserved file (git ls-files and the reserved words), opted in and
// uncached, so ordinary suites that read reserved data run with it too. Then it checks the per-file
// counts Vitest wrote (vitest.shared.ts) against the maintainer's inventory. It prints counts and
// inventory row numbers, never file or test names unless --names asks. Live and device tiers never
// run here. With --complete, a row of a tier it ran left unchecked fails the run even with --within
// or --filter, and so does a tier for which it selected no package.
const usage = [
	"usage: node tools/verify/reserved-proof.ts --tier unit|heavy [--tier ...]",
	"         [--within <dir>]... | [--filter <turbo filter>]...   [--complete] [--names]",
].join("\n");
export const INVENTORY = "tools/verify/reserved-inventory.json";
const tasks = { unit: "test", heavy: "test:heavy" } as const;
export type ProofTier = keyof typeof tasks;
const say = (line: string): string => `reserved proof: ${line}`;
const root = path.resolve(import.meta.dirname, "..", "..", "..");
// Where every script of a reserved-only package starts (spikes/kit/run.ts), and the one kit module
// its Vitest config may import up front (spikes/kit/off.ts).
export const KIT_RUN = "spikes/kit/run.ts";
export const KIT_OFF = "spikes/kit/off.ts";
// The folder the typecheck call gives the kit, which writes one mark there per tsc run of a
// reserved-only package (spikes/kit/runner.ts): { "version": 1, "package": <dir>, "code": <exit> }.
export const TYPECHECK_MARKS = "DRAFTYAK_TYPECHECK_MARKS";
// The final line when the gate's result isn't ok; tools/verify/reserved-proof.ts prints the same.
export const GATE_STOPPED = "not proven: the reserved check stopped it before any run";

// What DRAFTYAK_TEST_COUNTS_DIR receives per Vitest run (vitest.shared.ts's counts reporter):
// counts per file, never test names or messages.
export interface FileCounts {
	readonly file: string;
	readonly state: string;
	readonly errors: number;
	readonly passed: number;
	readonly failed: number;
	readonly skipped: number;
	readonly todo: number;
}

export interface CountsReport {
	readonly version: 1;
	readonly tier: TestTier;
	readonly optIn: boolean;
	readonly root: string;
	readonly reason: string;
	readonly unhandledErrors: number;
	readonly files: readonly FileCounts[];
}

export interface Row {
	readonly file: string;
	readonly tier: TestTier;
	readonly minPassed: number;
	// Skipped and todo tests a run may report for the file (a requires: tag on some hosts); 0 if unset.
	readonly maxSkipped?: number;
}

export interface Inventory {
	readonly rows: readonly Row[];
}

export interface TierRun {
	readonly code: number;
	readonly reports: readonly CountsReport[];
	// The packages whose suites ran this tier: each must have written a counts report.
	readonly packages?: readonly string[];
}

export type Problem =
	| { readonly kind: "inventory"; readonly detail: string }
	| { readonly kind: "missing-row" | "no-package"; readonly files: readonly string[] }
	| { readonly kind: "stale-row" | "tier-mismatch" | "bad-minimum"; readonly row: number }
	| { readonly kind: "run-exit"; readonly tier: ProofTier; readonly code: number }
	| { readonly kind: "run-outcome" | "not-opted-in" | "none-selected"; readonly tier: ProofTier }
	| {
			readonly kind: "package-not-run" | "unchecked" | "incomplete";
			readonly tier: ProofTier;
			readonly count: number;
	  }
	| { readonly kind: "typecheck" | "lint"; readonly code: number }
	| { readonly kind: "no-typecheck-script" | "no-mark"; readonly count: number }
	| { readonly kind: "wiring"; readonly scripts: number; readonly configs: number }
	| { readonly kind: "not-run" | "empty" | "failed" | "duplicate"; readonly row: number }
	| {
			readonly kind: "below-minimum";
			readonly row: number;
			readonly passed: number;
			readonly min: number;
	  }
	| {
			readonly kind: "skipped";
			readonly row: number;
			readonly skipped: number;
			readonly max: number;
	  };

const listed = (count: string, files: readonly string[], names: boolean): string =>
	names ? `${count}: ${files.join(", ")}` : `${count} (--names lists them)`;

export function describeProblem(problem: Problem, names = false): string {
	switch (problem.kind) {
		case "inventory":
			return `${INVENTORY}: ${problem.detail}`;
		case "missing-row": {
			const count = `${problem.files.length} tracked reserved test file(s) have no inventory row`;
			return listed(count, problem.files, names);
		}
		case "no-package": {
			const count = `${problem.files.length} tracked reserved file(s) sit in no workspace package, so nothing runs them`;
			return listed(count, problem.files, names);
		}
		case "stale-row":
			return `row ${problem.row}: no tracked reserved test file has this name`;
		case "tier-mismatch":
			return `row ${problem.row}: its tier isn't the one the file name gives`;
		case "bad-minimum":
			return `row ${problem.row}: minPassed must be a whole number of at least 1, maxSkipped of at least 0`;
		case "run-exit":
			return `${problem.tier}: the tier run exited ${problem.code}`;
		case "run-outcome":
			return `${problem.tier}: a run ended with failed tests or unhandled errors`;
		case "not-opted-in":
			return `${problem.tier}: a run had ${RESERVED_TESTS} unset`;
		case "package-not-run":
			return `${problem.tier}: ${problem.count} package(s) holding reserved files wrote no counts, so their suites never ran opted in`;
		case "unchecked":
			return `${problem.tier}: ${problem.count} inventory row(s) of the tier went unchecked in a run without --within or --filter`;
		case "incomplete":
			return `${problem.tier}: ${problem.count} inventory row(s) of the tier went unchecked in a --complete run`;
		case "none-selected":
			return `${problem.tier}: a --complete run selected no package holding reserved files`;
		case "typecheck":
			return `unit: the typecheck and build of the reserved-only packages exited ${problem.code}`;
		case "no-typecheck-script":
			return `unit: ${problem.count} reserved-only package(s) have no typecheck script`;
		case "no-mark":
			return `unit: ${problem.count} reserved-only package(s) wrote no typecheck mark with exit 0`;
		case "lint":
			return `unit: the lint and format check of the reserved files exited ${problem.code} (--names prints it)`;
		case "wiring":
			return `unit: reserved-only packages: ${problem.scripts} script(s) don't start with node <kit>/run.ts or are install, prepare or pre/post scripts, ${problem.configs} Vitest config(s) import more than the kit's off.ts up front`;
		case "not-run":
			return `row ${problem.row}: never ran`;
		case "empty":
			return `row ${problem.row}: collected no tests`;
		case "failed":
			return `row ${problem.row}: a test failed or the file didn't load`;
		case "duplicate":
			return `row ${problem.row}: more than one count report holds this file`;
		case "below-minimum":
			return `row ${problem.row}: ${problem.passed} passed, below its minimum ${problem.min}`;
		case "skipped":
			return `row ${problem.row}: ${problem.skipped} skipped or todo, above its maxSkipped ${problem.max}`;
	}
}

const whole = (value: unknown, min: number): boolean =>
	typeof value === "number" && Number.isInteger(value) && value >= min;

const isRecord = (value: unknown): value is Readonly<Record<string, unknown>> =>
	typeof value === "object" && value !== null && !Array.isArray(value);

// The inventory holds "about" and "files" only: no Rust row is proven, and no other key is read.
export function parseInventory(text: string): Inventory | string {
	let value: unknown;
	try {
		value = JSON.parse(text);
	} catch {
		return "isn't valid JSON";
	}
	if (!isRecord(value)) return 'needs a "files" array';
	const keys = Object.keys(value);
	if (keys.includes("rust")) return 'has a "rust" key; the proof runs no Rust rows';
	if (keys.some((key) => key !== "about" && key !== "files")) {
		return 'has keys other than "about" and "files"';
	}
	const files = value.files;
	if (!Array.isArray(files)) return 'needs a "files" array';
	const tiers: readonly unknown[] = ["unit", "heavy", "live", "device"];
	const rows: Row[] = [];
	for (const [index, entry] of files.entries()) {
		const row = entry as Partial<Row> | null;
		if (
			typeof row?.file !== "string" ||
			!tiers.includes(row.tier) ||
			typeof row.minPassed !== "number" ||
			(row.maxSkipped !== undefined && typeof row.maxSkipped !== "number")
		) {
			return `row ${index + 1} needs a file, a tier (unit, heavy, live or device) and minPassed`;
		}
		rows.push({
			file: row.file,
			tier: row.tier as TestTier,
			minPassed: row.minPassed,
			...(row.maxSkipped === undefined ? {} : { maxSkipped: row.maxSkipped }),
		});
	}
	return { rows };
}

// Tracked test files whose path names a reserved word, with each one's tier.
export function reservedTestFiles(tracked: readonly string[]): ReadonlyMap<string, TestTier> {
	const found = new Map<string, TestTier>();
	for (const file of tracked) {
		const tier = testTier(file);
		if (tier !== null && reservedWord.test(file)) found.set(file, tier);
	}
	return found;
}

// The workspace package holding a file: the nearest folder below the root with a tracked package.json.
export function packageOf(file: string, tracked: readonly string[]): string | null {
	const manifests = new Set(tracked.filter((name) => path.posix.basename(name) === "package.json"));
	for (let dir = path.posix.dirname(file); dir !== "."; dir = path.posix.dirname(dir)) {
		if (manifests.has(`${dir}/package.json`)) return dir;
	}
	return null;
}

export interface Owners {
	// Each reserved file the proof answers for, and the package whose suites run with it.
	readonly owned: ReadonlyMap<string, string>;
	readonly unowned: readonly string[];
}

// Every tracked reserved file but docs, and the package holding it.
export function reservedOwners(tracked: readonly string[]): Owners {
	const owned = new Map<string, string>();
	const unowned: string[] = [];
	for (const file of tracked) {
		if (!reservedWord.test(file) || /\.md$/i.test(file)) continue;
		const owner = packageOf(file, tracked);
		if (owner === null) unowned.push(file);
		else owned.set(file, owner);
	}
	return { owned, unowned };
}

// A manifest's scripts: null when it can't be read, isn't a JSON object, or holds scripts that
// aren't one.
function manifestScripts(text: string | undefined): Readonly<Record<string, unknown>> | null {
	if (text === undefined) return null;
	let manifest: unknown;
	try {
		manifest = JSON.parse(text);
	} catch {
		return null;
	}
	if (!isRecord(manifest)) return null;
	const scripts = manifest.scripts;
	if (scripts === undefined) return {};
	return isRecord(scripts) ? scripts : null;
}

// A reserved-only package (its own folder is reserved) starts every script through the kit's
// run.ts and has no install, prepare, pre/post or pnpm: script, and its Vitest config imports
// nothing up front but the kit's off.ts (and Vitest's or Node's own modules), so pnpm runs that
// reach it outside turbo end at the kit's early exit.
export function wiring(
	dirs: readonly string[],
	tracked: readonly string[],
	read: (file: string) => string | undefined,
): { scripts: number; configs: number } {
	let scripts = 0;
	let configs = 0;
	for (const dir of dirs) {
		const start = `node ${path.posix.relative(dir, KIT_RUN)}`;
		const found = manifestScripts(read(`${dir}/package.json`));
		if (found === null) scripts++;
		for (const [key, value] of Object.entries(found ?? {})) {
			const kit =
				typeof value === "string" &&
				value.startsWith(start) &&
				/^(?: |$)/.test(value.slice(start.length));
			if (!kit || hookKey(key)) scripts++;
		}
		const off = path.posix.relative(dir, KIT_OFF);
		const allowed = (specifier: string): boolean =>
			specifier === off ||
			specifier.startsWith("node:") ||
			specifier === "vitest/config" ||
			specifier === "vitest/node";
		const isConfig = (file: string): boolean =>
			path.posix.dirname(file) === dir &&
			/^vitest\.config\.[cm]?[jt]s$/.test(path.posix.basename(file));
		for (const config of tracked.filter(isConfig)) {
			const imports = literals(read(config) ?? "").filter((literal) =>
				["static", "bare", "require", "create-require"].includes(literal.kind),
			);
			if (imports.some((literal) => !allowed(literal.value))) configs++;
		}
	}
	return { scripts, configs };
}

export interface ProofInput {
	readonly tracked: readonly string[];
	readonly rows: readonly Row[];
	readonly runs: ReadonlyMap<ProofTier, TierRun>;
	readonly selected?: (file: string) => boolean;
	// A --within or --filter run, which may leave rows of a tier it ran unchecked. Any other run
	// fails on such a row, and so does a --complete one.
	readonly filtered?: boolean;
	readonly complete?: boolean;
}

export function check(input: ProofInput): Problem[] {
	const problems: Problem[] = [];
	const reserved = reservedTestFiles(input.tracked);
	const listedFiles = new Set(input.rows.map((row) => row.file));
	const missing = [...reserved.keys()].filter((file) => !listedFiles.has(file));
	if (missing.length > 0) problems.push({ kind: "missing-row", files: missing });
	for (const [index, row] of input.rows.entries()) {
		const tier = reserved.get(row.file);
		if (tier === undefined) problems.push({ kind: "stale-row", row: index + 1 });
		else if (tier !== row.tier) problems.push({ kind: "tier-mismatch", row: index + 1 });
		if (!whole(row.minPassed, 1) || (row.maxSkipped !== undefined && !whole(row.maxSkipped, 0))) {
			problems.push({ kind: "bad-minimum", row: index + 1 });
		}
	}
	const selected = input.selected ?? (() => true);
	for (const [tier, tierRun] of input.runs) {
		if (tierRun.code !== 0) problems.push({ kind: "run-exit", tier, code: tierRun.code });
		const reports = tierRun.reports.filter((report) => report.tier === tier);
		if (reports.some((report) => report.reason !== "passed" || report.unhandledErrors > 0)) {
			problems.push({ kind: "run-outcome", tier });
		}
		if (reports.some((report) => !report.optIn)) problems.push({ kind: "not-opted-in", tier });
		const silent = (tierRun.packages ?? []).filter(
			(dir) => !reports.some((report) => report.root === dir),
		);
		if (silent.length > 0) problems.push({ kind: "package-not-run", tier, count: silent.length });
		// One report per file: a second one (two runs of one package) is refused, never added up.
		const counts = new Map<string, FileCounts[]>();
		for (const file of reports.flatMap((report) => report.files)) {
			counts.set(file.file, [...(counts.get(file.file) ?? []), file]);
		}
		let unchecked = 0;
		for (const [index, row] of input.rows.entries()) {
			if (row.tier !== tier) continue;
			if (!selected(row.file)) {
				unchecked++;
				continue;
			}
			const at = index + 1;
			const all = counts.get(row.file) ?? [];
			const got = all[0];
			if (got === undefined) {
				problems.push({ kind: "not-run", row: at });
				continue;
			}
			if (all.length > 1) {
				problems.push({ kind: "duplicate", row: at });
				continue;
			}
			if (got.passed + got.failed + got.skipped + got.todo === 0) {
				problems.push({ kind: "empty", row: at });
			}
			if (got.failed > 0 || got.errors > 0 || got.state === "failed") {
				problems.push({ kind: "failed", row: at });
			}
			// Only passed tests count: skipped and todo tests never make up a minimum, and beyond the
			// row's maxSkipped (0 unless set) they fail it.
			if (got.passed < row.minPassed) {
				problems.push({ kind: "below-minimum", row: at, passed: got.passed, min: row.minPassed });
			}
			const max = row.maxSkipped ?? 0;
			if (got.skipped + got.todo > max) {
				problems.push({ kind: "skipped", row: at, skipped: got.skipped + got.todo, max });
			}
		}
		if (unchecked > 0 && input.filtered !== true) {
			problems.push({ kind: "unchecked", tier, count: unchecked });
		} else if (unchecked > 0 && input.complete === true) {
			problems.push({ kind: "incomplete", tier, count: unchecked });
		}
	}
	return problems;
}

export function readReports(dir: string): { reports: CountsReport[]; unreadable: number } {
	const reports: CountsReport[] = [];
	let unreadable = 0;
	for (const name of readdirSync(dir).filter((file) => file.endsWith(".json"))) {
		try {
			const report = JSON.parse(readFileSync(path.join(dir, name), "utf8")) as CountsReport;
			if (report.version !== 1 || !Array.isArray(report.files)) throw new Error("shape");
			reports.push(report);
		} catch {
			unreadable++;
		}
	}
	return { reports, unreadable };
}

export interface TypecheckMark {
	readonly version: 1;
	readonly package: string;
	readonly code: number;
}

export function readMarks(dir: string): { marks: TypecheckMark[]; unreadable: number } {
	const marks: TypecheckMark[] = [];
	let unreadable = 0;
	for (const name of readdirSync(dir).filter((file) => file.endsWith(".json"))) {
		try {
			const mark: unknown = JSON.parse(readFileSync(path.join(dir, name), "utf8"));
			if (
				!isRecord(mark) ||
				mark.version !== 1 ||
				typeof mark.package !== "string" ||
				typeof mark.code !== "number"
			) {
				throw new Error("shape");
			}
			marks.push({ version: 1, package: mark.package, code: mark.code });
		} catch {
			unreadable++;
		}
	}
	return { marks, unreadable };
}

// The packages whose tsc ran exactly once in the typecheck call and exited 0. An unreadable mark
// could be any package's, so then none counts.
export function markedPackages(
	packages: readonly string[],
	found: { readonly marks: readonly TypecheckMark[]; readonly unreadable: number },
): string[] {
	if (found.unreadable > 0) return [];
	return packages.filter((dir) => {
		const own = found.marks.filter((mark) => mark.package === dir);
		return own.length === 1 && own[0]?.code === 0;
	});
}

export interface Deps {
	readonly root: string;
	readonly env: NodeJS.ProcessEnv;
	readonly print: (line: string) => void;
	// The gate's result, which the entry already holds: main checks it before any other call.
	readonly gate: () => Promise<{ readonly ok: boolean; readonly lines: readonly string[] }>;
	readonly tracked: () => Promise<readonly string[]>;
	// turbo with these arguments and env: its exit code, or with dry its stdout.
	readonly turbo: (args: readonly string[], env: NodeJS.ProcessEnv) => Promise<number>;
	readonly turboDry: (args: readonly string[], env: NodeJS.ProcessEnv) => Promise<string>;
	// biome with these arguments: its exit code and output, which only --names prints.
	readonly biome: (args: readonly string[]) => Promise<{ code: number; output: string }>;
	// A new empty folder for the typecheck call's marks, which main removes once it has read them.
	readonly marksDir: () => string;
}

// Removes a folder this run made and has read. A folder still held open stays; it never changes
// the outcome.
function removeFolder(dir: string): void {
	try {
		rmSync(dir, { recursive: true, force: true, maxRetries: 3 });
	} catch {}
}

// Everything but the gate, which the entry runs before it loads this module.
export const defaults: Omit<Deps, "gate"> = {
	root,
	env: process.env,
	print: (line) => console.log(line),
	async tracked() {
		const result = await capture(
			{ command: "git", args: ["ls-files", "-z"] },
			{ cwd: root, env: windowsChildEnv(process.env) },
		);
		if (result.code !== 0) throw new Error(`git ls-files exited ${result.code}`);
		return result.stdout.split("\0").filter(Boolean);
	},
	turbo(args, env) {
		return run(
			{ command: resolveTurbo(root), args },
			{ cwd: root, env: windowsChildEnv({ ...env, ...telemetryOff }) },
		);
	},
	async turboDry(args, env) {
		const result = await capture(
			{ command: resolveTurbo(root), args },
			{ cwd: root, env: windowsChildEnv({ ...env, ...telemetryOff }) },
		);
		if (result.code !== 0) throw new Error(`turbo ${args.join(" ")} exited ${result.code}`);
		return result.stdout;
	},
	async biome(args) {
		const result = await capture(
			{ command: resolveBiome(root), args },
			{ cwd: root, env: windowsChildEnv({ ...process.env, NO_COLOR: "1" }) },
		);
		return { code: result.code, output: `${result.stdout}${result.stderr}` };
	},
	marksDir: () => mkdtempSync(path.join(tmpdir(), "draftyak-marks-")),
};

// Task logs: none, so nothing of a reserved suite reaches the log; with --names, a failing task's
// log, each line prefixed with its task.
const logArgs = (names: boolean): string[] =>
	names ? ["--output-logs=errors-only", "--log-prefix=task"] : ["--output-logs=none"];

export function tierArgs(tier: ProofTier, packages: readonly string[], names: boolean): string[] {
	return [
		"run",
		tasks[tier],
		...packages.map((dir) => `--filter=./${dir}`),
		// Never a cache replay: the counts must come from this run.
		"--force",
		...logArgs(names),
		"--continue=dependencies-successful",
		...(tier === "heavy" ? ["--concurrency=1"] : []),
		// No console output from the tests themselves, failing or passing.
		"--",
		"--silent",
	];
}

// The packages a default run of the tier never reaches: those whose own folder is reserved.
export function typecheckArgs(packages: readonly string[], names: boolean): string[] {
	return [
		"run",
		"typecheck",
		"build",
		...packages.map((dir) => `--filter=./${dir}`),
		// Never a cache replay: each package's tsc must run and write its mark in this run.
		"--force",
		...logArgs(names),
		"--continue=dependencies-successful",
	];
}

// biome.json without its reserved negations, for the lint and format check of the reserved files
// that default lint runs leave out. Other negations (fixtures, vectors, evidence) still apply.
export function reservedBiomeConfig(text: string): string {
	const config = JSON.parse(text) as { $schema?: string; files?: { includes?: string[] } };
	delete config.$schema;
	if (config.files?.includes) {
		config.files.includes = config.files.includes.filter((glob) => !biomeNegations.includes(glob));
	}
	return `${JSON.stringify(config, null, 2)}\n`;
}

export function biomeArgs(configDir: string, files: readonly string[]): string[] {
	return [
		"ci",
		`--config-path=${configDir}`,
		// The files are named here; a config outside the checkout can't read its .gitignore.
		"--vcs-enabled=false",
		"--files-ignore-unknown=true",
		"--no-errors-on-unmatched",
		"--colors=off",
		...files,
	];
}

// The package folders whose `task` the turbo filters select, as a dry run resolves them.
export function filteredDirs(dryJson: string, task: string): Set<string> {
	const { tasks: planned } = JSON.parse(dryJson) as {
		tasks: { task: string; directory: string }[];
	};
	return new Set(
		planned
			.filter((entry) => entry.task === task)
			.map((entry) => entry.directory.split(/[\\/]+/).join("/")),
	);
}

const within = (file: string, dir: string): boolean => file === dir || file.startsWith(`${dir}/`);

// Entries that leave the marks folder out of a child's env, in whatever case it was stored.
const withoutMarks = (env: NodeJS.ProcessEnv): NodeJS.ProcessEnv =>
	Object.fromEntries(
		Object.keys(env)
			.filter((key) => key.toUpperCase() === TYPECHECK_MARKS)
			.map((key) => [key, undefined]),
	);

export async function main(argv: readonly string[], deps: Deps): Promise<number> {
	let options: {
		tier: string[];
		within: string[];
		filter: string[];
		complete: boolean;
		names: boolean;
	};
	try {
		({ values: options } = parseArgs({
			args: argv[0] === "--" ? argv.slice(1) : [...argv],
			options: {
				tier: { type: "string", multiple: true, default: [] },
				within: { type: "string", multiple: true, default: [] },
				filter: { type: "string", multiple: true, default: [] },
				complete: { type: "boolean", default: false },
				names: { type: "boolean", default: false },
			},
		}));
	} catch (error) {
		deps.print(say(`${error instanceof Error ? error.message : String(error)}\n${usage}`));
		return 2;
	}
	const requested = [...new Set(options.tier)];
	if (requested.some((tier) => tier === "live" || tier === "device")) {
		deps.print(say("live and device tiers run only in owner sessions, never here"));
		return 2;
	}
	if (requested.length === 0 || !requested.every((tier) => tier in tasks)) {
		deps.print(say(usage));
		return 2;
	}
	const tiers = requested as ProofTier[];
	if (options.within.length > 0 && options.filter.length > 0) {
		deps.print(say(`--within and --filter don't mix\n${usage}`));
		return 2;
	}
	try {
		if (!reservedTestsOn(deps.env)) {
			deps.print(say(`${RESERVED_TESTS} is unset: CI, the sync and the maintainer set it to 1`));
			return 1;
		}
	} catch (error) {
		deps.print(say(error instanceof Error ? error.message : String(error)));
		return 1;
	}
	// The gate's result, from the run the entry made before loading this module: nothing is listed,
	// read or run unless it passed.
	let gate: { readonly ok: boolean; readonly lines: readonly string[] };
	try {
		gate = await deps.gate();
	} catch {
		gate = { ok: false, lines: [] };
	}
	for (const line of gate.lines) deps.print(line);
	if (gate.ok !== true) {
		deps.print(say(GATE_STOPPED));
		return 1;
	}

	const tracked = await deps.tracked();
	// A --within value must name a tracked file or folder exactly (case included): a near miss would
	// select nothing and prove nothing.
	const scope = options.within.map((dir) =>
		dir
			.replace(/\\/g, "/")
			.replace(/^(?:\.\/)+/, "")
			.replace(/\/+$/, ""),
	);
	const loose = scope.filter((dir) => dir === "" || !tracked.some((file) => within(file, dir)));
	if (loose.length > 0) {
		deps.print(say(`${loose.length} --within value(s) name no tracked file or folder`));
		return 2;
	}
	const filtered = scope.length > 0 || options.filter.length > 0;
	let parsed: Inventory | string;
	try {
		parsed = parseInventory(readFileSync(path.join(deps.root, INVENTORY), "utf8"));
	} catch {
		parsed = "can't be read";
	}
	const inventory: Inventory = typeof parsed === "string" ? { rows: [] } : parsed;
	const reserved = reservedTestFiles(tracked);
	const owners = reservedOwners(tracked);
	const holders = [...new Set(owners.owned.values())].toSorted();
	const env = {
		...deps.env,
		...withoutReservedTests(deps.env),
		...withoutMarks(deps.env),
		[RESERVED_TESTS]: "1",
	};
	const read = (file: string): string | undefined => {
		try {
			return readFileSync(path.join(deps.root, file), "utf8");
		} catch {
			return undefined;
		}
	};
	// The filters' packages per tier task, when the caller gave turbo filters (CI's heavy step's).
	const byFilter = new Map<ProofTier, Set<string>>();
	for (const tier of tiers) {
		if (options.filter.length === 0) continue;
		const task = tasks[tier];
		const filters = options.filter.map((filter) => `--filter=${filter}`);
		const dry = await deps.turboDry(["run", task, ...filters, "--dry=json"], env);
		byFilter.set(tier, filteredDirs(dry, task));
	}
	// The packages holding reserved files that this run covers in a tier: those the filters select,
	// or those whose folder or reserved files lie within --within, or all of them.
	const ownedFiles = (dir: string): string[] =>
		[...owners.owned].filter(([, owner]) => owner === dir).map(([file]) => file);
	const covers = (tier: ProofTier, dir: string): boolean => {
		if (options.filter.length > 0) return !!byFilter.get(tier)?.has(dir);
		if (scope.length === 0) return true;
		return scope.some((at) => within(dir, at) || ownedFiles(dir).some((file) => within(file, at)));
	};
	const selectedPackages = new Map<ProofTier, string[]>();
	const selected = (file: string): boolean => {
		const tier = reserved.get(file) as ProofTier | undefined;
		const pkg = packageOf(file, tracked);
		return tier !== undefined && pkg !== null && !!selectedPackages.get(tier)?.includes(pkg);
	};
	const problems: Problem[] = [];
	if (owners.unowned.length > 0) problems.push({ kind: "no-package", files: owners.unowned });
	const runs = new Map<ProofTier, TierRun>();
	let marks = { marked: 0, packages: 0 };
	for (const tier of tiers) {
		const packages = holders.filter((dir) => covers(tier, dir));
		selectedPackages.set(tier, packages);
		if (packages.length === 0) {
			deps.print(say(`${tier}: no package holding reserved files selected`));
			if (options.complete) problems.push({ kind: "none-selected", tier });
			// The tier still counts as run: its rows are reported, and checked as unselected.
			runs.set(tier, { code: 0, reports: [], packages: [] });
			continue;
		}
		// Default runs leave reserved-only packages out entirely (tools/verify/turbo.ts), and lint
		// leaves every reserved file out (biome.json), so their typecheck, build and lint happen here.
		const only = packages.filter((dir) => reservedWord.test(dir));
		if (tier === "unit") {
			const wired = wiring(only, tracked, read);
			if (wired.scripts + wired.configs > 0) problems.push({ kind: "wiring", ...wired });
			const scriptless = only.filter(
				(dir) => typeof manifestScripts(read(`${dir}/package.json`))?.typecheck !== "string",
			);
			if (scriptless.length > 0) {
				problems.push({ kind: "no-typecheck-script", count: scriptless.length });
			}
			marks = { marked: 0, packages: only.length };
			if (only.length > 0) {
				// The typecheck call alone gets the marks folder: each package's kit must write
				// exactly one mark there, with exit 0.
				const folder = deps.marksDir();
				// A folder that already held something isn't fresh: none of its marks counts, and it
				// isn't this run's to remove.
				const fresh = readdirSync(folder).length === 0;
				let code: number;
				try {
					code = await deps.turbo(typecheckArgs(only, options.names), {
						...env,
						[TYPECHECK_MARKS]: folder,
					});
					marks.marked = fresh ? markedPackages(only, readMarks(folder)).length : 0;
				} finally {
					if (fresh) removeFolder(folder);
				}
				deps.print(
					say(
						`unit: typecheck and build of ${only.length} reserved-only package(s) exited ${code}; ${marks.marked} typecheck mark(s) with exit 0`,
					),
				);
				if (code !== 0) problems.push({ kind: "typecheck", code });
				if (marks.marked < only.length) {
					problems.push({ kind: "no-mark", count: only.length - marks.marked });
				}
			}
			const lintable = [...owners.owned]
				.filter(([, owner]) => packages.includes(owner))
				.map(([file]) => file);
			const config = read("biome.json");
			if (lintable.length > 0 && config !== undefined) {
				const dir = mkdtempSync(path.join(tmpdir(), "draftyak-reserved-biome-"));
				let linted: { code: number; output: string };
				try {
					writeFileSync(path.join(dir, "biome.json"), reservedBiomeConfig(config));
					linted = await deps.biome(biomeArgs(dir, lintable));
				} finally {
					removeFolder(dir);
				}
				deps.print(
					say(
						`unit: lint and format check of ${lintable.length} reserved file(s) exited ${linted.code}`,
					),
				);
				if (linted.code !== 0) {
					problems.push({ kind: "lint", code: linted.code });
					// Biome's code frames carry no path, so the log guard can't refuse them: only --names.
					if (options.names) for (const line of linted.output.split(/\r?\n/)) deps.print(line);
				}
			}
		}
		// A package whose manifest can't be read still owes counts.
		const expected = packages.filter((dir) => {
			const scripts = manifestScripts(read(`${dir}/package.json`));
			return scripts === null || typeof scripts[tasks[tier]] === "string";
		});
		const files = [...reserved].filter(([file, of]) => of === tier && selected(file));
		deps.print(
			say(
				`${tier}: ${files.length} reserved test file(s); ${packages.length} package(s) holding reserved files, opted in, uncached`,
			),
		);
		// The per-file count reports name reserved test files, so the folder goes once read.
		const counts = mkdtempSync(path.join(tmpdir(), "draftyak-counts-"));
		let code: number;
		let found: { reports: CountsReport[]; unreadable: number };
		try {
			code = await deps.turbo(tierArgs(tier, packages, options.names), {
				...env,
				DRAFTYAK_TEST_COUNTS_DIR: counts,
			});
			found = readReports(counts);
		} finally {
			removeFolder(counts);
		}
		const { reports, unreadable } = found;
		const own = reports.filter((report) => packages.includes(report.root));
		deps.print(say(`${tier}: the run exited ${code}; ${own.length} count report(s)`));
		runs.set(tier, {
			code,
			reports: unreadable > 0 ? [...own, broken(tier)] : own,
			packages: expected,
		});
	}

	if (typeof parsed === "string") problems.push({ kind: "inventory", detail: parsed });
	const complete = options.complete;
	problems.push(...check({ tracked, rows: inventory.rows, runs, selected, filtered, complete }));
	printTable(deps, inventory.rows, runs, selected, options.names);
	for (const problem of problems)
		deps.print(say(`problem: ${describeProblem(problem, options.names)}`));
	if (problems.length > 0) {
		deps.print(say(`not proven: ${problems.length} problem(s)`));
		return 1;
	}
	// Each tier that ran: its rows this run checked, out of all its inventory rows. Only a run of
	// the unit tier without --within or --filter, which checked every row, is proven. Any other
	// --complete run checked every row of its tiers too and is complete; the rest are partial.
	const totals = (["unit", "heavy"] as const)
		.filter((tier) => runs.has(tier))
		.map((tier) => {
			const of = inventory.rows.filter((row) => row.tier === tier);
			return `${tier} ${of.filter((row) => selected(row.file)).length}/${of.length}`;
		});
	const typecheck = runs.has("unit") ? `; typecheck marks ${marks.marked}/${marks.packages}` : "";
	const verdict = !filtered && runs.has("unit") ? "proven" : complete ? "complete" : "partial";
	deps.print(say(`${verdict}: ${totals.join(", ")}${typecheck}`));
	return 0;
}

// An unreadable report fails the tier's outcome without guessing at its counts.
function broken(tier: ProofTier): CountsReport {
	return {
		version: 1,
		tier,
		optIn: true,
		root: "",
		reason: "unreadable",
		unhandledErrors: 0,
		files: [],
	};
}

function printTable(
	deps: Deps,
	rows: readonly Row[],
	runs: ReadonlyMap<ProofTier, TierRun>,
	selected: (file: string) => boolean,
	names: boolean,
): void {
	if (runs.size === 0) return;
	const totals = new Map<string, FileCounts>();
	for (const [tier, tierRun] of runs) {
		for (const file of tierRun.reports.flatMap((report) => report.files)) {
			totals.set(`${tier} ${file.file}`, file);
		}
	}
	deps.print(say("row  tier    minimum  passed  skipped  failed"));
	let others = 0;
	for (const [index, row] of rows.entries()) {
		if (!runs.has(row.tier as ProofTier) || !selected(row.file)) {
			others++;
			continue;
		}
		const got = totals.get(`${row.tier} ${row.file}`);
		const cells = [
			String(index + 1).padStart(3),
			row.tier.padEnd(6),
			String(row.minPassed).padStart(8),
			String(got?.passed ?? "-").padStart(7),
			String(got === undefined ? "-" : got.skipped + got.todo).padStart(8),
			String(got?.failed ?? "-").padStart(7),
		];
		deps.print(say(`${cells.join("  ")}${names ? `  ${row.file}` : ""}`));
	}
	if (others > 0)
		deps.print(say(`${others} row(s) not checked by this run (other tiers or packages)`));
}
