import { type Profile, stepsFor } from "../lib/registry.ts";

export const profile: Profile = {
	name: "reserved",
	description:
		"The reserved tests' opted-in run (sync, the maintainer): DRAFTYAK_RESERVED_TESTS=1 pnpm verify --profile reserved",
	select: (steps) => stepsFor("reserved", steps),
};
