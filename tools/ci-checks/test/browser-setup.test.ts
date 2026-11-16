import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
	type BrowserSetupDependencies,
	installBrowsers,
	planBrowserSetup,
} from "../src/browser-setup.ts";

const nativeSpawn = vi.hoisted(() => vi.fn());
vi.mock("node:child_process", async (original) => ({
	...(await original<typeof import("node:child_process")>()),
	spawnSync: nativeSpawn,
}));

const directory = path.resolve("browser cache");
const cli = path.resolve("locked workspace", "playwright", "cli.js");
const env = (spikes: string): NodeJS.ProcessEnv => ({
	SPIKES: spikes,
	PLAYWRIGHT_BROWSERS_PATH: directory,
	PRESERVED: "value",
});

function fake(status = 0): BrowserSetupDependencies & {
	readonly load: ReturnType<typeof vi.fn<BrowserSetupDependencies["load"]>>;
	readonly run: ReturnType<typeof vi.fn<BrowserSetupDependencies["run"]>>;
} {
	return {
		load: vi.fn(async () => ({
			cli,
			browsers: ["chromium", "webkit"],
			browsersPath: (input: NodeJS.ProcessEnv) => input.PLAYWRIGHT_BROWSERS_PATH ?? "",
		})),
		run: vi.fn(() => status),
	};
}

describe("selected heavy browser setup", () => {
	it.each([
		"",
		" \n\t",
		"spikes/s01-sqlite3mc",
		"spikes/s03-mcp-sdk-suffix",
		"spikes/s04-oauth-as/test",
	])("does not resolve or execute Playwright for %j", async (spikes) => {
		const deps = fake();
		const input = { SPIKES: spikes };
		expect(planBrowserSetup(input)).toEqual({ required: false, path: "" });
		expect(await installBrowsers(input, deps)).toBe(0);
		expect(deps.load).not.toHaveBeenCalled();
		expect(deps.run).not.toHaveBeenCalled();
	});

	it.each([
		"spikes/s03-mcp-sdk",
		"spikes/s04-oauth-as",
		"spikes/s03-mcp-sdk\nspikes/s04-oauth-as",
		"spikes/s01-sqlite3mc spikes/s04-oauth-as spikes/s03-mcp-sdk spikes/s04-oauth-as",
	])("installs both locked engines once for %j", async (spikes) => {
		const deps = fake();
		const input = env(spikes);
		expect(planBrowserSetup(input)).toEqual({ required: true, path: directory });
		expect(deps.load).not.toHaveBeenCalled();
		expect(await installBrowsers(input, deps)).toBe(0);
		expect(deps.load).toHaveBeenCalledTimes(1);
		expect(deps.run).toHaveBeenCalledExactlyOnceWith(
			process.execPath,
			[cli, "install", "--with-deps", "chromium", "webkit"],
			input,
		);
		expect(deps.run.mock.calls[0]?.[2]).not.toBe(input);
		expect(input).toEqual(env(spikes));
	});

	it.each([undefined, "", "0", "relative/cache", `${directory}\nother`, `${directory}\0other`])(
		"refuses an implicit, per-package or invalid cache path %j before loading",
		async (value) => {
			const deps = fake();
			const input = { SPIKES: "spikes/s03-mcp-sdk", PLAYWRIGHT_BROWSERS_PATH: value };
			await expect(installBrowsers(input, deps)).rejects.toThrow(
				"browser setup requires an absolute PLAYWRIGHT_BROWSERS_PATH",
			);
			expect(deps.load).not.toHaveBeenCalled();
			expect(deps.run).not.toHaveBeenCalled();
		},
	);

	it("captures the shared cache environment before loading the locked installer", async () => {
		const deps = fake();
		const input = env("spikes/s03-mcp-sdk");
		const result = installBrowsers(input, deps);
		input.PLAYWRIGHT_BROWSERS_PATH = path.resolve("different cache");
		expect(await result).toBe(0);
		expect(deps.run.mock.calls[0]?.[2].PLAYWRIGHT_BROWSERS_PATH).toBe(directory);
	});

	it("refuses a cache-contract mismatch before executing", async () => {
		const deps = fake();
		deps.load.mockResolvedValue({
			cli,
			browsers: ["chromium", "webkit"],
			browsersPath: () => "other",
		});
		await expect(installBrowsers(env("spikes/s04-oauth-as"), deps)).rejects.toThrow(
			"browser setup and heavy tests must use the same cache path",
		);
		expect(deps.run).not.toHaveBeenCalled();
	});

	it("uses S03's actual locked CLI and shared engines without executing it", async () => {
		const require = createRequire(
			new URL("../../../spikes/s03-mcp-sdk/package.json", import.meta.url),
		);
		const expectedCli = require.resolve("@playwright/test/cli");
		const installed = JSON.parse(
			readFileSync(require.resolve("@playwright/test/package.json"), "utf8"),
		);
		expect(installed.version).toBe("1.64.1");
		const input = env("spikes/s04-oauth-as");
		nativeSpawn.mockReset().mockReturnValue({ status: 0 });
		expect(await installBrowsers(input)).toBe(0);
		expect(nativeSpawn).toHaveBeenCalledExactlyOnceWith(
			process.execPath,
			[expectedCli, "install", "--with-deps", "chromium", "webkit"],
			{ env: input, stdio: "inherit", windowsHide: true },
		);
		nativeSpawn.mockReturnValue({ status: 19 });
		expect(await installBrowsers(input)).toBe(19);
		nativeSpawn.mockReturnValue({ status: null });
		expect(await installBrowsers(input)).toBe(1);
		const failure = new Error("fixture native spawn failure");
		nativeSpawn.mockReturnValue({ error: failure, status: null });
		await expect(installBrowsers(input)).rejects.toBe(failure);
	});

	it("propagates nonzero exit status and tool failures", async () => {
		const deps = fake(23);
		expect(await installBrowsers(env("spikes/s03-mcp-sdk"), deps)).toBe(23);
		const failure = new Error("fixture spawn failure");
		deps.run.mockImplementation(() => {
			throw failure;
		});
		await expect(installBrowsers(env("spikes/s03-mcp-sdk"), deps)).rejects.toBe(failure);
		deps.load.mockRejectedValue(failure);
		deps.run.mockClear();
		await expect(installBrowsers(env("spikes/s03-mcp-sdk"), deps)).rejects.toBe(failure);
		expect(deps.run).not.toHaveBeenCalled();
	});
});
