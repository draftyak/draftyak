import { spawnSync } from "node:child_process";
import { lstat, realpath, stat } from "node:fs/promises";
import { url as inspectorUrl } from "node:inspector";
import path from "node:path";
import { types } from "node:util";
import { SNAPSHOT_UNICODE_VERSION } from "@draftyak/protocol/snapshot";
import { classifyNode, loadNodePolicy } from "./node-version.ts";
import { probeFlags, probeSource } from "./probe.ts";
import { isKnownSyncedPath } from "./synced-folders.ts";

export { classifyNode };

export type CheckStatus = "pass" | "warn" | "fail";
export interface DoctorCheck {
	readonly id: string;
	readonly status: CheckStatus;
	readonly code: string;
	readonly message: string;
}
export interface DoctorReport {
	readonly format: "draftyak-doctor-v1";
	readonly summary: CheckStatus;
	readonly checks: readonly DoctorCheck[];
}
export interface DiagnoseOptions {
	readonly dataDirectory?: unknown;
	readonly env?: object;
}

const check = (id: string, status: CheckStatus, code: string, message: string): DoctorCheck =>
	Object.freeze({ id, status, code, message });
const unsafe = () => new Error("Data directory unavailable");
const environmentHas = (env: object, name: string): boolean => Object.hasOwn(env, name);
const dataValue = (env: object, name: string): string | undefined => {
	const entry = Object.getOwnPropertyDescriptor(env, name);
	return entry && Object.hasOwn(entry, "value") && typeof entry.value === "string"
		? entry.value
		: undefined;
};

const comparable = (value: string): string =>
	process.platform === "win32" ? value.toLowerCase() : value;
const within = (directory: string, root: string): boolean => {
	const relative = path.relative(comparable(root), comparable(directory));
	return (
		relative === "" ||
		(relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative))
	);
};

function absoluteDirectory(value: unknown): string {
	if (
		typeof value !== "string" ||
		value.length === 0 ||
		value.length > 4_096 ||
		!value.isWellFormed() ||
		value.includes("\0") ||
		!path.isAbsolute(value)
	)
		throw unsafe();
	// Lexical normalization can change a symlink/../ path's filesystem target.
	const components = value.split(process.platform === "win32" ? /[\\/]/ : /\//);
	if (components.some((component) => component === "." || component === "..")) throw unsafe();
	if (process.platform === "win32") {
		if (!/^[a-z]:[\\/][^:]*$/i.test(value) || /[<>"|?*]/.test(value)) throw unsafe();
		for (const character of value) if (character.charCodeAt(0) < 32) throw unsafe();
		for (const component of value.slice(3).split(/[\\/]/)) {
			if (!component) continue;
			if (
				/[. ]$/.test(component) ||
				/^(?:con|prn|aux|nul|conin\$|conout\$|com[0-9¹²³]|lpt[0-9¹²³])(?:\.|$)/i.test(component)
			)
				throw unsafe();
		}
	}
	return path.resolve(value);
}

/** Resolve the nearest existing ancestor without making or opening data files. */
async function canonicalCandidate(requested: unknown): Promise<{
	readonly absolute: string;
	readonly canonical: string;
	readonly exists: boolean;
}> {
	const absolute = absoluteDirectory(requested);
	let ancestor = absolute;
	const suffix: string[] = [];
	for (;;) {
		try {
			await lstat(ancestor);
			const canonical = absoluteDirectory(await realpath(ancestor));
			if (!(await stat(canonical)).isDirectory()) throw unsafe();
			return { absolute, canonical: path.join(canonical, ...suffix), exists: suffix.length === 0 };
		} catch (error) {
			if ((error as NodeJS.ErrnoException)?.code !== "ENOENT") throw unsafe();
			// A dangling link must not be treated as an absent directory.
			try {
				await lstat(ancestor);
				throw unsafe();
			} catch (entryError) {
				if ((entryError as NodeJS.ErrnoException)?.code !== "ENOENT") throw unsafe();
			}
			const next = path.dirname(ancestor);
			if (next === ancestor) throw unsafe();
			suffix.unshift(path.basename(ancestor));
			ancestor = next;
		}
	}
}

/** Returns fixed codes only; requested paths and filesystem errors never escape. */
export async function inspectDataDirectory(
	requested?: unknown,
	syncRoots: readonly unknown[] = [],
): Promise<DoctorCheck> {
	if (requested === undefined)
		return check(
			"data_directory",
			"warn",
			"DATA_DIR_NOT_CHECKED",
			"Supply an absolute data directory.",
		);
	try {
		// Refuse unsafe configured path syntax before any of it reaches realpath.
		const roots: string[] = [];
		for (const root of syncRoots) {
			if (typeof root !== "string" || root === "") continue;
			roots.push(absoluteDirectory(root));
		}
		const candidate = await canonicalCandidate(requested);
		if (comparable(candidate.absolute) !== comparable(candidate.canonical))
			return check(
				"data_directory",
				"fail",
				"DATA_DIR_ALIAS",
				"Use the canonical local data directory.",
			);
		if (isKnownSyncedPath(candidate.absolute) || isKnownSyncedPath(candidate.canonical))
			return check(
				"data_directory",
				"fail",
				"DATA_DIR_SYNCED",
				"Choose a local unsynced data directory.",
			);
		for (const root of roots) {
			const resolved = await canonicalCandidate(root);
			if (
				within(candidate.canonical, resolved.canonical) ||
				within(candidate.absolute, resolved.absolute)
			)
				return check(
					"data_directory",
					"fail",
					"DATA_DIR_SYNCED",
					"Choose a local unsynced data directory.",
				);
		}
		return candidate.exists
			? check(
					"data_directory",
					"pass",
					"DATA_DIR_LOCAL",
					"No known sync folder or path alias detected.",
				)
			: check(
					"data_directory",
					"warn",
					"DATA_DIR_ABSENT",
					"Directory is absent; its existing ancestor passed the known path checks.",
				);
	} catch {
		return check(
			"data_directory",
			"fail",
			"DATA_DIR_UNAVAILABLE",
			"Data directory safety could not be established.",
		);
	}
}

/** The only subprocess is the current native Node executable running fixed probe source. */
export function probeRuntime(flags: unknown = probeFlags): boolean {
	try {
		if (!Array.isArray(flags) || types.isProxy(flags) || flags.length > probeFlags.length)
			return false;
		const snapshot: string[] = [];
		for (let index = 0; index < flags.length; index++) {
			const descriptor = Object.getOwnPropertyDescriptor(flags, String(index));
			if (
				!descriptor ||
				!Object.hasOwn(descriptor, "value") ||
				!probeFlags.includes(descriptor.value)
			)
				return false;
			snapshot.push(descriptor.value);
		}
		if (
			new Set(snapshot).size !== snapshot.length ||
			snapshot.at(-1) !== "--eval" ||
			!snapshot.includes("--input-type=module") ||
			!snapshot.includes("--max-old-space-size=64")
		)
			return false;
		const result = spawnSync(process.execPath, [...snapshot, probeSource], {
			env: {},
			stdio: ["ignore", "pipe", "pipe"],
			encoding: "utf8",
			timeout: 5_000,
			killSignal: "SIGKILL",
			maxBuffer: 4_096,
			windowsHide: true,
			shell: false,
		});
		if (result.error || result.signal || result.status !== 0 || result.stderr !== "") return false;
		const value = JSON.parse(result.stdout);
		const expected = [
			"permissionModel",
			"fileReadDenied",
			"stringCodeDenied",
			"sqliteDisabled",
			"signalInspectorDisabled",
			"flagsFrozen",
		];
		return (
			value !== null &&
			typeof value === "object" &&
			!Array.isArray(value) &&
			Object.keys(value).length === expected.length &&
			expected.every((key) => value[key] === true)
		);
	} catch {
		return false;
	}
}

const summarize = (checks: readonly DoctorCheck[]): CheckStatus =>
	checks.some((item) => item.status === "fail")
		? "fail"
		: checks.some((item) => item.status === "warn")
			? "warn"
			: "pass";

export async function diagnose({
	dataDirectory,
	env = process.env,
}: DiagnoseOptions = {}): Promise<DoctorReport> {
	const checks: DoctorCheck[] = [];
	const policy = loadNodePolicy();
	const family = policy.classify(process.version);
	checks.push(
		family === "full"
			? check("node_version", "pass", "NODE_FULL", `Node ${policy.minimum} or newer is available.`)
			: check("node_version", "fail", "NODE_UNSUPPORTED", "Use a supported Node release."),
	);
	if (family !== "full") return reportFor(checks);
	checks.push(
		process.versions.unicode === SNAPSHOT_UNICODE_VERSION
			? check(
					"unicode_version",
					"pass",
					"UNICODE_VERSION_MATCH",
					"Runtime Unicode matches the snapshot contract.",
				)
			: check(
					"unicode_version",
					"fail",
					"SNAPSHOT_UNICODE_VERSION",
					"Use a Node runtime with the snapshot contract's Unicode version.",
				),
	);
	let inspectorActive = true;
	try {
		inspectorActive = inspectorUrl() !== undefined;
	} catch {
		/* An unavailable inspection API cannot prove the current process is hardened. */
	}
	let signalInspectorDisabled = false;
	for (const flag of process.execArgv) {
		const name = flag.split("=", 1)[0]?.replaceAll("_", "-");
		if (name === "--disable-sigusr1") signalInspectorDisabled = true;
		if (name === "--no-disable-sigusr1") signalInspectorDisabled = false;
	}
	const isolated = signalInspectorDisabled && !inspectorActive;
	checks.push(
		isolated
			? check(
					"current_process",
					"pass",
					"INSPECTOR_DISABLED",
					"Current process explicitly disables signal-triggered inspection.",
				)
			: check(
					"current_process",
					"fail",
					"PROCESS_NOT_HARDENED",
					"Start this command with node --disable-sigusr1 and no inspector.",
				),
	);
	checks.push(
		environmentHas(env, "NODE_OPTIONS")
			? check(
					"node_options",
					"warn",
					"NODE_OPTIONS_PRESENT",
					"Inherited Node options are present; the probe uses a clean environment.",
				)
			: check(
					"node_options",
					"pass",
					"NODE_OPTIONS_ABSENT",
					"No inherited Node options are present.",
				),
	);
	checks.push(
		typeof (globalThis as typeof globalThis & { Temporal?: unknown }).Temporal !== "undefined"
			? check("temporal", "pass", "TEMPORAL_AVAILABLE", "Temporal is present.")
			: check(
					"temporal",
					"warn",
					"TEMPORAL_UNAVAILABLE",
					"New schedules fail with SCHEDULING_UNAVAILABLE; calendar lookups are off; approved items still send.",
				),
	);
	checks.push(
		probeRuntime()
			? check(
					"runtime_capabilities",
					"pass",
					"RUNTIME_FLAGS_AVAILABLE",
					"Fixed child probe enforces the required runtime restrictions.",
				)
			: check(
					"runtime_capabilities",
					"fail",
					"RUNTIME_PROBE_FAILED",
					"Required runtime restrictions could not be established.",
				),
	);
	checks.push(
		environmentHas(env, "DRAFTYAK_MASTER_KEY")
			? check(
					"master_key_environment",
					"warn",
					"MASTER_KEY_ENV_PRESENT",
					"A master-key environment entry is present; prefer an OS credential store.",
				)
			: check(
					"master_key_environment",
					"pass",
					"MASTER_KEY_ENV_ABSENT",
					"No master-key environment entry is present.",
				),
	);
	const syncRoots = ["OneDrive", "OneDriveConsumer", "OneDriveCommercial"]
		.map((name) => dataValue(env, name))
		.filter((value) => value !== undefined);
	checks.push(await inspectDataDirectory(dataDirectory, syncRoots));
	return reportFor(checks);
}

function reportFor(checks: readonly DoctorCheck[]): DoctorReport {
	return Object.freeze({
		format: "draftyak-doctor-v1",
		summary: summarize(checks),
		checks: Object.freeze(checks),
	});
}

interface CliOptions {
	help?: boolean;
	dataDirectory?: string;
}

function argumentsFor(argv: readonly string[]): CliOptions {
	const args = argv[0] === "--" ? argv.slice(1) : argv;
	const options: CliOptions = {};
	for (let index = 0; index < args.length; index++) {
		const arg = args[index];
		if (arg === "--help" && args.length === 1) return { help: true };
		if (arg !== "--data-dir") throw new Error("Arguments refused");
		const key = "dataDirectory";
		const value = args[++index];
		if (Object.hasOwn(options, key) || !value || value.startsWith("--"))
			throw new Error("Arguments refused");
		options[key] = value;
	}
	return options;
}

export async function main(
	argv: readonly string[] = process.argv.slice(2),
	writeReport: (text: string) => void = (text) => {
		process.stdout.write(text);
	},
): Promise<number> {
	try {
		const options = argumentsFor(argv);
		if (options.help) {
			writeReport(
				"Usage: node --disable-sigusr1 tools/doctor/doctor.ts [--data-dir <absolute-directory>]\n",
			);
			return 0;
		}
		const report = await diagnose(options);
		writeReport(`${JSON.stringify(report, null, 2)}\n`);
		return report.summary === "fail" ? 1 : 0;
	} catch {
		process.stderr.write("Doctor request refused; arguments are unavailable.\n");
		return 2;
	}
}
