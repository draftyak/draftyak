import { type Profile, stepsFor } from "../lib/registry.ts";

export const profile: Profile = {
	name: "default",
	description: "pnpm verify: every local check before a PR opens",
	select: (steps) => stepsFor("default", steps),
};
