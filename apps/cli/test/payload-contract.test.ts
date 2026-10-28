import { afterEach, expect, it, vi } from "vitest";
import { commandNames } from "../src/command-loader.ts";
import { loadDoctorChecks, runDoctorChecks } from "../src/doctor/loader.ts";
import { main } from "../src/main.ts";
import { CLI_PAYLOAD, isCliExitCode } from "../src/payload-contract.ts";
import { record } from "../src/records.ts";

afterEach(() => vi.restoreAllMocks());

it("exports the fixed inert payload handoff", () => {
	expect(CLI_PAYLOAD).toEqual({
		executable: "draftyak",
		distribution: "draftyak",
		entry: "main.mjs",
		buildEntry: "dist/main.mjs",
		stagedEntry: "cli/main.mjs",
		exportName: "main",
		argv: "literal",
		stdout: "mcp-exclusive",
		minimumExit: 0,
		maximumExit: 255,
	});
	expect(Object.isFrozen(CLI_PAYLOAD)).toBe(true);
	for (const value of [0, 7, 255]) expect(isCliExitCode(value)).toBe(true);
	for (const value of [undefined, "0", -1, 256, 1.5, NaN, Infinity])
		expect(isCliExitCode(value)).toBe(false);
});

it("discovers the implemented help and MCP commands in the fixed source directory", async () => {
	const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
	const stdout = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
	expect(commandNames()).toEqual(["help", "mcp"]);
	expect(await main([])).toBe(0);
	expect(stderr).toHaveBeenCalledExactlyOnceWith(
		"Usage: draftyak <command>\nCommands:\nhelp\nmcp\n",
	);
	expect(stdout).not.toHaveBeenCalled();
});

it("returns malformed MCP argv refusal without sharing diagnostics with stdout", async () => {
	const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
	const stdout = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
	expect(await main(["mcp", "DYTEST-PRIVATE-ARG"])).toBe(2);
	expect(stderr).toHaveBeenCalledExactlyOnceWith("Usage: draftyak mcp --client <name>\n");
	expect(stdout).not.toHaveBeenCalled();
});

it("keeps the doctor mechanism explicitly unavailable without fabricated checks", async () => {
	expect(await loadDoctorChecks()).toEqual([]);
	expect(await runDoctorChecks("local")).toEqual({ available: false, checks: [], exitCode: 1 });
	expect(await runDoctorChecks("public")).toEqual({ available: false, checks: [], exitCode: 1 });
});

it.each([null, undefined, { name: "help", extra: 1 }, Object.create({ name: "help" })])(
	"refuses malformed command record %s",
	(value) => expect(() => record(value, ["name"])).toThrow("Command refused."),
);

it("refuses record accessors and proxies without invoking them", () => {
	const hook = vi.fn(() => "help");
	expect(() =>
		record(
			{
				get name() {
					return hook();
				},
			},
			["name"],
		),
	).toThrow("Command refused.");
	expect(() => record(new Proxy({}, { ownKeys: hook }), ["name"])).toThrow("Command refused.");
	expect(hook).not.toHaveBeenCalled();
});
