import path from "node:path";
import { fromExitCode, type Step, type StepContext } from "../lib/registry.ts";

// The branch an item or milestone branch merges into, by pr-meta's (M0.3) branch rules.
export function baseOf(branch: string): string | undefined {
	const item = /^m(\d+[a-z]?)-\d{2,}[a-z]?-[a-z0-9]+(?:-[a-z0-9]+)*$/.exec(branch);
	if (item) return `origin/m${item[1]}`;
	return /^m\d+[a-z]?$/.test(branch) ? "origin/main" : undefined;
}

// The branch's own commit messages, when its base is known here. CI's shallow, detached checkouts
// have no base, so there only the files are checked.
async function commitRange(ctx: StepContext): Promise<string[]> {
	const head = await ctx.capture("git", ["symbolic-ref", "--quiet", "--short", "HEAD"]);
	const base = head.code === 0 ? baseOf(head.stdout.trim()) : undefined;
	const verify = ["rev-parse", "--verify", "--quiet", `${base}^{commit}`];
	if (base !== undefined && (await ctx.capture("git", verify)).code === 0) {
		return ["--commits", `${base}..HEAD`];
	}
	const why = base === undefined ? "not on an item or milestone branch" : `${base} not found`;
	console.log(`vendor-guard: commit messages not checked (${why})`);
	return [];
}

// vendor-guard has no dependencies, so the docs profile runs it with node alone, before any install.
export const step: Step = {
	name: "vendor-guard",
	order: 15,
	profiles: ["default", "cheap", "docs"],
	run: async (ctx) => {
		const cli = path.join(ctx.root, "tools", "vendor-guard", "src", "cli.ts");
		return fromExitCode(await ctx.node([cli, ...(await commitRange(ctx))]));
	},
};
