import type { NativeStore } from "./capabilities.ts";
import { requireSuccess } from "./outcome.ts";
import type { Runner } from "./run.ts";
import { cargoEnvironment, executeTestCommand, transportCommands } from "./suite.ts";

export interface NativeContext {
	readonly root: string;
	readonly cargo: string;
	readonly docker?: string;
	readonly node: string;
	readonly platform: NodeJS.Platform;
	readonly environment: NodeJS.ProcessEnv;
	readonly runner: Runner;
}
export interface NativeCase {
	readonly name: string;
	work(): Promise<void>;
}
export interface NativeSuite {
	readonly cases: readonly NativeCase[];
	close(): Promise<void>;
}

const COMMON = [
	"successful_platform_io_is_not_a_constant_refusal",
	"only_no_entry_becomes_missing",
	"platform_read_failures_never_create_or_replace_identity",
	"platform_write_failures_stop_before_readback",
	"platform_failure_diagnostics_do_not_format_backend_errors",
] as const;

/** Required execution names are independent of the Cargo command/output selectors. */
export function hostCaseNames(store: "windows" | "macos"): readonly string[] {
	return [
		"locked dependencies",
		"stored mock identity",
		"clippy native-store",
		"clippy native-store,mock-store",
		...COMMON,
		...(store === "windows"
			? ["windows_reads_refuse_a_credential_without_local_persistence"]
			: [
					"apple_authentication_and_interaction_statuses_remain_typed_refusals",
					"apple_item_not_found_is_absence_without_regeneration",
				]),
		"native store roundtrip",
	].map((name) => `${store}: ${name}`);
}

/** Registry preparation is locked; execution and native store cases remain offline. */
export function createHostSuite(store: "windows" | "macos", context: NativeContext): NativeSuite {
	if ((store === "windows" ? "win32" : "darwin") !== context.platform)
		throw new Error("Native-store suite does not match its host");
	const commands = transportCommands(
		context.root,
		context.cargo,
		store,
		context.environment,
		context.node,
		context.platform,
	);
	const names = hostCaseNames(store);
	if (commands.length + 1 !== names.length) throw new Error("Native-store suite inventory differs");
	const environment = cargoEnvironment(
		context.environment,
		undefined,
		context.node,
		context.platform,
	);
	return {
		cases: [
			{
				name: names[0] as string,
				async work() {
					requireSuccess(
						await context.runner({
							executable: context.cargo,
							args: ["fetch", "--locked", "--manifest-path", "crates/Cargo.toml"],
							cwd: context.root,
							env: { ...environment, CARGO_NET_OFFLINE: "false" },
							timeoutMs: 240_000,
						}),
					);
				},
			},
			...commands.map((step, index) => ({
				name: names[index + 1] as string,
				work: () => executeTestCommand(step, context.runner),
			})),
		],
		async close() {},
	};
}

/** Missing, filtered or duplicated required native cases cannot be a successful heavy run. */
export function requireCompleteNativeRun(
	expected: readonly string[],
	passed: readonly string[],
): void {
	if (
		expected.length === 0 ||
		new Set(expected).size !== expected.length ||
		expected.some((name) => passed.filter((value) => value === name).length !== 1)
	)
		throw new Error("Required native-store acceptance did not complete");
}

export const nativeStores: readonly NativeStore[] = ["windows", "secret-service", "macos"];
