import type { SupervisedPlatform } from "./runtime.ts";

/** Set to empty strings so libuv injects none of its own values for them (ADR 0003). */
export const WINDOWS_EMPTY_NAMES: readonly string[] = Object.freeze([
	"HOMEDRIVE",
	"HOMEPATH",
	"LOGONSERVER",
	"PATH",
	"SYSTEMDRIVE",
	"USERDOMAIN",
	"USERNAME",
	"WINDIR",
]);
export const WINDOWS_DATA_NAMES: readonly string[] = Object.freeze([
	"USERPROFILE",
	"APPDATA",
	"LOCALAPPDATA",
	"TEMP",
	"TMP",
]);
export const POSIX_DATA_NAMES: readonly string[] = Object.freeze(["HOME", "TMPDIR"]);
const COPIED_NAMES = ["LANG", "TZ"];

export interface EnvironmentInput {
	readonly pluginId: string;
	readonly instanceId: string;
	readonly dataDir: string;
	readonly platform: SupervisedPlatform;
	readonly systemRoot: string | undefined;
	readonly parentEnv: Readonly<Record<string, string | undefined>>;
}

/** The exact plugin environment, built from nothing: no NODE_OPTIONS, NODE_CHANNEL_* or PATH value. */
export function pluginEnvironment(input: EnvironmentInput): Readonly<Record<string, string>> {
	const env = Object.create(null) as Record<string, string>;
	env.DRAFTYAK_PLUGIN_ID = input.pluginId;
	env.DRAFTYAK_INSTANCE_ID = input.instanceId;
	for (const name of COPIED_NAMES) {
		const value = input.parentEnv[name];
		if (typeof value === "string" && /^[\x20-\x7e]{1,256}$/.test(value)) env[name] = value;
	}
	if (input.platform === "win32") {
		if (input.systemRoot === undefined) throw new TypeError("SystemRoot is required on Windows");
		env.SystemRoot = input.systemRoot;
		for (const name of WINDOWS_DATA_NAMES) env[name] = input.dataDir;
		for (const name of WINDOWS_EMPTY_NAMES) env[name] = "";
	} else {
		for (const name of POSIX_DATA_NAMES) env[name] = input.dataDir;
	}
	return Object.freeze(env);
}
