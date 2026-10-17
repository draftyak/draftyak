import { type Profile, stepsFor } from "../lib/registry.ts";

export const profile: Profile = {
	name: "docs",
	description:
		"CI's docs-only runs, no install: node tools/verify/verify.ts --profile docs, not pnpm",
	select: (steps) => stepsFor("docs", steps),
};
