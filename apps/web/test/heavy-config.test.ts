import { afterEach, expect, it, vi } from "vitest";
import webVitestConfig from "../vitest.config.ts";

afterEach(() => vi.unstubAllEnvs());
it("requires nonempty heavy discovery and retains strict skip enforcement", () => {
	vi.stubEnv("DRAFTYAK_STRICT_SKIPS", "1");
	const config = webVitestConfig({ mode: "heavy", command: "serve" });
	expect(config.test.include).toEqual(["**/*.heavy.test.ts"]);
	expect(config.test.passWithNoTests).toBe(false);
	expect(config.test.testTimeout).toBe(300_000);
	expect(
		config.plugins?.some(
			(plugin) =>
				typeof plugin === "object" &&
				plugin !== null &&
				"name" in plugin &&
				plugin.name === "draftyak:strict-skips",
		),
	).toBe(true);
});
it("keeps unit discovery separate from browser heavy tests", () => {
	vi.stubEnv("DRAFTYAK_STRICT_SKIPS", "1");
	const config = webVitestConfig({ mode: "test", command: "serve" });
	expect(config.test.include).toEqual(["**/*.test.ts"]);
	expect(config.test.exclude).toContain("**/*.heavy.test.ts");
	expect(config.test.passWithNoTests).toBe(false);
	expect(config.plugins).toEqual([]);
});
it("refuses an unknown Web tier", () => {
	expect(() => webVitestConfig({ mode: "unknown", command: "serve" })).toThrow("unknown test tier");
});
