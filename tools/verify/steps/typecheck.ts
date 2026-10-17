import { fromExitCode, type Step } from "../lib/registry.ts";

export const step: Step = {
	name: "typecheck",
	order: 20,
	profiles: ["default", "cheap"],
	run: async (ctx) => fromExitCode(await ctx.turbo(["run", "typecheck"])),
};
