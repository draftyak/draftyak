import { RESERVED_TESTS, reservedTestsOn } from "../../../reserved-tests.ts";
import { fromExitCode, type Step } from "../lib/registry.ts";

// With DRAFTYAK_RESERVED_TESTS=1 (the branch sync, the maintainer; CI calls the proof
// itself), the reserved suites run here, uncached, and reserved-proof.ts proves from their counts
// that they ran: the unit tier with the typecheck, build and lint of reserved files; under a gate
// profile, the heavy tier of exactly the selection that profile's heavy step runs
// (ctx.heavyFilters). Every other step runs without the flag. Every gate
// profile (profiles/m<N>.ts) selects this step; a test checks each one.
export const step: Step = {
	name: "reserved",
	order: 46,
	profiles: ["reserved", "m0", "m1"],
	async run(ctx) {
		let on: boolean;
		try {
			on = reservedTestsOn(ctx.env);
		} catch (error) {
			return { status: "failed", reason: error instanceof Error ? error.message : String(error) };
		}
		const gate = ctx.heavyFilters !== undefined;
		if (!on) {
			if (ctx.env.GITHUB_ACTIONS === "true") {
				return { status: "failed", reason: `CI sets ${RESERVED_TESTS}=1 on this step` };
			}
			if (gate) {
				return {
					status: "incomplete",
					reason: `the gate needs the reserved files' maintainer's run with ${RESERVED_TESTS}=1`,
				};
			}
			return { status: "failed", reason: `opt-in only: ${RESERVED_TESTS}=1 runs it` };
		}
		const proof = "tools/verify/reserved-proof.ts";
		const tiers = ["--tier", "unit"];
		// verify leaves the flag out of every child that doesn't set it, so each proof call sets it.
		const optIn = { [RESERVED_TESTS]: "1" };
		const codes = [await ctx.node([proof, ...tiers], { env: optIn })];
		// Under strict skips, like the profile's heavy step, with its own filters. --complete makes a
		// row of that selection left unchecked a problem, not a partial run.
		const filters = ctx.heavyFilters ?? [];
		if (filters.length > 0) {
			const env = { ...optIn, DRAFTYAK_STRICT_SKIPS: "1" };
			const args = filters.flatMap((filter) => ["--filter", filter]);
			codes.push(await ctx.node([proof, "--tier", "heavy", ...args, "--complete"], { env }));
		}
		return fromExitCode(codes.find((code) => code !== 0) ?? 0);
	},
};
