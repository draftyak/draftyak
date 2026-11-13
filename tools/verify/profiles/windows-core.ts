import { type Profile, stepsFor } from "../lib/registry.ts";

export const profile: Profile = {
	name: "windows-core",
	description: "Windows verification before native checks",
	select: (steps) => stepsFor("default", steps).filter((step) => step.name !== "test"),
};
