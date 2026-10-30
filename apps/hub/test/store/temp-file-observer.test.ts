import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import config from "../../vitest.config.ts";
import {
	databaseFileIdentities,
	descriptorNumber,
	MAX_DESCRIPTOR_ENTRIES,
	MAX_FILE_BYTES,
	MAX_SCAN_BYTES,
	MAX_SCAN_FILES,
	requireEmptyTempFileScan,
	SCAN_CHUNK_BYTES,
	scanDescriptorDirectory,
	scanNamedFiles,
	scanRegularDescriptors,
	tempFileDiagnostic,
	tempFileScanSupported,
} from "./temp-file-observer.ts";

let directory: string;
const descriptors: number[] = [];
const needle = { label: "body", value: Buffer.from("DYTEST-TEMP-CANARY") };
beforeEach(() => {
	directory = fs.mkdtempSync(path.join(os.tmpdir(), "draftyak-observer-test-"));
});
afterEach(() => {
	vi.restoreAllMocks();
	syncBuiltinESMExports();
	for (const fd of descriptors.splice(0)) fs.closeSync(fd);
	fs.rmSync(directory, { recursive: true, force: true });
	expect(fs.existsSync(directory)).toBe(false);
});

function file(name: string, content: string | Buffer = needle.value): { name: string; fd: number } {
	const filename = path.join(directory, name);
	fs.writeFileSync(filename, content);
	const fd = fs.openSync(filename, "r+");
	descriptors.push(fd);
	return { name: filename, fd };
}

it("admits each selected platform without turning missing native discovery into a routed skip", () => {
	// These are selector assertions, not execution of another operating system's observer.
	for (const platform of ["win32", "linux", "darwin"])
		expect(tempFileScanSupported(platform)).toBe(true);
	for (const platform of ["freebsd", "", "Darwin", "darwin\n"])
		expect(tempFileScanSupported(platform)).toBe(false);
	expect(() => scanDescriptorDirectory(path.join(directory, "missing"), [], [needle])).toThrow();
});

it("wires the actual package heavy tag to the selected native scanner admission", () => {
	const tags = config({ command: "serve", mode: "heavy" }).test?.tags;
	const tag = Array.isArray(tags)
		? tags.find((entry) => entry.name === "requires:temp-file-scan")
		: undefined;
	expect(tag).toBeDefined();
	expect(tag?.skip === true).toBe(!tempFileScanSupported(process.platform));
});

it("reads a live borrowed descriptor positionally across chunk boundaries and leaves it open", () => {
	const content = Buffer.alloc(SCAN_CHUNK_BYTES * 2 + 32, "x");
	content[7] = 0x5a;
	needle.value.copy(content, SCAN_CHUNK_BYTES - 3);
	const current = file("live", content);
	fs.readSync(current.fd, Buffer.alloc(7), 0, 7, null);
	expect(scanRegularDescriptors([current.fd], [], [needle])).toEqual({
		files: 1,
		bytes: content.length,
		hits: ["body"],
	});
	const next = Buffer.alloc(1);
	expect(fs.readSync(current.fd, next, 0, 1, null)).toBe(1);
	expect(next[0]).toBe(content[7]);
	expect(fs.fstatSync(current.fd).isFile()).toBe(true);
});

it("observes an unlinked live regular file and never filters by its link count or pathname", () => {
	const current = file("unlinked");
	fs.unlinkSync(current.name);
	expect(scanRegularDescriptors([current.fd], [], [needle])).toEqual({
		files: 1,
		bytes: needle.value.length,
		hits: ["body"],
	});
});

it("excludes only actual database/WAL/SHM identities and still detects a similarly named file", () => {
	const database = file("hub.db");
	const wal = file("hub.db-wal");
	const shm = file("hub.db-shm");
	const other = file("hub.db-wal-extra");
	const excluded = databaseFileIdentities(database.name);
	expect(excluded).toHaveLength(3);
	expect(
		scanRegularDescriptors([database.fd, wal.fd, shm.fd, other.fd], excluded, [needle]),
	).toEqual({
		files: 1,
		bytes: needle.value.length,
		hits: ["body"],
	});
	const sibling = fs.openSync(other.name, "r");
	descriptors.push(sibling);
	expect(scanRegularDescriptors([other.fd, sibling], [], [needle]).files).toBe(1);
});

it("does not exclude a matching inode on another device", () => {
	const current = file("foreign-device");
	const info = fs.fstatSync(current.fd, { bigint: true });
	expect(
		scanRegularDescriptors([current.fd], [{ dev: info.dev + 1n, ino: info.ino }], [needle]),
	).toEqual({ files: 1, bytes: needle.value.length, hits: ["body"] });
});

it("refuses an unresolved descriptor instead of treating it as an empty observation", () => {
	const current = file("closed");
	fs.closeSync(current.fd);
	descriptors.splice(descriptors.indexOf(current.fd), 1);
	expect(() => scanRegularDescriptors([current.fd], [], [needle])).toThrow();
	for (const fd of [-1, 0.5, Number.MAX_SAFE_INTEGER, Number.NaN])
		expect(() => scanRegularDescriptors([fd], [], [needle])).toThrow();
	expect(() => scanRegularDescriptors([current.fd, current.fd], [], [needle])).toThrow();
});

it("accepts canonical descriptor names and refuses malformed or overflowing enumeration entries", () => {
	for (const [name, fd] of [
		["0", 0],
		["17", 17],
		["2147483647", 2 ** 31 - 1],
	] as const)
		expect(descriptorNumber(name)).toBe(fd);
	for (const name of ["01", "-1", "1.0", " 1", "1\n", "2147483648", "99999999999", "x"]) {
		let failure: unknown;
		expect(() => {
			try {
				descriptorNumber(name);
			} catch (error) {
				failure = error;
				throw error;
			}
		}).toThrow("Temporary-file observation refused");
		expect(tempFileDiagnostic(failure, "baseline")).toEqual({
			stage: "baseline",
			category: "discovery",
			discovery: "name",
		});
	}
});

it("bounds descriptor enumeration, observed files, individual size and aggregate bytes", () => {
	const many = Array.from({ length: MAX_SCAN_FILES + 1 }, (_, n) => file(`small-${n}`));
	expect(() =>
		scanRegularDescriptors(
			many.map((entry) => entry.fd),
			[],
			[needle],
		),
	).toThrow();
	const current = many[0];
	if (!current) throw new Error("Missing descriptor fixture");
	const aliases = Array.from({ length: MAX_DESCRIPTOR_ENTRIES + 1 }, () => {
		const fd = fs.openSync(current.name, "r");
		descriptors.push(fd);
		return fd;
	});
	expect(scanRegularDescriptors(aliases.slice(0, MAX_DESCRIPTOR_ENTRIES), [], [needle]).files).toBe(
		1,
	);
	expect(() => scanRegularDescriptors(aliases, [], [needle])).toThrow();
	const large = file("large", "");
	fs.ftruncateSync(large.fd, MAX_FILE_BYTES + 1);
	expect(() => scanRegularDescriptors([large.fd], [], [needle])).toThrow();
	const aggregate = Array.from({ length: MAX_SCAN_BYTES / MAX_FILE_BYTES + 1 }, (_, n) => {
		const entry = file(`aggregate-${n}`, "");
		fs.ftruncateSync(entry.fd, MAX_FILE_BYTES);
		return entry.fd;
	});
	expect(() => scanRegularDescriptors(aggregate, [], [needle])).toThrow();
});

it("refuses growth during a native positional read and preserves the borrowed descriptor", () => {
	const current = file("growing");
	const originalRead = fs.readSync;
	let changed = false;
	const observer = vi.spyOn(fs, "readSync").mockImplementation((...args) => {
		const count = Reflect.apply(originalRead, fs, args);
		if (args[0] === current.fd && !changed) {
			changed = true;
			fs.writeSync(current.fd, Buffer.from("x"), 0, 1, needle.value.length);
		}
		return count;
	});
	syncBuiltinESMExports();
	try {
		let failure: unknown;
		expect(() => {
			try {
				scanRegularDescriptors([current.fd], [], [needle]);
			} catch (error) {
				failure = error;
				throw error;
			}
		}).toThrow();
		expect(tempFileDiagnostic(failure, "active")).toEqual({
			stage: "active",
			category: "read",
		});
		expect(changed).toBe(true);
		expect(fs.fstatSync(current.fd).isFile()).toBe(true);
	} finally {
		observer.mockRestore();
		syncBuiltinESMExports();
	}
});

it("bounds named reads while keeping their plaintext positive control", () => {
	const current = file("named");
	expect(scanNamedFiles([current.name], [needle])).toEqual({
		files: 1,
		bytes: needle.value.length,
		hits: ["body"],
	});
	expect(() =>
		scanNamedFiles(
			Array.from({ length: MAX_SCAN_FILES + 1 }, () => current.name),
			[needle],
		),
	).toThrow();
	expect(() => databaseFileIdentities(path.join(directory, "missing.db"))).toThrow();
});

it.each(["discovery", "descriptor", "read", "metadata"] as const)(
	"classifies %s failures without exposing native error details",
	(category) => {
		const current = file("native-error");
		let traps = 0;
		const error = new Error("PRIVATE_OBSERVER_CANARY");
		for (const key of ["code", "path", "fd"])
			Object.defineProperty(error, key, {
				get: () => {
					traps++;
					throw new Error("PRIVATE_PROPERTY_CANARY");
				},
			});
		const fail = (): never => {
			throw error;
		};
		let operation: () => unknown;
		switch (category) {
			case "discovery":
				vi.spyOn(fs, "opendirSync").mockImplementation(fail);
				operation = () => scanDescriptorDirectory(directory, [], [needle]);
				break;
			case "descriptor":
				vi.spyOn(fs, "fstatSync").mockImplementation(fail);
				operation = () => scanRegularDescriptors([current.fd], [], [needle]);
				break;
			case "read":
				vi.spyOn(fs, "readSync").mockImplementation(fail);
				operation = () => scanRegularDescriptors([current.fd], [], [needle]);
				break;
			case "metadata":
				vi.spyOn(fs, "statSync").mockImplementation(fail);
				operation = () => scanNamedFiles([current.name], [needle]);
				break;
		}
		syncBuiltinESMExports();
		let failure: unknown;
		expect(() => {
			try {
				operation();
			} catch (error) {
				failure = error;
				throw error;
			}
		}).toThrow("Temporary-file observation refused");
		const diagnostic = tempFileDiagnostic(failure, "baseline");
		expect(diagnostic).toEqual({
			stage: "baseline",
			category,
			...(category === "discovery" ? { discovery: "open" } : {}),
		});
		expect(JSON.stringify(diagnostic)).not.toContain("CANARY");
		expect(traps).toBe(0);
	},
);

it("distinguishes identity and bounds refusals without native metadata values", () => {
	for (const [category, operation] of [
		["identity", () => scanRegularDescriptors([], [{ dev: -1n, ino: 1n }], [needle])],
		["bounds", () => scanNamedFiles(Array(MAX_SCAN_FILES + 1).fill("unused"), [needle])],
	] as const) {
		let failure: unknown;
		expect(() => {
			try {
				operation();
			} catch (error) {
				failure = error;
				throw error;
			}
		}).toThrow("Temporary-file observation refused");
		expect(tempFileDiagnostic(failure, "active")).toEqual({ stage: "active", category });
	}
});

it("identifies unexpected regular files while retaining every empty-scan condition", () => {
	expect(() => requireEmptyTempFileScan({ files: 0, bytes: 0, hits: [] })).not.toThrow();
	for (const scan of [
		{ files: 1, bytes: 0, hits: [] },
		{ files: 0, bytes: 1, hits: [] },
		{ files: 0, bytes: 0, hits: ["body"] },
	]) {
		let failure: unknown;
		expect(() => {
			try {
				requireEmptyTempFileScan(scan);
			} catch (error) {
				failure = error;
				throw error;
			}
		}).toThrow("Temporary-file observation refused");
		for (const stage of ["baseline", "active"])
			expect(tempFileDiagnostic(failure, stage)).toEqual({
				stage,
				category: "unexpected-regular-file",
			});
	}
});

it("never echoes unclassified error detail or caller stage", () => {
	const diagnostic = tempFileDiagnostic(
		new Error("PRIVATE_OBSERVER_CANARY"),
		"PRIVATE_STAGE_CANARY",
	);
	expect(JSON.stringify(diagnostic)).not.toContain("CANARY");
	expect(diagnostic).toEqual({ stage: "operation", category: "unknown" });
});

it("does not inspect hostile or proxied error properties to classify an unknown refusal", () => {
	let traps = 0;
	const hostile = (): never => {
		traps++;
		throw new Error("PRIVATE_PROPERTY_CANARY");
	};
	const error = Object.create(Error.prototype);
	for (const key of ["message", "code", "path", "fd"])
		Object.defineProperty(error, key, { get: hostile });
	const proxy = new Proxy(error, { get: hostile, getPrototypeOf: hostile });
	const revoked = Proxy.revocable({}, {});
	revoked.revoke();
	for (const value of [error, proxy, revoked.proxy, null, "PRIVATE_VALUE_CANARY"])
		expect(tempFileDiagnostic(value, { toString: hostile })).toEqual({
			stage: "operation",
			category: "unknown",
		});
	expect(traps).toBe(0);
});

it("enumerates every synthetic numeric descriptor name and preserves borrowed ownership and offset", () => {
	const current = file("borrowed");
	const second = file("second", "no matching content");
	const entries = path.join(directory, "descriptors");
	fs.mkdirSync(entries);
	for (const fd of [current.fd, second.fd]) fs.writeFileSync(path.join(entries, String(fd)), "");
	fs.readSync(current.fd, Buffer.alloc(3), 0, 3, null);
	expect(scanDescriptorDirectory(entries, [], [needle])).toEqual({
		files: 2,
		bytes: needle.value.length + Buffer.byteLength("no matching content"),
		hits: ["body"],
	});
	const next = Buffer.alloc(1);
	expect(fs.readSync(current.fd, next, 0, 1, null)).toBe(1);
	expect(next[0]).toBe(needle.value[3]);
	for (const fd of [current.fd, second.fd]) expect(fs.fstatSync(fd).isFile()).toBe(true);
});

it.each(["open", "read", "name", "close"] as const)(
	"identifies a directory %s refusal without exposing injected native detail",
	async (operation) => {
		const entries = path.join(directory, "descriptors");
		fs.mkdirSync(entries);
		let traps = 0;
		const error = new Error("PRIVATE_DISCOVERY_CANARY");
		for (const key of ["code", "path", "fd"])
			Object.defineProperty(error, key, {
				get: () => {
					traps++;
					throw new Error("PRIVATE_PROPERTY_CANARY");
				},
			});
		const fail = (): never => {
			throw error;
		};
		if (operation === "open") vi.spyOn(fs, "opendirSync").mockImplementation(fail);
		if (operation === "read") vi.spyOn(fs.Dir.prototype, "readSync").mockImplementation(fail);
		if (operation === "name") fs.writeFileSync(path.join(entries, "invalid-name"), "");
		if (operation === "close") {
			const close = fs.Dir.prototype.closeSync;
			vi.spyOn(fs.Dir.prototype, "closeSync").mockImplementation(function (this: fs.Dir) {
				close.call(this);
				throw error;
			});
		}
		syncBuiltinESMExports();
		vi.resetModules();
		const observer = await import("./temp-file-observer.ts");
		let failure: unknown;
		expect(() => {
			try {
				observer.scanDescriptorDirectory(entries, [], [needle]);
			} catch (error) {
				failure = error;
				throw error;
			}
		}).toThrow("Temporary-file observation refused");
		const diagnostic = observer.tempFileDiagnostic(failure, "baseline");
		expect(diagnostic).toEqual({ stage: "baseline", category: "discovery", discovery: operation });
		expect(JSON.stringify(diagnostic)).not.toContain("CANARY");
		expect(traps).toBe(0);
	},
);

it.each(["read", "descriptor"] as const)(
	"preserves the primary %s refusal when directory cleanup also fails",
	async (primary) => {
		const entries = path.join(directory, "descriptors");
		fs.mkdirSync(entries);
		if (primary === "read")
			vi.spyOn(fs.Dir.prototype, "readSync").mockImplementation(() => {
				throw new Error("PRIVATE_PRIMARY_CANARY");
			});
		else {
			const closed = file("closed");
			fs.closeSync(closed.fd);
			descriptors.splice(descriptors.indexOf(closed.fd), 1);
			fs.writeFileSync(path.join(entries, String(closed.fd)), "");
			vi.spyOn(fs, "fstatSync").mockImplementation(() => {
				throw new Error("PRIVATE_PRIMARY_CANARY");
			});
		}
		const close = fs.Dir.prototype.closeSync;
		const closeObserver = vi.spyOn(fs.Dir.prototype, "closeSync").mockImplementation(function (
			this: fs.Dir,
		) {
			close.call(this);
			throw new Error("PRIVATE_CLEANUP_CANARY");
		});
		syncBuiltinESMExports();
		vi.resetModules();
		const observer = await import("./temp-file-observer.ts");
		let failure: unknown;
		expect(() => {
			try {
				observer.scanDescriptorDirectory(entries, [], [needle]);
			} catch (error) {
				failure = error;
				throw error;
			}
		}).toThrow("Temporary-file observation refused");
		expect(closeObserver).toHaveBeenCalledOnce();
		const diagnostic = observer.tempFileDiagnostic(failure, "baseline");
		expect(diagnostic).toEqual(
			primary === "read"
				? { stage: "baseline", category: "discovery", discovery: "read" }
				: { stage: "baseline", category: "descriptor" },
		);
		expect(JSON.stringify(diagnostic)).not.toContain("CANARY");
	},
);
