import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { loadProfiles, loadSteps } from "./registry.ts";

const here = path.resolve(import.meta.dirname, "..");
const steps = await loadSteps(path.join(here, "steps"));
const profiles = await loadProfiles(path.join(here, "profiles"));

function selected(profile: string, among: readonly string[]): string[] {
	const chosen = profiles.find((candidate) => candidate.name === profile)?.select(steps) ?? [];
	return chosen.map((step) => step.name).filter((name) => among.includes(name));
}

describe("steps and profiles", () => {
	it("has the default, cheap and docs profiles", () => {
		expect(profiles.map((profile) => profile.name)).toEqual(
			expect.arrayContaining(["cheap", "default", "docs"]),
		);
	});

	it("runs lint, typecheck, test and build in that order by default", () => {
		const expected = ["lint", "typecheck", "test", "build"];
		expect(selected("default", expected)).toEqual(expected);
	});

	it("leaves build out of the cheap profile", () => {
		expect(selected("cheap", ["lint", "typecheck", "test", "build"])).toEqual([
			"lint",
			"typecheck",
			"test",
		]);
	});

	it("imports only node: built-ins and relative files, so verify runs before pnpm install", () => {
		const files = ["lib", "steps", "profiles"].flatMap((dir) =>
			readdirSync(path.join(here, dir))
				.filter((file) => file.endsWith(".ts") && !file.endsWith(".test.ts"))
				.map((file) => path.join(dir, file)),
		);
		const bare = ["verify.ts", ...files].flatMap((file) =>
			[
				...readFileSync(path.join(here, file), "utf8").matchAll(
					/\b(?:from|import)\s*\(?\s*["']([^"']+)/g,
				),
			]
				.map((match) => match[1] ?? "")
				.filter((specifier) => !/^(?:node:|\.\.?\/)/.test(specifier))
				.map((specifier) => `${file}: ${specifier}`),
		);
		expect(bare).toEqual([]);
	});
});
