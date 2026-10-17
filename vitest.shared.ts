import { mkdtempSync, rmSync, statSync, symlinkSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
	type ConfigEnv,
	defaultExclude,
	type TestTagDefinition,
	type ViteUserConfig,
} from "vitest/config";
import {
	experimental_getRunnerTask,
	type Reporter,
	type TestSpecification,
	type Vitest,
	type VitestPluginContext,
} from "vitest/node";

export type Tier = "unit" | "heavy" | "live" | "device";

export const tierFiles: Readonly<Record<Tier, string>> = {
	unit: "**/*.test.ts",
	heavy: "**/*.heavy.test.ts",
	live: "**/*.live.test.ts",
	device: "**/*.device.test.ts",
};

// The tier is Vitest's --mode (default "test" = unit): a plain flag, the same in every shell.
export function tierFromMode(mode: string): Tier {
	if (mode === "test") return "unit";
	if (mode === "heavy" || mode === "live" || mode === "device") return mode;
	throw new Error(`unknown test tier "${mode}": use --mode heavy, live or device`);
}

// Vitest 5 never reads a parent folder's config, so each package's vitest.config.ts returns this.
// This file is outside every package's rootDir: a tsconfig that emits must leave vitest.config.ts
// out (include src/ only, or use a separate tsconfig.build.json).
export function vitestConfig(env: ConfigEnv): ViteUserConfig {
	const tier = tierFromMode(env.mode);
	const otherTiers = [tierFiles.heavy, tierFiles.live, tierFiles.device];
	return {
		// No .env loading: live secrets reach tests only through the spike kit.
		envDir: false,
		test: {
			include: [tierFiles[tier]],
			exclude: tier === "unit" ? [...defaultExclude, ...otherTiers] : defaultExclude,
			passWithNoTests: tier !== "unit",
			// Many tests spawn git or a CLI, which can outlast Vitest's 5 s default on 2-core CI runners.
			testTimeout: 30_000,
			hookTimeout: 30_000,
		},
	};
}

// Product packages (packages/, plugins/) may not import spikes, so heavyVitestConfig copies the
// spike kit's requires: tags, tier timeouts and strict skips (spikes/kit/vitest.ts); keep the
// shared tags behaving as the kit's do.
export interface Capability {
	readonly description: string;
	readonly detect: () => boolean;
}

function canSymlink(): boolean {
	const dir = mkdtempSync(path.join(os.tmpdir(), "draftyak-symlink-"));
	try {
		symlinkSync(dir, path.join(dir, "link"), "dir");
		return true;
	} catch {
		return false;
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
}

function onPath(name: string): boolean {
	const file = process.platform === "win32" ? `${name}.exe` : name;
	return (process.env.PATH ?? "")
		.split(path.delimiter)
		.filter((dir) => dir !== "")
		.some((dir) => {
			try {
				return statSync(path.join(dir, file)).isFile();
			} catch {
				return false;
			}
		});
}

const on =
	(...platforms: NodeJS.Platform[]): (() => boolean) =>
	() =>
		platforms.includes(process.platform);

// A test tagged requires:<name> is skipped where <name> is missing, strict skips or not. OS-only
// cases use the OS tags, not skipIf: a static skip fails a strict heavy run.
export const heavyCapabilities: Readonly<Record<string, Capability>> = {
	cargo: {
		description: "cargo on PATH, for the Rust side of cross-language tests",
		detect: () => onPath("cargo"),
	},
	"symlink-privilege": {
		description: "creating symlinks (Windows: Developer Mode or an elevated runner)",
		detect: canSymlink,
	},
	windows: { description: "Windows", detect: on("win32") },
	linux: { description: "Linux", detect: on("linux") },
	macos: { description: "macOS", detect: on("darwin") },
	posix: { description: "Linux or macOS", detect: on("linux", "darwin") },
};

const timeouts: Readonly<Record<Tier, number | undefined>> = {
	unit: undefined,
	heavy: 300_000,
	live: 600_000,
	device: 600_000,
};

// verify:m1 sets DRAFTYAK_STRICT_SKIPS=1. Any value but 1, 0 or empty is refused, so a "true" in a
// workflow can't turn strictness off.
function strictSkips(env: NodeJS.ProcessEnv): boolean {
	const value = env.DRAFTYAK_STRICT_SKIPS ?? "";
	if (value === "1" || value === "" || value === "0") return value === "1";
	throw new Error(`DRAFTYAK_STRICT_SKIPS is 1 (strict) or 0, not "${value}"`);
}

// Vitest's partial runs (line, id, name and tag filters, .only) skip what they leave out, so there
// only skips decided while a test ran count.
const partial = (spec: TestSpecification): boolean =>
	[spec.testLines, spec.testIds, spec.testTagsFilter].some((list) => !!list?.length) ||
	!!spec.testNamePattern;

// With DRAFTYAK_STRICT_SKIPS=1, a skipped heavy test fails the run unless a requires: tag routed it.
function strictSkipsReporter(vitest: Vitest, routed: ReadonlySet<string>): Reporter {
	const filtered = new Set<string>();
	return {
		onTestRunStart(specifications) {
			for (const spec of specifications) if (partial(spec)) filtered.add(spec.moduleId);
		},
		onTestRunEnd(modules, _errors, reason) {
			if (reason === "interrupted") return;
			const everywhere = !!vitest.getGlobalTestNamePattern() || !!vitest.config.tagsFilter?.length;
			const skipped = modules.flatMap((module) => {
				const task = experimental_getRunnerTask(module) as { containsOnly?: boolean };
				const partly = everywhere || !!task.containsOnly || filtered.has(module.moduleId);
				return [...module.children.allTests("skipped")]
					.filter((test) => test.options.mode !== "todo")
					.filter((test) => !test.tags.some((tag) => routed.has(tag)))
					.filter((test) => !partly || test.options.mode === "run")
					.map((test) => `  ${module.relativeModuleId} > ${test.fullName}\n`);
			});
			if (skipped.length === 0) return;
			process.exitCode = 1;
			const head = `strict skips (DRAFTYAK_STRICT_SKIPS=1): ${skipped.length} heavy test(s) skipped`;
			process.stderr.write(`\n${head} instead of running:\n${skipped.join("")}`);
		},
	};
}

// The vitest.config.ts of a product package with heavy tests returns this: the tiers above,
// requires: tags (heavyCapabilities plus the package's own), tier timeouts and, for the heavy tier,
// strict skips.
export function heavyVitestConfig(
	env: ConfigEnv,
	capabilities: Readonly<Record<string, Capability>> = {},
): ViteUserConfig {
	const base = vitestConfig(env);
	const tier = tierFromMode(env.mode);
	const tags: TestTagDefinition[] = Object.entries({ ...heavyCapabilities, ...capabilities }).map(
		([name, capability]) => ({
			name: `requires:${name}`,
			description: capability.description,
			// Vitest applies a test's tags in order, so a present capability's skip: false would un-skip a
			// test that also needs a missing one.
			...(capability.detect() ? {} : { skip: true }),
		}),
	);
	const routed = new Set(tags.filter((tag) => tag.skip).map((tag) => tag.name));
	const strict = strictSkips(process.env) && tier === "heavy";
	const timeout = timeouts[tier];
	return {
		...base,
		// configureVitest runs before Vitest creates its reporters, so the strict one joins Vitest's
		// defaults (github-actions in CI) and whatever --reporter names instead of replacing them.
		plugins: strict
			? [
					{
						name: "draftyak:strict-skips",
						configureVitest({ vitest }: VitestPluginContext) {
							vitest.config.reporters.push(strictSkipsReporter(vitest, routed));
						},
					},
				]
			: [],
		test: {
			...base.test,
			tags,
			...(timeout === undefined ? {} : { testTimeout: timeout, hookTimeout: timeout }),
		},
	};
}
