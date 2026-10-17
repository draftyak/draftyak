import { mkdtempSync, rmSync, symlinkSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { ConfigEnv, TestTagDefinition, ViteUserConfig } from "vitest/config";
import {
	experimental_getRunnerTask,
	type Reporter,
	type TestSpecification,
	type Vitest,
	type VitestPluginContext,
} from "vitest/node";
import { type Tier, tierFromMode, vitestConfig } from "../../vitest.shared.ts";
import { linuxContainers } from "./docker.ts";
import { strictSkips } from "./skip.ts";

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

const on =
	(...platforms: NodeJS.Platform[]): (() => boolean) =>
	() =>
		platforms.includes(process.platform);

// A test tagged requires:<name> is skipped where <name> is missing, strict skips or not: it runs on
// hosts that have it (Developer Mode, windows-2025, xvfb). OS-only cases use the OS tags, not skipIf.
export const capabilities: Readonly<Record<string, Capability>> = {
	"symlink-privilege": {
		description: "creating symlinks (Windows: Developer Mode or an elevated runner)",
		detect: canSymlink,
	},
	"tauri-desktop": {
		description: "a desktop session (Linux: DISPLAY or WAYLAND_DISPLAY)",
		detect: () =>
			process.platform !== "linux" || !!(process.env.DISPLAY || process.env.WAYLAND_DISPLAY),
	},
	docker: {
		description: "Linux containers (Docker Desktop or a Linux engine); tests call needDocker()",
		detect: () => linuxContainers(),
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

// Each spike's vitest.config.ts returns this: M0.1's tiers (--mode), requires: tags, tier timeouts
// and, for the heavy tier, strict skips.
export function spikeVitestConfig(
	env: ConfigEnv,
	options: {
		readonly capabilities?: Readonly<Record<string, Capability>>;
		readonly env?: NodeJS.ProcessEnv;
	} = {},
): ViteUserConfig {
	const base = vitestConfig(env);
	const tier = tierFromMode(env.mode);
	const tags: TestTagDefinition[] = Object.entries({
		...capabilities,
		...options.capabilities,
	}).map(([name, capability]) => ({
		name: `requires:${name}`,
		description: capability.description,
		// Vitest applies a test's tags in order, so a present capability's skip: false would un-skip a
		// test that also needs a missing one.
		...(capability.detect() ? {} : { skip: true }),
	}));
	const routed = new Set(tags.filter((tag) => tag.skip).map((tag) => tag.name));
	const strict = strictSkips(options.env ?? process.env) && tier === "heavy";
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
