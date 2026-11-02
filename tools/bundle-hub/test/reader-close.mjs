import assert from "node:assert/strict";
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import path from "node:path";
import { read } from "../../release-guard/src/integrity.ts";
import { regularBytes } from "../src/inventory.ts";

const [mode] = process.argv.slice(2);
assert.equal(process.argv.length, 3);
assert(["before", "after"].includes(mode));
const parent = path.resolve(import.meta.dirname, "../.cache");
fs.mkdirSync(parent, { recursive: true });
const scratch = fs.mkdtempSync(path.join(parent, "reader-close-"));
const identity = fs.lstatSync(scratch, { bigint: true });
const file = path.join(scratch, "input.bin"),
	outer = path.join(scratch, "outer.bin");
fs.writeFileSync(file, "original");
fs.writeFileSync(outer, "outer");
const native = { open: fs.openSync, close: fs.closeSync };
let tracked,
	sentinel,
	fault = false,
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
	syncBuiltinESMExports();
	assert.throws(
		() => regularBytes(file),
		(error) => error?.name === "BoundedFileError" && error.code === "ownership",
	);
	if (mode === "before") {
		// Only the fixture knows that its injected close had no effect. Release its
		// own handle before another exclusive Windows read, and reserve the old fd.
		native.close(tracked);
		sentinel = native.open(outer, "r");
		assert.equal(sentinel, tracked);
	}
	assert.deepEqual(regularBytes(file), Buffer.from("original"));
	assert.deepEqual(read(scratch, "input.bin"), Buffer.from("original"));
	assert.equal(closes, 1);
	assert.equal(opensAfterFault, 2);
	assert(fs.fstatSync(sentinel).isFile());
	output = { refused: true, opensAfterFault, closes };
} finally {
	Object.assign(fs, { openSync: native.open, closeSync: native.close });
	syncBuiltinESMExports();
	// The fixture owns its injected close effect; the reader never retries that descriptor.
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
