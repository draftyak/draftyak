import { randomBytes } from "node:crypto";
import { linkSync, lstatSync, readFileSync, rmSync, unlinkSync } from "node:fs";
import path from "node:path";
import Database from "better-sqlite3-multiple-ciphers";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { MasterKey } from "../../src/kernel/master-key.ts";
import { openEncrypted, type SqliteDatabase } from "../../src/store/open.ts";
import { fixture, nativeBinding } from "./helpers.ts";

const nativeKey = Database.prototype.key,
	nativePragma = Database.prototype.pragma;
let f: Awaited<ReturnType<typeof fixture>>;
beforeEach(async () => {
	f = await fixture();
	f.store.write((tx) => tx.run("INSERT INTO test_rows VALUES('DYTEST-OPEN-GUARDS',1)"));
});
afterEach(() => {
	vi.restoreAllMocks();
	try {
		f.store.close();
	} finally {
		f.key.destroy();
	}
	rmSync(f.dir, { recursive: true, force: true });
});

it.each(["success", "wrong-key failure"])(
	"erases the exact transient native key buffer after %s",
	(outcome) => {
		let captured: Buffer | undefined,
			connection: SqliteDatabase | undefined,
			opened: SqliteDatabase | undefined,
			nonzeroAtApplication = false;
		const wrongBytes = randomBytes(32),
			wrong = new MasterKey(wrongBytes);
		wrongBytes.fill(0);
		const selected = outcome === "success" ? f.key : wrong;
		const before = readFileSync(f.filename);
		const spy = vi.spyOn(Database.prototype, "key").mockImplementation(function (
			this: SqliteDatabase,
			bytes,
		) {
			expect(Buffer.isBuffer(bytes)).toBe(true);
			captured = bytes as Buffer;
			connection = this;
			nonzeroAtApplication = captured.some((value) => value !== 0);
			return nativeKey.call(this, bytes);
		});
		try {
			const open = () => {
				opened = openEncrypted({ filename: f.filename, nativeBinding }, selected);
			};
			if (outcome === "success") {
				open();
				expect(opened?.prepare("SELECT id FROM test_rows").get()).toEqual({
					id: "DYTEST-OPEN-GUARDS",
				});
			} else {
				expect(open).toThrow();
				expect(connection?.open).toBe(false);
				expect(readFileSync(f.filename)).toEqual(before);
			}
			expect(nonzeroAtApplication).toBe(true);
			expect(captured).toBeDefined();
			expect(captured?.every((value) => value === 0)).toBe(true);
		} finally {
			captured?.fill(0);
			if (opened?.open) opened.close();
			if (connection?.open) connection.close();
			spy.mockRestore();
			wrong.destroy();
		}
		const reopened = openEncrypted({ filename: f.filename, nativeBinding }, f.key);
		try {
			expect(reopened.prepare("SELECT id FROM test_rows").get()).toEqual({
				id: "DYTEST-OPEN-GUARDS",
			});
		} finally {
			reopened.close();
		}
	},
);

it.each(["secure_delete", "fullfsync", "checkpoint_fullfsync"])(
	"refuses a real native %s mismatch and closes the unverified connection",
	(setting) => {
		let connection: SqliteDatabase | undefined, opened: SqliteDatabase | undefined, actual: unknown;
		const spy = vi.spyOn(Database.prototype, "pragma").mockImplementation(function (
			this: SqliteDatabase,
			source,
			options,
		) {
			connection = this;
			if (source === `${setting} = ON`) {
				const result = nativePragma.call(this, `${setting} = OFF`, options);
				actual = nativePragma.call(this, setting, { simple: true });
				return result;
			}
			return nativePragma.call(this, source, options);
		});
		try {
			expect(() => {
				opened = openEncrypted({ filename: f.filename, nativeBinding }, f.key);
			}).toThrow("Database settings were not confirmed");
			expect(actual).toBe(0);
			expect(connection?.open).toBe(false);
		} finally {
			if (opened?.open) opened.close();
			if (connection?.open) connection.close();
			spy.mockRestore();
		}
		const reopened = openEncrypted({ filename: f.filename, nativeBinding }, f.key);
		try {
			expect(reopened.pragma(setting, { simple: true })).toBe(1);
			expect(reopened.prepare("SELECT id FROM test_rows").get()).toEqual({
				id: "DYTEST-OPEN-GUARDS",
			});
		} finally {
			reopened.close();
		}
	},
);

it("sets both native full-sync flags before opening-time database configuration", () => {
	const checked: string[] = [];
	const spy = vi.spyOn(Database.prototype, "pragma").mockImplementation(function (
		this: SqliteDatabase,
		source,
		options,
	) {
		if (source === "auto_vacuum = INCREMENTAL" || source === "journal_mode = WAL") {
			expect(nativePragma.call(this, "fullfsync", { simple: true })).toBe(1);
			expect(nativePragma.call(this, "checkpoint_fullfsync", { simple: true })).toBe(1);
			checked.push(source);
		}
		return nativePragma.call(this, source, options);
	});
	let opened: SqliteDatabase | undefined;
	try {
		opened = openEncrypted(
			{ filename: path.join(f.dir, "opening-order.db"), nativeBinding, create: true },
			f.key,
		);
		expect(checked).toEqual(["auto_vacuum = INCREMENTAL", "journal_mode = WAL"]);
	} finally {
		if (opened?.open) opened.close();
		spy.mockRestore();
	}
});

it("refuses both names of a hardlinked encrypted database before applying a native key", () => {
	f.store.checkpoint();
	f.store.close();
	const alias = path.join(f.dir, "database-alias.db"),
		before = readFileSync(f.filename);
	linkSync(f.filename, alias);
	const identity = lstatSync(f.filename, { bigint: true });
	expect(identity.nlink).toBe(2n);
	expect(lstatSync(alias, { bigint: true }).ino).toBe(identity.ino);
	const keySpy = vi.spyOn(Database.prototype, "key"),
		pragmaSpy = vi.spyOn(Database.prototype, "pragma");
	try {
		for (const filename of [f.filename, alias]) {
			let opened: SqliteDatabase | undefined;
			try {
				expect(() => {
					opened = openEncrypted({ filename, nativeBinding }, f.key);
				}).toThrow("Existing database is invalid");
			} finally {
				if (opened?.open) opened.close();
			}
			expect(readFileSync(filename)).toEqual(before);
			const after = lstatSync(filename, { bigint: true });
			expect([after.dev, after.ino, after.nlink]).toEqual([identity.dev, identity.ino, 2n]);
		}
		expect(keySpy).not.toHaveBeenCalled();
		expect(pragmaSpy).not.toHaveBeenCalled();
	} finally {
		keySpy.mockRestore();
		pragmaSpy.mockRestore();
		unlinkSync(alias);
	}
	const reopened = openEncrypted({ filename: f.filename, nativeBinding }, f.key);
	try {
		expect(reopened.prepare("SELECT id FROM test_rows").get()).toEqual({
			id: "DYTEST-OPEN-GUARDS",
		});
	} finally {
		reopened.close();
	}
});
