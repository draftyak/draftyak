import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const doubles = vi.hoisted(() => ({
	authority: {},
	producer: {},
	create: vi.fn(),
	run: vi.fn(),
}));
vi.mock("../src/authority.ts", () => ({
	RepositoryAuthority: class {
		readonly marker = doubles.authority;
	},
}));
vi.mock("../src/production.ts", () => ({ createProductionProducer: doubles.create }));
vi.mock("../src/runner.ts", () => ({ runNativePolicy: doubles.run }));

import { main } from "../src/cli-main.ts";

describe("native policy command boundary", () => {
	let written: string[];
	beforeEach(() => {
		written = [];
		doubles.create.mockReset().mockReturnValue(doubles.producer);
		doubles.run.mockReset();
		vi.spyOn(process.stdout, "write").mockImplementation((value) => {
			written.push(String(value));
			return true;
		});
	});
	afterEach(() => vi.restoreAllMocks());
	it.each([0, 1, 2] as const)("preserves runner exit %s and one result", async (exitCode) => {
		const output = { version: 1, verdict: "refuse", reason: "ACTUAL_SOURCE_CONFIRMATION_REQUIRED" };
		doubles.run.mockResolvedValue({ exitCode, output });
		expect(await main(["check", "--phase", "item"])).toBe(exitCode);
		expect(written).toEqual([`${JSON.stringify(output)}\n`]);
		expect(doubles.run).toHaveBeenCalledWith({
			phase: "item",
			authority: expect.objectContaining({ marker: doubles.authority }),
			producer: doubles.producer,
		});
		const options = doubles.create.mock.calls[0]?.[0];
		expect(options.repositoryRoot).toMatch(/[\\/]$/);
		expect(Object.keys(options)).toEqual(["repositoryRoot"]);
	});
	it("passes the gate phase and only the requested new output directory", async () => {
		doubles.run.mockResolvedValue({ exitCode: 1, output: { verdict: "refuse" } });
		const directory =
			process.platform === "win32" ? "C:\\synthetic-evidence" : "/synthetic-evidence";
		expect(
			await main(["check", "--phase", "m4-gate", "--evidence-dir", directory, "--format", "json"]),
		).toBe(1);
		expect(doubles.run.mock.calls[0]?.[0].phase).toBe("m4-gate");
		expect(doubles.create.mock.calls[0]?.[0].evidenceDirectory).toBe(directory);
	});
	it.each(["--authority", "--policy", "--clock", "--report", "--ignore"])(
		"refuses %s before creating any production dependency",
		async (flag) => {
			expect(await main(["check", "--phase", "item", flag, "synthetic"])).toBe(2);
			expect(doubles.create).not.toHaveBeenCalled();
			expect(doubles.run).not.toHaveBeenCalled();
			expect(written).toEqual(['{"version":1,"verdict":"refuse","reason":"INVALID_ARGUMENTS"}\n']);
		},
	);
	it("never emits exception text or private paths", async () => {
		doubles.run.mockRejectedValue(new Error("synthetic private diagnostic /never/emit"));
		await expect(main(["check", "--phase", "item"])).resolves.toBe(2);
		expect(written).toEqual([
			'{"version":1,"phase":"item","verdict":"refuse","reason":"PRODUCER_UNAVAILABLE"}\n',
		]);
	});
	it("refuses an oversized result without partially emitting it", async () => {
		doubles.run.mockResolvedValue({ exitCode: 0, output: { data: "x".repeat(65_536) } });
		expect(await main(["check", "--phase", "item"])).toBe(2);
		expect(written).toHaveLength(1);
		expect(written[0]).not.toContain("xxx");
	});
	it("does not retry a failed output write or expose its diagnostic", async () => {
		doubles.run.mockResolvedValue({ exitCode: 0, output: { verdict: "strict-pass" } });
		vi.mocked(process.stdout.write).mockImplementationOnce(() => {
			throw new Error("synthetic private output failure");
		});
		expect(await main(["check", "--phase", "item"])).toBe(2);
		expect(process.stdout.write).toHaveBeenCalledTimes(1);
		expect(written).toEqual([]);
	});
});
