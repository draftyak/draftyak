import { randomBytes } from "node:crypto";
import fs, {
	appendFileSync,
	chmodSync,
	copyFileSync,
	existsSync,
	fstatSync,
	linkSync,
	lstatSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	realpathSync,
	rmdirSync,
	rmSync,
	statSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import type { AuditEvent } from "@draftyak/protocol/entities/audit";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AuditChain } from "../../src/audit/chain.ts";
import { newId } from "../../src/kernel/ids.ts";
import { MasterKey } from "../../src/kernel/master-key.ts";
import { flushDirectory } from "../../src/store/durable-file.ts";
import { openEncrypted, type SqliteDatabase } from "../../src/store/open.ts";
import {
	SNAPSHOT_RETENTION_MS,
	SnapshotError,
	type SnapshotErrorCode,
	type SnapshotOptions,
} from "../../src/store/snapshots.ts";
import { HubStore } from "../../src/store/store.ts";
import { canaryTail, leaks, needles, newCanary, scanDatabase } from "./fts-fixture.ts";
import { migrations, nativeBinding } from "./helpers.ts";

// Calls through. Windows has no directory flush for an fs.fsyncSync spy to see.
vi.mock("../../src/store/durable-file.ts", async (importOriginal) => {
	const actual = await importOriginal<typeof import("../../src/store/durable-file.ts")>();
	return { ...actual, flushDirectory: vi.fn(actual.flushDirectory) };
});

const T0 = 1_800_000_000_000;
const DAY = 24 * 60 * 60_000;
const SNAPSHOT = /^pre-migration-fixture-(\d+)-[0-9A-HJKMNP-TV-Z]{26}\.db$/;
const EVENT: AuditEvent = {
	id: "01ARZ3NDEKTSV4RRFFQ69G5FAV",
	at: 1,
	action: "hub.init",
	actor: { kind: "hub", id: null },
	refs: {},
};

const cleanups: (() => void)[] = [];
afterEach(() => {
	vi.restoreAllMocks();
	vi.mocked(flushDirectory).mockReset();
	const failures: unknown[] = [];
	for (const cleanup of cleanups.splice(0).reverse()) {
		try {
			cleanup();
		} catch (error) {
			failures.push(error);
		}
	}
	if (failures.length > 0) throw failures[0];
});

function tempDir(): string {
	const dir = realpathSync.native(mkdtempSync(path.join(os.tmpdir(), "draftyak-snapshots-")));
	cleanups.push(() => rmSync(dir, { recursive: true, force: true, maxRetries: 5 }));
	return dir;
}
const listDir = (dir: string): string[] => readdirSync(dir).toSorted();
const identity = (info: { dev: bigint; ino: bigint }): string => `${info.dev}:${info.ino}`;
const snapshotName = (namespace: string, time: number): string =>
	`pre-migration-${namespace}-${time}-${newId(time)}.db`;
const thrown = (action: () => unknown): unknown => {
	try {
		action();
	} catch (error) {
		return error;
	}
	return undefined;
};

// A refusal carries its fixed code and nothing else: no path, name or SQLite message.
function refused(error: unknown, code: SnapshotErrorCode): void {
	expect(error).toBeInstanceOf(SnapshotError);
	expect(error).toMatchObject({ code, message: `Database snapshot failed: ${code}` });
	expect(Object.keys(error as object)).toEqual(["name", "code"]);
	expect((error as Error).cause).toBeUndefined();
}

interface Prepared {
	readonly dir: string;
	readonly filename: string;
	readonly snapshots: string;
	readonly sql: string;
	readonly bytes: Buffer;
	readonly key: MasterKey;
	readonly chain: AuditChain;
	readonly clock: { now: number; wallMs(): number };
	readonly settings: SnapshotOptions;
	open(snapshots: SnapshotOptions | undefined, filename?: string, create?: boolean): HubStore;
	connect(): SqliteDatabase;
}

// A closed database with an audit event and the fixture namespace's first file applied.
async function prepared(): Promise<Prepared> {
	const dir = tempDir();
	const filename = path.join(dir, "draftyak.db");
	const snapshots = path.join(dir, "snapshots");
	const sql = path.join(dir, "sql");
	mkdirSync(snapshots, { mode: 0o700 });
	mkdirSync(sql);
	writeFileSync(
		path.join(sql, "0001_rows.sql"),
		"CREATE TABLE test_rows(id TEXT PRIMARY KEY, n INTEGER NOT NULL) STRICT;",
	);
	const bytes = randomBytes(32);
	const key = new MasterKey(bytes);
	const auditKey = key.derive("audit");
	const chain = new AuditChain(auditKey);
	auditKey.fill(0);
	const stores: HubStore[] = [];
	const connections: SqliteDatabase[] = [];
	cleanups.push(() => {
		for (const db of connections) if (db.open) db.close();
		for (const store of stores) store.close();
		chain.destroy();
		key.destroy();
	});
	const clock = {
		now: T0,
		wallMs(): number {
			return this.now;
		},
	};
	const open = (
		options: SnapshotOptions | undefined,
		file = filename,
		create = false,
	): HubStore => {
		const store = new HubStore({
			filename: file,
			nativeBinding,
			masterKey: key,
			create,
			migrations: { audit: path.join(migrations, "audit"), fixture: sql },
			snapshots: options,
		});
		stores.push(store);
		return store;
	};
	const connect = (): SqliteDatabase => {
		const db = openEncrypted({ filename, nativeBinding }, key);
		connections.push(db);
		return db;
	};
	const first = open(undefined, filename, true);
	await first.migrate("audit");
	await first.migrate("fixture");
	first.write((tx) => {
		tx.run("INSERT INTO test_rows VALUES ('committed', 1)");
		chain.append(tx, EVENT);
	});
	first.close();
	const settings = { directory: snapshots, clock };
	return { dir, filename, snapshots, sql, bytes, key, chain, clock, settings, open, connect };
}

const addPending = (f: Prepared, file = "0002_more.sql", table = "more_rows"): void =>
	writeFileSync(path.join(f.sql, file), `CREATE TABLE ${table}(id TEXT PRIMARY KEY) STRICT;`);
const applied = (store: HubStore): string[] =>
	store.read((db) =>
		db
			.all<{ name: string }>("SELECT name FROM _migrations_fixture ORDER BY name")
			.map((row) => row.name),
	);
const hasTable = (store: HubStore, table: string): boolean =>
	store.read(
		(db) => db.get("SELECT 1 AS found FROM sqlite_schema WHERE name = ?", [table]) !== undefined,
	);

function onlySnapshot(f: Prepared): string {
	const names = listDir(f.snapshots);
	expect(names).toHaveLength(1);
	return path.join(f.snapshots, names[0] as string);
}

let refusals = 0;
// Nothing applied, no new table, no file left, and the store still reads and writes.
async function refusedMigration(f: Prepared, store: HubStore, code: SnapshotErrorCode) {
	const error = await store.migrate("fixture").then(
		() => undefined,
		(reason: unknown) => reason,
	);
	refused(error, code);
	expect(applied(store)).toEqual(["0001_rows"]);
	expect(hasTable(store, "more_rows")).toBe(false);
	if (existsSync(f.snapshots) && statSync(f.snapshots).isDirectory())
		expect(listDir(f.snapshots)).toEqual([]);
	const id = `after refusal ${++refusals}`;
	store.write((tx) => tx.run("INSERT INTO test_rows VALUES (?, ?)", [id, 3]));
	expect(store.read((db) => db.get("SELECT n FROM test_rows WHERE id = ?", [id]))).toEqual({
		n: 3,
	});
}

describe("pre-migration snapshots", () => {
	it("copies the file, -wal rows included, before a pending file runs on an existing schema", async () => {
		const f = await prepared();
		const store = f.open(f.settings);
		const canary = newCanary();
		store.write((tx) => tx.run("INSERT INTO test_rows VALUES (?, ?)", [canary, 2]));
		expect(statSync(`${f.filename}-wal`).size).toBeGreaterThan(0);
		const alone = path.join(f.dir, "alone.db");
		copyFileSync(f.filename, alone);
		const withoutWal = openEncrypted({ filename: alone, nativeBinding }, f.key);
		try {
			expect(
				withoutWal.prepare("SELECT n FROM test_rows WHERE id = ?").get(canary),
			).toBeUndefined();
		} finally {
			withoutWal.close();
		}
		addPending(f);
		expect(await store.migrate("fixture")).toEqual(["0002_more"]);
		expect(hasTable(store, "more_rows")).toBe(true);
		const snapshot = onlySnapshot(f);
		expect(path.basename(snapshot)).toMatch(SNAPSHOT);
		expect(SNAPSHOT.exec(path.basename(snapshot))?.[1]).toBe(String(T0));
		const [dbKey, auditKey] = [f.key.derive("db"), f.key.derive("audit")];
		try {
			const look = needles({
				canary: canaryTail(canary),
				master: f.bytes,
				db: dbKey,
				audit: auditKey,
			});
			expect(leaks(scanDatabase(snapshot, look))).toEqual([]);
		} finally {
			dbKey.fill(0);
			auditKey.fill(0);
		}
		// A byte copy keeps the live file's salt.
		const salt = (file: string): Buffer => readFileSync(file).subarray(0, 16);
		expect(salt(snapshot).equals(salt(f.filename))).toBe(true);
		// SQLite on Windows refuses paths over MAX_PATH, which a deep temporary folder can reach.
		const opened = path.join(f.dir, "snapshot.db");
		copyFileSync(snapshot, opened);
		const wrong = new MasterKey(randomBytes(32));
		const refusal = thrown(() => openEncrypted({ filename: opened, nativeBinding }, wrong));
		wrong.destroy();
		expect(refusal).toMatchObject({ code: "SQLITE_NOTADB" });
		const db = openEncrypted({ filename: opened, nativeBinding }, f.key);
		try {
			expect(db.pragma("integrity_check", { simple: true })).toBe("ok");
			expect(db.prepare("SELECT id, n FROM test_rows ORDER BY n").all()).toEqual([
				{ id: "committed", n: 1 },
				{ id: canary, n: 2 },
			]);
			expect(db.prepare("SELECT name FROM _migrations_fixture").pluck().all()).toEqual([
				"0001_rows",
			]);
			expect(db.prepare("SELECT 1 FROM sqlite_schema WHERE name = 'more_rows'").get()).toBe(
				undefined,
			);
		} finally {
			db.close();
		}
		const copy = f.open(undefined, opened);
		copy.read((reader) => f.chain.verify(reader));
		expect(copy.read((reader) => reader.all("SELECT seq FROM audit_events"))).toEqual([{ seq: 1 }]);
	});

	it("takes none for a new file's first namespace or without pending files", async () => {
		const f = await prepared();
		const store = f.open(f.settings);
		expect(await store.migrate("audit")).toEqual([]);
		expect(await store.migrate("fixture")).toEqual([]);
		expect(listDir(f.snapshots)).toEqual([]);
		const fresh = f.open(f.settings, path.join(f.dir, "fresh.db"), true);
		expect(await fresh.migrate("audit")).toEqual(["0001_chain"]);
		expect(listDir(f.snapshots)).toEqual([]);
		// Every later namespace with pending files on that schema takes one.
		expect(await fresh.migrate("fixture")).toEqual(["0001_rows"]);
		expect(onlySnapshot(f)).toMatch(/pre-migration-fixture-/);
	});

	it("without the option, migrates as before and refuses the snapshot methods", async () => {
		const f = await prepared();
		const store = f.open(undefined);
		const copies = vi.spyOn(fs, "copyFileSync");
		addPending(f);
		const before = listDir(f.dir);
		expect(await store.migrate("fixture")).toEqual(["0002_more"]);
		expect(listDir(f.dir)).toEqual(before);
		expect(listDir(f.snapshots)).toEqual([]);
		expect(copies).not.toHaveBeenCalled();
		refused(
			thrown(() => store.expireSnapshots()),
			"options",
		);
		refused(
			thrown(() => store.removeSnapshots()),
			"options",
		);
	});

	it("flushes the snapshot, then its directory, and the directory again after removals", async () => {
		const f = await prepared();
		const store = f.open(f.settings);
		addPending(f);
		const directory = identity(lstatSync(f.snapshots, { bigint: true }));
		const events: string[] = [];
		const fsync = fs.fsyncSync;
		const flushes = vi.spyOn(fs, "fsyncSync").mockImplementation((descriptor) => {
			const flushed = identity(fstatSync(descriptor, { bigint: true }));
			const files = listDir(f.snapshots).map((name) =>
				identity(lstatSync(path.join(f.snapshots, name), { bigint: true })),
			);
			events.push(
				flushed === directory ? "directory" : files.includes(flushed) ? "snapshot" : "other",
			);
			fsync(descriptor);
		});
		const directoryFlushes = vi.mocked(flushDirectory).mock;
		const posix = process.platform === "win32" ? [] : ["directory"];
		await store.migrate("fixture");
		expect(events).toEqual(["snapshot", ...posix]);
		expect(directoryFlushes.calls).toEqual([[f.snapshots]]);
		expect(flushes.mock.invocationCallOrder[0]).toBeLessThan(
			directoryFlushes.invocationCallOrder[0] as number,
		);
		const removals = (remove: () => number, count: number) => {
			events.length = 0;
			vi.mocked(flushDirectory).mockClear();
			expect(remove()).toBe(count);
			expect(events).toEqual(count > 0 ? posix : []);
			expect(directoryFlushes.calls).toEqual(count > 0 ? [[f.snapshots]] : []);
		};
		f.clock.now = T0 + SNAPSHOT_RETENTION_MS;
		removals(() => store.expireSnapshots(), 0);
		f.clock.now += 1;
		removals(() => store.expireSnapshots(), 1);
		addPending(f, "0003_last.sql", "last_rows");
		await store.migrate("fixture");
		removals(() => store.removeSnapshots(), 1);
		expect(listDir(f.snapshots)).toEqual([]);
	});

	it("gives the snapshot exactly mode 0600", { tags: ["requires:posix"] }, async () => {
		const f = await prepared();
		const store = f.open(f.settings);
		addPending(f);
		await store.migrate("fixture");
		expect(statSync(onlySnapshot(f)).mode & 0o777).toBe(0o600);
	});
});

describe("a snapshot failure stops migrate() before any migration SQL", () => {
	it("refuses a missing or replaced snapshot directory", async () => {
		const f = await prepared();
		const store = f.open(f.settings);
		addPending(f);
		rmdirSync(f.snapshots);
		await refusedMigration(f, store, "directory");
		expect(existsSync(f.snapshots)).toBe(false);
		mkdirSync(f.snapshots, { mode: 0o700 });
		await refusedMigration(f, store, "directory");
		rmdirSync(f.snapshots);
		writeFileSync(f.snapshots, "");
		await refusedMigration(f, store, "directory");
		expect(readFileSync(f.snapshots, "utf8")).toBe("");
		refused(
			thrown(() => store.expireSnapshots()),
			"directory",
		);
		refused(
			thrown(() => store.removeSnapshots()),
			"directory",
		);
	});

	it("refuses while a reader's snapshot holds -wal frames, then takes one after it ends", async () => {
		const f = await prepared();
		const store = f.open(f.settings);
		addPending(f);
		store.write((tx) => tx.run("INSERT INTO test_rows VALUES ('held', 2)"));
		const reader = f.connect();
		reader.exec("BEGIN");
		const held = reader.prepare("SELECT n FROM test_rows WHERE id = 'held'").pluck();
		expect(held.get()).toBe(2);
		store.write((tx) => tx.run("INSERT INTO test_rows VALUES ('later', 4)"));
		const started = performance.now();
		await refusedMigration(f, store, "busy");
		// SQLite retries for the whole 5000 ms busy_timeout before it reports the reader.
		expect(performance.now() - started).toBeGreaterThanOrEqual(4_500);
		expect(held.get()).toBe(2);
		reader.exec("COMMIT");
		expect(await store.migrate("fixture")).toEqual(["0002_more"]);
		onlySnapshot(f);
	});

	it("never replaces a file that takes the snapshot's name first", async () => {
		const f = await prepared();
		const store = f.open(f.settings);
		addPending(f);
		const copy = fs.copyFileSync;
		let target = "";
		vi.spyOn(fs, "copyFileSync").mockImplementation((source, destination, mode) => {
			target = String(destination);
			writeFileSync(target, "other creator");
			copy(source, destination, mode);
		});
		const error = await store.migrate("fixture").then(
			() => undefined,
			(reason: unknown) => reason,
		);
		refused(error, "copy");
		expect(path.dirname(target)).toBe(f.snapshots);
		expect(listDir(f.snapshots)).toEqual([path.basename(target)]);
		expect(readFileSync(target, "utf8")).toBe("other creator");
		expect(applied(store)).toEqual(["0001_rows"]);
	});

	it("removes its copy when a flush or the comparison fails", async () => {
		const f = await prepared();
		const store = f.open(f.settings);
		addPending(f);
		vi.spyOn(fs, "fsyncSync").mockImplementationOnce(() => {
			throw new Error("flush failed");
		});
		await refusedMigration(f, store, "flush");
		vi.mocked(flushDirectory).mockImplementationOnce(() => {
			throw new Error("flush failed");
		});
		await refusedMigration(f, store, "flush");
		const copy = fs.copyFileSync;
		const copies = vi.spyOn(fs, "copyFileSync").mockImplementation((source, target, mode) => {
			copy(source, target, mode);
			appendFileSync(target, "x");
		});
		await refusedMigration(f, store, "verify");
		copies.mockRestore();
		const corrupt = vi.spyOn(fs, "copyFileSync").mockImplementation((source, target, mode) => {
			copy(source, target, mode);
			const bytes = readFileSync(target);
			bytes[32] = (bytes[32] as number) ^ 1;
			writeFileSync(target, bytes);
		});
		await refusedMigration(f, store, "verify");
		corrupt.mockRestore();
		expect(await store.migrate("fixture")).toEqual(["0002_more"]);
		onlySnapshot(f);
	});
});

describe("expireSnapshots and removeSnapshots", () => {
	it("keeps a snapshot for exactly the retention period and removes it 1 ms later", async () => {
		const f = await prepared();
		const store = f.open(f.settings);
		addPending(f);
		await store.migrate("fixture");
		const snapshot = path.basename(onlySnapshot(f));
		const future = snapshotName("fixture", T0 + 30 * DAY);
		writeFileSync(path.join(f.snapshots, future), "future");
		f.clock.now = T0 + SNAPSHOT_RETENTION_MS;
		expect(store.expireSnapshots()).toBe(0);
		expect(listDir(f.snapshots)).toEqual([future, snapshot].toSorted());
		f.clock.now = T0 + SNAPSHOT_RETENTION_MS + 1;
		expect(store.expireSnapshots()).toBe(1);
		expect(listDir(f.snapshots)).toEqual([future]);
		expect(SNAPSHOT_RETENTION_MS).toBe(7 * DAY);
	});

	it("never touches other names, directories, links or files with a second name", async () => {
		const f = await prepared();
		const store = f.open(f.settings);
		const old = T0 - 30 * DAY;
		const id = newId(old);
		const others = [
			`pre-migration-fixture-${old}-${id}.db-wal`,
			`pre-migration-fixture-${old}-${id}.db.tmp`,
			`pre-migration-fixture-${old}-${id}.DB`,
			`pre-migration-fixture-${old}-${id.toLowerCase()}.db`,
			`pre-migration-fixture-${old}-${id}0.db`,
			`pre-migration-fixture-${old}-8${id.slice(1)}.db`,
			`pre-migration-fixture-${old}-${id.slice(0, -1)}U.db`,
			`pre-migration-fixture-0${old}-${id}.db`,
			`pre-migration-fixture-${2 ** 48}-${id}.db`,
			`pre-migration-Fixture-${old}-${id}.db`,
			`pre-migration--${old}-${id}.db`,
			`pre-migration-fixture-${old}.db`,
			`xpre-migration-fixture-${old}-${id}.db`,
			"draftyak.db",
			"notes.txt",
		];
		for (const name of others) writeFileSync(path.join(f.snapshots, name), "kept");
		const directory = snapshotName("fixture", old);
		mkdirSync(path.join(f.snapshots, directory));
		const outside = path.join(f.dir, "outside");
		mkdirSync(outside);
		writeFileSync(path.join(outside, "kept.txt"), "kept");
		const junction = snapshotName("fixture", old);
		symlinkSync(outside, path.join(f.snapshots, junction), "junction");
		const linked = snapshotName("fixture", old);
		writeFileSync(path.join(f.snapshots, linked), "kept");
		linkSync(path.join(f.snapshots, linked), path.join(f.dir, "second-name.db"));
		const expired = snapshotName("audit", old);
		writeFileSync(path.join(f.snapshots, expired), "expired");
		const before = listDir(f.snapshots);
		expect(store.expireSnapshots()).toBe(1);
		const kept = before.filter((name) => name !== expired);
		expect(listDir(f.snapshots)).toEqual(kept);
		expect(store.removeSnapshots()).toBe(0);
		expect(listDir(f.snapshots)).toEqual(kept);
		for (const name of [...others, linked])
			expect(readFileSync(path.join(f.snapshots, name), "utf8")).toBe("kept");
		expect(listDir(path.join(f.snapshots, junction))).toEqual(["kept.txt"]);
	});

	it("leaves symlinks and their targets", { tags: ["requires:symlink-privilege"] }, async () => {
		const f = await prepared();
		const store = f.open(f.settings);
		const old = T0 - 30 * DAY;
		const target = path.join(f.dir, "outside.db");
		writeFileSync(target, "kept");
		const link = snapshotName("fixture", old);
		symlinkSync(target, path.join(f.snapshots, link), "file");
		const outside = path.join(f.dir, "outside");
		mkdirSync(outside);
		const directoryLink = snapshotName("fixture", old);
		symlinkSync(outside, path.join(f.snapshots, directoryLink), "dir");
		expect(store.expireSnapshots()).toBe(0);
		expect(store.removeSnapshots()).toBe(0);
		expect(listDir(f.snapshots)).toEqual([directoryLink, link].toSorted());
		expect(readFileSync(target, "utf8")).toBe("kept");
	});

	it("removeSnapshots removes every snapshot, future-dated too, and returns the count", async () => {
		const f = await prepared();
		const store = f.open(f.settings);
		addPending(f);
		await store.migrate("fixture");
		f.clock.now = T0 + 1;
		addPending(f, "0003_last.sql", "last_rows");
		await store.migrate("fixture");
		writeFileSync(path.join(f.snapshots, snapshotName("audit", T0 + 365 * DAY)), "future");
		writeFileSync(path.join(f.snapshots, "notes.txt"), "kept");
		expect(listDir(f.snapshots)).toHaveLength(4);
		expect(store.removeSnapshots()).toBe(3);
		expect(listDir(f.snapshots)).toEqual(["notes.txt"]);
		expect(store.removeSnapshots()).toBe(0);
	});

	it("refuses while the store is busy or closed", async () => {
		const f = await prepared();
		const store = f.open(f.settings);
		addPending(f);
		await store.migrate("fixture");
		const snapshot = onlySnapshot(f);
		f.clock.now = T0 + 30 * DAY;
		const unavailable = "Database is unavailable or already in use";
		for (const method of ["expireSnapshots", "removeSnapshots"] as const) {
			store.read(() => {
				expect(() => store[method]()).toThrow(unavailable);
			});
			store.write(() => {
				expect(() => store[method]()).toThrow(unavailable);
			});
		}
		expect(existsSync(snapshot)).toBe(true);
		store.close();
		expect(() => store.expireSnapshots()).toThrow(unavailable);
		expect(() => store.removeSnapshots()).toThrow(unavailable);
		expect(existsSync(snapshot)).toBe(true);
	});
});

describe("snapshot options", () => {
	it("refuses unusable directories and clocks before the database is opened", () => {
		const dir = tempDir();
		const directory = path.join(dir, "snapshots");
		mkdirSync(directory, { mode: 0o700 });
		mkdirSync(path.join(directory, "inner"), { mode: 0o700 });
		const file = path.join(dir, "file");
		writeFileSync(file, "");
		const link = path.join(dir, "link");
		symlinkSync(directory, link, "junction");
		const filename = path.join(dir, "new.db");
		const key = new MasterKey(randomBytes(32));
		cleanups.push(() => key.destroy());
		const clock = { wallMs: () => T0 };
		const open = (snapshots: unknown) =>
			new HubStore({
				filename,
				nativeBinding,
				masterKey: key,
				create: true,
				snapshots: snapshots as SnapshotOptions,
			});
		const cases: unknown[] = [
			null,
			directory,
			new Proxy({ directory, clock }, {}),
			{ directory: "snapshots", clock },
			{ directory: `.${path.sep}snapshots`, clock },
			{ directory: `${directory}${path.sep}`, clock },
			{ directory: `${dir}${path.sep}.${path.sep}snapshots`, clock },
			{ directory: `${directory}${path.sep}..${path.sep}snapshots`, clock },
			{ directory: path.join(dir, "missing"), clock },
			{ directory: file, clock },
			{ directory: link, clock },
			{ directory: path.join(link, "inner"), clock },
			{ directory: 7, clock },
			{ directory, clock: new Proxy(clock, {}) },
			{ directory, clock: { wallMs: new Proxy(() => T0, {}) } },
			{ directory, clock: {} },
			{ directory, clock: () => T0 },
			{ directory, clock: null },
		];
		if (process.platform === "win32") cases.push({ directory: directory.toUpperCase(), clock });
		for (const snapshots of cases) {
			refused(
				thrown(() => open(snapshots)),
				"options",
			);
			expect(existsSync(filename)).toBe(false);
		}
		open({ directory, clock }).close();
		expect(existsSync(filename)).toBe(true);
	});

	it("reads the options once and keeps the clock it was given", async () => {
		const f = await prepared();
		const reads: string[] = [];
		const clock = {
			get wallMs() {
				reads.push("wallMs");
				return () => T0 + 5;
			},
		};
		const options = {
			get directory() {
				reads.push("directory");
				return f.snapshots;
			},
			get clock() {
				reads.push("clock");
				return clock;
			},
		};
		const store = f.open(options);
		expect(reads.toSorted()).toEqual(["clock", "directory", "wallMs"]);
		addPending(f);
		await store.migrate("fixture");
		expect(reads).toHaveLength(3);
		expect(SNAPSHOT.exec(path.basename(onlySnapshot(f)))?.[1]).toBe(String(T0 + 5));
	});

	it("refuses a directory with group or other bits", { tags: ["requires:posix"] }, async () => {
		const f = await prepared();
		for (const mode of [0o750, 0o705, 0o710, 0o701, 0o770, 0o707]) {
			chmodSync(f.snapshots, mode);
			refused(
				thrown(() => f.open(f.settings)),
				"options",
			);
		}
		chmodSync(f.snapshots, 0o700);
		const store = f.open(f.settings);
		addPending(f);
		chmodSync(f.snapshots, 0o770);
		await refusedMigration(f, store, "directory");
	});
});
