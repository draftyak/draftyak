import { fromExitCode, type Step } from "../lib/registry.ts";

export const step: Step = {
	name: "test",
	order: 30,
	profiles: ["default", "cheap"],
	run: async (ctx) => fromExitCode(await ctx.turbo(["run", "test"])),
};
