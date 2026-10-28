import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { findPackageDir, kitDir } from "./repo.ts";

const usage = [
	"usage: node ../kit/run.ts [--heavy | --live | --device] [--strict] [--] [vitest args]",
	"       node ../kit/run.ts --typecheck   (tsc -b, with no other argument)",
].join("\n");

export interface RunPlan {
	readonly tier: "unit" | "heavy" | "live" | "device";
	readonly strict: boolean;
	readonly args: readonly string[];
	// --typecheck: args are tsc's, not Vitest's.
	readonly typecheck?: boolean;
}

// Kit flags first, read across any `--`: from bash and cmd, `pnpm test:heavy -- --strict` passes
// one; PowerShell's pnpm.ps1 drops it. The first other argument starts Vitest's.
export function parseRunArgs(argv: readonly string[]): RunPlan {
	let tier: RunPlan["tier"] = "unit";
	let strict = false;
	let typecheck = false;
	let index = 0;
	for (; index < argv.length; index++) {
		const arg = argv[index] ?? "";
		if (arg === "--strict") {
			strict = true;
		} else if (arg === "--typecheck") {
			typecheck = true;
		} else if (arg === "--heavy" || arg === "--live" || arg === "--device") {
			if (tier !== "unit") throw new Error(`one tier at a time\n${usage}`);
			tier = arg.slice(2) as RunPlan["tier"];
		} else if (arg !== "--") {
			break;
		}
	}
	const rest = argv.slice(index);
	if (typecheck || rest.some((arg) => /^--typecheck(?:=|$)/.test(arg))) {
		if (tier !== "unit" || strict || rest.length > 0) {
			throw new Error(`--typecheck runs tsc -b alone: no tier, --strict or Vitest args\n${usage}`);
		}
		return { tier, strict, args: ["-b"], typecheck: true };
	}
	if (rest.some((arg) => /^--mode(?:=|$)/.test(arg))) {
		throw new Error(`pick the tier with --heavy, --live or --device, not --mode\n${usage}`);
	}
	return { tier, strict, args: ["run", ...(tier === "unit" ? [] : ["--mode", tier]), ...rest] };
}

// A bin from the package's own install, else the workspace root's; run with process.execPath.
function resolveBin(name: string, bin: string, fallback: string, from: string): string {
	const dir = findPackageDir(name, from) ?? findPackageDir(name, kitDir);
	if (dir === null) throw new Error(`${name} isn't installed: run pnpm install`);
	const json = JSON.parse(readFileSync(path.join(dir, "package.json"), "utf8")) as {
		bin?: Record<string, string>;
	};
	return path.join(dir, json.bin?.[bin] ?? fallback);
}

export function resolveVitest(from: string = process.cwd()): string {
	return resolveBin("vitest", "vitest", "vitest.mjs", from);
}

export function resolveTsc(from: string = process.cwd()): string {
	return resolveBin("typescript", "tsc", "bin/tsc", from);
}

// Without its own config Vitest would run every test file below the folder, in no tier.
export function assertVitestConfig(dir: string = process.cwd()): void {
	const names = ["ts", "mts", "cts", "js", "mjs", "cjs"].map((ext) => `vitest.config.${ext}`);
	if (!names.some((name) => existsSync(path.join(dir, name)))) {
		throw new Error(`no vitest.config.ts in ${dir}: run it from a package that has one\n${usage}`);
	}
}

// A folder without one is a usage error, not a failed check.
export function assertTsconfig(dir: string = process.cwd()): void {
	if (!existsSync(path.join(dir, "tsconfig.json"))) {
		throw new Error(`no tsconfig.json in ${dir}: run it from a package that has one\n${usage}`);
	}
}

if (import.meta.main) {
	try {
		const plan = parseRunArgs(process.argv.slice(2));
		if (plan.typecheck) assertTsconfig();
		else assertVitestConfig();
		const env = plan.strict ? { ...process.env, DRAFTYAK_STRICT_SKIPS: "1" } : process.env;
		const bin = plan.typecheck ? resolveTsc() : resolveVitest();
		// Vitest and tsc get Ctrl+C from the console themselves; stay alive until they have shut down.
		process.on("SIGINT", () => {});
		spawn(process.execPath, [bin, ...plan.args], { env, stdio: "inherit" })
			.once("error", (error) => {
				console.error(`run: ${error.message}`);
				process.exitCode = 2;
			})
			.once("close", (code) => {
				process.exitCode ??= code ?? 1;
			});
	} catch (error) {
		console.error(`run: ${error instanceof Error ? error.message : String(error)}`);
		process.exitCode = 2;
	}
}
