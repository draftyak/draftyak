import { statSync, writeFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ExtensionError } from "../../src/extensions/errors.ts";
import { type ExtensionLogEntry, MODULE_TIMEOUT_MS } from "../../src/extensions/registry.ts";
import { systemClock, type TimerClock } from "../../src/kernel/clock.ts";
import { newId } from "../../src/kernel/ids.ts";
import { HUB_NAMESPACES } from "../../src/kernel/namespaces.ts";
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

let f: SessionFixture;
beforeEach(() => {
	resetTrace();
	f = sessionFixture();
});
afterEach(() => f.remove());

const user = newId(1);
const TABLES =
	"SELECT name FROM main.sqlite_schema WHERE type='table' AND name IN ('audit_meta','hub_meta') ORDER BY name";

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
		first.close();
		expectErased(key);
		expect(listing(f.folder)).toEqual(["draftyak.db"]);
		const second = await f.open();
		expect([second.hubId, second.hid, second.identity.certificate]).toEqual([
			first.hubId,
			first.hid,
			first.identity.certificate,
		]);
	});

	it("refuses another key without writing, deleting or creating an identity", async () => {
		const first = await f.open();
		first.close();
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
		expect(listing(f.folder)).toEqual(["draftyak.db"]);
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
			expect(listing(f.folder)).toEqual(["draftyak.db"]);
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
		session.close();
		await expectLocked(session);
		expectErased(key);
		session.close();
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
		first.close();
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
		first.close();
		const second = await f.open();
		expect(second.hubId).toBe(first.hubId);
	});

	it("ignores a repeated close of an earlier session while a later one holds the folder", async () => {
		const first = await f.open();
		first.close();
		const second = await f.open();
		first.close();
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
		session.close();
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
