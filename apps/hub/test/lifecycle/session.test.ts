import { statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ExtensionError } from "../../src/extensions/errors.ts";
import { type ExtensionLogEntry, MODULE_TIMEOUT_MS } from "../../src/extensions/registry.ts";
import { systemClock, type TimerClock } from "../../src/kernel/clock.ts";
import { admitDataFolder, type DataFolder } from "../../src/kernel/data-directory.ts";
import { newId } from "../../src/kernel/ids.ts";
import { HUB_NAMESPACES } from "../../src/kernel/namespaces.ts";
import { assertHubSessionAdmission, HubSessionError } from "../../src/lifecycle/session.ts";
import { HubStore } from "../../src/store/store.ts";
import { resetTrace, trace } from "../extensions/helpers.ts";
import {
	configureModule,
	digest,
	expectErased,
	expectLocked,
	expectUsable,
	listing,
	nativeBinding,
	noRows,
	PIN,
	refusal,
	type SessionFixture,
	sessionFixture,
} from "./session-helpers.ts";

const admissions = vi.hoisted(() => ({
	opened: [] as { folder: string; admission: DataFolder }[],
}));
vi.mock("../../src/kernel/data-directory.ts", async (importOriginal) => {
	const actual = await importOriginal<typeof import("../../src/kernel/data-directory.ts")>();
	return {
		...actual,
		admitDataFolder: (...args: Parameters<typeof actual.admitDataFolder>) => {
			const admission = actual.admitDataFolder(...args);
			admissions.opened.push({ folder: args[0], admission });
			return admission;
		},
	};
});

let f: SessionFixture;
beforeEach(() => {
	resetTrace();
	admissions.opened.length = 0;
	f = sessionFixture();
});
afterEach(() => f.remove());

const user = newId(1);
const TABLES =
	"SELECT name FROM main.sqlite_schema WHERE type='table' AND name IN ('audit_meta','hub_meta') ORDER BY name";

function admissionRefusal(operation: () => unknown): void {
	let error: unknown;
	try {
		operation();
	} catch (reason) {
		error = reason;
	}
	expect(error).toBeInstanceOf(HubSessionError);
	expect(error).toMatchObject({
		name: "HubSessionError",
		code: "SESSION_UNAVAILABLE",
		message: "SESSION_UNAVAILABLE",
	});
	expect(Object.hasOwn(error as object, "cause")).toBe(false);
	expect(String(error)).not.toContain(f.folder);
}

describe("original session admission", () => {
	it("returns undefined for a fresh unbootstrapped session without plugin state or writes", async () => {
		const session = await f.open();
		const state = session.devices.currentState();
		expect(state.bootstrapDone).toBe(false);
		expect(state.ownerUserId).toBeNull();
		const before = { files: listing(f.folder), schema: session.store.read((db) => db.all(TABLES)) };
		expect(before.files).not.toContain("plugins");
		for (let check = 0; check < 2; check++)
			expect(assertHubSessionAdmission(session)).toBeUndefined();
		expect(session.devices.currentState()).toEqual(state);
		expect({
			files: listing(f.folder),
			schema: session.store.read((db) => db.all(TABLES)),
		}).toEqual(before);
		expect(trace()).toEqual([]);
	});

	it("rejects forged, inherited, copied and proxy sessions without reading caller fields", async () => {
		const session = await f.open();
		let reads = 0;
		const trap = (): never => {
			reads++;
			throw new Error("DYTEST caller field evaluated");
		};
		const handlers = {
			get: trap,
			getPrototypeOf: trap,
			getOwnPropertyDescriptor: trap,
			ownKeys: trap,
		};
		const proxy = new Proxy(session, handlers);
		const revoked = Proxy.revocable(session, handlers);
		revoked.revoke();
		const accessor = Object.defineProperty({}, "store", { get: trap });
		const copy = { ...session };
		for (const candidate of [
			undefined,
			null,
			false,
			1,
			"session",
			() => session,
			[],
			{},
			copy,
			Object.create(session),
			Object.assign(Object.create(null), session),
			accessor,
			proxy,
			revoked.proxy,
		])
			admissionRefusal(() => assertHubSessionAdmission(candidate));
		admissionRefusal(() => Reflect.apply(assertHubSessionAdmission, session, []));
		admissionRefusal(() => Reflect.apply(assertHubSessionAdmission, session, [copy]));
		expect(Reflect.apply(assertHubSessionAdmission, proxy, [session])).toBeUndefined();
		expect(reads).toBe(0);
	});

	it("never revives an earlier session when a new genuine session owns the folder", async () => {
		const first = await f.open();
		await first.close();
		admissionRefusal(() => assertHubSessionAdmission(first));
		const second = await f.open();
		expect(assertHubSessionAdmission(second)).toBeUndefined();
		admissionRefusal(() => assertHubSessionAdmission(first));
	});

	it("uses the captured genuine Store key check despite an instance method replacement", async () => {
		const session = await f.open();
		const before = Object.getOwnPropertyDescriptor(session.store, "assertMasterKey");
		let spoofed = 0;
		Object.defineProperty(session.store, "assertMasterKey", {
			configurable: true,
			value: () => {
				spoofed++;
			},
		});
		try {
			expect(assertHubSessionAdmission(session)).toBeUndefined();
			session.store.close();
			admissionRefusal(() => assertHubSessionAdmission(session));
			expect(spoofed).toBe(0);
		} finally {
			if (before) Object.defineProperty(session.store, "assertMasterKey", before);
			else Reflect.deleteProperty(session.store, "assertMasterKey");
		}
	});

	it("rejects the destroyed original key despite a public derivation replacement", async () => {
		const key = f.key();
		const session = await f.open({ masterKey: key });
		const before = Object.getOwnPropertyDescriptor(key, "derive");
		let spoofed = 0;
		Object.defineProperty(key, "derive", {
			configurable: true,
			value: () => {
				spoofed++;
				return Buffer.alloc(32);
			},
		});
		try {
			expect(assertHubSessionAdmission(session)).toBeUndefined();
			key.destroy();
			admissionRefusal(() => assertHubSessionAdmission(session));
			expect(spoofed).toBe(0);
		} finally {
			if (before) Object.defineProperty(key, "derive", before);
			else Reflect.deleteProperty(key, "derive");
		}
	});

	it("cannot replace its released original admission with a newly acquired real lease", async () => {
		const session = await f.open();
		const original = admissions.opened.findLast((entry) => entry.folder === f.folder)?.admission;
		if (!original) throw new Error("Original session admission was not captured");
		expect(assertHubSessionAdmission(session)).toBeUndefined();
		original.release();
		admissionRefusal(() => assertHubSessionAdmission(session));
		const replacement = admitDataFolder(f.folder, { nativeBinding });
		try {
			expect(replacement).not.toBe(original);
			expect(() => replacement.assertHeld()).not.toThrow();
			admissionRefusal(() => assertHubSessionAdmission(session));
			expect(() => replacement.assertHeld()).not.toThrow();
			expect(replacement.path).toBe(f.folder);
			expect(replacement.runPath).toBe(path.join(f.folder, "run"));
		} finally {
			replacement.release();
		}
	});
});

describe("open", () => {
	it("creates the hub on a first run and reopens it with the same key", async () => {
		const key = f.key();
		const first = await f.open({ masterKey: key });
		expect(first.hubId).toMatch(/^DYK-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{4}$/);
		expect([first.hubId, first.hid]).toEqual([first.identity.hubId, first.identity.hid]);
		expect(first.store.read((db) => db.all(TABLES))).toEqual([
			{ name: "audit_meta" },
			{ name: "hub_meta" },
		]);
		first.store.read((db) => first.audit.verify(db));
		expect(first.extensions.modules).toEqual([]);
		await first.close();
		expectErased(key);
		expect(listing(f.folder)).toEqual(["draftyak.db", "run"]);
		const second = await f.open();
		expect([second.hubId, second.hid, second.identity.certificate]).toEqual([
			first.hubId,
			first.hid,
			first.identity.certificate,
		]);
	});

	it("refuses another key without writing, deleting or creating an identity", async () => {
		const first = await f.open();
		await first.close();
		const before = { files: listing(f.folder), hash: digest(f.database) };
		const wrong = f.otherKey();
		expect((await refusal(f.open({ masterKey: wrong }))).code).toBe("UNLOCK_REFUSED");
		expectErased(wrong);
		expect({ files: listing(f.folder), hash: digest(f.database) }).toEqual(before);
		expect((await f.open()).hubId).toBe(first.hubId);
	});

	it("refuses an empty database file with M2.1's instruction and keeps it", async () => {
		writeFileSync(f.database, "");
		const key = f.key();
		const error = await refusal(f.open({ masterKey: key }));
		expect([error.code, error.message]).toEqual([
			"FIRST_RUN_INTERRUPTED",
			"Database was never initialized; remove this unused empty database before creating it again",
		]);
		expectErased(key);
		expect(listing(f.folder)).toEqual(["draftyak.db", "run"]);
		expect(statSync(f.database).size).toBe(0);
	});

	// Any open with the right key re-encrypts the header, so this compares the schema, not the bytes.
	it("refuses an encrypted database without audit storage and adds nothing to it", async () => {
		new HubStore({
			filename: f.database,
			nativeBinding,
			masterKey: f.key(),
			create: true,
			migrations: HUB_NAMESPACES,
		}).close();
		expect(statSync(f.database).size).toBeGreaterThan(0);
		for (let attempt = 0; attempt < 2; attempt++) {
			const key = f.key();
			const error = await refusal(f.open({ masterKey: key }));
			expect([error.code, error.message]).toEqual([
				"FIRST_RUN_INTERRUPTED",
				"Audit storage is missing or incomplete. Restore a valid backup; remove and recreate the database only if it was never used.",
			]);
			expectErased(key);
			expect(listing(f.folder)).toEqual(["draftyak.db", "run"]);
		}
		const check = new HubStore({ filename: f.database, nativeBinding, masterKey: f.key() });
		try {
			expect(check.read((db) => db.all("SELECT type, name FROM main.sqlite_schema"))).toEqual([]);
		} finally {
			check.close();
		}
	});
});

describe("close", () => {
	it("closes the extensions, locks every service and erases the key", async () => {
		const key = f.key();
		const session = await f.open({ masterKey: key });
		session.identity.tlsPrivateKey().fill(0);
		await expect(session.pins.verify("not-a-user", PIN, "approval")).rejects.toThrow("PIN_INVALID");
		expect(() => session.audit.verify(noRows)).toThrow("Audit head verification failed");
		expectUsable(key);
		await session.close();
		await expectLocked(session);
		expectErased(key);
		await session.close();
		expectErased(key);
	});

	it("refuses an earlier session's PIN proof and audit key in the next session", async () => {
		const wall = 1_800_000_000_000;
		const clock = { ...systemClock, wallMs: () => wall };
		const first = await f.open({ clock });
		expect(first.pins).toBe(first.pins);
		first.store.write((tx) =>
			tx.run("INSERT INTO main.users(id,created_at) VALUES(?,?)", [user, 1]),
		);
		await first.pins.initialize(user, PIN);
		const proof = await first.pins.verify(user, PIN, "approval");
		await first.close();
		await expect(first.pins.verify(user, PIN, "approval")).rejects.toThrow("PIN_REQUIRED");
		const second = await f.open({ clock });
		expect(() =>
			second.store.write((tx) => second.pins.consume(tx, proof, user, "approval")),
		).toThrow("PIN_REQUIRED");
		expect(() => second.store.read((db) => first.audit.verify(db))).toThrow("Audit is locked");
		const events = second.store
			.read((db) => second.audit.exportVerifiedJsonl(db))
			.jsonl.trim()
			.split("\n")
			.map((line) => JSON.parse(line) as { action: string; at: number });
		expect(events.map(({ action, at }) => [action, at])).toEqual([
			["pin.initialized", wall],
			["pin.verified", wall],
		]);
		const fresh = await second.pins.verify(user, PIN, "approval");
		second.store.write((tx) => second.pins.consume(tx, fresh, user, "approval"));
	});

	it("opens a second session for the folder only after the first one closes", async () => {
		const first = await f.open();
		const waiting = f.key();
		expect((await refusal(f.open({ masterKey: waiting }))).code).toBe("SESSION_ACTIVE");
		expectErased(waiting);
		first.store.read((db) => first.audit.verify(db));
		first.identity.tlsPrivateKey().fill(0);
		await first.close();
		const second = await f.open();
		expect(second.hubId).toBe(first.hubId);
	});

	it("ignores a repeated close of an earlier session while a later one holds the folder", async () => {
		const first = await f.open();
		await first.close();
		const second = await f.open();
		await first.close();
		const waiting = f.key();
		expect((await refusal(f.open({ masterKey: waiting }))).code).toBe("SESSION_ACTIVE");
		expectErased(waiting);
		second.store.read((db) => second.audit.verify(db));
		second.identity.tlsPrivateKey().fill(0);
	});
});

describe("extensions", () => {
	it("starts one configured module with the session and retires it on close", async () => {
		configureModule(f, "probe", `registry.log.info("probe.ready");`);
		const logged: ExtensionLogEntry[] = [];
		const session = await f.open({ log: (logEntry) => logged.push(logEntry) });
		expect(session.extensions.modules).toEqual([{ id: "probe", version: "1.0.0" }]);
		expect(trace()).toEqual(["probe:loaded", "probe:register"]);
		expect(logged).toEqual([{ module: "probe", level: "info", action: "probe.ready", refs: {} }]);
		const [sink] = session.extensions.providers("auditSink");
		expect(sink?.id).toBe("sink");
		expect(listing(f.folder)).toContain("ext-probe.db");
		await session.close();
		expect(session.extensions.providers("auditSink")).toEqual([]);
		expect(() => sink?.append({} as never)).toThrow(ExtensionError);
		const reopened = await f.open();
		expect(reopened.extensions.modules).toEqual([{ id: "probe", version: "1.0.0" }]);
	});

	it("bounds module loading with the session's clock", async () => {
		configureModule(f, "probe");
		const calls: string[] = [];
		const clock: TimerClock = {
			wallMs: () => systemClock.wallMs(),
			monotonicMs: () => {
				calls.push("monotonicMs");
				return systemClock.monotonicMs();
			},
			after: (ms, signal) => {
				calls.push(`after ${ms}`);
				return systemClock.after(ms, signal);
			},
		};
		const session = await f.open({ clock });
		expect(session.extensions.modules).toEqual([{ id: "probe", version: "1.0.0" }]);
		expect(calls).toContain("monotonicMs");
		expect(calls).toContain(`after ${MODULE_TIMEOUT_MS}`);
	});
});
