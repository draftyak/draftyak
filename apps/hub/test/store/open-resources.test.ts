import { randomBytes } from "node:crypto";
import fs, {
	existsSync,
	mkdtempSync,
	readFileSync,
	realpathSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { MasterKey } from "../../src/kernel/master-key.ts";
import {
	assertEncryptedKeyIdentity,
	createEncryptedKeyIdentity,
	openEncrypted,
	type SqliteDatabase,
} from "../../src/store/open.ts";
import { nativeBinding } from "./helpers.ts";

const nativeOpen = fs.openSync,
	nativeClose = fs.closeSync,
	nativeStat = fs.fstatSync,
	nativeLstat = fs.lstatSync;
const databases: SqliteDatabase[] = [];
const descriptors: { fd: number; dev: bigint; ino: bigint }[] = [];
let directory: string, key: MasterKey;
const first = (): string => path.join(directory, "first.db"),
	second = (): string => path.join(directory, "second.db");
const refused = "Database file reservation unavailable";
beforeEach(() => {
	directory = realpathSync(mkdtempSync(path.join(os.tmpdir(), "dy-open-resource-")));
	const bytes = randomBytes(32);
	key = new MasterKey(bytes);
	bytes.fill(0);
});
function create(filename = second(), create = true, masterKey = key): SqliteDatabase {
	const db = openEncrypted({ filename, nativeBinding, create }, masterKey);
	databases.push(db);
	return db;
}
function capture(fd: number): void {
	const identity = nativeStat(fd, { bigint: true });
	descriptors.push({ fd, dev: identity.dev, ino: identity.ino });
}
afterEach(() => {
	vi.restoreAllMocks();
	syncBuiltinESMExports();
	for (const db of databases.splice(0)) if (db.open) db.close();
	// Test-native owners release only their exact captured descriptors; no product force-clear API.
	for (const held of descriptors.splice(0))
		try {
			const now = nativeStat(held.fd, { bigint: true });
			if (now.dev === held.dev && now.ino === held.ino) nativeClose(held.fd);
		} catch {}
	const probe = openEncrypted(
		{ filename: path.join(directory, "cleanup-probe.db"), nativeBinding, create: true },
		key,
	);
	probe.close();
	key.destroy();
	rmSync(directory, { recursive: true, force: true });
});
type CloseMode = "none" | "persistent" | "once-before" | "after" | "after-reuse";
type StatMode =
	| "none"
	| "initial-error"
	| "always-error"
	| "always-zero"
	| "after-error"
	| "after-zero";
function trap() {
	const state = {
		fd: undefined as number | undefined,
		foreign: undefined as number | undefined,
		opens: 0,
		closes: 0,
		secondLookups: 0,
		close: "none" as CloseMode,
		stat: "none" as StatMode,
	};
	vi.spyOn(fs, "openSync").mockImplementation((filename, flags, mode) => {
		const fd = nativeOpen(filename, flags, mode);
		if (String(filename) === first()) {
			state.fd = fd;
			state.opens++;
			capture(fd);
		}
		return fd;
	});
	vi.spyOn(fs, "closeSync").mockImplementation((fd) => {
		if (fd !== state.fd) {
			nativeClose(fd);
			return;
		}
		state.closes++;
		if (state.close === "persistent") throw Error("private-close-before-effect");
		if (state.close === "once-before") {
			state.close = "none";
			throw Error("private-close-before-effect");
		}
		if (state.close === "after" || state.close === "after-reuse") {
			const reuse = state.close === "after-reuse";
			state.close = "none";
			nativeClose(fd);
			if (reuse) {
				state.foreign = nativeOpen(path.join(directory, "independent-file"), "wx+");
				capture(state.foreign);
				writeFileSync(state.foreign, "INDEPENDENT_OWNER_UNCHANGED");
			}
			throw Error("private-close-after-effect");
		}
		nativeClose(fd);
	});
	vi.spyOn(fs, "fstatSync").mockImplementation((fd, options) => {
		if (fd === state.fd) {
			if (state.stat === "initial-error") {
				state.stat = "none";
				throw Error("private-initial-stat");
			}
			if (state.stat === "always-error" || (state.stat === "after-error" && state.closes > 0))
				throw Error("private-stat-unavailable");
			if (state.stat === "always-zero" || (state.stat === "after-zero" && state.closes > 0)) {
				const unknown = Object.create(nativeStat(fd, options));
				Object.defineProperty(unknown, "ino", { value: 0n });
				return unknown;
			}
		}
		return nativeStat(fd, options);
	});
	vi.spyOn(fs, "lstatSync").mockImplementation((filename, options) => {
		if (String(filename) === second()) state.secondLookups++;
		return nativeLstat(filename, options);
	});
	syncBuiltinESMExports();
	return state;
}
function refusal(work: () => unknown): void {
	let error: unknown;
	try {
		work();
	} catch (value) {
		error = value;
	}
	expect(error).toBeInstanceOf(Error);
	expect((error as Error).message).toBe(refused);
	expect(String(error)).not.toContain(directory);
	expect(String(error)).not.toContain("private-");
}

it("opens actual encrypted SQLite after bounded reservation and preserves real key verification", () => {
	const canary = "ENCRYPTED_OPEN_PRIVATE_CANARY",
		db = create(first());
	db.exec("CREATE TABLE private_data(value TEXT)");
	db.prepare("INSERT INTO private_data VALUES(?)").run(canary);
	db.close();
	expect(readFileSync(first()).includes(Buffer.from(canary))).toBe(false);
	expect(readFileSync(first()).subarray(0, 16).toString()).not.toBe("SQLite format 3\0");
	const reopened = create(first(), false);
	expect(reopened.prepare("SELECT value FROM private_data").get()).toEqual({ value: canary });
	reopened.close();
	const wrong = new MasterKey(randomBytes(32));
	try {
		expect(() => create(first(), false, wrong)).toThrow();
	} finally {
		wrong.destroy();
	}
});

it("holds one failed exclusive descriptor and refuses another path before lookup or allocation", () => {
	const state = trap();
	state.close = "persistent";
	refusal(() => create(first()));
	expect(state.fd).toBeDefined();
	expect(nativeStat(state.fd as number).isFile()).toBe(true);
	expect(nativeStat(state.fd as number).size).toBe(0);
	for (let count = 0; count < 3; count++) refusal(() => create());
	expect(state.opens).toBe(1);
	expect(state.secondLookups).toBe(0);
	expect(existsSync(second())).toBe(false);
	state.close = "none";
	const db = create();
	db.exec("CREATE TABLE recovered(x)");
	expect(state.secondLookups).toBeGreaterThan(0);
	expect(db.prepare("SELECT name FROM sqlite_schema WHERE name='recovered'").get()).toEqual({
		name: "recovered",
	});
	expect(nativeLstat(first()).size).toBe(0);
});

it("quarantines existing native database reopening as well as new-file creation", () => {
	const db = create();
	db.exec("CREATE TABLE persisted(x)");
	db.close();
	const before = readFileSync(second());
	const state = trap();
	state.close = "persistent";
	refusal(() => create(first()));
	refusal(() => create(second(), false));
	expect(state.secondLookups).toBe(0);
	expect(readFileSync(second())).toEqual(before);
	state.close = "none";
	expect(
		create(second(), false).prepare("SELECT name FROM sqlite_schema WHERE name='persisted'").get(),
	).toEqual({ name: "persisted" });
});

it.each(["once-before", "after"] as const)(
	"proves cleanup after a close failure %s without erasing the empty file",
	(mode) => {
		const state = trap();
		state.close = mode;
		refusal(() => create(first()));
		expect(() => nativeStat(state.fd as number)).toThrow();
		expect(nativeLstat(first()).size).toBe(0);
		create().exec("CREATE TABLE next_open(x)");
		expect(existsSync(second())).toBe(true);
	},
);

it("never closes a positive foreign inode reused after native close took effect", () => {
	const state = trap();
	state.close = "after-reuse";
	refusal(() => create(first()));
	expect(state.foreign).toBe(state.fd);
	expect(state.closes).toBe(1);
	create().exec("CREATE TABLE next_open(x)");
	expect(nativeStat(state.foreign as number).isFile()).toBe(true);
	expect(readFileSync(path.join(directory, "independent-file"), "utf8")).toBe(
		"INDEPENDENT_OWNER_UNCHANGED",
	);
});

it.each(["after-error", "after-zero"] as const)(
	"unknown post-close metadata %s retains quarantine without another close",
	(mode) => {
		const state = trap();
		state.close = "persistent";
		state.stat = mode;
		refusal(() => create(first()));
		expect(state.closes).toBe(1);
		refusal(() => create());
		expect(state.closes).toBe(1);
		expect(state.secondLookups).toBe(0);
		expect(existsSync(second())).toBe(false);
		state.stat = "none";
		state.close = "none";
		create().exec("CREATE TABLE after_native_metadata_recovery(x)");
	},
);

it("cannot adopt later metadata when the initial stat and first native close both fail", () => {
	const state = trap();
	state.stat = "initial-error";
	state.close = "persistent";
	refusal(() => create(first()));
	expect(nativeStat(state.fd as number).isFile()).toBe(true);
	refusal(() => create());
	expect(state.secondLookups).toBe(0);
	state.close = "none";
	refusal(() => create());
	expect(state.closes).toBe(1);
	// Later valid metadata cannot establish the missing original identity.
	nativeClose(state.fd as number);
	create().exec("CREATE TABLE initial_stat_recovered(x)");
	expect(nativeLstat(first()).size).toBe(0);
});

it("can perform its first known-open close after initial metadata failure without adopting identity", () => {
	const state = trap();
	state.stat = "initial-error";
	refusal(() => create(first()));
	expect(state.closes).toBe(1);
	expect(() => nativeStat(state.fd as number)).toThrow();
	create().exec("CREATE TABLE after_first_close_without_identity(x)");
	expect(nativeLstat(first()).size).toBe(0);
});

it.each(["always-error", "always-zero"] as const)(
	"unknown initial identity %s cannot be adopted from later metadata",
	(mode) => {
		const state = trap();
		state.stat = mode;
		state.close = "persistent";
		refusal(() => create(first()));
		expect(state.closes).toBe(1);
		state.stat = "none";
		state.close = "none";
		refusal(() => create());
		expect(state.closes).toBe(1);
		expect(state.secondLookups).toBe(0);
		// Simulate OS/process-owner teardown; only subsequent EBADF proves that unknown resource gone.
		nativeClose(state.fd as number);
		create().exec("CREATE TABLE after_original_resource_gone(x)");
		expect(nativeLstat(first()).size).toBe(0);
	},
);

it("retains no master-key authority while cleanup remains pending", () => {
	const state = trap(),
		identity = createEncryptedKeyIdentity();
	state.close = "persistent";
	refusal(() =>
		openEncrypted({ filename: first(), nativeBinding, create: true }, key, "db", identity),
	);
	expect(() => assertEncryptedKeyIdentity(identity, key)).toThrow("unavailable");
	key.destroy();
	key = new MasterKey(randomBytes(32));
	state.close = "none";
	create().exec("CREATE TABLE another_key_can_retry_native_cleanup(x)");
});
