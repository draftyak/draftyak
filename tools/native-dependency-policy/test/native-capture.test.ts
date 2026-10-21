import { EventEmitter } from "node:events";
import { chmod, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { PassThrough } from "node:stream";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	CaptureError,
	createEvidenceDirectory,
	type EvidenceDirectory,
	readCapturedBytes,
	STDERR_LIMIT,
	STDOUT_LIMIT,
} from "../src/evidence.ts";
import { captureNativeProcess, MAX_CAPTURE_MS, type NativeCommand } from "../src/native-capture.ts";

const injected = vi.hoisted(() => ({
	mode: "real" as "real" | "spawn-error" | "unknown-signal" | "signal" | "bad-code" | "unclosed",
	calls: [] as Array<{ executable: string; args: readonly string[]; options: unknown }>,
	realpathPause: null as null | { requested: string; entered: () => void; wait: Promise<void> },
}));
vi.mock("node:fs/promises", async (importOriginal) => {
	const actual = await importOriginal<typeof import("node:fs/promises")>();
	return {
		...actual,
		realpath: async (requested: string) => {
			const pause = injected.realpathPause;
			if (pause?.requested === requested) {
				injected.realpathPause = null;
				pause.entered();
				await pause.wait;
			}
			return actual.realpath(requested);
		},
	};
});
vi.mock("node:child_process", async (importOriginal) => {
	const actual = await importOriginal<typeof import("node:child_process")>();
	return {
		...actual,
		spawn: (executable: string, args: readonly string[], options: unknown) => {
			injected.calls.push({ executable, args, options });
			if (injected.mode === "real") return actual.spawn(executable, args, options as never);
			// Synthetic process API only: no OS PID exists and no termination call can select one.
			const child = Object.assign(new EventEmitter(), {
				pid: undefined,
				exitCode: null as number | null,
				signalCode: null as string | null,
				stdout: new PassThrough(),
				stderr: new PassThrough(),
			});
			queueMicrotask(() => {
				if (injected.mode === "spawn-error") {
					child.emit("error", new Error("synthetic private diagnostic"));
				} else if (injected.mode === "signal" || injected.mode === "unknown-signal") {
					child.signalCode = injected.mode === "signal" ? "SIGTERM" : "synthetic-signal";
					child.emit("exit", null, child.signalCode);
				} else {
					child.exitCode = injected.mode === "bad-code" ? -1 : 0;
					child.emit("exit", child.exitCode, null);
				}
				if (injected.mode === "unclosed") return;
				child.stdout.end();
				child.stderr.end();
				setImmediate(() => child.emit("close", child.exitCode, child.signalCode));
			});
			return child;
		},
	};
});

let root: string;
let checkout: string;
let directory: string;
let evidence: EvidenceDirectory;
const env = (): Record<string, string> =>
	process.platform === "win32" && process.env.SystemRoot
		? { SystemRoot: process.env.SystemRoot }
		: {};
beforeEach(async () => {
	injected.mode = "real";
	injected.calls.length = 0;
	injected.realpathPause = null;
	root = await mkdtemp(path.join(os.tmpdir(), "draftyak-native-test-"));
	checkout = path.join(root, "checkout");
	directory = path.join(root, "evidence");
	await mkdir(checkout);
	evidence = await createEvidenceDirectory({ checkoutRoot: checkout, directory });
});
afterEach(async () => {
	vi.restoreAllMocks();
	expect(path.basename(root)).toMatch(/^draftyak-native-test-/);
	expect(path.dirname(root)).toBe(path.resolve(os.tmpdir()));
	await rm(root, { recursive: true, force: true });
});
async function command(
	source = "",
	overrides: Partial<NativeCommand> = {},
): Promise<NativeCommand> {
	const script = path.join(root, "synthetic-child.cjs");
	await writeFile(script, source);
	return {
		executable: process.execPath,
		args: [script],
		cwd: root,
		env: env(),
		deadlineMs: 5000,
		...overrides,
	};
}
async function refuses(input: NativeCommand): Promise<void> {
	await expect(captureNativeProcess(evidence, "invalid", input)).rejects.toMatchObject({
		name: "CaptureError",
		code: "INVALID_INPUT",
		message: "native process capture refused",
	});
	expect(injected.calls).toHaveLength(0);
}

describe("fixed native command capture", () => {
	it("captures separate opaque bytes and retains a real nonzero exit", async () => {
		const result = await captureNativeProcess(
			evidence,
			"nonzero",
			await command(
				"process.stdout.write(Buffer.from([0,255,65]));process.stderr.write('synthetic-private');process.exitCode=7;",
			),
		);
		expect(result.failure).toBeNull();
		expect(result.exitCode).toBe(7);
		expect(result.signal).toBeNull();
		expect(await readCapturedBytes(evidence, result, "stdout")).toEqual(Buffer.from([0, 255, 65]));
		expect(Buffer.from(await readCapturedBytes(evidence, result, "stderr")).toString()).toBe(
			"synthetic-private",
		);
		expect(JSON.stringify(result)).not.toContain("synthetic-private");
	});
	it("passes argv literally without a shell or inherited environment", async () => {
		const input = await command(
			"process.stdout.write(JSON.stringify({args:process.argv.slice(2),keys:Object.keys(process.env).filter(key=>process.env[key]!=='').sort()}));",
		);
		const literal = 'synthetic space & "quote" ; $()';
		const result = await captureNativeProcess(evidence, "literal", {
			...input,
			args: [...input.args, literal],
		});
		expect(result.failure).toBeNull();
		expect(result.exitCode).toBe(0);
		const data = JSON.parse(
			Buffer.from(await readCapturedBytes(evidence, result, "stdout")).toString(),
		);
		expect(data.args).toEqual([literal]);
		expect(data.keys).toEqual(
			Object.keys(env())
				.map((key) => (process.platform === "win32" ? key.toUpperCase() : key))
				.sort(),
		);
		expect(injected.calls[0]?.options).toMatchObject({
			shell: false,
			windowsHide: true,
			stdio: ["ignore", "pipe", "pipe"],
		});
		const options = injected.calls[0]?.options as { env: Record<string, string> };
		expect(
			Object.keys(options.env)
				.filter((key) => options.env[key] !== "")
				.sort(),
		).toEqual(data.keys);
	});
	it("does not print captured child prose or raw errors", async () => {
		const output = vi.spyOn(console, "log").mockImplementation(() => undefined);
		const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
		const warning = vi.spyOn(console, "warn").mockImplementation(() => undefined);
		const result = await captureNativeProcess(
			evidence,
			"quiet",
			await command(
				"process.stdout.write('synthetic-out');process.stderr.write('synthetic-err');process.exitCode=9;",
			),
		);
		expect(result.exitCode).toBe(9);
		expect(output).not.toHaveBeenCalled();
		expect(error).not.toHaveBeenCalled();
		expect(warning).not.toHaveBeenCalled();
	});
	it.each(["stdout", "stderr"] as const)("accepts the exact real-child %s cap", async (stream) => {
		const limit = stream === "stdout" ? STDOUT_LIMIT : STDERR_LIMIT;
		const input = await command(`process.${stream}.write(Buffer.alloc(${limit},65));`, {
			deadlineMs: 25_000,
		});
		const result = await captureNativeProcess(evidence, "exact", input);
		expect(result.failure).toBeNull();
		expect(result.exitCode).toBe(0);
		expect(result[stream].bytes).toBe(limit);
	});
	it.each(["stdout", "stderr"] as const)(
		"refuses a real-child %s overflow without storing excess",
		async (stream) => {
			const limit = stream === "stdout" ? STDOUT_LIMIT : STDERR_LIMIT;
			const input = await command(
				"process." +
					stream +
					".write(Buffer.alloc(" +
					(limit + 1) +
					",65));setTimeout(()=>{},2000);",
				{ deadlineMs: 25_000 },
			);
			const result = await captureNativeProcess(evidence, "overflow", input);
			expect(result.failure).toBe(stream === "stdout" ? "STDOUT_LIMIT" : "STDERR_LIMIT");
			expect(result[stream].bytes).toBeLessThanOrEqual(limit);
			expect(
				(await readFile(path.join(directory, result[stream].file))).length,
			).toBeLessThanOrEqual(limit);
			await expect(readCapturedBytes(evidence, result, stream)).rejects.toBeInstanceOf(
				CaptureError,
			);
		},
	);
});

describe("native input restrictions", () => {
	it("refuses relative executables, shims, scripts and shell interpreters", async () => {
		const input = await command();
		for (const executable of [
			"node",
			path.join(root, "tool.cmd"),
			path.join(root, "tool.ps1"),
			path.join(root, "script.cjs"),
			path.join(root, process.platform === "win32" ? "cmd.exe" : "bash"),
		]) {
			await refuses({ ...input, executable });
		}
	});
	it("refuses an executable-looking file with no native header", async () => {
		const executable = path.join(
			root,
			process.platform === "win32" ? "synthetic.exe" : "synthetic",
		);
		await writeFile(executable, "synthetic-not-a-native-executable");
		await chmod(executable, 0o700);
		await refuses(await command("", { executable }));
	});
	it("refuses unsafe or excessive arguments before spawn", async () => {
		const input = await command();
		for (const args of [
			["\0"],
			["a".repeat(8193)],
			Array.from({ length: 65 }, () => ""),
			Array.from({ length: 9 }, () => "a".repeat(8192)),
		]) {
			await refuses({ ...input, args });
		}
	});
	it("refuses implicit environment, forbidden keys and excessive values", async () => {
		const input = await command();
		const environments: Record<string, string>[] = [
			{ NODE_OPTIONS: "--no-warnings" },
			{ SYNTHETIC_SECRET: "synthetic" },
			{ PATH: "a\0b" },
			{ PATH: "a".repeat(8193) },
			{
				HOME: "a".repeat(8192),
				PATH: "a".repeat(8192),
				TEMP: "a".repeat(8192),
				TMP: "a".repeat(8192),
			},
		];
		for (const bad of environments) {
			await refuses({ ...input, env: bad });
		}
	});
	it("requires a positive bounded total deadline and existing absolute cwd", async () => {
		const input = await command();
		for (const deadlineMs of [0, 49, MAX_CAPTURE_MS + 1, Number.NaN, 50.5]) {
			await refuses({ ...input, deadlineMs });
		}
		await refuses({ ...input, cwd: "." });
		await refuses({ ...input, cwd: path.join(root, "absent") });
	});
});

describe("explicit native CARGO environment", () => {
	it("hands an explicit native CARGO to the controlled child without running it", async () => {
		const result = await captureNativeProcess(
			evidence,
			"cargo-native",
			await command("process.stdout.write(String(process.env.CARGO===process.execPath));", {
				env: { ...env(), CARGO: process.execPath },
			}),
		);
		expect(result.failure).toBeNull();
		expect(result.exitCode).toBe(0);
		expect(Buffer.from(await readCapturedBytes(evidence, result, "stdout")).toString()).toBe(
			"true",
		);
		expect(injected.calls).toHaveLength(1);
		expect(injected.calls[0]?.executable === process.execPath).toBe(true);
	});
	it("retains a requested native-looking path with spaces and noncanonical spelling", async () => {
		const folder = path.join(root, "native paths");
		await mkdir(folder);
		const name = process.platform === "win32" ? "synthetic.exe" : "synthetic";
		const fixture = path.join(folder, name);
		await writeFile(fixture, Buffer.from([0x4d, 0x5a, 0, 0]));
		await chmod(fixture, 0o700);
		const requested = `${folder}${path.sep}..${path.sep}native paths${path.sep}${name}`;
		const input = await command(
			"process.stdout.write(String(process.env.CARGO===process.argv[2]));",
			{
				env: { ...env(), CARGO: requested },
			},
		);
		const result = await captureNativeProcess(evidence, "cargo-spaces", {
			...input,
			args: [...input.args, requested],
		});
		expect(result.failure).toBeNull();
		expect(result.exitCode).toBe(0);
		expect(Buffer.from(await readCapturedBytes(evidence, result, "stdout")).toString()).toBe(
			"true",
		);
		expect(injected.calls[0]?.executable === process.execPath).toBe(true);
	});
	it("does not inherit an ambient CARGO or PATH when the entries are omitted", async () => {
		vi.stubEnv("CARGO", "synthetic-ambient-cargo");
		vi.stubEnv("PATH", "synthetic-ambient-path");
		try {
			const result = await captureNativeProcess(
				evidence,
				"cargo-absent",
				await command("process.stdout.write(String(!process.env.CARGO&&!process.env.PATH));"),
			);
			expect(result.failure).toBeNull();
			expect(result.exitCode).toBe(0);
			expect(Buffer.from(await readCapturedBytes(evidence, result, "stdout")).toString()).toBe(
				"true",
			);
			const options = injected.calls[0]?.options as { env: Record<string, string> };
			expect(Object.hasOwn(options.env, "CARGO")).toBe(false);
		} finally {
			vi.unstubAllEnvs();
		}
	});
	it.each(["cargo", "Cargo", "CaRgO"])(
		"refuses the %s alias alone and beside CARGO",
		async (alias) => {
			const input = await command();
			await refuses({ ...input, env: { ...env(), [alias]: process.execPath } });
			await refuses({
				...input,
				env: { ...env(), CARGO: process.execPath, [alias]: process.execPath },
			});
			expect(await readdir(directory)).toEqual([]);
		},
	);
	it("refuses invalid CARGO before capture creation or controlled-parent spawn", async () => {
		const script = path.join(root, "synthetic.mjs");
		const shell = path.join(root, process.platform === "win32" ? "cmd.exe" : "bash");
		// Native-looking data fixtures are never invoked, even under the guard mutation.
		for (const fixture of [script, shell]) {
			await writeFile(fixture, Buffer.from([0x4d, 0x5a, 0, 0]));
			await chmod(fixture, 0o700);
		}
		const nonnative = path.join(root, process.platform === "win32" ? "text.exe" : "text");
		await writeFile(nonnative, "synthetic-not-native");
		await chmod(nonnative, 0o700);
		const nativeDirectory = path.join(root, "directory.exe");
		await mkdir(nativeDirectory);
		const input = await command();
		for (const cargo of [
			"",
			"cargo",
			".",
			script,
			...["cmd", "bat", "ps1", "sh", "js", "mjs", "cjs", "py"].map((suffix) =>
				path.join(root, `tool.${suffix}`),
			),
			shell,
			path.join(root, "absent.exe"),
			nonnative,
			nativeDirectory,
			`${process.execPath}\0`,
			`${process.execPath} --version`,
			"a".repeat(8193),
		]) {
			await refuses({ ...input, env: { ...env(), CARGO: cargo } });
		}
		expect(await readdir(directory)).toEqual([]);
		// Refused input must not consume the capture ID either.
		const result = await captureNativeProcess(evidence, "invalid", input);
		expect(result.failure).toBeNull();
		expect(result.exitCode).toBe(0);
	});
	it("snapshots CARGO and argv before the first filesystem validation await", async () => {
		const input = await command(
			"process.stdout.write(String(process.env.CARGO===process.execPath&&process.argv[2]==='original'));",
			{
				env: { ...env(), CARGO: process.execPath },
			},
		);
		const args = [...input.args, "original"];
		const environment = { ...input.env };
		const entered = Promise.withResolvers<void>();
		const resume = Promise.withResolvers<void>();
		injected.realpathPause = {
			requested: process.execPath,
			entered: entered.resolve,
			wait: resume.promise,
		};
		const pending = captureNativeProcess(evidence, "cargo-snapshot", {
			...input,
			args,
			env: environment,
		});
		try {
			await entered.promise;
			environment.CARGO = path.join(root, "later-unvalidated.cjs");
			args[args.length - 1] = "changed";
		} finally {
			resume.resolve();
		}
		const result = await pending;
		expect(result.failure).toBeNull();
		expect(result.exitCode).toBe(0);
		expect(Buffer.from(await readCapturedBytes(evidence, result, "stdout")).toString()).toBe(
			"true",
		);
	});
});

describe("completion and owned process lifetime", () => {
	it("records a fixed spawn failure without child diagnostics", async () => {
		injected.mode = "spawn-error";
		const result = await captureNativeProcess(evidence, "spawn", await command());
		expect(result).toMatchObject({ failure: "SPAWN_FAILED", exitCode: null, signal: null });
		expect(JSON.stringify(result)).not.toContain("synthetic private diagnostic");
	});
	it("records an allowlisted signal without inventing a numeric exit", async () => {
		injected.mode = "signal";
		const result = await captureNativeProcess(evidence, "signal", await command());
		expect(result).toMatchObject({ failure: null, exitCode: null, signal: "SIGTERM" });
	});
	it.each(["unknown-signal", "bad-code"] as const)(
		"refuses malformed completion %s",
		async (mode) => {
			injected.mode = mode;
			const result = await captureNativeProcess(evidence, "completion", await command());
			expect(result.failure).toBe("COMPLETION_INVALID");
			expect(result.signal).toBeNull();
			expect(result.exitCode).toBeNull();
		},
	);
	it("refuses unclosed pipes after parent exit without targeting a stale PID", async () => {
		injected.mode = "unclosed";
		const start = performance.now();
		const result = await captureNativeProcess(
			evidence,
			"uncertain",
			await command("", { deadlineMs: 100 }),
		);
		expect(result.failure).toBe("TREE_UNCONFIRMED");
		expect(result.exitCode).toBe(0);
		expect(performance.now() - start).toBeLessThan(1500);
		expect(injected.calls).toHaveLength(1);
	});
	it("terminates only its real owned child tree within the total deadline", async () => {
		// The grandchild has its own finite stop even if this assertion is exercised under mutation.
		const marker = path.join(root, "grandchild-completed");
		const childSource =
			"require('node:child_process').spawn(process.execPath,['-e'," +
			JSON.stringify(
				"setTimeout(()=>require('node:fs').writeFileSync(" +
					JSON.stringify(marker) +
					",'synthetic-late'),2500);",
			) +
			"],{stdio:'inherit',env:process.env});setTimeout(()=>{},3000);";
		const input = await command(childSource, { deadlineMs: 1500 });
		const start = performance.now();
		const result = await captureNativeProcess(evidence, "timeout", input);
		try {
			expect(result.failure).toBe("TIMED_OUT");
			expect(performance.now() - start).toBeLessThan(2300);
			expect(result.exitCode !== null || result.signal !== null).toBe(true);
		} finally {
			// Also drain the synthetic finite lifetime when a guard mutation makes an assertion fail.
			const control = await captureNativeProcess(
				evidence,
				"wait",
				await command("setTimeout(()=>{},2000);", { deadlineMs: 5000 }),
			);
			expect(control.exitCode).toBe(0);
		}
		await expect(readFile(marker)).rejects.toMatchObject({ code: "ENOENT" });
	}, 10_000);
});
