import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { Profile, Step, StepContext } from "../lib/registry.ts";
import type { RunOptions } from "../lib/spawn.ts";
import { profile as core } from "../profiles/windows-core.ts";
import { profile as hub } from "../profiles/windows-hub-tests.ts";
import { profile as other } from "../profiles/windows-tests.ts";
import { step as unitTests } from "../steps/test.ts";

const roots: string[] = [];
afterEach(() => {
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function workspace(
	manifest: unknown = { name: "@draftyak/hub", scripts: { test: "vitest run" } },
): string {
	const root = mkdtempSync(path.join(tmpdir(), "draftyak-windows-profiles-"));
	roots.push(root);
	mkdirSync(path.join(root, "apps/hub"), { recursive: true });
	writeFileSync(path.join(root, "apps/hub/package.json"), JSON.stringify(manifest));
	return root;
}

function check(name: string, order: number, profiles: readonly string[] = ["default"]): Step {
	return Object.freeze({ name, order, profiles, run: async () => ({ status: "passed" as const }) });
}

function selected(profile: Profile, steps: readonly Step[] = [unitTests]): Step {
	const chosen = profile.select(steps);
	expect(chosen).toHaveLength(1);
	const step = chosen[0];
	if (step === undefined) throw new Error("Missing Windows test step");
	return step;
}

function context(
	root: string,
	profile: Profile,
	turbo: StepContext["turbo"] = async () => 0,
): StepContext {
	const unexpected = async (): Promise<never> => {
		throw new Error("Unexpected verification command");
	};
	return {
		root,
		profile: profile.name,
		env: Object.freeze({ CI: "true", DRAFTYAK_STRICT_SKIPS: "1" }),
		run: unexpected,
		capture: unexpected,
		node: unexpected,
		pnpm: unexpected,
		biome: unexpected,
		turbo,
	};
}

// Plain positive package filters form a union; negatives subtract from it, or from all packages
// when no positive filter is given. Only packages declaring the requested test task run.
function testTasks(args: readonly string[], packages: ReadonlyMap<string, boolean>): string[] {
	expect(args.slice(0, 2)).toEqual(["run", "test"]);
	expect(args.filter((arg) => arg.startsWith("--concurrency="))).toEqual(["--concurrency=1"]);
	const filters = args.filter((arg) => arg.startsWith("--filter=")).map((arg) => arg.slice(9));
	const include = filters.filter((filter) => !filter.startsWith("!"));
	const exclude = filters
		.filter((filter) => filter.startsWith("!"))
		.map((filter) => filter.slice(1));
	return [...packages]
		.filter(
			([name, hasTests]) =>
				hasTests && (include.length === 0 || include.includes(name)) && !exclude.includes(name),
		)
		.map(([name]) => `${name}#test`);
}

const mismatch = {
	status: "failed",
	reason: "Windows test partition no longer matches the default test step",
};

describe("Windows verification profiles", () => {
	it("retains every default non-test check and original callback in core, including future checks", () => {
		const future = check("future-check", 25);
		const steps = Object.freeze([
			check("build", 40),
			unitTests,
			check("lint", 10),
			check("zizmor", 50),
			check("typecheck", 20),
			check("rust", 35),
			check("vendor-guard", 15),
			future,
			check("other-profile", 1, ["cheap"]),
		]);
		const originalOrder = steps.map((step) => step.name);
		const chosen = core.select(steps);
		expect(chosen.map((step) => step.name)).toEqual([
			"lint",
			"vendor-guard",
			"typecheck",
			"future-check",
			"rust",
			"build",
			"zizmor",
		]);
		for (const step of chosen) expect(steps).toContain(step);
		expect(chosen[3]).toBe(future);
		expect(other.select(steps).map((step) => step.name)).toEqual(["test"]);
		expect(hub.select(steps).map((step) => step.name)).toEqual(["test"]);
		expect(steps.map((step) => step.name)).toEqual(originalOrder);
	});

	it("partitions every default workspace test task exactly once, including future packages", async () => {
		const packages = new Map([
			["@draftyak/verify", true],
			["@draftyak/hub", true],
			["@draftyak/web", true],
			["@draftyak/client", true],
			["@draftyak/channel-future", true],
			["@draftyak/future-tool", true],
			["@draftyak/no-tests", false],
		]);
		const root = workspace();
		const runs: string[][] = [];
		for (const profile of [other, hub]) {
			const tasks: string[] = [];
			const ctx = context(root, profile, async (args) => {
				tasks.push(...testTasks(args, packages));
				return 0;
			});
			expect(await selected(profile).run(ctx)).toEqual({ status: "passed" });
			runs.push(tasks);
		}
		expect(runs[0]).toEqual([
			"@draftyak/verify#test",
			"@draftyak/web#test",
			"@draftyak/client#test",
			"@draftyak/channel-future#test",
			"@draftyak/future-tool#test",
		]);
		expect(runs[1]).toEqual(["@draftyak/hub#test"]);
		const all = runs.flat();
		expect(new Set(all).size).toBe(all.length);
		expect(all.toSorted()).toEqual(
			[...packages]
				.filter(([, hasTests]) => hasTests)
				.map(([name]) => `${name}#test`)
				.toSorted(),
		);
	});

	it.each([other, hub])("refuses missing or duplicate default test steps in $name", (profile) => {
		expect(() => profile.select([check("typecheck", 20)])).toThrow("default test step");
		expect(() => profile.select([unitTests, unitTests])).toThrow("default test step");
		expect(() => profile.select([check("test", 30, ["cheap"])])).toThrow("default test step");
	});

	it.each([
		null,
		{},
		{ name: "@draftyak/renamed", scripts: { test: "vitest run" } },
		{ name: "@draftyak/hub" },
		{ name: "@draftyak/hub", scripts: { test: " " } },
	])("refuses an unsupported Hub test manifest %j before dispatch", async (manifest) => {
		for (const profile of [other, hub]) {
			const calls: string[][] = [];
			const ctx = context(workspace(manifest), profile, async (args) => {
				calls.push([...args]);
				return 0;
			});
			expect(await selected(profile).run(ctx)).toEqual({
				status: "failed",
				reason: "Hub test workspace is missing or unsupported",
			});
			expect(calls).toEqual([]);
		}
	});

	it("refuses a missing Hub manifest before dispatch", async () => {
		const root = workspace();
		rmSync(path.join(root, "apps/hub/package.json"));
		for (const profile of [other, hub]) {
			let calls = 0;
			const ctx = context(root, profile, async () => {
				calls++;
				return 0;
			});
			expect(await selected(profile).run(ctx)).toEqual({
				status: "failed",
				reason: "Hub test workspace is missing or unsupported",
			});
			expect(calls).toBe(0);
		}
	});

	it("keeps root, profile, environment and original Turbo options on the original callback", async () => {
		for (const profile of [other, hub]) {
			const options: RunOptions = { cwd: "kept-cwd", env: { DRAFTYAK_CASE: "kept" } };
			const forwarded: (RunOptions | undefined)[] = [];
			const ctx = context(workspace(), profile, async (_args, actual) => {
				forwarded.push(actual);
				return 0;
			});
			let callbacks = 0;
			const original: Step = {
				...unitTests,
				async run(actual) {
					callbacks++;
					expect(actual.root).toBe(ctx.root);
					expect(actual.profile).toBe(ctx.profile);
					expect(actual.env).toBe(ctx.env);
					return unitTests.run({ ...actual, turbo: (args) => actual.turbo(args, options) });
				},
			};
			expect(await selected(profile, [original]).run(ctx)).toEqual({ status: "passed" });
			expect(callbacks).toBe(1);
			expect(forwarded).toHaveLength(profile === other ? 2 : 1);
			for (const actual of forwarded) expect(actual).toBe(options);
		}
	});

	it.each(["omit", "unfiltered", "reorder", "extra", "other-helper"] as const)(
		"keeps unsupported callback shape %s fatal even when it catches refusal",
		async (shape) => {
			for (const profile of [other, hub]) {
				const calls: string[][] = [];
				const ctx = context(workspace(), profile, async (args) => {
					calls.push([...args]);
					return 0;
				});
				const original: Step = {
					...unitTests,
					async run(actual) {
						try {
							if (shape === "unfiltered") await actual.turbo(["run", "test"]);
							else if (shape === "reorder")
								await actual.turbo(["run", "test", "--filter=!@draftyak/verify"]);
							else if (shape === "other-helper") await actual.node(["unexpected.ts"]);
							else if (shape === "extra") {
								await unitTests.run(actual);
								await actual.turbo(["run", "test", "--filter=@draftyak/verify"]);
							}
						} catch {}
						return { status: "passed" };
					},
				};
				expect(await selected(profile, [original]).run(ctx)).toEqual(mismatch);
				if (shape !== "extra") expect(calls).toEqual([]);
			}
		},
	);

	it.each(["nonzero", "throw"] as const)(
		"retains failure and drains the other selection after policy %s",
		async (failure) => {
			const calls: string[][] = [];
			const ctx = context(workspace(), other, async (args) => {
				calls.push([...args]);
				if (calls.length === 1) {
					if (failure === "throw") throw new Error("DYTEST original policy failure");
					return 23;
				}
				return 0;
			});
			expect(await selected(other).run(ctx)).toEqual({
				status: "failed",
				reason: "unit tests failed",
			});
			expect(calls).toEqual([
				["run", "test", "--filter=@draftyak/verify", "--concurrency=1"],
				["run", "test", "--filter=!@draftyak/verify", "--filter=!@draftyak/hub", "--concurrency=1"],
			]);
		},
	);

	it.each([other, hub])(
		"awaits physical completion and preserves fatal test exit in $name",
		async (profile) => {
			const physical = Promise.withResolvers<number>();
			const started = Promise.withResolvers<void>();
			let calls = 0;
			let finished = false;
			const ctx = context(workspace(), profile, async () => {
				calls++;
				if (profile === other && calls === 1) return 0;
				started.resolve();
				return physical.promise;
			});
			const running = selected(profile)
				.run(ctx)
				.finally(() => {
					finished = true;
				});
			try {
				await started.promise;
				await new Promise<void>((resolve) => setImmediate(resolve));
				expect(finished).toBe(false);
				physical.resolve(17);
				expect(await running).toEqual({ status: "failed", reason: "unit tests failed" });
				expect(calls).toBe(profile === other ? 2 : 1);
			} finally {
				physical.resolve(0);
				await running.catch(() => {});
			}
		},
	);

	it("drains an early-returning callback and cannot turn a lost process failure green", async () => {
		const physical = Promise.withResolvers<number>();
		const started = Promise.withResolvers<void>();
		let finished = false;
		const original: Step = {
			...unitTests,
			async run(ctx) {
				await ctx.turbo(["run", "test", "--filter=@draftyak/verify"]);
				void ctx.turbo(["run", "test", "--filter=!@draftyak/verify"]);
				return { status: "passed" };
			},
		};
		const ctx = context(workspace(), hub, async () => {
			started.resolve();
			return physical.promise;
		});
		const running = selected(hub, [original])
			.run(ctx)
			.finally(() => {
				finished = true;
			});
		try {
			await started.promise;
			await new Promise<void>((resolve) => setImmediate(resolve));
			expect(finished).toBe(false);
			physical.resolve(17);
			expect(await running).toEqual(mismatch);
		} finally {
			physical.resolve(0);
			await running.catch(() => {});
		}
	});

	it.each([other, hub])(
		"seals a retained callback after return and throw in $name",
		async (profile) => {
			for (const throws of [false, true]) {
				let saved: StepContext | undefined;
				const calls: string[][] = [];
				const original: Step = {
					...unitTests,
					async run(actual) {
						saved = actual;
						await actual.turbo(["run", "test", "--filter=@draftyak/verify"]);
						if (throws) throw new Error("DYTEST callback failed");
						return { status: "passed" };
					},
				};
				const ctx = context(workspace(), profile, async (args) => {
					calls.push([...args]);
					return 0;
				});
				const running = selected(profile, [original]).run(ctx);
				if (throws) await expect(running).rejects.toThrow("DYTEST callback failed");
				else expect(await running).toEqual(mismatch);
				expect(calls).toHaveLength(profile === other ? 1 : 0);
				if (saved === undefined) throw new Error("Missing retained callback context");
				await expect(saved.turbo(["run", "test", "--filter=!@draftyak/verify"])).rejects.toThrow(
					"Windows test partition no longer matches the default test step",
				);
				await expect(saved.node(["unexpected.ts"])).rejects.toThrow("default test step");
				expect(calls).toHaveLength(profile === other ? 1 : 0);
			}
		},
	);

	it("refuses overlapping callback dispatch and drains the process already started", async () => {
		const physical = Promise.withResolvers<number>();
		const started = Promise.withResolvers<void>();
		let calls = 0;
		let finished = false;
		const original: Step = {
			...unitTests,
			async run(ctx) {
				void ctx.turbo(["run", "test", "--filter=@draftyak/verify"]);
				await ctx.turbo(["run", "test", "--filter=!@draftyak/verify"]).catch(() => {});
				return { status: "passed" };
			},
		};
		const ctx = context(workspace(), other, async () => {
			calls++;
			started.resolve();
			return physical.promise;
		});
		const running = selected(other, [original])
			.run(ctx)
			.finally(() => {
				finished = true;
			});
		try {
			await started.promise;
			await new Promise<void>((resolve) => setImmediate(resolve));
			expect(finished).toBe(false);
			expect(calls).toBe(1);
			physical.resolve(0);
			expect(await running).toEqual(mismatch);
		} finally {
			physical.resolve(0);
			await running.catch(() => {});
		}
	});
});
