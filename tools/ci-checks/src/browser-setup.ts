import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import path from "node:path";
import { runCli, setOutputs, UsageError } from "./lib.ts";

const browserSpikes = new Set(["spikes/s03-mcp-sdk", "spikes/s04-oauth-as"]);

export interface BrowserSetupPlan {
	readonly required: boolean;
	readonly path: string;
}

export interface BrowserInstaller {
	readonly cli: string;
	readonly browsers: readonly string[];
	readonly browsersPath: (env: NodeJS.ProcessEnv) => string;
}

export interface BrowserSetupDependencies {
	readonly load: () => Promise<BrowserInstaller>;
	readonly run: (command: string, args: readonly string[], env: NodeJS.ProcessEnv) => number;
}

// Selection is the existing complete heavy selection, not a second spike classifier.
// The plan runs without loading any installed Playwright or spike-kit module.
export function planBrowserSetup(env: NodeJS.ProcessEnv): BrowserSetupPlan {
	const selected = (env.SPIKES ?? "").split(/\s+/).filter(Boolean);
	if (!selected.some((spike) => browserSpikes.has(spike))) return { required: false, path: "" };
	const directory = env.PLAYWRIGHT_BROWSERS_PATH;
	if (!directory || !path.isAbsolute(directory) || /[\0\r\n]/.test(directory)) {
		throw new UsageError("browser setup requires an absolute PLAYWRIGHT_BROWSERS_PATH");
	}
	return { required: true, path: path.resolve(directory) };
}

const dependencies: BrowserSetupDependencies = {
	load: async () => {
		// Reuse the engines and cache contract consumed by S03 and S04. Resolve the CLI
		// from S03's frozen workspace install, never a PATH shim or an unpinned download.
		const prefetch = await import("../../../spikes/s03-mcp-sdk/prefetch.ts");
		const require = createRequire(
			new URL("../../../spikes/s03-mcp-sdk/package.json", import.meta.url),
		);
		return {
			cli: require.resolve("@playwright/test/cli"),
			browsers: prefetch.BROWSERS,
			browsersPath: prefetch.browsersPath,
		};
	},
	run: (command, args, env) => {
		const result = spawnSync(command, [...args], { env, stdio: "inherit", windowsHide: true });
		if (result.error) throw result.error;
		return result.status ?? 1;
	},
};

export async function installBrowsers(
	env: NodeJS.ProcessEnv,
	deps: BrowserSetupDependencies = dependencies,
): Promise<number> {
	const plan = planBrowserSetup(env);
	if (!plan.required) return 0;
	const captured = { ...env, PLAYWRIGHT_BROWSERS_PATH: plan.path };
	const installer = await deps.load();
	if (installer.browsersPath(captured) !== plan.path) {
		throw new Error("browser setup and heavy tests must use the same cache path");
	}
	// Cache hits still need the host libraries; missing binaries are repaired by the
	// same locked CLI. A failed install must stop the job before its heavy tests.
	return deps.run(
		process.execPath,
		[installer.cli, "install", "--with-deps", ...installer.browsers],
		captured,
	);
}

async function main(argv: readonly string[]): Promise<number> {
	const args = argv[0] === "--" ? argv.slice(1) : argv;
	if (args.length !== 1 || !["plan", "install"].includes(args[0] ?? "")) {
		throw new UsageError("expected plan or install");
	}
	if (args[0] === "plan") {
		const plan = planBrowserSetup(process.env);
		setOutputs({ required: String(plan.required), path: plan.path });
		return 0;
	}
	return installBrowsers(process.env);
}

if (import.meta.main) await runCli("browser-setup", () => main(process.argv.slice(2)));
