import { afterEach, expect, it, vi } from "vitest";
import { commandNames } from "../src/command-loader.ts";
import { loadDoctorChecks, runDoctorChecks } from "../src/doctor/loader.ts";
import { main } from "../src/main.ts";
import { CLI_PAYLOAD, isCliExitCode } from "../src/payload-contract.ts";
import { record } from "../src/records.ts";

vi.mock("@draftyak/doctor/node-policy", () => ({
	loadNodePolicy: () => ({ classify: () => "full" }),
}));
vi.mock("@draftyak/doctor/diagnostics", () => ({
	diagnose: async () => ({ summary: "warn" }),
}));

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

it("discovers the implemented doctor and help commands in the fixed source directory", async () => {
	const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
	const stdout = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
	expect(commandNames()).toEqual(["doctor", "help"]);
	expect(await main([])).toBe(0);
	expect(stderr).toHaveBeenCalledExactlyOnceWith(
		"Usage: draftyak <command>\nCommands:\ndoctor\nhelp\n",
	);
	expect(stdout).not.toHaveBeenCalled();
});

it("returns unknown MCP failure without sharing diagnostics with stdout", async () => {
	const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
	const stdout = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
	expect(await main(["mcp", "DYTEST-PRIVATE-ARG"])).toBe(2);
	expect(stderr).toHaveBeenCalledExactlyOnceWith("Command refused.\n");
	expect(stdout).not.toHaveBeenCalled();
});

it("discovers the offline check and returns fixed statuses in both modes", async () => {
	expect((await loadDoctorChecks()).map((check) => check.id)).toEqual(["offline"]);
	for (const mode of ["local", "public"] as const)
		expect(await runDoctorChecks(mode)).toEqual({
			available: true,
			checks: [{ id: "offline", status: "warn" }],
			exitCode: 0,
		});
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
