import type { PlaywrightTestConfig } from "@playwright/test";
import base from "./playwright.config.ts";

const config: PlaywrightTestConfig = {
	...base,
	testMatch: "inbox-workspace.spec.ts",
	outputDir: "dist/inbox-workspace-results",
};
export default config;
