import { type Profile, stepsFor } from "../lib/registry.ts";

export const profile: Profile = {
	name: "windows-tests",
	description: "Windows typecheck and test verification",
	select: (steps) =>
		stepsFor("default", steps).filter((step) => step.name === "typecheck" || step.name === "test"),
};
