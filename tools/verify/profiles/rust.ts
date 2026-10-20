import { type Profile, stepsFor } from "../lib/registry.ts";

export const profile: Profile = {
	name: "rust",
	description:
		"CI's full job when crates/ changes: cargo fmt, cargo-deny, clippy and tests for the crates/ workspace; needs cargo and cargo-deny",
	select: (steps) => stepsFor("rust", steps),
};
