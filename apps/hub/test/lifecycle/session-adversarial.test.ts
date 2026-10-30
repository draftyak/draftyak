import { mkdirSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import { inspect } from "node:util";
import Database from "better-sqlite3-multiple-ciphers";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { systemClock } from "../../src/kernel/clock.ts";
import { MasterKey } from "../../src/kernel/master-key.ts";
import { HUB_NAMESPACES } from "../../src/kernel/namespaces.ts";
import {
	type HubSessionError,
	type HubSessionOptions,
	openHubSession,
} from "../../src/lifecycle/session.ts";
import { HubStore } from "../../src/store/store.ts";
import { blockNativeClose } from "../extensions/helpers.ts";
import {
	configureModule,
	digest,
	expectErased,
	expectLocked,
	expectUsable,
	listing,
	nativeBinding,
	refusal,
	refusalNow,
	type SessionFixture,
	sessionFixture,
} from "./session-helpers.ts";

let f: SessionFixture;
beforeEach(() => {
	f = sessionFixture();
});
afterEach(() => f.remove());

describe("options", () => {
	type Change = (options: Record<string, unknown>, f: SessionFixture) => void;
	const clockWithout = (name: string): Record<string, unknown> =>
		Object.fromEntries(Object.entries(systemClock).filter(([key]) => key !== name));
	const cases: [string, Change][] = [
		["a relative folder", (o) => Object.assign(o, { folder: "data" })],
		["a missing folder", (o, f) => Object.assign(o, { folder: path.join(f.folder, "missing") })],
		[
			"a file as the folder",
			(o, f) => {
				const file = path.join(f.scratch(), "file");
				writeFileSync(file, "");
				Object.assign(o, { folder: file });
			},
		],
		["a non-canonical spelling", (o, f) => Object.assign(o, { folder: `${f.folder}${path.sep}.` })],
		[
			"a folder reached through an alias",
			(o, f) => {
				const alias = path.join(f.scratch(), "alias");
				symlinkSync(path.dirname(f.folder), alias, "junction");
				Object.assign(o, { folder: path.join(alias, path.basename(f.folder)) });
			},
		],
		[
			"a relative binding",
			(o) => Object.assign(o, { nativeBinding: path.relative(process.cwd(), nativeBinding) }),
		],
		[
			"a binding that is not .node",
			(o, f) => {
				const file = path.join(f.scratch(), "binding.txt");
				writeFileSync(file, "");
				Object.assign(o, { nativeBinding: file });
			},
		],
		[
			"a missing binding",
			(o, f) => Object.assign(o, { nativeBinding: path.join(f.scratch(), "missing.node") }),
		],
		[
			"a folder as the binding",
			(o, f) => {
				const folder = path.join(f.scratch(), "folder.node");
				mkdirSync(folder);
				Object.assign(o, { nativeBinding: folder });
			},
		],
		["a null clock", (o) => Object.assign(o, { clock: null })],
		["a clock that is not an object", (o) => Object.assign(o, { clock: 5 })],
		["a proxied clock", (o) => Object.assign(o, { clock: new Proxy(systemClock, {}) })],
		["an empty clock", (o) => Object.assign(o, { clock: {} })],
		["a clock without wallMs", (o) => Object.assign(o, { clock: clockWithout("wallMs") })],
		[
			"a clock without monotonicMs",
			(o) => Object.assign(o, { clock: clockWithout("monotonicMs") }),
		],
		["a clock without after", (o) => Object.assign(o, { clock: clockWithout("after") })],
		[
			"a clock whose after is an accessor",
			(o) => {
				const clock = { ...systemClock };
				Object.defineProperty(clock, "after", { enumerable: true, get: () => systemClock.after });
				Object.assign(o, { clock });
			},
		],
		[
			"a clock with a proxied after",
			(o) =>
				Object.assign(o, { clock: { ...systemClock, after: new Proxy(systemClock.after, {}) } }),
		],
		["a log that is not a function", (o) => Object.assign(o, { log: "log" })],
		["a proxied log", (o) => Object.assign(o, { log: new Proxy(() => {}, {}) })],
		["an unknown option", (o) => Object.assign(o, { create: true })],
		[
			"an accessor option",
			(o) => {
				const folder = o.folder;
				Object.defineProperty(o, "folder", { enumerable: true, get: () => folder });
			},
		],
	];

	it.each(cases)("refuses %s, erases the key and writes nothing", async (_name, change) => {
		const key = f.key();
		const options: Record<string, unknown> = { folder: f.folder, nativeBinding, masterKey: key };
		change(options, f);
		const error = await refusal(openHubSession(options as unknown as HubSessionOptions));
		expect(error.code).toBe("SESSION_OPTIONS");
		expectErased(key);
		expect(listing(f.folder)).toEqual([]);
	});

	it.each([
		["no options", () => undefined],
		["a plain object as the key", () => ({})],
		["bytes as the key", () => Buffer.alloc(32, 7)],
	])("refuses %s", async (_name, masterKey) => {
		const options =
			masterKey() === undefined
				? undefined
				: { folder: f.folder, nativeBinding, masterKey: masterKey() };
		const error = await refusal(openHubSession(options as unknown as HubSessionOptions));
		expect(error.code).toBe("SESSION_OPTIONS");
		expect(listing(f.folder)).toEqual([]);
	});

	it("never runs an accessor to find the key, and cannot erase a key behind a proxy", async () => {
		const key = f.key();
		let reads = 0;
		const options = { folder: f.folder, nativeBinding };
		Object.defineProperty(options, "masterKey", {
			enumerable: true,
			get: () => {
				reads++;
				return key;
			},
		});
		expect((await refusal(openHubSession(options as HubSessionOptions))).code).toBe(
			"SESSION_OPTIONS",
		);
		expect(reads).toBe(0);
		const proxied = f.key();
		let traps = 0;
		const masterKey = new Proxy(proxied, {
			getPrototypeOf: (target) => {
				traps++;
				return Reflect.getPrototypeOf(target);
			},
		});
		expect(
			(await refusal(openHubSession({ folder: f.folder, nativeBinding, masterKey }))).code,
		).toBe("SESSION_OPTIONS");
		expect(traps).toBe(0);
		expectUsable(key);
		expectUsable(proxied);
		expect(listing(f.folder)).toEqual([]);
	});

	it("refuses proxied options without running a trap, leaving the key behind them", async () => {
		const key = f.key();
		let traps = 0;
		const count = <T>(result: T): T => {
			traps++;
			return result;
		};
		const options = new Proxy(
			{ folder: f.folder, nativeBinding, masterKey: key },
			{
				get: (target, name, receiver) => count(Reflect.get(target, name, receiver)),
				getOwnPropertyDescriptor: (target, name) =>
					count(Reflect.getOwnPropertyDescriptor(target, name)),
				getPrototypeOf: (target) => count(Reflect.getPrototypeOf(target)),
				has: (target, name) => count(Reflect.has(target, name)),
				ownKeys: (target) => count(Reflect.ownKeys(target)),
			},
		);
		expect((await refusal(openHubSession(options))).code).toBe("SESSION_OPTIONS");
		expect(traps).toBe(0);
		expectUsable(key);
		expect(listing(f.folder)).toEqual([]);
	});

	it("refuses a forged key before any file is created", async () => {
		const forged = Object.create(MasterKey.prototype) as MasterKey;
		const error = await refusal(
			openHubSession({ folder: f.folder, nativeBinding, masterKey: forged }),
		);
		expect(error.code).toBe("STORE_UNAVAILABLE");
		expect(listing(f.folder)).toEqual([]);
	});
});

describe("first run", () => {
	it.each([
		"draftyak.db-wal",
		"draftyak.db-shm",
		"draftyak.db-journal",
		"mk.recovery",
		"MK.RECOVERY",
		"ext-probe.db",
		"ext-probe.db-wal",
		"ext-probe.db-shm",
		"ext-probe.db-journal",
	])("refuses to create a hub beside %s", async (name) => {
		writeFileSync(path.join(f.folder, name), "");
		const key = f.key();
		expect((await refusal(f.open({ masterKey: key }))).code).toBe("HUB_STATE_INCOMPLETE");
		expectErased(key);
		expect(listing(f.folder)).toEqual([name]);
	});

	it("creates a hub beside configuration, the wrapped key and the run folder", async () => {
		writeFileSync(path.join(f.folder, "config.json"), JSON.stringify({ modules: [] }));
		writeFileSync(path.join(f.folder, "mk.wrapped"), "");
		writeFileSync(path.join(f.folder, "draftyak.db.bak"), "");
		mkdirSync(path.join(f.folder, "run"));
		const session = await f.open();
		expect(session.extensions.modules).toEqual([]);
		session.close();
		expect(listing(f.folder)).toEqual([
			"config.json",
			"draftyak.db",
			"draftyak.db.bak",
			"mk.wrapped",
			"run",
		]);
	});

	it("refuses a lost database whose module database remains", async () => {
		const first = await f.open();
		first.close();
		writeFileSync(path.join(f.folder, "ext-probe.db"), "");
		rmSync(f.database);
		const key = f.key();
		expect((await refusal(f.open({ masterKey: key }))).code).toBe("HUB_STATE_INCOMPLETE");
		expectErased(key);
		expect(listing(f.folder)).toEqual(["ext-probe.db"]);
	});

	it("never creates over the empty file a failed first run of this process left", async () => {
		const garbage = path.join(f.scratch(), "garbage.node");
		writeFileSync(garbage, "DYTEST not a native module");
		const first = f.key();
		const failed = await refusal(f.open({ masterKey: first, nativeBinding: garbage }));
		expect(failed.code).toBe("STORE_UNAVAILABLE");
		expectErased(first);
		expect(listing(f.folder)).toEqual(["draftyak.db"]);
		const second = f.key();
		expect((await refusal(f.open({ masterKey: second }))).code).toBe("FIRST_RUN_INTERRUPTED");
		expectErased(second);
		expect(listing(f.folder)).toEqual(["draftyak.db"]);
		expect(statSync(f.database).size).toBe(0);
	});

	it("opens on the next try after a first run whose core migration failed", async () => {
		const migrate = HubStore.prototype.migrate;
		let faults = 1;
		const spy = vi.spyOn(HubStore.prototype, "migrate");
		spy.mockImplementation(function (this: HubStore, namespace: string) {
			if (namespace !== "core" || faults === 0) return migrate.call(this, namespace);
			faults--;
			return Promise.reject(new Error("DYTEST core migration fault"));
		});
		try {
			const key = f.key();
			expect((await refusal(f.open({ masterKey: key }))).code).toBe("STORE_UNAVAILABLE");
			expectErased(key);
			expect(listing(f.folder)).toEqual(["draftyak.db"]);
			const session = await f.open();
			session.store.read((db) => session.audit.verify(db));
			expect(spy.mock.calls).toEqual([
				["audit"],
				["core"],
				["audit"],
				["core"],
				["jobs"],
				["events"],
				["revisions"],
				["credentials"],
				["tickets"],
			]);
		} finally {
			spy.mockRestore();
		}
	});

	it("lets only one of two concurrent opens of a folder proceed", async () => {
		const keys = [f.key(), f.key()];
		const results = await Promise.allSettled(keys.map((masterKey) => f.open({ masterKey })));
		expect(results[0]?.status).toBe("fulfilled");
		expect(results[1]?.status).toBe("rejected");
		expect(((results[1] as PromiseRejectedResult).reason as HubSessionError).code).toBe(
			"SESSION_ACTIVE",
		);
		expectUsable(keys[0] as MasterKey);
		expectErased(keys[1] as MasterKey);
	});
});

describe("existing database", () => {
	it("refuses a plaintext database as a key it cannot open and leaves it unchanged", async () => {
		const plain = new Database(f.database, { nativeBinding });
		plain.exec("CREATE TABLE notes(body TEXT); INSERT INTO notes VALUES('DYTEST plaintext');");
		plain.close();
		const before = { files: listing(f.folder), hash: digest(f.database) };
		const key = f.key();
		expect((await refusal(f.open({ masterKey: key }))).code).toBe("UNLOCK_REFUSED");
		expectErased(key);
		expect({ files: listing(f.folder), hash: digest(f.database) }).toEqual(before);
	});

	it("refuses a database path that is not a regular file", async () => {
		mkdirSync(f.database);
		const key = f.key();
		expect((await refusal(f.open({ masterKey: key }))).code).toBe("STORE_UNAVAILABLE");
		expectErased(key);
		expect(listing(f.folder)).toEqual(["draftyak.db"]);
		expect(listing(f.database)).toEqual([]);
	});

	it("erases the key and creates no identity when a core migration fails", async () => {
		const rogue = f.scratch();
		writeFileSync(
			path.join(rogue, "0001_rogue.sql"),
			"CREATE TABLE hub_meta (singleton INTEGER PRIMARY KEY) STRICT;",
		);
		const creator = f.key();
		const store = new HubStore({
			filename: f.database,
			nativeBinding,
			masterKey: creator,
			create: true,
			migrations: { audit: HUB_NAMESPACES.audit, rogue },
		});
		await store.migrate("audit");
		await store.migrate("rogue");
		store.close();
		const key = f.key();
		expect((await refusal(f.open({ masterKey: key }))).code).toBe("STORE_UNAVAILABLE");
		expectErased(key);
		const check = new HubStore({ filename: f.database, nativeBinding, masterKey: creator });
		try {
			expect(
				check.read((db) =>
					db.all("SELECT name FROM main.sqlite_schema WHERE name IN ('users','approval_pins')"),
				),
			).toEqual([]);
		} finally {
			check.close();
		}
	});

	it("refuses an incomplete identity record instead of creating another identity", async () => {
		const first = await f.open();
		first.close();
		const editor = new HubStore({ filename: f.database, nativeBinding, masterKey: f.key() });
		try {
			editor.write((tx) => tx.run("UPDATE main.hub_meta SET statement_wrapped=NULL"));
		} finally {
			editor.close();
		}
		const key = f.key();
		expect((await refusal(f.open({ masterKey: key }))).code).toBe("IDENTITY_UNAVAILABLE");
		expectErased(key);
	});

	it("erases the key and releases the folder when the extensions refuse to start", async () => {
		const config = path.join(f.folder, "config.json");
		writeFileSync(config, "{ not json");
		const key = f.key();
		expect((await refusal(f.open({ masterKey: key }))).code).toBe("EXTENSIONS_UNAVAILABLE");
		expectErased(key);
		rmSync(config);
		expect((await f.open()).extensions.modules).toEqual([]);
	});
});

describe("a store that cannot close", () => {
	it("keeps the store of a failed open and refuses every open until it closes", async () => {
		const config = path.join(f.folder, "config.json");
		writeFileSync(config, "{ not json");
		const control = blockNativeClose();
		try {
			const first = f.key();
			expect((await refusal(f.open({ masterKey: first }))).code).toBe("EXTENSIONS_UNAVAILABLE");
			expectErased(first);
			expect(control.attempts).toBe(1);
			rmSync(config);
			const second = f.key();
			expect((await refusal(f.open({ masterKey: second }))).code).toBe("STORE_UNAVAILABLE");
			expectErased(second);
			expect(control.attempts).toBe(2);
			control.blocked = false;
			const session = await f.open();
			expect(control.attempts).toBe(3);
			session.store.read((db) => session.audit.verify(db));
		} finally {
			control.restore();
		}
	});

	it("reports an unproved close, still erases the key and retries the store on the next call", async () => {
		const key = f.key();
		const session = await f.open({ masterKey: key });
		const control = blockNativeClose();
		try {
			expect(refusalNow(() => session.close()).code).toBe("CLOSE_INCOMPLETE");
			expectErased(key);
			await expectLocked(session);
			const waiting = f.key();
			expect((await refusal(f.open({ masterKey: waiting }))).code).toBe("SESSION_ACTIVE");
			expectErased(waiting);
			expect(refusalNow(() => session.close()).code).toBe("CLOSE_INCOMPLETE");
			control.blocked = false;
			session.close();
			session.close();
			expect(control.attempts).toBe(3);
		} finally {
			control.restore();
		}
		expect((await f.open()).hubId).toBe(session.hubId);
	});
});

describe("a module database that cannot close", () => {
	it("still locks every service, closes the store and erases the key", async () => {
		configureModule(f, "probe");
		const key = f.key();
		const session = await f.open({ masterKey: key });
		expect(session.extensions.modules).toEqual([{ id: "probe", version: "1.0.0" }]);
		const control = blockNativeClose();
		// Only the first native close fails: the module database's, which the extensions close first.
		Object.defineProperty(control, "blocked", { get: () => control.attempts === 1 });
		try {
			expect(refusalNow(() => session.close()).code).toBe("CLOSE_INCOMPLETE");
			expect(control.attempts).toBe(2);
			expectErased(key);
			await expectLocked(session);
			expect(session.extensions.providers("auditSink")).toEqual([]);
			session.close();
			expect(control.attempts).toBe(2);
		} finally {
			control.restore();
		}
		expect((await f.open()).extensions.modules).toEqual([{ id: "probe", version: "1.0.0" }]);
	});
});

describe("redaction", () => {
	it("shows no service in JSON or inspection", async () => {
		const session = await f.open();
		expect(JSON.stringify(session)).toBe('"[REDACTED]"');
		expect(inspect(session)).toBe("[REDACTED]");
		expect(Object.keys(session)).toEqual([
			"hubId",
			"hid",
			"store",
			"audit",
			"identity",
			"pins",
			"extensions",
			"close",
		]);
		expect(Object.isFrozen(session)).toBe(true);
	});

	it("carries no path, key byte or cause in a refusal", async () => {
		const canary = sessionFixture("draftyak-session-CANARYPATH-");
		try {
			(await canary.open()).close();
			const bytes = Buffer.alloc(32, 0x5a);
			const hex = bytes.toString("hex").slice(0, 16);
			const refusals = [await refusal(canary.open({ masterKey: new MasterKey(bytes) }))];
			writeFileSync(canary.database, "");
			refusals.push(await refusal(canary.open()));
			rmSync(canary.database);
			writeFileSync(path.join(canary.folder, "mk.recovery"), "");
			refusals.push(await refusal(canary.open()));
			expect(refusals.map((error) => error.code)).toEqual([
				"UNLOCK_REFUSED",
				"FIRST_RUN_INTERRUPTED",
				"HUB_STATE_INCOMPLETE",
			]);
			for (const error of refusals) {
				const shown = [error.message, error.stack, inspect(error), JSON.stringify(error)].join(
					"\n",
				);
				expect(shown).not.toContain("CANARYPATH");
				expect(shown.toLowerCase()).not.toContain(hex);
				expect(Object.hasOwn(error, "cause")).toBe(false);
			}
		} finally {
			canary.remove();
		}
	});
});

describe("migration folders", () => {
	it("are frozen", () => {
		expect(Object.isFrozen(HUB_NAMESPACES)).toBe(true);
	});
});
