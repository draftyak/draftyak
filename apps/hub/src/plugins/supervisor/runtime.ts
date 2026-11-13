import { realpathSync, statSync } from "node:fs";
import path from "node:path";
import { isPluginNodeVersionSupported } from "@draftyak/protocol/plugin-argv";
import { refuse } from "./errors.ts";

export type SupervisedPlatform = "win32" | "linux" | "darwin";

export interface RuntimeSnapshot {
	readonly platform: string;
	readonly release: string;
	readonly version: string;
	readonly execPath: string;
	/** Windows only: the hub's own SystemRoot, never a default. */
	readonly systemRoot: string | undefined;
}

export interface CheckedRuntime extends RuntimeSnapshot {
	readonly platform: SupervisedPlatform;
}

/** The facts about this hub process; checkRuntime decides whether they are acceptable. */
export function currentRuntime(): RuntimeSnapshot {
	return Object.freeze({
		platform: process.platform,
		release: process.release.name,
		version: process.versions.node,
		execPath: process.execPath,
		systemRoot: process.platform === "win32" ? process.env.SystemRoot : undefined,
	});
}

const SHIM = /\.(?:cmd|bat|ps1|sh)$/i;

function isFile(name: string): boolean {
	try {
		return statSync(name).isFile();
	} catch {
		return false;
	}
}

function isDirectory(name: string): boolean {
	try {
		return statSync(name).isDirectory();
	} catch {
		return false;
	}
}

function realExecutable(execPath: unknown): string | undefined {
	if (typeof execPath !== "string" || !path.isAbsolute(execPath) || SHIM.test(execPath))
		return undefined;
	let real: string;
	try {
		real = realpathSync.native(execPath);
	} catch {
		return undefined;
	}
	return path.isAbsolute(real) && !SHIM.test(real) && isFile(real) ? real : undefined;
}

function validSystemRoot(value: unknown): value is string {
	return (
		typeof value === "string" &&
		/^[A-Za-z]:\\[^\\]/.test(value) &&
		// biome-ignore lint/suspicious/noControlCharactersInRegex: environment values cannot hold controls.
		!/[\u0000-\u001f"]/.test(value) &&
		path.win32.resolve(value) === value &&
		isDirectory(value)
	);
}

/** One frozen snapshot every spawn reuses: a real Node executable at or above the plugin floor. */
export function checkRuntime(raw: RuntimeSnapshot): CheckedRuntime {
	const { platform, release, version, execPath, systemRoot } = raw;
	if (platform !== "win32" && platform !== "linux" && platform !== "darwin")
		return refuse("RUNTIME_UNSUPPORTED");
	if (release !== "node" || !isPluginNodeVersionSupported(version))
		return refuse("RUNTIME_UNSUPPORTED");
	const real = realExecutable(execPath);
	if (real === undefined) return refuse("RUNTIME_UNSUPPORTED");
	if (platform === "win32" && !validSystemRoot(systemRoot)) return refuse("RUNTIME_UNSUPPORTED");
	return Object.freeze({
		platform,
		release,
		version,
		execPath: real,
		systemRoot: platform === "win32" ? systemRoot : undefined,
	});
}
