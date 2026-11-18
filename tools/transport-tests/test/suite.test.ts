import { describe, expect, it } from "vitest";
import { cargoEnvironment, executeTestCommand, transportCommands } from "../src/suite.ts";

describe("fixed native-store acceptance commands", () => {
	it("binds the exact host and features without inherited compiler or test selectors", () => {
		const env = cargoEnvironment(
			{
				PATH: "/system",
				NODE_OPTIONS: "DYTEST-options",
				RUSTFLAGS: "DYTEST-flags",
				CARGO_TARGET_X86_64_UNKNOWN_LINUX_GNU_RUNNER: "DYTEST-runner",
				DRAFTYAK_NATIVE_STORE_TEST: "macos",
				DYTEST_UNRELATED: "DYTEST-value",
			},
			"secret-service",
			"/node/bin/node",
			"linux",
		);
		expect(env).toEqual({
			PATH: "/node/bin:/system",
			CARGO_TERM_COLOR: "never",
			CARGO_NET_OFFLINE: "true",
			DRAFTYAK_NATIVE_STORE_TEST: "secret-service",
		});
	});
	it.each([
		["windows", "win32"],
		["macos", "darwin"],
		["secret-service", "linux"],
	] as const)("selects exact accepted targets for %s", (store, platform) => {
		const windows = platform === "win32";
		const steps = transportCommands(
			windows ? "C:\\repo" : "/repo",
			windows ? "C:\\cargo.exe" : "/cargo",
			store,
			{},
			windows ? "C:\\node.exe" : "/node",
			platform,
		);
		const last = steps.at(-1);
		expect(last?.expectedTest).toBe("native_store_roundtrip");
		expect(last?.command.env.DRAFTYAK_NATIVE_STORE_TEST).toBe(store);
		expect(last?.command.args).toContain("--exact");
		expect(last?.command.args).toContain("--ignored");
		expect(
			steps.every(
				(step) => step.command.args.includes("--locked") && step.command.args.includes("--offline"),
			),
		).toBe(true);
		expect(steps.filter((step) => step.command.args[0] === "clippy")).toHaveLength(2);
		expect(steps.some((step) => step.command.args.includes("--all-features"))).toBe(false);
		const platformControls = steps.filter((step) => step.expectedTest?.startsWith("key_store::"));
		expect(platformControls.length).toBeGreaterThanOrEqual(5);
		expect(
			platformControls.every((step) =>
				step.expectedTest?.startsWith("key_store::platform::controls::"),
			),
		).toBe(true);
		expect(steps.some((step) => step.expectedTest?.includes("windows_reads"))).toBe(
			store === "windows",
		);
		expect(steps.some((step) => step.expectedTest?.includes("apple_authentication"))).toBe(
			store === "macos",
		);
	});
	it("runs through an injected runner and refuses a zero-test success", async () => {
		const step = transportCommands("/repo", "/cargo", "macos", {}, "/node", "darwin")[0];
		if (step === undefined) throw new Error("missing fixture command");
		let calls = 0;
		await expect(
			executeTestCommand(step, async () => {
				calls++;
				return {
					started: true,
					code: 0,
					signal: null,
					timedOut: false,
					overflow: false,
					processError: false,
					terminationFailed: false,
					stdout:
						"test result: ok. 0 passed; 0 failed; 0 ignored; 0 measured; 1 filtered out; finished in 0.00s\n",
					stderr: "",
				};
			}),
		).rejects.toThrow("exactly once");
		expect(calls).toBe(1);
	});
});
