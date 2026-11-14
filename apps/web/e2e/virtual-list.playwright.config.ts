import { defineConfig, type PlaywrightTestConfig } from "@playwright/test";
import existing from "./playwright.config.ts";

const config: PlaywrightTestConfig = defineConfig({
	...existing,
	testMatch: "virtual-list.spec.ts",
	outputDir: "dist/virtual-list-test-results",
});
export default config;
