import path from "node:path";
import { fromExitCode, type Step } from "../lib/registry.ts";

// adr-check has no dependencies, so the docs profile runs it with node alone, before any install.
export const step: Step = {
	name: "adr",
	order: 50,
	profiles: ["cheap", "docs", "m0"],
	run: async (ctx) =>
		fromExitCode(await ctx.node([path.join(ctx.root, "tools", "adr-check", "src", "cli.ts")])),
};
