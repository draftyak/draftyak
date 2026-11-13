import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import config from "../../vitest.config.ts";
import type { TempFileDirectory } from "./temp-file-directory.ts";
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
	directory = fs.mkdtempSync(
		path.join(fs.realpathSync.native(os.tmpdir()), "draftyak-observer-test-"),
	);
});
afterEach(() => {
	vi.restoreAllMocks();
	syncBuiltinESMExports();
	for (const fd of descriptors.splice(0)) fs.closeSync(fd);
	expect(path.dirname(directory)).toBe(fs.realpathSync.native(os.tmpdir()));
	expect(path.basename(directory).startsWith("draftyak-observer-test-")).toBe(true);
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
		expect(diagnostic).toEqual({
			stage: "baseline",
			category: "discovery",
			discovery: operation,
			...(operation === "read" ? { discoveryReadCode: "other", discoveryReadAttempt: 1 } : {}),
		});
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
				? {
						stage: "baseline",
						category: "discovery",
						discovery: "read",
						discoveryReadCode: "other",
						discoveryReadAttempt: 1,
					}
				: { stage: "baseline", category: "descriptor" },
		);
		expect(JSON.stringify(diagnostic)).not.toContain("CANARY");
	},
);

it.each([1, 2])("labels a native directory read refusal at bounded attempt %s", async (attempt) => {
	const current = file("discovery-read");
	const entries = path.join(directory, "descriptors");
	fs.mkdirSync(entries);
	fs.writeFileSync(path.join(entries, String(current.fd)), "");
	const error = Object.assign(new Error("PRIVATE_READ_CANARY"), {
		code: "EIO",
		path: "PRIVATE_PATH_CANARY",
		fd: "PRIVATE_DESCRIPTOR_CANARY",
	});
	const read = fs.Dir.prototype.readSync;
	let calls = 0;
	vi.spyOn(fs.Dir.prototype, "readSync").mockImplementation(function (this: fs.Dir) {
		if (++calls === attempt) throw error;
		return read.call(this);
	});
	const closeObserver = vi.spyOn(fs.Dir.prototype, "closeSync");
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
	expect(observer.tempFileDiagnostic(failure, "baseline")).toEqual({
		stage: "baseline",
		category: "discovery",
		discovery: "read",
		discoveryReadCode: "EIO",
		discoveryReadAttempt: attempt,
	});
	expect(JSON.stringify(observer.tempFileDiagnostic(failure, "baseline"))).not.toContain("CANARY");
	expect(
		observer.tempFileFailureReport("memory-sort", observer.tempFileDiagnostic(failure, "baseline")),
	).toBe(
		`{"phase":"memory-sort","refused":true,"stage":"baseline","category":"discovery","discovery":"read","discoveryReadCode":"EIO","discoveryReadAttempt":${attempt}}`,
	);
	expect(calls).toBe(attempt);
	expect(closeObserver).toHaveBeenCalledOnce();
	expect(fs.fstatSync(current.fd).isFile()).toBe(true);
});

it("keeps unknown or accessor directory error codes fatal and private", async () => {
	const entries = path.join(directory, "descriptors");
	fs.mkdirSync(entries);
	let traps = 0;
	const accessor = Object.create(null);
	Object.defineProperty(accessor, "code", {
		get: () => {
			traps++;
			throw new Error("PRIVATE_GETTER_CANARY");
		},
	});
	let nativeError: unknown;
	vi.spyOn(fs.Dir.prototype, "readSync").mockImplementation(() => {
		throw nativeError;
	});
	vi.resetModules();
	const observer = await import("./temp-file-observer.ts");
	for (nativeError of [
		Object.assign(new Error("PRIVATE_ERROR_CANARY"), { code: "PRIVATE_CODE_CANARY" }),
		Object.assign(new Error("PRIVATE_ERROR_CANARY"), {
			code: {
				toString: () => {
					traps++;
					return "EIO";
				},
			},
		}),
		Object.create({ code: "EIO" }),
		accessor,
		null,
	]) {
		let failure: unknown;
		expect(() => {
			try {
				observer.scanDescriptorDirectory(entries, [], [needle]);
			} catch (error) {
				failure = error;
				throw error;
			}
		}).toThrow("Temporary-file observation refused");
		expect(observer.tempFileDiagnostic(failure, "baseline")).toEqual({
			stage: "baseline",
			category: "discovery",
			discovery: "read",
			discoveryReadCode: "other",
			discoveryReadAttempt: 1,
		});
		expect(JSON.stringify(observer.tempFileDiagnostic(failure, "baseline"))).not.toContain(
			"CANARY",
		);
	}
	expect(traps).toBe(0);
});

it("keeps a hostile discovery error descriptor trap subordinate to the primary refusal", async () => {
	const entries = path.join(directory, "descriptors");
	fs.mkdirSync(entries);
	let descriptorTraps = 0;
	const hostile = new Proxy(
		{},
		{
			getOwnPropertyDescriptor: () => {
				descriptorTraps++;
				throw new Error("PRIVATE_DESCRIPTOR_TRAP_CANARY");
			},
			get: () => {
				throw new Error("PRIVATE_GET_CANARY");
			},
			getPrototypeOf: () => {
				throw new Error("PRIVATE_PROTOTYPE_CANARY");
			},
		},
	);
	const read = fs.Dir.prototype.readSync;
	fs.Dir.prototype.readSync = () => {
		throw hostile;
	};
	const close = fs.Dir.prototype.closeSync;
	const closeObserver = vi.spyOn(fs.Dir.prototype, "closeSync").mockImplementation(function (
		this: fs.Dir,
	) {
		close.call(this);
		throw new Error("PRIVATE_CLEANUP_CANARY");
	});
	try {
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
		expect(
			observer.tempFileFailureReport(
				"memory-sort",
				observer.tempFileDiagnostic(failure, "baseline"),
			),
		).toBe(
			'{"phase":"memory-sort","refused":true,"stage":"baseline","category":"discovery","discovery":"read","discoveryReadCode":"other","discoveryReadAttempt":1}',
		);
		expect(descriptorTraps).toBe(1);
		expect(closeObserver).toHaveBeenCalledOnce();
	} finally {
		fs.Dir.prototype.readSync = read;
	}
});

function rawDirectory(names: readonly string[]): TempFileDirectory {
	const handle = {};
	let index = 0;
	return {
		open: vi.fn(() => handle),
		read: vi.fn((actual) => {
			expect(actual).toBe(handle);
			const name = names[index++];
			return name === undefined ? null : { name };
		}),
		close: vi.fn((actual) => expect(actual).toBe(handle)),
	};
}

it("uses raw Darwin names when the old Dirent reader refuses its first metadata conversion", async () => {
	const current = file("raw-borrowed");
	fs.readSync(current.fd, Buffer.alloc(3), 0, 3, null);
	const entries = path.join(directory, "old-directory");
	fs.mkdirSync(entries);
	const open = fs.opendirSync;
	const oldOpen = vi.spyOn(fs, "opendirSync").mockImplementation(() => open(entries));
	const oldRead = vi.spyOn(fs.Dir.prototype, "readSync").mockImplementation(() => {
		throw Object.assign(new Error("DYTEST-OLD-DIRENT"), { code: "EBADF" });
	});
	syncBuiltinESMExports();
	vi.resetModules();
	const observer = await import("./temp-file-observer.ts");
	const raw = rawDirectory([String(current.fd)]);
	let result: unknown;
	expect(() => {
		result = observer.scanDescriptorDirectory("/dev/fd", [], [needle], raw);
	}).not.toThrow();
	expect(result).toEqual({ files: 1, bytes: needle.value.length, hits: ["body"] });
	expect(oldOpen).not.toHaveBeenCalled();
	expect(oldRead).not.toHaveBeenCalled();
	expect(raw.close).toHaveBeenCalledOnce();
	const next = Buffer.alloc(1);
	expect(fs.readSync(current.fd, next, 0, 1, null)).toBe(1);
	expect(next[0]).toBe(needle.value[3]);
	expect(fs.fstatSync(current.fd).isFile()).toBe(true);
});

it("requires the native adapter only for the exact selected descriptor directory", () => {
	const open = vi.spyOn(fs, "opendirSync");
	syncBuiltinESMExports();
	expect(() => scanDescriptorDirectory("/dev/fd", [], [needle])).toThrow();
	const raw = rawDirectory([]);
	expect(() => scanDescriptorDirectory(directory, [], [needle], raw)).toThrow();
	expect(open).not.toHaveBeenCalled();
	expect(raw.open).not.toHaveBeenCalled();
});

it("admits 256 raw numeric entries plus EOF and refuses the 257th before inspection", () => {
	const current = file("raw-boundary");
	const aliases = Array.from({ length: MAX_DESCRIPTOR_ENTRIES + 1 }, () => {
		const fd = fs.openSync(current.name, "r");
		descriptors.push(fd);
		return fd;
	});
	const raw = rawDirectory(aliases.slice(0, MAX_DESCRIPTOR_ENTRIES).map(String));
	expect(scanDescriptorDirectory("/dev/fd", [], [needle], raw)).toEqual({
		files: 1,
		bytes: needle.value.length,
		hits: ["body"],
	});
	expect(raw.read).toHaveBeenCalledTimes(MAX_DESCRIPTOR_ENTRIES + 1);
	expect(raw.close).toHaveBeenCalledOnce();
	const overflow = rawDirectory(aliases.map(String));
	const stat = vi.spyOn(fs, "fstatSync");
	syncBuiltinESMExports();
	let failure: unknown;
	expect(() => {
		try {
			scanDescriptorDirectory("/dev/fd", [], [needle], overflow);
		} catch (error) {
			failure = error;
			throw error;
		}
	}).toThrow();
	expect(tempFileDiagnostic(failure, "baseline")).toEqual({
		stage: "baseline",
		category: "bounds",
	});
	expect(overflow.read).toHaveBeenCalledTimes(MAX_DESCRIPTOR_ENTRIES + 1);
	expect(stat.mock.calls.some(([fd]) => fd === aliases[MAX_DESCRIPTOR_ENTRIES])).toBe(false);
	expect(overflow.close).toHaveBeenCalledOnce();
});

it("keeps the native directory live through borrowed reads and closes it once on failure", () => {
	const current = file("raw-lifetime");
	const raw = rawDirectory([String(current.fd)]);
	const read = fs.readSync;
	const readObserver = vi.spyOn(fs, "readSync").mockImplementation((...args) => {
		expect(raw.close).not.toHaveBeenCalled();
		return Reflect.apply(read, fs, args);
	});
	syncBuiltinESMExports();
	expect(scanDescriptorDirectory("/dev/fd", [], [needle], raw).hits).toEqual(["body"]);
	expect(raw.close).toHaveBeenCalledOnce();
	readObserver.mockRestore();
	syncBuiltinESMExports();
	const duplicate = rawDirectory([String(current.fd), String(current.fd)]);
	expect(() => scanDescriptorDirectory("/dev/fd", [], [needle], duplicate)).toThrow();
	expect(duplicate.close).toHaveBeenCalledOnce();
});

it("preserves the native read refusal when native cleanup also fails", () => {
	const raw: TempFileDirectory = {
		open: () => ({}),
		read: () => {
			throw Object.assign(new Error("DYFD_READ"), { code: "DYFD_READ", syscallCode: "EBADF" });
		},
		close: vi.fn(() => {
			throw Object.assign(new Error("DYFD_CLOSE"), { code: "DYFD_CLOSE", syscallCode: "EIO" });
		}),
	};
	let failure: unknown;
	expect(() => {
		try {
			scanDescriptorDirectory("/dev/fd", [], [needle], raw);
		} catch (error) {
			failure = error;
			throw error;
		}
	}).toThrow();
	expect(tempFileDiagnostic(failure, "baseline")).toEqual({
		stage: "baseline",
		category: "discovery",
		discovery: "read",
		discoveryReadCode: "EBADF",
		discoveryReadAttempt: 1,
	});
	expect(raw.close).toHaveBeenCalledOnce();
	const cleanup = { ...raw, read: () => null };
	expect(() => scanDescriptorDirectory("/dev/fd", [], [needle], cleanup)).toThrow();
	expect(raw.close).toHaveBeenCalledTimes(2);
});

it("only admits native syscall codes through an own-data DYFD_READ identity", () => {
	let traps = 0;
	const accessor = Object.assign(new Error("DYFD_READ"), { code: "DYFD_READ" });
	Object.defineProperty(accessor, "syscallCode", {
		get: () => {
			traps++;
			return "EBADF";
		},
	});
	const other = Object.assign(new Error("DYFD_OPEN"), { code: "DYFD_OPEN" });
	Object.defineProperty(other, "syscallCode", {
		get: () => {
			traps++;
			return "EBADF";
		},
	});
	const node = Object.assign(new Error("DYTEST-NODE"), { code: "EIO" });
	Object.defineProperty(node, "syscallCode", {
		get: () => {
			traps++;
			return "EBADF";
		},
	});
	const cases = [
		[accessor, "other"],
		[other, "other"],
		[node, "EIO"],
		[
			Object.assign(new Error("DYFD_READ"), { code: "DYFD_READ", syscallCode: "DYTEST-UNKNOWN" }),
			"other",
		],
		[Object.assign(new Error("DYFD_READ"), { code: "DYFD_READ", syscallCode: "EBADF" }), "EBADF"],
	] as const;
	for (const [error, expected] of cases) {
		const raw = {
			open: () => ({}),
			read: (): never => {
				throw error;
			},
			close: vi.fn(),
		};
		let failure: unknown;
		expect(() => {
			try {
				scanDescriptorDirectory("/dev/fd", [], [needle], raw);
			} catch (caught) {
				failure = caught;
				throw caught;
			}
		}).toThrow();
		expect(tempFileDiagnostic(failure, "baseline")).toEqual({
			stage: "baseline",
			category: "discovery",
			discovery: "read",
			discoveryReadCode: expected,
			discoveryReadAttempt: 1,
		});
		expect(raw.close).toHaveBeenCalledOnce();
	}
	expect(traps).toBe(0);
});
