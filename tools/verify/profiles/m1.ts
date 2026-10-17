import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import type { LockHolder } from "../../../spikes/kit/lock.ts";
import {
	fromExitCode,
	type Profile,
	type Step,
	type StepContext,
	type StepOutcome,
	stepsFor,
} from "../lib/registry.ts";
import { findCargoDeny, findOnPath, step as rustStep } from "../steps/rust.ts";
import { findUvx } from "../steps/zizmor.ts";

export interface Check {
	readonly name: string;
	readonly state: "ok" | "missing" | "warn";
	readonly detail: string;
}

type Capture = StepContext["capture"];

async function versionOf(
	capture: Capture,
	file: string,
	root: string,
): Promise<string | undefined> {
	const { code, stdout } = await capture(file, ["--version"], { cwd: root });
	return code === 0 ? /\d+\.\d+\.\d+/.exec(stdout)?.[0] : undefined;
}

async function tool(
	name: string,
	file: string,
	pinned: string,
	pinnedBy: string,
	capture: Capture,
	root: string,
): Promise<Check> {
	const version = await versionOf(capture, file, root);
	if (version === undefined) return { name, state: "missing", detail: `${file} --version failed` };
	const detail = `${version} at ${file}${version === pinned ? "" : `; ${pinnedBy} pins ${pinned}`}`;
	return { name, state: version === pinned ? "ok" : "warn", detail };
}

// cargo runs from the repo root, so rustup picks the toolchain rust-toolchain.toml pins.
export async function checkPrerequisites(
	root: string,
	capture: Capture,
	env: NodeJS.ProcessEnv,
): Promise<Check[]> {
	const node = readFileSync(path.join(root, ".node-version"), "utf8").trim();
	const toolchain = readFileSync(path.join(root, "rust-toolchain.toml"), "utf8");
	const rust = /^channel\s*=\s*"([^"]+)"/m.exec(toolchain)?.[1] ?? "?";
	const checks: Check[] = [
		process.versions.node === node
			? { name: "node", state: "ok", detail: `${node}, as .node-version pins` }
			: {
					name: "node",
					state: "warn",
					detail: `${process.versions.node} runs; .node-version pins ${node}`,
				},
	];
	const cargo = findOnPath("cargo", env);
	checks.push(
		cargo === undefined
			? { name: "cargo", state: "missing", detail: "not found on PATH: install Rust with rustup" }
			: await tool("cargo", cargo, rust, "rust-toolchain.toml", capture, root),
	);
	const deny = findCargoDeny(root, env);
	if (deny.problem !== undefined) {
		checks.push({ name: "cargo-deny", state: "missing", detail: deny.problem });
	} else if (deny.file === undefined) {
		const detail = "not on PATH or at DRAFTYAK_CARGO_DENY: the rust step skips cargo deny check";
		checks.push({ name: "cargo-deny", state: "warn", detail });
	} else {
		const check = await tool("cargo-deny", deny.file, "0.20.2", "CI", capture, root);
		checks.push(check.state === "missing" ? { ...check, state: "warn" } : check);
	}
	const uvx = findUvx(env);
	checks.push(
		uvx === undefined
			? {
					name: "uv",
					state: "missing",
					detail: "not found on PATH, in the WinGet folder or DRAFTYAK_UV",
				}
			: await tool("uv", uvx.command, "0.13.1", "ADR 0001", capture, root),
	);
	return checks;
}

const prerequisites: Step = {
	name: "prerequisites",
	order: 0,
	profiles: [],
	async run(ctx) {
		const checks = await checkPrerequisites(ctx.root, ctx.capture, ctx.env);
		const width = Math.max(...checks.map((check) => check.name.length));
		console.log("verify:m1: prerequisites");
		for (const { state, name, detail } of checks) {
			console.log(`  ${state.padEnd(7)}  ${name.padEnd(width)}  ${detail}`);
		}
		const missing = checks.filter((check) => check.state === "missing").map((check) => check.name);
		if (missing.length === 0) return { status: "passed" };
		console.log("verify:m1: the other steps are skipped; fix the missing prerequisites and rerun");
		return { status: "failed", reason: `missing ${missing.join(", ")}` };
	},
};

export interface BenchWait {
	// The kit's machine-wide lock file, unless a test passes its own.
	readonly path?: string;
	readonly timeoutMs?: number;
	readonly pollMs?: number;
}

const span = (ms: number): string =>
	ms >= 60_000 ? `${Math.round(ms / 6_000) / 10} min` : `${Math.round(ms / 100) / 10} s`;

const holderOf = (holder: LockHolder | null): string =>
	holder ? `${holder.label} (pid ${holder.pid}, since ${holder.since})` : "another run";

function currentHolder(file: string): LockHolder | null {
	try {
		const holder = JSON.parse(readFileSync(`${file}.owner`, "utf8")) as Partial<LockHolder>;
		return typeof holder.pid === "number" && typeof holder.label === "string"
			? (holder as LockHolder)
			: null;
	} catch {
		return null;
	}
}

// M0's benchmarks hold the kit's bench lock and need an idle machine, so a heavy M1 run starts only
// once the lock is free; it takes the lock without the idle check and lets it go at once.
export function benchLockWait(options: BenchWait = {}): Step {
	const timeoutMs = options.timeoutMs ?? 600_000;
	return {
		name: "bench-lock",
		order: 1,
		profiles: [],
		async run() {
			const kit = await import("../../../spikes/kit/lock.ts");
			const file = options.path ?? kit.benchLockPath();
			try {
				const lock = await kit.acquireBenchLock({
					path: file,
					label: "verify:m1",
					timeoutMs,
					pollMs: options.pollMs,
					idle: false,
					onWait: (holder) => {
						const whom = holderOf(holder);
						console.log(
							`verify:m1: waiting up to ${span(timeoutMs)} for ${whom} to release ${file}`,
						);
					},
				});
				lock.release();
				const waited = lock.waitedMs >= 1000 ? ` after ${span(lock.waitedMs)}` : "";
				console.log(`verify:m1: the bench lock is free${waited}`);
				return { status: "passed" };
			} catch (error) {
				if ((error as { code?: unknown }).code !== "machine-busy") throw error;
				const whom = holderOf(currentHolder(file));
				const reason = `${whom} still holds the bench lock after ${span(timeoutMs)}; rerun once it is done`;
				return { status: "failed", reason };
			}
		},
	};
}

export const heavy: Step = {
	name: "test:heavy",
	order: 45,
	profiles: [],
	async run(ctx) {
		// turbo refuses a path filter whose folder doesn't exist.
		const filters = ["packages/*", "plugins/*", "tools/verify"]
			.filter((glob) => existsSync(path.join(ctx.root, glob.replace(/\/\*$/, ""))))
			.map((glob) => `--filter=./${glob}`);
		const args = [
			"run",
			"test:heavy",
			...filters,
			// One suite at a time, as verify:m0 runs them.
			"--concurrency=1",
			"--continue=dependencies-successful",
		];
		return fromExitCode(await ctx.turbo(args, { env: { DRAFTYAK_STRICT_SKIPS: "1" } }));
	},
};

// The prerequisites and the bench-lock wait run first. The wait runs again right before the rust
// step and the heavy tests, as an M0 benchmark may have started since. When a check fails, every
// later step is skipped. A test passes its own lock file and timeout.
export function m1Profile(wait: BenchWait = {}): Profile {
	return {
		name: "m1",
		description:
			"pnpm verify:m1: prerequisites, the default steps, heavy tests with strict skips, pnpm adr; it waits for the bench lock first and before the rust step and the heavy tests",
		select(steps) {
			let blocked: string | undefined;
			const skipped = (): Promise<StepOutcome> =>
				Promise.resolve({ status: "skipped", reason: blocked ?? "" });
			const blocking = (step: Step, reason: string): Step => ({
				...step,
				async run(ctx) {
					if (blocked !== undefined) return skipped();
					try {
						const outcome = await step.run(ctx);
						if (outcome.status === "failed") blocked = reason;
						return outcome;
					} catch (error) {
						blocked = reason;
						throw error;
					}
				},
			});
			const gated = (step: Step): Step => ({
				...step,
				run: (ctx) => (blocked === undefined ? step.run(ctx) : skipped()),
			});
			const lockWait = (order: number): Step =>
				blocking({ ...benchLockWait(wait), order }, "the bench lock is held");
			const adr = steps.filter((step) => step.name === "adr");
			const chosen = [
				...new Set([...stepsFor("default", steps), ...stepsFor("m1", steps), ...adr]),
			];
			const ordered = [
				...chosen.map(gated),
				gated(heavy),
				lockWait(rustStep.order - 0.5),
				lockWait(heavy.order - 0.5),
			].toSorted((a, b) => a.order - b.order || a.name.localeCompare(b.name));
			return [blocking(prerequisites, "prerequisites missing"), lockWait(1), ...ordered];
		},
	};
}

export const profile: Profile = m1Profile();
