// pnpm m0:prefetch runs this from the spike folder: the Chromium (with its headless shell) and WebKit
// builds that @playwright/test pins, installed into the cache, never into the user profile.
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import path from "node:path";
import { cacheDir } from "@draftyak/spike-kit";

export const BROWSERS: readonly string[] = ["chromium", "webkit"];

// playwright-core as @playwright/test loads it, where PLAYWRIGHT_BROWSERS_PATH=0 keeps browsers.
export function playwrightCore(): string {
	const from = (file: string, id: string): string => createRequire(file).resolve(id);
	const runner = from(
		path.join(import.meta.dirname, "package.json"),
		"@playwright/test/package.json",
	);
	return path.dirname(
		from(from(runner, "playwright/package.json"), "playwright-core/package.json"),
	);
}

// The rule verify:m0's browser check applies (tools/verify/profiles/m0.ts): PLAYWRIGHT_BROWSERS_PATH
// when set ("0": inside playwright-core; turbo passes it through), else <DRAFTYAK_CACHE_DIR>/playwright.
// A relative value would resolve against each tool's own working folder, so it is refused.
export function browsersPath(env: NodeJS.ProcessEnv = process.env): string {
	const set = env.PLAYWRIGHT_BROWSERS_PATH;
	if (set === "0") return path.join(playwrightCore(), ".local-browsers");
	if (set && !path.isAbsolute(set)) {
		throw new Error(`PLAYWRIGHT_BROWSERS_PATH must be absolute or 0, not ${set}`);
	}
	return set ? path.resolve(set) : path.join(cacheDir(env), "playwright");
}

if (import.meta.main) {
	const args = process.argv.slice(2).filter((arg, index) => index > 0 || arg !== "--");
	if (args.length > 0) {
		console.error(`prefetch: unknown argument ${args[0]}; it takes none`);
		process.exit(2);
	}
	let dir: string;
	try {
		dir = browsersPath();
	} catch (error) {
		console.error(`prefetch: ${error instanceof Error ? error.message : String(error)}`);
		process.exit(2);
	}
	const cli = createRequire(import.meta.url).resolve("@playwright/test/cli");
	console.log(`prefetch: Playwright browsers (${BROWSERS.join(", ")}) into ${dir}`);
	const env = { ...process.env, PLAYWRIGHT_BROWSERS_PATH: dir };
	const result = spawnSync(process.execPath, [cli, "install", ...BROWSERS], {
		env,
		stdio: "inherit",
		windowsHide: true,
	});
	process.exitCode = result.status ?? 1;
}
