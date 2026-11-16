import { describe, expect, it } from "vitest";
import type { StepContext } from "../lib/registry.ts";
import { step } from "../steps/test.ts";

const selections = [
	["run", "test", "--filter=@draftyak/verify"],
	["run", "test", "--filter=!@draftyak/verify"],
] as const;

function fakeContext(invoke: (index: number) => Promise<number>): {
	readonly context: StepContext;
	readonly calls: string[][];
	readonly environments: (NodeJS.ProcessEnv | undefined)[];
} {
	const calls: string[][] = [];
	const environments: (NodeJS.ProcessEnv | undefined)[] = [];
	const unexpected = async (): Promise<never> => {
		throw new Error("Unexpected verification command");
	};
	return {
		calls,
		environments,
		context: {
			root: ".",
			profile: "default",
			env: {},
			run: unexpected,
			capture: unexpected,
			node: unexpected,
			pnpm: unexpected,
			biome: unexpected,
			turbo: async (args, options) => {
				calls.push([...args]);
				environments.push(options?.env);
				return invoke(calls.length - 1);
			},
		},
	};
}

describe("isolated verification unit-test step", () => {
	it("bounds each workspace selection without changing its coverage or the caller environment", async () => {
		const { context, calls, environments } = fakeContext(async () => 0);
		context.env.TURBO_CONCURRENCY = "64";
		context.env.DYTEST_KEEP = "retained";
		expect(await step.run(context)).toEqual({ status: "passed" });
		expect(calls).toEqual(selections);
		expect(environments).toEqual([{ TURBO_CONCURRENCY: "1" }, { TURBO_CONCURRENCY: "1" }]);
		expect(context.env).toEqual({ TURBO_CONCURRENCY: "64", DYTEST_KEEP: "retained" });
	});

	it.each(["zero", "nonzero", "throw"] as const)(
		"awaits both selections without overlap or early completion after first %s",
		async (firstOutcome) => {
			const first = Promise.withResolvers<number>();
			const second = Promise.withResolvers<number>();
			const firstStarted = Promise.withResolvers<void>();
			const secondStarted = Promise.withResolvers<void>();
			const { context, calls } = fakeContext(async (index) => {
				if (index === 0) {
					firstStarted.resolve();
					return first.promise;
				}
				if (index === 1) {
					secondStarted.resolve();
					return second.promise;
				}
				throw new Error("Unexpected extra test selection");
			});
			let finished = false;
			const running = step.run(context).finally(() => {
				finished = true;
			});
			const settled = running.then(
				() => "finished",
				() => "rejected",
			);
			try {
				expect(await Promise.race([firstStarted.promise.then(() => "first"), settled])).toBe(
					"first",
				);
				await new Promise<void>((resolve) => setImmediate(resolve));
				expect(calls).toEqual([selections[0]]);
				expect(finished).toBe(false);
				if (firstOutcome === "throw") first.reject(new Error("DYTEST first test failure"));
				else first.resolve(firstOutcome === "zero" ? 0 : 23);
				expect(await Promise.race([secondStarted.promise.then(() => "second"), settled])).toBe(
					"second",
				);
				expect(calls).toEqual(selections);
				await new Promise<void>((resolve) => setImmediate(resolve));
				expect(finished).toBe(false);
				second.resolve(0);
				expect(await running).toEqual(
					firstOutcome === "zero"
						? { status: "passed" }
						: { status: "failed", reason: "unit tests failed" },
				);
				expect(calls).toEqual(selections);
			} finally {
				first.resolve(0);
				second.resolve(0);
				await running.catch(() => {});
			}
		},
	);

	it.each([
		[0, 0],
		[23, 0],
		[0, 17],
		[23, 17],
	])("runs both selections exactly once for exit codes %i and %i", async (first, second) => {
		const { context, calls } = fakeContext(async (index) => {
			if (index === 0) return first;
			if (index === 1) return second;
			throw new Error("Unexpected extra test selection");
		});
		expect(await step.run(context)).toEqual(
			first === 0 && second === 0
				? { status: "passed" }
				: { status: "failed", reason: "unit tests failed" },
		);
		expect(calls).toEqual(selections);
	});

	it.each([0, 1])(
		"keeps an exception in selection %i fatal and still runs both",
		async (failing) => {
			const { context, calls } = fakeContext(async (index) => {
				if (index > 1) throw new Error("Unexpected extra test selection");
				if (index === failing) throw new Error("DYTEST raw failure must not be disclosed");
				return 0;
			});
			expect(await step.run(context)).toEqual({ status: "failed", reason: "unit tests failed" });
			expect(calls).toEqual(selections);
		},
	);
});
