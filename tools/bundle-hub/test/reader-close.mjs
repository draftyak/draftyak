import assert from "node:assert/strict";
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import path from "node:path";

const [inventoryUrl, integrityUrl, mode] = process.argv.slice(2);
assert(["before", "after", "preopen"].includes(mode));
const { regularBytes } = await import(inventoryUrl);
const { read } = await import(integrityUrl);
const parent = path.resolve(import.meta.dirname, "../.cache");
fs.mkdirSync(parent, { recursive: true });
const scratch = fs.mkdtempSync(path.join(parent, "reader-close-"));
const identity = fs.lstatSync(scratch, { bigint: true });
const file = path.join(scratch, "input.bin"),
	outer = path.join(scratch, "outer.bin");
fs.writeFileSync(file, "original");
fs.writeFileSync(outer, "outer");
const native = { open: fs.openSync, close: fs.closeSync, lstat: fs.lstatSync };
let tracked,
	sentinel,
	fault = false,
	triggered = false,
	closes = 0,
	opensAfterFault = 0;
let output;
try {
	fs.openSync = (...args) => {
		if (fault) opensAfterFault++;
		const fd = native.open(...args);
		if (args[0] === file && tracked === undefined) tracked = fd;
		return fd;
	};
	fs.closeSync = (fd) => {
		if (fd === tracked) {
			closes++;
			if (!fault) {
				fault = true;
				if (mode === "after") {
					native.close(fd);
					sentinel = native.open(outer, "r");
					assert.equal(sentinel, fd);
				}
				throw new Error("PRIVATE_CLOSE_CANARY");
			}
		}
		return native.close(fd);
	};
	fs.lstatSync = (...args) => {
		if (mode === "preopen" && args[0] === outer && !triggered) {
			triggered = true;
			assert.throws(() => regularBytes(file), /close is uncertain/);
		}
		return Reflect.apply(native.lstat, fs, args);
	};
	syncBuiltinESMExports();
	const capture = (fn) => {
		try {
			fn();
		} catch (error) {
			return error;
		}
		return undefined;
	};
	const first = capture(() => regularBytes(mode === "preopen" ? outer : file));
	const next = capture(() => regularBytes(file));
	const cross = capture(() => read(scratch, "input.bin"));
	for (const error of [first, next, cross])
		assert.match(error?.message ?? "", /close is uncertain/);
	assert.equal(closes, 1);
	assert.equal(opensAfterFault, 0);
	if (mode === "after") assert(fs.fstatSync(sentinel).isFile());
	output = { refused: true, opensAfterFault, closes };
} finally {
	Object.assign(fs, { openSync: native.open, closeSync: native.close, lstatSync: native.lstat });
	syncBuiltinESMExports();
	// The test owns the injected effect; production never retries an uncertain number.
	if (sentinel !== undefined) native.close(sentinel);
	else if (tracked !== undefined) native.close(tracked);
	const current = fs.lstatSync(scratch, { bigint: true });
	assert.equal(path.dirname(path.resolve(scratch)), path.resolve(parent));
	assert(path.basename(scratch).startsWith("reader-close-"));
	assert(current.isDirectory() && !current.isSymbolicLink());
	assert.equal(current.dev, identity.dev);
	assert.equal(current.ino, identity.ino);
	assert.equal(
		fs.realpathSync(scratch),
		path.join(fs.realpathSync(parent), path.basename(scratch)),
	);
	fs.rmSync(scratch, { recursive: true, force: true });
}
console.log(JSON.stringify(output));
