import { randomBytes } from "node:crypto";
import fs from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import {
	appendAccountRestoreChangedInTransaction,
	appendOutboxRestoreChangedInTransaction,
	EVENT_MIGRATIONS,
	EventLog,
} from "../../src/events/log.ts";
import { WorkDatabase } from "../../src/jobs/database.ts";
import { JOB_MIGRATIONS } from "../../src/jobs/queue.ts";
import { WorkError } from "../../src/jobs/values.ts";
import { MasterKey } from "../../src/kernel/master-key.ts";
import { HubStore, type SqlTransaction } from "../../src/store/store.ts";

const USER = "01ARZ3NDEKTSV4RRFFQ69G5FAV";
const ACCOUNT = "01ARZ3NDEKTSV4RRFFQ69G5FAW";
const OUTBOX = "01ARZ3NDEKTSV4RRFFQ69G5FAX";
const NOW = 1_800_000_000_000;
const DATA = Object.freeze({
	userId: USER,
	accountId: ACCOUNT,
	dataClass: "gmail.metadata" as const,
	outboxId: OUTBOX,
});
type RestoreInput = Parameters<typeof appendOutboxRestoreChangedInTransaction>[2];

function installedBinding(): string {
	const resolvePackage = createRequire(import.meta.url);
	const entry = fs.realpathSync.native(resolvePackage.resolve("better-sqlite3-multiple-ciphers"));
	const root = path.dirname(path.dirname(entry));
	const metadata = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
	if (
		metadata.name !== "better-sqlite3-multiple-ciphers" ||
		metadata.version !== "13.0.3" ||
		metadata.main !== "lib/index.js" ||
		entry !== path.join(root, "lib", "index.js")
	)
		throw new Error("SQLite test package unavailable");
	const selected = path.join(root, "prebuilds", `${process.platform}-${process.arch}.node`);
	const stat = fs.lstatSync(selected);
	if (!stat.isFile() || stat.isSymbolicLink() || fs.realpathSync.native(selected) !== selected)
		throw new Error("SQLite test input unavailable");
	return selected;
}

class Fixture {
	root: string | undefined;
	rootIdentity: fs.BigIntStats | undefined;
	key: MasterKey | undefined;
	store: HubStore | undefined;
	database: WorkDatabase | undefined;
	log: EventLog | undefined;
	now: () => number = () => NOW;
	uncertain = false;
	closed = false;

	async initialize(): Promise<void> {
		this.root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "dy-event-restore-")));
		this.rootIdentity = fs.lstatSync(this.root, { bigint: true });
		const seed = randomBytes(32);
		try {
			this.key = new MasterKey(seed);
		} finally {
			seed.fill(0);
		}
		const nativeBinding = installedBinding();
		this.uncertain = true;
		this.store = new HubStore({
			filename: path.join(this.root, "events.db"),
			masterKey: this.key,
			nativeBinding,
			create: true,
			migrations: {
				audit: fileURLToPath(new URL("../../src/store/migrations/audit/", import.meta.url)),
				core: fileURLToPath(new URL("../../src/store/migrations/core/", import.meta.url)),
				jobs: JOB_MIGRATIONS,
				events: EVENT_MIGRATIONS,
			},
		});
		this.uncertain = false;
		for (const namespace of ["audit", "core", "jobs", "events"])
			await this.store.migrate(namespace);
		this.database = new WorkDatabase(this.store);
		this.log = new EventLog(this.database, () => this.now());
	}

	close(): void {
		if (this.closed) return;
		if (this.uncertain) throw new Error("Event fixture custody uncertain");
		if (this.store) {
			this.uncertain = true;
			this.store.close();
			this.uncertain = false;
			this.store = undefined;
		}
		this.uncertain = true;
		this.key?.destroy();
		this.key = undefined;
		if (this.root) {
			const current = fs.lstatSync(this.root, { bigint: true });
			if (
				!this.rootIdentity ||
				!current.isDirectory() ||
				current.isSymbolicLink() ||
				current.dev !== this.rootIdentity.dev ||
				current.ino !== this.rootIdentity.ino ||
				fs.realpathSync.native(this.root) !== this.root
			)
				throw new Error("Event fixture namespace uncertain");
			fs.rmSync(this.root, { recursive: true });
		}
		this.uncertain = false;
		this.closed = true;
	}
}

const fixtures: Fixture[] = [];
const bodies = new Set<Promise<void>>();
type LiveFixture = Fixture & { store: HubStore; database: WorkDatabase; log: EventLog };
async function fixture(): Promise<LiveFixture> {
	if (fixtures.some((value) => value.uncertain))
		throw new Error("Earlier native custody uncertain");
	const value = new Fixture();
	fixtures.push(value);
	await value.initialize();
	if (!value.store || !value.database || !value.log) throw new Error("Event fixture unavailable");
	return value as LiveFixture;
}
function test(name: string, body: () => Promise<void>): void {
	it(name, () => {
		if (bodies.size !== 0) throw new Error("Earlier event test body remains owned");
		const work = Promise.resolve().then(body);
		bodies.add(work);
		return work;
	});
}
afterEach(async () => {
	await Promise.allSettled([...bodies]);
	bodies.clear();
	const failures: unknown[] = [];
	for (const value of fixtures) {
		try {
			value.close();
		} catch (error) {
			failures.push(error);
		}
	}
	if (failures.length) throw new AggregateError(failures, "Event fixture cleanup incomplete");
	fixtures.length = 0;
});

function empty(store: HubStore): void {
	store.read((tx) => {
		expect(tx.get("SELECT last_seq,floor_seq FROM main.event_meta WHERE singleton=1")).toEqual({
			last_seq: 0,
			floor_seq: 0,
		});
		expect(tx.all("SELECT seq FROM main.events")).toEqual([]);
	});
}

describe("outbox restore events in the original transaction", () => {
	test("appends fixed metadata through the original Store write without a WorkScope", async () => {
		const f = await fixture();
		const saved = f.store.write((tx) => appendOutboxRestoreChangedInTransaction(f.log, tx, DATA));
		expect(saved).toEqual({
			userId: USER,
			accountId: ACCOUNT,
			dataClass: "gmail.metadata",
			kind: "outbox.changed",
			ids: [OUTBOX],
			seq: 1,
			at: NOW,
		});
		expect(Object.isFrozen(saved)).toBe(true);
		expect(Object.isFrozen(saved.ids)).toBe(true);
		f.store.read((tx) => {
			expect(tx.get("SELECT * FROM main.events WHERE seq=1")).toEqual({
				seq: 1,
				user_id: USER,
				account_id: ACCOUNT,
				data_class: "gmail.metadata",
				kind: "outbox.changed",
				ids: JSON.stringify([OUTBOX]),
				at: NOW,
			});
		});
	});

	test("shares the native sequence with ordinary and account-restore events", async () => {
		const f = await fixture();
		f.store.write((tx) => {
			appendOutboxRestoreChangedInTransaction(f.log, tx, DATA);
			appendAccountRestoreChangedInTransaction(f.log, tx, {
				userId: USER,
				accountId: ACCOUNT,
				channel: "email",
			});
		});
		const saved = f.database.write((scope) =>
			f.log.append(scope, {
				userId: USER,
				accountId: ACCOUNT,
				dataClass: "slack.metadata",
				kind: "outbox.changed",
				ids: [OUTBOX],
			}),
		);
		expect(saved.seq).toBe(3);
		const page = f.database.write((scope) => f.log.page(scope, { userId: USER, afterSeq: 0 }));
		expect(page.events.map((value) => [value.seq, value.kind])).toEqual([
			[1, "outbox.changed"],
			[2, "accounts.changed"],
			[3, "outbox.changed"],
		]);
	});

	test("refuses another encrypted Store's transaction before the clock", async () => {
		const f = await fixture();
		const foreign = await fixture();
		let calls = 0;
		f.now = () => ++calls;
		expect(() =>
			foreign.store.write((tx) => appendOutboxRestoreChangedInTransaction(f.log, tx, DATA)),
		).toThrow(WorkError);
		expect(calls).toBe(0);
		empty(f.store);
		empty(foreign.store);
	});

	test("refuses a read reader, copied transaction and expired original transaction", async () => {
		const f = await fixture();
		expect(() =>
			f.store.read((tx) =>
				appendOutboxRestoreChangedInTransaction(f.log, tx as SqlTransaction, DATA),
			),
		).toThrow(WorkError);
		let expired: SqlTransaction | undefined;
		f.store.write((tx) => {
			expect(() => appendOutboxRestoreChangedInTransaction(f.log, Object.create(tx), DATA)).toThrow(
				WorkError,
			);
			expired = tx;
		});
		const old = expired;
		if (!old) throw new Error("Original transaction missing");
		expect(() => appendOutboxRestoreChangedInTransaction(f.log, old, DATA)).toThrow(WorkError);
		empty(f.store);
	});

	for (const dataClass of ["slack.content", "test-channel.content"] as const) {
		test(`preserves the validated ${dataClass} classification`, async () => {
			const f = await fixture();
			const saved = f.store.write((tx) =>
				appendOutboxRestoreChangedInTransaction(f.log, tx, { ...DATA, dataClass }),
			);
			expect(saved.dataClass).toBe(dataClass);
			f.store.read((tx) => {
				expect(tx.get("SELECT data_class FROM main.events WHERE seq=1")).toEqual({
					data_class: dataClass,
				});
			});
		});
	}

	test("refuses copied and proxied receivers without invoking their properties", async () => {
		const f = await fixture();
		let traps = 0;
		const proxied = new Proxy(f.log, {
			get() {
				traps++;
				throw new Error("Receiver property invoked");
			},
		});
		for (const target of [Object.create(EventLog.prototype), proxied, null])
			expect(() =>
				f.store.write((tx) => appendOutboxRestoreChangedInTransaction(target, tx, DATA)),
			).toThrow(WorkError);
		expect(traps).toBe(0);
		empty(f.store);
	});

	for (const [name, offered] of [
		["an omitted ID", { userId: USER, accountId: ACCOUNT, dataClass: "gmail.metadata" }],
		["an extra kind", { ...DATA, kind: "accounts.changed" }],
		["an extra IDs list", { ...DATA, ids: [ACCOUNT] }],
		["a null account", { ...DATA, accountId: null }],
		["an invalid data class", { ...DATA, dataClass: "unknown.invalid" }],
		["an invalid outbox ID", { ...DATA, outboxId: "invalid" }],
	] as const) {
		test(`refuses ${name} before reading the clock`, async () => {
			const f = await fixture();
			let calls = 0;
			f.now = () => ++calls;
			expect(() =>
				f.store.write((tx) =>
					appendOutboxRestoreChangedInTransaction(f.log, tx, offered as unknown as RestoreInput),
				),
			).toThrow(WorkError);
			expect(calls).toBe(0);
			empty(f.store);
		});
	}

	test("rejects input accessors and proxies without executing a caller trap", async () => {
		const f = await fixture();
		let reads = 0;
		const accessor = { ...DATA };
		Object.defineProperty(accessor, "outboxId", {
			enumerable: true,
			get() {
				reads++;
				return OUTBOX;
			},
		});
		const proxy = new Proxy(DATA, {
			ownKeys() {
				reads++;
				return Reflect.ownKeys(DATA);
			},
		});
		for (const offered of [accessor, proxy])
			expect(() =>
				f.store.write((tx) => appendOutboxRestoreChangedInTransaction(f.log, tx, offered)),
			).toThrow(WorkError);
		expect(reads).toBe(0);
		empty(f.store);
	});

	test("rechecks the same native write after a clock changes its original transaction", async () => {
		const f = await fixture();
		let observed = false;
		expect(() =>
			f.store.write((tx) => {
				f.now = () => {
					observed = tx.run("DELETE FROM main.jobs_meta WHERE singleton=1").changes === 1;
					return NOW;
				};
				return appendOutboxRestoreChangedInTransaction(f.log, tx, DATA);
			}),
		).toThrow(WorkError);
		expect(observed).toBe(true);
		empty(f.store);
		f.store.read((tx) => {
			expect(tx.get("SELECT singleton FROM main.jobs_meta WHERE singleton=1")).toEqual({
				singleton: 1,
			});
		});
	});

	test("rolls back the event and sequence with the original transaction", async () => {
		const f = await fixture();
		let entered = false;
		expect(() =>
			f.store.write((tx) => {
				const saved = appendOutboxRestoreChangedInTransaction(f.log, tx, DATA);
				entered =
					saved.seq === 1 && tx.get("SELECT seq FROM main.events WHERE seq=1") !== undefined;
				throw new Error("Original transaction rollback witness");
			}),
		).toThrow("Original transaction rollback witness");
		expect(entered).toBe(true);
		empty(f.store);
		const saved = f.store.write((tx) => appendOutboxRestoreChangedInTransaction(f.log, tx, DATA));
		expect(saved.seq).toBe(1);
	});

	test("refuses an invalid native clock and exhausted sequence without appending", async () => {
		const f = await fixture();
		f.now = () => Number.NaN;
		expect(() =>
			f.store.write((tx) => appendOutboxRestoreChangedInTransaction(f.log, tx, DATA)),
		).toThrow(WorkError);
		empty(f.store);
		f.now = () => NOW;
		f.store.write((tx) =>
			tx.run("UPDATE main.event_meta SET last_seq=? WHERE singleton=1", [Number.MAX_SAFE_INTEGER]),
		);
		expect(() =>
			f.store.write((tx) => appendOutboxRestoreChangedInTransaction(f.log, tx, DATA)),
		).toThrow(WorkError);
		f.store.read((tx) => {
			expect(tx.all("SELECT seq FROM main.events")).toEqual([]);
		});
	});

	test("bypasses shadowed method and call properties with the captured original", async () => {
		const f = await fixture();
		const original = EventLog.prototype.appendOutboxRestoreChangedInTransaction;
		const previous = Object.getOwnPropertyDescriptor(original, "call");
		let hooks = 0;
		Object.defineProperty(f.log, "appendOutboxRestoreChangedInTransaction", {
			value: () => {
				hooks++;
				throw new Error("Shadowed instance method");
			},
		});
		Object.defineProperty(original, "call", {
			configurable: true,
			value: () => {
				hooks++;
				throw new Error("Shadowed call property");
			},
		});
		try {
			const saved = f.store.write((tx) => appendOutboxRestoreChangedInTransaction(f.log, tx, DATA));
			expect(saved.seq).toBe(1);
			expect(hooks).toBe(0);
			f.store.read((tx) => {
				expect(tx.all("SELECT seq FROM main.events")).toEqual([{ seq: 1 }]);
			});
		} finally {
			if (previous) Object.defineProperty(original, "call", previous);
			else Reflect.deleteProperty(original, "call");
		}
	});
});
