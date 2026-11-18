import path from "node:path";
import type { NativeStore } from "./capabilities.ts";
import { requireOneTest, requireSuccess } from "./outcome.ts";
import type { Command, Runner } from "./run.ts";

export interface TestCommand {
	readonly command: Command;
	readonly expectedTest?: string;
}
const COMMON_CONTROLS = [
	"successful_platform_io_is_not_a_constant_refusal",
	"only_no_entry_becomes_missing",
	"platform_read_failures_never_create_or_replace_identity",
	"platform_write_failures_stop_before_readback",
	"platform_failure_diagnostics_do_not_format_backend_errors",
] as const;

/** Compiler and Node overrides from an unrelated parent invocation never select these tests. */
export function cargoEnvironment(
	parent: NodeJS.ProcessEnv,
	store: NativeStore | undefined,
	nodeExecutable: string,
	platform: NodeJS.Platform,
): NodeJS.ProcessEnv {
	const env: NodeJS.ProcessEnv = {};
	for (const name of [
		"SystemRoot",
		"SYSTEMROOT",
		"WINDIR",
		"TEMP",
		"TMP",
		"TMPDIR",
		"HOME",
		"USERPROFILE",
		"LOCALAPPDATA",
		"APPDATA",
		"CARGO_HOME",
		"RUSTUP_HOME",
		"DBUS_SESSION_BUS_ADDRESS",
		"XDG_RUNTIME_DIR",
		"XDG_DATA_HOME",
		"XDG_CONFIG_HOME",
		"XDG_CACHE_HOME",
	])
		if (parent[name] !== undefined) env[name] = parent[name];
	const api = platform === "win32" ? path.win32 : path.posix;
	if (!api.isAbsolute(nodeExecutable)) throw new Error("Absolute Node executable required");
	env.PATH = [api.dirname(nodeExecutable), parent.PATH ?? parent.Path ?? ""]
		.filter(Boolean)
		.join(platform === "win32" ? ";" : ":");
	env.CARGO_TERM_COLOR = "never";
	env.CARGO_NET_OFFLINE = "true";
	if (store !== undefined) env.DRAFTYAK_NATIVE_STORE_TEST = store;
	return env;
}

/** Fixed selectors only: neither test names, store namespaces nor Cargo features are input data. */
export function transportCommands(
	root: string,
	cargo: string,
	store: NativeStore,
	environment: NodeJS.ProcessEnv,
	nodeExecutable: string,
	platform: NodeJS.Platform,
): readonly TestCommand[] {
	const base = [
		"--locked",
		"--offline",
		"--manifest-path",
		"crates/Cargo.toml",
		"-p",
		"draftyak-transport",
	];
	const make = (args: readonly string[], native = false): Command => ({
		executable: cargo,
		args,
		cwd: root,
		env: cargoEnvironment(environment, native ? store : undefined, nodeExecutable, platform),
		timeoutMs: 240_000,
	});
	const test = (
		name: string,
		target: readonly string[],
		features: string,
		native = false,
	): TestCommand => ({
		command: make(
			[
				"test",
				...base,
				"--no-default-features",
				"--features",
				features,
				...target,
				name,
				"--",
				"--exact",
				"--test-threads=1",
				...(native ? ["--ignored"] : []),
			],
			native,
		),
		expectedTest: name,
	});
	const controls = [
		...COMMON_CONTROLS,
		...(store === "windows" ? ["windows_reads_refuse_a_credential_without_local_persistence"] : []),
		...(store === "macos"
			? [
					"apple_authentication_and_interaction_statuses_remain_typed_refusals",
					"apple_item_not_found_is_absence_without_regeneration",
				]
			: []),
	];
	return Object.freeze([
		test(
			"mock_cases::explicit_store_reloads_two_independent_keys_and_the_unchanged_pin",
			["--test", "key_store"],
			"mock-store",
		),
		...(["native-store", "native-store,mock-store"] as const).map((features) => ({
			command: make([
				"clippy",
				...base,
				"--no-default-features",
				"--features",
				features,
				"--all-targets",
				"--",
				"-D",
				"warnings",
			]),
		})),
		...controls.map((name) =>
			test(`key_store::platform::controls::${name}`, ["--lib"], "native-store,mock-store"),
		),
		test("native_store_roundtrip", ["--test", "key_store"], "native-store,mock-store", true),
	]);
}

export async function executeTestCommand(step: TestCommand, runner: Runner): Promise<void> {
	const result = await runner(step.command);
	if (step.expectedTest === undefined) requireSuccess(result);
	else requireOneTest(result, step.expectedTest);
}
