import { SNAPSHOT_UNICODE_VERSION } from "@draftyak/protocol/snapshot";

export type StartupRefusalCode =
	| "LAUNCH_ARGUMENTS"
	| "LAUNCH_FLAGS"
	| "KEY_SOURCE_POSTPONED"
	| "UNICODE_VERSION"
	| "DATA_DIR_INVALID"
	| "DATA_DIR_SYNCED"
	| "DATA_DIR_OWNERSHIP"
	| "DATA_DIR_LOCKED"
	| "DATA_DIR_LOCK_IO";

/** Fixed and content-free: no path, argument or environment value is carried. */
export class StartupRefusal extends Error {
	readonly code: StartupRefusalCode;
	constructor(code: StartupRefusalCode) {
		super(code);
		this.name = "StartupRefusal";
		this.code = code;
	}
}

export interface LaunchInput {
	/** The arguments after the entry script. */
	readonly argv: readonly string[];
	readonly execArgv: readonly string[];
	/** `process.versions.unicode`. */
	readonly unicodeVersion: string | undefined;
	/** `globalThis.Temporal`. */
	readonly temporal: unknown;
}

export type LaunchCheck =
	| { readonly temporal: true }
	| { readonly temporal: false; readonly warning: "TEMPORAL_MISSING" };

const TEMPORAL: LaunchCheck = Object.freeze({ temporal: true });
const NO_TEMPORAL: LaunchCheck = Object.freeze({ temporal: false, warning: "TEMPORAL_MISSING" });
// Variables Node applies like launch flags: module and code loading, TLS trust, proxying, ICU data
// and files it writes. Presence alone refuses.
const FLAG_VARIABLES = [
	"NODE_OPTIONS",
	"NODE_PATH",
	"NODE_PRESERVE_SYMLINKS",
	"NODE_COMPILE_CACHE",
	"NODE_TLS_REJECT_UNAUTHORIZED",
	"NODE_EXTRA_CA_CERTS",
	"NODE_USE_SYSTEM_CA",
	"OPENSSL_CONF",
	"NODE_USE_ENV_PROXY",
	"NODE_ICU_DATA",
	"NODE_V8_COVERAGE",
	"NODE_REDIRECT_WARNINGS",
] as const;
// Postponed headless key sources. Presence alone refuses, so no value is ever read.
const POSTPONED_KEY_SOURCES = ["DRAFTYAK_MASTER_KEY", "CREDENTIALS_DIRECTORY"] as const;

/**
 * Refuses unexpected arguments, flags, key sources or Unicode; missing Temporal only warns. The
 * environment is always the live `process.env`: a copy would hold every value and, on Windows,
 * miss a name in another letter case that Node still applies.
 */
export function checkLaunch(input: LaunchInput): LaunchCheck {
	const { argv, execArgv, unicodeVersion, temporal } = input;
	const env = process.env;
	if (argv.length !== 0) throw new StartupRefusal("LAUNCH_ARGUMENTS");
	if (
		execArgv.length !== 1 ||
		execArgv[0] !== "--disable-sigusr1" ||
		FLAG_VARIABLES.some((name) => name in env)
	)
		throw new StartupRefusal("LAUNCH_FLAGS");
	if (POSTPONED_KEY_SOURCES.some((name) => name in env))
		throw new StartupRefusal("KEY_SOURCE_POSTPONED");
	if (unicodeVersion !== SNAPSHOT_UNICODE_VERSION) throw new StartupRefusal("UNICODE_VERSION");
	return typeof temporal === "undefined" ? NO_TEMPORAL : TEMPORAL;
}
