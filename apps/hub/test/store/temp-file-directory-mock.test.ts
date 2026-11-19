import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { stripVTControlCharacters } from "node:util";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

interface Settings {
	names: string[];
	openError?: boolean;
	readErrorAt?: number;
	readErrno?: "EBADF" | "EIO";
	closeError?: boolean;
}
interface Statistics {
	openCalls: number;
	readCalls: number;
	closeCalls: number;
	live: number;
}
interface DirectoryMock {
	open(): unknown;
	read(handle: unknown): { name: string } | null;
	close(handle: unknown): void;
	configure(settings: Settings): void;
	stats(): Statistics;
	foreign(): unknown;
}

const require = createRequire(import.meta.url);
const fixtures = path.join(import.meta.dirname, "fixtures");
const productionSource = path.join(fixtures, "temp-file-directory.c");
const mockSource = path.join(fixtures, "temp-file-directory-mock.c");
const headerNames = [
	"node_api.h",
	"node_api_types.h",
	"js_native_api.h",
	"js_native_api_types.h",
	"node_version.h",
] as const;
const digest = (bytes: Buffer): string => createHash("sha256").update(bytes).digest("hex");

function compilerEnv(directory: string): NodeJS.ProcessEnv {
	return { TMPDIR: directory, LC_ALL: "C", LANG: "C", PATH: "/usr/bin:/bin" };
}

const compileLimit = 64 * 1024;
const diagnosticFiles = new Set([
	"temp-file-directory.c",
	"temp-file-directory-mock.c",
	...headerNames,
	"dirent.h",
	"errno.h",
	"stdbool.h",
	"stdint.h",
	"stdlib.h",
	"string.h",
]);
const warningNames = [
	"implicit-function-declaration",
	"incompatible-pointer-types",
	"int-conversion",
	"return-type",
	"unused-function",
	"unused-variable",
	"unused-parameter",
	"unused-but-set-variable",
	"unknown-pragmas",
	"macro-redefined",
	"builtin-declaration-mismatch",
	"strict-prototypes",
	"missing-prototypes",
	"pedantic",
	"old-style-definition",
	"pointer-sign",
	"declaration-after-statement",
] as const;
const warningFlags = new Set([
	"-Werror",
	...warningNames.flatMap((name) => [`-W${name}`, `-Werror=${name}`]),
]);
const compilerErrors = new Set([
	"EACCES",
	"EAGAIN",
	"EBADF",
	"EFAULT",
	"EINTR",
	"EINVAL",
	"EIO",
	"EMFILE",
	"ENFILE",
	"ENOENT",
	"ENOEXEC",
	"ENOMEM",
	"ENOBUFS",
	"EPERM",
	"ETIMEDOUT",
	"E2BIG",
]);
const compilerSignals = new Set([
	"SIGABRT",
	"SIGALRM",
	"SIGBUS",
	"SIGFPE",
	"SIGILL",
	"SIGINT",
	"SIGKILL",
	"SIGPIPE",
	"SIGQUIT",
	"SIGSEGV",
	"SIGTERM",
	"SIGTRAP",
	"SIGSYS",
	"SIGXCPU",
	"SIGXFSZ",
]);
const compilerPrograms = new Set(["cc", "cc1", "as", "ld", "collect2", "lto1"]);
const categoryRules = [
	["cannot-exec", /cannot execute|unable to execute|failed to execute|execvp|execv|posix_spawn/i],
	["cannot-find", /cannot find|unable to find/i],
	["missing-file", /no such file or directory|file not found/i],
	["internal-error", /internal (?:compiler |linker )?error/i],
	[
		"implicit-declaration",
		/implicit declaration|implicitly declaring|implicit-function-declaration/i,
	],
	["conflicting-type", /conflicting types?|incompatible (?:function )?types?/i],
	["redefinition", /redefinition|redefined/i],
	["unknown-type", /unknown type name|unknown type/i],
	["unused", /unused|not used/i],
	["syntax", /syntax error|parse error|expected |undeclared identifier|\bundeclared\b/i],
] as const;

function ownValue(object: unknown, key: string): unknown {
	try {
		if (object === null || (typeof object !== "object" && typeof object !== "function"))
			return undefined;
		const field = Object.getOwnPropertyDescriptor(object, key);
		return field && "value" in field ? field.value : undefined;
	} catch {
		return undefined;
	}
}

/** Emit fixed metadata and admitted source tokens, never compiler text or paths. */
function compilerProjection(result: unknown, sources: readonly Buffer[]): object {
	try {
		const identifiers = new Set<string>();
		for (const source of sources) {
			if (source.length > compileLimit) continue;
			const code = source
				.toString("utf8")
				.replace(/\/\*[\s\S]*?\*\/|\/\/[^\r\n]*|"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'/g, " ")
				.replace(/^\s*#\s*include[^\r\n]*/gm, " ");
			for (const token of code.match(/\b[A-Za-z_][A-Za-z0-9_]{0,63}\b/g) ?? [])
				identifiers.add(token);
		}
		const status = ownValue(result, "status");
		const signal = ownValue(result, "signal");
		const error = ownValue(result, "error");
		const errorCode = ownValue(error, "code");
		const stderr = ownValue(result, "stderr");
		const stdout = ownValue(result, "stdout");
		const byteCount = (value: unknown): number | "over-limit" | "unavailable" =>
			Buffer.isBuffer(value)
				? value.length <= compileLimit
					? value.length
					: "over-limit"
				: "unavailable";
		const diagnostics: object[] = [];
		let truncated = Buffer.isBuffer(stderr) && stderr.length > compileLimit;
		let unparsedLines = 0;
		if (Buffer.isBuffer(stderr)) {
			const lines = stripVTControlCharacters(
				Buffer.prototype.toString.call(stderr, "utf8", 0, compileLimit),
			).split(/\r?\n/);
			if (lines.length > 256) truncated = true;
			for (const text of lines.slice(0, 256)) {
				if (!text) continue;
				if (text.length > 4096) {
					unparsedLines++;
					truncated = true;
					continue;
				}
				const located =
					/^(.+):([0-9]{1,6}):([0-9]{1,6}):\s*(fatal error|error|warning|note):\s*(.*)$/.exec(text);
				const noColumn = located
					? null
					: /^(.+):([0-9]{1,6}):\s*(fatal error|error|warning|note):\s*(.*)$/.exec(text);
				const driver =
					located || noColumn
						? null
						: /^(cc|cc1|as|ld|collect2|lto1):\s*(?:(fatal error|error|warning|note):\s*)?(.*)$/.exec(
								text,
							);
				if (!located && !noColumn && !driver) {
					unparsedLines++;
					continue;
				}
				if (diagnostics.length >= 8) {
					truncated = true;
					continue;
				}
				const filename = located?.[1] ?? noColumn?.[1];
				const basename =
					filename === undefined ? "compiler" : path.posix.basename(filename.replaceAll("\\", "/"));
				const severity = located?.[4] ?? noColumn?.[3] ?? driver?.[2] ?? "error";
				const body = located?.[5] ?? noColumn?.[4] ?? driver?.[3] ?? "";
				const names = new Set<string>();
				const programs = new Set<string>(driver?.[1] ? [driver[1]] : []);
				for (const quoted of body.matchAll(
					/['"\u2018\x60]([^'"\u2019\x60\r\n]{1,256})['"\u2019\x60]/g,
				))
					for (const name of quoted[1]?.match(/\b[A-Za-z_][A-Za-z0-9_]{0,63}\b/g) ?? []) {
						if (identifiers.has(name) && names.size < 4) names.add(name);
						if (compilerPrograms.has(name) && programs.size < 4) programs.add(name);
					}
				const flags = new Set<string>();
				let otherWarning = false;
				for (const match of body.matchAll(/\[(-W[^\]\s]{1,64})\]/g)) {
					const flag = match[1] ?? "";
					if (warningFlags.has(flag)) {
						if (flags.size < 4) flags.add(flag);
					} else otherWarning = true;
				}
				diagnostics.push({
					file: basename === "compiler" || diagnosticFiles.has(basename) ? basename : "other",
					line: located || noColumn ? Number(located?.[2] ?? noColumn?.[2]) : null,
					column: located ? Number(located[3]) : null,
					severity: severity === "fatal error" ? "fatal-error" : severity,
					category: categoryRules.find(([, expression]) => expression.test(body))?.[0] ?? "other",
					references: [...diagnosticFiles].filter((file) => body.includes(file)).slice(0, 4),
					identifiers: [...names],
					programs: [...programs],
					warningFlags: [...flags],
					otherWarning,
				});
			}
		}
		return {
			status:
				status === null ||
				(typeof status === "number" && Number.isInteger(status) && status >= 0 && status <= 255)
					? status
					: "other",
			signal:
				signal === null || (typeof signal === "string" && compilerSignals.has(signal))
					? signal
					: "other",
			errorCode:
				error === undefined
					? "none"
					: typeof errorCode === "string" && compilerErrors.has(errorCode)
						? errorCode
						: "other",
			stdoutBytes: byteCount(stdout),
			stderrBytes: byteCount(stderr),
			diagnostics,
			unparsedLines,
			truncated,
		};
	} catch {
		return { projection: "unavailable" };
	}
}

const fictionalC = [Buffer.from("static int read_directory; static int production_init;")];
function fictionalCompiler(stderr: string): object {
	return { status: 1, signal: null, stdout: Buffer.alloc(0), stderr: Buffer.from(stderr) };
}
it("uses only the fixed system compiler environment despite a hostile parent PATH", () => {
	const previous = process.env.PATH;
	try {
		process.env.PATH = "/DYTEST-UNTRUSTED:.:/DYTEST-CWD";
		const environment = compilerEnv("/DYTEST-OWNED-COMPILER-DIRECTORY");
		expect(environment).toEqual({
			TMPDIR: "/DYTEST-OWNED-COMPILER-DIRECTORY",
			LC_ALL: "C",
			LANG: "C",
			PATH: "/usr/bin:/bin",
		});
		expect(Object.keys(environment).sort()).toEqual(["LANG", "LC_ALL", "PATH", "TMPDIR"]);
		expect(environment.PATH).not.toContain("DYTEST");
	} finally {
		if (previous === undefined) delete process.env.PATH;
		else process.env.PATH = previous;
	}
});
it("projects admitted compiler locations, categories, warning rules and C tokens only", () => {
	const stderr =
		"/DYTEST-PRIVATE-PATH/temp-file-directory-mock.c:123:7: error: implicit declaration of function 'read_directory' [-Werror=implicit-function-declaration]\n";
	expect(compilerProjection(fictionalCompiler(stderr), fictionalC)).toEqual({
		status: 1,
		signal: null,
		errorCode: "none",
		stdoutBytes: 0,
		stderrBytes: Buffer.byteLength(stderr),
		unparsedLines: 0,
		truncated: false,
		diagnostics: [
			{
				file: "temp-file-directory-mock.c",
				line: 123,
				column: 7,
				severity: "error",
				category: "implicit-declaration",
				references: [],
				identifiers: ["read_directory"],
				programs: [],
				warningFlags: ["-Werror=implicit-function-declaration"],
				otherWarning: false,
			},
		],
	});
});
it.each([
	["cannot execute 'DYTEST-PRIVATE-EXEC': execvp: No such file or directory", "cannot-exec"],
	["'node_api.h' file not found", "missing-file"],
	["conflicting types for 'read_directory'", "conflicting-type"],
	["redefinition of 'read_directory'", "redefinition"],
	["unknown type name 'production_init'", "unknown-type"],
	["unused function 'read_directory'", "unused"],
	["expected ';' before 'read_directory'", "syntax"],
])("projects the fixed compiler category for a fictional %s", (message, category) => {
	const projection = compilerProjection(
		fictionalCompiler(`/DYTEST-PATH/node_api.h:12: warning: ${message}\n`),
		fictionalC,
	) as { diagnostics: { category: string; file: string }[] };
	expect(projection.diagnostics[0]).toMatchObject({ category, file: "node_api.h" });
});
it("projects bounded driver and linker failures without source coordinates or private arguments", () => {
	for (const [stderr, category, programs] of [
		[
			"cc: fatal error: cannot execute 'cc1': execvp: No such file or directory DYTEST-PRIVATE\n",
			"cannot-exec",
			["cc", "cc1"],
		],
		["collect2: fatal error: cannot find 'ld' DYTEST-PRIVATE\n", "cannot-find", ["collect2", "ld"]],
		["lto1: internal compiler error: DYTEST-PRIVATE\n", "internal-error", ["lto1"]],
	] as const) {
		const result = {
			...fictionalCompiler(stderr),
			signal: "SIGTERM",
			error: { code: "ETIMEDOUT" },
		};
		const projection = compilerProjection(result, fictionalC);
		expect(projection).toMatchObject({
			status: 1,
			signal: "SIGTERM",
			errorCode: "ETIMEDOUT",
			diagnostics: [{ file: "compiler", line: null, column: null, category, programs }],
		});
		expect(JSON.stringify(projection)).not.toContain("DYTEST");
	}
});
it("suppresses unknown paths, free text, source comments, stdout and unknown quoted tokens", () => {
	const result = {
		...fictionalCompiler(
			"/DYTEST-PRIVATE/secret.c:8:3: error: DYTEST-PRIVATE-TEXT 'DYTEST_PRIVATE_TOKEN' [-WDYTEST_PRIVATE_FLAG]\nDYTEST-PRIVATE-UNPARSED\n",
		),
		stdout: Buffer.from("DYTEST-PRIVATE-STDOUT"),
	};
	const projection = compilerProjection(result, [
		Buffer.from(
			'/* DYTEST_PRIVATE_TOKEN */ static int read_directory; char *text = "DYTEST_PRIVATE_TOKEN";',
		),
	]);
	const encoded = JSON.stringify(projection);
	expect(encoded).not.toContain("DYTEST");
	expect(projection).toMatchObject({
		diagnostics: [
			{
				file: "other",
				line: 8,
				column: 3,
				severity: "error",
				category: "other",
				identifiers: [],
				warningFlags: [],
				otherWarning: true,
			},
		],
		unparsedLines: 1,
	});
});
it("bounds compiler bytes and rows without invoking an error-code accessor", () => {
	let getters = 0;
	const error = Object.create(null);
	Object.defineProperty(error, "code", {
		get: () => {
			getters++;
			throw new Error("DYTEST-PRIVATE-ERROR");
		},
	});
	const diagnostic = "temp-file-directory.c:1:2: error: unused function 'read_directory'\n";
	const result = {
		status: 999,
		signal: "DYTEST-PRIVATE-SIGNAL",
		error,
		stdout: Buffer.alloc(0),
		stderr: Buffer.from(diagnostic.repeat(300) + "x".repeat(compileLimit)),
	};
	const projection = compilerProjection(result, fictionalC) as {
		diagnostics: object[];
		truncated: boolean;
	};
	expect(projection).toMatchObject({
		status: "other",
		signal: "other",
		errorCode: "other",
		stderrBytes: "over-limit",
		truncated: true,
	});
	expect(projection.diagnostics).toHaveLength(8);
	expect(JSON.stringify(projection).length).toBeLessThan(8192);
	expect(getters).toBe(0);
	const hostile = new Proxy(
		{},
		{
			getOwnPropertyDescriptor: () => {
				throw new Error("DYTEST-PRIVATE-TRAP");
			},
		},
	);
	expect(compilerProjection({ ...result, error: hostile }, fictionalC)).toMatchObject({
		errorCode: "other",
	});
});

function regularBytes(filename: string, maximum = 1024 * 1024): Buffer {
	const before = fs.lstatSync(filename, { bigint: true });
	assert(before.isFile() && !before.isSymbolicLink());
	assert(before.size > 0n && before.size <= BigInt(maximum));
	assert.equal(fs.realpathSync.native(filename), filename);
	const bytes = fs.readFileSync(filename);
	const after = fs.lstatSync(filename, { bigint: true });
	assert.equal(bytes.length, Number(before.size));
	for (const field of ["dev", "ino", "mode", "size", "mtimeNs", "ctimeNs"] as const)
		assert.equal(after[field], before[field]);
	return bytes;
}

function replacement(source: Buffer, before: string, after: string): Buffer {
	const text = source.toString("utf8");
	assert.notEqual(before, after);
	assert.equal(text.split(before).length, 2, "The source fault must have exactly one target");
	const changed = Buffer.from(text.replace(before, after));
	assert.notEqual(digest(changed), digest(source));
	return changed;
}

function closePointerFault(source: Buffer): Buffer {
	const text = source.toString("utf8");
	const marker = "static napi_value close_directory(";
	assert.equal(text.split(marker).length, 2);
	const start = text.indexOf(marker);
	return Buffer.concat([
		Buffer.from(text.slice(0, start)),
		replacement(Buffer.from(text.slice(start)), "state->directory = NULL;", "(void)0;"),
	]);
}

// These tests compile only the in-memory POSIX replacement fixture on Linux CI.
// The production Darwin reader is never built or loaded by this test.
describe("Linux synthetic raw-directory C body", { tags: ["requires:linux"] }, () => {
	let root: string | undefined;
	let baseline: DirectoryMock;
	let readGuardFault: DirectoryMock;
	let closeClearFault: DirectoryMock;
	// Keep fault handles alive so deferred finalizers cannot interfere with an oracle.
	const retainedHandles: unknown[] = [];

	beforeAll(() => {
		assert.equal(process.versions.node, "26.12.0");
		assert.equal(fs.realpathSync.native(process.execPath), process.execPath);
		assert.equal(path.basename(path.dirname(process.execPath)), "bin");
		const include = path.resolve(path.dirname(process.execPath), "..", "include", "node");
		assert.equal(fs.realpathSync.native(include), include);
		assert(fs.lstatSync(include).isDirectory());
		const inputs = [
			productionSource,
			mockSource,
			...headerNames.map((name) => path.join(include, name)),
		];
		const pins = new Map(inputs.map((filename) => [filename, digest(regularBytes(filename))]));
		const version = regularBytes(path.join(include, "node_version.h")).toString("utf8");
		for (const [part, expected] of [
			["MAJOR", 26],
			["MINOR", 12],
			["PATCH", 0],
		] as const) {
			const matches = [
				...version.matchAll(
					new RegExp(`^#define NODE_${part}_VERSION[ \\t]+([0-9]+)[ \\t]*$`, "gm"),
				),
			];
			assert.equal(matches.length, 1);
			assert.equal(Number(matches[0]?.[1]), expected);
		}
		root = fs.mkdtempSync(
			path.join(fs.realpathSync.native(os.tmpdir()), "draftyak-directory-mock-"),
		);
		fs.chmodSync(root, 0o700);
		const original = regularBytes(productionSource, 64 * 1024);
		const mock = regularBytes(mockSource, 64 * 1024);
		const build = (name: string, production: Buffer): DirectoryMock => {
			assert(root);
			const directory = path.join(root, name);
			fs.mkdirSync(directory, { mode: 0o700 });
			const source = path.join(directory, "temp-file-directory-mock.c");
			fs.writeFileSync(source, mock, { mode: 0o600, flag: "wx" });
			fs.writeFileSync(path.join(directory, "temp-file-directory.c"), production, {
				mode: 0o600,
				flag: "wx",
			});
			const binary = path.join(directory, "directory-mock.node");
			const compiled = spawnSync(
				"/usr/bin/cc",
				[
					"-std=c11",
					"-Wall",
					"-Wextra",
					"-Werror",
					"-O2",
					"-shared",
					"-fPIC",
					"-DNAPI_VERSION=8",
					"-I",
					include,
					source,
					"-o",
					binary,
				],
				{
					cwd: directory,
					env: compilerEnv(directory),
					encoding: "buffer",
					stdio: ["ignore", "pipe", "pipe"],
					timeout: 30_000,
					maxBuffer: 64 * 1024,
					windowsHide: true,
					shell: false,
				},
			);
			const diagnostic = `Synthetic C compile refused: ${JSON.stringify(compilerProjection(compiled, [original, mock]))}`;
			assert(compiled.status === 0, diagnostic);
			assert(compiled.signal === null, diagnostic);
			assert(compiled.error === undefined, diagnostic);
			assert(Buffer.isBuffer(compiled.stdout) && compiled.stdout.length === 0, diagnostic);
			assert(Buffer.isBuffer(compiled.stderr) && compiled.stderr.length === 0, diagnostic);
			const output = regularBytes(binary);
			const module = require(binary) as DirectoryMock;
			for (const key of ["open", "read", "close", "configure", "stats", "foreign"] as const)
				assert.equal(typeof Object.getOwnPropertyDescriptor(module, key)?.value, "function");
			assert.equal(digest(regularBytes(binary)), digest(output));
			return module;
		};
		baseline = build("baseline", original);
		readGuardFault = build(
			"read-guard-fault",
			replacement(original, "if (state->logical_reads >= MAX_LOGICAL_READS) {", "if (false) {"),
		);
		closeClearFault = build("close-clear-fault", closePointerFault(original));
		for (const [filename, expected] of pins) assert.equal(digest(regularBytes(filename)), expected);
		assert.equal(digest(regularBytes(productionSource)), digest(original));
	});

	afterAll(() => {
		if (!root) return;
		assert.equal(fs.realpathSync.native(root), root);
		assert.equal(path.dirname(root), fs.realpathSync.native(os.tmpdir()));
		assert(path.basename(root).startsWith("draftyak-directory-mock-"));
		fs.rmSync(root, { recursive: true, force: true });
		assert.equal(fs.existsSync(root), false);
	});

	function open(module: DirectoryMock, settings: Settings): unknown {
		module.configure(settings);
		const handle = module.open();
		retainedHandles.push(handle);
		return handle;
	}

	function repeatedEofOracle(module: DirectoryMock, observed?: { returned?: unknown }): void {
		const handle = open(module, { names: [] });
		try {
			for (let read = 0; read < 257; read++) assert.equal(module.read(handle), null);
			assert.throws(
				() => {
					const returned = module.read(handle);
					if (observed) observed.returned = returned;
				},
				{ code: "DYFD_BOUNDS" },
			);
			assert.equal(module.stats().readCalls, 1);
		} finally {
			module.close(handle);
		}
	}

	function closeOnceOracle(module: DirectoryMock, observed?: { code?: unknown }): void {
		const handle = open(module, { names: [] });
		module.close(handle);
		assert.throws(
			() => {
				try {
					module.close(handle);
				} catch (error) {
					if (observed && error instanceof Error)
						observed.code = Object.getOwnPropertyDescriptor(error, "code")?.value;
					throw error;
				}
			},
			{ code: "DYFD_CLOSED" },
		);
		assert.equal(module.stats().closeCalls, 1);
	}

	it("returns 256 numeric names and EOF while skipping each dot record once", () => {
		const names = Array.from({ length: 256 }, (_, index) => String(index));
		const handle = open(baseline, { names: [".", "..", ...names] });
		try {
			for (const name of names) expect(baseline.read(handle)).toEqual({ name });
			expect(baseline.read(handle)).toBeNull();
			expect(baseline.stats()).toEqual({ openCalls: 1, readCalls: 259, closeCalls: 0, live: 1 });
			expect(() => baseline.read(handle)).toThrow("DYFD_BOUNDS");
		} finally {
			baseline.close(handle);
		}
		expect(baseline.stats()).toEqual({ openCalls: 1, readCalls: 259, closeCalls: 1, live: 0 });
	});

	it("refuses repeated dot records and latches the failed read", () => {
		const handle = open(baseline, { names: [".", "."] });
		try {
			expect(() => baseline.read(handle)).toThrow("DYFD_NAME");
			expect(() => baseline.read(handle)).toThrow("DYFD_STATE");
			expect(baseline.stats().readCalls).toBe(2);
		} finally {
			baseline.close(handle);
		}
		expect(baseline.stats().closeCalls).toBe(1);
	});

	it("enforces the logical 257-read cap even after early EOF", () => {
		repeatedEofOracle(baseline);
	});

	it("kills an omitted logical guard through the same repeated-EOF oracle", () => {
		const observed: { returned?: unknown } = {};
		expect(() => repeatedEofOracle(readGuardFault, observed)).toThrow(assert.AssertionError);
		expect(Object.hasOwn(observed, "returned")).toBe(true);
		expect(observed.returned).toBeNull();
		expect(readGuardFault.stats()).toEqual({
			openCalls: 1,
			readCalls: 1,
			closeCalls: 1,
			live: 0,
		});
	});

	it("rejects forged, foreign, inherited and closed handles before POSIX calls", () => {
		const handle = open(baseline, { names: [] });
		for (const forged of [{}, baseline.foreign(), Object.create(handle as object), null, 1])
			expect(() => baseline.read(forged)).toThrow("DYFD_HANDLE");
		expect(baseline.stats()).toEqual({ openCalls: 1, readCalls: 0, closeCalls: 0, live: 1 });
		baseline.close(handle);
		expect(() => baseline.read(handle)).toThrow("DYFD_CLOSED");
		expect(() => baseline.close(handle)).toThrow("DYFD_CLOSED");
		expect(baseline.stats().closeCalls).toBe(1);
	});

	it("reports only fixed open and read errno fields without swallowing failures", () => {
		baseline.configure({ names: [], openError: true });
		assert.throws(() => baseline.open(), {
			code: "DYFD_OPEN",
			message: "DYFD_OPEN",
			syscallCode: "EACCES",
		});
		expect(baseline.stats()).toEqual({ openCalls: 1, readCalls: 0, closeCalls: 0, live: 0 });
		const handle = open(baseline, { names: ["0"], readErrorAt: 1, readErrno: "EBADF" });
		try {
			let failure: unknown;
			try {
				baseline.read(handle);
			} catch (error) {
				failure = error;
			}
			assert(failure instanceof Error);
			expect(Object.getOwnPropertyDescriptor(failure, "syscallCode")).toMatchObject({
				value: "EBADF",
				enumerable: false,
				writable: false,
				configurable: false,
			});
			assert.throws(
				() => {
					throw failure;
				},
				{ code: "DYFD_READ", message: "DYFD_READ" },
			);
			expect(() => baseline.read(handle)).toThrow("DYFD_STATE");
			expect(baseline.stats().readCalls).toBe(1);
		} finally {
			baseline.close(handle);
		}
		expect(baseline.stats().closeCalls).toBe(1);
	});

	it("closes once and invalidates the handle even when fake closedir fails", () => {
		const handle = open(baseline, { names: [], closeError: true });
		assert.throws(() => baseline.close(handle), {
			code: "DYFD_CLOSE",
			message: "DYFD_CLOSE",
			syscallCode: "EIO",
		});
		expect(() => baseline.close(handle)).toThrow("DYFD_CLOSED");
		expect(baseline.stats()).toEqual({ openCalls: 1, readCalls: 0, closeCalls: 1, live: 0 });
	});

	it("requires the close-pointer clear before any second fake closedir call", () => {
		closeOnceOracle(baseline);
	});

	it("kills an omitted pointer clear through the same close-once oracle", () => {
		const observed: { code?: unknown } = {};
		expect(() => closeOnceOracle(closeClearFault, observed)).toThrow(assert.AssertionError);
		expect(observed.code).toBe("DYFD_CLOSE");
		expect(closeClearFault.stats()).toEqual({
			openCalls: 1,
			readCalls: 0,
			closeCalls: 2,
			live: 0,
		});
	});
});
