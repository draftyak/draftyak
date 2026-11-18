import { run } from "../../verify/lib/spawn.ts";
import { resolvePnpm } from "../../verify/lib/tools.ts";
import { runCli, setOutputs, UsageError } from "./lib.ts";

export const nativeTransportFilter = "./tools/transport-tests";
const segment = "(?!\\.{1,2}(?:/|\\}|$))[a-z0-9._-]+";
const repositoryPath = `${segment}(?:/${segment})*`;
const heavyPattern = new RegExp(`^(?:\\./${repositoryPath}|\\.\\.\\.\\{\\./${repositoryPath}\\})$`);
const workspacePattern = new RegExp(`^${repositoryPath}$`);

export interface NativeTransportSelection {
	readonly selected: boolean;
	readonly ordinaryHeavy: string;
}

// Selection consumes bounded ordinary metadata only. It never opens a package or Rust manifest.
export function nativeTransportSelection(heavy: string, rust: string): NativeTransportSelection {
	if (heavy.length > 16 * 1024 || rust.length > 16 * 1024)
		throw new UsageError("native transport selection is oversized");
	const filters = heavy === "" ? [] : heavy.split(/\r?\n/);
	const workspaces = rust === "" ? [] : rust.split(/\r?\n/);
	if (
		filters.length > 100 ||
		filters.some((value) => value.length > 200 || !heavyPattern.test(value)) ||
		new Set(filters).size !== filters.length
	)
		throw new UsageError("invalid native transport heavy selection");
	if (
		workspaces.length > 100 ||
		workspaces.some((value) => value.length > 200 || !workspacePattern.test(value)) ||
		new Set(workspaces).size !== workspaces.length
	)
		throw new UsageError("invalid native transport Rust selection");
	if (filters.includes(`...{${nativeTransportFilter}}`))
		throw new UsageError("native transport needs its exact direct selector");
	const selected = filters.includes(nativeTransportFilter);
	if (selected && !workspaces.includes("crates"))
		throw new UsageError("native transport needs the crates toolchain workspace");
	return {
		selected,
		ordinaryHeavy: filters.filter((value) => value !== nativeTransportFilter).join("\n"),
	};
}

export interface NativePlatform {
	readonly platform: string;
	readonly architecture: string;
}

export function assertNativePlatform(actual: NativePlatform, expected: NativePlatform): void {
	const allowed =
		(expected.platform === "linux" || expected.platform === "win32") &&
		expected.architecture === "x64";
	const apple = expected.platform === "darwin" && expected.architecture === "arm64";
	if (
		(!allowed && !apple) ||
		actual.platform !== expected.platform ||
		actual.architecture !== expected.architecture
	)
		throw new UsageError("native transport runner platform or architecture is unavailable");
}

export async function executeNativeTransport(
	actual: NativePlatform,
	expected: NativePlatform,
	execute: () => Promise<number>,
): Promise<"passed"> {
	assertNativePlatform(actual, expected);
	if ((await execute()) !== 0) throw new UsageError("native transport checks failed");
	return "passed";
}

async function main(argv: readonly string[]): Promise<number> {
	if (argv.length !== 1) throw new UsageError("expected select, platform or run");
	if (argv[0] === "select") {
		const selection = nativeTransportSelection(process.env.HEAVY ?? "", process.env.RUST ?? "");
		setOutputs({
			"native-transport": String(selection.selected),
			"ordinary-heavy": selection.ordinaryHeavy,
		});
		return 0;
	}
	const actual = { platform: process.platform, architecture: process.arch };
	const expected = {
		platform: process.env.NATIVE_PLATFORM ?? "",
		architecture: process.env.NATIVE_ARCHITECTURE ?? "",
	};
	assertNativePlatform(actual, expected);
	if (argv[0] === "platform") return 0;
	if (argv[0] !== "run") throw new UsageError("expected select, platform or run");
	const completion = await executeNativeTransport(actual, expected, async () => {
		const pnpm = resolvePnpm();
		return run(
			{
				command: pnpm.command,
				args: [
					...pnpm.args,
					"--filter",
					nativeTransportFilter,
					"--fail-if-no-match",
					"run",
					"test:heavy",
				],
			},
			{ env: { ...process.env, DRAFTYAK_STRICT_SKIPS: "1" } },
		);
	});
	setOutputs({ "native-transport": completion });
	return 0;
}

if (import.meta.main) await runCli("native-transport", () => main(process.argv.slice(2)));
