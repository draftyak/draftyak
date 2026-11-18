import { readFileSync } from "node:fs";
import path from "node:path";
import {
	type Profile,
	type Step,
	type StepContext,
	type StepOutcome,
	stepsFor,
} from "../lib/registry.ts";

const selections = ["--filter=@draftyak/verify", "--filter=!@draftyak/verify"] as const;
const unsupported = "Windows test partition no longer matches the default test step";

function hasHubTests(root: string): boolean {
	try {
		const manifest = JSON.parse(readFileSync(path.join(root, "apps/hub/package.json"), "utf8")) as {
			name?: unknown;
			scripts?: { test?: unknown };
		};
		return (
			manifest?.name === "@draftyak/hub" &&
			typeof manifest.scripts?.test === "string" &&
			manifest.scripts.test.trim() !== ""
		);
	} catch {
		return false;
	}
}

// Keep the default callback, including its policy-first ordering and failure handling. The
// checked adapter intersects each of its two selections with this profile's test partition.
export function partitionTests(
	steps: readonly Step[],
	partition: "hub" | "other",
): readonly Step[] {
	const tests = stepsFor("default", steps).filter((step) => step.name === "test");
	if (tests.length !== 1) throw new Error(unsupported);
	const original = tests[0];
	if (original === undefined) throw new Error(unsupported);
	return [
		{
			...original,
			async run(ctx) {
				if (!hasHubTests(ctx.root)) {
					return { status: "failed", reason: "Hub test workspace is missing or unsupported" };
				}
				let count = 0;
				let invalid = false;
				let active = false;
				let executionFailed = false;
				let sealed = false;
				const pending: Promise<number>[] = [];
				const refuse = (): Promise<never> => {
					invalid = true;
					const failure = Promise.reject<never>(new Error(unsupported));
					void failure.catch(() => {});
					return failure;
				};
				const context: StepContext = {
					...ctx,
					run: refuse,
					capture: refuse,
					node: refuse,
					pnpm: refuse,
					biome: refuse,
					turbo(args, options) {
						if (sealed) return refuse();
						const index = count++;
						if (
							invalid ||
							active ||
							index >= selections.length ||
							args.length !== 3 ||
							args[0] !== "run" ||
							args[1] !== "test" ||
							args[2] !== selections[index]
						) {
							return refuse();
						}
						// The policy-only selection has no Hub test task. Adding a positive Hub
						// filter would union the selections, rather than intersect them.
						if (partition === "hub" && index === 0) return Promise.resolve(0);
						const filters =
							index === 0
								? []
								: [partition === "hub" ? "--filter=@draftyak/hub" : "--filter=!@draftyak/hub"];
						active = true;
						let running: Promise<number>;
						try {
							running = ctx.turbo([...args, ...filters, "--concurrency=1"], options);
						} catch (error) {
							active = false;
							executionFailed = true;
							throw error;
						}
						const settled = running
							.then(
								(code) => {
									if (code !== 0) executionFailed = true;
									return code;
								},
								(error: unknown) => {
									executionFailed = true;
									throw error;
								},
							)
							.finally(() => {
								active = false;
							});
						pending.push(settled);
						void settled.catch(() => {});
						return settled;
					},
				};
				let outcome: StepOutcome;
				try {
					outcome = await original.run(context);
				} finally {
					sealed = true;
					// A changed callback must not retire a process it started but did not await.
					await Promise.allSettled(pending);
				}
				return invalid ||
					count !== selections.length ||
					(executionFailed && outcome.status === "passed")
					? { status: "failed", reason: unsupported }
					: outcome;
			},
		},
	];
}

export const profile: Profile = {
	name: "windows-tests",
	description: "Windows unit tests outside Hub after windows-core succeeds",
	select: (steps) => partitionTests(steps, "other"),
};
