import { type Profile, stepsFor } from "../lib/registry.ts";

export const profile: Profile = {
	name: "cheap",
	description: "CI's cheap job: lint, typecheck, unit tests and later cheap steps",
	select: (steps) => stepsFor("cheap", steps),
};
