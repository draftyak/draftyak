import type { Profile } from "../lib/registry.ts";
import { partitionTests } from "./windows-tests.ts";

export const profile: Profile = {
	name: "windows-hub-tests",
	description: "Windows Hub unit tests after windows-core succeeds and windows-tests finishes",
	select: (steps) => partitionTests(steps, "hub"),
};
