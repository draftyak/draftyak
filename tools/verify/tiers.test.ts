import path from "node:path";
import { describe, expect, it } from "vitest";
import { type Tier, tierFiles, vitestConfig } from "../../vitest.shared.ts";

const config = (mode: string) => vitestConfig({ command: "serve", mode });

describe("test tiers", () => {
	it("runs only unit tests by default and never loads .env files", () => {
		const { envDir, test } = config("test");
		expect(envDir).toBe(false);
		expect(test).toMatchObject({
			include: [tierFiles.unit],
			passWithNoTests: false,
			testTimeout: 30_000,
			hookTimeout: 30_000,
		});
		expect(test?.exclude).toEqual(
			expect.arrayContaining([tierFiles.heavy, tierFiles.live, tierFiles.device]),
		);
	});

	it("keeps Vitest's module cache inside the package, never at the workspace root", () => {
		expect(config("test").test?.fsModuleCachePath).toBe(
			path.join(process.cwd(), "node_modules", ".vitest-cache"),
		);
	});

	it.each<Tier>(["heavy", "live", "device"])(
		"--mode %s runs only that tier, passing with none",
		(tier) => {
			const { test } = config(tier);
			expect(test).toMatchObject({
				include: [tierFiles[tier]],
				passWithNoTests: true,
				testTimeout: 30_000,
			});
			expect(test?.exclude).not.toContain(tierFiles[tier]);
		},
	);

	it("refuses an unknown mode", () => {
		expect(() => config("production")).toThrow('unknown test tier "production"');
	});
});
