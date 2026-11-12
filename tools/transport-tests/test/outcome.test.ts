import { describe, expect, it } from "vitest";
import { type Outcome, requireOneTest, requireSuccess } from "../src/outcome.ts";

const good = (): Outcome => ({
	started: true,
	code: 0,
	signal: null,
	timedOut: false,
	overflow: false,
	processError: false,
	terminationFailed: false,
	stdout:
		"running 1 test\ntest native_store_roundtrip ... ok\n\ntest result: ok. 1 passed; 0 failed; 0 ignored; 0 measured; 8 filtered out; finished in 0.20s\n",
	stderr: "",
});

describe("native-store execution outcomes", () => {
	it("accepts only the expected actually executed test", () => {
		expect(() => requireOneTest(good(), "native_store_roundtrip")).not.toThrow();
	});
	it.each([
		{ started: false },
		{ code: 1 },
		{ code: null },
		{ signal: "SIGTERM" },
		{ timedOut: true },
		{ overflow: true },
		{ processError: true },
		{ terminationFailed: true },
	])("refuses unsuccessful process state %j", (delta) => {
		expect(() => requireOneTest({ ...good(), ...delta }, "native_store_roundtrip")).toThrow(
			"command failed",
		);
	});
	it.each([
		"",
		"running 0 tests\ntest result: ok. 0 passed; 0 failed; 0 ignored; 0 measured; 1 filtered out; finished in 0.00s\n",
		good().stdout.replace("native_store_roundtrip ... ok", "different_test ... ok"),
		good().stdout.replace(" ... ok", " ... ignored"),
		good().stdout.replace("1 passed; 0 failed; 0 ignored", "0 passed; 0 failed; 1 ignored"),
		good().stdout + good().stdout,
		good().stdout.replace("running 1 test", "running 2 tests\ntest unexpected ... ok"),
	])("refuses absent, skipped, mismatched or extra test output", (stdout) => {
		expect(() => requireOneTest({ ...good(), stdout }, "native_store_roundtrip")).toThrow(
			"did not run exactly once",
		);
	});
	it("never echoes captured diagnostics in a public failure", () => {
		const canary = "DYTEST-diagnostic-canary";
		try {
			requireSuccess({ ...good(), code: 1, stderr: canary, stdout: canary });
		} catch (error) {
			expect(String(error)).toBe("Error: Native-store test command failed");
		}
	});
});
