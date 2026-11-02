import { spawnSync } from "node:child_process";
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import path from "node:path";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { read } from "../../release-guard/src/integrity.ts";
import { regularBytes } from "../src/inventory.ts";

const parent = path.resolve(import.meta.dirname, "../.cache");
fs.mkdirSync(parent, { recursive: true });
const scratch = fs.mkdtempSync(path.join(parent, "reader-test-"));
const identity = fs.lstatSync(scratch, { bigint: true });
const native = {
	open: fs.openSync,
	fstat: fs.fstatSync,
	read: fs.readSync,
	readFile: fs.readFileSync,
};
function input(bytes: string | Buffer = "ab"): string {
	const dir = fs.mkdtempSync(path.join(scratch, "case-"));
	const file = path.join(dir, "input.bin");
	fs.writeFileSync(file, bytes);
	return file;
}
afterEach(() => {
	vi.restoreAllMocks();
	syncBuiltinESMExports();
});
afterAll(() => {
	const current = fs.lstatSync(scratch, { bigint: true });
	if (
		path.dirname(path.resolve(scratch)) !== path.resolve(parent) ||
		!path.basename(scratch).startsWith("reader-test-") ||
		current.isSymbolicLink() ||
		!current.isDirectory() ||
		current.dev !== identity.dev ||
		current.ino !== identity.ino ||
		fs.realpathSync(scratch) !== path.join(fs.realpathSync(parent), path.basename(scratch))
	)
		throw new Error("Unsafe reader fixture cleanup");
	fs.rmSync(scratch, { recursive: true, force: true });
});

describe("one bounded held file reader", () => {
	it("preserves empty, binary and UTF-8 bytes at the exact selected cap", () => {
		for (const bytes of [
			Buffer.alloc(0),
			Buffer.from([0, 255, 1]),
			Buffer.from("caf\u00e9 \u96ea"),
		])
			expect(regularBytes(input(bytes), Math.max(1, bytes.length))).toEqual(bytes);
	});
	it("rejects the adjacent byte before opening it", () => {
		const file = input("123456789");
		const opened = vi.spyOn(fs, "openSync");
		syncBuiltinESMExports();
		expect(() => regularBytes(file, 8)).toThrow("Bounded file operation refused.");
		expect(opened).not.toHaveBeenCalled();
	});
	it("refuses malformed Unicode before looking up a bundle input", () => {
		const file = input();
		const lookedUp = vi.spyOn(fs, "lstatSync");
		syncBuiltinESMExports();
		expect(() => regularBytes(`${file}\ud800`)).toThrow("Bounded file operation refused.");
		expect(lookedUp).not.toHaveBeenCalled();
	});
	it("refuses same-inode growth between the initial stat and held open before reading", () => {
		const file = input();
		let changed = false;
		vi.spyOn(fs, "openSync").mockImplementation((...args) => {
			if (args[0] === file && !changed) {
				changed = true;
				fs.appendFileSync(file, "0123456789");
			}
			return native.open(...args);
		});
		const readCalls = vi.spyOn(fs, "readSync");
		syncBuiltinESMExports();
		expect(() => regularBytes(file, 4)).toThrow("Bounded file operation refused.");
		expect(changed).toBe(true);
		expect(readCalls).not.toHaveBeenCalled();
	});
	it("reads at most the captured size plus one byte when growth occurs after held stat", () => {
		const file = input();
		let tracked = -1,
			changed = false,
			consumed = 0;
		vi.spyOn(fs, "openSync").mockImplementation((...args) => {
			const fd = native.open(...args);
			if (args[0] === file && tracked < 0) tracked = fd;
			return fd;
		});
		vi.spyOn(fs, "fstatSync").mockImplementation((...args: unknown[]) => {
			const result = Reflect.apply(native.fstat, fs, args);
			if (args[0] === tracked && !changed) {
				changed = true;
				fs.appendFileSync(file, "0123456789abcdef");
			}
			return result;
		});
		vi.spyOn(fs, "readSync").mockImplementation((...args: unknown[]) => {
			const count = Reflect.apply(native.read, fs, args) as number;
			if (args[0] === tracked) consumed += count;
			return count;
		});
		vi.spyOn(fs, "readFileSync").mockImplementation((...args: unknown[]) => {
			const prior = consumed;
			const bytes = Reflect.apply(native.readFile, fs, args);
			if (args[0] === tracked && consumed === prior) consumed += bytes.length;
			return bytes;
		});
		syncBuiltinESMExports();
		expect(() => regularBytes(file, 4)).toThrow("Bounded file operation refused.");
		expect(changed).toBe(true);
		expect(consumed).toBeLessThanOrEqual(3);
	});
	it("checks held identity instead of reading a replacement pathname in release guard", () => {
		const file = input("ORIGINAL");
		const replacement = path.join(path.dirname(file), "replacement.bin");
		fs.writeFileSync(replacement, "CANARY_REPLACEMENT");
		let swapped = false;
		const swap = (target: unknown) => {
			if (target === file && !swapped) {
				swapped = true;
				fs.renameSync(replacement, file);
			}
		};
		vi.spyOn(fs, "openSync").mockImplementation((...args) => {
			swap(args[0]);
			return native.open(...args);
		});
		vi.spyOn(fs, "readFileSync").mockImplementation((...args: unknown[]) => {
			swap(args[0]);
			return Reflect.apply(native.readFile, fs, args);
		});
		syncBuiltinESMExports();
		expect(() => read(path.dirname(file), path.basename(file))).toThrow(
			"Bounded file operation refused.",
		);
		expect(swapped).toBe(true);
	});
	it("refuses pathname replacement attempted after a read", () => {
		const file = input("ORIGINAL"),
			replacement = path.join(path.dirname(file), "replacement.bin"),
			retained = path.join(path.dirname(file), "retained.bin");
		fs.writeFileSync(replacement, "CHANGED!");
		let tracked = -1,
			swapped = false,
			renamed = false;
		const swap = (fd: unknown) => {
			if (fd === tracked && !swapped) {
				swapped = true;
				fs.linkSync(file, retained);
				fs.renameSync(replacement, file);
				renamed = true;
			}
		};
		vi.spyOn(fs, "openSync").mockImplementation((...args) => {
			const fd = native.open(...args);
			if (args[0] === file) tracked = fd;
			return fd;
		});
		vi.spyOn(fs, "readSync").mockImplementation((...args: unknown[]) => {
			const count = Reflect.apply(native.read, fs, args) as number;
			if (count > 0) swap(args[0]);
			return count;
		});
		vi.spyOn(fs, "readFileSync").mockImplementation((...args: unknown[]) => {
			const bytes = Reflect.apply(native.readFile, fs, args);
			swap(args[0]);
			return bytes;
		});
		syncBuiltinESMExports();
		// Windows may deny replacing this held native handle before the final check.
		expect(() => regularBytes(file)).toThrow("Bounded file operation refused.");
		expect(swapped).toBe(true);
		expect(fs.lstatSync(retained).nlink).toBe(renamed ? 1 : 2);
	});
	it("refuses a mode change after reading without publishing bytes", () => {
		const file = input("ORIGINAL");
		let tracked = -1,
			changed = false;
		const change = (fd: unknown) => {
			if (fd === tracked && !changed) {
				changed = true;
				fs.chmodSync(file, 0o400);
			}
		};
		vi.spyOn(fs, "openSync").mockImplementation((...args) => {
			const fd = native.open(...args);
			if (args[0] === file) tracked = fd;
			return fd;
		});
		vi.spyOn(fs, "readSync").mockImplementation((...args: unknown[]) => {
			const count = Reflect.apply(native.read, fs, args) as number;
			if (count > 0) change(args[0]);
			return count;
		});
		vi.spyOn(fs, "readFileSync").mockImplementation((...args: unknown[]) => {
			const bytes = Reflect.apply(native.readFile, fs, args);
			change(args[0]);
			return bytes;
		});
		syncBuiltinESMExports();
		try {
			expect(() => regularBytes(file)).toThrow("Bounded file operation refused.");
		} finally {
			fs.chmodSync(file, 0o600);
		}
		expect(changed).toBe(true);
		expect(fs.lstatSync(file).nlink).toBe(1);
	});
	it("refuses transient hard-link changes after reading even when the final link count is one", () => {
		const file = input("ORIGINAL"),
			alias = path.join(path.dirname(file), "transient.bin");
		let tracked = -1,
			changed = false;
		const change = (fd: unknown) => {
			if (fd === tracked && !changed) {
				changed = true;
				fs.linkSync(file, alias);
				fs.unlinkSync(alias);
			}
		};
		vi.spyOn(fs, "openSync").mockImplementation((...args) => {
			const fd = native.open(...args);
			if (args[0] === file) tracked = fd;
			return fd;
		});
		vi.spyOn(fs, "readSync").mockImplementation((...args: unknown[]) => {
			const count = Reflect.apply(native.read, fs, args) as number;
			if (count > 0) change(args[0]);
			return count;
		});
		vi.spyOn(fs, "readFileSync").mockImplementation((...args: unknown[]) => {
			const bytes = Reflect.apply(native.readFile, fs, args);
			change(args[0]);
			return bytes;
		});
		syncBuiltinESMExports();
		expect(() => regularBytes(file)).toThrow("Bounded file operation refused.");
		expect(changed).toBe(true);
		expect(fs.lstatSync(file).nlink).toBe(1);
	});
	it("keeps each read request within 64 KiB and preserves exact complete output", () => {
		const bytes = Buffer.alloc(65_539, 37);
		const file = input(bytes);
		const requested: number[] = [];
		vi.spyOn(fs, "readSync").mockImplementation((...args: unknown[]) => {
			if (typeof args[3] === "number") requested.push(args[3]);
			return Reflect.apply(native.read, fs, args) as number;
		});
		syncBuiltinESMExports();
		expect(regularBytes(file, bytes.length)).toEqual(bytes);
		// The held reader compares a second pass after the first complete read and EOF check.
		expect(requested).toEqual([65_536, 3, 1, 65_536, 3]);
	});
	for (const mode of ["before", "after"])
		it(`refuses uncertain close ${mode} per operation without retrying a numeric descriptor`, () => {
			const child = spawnSync(
				process.execPath,
				["--disable-sigusr1", path.resolve(import.meta.dirname, "reader-close.mjs"), mode],
				{ encoding: "utf8", windowsHide: true, timeout: 5_000, maxBuffer: 16_384 },
			);
			expect(child.status, child.stderr).toBe(0);
			expect(JSON.parse(child.stdout)).toEqual({ refused: true, opensAfterFault: 2, closes: 1 });
		});
});
