import type { TestContext } from "vitest";

export type SkipContext = Pick<TestContext, "skip">;

// verify:m0 and spikes-run set DRAFTYAK_STRICT_SKIPS=1: a test that can't run fails there. Any other
// value than 1, 0 or empty is refused, so a "true" in a workflow can't turn strictness off.
export function strictSkips(env: NodeJS.ProcessEnv = process.env): boolean {
	const value = env.DRAFTYAK_STRICT_SKIPS ?? "";
	if (value === "1" || value === "" || value === "0") return value === "1";
	throw new Error(`DRAFTYAK_STRICT_SKIPS is 1 (strict) or 0, not "${value}"`);
}

export function skipOrFail(ctx: SkipContext, reason: string): never {
	if (strictSkips()) {
		throw new Error(
			`cannot run: ${reason} (DRAFTYAK_STRICT_SKIPS=1 turns this skip into a failure)`,
		);
	}
	return ctx.skip(reason);
}
