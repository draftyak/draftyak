import {
	existsSync,
	lstatSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	realpathSync,
	rmSync,
	symlinkSync,
	unlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { RESERVED_TESTS } from "../../../reserved-tests.ts";
import { gitEnv } from "../../../spikes/kit/repo.ts";
import type { GateResult } from "../lib/gate.ts";
import { capture } from "../lib/spawn.ts";
import { resolveTurbo, telemetryOff } from "../lib/tools.ts";
import { launch, turboMain } from "../turbo.ts";
import { scrub, word } from "./temp-repo.ts";

const root = path.resolve(import.meta.dirname, "..", "..", "..");
const { packageManager } = JSON.parse(readFileSync(path.join(root, "package.json"), "utf8")) as {
	packageManager: string;
};

// The probe fails unless the declared variables arrive and an undeclared one is filtered out.
const probe = `
const seen = {
	strict: process.env.DRAFTYAK_STRICT_SKIPS ?? "missing",
	dnt: process.env.DO_NOT_TRACK ?? "missing",
	undeclared: process.env.DY_TURBO_ENV_UNDECLARED ?? "absent",
};
console.log("probe: " + JSON.stringify(seen));
process.exit(seen.strict === "1" && seen.dnt === "1" && seen.undeclared === "absent" ? 0 : 1);
`;

function write(dir: string, file: string, text: string): void {
	mkdirSync(path.dirname(path.join(dir, file)), { recursive: true });
	writeFileSync(path.join(dir, file), text);
}

describe("turbo env", () => {
	it("passes DRAFTYAK_* and DO_NOT_TRACK to a test:heavy task, and nothing undeclared", async () => {
		const dir = mkdtempSync(path.join(tmpdir(), "draftyak-turbo-env-"));
		try {
			// A one-package workspace under the repo's own turbo.json.
			write(dir, "turbo.json", readFileSync(path.join(root, "turbo.json"), "utf8"));
			const workspace = { name: "turbo-env-probe", private: true, packageManager };
			write(dir, "package.json", JSON.stringify(workspace));
			write(dir, "pnpm-workspace.yaml", "packages:\n  - probe\nverifyDepsBeforeRun: false\n");
			const scripts = { "test:heavy": "node probe.mjs" };
			write(dir, "probe/package.json", JSON.stringify({ name: "probe", private: true, scripts }));
			write(dir, "probe/probe.mjs", probe);

			// Drop the outer turbo's TURBO_* task variables; keep the rest of this process's env.
			const env = Object.fromEntries(
				Object.entries(process.env).filter(([name]) => !name.startsWith("TURBO_")),
			);
			Object.assign(env, telemetryOff, {
				DRAFTYAK_STRICT_SKIPS: "1",
				DY_TURBO_ENV_UNDECLARED: "1",
			});
			const turbo = {
				command: resolveTurbo(root),
				args: ["run", "test:heavy", "--log-prefix=none"],
			};
			const result = await capture(turbo, { cwd: dir, env });
			const output = `${result.stdout}\n${result.stderr}`;
			expect(output).toContain('probe: {"strict":"1","dnt":"1","undeclared":"absent"}');
			expect(result.code, output).toBe(0);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	}, 120_000);
});

// The root launcher's turbo runs, in synthetic workspaces under the repo's own turbo.json,
// reserved-tests.ts and vitest.shared.ts. Each run of a task's script records the mode it saw, so a
// cache replay records nothing. The flag is set only for these synthetic workspaces' runs.
const GATE_ROOT = "DRAFTYAK_GATE_ROOT";
const cached = ["test", "typecheck", "build"] as const;
const uncached = ["test:heavy", "test:live", "test:device"] as const;

type TurboJson = { tasks: Record<string, { env?: string[] }> };

// This process's env without what would change a task's hash or behaviour: an outer turbo's TURBO_*
// variables, Vitest's own, every DRAFTYAK_* setting and the git variables that move a repository.
const clean = gitEnv(
	Object.fromEntries(
		Object.entries(process.env).filter(
			([name]) => !/^(?:TURBO_|VITEST|DRAFTYAK_)|^(?:NODE_ENV|TEST|FORCE_COLOR)$/i.test(name),
		),
	),
);

interface Mode {
	readonly optIn: boolean;
	// DRAFTYAK_GATE_ROOT, the launcher marker, set to the workspace root (the default) or unset.
	readonly marked?: boolean;
}

function workspace(change: (config: TurboJson) => void = () => {}) {
	const base = realpathSync.native(mkdtempSync(path.join(tmpdir(), "draftyak-turbo-split-")));
	const dir = path.join(base, "ws");
	// Outside the workspace, so turbo never hashes it.
	const log = path.join(base, "executions.txt");
	const config = JSON.parse(readFileSync(path.join(root, "turbo.json"), "utf8")) as TurboJson;
	change(config);
	write(dir, "turbo.json", JSON.stringify(config, null, 2));
	for (const file of ["reserved-tests.ts", "vitest.shared.ts"]) {
		write(dir, file, readFileSync(path.join(root, file), "utf8"));
	}
	const manifest = { name: "turbo-split", private: true, type: "module", packageManager };
	write(dir, "package.json", JSON.stringify(manifest));
	write(dir, "pnpm-workspace.yaml", "packages:\n  - packages/*\nverifyDepsBeforeRun: false\n");
	write(dir, ".gitignore", ".turbo\nnode_modules\n");
	// The source of one execution's line, <label>|<flag value or unset>|<marked or unmarked>, for the
	// label's own source.
	const flag = `(process.env.${RESERVED_TESTS} ?? "unset")`;
	const marker = `(process.env.${GATE_ROOT} === undefined ? "unmarked" : "marked")`;
	const append = (label: string): string =>
		`appendFileSync(${JSON.stringify(log)}, [${label}, ${flag}, ${marker}].join("|") + "\\n")`;
	write(
		dir,
		"record.mjs",
		`import { appendFileSync } from "node:fs";\n${append("process.argv[2]")};\n`,
	);
	const record = (label: string): string => `node ../../record.mjs ${label}`;
	const scripts = Object.fromEntries([
		["test", "vitest run"],
		...["typecheck", "build", ...uncached].map((task) => [task, record(task)]),
	]);
	write(
		dir,
		"packages/probe/package.json",
		JSON.stringify({ name: "probe", private: true, scripts }),
	);
	write(
		dir,
		"packages/probe/vitest.config.ts",
		[
			'import type { ConfigEnv, ViteUserConfig } from "vitest/config";',
			'import { vitestConfig } from "../../vitest.shared.ts";',
			"export default (env: ConfigEnv): ViteUserConfig => vitestConfig(env);",
			"",
		].join("\n"),
	);
	write(
		dir,
		"packages/probe/probe.test.ts",
		[
			'import { appendFileSync } from "node:fs";',
			'import { it } from "vitest";',
			`it("records its run", () => ${append('"test"')});`,
			"",
		].join("\n"),
	);
	// A reserved-only package, whose name is built here; its scripts record a label without it.
	const reservedScripts = Object.fromEntries(
		cached.map((task) => [task, record(`reserved-${task}`)]),
	);
	const reserved = { name: "reserved-probe", private: true, scripts: reservedScripts };
	write(dir, `packages/x-${word()}/package.json`, JSON.stringify(reserved));
	const init = capture({ command: "git", args: ["init", "-q"] }, { cwd: dir, env: clean });
	// Vitest and the workspace's vitest/config come from this checkout's install.
	const modules = path.join(dir, "node_modules");
	symlinkSync(path.join(root, "node_modules"), modules, "junction");
	const outputs: string[] = [];
	const envOf = (mode: Mode): NodeJS.ProcessEnv => ({
		...clean,
		...(mode.optIn ? { [RESERVED_TESTS]: "1" } : {}),
		...(mode.marked === false ? {} : { [GATE_ROOT]: dir }),
	});
	// The root launcher's launch(), starting this workspace's turbo; each start's output is kept.
	const started = (argv: readonly string[], env: NodeJS.ProcessEnv): Promise<number> =>
		launch(argv, env, {
			root: dir,
			run: async (invocation, options) => {
				const result = await capture(invocation, options);
				outputs.push(`${result.stdout}\n${result.stderr}`);
				return result.code;
			},
			resolveTurbo: () => resolveTurbo(root),
		});
	return {
		init,
		dir,
		envOf,
		started,
		// How often turbo started.
		turbos: (): number => outputs.length,
		async run(tasks: readonly string[], mode: Mode): Promise<void> {
			const code = await started(["run", ...tasks, "--output-logs=errors-only"], envOf(mode));
			expect(code, scrub(outputs.at(-1) ?? "")).toBe(0);
		},
		// The executions recorded since the last call, then a fresh log.
		executions(): string[] {
			if (!existsSync(log)) return [];
			const lines = readFileSync(log, "utf8").split("\n").filter(Boolean);
			rmSync(log);
			return lines;
		},
		clearCache(): void {
			rmSync(path.join(dir, ".turbo"), { recursive: true, force: true });
		},
		remove(): void {
			// The junction goes on its own first, so removing the workspace never reaches this
			// checkout's node_modules.
			if (lstatSync(modules, { throwIfNoEntry: false })?.isSymbolicLink()) unlinkSync(modules);
			rmSync(base, { recursive: true, force: true, maxRetries: 5 });
		},
	};
}

// The modes each cached task's script ran in, against the modes the runs switched through: one
// execution per switch, none for a repeat, which replays its own mode's entry.
function splitProblems(lines: readonly string[], modes: readonly string[]): string[] {
	return cached.flatMap((task) => {
		const seen = lines
			.filter((line) => line.startsWith(`${task}|`))
			.map((line) => line.split("|")[1]);
		return JSON.stringify(seen) === JSON.stringify(modes)
			? []
			: [`${task}: ran in ${seen.join(", ") || "no mode"}, not ${modes.join(", ")}`];
	});
}

const labelled = (lines: readonly string[], prefix: string): string[] =>
	lines.filter((line) => line.startsWith(prefix)).toSorted();
// <label>|<flag>, without the marker, which every run but an unmarked one sets.
const withoutMarker = (lines: readonly string[]): string[] =>
	lines.map((line) => line.split("|").slice(0, 2).join("|"));

describe("turbo's cache and the reserved-tests mode", () => {
	it("keeps default and opted-in runs, and marked and unmarked runs, apart in both directions", async () => {
		const split = workspace();
		try {
			expect((await split.init).code).toBe(0);
			const off = { optIn: false };
			const on = { optIn: true };
			const reservedRuns = cached.map((task) => `reserved-${task}|1`).toSorted();

			// Default first, then opted in; each repeat replays its own mode's entry.
			for (const mode of [off, on, off, on]) await split.run(cached, mode);
			const first = split.executions();
			expect(splitProblems(first, ["unset", "1"])).toEqual([]);
			expect(labelled(first, "test|")).toEqual(["test|1|marked", "test|unset|marked"]);
			// launch() leaves the reserved package out of the default runs, and keeps it opted in.
			expect(labelled(withoutMarker(first), "reserved-")).toEqual(reservedRuns);

			// Opted in first, then default, from an empty cache.
			split.clearCache();
			for (const mode of [on, off, on, off]) await split.run(cached, mode);
			const second = split.executions();
			expect(splitProblems(second, ["1", "unset"])).toEqual([]);
			expect(labelled(withoutMarker(second), "reserved-")).toEqual(reservedRuns);

			// The marker is hashed into every cached task (test through DRAFTYAK_*): marked and
			// unmarked runs miss each other, either way round, and each repeat replays its own entry.
			// So a launcher never replays what an ungated run left in the cache.
			const unmarked = { ...off, marked: false };
			for (const mode of [unmarked, unmarked]) await split.run(cached, mode);
			expect(split.executions().toSorted()).toEqual(
				cached.map((task) => `${task}|unset|unmarked`).toSorted(),
			);
			split.clearCache();
			for (const mode of [unmarked, off, unmarked, off]) await split.run(cached, mode);
			expect(split.executions().toSorted()).toEqual(
				cached.flatMap((task) => [`${task}|unset|marked`, `${task}|unset|unmarked`]).toSorted(),
			);

			// heavy, live and device are never cached.
			for (let index = 0; index < 2; index++) await split.run(uncached, off);
			expect(labelled(split.executions(), "test:")).toEqual(
				uncached.flatMap((task) => [`${task}|unset|marked`, `${task}|unset|marked`]).toSorted(),
			);
		} finally {
			split.remove();
		}
		expect(existsSync(path.join(root, "node_modules", "vitest", "package.json"))).toBe(true);
	}, 600_000);

	// The launcher's gate runs before turbo starts, outside every task, so it runs on every launch,
	// one whose tasks would all replay from the cache included, and a refusing gate starts no turbo.
	it("runs the input gate before turbo on every launch, one whose every task would replay included", async () => {
		const split = workspace();
		try {
			expect((await split.init).code).toBe(0);
			const gates: string[] = [];
			const passing: GateResult = {
				ok: true,
				lines: [],
				listing: { root: split.dir, entries: [], untracked: [] },
				tracked: [],
			};
			const refusing: GateResult = { ok: false, lines: [], listing: null, tracked: [] };
			const launched = (gate: GateResult): Promise<number> =>
				turboMain(
					["run", ...cached, "--output-logs=errors-only"],
					split.envOf({ optIn: false, marked: false }),
					{
						print: () => {},
						startCheck: () => [],
						gate: async () => {
							gates.push(gate.ok ? "passed" : "refused");
							return gate;
						},
						launch: (argv, env) => split.started(argv, env),
					},
				);
			expect(await launched(passing)).toBe(0);
			expect(split.executions().toSorted()).toEqual(
				cached.map((task) => `${task}|unset|marked`).toSorted(),
			);
			// Every task replays now, and the gate still ran first.
			expect(await launched(passing)).toBe(0);
			expect(split.executions()).toEqual([]);
			const turbos = split.turbos();
			// The same launch, every task in the cache: the refusal stops it before turbo starts.
			expect(await launched(refusing)).toBe(2);
			expect([gates, split.turbos() - turbos, split.executions()]).toEqual([
				["passed", "passed", "refused"],
				0,
				[],
			]);
		} finally {
			split.remove();
		}
	}, 600_000);

	// Mutation case: without the task's env entry in turbo.json, the opted-in run replays the
	// default run's entry, and the split assertion above fails for every task.
	it("fails the split assertion once the mode is no longer hashed", async () => {
		const unhashed = workspace((config) => {
			for (const task of cached) delete config.tasks[task]?.env;
		});
		try {
			expect((await unhashed.init).code).toBe(0);
			for (const mode of [{ optIn: false }, { optIn: true }]) await unhashed.run(cached, mode);
			const lines = unhashed.executions();
			expect(splitProblems(lines, ["unset", "1"])).toHaveLength(cached.length);
			// Each task ran once, in the default run: the opted-in run replayed that entry.
			const own = withoutMarker(lines).filter((line) => /^(?:test|typecheck|build)\|/.test(line));
			expect(own.toSorted()).toEqual(["build|unset", "test|unset", "typecheck|unset"]);
		} finally {
			unhashed.remove();
		}
	}, 600_000);
});
