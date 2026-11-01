import { describe, expect, it } from "vitest";
import { EVENT_PAGE_SIZE, EVENT_RETENTION_MS, EventLog } from "../../src/events/log.ts";
import type { WorkScope } from "../../src/jobs/database.ts";
import { WorkDatabase } from "../../src/jobs/database.ts";
import { ACCOUNT, fixture, OWNER, REF, testId } from "../jobs/fixture.ts";

const event = () => ({
	userId: OWNER,
	accountId: ACCOUNT,
	dataClass: "hub.state" as const,
	kind: "jobs.changed" as const,
	ids: [REF],
});

describe("durable ID-only event log", () => {
	it("copies native ID metadata, isolates owner pages and persists sequences across reopen", async () => {
		const f = await fixture();
		try {
			const raw = event();
			const first = f.database.write((scope) => f.events.append(scope, raw));
			raw.ids[0] = testId(9);
			expect(first.ids).toEqual([REF]);
			expect(Object.isFrozen(first)).toBe(true);
			expect(Object.isFrozen(first.ids)).toBe(true);
			f.database.write((scope) => f.events.append(scope, { ...event(), userId: testId(8) }));
			f.database.write((scope) => f.events.append(scope, event()));
			const page = f.database.write((scope) =>
				f.events.page(scope, { userId: OWNER, afterSeq: 0 }),
			);
			expect(page.events.map((row) => row.seq)).toEqual([1, 3]);
			expect(page.nextSeq).toBe(3);
			expect(page.more).toBe(false);
			f.store.close();
			const reopened = f.reopen();
			try {
				const database = new WorkDatabase(reopened);
				const events = new EventLog(database, () => f.clock.wall);
				expect(database.write((scope) => events.append(scope, event())).seq).toBe(4);
			} finally {
				reopened.close();
			}
		} finally {
			f.cleanup();
		}
	});

	it("rolls consumer state, event row, event counter and audit back together", async () => {
		const f = await fixture();
		try {
			expect(() =>
				f.database.write((scope) => {
					scope.sql.run("UPDATE main.consumer_state SET value=1 WHERE id=1");
					f.events.append(scope, event());
					f.audit.append(scope.sql, {
						id: testId(99),
						at: f.clock.wall,
						action: "jobs.enqueue",
						actor: { kind: "hub", id: null },
						refs: { account: ACCOUNT },
					});
					throw new Error("Synthetic transaction failure");
				}),
			).toThrow("Synthetic transaction failure");
			expect(
				f.store.read((sql) => sql.get("SELECT value FROM main.consumer_state WHERE id=1")),
			).toEqual({ value: 0 });
			expect(f.store.read((sql) => sql.get("SELECT count(*) AS n FROM main.audit_events"))).toEqual(
				{ n: 0 },
			);
			expect(f.database.write((scope) => f.events.append(scope, event())).seq).toBe(1);
		} finally {
			f.cleanup();
		}
	});

	it("poisons a caught insertion failure so the advanced counter cannot commit", async () => {
		const f = await fixture();
		try {
			f.database.write((scope) => f.events.append(scope, event()));
			f.store.write((sql) => sql.run("UPDATE main.event_meta SET last_seq=0 WHERE singleton=1"));
			expect(() =>
				f.database.write((scope) => {
					try {
						f.events.append(scope, event());
					} catch {
						// The caller cannot turn a partial module failure into a successful write.
					}
				}),
			).toThrow();
			expect(
				f.store.read((sql) => sql.get("SELECT last_seq FROM main.event_meta WHERE singleton=1")),
			).toEqual({ last_seq: 0 });
			expect(f.store.read((sql) => sql.get("SELECT count(*) AS n FROM main.events"))).toEqual({
				n: 1,
			});
		} finally {
			f.cleanup();
		}
	});

	it("bounds pages and purge progress and never resets the durable sequence after emptying", async () => {
		const f = await fixture();
		try {
			f.database.write((scope) => {
				for (let n = 0; n < EVENT_PAGE_SIZE * 2 + 1; n++) f.events.append(scope, event());
			});
			const first = f.database.write((scope) =>
				f.events.page(scope, { userId: OWNER, afterSeq: 0 }),
			);
			expect(first.events).toHaveLength(100);
			expect(first.more).toBe(true);
			expect(first.nextSeq).toBe(100);
			f.clock.wall += EVENT_RETENTION_MS;
			expect(f.database.write((scope) => f.events.purge(scope))).toEqual({
				deleted: 0,
				more: false,
			});
			f.clock.wall++;
			expect(f.database.write((scope) => f.events.purge(scope))).toEqual({
				deleted: 100,
				more: true,
			});
			expect(
				f.database.write((scope) => f.events.page(scope, { userId: OWNER, afterSeq: 0 }))
					.resyncRequired,
			).toBe(true);
			expect(f.database.write((scope) => f.events.purge(scope))).toEqual({
				deleted: 100,
				more: true,
			});
			expect(f.database.write((scope) => f.events.purge(scope))).toEqual({
				deleted: 1,
				more: false,
			});
			expect(f.database.write((scope) => f.events.append(scope, event())).seq).toBe(202);
			const page = f.database.write((scope) =>
				f.events.page(scope, { userId: OWNER, afterSeq: 201 }),
			);
			expect(page.floorSeq).toBe(201);
			expect(page.events.map((row) => row.seq)).toEqual([202]);
		} finally {
			f.cleanup();
		}
	});

	it("retains a contiguous floor when backward timestamps interleave fresh and expired rows", async () => {
		const f = await fixture();
		try {
			const initial = f.clock.wall;
			f.clock.wall += EVENT_RETENTION_MS;
			f.database.write((scope) => f.events.append(scope, event()));
			f.clock.wall = initial;
			f.database.write((scope) => f.events.append(scope, event()));
			f.clock.wall = initial + EVENT_RETENTION_MS + 1;
			expect(f.database.write((scope) => f.events.purge(scope))).toEqual({
				deleted: 2,
				more: false,
			});
			const page = f.database.write((scope) =>
				f.events.page(scope, { userId: OWNER, afterSeq: 0 }),
			);
			expect(page.floorSeq).toBe(2);
			expect(page.resyncRequired).toBe(true);
		} finally {
			f.cleanup();
		}
	});

	it("rejects forged, expired and foreign transaction scopes", async () => {
		const f = await fixture();
		try {
			let expired: WorkScope | undefined;
			f.database.write((scope) => {
				expired = scope;
			});
			expect(() => f.events.append(expired as WorkScope, event())).toThrow();
			expect(() => f.events.append({ sql: {} } as WorkScope, event())).toThrow();
			const foreign = new EventLog(new WorkDatabase(f.store), () => f.clock.wall);
			expect(() => f.database.write((scope) => foreign.append(scope, event()))).toThrow();
		} finally {
			f.cleanup();
		}
	});
});
