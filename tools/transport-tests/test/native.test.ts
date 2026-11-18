import { describe, expect, it } from "vitest";
import { createHostSuite, hostCaseNames, requireCompleteNativeRun } from "../src/native.ts";
import type { Outcome } from "../src/outcome.ts";
import type { Command } from "../src/run.ts";

const success = (): Outcome => ({
	started: true,
	code: 0,
	signal: null,
	timedOut: false,
	overflow: false,
	processError: false,
	terminationFailed: false,
	stdout: "",
	stderr: "",
});

describe("required native-store acceptance", () => {
	it("refuses an empty, filtered, skipped or duplicated required result", () => {
		const required = ["windows: native store roundtrip", "windows: stored mock identity"];
		expect(() => requireCompleteNativeRun(required, [...required])).not.toThrow();
		for (const passed of [
			[],
			required.slice(0, 1),
			[required[0] as string, required[0] as string],
			[...required, required[0] as string],
		])
			expect(() => requireCompleteNativeRun(required, passed)).toThrow("did not complete");
		expect(() => requireCompleteNativeRun([], [])).toThrow();
	});
	it.each([
		["windows", "win32"],
		["macos", "darwin"],
	] as const)(
		"runs each fixed %s step and accepts only actual named tests",
		async (store, platform) => {
			const calls: Command[] = [];
			const suite = createHostSuite(store, {
				root: platform === "win32" ? "C:\\repo" : "/repo",
				cargo: platform === "win32" ? "C:\\cargo.exe" : "/cargo",
				node: platform === "win32" ? "C:\\node.exe" : "/node",
				platform,
				environment: { NODE_OPTIONS: "DYTEST-unrelated" },
				runner: async (command) => {
					calls.push(command);
					const value = success();
					if (command.args[0] === "test") {
						const separator = command.args.indexOf("--"),
							name = command.args[separator - 1];
						return {
							...value,
							stdout: `running 1 test\ntest ${name} ... ok\ntest result: ok. 1 passed; 0 failed; 0 ignored; 0 measured; 5 filtered out; finished in 0.01s\n`,
						};
					}
					return value;
				},
			});
			for (const step of suite.cases) await step.work();
			await suite.close();
			expect(suite.cases.map((step) => step.name)).toEqual(hostCaseNames(store));
			expect(calls[0]?.args).toEqual(["fetch", "--locked", "--manifest-path", "crates/Cargo.toml"]);
			expect(calls[0]?.env.CARGO_NET_OFFLINE).toBe("false");
			for (const command of calls.slice(1)) {
				expect(command.args).toContain("--offline");
				expect(command.env.NODE_OPTIONS).toBeUndefined();
			}
			expect(calls.at(-1)?.env.DRAFTYAK_NATIVE_STORE_TEST).toBe(store);
		},
	);
	it("never turns a successful empty native process into a passed case", async () => {
		const suite = createHostSuite("windows", {
			root: "C:\\repo",
			cargo: "C:\\cargo.exe",
			node: "C:\\node.exe",
			platform: "win32",
			environment: {},
			runner: async () => success(),
		});
		await expect(suite.cases.at(-1)?.work()).rejects.toThrow("exactly once");
	});
	it("refuses a suite selected for another OS", () => {
		expect(() =>
			createHostSuite("macos", {
				root: "/repo",
				cargo: "/cargo",
				node: "/node",
				platform: "linux",
				environment: {},
				runner: async () => success(),
			}),
		).toThrow("does not match");
	});
});
