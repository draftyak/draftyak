import { afterEach, beforeEach, expect, it } from "vitest";
import { EventLog } from "../../src/events/log.ts";
import { WorkDatabase, type WorkScope } from "../../src/jobs/database.ts";
import { JOB_LEASE_MS, type JobInput, type JobLease, JobQueue } from "../../src/jobs/queue.ts";
import { WorkError } from "../../src/jobs/values.ts";
import { ACCOUNT, fixture, OWNER, REF, testId } from "./fixture.ts";

let f: Awaited<ReturnType<typeof fixture>>;
beforeEach(async () => {
	f = await fixture();
});
afterEach(() => f.cleanup());
const input = (n = 10, changes: Partial<JobInput> = {}): JobInput => ({
	id: testId(n),
	accountId: ACCOUNT,
	ownerId: OWNER,
	kind: "sync",
	refId: REF,
	...changes,
});
const enqueue = (value: JobInput = input()): void => {
	f.database.write((s) => f.queue.enqueue(s, value));
};
const claim = (accountId = ACCOUNT, exact?: string): JobLease => {
	const lease = f.database.write((s) => f.queue.claim(s, accountId, exact));
	expect(lease).toBeDefined();
	return lease as JobLease;
};
const state = (jobId = testId(10)): string | undefined =>
	f.database.write((s) => f.queue.get(s, jobId)?.state);

it("copies frozen ID-only job metadata and emits its durable invalidation", () => {
	const raw = input();
	const job = f.database.write((s) => f.queue.enqueue(s, raw));
	Object.assign(raw, { ownerId: testId(77), kind: "draft" });
	expect(Object.isFrozen(job)).toBe(true);
	expect(job).toMatchObject({
		ownerId: OWNER,
		kind: "sync",
		attempts: 0,
		state: "PENDING",
		maxAttempts: 5,
	});
	const page = f.database.write((s) => f.events.page(s, { userId: OWNER, afterSeq: 0 }));
	expect(page.events).toEqual([
		{
			userId: OWNER,
			accountId: ACCOUNT,
			kind: "jobs.changed",
			dataClass: "hub.state",
			ids: [job.id],
			seq: 1,
			at: f.clock.wall,
		},
	]);
});
it("serializes one account while a second account makes progress", () => {
	enqueue();
	enqueue(input(11));
	enqueue(input(12, { accountId: testId(20) }));
	const first = claim();
	expect(f.database.write((s) => f.queue.claim(s, ACCOUNT))).toBeUndefined();
	const other = claim(testId(20));
	expect(other.job.id).toBe(testId(12));
	f.database.write((s) => f.queue.complete(s, first));
	expect(claim().job.id).toBe(testId(11));
});
it("never falls back from an exact missing, wrong-account, future or completed job", () => {
	enqueue();
	enqueue(input(11, { accountId: testId(20) }));
	for (const exact of [testId(99), testId(11)])
		expect(f.database.write((s) => f.queue.claim(s, ACCOUNT, exact))).toBeUndefined();
	f.database.write((s) =>
		s.sql.run("UPDATE main.jobs SET next_at=? WHERE id=?", [f.clock.wall + 1, testId(10)]),
	);
	expect(f.database.write((s) => f.queue.claim(s, ACCOUNT, testId(10)))).toBeUndefined();
	f.clock.wall++;
	const lease = claim();
	f.database.write((s) => f.queue.complete(s, lease));
	expect(f.database.write((s) => f.queue.claim(s, ACCOUNT, testId(10)))).toBeUndefined();
});
it("completes once and keeps the persisted token out of public snapshots", () => {
	enqueue();
	const lease = claim();
	expect(Object.isFrozen(lease)).toBe(true);
	expect(Object.isFrozen(lease.job)).toBe(true);
	expect(JSON.stringify(lease)).not.toContain("token");
	f.database.write((s) => f.queue.complete(s, lease));
	expect(state()).toBe("SUCCEEDED");
	expect(() => f.database.write((s) => f.queue.complete(s, lease))).toThrow(WorkError);
});
it("backs off failed work and stops at the bounded attempt count", () => {
	enqueue(input(10, { maxAttempts: 2 }));
	let lease = claim();
	f.database.write((s) => f.queue.fail(s, lease, 100));
	expect(f.database.write((s) => f.queue.claim(s, ACCOUNT))).toBeUndefined();
	f.clock.wall += 100;
	f.clock.monotonic += 100;
	lease = claim();
	expect(lease.job.attempts).toBe(2);
	f.database.write((s) => f.queue.fail(s, lease, 0));
	expect(state()).toBe("FAILED");
	expect(f.database.write((s) => f.queue.claim(s, ACCOUNT))).toBeUndefined();
});
it("recovers wall-expired leases and fences the old capability after handoff", () => {
	enqueue();
	const old = claim();
	f.clock.wall += JOB_LEASE_MS;
	f.clock.monotonic += JOB_LEASE_MS;
	expect(f.database.write((s) => f.queue.recover(s))).toBe(1);
	const next = claim();
	expect(next.job.attempts).toBe(2);
	expect(() => f.database.write((s) => f.queue.complete(s, old))).toThrow(WorkError);
	f.database.write((s) => f.queue.complete(s, next));
});
it("turns an expired final attempt into FAILED instead of endlessly requeueing", () => {
	enqueue(input(10, { maxAttempts: 1 }));
	claim();
	f.clock.wall += JOB_LEASE_MS;
	expect(f.database.write((s) => f.queue.recover(s))).toBe(1);
	expect(state()).toBe("FAILED");
	expect(f.database.write((s) => f.queue.claim(s, ACCOUNT))).toBeUndefined();
});
it("refuses a locally expired monotonic lease despite a backward wall jump", () => {
	enqueue();
	const old = claim();
	f.clock.wall -= 10_000;
	f.clock.monotonic += JOB_LEASE_MS;
	expect(() => f.database.write((s) => f.queue.complete(s, old))).toThrow(WorkError);
	expect(f.database.write((s) => f.queue.recover(s))).toBe(0);
	expect(state()).toBe("RUNNING");
	f.clock.wall = 1_000_000 + JOB_LEASE_MS;
	expect(f.database.write((s) => f.queue.recover(s))).toBe(1);
});
it("renews with a fresh capability and retires the old one", () => {
	enqueue();
	const old = claim();
	f.clock.wall += 100;
	f.clock.monotonic += 100;
	const renewed = f.database.write((s) => f.queue.renew(s, old));
	expect(renewed.job.leaseUntil).toBe(f.clock.wall + JOB_LEASE_MS);
	expect(() => f.database.write((s) => f.queue.complete(s, old))).toThrow(WorkError);
	f.database.write((s) => f.queue.complete(s, renewed));
});
it("never revives a completion capability after enclosing rollback", () => {
	enqueue();
	const lease = claim();
	expect(() =>
		f.database.write((s) => {
			f.queue.complete(s, lease);
			throw new Error("rollback");
		}),
	).toThrow("rollback");
	expect(state()).toBe("RUNNING");
	expect(() => f.database.write((s) => f.queue.complete(s, lease))).toThrow(WorkError);
	f.clock.wall += JOB_LEASE_MS;
	expect(f.database.write((s) => f.queue.recover(s))).toBe(1);
});
it("rolls back a claim's state and invalidation together", () => {
	enqueue();
	let leaked: JobLease | undefined;
	expect(() =>
		f.database.write((s) => {
			leaked = f.queue.claim(s, ACCOUNT);
			throw new Error("rollback");
		}),
	).toThrow("rollback");
	expect(state()).toBe("PENDING");
	expect(
		f.database.write((s) => f.events.page(s, { userId: OWNER, afterSeq: 0 })).events,
	).toHaveLength(1);
	expect(() => f.database.write((s) => f.queue.complete(s, leaked as JobLease))).toThrow(WorkError);
	expect(claim().job.attempts).toBe(1);
});
it("cancels a live job and never completes its old capability", () => {
	enqueue();
	const lease = claim();
	expect(f.database.write((s) => f.queue.cancel(s, lease.job.id))).toBe(true);
	expect(state()).toBe("CANCELLED");
	expect(f.database.write((s) => f.queue.cancel(s, lease.job.id))).toBe(false);
	expect(() => f.database.write((s) => f.queue.complete(s, lease))).toThrow(WorkError);
});
it("joins consumer state, enqueue, event and actual audit in one native commit", () => {
	f.database.write((s) => {
		s.sql.run("UPDATE main.consumer_state SET value=1 WHERE id=1");
		f.queue.enqueue(s, input());
		f.audit.append(s.sql, {
			id: testId(88),
			at: f.clock.wall,
			action: "hub.init",
			actor: { kind: "hub", id: null },
			refs: {},
		});
	});
	expect(
		f.store.read(
			(sql) =>
				sql.get<{ value: number }>("SELECT value FROM main.consumer_state WHERE id=1")?.value,
		),
	).toBe(1);
	f.store.read((sql) => f.audit.verify(sql));
	expect(
		f.store.read(
			(sql) => sql.get<{ count: number }>("SELECT count(*) AS count FROM main.audit_events")?.count,
		),
	).toBe(1);
	expect(() =>
		f.database.write((s) => {
			s.sql.run("UPDATE main.consumer_state SET value=2 WHERE id=1");
			f.queue.enqueue(s, input(11));
			f.audit.append(s.sql, {
				id: testId(88),
				at: f.clock.wall,
				action: "hub.init",
				actor: { kind: "hub", id: null },
				refs: {},
			});
		}),
	).toThrow();
	expect(state(testId(11))).toBeUndefined();
	expect(
		f.store.read(
			(sql) =>
				sql.get<{ value: number }>("SELECT value FROM main.consumer_state WHERE id=1")?.value,
		),
	).toBe(1);
	expect(f.database.write((s) => f.events.page(s, { userId: OWNER, afterSeq: 0 })).lastSeq).toBe(1);
});
it("poisons caught partial-operation errors instead of committing state without events", () => {
	expect(() =>
		f.database.write((s) => {
			s.sql.run("UPDATE main.event_meta SET last_seq=? WHERE singleton=1", [
				Number.MAX_SAFE_INTEGER,
			]);
			try {
				f.queue.enqueue(s, input());
			} catch {
				/* outer transaction must still refuse */
			}
			s.sql.run("UPDATE main.consumer_state SET value=9 WHERE id=1");
		}),
	).toThrow(WorkError);
	expect(state()).toBeUndefined();
	expect(
		f.store.read(
			(sql) =>
				sql.get<{ value: number }>("SELECT value FROM main.consumer_state WHERE id=1")?.value,
		),
	).toBe(0);
});
it("preserves a healthy sibling's unexpired lease and supports a second account natively", () => {
	enqueue();
	enqueue(input(11));
	enqueue(input(12, { accountId: testId(20) }));
	const old = claim();
	const store = f.reopen();
	try {
		const database = new WorkDatabase(store),
			events = new EventLog(database, () => f.clock.wall);
		const queue = new JobQueue(database, events, {
			wallNow: () => f.clock.wall,
			monotonicNow: () => f.clock.monotonic,
		});
		expect(database.write((s) => queue.recover(s))).toBe(0);
		expect(database.write((s) => queue.claim(s, ACCOUNT))).toBeUndefined();
		expect(database.write((s) => queue.claim(s, testId(20)))?.job.id).toBe(testId(12));
		f.database.write((s) => f.queue.complete(s, old));
		expect(database.write((s) => queue.claim(s, ACCOUNT))?.job.id).toBe(testId(11));
	} finally {
		store.close();
	}
});
it("reopening after backward wall time does not treat restart as ownership or expiry", () => {
	enqueue();
	claim();
	const store = f.reopen();
	f.clock.wall -= 60_000;
	try {
		const database = new WorkDatabase(store),
			events = new EventLog(database, () => f.clock.wall);
		const queue = new JobQueue(database, events, {
			wallNow: () => f.clock.wall,
			monotonicNow: () => 0,
		});
		expect(database.write((s) => queue.recover(s))).toBe(0);
		expect(database.write((s) => queue.claim(s, ACCOUNT))).toBeUndefined();
		f.clock.wall = 1_000_000 + JOB_LEASE_MS;
		expect(database.write((s) => queue.recover(s))).toBe(1);
		expect(database.write((s) => queue.claim(s, ACCOUNT))?.job.attempts).toBe(2);
	} finally {
		store.close();
	}
});

for (const [name, raw] of [
	["content", { ...input(), body: "DYTEST-CANARY" }],
	["send", input(10, { kind: "send" as JobInput["kind"] })],
	["noncanonical ID", input(10, { id: `${testId(10)}\n` })],
	["zero attempts", input(10, { maxAttempts: 0 })],
	["unbounded attempts", input(10, { maxAttempts: 21 })],
	["explicit undefined", input(10, { maxAttempts: undefined })],
] as const)
	it(`refuses ${name} before durable enqueue`, () => {
		expect(() => f.database.write((s) => f.queue.enqueue(s, raw as JobInput))).toThrow(WorkError);
		expect(state()).toBeUndefined();
	});
it("refuses input accessors and Proxies without invoking user hooks", () => {
	let hooks = 0;
	const accessor = Object.defineProperty({ ...input() }, "id", {
		enumerable: true,
		get: () => {
			hooks++;
			return testId(10);
		},
	});
	const proxy = new Proxy(input(), {
		ownKeys: () => {
			hooks++;
			throw new Error("hook");
		},
		get: () => {
			hooks++;
			throw new Error("hook");
		},
	});
	for (const raw of [accessor, proxy])
		expect(() => f.database.write((s) => f.queue.enqueue(s, raw))).toThrow(WorkError);
	expect(hooks).toBe(0);
});
it("refuses fabricated, copied and proxied lease handles without hooks", () => {
	enqueue();
	const lease = claim();
	let hooks = 0;
	for (const raw of [
		{ ...lease },
		Object.create(lease),
		new Proxy(lease, {
			get: () => {
				hooks++;
				throw new Error("hook");
			},
		}),
	])
		expect(() => f.database.write((s) => f.queue.complete(s, raw))).toThrow(WorkError);
	expect(hooks).toBe(0);
	f.database.write((s) => f.queue.complete(s, lease));
});
it("enforces the account uniqueness constraint in actual SQLite", () => {
	enqueue();
	enqueue(input(11));
	claim();
	expect(() =>
		f.database.write((s) =>
			s.sql.run("UPDATE main.jobs SET state='RUNNING',token=?,lease_until=? WHERE id=?", [
				"0".repeat(64),
				f.clock.wall + JOB_LEASE_MS,
				testId(11),
			]),
		),
	).toThrow(/UNIQUE/);
});
it("does not export SQL or token authority in serialized errors", () => {
	try {
		f.database.write((s) => f.queue.enqueue(s, { ...input(), body: "DYTEST-CANARY" } as JobInput));
	} catch (error) {
		expect(String(error)).toBe("WorkError: Durable work input refused");
		expect(JSON.stringify(error)).not.toContain("DYTEST-CANARY");
	}
});
it("does not revive a locally retired lease when another native handle restores older row state", () => {
	enqueue();
	const lease = claim();
	expect(() =>
		f.database.write((s) => {
			f.queue.fail(s, lease, 0);
			throw new Error("rollback");
		}),
	).toThrow();
	expect(state()).toBe("RUNNING");
	expect(() => f.database.write((s) => f.queue.renew(s, lease))).toThrow(WorkError);
});
it("uses one account's recovery without prematurely retiring another account", () => {
	enqueue();
	enqueue(input(11, { accountId: testId(20) }));
	claim();
	const other = claim(testId(20));
	f.clock.wall += JOB_LEASE_MS;
	expect(f.database.write((s) => f.queue.recover(s, ACCOUNT))).toBe(1);
	expect(state(testId(11))).toBe("RUNNING");
	expect(() => f.database.write((s) => f.queue.complete(s, other))).toThrow(WorkError);
});
it("keeps a capability bound to its issuing queue even for the same native database", () => {
	enqueue();
	const lease = claim();
	const other = new JobQueue(f.database, f.events, {
		wallNow: () => f.clock.wall,
		monotonicNow: () => f.clock.monotonic,
	});
	expect(() => f.database.write((s) => other.complete(s, lease))).toThrow(WorkError);
	f.database.write((s) => f.queue.complete(s, lease));
});
it("checks the exact scope before consuming a valid lease", () => {
	enqueue();
	const lease = claim();
	expect(() => f.queue.complete({ sql: {} } as WorkScope, lease)).toThrow(WorkError);
	f.database.write((s) => f.queue.complete(s, lease));
});

it("refuses a persisted token replacement even within the original lease time", () => {
	enqueue();
	const lease = claim();
	f.database.write((s) =>
		s.sql.run("UPDATE main.jobs SET token=? WHERE id=?", ["a".repeat(64), lease.job.id]),
	);
	expect(() => f.database.write((s) => f.queue.complete(s, lease))).toThrow(WorkError);
	expect(state()).toBe("RUNNING");
});
it("refuses a changed owner scope even if the native token and expiry still match", () => {
	enqueue();
	const lease = claim();
	f.database.write((s) =>
		s.sql.run("UPDATE main.jobs SET owner_id=? WHERE id=?", [testId(99), lease.job.id]),
	);
	expect(() => f.database.write((s) => f.queue.complete(s, lease))).toThrow(WorkError);
	expect(state()).toBe("RUNNING");
});
it("refuses wall-expired capability when monotonic time alone has not elapsed", () => {
	enqueue();
	const lease = claim();
	f.clock.wall += JOB_LEASE_MS;
	expect(() => f.database.write((s) => f.queue.complete(s, lease))).toThrow(WorkError);
	expect(state()).toBe("RUNNING");
});
it("does not revive the old or new renewal capability after rollback", () => {
	enqueue();
	const old = claim();
	let renewed: JobLease | undefined;
	expect(() =>
		f.database.write((s) => {
			renewed = f.queue.renew(s, old);
			throw new Error("rollback");
		}),
	).toThrow("rollback");
	for (const lease of [old, renewed as JobLease])
		expect(() => f.database.write((s) => f.queue.complete(s, lease))).toThrow(WorkError);
	expect(state()).toBe("RUNNING");
});
for (const column of ["owner_id", "account_id", "ref_id"] as const)
	it(`rejects malformed stored canonical metadata in ${column}`, () => {
		enqueue();
		f.database.write((s) =>
			s.sql.run(`UPDATE main.jobs SET ${column}=? WHERE id=?`, ["Z".repeat(26), testId(10)]),
		);
		expect(() => f.database.write((s) => f.queue.get(s, testId(10)))).toThrow(
			"Durable work data refused",
		);
	});
