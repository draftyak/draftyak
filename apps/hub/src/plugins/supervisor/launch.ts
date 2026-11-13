import { lstatSync, mkdirSync, realpathSync } from "node:fs";
import path from "node:path";
import {
	buildPluginArgv,
	checkPluginArgv,
	PLUGIN_ALLOWED_FLAGS,
	PLUGIN_NEVER_FLAGS,
	type PluginArgvSpec,
} from "@draftyak/protocol/plugin-argv";
import { type InstalledBundle, verifyBundle } from "../../artifacts/index.ts";
import { refuse, type SupervisorErrorCode } from "./errors.ts";
import type { SupervisedPlatform } from "./runtime.ts";

/** Values that become grant flags: absolute, no grant separators, globs or controls. */
// biome-ignore lint/suspicious/noControlCharactersInRegex: grant values cannot hold controls.
export const GRANT_UNSAFE: RegExp = /[*?,=\u0000-\u001f\u007f]/;

function fold(value: string, platform: SupervisedPlatform): string {
	const resolved = path.resolve(value);
	return platform === "win32" ? resolved.toLowerCase() : resolved;
}

/** Neither path equals or lies inside the other (case-folded on Windows). */
export function disjoint(a: string, b: string, platform: SupervisedPlatform): boolean {
	const left = fold(a, platform);
	const right = fold(b, platform);
	const inside = (outer: string, inner: string): boolean => {
		const relative = path.relative(outer, inner);
		return (
			relative === "" ||
			(relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative))
		);
	};
	return !inside(left, right) && !inside(right, left);
}

/** Verify the exact tree once at activation; the entry must come from inside its own root. */
export async function activationEntry(bundle: InstalledBundle): Promise<string> {
	let entry: string;
	try {
		entry = await verifyBundle(bundle);
	} catch {
		return refuse("BUNDLE_REFUSED");
	}
	const wanted = path.join(bundle.directory, bundle.inventory.entry);
	const relative = path.relative(bundle.directory, entry);
	if (
		entry !== wanted ||
		relative === "" ||
		relative === ".." ||
		relative.startsWith(`..${path.sep}`) ||
		path.isAbsolute(relative)
	)
		return refuse("BUNDLE_REFUSED");
	return entry;
}

/** The re-hash before every spawn: true only for an unchanged tree with the same entry. */
export async function verifiedAgain(bundle: InstalledBundle, entry: string): Promise<boolean> {
	try {
		return (await verifyBundle(bundle)) === entry;
	} catch {
		return false;
	}
}

function ensureLevel(level: string, platform: SupervisedPlatform, create: boolean): void {
	if (create) {
		try {
			mkdirSync(level, { mode: 0o700 });
		} catch (error) {
			if ((error as NodeJS.ErrnoException | null)?.code !== "EEXIST") throw error;
		}
	}
	const stat = lstatSync(level);
	if (!stat.isDirectory() || stat.isSymbolicLink() || realpathSync.native(level) !== level)
		throw new Error("Data directory refused");
	if (
		platform !== "win32" &&
		(stat.uid !== process.getuid?.() || (stat.mode & 0o077) !== 0 || (stat.mode & 0o700) !== 0o700)
	)
		throw new Error("Data directory refused");
}

/** <dataRoot>/<pluginId>/<instanceId>, made one 0700 level at a time; never scanned or deleted. */
export function ensureDataDir(
	dataRoot: string,
	pluginId: string,
	instanceId: string,
	platform: SupervisedPlatform,
): string {
	const plugin = path.join(dataRoot, pluginId);
	const instance = path.join(plugin, instanceId);
	try {
		ensureLevel(dataRoot, platform, false);
		ensureLevel(plugin, platform, true);
		ensureLevel(instance, platform, true);
	} catch {
		return refuse("DATA_DIR_REFUSED");
	}
	return instance;
}

/**
 * The production argv: exactly the shared builder's output, rechecked against the same trusted
 * configuration and the allowlist. The only filesystem grants are the plugin root and, when the
 * manifest declares it, the instance's data directory.
 */
export function launchArgv(
	pluginDir: string,
	entry: string,
	dataDir: string | undefined,
	code: SupervisorErrorCode,
): readonly string[] {
	const spec: PluginArgvSpec =
		dataDir === undefined ? { pluginDir, entry } : { pluginDir, dataDir, entry };
	let argv: string[];
	try {
		argv = buildPluginArgv(spec);
	} catch {
		return refuse(code);
	}
	if (checkPluginArgv(argv, spec).length !== 0 || argv[0] !== "--permission") return refuse(code);
	if (argv.at(-1) !== entry) return refuse(code);
	const flags = argv.slice(0, -1);
	if (flags.length !== (dataDir === undefined ? 7 : 9)) return refuse(code);
	for (const flag of flags) {
		const name = flag.split("=", 1)[0] as string;
		if (
			!PLUGIN_ALLOWED_FLAGS.includes(name) ||
			PLUGIN_NEVER_FLAGS.includes(name) ||
			/^--(?:inspect|debug)/.test(flag)
		)
			return refuse(code);
	}
	return Object.freeze(argv);
}
