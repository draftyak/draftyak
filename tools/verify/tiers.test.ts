import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	RESERVED_TESTS,
	reservedGlobs,
	reservedWord,
	workspacePackageDirs,
} from "../../reserved-tests.ts";
import { PLUGIN_MISSING, type Tier, tierFiles, vitestConfig } from "../../vitest.shared.ts";
import { literals } from "./lib/imports.ts";

const root = path.resolve(import.meta.dirname, "..", "..");
const config = (mode: string, flag?: string) => {
	vi.stubEnv(RESERVED_TESTS, flag);
	try {
		return vitestConfig({ command: "serve", mode });
	} finally {
		vi.unstubAllEnvs();
	}
};
const pluginNames = (mode: string, flag?: string) =>
	(config(mode, flag).plugins ?? []).map((plugin) => (plugin as { name?: string }).name);

interface TurboTask {
	readonly cache?: boolean;
	readonly env?: readonly string[];
	readonly passThroughEnv?: readonly string[];
	readonly inputs?: readonly string[];
}
interface TurboConfig {
	readonly globalDependencies?: readonly string[];
	readonly globalPassThroughEnv?: readonly string[];
	readonly tasks?: Readonly<Record<string, TurboTask>>;
}
const turboConfig = (dir: string): TurboConfig =>
	JSON.parse(readFileSync(path.join(root, dir, "turbo.json"), "utf8")) as TurboConfig;
const turbo = turboConfig("");

describe("test tiers", () => {
	afterEach(() => {
		vi.unstubAllEnvs();
	});

	it("runs only unit tests by default and never loads .env files", () => {
		vi.stubEnv("CI", "");
		const { envDir, test } = config("test");
		expect(envDir).toBe(false);
		// The tier's glob and passWithNoTests arrive through draftyak:reserved-tests; test/
		// reserved-tests.test.ts runs real Vitest to prove them.
		expect(test).toMatchObject({
			include: [PLUGIN_MISSING],
			passWithNoTests: false,
			testTimeout: 30_000,
			hookTimeout: 30_000,
		});
		expect(test?.exclude).toEqual(
			expect.arrayContaining([tierFiles.heavy, tierFiles.live, tierFiles.device]),
		);
	});

	it("keeps Vitest's module cache inside the package, never at the workspace root", () => {
		expect(config("test").test?.fsModuleCachePath).toBe(
			path.join(process.cwd(), "node_modules", ".vitest-cache"),
		);
	});

	it.each<Tier>(["heavy", "live", "device"])(
		"--mode %s leaves out no file of its own tier",
		(tier) => {
			const { test } = config(tier);
			expect(test).toMatchObject({ include: [PLUGIN_MISSING], testTimeout: 30_000 });
			expect(test?.exclude).not.toContain(tierFiles[tier]);
		},
	);

	it("leaves reserved paths out of every tier unless the flag is exactly 1", () => {
		for (const mode of ["test", "heavy", "live", "device"]) {
			expect(config(mode).test?.exclude, mode).toEqual(expect.arrayContaining([...reservedGlobs]));
			const optIn = config(mode, "1").test?.exclude ?? [];
			expect(
				reservedGlobs.filter((glob) => optIn.includes(glob)),
				mode,
			).toEqual([]);
			expect([pluginNames(mode), pluginNames(mode, "1")], mode).toEqual([
				["draftyak:reserved-tests"],
				["draftyak:reserved-tests"],
			]);
		}
	});

	it.each(["", "0", "true", "yes", " 1", "1 ", "01", "on"])(
		"refuses the flag value %j when a config loads",
		(value) => {
			expect(() => config("test", value)).toThrow(`${RESERVED_TESTS} must be unset (off)`);
		},
	);

	it("refuses an unknown mode", () => {
		expect(() => config("production")).toThrow('unknown test tier "production"');
	});

	// test/turbo-env.heavy.test.ts runs turbo to prove the cache split this declares.
	it("hashes the flag into the cached unit task, and never caches heavy, live or device", () => {
		const hashed = (task: string) =>
			(turbo.tasks?.[task]?.env ?? []).some((name) =>
				new RegExp(`^${name.replaceAll("*", ".*")}$`).test(RESERVED_TESTS),
			);
		expect(["test", "test:heavy", "test:live", "test:device"].map(hashed)).toEqual([
			true,
			true,
			true,
			true,
		]);
		expect(turbo.tasks?.test?.cache).not.toBe(false);
		expect(
			["test:heavy", "test:live", "test:device"].map((task) => turbo.tasks?.[task]?.cache),
		).toEqual([false, false, false]);
		expect(turbo.globalDependencies).toEqual(
			expect.arrayContaining(["reserved-tests.ts", "vitest.shared.ts"]),
		);
	});

	// A reserved spike's typecheck and build go through the kit, which checks the flag: hashing it
	// keeps a default run's cached result from standing in for an opted-in one. The launcher marker
	// is hashed too (the case below).
	it("hashes the flag into typecheck and build, and passes the typecheck marks folder through unhashed", () => {
		expect([turbo.tasks?.typecheck?.env, turbo.tasks?.build?.env]).toEqual([
			[RESERVED_TESTS, "DRAFTYAK_GATE_ROOT"],
			[RESERVED_TESTS, "DRAFTYAK_GATE_ROOT"],
		]);
		expect([turbo.tasks?.typecheck?.passThroughEnv, turbo.tasks?.build?.passThroughEnv]).toEqual([
			["DRAFTYAK_TYPECHECK_MARKS"],
			undefined,
		]);
	});

	// The launchers set DRAFTYAK_GATE_ROOT after their input gate passed, and the kit trusts it
	// in their tasks. Every task gets it, and every cached task hashes it (test through DRAFTYAK_*),
	// so a gated and an ungated run never share a cache entry: a launcher never replays the output of
	// a typecheck, build or test that ran ungated. The kit loads lib/bootstrap.ts in-process, so a
	// change to it misses every cached task.
	it("passes the launcher marker to every task, hashes it into every cached task, and hashes bootstrap.ts", () => {
		const marker = "DRAFTYAK_GATE_ROOT";
		expect(turbo.globalPassThroughEnv).toContain(marker);
		const hashed = (task: string) =>
			(turbo.tasks?.[task]?.env ?? []).some((name) =>
				new RegExp(`^${name.replaceAll("*", ".*")}$`).test(marker),
			);
		expect(["test", "test:heavy", "typecheck", "build"].map(hashed)).toEqual([
			true,
			true,
			true,
			true,
		]);
		expect(turbo.globalDependencies).toContain("tools/verify/lib/bootstrap.ts");
	});

	// The kit's tests load tools/verify modules, so a cached kit result must miss when one changes:
	// each file outside the kit that a kit module loads, or tsc reads for it, is hashed.
	it("hashes into the kit's test and typecheck every file outside the kit that its modules load", () => {
		const kit = "spikes/kit";
		const modules = /\.[cm]?ts$/;
		const own = (dir: string): string[] =>
			readdirSync(path.join(root, dir), { withFileTypes: true }).flatMap((entry) => {
				const rel = `${dir}/${entry.name}`;
				if (entry.name === "node_modules" || reservedWord.test(rel)) return [];
				if (entry.isDirectory()) return own(rel);
				return modules.test(entry.name) ? [rel] : [];
			});
		const seen = new Set<string>();
		const visit = (rel: string): void => {
			if (seen.has(rel)) return;
			seen.add(rel);
			if (reservedWord.test(rel) || !modules.test(rel) || !existsSync(path.join(root, rel))) return;
			for (const { value, kind } of literals(readFileSync(path.join(root, rel), "utf8"))) {
				if (kind !== "other" && value.startsWith(".")) {
					visit(path.posix.normalize(path.posix.join(path.posix.dirname(rel), value)));
				}
			}
		};
		for (const file of own(kit)) visit(file);
		const outside = [...seen].filter((rel) => !rel.startsWith(`${kit}/`));
		expect(outside).toContain("tools/verify/lib/proof.ts");
		const configured = existsSync(path.join(root, kit, "turbo.json"));
		const tasks = (configured ? turboConfig(kit).tasks : undefined) ?? {};
		const at = "$TURBO_ROOT$/";
		const hashed = (task: string, rel: string): boolean =>
			(turbo.globalDependencies ?? []).includes(rel) ||
			(tasks[task]?.inputs ?? []).some(
				(glob) => glob.startsWith(at) && path.posix.matchesGlob(rel, glob.slice(at.length)),
			);
		expect(["test", "typecheck"].map((task) => tasks[task]?.inputs?.[0])).toEqual([
			"$TURBO_DEFAULT$",
			"$TURBO_DEFAULT$",
		]);
		expect(
			["test", "typecheck"].map((task) => outside.filter((rel) => !hashed(task, rel))),
		).toEqual([[], []]);
	});

	// turbo's strict env mode drops what no setting names, and cmd.exe then searches the task's
	// working folder before PATH for a bare command.
	it("passes the Windows command-search setting to every task", () => {
		expect(turbo.globalPassThroughEnv).toContain("NoDefaultCurrentDirectoryInExePath");
	});

	// A package's env or passThroughEnv for a task takes the place of the root's, so both stay with
	// the root turbo.json. The one package setting is the Python runtime spike's pass-through of the
	// three Actions context names its heavy timing route reads: for a task that is never cached and
	// whose root definition passes nothing through, it replaces and hashes nothing.
	it("leaves every task's env and passThroughEnv to the root turbo.json, but one uncached pass-through", () => {
		const packages = workspacePackageDirs(root).filter(
			(dir) => !reservedWord.test(dir) && existsSync(path.join(root, dir, "turbo.json")),
		);
		expect(packages.length).toBeGreaterThan(1);
		const overrides = packages.flatMap((dir) =>
			Object.entries(turboConfig(dir).tasks ?? {})
				.filter(([, task]) => "env" in task || "passThroughEnv" in task)
				.map(([name, task]) => [`${dir}#${name}`, task] as const),
		);
		expect(overrides).toEqual([
			[
				"spikes/s11-python-runtime#test:heavy",
				{ passThroughEnv: ["GITHUB_ACTIONS", "GITHUB_WORKFLOW", "GITHUB_JOB"] },
			],
		]);
		expect(turbo.tasks?.["test:heavy"]).toMatchObject({ cache: false, env: ["DRAFTYAK_*"] });
		expect(turbo.tasks?.["test:heavy"]?.passThroughEnv).toBeUndefined();
	});
});
