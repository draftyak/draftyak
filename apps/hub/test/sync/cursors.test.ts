import { createHash } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import type { JobLease } from "../../src/jobs/queue.ts";
import type { SyncScan } from "../../src/sync/cursors.ts";
import { requireLoopbackNetworkGuard } from "../helpers/loopback-network.ts";

requireLoopbackNetworkGuard();
const [{ newId }, { NativeSyncCursors, NativeSyncCursorError }, { fixture, emailMessage }] =
	await Promise.all([
		import("../../src/kernel/ids.ts"),
		import("../../src/sync/cursors.ts"),
		import("./apply-fixture.ts"),
	]);
type Fixture = Awaited<ReturnType<typeof fixture>>;
const opened: Fixture[] = [];
const DAY_MS = 86_400_000;
const NOW = 1_700_000_000_000;
async function setup() {
	const f = await fixture();
	opened.push(f);
	return {
		f,
		cursors: new NativeSyncCursors(
			f.database,
			f.model,
			f.devices,
			f.jobs,
			f.accounts,
			f.nativeClock,
		),
	};
}
afterEach(async () => {
	await Promise.all(opened.splice(0).map((f) => f.cleanup()));
});
function start(f: Fixture, cursors: InstanceType<typeof NativeSyncCursors>, since = 0) {
	return f.database.write((scope) => {
		const scanId = newId(),
			jobId = newId();
		f.jobs.enqueue(scope, {
			id: jobId,
			accountId: f.account.id,
			ownerId: f.account.userId,
			kind: "sync",
			refId: scanId,
		});
		const current = cursors.current(scope, f.ref());
		const scan = cursors.create(scope, f.ref(), {
			scanId,
			jobId,
			requestMode: current.checkpoint.cursor === null ? "initial" : "delta",
			since,
		});
		const lease = f.jobs.claim(scope, f.account.id, jobId);
		if (!lease) throw new Error("Synthetic scan job was not claimed");
		return { scan, lease };
	});
}
function commit(
	f: Fixture,
	cursors: InstanceType<typeof NativeSyncCursors>,
	scan: SyncScan,
	lease: JobLease,
	cursor: string,
	more = false,
	withObservation = false,
) {
	return f.database.write((scope) => {
		cursors.check(scope, f.ref(), scan.scanId, scan.version);
		f.model.applyPage(
			scope,
			lease,
			f.page(withObservation ? [emailMessage()] : [], {
				expectedCursor: scan.cursor,
				expectedRevision: scan.revision,
				cursor,
			}),
		);
		scope.sql.run(
			`INSERT INTO main.sync_scan_pages(scan_id,ordinal,account_id,generation,job_id,previous_cursor,previous_revision,reported_more,resync_count,continuation_digest)
 VALUES(?,?,?,?,?,?,?,?,?,?)`,
			[
				scan.scanId,
				scan.ordinal,
				scan.accountId,
				scan.generation,
				scan.jobId,
				scan.cursor,
				scan.revision,
				more ? 1 : 0,
				scan.resyncCount,
				createHash("sha256").update(cursor).digest("hex"),
			],
		);
		if (withObservation) {
			const message = f.model.messages(scope, f.ref())[0];
			if (!message) throw new Error("Synthetic message metadata missing");
			scope.sql.run(
				`INSERT INTO main.sync_page_observations(scan_id,page_ordinal,change_index,account_id,generation,kind,provider_id,thread_id,message_id)
 VALUES(?,?,0,?,?,'email.message',?,?,?)`,
				[
					scan.scanId,
					scan.ordinal,
					scan.accountId,
					scan.generation,
					message.providerId,
					message.threadId,
					message.id,
				],
			);
		}
		let nextJobId: string | null = null;
		if (more) {
			nextJobId = newId();
			f.jobs.enqueue(scope, {
				id: nextJobId,
				accountId: scan.accountId,
				ownerId: scan.ownerId,
				kind: "sync",
				refId: scan.scanId,
			});
		}
		return cursors.advanceApplied(scope, f.ref(), {
			scanId: scan.scanId,
			expectedVersion: scan.version,
			jobId: scan.jobId,
			nextJobId,
			reportedMore: more,
		});
	});
}
function claim(f: Fixture, scan: SyncScan): JobLease {
	const lease = f.database.write((scope) => f.jobs.claim(scope, scan.accountId, scan.jobId));
	if (!lease) throw new Error("Synthetic continuation job was not claimed");
	return lease;
}

describe("native sync cursor journal", () => {
	it("derives a direct original creation boundary instead of trusting caller since zero", async () => {
		const { f, cursors } = await setup();
		f.clock.wall = NOW;
		const { scan, lease } = start(f, cursors);
		const expected = NOW - f.account.historyLimitDays * DAY_MS;
		expect(expected).toBeGreaterThan(0);
		expect(scan.since).toBe(expected);
		expect(
			f.database.write((scope) =>
				scope.sql.get(
					"SELECT anchor_version,sampled_at,history_days,anchor_job_id,job_created_at FROM main.sync_scan_anchors WHERE scan_id=?",
					[scan.scanId],
				),
			),
		).toEqual({
			anchor_version: 1,
			sampled_at: NOW,
			history_days: f.account.historyLimitDays,
			anchor_job_id: scan.jobId,
			job_created_at: NOW,
		});
		f.clock.wall += 1;
		f.clock.monotonic += 1;
		expect(
			f.database.write((scope) => cursors.check(scope, f.ref(), scan.scanId, scan.version)).since,
		).toBe(expected);
		f.database.write((scope) => f.jobs.complete(scope, lease));
	});
	it("preserves a seven-day DATA restriction inside a thirty-day native account window", async () => {
		const { f, cursors } = await setup();
		f.clock.wall = NOW;
		expect(f.account.historyLimitDays).toBe(30);
		const requestedSince = NOW - 7 * DAY_MS;
		const { scan, lease } = start(f, cursors, requestedSince);
		expect(scan.since).toBe(requestedSince);
		f.clock.wall += 1;
		expect(
			f.database.write((scope) => cursors.check(scope, f.ref(), scan.scanId, scan.version)).since,
		).toBe(requestedSince);
		f.database.write((scope) => f.jobs.complete(scope, lease));
	});
	it("refuses lowering a native pass restriction and preserves a stricter requested resync bound", async () => {
		const { f, cursors } = await setup();
		f.clock.wall = NOW;
		const requestedSince = NOW - 7 * DAY_MS;
		const first = start(f, cursors, requestedSince);
		const partial = commit(f, cursors, first.scan, first.lease, "DYTEST-narrow-pass", true);
		f.database.write((scope) => f.jobs.cancel(scope, partial.jobId));
		const refusedJob = newId();
		expect(() =>
			f.database.write((scope) => {
				f.jobs.enqueue(scope, {
					id: refusedJob,
					accountId: f.account.id,
					ownerId: f.account.userId,
					kind: "sync",
					refId: partial.scanId,
				});
				cursors.resync(
					scope,
					f.ref(),
					partial.scanId,
					partial.version,
					refusedJob,
					requestedSince - 1,
				);
			}),
		).toThrow(NativeSyncCursorError);
		expect(f.database.write((scope) => f.jobs.get(scope, refusedJob))).toBeUndefined();
		const stricterSince = NOW - 3 * DAY_MS;
		const reset = f.database.write((scope) => {
			const jobId = newId();
			f.jobs.enqueue(scope, {
				id: jobId,
				accountId: f.account.id,
				ownerId: f.account.userId,
				kind: "sync",
				refId: partial.scanId,
			});
			return cursors.resync(scope, f.ref(), partial.scanId, partial.version, jobId, stricterSince);
		});
		expect(reset.since).toBe(stricterSince);
		expect(reset.resyncCount).toBe(1);
		expect(
			f.database.write((scope) => cursors.check(scope, f.ref(), reset.scanId, reset.version)).since,
		).toBe(stricterSince);
		const currentLease = claim(f, reset);
		f.database.write((scope) => f.jobs.complete(scope, currentLease));
	});
	it("derives a direct original resync boundary when its caller omits a restriction", async () => {
		const { f, cursors } = await setup();
		f.clock.wall = NOW;
		const first = start(f, cursors);
		const partial = commit(f, cursors, first.scan, first.lease, "DYTEST-native-anchor", true);
		f.clock.wall += 1_000;
		f.clock.monotonic += 1_000;
		const scan = f.database.write((scope) => {
			f.jobs.cancel(scope, partial.jobId);
			const jobId = newId();
			f.jobs.enqueue(scope, {
				id: jobId,
				accountId: f.account.id,
				ownerId: f.account.userId,
				kind: "sync",
				refId: partial.scanId,
			});
			return cursors.resync(scope, f.ref(), partial.scanId, partial.version, jobId);
		});
		expect(scan.since).toBe(f.clock.wall - f.account.historyLimitDays * DAY_MS);
		expect(scan.since).toBeGreaterThan(first.scan.since ?? 0);
		expect(scan.resyncCount).toBe(1);
		expect(
			f.database.write((scope) => cursors.continuation(scope, f.ref(), scan.scanId, scan.version)),
		).toBeNull();
		const lease = claim(f, scan);
		f.database.write((scope) => f.jobs.complete(scope, lease));
	});
	it("rejects foreign original account binding and rolls back the matching native enqueue", async () => {
		const { f } = await setup();
		const foreign = await setup();
		const cursors = new NativeSyncCursors(
			f.database,
			f.model,
			f.devices,
			f.jobs,
			foreign.f.accounts,
			f.nativeClock,
		);
		const scanId = newId(),
			jobId = newId();
		expect(() =>
			f.database.write((scope) => {
				f.jobs.enqueue(scope, {
					id: jobId,
					accountId: f.account.id,
					ownerId: f.account.userId,
					kind: "sync",
					refId: scanId,
				});
				cursors.create(scope, f.ref(), { scanId, jobId, requestMode: "initial", since: 0 });
			}),
		).toThrow(NativeSyncCursorError);
		expect(f.database.write((scope) => f.jobs.get(scope, jobId))).toBeUndefined();
	});
	it("refuses an anchor sampled before its original native job birth", async () => {
		const { f, cursors } = await setup();
		f.clock.wall = NOW;
		const scanId = newId(),
			jobId = newId();
		try {
			expect(() =>
				f.database.write((scope) => {
					f.jobs.enqueue(scope, {
						id: jobId,
						accountId: f.account.id,
						ownerId: f.account.userId,
						kind: "sync",
						refId: scanId,
					});
					f.clock.wall -= 1;
					cursors.create(scope, f.ref(), { scanId, jobId, requestMode: "initial", since: 0 });
				}),
			).toThrow(NativeSyncCursorError);
		} finally {
			f.clock.wall = NOW;
		}
		expect(f.database.write((scope) => f.jobs.get(scope, jobId))).toBeUndefined();
	});
	it("keeps legacy DATA readable but retires its original active job before fresh work", async () => {
		const { f, cursors } = await setup();
		f.clock.wall = NOW;
		const old = start(f, cursors);
		f.database.write((scope) =>
			scope.sql.run("DELETE FROM main.sync_scan_anchors WHERE scan_id=?", [old.scan.scanId]),
		);
		expect(f.database.write((scope) => cursors.get(scope, f.ref(), old.scan.scanId))?.since).toBe(
			old.scan.since,
		);
		expect(() =>
			f.database.write((scope) => cursors.check(scope, f.ref(), old.scan.scanId, old.scan.version)),
		).toThrow(NativeSyncCursorError);
		expect(() => f.database.write((scope) => cursors.active(scope, f.ref()))).toThrow(
			NativeSyncCursorError,
		);
		expect(f.database.write((scope) => cursors.retireUnanchored(scope, f.ref()))).toBe(true);
		expect(f.database.write((scope) => cursors.retireUnanchored(scope, f.ref()))).toBe(false);
		expect(f.database.write((scope) => f.jobs.get(scope, old.scan.jobId))?.state).toBe("CANCELLED");
		expect(() => f.database.write((scope) => f.jobs.renew(scope, old.lease))).toThrow();
		const current = start(f, cursors);
		expect(current.scan.since).toBe(NOW - f.account.historyLimitDays * DAY_MS);
		expect(f.database.write((scope) => f.model.checkpoint(scope, f.ref()))).toEqual({
			cursor: null,
			revision: 0,
		});
		f.database.write((scope) => f.jobs.complete(scope, current.lease));
	});
	it.each(["clock", "days", "job", "job-birth", "since"] as const)(
		"refuses corrupt durable anchor %s without legacy promotion",
		async (changed) => {
			const { f, cursors } = await setup();
			f.clock.wall = NOW;
			const { scan } = start(f, cursors);
			f.database.write((scope) => {
				if (changed === "clock")
					scope.sql.run(
						"UPDATE main.sync_scan_anchors SET sampled_at=sampled_at-1 WHERE scan_id=?",
						[scan.scanId],
					);
				if (changed === "days")
					scope.sql.run(
						"UPDATE main.sync_scan_anchors SET history_days=history_days+1 WHERE scan_id=?",
						[scan.scanId],
					);
				if (changed === "job")
					scope.sql.run("UPDATE main.sync_scan_anchors SET anchor_job_id=? WHERE scan_id=?", [
						newId(),
						scan.scanId,
					]);
				if (changed === "job-birth")
					scope.sql.run(
						"UPDATE main.sync_scan_anchors SET job_created_at=sampled_at+1 WHERE scan_id=?",
						[scan.scanId],
					);
				if (changed === "since")
					scope.sql.run("UPDATE main.sync_scans SET since=0 WHERE id=?", [scan.scanId]);
			});
			expect(() =>
				f.database.write((scope) => cursors.check(scope, f.ref(), scan.scanId, scan.version)),
			).toThrow(NativeSyncCursorError);
			expect(f.database.write((scope) => cursors.retireUnanchored(scope, f.ref()))).toBe(false);
		},
	);
	it("preserves a native anchor across reopen without retaining the completed anchor job", async () => {
		const { f, cursors } = await setup();
		f.clock.wall = NOW;
		const first = start(f, cursors);
		const partial = commit(f, cursors, first.scan, first.lease, "DYTEST-pruned-anchor-job", true);
		expect(
			f.database.write((scope) =>
				scope.sql.run("DELETE FROM main.jobs WHERE id=? AND state='SUCCEEDED'", [first.scan.jobId]),
			).changes,
		).toBe(1);
		await f.reopen();
		const reopened = new NativeSyncCursors(
			f.database,
			f.model,
			f.devices,
			f.jobs,
			f.accounts,
			f.nativeClock,
		);
		const held = claim(f, partial);
		expect(
			f.database.write((scope) => reopened.check(scope, f.ref(), partial.scanId, partial.version))
				.since,
		).toBe(first.scan.since);
		const finished = commit(f, reopened, partial, held, "DYTEST-after-anchor-job-prune");
		expect(finished.status).toBe("waiting");
		expect(finished.revision).toBe(2);
	});
	it("starts three consecutive successful scans and retains waiting history", async () => {
		const { f, cursors } = await setup();
		for (let i = 0; i < 3; i++) {
			const { scan, lease } = start(f, cursors);
			expect(scan.requestMode).toBe(i === 0 ? "initial" : "delta");
			const result = commit(f, cursors, scan, lease, "DYTEST-idle-cursor");
			expect(result).toMatchObject({ status: "waiting", ordinal: 1, revision: i + 1 });
			expect(result.jobId).toBe(scan.jobId);
		}
		const scans = f.database.write((scope) => cursors.list(scope, f.ref()));
		expect(scans).toHaveLength(3);
		expect(scans.every((scan) => scan.status === "waiting")).toBe(true);
		expect(Object.isFrozen(scans)).toBe(true);
	});
	it("permits a stationary empty first delta page but not a page with observations", async () => {
		const { f, cursors } = await setup();
		let work = start(f, cursors);
		commit(f, cursors, work.scan, work.lease, "DYTEST-idle");
		work = start(f, cursors);
		expect(() => commit(f, cursors, work.scan, work.lease, "DYTEST-idle", false, true)).toThrow(
			NativeSyncCursorError,
		);
		expect(f.database.write((scope) => f.model.checkpoint(scope, f.ref()))).toEqual({
			cursor: "DYTEST-idle",
			revision: 1,
		});
		expect(f.database.write((scope) => f.model.messages(scope, f.ref()))).toEqual([]);
	});
	it("refuses a continuing stationary cursor and rolls back the metadata page", async () => {
		const { f, cursors } = await setup();
		const first = start(f, cursors);
		commit(f, cursors, first.scan, first.lease, "DYTEST-idle");
		const next = start(f, cursors);
		expect(() => commit(f, cursors, next.scan, next.lease, "DYTEST-idle", true)).toThrow(
			NativeSyncCursorError,
		);
		expect(f.database.write((scope) => f.model.checkpoint(scope, f.ref())).revision).toBe(1);
	});
	it("rejects a terminal return to the pass origin after genuine forward progress", async () => {
		const { f, cursors } = await setup();
		const seed = start(f, cursors);
		commit(f, cursors, seed.scan, seed.lease, "DYTEST-a");
		const next = start(f, cursors);
		const advanced = commit(f, cursors, next.scan, next.lease, "DYTEST-b", true);
		expect(() => commit(f, cursors, advanced, claim(f, advanced), "DYTEST-a")).toThrow(
			NativeSyncCursorError,
		);
		expect(f.database.write((scope) => f.model.checkpoint(scope, f.ref()))).toEqual({
			cursor: "DYTEST-b",
			revision: 2,
		});
	});
	it("rejects a terminal cursor already seen earlier in the same pass", async () => {
		const { f, cursors } = await setup();
		const first = start(f, cursors);
		const a = commit(f, cursors, first.scan, first.lease, "DYTEST-a", true);
		const b = commit(f, cursors, a, claim(f, a), "DYTEST-b", true);
		expect(() => commit(f, cursors, b, claim(f, b), "DYTEST-a")).toThrow();
		expect(f.database.write((scope) => f.model.checkpoint(scope, f.ref()))).toEqual({
			cursor: "DYTEST-b",
			revision: 2,
		});
	});
	it("allows only one active scan per account and rolls back a caught second enqueue", async () => {
		const { f, cursors } = await setup();
		const first = start(f, cursors);
		let attempted = "";
		expect(() =>
			f.database.write((scope) => {
				const scanId = newId();
				attempted = newId();
				f.jobs.enqueue(scope, {
					id: attempted,
					accountId: f.account.id,
					ownerId: f.account.userId,
					kind: "sync",
					refId: scanId,
				});
				try {
					cursors.create(scope, f.ref(), {
						scanId,
						jobId: attempted,
						requestMode: "initial",
						since: 0,
					});
				} catch {}
			}),
		).toThrow();
		expect(f.database.write((scope) => f.jobs.get(scope, attempted))).toBeUndefined();
		expect(
			f.database.write((scope) => cursors.get(scope, f.ref(), first.scan.scanId))?.version,
		).toBe(1);
	});
	it("requires the original matching sync job rather than another native job", async () => {
		const { f, cursors } = await setup();
		const scanId = newId(),
			jobId = newId();
		expect(() =>
			f.database.write((scope) => {
				f.jobs.enqueue(scope, {
					id: jobId,
					accountId: f.account.id,
					ownerId: f.account.userId,
					kind: "draft",
					refId: scanId,
				});
				cursors.create(scope, f.ref(), { scanId, jobId, requestMode: "initial", since: 0 });
			}),
		).toThrow(NativeSyncCursorError);
		expect(f.database.write((scope) => f.jobs.get(scope, jobId))).toBeUndefined();
	});
	it("retires the original running scan after genuine account replacement and keeps the new generation usable", async () => {
		const { f, cursors } = await setup();
		const oldRef = f.ref();
		const old = start(f, cursors);
		expect(old.lease.job.state).toBe("RUNNING");
		const replacement = f.database.write((scope) =>
			f.accounts.replace(
				scope,
				{ ...f.account, mode: "read_only", historyLimitDays: 7 },
				f.generation,
			),
		);
		expect(replacement.generation).toBe(oldRef.generation + 1);
		if (replacement.account.channel !== "email")
			throw new Error("Synthetic replacement account is not email");
		f.account = replacement.account;
		f.generation = replacement.generation;
		expect(() =>
			f.database.write((scope) => cursors.check(scope, oldRef, old.scan.scanId, old.scan.version)),
		).toThrow(NativeSyncCursorError);
		const fresh = start(f, cursors);
		expect(fresh.scan).toMatchObject({
			generation: replacement.generation,
			mode: "read_only",
			status: "active",
		});
		expect(fresh.scan.scanId).not.toBe(old.scan.scanId);
		expect(fresh.lease.job.state).toBe("RUNNING");
		expect(f.database.write((scope) => f.jobs.get(scope, old.scan.jobId))?.state).toBe("CANCELLED");
		expect(
			f.native.store.read((sql) =>
				sql.get<{ status: string; version: number; generation: number }>(
					"SELECT status,version,generation FROM main.sync_scans WHERE id=?",
					[old.scan.scanId],
				),
			),
		).toEqual({
			status: "cancelled",
			version: old.scan.version + 1,
			generation: oldRef.generation,
		});
		expect(() => f.database.write((scope) => f.jobs.renew(scope, old.lease))).toThrow(
			"Durable work lease refused",
		);
		expect(() => commit(f, cursors, fresh.scan, old.lease, "DYTEST-retired-lease")).toThrow();
		expect(f.database.write((scope) => f.model.checkpoint(scope, f.ref()))).toEqual({
			cursor: null,
			revision: 0,
		});
		expect(f.database.write((scope) => f.jobs.get(scope, fresh.scan.jobId))?.state).toBe("RUNNING");
		const applied = commit(f, cursors, fresh.scan, fresh.lease, "DYTEST-replacement-current");
		expect(applied).toMatchObject({
			generation: replacement.generation,
			mode: "read_only",
			status: "waiting",
			cursor: "DYTEST-replacement-current",
			revision: 1,
		});
	});
	it("refuses stale versions without committing a caught surrounding write", async () => {
		const { f, cursors } = await setup();
		const { scan } = start(f, cursors);
		expect(() =>
			f.database.write((scope) => {
				try {
					cursors.check(scope, f.ref(), scan.scanId, 2);
				} catch {}
			}),
		).toThrow();
		expect(f.database.write((scope) => cursors.check(scope, f.ref(), scan.scanId, 1)).version).toBe(
			1,
		);
	});
	it("does not accept success without the native page ledger and original completed job", async () => {
		const { f, cursors } = await setup();
		const { scan } = start(f, cursors);
		expect(() =>
			f.database.write((scope) =>
				cursors.advanceApplied(scope, f.ref(), {
					scanId: scan.scanId,
					expectedVersion: scan.version,
					jobId: scan.jobId,
					nextJobId: null,
					reportedMore: false,
				}),
			),
		).toThrow(NativeSyncCursorError);
		expect(f.database.write((scope) => f.model.checkpoint(scope, f.ref()))).toEqual({
			cursor: null,
			revision: 0,
		});
	});
	it("allows one native cancelled-job resync and retains the total page budget", async () => {
		const { f, cursors } = await setup();
		const first = start(f, cursors);
		const advanced = commit(f, cursors, first.scan, first.lease, "DYTEST-a", true);
		const replacement = f.database.write((scope) => {
			f.jobs.cancel(scope, advanced.jobId);
			const jobId = newId();
			f.jobs.enqueue(scope, {
				id: jobId,
				accountId: f.account.id,
				ownerId: f.account.userId,
				kind: "sync",
				refId: advanced.scanId,
			});
			return cursors.resync(scope, f.ref(), advanced.scanId, advanced.version, jobId, 1);
		});
		expect(replacement).toMatchObject({
			resyncCount: 1,
			requestMode: "resync",
			ordinal: 1,
			since: 1,
			cursor: "DYTEST-a",
		});
		expect(() =>
			f.database.write((scope) => {
				f.jobs.cancel(scope, replacement.jobId);
				const jobId = newId();
				f.jobs.enqueue(scope, {
					id: jobId,
					accountId: f.account.id,
					ownerId: f.account.userId,
					kind: "sync",
					refId: replacement.scanId,
				});
				cursors.resync(scope, f.ref(), replacement.scanId, replacement.version, jobId, 2);
			}),
		).toThrow(NativeSyncCursorError);
		expect(f.database.write((scope) => f.jobs.get(scope, replacement.jobId))?.state).toBe(
			"PENDING",
		);
	});
	it("refuses a fresh resync-mode scan rather than resetting its resync budget", async () => {
		const { f, cursors } = await setup();
		expect(() =>
			f.database.write((scope) => {
				const scanId = newId(),
					jobId = newId();
				f.jobs.enqueue(scope, {
					id: jobId,
					accountId: f.account.id,
					ownerId: f.account.userId,
					kind: "sync",
					refId: scanId,
				});
				cursors.create(scope, f.ref(), { scanId, jobId, requestMode: "resync", since: 0 });
			}),
		).toThrow(NativeSyncCursorError);
	});
	it("requires genuine cancelled state before stopping and permits normal cancellation", async () => {
		const { f, cursors } = await setup();
		const { scan } = start(f, cursors);
		expect(() =>
			f.database.write((scope) =>
				cursors.stop(scope, f.ref(), scan.scanId, scan.version, "cancelled"),
			),
		).toThrow(NativeSyncCursorError);
		const cancelled = f.database.write((scope) => {
			f.jobs.cancel(scope, scan.jobId);
			return cursors.stop(scope, f.ref(), scan.scanId, scan.version, "cancelled");
		});
		expect(cancelled).toMatchObject({ status: "cancelled", version: 2 });
		const next = start(f, cursors);
		expect(next.scan.scanId).not.toBe(scan.scanId);
	});
	it("rejects copied and retired scopes without invoking supplied accessors", async () => {
		const { f, cursors } = await setup();
		let retired: Parameters<typeof cursors.current>[0] | undefined;
		f.database.write((scope) => {
			retired = scope;
		});
		expect(() => cursors.current(retired!, f.ref())).toThrow(NativeSyncCursorError);
		let calls = 0;
		const copied = Object.defineProperty({}, "sql", {
			get() {
				calls++;
				throw new Error("trap");
			},
		});
		expect(() => cursors.current(copied as Parameters<typeof cursors.current>[0], f.ref())).toThrow(
			NativeSyncCursorError,
		);
		expect(calls).toBe(0);
	});
	it("refuses accessor reference input without calling its getter", async () => {
		const { f, cursors } = await setup();
		let calls = 0;
		const ref = Object.defineProperty({ ...f.ref() }, "generation", {
			enumerable: true,
			get() {
				calls++;
				return 1;
			},
		});
		expect(() => f.database.write((scope) => cursors.current(scope, ref))).toThrow(
			NativeSyncCursorError,
		);
		expect(calls).toBe(0);
	});
	it("refuses a foreign native metadata store rather than accepting structural affinity", async () => {
		const { f, cursors } = await setup();
		const second = await setup();
		expect(f.database.write((scope) => cursors.current(scope, f.ref())).ownerId).toBe(
			f.account.userId,
		);
		const foreign = new NativeSyncCursors(
			f.database,
			second.f.model,
			f.devices,
			f.jobs,
			f.accounts,
			f.nativeClock,
		);
		expect(() => f.database.write((scope) => foreign.current(scope, f.ref()))).toThrow(
			NativeSyncCursorError,
		);
	});
	it("bounds list reads and detaches immutable results", async () => {
		const { f, cursors } = await setup();
		const { scan } = start(f, cursors);
		expect(() => f.database.write((scope) => cursors.list(scope, f.ref(), null, 101))).toThrow(
			NativeSyncCursorError,
		);
		const result = f.database.write((scope) => cursors.list(scope, f.ref(), null, 1));
		expect(result).toHaveLength(1);
		expect(result[0]?.scanId).toBe(scan.scanId);
		expect(Object.isFrozen(result[0])).toBe(true);
	});
	it("finds and resumes the current active scan after more than one hundred waiting scans", async () => {
		const { f, cursors } = await setup();
		for (let i = 0; i < 101; i++) {
			const { scan, lease } = start(f, cursors);
			commit(f, cursors, scan, lease, "DYTEST-history-cursor");
		}
		const { scan, lease } = start(f, cursors);
		const found = f.database.write((scope) => cursors.active(scope, f.ref()));
		expect(found?.scanId).toBe(scan.scanId);
		expect(f.database.write((scope) => cursors.list(scope, f.ref()))).toHaveLength(100);
		const result = commit(f, cursors, found!, lease, "DYTEST-resumed-cursor");
		expect(result).toMatchObject({ status: "waiting", revision: 102 });
		expect(f.database.write((scope) => cursors.active(scope, f.ref()))).toBeUndefined();
	});
	it("recovers the durable journal after reopening the genuine store", async () => {
		const { f, cursors } = await setup();
		f.clock.wall = NOW;
		const { scan, lease } = start(f, cursors);
		const saved = commit(f, cursors, scan, lease, "DYTEST-durable");
		await f.reopen();
		const reopened = new NativeSyncCursors(
			f.database,
			f.model,
			f.devices,
			f.jobs,
			f.accounts,
			f.nativeClock,
		);
		expect(f.database.write((scope) => reopened.get(scope, f.ref(), scan.scanId))).toMatchObject({
			status: "waiting",
			cursor: "DYTEST-durable",
			revision: 1,
			ordinal: 1,
		});
		expect(
			f.database.write((scope) => reopened.check(scope, f.ref(), saved.scanId, saved.version))
				.since,
		).toBe(saved.since);
	});
});
