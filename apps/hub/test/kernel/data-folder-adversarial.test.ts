import {
	type BigIntStats,
	chmodSync,
	linkSync,
	lstatSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	realpathSync,
	rmSync,
	type Stats,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { inspect } from "node:util";
import Database from "better-sqlite3-multiple-ciphers";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { admitDataFolder, type DataFolder, ownerOnly } from "../../src/kernel/data-directory.ts";
import { StartupRefusal, type StartupRefusalCode } from "../../src/lifecycle/preflight.ts";
import { nativeBinding } from "../store/helpers.ts";

const faults = vi.hoisted(() => ({
	mkdir: undefined as Error | undefined,
	writes: 0,
	statCalls: 0,
	spelledStat: undefined as { spelling: string; stat: Stats } | undefined,
	lockStat: undefined as
		| "replace"
		| "main"
		| "missing"
		| "nonregular"
		| "nonregular-before"
		| undefined,
	lockChecks: 0,
}));
vi.mock("node:fs", async (importOriginal) => {
	const fs = await importOriginal<typeof import("node:fs")>();
	const mkdirSync = (...args: Parameters<typeof fs.mkdirSync>) => {
		faults.writes++;
		if (faults.mkdir) throw faults.mkdir;
		return fs.mkdirSync(...args);
	};
	const lstatSync = (...args: Parameters<typeof fs.lstatSync>) => {
		faults.statCalls++;
		if (faults.spelledStat && args[0] === faults.spelledStat.spelling)
			return faults.spelledStat.stat;
		const stat = fs.lstatSync(...args);
		if (!stat || typeof args[0] !== "string" || !args[0].endsWith("hub.lock") || !args[1]?.bigint)
			return stat;
		const check = ++faults.lockChecks;
		if (faults.lockStat === "missing" && check === 2)
			throw Object.assign(new Error("DYTEST-lock-disappeared"), { code: "ENOENT" });
		if (
			(faults.lockStat === "nonregular" && check === 2) ||
			(faults.lockStat === "nonregular-before" && check === 1)
		)
			return Object.create(stat, { isFile: { value: () => false } });
		if (
			(faults.lockStat === "replace" && check >= 2) ||
			(faults.lockStat === "main" && check === 3)
		)
			return Object.create(stat, { ino: { value: (stat as BigIntStats).ino + 1n } });
		return stat;
	};
	return { ...fs, mkdirSync, lstatSync };
});

const temporaryRoot = realpathSync.native(os.tmpdir());
const held: DataFolder[] = [];
let root: string;

beforeEach(() => {
	root = realpathSync.native(mkdtempSync(path.join(temporaryRoot, "draftyak-data-")));
});
afterEach(() => {
	faults.mkdir = undefined;
	faults.spelledStat = undefined;
	faults.lockStat = undefined;
	faults.lockChecks = 0;
	vi.restoreAllMocks();
	for (const folder of held.splice(0)) folder.release();
	rmSync(root, { recursive: true, force: true });
});

function folder(...parts: string[]): string {
	const created = path.join(root, ...parts);
	mkdirSync(created, { recursive: true, mode: 0o700 });
	return created;
}

function admit(spelling: string): DataFolder {
	const admitted = admitDataFolder(spelling, { nativeBinding });
	held.push(admitted);
	return admitted;
}

function refused(spelling: string, code: StartupRefusalCode): StartupRefusal {
	let failure: unknown;
	try {
		admit(spelling);
	} catch (error) {
		failure = error;
	}
	expect(failure).toBeInstanceOf(StartupRefusal);
	expect((failure as StartupRefusal).code).toBe(code);
	return failure as StartupRefusal;
}

it("classifies the canonical spelling, so a link into a synced folder is refused as synced", () => {
	const synced = folder("OneDrive", "hub");
	const direct = path.join(root, "direct");
	symlinkSync(synced, direct, "junction");
	refused(direct, "DATA_DIR_SYNCED");
	const parent = path.join(root, "parent");
	symlinkSync(path.join(root, "OneDrive"), parent, "junction");
	refused(path.join(parent, "hub"), "DATA_DIR_SYNCED");
	expect(readdirSync(synced)).toEqual([]);
});

it("admits POSIX ownership only for the effective user without group or other write", () => {
	const euid = 1_000;
	const stat = (uid: number, mode: number) => ({ uid, mode: 0o040_000 | mode });
	for (const mode of [0o700, 0o750, 0o755, 0o705, 0o500])
		expect(ownerOnly(stat(euid, mode), euid, false)).toBe(true);
	for (const mode of [0o720, 0o702, 0o770, 0o707, 0o777])
		expect(ownerOnly(stat(euid, mode), euid, false)).toBe(false);
	expect(ownerOnly(stat(euid, 0o700), euid, true)).toBe(true);
	for (const mode of [0o755, 0o750, 0o705, 0o711, 0o600, 0o500])
		expect(ownerOnly(stat(euid, mode), euid, true)).toBe(false);
	for (const run of [false, true]) {
		expect(ownerOnly(stat(euid + 1, 0o700), euid, run)).toBe(false);
		expect(ownerOnly(stat(0, 0o700), undefined, run)).toBe(false);
	}
});

it("leaves nothing open behind a refused admission", () => {
	const data = folder("data");
	const first = admit(data);
	refused(data, "DATA_DIR_LOCKED");
	first.release();
	rmSync(data, { recursive: true });
	expect(readdirSync(root)).toEqual([]);
});

it("refuses any failure to create run/ with DATA_DIR_OWNERSHIP and none of its detail", () => {
	const data = folder("data");
	faults.mkdir = Object.assign(new Error(`EACCES: permission denied, mkdir '${data}'`), {
		code: "EACCES",
	});
	const failure = refused(data, "DATA_DIR_OWNERSHIP");
	expect(failure.cause).toBeUndefined();
	expect(inspect(failure, { showHidden: true, depth: null })).not.toContain(data);
	faults.mkdir = undefined;
	expect(readdirSync(data)).toEqual([]);
	admit(data);
});

it("refuses a canonical folder over 4,096 UTF-16 units before writing to it", {
	tags: ["requires:windows"],
}, () => {
	let data = root;
	while (data.length <= 4_096) data = path.join(data, "x".repeat(200));
	mkdirSync(data, { recursive: true });
	expect(realpathSync.native(data)).toBe(data);
	refused(data, "DATA_DIR_INVALID");
	expect(readdirSync(data)).toEqual([]);
});

it("refuses another letter case of the folder's spelling", { tags: ["requires:windows"] }, () => {
	const data = folder("Data");
	expect(data.toLowerCase()).not.toBe(data);
	refused(data.toLowerCase(), "DATA_DIR_INVALID");
	expect(readdirSync(data)).toEqual([]);
});

it.each([".", " "])(
	"refuses a Windows trailing %j data-folder alias before writing to either twin",
	{ tags: ["requires:windows"] },
	(suffix) => {
		const twin = folder("OneDrive");
		const run = folder("OneDrive", "run");
		const data = path.join(root, `OneDrive${suffix}`);
		mkdirSync(path.toNamespacedPath(data));
		expect(realpathSync.native(data)).toBe(data);
		expect(lstatSync(data).ino).not.toBe(lstatSync(twin).ino);
		refused(data, "DATA_DIR_INVALID");
		expect(readdirSync(data)).toEqual([]);
		expect(readdirSync(run)).toEqual([]);
	},
);

it.each([".", " "])(
	"refuses a Windows trailing %j ancestor before writing to either twin",
	{ tags: ["requires:windows"] },
	(suffix) => {
		const twin = folder("ancestor", "data");
		const run = folder("ancestor", "data", "run");
		const data = path.join(root, `ancestor${suffix}`, "data");
		mkdirSync(path.toNamespacedPath(data), { recursive: true });
		expect(realpathSync.native(data)).toBe(data);
		expect(lstatSync(data).ino).not.toBe(lstatSync(twin).ino);
		refused(data, "DATA_DIR_INVALID");
		expect(readdirSync(data)).toEqual([]);
		expect(readdirSync(run)).toEqual([]);
	},
);

it.each([".", " "])(
	"refuses a Windows trailing %j alias whose twin run/ is a junction",
	{ tags: ["requires:windows"] },
	(suffix) => {
		const twin = folder("store");
		const target = folder("target");
		symlinkSync(target, path.join(twin, "run"), "junction");
		refused(twin, "DATA_DIR_OWNERSHIP");
		const data = path.join(root, `store${suffix}`);
		mkdirSync(path.toNamespacedPath(data));
		expect(realpathSync.native(data)).toBe(data);
		refused(data, "DATA_DIR_INVALID");
		expect(readdirSync(data)).toEqual([]);
		expect(readdirSync(target)).toEqual([]);
	},
);

it.each([
	String.raw`\\DYTEST\share\data`,
	String.raw`\\localhost\C$\DYTEST\data`,
	String.raw`\\?\UNC\DYTEST\share\data`,
	String.raw`\\?\C:\DYTEST\data`,
	String.raw`\\.\C:\DYTEST\data`,
])(
	"refuses non-drive Windows spelling %j before filesystem access",
	{ tags: ["requires:windows"] },
	(spelling) => {
		faults.spelledStat = { spelling, stat: lstatSync(folder("data")) };
		const resolve = vi.spyOn(realpathSync, "native").mockReturnValue(spelling);
		faults.mkdir = new Error("DYTEST-no-network-write");
		faults.writes = 0;
		faults.statCalls = 0;
		refused(spelling, "DATA_DIR_INVALID");
		expect(resolve).not.toHaveBeenCalled();
		expect(faults.writes).toBe(0);
		expect(faults.statCalls).toBe(0);
	},
);

it.each(["data.with.dots", "data with spaces"])(
	"admits an ordinary folder named %s without normalizing it",
	(name) => {
		const data = folder(name);
		const admitted = admit(data);
		expect(admitted.path).toBe(data);
		expect(() => admitted.assertHeld()).not.toThrow();
	},
);

function home(homedir: string): void {
	vi.spyOn(os, "userInfo").mockReturnValue({
		homedir,
		username: "DYTEST",
		uid: 1_000,
		gid: 1_000,
		shell: null,
	});
}

it.each(["Box", "box", "Dropbox"])(
	"admits a local folder below an authenticated home named %s",
	(name) => {
		const profile = folder(name);
		home(profile);
		const data = folder(name, "AppData", "Local", "hub");
		const admitted = admit(data);
		expect(() => admitted.assertHeld()).not.toThrow();
		refused(data, "DATA_DIR_LOCKED");
	},
);

it("still refuses a sync-family folder below the home before writing", () => {
	const profile = folder("Box");
	home(profile);
	const data = folder("Box", "OneDrive", "data");
	refused(data, "DATA_DIR_SYNCED");
	expect(readdirSync(data)).toEqual([]);
});

it("does not exempt a synced home itself or a known synced ancestor above it", () => {
	const profile = folder("Box");
	home(profile);
	refused(profile, "DATA_DIR_SYNCED");
	const nested = folder("OneDrive", "profile");
	home(nested);
	const data = folder("OneDrive", "profile", "data");
	refused(data, "DATA_DIR_SYNCED");
	expect(readdirSync(data)).toEqual([]);
});

it("fails closed when the authenticated home cannot be resolved", () => {
	home(path.join(root, "missing-home"));
	const data = folder("Box", "data");
	refused(data, "DATA_DIR_SYNCED");
	expect(readdirSync(data)).toEqual([]);
});

it("refuses a read-only lock rather than admitting shared read transactions", () => {
	const data = folder("data");
	const run = folder("data", "run");
	const lock = path.join(run, "hub.lock");
	writeFileSync(lock, "");
	chmodSync(lock, 0o444);
	try {
		expect(lstatSync(lock).mode & 0o222).toBe(0);
		refused(data, "DATA_DIR_LOCK_IO");
		refused(data, "DATA_DIR_LOCK_IO");
		expect(lstatSync(lock).size).toBe(0);
	} finally {
		chmodSync(lock, 0o600);
	}
	admit(data);
	refused(data, "DATA_DIR_LOCKED");
});

it("refuses a hard-linked lock before following it", () => {
	const data = folder("data");
	const run = folder("data", "run");
	const target = path.join(root, "target.lock");
	writeFileSync(target, "");
	linkSync(target, path.join(run, "hub.lock"));
	expect(lstatSync(target).nlink).toBe(2);
	// Held elsewhere, so opening through the link would report DATA_DIR_LOCKED instead.
	const holder = new Database(target, { nativeBinding, timeout: 0 });
	try {
		holder.pragma("journal_mode = MEMORY");
		holder.exec("BEGIN EXCLUSIVE");
		refused(data, "DATA_DIR_LOCK_IO");
	} finally {
		holder.close();
	}
	expect(lstatSync(target).size).toBe(0);
	rmSync(path.join(run, "hub.lock"));
	admit(data);
});

it("refuses a file symlink at hub.lock before following it", {
	tags: ["requires:symlink-privilege"],
}, () => {
	const data = folder("data");
	const run = folder("data", "run");
	const target = path.join(root, "target.lock");
	symlinkSync(target, path.join(run, "hub.lock"), "file");
	refused(data, "DATA_DIR_LOCK_IO");
	expect(readdirSync(root)).toEqual(["data"]);
	writeFileSync(target, "");
	refused(data, "DATA_DIR_LOCK_IO");
	expect(lstatSync(target).size).toBe(0);
});

it("refuses an existing nonempty SQLite lock without changing it", () => {
	const data = folder("data");
	const run = folder("data", "run");
	const lock = path.join(run, "hub.lock");
	const db = new Database(lock, { nativeBinding });
	db.pragma("journal_mode = WAL");
	db.exec("CREATE TABLE marker(value TEXT) STRICT");
	db.close();
	const bytes = readFileSync(lock);
	expect(bytes.length).toBeGreaterThan(0);
	refused(data, "DATA_DIR_LOCK_IO");
	expect(readFileSync(lock)).toEqual(bytes);
	expect(readdirSync(run)).toEqual(["hub.lock"]);
});

it("refuses a lock reported as not a regular file before opening it", () => {
	const data = folder("data");
	const lock = path.join(folder("data", "run"), "hub.lock");
	writeFileSync(lock, "");
	// Held elsewhere, so opening it first would report DATA_DIR_LOCKED instead.
	const holder = new Database(lock, { nativeBinding, timeout: 0 });
	try {
		holder.pragma("journal_mode = MEMORY");
		holder.exec("BEGIN EXCLUSIVE");
		faults.lockChecks = 0;
		faults.lockStat = "nonregular-before";
		refused(data, "DATA_DIR_LOCK_IO");
	} finally {
		holder.close();
	}
});

it.each(["replace", "main", "missing", "nonregular"] as const)(
	"refuses a lock whose acquisition identity check reports %s, without leaking a connection",
	(fault) => {
		const data = folder("data");
		const run = folder("data", "run");
		writeFileSync(path.join(run, "hub.lock"), "");
		faults.lockChecks = 0;
		faults.lockStat = fault;
		const error = refused(data, "DATA_DIR_LOCK_IO");
		expect(error.cause).toBeUndefined();
		expect(inspect(error, { showHidden: true, depth: null })).not.toContain("DYTEST-lock");
		faults.lockStat = undefined;
		faults.lockChecks = 0;
		admit(data);
	},
);

it.each([false, true])(
	"refuses a lock SQLite reports at another file (hub.lock existed: %s)",
	(existed) => {
		const data = folder("data");
		const run = folder("data", "run");
		if (existed) writeFileSync(path.join(run, "hub.lock"), "");
		const other = path.join(root, "other.lock");
		writeFileSync(other, "");
		const pragma = Database.prototype.pragma;
		vi.spyOn(Database.prototype, "pragma").mockImplementation(function (
			this: Database.Database,
			source,
			options,
		) {
			return source === "database_list"
				? [{ seq: 0, name: "main", file: other }]
				: pragma.call(this, source, options);
		});
		refused(data, "DATA_DIR_LOCK_IO");
		vi.restoreAllMocks();
		admit(data);
	},
);

it.each(["replace", "missing", "nonregular"] as const)(
	"refuses a held check reporting %s without releasing the original lock",
	(fault) => {
		const data = folder("data");
		const admitted = admit(data);
		faults.lockChecks = 1;
		faults.lockStat = fault;
		expect(() => admitted.assertHeld()).toThrowError(new StartupRefusal("DATA_DIR_LOCK_IO"));
		faults.lockStat = undefined;
		expect(() => admitted.assertHeld()).not.toThrow();
		refused(data, "DATA_DIR_LOCKED");
	},
);
