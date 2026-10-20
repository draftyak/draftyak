import path from "node:path";

/** Minimum supported plugin Node version; checking the actual executable belongs to the parent. */
export const PLUGIN_NODE_MINIMUM_VERSION = "26.5.1";

/** Node-runtime exec flags only. Application arguments follow the entry and are not exec flags. */
export const PLUGIN_ALLOWED_FLAGS: readonly string[] = Object.freeze([
	"--permission",
	"--allow-fs-read",
	"--allow-fs-write",
	"--no-experimental-sqlite",
	"--disable-sigusr1",
	"--disallow-code-generation-from-strings",
	"--freeze-flags-after-init",
	"--max-old-space-size",
]);

export const PLUGIN_NEVER_FLAGS: readonly string[] = Object.freeze([
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

/** Trusted parent configuration. Paths must already have passed the parent's realpath/link checks. */
export interface PluginArgvSpec {
	readonly runtime?: "node";
	readonly pluginDir: string;
	readonly dataDir?: string;
	readonly entry: string;
	readonly entryArgs?: readonly string[];
}

export interface PluginArgvProblem {
	readonly reason: "invalid-configuration" | "invalid-argv" | "configuration-mismatch";
	readonly index?: number;
}

function assertPath(label: string, value: string): void {
	if (
		typeof value !== "string" ||
		!path.isAbsolute(value) ||
		// Windows root-relative paths depend on the parent's current drive, not just this value.
		(process.platform === "win32" &&
			!/^(?:[a-z]:[\\/]|[\\/]{2}[^\\/]+[\\/][^\\/]+)/i.test(value)) ||
		/[*?,=]/.test(value) ||
		// biome-ignore lint/suspicious/noControlCharactersInRegex: argv paths cannot contain controls.
		/[\u0000-\u001f\u007f]/.test(value)
	) {
		throw new TypeError(`${label} must be an absolute path without controls or grant separators`);
	}
}

function assertDisjoint(pluginDir: string, dataDir: string): void {
	const fold = (value: string): string => {
		const resolved = path.resolve(value);
		return process.platform === "win32" ? resolved.toLowerCase() : resolved;
	};
	const plugin = fold(pluginDir);
	const data = fold(dataDir);
	const contains = (outer: string, inner: string): boolean => {
		const relative = path.relative(outer, inner);
		return (
			relative === "" ||
			(relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative))
		);
	};
	if (contains(plugin, data) || contains(data, plugin)) {
		throw new TypeError("pluginDir and dataDir must be disjoint");
	}
}

/** Builds the complete canonical Node argv, excluding the executable itself. Never spawns. */
export function buildPluginArgv(spec: PluginArgvSpec): string[] {
	if (
		!spec ||
		typeof spec !== "object" ||
		Array.isArray(spec) ||
		Object.keys(spec).some(
			(key) => !["runtime", "pluginDir", "dataDir", "entry", "entryArgs"].includes(key),
		)
	) {
		throw new TypeError("Expected a Node plugin argv configuration");
	}
	// Read each field once: readonly interfaces can still have stateful getters.
	const { runtime, pluginDir, dataDir, entry, entryArgs } = spec;
	if (runtime !== undefined && runtime !== "node") {
		throw new TypeError("Expected a Node plugin argv configuration");
	}
	assertPath("pluginDir", pluginDir);
	assertPath("entry", entry);
	const argv = ["--permission", `--allow-fs-read=${pluginDir}`];
	if (dataDir !== undefined) {
		assertPath("dataDir", dataDir);
		assertDisjoint(pluginDir, dataDir);
		argv.push(`--allow-fs-read=${dataDir}`, `--allow-fs-write=${dataDir}`);
	}
	if (entryArgs !== undefined && !Array.isArray(entryArgs)) {
		throw new TypeError("entryArgs must be strings without NUL bytes");
	}
	// Materialize once so validation and emission use the same iterator values.
	const args = entryArgs === undefined ? [] : Array.from(entryArgs);
	if (args.some((arg) => typeof arg !== "string" || arg.includes("\0"))) {
		throw new TypeError("entryArgs must be strings without NUL bytes");
	}
	argv.push(
		"--no-experimental-sqlite",
		"--disable-sigusr1",
		"--disallow-code-generation-from-strings",
		"--freeze-flags-after-init",
		"--max-old-space-size=256",
		entry,
		...args,
	);
	return argv;
}

/**
 * Checks a full argv against separately trusted configuration, including exact order and values.
 * Checks one indexed argv snapshot; later mutation or execution belongs to the parent.
 * Checking an argv against configuration derived from that same argv establishes no trust.
 */
export function checkPluginArgv(
	argv: readonly string[],
	expected: PluginArgvSpec,
): PluginArgvProblem[] {
	let canonical: string[];
	try {
		canonical = buildPluginArgv(expected);
	} catch {
		return [{ reason: "invalid-configuration" }];
	}
	let tokens: string[];
	try {
		if (!Array.isArray(argv)) return [{ reason: "invalid-argv" }];
		// An array's iterator can disagree with its indexed arguments. Never consult it.
		const length = argv.length;
		if (!Number.isInteger(length) || length < 0 || length > 0xffff_ffff) {
			return [{ reason: "invalid-argv" }];
		}
		tokens = [];
		for (let index = 0; index < length; index++) {
			const token = argv[index];
			if (typeof token !== "string") return [{ reason: "invalid-argv" }];
			tokens.push(token);
		}
	} catch {
		return [{ reason: "invalid-argv" }];
	}
	const problems: PluginArgvProblem[] = [];
	for (let index = 0; index < Math.max(tokens.length, canonical.length); index++) {
		if (tokens[index] !== canonical[index]) {
			problems.push({ reason: "configuration-mismatch", index });
		}
	}
	return problems;
}

/** Stable Node release comparison only; this does not inspect or authorize an executable. */
export function isPluginNodeVersionSupported(version: string): boolean {
	if (typeof version !== "string") return false;
	const match = /^v?(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.exec(version);
	if (!match) return false;
	const parts = match.slice(1).map(Number);
	if (!parts.every(Number.isSafeInteger)) return false;
	const [major = 0, minor = 0, patch = 0] = parts;
	return major > 26 || (major === 26 && (minor > 5 || (minor === 5 && patch >= 1)));
}
