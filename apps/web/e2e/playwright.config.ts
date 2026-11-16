import { defineConfig, devices, type PlaywrightTestConfig } from "@playwright/test";

const baseURL = process.env.DRAFTYAK_E2E_BASE_URL;
if (baseURL === undefined) throw new Error("Start browser tests with the fixture runner");
const endpoint = new URL(baseURL);
if (
	endpoint.protocol !== "http:" ||
	endpoint.hostname !== "127.0.0.1" ||
	endpoint.port === "" ||
	endpoint.username !== "" ||
	endpoint.password !== "" ||
	endpoint.pathname !== "/" ||
	endpoint.search !== "" ||
	endpoint.hash !== ""
) {
	throw new Error("Browser fixture URL must be an IPv4 loopback origin");
}

const config: PlaywrightTestConfig = defineConfig({
	testDir: ".",
	testMatch: "flags.spec.ts",
	outputDir: "dist/test-results",
	fullyParallel: false,
	workers: 1,
	retries: 0,
	reporter: "line",
	forbidOnly: true,
	use: { baseURL, serviceWorkers: "block", trace: "off", screenshot: "off", video: "off" },
	projects: [
		{ name: "chromium", use: { ...devices["Desktop Chrome"] } },
		{ name: "webkit", use: { ...devices["Desktop Safari"] } },
	],
});

export default config;
