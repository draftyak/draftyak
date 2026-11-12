import type { Step } from "../lib/registry.ts";

export const step: Step = {
	name: "test",
	order: 30,
	profiles: ["default", "cheap"],
	run: async (ctx) => {
		let failed = false;
		// Finish repository-wide policy checks before other package tests begin.
		for (const filter of ["--filter=@draftyak/verify", "--filter=!@draftyak/verify"]) {
			try {
				if ((await ctx.turbo(["run", "test", filter])) !== 0) failed = true;
			} catch {
				failed = true;
			}
		}
		return failed ? { status: "failed", reason: "unit tests failed" } : { status: "passed" };
	},
};
