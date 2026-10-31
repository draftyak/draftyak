import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import {
	RESERVED_TESTS,
	reservedPackageDirs,
	reservedTestsOn,
	reservedTurboArgs,
	withoutReservedTests,
} from "../../reserved-tests.ts";
import { context } from "./lib/context.ts";
import type { GateResult } from "./lib/gate.ts";
import type { Profile } from "./lib/registry.ts";
import type { Invocation, RunOptions } from "./lib/spawn.ts";
import { telemetryOff } from "./lib/tools.ts";
import { STOP_LINE } from "./reserved-tripwire.ts";
import { scrub, word } from "./test/temp-repo.ts";
import { launch } from "./turbo.ts";
import { type Dirs, main, type VerifyDeps } from "./verify.ts";

const tmp = mkdtempSync(path.join(tmpdir(), "draftyak-verify-"));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));
const repoRoot = path.resolve(import.meta.dirname, "..", "..");

function write(dir: string, name: string, source: string): void {
	mkdirSync(path.join(tmp, dir), { recursive: true });
	writeFileSync(path.join(tmp, dir, `${name}.ts`), source);
}

const envCheck =
	"process.exit(process.env.DY_PROBE === '1' && process.env.DO_NOT_TRACK === '1' && process.env.PATH ? 0 : 1)";
// A passing gate's listing root reaches every child as the launcher marker.
const markerCheck = `process.exit(process.env.DRAFTYAK_GATE_ROOT === ${JSON.stringify(repoRoot)} ? 0 : 1)`;
const steps: Record<string, [profiles: string[], run: string]> = {
	pass: [["ok", "all", "skip", "mixed"], `async () => ({ status: "passed" })`],
	fail: [["all", "failing"], `async () => ({ status: "failed", reason: "broken" })`],
	skip: [["skip"], `async () => ({ status: "skipped", reason: "not here" })`],
	incomplete: [
		["incomplete", "mixed", "failing"],
		`async () => ({ status: "incomplete", reason: "needs the opted-in run" })`,
	],
	env: [
		["env"],
		`async (ctx) => (await ctx.node(["-e", ${JSON.stringify(envCheck)}], { env: { DY_PROBE: "1" } })) === 0 ? { status: "passed" } : { status: "failed", reason: "env replaced" }`,
	],
	marker: [
		["marker"],
		`async (ctx) => (await ctx.node(["-e", ${JSON.stringify(markerCheck)}])) === 0 ? { status: "passed" } : { status: "failed", reason: "no marker" }`,
	],
};
for (const [name, [profiles, run]] of Object.entries(steps)) {
	const step = `{ name: "${name}", order: 1, profiles: ${JSON.stringify(profiles)}, run: ${run} }`;
	write("steps", name, `export const step = ${step};\n`);
}
for (const name of ["ok", "all", "skip", "env", "incomplete", "mixed", "failing", "marker"]) {
	const select = `(steps) => steps.filter((step) => step.profiles.includes("${name}"))`;
	write(
		"profiles",
		name,
		`export const profile = { name: "${name}", description: "", select: ${select} };\n`,
	);
}
write(
	"misnamed",
	"other",
	`export const step = { name: "renamed", order: 1, profiles: [], run: async () => ({ status: "passed" }) };\n`,
);

const dirs: Dirs = { steps: path.join(tmp, "steps"), profiles: path.join(tmp, "profiles") };

type Verify = typeof import("./verify.ts");
type Context = typeof import("./lib/context.ts");

// The start check and the input gate passed: routes.test.ts and the real-tree tests run the real
// ones; these cases are about what verify does after them.
const passed: VerifyDeps = {
	startCheck: () => [],
	gate: async (): Promise<GateResult> => ({
		ok: true,
		lines: ["reserved check: stubbed"],
		listing: { root: repoRoot, entries: [], untracked: [] },
		tracked: [],
	}),
};

async function verify(
	argv: string[],
	at: Dirs = dirs,
	entry: Verify["main"] = main,
	deps: VerifyDeps = passed,
): Promise<{ code: number; lines: string[] }> {
	const lines: string[] = [];
	const collect = (...parts: unknown[]): void => {
		lines.push(...parts.join(" ").split("\n"));
	};
	const log = vi.spyOn(console, "log").mockImplementation(collect);
	const error = vi.spyOn(console, "error").mockImplementation(collect);
	try {
		return { code: await entry(argv, at, deps), lines };
	} finally {
		log.mockRestore();
		error.mockRestore();
	}
}

// verify.ts and what it loads, in a folder of their own with one text of one of its files replaced:
// the committed mutation cases. The text must be there exactly once.
let mutants = 0;
async function mutant<T>(changed: string, from: string, to: string, entry: string): Promise<T> {
	const dir = path.join(tmp, `mutant-${++mutants}`);
	const lib = ["bootstrap", "context", "registry", "spawn", "tools"].map((f) => `lib/${f}.ts`);
	for (const file of ["reserved-tests.ts", "verify.ts", ...lib]) {
		const rel = file === "reserved-tests.ts" ? file : `tools/verify/${file}`;
		mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
		writeFileSync(path.join(dir, rel), readFileSync(path.join(repoRoot, rel), "utf8"));
	}
	const target = path.join(dir, "tools", "verify", changed);
	const parts = readFileSync(target, "utf8").split(from);
	if (parts.length !== 2) throw new Error(`${changed} must hold ${JSON.stringify(from)} once`);
	writeFileSync(target, parts.join(to));
	return (await import(pathToFileURL(path.join(dir, "tools", "verify", entry)).href)) as T;
}

// The lines after the gate's check line, which a passing gate prints first.
const afterGate = (lines: readonly string[]): string[] =>
	lines[0]?.startsWith("reserved check: ") === true ? lines.slice(1) : [...lines];

describe("verify", () => {
	it.each([
		[["--profile", "ok"], 0, "verify: 1/1 steps passed"],
		[["--profile", "all"], 1, "verify: 1/2 steps passed"],
		[["--profile", "skip"], 0, "verify: 1/1 steps passed, 1 skipped"],
		[["--profile", "env"], 0, "verify: 1/1 steps passed"],
		[["--", "--profile", "ok"], 0, "verify: 1/1 steps passed"],
		[["--profile", "incomplete"], 3, "verify: 0/1 steps passed, 1 incomplete"],
		[["--profile", "mixed"], 3, "verify: 1/2 steps passed, 1 incomplete"],
		[["--profile", "failing"], 1, "verify: 0/2 steps passed, 1 incomplete"],
	])("%j exits %i and ends with %j", async (argv, code, summary) => {
		const result = await verify(argv);
		expect(result.code).toBe(code);
		expect(result.lines.at(-1)).toBe(summary);
	});

	it.each([
		[
			["--profile", "nope"],
			'verify: unknown profile "nope" (known: all, env, failing, incomplete, marker, mixed, ok, skip)',
		],
		[["--bogus"], "verify: Unknown option '--bogus'"],
		[["--profile", "ok", "extra"], "verify: Unexpected argument 'extra'"],
	])("%j is a usage error (exit 2)", async (argv, error) => {
		const result = await verify(argv);
		expect(result.code).toBe(2);
		expect(afterGate(result.lines)[0]).toContain(error);
	});

	it("refuses a step file whose step has another name (exit 2)", async () => {
		const result = await verify(["--list"], { ...dirs, steps: path.join(tmp, "misnamed") });
		expect(result.code).toBe(2);
		expect(afterGate(result.lines)[0]).toMatch(/other\.ts must export a step named "other"$/);
	});

	it("refuses DRAFTYAK_RESERVED_TESTS other than unset or 1 before any step (exit 2)", async () => {
		vi.stubEnv(RESERVED_TESTS, "yes");
		try {
			const result = await verify(["--profile", "ok"]);
			expect(result).toEqual({
				code: 2,
				lines: [`verify: ${RESERVED_TESTS} must be unset (off) or exactly 1 (on), not "yes"`],
			});
		} finally {
			vi.unstubAllEnvs();
		}
	});

	// Mutation case: the same run, with incomplete steps no longer counted.
	it("returns 0 for an incomplete run once incomplete steps aren't counted", async () => {
		const { main: counted } = await mutant<Verify>(
			"verify.ts",
			"return failed > 0 ? 1 : incomplete > 0 ? 3 : 0;",
			"return failed > 0 ? 1 : 0;",
			"verify.ts",
		);
		expect((await verify(["--profile", "mixed"], dirs, counted)).code).toBe(0);
	});
});

// The start check, then the flag, then the input gate, all before the registry loads the steps.
describe("verify's checks before any step", () => {
	const START =
		"reserved tripwire: 1 start file(s) or folder(s) failed their kind check; nothing was loaded";
	const refusing: GateResult = {
		ok: false,
		lines: ["reserved tripwire: 1 listed path(s) stubbed", STOP_LINE],
		listing: null,
		tracked: [],
	};
	const calls: string[] = [];
	const deps = (gate: GateResult = refusing, start = false): VerifyDeps => ({
		startCheck: () => {
			calls.push("start");
			return start ? [{ rel: "tools/verify/lib/gate.ts", kind: "link" }] : [];
		},
		gate: async () => {
			calls.push("gate");
			return gate;
		},
	});
	afterEach(() => {
		calls.length = 0;
		vi.unstubAllEnvs();
	});

	it("stops at a failed start check with its two lines, before the flag and the gate (exit 1)", async () => {
		vi.stubEnv(RESERVED_TESTS, "yes");
		const result = await verify(["--profile", "ok"], dirs, main, deps(refusing, true));
		expect(result).toEqual({ code: 1, lines: [START, STOP_LINE] });
		expect(calls).toEqual(["start"]);
	});

	it("checks the flag before the gate (exit 2)", async () => {
		vi.stubEnv(RESERVED_TESTS, "yes");
		expect((await verify(["--profile", "ok"], dirs, main, deps())).code).toBe(2);
		expect(calls).toEqual(["start"]);
	});

	it("stops at a refusing gate with its lines, and runs no step, --list included (exit 1)", async () => {
		for (const argv of [["--profile", "ok"], ["--list"]]) {
			const result = await verify(
				argv,
				{ ...dirs, steps: path.join(tmp, "misnamed") },
				main,
				deps(),
			);
			expect(result).toEqual({ code: 1, lines: refusing.lines });
		}
		expect(calls).toEqual(["start", "gate", "start", "gate"]);
	});

	it("prints the usage for --help without a start check or a gate", async () => {
		const result = await verify(["--help"], dirs, main, deps(refusing, true));
		expect([result.code, calls]).toEqual([0, []]);
	});

	it("gives every step's children the marker of a passing gate", async () => {
		expect((await verify(["--profile", "marker"])).code).toBe(0);
	});

	// Mutation case: with the gate's verdict ignored, the same refusing gate runs the steps.
	it("runs the steps behind a refusing gate once its verdict is ignored", async () => {
		const { main: ungated } = await mutant<Verify>(
			"verify.ts",
			"const listing = result?.ok === true ? result.listing : null;",
			"const listing = result?.listing ?? { root: '', entries: [], untracked: [] };",
			"verify.ts",
		);
		const result = await verify(["--profile", "ok"], dirs, ungated, deps());
		expect(result.code).toBe(0);
		expect(result.lines.at(-1)).toBe("verify: 1/1 steps passed");
	});
});

// What each step's children get from verify.
describe("verify's step context", () => {
	const profile: Profile = { name: "probe", description: "", select: () => [] };
	type Started = { invocation: Invocation; options: RunOptions | undefined };
	function recorder(): {
		started: Started[];
		start: (i: Invocation, o?: RunOptions) => Promise<number>;
	} {
		const started: Started[] = [];
		return {
			started,
			start: async (invocation, options) => {
				started.push({ invocation, options });
				return 0;
			},
		};
	}
	// The parent's env with the flag on: the children must not inherit it.
	const optedIn: NodeJS.ProcessEnv = {
		...process.env,
		...withoutReservedTests(process.env),
		[RESERVED_TESTS]: "1",
	};
	const flags = (started: readonly Started[]): boolean[] =>
		started.map(({ options }) => reservedTestsOn(options?.env ?? {}));

	async function everyChild(ctx: ReturnType<typeof context>, env?: NodeJS.ProcessEnv) {
		const options = env === undefined ? undefined : { env };
		await ctx.node(["-e", "0"], options);
		await ctx.run(process.execPath, ["-e", "0"], options);
		await ctx.pnpm(["--version"], options);
		await ctx.biome(["--version"], options);
		await ctx.turbo(["run", "typecheck"], options);
	}

	it("starts no child with the flag unless the call sets it", async () => {
		const { started, start } = recorder();
		const ctx = context(profile, start, optedIn);
		expect(reservedTestsOn(ctx.env)).toBe(true);
		await everyChild(ctx);
		await everyChild(ctx, { [RESERVED_TESTS]: undefined });
		await everyChild(ctx, { [RESERVED_TESTS]: "1" });
		expect(flags(started)).toEqual([...Array(10).fill(false), ...Array(5).fill(true)]);
		expect(started.every(({ options }) => options?.cwd === repoRoot)).toBe(true);
		const flag = `process.stdout.write(process.env.${RESERVED_TESTS} ?? "unset")`;
		const captured = await ctx.capture(process.execPath, ["-e", flag]);
		expect([captured.code, captured.stdout]).toEqual([0, "unset"]);
	});

	// Mutation case: without the strip, the children inherit the parent's flag.
	it("starts children with the parent's flag once the strip is removed", async () => {
		const { context: unstripped } = await mutant<Context>(
			"lib/context.ts",
			"env: { ...env, ...withoutReservedTests(env), ...options?.env },",
			"env: { ...env, ...options?.env },",
			"lib/context.ts",
		);
		const { started, start } = recorder();
		const ctx = unstripped(profile, start, optedIn);
		await ctx.node(["-e", "0"]);
		await ctx.run(process.execPath, ["-e", "0"]);
		expect(flags(started)).toEqual([true, true]);
	});

	// A synthetic workspace with one reserved package; its name is built here.
	const workspace = path.join(tmp, "workspace");
	const reservedDir = `spikes/x-${word()}`;
	for (const dir of ["spikes/plain", reservedDir]) {
		mkdirSync(path.join(workspace, dir), { recursive: true });
		writeFileSync(path.join(workspace, dir, "package.json"), "{}\n");
	}
	writeFileSync(path.join(workspace, "pnpm-workspace.yaml"), "packages:\n  - spikes/*\n");
	const inWorkspace: typeof reservedTurboArgs = (args, env) =>
		reservedTurboArgs(args, env, workspace);
	// Compared whole, printed scrubbed: the filters name reserved packages.
	const same = (got: unknown, want: unknown): string => {
		const [a, b] = [JSON.stringify(got), JSON.stringify(want)];
		return a === b ? "same" : `${scrub(a)} is not ${scrub(b)}`;
	};
	const turboRuns = async (turboArgs?: typeof reservedTurboArgs, env = optedIn) => {
		const { started, start } = recorder();
		const ctx = context(profile, start, env, turboArgs);
		await ctx.turbo(["run", "test", "--", "--silent"]);
		await ctx.turbo(["run", "build"], { env: { [RESERVED_TESTS]: undefined } });
		await ctx.turbo(["run", "test"], { env: { [RESERVED_TESTS]: "1" } });
		return started.map(({ invocation }) => invocation.args);
	};

	it("starts turbo without the reserved packages unless that call's env has the flag on", async () => {
		const off = `--filter=!./${reservedDir}`;
		expect(
			same(await turboRuns(inWorkspace), [
				["run", "test", off, "--", "--silent"],
				["run", "build", off],
				["run", "test"],
			]),
		).toBe("same");
		// The default filter reads the checkout's own packages.
		const real = reservedPackageDirs(repoRoot).map((dir) => `--filter=!./${dir}`);
		const unset = { ...process.env, ...withoutReservedTests(process.env) };
		expect(
			same(await turboRuns(undefined, unset), [
				["run", "test", ...real, "--", "--silent"],
				["run", "build", ...real],
				["run", "test"],
			]),
		).toBe("same");
	});

	// Mutation case: with the filter as identity, the same comparison fails.
	it("starts turbo with the reserved packages once the filter is removed", async () => {
		const identity: typeof reservedTurboArgs = (args) => [...args];
		const off = `--filter=!./${reservedDir}`;
		expect(
			same(await turboRuns(identity), [
				["run", "test", off, "--", "--silent"],
				["run", "build", off],
				["run", "test"],
			]),
		).not.toBe("same");
	});

	it("takes heavyFilters from the profile, and leaves them unset without", () => {
		const gate: Profile = { ...profile, heavyFilters: (root) => [`./x/${path.basename(root)}`] };
		expect(context(gate).heavyFilters).toEqual([`./x/${path.basename(repoRoot)}`]);
		expect("heavyFilters" in context(profile)).toBe(false);
	});
});

// tools/verify/turbo.ts, the root launcher of turbo run.
describe("turbo.ts launch()", () => {
	const root = realpathSync.native(mkdtempSync(path.join(tmpdir(), "draftyak-launch-")));
	afterAll(() => rmSync(root, { recursive: true, force: true }));
	const reservedDir = `spikes/x-${word("-")}`;
	for (const dir of ["spikes/plain", reservedDir]) {
		mkdirSync(path.join(root, dir), { recursive: true });
		writeFileSync(path.join(root, dir, "package.json"), "{}\n");
	}
	writeFileSync(path.join(root, "pnpm-workspace.yaml"), "packages:\n  - spikes/*\n");
	const off = `--filter=!./${reservedDir}`;

	async function launched(
		argv: readonly string[],
		env: NodeJS.ProcessEnv = {},
		args?: typeof reservedTurboArgs,
	) {
		const started: { invocation: Invocation; options: RunOptions | undefined }[] = [];
		const resolved: string[] = [];
		const errors: string[] = [];
		const error = vi.spyOn(console, "error").mockImplementation((...parts) => {
			errors.push(parts.join(" "));
		});
		try {
			const code = await launch(argv, env, {
				root,
				run: async (invocation, options) => {
					started.push({ invocation, options });
					return 7;
				},
				resolveTurbo: (at) => {
					resolved.push(at);
					return "turbo-binary";
				},
				...(args === undefined ? {} : { args }),
			});
			return { code, started, resolved, errors };
		} finally {
			error.mockRestore();
		}
	}
	const argsOf = (run: Awaited<ReturnType<typeof launched>>) =>
		run.started.map(({ invocation }) => invocation.args);

	it("adds the reserved filters before any `--`, and runs turbo from the root with telemetry off", async () => {
		const run = await launched(["run", "test", "--force", "--", "--silent"], { DY_KEEP: "1" });
		expect(run.code).toBe(7);
		expect(scrub(JSON.stringify(argsOf(run)))).toBe(
			scrub(JSON.stringify([["run", "test", "--force", off, "--", "--silent"]])),
		);
		expect(run.started[0]?.invocation.command).toBe("turbo-binary");
		expect(run.started[0]?.options).toEqual({
			cwd: root,
			env: { DY_KEEP: "1", ...telemetryOff },
		});
		expect(run.resolved).toEqual([root]);
	});

	it("drops pnpm's `--` after the task, as before", async () => {
		const run = await launched(["run", "test", "--", "--", "--silent"]);
		expect(scrub(JSON.stringify(argsOf(run)))).toBe(
			scrub(JSON.stringify([["run", "test", off, "--", "--silent"]])),
		);
	});

	it("keeps the reserved packages when the flag is on", async () => {
		const run = await launched(["run", "typecheck", "build"], { [RESERVED_TESTS]: "1" });
		expect(argsOf(run)).toEqual([["run", "typecheck", "build"]]);
	});

	it.each([[["watch", "test"]], [["test"]], [[]]])(
		"refuses %j before turbo is resolved (exit 2)",
		async (argv) => {
			const run = await launched(argv);
			expect([run.code, run.started, run.resolved]).toEqual([2, [], []]);
			expect(run.errors[0]).toMatch(/^only turbo run goes through here\nusage: /);
		},
	);

	it("refuses a flag value other than 1 before turbo is resolved (exit 2)", async () => {
		const run = await launched(["run", "test"], { [RESERVED_TESTS]: "true" });
		expect([run.code, run.started, run.resolved]).toEqual([2, [], []]);
		expect(run.errors).toEqual([
			`${RESERVED_TESTS} must be unset (off) or exactly 1 (on), not "true"`,
		]);
	});

	// Mutation case: with the filter as identity, the spy sees no filter.
	it("starts turbo with the reserved packages once the filter is removed", async () => {
		const run = await launched(["run", "test"], {}, (args) => [...args]);
		expect(argsOf(run).flat().includes(off)).toBe(false);
		expect((await launched(["run", "test"])).started[0]?.invocation.args.includes(off)).toBe(true);
	});
});
