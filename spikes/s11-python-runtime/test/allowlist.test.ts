import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { assertContentFree } from "@draftyak/spike-kit";
import { describe, expect, it } from "vitest";
import { installedDir, readRuntimeLock, resolveWheels } from "../scripts/fetch-runtime.ts";
import {
	ALLOWLIST,
	type Argv,
	allowlistOf,
	CANDIDATES,
	type CandidateRun,
	knownExitAbort,
	LADDER_SHIM_FIXES,
	productionArgv,
	REQUIRED,
	uncleanExitsOf,
} from "./allowlist.ts";
import { contentFree, exitReasonOf, reasonOf } from "./rpc.ts";

const lock = readRuntimeLock();
const pyodideLock = JSON.parse(
	fs.readFileSync(path.join(installedDir("pyodide"), "pyodide-lock.json"), "utf8"),
);
const LIBUV_ABORT =
	"Assertion failed: !(handle->flags & UV_HANDLE_CLOSING), file src\\win\\async.c, line 94";

describe("the allowlist candidates", () => {
	it("are the backlog's nine, each in runtime.lock.json with its whole wheel closure", () => {
		expect(CANDIDATES).toEqual([
			"pydantic-core",
			"orjson",
			"regex",
			"pyyaml",
			"rpds-py",
			"msgspec",
			"lxml",
			"cryptography",
			"numpy",
		]);
		for (const candidate of CANDIDATES) {
			expect(lock.packages).toContain(candidate);
			for (const name of Object.keys(resolveWheels(pyodideLock, [candidate]))) {
				expect(Object.keys(lock.wheels), `${candidate} needs ${name}`).toContain(name);
			}
		}
	});

	it("are C-extension wheels for the runtime's ABI", () => {
		for (const candidate of CANDIDATES) {
			const wheel = lock.wheels[candidate];
			expect(wheel?.file_name, candidate).toMatch(/-pyemscripten_2026_0_wasm32\.whl$/);
		}
	});

	it("keep ALLOWLIST a subset in backlog order, with pydantic-core on it", () => {
		expect(ALLOWLIST).toContain(REQUIRED);
		expect(CANDIDATES.filter((candidate) => ALLOWLIST.includes(candidate))).toEqual(ALLOWLIST);
	});

	it("name only candidates off the allowlist as fixed by ladder step 1's shim", () => {
		expect(LADDER_SHIM_FIXES).toEqual({ win32: ["cryptography"] });
		for (const names of Object.values(LADDER_SHIM_FIXES)) {
			for (const name of names) {
				expect(CANDIDATES).toContain(name);
				expect(ALLOWLIST).not.toContain(name);
			}
		}
	});
});

describe("the probes' argv", () => {
	it("is the production python argv, the codegen flag and the wasm cap included", () => {
		const argv = productionArgv();
		expect(argv[0]).toBe("--permission");
		expect(argv).toEqual(
			expect.arrayContaining([
				"--allow-fs-read=<pluginDir>",
				"--allow-fs-read=<runtimeDir>",
				"--disallow-code-generation-from-strings",
				"--wasm-max-mem-pages=8192",
			]),
		);
		expect(argv.filter((arg) => /^--allow-(?!fs-read=)/.test(arg))).toEqual([]);
	});
});

const run = (
	candidate: string,
	node: string,
	runs: boolean,
	argv: Argv = "production",
	exit: { exitCode: number | null; exitReason: string | null } = { exitCode: 0, exitReason: null },
) => ({ candidate, node, runs, argv, cleanExit: exit.exitCode === 0, ...exit }) as CandidateRun;

describe("allowlistOf", () => {
	it("keeps a candidate only when it ran under the production argv on every Node", () => {
		const runs = [
			run("pydantic-core", "26.5.1", true),
			run("pydantic-core", "26.12.0", true),
			run("orjson", "26.5.1", true),
			run("orjson", "26.12.0", false),
			run("regex", "26.5.1", true, "without-codegen-flag"),
			run("cryptography", "26.5.1", true, "with-ladder-shim"),
		];
		expect(allowlistOf(runs)).toEqual(["pydantic-core"]);
		expect(allowlistOf([])).toEqual([]);
	});
});

describe("plugins that don't exit cleanly when stopped", () => {
	it("know only Node 26.5.1's libuv assertion on Windows", () => {
		const reason = reasonOf([LIBUV_ABORT]);
		expect(knownExitAbort("win32", "26.5.1", reason)).toBe(true);
		expect(knownExitAbort("win32", "26.12.0", reason)).toBe(false);
		expect(knownExitAbort("linux", "26.5.1", reason)).toBe(false);
		expect(knownExitAbort("win32", "26.5.1", "exit 3221226505")).toBe(false);
		expect(knownExitAbort("win32", "26.5.1", null)).toBe(false);
	});

	it("are listed from the passes, each marked known or not", () => {
		const abort = { exitCode: 3221226505, exitReason: reasonOf([LIBUV_ABORT]) };
		const runs = [
			run("pyyaml", "26.5.1", true, "production", abort),
			run("lxml", "26.12.0", true, "production", abort),
			run("orjson", "26.5.1", true),
			run("cryptography", "26.5.1", false, "production", { exitCode: 1, exitReason: "exit 1" }),
		];
		expect(uncleanExitsOf(runs, "win32")).toEqual([
			{ candidate: "pyyaml", node: "26.5.1", ...abort, known: true },
			{ candidate: "lxml", node: "26.12.0", ...abort, known: false },
		]);
		expect(uncleanExitsOf(runs, "linux").map((exit) => exit.known)).toEqual([false, false]);
	});

	it("say why from stderr, else from the signal or the code", () => {
		expect(exitReasonOf(0, null, LIBUV_ABORT)).toBe(null);
		expect(exitReasonOf(3221226505, null, `\n${LIBUV_ABORT}\n`)).toBe(
			"Assertion failed: !(handle->flags UV_HANDLE_CLOSING), file src<path>, line 94",
		);
		expect(exitReasonOf(null, "SIGKILL", "")).toBe("signal SIGKILL");
		expect(exitReasonOf(1, null, "nothing to see")).toBe("exit 1");
	});
});

describe("failure reasons", () => {
	it("names a Rust panic and the cause of a Pyodide fatal error", () => {
		const output = [
			"thread '<unnamed>' (1) panicked at /rustc/8bab26f4/library/core/src/panicking.rs:225:5:\npanic in a function that cannot unwind",
			"Pyodide has suffered a fatal error. Please report this to the Pyodide maintainers.",
			"The cause of the fatal error was:\nRuntimeError: unreachable\n    at wasm://wasm/0249d42a:wasm-function[13197]:0x55aabb",
		];
		expect(reasonOf(output)).toBe(
			"Rust panic: panic in a function that cannot unwind; fatal error: RuntimeError: unreachable",
		);
	});

	it("keeps the shim's boot failure and drops paths, quoted values and long numbers", () => {
		const stderr =
			"shim: boot failed at packages: ERR_LOADER: Unable to load C:\\Users\\someone\\x\\wheels\\a.whl from '/tmp/x' (code 123456789)";
		expect(reasonOf([stderr])).toBe(
			"boot failed at packages: ERR_LOADER: Unable to load <path> from <value> (code <n>)",
		);
		expect(contentFree("ImportError: /lib/python3.14/site-packages/x.so")).toBe(
			"ImportError: <path>",
		);
		expect(reasonOf(["all fine"])).toBe(null);
	});

	it("leaves nothing of a folder name with a space", () => {
		const windows =
			"shim: boot failed at packages: ERR_LOADER: Unable to load C:\\Users\\Jane Doe\\AppData\\Local\\Temp\\dy-s11c-abc\\allow-orjson\\wheels\\orjson.whl";
		expect(reasonOf([windows])).toBe("boot failed at packages: ERR_LOADER: Unable to load <path>");
		const posix = "ImportError: /Users/Jane Doe/Library/x/_core.so: cannot open shared object file";
		expect(contentFree(posix)).toBe("ImportError: <path>: cannot open shared object file");
		expect(contentFree("50 / 100 at /a b")).toBe("50 100 at <path> b");
	});

	it("drops this machine's home and temp folders whole, with either separator", () => {
		for (const root of [os.homedir(), os.tmpdir()]) {
			const inside = path.join(root, "My Files", "x", "a.whl");
			const text = `Unable to load ${inside} and ${inside.replaceAll("\\", "/")}`;
			const free = contentFree(text);
			expect(free).toBe("Unable to load <path> and <path>");
			expect(() => assertContentFree({ free })).not.toThrow();
		}
		expect(contentFree("at /srv/a b/c.so", ["/srv/a b"])).toBe("at <path>");
	});
});
