import { existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { type ExecResult, execSync } from "./exec.ts";

export const kitDir: string = import.meta.dirname;
export const repoRoot: string = path.resolve(kitDir, "..", "..");

// `git rev-parse --local-env-vars` plus GIT_NAMESPACE. Hooks, `rebase -x` and `bisect run` export
// some of them, and with them `git -C <dir>` acts on that outer repository instead of <dir>'s.
const REPO_VARS = new Set([
	...["GIT_DIR", "GIT_WORK_TREE", "GIT_INDEX_FILE", "GIT_COMMON_DIR", "GIT_OBJECT_DIRECTORY"],
	...["GIT_ALTERNATE_OBJECT_DIRECTORIES", "GIT_IMPLICIT_WORK_TREE", "GIT_PREFIX", "GIT_NAMESPACE"],
	...["GIT_CONFIG", "GIT_CONFIG_PARAMETERS", "GIT_CONFIG_COUNT", "GIT_GRAFT_FILE"],
	...["GIT_NO_REPLACE_OBJECTS", "GIT_REPLACE_REF_BASE", "GIT_SHALLOW_FILE"],
	// Calls choose their own pathspec magic; inherited flags must not reinterpret it.
	...["GIT_LITERAL_PATHSPECS", "GIT_GLOB_PATHSPECS", "GIT_NOGLOB_PATHSPECS", "GIT_ICASE_PATHSPECS"],
]);

export function gitEnv(env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
	return Object.fromEntries(
		Object.entries(env).filter(([name]) => !REPO_VARS.has(name.toUpperCase())),
	);
}

// git on the repository at `cwd`, whatever repository the calling process runs in.
export function git(cwd: string, ...args: string[]): ExecResult {
	return execSync("git", ["-C", cwd, ...args], { env: gitEnv(), timeoutMs: 30_000 });
}

export interface GitPaths {
	readonly gitDir: string;
	readonly commonDir: string;
	readonly toplevel: string;
}

export function gitPaths(cwd: string): GitPaths | null {
	const args = ["rev-parse", "--path-format=absolute", "--git-dir", "--git-common-dir"];
	try {
		const result = git(cwd, ...args, "--show-toplevel");
		const lines = result.stdout.trim().split(/\r?\n/);
		const [gitDir, commonDir, toplevel] = lines.map((line) => path.resolve(line));
		if (result.code !== 0 || lines.length !== 3 || !gitDir || !commonDir || !toplevel) return null;
		return { gitDir, commonDir, toplevel };
	} catch {
		return null;
	}
}

export function isLinkedWorktree(paths: GitPaths): boolean {
	const fold = (dir: string): string => (process.platform === "win32" ? dir.toLowerCase() : dir);
	return fold(paths.gitDir) !== fold(paths.commonDir);
}

// DRAFTYAK_CACHE_DIR (absolute), else fetch-node's default (M0.5): C:/dev/.draftyak-cache on
// Windows, $XDG_CACHE_HOME/draftyak or ~/.cache/draftyak elsewhere.
export function cacheDir(env: NodeJS.ProcessEnv = process.env): string {
	const dir = env.DRAFTYAK_CACHE_DIR;
	if (dir && !path.isAbsolute(dir)) throw new Error(`DRAFTYAK_CACHE_DIR must be absolute: ${dir}`);
	if (dir) return path.resolve(dir);
	if (process.platform === "win32") return "C:/dev/.draftyak-cache";
	return path.join(env.XDG_CACHE_HOME || path.join(os.homedir(), ".cache"), "draftyak");
}

// Node's directory lookup, without package exports getting in the way.
export function findPackageDir(name: string, from: string): string | null {
	for (let dir = path.resolve(from); ; dir = path.dirname(dir)) {
		const candidate = path.join(dir, "node_modules", name);
		if (existsSync(path.join(candidate, "package.json"))) return candidate;
		if (path.dirname(dir) === dir) return null;
	}
}
