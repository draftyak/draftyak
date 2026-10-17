// The supervisor builds a plugin's Node argv only from this allowlist (plan §4 Flags). A snapshot
// test pins the result, so a flag Node adds in a later release is never passed by accident.

import path from "node:path";

export type Runtime = "node" | "python";

export interface ArgvSpec {
	readonly runtime?: Runtime;
	// The plugin bundle directory (always granted read). Node must be able to load the entry from it.
	readonly pluginDir: string;
	// A node plugin's optional own data dir (granted read and write); never overlaps pluginDir.
	readonly dataDir?: string;
	// A python plugin's runtime dir (granted a second, separate read); python gets no data grant.
	readonly runtimeDir?: string;
}

// Allowed flags, by name (the part before "="). Value flags appear as "<name>=<value>" in argv.
// --freeze-flags-after-init is added by S2b (M0.12): v8.setFlagsFromString('--allow-natives-syntax')
// weakens V8 at runtime on both Nodes, and natives then compile through node:vm, which
// --disallow-code-generation-from-strings does not block. With the freeze flag set, any runtime
// setFlagsFromString aborts the plugin instead of weakening V8 (evidence/v8flags-*.json).
export const ALLOWED_FLAGS: readonly string[] = Object.freeze([
	"--permission",
	"--allow-fs-read",
	"--allow-fs-write",
	"--no-experimental-sqlite",
	"--disable-sigusr1",
	"--disallow-code-generation-from-strings",
	"--freeze-flags-after-init",
	"--max-old-space-size",
	"--wasm-max-mem-pages",
]);

// Flags that must never reach a plugin. --allow-worker, --allow-fs-vfs, --experimental-vfs and
// --vfs-load are singled out in §4 and the S2 task. The VFS trio is denied in full: --experimental-vfs
// alone loads node:vfs and lets a VirtualFileSystem construct (26.12.0), and although mounting it still
// needs --allow-fs-vfs, the trio is never-listed as defense in depth (S2 control: control-vfs).
export const NEVER_FLAGS: readonly string[] = Object.freeze([
	"--allow-net",
	"--allow-child-process",
	"--allow-worker",
	"--allow-addons",
	"--allow-wasi",
	"--allow-inspector",
	"--allow-ffi",
	"--allow-openssl-store",
	"--experimental-ffi",
	"--experimental-sqlite",
	"--allow-fs-vfs",
	"--experimental-vfs",
	"--vfs-load",
]);

const HEAP_MB = 256;
// A 512 MiB wasm heap cap for python (a limit, not a grant): 8192 × 64 KiB pages.
const WASM_MAX_PAGES = 8192;

// A directory or entry path safe to place in argv. It must be absolute and must not be a wildcard,
// a flag, or hold a character Node parses specially: "*" is Node's grant-everything value, "," and
// "=" split a single --allow-fs-* flag into several paths, and a leading "-" makes an entry parse as
// an option (both verified against 26.5.1 and 26.12.0). Relative paths are refused outright.
function assertPathArg(label: string, value: string): void {
	const bad =
		value === "" ||
		value === "*" ||
		!path.isAbsolute(value) ||
		value.startsWith("-") ||
		/[*?,=]/.test(value) ||
		// biome-ignore lint/suspicious/noControlCharactersInRegex: argv must carry no control bytes.
		/[\u0000-\u001f]/.test(value);
	if (bad)
		throw new Error(
			`${label} must be an absolute path with no wildcard or separator, got ${JSON.stringify(value)}`,
		);
}

// §4: the data (or runtime) dir never overlaps pluginDir. A read grant covers everything under its
// path, so an equal or nested second grant would silently widen the first.
function assertDisjoint(dirs: readonly (readonly [string, string])[]): void {
	const fold = (dir: string): string =>
		process.platform === "win32" ? path.resolve(dir).toLowerCase() : path.resolve(dir);
	for (let i = 0; i < dirs.length; i++) {
		for (let j = i + 1; j < dirs.length; j++) {
			const [aLabel, a] = dirs[i] as readonly [string, string];
			const [bLabel, b] = dirs[j] as readonly [string, string];
			const ra = fold(a);
			const rb = fold(b);
			const inside = (outer: string, inner: string): boolean => {
				if (outer === inner) return true;
				const rel = path.relative(outer, inner);
				return rel !== "" && !rel.startsWith("..") && !path.isAbsolute(rel);
			};
			if (inside(ra, rb) || inside(rb, ra)) {
				throw new Error(`${aLabel} and ${bLabel} must be disjoint: ${JSON.stringify([a, b])}`);
			}
		}
	}
}

export function flagName(token: string): string {
	const eq = token.indexOf("=");
	return eq === -1 ? token : token.slice(0, eq);
}

// The exec argv (the Node flags only), in a fixed canonical order so the snapshot is stable.
export function buildExecArgv(spec: ArgvSpec): string[] {
	const runtime = spec.runtime ?? "node";
	assertPathArg("pluginDir", spec.pluginDir);
	const grants: (readonly [string, string])[] = [["pluginDir", spec.pluginDir]];
	const argv = ["--permission", `--allow-fs-read=${spec.pluginDir}`];
	if (runtime === "node") {
		if (spec.dataDir !== undefined) {
			assertPathArg("dataDir", spec.dataDir);
			grants.push(["dataDir", spec.dataDir]);
			argv.push(`--allow-fs-read=${spec.dataDir}`, `--allow-fs-write=${spec.dataDir}`);
		}
	} else {
		if (spec.runtimeDir === undefined) throw new Error("python plugins need a runtimeDir");
		assertPathArg("runtimeDir", spec.runtimeDir);
		grants.push(["runtimeDir", spec.runtimeDir]);
		argv.push(`--allow-fs-read=${spec.runtimeDir}`);
	}
	assertDisjoint(grants);
	argv.push(
		"--no-experimental-sqlite",
		"--disable-sigusr1",
		"--disallow-code-generation-from-strings",
		"--freeze-flags-after-init",
		`--max-old-space-size=${HEAP_MB}`,
	);
	if (runtime === "python") argv.push(`--wasm-max-mem-pages=${WASM_MAX_PAGES}`);
	return argv;
}

// The full process argv: the exec flags, the entry script, then the entry's own arguments.
export function buildArgv(
	spec: ArgvSpec,
	entry: string,
	entryArgs: readonly string[] = [],
): string[] {
	assertPathArg("entry", entry);
	return [...buildExecArgv(spec), entry, ...entryArgs];
}

export interface ArgvProblem {
	readonly token: string;
	readonly reason:
		| "not-a-flag"
		| "not-allowed"
		| "on-never-list"
		| "bad-grant-value"
		| "missing-permission";
}

// Verifies every exec-argv token is an allowlisted flag, none is on the never-list, every fs grant
// carries a concrete absolute path (never "*" or a wildcard), and --permission is present. The same
// check guards a built argv before spawn (spawnPlugin calls assertExecArgvAllowed) and backs the
// snapshot test.
export function checkExecArgv(execArgv: readonly string[]): ArgvProblem[] {
	const allowed = new Set(ALLOWED_FLAGS);
	const never = new Set(NEVER_FLAGS);
	const problems: ArgvProblem[] = [];
	for (const token of execArgv) {
		const name = flagName(token);
		if (!token.startsWith("--")) problems.push({ token, reason: "not-a-flag" });
		else if (never.has(name) || name.startsWith("--inspect") || name === "--debug-port") {
			problems.push({ token, reason: "on-never-list" });
		} else if (!allowed.has(name)) {
			problems.push({ token, reason: "not-allowed" });
		} else if (name === "--allow-fs-read" || name === "--allow-fs-write") {
			const value = token.slice(name.length + 1);
			if (token.indexOf("=") === -1 || value === "" || value === "*" || /[*?,]/.test(value)) {
				problems.push({ token, reason: "bad-grant-value" });
			}
		}
	}
	if (!execArgv.includes("--permission")) {
		problems.push({ token: "(exec argv)", reason: "missing-permission" });
	}
	return problems;
}

export function assertExecArgvAllowed(execArgv: readonly string[]): void {
	const problems = checkExecArgv(execArgv);
	if (problems.length > 0) {
		const detail = problems.map((p) => `${p.token} (${p.reason})`).join(", ");
		throw new Error(`argv is not on the §4 allowlist: ${detail}`);
	}
}
