import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { parseArguments, UsageError } from "../src/options.ts";

describe("bounded native policy command arguments", () => {
	it.each(["item", "m4-gate"])("requires an explicit phase", (phase) => {
		expect(parseArguments(["check", "--phase", phase, "--format", "json"])).toEqual({ phase });
	});
	it("accepts one leading separator and an absolute output directory", () => {
		const evidenceDirectory = resolve("synthetic-evidence");
		expect(
			parseArguments(["--", "check", "--phase", "item", "--evidence-dir", evidenceDirectory]),
		).toEqual({ phase: "item", evidenceDirectory });
	});
	it.each(
		[
			[],
			["check"],
			["approve"],
			["renew"],
			["check", "--phase"],
			["check", "--phase", "other"],
			["check", "--phase", "item", "--phase", "m4-gate"],
			["check", "--phase", "item", "--format", "text"],
			["check", "--phase", "item", "--format", "json", "--format", "json"],
			["check", "--phase", "item", "extra"],
			["--", "--", "check", "--phase", "item"],
			["check", "--phase", "item", "--evidence-dir", "relative"],
			["check", "--phase", "item", "--evidence-dir", "\0"],
			["check", "--phase", "item", "--evidence-dir", "x".repeat(4097)],
		].map((args) => ({ args })),
	)("refuses malformed, repeated or ambiguous arguments", ({ args }) => {
		expect(() => parseArguments(args)).toThrow(UsageError);
	});
	it.each([
		"--approved",
		"--policy",
		"--record",
		"--ref",
		"--time",
		"--ignore",
		"--target",
		"--features",
		"--metadata",
		"--audit",
		"--gate-open",
		"--cargo",
		"--cargo-deny",
	])("refuses every caller authority or producer override", (option) => {
		expect(() => parseArguments(["check", "--phase", "item", option, "synthetic"])).toThrow(
			UsageError,
		);
	});
});
