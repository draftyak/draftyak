import { type ChildProcess, spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { type ArgvSpec, assertExecArgvAllowed, buildArgv, buildExecArgv } from "./argv.ts";

// MCP on stdin/stdout, redacted logs on stderr, and the host channel on fd 3 (plan §4 Transport).
// The plugin's Node opens fd 3 as its IPC channel (PLUGIN_CHANNEL_ENV), so process.send works there;
// the hub reads it as a plain pipe through host-channel.ts, never with stdio 'ipc', whose parent-side
// parser a plugin can crash. Windows needs 'overlapped' for the child's IPC end (libuv asserts on a
// synchronous pipe). JSON mode carries handles too, so it is not a handle barrier: the decoder is.
export const PLUGIN_STDIO = ["pipe", "pipe", "pipe", "overlapped"] as const;
export const PLUGIN_CHANNEL_ENV: Readonly<Record<string, string>> = Object.freeze({
	NODE_CHANNEL_FD: "3",
	NODE_CHANNEL_SERIALIZATION_MODE: "json",
});

const SHIM = /\.(?:bat|cmd|ps1)[\s.]*$/i;

export interface LinkFinding {
	readonly path: string;
	// symlink/junction (lstat says symbolic link) or hardlink (regular file, nlink > 1); unreadable
	// (a dir or entry the scan could not stat or list) and irregular (a fifo, socket or device) fail
	// closed, because an unscannable bundle is not a safe bundle.
	readonly kind: "symlink" | "hardlink" | "unreadable" | "irregular";
}

export class RefusedSpawnError extends Error {
	override name = "RefusedSpawnError";
	readonly code = "DY_REFUSED_SPAWN";
	readonly finding: LinkFinding;
	constructor(message: string, finding: LinkFinding) {
		super(message);
		this.finding = finding;
	}
}

const fold = (p: string): string => (process.platform === "win32" ? p.toLowerCase() : p);

// A plugin bundle is unpacked read-only with no links; before every spawn the hub refuses it on any
// link of any kind, because Node's permission model follows a lexically in-grant path to its real
// target (plan §4; S2 controls confirm a planted symlink, junction or hard link is read through on
// both Nodes and both OSes). A symlink or Windows junction shows up through lstat as a symbolic link;
// a hard link shows up as a regular file with nlink > 1. The scan fails closed: each root must be a
// real directory that is its own realpath, every directory must list, every entry must stat, and any
// fifo/socket/device is refused. The writable data dir is the plugin's own area and is not scanned
// (it cannot be hashed against an install record); S2 records that it must be link-free at spawn, a
// condition only a same-user process could violate, which guardrail 9 already places out of scope.
export function preSpawnLinkScan(dirs: readonly string[]): LinkFinding | null {
	for (const dir of dirs) {
		const root = path.resolve(dir);
		let rootStat: fs.Stats;
		try {
			rootStat = fs.lstatSync(root);
		} catch {
			return { path: root, kind: "unreadable" };
		}
		if (rootStat.isSymbolicLink()) return { path: root, kind: "symlink" };
		if (!rootStat.isDirectory()) return { path: root, kind: "irregular" };
		try {
			if (fold(fs.realpathSync(root)) !== fold(root)) return { path: root, kind: "symlink" };
		} catch {
			return { path: root, kind: "unreadable" };
		}
		const stack: string[] = [root];
		while (stack.length > 0) {
			const current = stack.pop() as string;
			let entries: fs.Dirent[];
			try {
				entries = fs.readdirSync(current, { withFileTypes: true });
			} catch {
				return { path: current, kind: "unreadable" };
			}
			for (const entry of entries) {
				const full = path.join(current, entry.name);
				if (entry.isSymbolicLink()) return { path: full, kind: "symlink" };
				if (entry.isDirectory()) {
					stack.push(full);
				} else if (entry.isFile()) {
					const stats = fs.lstatSync(full, { throwIfNoEntry: false });
					if (!stats) return { path: full, kind: "unreadable" };
					if (stats.nlink > 1) return { path: full, kind: "hardlink" };
				} else {
					return { path: full, kind: "irregular" };
				}
			}
		}
	}
	return null;
}

export interface ScrubEnvSpec {
	readonly pluginId: string;
	readonly instanceId: string;
	// home and temp point here (plan §4 Environment); the plugin never sees the real profile paths.
	readonly dataDir: string;
	readonly parentEnv?: NodeJS.ProcessEnv;
	readonly platform?: NodeJS.Platform;
}

// §4 Environment: scrubbed to plugin and instance ids, LANG, TZ, SystemRoot and Node's NODE_CHANNEL_*
// IPC variables (which spawnPlugin adds for the fd-3 channel); home and temp point at the data dir.
// The result is built from an empty object, never the parent's, so NODE_OPTIONS and every
// other variable are dropped. On Windows, libuv injects a required variable only when it is absent, so
// PATH, USERNAME, USERDOMAIN, LOGONSERVER, SYSTEMDRIVE and WINDIR are all set empty here to keep the
// real values out of the child. os.userInfo() and os.hostname() still return the real user, home and
// host through OS APIs regardless of the env; that residual is accepted and recorded for ADR 0003.
export function scrubEnv(spec: ScrubEnvSpec): Record<string, string> {
	const parent = spec.parentEnv ?? process.env;
	const platform = spec.platform ?? process.platform;
	const data = spec.dataDir;
	const env: Record<string, string> = {
		DRAFTYAK_PLUGIN_ID: spec.pluginId,
		DRAFTYAK_INSTANCE_ID: spec.instanceId,
	};
	if (parent.LANG !== undefined) env.LANG = parent.LANG;
	if (parent.TZ !== undefined) env.TZ = parent.TZ;
	if (platform === "win32") {
		env.SystemRoot = parent.SystemRoot ?? parent.SYSTEMROOT ?? "C:\\Windows";
		env.USERPROFILE = data;
		env.APPDATA = data;
		env.LOCALAPPDATA = data;
		env.TEMP = data;
		env.TMP = data;
		env.HOMEDRIVE = "";
		env.HOMEPATH = "";
		env.PATH = "";
		env.USERNAME = "";
		env.USERDOMAIN = "";
		env.LOGONSERVER = "";
		env.SYSTEMDRIVE = "";
		env.WINDIR = "";
	} else {
		env.HOME = data;
		env.TMPDIR = data;
	}
	return env;
}

export interface SpawnPluginSpec {
	readonly nodeBin: string;
	readonly runtime?: "node" | "python";
	readonly pluginDir: string;
	readonly dataDir: string;
	readonly runtimeDir?: string;
	// Variant B for node plugins: also grant read and write on the data dir.
	readonly grantData?: boolean;
	readonly pluginId: string;
	readonly instanceId: string;
	readonly entry: string;
	readonly entryArgs?: readonly string[];
	readonly parentEnv?: NodeJS.ProcessEnv;
	readonly signal?: AbortSignal;
	// The dirs the pre-spawn link scan covers (default: the plugin bundle and any runtime dir).
	readonly scanDirs?: readonly string[];
}

export function execArgvFor(spec: SpawnPluginSpec): ArgvSpec {
	return {
		runtime: spec.runtime ?? "node",
		pluginDir: spec.pluginDir,
		dataDir: spec.grantData ? spec.dataDir : undefined,
		runtimeDir: spec.runtimeDir,
	};
}

// Spawns a plugin the way the hub does: the §4 argv (re-verified against the allowlist, --permission
// first, before use), the scrubbed env, an explicit cwd at the plugin dir so the hub's cwd never
// leaks, the fd-3 channel, and never a shell. Refuses first if the bundle holds any link or cannot
// be scanned (RefusedSpawnError). The hub reads fd 3 only through attachHostChannel.
export function spawnPlugin(spec: SpawnPluginSpec): ChildProcess {
	if (SHIM.test(spec.nodeBin)) throw new Error(`refusing to spawn a shell shim: ${spec.nodeBin}`);
	const argvSpec = execArgvFor(spec);
	const execArgv = buildExecArgv(argvSpec);
	assertExecArgvAllowed(execArgv);
	if (execArgv[0] !== "--permission") throw new Error("exec argv must start with --permission");
	const scanDirs = spec.scanDirs ?? [spec.pluginDir, ...(spec.runtimeDir ? [spec.runtimeDir] : [])];
	const finding = preSpawnLinkScan(scanDirs);
	if (finding !== null) {
		throw new RefusedSpawnError(
			`refusing to spawn: ${finding.kind} in the plugin bundle (${finding.path})`,
			finding,
		);
	}
	const argv = buildArgv(argvSpec, spec.entry, spec.entryArgs);
	if (argv.slice(0, execArgv.length).join("\u0000") !== execArgv.join("\u0000")) {
		throw new Error("built argv does not start with the verified exec argv");
	}
	const env = { ...scrubEnv(spec), ...PLUGIN_CHANNEL_ENV };
	return spawn(spec.nodeBin, argv, {
		env,
		cwd: spec.pluginDir,
		stdio: [...PLUGIN_STDIO],
		windowsHide: true,
		signal: spec.signal,
	});
}
