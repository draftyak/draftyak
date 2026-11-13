import { afterEach, describe, expect, it } from "vitest";
import type { JobLease } from "../../src/jobs/queue.ts";
import type { SyncScan, SyncScanRef } from "../../src/sync/cursors.ts";
import type { PreparedSyncPage } from "../../src/sync/engine.ts";
import { requireLoopbackNetworkGuard } from "../helpers/loopback-network.ts";
import type { NativeApplyFixture } from "./apply-fixture.ts";

requireLoopbackNetworkGuard();
const [
	{ emailMessage, fixture },
	{ NativeSyncEngine },
	{ NativeSyncCursors },
	{ NativeSyncPages },
	{ NativeSyncError },
	{ JobQueue },
	{ newId },
] = await Promise.all([
	import("./apply-fixture.ts"),
	import("../../src/sync/engine.ts"),
	import("../../src/sync/cursors.ts"),
	import("../../src/sync/pages.ts"),
	import("../../src/sync/apply.ts"),
	import("../../src/jobs/queue.ts"),
	import("../../src/kernel/ids.ts"),
]);

const NOW = 1_700_000_000_000;
const DAY_MS = 86_400_000;
const opened: NativeApplyFixture[] = [];

afterEach(async () => {
	const all = opened.splice(0);
	const results = await Promise.allSettled(all.map((f) => f.cleanup()));
	for (const result of results) if (result.status === "rejected") throw result.reason;
});

async function setup(withMetadata = false) {
	const f = await fixture();
	opened.push(f);
	f.clock.wall = NOW;
	const clock = f.nativeClock;
	const cursors = new NativeSyncCursors(
		f.database,
		f.model,
		f.devices,
		f.jobs,
		f.accounts,
		f.nativeClock,
	);
	const engine = new NativeSyncEngine(
		f.database,
		f.accounts,
		f.jobs,
		cursors,
		clock,
		withMetadata ? f.model : undefined,
	);
	const pages = new NativeSyncPages(f.database, f.model, cursors, f.jobs);
	return { f, cursors, engine, pages, clock };
}

type Setup = Awaited<ReturnType<typeof setup>>;

function start(s: Setup, maxAttempts = 5, at?: number) {
	const scanId = newId(at);
	const jobId = newId(at);
	const scan = s.engine.enqueue(s.f.ref(), { scanId, jobId, maxAttempts });
	const ref: SyncScanRef = { ...s.f.ref(), scanId };
	return { scan, ref, jobId };
}

function claim(s: Setup, ref: SyncScanRef, scan: SyncScan) {
	const result = s.engine.claim(ref, scan.version);
	expect(result).toBeDefined();
	if (!result) throw new Error("Owned sync page was not claimed");
	return result;
}

function job(s: Setup, jobId: string) {
	return s.f.database.write((scope) => s.f.jobs.get(scope, jobId));
}

function seedMessagePage(s: Setup, changes: Parameters<NativeApplyFixture["page"]>[0]) {
	const current = start(s);
	const held = claim(s, current.ref, current.scan);
	const recorded = s.f.database.write((scope) =>
		s.pages.record(scope, held.lease, current.ref, current.scan.version, {
			changes,
			cursor: `DYTEST-message-page-${current.scan.scanId}`,
			more: false,
		}),
	);
	return { scan: recorded.scan, consumedLease: held.lease };
}

async function messageSetup(count = 1) {
	const s = await setup(true);
	const page = seedMessagePage(
		s,
		Array.from({ length: count }, (_, index) =>
			emailMessage(`DYTEST-native-message-${index}`, { internalDate: NOW - 1_000 - index }),
		),
	);
	const first = s.f.database.write((scope) => s.f.model.messages(scope, s.f.ref(), null, 100));
	if (!first[0]) throw new Error("Current native message metadata missing");
	return { ...s, page, first, message: first[0] };
}

function messageOptions(s: Setup, messageId: string) {
	return {
		jobId: newId(),
		messageId,
		expectedCheckpoint: s.f.database.write((scope) => s.f.model.checkpoint(scope, s.f.ref())),
		afterId: null as string | null,
		limit: 100,
		maxAttempts: 2,
	};
}

function releasePrepared(s: Setup, prepared: PreparedSyncPage) {
	s.f.database.write((scope) => s.f.jobs.complete(scope, prepared.lease));
}

describe("native metadata request preparation", () => {
	it("preserves a narrower original pass boundary through engine preparation and resync", async () => {
		const s = await setup();
		const scanId = newId(),
			jobId = newId();
		const requestedSince = NOW - 7 * DAY_MS;
		const scan = s.f.database.write((scope) => {
			s.f.jobs.enqueue(scope, {
				id: jobId,
				accountId: s.f.account.id,
				ownerId: s.f.account.userId,
				kind: "sync",
				refId: scanId,
			});
			return s.cursors.create(scope, s.f.ref(), {
				scanId,
				jobId,
				requestMode: "initial",
				since: requestedSince,
			});
		});
		const ref: SyncScanRef = { ...s.f.ref(), scanId };
		const held = claim(s, ref, scan);
		const prepared = s.engine.preparePage(ref, scan.version, held.lease);
		expect(prepared.request).toEqual({ mode: "initial", since: requestedSince });
		s.f.clock.wall += 1;
		s.f.clock.monotonic += 1;
		const reset = s.engine.resync(ref, scan.version, prepared.lease, newId());
		expect(reset.since).toBe(requestedSince);
		const latest = claim(s, ref, reset);
		const next = s.engine.preparePage(ref, reset.version, latest.lease);
		expect(next.request).toEqual({ mode: "resync", since: requestedSince });
		releasePrepared(s, next);
	});
	it("retires one unanchored active journal and resumes from the preserved native checkpoint", async () => {
		const s = await setup();
		const old = start(s);
		const first = claim(s, old.ref, old.scan);
		const partial = s.f.database.write((scope) =>
			s.pages.record(scope, first.lease, old.ref, old.scan.version, {
				changes: [],
				cursor: "DYTEST-legacy-checkpoint",
				more: true,
			}),
		).scan;
		const held = claim(s, old.ref, partial);
		s.f.database.write((scope) =>
			scope.sql.run("DELETE FROM main.sync_scan_anchors WHERE scan_id=?", [partial.scanId]),
		);
		expect(() => s.engine.preparePage(old.ref, partial.version, held.lease)).toThrow(
			NativeSyncError,
		);
		const current = start(s);
		expect(job(s, partial.jobId)?.state).toBe("CANCELLED");
		expect(() => s.engine.renew(old.ref, partial.version, held.lease)).toThrow(NativeSyncError);
		expect(current.scan.requestMode).toBe("delta");
		expect(current.scan.cursor).toBe("DYTEST-legacy-checkpoint");
		expect(current.scan.revision).toBe(1);
		const latest = claim(s, current.ref, current.scan);
		const prepared = s.engine.preparePage(current.ref, current.scan.version, latest.lease);
		expect(prepared.request).toEqual({ mode: "delta", cursor: "DYTEST-legacy-checkpoint" });
		expect(s.f.database.write((scope) => s.f.model.checkpoint(scope, s.f.ref()))).toEqual({
			cursor: "DYTEST-legacy-checkpoint",
			revision: 1,
		});
		releasePrepared(s, prepared);
	});
	it("derives the initial window and returns an original replacement lease usable for page commit", async () => {
		const s = await setup();
		const { ref, scan } = start(s, 2);
		const held = claim(s, ref, scan);
		const prepared = s.engine.preparePage(ref, scan.version, held.lease);
		expect(prepared.scan).toEqual(scan);
		expect(prepared.request).toEqual({ mode: "initial", since: NOW - 30 * DAY_MS });
		expect(prepared.lease).not.toBe(held.lease);
		expect(prepared.lease.job).toMatchObject({ id: scan.jobId, attempts: 1, maxAttempts: 2 });
		expect(() => s.engine.renew(ref, scan.version, held.lease)).toThrow(NativeSyncError);
		const recorded = s.f.database.write((scope) =>
			s.pages.record(scope, prepared.lease, ref, scan.version, {
				changes: [],
				cursor: "DYTEST-prepared-initial",
				more: false,
			}),
		);
		expect(recorded).toMatchObject({ cursor: "DYTEST-prepared-initial", revision: 1 });
		expect(job(s, scan.jobId)?.state).toBe("SUCCEEDED");
	});

	it("uses only the native delta cursor and omits the stored recovery floor", async () => {
		const s = await setup();
		const original = s.f.lease();
		s.f.database.write((scope) => s.f.model.applyPage(scope, original, s.f.page()));
		const { ref, scan } = start(s);
		expect(scan.since).toBe(NOW - 30 * DAY_MS);
		const held = claim(s, ref, scan);
		const prepared = s.engine.preparePage(ref, scan.version, held.lease);
		expect(prepared.request).toEqual({ mode: "delta", cursor: "DYTEST-cursor-1" });
		expect(Object.hasOwn(prepared.request, "since")).toBe(false);
		expect(prepared.scan).toEqual(scan);
		releasePrepared(s, prepared);
	});

	it("preserves an initial pass and its opaque continuation after a committed page", async () => {
		const s = await setup();
		const { ref, scan } = start(s);
		const first = claim(s, ref, scan);
		const next = s.f.database.write((scope) =>
			s.pages.record(scope, first.lease, ref, scan.version, {
				changes: [],
				cursor: "DYTEST-opaque:+/cursor=1",
				more: true,
			}),
		).scan;
		expect(next.ordinal).toBe(1);
		const held = claim(s, ref, next);
		const prepared = s.engine.preparePage(ref, next.version, held.lease);
		expect(prepared.request).toEqual({
			mode: "initial",
			since: NOW - 30 * DAY_MS,
			cursor: "DYTEST-opaque:+/cursor=1",
		});
		expect(prepared.scan).toEqual(next);
		releasePrepared(s, prepared);
	});

	it("prepares a native resync without resetting its one-resync or job attempt budget", async () => {
		const s = await setup();
		const { ref, scan } = start(s, 2);
		const first = claim(s, ref, scan);
		const resynced = s.engine.resync(ref, scan.version, first.lease, newId());
		const held = claim(s, ref, resynced);
		const prepared = s.engine.preparePage(ref, resynced.version, held.lease);
		expect(prepared.request).toEqual({ mode: "resync", since: NOW - 30 * DAY_MS });
		expect(prepared.scan).toEqual(resynced);
		expect(prepared.scan.resyncCount).toBe(1);
		expect(prepared.lease.job.maxAttempts).toBe(2);
		expect(() => s.engine.resync(ref, resynced.version, prepared.lease, newId())).toThrow(
			NativeSyncError,
		);
		releasePrepared(s, prepared);
	});

	it.each(["initial", "resync"] as const)(
		"preserves the original native %s scan boundary while the clock advances",
		async (mode) => {
			const s = await setup();
			const current = start(s);
			let scan = current.scan;
			let held = claim(s, current.ref, scan);
			if (mode === "resync") {
				scan = s.engine.resync(current.ref, scan.version, held.lease, newId());
				held = claim(s, current.ref, scan);
			}
			s.f.clock.wall += 1_000;
			s.f.clock.monotonic += 1_000;
			const prepared = s.engine.preparePage(current.ref, scan.version, held.lease);
			expect(prepared.request).toEqual({ mode, since: NOW - 30 * DAY_MS });
			expect(scan.since).toBe(NOW - 30 * DAY_MS);
			expect(prepared.scan).toEqual(scan);
			releasePrepared(s, prepared);
		},
	);

	it("rechecks native time after renewal without moving the original scan boundary", async () => {
		const s = await setup();
		const { ref, scan } = start(s);
		const held = claim(s, ref, scan);
		let reads = 0;
		const clock = {
			wallMs: () => {
				s.f.clock.wall = NOW + ++reads;
				return s.f.clock.wall;
			},
			monotonicMs: s.clock.monotonicMs,
		};
		const engine = new NativeSyncEngine(s.f.database, s.f.accounts, s.f.jobs, s.cursors, clock);
		const prepared = engine.preparePage(ref, scan.version, held.lease);
		expect(reads).toBeGreaterThan(1);
		expect(prepared.request).toEqual({ mode: "initial", since: NOW - 30 * DAY_MS });
		expect(prepared.scan).toEqual(scan);
		expect(scan.since).toBe(NOW - 30 * DAY_MS);
		releasePrepared(s, prepared);
	});

	it.each(["initial", "resync"] as const)(
		"retains the %s boundary across a delayed original renewal and the next page lease",
		async (mode) => {
			const s = await setup();
			const current = start(s, 2);
			let scan = current.scan;
			let held = claim(s, current.ref, scan);
			if (mode === "resync") {
				scan = s.engine.resync(current.ref, scan.version, held.lease, newId());
				held = claim(s, current.ref, scan);
			}
			const first = s.engine.preparePage(current.ref, scan.version, held.lease);
			const boundary = NOW - 30 * DAY_MS;
			expect(first.request).toEqual({ mode, since: boundary });
			s.f.clock.wall += 1;
			s.f.clock.monotonic += 1;
			const delayed = s.engine.preparePage(current.ref, scan.version, first.lease);
			expect(delayed.request).toEqual(first.request);
			expect(() => s.engine.renew(current.ref, scan.version, first.lease)).toThrow(NativeSyncError);
			const next = s.f.database.write((scope) =>
				s.pages.record(scope, delayed.lease, current.ref, scan.version, {
					changes: [],
					cursor: `DYTEST-${mode}-window-continuation`,
					more: true,
				}),
			).scan;
			s.f.clock.wall += 1_000;
			s.f.clock.monotonic += 1_000;
			const successor = claim(s, current.ref, next);
			const prepared = s.engine.preparePage(current.ref, next.version, successor.lease);
			expect(prepared.request).toEqual({
				mode,
				since: boundary,
				cursor: `DYTEST-${mode}-window-continuation`,
			});
			expect(prepared.scan.since).toBe(boundary);
			expect(prepared.lease.job.id).toBe(next.jobId);
			expect(prepared.lease.job.maxAttempts).toBe(2);
			releasePrepared(s, prepared);
		},
	);

	it("rejects copied lease DATA without consuming the original capability", async () => {
		const s = await setup();
		const { ref, scan } = start(s);
		const held = claim(s, ref, scan);
		expect(() => s.engine.preparePage(ref, scan.version, { job: held.lease.job })).toThrow(
			NativeSyncError,
		);
		const prepared = s.engine.preparePage(ref, scan.version, held.lease);
		expect(prepared.lease).not.toBe(held.lease);
		releasePrepared(s, prepared);
	});

	it("rejects another original queue's lease even when its persisted page job matches", async () => {
		const s = await setup();
		const { ref, scan } = start(s);
		const other = new JobQueue(s.f.database, s.f.events, s.clock);
		const held = s.f.database.write((scope) => other.claim(scope, ref.accountId, scan.jobId));
		if (!held) throw new Error("Expected the other queue's original lease");
		expect(() => s.engine.preparePage(ref, scan.version, held)).toThrow(NativeSyncError);
		const renewed = s.f.database.write((scope) => other.renew(scope, held));
		s.f.database.write((scope) => other.complete(scope, renewed));
	});

	it.each(["mode", "history"] as const)(
		"refuses preparation after genuine native account %s replacement",
		async (changed) => {
			const s = await setup();
			const { ref, scan } = start(s);
			const held = claim(s, ref, scan);
			const replacement = s.f.database.write((scope) =>
				s.f.accounts.replace(
					scope,
					{
						...s.f.account,
						...(changed === "mode" ? { mode: "read_only" } : { historyLimitDays: 7 }),
					},
					s.f.generation,
				),
			);
			if (replacement.account.channel !== "email") throw new Error("Expected an email account");
			s.f.account = replacement.account;
			s.f.generation = replacement.generation;
			expect(() => s.engine.preparePage(ref, scan.version, held.lease)).toThrow(NativeSyncError);
			const fresh = start(s);
			expect(job(s, scan.jobId)?.state).toBe("CANCELLED");
			const current = claim(s, fresh.ref, fresh.scan);
			const prepared = s.engine.preparePage(fresh.ref, fresh.scan.version, current.lease);
			expect(prepared.scan.generation).toBe(replacement.generation);
			expect(prepared.request).toEqual({
				mode: "initial",
				since: s.f.clock.wall - s.f.account.historyLimitDays * DAY_MS,
			});
			releasePrepared(s, prepared);
		},
	);

	it("refuses a stale journal after an actual native metadata commit consumed its page lease", async () => {
		const s = await setup();
		const { ref, scan } = start(s);
		const held = claim(s, ref, scan);
		s.f.database.write((scope) =>
			s.f.model.applyPage(
				scope,
				held.lease,
				s.f.page([], {
					cursor: "DYTEST-already-committed",
				}),
			),
		);
		const before = s.f.database.write((scope) => s.f.model.checkpoint(scope, s.f.ref()));
		expect(() => s.engine.preparePage(ref, scan.version, held.lease)).toThrow(NativeSyncError);
		expect(s.f.database.write((scope) => s.f.model.checkpoint(scope, s.f.ref()))).toEqual(before);
		expect(before).toEqual({ cursor: "DYTEST-already-committed", revision: 1 });
		expect(job(s, scan.jobId)?.state).toBe("SUCCEEDED");
	});

	it.each(["waiting", "cancelled"] as const)(
		"does not prepare another request for a %s native scan",
		async (status) => {
			const s = await setup();
			const { ref, scan } = start(s);
			const held = claim(s, ref, scan);
			const stopped =
				status === "cancelled"
					? s.engine.cancel(ref, scan.version)
					: s.f.database.write((scope) =>
							s.pages.record(scope, held.lease, ref, scan.version, {
								changes: [],
								cursor: "DYTEST-finished-scan",
								more: false,
							}),
						).scan;
			expect(stopped.status).toBe(status);
			const before = s.f.database.write((scope) => s.f.model.checkpoint(scope, s.f.ref()));
			expect(() => s.engine.preparePage(ref, stopped.version, held.lease)).toThrow(NativeSyncError);
			expect(s.f.database.write((scope) => s.f.model.checkpoint(scope, s.f.ref()))).toEqual(before);
		},
	);

	it.each(["wall", "monotonic"] as const)(
		"refuses an original lease at its %s deadline without preparing more metadata",
		async (time) => {
			const s = await setup();
			const { ref, scan } = start(s);
			const held = claim(s, ref, scan);
			if (held.lease.job.leaseUntil === null) throw new Error("Expected the native lease deadline");
			if (time === "wall") s.f.clock.wall = held.lease.job.leaseUntil;
			else s.f.clock.monotonic += 30_000;
			expect(() => s.engine.preparePage(ref, scan.version, held.lease)).toThrow(NativeSyncError);
			expect(s.f.database.write((scope) => s.f.model.checkpoint(scope, s.f.ref()))).toEqual({
				cursor: null,
				revision: 0,
			});
			expect(job(s, scan.jobId)).toMatchObject({ state: "RUNNING", attempts: 1 });
		},
	);

	it("refuses a stale journal version without spending the genuine current lease", async () => {
		const s = await setup();
		const { ref, scan } = start(s);
		const held = claim(s, ref, scan);
		expect(() => s.engine.preparePage(ref, scan.version + 1, held.lease)).toThrow(NativeSyncError);
		const prepared = s.engine.preparePage(ref, scan.version, held.lease);
		expect(prepared.scan).toEqual(scan);
		releasePrepared(s, prepared);
	});
});

describe("native per-message sync job issuance", () => {
	it("issues an original message lease after the page lease was completed", async () => {
		const s = await messageSetup();
		expect(job(s, s.page.scan.jobId)?.state).toBe("SUCCEEDED");
		expect(() =>
			s.f.database.write((scope) => s.f.jobs.renew(scope, s.page.consumedLease)),
		).toThrow();
		const options = messageOptions(s, s.message.id);
		const held = s.engine.claimMessage(s.f.ref(), options);
		expect(held).toBeDefined();
		if (!held) throw new Error("Expected an original message lease");
		expect(held.job).toMatchObject({
			id: options.jobId,
			accountId: s.f.account.id,
			ownerId: s.f.account.userId,
			kind: "sync",
			refId: s.message.id,
			state: "RUNNING",
			attempts: 1,
			maxAttempts: 2,
		});
		expect(held.job.refId).not.toBe(s.page.scan.scanId);
		expect(held.job.id).not.toBe(s.page.scan.jobId);
		expect(() => s.f.database.write((scope) => s.f.jobs.renew(scope, { job: held.job }))).toThrow();
		const renewed = s.f.database.write((scope) => s.f.jobs.renew(scope, held));
		expect(renewed).not.toBe(held);
		s.f.database.write((scope) => s.f.jobs.complete(scope, renewed));
		expect(job(s, options.jobId)?.state).toBe("SUCCEEDED");
	});

	it("refuses the method when its original metadata store is unavailable", async () => {
		const s = await messageSetup();
		const unavailable = new NativeSyncEngine(
			s.f.database,
			s.f.accounts,
			s.f.jobs,
			s.cursors,
			s.clock,
		);
		const options = messageOptions(s, s.message.id);
		expect(() => unavailable.claimMessage(s.f.ref(), options)).toThrow(NativeSyncError);
		expect(job(s, options.jobId)).toBeUndefined();
	});

	it("selects a native ID only inside the explicit current metadata page", async () => {
		const s = await messageSetup(101);
		expect(s.first).toHaveLength(100);
		const afterId = s.first.at(-1)?.id;
		if (!afterId) throw new Error("Expected a native page continuation");
		const second = s.f.database.write((scope) =>
			s.f.model.messages(scope, s.f.ref(), afterId, 100),
		);
		expect(second).toHaveLength(1);
		const message = second[0];
		if (!message) throw new Error("Expected the second native metadata page");
		const outside = messageOptions(s, message.id);
		expect(() => s.engine.claimMessage(s.f.ref(), outside)).toThrow(NativeSyncError);
		expect(job(s, outside.jobId)).toBeUndefined();
		const inside = { ...messageOptions(s, message.id), afterId };
		const lease = s.engine.claimMessage(s.f.ref(), inside);
		expect(lease?.job.refId).toBe(message.id);
		if (!lease) throw new Error("Expected the original second-page message lease");
		s.f.database.write((scope) => s.f.jobs.complete(scope, lease));
	});

	it("refuses a provider identifier in place of the persisted native message ULID", async () => {
		const s = await messageSetup();
		const options = messageOptions(s, s.message.providerId);
		expect(() => s.engine.claimMessage(s.f.ref(), options)).toThrow(NativeSyncError);
		expect(job(s, options.jobId)).toBeUndefined();
	});

	it("refuses a native message that belongs to another genuine account", async () => {
		const s = await messageSetup();
		const other = s.f.email();
		s.f.database.write((scope) => s.f.accounts.create(scope, other));
		const ref = s.f.ref({ accountId: other.id, pluginInstanceId: other.pluginInstanceId });
		const options = {
			...messageOptions(s, s.message.id),
			expectedCheckpoint: s.f.database.write((scope) => s.f.model.checkpoint(scope, ref)),
		};
		expect(() => s.engine.claimMessage(ref, options)).toThrow(NativeSyncError);
		expect(job(s, options.jobId)).toBeUndefined();
	});

	it("refuses a deleted native message even with the new current checkpoint", async () => {
		const s = await messageSetup();
		seedMessagePage(s, [{ kind: "email.deleted", providerId: s.message.providerId }]);
		const options = messageOptions(s, s.message.id);
		expect(() => s.engine.claimMessage(s.f.ref(), options)).toThrow(NativeSyncError);
		expect(job(s, options.jobId)).toBeUndefined();
	});

	it("refuses stale checkpoint data after a genuine metadata update", async () => {
		const s = await messageSetup();
		const options = messageOptions(s, s.message.id);
		seedMessagePage(s, [
			{
				kind: "email.labels",
				providerId: s.message.providerId,
				threadId: s.message.threadId,
				labelIds: ["ARCHIVE"],
			},
		]);
		expect(() => s.engine.claimMessage(s.f.ref(), options)).toThrow(NativeSyncError);
		expect(job(s, options.jobId)).toBeUndefined();
		expect(s.f.database.write((scope) => s.f.model.checkpoint(scope, s.f.ref())).revision).toBe(
			options.expectedCheckpoint.revision + 1,
		);
	});

	it("rolls back an issued message job when its retention floor changes after the exact claim", async () => {
		const s = await messageSetup();
		const options = messageOptions(s, s.message.id);
		let reads = 0;
		const lateClock = {
			wallMs: () => (++reads < 3 ? NOW : NOW + s.f.account.historyLimitDays * DAY_MS),
			monotonicMs: s.clock.monotonicMs,
		};
		const engine = new NativeSyncEngine(
			s.f.database,
			s.f.accounts,
			s.f.jobs,
			s.cursors,
			lateClock,
			s.f.model,
		);
		expect(() => engine.claimMessage(s.f.ref(), options)).toThrow(NativeSyncError);
		expect(reads).toBe(3);
		expect(job(s, options.jobId)).toBeUndefined();
		expect(s.f.database.write((scope) => s.f.model.checkpoint(scope, s.f.ref()))).toEqual(
			options.expectedCheckpoint,
		);
		const original = s.engine.claimMessage(s.f.ref(), options);
		expect(original?.job).toMatchObject({ id: options.jobId, refId: s.message.id, attempts: 1 });
		if (!original) throw new Error("Expected the current original message lease after rollback");
		s.f.database.write((scope) => s.f.jobs.complete(scope, original));
	});

	it.each(["mode", "history", "both"] as const)(
		"refuses stale native state after account %s replacement",
		async (changed) => {
			const s = await messageSetup();
			const oldRef = s.f.ref();
			const options = messageOptions(s, s.message.id);
			const replaced = s.f.database.write((scope) =>
				s.f.accounts.replace(
					scope,
					{
						...s.f.account,
						mode: changed === "history" ? s.f.account.mode : "read_only",
						historyLimitDays: changed === "mode" ? s.f.account.historyLimitDays : 7,
					},
					s.f.generation,
				),
			);
			if (replaced.account.channel !== "email")
				throw new Error("Expected the native email account");
			s.f.account = replaced.account;
			s.f.generation = replaced.generation;
			expect(() => s.engine.claimMessage(oldRef, options)).toThrow(NativeSyncError);
			expect(job(s, options.jobId)).toBeUndefined();
		},
	);

	it.each(["account", "message", "kind", "budget"] as const)(
		"refuses a stable job ID with foreign %s binding",
		async (changed) => {
			const s = await messageSetup();
			const options = messageOptions(s, s.message.id);
			const foreign = s.f.email();
			if (changed === "account") s.f.database.write((scope) => s.f.accounts.create(scope, foreign));
			const before = s.f.database.write((scope) =>
				s.f.jobs.enqueue(scope, {
					id: options.jobId,
					accountId: changed === "account" ? foreign.id : s.f.account.id,
					ownerId: s.f.account.userId,
					kind: changed === "kind" ? "draft" : "sync",
					refId: changed === "message" ? newId() : s.message.id,
					maxAttempts: changed === "budget" ? 1 : options.maxAttempts,
				}),
			);
			expect(() => s.engine.claimMessage(s.f.ref(), options)).toThrow(NativeSyncError);
			expect(job(s, options.jobId)).toEqual(before);
		},
	);

	it("respects one original running job per account without claiming unrelated work", async () => {
		const s = await messageSetup();
		const unrelated = s.f.lease("sync");
		const options = messageOptions(s, s.message.id);
		expect(s.engine.claimMessage(s.f.ref(), options)).toBeUndefined();
		expect(job(s, options.jobId)).toMatchObject({
			state: "PENDING",
			attempts: 0,
			refId: s.message.id,
		});
		expect(job(s, unrelated.job.id)?.state).toBe("RUNNING");
		s.f.database.write((scope) => s.f.jobs.complete(scope, unrelated));
		const lease = s.engine.claimMessage(s.f.ref(), options);
		expect(lease?.job.id).toBe(options.jobId);
		if (!lease) throw new Error("Expected the exact pending message job");
		s.f.database.write((scope) => s.f.jobs.complete(scope, lease));
	});

	it("retains a stable job's retry schedule and exhausts its original attempt budget", async () => {
		const s = await messageSetup();
		const options = messageOptions(s, s.message.id);
		const first = s.engine.claimMessage(s.f.ref(), options);
		if (!first) throw new Error("Expected first native message attempt");
		s.f.database.write((scope) => s.f.jobs.fail(scope, first, 1_000));
		expect(s.engine.claimMessage(s.f.ref(), options)).toBeUndefined();
		expect(job(s, options.jobId)).toMatchObject({
			state: "PENDING",
			attempts: 1,
			nextAt: NOW + 1_000,
		});
		s.f.clock.wall += 1_000;
		s.f.clock.monotonic += 1_000;
		const second = s.engine.claimMessage(s.f.ref(), options);
		expect(second?.job.attempts).toBe(2);
		if (!second) throw new Error("Expected second native message attempt");
		s.f.database.write((scope) => s.f.jobs.fail(scope, second, 0));
		expect(s.engine.claimMessage(s.f.ref(), options)).toBeUndefined();
		expect(job(s, options.jobId)).toMatchObject({ state: "FAILED", attempts: 2, maxAttempts: 2 });
	});

	it("commits original queue exhaustion when an expired last attempt cannot be reclaimed", async () => {
		const s = await messageSetup();
		const options = { ...messageOptions(s, s.message.id), maxAttempts: 1 };
		const original = s.engine.claimMessage(s.f.ref(), options);
		if (!original) throw new Error("Expected the only original message attempt");
		if (original.job.leaseUntil === null) throw new Error("Expected the native lease deadline");
		s.f.clock.wall = original.job.leaseUntil + 1;
		s.f.clock.monotonic += 60_001;
		expect(s.engine.claimMessage(s.f.ref(), options)).toBeUndefined();
		expect(job(s, options.jobId)).toMatchObject({
			state: "FAILED",
			attempts: 1,
			maxAttempts: 1,
			leaseUntil: null,
		});
		expect(() => s.f.database.write((scope) => s.f.jobs.renew(scope, original))).toThrow();
	});

	it.each(["SUCCEEDED", "CANCELLED"] as const)(
		"does not revive a stable %s message job",
		async (state) => {
			const s = await messageSetup();
			const options = messageOptions(s, s.message.id);
			const first = s.engine.claimMessage(s.f.ref(), options);
			if (!first) throw new Error("Expected the original message job");
			s.f.database.write((scope) => {
				if (state === "SUCCEEDED") s.f.jobs.complete(scope, first);
				else s.f.jobs.cancel(scope, first.job.id);
			});
			expect(s.engine.claimMessage(s.f.ref(), options)).toBeUndefined();
			expect(job(s, options.jobId)).toMatchObject({ state, attempts: 1 });
		},
	);

	it.each([0, 101])("refuses a metadata page limit of %i without issuing work", async (limit) => {
		const s = await messageSetup();
		const options = { ...messageOptions(s, s.message.id), limit };
		expect(() => s.engine.claimMessage(s.f.ref(), options)).toThrow(NativeSyncError);
		expect(job(s, options.jobId)).toBeUndefined();
	});

	it("refuses an out-of-range original attempt budget before issuing work", async () => {
		const s = await messageSetup();
		const options = { ...messageOptions(s, s.message.id), maxAttempts: 21 };
		expect(() => s.engine.claimMessage(s.f.ref(), options)).toThrow(NativeSyncError);
		expect(job(s, options.jobId)).toBeUndefined();
	});
});

describe("native resync request cursors", () => {
	function fromCommittedDelta(s: Setup) {
		const pageLease = s.f.lease();
		s.f.database.write((scope) =>
			s.f.model.applyPage(
				scope,
				pageLease,
				s.f.page([], {
					cursor: "DYTEST-expired-delta-cursor",
				}),
			),
		);
		const { ref, scan } = start(s, 2);
		expect(scan.requestMode).toBe("delta");
		expect(scan.cursor).toBe("DYTEST-expired-delta-cursor");
		const held = claim(s, ref, scan);
		const resynced = s.engine.resync(ref, scan.version, held.lease, newId());
		return { ref, resynced };
	}

	it("omits the expired delta cursor from the first resync request while retaining it for native CAS", async () => {
		const s = await setup();
		const { ref, resynced } = fromCommittedDelta(s);
		expect(resynced.cursor).toBe("DYTEST-expired-delta-cursor");
		expect(resynced.revision).toBe(1);
		const held = claim(s, ref, resynced);
		const prepared = s.engine.preparePage(ref, resynced.version, held.lease);
		expect(prepared.request).toEqual({ mode: "resync", since: NOW - 30 * DAY_MS });
		expect(prepared.scan).toEqual(resynced);
		s.f.database.write((scope) => s.f.jobs.complete(scope, prepared.lease));
	});

	it("uses the fresh continuation only after the first resync page commits", async () => {
		const s = await setup();
		const { ref, resynced } = fromCommittedDelta(s);
		const first = claim(s, ref, resynced);
		const firstRequest = s.engine.preparePage(ref, resynced.version, first.lease);
		const next = s.f.database.write((scope) =>
			s.pages.record(scope, firstRequest.lease, ref, resynced.version, {
				changes: [],
				cursor: "DYTEST-fresh-resync-continuation",
				more: true,
			}),
		).scan;
		expect(next.revision).toBe(2);
		expect(next.resyncCount).toBe(1);
		const held = claim(s, ref, next);
		const prepared = s.engine.preparePage(ref, next.version, held.lease);
		expect(prepared.request).toEqual({
			mode: "resync",
			since: NOW - 30 * DAY_MS,
			cursor: "DYTEST-fresh-resync-continuation",
		});
		expect(prepared.scan).toEqual(next);
		s.f.database.write((scope) => s.f.jobs.complete(scope, prepared.lease));
	});

	it("omits a partial initial pass's expired cursor even when the first resync ordinal is nonzero", async () => {
		const s = await setup();
		const { ref, scan } = start(s, 2);
		const first = claim(s, ref, scan);
		const partial = s.f.database.write((scope) =>
			s.pages.record(scope, first.lease, ref, scan.version, {
				changes: [],
				cursor: "DYTEST-expired-initial-continuation",
				more: true,
			}),
		).scan;
		expect(partial.ordinal).toBe(1);
		expect(partial.requestMode).toBe("initial");
		const held = claim(s, ref, partial);
		const resynced = s.engine.resync(ref, partial.version, held.lease, newId());
		expect(resynced.ordinal).toBe(1);
		expect(resynced.cursor).toBe("DYTEST-expired-initial-continuation");
		const current = claim(s, ref, resynced);
		const prepared = s.engine.preparePage(ref, resynced.version, current.lease);
		expect(prepared.request).toEqual({ mode: "resync", since: NOW - 30 * DAY_MS });
		expect(prepared.scan).toEqual(resynced);
		s.f.database.write((scope) => s.f.jobs.complete(scope, prepared.lease));
	});
});

describe("native sync job engine", () => {
	it("derives the first request and recovery floor from the original account and clock", async () => {
		const s = await setup();
		const { scan, jobId } = start(s, 2);
		expect(scan.requestMode).toBe("initial");
		expect(scan.since).toBe(NOW - s.f.account.historyLimitDays * DAY_MS);
		expect(scan.cursor).toBeNull();
		expect(scan.revision).toBe(0);
		expect(scan.resyncCount).toBe(0);
		expect(job(s, jobId)).toMatchObject({
			accountId: s.f.account.id,
			ownerId: s.f.account.userId,
			refId: scan.scanId,
			kind: "sync",
			state: "PENDING",
			maxAttempts: 2,
		});
	});

	it("derives delta mode from the native checkpoint instead of accepting a caller mode", async () => {
		const s = await setup();
		const lease = s.f.lease();
		s.f.database.write((scope) => s.f.model.applyPage(scope, lease, s.f.page()));
		const { scan } = start(s);
		expect(scan.requestMode).toBe("delta");
		expect(scan.cursor).toBe("DYTEST-cursor-1");
		expect(scan.revision).toBe(1);
		expect(scan.since).toBe(NOW - s.f.account.historyLimitDays * DAY_MS);
	});

	it("rejects caller window and mode fields without creating a job", async () => {
		const s = await setup();
		const options = { scanId: newId(), jobId: newId(), since: 0, requestMode: "resync" };
		expect(() => s.engine.enqueue(s.f.ref(), options)).toThrow(NativeSyncError);
		expect(job(s, options.jobId)).toBeUndefined();
	});

	it("resumes the native active scan without creating or resetting another job", async () => {
		const s = await setup();
		const first = start(s);
		const scanId = newId();
		const jobId = newId();
		const resumed = s.engine.enqueue(s.f.ref(), { scanId, jobId });
		expect(resumed).toEqual(first.scan);
		expect(job(s, jobId)).toBeUndefined();
		expect(job(s, first.jobId)?.state).toBe("PENDING");
	});

	it("claims its exact sync job and preserves an older unrelated draft job", async () => {
		const s = await setup();
		const draftId = newId();
		s.f.database.write((scope) =>
			s.f.jobs.enqueue(scope, {
				id: draftId,
				accountId: s.f.account.id,
				ownerId: s.f.account.userId,
				kind: "draft",
				refId: newId(),
			}),
		);
		const { ref, scan, jobId } = start(s);
		const first = claim(s, ref, scan);
		expect(first.lease.job.id).toBe(jobId);
		expect(first.lease.job.kind).toBe("sync");
		expect(s.engine.claim(ref, scan.version)).toBeUndefined();
		expect(job(s, draftId)?.state).toBe("PENDING");
	});

	it("keeps different genuine accounts independent", async () => {
		const s = await setup();
		const second = s.f.email();
		s.f.database.write((scope) => s.f.accounts.create(scope, second));
		const first = start(s);
		const secondRef = s.f.ref({ accountId: second.id, pluginInstanceId: second.pluginInstanceId });
		const secondScan = s.engine.enqueue(secondRef, { scanId: newId(), jobId: newId() });
		const secondScanRef = { ...secondRef, scanId: secondScan.scanId };
		expect(claim(s, first.ref, first.scan).lease.job.accountId).toBe(s.f.account.id);
		expect(claim(s, secondScanRef, secondScan).lease.job.accountId).toBe(second.id);
	});

	it("renews through the original queue and never revives the retired lease", async () => {
		const s = await setup();
		const { ref, scan } = start(s);
		const first = claim(s, ref, scan);
		const second = s.engine.renew(ref, scan.version, first.lease);
		expect(second.lease).not.toBe(first.lease);
		expect(() => s.engine.renew(ref, scan.version, first.lease)).toThrow(NativeSyncError);
		expect(s.engine.renew(ref, scan.version, second.lease).lease).not.toBe(second.lease);
	});

	it("refuses copied leases without consuming the original", async () => {
		const s = await setup();
		const { ref, scan } = start(s);
		const held = claim(s, ref, scan);
		const copy: JobLease = { job: held.lease.job };
		expect(() => s.engine.renew(ref, scan.version, copy)).toThrow(NativeSyncError);
		expect(s.engine.renew(ref, scan.version, held.lease).lease.job.id).toBe(scan.jobId);
	});

	it("refuses another original queue's lease even when the database and job match", async () => {
		const s = await setup();
		const { ref, scan } = start(s);
		const other = new JobQueue(s.f.database, s.f.events, s.clock);
		const held = s.f.database.write((scope) => other.claim(scope, ref.accountId, scan.jobId));
		expect(held).toBeDefined();
		if (!held) throw new Error("Owned other-queue job was not claimed");
		expect(() => s.engine.renew(ref, scan.version, held)).toThrow(NativeSyncError);
		expect(s.f.database.write((scope) => other.renew(scope, held)).job.id).toBe(scan.jobId);
	});

	it("enforces retry time and attempt budgets while retaining the same journal version", async () => {
		const s = await setup();
		const { ref, scan } = start(s, 2);
		const first = claim(s, ref, scan);
		const pending = s.engine.retry(ref, scan.version, first.lease, 1_234);
		expect(pending.version).toBe(scan.version);
		expect(pending.status).toBe("active");
		expect(job(s, scan.jobId)).toMatchObject({ state: "PENDING", nextAt: NOW + 1_234 });
		expect(s.engine.claim(ref, scan.version)).toBeUndefined();
		s.f.clock.wall += 1_234;
		s.f.clock.monotonic += 1_234;
		const second = claim(s, ref, scan);
		expect(second.lease.job.attempts).toBe(2);
		const failed = s.engine.retry(ref, scan.version, second.lease, 0);
		expect(failed.status).toBe("failed");
		expect(job(s, scan.jobId)?.state).toBe("FAILED");
		expect(s.engine.claim(ref, failed.version)).toBeUndefined();
	});

	it("refuses an out-of-budget retry without spending its genuine lease", async () => {
		const s = await setup();
		const { ref, scan } = start(s);
		const held = claim(s, ref, scan);
		expect(() => s.engine.retry(ref, scan.version, held.lease, 86_400_001)).toThrow(
			NativeSyncError,
		);
		expect(s.engine.renew(ref, scan.version, held.lease).lease.job.id).toBe(scan.jobId);
	});

	it.each(["PENDING", "RUNNING"])(
		"cancels a genuine %s page and retires any lease",
		async (state) => {
			const s = await setup();
			const { ref, scan } = start(s);
			const held = state === "RUNNING" ? claim(s, ref, scan) : undefined;
			const stopped = s.engine.cancel(ref, scan.version);
			expect(stopped.status).toBe("cancelled");
			expect(job(s, scan.jobId)?.state).toBe("CANCELLED");
			expect(s.engine.claim(ref, stopped.version)).toBeUndefined();
			if (held)
				expect(() => s.engine.renew(ref, stopped.version, held.lease)).toThrow(NativeSyncError);
		},
	);

	it("reclaims expired work through the original queue without reviving the old lease", async () => {
		const s = await setup();
		const { ref, scan } = start(s);
		const first = claim(s, ref, scan);
		s.f.clock.wall += 30_000;
		s.f.clock.monotonic += 30_000;
		const recovered = claim(s, ref, scan);
		expect(recovered.lease.job.attempts).toBe(2);
		expect(recovered.lease).not.toBe(first.lease);
		expect(() => s.engine.renew(ref, scan.version, first.lease)).toThrow(NativeSyncError);
		expect(s.engine.renew(ref, scan.version, recovered.lease).lease.job.id).toBe(scan.jobId);
	});

	it("allows only one resync and preserves the replacement lease on refusal", async () => {
		const s = await setup();
		const { ref, scan } = start(s, 2);
		const first = claim(s, ref, scan);
		const replacementId = newId();
		const resynced = s.engine.resync(ref, scan.version, first.lease, replacementId);
		expect(resynced).toMatchObject({
			jobId: replacementId,
			requestMode: "resync",
			resyncCount: 1,
			since: scan.since,
			ordinal: scan.ordinal,
		});
		expect(job(s, scan.jobId)?.state).toBe("CANCELLED");
		const second = claim(s, ref, resynced);
		expect(() => s.engine.resync(ref, resynced.version, second.lease, newId())).toThrow(
			NativeSyncError,
		);
		expect(s.engine.renew(ref, resynced.version, second.lease).lease.job.maxAttempts).toBe(2);
	});

	it("starts one fresh native resync boundary without replaying its old checkpoint cursor", async () => {
		const s = await setup();
		const { ref, scan } = start(s);
		const first = claim(s, ref, scan);
		const partial = s.f.database.write((scope) =>
			s.pages.record(scope, first.lease, ref, scan.version, {
				changes: [],
				cursor: "DYTEST-expired-native-window-cursor",
				more: true,
			}),
		).scan;
		let held = claim(s, ref, partial);
		s.f.clock.wall += 1_000;
		s.f.clock.monotonic += 1_000;
		held = s.engine.renew(ref, partial.version, held.lease);
		const resynced = s.engine.resync(ref, partial.version, held.lease, newId());
		expect(resynced.since).toBe(NOW - s.f.account.historyLimitDays * DAY_MS + 1_000);
		expect(resynced.cursor).toBe("DYTEST-expired-native-window-cursor");
		expect(resynced.resyncCount).toBe(1);
		const current = claim(s, ref, resynced);
		s.f.clock.wall += 1;
		s.f.clock.monotonic += 1;
		const prepared = s.engine.preparePage(ref, resynced.version, current.lease);
		expect(prepared.request).toEqual({ mode: "resync", since: resynced.since });
		expect(Object.hasOwn(prepared.request, "cursor")).toBe(false);
		expect(() => s.engine.resync(ref, resynced.version, prepared.lease, newId())).toThrow(
			NativeSyncError,
		);
		releasePrepared(s, prepared);
	});

	it("rejects stale identity and journal versions before claiming a native job", async () => {
		const s = await setup();
		const { ref, scan } = start(s);
		for (const changed of [
			{ ...ref, generation: ref.generation + 1 },
			{ ...ref, pluginInstanceId: newId() },
			{ ...ref, ownerEpoch: ref.ownerEpoch + 1 },
			{ ...ref, mode: "read_only" as const },
		])
			expect(() => s.engine.claim(changed, scan.version)).toThrow(NativeSyncError);
		expect(() => s.engine.claim(ref, scan.version + 1)).toThrow(NativeSyncError);
		expect(job(s, scan.jobId)?.state).toBe("PENDING");
		expect(claim(s, ref, scan).lease.job.id).toBe(scan.jobId);
	});

	it.each(["mode", "history"] as const)(
		"fences a claimed page across an original account %s replacement and resumes current work",
		async (changed) => {
			const s = await setup();
			const old = start(s, 5);
			const held = claim(s, old.ref, old.scan);
			const previousGeneration = s.f.generation;
			const replacement = s.f.database.write((scope) =>
				s.f.accounts.replace(
					scope,
					{
						...s.f.account,
						mode: changed === "mode" ? "read_only" : s.f.account.mode,
						historyLimitDays: changed === "history" ? 7 : s.f.account.historyLimitDays,
					},
					previousGeneration,
				),
			);
			if (replacement.account.channel !== "email") throw new Error("Expected owned email account");
			s.f.account = replacement.account;
			s.f.generation = replacement.generation;
			expect(s.f.generation).toBe(previousGeneration + 1);
			const currentRef = s.f.ref();
			const latePage = {
				changes: [emailMessage("DYTEST-late-replaced-account")],
				cursor: "DYTEST-late-replacement-cursor",
				more: false,
			};
			expect(() =>
				s.f.database.write((scope) =>
					s.pages.record(scope, held.lease, old.ref, old.scan.version, latePage),
				),
			).toThrow(NativeSyncError);
			expect(() => s.engine.claim(old.ref, old.scan.version)).toThrow(NativeSyncError);
			expect(() => s.engine.renew(old.ref, old.scan.version, held.lease)).toThrow(NativeSyncError);
			const staleJobId = newId();
			expect(() =>
				s.engine.enqueue(
					{
						accountId: old.ref.accountId,
						generation: old.ref.generation,
						pluginInstanceId: old.ref.pluginInstanceId,
						ownerEpoch: old.ref.ownerEpoch,
						mode: old.ref.mode,
					},
					{ scanId: newId(), jobId: staleJobId },
				),
			).toThrow(NativeSyncError);
			expect(job(s, staleJobId)).toBeUndefined();
			expect(job(s, old.jobId)?.state).toBe("RUNNING");
			expect(s.f.database.write((scope) => s.f.model.checkpoint(scope, currentRef))).toEqual({
				cursor: null,
				revision: 0,
			});
			expect(s.f.database.write((scope) => s.f.model.messages(scope, currentRef))).toEqual([]);

			const fresh = s.engine.enqueue(currentRef, {
				scanId: newId(),
				jobId: newId(),
				maxAttempts: 2,
			});
			const freshRef = { ...currentRef, scanId: fresh.scanId };
			// The stale original job must be retired before a new generation is claimed.
			expect(job(s, old.jobId)?.state).toBe("CANCELLED");
			expect(fresh).toMatchObject({
				generation: replacement.generation,
				mode: replacement.account.mode,
				requestMode: "initial",
				since: NOW - replacement.account.historyLimitDays * DAY_MS,
			});
			const unusedJobId = newId();
			expect(
				s.engine.enqueue(currentRef, {
					scanId: newId(),
					jobId: unusedJobId,
					maxAttempts: 20,
				}),
			).toEqual(fresh);
			expect(job(s, unusedJobId)).toBeUndefined();
			const freshLease = claim(s, freshRef, fresh);
			expect(freshLease.lease.job.maxAttempts).toBe(2);
			expect(() =>
				s.f.database.write((scope) =>
					s.pages.record(scope, held.lease, freshRef, fresh.version, latePage),
				),
			).toThrow(NativeSyncError);
			expect(s.f.database.write((scope) => s.f.model.messages(scope, currentRef))).toEqual([]);
			const applied = s.f.database.write((scope) =>
				s.pages.record(scope, freshLease.lease, freshRef, fresh.version, {
					changes: [emailMessage("DYTEST-current-replacement")],
					cursor: "DYTEST-current-replacement-cursor",
					more: true,
				}),
			);
			const successor = claim(s, freshRef, applied.scan);
			expect(successor.lease.job.maxAttempts).toBe(2);
			const stopped = s.f.database.write((scope) =>
				s.pages.record(scope, successor.lease, freshRef, applied.scan.version, {
					changes: [],
					cursor: "DYTEST-current-replacement-terminal",
					more: false,
				}),
			);
			expect(stopped.scan.status).toBe("waiting");
			expect(
				s.f.database
					.write((scope) => s.f.model.messages(scope, currentRef))
					.map((row) => row.providerId),
			).toEqual(["DYTEST-current-replacement"]);
		},
	);

	it.each(["wall expiry", "monotonic expiry", "cancellation"] as const)(
		"refuses the actual claimed page handoff after %s and permits fresh work",
		async (cause) => {
			const s = await setup();
			const old = start(s, 2);
			const held = claim(s, old.ref, old.scan);
			const after =
				cause === "cancellation" ? s.engine.cancel(old.ref, old.scan.version) : old.scan;
			if (cause === "wall expiry") s.f.clock.wall += 30_000;
			if (cause === "monotonic expiry") s.f.clock.monotonic += 30_000;
			expect(s.f.clock.wall).toBe(cause === "wall expiry" ? NOW + 30_000 : NOW);
			expect(() =>
				s.f.database.write((scope) =>
					s.pages.record(scope, held.lease, old.ref, after.version, {
						changes: [emailMessage("DYTEST-late-controller-handoff")],
						cursor: "DYTEST-refused-controller-handoff",
						more: false,
					}),
				),
			).toThrow(NativeSyncError);
			expect(s.f.database.write((scope) => s.f.model.checkpoint(scope, s.f.ref()))).toEqual({
				cursor: null,
				revision: 0,
			});
			expect(s.f.database.write((scope) => s.f.model.messages(scope, s.f.ref()))).toEqual([]);
			expect(job(s, old.jobId)?.state).toBe(cause === "cancellation" ? "CANCELLED" : "RUNNING");
			expect(() => s.engine.renew(old.ref, after.version, held.lease)).toThrow(NativeSyncError);
			if (cause !== "cancellation") {
				if (cause === "monotonic expiry") {
					// Monotonic-only expiry does not fabricate wall-clock recovery eligibility.
					expect(s.engine.claim(old.ref, old.scan.version)).toBeUndefined();
					s.f.clock.wall += 30_000;
				}
				const recovered = claim(s, old.ref, old.scan);
				expect(recovered.lease.job.attempts).toBe(2);
				const applied = s.f.database.write((scope) =>
					s.pages.record(scope, recovered.lease, old.ref, old.scan.version, {
						changes: [emailMessage("DYTEST-fresh-controller-handoff")],
						cursor: "DYTEST-current-controller-handoff",
						more: false,
					}),
				);
				expect(applied.scan.status).toBe("waiting");
			} else {
				const fresh = start(s, 2);
				const freshLease = claim(s, fresh.ref, fresh.scan);
				const applied = s.f.database.write((scope) =>
					s.pages.record(scope, freshLease.lease, fresh.ref, fresh.scan.version, {
						changes: [emailMessage("DYTEST-fresh-controller-handoff")],
						cursor: "DYTEST-current-controller-handoff",
						more: false,
					}),
				);
				expect(applied.scan.status).toBe("waiting");
			}
			expect(
				s.f.database
					.write((scope) => s.f.model.messages(scope, s.f.ref()))
					.map((row) => row.providerId),
			).toEqual(["DYTEST-fresh-controller-handoff"]);
		},
	);

	it("snapshots inert arguments without invoking accessors or proxy traps", async () => {
		const s = await setup();
		let hooks = 0;
		const ref = s.f.ref();
		Object.defineProperty(ref, "accountId", {
			get: () => {
				hooks++;
				return s.f.account.id;
			},
		});
		const options = { scanId: newId(), jobId: newId() };
		expect(() => s.engine.enqueue(ref, options)).toThrow(NativeSyncError);
		const proxy = new Proxy(s.f.ref(), {
			ownKeys: () => {
				hooks++;
				return [];
			},
		});
		expect(() => s.engine.enqueue(proxy, options)).toThrow(NativeSyncError);
		Object.defineProperty(options, "scanId", {
			get: () => {
				hooks++;
				return newId();
			},
		});
		expect(() => s.engine.enqueue(s.f.ref(), options)).toThrow(NativeSyncError);
		expect(hooks).toBe(0);
		expect(job(s, options.jobId)).toBeUndefined();
	});

	it("keeps three stopped page sessions while allowing each next native delta scan", async () => {
		const s = await setup();
		for (let index = 0; index < 3; index++) {
			const { ref, scan } = start(s);
			expect(scan.requestMode).toBe(index === 0 ? "initial" : "delta");
			const held = claim(s, ref, scan);
			const recorded = s.f.database.write((scope) =>
				s.pages.record(scope, held.lease, ref, scan.version, {
					changes: [],
					cursor: `DYTEST-engine-cursor-${index}`,
					more: false,
				}),
			);
			expect(recorded.scan.status).toBe("waiting");
			expect(job(s, scan.jobId)?.state).toBe("SUCCEEDED");
			expect(s.engine.claim(ref, recorded.scan.version)).toBeUndefined();
		}
		const retained = s.f.database.write((scope) => s.cursors.list(scope, s.f.ref()));
		expect(retained).toHaveLength(3);
		expect(retained.every((scan) => scan.status === "waiting")).toBe(true);
	});

	it("resumes current active work beyond the first hundred historical scans", async () => {
		const s = await setup();
		for (let index = 0; index < 101; index++) {
			const { ref, scan } = start(s, 5, NOW + index);
			const held = claim(s, ref, scan);
			s.f.database.write((scope) =>
				s.pages.record(scope, held.lease, ref, scan.version, {
					changes: [],
					cursor: `DYTEST-past-scan-${index}`,
					more: false,
				}),
			);
		}
		const active = start(s, 2, NOW + 1_000);
		const firstHundred = s.f.database.write((scope) => s.cursors.list(scope, s.f.ref()));
		expect(firstHundred).toHaveLength(100);
		expect(firstHundred.every((scan) => scan.status === "waiting")).toBe(true);
		const unusedJobId = newId(NOW + 2_000);
		const resumed = s.engine.enqueue(s.f.ref(), {
			scanId: newId(NOW + 2_000),
			jobId: unusedJobId,
			maxAttempts: 20,
		});
		expect(resumed).toEqual(active.scan);
		expect(job(s, unusedJobId)).toBeUndefined();
		expect(claim(s, active.ref, resumed).lease.job.maxAttempts).toBe(2);
	});

	it("uses a fresh genuine lease for the successor created by atomic page application", async () => {
		const s = await setup();
		const { ref, scan } = start(s);
		const first = claim(s, ref, scan);
		const recorded = s.f.database.write((scope) =>
			s.pages.record(scope, first.lease, ref, scan.version, {
				changes: [],
				cursor: "DYTEST-engine-next-page",
				more: true,
			}),
		);
		expect(recorded.scan.jobId).not.toBe(scan.jobId);
		expect(job(s, scan.jobId)?.state).toBe("SUCCEEDED");
		const next = claim(s, ref, recorded.scan);
		expect(next.lease.job.id).toBe(recorded.scan.jobId);
		expect(next.lease).not.toBe(first.lease);
		expect(() => s.engine.renew(ref, recorded.scan.version, first.lease)).toThrow(NativeSyncError);
	});
});
