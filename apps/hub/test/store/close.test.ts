import { randomBytes } from "node:crypto";
import { rmSync } from "node:fs";
import { createRequire } from "node:module";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { MasterKey } from "../../src/kernel/master-key.ts";
import { HubStore } from "../../src/store/store.ts";
import { fixture, nativeBinding } from "./helpers.ts";

const require = createRequire(import.meta.url);
const addon = require(nativeBinding) as { Database: { prototype: { close(): unknown } } };
const nativeClose = addon.Database.prototype.close;
let f: Awaited<ReturnType<typeof fixture>>;
const opened: HubStore[] = [];
beforeEach(async () => {
	f = await fixture();
});
afterEach(() => {
	vi.restoreAllMocks();
	f.store.close();
	for (const store of opened.splice(0)) store.close();
	f.key.destroy();
	rmSync(f.dir, { recursive: true, force: true });
});
function reopen(): HubStore {
	const store = new HubStore({
		filename: f.filename,
		nativeBinding,
		masterKey: f.key,
		migrations: f.migrations,
	});
	opened.push(store);
	return store;
}

it("retains the actual connection after a failed close while permanently revoking its SQL and key authority", async () => {
	let blocked = true;
	let attempts = 0;
	const spy = vi.spyOn(addon.Database.prototype, "close").mockImplementation(function (
		this: object,
	) {
		attempts++;
		if (blocked) throw Error("PRIVATE_NATIVE_CLOSE_CANARY");
		return nativeClose.call(this);
	});
	expect(() => f.store.close()).toThrow(/^Database cleanup unavailable$/);
	expect(() => f.store.read((db) => db.get("SELECT 1"))).toThrow("unavailable");
	expect(() => f.store.write((tx) => tx.run("INSERT INTO test_rows VALUES('late',1)"))).toThrow(
		"unavailable",
	);
	await expect(f.store.migrate("core")).rejects.toThrow("unavailable");
	expect(() => f.store.checkpoint()).toThrow("unavailable");
	expect(() => f.store.assertMasterKey(f.key)).toThrow("key unavailable");
	expect(() => f.store.close()).toThrow(/^Database cleanup unavailable$/);
	expect(attempts).toBe(2);
	blocked = false;
	f.store.close();
	expect(attempts).toBe(3);
	f.store.close();
	expect(attempts).toBe(3);
	const derived = f.key.derive("db");
	expect(derived).toHaveLength(32);
	derived.fill(0);
	spy.mockRestore();
	expect(reopen().read((db) => db.all("SELECT * FROM test_rows"))).toEqual([]);
});

it("recognizes an after-effect native close without closing a replacement connection", () => {
	let calls = 0;
	vi.spyOn(addon.Database.prototype, "close").mockImplementation(function (this: object) {
		calls++;
		nativeClose.call(this);
		throw Error("PRIVATE_AFTER_CLOSE_CANARY");
	});
	expect(() => f.store.close()).not.toThrow();
	expect(calls).toBe(1);
	const replacement = reopen();
	f.store.close();
	expect(calls).toBe(1);
	expect(replacement.read((db) => db.get("SELECT 42 AS answer"))).toEqual({ answer: 42 });
});

it("uses the captured close operation even if the wrapper prototype changes", async () => {
	const { default: Database } = await import("better-sqlite3-multiple-ciphers");
	const replacement = vi.spyOn(Database.prototype, "close").mockImplementation(() => {
		throw Error("REPLACEMENT_CLOSE_MUST_NOT_RUN");
	});
	f.store.close();
	expect(replacement).not.toHaveBeenCalled();
	expect(reopen().read((db) => db.get("SELECT 1 AS value"))).toEqual({ value: 1 });
});

it("refuses a busy close without revoking a still-active transaction", () => {
	f.store.write((tx) => {
		expect(() => f.store.close()).toThrow("in use");
		tx.run("INSERT INTO test_rows VALUES('still-active',1)");
	});
	f.store.assertMasterKey(f.key);
	expect(f.store.read((db) => db.get("SELECT id FROM test_rows"))).toEqual({ id: "still-active" });
});

it("compares actual encrypted key identity and leaves caller key lifetime independent", () => {
	const wrong = new MasterKey(randomBytes(32));
	try {
		f.store.assertMasterKey(f.key);
		expect(() => f.store.assertMasterKey(wrong)).toThrow("key unavailable");
		f.store.close();
		expect(() => f.store.assertMasterKey(f.key)).toThrow("key unavailable");
		const bytes = f.key.derive("db");
		expect(bytes).toHaveLength(32);
		bytes.fill(0);
	} finally {
		wrong.destroy();
	}
});
