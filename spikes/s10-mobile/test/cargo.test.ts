import os from "node:os";
import { describe, expect, it } from "vitest";
import {
	buildNotes,
	buildScriptFailures,
	clean,
	crateTable,
	expectedCrates,
	featureArgs,
	packageOf,
} from "../src/cargo.ts";

const registry = (name: string, version: string): string =>
	`registry+https://github.com/rust-lang/crates.io-index#${name}@${version}`;
const artifact = (id: string, kind = "lib"): string =>
	JSON.stringify({ reason: "compiler-artifact", package_id: id, target: { kind: [kind] } });
const finished = (success: boolean): string =>
	JSON.stringify({ reason: "build-finished", success });
const skeleton = "path+file:///work/spikes/s10-mobile/transport-skeleton#0.0.0";

describe("packageOf", () => {
	it("reads registry and path package ids", () => {
		expect(packageOf(registry("aws-lc-sys", "0.46.0"))).toEqual({
			name: "aws-lc-sys",
			version: "0.46.0",
		});
		expect(packageOf(skeleton)).toEqual({ name: "transport-skeleton", version: "0.0.0" });
		expect(packageOf("path+file:///work/app#draftyak-mobile@0.1.0")).toEqual({
			name: "draftyak-mobile",
			version: "0.1.0",
		});
	});
});

describe("expectedCrates", () => {
	it("adds the provider's crates and the target's keyring store", () => {
		const android = expectedCrates("aarch64-linux-android", "aws-lc-rs");
		expect(android.slice(0, 2)).toEqual(["aws-lc-sys", "aws-lc-rs"]);
		expect(android).toContain("android-native-keyring-store");
		expect(android.at(-1)).toBe("transport-skeleton");
		expect(expectedCrates("aarch64-apple-ios-sim", "ring")).toContain("apple-native-keyring-store");
		const host = expectedCrates("x86_64-pc-windows-msvc", "ring");
		expect(host[0]).toBe("ring");
		expect(host.filter((name) => name.endsWith("keyring-store"))).toEqual([]);
		expect(featureArgs("ring")).toEqual([]);
		expect(featureArgs("aws-lc-rs")).toEqual(["--no-default-features", "--features", "aws-lc-rs"]);
	});
});

describe("crateTable", () => {
	it("marks compiled crates ok, ignoring build-script artifacts", () => {
		const stdout = [
			artifact(registry("ring", "0.17.14"), "custom-build"),
			artifact(registry("ring", "0.17.14")),
			artifact(registry("rustls", "0.23.46")),
			artifact(skeleton, "cdylib"),
			finished(true),
		].join("\n");
		const { ok, crates } = crateTable(stdout, "", ["ring", "rustls", "transport-skeleton", "jiff"]);
		expect(ok).toBe(true);
		expect(crates).toEqual([
			{ name: "ring", version: "0.17.14", status: "ok" },
			{ name: "rustls", version: "0.23.46", status: "ok" },
			{ name: "transport-skeleton", version: "0.0.0", status: "ok" },
			{ name: "jiff", version: null, status: "missing" },
		]);
	});

	it("names the failing crate and marks its dependents blocked", () => {
		const stdout = [
			artifact(registry("aws-lc-sys", "0.46.0"), "custom-build"),
			artifact(registry("jiff", "0.2.38")),
			JSON.stringify({
				reason: "compiler-message",
				package_id: skeleton,
				message: { level: "error", message: "linking with `C:\\ndk\\clang` failed: exit code: 1" },
			}),
			finished(false),
		].join("\n");
		const stderr = [
			"error: failed to run custom build command for `aws-lc-sys v0.46.0`",
			"",
			"Caused by:",
			"  --- stdout",
			"  cargo:rerun-if-env-changed=AWS_LC_SYS_NO_ASM",
			"  --- stderr",
			"  Missing dependency: cmake",
			"",
			"  thread 'main' (1) panicked at /home/runner/.cargo/registry/src/aws-lc-sys/builder/main.rs:776:38:",
		].join("\n");
		const expected = ["aws-lc-sys", "aws-lc-rs", "jiff", "transport-skeleton"];
		const { ok, crates } = crateTable(stdout, stderr, expected);
		expect(ok).toBe(false);
		expect(crates).toEqual([
			{ name: "aws-lc-sys", version: null, status: "fail", reason: "Missing dependency: cmake" },
			{ name: "aws-lc-rs", version: null, status: "blocked" },
			{ name: "jiff", version: "0.2.38", status: "ok" },
			{
				name: "transport-skeleton",
				version: null,
				status: "fail",
				reason: "linking with `[path]` failed: exit code: 1",
			},
		]);
	});

	it("keeps each build script's OUT_DIR, where aws-lc-sys's output file lies", () => {
		const outDir = "/work/target/debug/build/aws-lc-sys-0123/out";
		const executed = JSON.stringify({
			reason: "build-script-executed",
			package_id: registry("aws-lc-sys", "0.46.0"),
			out_dir: outDir,
		});
		const { scripts } = crateTable([executed, finished(true)].join("\n"), "", ["aws-lc-sys"]);
		expect([...scripts]).toEqual([["aws-lc-sys", outDir]]);
	});
});

describe("buildNotes", () => {
	it("takes aws-lc-sys's builder and the NASM fallback from its script's output or stderr", () => {
		const output = [
			"cargo:rerun-if-env-changed=AWS_LC_SYS_CMAKE_BUILDER",
			"cargo:warning=Building with: CC",
			'cargo:warning=Symbol Prefix: Some("aws_lc_0_46_0")',
			"cargo:warning=NASM command not found or failed to execute.",
			"cargo:warning=NASM command not found or failed to execute.",
		].join("\r\n");
		expect(buildNotes(output)).toEqual([
			"Building with: CC",
			"NASM command not found or failed to execute.",
		]);
		expect(buildNotes("  --- stdout\n  cargo:warning=Building with: CMake\n")).toEqual([
			"Building with: CMake",
		]);
		expect(buildNotes("Compiling ring v0.17.14")).toEqual([]);
	});
});

describe("buildScriptFailures", () => {
	it("takes the first stderr line that isn't the panic location", () => {
		const stderr = [
			"error: failed to run custom build command for `ring v0.17.14`",
			"  --- stderr",
			"  thread 'main' panicked at src/build.rs:1:1:",
			"  note: run with `RUST_BACKTRACE=1`",
			'  failed to find tool "aarch64-linux-android24-clang": No such file or directory',
		].join("\n");
		expect([...buildScriptFailures(stderr)]).toEqual([
			["ring", 'failed to find tool "aarch64-linux-android24-clang": No such file or directory'],
		]);
		expect(buildScriptFailures("error: could not compile `jiff`")).toEqual(new Map());
	});
});

describe("clean", () => {
	it("drops local paths and keeps one short line", () => {
		expect(clean("a\n b  C:\\Users\\someone\\x.rs and /home/runner/y and /Users/a/z", [])).toBe(
			"a b [path] and [path] and [path]",
		);
		expect(clean("x".repeat(300))).toHaveLength(160);
	});

	it("drops paths whose folders hold spaces, quoted or not", () => {
		const home =
			"failed to run C:\\Users\\Jane Doe\\.cargo\\registry\\src\\builder\\main.rs: missing";
		expect(clean(home, [])).toBe("failed to run [path]: missing");
		const linker =
			"C:\\Program Files\\Microsoft Visual Studio\\2022\\BuildTools\\VC\\Tools\\MSVC\\14.44.35207\\bin\\HostX64\\x64\\link.exe failed";
		expect(clean(linker, [])).toBe("[path] failed");
		expect(clean('failed to find tool "C:\\LLVM tools\\clang cl.exe": not found', [])).toBe(
			'failed to find tool "[path]": not found',
		);
		expect(clean("note: -FoC:\\\\dev\\\\x\\\\a.o and file:///home/runner/b.rs", [])).toBe(
			"note: -Fo[path] and file://[path]",
		);
	});

	it("keeps URLs and replaces known roots literally", () => {
		const help = "(see https://docs.rs/cc/latest/cc/#compile-time-requirements for help)";
		expect(clean(`failed to find tool "/opt/x y/cc": ${help}`, [])).toBe(
			`failed to find tool "[path]": ${help}`,
		);
		const root = os.platform() === "win32" ? "D:\\Some One" : "/srv/some one";
		expect(clean(`at ${root}/a b/c.rs: x`, [root])).toBe("at [path]: x");
		expect(clean(`at ${root}`, [root])).toBe("at [path]");
	});
});
