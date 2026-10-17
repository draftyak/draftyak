import { fromExitCode, type Step } from "../lib/registry.ts";

export const step: Step = {
	name: "lint",
	order: 10,
	profiles: ["default", "cheap"],
	run: async (ctx) => fromExitCode(await ctx.biome(["ci", "."])),
};
