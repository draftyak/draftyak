import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it, vi } from "vitest";
import { acquireBenchLock } from "../../../spikes/kit/lock.ts";
import {
	loadProfiles,
	loadSteps,
	type Step,
	type StepContext,
	type StepOutcome,
} from "../lib/registry.ts";
import type { Captured, RunOptions } from "../lib/spawn.ts";
import { benchLockWait, checkPrerequisites, heavy, m1Profile } from "../profiles/m1.ts";
import { crateManifests, findCargoDeny, step as rust } from "../steps/rust.ts";

const here = path.resolve(import.meta.dirname, "..");
const tmp = mkdtempSync(path.join(tmpdir(), "draftyak-m1-"));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));
const exe = process.platform === "win32" ? ".exe" : "";

function write(file: string, text = ""): void {
	mkdirSync(path.dirname(file), { recursive: true });
	writeFileSync(file, text);
}

let roots = 0;
function fakeRoot(files: Record<string, string> = {}): string {
	const root = path.join(tmp, `root-${++roots}`);
	const all = {
		".node-version": process.versions.node,
		"rust-toolchain.toml": '[toolchain]\nchannel = "1.95.0"\n',
		"tools/verify/package.json": "{}",
		...files,
	};
	for (const [file, text] of Object.entries(all)) write(path.join(root, file), text);
	return root;
}

// Empty stand-ins for the tools, found on PATH by name; capture() answers by that name.
function fakeBin(name: string, tools: readonly string[]): string {
	const bin = path.join(tmp, name);
	for (const tool of tools) write(path.join(bin, `${tool}${exe}`));
	return bin;
}

interface Call {
	readonly command: string;
	readonly args: readonly string[];
	readonly cwd?: string;
}

// capture() answers "<tool> <first argument>" first, then "<tool>"; run() exits with the code
// given for "<tool> <first argument>", else 0.
function context(
	root: string,
	env: NodeJS.ProcessEnv,
	answers: Record<string, string> = {},
	codes: Record<string, number> = {},
): { ctx: StepContext; calls: Call[] } {
	const calls: Call[] = [];
	const name = (command: string): string => path.parse(command).name;
	const capture = async (command: string, args: readonly string[]): Promise<Captured> => {
		const stdout = answers[`${name(command)} ${args[0]}`] ?? answers[name(command)];
		return { code: stdout === undefined ? 1 : 0, stdout: stdout ?? "", stderr: "" };
	};
	const run = async (command: string, args: readonly string[], options?: RunOptions) => {
		calls.push({ command: name(command), args, cwd: options?.cwd });
		return codes[`${name(command)} ${args[0]}`] ?? 0;
	};
	const never = async (): Promise<number> => 1;
	const ctx: StepContext = {
		root,
		env,
		profile: "m1",
		run,
		capture,
		node: never,
		pnpm: never,
		turbo: never,
		biome: never,
	};
	return { ctx, calls };
}

async function quietly<T>(work: () => Promise<T>): Promise<{ result: T; output: string }> {
	const lines: string[] = [];
	const spies = [vi.spyOn(console, "log"), vi.spyOn(console, "error")];
	for (const spy of spies) spy.mockImplementation((...parts) => lines.push(parts.join(" ")));
	try {
		return { result: await work(), output: lines.join("\n") };
	} finally {
		for (const spy of spies) spy.mockRestore();
	}
}

async function runAll(plan: readonly Step[], ctx: StepContext): Promise<StepOutcome[]> {
	const outcomes: StepOutcome[] = [];
	for (const step of plan) outcomes.push(await step.run(ctx));
	return outcomes;
}

const versions = {
	cargo: "cargo 1.95.0 (f2d3ce0bd 2026-03-21)",
	"cargo-deny": "cargo-deny 0.20.2",
	uvx: "uvx 0.13.1 (62faed335 2026-10-13 x86_64-pc-windows-msvc)",
};
const steps = await loadSteps(path.join(here, "steps"));
const lock = path.join(tmp, "bench.lock");

describe("verify:m1", () => {
	it("lists rust in the default, m1 and rust profiles, and only rust in the rust profile", async () => {
		const profiles = await loadProfiles(path.join(here, "profiles"));
		const names = (profile: string): string[] =>
			(profiles.find((each) => each.name === profile)?.select(steps) ?? []).map((s) => s.name);
		expect(["default", "m1"].map((profile) => names(profile).includes("rust"))).toEqual([
			true,
			true,
		]);
		expect(names("rust")).toEqual(["rust"]);
	});

	it("checks prerequisites, waits for the bench lock, then the default steps, heavy tests and adr", () => {
		const known = ["bench-lock", "lint", "typecheck", "test", "rust", "build", "test:heavy", "adr"];
		const names = m1Profile()
			.select(steps)
			.map((step) => step.name);
		expect(names.slice(0, 2)).toEqual(["prerequisites", "bench-lock"]);
		expect(names.filter((name) => known.includes(name))).toEqual([
			"bench-lock",
			"lint",
			"typecheck",
			"test",
			"bench-lock",
			"rust",
			"build",
			"bench-lock",
			"test:heavy",
			"adr",
		]);
	});

	it("names each missing tool, warns about cargo-deny and skips every later step", async () => {
		const plan = m1Profile({ path: lock, timeoutMs: 1_000 }).select(steps);
		const { ctx } = context(fakeRoot(), {});
		const { result, output } = await quietly(() => runAll(plan, ctx));
		expect(result[0]).toEqual({ status: "failed", reason: "missing cargo, uv" });
		const skipped = { status: "skipped", reason: "prerequisites missing" };
		expect(result.slice(1)).toEqual(result.slice(1).map(() => skipped));
		expect(result.length).toBeGreaterThan(5);
		expect(output).toMatch(/ok +node +\d+\.\d+\.\d+, as \.node-version pins/);
		expect(output).toMatch(/missing +cargo +not found on PATH: install Rust with rustup/);
		expect(output).toMatch(/warn +cargo-deny +not on PATH or at DRAFTYAK_CARGO_DENY/);
		expect(output).toMatch(/missing +uv +not found on PATH, in the WinGet folder or DRAFTYAK_UV/);
		expect(existsSync(lock)).toBe(false);
	});

	it("passes with the pinned cargo and uv, and warns about other versions", async () => {
		const root = fakeRoot();
		const deny = path.join(fakeBin("deny-bin", ["cargo-deny"]), `cargo-deny${exe}`);
		const env = { PATH: fakeBin("bin-ok", ["cargo", "uvx"]), DRAFTYAK_CARGO_DENY: deny };
		expect(await checkPrerequisites(root, context(root, env, versions).ctx.capture, env)).toEqual([
			expect.objectContaining({ name: "node", state: "ok" }),
			expect.objectContaining({
				name: "cargo",
				state: "ok",
				detail: expect.stringMatching(/^1\.95\.0 at /),
			}),
			expect.objectContaining({ name: "cargo-deny", state: "ok", detail: `0.20.2 at ${deny}` }),
			expect.objectContaining({ name: "uv", state: "ok" }),
		]);
		const older = {
			...versions,
			cargo: "cargo 1.94.1 (x 2026-02-01)",
			"cargo-deny": "cargo-deny 0.19.0",
		};
		const checks = await checkPrerequisites(root, context(root, env, older).ctx.capture, env);
		expect(checks.filter((check) => check.state !== "ok")).toEqual([
			expect.objectContaining({
				name: "cargo",
				state: "warn",
				detail: expect.stringMatching(/^1\.94\.1 at .*; rust-toolchain\.toml pins 1\.95\.0$/),
			}),
			expect.objectContaining({
				name: "cargo-deny",
				state: "warn",
				detail: expect.stringMatching(/; CI pins 0\.20\.2$/),
			}),
		]);
		const gone = { ...env, DRAFTYAK_CARGO_DENY: path.join(tmp, "nowhere", "cargo-deny") };
		const misconfigured = await checkPrerequisites(
			root,
			context(root, gone, versions).ctx.capture,
			gone,
		);
		expect(misconfigured.find((check) => check.name === "cargo-deny")).toMatchObject({
			state: "missing",
			detail: expect.stringContaining("which doesn't exist"),
		});
	});

	it("waits while a test holds the bench lock, names the holder and gives up after its timeout", async () => {
		const root = fakeRoot();
		const env = { PATH: fakeBin("bin-lock", ["cargo", "uvx"]) };
		const { ctx } = context(root, env, versions);
		const held = await acquireBenchLock({ path: lock, label: "s01 benchmark", idle: false });
		const holder = `s01 benchmark (pid ${process.pid}, since `;
		try {
			const wait = benchLockWait({ path: lock, timeoutMs: 1_000, pollMs: 50 });
			const started = performance.now();
			const { result, output } = await quietly(() => wait.run(ctx));
			expect(performance.now() - started).toBeLessThan(10_000);
			expect(result).toMatchObject({ status: "failed" });
			const reason = (result as { reason: string }).reason;
			expect(reason).toMatch(/ still holds the bench lock after 1 s; rerun once it is done$/);
			expect(reason.startsWith(holder)).toBe(true);
			expect(output).toContain(`verify:m1: waiting up to 1 s for ${holder}`);

			const plan = m1Profile({ path: lock, timeoutMs: 300, pollMs: 50 }).select(steps);
			const outcomes = await quietly(() => runAll(plan, ctx));
			expect(outcomes.result.slice(0, 2).map((outcome) => outcome.status)).toEqual([
				"passed",
				"failed",
			]);
			const skipped = { status: "skipped", reason: "the bench lock is held" };
			expect(outcomes.result.slice(2)).toEqual(outcomes.result.slice(2).map(() => skipped));
		} finally {
			held.release();
		}
		const free = await quietly(() => benchLockWait({ path: lock, timeoutMs: 1_000 }).run(ctx));
		expect(free.result).toEqual({ status: "passed" });
		expect(free.output).toContain("verify:m1: the bench lock is free");
		expect(existsSync(`${lock}.owner`)).toBe(false);
	});

	it("waits again right before the rust step and the heavy tests", async () => {
		const root = fakeRoot();
		const { ctx } = context(root, { PATH: fakeBin("bin-again", ["cargo", "uvx"]) }, versions);
		const plan = m1Profile({ path: lock, timeoutMs: 300, pollMs: 50 }).select(steps);
		const names = plan.map((step) => step.name);
		const beforeRust = names.indexOf("rust") - 1;
		expect([names[beforeRust], names[names.indexOf("test:heavy") - 1]]).toEqual([
			"bench-lock",
			"bench-lock",
		]);
		const start = await quietly(() => runAll(plan.slice(0, 2), ctx));
		expect(start.result).toEqual([{ status: "passed" }, { status: "passed" }]);
		// An M0 benchmark takes the lock while the default steps run.
		const held = await acquireBenchLock({ path: lock, label: "s02 benchmark", idle: false });
		try {
			const { result } = await quietly(() => runAll(plan.slice(beforeRust), ctx));
			expect(result[0]).toMatchObject({
				status: "failed",
				reason: expect.stringMatching(/^s02 benchmark \(pid \d+, since .+\) still holds the /),
			});
			const skipped = { status: "skipped", reason: "the bench lock is held" };
			expect(result.slice(1)).toEqual(result.slice(1).map(() => skipped));
			expect(result.length).toBeGreaterThan(4);
		} finally {
			held.release();
		}
	});

	it("runs heavy suites one at a time with strict skips, for folders that exist", async () => {
		const turbo: { args: readonly string[]; options?: RunOptions }[] = [];
		const record = (root: string): StepContext => ({
			...context(root, {}).ctx,
			turbo: async (args, options) => {
				turbo.push({ args, options });
				return 0;
			},
		});
		const withPackages = fakeRoot({ "packages/protocol/package.json": "{}" });
		expect(await heavy.run(record(withPackages))).toEqual({ status: "passed" });
		expect(await heavy.run(record(fakeRoot()))).toEqual({ status: "passed" });
		const tail = ["--concurrency=1", "--continue=dependencies-successful"];
		const options = { env: { DRAFTYAK_STRICT_SKIPS: "1" } };
		expect(turbo).toEqual([
			{
				args: ["run", "test:heavy", "--filter=./packages/*", "--filter=./tools/verify", ...tail],
				options,
			},
			{ args: ["run", "test:heavy", "--filter=./tools/verify", ...tail], options },
		]);
	});
});

describe("rust step", () => {
	const workspace = {
		"crates/Cargo.toml": "[workspace]\nmembers = ['draftyak-protocol']\n",
		"crates/draftyak-protocol/Cargo.toml": "[package]\nname = 'draftyak-protocol'\n",
	};
	const withProfile = (ctx: StepContext, profile: string): StepContext => ({ ...ctx, profile });
	// cargo metadata --no-deps for a workspace with these members, rooted at crates/ by default.
	const metadata = (root: string, members: readonly string[], at = "crates"): string =>
		JSON.stringify({
			workspace_root: path.join(root, at),
			packages: members.map((dir) => ({ manifest_path: path.join(root, dir, "Cargo.toml") })),
		});
	const answers = (root: string, members = ["crates/draftyak-protocol"]) => ({
		"cargo metadata": metadata(root, members),
		"cargo-deny": "cargo-deny 0.20.2",
	});
	const cargoCalls = (root: string): Call[] =>
		[
			["fmt", "--all", "--check"],
			["clippy", "--workspace", "--all-targets", "--locked", "--", "-D", "warnings"],
			["test", "--workspace", "--locked"],
		].map((args) => ({ command: "cargo", args, cwd: path.join(root, "crates") }));

	it("passes with a note when there's no Cargo.toml under crates/", async () => {
		const { ctx, calls } = context(fakeRoot({ "crates/README.md": "" }), {});
		const { result, output } = await quietly(() => rust.run(ctx));
		expect(result).toEqual({ status: "passed" });
		expect(output).toBe("rust: no Cargo workspaces under crates/");
		expect(calls).toEqual([]);
	});

	it("finds every Cargo.toml under crates/, but not in target/ or hidden folders", () => {
		const root = fakeRoot({
			...workspace,
			"crates/target/debug/build/x/Cargo.toml": "[workspace]\n",
			"crates/.cache/Cargo.toml": "[workspace]\n",
			"crates/other/Cargo.toml": "[package]\nname = 'other'\n",
		});
		expect(crateManifests(root)).toEqual([
			"crates/Cargo.toml",
			"crates/draftyak-protocol/Cargo.toml",
			"crates/other/Cargo.toml",
		]);
	});

	it("checks crates/ whether its manifest says [ workspace ], workspace.members or [package]", async () => {
		const bin = fakeBin("bin-forms", ["cargo"]);
		const forms: [string, Record<string, string>, string[]][] = [
			["[ workspace ]\nmembers = ['a']\n", { "crates/a/Cargo.toml": "[package]\n" }, ["crates/a"]],
			["workspace.members = ['a']\n", { "crates/a/Cargo.toml": "[package]\n" }, ["crates/a"]],
			["[package]\nname = 'one'\n", {}, ["crates"]],
		];
		for (const [manifest, members, ids] of forms) {
			const root = fakeRoot({ "crates/Cargo.toml": manifest, ...members });
			const { ctx, calls } = context(root, { PATH: bin }, answers(root, ids));
			expect((await quietly(() => rust.run(ctx))).result).toEqual({ status: "passed" });
			expect(calls).toEqual(cargoCalls(root));
		}
	});

	it("fails, in every profile, on Cargo.toml files under crates/ without crates/Cargo.toml", async () => {
		const { ctx, calls } = context(fakeRoot({ "crates/a/Cargo.toml": "[package]\n" }), {});
		const outcomes = await Promise.all(
			["default", "m1", "rust"].map((profile) => rust.run(withProfile(ctx, profile))),
		);
		const reason = "no crates/Cargo.toml, the workspace root, for crates/a/Cargo.toml";
		expect(outcomes).toEqual(outcomes.map(() => ({ status: "failed", reason })));
		expect(calls).toEqual([]);
	});

	it("fails on a Cargo.toml under crates/ that isn't a member, or a root above crates/", async () => {
		const root = fakeRoot({ ...workspace, "crates/b/Cargo.toml": "[package]\nname = 'b'\n" });
		const env = { PATH: fakeBin("bin-stray", ["cargo"]) };
		const stray = context(root, env, answers(root));
		expect(await rust.run(stray.ctx)).toEqual({
			status: "failed",
			reason:
				"not members of the crates/ workspace, so nothing builds or tests them: crates/b/Cargo.toml",
		});
		expect(stray.calls).toEqual([]);
		const plain = fakeRoot(workspace);
		const above = context(plain, env, {
			"cargo metadata": metadata(plain, ["crates/draftyak-protocol"], "."),
		});
		expect(await rust.run(above.ctx)).toMatchObject({
			status: "failed",
			reason: expect.stringMatching(/^crates\/Cargo\.toml belongs to the workspace at .+; it must/),
		});
	});

	it("skips without cargo in pnpm verify, and fails without it in verify:m1 and the rust profile", async () => {
		const { ctx } = context(fakeRoot(workspace), {});
		const outcomes = await Promise.all(
			["default", "m0", "m1", "rust"].map((profile) => rust.run(withProfile(ctx, profile))),
		);
		expect(outcomes.map((outcome) => outcome.status)).toEqual([
			"skipped",
			"skipped",
			"failed",
			"failed",
		]);
		expect(outcomes[2]).toMatchObject({
			reason: expect.stringContaining("cargo not found on PATH"),
		});
	});

	it("runs fmt, then cargo-deny where it's installed, then clippy and the tests, from crates/", async () => {
		const root = fakeRoot(workspace);
		const bin = fakeBin("bin-rust", ["cargo"]);
		const plain = context(root, { PATH: bin }, answers(root));
		const { result, output } = await quietly(() => rust.run(plain.ctx));
		expect(result).toEqual({ status: "passed" });
		expect(output).toContain("cargo-deny isn't on PATH or at DRAFTYAK_CARGO_DENY");
		expect(plain.calls).toEqual(cargoCalls(root));

		const deny = path.join(fakeBin("bin-deny", ["cargo-deny"]), `cargo-deny${exe}`);
		const full = context(root, { PATH: bin, DRAFTYAK_CARGO_DENY: deny }, answers(root));
		const checked = await quietly(() => rust.run(full.ctx));
		expect(checked.result).toEqual({ status: "passed" });
		expect(checked.output).toContain(`rust: cargo-deny 0.20.2 at ${deny}`);
		const [fmt, clippy, tests] = cargoCalls(root);
		const check = {
			command: "cargo-deny",
			args: ["--locked", "check"],
			cwd: path.join(root, "crates"),
		};
		expect(full.calls).toEqual([fmt, check, clippy, tests]);
	});

	it("takes DRAFTYAK_CARGO_DENY over PATH, from the repo root when relative", () => {
		const relative = `bin/cargo-deny${exe}`;
		const root = fakeRoot({ [relative]: "" });
		const onPath = fakeBin("bin-path-deny", ["cargo-deny"]);
		expect(findCargoDeny(root, { PATH: onPath, DRAFTYAK_CARGO_DENY: relative })).toEqual({
			file: path.join(root, relative),
		});
		expect(findCargoDeny(root, { PATH: onPath })).toEqual({
			file: path.join(onPath, `cargo-deny${exe}`),
		});
		expect(
			findCargoDeny(root, { PATH: onPath, DRAFTYAK_CARGO_DENY: "nowhere/cargo-deny" }),
		).toEqual({ problem: "DRAFTYAK_CARGO_DENY is nowhere/cargo-deny, which doesn't exist" });
		expect(findCargoDeny(root, {})).toEqual({ file: undefined });
	});

	it("needs cargo-deny in the rust profile, which only CI runs, and only notes it elsewhere", async () => {
		const root = fakeRoot(workspace);
		const { ctx } = context(root, { PATH: fakeBin("bin-no-deny", ["cargo"]) }, answers(root));
		const outcomes = await quietly(() =>
			Promise.all(["default", "m1", "rust"].map((profile) => rust.run(withProfile(ctx, profile)))),
		);
		expect(outcomes.result).toEqual([
			{ status: "passed" },
			{ status: "passed" },
			{
				status: "failed",
				reason: "cargo-deny not found: the rust profile needs DRAFTYAK_CARGO_DENY or PATH",
			},
		]);
	});

	it("stops at the first failing command, and fails on a DRAFTYAK_CARGO_DENY that doesn't exist", async () => {
		const root = fakeRoot(workspace);
		const env = { PATH: fakeBin("bin-fail", ["cargo"]) };
		const failing = context(root, env, answers(root), { "cargo clippy": 101 });
		expect((await quietly(() => rust.run(failing.ctx))).result).toEqual({
			status: "failed",
			reason:
				"cargo clippy --workspace --all-targets --locked -- -D warnings failed in crates (exit code 101)",
		});
		expect(failing.calls.map((call) => call.args[0])).toEqual(["fmt", "clippy"]);
		const broken = context(root, env);
		expect((await quietly(() => rust.run(broken.ctx))).result).toEqual({
			status: "failed",
			reason: "cargo metadata --no-deps --format-version 1 --locked failed in crates (exit code 1)",
		});
		expect(broken.calls).toEqual([]);
		const gone = path.join(tmp, "nowhere", "cargo-deny");
		const missing = context(root, { ...env, DRAFTYAK_CARGO_DENY: gone });
		expect(await rust.run(missing.ctx)).toEqual({
			status: "failed",
			reason: `DRAFTYAK_CARGO_DENY is ${gone}, which doesn't exist`,
		});
		expect(missing.calls).toEqual([]);
	});
});
