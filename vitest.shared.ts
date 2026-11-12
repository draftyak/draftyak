import { randomUUID } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { type ConfigEnv, defaultExclude, type ViteUserConfig } from "vitest/config";
import type { Reporter, TestModule, VitestPluginContext } from "vitest/node";
import {
	OFF_NOTICE,
	RESERVED_TESTS,
	repoPath,
	reservedGlobs,
	reservedPath,
	reservedTestsOn,
	type TestTier,
	tierFiles,
} from "./reserved-tests.ts";

export { tierFiles };
export type Tier = TestTier;

// The tier is Vitest's --mode (default "test" = unit): a plain flag, the same in every shell.
export function tierFromMode(mode: string): Tier {
	if (mode === "test") return "unit";
	if (mode === "heavy" || mode === "live" || mode === "device") return mode;
	throw new Error(`unknown test tier "${mode}": use --mode heavy, live or device`);
}

// The include until the draftyak:reserved-tests plugin sets the tier's glob. A config that drops the
// plugin (a factory setting `plugins` without base.plugins) finds no test files and fails, instead
// of running reserved tests.
export const PLUGIN_MISSING = "draftyak-reserved-tests-plugin-missing/**";

// What DRAFTYAK_TEST_COUNTS_DIR receives per run, for the reserved proof: counts per file, never
// test names or messages. Paths are below the repository root where they can be.
export interface FileCounts {
	readonly file: string;
	readonly state: string;
	readonly errors: number;
	readonly passed: number;
	readonly failed: number;
	// Skipped, or never finished (an interrupted run).
	readonly skipped: number;
	readonly todo: number;
}

export interface CountsReport {
	readonly version: 1;
	readonly tier: Tier;
	readonly optIn: boolean;
	readonly root: string;
	readonly reason: string;
	readonly unhandledErrors: number;
	readonly files: readonly FileCounts[];
}

function fileCounts(module: TestModule): FileCounts {
	const tally = { passed: 0, failed: 0, skipped: 0, todo: 0 };
	for (const test of module.children.allTests()) {
		const { state } = test.result();
		if (test.options.mode === "todo") tally.todo++;
		else if (state === "passed") tally.passed++;
		else if (state === "failed") tally.failed++;
		else tally.skipped++;
	}
	const file = repoPath(module.moduleId) ?? module.moduleId;
	return { file, state: module.state(), errors: module.errors().length, ...tally };
}

function countsReporter(dir: string, tier: Tier, optIn: boolean, root: string): Reporter {
	if (!path.isAbsolute(dir)) throw new Error("DRAFTYAK_TEST_COUNTS_DIR must be an absolute path");
	return {
		onTestRunEnd(modules, unhandledErrors, reason) {
			const report: CountsReport = {
				version: 1,
				tier,
				optIn,
				root: repoPath(root) ?? root,
				reason,
				unhandledErrors: unhandledErrors.length,
				files: modules.map(fileCounts),
			};
			mkdirSync(dir, { recursive: true });
			const file = path.join(dir, `${tier}-${process.pid}-${randomUUID()}.json`);
			writeFileSync(file, `${JSON.stringify(report, null, "\t")}\n`);
		},
	};
}

// The reserved globs added to an exclude list, whatever a package config put there.
const withReserved = (list: readonly string[] | undefined): string[] => [
	...new Set([...(list ?? []), ...reservedGlobs]),
];

// One counts report per Vitest run, however often its plugins are configured.
const counted = new WeakSet<object>();

// What a default run's load of a reserved module fails with: no path, no failure marker of the log
// guard's own, so the guard decides from the lines around it.
export const LOADED_RESERVED: string = `a default run loaded a reserved module; ${RESERVED_TESTS}=1 runs it`;

// The file behind a Vite module id, or null for a virtual module (\0-prefixed, or not a path).
export function moduleFile(id: string): string | null {
	if (id.startsWith("\0")) return null;
	const file = id.replace(/[?#].*$/, "");
	const local = file.startsWith("/@fs/") ? file.slice(4).replace(/^\/([A-Za-z]:)/, "$1") : file;
	return path.isAbsolute(local) ? local : null;
}

const reservedModule = (id: string): boolean => {
	const file = moduleFile(id);
	return file !== null && reservedPath(file);
};

// Globs only see paths below Vitest's root or --dir, never that folder's own name. Once Vitest has
// resolved both (CLI --root and --dir included), a run in a reserved folder gets no test files and
// passes with none, while every other run gets its tier's glob. The reserved globs join the resolved
// test, benchmark and typecheck excludes here too, so a package config that replaces test.exclude,
// or `vitest bench`, still leaves reserved files out. Whatever else reaches a reserved module (a
// setup or global setup file, vi.importActual, a computed import, an alias, a package's exports)
// fails its load unless the run is opted in. Vitest's file cache serves a cached module without
// that load, so it never holds a reserved module, and default and opted-in runs never share it.
function reservedTestsPlugin(tier: Tier, optIn: boolean) {
	return {
		name: "draftyak:reserved-tests",
		load(id: string): null {
			if (!optIn && reservedModule(id)) throw new Error(LOADED_RESERVED);
			return null;
		},
		configureVitest({ vitest, project, defineCacheKeyGenerator }: VitestPluginContext): void {
			defineCacheKeyGenerator(({ id }) =>
				reservedModule(id) ? false : `draftyak:reserved-tests=${optIn ? 1 : 0}`,
			);
			const config = project.config;
			const off = !optIn && [config.root, config.dir].some((dir) => !!dir && reservedPath(dir));
			if (off) config.include = [];
			else if (config.include.length === 1 && config.include[0] === PLUGIN_MISSING) {
				config.include = [tierFiles[tier]];
			}
			if (!optIn) {
				config.exclude = withReserved(config.exclude);
				if (config.benchmark) config.benchmark.exclude = withReserved(config.benchmark.exclude);
				if (config.typecheck) config.typecheck.exclude = withReserved(config.typecheck.exclude);
			}
			const pass = off || tier !== "unit" || config.passWithNoTests;
			config.passWithNoTests = pass;
			vitest.config.passWithNoTests = pass;
			if (off) process.stderr.write(`${OFF_NOTICE}\n`);
			const counts = process.env.DRAFTYAK_TEST_COUNTS_DIR;
			if (counts && !counted.has(vitest)) {
				counted.add(vitest);
				vitest.config.reporters.push(countsReporter(counts, tier, optIn, config.root));
			}
		},
	};
}

// Vitest 5 never reads a parent folder's config, so each package's vitest.config.ts returns this.
// This file is outside every package's rootDir: a tsconfig that emits must leave vitest.config.ts
// out (include src/ only, or use a separate tsconfig.build.json). A factory built on it keeps
// base.plugins.
export function vitestConfig(env: ConfigEnv): ViteUserConfig {
	const tier = tierFromMode(env.mode);
	const optIn = reservedTestsOn();
	const otherTiers = [tierFiles.heavy, tierFiles.live, tierFiles.device];
	// Slow Windows CI disks can push SQLite unit transactions past the usual 30 seconds.
	const timeout =
		tier === "unit" && process.platform === "win32" && process.env.CI === "true" ? 90_000 : 30_000;
	const exclude = tier === "unit" ? [...defaultExclude, ...otherTiers] : [...defaultExclude];
	return {
		// No .env loading: live secrets reach tests only through the spike kit.
		envDir: false,
		plugins: [reservedTestsPlugin(tier, optIn)],
		test: {
			include: [PLUGIN_MISSING],
			exclude: optIn ? exclude : [...exclude, ...reservedGlobs],
			// The plugin sets it: the unit tier fails with no test files, except in a reserved folder.
			passWithNoTests: false,
			// Many tests spawn git or a CLI, which can outlast Vitest's 5 s default on 2-core CI runners.
			testTimeout: timeout,
			hookTimeout: timeout,
			// Vitest 5 shares this cache between processes at the workspace root by default; packages
			// tested in parallel on Windows then fail with EPERM on each other's open cache files.
			fsModuleCachePath: path.join(process.cwd(), "node_modules", ".vitest-cache"),
		},
	};
}
