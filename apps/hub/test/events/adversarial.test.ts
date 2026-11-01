import Database from "better-sqlite3-multiple-ciphers";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	EVENT_PAGE_SIZE,
	EVENT_RETENTION_MS,
	type EventInput,
	EventLog,
} from "../../src/events/log.ts";
import { WorkDatabase, type WorkScope } from "../../src/jobs/database.ts";
import { WorkError } from "../../src/jobs/values.ts";
import { ACCOUNT, fixture, OWNER, REF, testId } from "../jobs/fixture.ts";
import { nativeBinding } from "../store/helpers.ts";

type Fixture = Awaited<ReturnType<typeof fixture>>;
let f: Fixture;
const input = (): EventInput => ({
	userId: OWNER,
	accountId: ACCOUNT,
	dataClass: "gmail.metadata",
	kind: "messages.changed",
	ids: [REF],
});
const append = (raw: unknown = input()) =>
	f.database.write((scope) => f.events.append(scope, raw as EventInput));
const page = (afterSeq = 0, limit = EVENT_PAGE_SIZE, userId = OWNER) =>
	f.database.write((scope) => f.events.page(scope, { userId, afterSeq, limit }));
const count = () =>
	f.store.read((sql) => sql.get<{ n: number }>("SELECT count(*) AS n FROM events")?.n);

// Corrupt only this fixture's actual encrypted file, including values refused by its CHECKs.
function corrupt(statement: string, values: readonly (string | number | null)[] = []): void {
	const native = new Database(f.filename, { nativeBinding, fileMustExist: true });
	const key = f.key.derive("db");
	try {
		native.key(key);
		native.pragma("ignore_check_constraints = ON");
		native.prepare(statement).run(...values);
	} finally {
		key.fill(0);
		native.close();
	}
}

beforeEach(async () => {
	f = await fixture();
});
afterEach(() => f.cleanup());

describe("event admission", () => {
	it.each([
		["null", null],
		["array", []],
		["primitive", "DYTEST-event"],
		["missing field", { ...input(), ids: undefined }],
		["extra field", { ...input(), content: "DYTEST-CANARY" }],
		["symbol field", { ...input(), [Symbol("extra")]: 1 }],
		["invalid owner", { ...input(), userId: "x".repeat(26) }],
		["invalid account", { ...input(), accountId: 3 }],
		["invalid class", { ...input(), dataClass: "unassigned" }],
		["class newline", { ...input(), dataClass: "gmail.metadata\n" }],
		["class suffix", { ...input(), dataClass: "gmail.metadata\0" }],
		["unsupported kind", { ...input(), kind: "messages.created" }],
		["coerced kind", { ...input(), kind: new String("messages.changed") }],
		["ids string", { ...input(), ids: REF }],
		["ids typed array", { ...input(), ids: new Uint8Array(0) }],
		["duplicate ids", { ...input(), ids: [REF, REF] }],
		["invalid id", { ...input(), ids: ["z".repeat(26)] }],
		["non-string id", { ...input(), ids: [4] }],
		["101 ids", { ...input(), ids: Array.from({ length: 101 }, (_, n) => testId(n + 100)) }],
	])("refuses %s without a persisted event", (_label, raw) => {
		expect(() => append(raw)).toThrow(WorkError);
		expect(count()).toBe(0);
		expect(page().lastSeq).toBe(0);
	});

	it("rejects record and array accessors without invoking them", () => {
		let calls = 0;
		const record = Object.defineProperty(input(), "kind", {
			enumerable: true,
			get: () => {
				calls++;
				return "messages.changed";
			},
		});
		const ids = Object.defineProperty([REF], "0", {
			enumerable: true,
			get: () => {
				calls++;
				return REF;
			},
		});
		for (const raw of [record, { ...input(), ids }]) expect(() => append(raw)).toThrow(WorkError);
		expect(calls).toBe(0);
		expect(count()).toBe(0);
	});

	it("rejects record and array proxies without reflection traps", () => {
		let calls = 0;
		const traps = {
			get: () => {
				calls++;
				throw new Error("DYTEST trap");
			},
			getPrototypeOf: () => {
				calls++;
				throw new Error("DYTEST trap");
			},
			ownKeys: () => {
				calls++;
				throw new Error("DYTEST trap");
			},
			getOwnPropertyDescriptor: () => {
				calls++;
				throw new Error("DYTEST trap");
			},
		};
		for (const raw of [new Proxy(input(), traps), { ...input(), ids: new Proxy([REF], traps) }])
			expect(() => append(raw)).toThrow();
		expect(calls).toBe(0);
	});

	it("rejects holes, inherited array elements, nonenumerable elements and extra keys", () => {
		const inherited = new Array(1);
		Object.setPrototypeOf(inherited, Object.assign(Object.create(Array.prototype), { 0: REF }));
		const hidden = Object.defineProperty([REF], "0", { value: REF, enumerable: false });
		for (const ids of [
			new Array(1),
			inherited,
			hidden,
			Object.assign([REF], { extra: 1 }),
			Object.assign([REF], { [Symbol("extra")]: 1 }),
		])
			expect(() => append({ ...input(), ids })).toThrow(WorkError);
	});

	it("accepts empty and exactly 100 distinct ids and detached frozen snapshots", () => {
		expect(append({ ...input(), accountId: null, ids: [] }).ids).toEqual([]);
		const ids = Array.from({ length: 100 }, (_, n) => testId(n + 100));
		const raw = { ...input(), ids };
		const saved = append(raw);
		ids[0] = OWNER;
		raw.kind = "jobs.changed";
		expect(saved.ids).toHaveLength(100);
		expect(saved.ids[0]).toBe(testId(100));
		expect(saved.kind).toBe("messages.changed");
		expect(Object.isFrozen(saved)).toBe(true);
		expect(Object.isFrozen(saved.ids)).toBe(true);
		expect(Reflect.set(saved, "at", 0)).toBe(false);
		expect(page().events[1]).toEqual(saved);
	});

	it("snapshots input before calling the supplied clock", () => {
		const raw = input();
		const events = new EventLog(f.database, () => {
			(raw.ids as string[])[0] = OWNER;
			(raw as { kind: string }).kind = "jobs.changed";
			return 123;
		});
		const saved = f.database.write((scope) => events.append(scope, raw));
		expect(saved).toMatchObject({ ids: [REF], kind: "messages.changed", at: 123 });
		expect(page().events).toEqual([saved]);
	});

	it.each([-1, 0.5, Number.NaN, Number.POSITIVE_INFINITY, Number.MAX_SAFE_INTEGER + 1, "1", null])(
		"rejects invalid timestamp %s before mutation",
		(now) => {
			const events = new EventLog(f.database, () => now as number);
			expect(() => f.database.write((scope) => events.append(scope, input()))).toThrow(WorkError);
			expect(count()).toBe(0);
		},
	);
});

describe("native event projection", () => {
	it("bounds oversized ids in the native projection before JavaScript decoding", () => {
		append();
		corrupt("UPDATE events SET ids=?", [`[${" ".repeat(1_000_000)}]`]);
		const sizes: (number | null)[] = [];
		const restoreStatements: (() => void)[] = [];
		const prepare = Database.prototype.prepare;
		const observer = vi.spyOn(Database.prototype, "prepare").mockImplementation(function (
			this: InstanceType<typeof Database>,
			source: string,
		) {
			const statement = prepare.call(this, source);
			if (source.includes("FROM main.events")) {
				const all = statement.all.bind(statement);
				const observation = vi
					.spyOn(statement, "all")
					.mockImplementation((...bindings: unknown[]) => {
						const rows = Reflect.apply(all, statement, bindings) as { ids: unknown }[];
						for (const row of rows) sizes.push(typeof row.ids === "string" ? row.ids.length : null);
						return rows;
					});
				restoreStatements.push(() => observation.mockRestore());
			}
			return statement;
		});
		try {
			expect(() => page()).toThrow(WorkError);
			expect(sizes).toEqual([null]);
		} finally {
			for (const restore of restoreStatements) restore();
			observer.mockRestore();
		}
	});

	it.each([
		["account", "UPDATE events SET account_id=?", ["x".repeat(26)]],
		["class", "UPDATE events SET data_class=?", ["gmail.metadata\n"]],
		["class size", "UPDATE events SET data_class=?", ["x".repeat(1_000_000)]],
		["kind", "UPDATE events SET kind=?", ["unknown.changed"]],
		["kind size", "UPDATE events SET kind=?", ["x".repeat(1_000_000)]],
		["json", "UPDATE events SET ids=?", ["{not-json}"]],
		["noncanonical json", "UPDATE events SET ids=?", [`[ "${REF}" ]`]],
		["duplicate ids", "UPDATE events SET ids=?", [JSON.stringify([REF, REF])]],
		[
			"101 ids",
			"UPDATE events SET ids=?",
			[JSON.stringify(Array.from({ length: 101 }, (_, n) => testId(n + 100)))],
		],
		["ids size", "UPDATE events SET ids=?", [`[${" ".repeat(1_000_000)}]`]],
		["negative time", "UPDATE events SET at=?", [-1]],
	])("refuses malformed stored %s", (_label, statement, values) => {
		append();
		corrupt(statement as string, values as (string | number)[]);
		expect(() => page()).toThrow(WorkError);
	});

	it("validates the lookahead before returning any successful partial page", () => {
		append();
		append();
		corrupt("UPDATE events SET ids='not-json' WHERE seq=2");
		expect(() => page(0, 1)).toThrow(WorkError);
	});

	it("rejects a valid-looking stored event above the durable sequence head", () => {
		append();
		corrupt("UPDATE event_meta SET last_seq=0");
		expect(() => page()).toThrow(WorkError);
	});

	it.each([
		["oversized head", "UPDATE event_meta SET last_seq=9007199254740992"],
		["negative floor", "UPDATE event_meta SET floor_seq=-1"],
		["floor past head", "UPDATE event_meta SET floor_seq=2"],
		["missing head", "DELETE FROM event_meta"],
	])("rejects %s", (_label, statement) => {
		append();
		corrupt(statement);
		expect(() => page()).toThrow(WorkError);
	});

	it.each([
		"UPDATE events SET at=0.5",
		"UPDATE event_meta SET last_seq=0.5",
		"UPDATE event_meta SET floor_seq=0.5",
	])("retains native STRICT integer admission for %s", (statement) => {
		const saved = append();
		expect(() => corrupt(statement)).toThrow();
		expect(page().events).toEqual([saved]);
	});

	it("refuses sequence overflow without creating a row or advancing its head", () => {
		corrupt("UPDATE event_meta SET last_seq=?", [Number.MAX_SAFE_INTEGER]);
		expect(() => append()).toThrow(WorkError);
		expect(count()).toBe(0);
		expect(page(Number.MAX_SAFE_INTEGER).lastSeq).toBe(Number.MAX_SAFE_INTEGER);
	});

	it("filters owners before limit/lookahead and advances over other owners", () => {
		append();
		append({ ...input(), userId: testId(4) });
		append();
		const first = page(0, 1);
		expect(first).toMatchObject({ nextSeq: 1, lastSeq: 3, more: true, resyncRequired: false });
		expect(first.events.map((event) => event.seq)).toEqual([1]);
		const second = page(first.nextSeq, 1);
		expect(second).toMatchObject({ nextSeq: 3, more: false });
		expect(second.events.map((event) => event.seq)).toEqual([3]);
		corrupt("UPDATE events SET ids='invalid' WHERE user_id=?", [testId(4)]);
		expect(page(0).events.map((event) => event.seq)).toEqual([1, 3]);
		expect(page(0, 100, testId(5))).toMatchObject({ events: [], nextSeq: 3, more: false });
	});

	it("distinguishes exactly 100 events from a 101st lookahead event", () => {
		f.database.write((scope) => {
			for (let n = 0; n < 100; n++) f.events.append(scope, input());
		});
		expect(page()).toMatchObject({ nextSeq: 100, lastSeq: 100, more: false });
		expect(page().events).toHaveLength(100);
		append();
		const first = page();
		expect(first).toMatchObject({ nextSeq: 100, lastSeq: 101, more: true });
		expect(first.events).toHaveLength(100);
		expect(page(first.nextSeq)).toMatchObject({
			events: [expect.objectContaining({ seq: 101 })],
			nextSeq: 101,
			more: false,
		});
	});

	it("rejects page getters and proxies without invoking caller code", () => {
		let calls = 0;
		const getter = Object.defineProperty({ userId: OWNER }, "afterSeq", {
			enumerable: true,
			get: () => {
				calls++;
				return 0;
			},
		});
		const proxy = new Proxy(
			{ userId: OWNER, afterSeq: 0 },
			{
				ownKeys: () => {
					calls++;
					return ["userId", "afterSeq"];
				},
			},
		);
		for (const raw of [getter, proxy])
			expect(() =>
				f.database.write((scope) =>
					f.events.page(scope, raw as { userId: string; afterSeq: number }),
				),
			).toThrow(WorkError);
		expect(calls).toBe(0);
	});

	it.each([
		{ userId: OWNER, afterSeq: -1 },
		{ userId: OWNER, afterSeq: 0.5 },
		{ userId: OWNER, afterSeq: 1 },
		{ userId: OWNER, afterSeq: 0, limit: 0 },
		{ userId: OWNER, afterSeq: 0, limit: 101 },
		{ userId: OWNER, afterSeq: 0, limit: 1.5 },
		{ userId: OWNER, afterSeq: 0, limit: undefined },
		{ userId: OWNER, afterSeq: 0, content: "DYTEST-CANARY" },
	])("rejects malformed page request %#", (raw) => {
		expect(() => f.database.write((scope) => f.events.page(scope, raw))).toThrow(WorkError);
	});

	it("preserves durable pages and sequence after closing and reopening the real store", () => {
		const saved = append();
		f.store.close();
		const reopened = f.reopen();
		try {
			const database = new WorkDatabase(reopened);
			const events = new EventLog(database, () => 1_000_001);
			expect(
				database.write((scope) => events.page(scope, { userId: OWNER, afterSeq: 0 })).events,
			).toEqual([saved]);
			expect(database.write((scope) => events.append(scope, input())).seq).toBe(2);
		} finally {
			reopened.close();
		}
	});
});

describe("retention and transactional ownership", () => {
	it("keeps the exact seven-day boundary and purges one millisecond later", () => {
		f.clock.wall = 0;
		append();
		f.clock.wall = EVENT_RETENTION_MS;
		expect(f.database.write((scope) => f.events.purge(scope))).toEqual({ deleted: 0, more: false });
		f.clock.wall++;
		expect(f.database.write((scope) => f.events.purge(scope))).toEqual({ deleted: 1, more: false });
		expect(page()).toMatchObject({
			events: [],
			floorSeq: 1,
			lastSeq: 1,
			nextSeq: 1,
			resyncRequired: true,
		});
		expect(page(1)).toMatchObject({ events: [], resyncRequired: false });
	});

	it("purges in bounded 100-row pages and persists the contiguous floor", () => {
		f.clock.wall = 0;
		f.database.write((scope) => {
			for (let n = 0; n < 201; n++) f.events.append(scope, input());
		});
		f.clock.wall = EVENT_RETENTION_MS + 1;
		for (const [deleted, more, floorSeq] of [
			[100, true, 100],
			[100, true, 200],
			[1, false, 201],
		] as const) {
			expect(f.database.write((scope) => f.events.purge(scope))).toEqual({ deleted, more });
			expect(page().floorSeq).toBe(floorSeq);
		}
		expect(f.database.write((scope) => f.events.purge(scope))).toEqual({ deleted: 0, more: false });
		expect(page(201)).toMatchObject({
			events: [],
			lastSeq: 201,
			floorSeq: 201,
			resyncRequired: false,
		});
		expect(append().seq).toBe(202);
	});

	it("uses a sequence prefix across backward timestamps, including fresher earlier rows", () => {
		f.clock.wall = EVENT_RETENTION_MS;
		append();
		f.clock.wall = 0;
		append();
		f.clock.wall = EVENT_RETENTION_MS + 1;
		expect(f.database.write((scope) => f.events.purge(scope))).toEqual({ deleted: 2, more: false });
		expect(page()).toMatchObject({ floorSeq: 2, lastSeq: 2, resyncRequired: true });
	});

	it("a caught failed append poisons its whole native write, including previous consumer changes", () => {
		expect(() =>
			f.database.write((scope) => {
				scope.sql.run("UPDATE consumer_state SET value=7 WHERE id=1");
				f.events.append(scope, input());
				try {
					f.events.append(scope, { ...input(), ids: [REF, REF] });
				} catch {}
			}),
		).toThrow(WorkError);
		expect(count()).toBe(0);
		expect(page().lastSeq).toBe(0);
		expect(
			f.store.read(
				(sql) => sql.get<{ value: number }>("SELECT value FROM consumer_state WHERE id=1")?.value,
			),
		).toBe(0);
	});

	it("rolls back an advanced head when a later event insert fails and its error is caught", () => {
		corrupt("INSERT INTO events VALUES(1,?,?,?,?,?,?)", [
			OWNER,
			ACCOUNT,
			"gmail.metadata",
			"messages.changed",
			JSON.stringify([REF]),
			0,
		]);
		expect(() =>
			f.database.write((scope) => {
				try {
					f.events.append(scope, input());
				} catch {}
			}),
		).toThrow(WorkError);
		expect(
			f.store.read(
				(sql) => sql.get<{ last_seq: number }>("SELECT last_seq FROM event_meta")?.last_seq,
			),
		).toBe(0);
		expect(count()).toBe(1);
	});

	it("rejects forged, proxy, expired and foreign scopes without native work", async () => {
		let retired: WorkScope | undefined;
		f.database.write((scope) => {
			retired = scope;
		});
		for (const scope of [{ sql: {} }, retired, new Proxy(retired as WorkScope, {})])
			expect(() => f.events.page(scope as WorkScope, { userId: OWNER, afterSeq: 0 })).toThrow(
				WorkError,
			);
		const other = await fixture();
		try {
			other.database.write((scope) => {
				expect(() => f.events.page(scope, { userId: OWNER, afterSeq: 0 })).toThrow(WorkError);
			});
		} finally {
			other.cleanup();
		}
	});

	it("rejects event reads after a caught native OR ROLLBACK invalidates the write", () => {
		expect(() =>
			f.database.write((scope) => {
				try {
					scope.sql.run("INSERT OR ROLLBACK INTO consumer_state VALUES(1,9)");
				} catch {}
				expect(() => f.events.page(scope, { userId: OWNER, afterSeq: 0 })).toThrow();
			}),
		).toThrow();
		expect(page().lastSeq).toBe(0);
	});
});
