import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { JOB_LEASE_MS, type JobLease } from "../../src/jobs/queue.ts";
import { WorkError } from "../../src/jobs/values.ts";
import { fixture, OWNER, REF, testId } from "./fixture.ts";

type Fixture = Awaited<ReturnType<typeof fixture>>;
const DAY = 24 * 60 * 60 * 1_000;
const MAX = Number.MAX_SAFE_INTEGER;
let f: Fixture;

function enqueue(n = 0): { jobId: string; accountId: string } {
	const jobId = testId(2_000 + n);
	const accountId = testId(1_000 + n);
	f.database.write((scope) =>
		f.queue.enqueue(scope, {
			id: jobId,
			accountId,
			ownerId: OWNER,
			kind: "sync",
			refId: REF,
		}),
	);
	return { jobId, accountId };
}

function claim(accountId: string): JobLease {
	const lease = f.database.write((scope) => f.queue.claim(scope, accountId));
	expect(lease).toBeDefined();
	return lease as JobLease;
}

function admitted(accountId: string): JobLease {
	let lease: JobLease | undefined;
	expect(() => {
		lease = f.database.write((scope) => f.queue.claim(scope, accountId));
	}).not.toThrow();
	expect(lease).toBeDefined();
	return lease as JobLease;
}

function durable(jobId: string) {
	return f.store.read((sql) => ({
		job: sql.get<{ state: string; attempts: number; nextAt: number; leaseUntil: number | null }>(
			"SELECT state,attempts,next_at AS nextAt,lease_until AS leaseUntil FROM jobs WHERE id=?",
			[jobId],
		),
		events: sql.get<{ count: number }>("SELECT count(*) AS count FROM events")?.count,
		lastSeq: sql.get<{ last_seq: number }>("SELECT last_seq FROM event_meta")?.last_seq,
	}));
}

function fillCapacity(): { accounts: string[]; leases: JobLease[] } {
	const accounts: string[] = [];
	f.database.write((scope) => {
		for (let n = 0; n < 256; n++) {
			const accountId = testId(1_000 + n);
			accounts.push(accountId);
			f.queue.enqueue(scope, {
				id: testId(2_000 + n),
				accountId,
				ownerId: OWNER,
				kind: "sync",
				refId: REF,
			});
		}
	});
	const leases = f.database.write((scope) =>
		accounts.map((accountId) => {
			const lease = f.queue.claim(scope, accountId);
			expect(lease).toBeDefined();
			return lease as JobLease;
		}),
	);
	return { accounts, leases };
}

beforeEach(async () => {
	f = await fixture();
});
afterEach(() => f.cleanup());

describe("native live-handle capacity", () => {
	it("admits 256, refuses 257 before durable claim and frees exactly one slot on completion", () => {
		const { leases } = fillCapacity();
		const extra = enqueue(256);
		const beyond = enqueue(257);
		const before = durable(extra.jobId);
		expect(() => claim(extra.accountId)).toThrow(WorkError);
		expect(durable(extra.jobId)).toEqual(before);
		expect(before.job).toMatchObject({ state: "PENDING", attempts: 0, leaseUntil: null });
		f.database.write((scope) => f.queue.complete(scope, leases[0] as JobLease));
		const replacement = admitted(extra.accountId);
		expect(replacement.job).toMatchObject({ id: extra.jobId, state: "RUNNING", attempts: 1 });
		const fullAgain = durable(beyond.jobId);
		expect(() => claim(beyond.accountId)).toThrow(WorkError);
		expect(durable(beyond.jobId)).toEqual(fullAgain);
		expect(
			f.store.read(
				(sql) => sql.get<{ n: number }>("SELECT count(*) AS n FROM jobs WHERE state='RUNNING'")?.n,
			),
		).toBe(256);
	});

	it("cleans expired bounded handles before admission without requeuing unexpired durable rows", () => {
		const { leases } = fillCapacity();
		const extra = enqueue(256);
		const before = durable(extra.jobId);
		f.clock.monotonic += JOB_LEASE_MS;
		const replacement = admitted(extra.accountId);
		expect(replacement.job.id).toBe(extra.jobId);
		expect(durable(extra.jobId)).toMatchObject({
			job: { state: "RUNNING", attempts: 1 },
			events: (before.events as number) + 1,
			lastSeq: (before.lastSeq as number) + 1,
		});
		// The wall clock did not expire the other accounts' durable rows.
		expect(
			f.store.read(
				(sql) => sql.get<{ n: number }>("SELECT count(*) AS n FROM jobs WHERE state='RUNNING'")?.n,
			),
		).toBe(257);
		expect(() =>
			f.database.write((scope) => f.queue.complete(scope, leases[0] as JobLease)),
		).toThrow(WorkError);
		f.database.write((scope) => f.queue.complete(scope, replacement));
	});
});

describe("native retry and addition bounds", () => {
	it("accepts exactly 24 hours, refuses one millisecond more without consuming the valid lease", () => {
		const job = enqueue();
		const lease = claim(job.accountId);
		const before = durable(job.jobId);
		expect(() => f.database.write((scope) => f.queue.fail(scope, lease, DAY + 1))).toThrow(
			WorkError,
		);
		expect(durable(job.jobId)).toEqual(before);
		f.database.write((scope) => f.queue.fail(scope, lease, DAY));
		expect(durable(job.jobId)).toMatchObject({
			job: { state: "PENDING", attempts: 1, nextAt: f.clock.wall + DAY, leaseUntil: null },
			events: (before.events as number) + 1,
		});
	});

	it("accepts the inclusive safe wall-plus-lease edge and completes before expiry", () => {
		f.clock.wall = MAX - JOB_LEASE_MS;
		const job = enqueue();
		const lease = claim(job.accountId);
		expect(lease.job.leaseUntil).toBe(MAX);
		f.clock.wall = MAX - 1;
		f.database.write((scope) => f.queue.complete(scope, lease));
		expect(durable(job.jobId).job).toMatchObject({
			state: "SUCCEEDED",
			attempts: 1,
			leaseUntil: null,
		});
	});

	it("rolls back an overflowing wall-plus-lease claim before attempts/events advance", () => {
		f.clock.wall = MAX - JOB_LEASE_MS + 1;
		const job = enqueue();
		const before = durable(job.jobId);
		expect(() => claim(job.accountId)).toThrow(WorkError);
		expect(durable(job.jobId)).toEqual(before);
	});

	it("accepts the inclusive finite monotonic-plus-lease edge", () => {
		f.clock.monotonic = MAX - JOB_LEASE_MS;
		const job = enqueue();
		const lease = claim(job.accountId);
		f.clock.monotonic = MAX - 1;
		f.database.write((scope) => f.queue.complete(scope, lease));
		expect(durable(job.jobId).job?.state).toBe("SUCCEEDED");
	});

	it("rolls back monotonic-plus-lease overflow after native claim writes and issues no capability", () => {
		f.clock.monotonic = MAX - JOB_LEASE_MS + 1;
		const job = enqueue();
		const before = durable(job.jobId);
		expect(() => claim(job.accountId)).toThrow(WorkError);
		expect(durable(job.jobId)).toEqual(before);
		f.clock.monotonic--;
		expect(claim(job.accountId).job).toMatchObject({ state: "RUNNING", attempts: 1 });
	});

	it("accepts fractional monotonic time while preserving the exact finite upper boundary", () => {
		f.clock.monotonic = 0.5;
		const job = enqueue();
		const lease = claim(job.accountId);
		f.clock.monotonic = JOB_LEASE_MS + 0.25;
		f.database.write((scope) => f.queue.complete(scope, lease));
		expect(durable(job.jobId).job?.state).toBe("SUCCEEDED");
	});

	it("accepts wall-plus-retry exactly at the maximum safe integer", () => {
		f.clock.wall = MAX - DAY;
		const job = enqueue();
		const lease = claim(job.accountId);
		f.database.write((scope) => f.queue.fail(scope, lease, DAY));
		expect(durable(job.jobId).job).toMatchObject({ state: "PENDING", attempts: 1, nextAt: MAX });
	});

	it("rolls back overflowing retry scheduling and never revives its consumed capability", () => {
		f.clock.wall = MAX - DAY + 1;
		const job = enqueue();
		const lease = claim(job.accountId);
		const before = durable(job.jobId);
		expect(() => f.database.write((scope) => f.queue.fail(scope, lease, DAY))).toThrow(WorkError);
		expect(durable(job.jobId)).toEqual(before);
		f.clock.wall--;
		expect(() => f.database.write((scope) => f.queue.complete(scope, lease))).toThrow(WorkError);
		expect(durable(job.jobId)).toEqual(before);
	});

	it.each(["wall", "monotonic"] as const)(
		"rolls back %s renewal overflow and burns the old lease",
		(clock) => {
			f.clock[clock] = MAX - JOB_LEASE_MS;
			const job = enqueue();
			const lease = claim(job.accountId);
			const before = durable(job.jobId);
			f.clock[clock]++;
			expect(() => f.database.write((scope) => f.queue.renew(scope, lease))).toThrow(WorkError);
			expect(durable(job.jobId)).toEqual(before);
			f.clock[clock]--;
			expect(() => f.database.write((scope) => f.queue.complete(scope, lease))).toThrow(WorkError);
			expect(durable(job.jobId)).toEqual(before);
		},
	);
});

describe("bad clock observation consumes authority", () => {
	it.each([
		["wall", -1],
		["wall", Number.NaN],
		["wall", MAX + 1],
		["wall", 0.5],
		["monotonic", -1],
		["monotonic", Number.NaN],
		["monotonic", Number.POSITIVE_INFINITY],
		["monotonic", MAX + 1],
	] as const)("never revives after invalid %s=%s was observed", (clock, invalid) => {
		const job = enqueue();
		const lease = claim(job.accountId);
		const before = durable(job.jobId);
		const previous = f.clock[clock];
		f.clock[clock] = invalid;
		expect(() => f.database.write((scope) => f.queue.complete(scope, lease))).toThrow(WorkError);
		f.clock[clock] = previous;
		expect(durable(job.jobId)).toEqual(before);
		expect(() => f.database.write((scope) => f.queue.complete(scope, lease))).toThrow(WorkError);
		expect(durable(job.jobId)).toEqual(before);
	});

	it("does not equate an ordinary backward wall step with lease expiry or process death", () => {
		const job = enqueue();
		const lease = claim(job.accountId);
		f.clock.wall--;
		f.clock.monotonic++;
		f.database.write((scope) => f.queue.complete(scope, lease));
		expect(durable(job.jobId).job?.state).toBe("SUCCEEDED");
	});
});
