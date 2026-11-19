import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { buildTempFileDirectory, type DirectoryBuildRuntime } from "./temp-file-directory.ts";

let root: string;
let include: string;
let runtime: DirectoryBuildRuntime;
let groupWritable = false;
const native = { open: vi.fn(() => ({})), read: vi.fn(() => null), close: vi.fn() };
const success = () => ({
	status: 0,
	signal: null,
	stdout: Buffer.alloc(0),
	stderr: Buffer.alloc(0),
});

beforeEach(() => {
	root = fs.mkdtempSync(path.join(fs.realpathSync.native(os.tmpdir()), "draftyak-temp-store-"));
	const bin = path.join(root, "node", "bin");
	include = path.join(root, "node", "include", "node");
	fs.mkdirSync(bin, { recursive: true });
	fs.mkdirSync(include, { recursive: true });
	const execPath = path.join(bin, "node");
	fs.writeFileSync(execPath, "DYTEST-NODE-LOCATION");
	for (const name of ["node_api.h", "node_api_types.h", "js_native_api.h", "js_native_api_types.h"])
		fs.writeFileSync(path.join(include, name), "DYTEST-HEADER\n");
	fs.writeFileSync(
		path.join(include, "node_version.h"),
		"#define NODE_MAJOR_VERSION 26\n#define NODE_MINOR_VERSION 12\n#define NODE_PATCH_VERSION 0\n",
	);
	groupWritable = false;
	// These synthetic compiler tests do not claim Windows mode bits supply POSIX ownership.
	const stat = fs.lstatSync;
	const fstat = fs.fstatSync;
	const open = fs.openSync;
	const close = fs.closeSync;
	const opened = new Map<number, string>();
	const metadata = (filename: string, info: fs.Stats | fs.BigIntStats) => {
		const big = typeof info.mode === "bigint";
		if (filename === path.join(root, "descriptor-directory"))
			Object.defineProperty(info, "mode", { value: big ? 0o40700n : 0o40700 });
		if (filename === path.join(root, "descriptor-directory", "directory.node"))
			Object.defineProperty(info, "mode", {
				value: big ? (groupWritable ? 0o100775n : 0o100755n) : groupWritable ? 0o100775 : 0o100755,
			});
		return info;
	};
	vi.spyOn(fs, "openSync").mockImplementation((...args) => {
		const fd = Reflect.apply(open, fs, args);
		opened.set(fd, String(args[0]));
		return fd;
	});
	vi.spyOn(fs, "closeSync").mockImplementation((fd) => {
		opened.delete(fd);
		return close(fd);
	});
	vi.spyOn(fs, "fstatSync").mockImplementation(((fd: number, options?: unknown) => {
		const info = Reflect.apply(fstat, fs, options === undefined ? [fd] : [fd, options]);
		return metadata(opened.get(fd) ?? "", info);
	}) as typeof fs.fstatSync);
	vi.spyOn(fs, "lstatSync").mockImplementation(((filename: fs.PathLike, options?: unknown) => {
		const info = Reflect.apply(stat, fs, options === undefined ? [filename] : [filename, options]);
		return metadata(String(filename), info);
	}) as typeof fs.lstatSync);
	syncBuiltinESMExports();
	runtime = {
		platform: "darwin",
		arch: "arm64",
		nodeVersion: "26.12.0",
		execPath,
		uid: fs.statSync(root).uid,
		compile: vi.fn((_command, args) => {
			const output = args[args.indexOf("-o") + 1];
			if (!output) throw new Error("Missing synthetic output");
			fs.writeFileSync(output, "DYTEST-SYNTHETIC-ADDON");
			return success();
		}),
		load: vi.fn(() => native),
	};
	vi.clearAllMocks();
});

afterEach(() => {
	vi.restoreAllMocks();
	vi.unstubAllEnvs();
	syncBuiltinESMExports();
	expect(path.dirname(root)).toBe(fs.realpathSync.native(os.tmpdir()));
	expect(path.basename(root).startsWith("draftyak-temp-store-")).toBe(true);
	fs.rmSync(root, { recursive: true, force: true });
	expect(fs.existsSync(root)).toBe(false);
});

it("binds the fixed compiler and pinned installation headers to one fresh owned addon", () => {
	const directory = buildTempFileDirectory(root, runtime);
	expect(runtime.compile).toHaveBeenCalledOnce();
	const [command, args, options] = vi.mocked(runtime.compile).mock.calls[0] ?? [];
	expect(command).toBe("/usr/bin/clang");
	expect(args).toEqual([
		"-std=c11",
		"-Wall",
		"-Wextra",
		"-Werror",
		"-O2",
		"-bundle",
		"-undefined",
		"dynamic_lookup",
		"-DNAPI_VERSION=8",
		"-arch",
		"arm64",
		"-I",
		include,
		path.resolve(import.meta.dirname, "fixtures", "temp-file-directory.c"),
		"-o",
		path.join(root, "descriptor-directory", "directory.node"),
	]);
	expect(options).toEqual({
		cwd: path.join(root, "descriptor-directory"),
		env: {
			TMPDIR: path.join(root, "descriptor-directory"),
			LC_ALL: "C",
			LANG: "C",
			PATH: "/usr/bin:/bin",
		},
		encoding: "buffer",
		stdio: ["ignore", "pipe", "pipe"],
		timeout: 30_000,
		maxBuffer: 65536,
		windowsHide: true,
		shell: false,
	});
	expect(runtime.load).toHaveBeenCalledExactlyOnceWith(
		path.join(root, "descriptor-directory", "directory.node"),
	);
	const handle = directory.open();
	expect(directory.read(handle)).toBeNull();
	directory.close(handle);
	expect(native.open).toHaveBeenCalledOnce();
	expect(native.close).toHaveBeenCalledExactlyOnceWith(handle);
});

it("keeps secondary compiler tools on a fixed trusted path despite a hostile parent environment", () => {
	const hostile = path.join(root, "DYTEST-untrusted-tools");
	vi.stubEnv("PATH", hostile);
	vi.stubEnv("PWD", hostile);
	const compile = runtime.compile;
	runtime = {
		...runtime,
		compile: vi.fn((command, args, options) => {
			if (options.env.PATH !== "/usr/bin:/bin") throw new Error("DYTEST-COMPILER-PATH");
			return compile(command, args, options);
		}),
	};
	expect(() => buildTempFileDirectory(root, runtime)).not.toThrow();
	expect(vi.mocked(runtime.compile).mock.calls[0]?.[2]).toMatchObject({
		cwd: path.join(root, "descriptor-directory"),
		env: {
			TMPDIR: path.join(root, "descriptor-directory"),
			LC_ALL: "C",
			LANG: "C",
			PATH: "/usr/bin:/bin",
		},
	});
	expect(vi.mocked(runtime.compile).mock.calls[0]?.[2].env).not.toHaveProperty("PWD");
	expect(process.env.PATH).toBe(hostile);
	expect(process.env.PWD).toBe(hostile);
});

it.each([{ platform: "linux" }, { nodeVersion: "26.11.0" }, { arch: "mips" }, { uid: undefined }])(
	"refuses an unqualified runtime before compiler execution: %j",
	(change) => {
		expect(() => buildTempFileDirectory(root, { ...runtime, ...change })).toThrow(
			"Temporary-file directory build refused",
		);
		expect(runtime.compile).not.toHaveBeenCalled();
		expect(runtime.load).not.toHaveBeenCalled();
	},
);

it("uses the x64 target explicitly and has no compiler search fallback", () => {
	buildTempFileDirectory(root, { ...runtime, arch: "x64" });
	expect(vi.mocked(runtime.compile).mock.calls[0]?.[1]).toContain("x86_64");
	expect(runtime.compile).toHaveBeenCalledOnce();
});

it.each(["missing", "version", "duplicate", "layout"])(
	"refuses %s pinned header admission",
	(change) => {
		if (change === "missing") fs.unlinkSync(path.join(include, "node_api.h"));
		if (change === "version")
			fs.writeFileSync(path.join(include, "node_version.h"), "#define NODE_MAJOR_VERSION 25\n");
		if (change === "duplicate")
			fs.appendFileSync(path.join(include, "node_version.h"), "#define NODE_MINOR_VERSION 12\n");
		const actual =
			change === "layout" ? { ...runtime, execPath: path.join(root, "node") } : runtime;
		expect(() => buildTempFileDirectory(root, actual)).toThrow(
			"Temporary-file directory build refused",
		);
		expect(runtime.compile).not.toHaveBeenCalled();
		expect(runtime.load).not.toHaveBeenCalled();
	},
);

it.each([
	{ status: 1 },
	{ signal: "SIGTERM" },
	{ error: new Error("DYTEST-PRIVATE-BUILD") },
	{ stdout: Buffer.from("DYTEST-PRIVATE-OUTPUT") },
	{ stderr: Buffer.from("DYTEST-PRIVATE-DIAGNOSTIC") },
	{ stdout: "" },
	{ stderr: null },
])("refuses compiler failure or unexpected output without loading: %j", (change) => {
	runtime = { ...runtime, compile: vi.fn(() => ({ ...success(), ...change })) };
	expect(() => buildTempFileDirectory(root, runtime)).toThrow(
		"Temporary-file directory build refused",
	);
	expect(runtime.load).not.toHaveBeenCalled();
});

it("does not inspect failed-command output or reuse an existing binary", () => {
	let traps = 0;
	runtime = {
		...runtime,
		compile: vi.fn(() => ({
			status: 1,
			signal: null,
			get stdout() {
				traps++;
				throw new Error("DYTEST-PRIVATE-OUTPUT");
			},
			get stderr() {
				traps++;
				throw new Error("DYTEST-PRIVATE-OUTPUT");
			},
		})),
	};
	expect(() => buildTempFileDirectory(root, runtime)).toThrow(
		"Temporary-file directory build refused",
	);
	expect(traps).toBe(0);
	expect(runtime.load).not.toHaveBeenCalled();
	expect(() => buildTempFileDirectory(root, runtime)).toThrow(
		"Temporary-file directory build refused",
	);
	expect(runtime.compile).toHaveBeenCalledOnce();
});

it("refuses changed build inputs", () => {
	const compile = runtime.compile;
	runtime = {
		...runtime,
		compile: vi.fn((command, args, options) => {
			const result = compile(command, args, options);
			fs.appendFileSync(path.join(include, "node_api.h"), "DYTEST-CHANGED\n");
			return result;
		}),
	};
	expect(() => buildTempFileDirectory(root, runtime)).toThrow(
		"Temporary-file directory build refused",
	);
	expect(runtime.load).not.toHaveBeenCalled();
});

it("refuses group-writable binary ownership", () => {
	groupWritable = true;
	expect(() => buildTempFileDirectory(root, runtime)).toThrow(
		"Temporary-file directory build refused",
	);
	expect(runtime.load).not.toHaveBeenCalled();
});

it("refuses a changed binary after the injected load step", () => {
	runtime = {
		...runtime,
		load: vi.fn((filename) => {
			fs.appendFileSync(filename, "DYTEST-REPLACED");
			return native;
		}),
	};
	expect(() => buildTempFileDirectory(root, runtime)).toThrow(
		"Temporary-file directory build refused",
	);
});

it("validates own exported functions without executing getters", () => {
	let traps = 0;
	const module = { read: native.read, close: native.close };
	Object.defineProperty(module, "open", {
		get: () => {
			traps++;
			return native.open;
		},
	});
	runtime = { ...runtime, load: vi.fn(() => module) };
	expect(() => buildTempFileDirectory(root, runtime)).toThrow(
		"Temporary-file directory build refused",
	);
	expect(traps).toBe(0);
});

it("refuses accessor, extra-field and oversized native names without interpreting them", () => {
	let traps = 0;
	let entry: unknown;
	const directory = buildTempFileDirectory(root, {
		...runtime,
		load: () => ({ ...native, read: () => entry }),
	});
	const accessor = Object.create(null);
	Object.defineProperty(accessor, "name", {
		get: () => {
			traps++;
			return "0";
		},
	});
	for (entry of [accessor, { name: "0", extra: true }, { name: "1".repeat(256) }, undefined])
		expect(() => directory.read({})).toThrow("Temporary-file directory build refused");
	expect(traps).toBe(0);
});

it("refuses an invalid close result", () => {
	const directory = buildTempFileDirectory(root, {
		...runtime,
		load: () => ({ ...native, close: () => true }),
	});
	expect(() => directory.close({})).toThrow("Temporary-file directory build refused");
});

it("bounds opened input reads even when a header grows after its admitted stat", () => {
	const header = path.join(include, "node_api.h");
	const open = vi.mocked(fs.openSync).getMockImplementation();
	const read = fs.readSync;
	const close = vi.mocked(fs.closeSync).getMockImplementation();
	if (!open || !close) throw new Error("Missing synthetic file controls");
	let target: number | undefined;
	let bytes = 0;
	let largestRequest = 0;
	let closed = 0;
	vi.spyOn(fs, "openSync").mockImplementation((...args) => {
		const fd = Reflect.apply(open, fs, args);
		if (String(args[0]) === header && target === undefined) target = fd;
		return fd;
	});
	vi.spyOn(fs, "readSync").mockImplementation((...args) => {
		if (args[0] === target) {
			if (bytes === 0) fs.appendFileSync(header, Buffer.alloc(1024 * 1024 + 2, "x"));
			largestRequest = Math.max(largestRequest, Number((args as unknown[])[3]));
			const count = Reflect.apply(read, fs, args);
			bytes += count;
			return count;
		}
		return Reflect.apply(read, fs, args);
	});
	vi.spyOn(fs, "closeSync").mockImplementation((fd) => {
		if (fd === target) closed++;
		return close(fd);
	});
	syncBuiltinESMExports();
	expect(() => buildTempFileDirectory(root, runtime)).toThrow(
		"Temporary-file directory build refused",
	);
	expect(largestRequest).toBeLessThanOrEqual(1024 * 1024 + 1);
	expect(bytes).toBe(1024 * 1024 + 1);
	expect(closed).toBe(1);
	expect(runtime.compile).not.toHaveBeenCalled();
	expect(runtime.load).not.toHaveBeenCalled();
});
