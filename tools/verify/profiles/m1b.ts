import { lstatSync, readFileSync, realpathSync } from "node:fs";
import path from "node:path";
import { type Profile, type Step, type StepContext, stepsFor } from "../lib/registry.ts";
import type { RunOptions } from "../lib/spawn.ts";
import { findCargoDeny, findOnPath } from "../steps/rust.ts";
import { type BenchWait, benchLockWait } from "./m1.ts";

const requiredDefaults = ["lint", "vendor-guard", "typecheck", "test", "rust", "build", "zizmor"];
const requiredFiles = [
	"crates/Cargo.toml",
	"crates/draftyak-transport/Cargo.toml",
	"tools/transport-tests/package.json",
	"tools/transport-tests/vitest.config.ts",
	"tools/transport-tests/test/native.heavy.test.ts",
];
const localNames = [
	"m1b-prerequisites",
	"transport",
	"test:heavy",
	"transport-heavy",
	"m1b-completion",
	"m1b-bench-rust",
	"m1b-bench-transport",
	"m1b-bench-heavy",
	"m1b-bench-transport-heavy",
];

function regularFile(root: string, relative: string): boolean {
	try {
		const rootInfo = lstatSync(root);
		if (rootInfo.isSymbolicLink() || !rootInfo.isDirectory()) return false;
		const canonical = realpathSync.native(root);
		let current = root;
		const parts = relative.split("/");
		for (const [index, part] of parts.entries()) {
			current = path.join(current, part);
			const info = lstatSync(current);
			if (
				info.isSymbolicLink() ||
				(index === parts.length - 1 ? !info.isFile() : !info.isDirectory())
			)
				return false;
		}
		return realpathSync.native(current) === path.join(canonical, ...parts);
	} catch {
		return false;
	}
}

function strictContext(ctx: StepContext): StepContext {
	const options = (value?: RunOptions): RunOptions => ({
		...value,
		env: { ...ctx.env, ...value?.env, DRAFTYAK_STRICT_SKIPS: "1" },
	});
	return {
		root: ctx.root,
		profile: ctx.profile,
		env: { ...ctx.env, DRAFTYAK_STRICT_SKIPS: "1" },
		run: (command, args, value) => ctx.run(command, args, options(value)),
		capture: (command, args, value) => ctx.capture(command, args, options(value)),
		node: (args, value) => ctx.node(args, options(value)),
		pnpm: (args, value) => ctx.pnpm(args, options(value)),
		turbo: (args, value) => ctx.turbo(args, options(value)),
		biome: (args, value) => ctx.biome(args, options(value)),
	};
}

/** The executable checks supply no native acceptance or milestone sign-off themselves. */
export function m1bProfile(wait: BenchWait = {}): Profile {
	return {
		name: "m1b",
		description:
			"pnpm verify:m1b: default verification, locked transport checks and strict heavy checks including native stores",
		select(steps) {
			const ordinary = stepsFor("default", steps);
			const names = ordinary.map((step) => step.name);
			const selectionValid =
				requiredDefaults.every((name) => names.includes(name)) &&
				new Set(names).size === names.length &&
				names.every((name) => !localNames.includes(name));

			// A new select() gets new state even when the exported profile object is reused.
			const completed = new Set<string>();
			const expected = [
				...requiredDefaults,
				...names,
				...localNames.filter((name) => name !== "m1b-completion"),
			];
			let blocked: string | undefined;
			let tools: { cargo: string; deny: string } | undefined;
			const required = (step: Step): Step => ({
				...step,
				async run(ctx) {
					if (blocked !== undefined)
						return { status: "failed", reason: `required phase ${blocked} did not pass` };
					try {
						const strict = strictContext(ctx);
						// Reuse the existing branch that requires both Rust tools, including cargo-deny.
						const outcome = await step.run(
							step.name === "rust" ? { ...strict, profile: "rust" } : strict,
						);
						if (outcome.status !== "passed") {
							blocked = step.name;
							return { status: "failed", reason: `required phase ${step.name} did not pass` };
						}
						completed.add(step.name);
						return outcome;
					} catch {
						blocked = step.name;
						return { status: "failed", reason: `required phase ${step.name} did not complete` };
					}
				},
			});
			const prerequisites: Step = {
				name: "m1b-prerequisites",
				order: 0,
				profiles: [],
				async run(ctx) {
					if (!selectionValid)
						return {
							status: "failed",
							reason: "required verification selection is incomplete or duplicated",
						};
					if (requiredFiles.some((file) => !regularFile(ctx.root, file)))
						return { status: "failed", reason: "required native transport source is unavailable" };
					const manifest = JSON.parse(
						readFileSync(path.join(ctx.root, "tools/transport-tests/package.json"), "utf8"),
					) as { name?: unknown; scripts?: Record<string, unknown> };
					const heavy = manifest?.scripts?.["test:heavy"];
					if (
						manifest?.name !== "@draftyak/transport-tests" ||
						typeof heavy !== "string" ||
						heavy.trim() === "" ||
						!regularFile(ctx.root, "tools/transport-tests/package.json")
					)
						return { status: "failed", reason: "required native transport wrapper is unavailable" };
					const cargo = findOnPath("cargo", ctx.env);
					const deny = findCargoDeny(ctx.root, ctx.env);
					if (!cargo || !deny.file || deny.problem)
						return { status: "failed", reason: "cargo and cargo-deny are required" };
					tools = { cargo, deny: deny.file };
					return { status: "passed" };
				},
			};
			const tail = Math.max(0, ...ordinary.map((step) => step.order)) + 10;
			const transport: Step = {
				name: "transport",
				order: tail,
				profiles: [],
				async run(ctx) {
					if (!tools)
						return { status: "failed", reason: "native transport tools were not admitted" };
					const commands = [
						{ file: tools.deny, args: ["--locked", "check"] },
						{
							file: tools.cargo,
							args: ["fmt", "--all", "--manifest-path", "Cargo.toml", "--check"],
						},
						{
							file: tools.cargo,
							args: [
								"clippy",
								"--locked",
								"--manifest-path",
								"Cargo.toml",
								"--all-targets",
								"--",
								"-D",
								"warnings",
							],
						},
						{
							file: tools.cargo,
							args: [
								"test",
								"--locked",
								"--manifest-path",
								"Cargo.toml",
								"-p",
								"draftyak-transport",
							],
						},
					];
					for (const { file, args } of commands) {
						const code = await ctx.run(file, args, { cwd: path.join(ctx.root, "crates") });
						if (code !== 0)
							return { status: "failed", reason: `transport check failed (exit ${code})` };
					}
					return { status: "passed" };
				},
			};
			const heavy = (name: string, order: number, filters: readonly string[]): Step => ({
				name,
				order,
				profiles: [],
				async run(ctx) {
					const code = await ctx.turbo(
						[
							"run",
							"test:heavy",
							...filters,
							"--concurrency=1",
							"--continue=dependencies-successful",
							"--force",
						],
						{ env: { DRAFTYAK_STRICT_SKIPS: "1" } },
					);
					return code === 0
						? { status: "passed" }
						: { status: "failed", reason: `strict heavy checks failed (exit ${code})` };
				},
			});
			const lock = (name: string, order: number): Step => ({ ...benchLockWait(wait), name, order });
			const selected = [
				prerequisites,
				...ordinary.flatMap((step) =>
					step.name === "rust" ? [lock("m1b-bench-rust", step.order - 0.5), step] : [step],
				),
				lock("m1b-bench-transport", tail - 0.5),
				transport,
				lock("m1b-bench-heavy", tail + 9.5),
				heavy("test:heavy", tail + 10, [
					"--filter=./packages/*",
					"--filter=./plugins/*",
					"--filter=./tools/verify",
				]),
				lock("m1b-bench-transport-heavy", tail + 10.5),
				heavy("transport-heavy", tail + 11, ["--filter=./tools/transport-tests"]),
			];
			const completion: Step = {
				name: "m1b-completion",
				order: tail + 20,
				profiles: [],
				async run() {
					return expected.every((name) => completed.has(name))
						? { status: "passed" }
						: {
								status: "failed",
								reason: "M1b verification did not complete every required phase",
							};
				},
			};
			return [...selected.map(required), completion];
		},
	};
}

export const profile: Profile = m1bProfile();
