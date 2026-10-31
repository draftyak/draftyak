import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import path from "node:path";
import { findPackageDir, kitDir, repoRoot } from "./repo.ts";

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

// The reserved proof (tools/verify/lib/proof.ts) gives its typecheck call this folder: each tsc run
// started here writes one mark there, so the proof can tell a run from a cache replay.
export const TYPECHECK_MARKS = "DRAFTYAK_TYPECHECK_MARKS";

// One tsc run's mark, in a new file of its own: { version: 1, package, code }, where package is the
// package's folder below the repository root. It prints nothing, and throws when the file can't be
// written.
export function writeTypecheckMark(dir: string, pkg: string, code: number): void {
	const mark = { version: 1, package: pkg, code };
	const file = path.join(dir, `${randomUUID()}.json`);
	writeFileSync(file, `${JSON.stringify(mark)}\n`, { flag: "wx" });
}

function below(file: string, root: string): string | null {
	const rel = path.relative(root, file);
	if (rel === "" || path.isAbsolute(rel)) return null;
	const slashed = rel.split(path.sep).join("/");
	return slashed === ".." || slashed.startsWith("../") ? null : slashed;
}

// The package folder below the repository root, as the given path or else the real one shows it.
function packageDir(dir: string): string | null {
	const given = below(path.resolve(dir), repoRoot);
	if (given !== null) return given;
	try {
		return below(realpathSync.native(dir), realpathSync.native(repoRoot));
	} catch {
		return null;
	}
}

// Where this typecheck's mark goes: nothing without the variable.
function markTarget(env: NodeJS.ProcessEnv): { dir: string; pkg: string } | undefined {
	const dir = env[TYPECHECK_MARKS];
	if (dir === undefined) return undefined;
	if (!path.isAbsolute(dir)) throw new Error(`${TYPECHECK_MARKS} must be an absolute folder`);
	const pkg = packageDir(process.cwd());
	if (pkg === null) {
		throw new Error(`${TYPECHECK_MARKS} needs a package folder below the repository root`);
	}
	return { dir, pkg };
}

const reason = (error: unknown): string =>
	(error as NodeJS.ErrnoException | undefined)?.code ?? "unknown error";

// run.ts loads this module only once the folder's scripts may run.
export function main(argv: readonly string[], env: NodeJS.ProcessEnv = process.env): void {
	try {
		const plan = parseRunArgs(argv);
		if (plan.typecheck) assertTsconfig();
		else assertVitestConfig();
		const marks = plan.typecheck ? markTarget(env) : undefined;
		const childEnv = plan.strict ? { ...env, DRAFTYAK_STRICT_SKIPS: "1" } : env;
		const bin = plan.typecheck ? resolveTsc() : resolveVitest();
		// Vitest and tsc get Ctrl+C from the console themselves; stay alive until they have shut down.
		process.on("SIGINT", () => {});
		let started = true;
		spawn(process.execPath, [bin, ...plan.args], { env: childEnv, stdio: "inherit" })
			.once("error", (error) => {
				started = false;
				console.error(`run: ${error.message}`);
				process.exitCode = 2;
			})
			.once("close", (code) => {
				const exit = code ?? 1;
				if (marks !== undefined && started) {
					try {
						writeTypecheckMark(marks.dir, marks.pkg, exit);
					} catch (error) {
						console.error(`run: the typecheck mark wasn't written (${reason(error)})`);
						process.exitCode = 2;
						return;
					}
				}
				process.exitCode ??= exit;
			});
	} catch (error) {
		console.error(`run: ${error instanceof Error ? error.message : String(error)}`);
		process.exitCode = 2;
	}
}
