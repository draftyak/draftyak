import { beforeEach, expect, it, vi } from "vitest";

const boundary = vi.hoisted(() => ({
	classify: vi.fn(),
	diagnose: vi.fn(),
	diagnosticsLoaded: vi.fn(),
	runDoctor:
		vi.fn<(argv: readonly string[], writeReport: (text: string) => void) => Promise<number>>(),
}));

beforeEach(() => {
	vi.resetModules();
	vi.clearAllMocks();
	boundary.classify.mockReturnValue("full");
	boundary.diagnose.mockResolvedValue({ summary: "pass" });
	boundary.runDoctor.mockResolvedValue(0);
	vi.doMock("@draftyak/doctor", () => ({ runDoctor: boundary.runDoctor }));
	vi.doMock("@draftyak/doctor/node-policy", () => ({
		loadNodePolicy: () => ({ classify: boundary.classify }),
	}));
	vi.doMock("@draftyak/doctor/diagnostics", () => {
		boundary.diagnosticsLoaded();
		return { diagnose: boundary.diagnose };
	});
});

it("loads the doctor command without executing diagnostics", async () => {
	const { command } = await import("../../src/commands/doctor.ts");
	expect(command.name).toBe("doctor");
	expect(boundary.runDoctor).not.toHaveBeenCalled();
	expect(boundary.diagnosticsLoaded).not.toHaveBeenCalled();
});

it("passes literal doctor arguments and its exit status through the dispatcher plugin", async () => {
	boundary.runDoctor.mockResolvedValue(23);
	const { command } = await import("../../src/commands/doctor.ts");
	const argv = ["doctor", "--data-dir", "literal;$(fixture)&`text`", "two words"];
	const stderr = vi.fn();
	expect(await command.run(argv, { commands: ["doctor", "help"], stderr })).toBe(23);
	expect(boundary.runDoctor).toHaveBeenCalledExactlyOnceWith(argv.slice(1), stderr);
});

it("imports without loading or running diagnostic code", async () => {
	await import("../../src/doctor/checks/offline.ts");
	expect(boundary.classify).not.toHaveBeenCalled();
	expect(boundary.diagnosticsLoaded).not.toHaveBeenCalled();
	expect(boundary.diagnose).not.toHaveBeenCalled();
});

it("refuses an unsupported Node before importing diagnostic code", async () => {
	boundary.classify.mockReturnValue("unsupported");
	const { check } = await import("../../src/doctor/checks/offline.ts");
	expect(await check.run()).toBe("error");
	expect(boundary.classify).toHaveBeenCalledExactlyOnceWith(process.version);
	expect(boundary.diagnosticsLoaded).not.toHaveBeenCalled();
	expect(boundary.diagnose).not.toHaveBeenCalled();
});

it.each([
	["pass", "ok"],
	["warn", "warn"],
	["fail", "error"],
	["unknown", "error"],
])("adapts a %s diagnostic summary to the fixed %s status", async (summary, status) => {
	boundary.diagnose.mockResolvedValue({ summary });
	const { check } = await import("../../src/doctor/checks/offline.ts");
	expect(await check.run()).toBe(status);
	expect(boundary.diagnosticsLoaded).toHaveBeenCalledOnce();
	expect(boundary.diagnose).toHaveBeenCalledExactlyOnceWith();
});

it("keeps diagnostic exceptions inside the existing loader's fixed status boundary", async () => {
	boundary.diagnose.mockRejectedValue(new Error("DYTEST-private-diagnostic"));
	const { runDoctorChecks } = await import("../../src/doctor/loader.ts");
	const report = await runDoctorChecks("local");
	expect(report).toEqual({
		available: true,
		checks: [{ id: "offline", status: "error" }],
		exitCode: 1,
	});
	expect(JSON.stringify(report)).not.toContain("DYTEST-private-diagnostic");
});
