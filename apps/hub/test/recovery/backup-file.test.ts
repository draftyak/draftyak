import { randomBytes } from "node:crypto";
import {
	chmodSync,
	existsSync,
	linkSync,
	lstatSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	realpathSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, it } from "vitest";
import {
	RecoveryCapsuleFileError,
	RecoveryCapsuleFileWrite,
	readRecoveryCapsuleFile,
} from "../../src/recovery/backup-file.ts";
import { RECOVERY_FILE, writeRecoveryFile } from "../../src/recovery/recovery-code.ts";

const temporaryRoot = realpathSync.native(os.tmpdir());
const roots: { folder: string; dev: number; ino: number }[] = [];
const writers: RecoveryCapsuleFileWrite[] = [];
const buffers: Buffer[] = [];
afterEach(async () => {
	for (const writer of writers.splice(0).reverse()) await writer.close();
	for (const bytes of buffers.splice(0)) bytes.fill(0);
	for (const root of roots.splice(0).reverse()) {
		const current = lstatSync(root.folder);
		expect(path.dirname(root.folder) === temporaryRoot).toBe(true);
		expect(path.basename(root.folder).startsWith("draftyak-backup-file-")).toBe(true);
		expect(current.dev === root.dev && current.ino === root.ino && !current.isSymbolicLink()).toBe(
			true,
		);
		rmSync(root.folder, { recursive: true, force: true });
	}
});
function folder(): string {
	const value = realpathSync.native(mkdtempSync(path.join(temporaryRoot, "draftyak-backup-file-")));
	const { dev, ino } = lstatSync(value);
	roots.push({ folder: value, dev, ino });
	return value;
}
function keep(bytes: Buffer): Buffer {
	buffers.push(bytes);
	return bytes;
}
function capsule(): Buffer {
	const source = folder(),
		master = randomBytes(32),
		code = randomBytes(20);
	try {
		writeRecoveryFile(source, master, code);
		return keep(readFileSync(path.join(source, RECOVERY_FILE)));
	} finally {
		master.fill(0);
		code.fill(0);
	}
}
function writer(directory: unknown, bytes: unknown): RecoveryCapsuleFileWrite {
	const value = new RecoveryCapsuleFileWrite(directory, bytes);
	writers.push(value);
	return value;
}
const filename = (directory: string): string => path.join(directory, "mk.recovery");

it("accepts an admitted owned 0755 folder without changing its mode", {
	tags: ["requires:posix"],
}, async () => {
	const directory = folder(),
		bytes = capsule();
	chmodSync(directory, 0o755);
	const value = writer(directory, bytes);
	await value.write();
	value.preserve();
	expect(keep(readRecoveryCapsuleFile(directory)).equals(bytes)).toBe(true);
	expect(lstatSync(directory).mode & 0o777).toBe(0o755);
});

it.each([0o770, 0o777])(
	"refuses a folder writable by others (%s)",
	{ tags: ["requires:posix"] },
	async (mode) => {
		const directory = folder(),
			bytes = capsule();
		chmodSync(directory, mode);
		const value = writer(directory, bytes);
		await refused(() => value.write());
		expect(existsSync(filename(directory))).toBe(false);
		writeFileSync(filename(directory), bytes, { mode: 0o600 });
		await refused(() => readRecoveryCapsuleFile(directory));
		expect(readFileSync(filename(directory)).equals(bytes)).toBe(true);
	},
);

async function refused(operation: () => unknown): Promise<void> {
	let caught = false;
	try {
		await operation();
	} catch (error) {
		caught = true;
		expect(error instanceof RecoveryCapsuleFileError).toBe(true);
		if (!(error instanceof RecoveryCapsuleFileError)) return;
		expect(error.name === "RecoveryCapsuleFileError").toBe(true);
		expect(error.code === "RECOVERY_FILE_UNAVAILABLE").toBe(true);
		expect(error.message === "Recovery file unavailable").toBe(true);
		expect(Object.hasOwn(error, "cause")).toBe(false);
	}
	expect(caught).toBe(true);
}

it("writes one captured legacy capsule once and preserves independent code-free reads", async () => {
	const directory = folder(),
		bytes = capsule(),
		expected = keep(Buffer.from(bytes));
	const operation = writer(directory, bytes);
	expect(existsSync(filename(directory))).toBe(false);
	expect(bytes.equals(expected)).toBe(true);
	bytes.fill(0);
	const writing = operation.write();
	expect(operation.write() === writing).toBe(true);
	await writing;
	expect(operation.write() === writing).toBe(true);
	expect(bytes.every((byte) => byte === 0)).toBe(true);
	expect(readFileSync(filename(directory)).equals(expected)).toBe(true);
	const stat = lstatSync(filename(directory));
	expect(stat.isFile() && !stat.isSymbolicLink() && stat.nlink === 1).toBe(true);
	if (process.platform !== "win32") expect(stat.mode & 0o777).toBe(0o600);
	operation.preserve();
	operation.preserve();
	await operation.close();
	await operation.close();
	const first = keep(readRecoveryCapsuleFile(directory));
	const second = keep(readRecoveryCapsuleFile(directory));
	expect(first.length).toBe(94);
	expect(first !== second && first.equals(expected) && second.equals(expected)).toBe(true);
	first.fill(0);
	expect(second.equals(expected)).toBe(true);
	expect(readFileSync(filename(directory)).equals(expected)).toBe(true);
	await refused(() => operation.write());
	await refused(() => operation.preserve());
	expect(readFileSync(filename(directory)).equals(expected)).toBe(true);
});

it("removes only its unpreserved completed file and fences later work", async () => {
	const directory = folder(),
		operation = writer(directory, capsule());
	await refused(() => operation.preserve());
	await operation.write();
	expect(existsSync(filename(directory))).toBe(true);
	await operation.close();
	expect(readdirSync(directory).length).toBe(0);
	await operation.close();
	await refused(() => operation.write());
	await refused(() => readRecoveryCapsuleFile(directory));
	expect(readdirSync(directory).length).toBe(0);
});

it("closes an unwritten owner without creating any file", async () => {
	const directory = folder(),
		operation = writer(directory, capsule());
	await operation.close();
	await refused(() => operation.write());
	await refused(() => operation.preserve());
	expect(readdirSync(directory).length).toBe(0);
});

it("never overwrites or deletes a preexisting foreign file", async () => {
	const directory = folder(),
		foreign = capsule();
	writeFileSync(filename(directory), foreign, { mode: 0o600 });
	const operation = writer(directory, capsule()),
		writing = operation.write();
	expect(operation.write() === writing).toBe(true);
	await refused(() => writing);
	expect(operation.write() === writing).toBe(true);
	expect(readFileSync(filename(directory)).equals(foreign)).toBe(true);
	await operation.close();
	expect(readFileSync(filename(directory)).equals(foreign)).toBe(true);
});

it("stores exact-size opaque DATA without claiming header validity or authentication", async () => {
	const directory = folder(),
		bytes = keep(Buffer.alloc(94, 7));
	const padded = new Uint8Array(100);
	padded.set(bytes, 3);
	const operation = writer(directory, padded.subarray(3, 97));
	await operation.write();
	operation.preserve();
	await operation.close();
	expect(keep(readRecoveryCapsuleFile(directory)).equals(bytes)).toBe(true);
});

it.each([0, 93, 95, 188])(
	"refuses a write input of %i bytes before file creation",
	async (length) => {
		const directory = folder();
		await refused(() => writer(directory, Buffer.alloc(length)));
		expect(readdirSync(directory).length).toBe(0);
	},
);

it("refuses non-byte, shared, detached and proxied write input without caller traps", async () => {
	const directory = folder(),
		bytes = capsule();
	const shared = new Uint8Array(new SharedArrayBuffer(94));
	shared.set(bytes);
	const detached = new Uint8Array(bytes);
	structuredClone(detached.buffer, { transfer: [detached.buffer] });
	for (const input of [
		null,
		[],
		{},
		"bytes",
		new DataView(new ArrayBuffer(94)),
		new Uint16Array(47),
		shared,
		detached,
	])
		await refused(() => writer(directory, input));
	let traps = 0;
	const trap = () => {
		traps++;
		throw new Error("Unexpected caller trap");
	};
	await refused(() => writer(directory, new Proxy(bytes, { get: trap, getPrototypeOf: trap })));
	expect(traps).toBe(0);
	expect(readdirSync(directory).length).toBe(0);
});

it("does not coerce caller folders or create missing or noncanonical directories", async () => {
	const directory = folder(),
		bytes = capsule();
	let traps = 0;
	const proxy = new Proxy(
		{},
		{
			get() {
				traps++;
				throw new Error("Unexpected caller trap");
			},
		},
	);
	for (const input of [undefined, null, {}, proxy]) {
		await refused(() => writer(input, bytes));
		await refused(() => readRecoveryCapsuleFile(input));
	}
	expect(traps).toBe(0);
	const missing = path.join(directory, "missing");
	const missingWriter = writer(missing, bytes);
	expect(existsSync(missing)).toBe(false);
	await refused(() => missingWriter.write());
	await refused(() => readRecoveryCapsuleFile(missing));
	await refused(() => writer(`${directory}${path.sep}.`, bytes).write());
	expect(readdirSync(directory).length).toBe(0);
});

it.each([0, 93, 95, 188])("refuses a stored DATA file of %i bytes", async (length) => {
	const directory = folder();
	writeFileSync(filename(directory), Buffer.alloc(length), { mode: 0o600 });
	await refused(() => readRecoveryCapsuleFile(directory));
	expect(lstatSync(filename(directory)).size).toBe(length);
});

it("refuses noncanonical reads, directories and shared hardlinked files without deleting them", async () => {
	const directory = folder(),
		bytes = capsule();
	const operation = writer(directory, bytes);
	await operation.write();
	operation.preserve();
	await operation.close();
	await refused(() => readRecoveryCapsuleFile(`${directory}${path.sep}.`));
	const other = folder();
	mkdirSync(filename(other));
	await refused(() => readRecoveryCapsuleFile(other));
	expect(lstatSync(filename(other)).isDirectory()).toBe(true);
	const linked = folder(),
		target = path.join(linked, "foreign-data");
	writeFileSync(target, bytes, { mode: 0o600 });
	linkSync(target, filename(linked));
	expect(lstatSync(filename(linked)).nlink).toBe(2);
	await refused(() => readRecoveryCapsuleFile(linked));
	expect(readFileSync(target).equals(bytes)).toBe(true);
	expect(readFileSync(filename(linked)).equals(bytes)).toBe(true);
});
