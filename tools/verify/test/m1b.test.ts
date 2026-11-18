import {
	lstatSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	realpathSync,
	renameSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it, vi } from "vitest";
import {
	loadProfiles,
	loadSteps,
	type Step,
	type StepContext,
	type StepOutcome,
} from "../lib/registry.ts";
import type { RunOptions } from "../lib/spawn.ts";
import { profile as defaultProfile } from "../profiles/default.ts";
import { m1bProfile } from "../profiles/m1b.ts";

// The lock implementation has its own tests; this profile suite starts no real lock or tool.
vi.mock("../profiles/m1.ts", async (importOriginal) => {
	const actual = await importOriginal<typeof import("../profiles/m1.ts")>();
	return {
		...actual,
		benchLockWait: () => ({
			name: "bench-lock",
			order: 1,
			profiles: [],
			run: async () => ({ status: "passed" as const }),
		}),
	};
});

const here = path.resolve(import.meta.dirname, "..");
const repository = path.resolve(here, "../..");
const temporary = realpathSync.native(mkdtempSync(path.join(tmpdir(), "draftyak-m1b-profile-")));
const extension = process.platform === "win32" ? ".exe" : "";
let fixtures = 0;
afterAll(() => {
	expect(path.dirname(temporary)).toBe(realpathSync.native(tmpdir()));
	expect(path.basename(temporary).startsWith("draftyak-m1b-profile-")).toBe(true);
	expect(lstatSync(temporary).isSymbolicLink()).toBe(false);
	rmSync(temporary, { recursive: true, force: true });
});

function write(root: string, file: string, value: string): void {
	const target = path.join(root, file);
	mkdirSync(path.dirname(target), { recursive: true });
	writeFileSync(target, value);
}
function fixture(
	options: {
		missingCargo?: boolean;
		missingDeny?: boolean;
		missingFile?: string;
		manifest?: Record<string, unknown>;
	} = {},
): { root: string; env: NodeJS.ProcessEnv } {
	const root = path.join(temporary, `fixture-${++fixtures}`);
	const files: Record<string, string> = {
		".node-version": process.versions.node,
		"rust-toolchain.toml": '[toolchain]\nchannel = "1.95.0"\n',
		"crates/Cargo.toml": '[workspace]\nmembers = ["draftyak-transport"]\n',
		"crates/draftyak-transport/Cargo.toml": '[package]\nname = "draftyak-transport"\n',
		"packages/protocol/package.json": "{}",
		"plugins/synthetic/package.json": "{}",
		"tools/verify/package.json": "{}",
		"tools/transport-tests/package.json": JSON.stringify(
			options.manifest ?? {
				name: "@draftyak/transport-tests",
				scripts: { "test:heavy": "vitest run --mode heavy" },
			},
		),
		"tools/transport-tests/test/native.heavy.test.ts": "// synthetic required-wrapper fixture\n",
		"tools/transport-tests/vitest.config.ts": "// synthetic required-wrapper configuration\n",
	};
	for (const [file, value] of Object.entries(files))
		if (file !== options.missingFile) write(root, file, value);
	const bin = path.join(root, "bin");
	mkdirSync(bin, { recursive: true });
	if (!options.missingCargo) write(root, `bin/cargo${extension}`, "");
	if (!options.missingDeny) write(root, `bin/cargo-deny${extension}`, "");
	return { root, env: { PATH: bin, DRAFTYAK_STRICT_SKIPS: "0" } };
}

interface Call {
	readonly kind: "run" | "capture" | "node" | "pnpm" | "turbo" | "biome";
	readonly command: string;
	readonly args: readonly string[];
	readonly env: NodeJS.ProcessEnv;
	readonly cwd?: string;
}
type Phase = "deny" | "fmt" | "clippy" | "transport-test" | "heavy" | "transport-heavy" | "probe";
function phase(call: Call): Phase {
	if (call.kind === "turbo" && call.args.includes("test:heavy"))
		return call.args.includes("--filter=./tools/transport-tests") ? "transport-heavy" : "heavy";
	if (path.parse(call.command).name === "cargo-deny") return "deny";
	if (path.parse(call.command).name === "cargo") {
		if (call.args[0] === "fmt") return "fmt";
		if (call.args[0] === "clippy") return "clippy";
		if (call.args[0] === "test") return "transport-test";
	}
	return "probe";
}
function context(
	input: ReturnType<typeof fixture>,
	failed?: Phase,
	rejected?: Phase,
): { ctx: StepContext; calls: Call[] } {
	const calls: Call[] = [];
	const record = (
		kind: Call["kind"],
		command: string,
		args: readonly string[],
		options?: RunOptions,
	): number => {
		const call: Call = {
			kind,
			command,
			args,
			env: { ...input.env, ...options?.env },
			cwd: options?.cwd,
		};
		calls.push(call);
		if (phase(call) === rejected) throw new Error("synthetic command rejection");
		return phase(call) === failed ? 19 : 0;
	};
	const ctx: StepContext = {
		root: input.root,
		env: input.env,
		profile: "m1b",
		run: async (command, args, options) => record("run", command, args, options),
		capture: async (command, args, options) => ({
			code: record("capture", command, args, options),
			stdout: "synthetic 1.95.0",
			stderr: "",
		}),
		node: async (args, options) => record("node", "node", args, options),
		pnpm: async (args, options) => record("pnpm", "pnpm", args, options),
		turbo: async (args, options) => record("turbo", "turbo", args, options),
		biome: async (args, options) => record("biome", "biome", args, options),
	};
	return { ctx, calls };
}

const actualSteps = await loadSteps(path.join(here, "steps"));
const defaultNames = defaultProfile.select(actualSteps).map((step) => step.name);
interface ObservedDefault {
	readonly name: string;
	readonly profile: string;
	readonly strict: string | undefined;
}
function steps(options: { skipped?: string; probe?: boolean } = {}): {
	all: Step[];
	observed: ObservedDefault[];
} {
	const observed: ObservedDefault[] = [];
	return {
		observed,
		all: actualSteps.map((original) => ({
			...original,
			async run(ctx): Promise<StepOutcome> {
				observed.push({
					name: original.name,
					profile: ctx.profile,
					strict: ctx.env.DRAFTYAK_STRICT_SKIPS,
				});
				if (original.name === options.skipped)
					return { status: "skipped", reason: "synthetic required skip" };
				if (options.probe && original.name === "test") {
					const weakened = { env: { DRAFTYAK_STRICT_SKIPS: "0" } };
					await ctx.run("synthetic-check", [], weakened);
					await ctx.capture("synthetic-check", [], weakened);
					await ctx.node(["synthetic-check"], weakened);
					await ctx.pnpm(["synthetic-check"], weakened);
					await ctx.turbo(["synthetic-check"], weakened);
					await ctx.biome(["synthetic-check"], weakened);
				}
				return { status: "passed" };
			},
		})),
	};
}
async function runAll(
	plan: readonly Step[],
	ctx: StepContext,
): Promise<{ name: string; outcome: StepOutcome }[]> {
	const outcomes = [];
	for (const step of plan) outcomes.push({ name: step.name, outcome: await step.run(ctx) });
	return outcomes;
}
const passed = (outcomes: Awaited<ReturnType<typeof runAll>>): boolean =>
	outcomes.every(({ outcome }) => outcome.status === "passed");

describe("verify:m1b", () => {
	it("registers the real profile and exactly one root command", async () => {
		const source = readFileSync(path.join(repository, "package.json"), "utf8");
		const manifest = JSON.parse(source) as { scripts: Record<string, string> };
		expect(manifest.scripts["verify:m1b"]).toBe("node tools/verify/verify.ts --profile m1b");
		expect([...source.matchAll(/"verify:m1b"\s*:/g)]).toHaveLength(1);
		expect(
			(await loadProfiles(path.join(here, "profiles"))).filter((profile) => profile.name === "m1b"),
		).toHaveLength(1);
	});

	it("runs default checks and the required transport wrapper before reporting a complete gate", async () => {
		const selected = steps();
		const { ctx, calls } = context(fixture());
		const outcomes = await runAll(m1bProfile().select(selected.all), ctx);
		expect(passed(outcomes)).toBe(true);
		expect(selected.observed.map(({ name }) => name).toSorted()).toEqual(defaultNames.toSorted());
		expect(selected.observed.find(({ name }) => name === "rust")?.profile).toBe("rust");
		const wrapper = calls.filter((call) => phase(call) === "transport-heavy");
		expect(wrapper).toHaveLength(1);
		expect(wrapper[0]?.args.filter((argument) => argument.startsWith("--filter="))).toEqual([
			"--filter=./tools/transport-tests",
		]);
		expect(wrapper[0]?.args.includes("--force")).toBe(true);
		for (const call of calls.filter((call) => ["heavy", "transport-heavy"].includes(phase(call)))) {
			expect(call.args.includes("--concurrency=1")).toBe(true);
			expect(call.args.includes("--continue=dependencies-successful")).toBe(true);
			expect(call.env.DRAFTYAK_STRICT_SKIPS).toBe("1");
		}
		const deny = calls.findIndex((call) => phase(call) === "deny");
		expect(deny >= 0 && deny < calls.findIndex((call) => phase(call) === "clippy")).toBe(true);
		for (const name of ["deny", "clippy", "transport-test"] as const) {
			const call = calls.find((entry) => phase(entry) === name);
			expect(call?.args.includes("--locked")).toBe(true);
		}
		const transport = calls.find((call) => phase(call) === "transport-test");
		expect(transport?.args.includes("draftyak-transport")).toBe(true);
		expect(calls.find((call) => phase(call) === "fmt")?.args.includes("--check")).toBe(true);
	});

	it("forces strict skips after inherited and per-command overrides without mutating the parent", async () => {
		const input = fixture();
		const selected = steps({ probe: true });
		const { ctx, calls } = context(input);
		const prior = process.env.DRAFTYAK_STRICT_SKIPS;
		expect(passed(await runAll(m1bProfile().select(selected.all), ctx))).toBe(true);
		expect(selected.observed.every(({ strict }) => strict === "1")).toBe(true);
		expect(calls.every((call) => call.env.DRAFTYAK_STRICT_SKIPS === "1")).toBe(true);
		expect(
			new Set(calls.filter((call) => phase(call) === "probe").map(({ kind }) => kind)).size,
		).toBe(6);
		expect(input.env.DRAFTYAK_STRICT_SKIPS).toBe("0");
		expect(process.env.DRAFTYAK_STRICT_SKIPS).toBe(prior);
	});

	it.each(["cargo", "deny"] as const)("fails before commands when %s is missing", async (tool) => {
		const { ctx, calls } = context(
			fixture({ missingCargo: tool === "cargo", missingDeny: tool === "deny" }),
		);
		const outcomes = await runAll(m1bProfile().select(steps().all), ctx);
		expect(outcomes[0]?.outcome.status).toBe("failed");
		expect(passed(outcomes)).toBe(false);
		expect(calls).toHaveLength(0);
	});

	it.each([
		"crates/Cargo.toml",
		"crates/draftyak-transport/Cargo.toml",
		"tools/transport-tests/package.json",
		"tools/transport-tests/test/native.heavy.test.ts",
		"tools/transport-tests/vitest.config.ts",
	])("fails before commands without the required source %s", async (missingFile) => {
		const { ctx, calls } = context(fixture({ missingFile }));
		const outcomes = await runAll(m1bProfile().select(steps().all), ctx);
		expect(outcomes[0]?.outcome.status).toBe("failed");
		expect(passed(outcomes)).toBe(false);
		expect(calls).toHaveLength(0);
	});

	it.each([
		{ name: "@draftyak/not-the-wrapper", scripts: { "test:heavy": "vitest run --mode heavy" } },
		{ name: "@draftyak/transport-tests", scripts: { "test:heavy": "   " } },
	])("refuses an ineligible transport-wrapper manifest %#", async (manifest) => {
		const { ctx, calls } = context(fixture({ manifest }));
		const outcomes = await runAll(m1bProfile().select(steps().all), ctx);
		expect(outcomes[0]?.outcome.status).toBe("failed");
		expect(calls).toHaveLength(0);
	});

	it("refuses a linked required wrapper directory before any command", async () => {
		const input = fixture();
		const wrapper = path.join(input.root, "tools/transport-tests");
		const target = path.join(temporary, `relocated-wrapper-${fixtures}`);
		renameSync(wrapper, target);
		symlinkSync(target, wrapper, process.platform === "win32" ? "junction" : "dir");
		const { ctx, calls } = context(input);
		const outcomes = await runAll(m1bProfile().select(steps().all), ctx);
		expect(outcomes[0]?.outcome.status).toBe("failed");
		expect(calls).toHaveLength(0);
	});

	it("turns a required skipped default check into failure and blocks later commands", async () => {
		const { ctx, calls } = context(fixture());
		const outcomes = await runAll(m1bProfile().select(steps({ skipped: "test" }).all), ctx);
		expect(outcomes.find(({ name }) => name === "test")?.outcome.status).toBe("failed");
		expect(passed(outcomes)).toBe(false);
		expect(calls).toHaveLength(0);
	});

	it.each(["deny", "fmt", "clippy", "transport-test", "heavy", "transport-heavy"] as const)(
		"fails the gate on a nonzero %s command",
		async (failed) => {
			const { ctx, calls } = context(fixture(), failed);
			const outcomes = await runAll(m1bProfile().select(steps().all), ctx);
			expect(calls.some((call) => phase(call) === failed)).toBe(true);
			expect(outcomes.some(({ outcome }) => outcome.status === "failed")).toBe(true);
			expect(passed(outcomes)).toBe(false);
		},
	);

	it("fails closed when the required wrapper command rejects", async () => {
		const { ctx, calls } = context(fixture(), undefined, "transport-heavy");
		const outcomes = await runAll(m1bProfile().select(steps().all), ctx);
		expect(calls.some((call) => phase(call) === "transport-heavy")).toBe(true);
		expect(outcomes.some(({ outcome }) => outcome.status === "failed")).toBe(true);
	});

	it.each(["missing", "duplicate"] as const)(
		"refuses a %s required default selection",
		async (mode) => {
			const all = steps().all;
			const required = all.find((step) => step.name === "test");
			if (!required) throw new Error("Required default test step is absent");
			const input =
				mode === "missing" ? all.filter((step) => step !== required) : [...all, { ...required }];
			const { ctx, calls } = context(fixture());
			const outcomes = await runAll(m1bProfile().select(input), ctx);
			expect(outcomes[0]?.outcome.status).toBe("failed");
			expect(calls).toHaveLength(0);
		},
	);

	it("does not reuse a prior completed selection to excuse a fresh missing-wrapper run", async () => {
		const profile = m1bProfile();
		const first = context(fixture());
		expect(passed(await runAll(profile.select(steps().all), first.ctx))).toBe(true);
		const fresh = context(fixture());
		const incomplete = profile
			.select(steps().all)
			.filter((step) => step.name !== "transport-heavy");
		const outcomes = await runAll(incomplete, fresh.ctx);
		expect(outcomes.find(({ name }) => name === "m1b-completion")?.outcome.status).toBe("failed");
		expect(passed(outcomes)).toBe(false);
	});

	it("runs later default additions before final completion", async () => {
		let called = false;
		const added: Step = {
			name: "synthetic-late-default",
			order: 1000,
			profiles: ["default"],
			run: async () => {
				called = true;
				return { status: "passed" };
			},
		};
		const { ctx } = context(fixture());
		const outcomes = await runAll(m1bProfile().select([...steps().all, added]), ctx);
		expect(called).toBe(true);
		expect(passed(outcomes)).toBe(true);
		expect(outcomes.at(-1)?.name).toBe("m1b-completion");
	});
});
