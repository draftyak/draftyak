import { randomBytes } from "node:crypto";
import fs, { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { createRequire, syncBuiltinESMExports } from "node:module";
import os from "node:os";
import path from "node:path";
import Database from "better-sqlite3-multiple-ciphers";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { MasterKey } from "../../src/kernel/master-key.ts";
import {
	assertEncryptedKeyIdentity,
	createEncryptedKeyIdentity,
	openEncrypted,
	type SqliteDatabase,
} from "../../src/store/open.ts";
import { nativeBinding } from "./helpers.ts";

const require = createRequire(import.meta.url);
const addon = require(nativeBinding) as { Database: { prototype: { close(): unknown } } };
const nativeClose = addon.Database.prototype.close;
const wrapperClose = Database.prototype.close,
	nativePragma = Database.prototype.pragma,
	nativeKey = Database.prototype.key,
	nativeLstat = fs.lstatSync;
const databases = new Set<SqliteDatabase>();
const keys: MasterKey[] = [];
const cleanupFailure = "Database initialization cleanup unavailable";
let directory: string, key: MasterKey;
const first = (): string => path.join(directory, "failed.db"),
	second = (): string => path.join(directory, "next.db");
function newKey(): MasterKey {
	const bytes = randomBytes(32),
		result = new MasterKey(bytes);
	bytes.fill(0);
	keys.push(result);
	return result;
}
function create(filename = second(), create = true, masterKey = key): SqliteDatabase {
	const result = openEncrypted({ filename, nativeBinding, create }, masterKey);
	databases.add(result);
	return result;
}
beforeEach(() => {
	directory = realpathSync(mkdtempSync(path.join(os.tmpdir(), "dy-open-db-resource-")));
	key = newKey();
});
afterEach(() => {
	vi.restoreAllMocks();
	syncBuiltinESMExports();
	for (const db of databases) if (db.open) wrapperClose.call(db);
	databases.clear();
	// A later ordinary open clears only proven-closed private cleanup state.
	const probe = create(path.join(directory, "cleanup-probe.db"), true, newKey());
	probe.close();
	databases.clear();
	for (const held of keys.splice(0)) held.destroy();
	rmSync(directory, { recursive: true, force: true });
});

type CloseMode = "persistent" | "once-before" | "after" | "none";
function fault(point: "settings" | "key" = "settings") {
	const state = {
		lost: undefined as SqliteDatabase | undefined,
		native: undefined as object | undefined,
		close: "persistent" as CloseMode,
		fail: true,
		closes: 0,
		lookups: 0,
		initialized: new Set<SqliteDatabase>(),
	};
	vi.spyOn(Database.prototype, "pragma").mockImplementation(function (
		this: SqliteDatabase,
		source,
		options,
	) {
		databases.add(this);
		state.initialized.add(this);
		const result = nativePragma.call(this, source, options);
		if (state.fail && point === "settings" && source === "trusted_schema = OFF") {
			state.lost = this;
			throw Error(`private-initialization-canary ${source}`);
		}
		return result;
	});
	vi.spyOn(Database.prototype, "key").mockImplementation(function (this: SqliteDatabase, bytes) {
		const result = nativeKey.call(this, bytes);
		if (state.fail && point === "key") {
			state.lost = this;
			throw Error("private-initialization-canary key");
		}
		return result;
	});
	vi.spyOn(addon.Database.prototype, "close").mockImplementation(function (this: object) {
		if (!state.native) state.native = this;
		if (this !== state.native) return nativeClose.call(this);
		state.closes++;
		if (state.close === "persistent") throw Error("private-native-close-before-effect");
		if (state.close === "once-before") {
			state.close = "none";
			throw Error("private-native-close-before-effect");
		}
		if (state.close === "after") {
			state.close = "none";
			nativeClose.call(this);
			throw Error("private-native-close-after-effect");
		}
		return nativeClose.call(this);
	});
	vi.spyOn(fs, "lstatSync").mockImplementation((filename, options) => {
		if (String(filename) === second()) state.lookups++;
		return nativeLstat(filename, options);
	});
	syncBuiltinESMExports();
	return state;
}
function refused(work: () => unknown): void {
	let error: unknown;
	try {
		work();
	} catch (value) {
		error = value;
	}
	expect(error).toBeInstanceOf(Error);
	expect((error as Error).message).toBe(cleanupFailure);
	expect(String(error)).not.toContain(directory);
	expect(String(error)).not.toContain("private-");
}

it("retains the actual keyed connection and blocks subsequent creation before any requested-file lookup", () => {
	const state = fault();
	refused(() => create(first()));
	expect(state.lost?.open).toBe(true);
	expect(state.lost?.prepare("SELECT count(*) n FROM sqlite_schema").get()).toEqual({ n: 0 });
	for (let count = 0; count < 3; count++) refused(() => create());
	expect(state.closes).toBe(4);
	expect(state.initialized.size).toBe(1);
	expect(state.lookups).toBe(0);
	expect(existsSync(second())).toBe(false);
	state.close = "none";
	state.fail = false;
	const recovered = create();
	expect(state.lost?.open).toBe(false);
	recovered.exec("CREATE TABLE healed(value TEXT)");
	expect(recovered.prepare("SELECT name FROM sqlite_schema WHERE name='healed'").get()).toEqual({
		name: "healed",
	});
});

it("also blocks reopening an existing database without touching its bytes or unrelated native owner", () => {
	const existing = create();
	existing.exec("CREATE TABLE intact(value TEXT)");
	existing.prepare("INSERT INTO intact VALUES(?)").run("EXISTING_ENCRYPTED_CANARY");
	existing.pragma("wal_checkpoint(TRUNCATE)");
	const before = readFileSync(second());
	const state = fault();
	refused(() => create(first()));
	refused(() => create(second(), false));
	expect(state.lookups).toBe(0);
	expect(state.initialized.size).toBe(1);
	expect(existing.open).toBe(true);
	expect(existing.prepare("SELECT value FROM intact").get()).toEqual({
		value: "EXISTING_ENCRYPTED_CANARY",
	});
	expect(readFileSync(second())).toEqual(before);
	state.fail = false;
	state.close = "none";
	expect(create(second(), false).prepare("SELECT value FROM intact").get()).toEqual({
		value: "EXISTING_ENCRYPTED_CANARY",
	});
	expect(existing.open).toBe(true);
});

it("retries a transient before-effect failure on the original object only", () => {
	const state = fault();
	state.close = "once-before";
	refused(() => create(first()));
	expect(state.lost?.open).toBe(true);
	expect(state.closes).toBe(1);
	state.fail = false;
	create().exec("CREATE TABLE after_retry(value)");
	expect(state.closes).toBe(2);
	expect(state.lost?.open).toBe(false);
});

it("proves an after-effect close is complete without retrying a closed native connection", () => {
	const state = fault();
	state.close = "after";
	expect(() => create(first())).toThrow("private-initialization-canary");
	expect(state.lost?.open).toBe(false);
	expect(state.closes).toBe(1);
	state.fail = false;
	create().exec("CREATE TABLE after_native_close(value)");
	expect(state.closes).toBe(1);
});

it("does not replace the retained close operation with a later prototype callback", () => {
	const state = fault();
	refused(() => create(first()));
	const replacement = vi.spyOn(Database.prototype, "close").mockImplementation(() => {
		throw Error("replacement-close-must-not-run");
	});
	state.fail = false;
	state.close = "none";
	create().exec("CREATE TABLE captured_native_close(value)");
	expect(replacement).not.toHaveBeenCalled();
	expect(state.lost?.open).toBe(false);
});

it("observes already-closed original state without closing an unrelated later connection", () => {
	const state = fault();
	refused(() => create(first()));
	state.close = "none";
	wrapperClose.call(state.lost);
	expect(state.lost?.open).toBe(false);
	const closes = state.closes;
	state.close = "persistent";
	state.fail = false;
	create().exec("CREATE TABLE original_already_closed(value)");
	expect(state.closes).toBe(closes);
});

it("erases failed key identity and needs no surviving caller master-key authority for native cleanup", () => {
	const state = fault(),
		identity = createEncryptedKeyIdentity();
	refused(() =>
		openEncrypted({ filename: first(), nativeBinding, create: true }, key, "db", identity),
	);
	expect(() => assertEncryptedKeyIdentity(identity, key)).toThrow("Database key unavailable");
	key.destroy();
	expect(() => key.derive("db")).toThrow("Hub is locked");
	key = newKey();
	refused(() => create());
	state.fail = false;
	state.close = "none";
	const db = create();
	db.exec("CREATE TABLE other_key(value TEXT)");
	db.prepare("INSERT INTO other_key VALUES(?)").run("NO_CALLER_KEY_RETAINED");
	db.pragma("wal_checkpoint(TRUNCATE)");
	expect(readFileSync(second()).includes(Buffer.from("NO_CALLER_KEY_RETAINED"))).toBe(false);
});

it("redacts a private initializer error containing the key pragma when native close remains unproven", () => {
	const state = fault("key"),
		bytes = key.derive("db"),
		hex = bytes.toString("hex");
	bytes.fill(0);
	let error: unknown;
	try {
		create(first());
	} catch (value) {
		error = value;
	}
	expect(String(error)).toBe(`Error: ${cleanupFailure}`);
	expect(String(error)).not.toContain(hex);
	expect(String(error)).not.toContain("hexkey");
	expect(String(error)).not.toContain(directory);
	state.fail = false;
	state.close = "none";
	create().exec("CREATE TABLE after_redacted_failure(value)");
});

it("preserves actual encrypted key verification after initialization cleanup recovers", () => {
	const state = fault();
	refused(() => create(first()));
	state.fail = false;
	state.close = "none";
	const db = create(first(), false);
	expect(state.lost?.open).toBe(false);
	db.exec("CREATE TABLE verified(value TEXT)");
	db.prepare("INSERT INTO verified VALUES(?)").run("SQLITE_ENCRYPTED_RECOVERY_CANARY");
	db.close();
	expect(readFileSync(first()).includes(Buffer.from("SQLITE_ENCRYPTED_RECOVERY_CANARY"))).toBe(
		false,
	);
	expect(create(first(), false).prepare("SELECT value FROM verified").get()).toEqual({
		value: "SQLITE_ENCRYPTED_RECOVERY_CANARY",
	});
	expect(() => create(first(), false, newKey())).toThrow();
});
