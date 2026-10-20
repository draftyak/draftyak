import assert from "node:assert/strict";
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import path from "node:path";

const [moduleUrl, mode] = process.argv.slice(2);
assert(["before", "after", "preopen"].includes(mode));
const { defineExtensionModule } = await import(moduleUrl);
const parent = path.resolve(import.meta.dirname, "../../.cache");
fs.mkdirSync(parent, { recursive: true });
const scratch = fs.mkdtempSync(path.join(parent, "module-close-"));
const identity = fs.lstatSync(scratch, { bigint: true });
const inner = path.join(scratch, "inner"), outer = path.join(scratch, "outer");
for (const folder of [inner, outer]) {
	fs.mkdirSync(folder);
	fs.writeFileSync(path.join(folder, "0001_fixture.sql"), "-- synthetic fixture");
}
const native = { open: fs.opendirSync, lstat: fs.lstatSync, close: fs.Dir.prototype.closeSync, read: fs.Dir.prototype.readSync };
const owned = [];
let fault = false, triggered = false, faultCloses = 0, opensAfterFault = 0, original;
const descriptor = (migrations) => ({ id: "close-fixture", version: "1.0.0", ...(migrations ? { migrations } : {}), async register() {} });
const refusal = { message: "Extension module definition refused" };
try {
	// Successful directory validation still returns its ordinary frozen descriptor.
	assert(Object.isFrozen(defineExtensionModule(descriptor(inner))));
	fs.opendirSync = (...args) => {
		if (fault) opensAfterFault++;
		const directory = Reflect.apply(native.open, fs, args);
		const record = { directory, closed: false };
		owned.push(record);
		directory.closeSync = () => {
			if (directory === original && !fault) {
				faultCloses++;
				fault = true;
				if (mode === "after") { Reflect.apply(native.close, directory, []); record.closed = true; }
				throw Error("PRIVATE_DIRECTORY_CLOSE_CANARY");
			}
			Reflect.apply(native.close, directory, []);
			record.closed = true;
		};
		original ??= directory;
		return directory;
	};
	fs.lstatSync = (...args) => {
		if (mode === "preopen" && args[0] === outer && !triggered) {
			triggered = true;
			assert.throws(() => defineExtensionModule(descriptor(inner)), refusal);
		}
		return Reflect.apply(native.lstat, fs, args);
	};
	syncBuiltinESMExports();
	if (mode === "preopen") assert(Object.isFrozen(defineExtensionModule(descriptor(outer))));
	else assert.throws(() => defineExtensionModule(descriptor(inner)), refusal);
	assert.equal(owned.length, mode === "preopen" ? 2 : 1);
	if (mode === "after") assert.throws(() => Reflect.apply(native.read, original, []), { code: "ERR_DIR_CLOSED" });
	else assert.equal(Reflect.apply(native.read, original, []), null);
	assert(Object.isFrozen(defineExtensionModule(descriptor(inner))));
	assert(Object.isFrozen(defineExtensionModule(descriptor(outer))));
	// Each operation owns its directory; a failed close creates no process-global state.
	assert(Object.isFrozen(defineExtensionModule(descriptor())));
	let reads = 0;
	const invalid = { ...descriptor(), get migrations() { reads++; throw Error("PRIVATE_GETTER_CANARY"); } };
	assert.throws(() => defineExtensionModule(invalid), refusal);
	assert.equal(reads, 0);
	assert.equal(faultCloses, 1);
	assert.equal(opensAfterFault, mode === "preopen" ? 3 : 2);
} finally {
	fs.opendirSync = native.open; fs.lstatSync = native.lstat; syncBuiltinESMExports();
	// Only this fixture knows which injected call skipped native close. Close exact owned objects.
	for (const record of owned) if (!record.closed) {
		Reflect.apply(native.close, record.directory, []);
		record.closed = true;
	}
	const current = fs.lstatSync(scratch, { bigint: true });
	assert.equal(path.dirname(scratch), parent);
	assert(path.basename(scratch).startsWith("module-close-"));
	assert(current.isDirectory() && !current.isSymbolicLink());
	assert.equal(current.dev, identity.dev); assert.equal(current.ino, identity.ino);
	assert.equal(fs.realpathSync(scratch), path.join(fs.realpathSync(parent), path.basename(scratch)));
	fs.rmSync(scratch, { recursive: true, force: true });
}
console.log(JSON.stringify({ refused: true, opensAfterFault, faultCloses }));
