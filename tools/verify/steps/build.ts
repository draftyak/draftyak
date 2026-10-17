import { fromExitCode, type Step } from "../lib/registry.ts";

export const step: Step = {
	name: "build",
	order: 40,
	profiles: ["default"],
	run: async (ctx) => fromExitCode(await ctx.turbo(["run", "build"])),
};
