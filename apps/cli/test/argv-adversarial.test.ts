import { runInNewContext } from "node:vm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ARGV_LIMITS, snapshotArgv } from "../src/argv.ts";
import { main } from "../src/main.ts";
import { isCliExitCode } from "../src/payload-contract.ts";
import { CliRefusal } from "../src/refusal.ts";

const REFUSAL = "Command refused.";
const CANARY = "DYTEST-ARGV-CANARY";

function refused(raw: unknown): void {
	let error: unknown;
	try {
		snapshotArgv(raw);
	} catch (caught) {
		error = caught;
	}
	expect(error).toBeInstanceOf(CliRefusal);
	expect((error as Error).message).toBe(REFUSAL);
}

describe("literal argument snapshots", () => {
	it("preserves every literal value and its position without shell or Unicode interpretation", () => {
		const input = [
			"help",
			"",
			" --help ",
			"$(literal)",
			`\${literal}`,
			"*.ts",
			"a;b|c&d",
			'"quoted"',
			"line\nbreak",
			"tab\tvalue",
			"../relative/../value",
			"e\u0301",
			"\u00e9",
			"\u{1f600}",
		];
		const result = snapshotArgv(input);
		expect(result).toEqual(input);
		expect(result).not.toBe(input);
		expect(result[11]).not.toBe(result[12]);
	});

	it("owns a frozen independent snapshot after caller replacement, truncation and append", () => {
		const input = ["help", CANARY];
		const result = snapshotArgv(input);
		input[0] = "mcp";
		input.length = 0;
		input.push("DYTEST-LATER");
		expect(result).toEqual(["help", CANARY]);
		expect(Reflect.set(result, "0", "changed")).toBe(false);
		expect(Reflect.deleteProperty(result, "1")).toBe(false);
		expect(result).toEqual(["help", CANARY]);
	});

	it("accepts frozen and null-prototype native arrays without consulting inherited methods", () => {
		const input = ["help", "literal"];
		Object.setPrototypeOf(input, null);
		Object.freeze(input);
		expect(snapshotArgv(input)).toEqual(["help", "literal"]);
	});

	it("accepts a genuine cross-realm array and copies into the local realm", () => {
		const input: unknown = runInNewContext('["help", "DYTEST-CROSS-REALM"]');
		const result = snapshotArgv(input);
		expect(result).toEqual(["help", "DYTEST-CROSS-REALM"]);
		expect(Object.getPrototypeOf(result)).toBe(Array.prototype);
	});

	it("never consults custom iteration, coercion or non-index getters", () => {
		let hooks = 0;
		const hook = (): never => {
			hooks++;
			throw new Error(CANARY);
		};
		const input = ["help", "literal"];
		Object.defineProperties(input, {
			[Symbol.iterator]: { get: hook },
			[Symbol.toPrimitive]: { value: hook },
			toString: { value: hook },
			extra: { get: hook },
		});
		expect(snapshotArgv(input)).toEqual(["help", "literal"]);
		expect(hooks).toBe(0);
	});

	it.each([
		["ASCII", "a".repeat(65_536)],
		["two-byte UTF-8", "\u00e9".repeat(32_768)],
		["four-byte UTF-8", "\u{1f600}".repeat(16_384)],
	])("accepts the inclusive per-argument byte limit for %s", (_label, argument) => {
		expect(snapshotArgv([argument])).toEqual([argument]);
	});

	it.each([
		["ASCII", "a".repeat(65_537)],
		["two-byte UTF-8", `${"\u00e9".repeat(32_768)}a`],
		["four-byte UTF-8", `${"\u{1f600}".repeat(16_384)}a`],
	])("refuses one byte above the per-argument limit for %s", (_label, argument) => {
		refused([argument]);
	});

	it("accepts exactly 256 arguments and refuses 257 independently of byte limits", () => {
		const input = Array.from({ length: 256 }, () => "");
		expect(snapshotArgv(input)).toEqual(input);
		refused([...input, ""]);
	});

	it("bounds total UTF-8 bytes independently of each argument and code-unit count", () => {
		const argument = "\u{1f600}".repeat(16_384);
		const input = [argument, argument, argument, argument];
		expect(snapshotArgv(input)).toEqual(input);
		refused([...input, "a"]);
	});

	it("keeps the documented bounds immutable to an importing caller", () => {
		expect(ARGV_LIMITS).toEqual({ count: 256, argumentBytes: 65_536, totalBytes: 262_144 });
		expect(Reflect.set(ARGV_LIMITS, "count", 257)).toBe(false);
		refused(Array.from({ length: 257 }, () => ""));
	});
});

describe("inert argument admission", () => {
	it.each([
		["undefined", undefined],
		["null", null],
		["string", "help"],
		["boxed string", new String("help")],
		["record", { 0: "help", length: 1 }],
		["typed bytes", new Uint8Array([1])],
		["boolean member", [false]],
		["number member", [7]],
		["bigint member", [7n]],
		["symbol member", [Symbol("DYTEST")]],
		["boxed member", [new String("help")]],
		["undefined member", [undefined]],
		["null member", [null]],
		["NUL", [`help\0${CANARY}`]],
		["lone high surrogate", ["\ud800"]],
		["lone low surrogate", ["\udfff"]],
	])("refuses %s with the exact content-free failure", (_label, input) => {
		refused(input);
	});

	it.each([0, 1, 2])("refuses a hole at index %s", (hole) => {
		const input = ["help", "literal", "tail"];
		Reflect.deleteProperty(input, String(hole));
		refused(input);
	});

	it("refuses an inherited array index without reading its getter", () => {
		let hooks = 0;
		const input: string[] = new Array(1);
		Object.setPrototypeOf(
			input,
			Object.create(Array.prototype, {
				0: {
					get() {
						hooks++;
						throw new Error(CANARY);
					},
				},
			}),
		);
		refused(input);
		expect(hooks).toBe(0);
	});

	it("refuses an accessor index before invoking it", () => {
		let hooks = 0;
		const input = ["help", "literal"];
		Object.defineProperty(input, "1", {
			get() {
				hooks++;
				throw new Error(CANARY);
			},
		});
		refused(input);
		expect(hooks).toBe(0);
	});

	it("does not coerce a caller-owned array member", () => {
		let hooks = 0;
		const member = {
			[Symbol.toPrimitive]() {
				hooks++;
				throw new Error(CANARY);
			},
		};
		refused([member]);
		expect(hooks).toBe(0);
	});

	it("refuses a proxy before any caller reflection trap", () => {
		let hooks = 0;
		const hook = (): never => {
			hooks++;
			throw new Error(CANARY);
		};
		refused(
			new Proxy(["help"], {
				get: hook,
				getOwnPropertyDescriptor: hook,
				getPrototypeOf: hook,
				has: hook,
				ownKeys: hook,
			}),
		);
		expect(hooks).toBe(0);
	});

	it("refuses a revoked proxy with the same fixed failure", () => {
		const { proxy, revoke } = Proxy.revocable(["help"], {});
		revoke();
		refused(proxy);
	});
});

describe("main argument ownership and output", () => {
	let stdout: string[];
	let stderr: string[];
	beforeEach(() => {
		stdout = [];
		stderr = [];
		vi.spyOn(process.stdout, "write").mockImplementation((chunk) => {
			stdout.push(String(chunk));
			return true;
		});
		vi.spyOn(process.stderr, "write").mockImplementation((chunk) => {
			stderr.push(String(chunk));
			return true;
		});
	});
	afterEach(() => vi.restoreAllMocks());

	it.each([[], ["help"], ["--help"], ["-h"]])(
		"returns help without stdout for %j",
		async (...input) => {
			const before = process.argv.slice();
			expect(await main(input)).toBe(0);
			expect(stdout).toEqual([]);
			expect(stderr.join("")).toContain("Usage: draftyak <command>\nCommands:\n");
			expect(stderr.join("")).toContain("help\n");
			expect(process.argv).toEqual(before);
		},
	);

	it("captures before its first await rather than retaining mutable caller argv", async () => {
		const input = ["help"];
		const outcome = main(input);
		input[0] = CANARY;
		input.push("DYTEST-AFTER-CALL");
		expect(await outcome).toBe(0);
		expect(stdout).toEqual([]);
		expect(stderr.join("")).toContain("Usage: draftyak <command>");
		expect(stderr.join("")).not.toContain(CANARY);
		expect(stderr.join("")).not.toContain("DYTEST-AFTER-CALL");
	});

	it.each([CANARY, "mcp", "help;DYTEST", "../../help", " help "])(
		"refuses unknown literal command %s without echoing any argument",
		async (command) => {
			expect(await main([command, CANARY, "--token=DYTEST-NONCREDENTIAL"])).toBe(2);
			expect(stdout).toEqual([]);
			expect(stderr).toEqual([`${REFUSAL}\n`]);
		},
	);

	it("maps malformed argv to a fixed bounded exit without caller hooks or echo", async () => {
		let hooks = 0;
		const input = ["help"];
		Object.defineProperty(input, "0", {
			get() {
				hooks++;
				throw new Error(CANARY);
			},
		});
		expect(await main(input)).toBe(1);
		expect(hooks).toBe(0);
		expect(stdout).toEqual([]);
		expect(stderr).toEqual([`${REFUSAL}\n`]);
	});
});

describe("primitive CLI exit admission", () => {
	it.each([0, -0, 7, 255])("accepts integer exit %s", (value) => {
		expect(isCliExitCode(value)).toBe(true);
	});
	it.each([undefined, null, false, "0", "7", 0n, -1, 256, 0.5, NaN, Infinity, -Infinity])(
		"refuses non-exit value %# without coercion",
		(value) => {
			expect(isCliExitCode(value)).toBe(false);
		},
	);
	it("never consults an exit-like object's conversion hooks", () => {
		let hooks = 0;
		const value = {
			[Symbol.toPrimitive]() {
				hooks++;
				throw new Error(CANARY);
			},
		};
		expect(isCliExitCode(value)).toBe(false);
		expect(hooks).toBe(0);
	});
});
