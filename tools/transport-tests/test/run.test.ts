import { spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import path from "node:path";
import { PassThrough } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";
import { type Command, run } from "../src/run.ts";

vi.mock("node:child_process", () => ({ spawn: vi.fn() }));

function child() {
	return Object.assign(new EventEmitter(), {
		pid: 12345,
		exitCode: null as number | null,
		signalCode: null as string | null,
		stdout: new PassThrough(),
		stderr: new PassThrough(),
		kill: vi.fn(() => true),
		unref: vi.fn(),
	});
}
const command = (): Command => ({
	executable: path.resolve("dytest-cargo.exe"),
	args: ["test"],
	cwd: path.resolve("dytest-root"),
	env: { SystemRoot: "C:\\Windows" },
	timeoutMs: 1000,
});
afterEach(() => {
	vi.useRealTimers();
	vi.resetAllMocks();
});

describe("bounded native-store command runner with synthetic children", () => {
	it.each([
		{ executable: "cargo" },
		{ executable: path.resolve("cargo.cmd") },
		{ executable: path.resolve("cargo.ps1") },
		{ cwd: "relative" },
		{ timeoutMs: 0 },
		{ timeoutMs: 300_001 },
		{ args: ["bad\0argument"] },
	])("refuses invalid input before spawning %j", async (delta) => {
		await expect(run({ ...command(), ...delta })).rejects.toThrow("Invalid native-store");
		expect(spawn).not.toHaveBeenCalled();
	});
	it("captures a successful close without a shell or inherited stdin", async () => {
		const fake = child();
		vi.mocked(spawn).mockReturnValue(fake as unknown as ReturnType<typeof spawn>);
		const result = run(command());
		fake.emit("spawn");
		fake.stdout.write("DYTEST-output");
		fake.stderr.write("DYTEST-diagnostic");
		fake.exitCode = 0;
		fake.emit("exit", 0, null);
		fake.emit("close", 0, null);
		await expect(result).resolves.toMatchObject({
			started: true,
			code: 0,
			timedOut: false,
			stdout: "DYTEST-output",
			stderr: "DYTEST-diagnostic",
			terminationFailed: false,
		});
		expect(spawn).toHaveBeenCalledWith(
			command().executable,
			["test"],
			expect.objectContaining({
				shell: false,
				windowsHide: true,
				stdio: ["ignore", "pipe", "pipe"],
			}),
		);
	});
	it("keeps spawn failures unsuccessful and content-free in the outcome state", async () => {
		const fake = child();
		vi.mocked(spawn).mockReturnValue(fake as unknown as ReturnType<typeof spawn>);
		const result = run(command());
		fake.emit("error", new Error("DYTEST-not-public"));
		fake.emit("close", null, null);
		await expect(result).resolves.toMatchObject({
			started: false,
			processError: true,
			code: null,
			stdout: "",
			stderr: "",
		});
	});
	it("caps combined output and retains overflow even when the child then exits zero", async () => {
		const fake = child();
		vi.mocked(spawn).mockReturnValue(fake as unknown as ReturnType<typeof spawn>);
		const result = run(command());
		fake.emit("spawn");
		fake.exitCode = 0;
		fake.stdout.write(Buffer.alloc(1024 * 1024 + 1));
		fake.emit("exit", 0, null);
		fake.emit("close", 0, null);
		await expect(result).resolves.toMatchObject({
			overflow: true,
			terminationFailed: true,
			stdout: "",
		});
	});
	it("refuses timeout completion when an ended parent still has open inherited pipes", async () => {
		vi.useFakeTimers();
		const fake = child();
		vi.mocked(spawn).mockReturnValue(fake as unknown as ReturnType<typeof spawn>);
		const result = run(command());
		fake.emit("spawn");
		fake.exitCode = 0;
		fake.emit("exit", 0, null);
		await vi.advanceTimersByTimeAsync(6000);
		await expect(result).resolves.toMatchObject({
			code: 0,
			timedOut: true,
			terminationFailed: true,
		});
		expect(spawn).toHaveBeenCalledTimes(1);
		expect(fake.unref).toHaveBeenCalled();
	});
});
