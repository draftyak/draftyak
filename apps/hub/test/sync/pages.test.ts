import { createHash } from "node:crypto";
import { ChannelSyncPage, type SyncPage } from "@draftyak/protocol/channel-v1";
import { type BlobRef, MAX_CHANGES } from "@draftyak/protocol/normalized-change";
import { afterEach, describe, expect, it } from "vitest";
import type { JobLease } from "../../src/jobs/queue.ts";
import { newId } from "../../src/kernel/ids.ts";
import {
	CONTENT_PURGE_BATCH,
	MAX_APPLY_BYTES,
	type MetadataAccountRef,
	type MetadataPurgeProgress,
	NativeSyncError,
} from "../../src/sync/apply.ts";
import { NativeSyncCursors, type SyncScan } from "../../src/sync/cursors.ts";
import { checkedSyncPage, NativeSyncPages, type RecordedSyncPage } from "../../src/sync/pages.ts";
import { RAW_CONTENT_CHUNK_BYTES } from "../../src/sync/raw-store.ts";
import { emailMessage, fixture, type NativeApplyFixture } from "./apply-fixture.ts";
import { type PurgeFixture, purgeFixture, rawView } from "./raw-purge-fixture.ts";

function page(): SyncPage {
	return {
		changes: [
			{
				kind: "email.message",
				providerId: "DYTEST-message-1",
				threadId: "DYTEST-thread-1",
				internalDate: 1,
				labelIds: ["INBOX"],
				raw: { base64: "RHl0ZXN0" },
			},
		],
		cursor: "DYTEST-cursor-1",
		more: true,
	};
}

function byteBoundPage(): SyncPage {
	const changes = Array.from({ length: 48 }, (_, index) => ({
		kind: "email.message" as const,
		providerId: `DYTEST-${index}`,
		threadId: "DYTEST-thread",
		internalDate: 1,
		labelIds: [],
		raw: { base64: "A".repeat(index === 47 ? 4 : 87_380) },
	}));
	const result = { changes, cursor: "DYTEST-cursor", more: false };
	const remaining = MAX_APPLY_BYTES - Buffer.byteLength(JSON.stringify(result));
	const last = changes[47];
	if (!last || remaining < 0 || last.raw.base64.length + remaining > 87_380)
		throw new Error("Invalid test byte budget");
	last.raw.base64 += "A".repeat(remaining - (remaining % 4));
	last.providerId += "X".repeat(remaining % 4);
	return result;
}

describe("untrusted sync page DATA", () => {
	it("validates, detaches and freezes the whole protocol page", () => {
		const input = page();
		const checked = checkedSyncPage(input);
		expect(checked).toEqual(input);
		expect(checked).not.toBe(input);
		expect(checked.changes).not.toBe(input.changes);
		expect(checked.changes[0]).not.toBe(input.changes[0]);
		const change = checked.changes[0];
		if (change?.kind !== "email.message") throw new Error("Missing test message");
		expect(Object.isFrozen(checked)).toBe(true);
		expect(Object.isFrozen(checked.changes)).toBe(true);
		expect(Object.isFrozen(change)).toBe(true);
		expect(Object.isFrozen(change.labelIds)).toBe(true);
		expect(Object.isFrozen(change.raw)).toBe(true);
		const original = input.changes[0];
		if (original?.kind !== "email.message") throw new Error("Missing test message");
		(original.labelIds as string[]).push("SENT");
		expect(change.labelIds).toEqual(["INBOX"]);
	});

	it("preserves empty and reported-final pages without inventing completion fields", () => {
		expect(checkedSyncPage({ changes: [], cursor: "DYTEST-cursor", more: false })).toEqual({
			changes: [],
			cursor: "DYTEST-cursor",
			more: false,
		});
	});

	it("refuses selected catalog DATA at the ordinary sync page boundary", () => {
		const input = {
			work: { kind: "slack.catalog" },
			conversations: [],
			continuation: { state: "complete" },
		};
		expect(ChannelSyncPage.parse(input)).toEqual(input);
		expect(() => checkedSyncPage(input)).toThrow(NativeSyncError);
	});

	it("keeps the existing chat protocol shape as untrusted DATA", () => {
		const input = {
			changes: [
				{
					kind: "chat.message",
					channelId: "DYTEST-channel",
					ts: "1.1",
					sentAt: 1,
					author: { kind: "user", id: "DYTEST-user" },
					text: "DYTEST text",
				},
			],
			cursor: "DYTEST-cursor",
			more: false,
		};
		expect(checkedSyncPage(input)).toEqual(input);
	});

	it.each(["changes", "cursor", "more"])("does not invoke the %s getter", (key) => {
		let reads = 0;
		const input = page();
		Object.defineProperty(input, key, {
			enumerable: true,
			get() {
				reads++;
				throw new Error("Untrusted getter");
			},
		});
		expect(() => checkedSyncPage(input)).toThrow(NativeSyncError);
		expect(reads).toBe(0);
	});

	it("does not invoke a nested array getter", () => {
		let reads = 0;
		const input = page();
		Object.defineProperty(input.changes, "0", {
			enumerable: true,
			get() {
				reads++;
				return {};
			},
		});
		expect(() => checkedSyncPage(input)).toThrow(NativeSyncError);
		expect(reads).toBe(0);
	});

	it("rejects proxies without invoking any proxy trap", () => {
		let traps = 0;
		const trap = (): never => {
			traps++;
			throw new Error("Untrusted proxy");
		};
		const input = new Proxy(page(), { get: trap, getPrototypeOf: trap, ownKeys: trap });
		expect(() => checkedSyncPage(input)).toThrow(NativeSyncError);
		expect(traps).toBe(0);
	});

	it("does not invoke serialization hooks", () => {
		let calls = 0;
		const input = {
			...page(),
			toJSON() {
				calls++;
				return page();
			},
		};
		expect(() => checkedSyncPage(input)).toThrow(NativeSyncError);
		expect(calls).toBe(0);
	});

	it.each([
		["missing more", { changes: [], cursor: "DYTEST-cursor" }],
		["invalid cursor", { changes: [], cursor: "has space", more: false }],
		["unknown field", { changes: [], cursor: "DYTEST-cursor", more: false, complete: true }],
		["unsupported change", { changes: [{ kind: "verified-email" }], cursor: "DYTEST", more: true }],
	])("uses the shared protocol validation for %s", (_, input) => {
		expect(() => checkedSyncPage(input)).toThrow(NativeSyncError);
	});

	it("accepts the exact shared change count and refuses one extra", () => {
		const changes = Array.from({ length: MAX_CHANGES }, (_, index) => ({
			kind: "email.deleted" as const,
			providerId: `DYTEST-${index}`,
		}));
		expect(checkedSyncPage({ changes, cursor: "DYTEST", more: false }).changes).toHaveLength(
			MAX_CHANGES,
		);
		expect(() =>
			checkedSyncPage({ changes: [...changes, changes[0]], cursor: "DYTEST", more: false }),
		).toThrow(NativeSyncError);
	});

	it("accepts exactly the byte budget and refuses one additional valid byte", () => {
		const input = byteBoundPage();
		expect(Buffer.byteLength(JSON.stringify(input))).toBe(MAX_APPLY_BYTES);
		expect(checkedSyncPage(input)).toEqual(input);
		const first = input.changes[0];
		if (first?.kind !== "email.message") throw new Error("Missing test message");
		const oversized = {
			...input,
			changes: [{ ...first, providerId: `${first.providerId}X` }, ...input.changes.slice(1)],
		};
		expect(Buffer.byteLength(JSON.stringify(oversized))).toBe(MAX_APPLY_BYTES + 1);
		expect(() => checkedSyncPage(oversized)).toThrow(NativeSyncError);
	});

	it("refuses cycles, sparse arrays and hidden fields", () => {
		const cycle: Record<string, unknown> = { changes: [], cursor: "DYTEST", more: false };
		cycle.self = cycle;
		const sparse = { changes: new Array(1), cursor: "DYTEST", more: false };
		const hidden = page();
		Object.defineProperty(hidden, "more", { enumerable: false, value: true });
		for (const input of [cycle, sparse, hidden])
			expect(() => checkedSyncPage(input)).toThrow(NativeSyncError);
	});
});

interface PagesFixture {
	readonly f: NativeApplyFixture;
	readonly cursors: NativeSyncCursors;
	readonly pages: NativeSyncPages;
	readonly scan: Readonly<SyncScan>;
	readonly lease: JobLease;
}

const fixtures: NativeApplyFixture[] = [];
afterEach(async () => {
	await Promise.all(fixtures.splice(0).map((f) => f.cleanup()));
});

async function nativePages(
	delta = false,
	maxAttempts = 5,
	providedFixture?: PurgeFixture,
): Promise<PagesFixture> {
	const f = providedFixture ?? (await fixture());
	fixtures.push(f);
	if (delta) {
		const seed = f.lease();
		f.database.write((scope) => f.model.applyPage(scope, seed, f.page()));
	}
	const cursors = new NativeSyncCursors(
		f.database,
		f.model,
		f.devices,
		f.jobs,
		f.accounts,
		f.nativeClock,
	);
	const pages = new NativeSyncPages(f.database, f.model, cursors, f.jobs);
	const scan = f.database.write((scope) => {
		const scanId = newId();
		const jobId = newId();
		f.jobs.enqueue(scope, {
			id: jobId,
			accountId: f.account.id,
			ownerId: f.account.userId,
			kind: "sync",
			refId: scanId,
			maxAttempts,
		});
		return cursors.create(scope, f.ref(), {
			scanId,
			jobId,
			requestMode: delta ? "delta" : "initial",
			since: Math.max(0, f.clock.wall - f.account.historyLimitDays * 86_400_000),
		});
	});
	const lease = claim(f, scan);
	return { f, cursors, pages, scan, lease };
}

function claim(f: NativeApplyFixture, scan: Readonly<SyncScan>): JobLease {
	const lease = f.database.write((scope) => f.jobs.claim(scope, f.account.id, scan.jobId));
	if (!lease) throw new Error("Expected the exact native page job");
	return lease;
}

function record(
	test: PagesFixture,
	scan: Readonly<SyncScan>,
	lease: JobLease,
	input: unknown,
): RecordedSyncPage {
	return test.f.database.write((scope) =>
		test.pages.record(scope, lease, { ...test.f.ref(), scanId: scan.scanId }, scan.version, input),
	);
}

function observations(test: PagesFixture, scan: Readonly<SyncScan>) {
	return test.f.database.write((scope) =>
		test.pages.observations(scope, { ...test.f.ref(), scanId: scan.scanId }, scan.version),
	);
}

describe("native sync page associations", () => {
	it.each([1, 2])(
		"preserves the configured %i-attempt budget on successor jobs",
		async (maxAttempts) => {
			const test = await nativePages(false, maxAttempts);
			const result = record(test, test.scan, test.lease, {
				changes: [],
				cursor: "DYTEST-budget-a",
				more: true,
			});
			expect(
				test.f.database.write((scope) => test.f.jobs.get(scope, result.scan.jobId)?.maxAttempts),
			).toBe(maxAttempts);
			for (let attempt = 1; attempt <= maxAttempts; attempt++) {
				const lease = claim(test.f, result.scan);
				test.f.database.write((scope) => test.f.jobs.fail(scope, lease, 0));
				expect(
					test.f.database.write((scope) => test.f.jobs.get(scope, result.scan.jobId)?.state),
				).toBe(attempt === maxAttempts ? "FAILED" : "PENDING");
			}
		},
	);

	it("does not bind earlier transient messages to a later recreated identity", async () => {
		const test = await nativePages();
		const providerId = "DYTEST-recreated";
		const result = record(test, test.scan, test.lease, {
			changes: [
				emailMessage(providerId),
				{ kind: "email.deleted", providerId },
				emailMessage(providerId),
				{ kind: "email.deleted", providerId },
				emailMessage(providerId),
			],
			cursor: "DYTEST-recreated-a",
			more: false,
		});
		const current = test.f.database.write((scope) => test.f.model.messages(scope, test.f.ref())[0]);
		expect(current).toBeDefined();
		expect(observations(test, result.scan).map((row) => row.messageId)).toEqual([
			null,
			null,
			null,
			null,
			current?.id,
		]);
	});

	it("keeps the prior identity distinct from a later recreation in the same page", async () => {
		const test = await nativePages();
		const providerId = "DYTEST-existing-recreated";
		const first = record(test, test.scan, test.lease, {
			changes: [emailMessage(providerId)],
			cursor: "DYTEST-existing-a",
			more: true,
		});
		const prior = observations(test, first.scan)[0]?.messageId;
		expect(prior).toBeTypeOf("string");
		const result = record(test, first.scan, claim(test.f, first.scan), {
			changes: [
				emailMessage(providerId),
				{ kind: "email.deleted", providerId },
				emailMessage(providerId),
			],
			cursor: "DYTEST-existing-b",
			more: false,
		});
		const current = test.f.database.write((scope) => test.f.model.messages(scope, test.f.ref())[0]);
		expect(current).toBeDefined();
		expect(current?.id).not.toBe(prior);
		expect(
			observations(test, result.scan)
				.filter((row) => row.pageOrdinal === 1)
				.map((row) => row.messageId),
		).toEqual([prior, prior, current?.id]);
	});

	it("captures the requested position before currentness clock hooks run", async () => {
		const test = await nativePages();
		const result = record(test, test.scan, test.lease, {
			changes: [emailMessage("DYTEST-position-a"), emailMessage("DYTEST-position-b")],
			cursor: "DYTEST-position",
			more: false,
		});
		const after = { pageOrdinal: 0, changeIndex: 0 };
		const wall = test.f.clock.wall;
		let reads = 0;
		Object.defineProperty(test.f.clock, "wall", {
			configurable: true,
			enumerable: true,
			get: () => {
				reads++;
				after.changeIndex = 1;
				return wall;
			},
		});
		try {
			const seen = test.f.database.write((scope) =>
				test.pages.observations(
					scope,
					{ ...test.f.ref(), scanId: result.scan.scanId },
					result.scan.version,
					after,
				),
			);
			expect(reads).toBeGreaterThan(0);
			expect(after.changeIndex).toBe(1);
			expect(seen.map((row) => row.providerId)).toEqual(["DYTEST-position-b"]);
		} finally {
			Object.defineProperty(test.f.clock, "wall", {
				configurable: true,
				enumerable: true,
				writable: true,
				value: wall,
			});
		}
	});

	it("atomically records ordered observations and the genuine successor job", async () => {
		const test = await nativePages();
		const result = record(test, test.scan, test.lease, {
			changes: [emailMessage("DYTEST-two"), emailMessage("DYTEST-one")],
			cursor: "DYTEST-a",
			more: true,
		});
		expect(result).toMatchObject({
			pageJobId: test.scan.jobId,
			pageOrdinal: 0,
			cursor: "DYTEST-a",
			revision: 1,
			observationCount: 2,
			scan: { scanId: test.scan.scanId, version: 2, ordinal: 1, status: "active" },
		});
		expect(result.scan.jobId).not.toBe(test.scan.jobId);
		const jobs = test.f.database.write((scope) => [
			test.f.jobs.get(scope, test.scan.jobId),
			test.f.jobs.get(scope, result.scan.jobId),
		]);
		expect(jobs[0]?.state).toBe("SUCCEEDED");
		expect(jobs[1]).toMatchObject({ state: "PENDING", refId: test.scan.scanId, kind: "sync" });
		const seen = observations(test, result.scan);
		expect(seen.map((row) => [row.pageOrdinal, row.changeIndex, row.providerId])).toEqual([
			[0, 0, "DYTEST-two"],
			[0, 1, "DYTEST-one"],
		]);
		expect(seen.every((row) => row.messageId !== null)).toBe(true);
	});

	it("retains a reported-final page as waiting DATA with no continuation job", async () => {
		const test = await nativePages();
		const result = record(test, test.scan, test.lease, {
			changes: [],
			cursor: "DYTEST-a",
			more: false,
		});
		expect(result.scan).toMatchObject({ status: "waiting", jobId: test.scan.jobId, ordinal: 1 });
		expect(result.observationCount).toBe(0);
		expect(Object.hasOwn(result, "complete")).toBe(false);
		expect(Object.hasOwn(result.scan, "complete")).toBe(false);
		expect(observations(test, result.scan)).toEqual([]);
	});

	it("rolls back all page state when a copied lease refusal is caught in the write", async () => {
		const test = await nativePages();
		const lateJobId = newId();
		expect(() =>
			test.f.database.write((scope) => {
				try {
					test.pages.record(
						scope,
						{ job: test.lease.job },
						{ ...test.f.ref(), scanId: test.scan.scanId },
						test.scan.version,
						{ changes: [emailMessage()], cursor: "DYTEST-a", more: true },
					);
				} catch (error) {
					expect(error).toBeInstanceOf(NativeSyncError);
				}
				test.f.jobs.enqueue(scope, {
					id: lateJobId,
					accountId: test.f.account.id,
					ownerId: test.f.account.userId,
					kind: "draft",
					refId: newId(),
				});
			}),
		).toThrow();
		const state = test.f.database.write((scope) => ({
			checkpoint: test.f.model.checkpoint(scope, test.f.ref()),
			messages: test.f.model.messages(scope, test.f.ref()),
			lateJob: test.f.jobs.get(scope, lateJobId),
			scan: test.cursors.get(scope, test.f.ref(), test.scan.scanId),
		}));
		expect(state.checkpoint).toEqual({ cursor: null, revision: 0 });
		expect(state.messages).toEqual([]);
		expect(state.lateJob).toBeUndefined();
		expect(state.scan).toMatchObject({ version: 1, ordinal: 0, jobId: test.scan.jobId });
		expect(observations(test, test.scan)).toEqual([]);
	});

	it("poisons the original write when a page getter refusal is caught before metadata apply", async () => {
		const test = await nativePages();
		let reads = 0;
		const input = { changes: [], cursor: "DYTEST-a" };
		Object.defineProperty(input, "more", {
			enumerable: true,
			get() {
				reads++;
				return false;
			},
		});
		const lateJobId = newId();
		expect(() =>
			test.f.database.write((scope) => {
				try {
					test.pages.record(
						scope,
						test.lease,
						{ ...test.f.ref(), scanId: test.scan.scanId },
						test.scan.version,
						input,
					);
				} catch (error) {
					expect(error).toBeInstanceOf(NativeSyncError);
				}
				test.f.jobs.enqueue(scope, {
					id: lateJobId,
					accountId: test.f.account.id,
					ownerId: test.f.account.userId,
					kind: "draft",
					refId: newId(),
				});
			}),
		).toThrow();
		expect(reads).toBe(0);
		expect(test.f.database.write((scope) => test.f.jobs.get(scope, lateJobId))).toBeUndefined();
	});

	it.each(["accountId", "generation", "pluginInstanceId", "ownerEpoch", "mode"] as const)(
		"refuses a stale %s before committing a page",
		async (field) => {
			const test = await nativePages();
			const changed = {
				accountId: newId(),
				generation: test.f.generation + 1,
				pluginInstanceId: newId(),
				ownerEpoch: test.f.ref().ownerEpoch + 1,
				mode: "read_only" as const,
			};
			expect(() =>
				test.f.database.write((scope) =>
					test.pages.record(
						scope,
						test.lease,
						{ ...test.f.ref(), scanId: test.scan.scanId, [field]: changed[field] },
						test.scan.version,
						{ changes: [emailMessage()], cursor: "DYTEST-a", more: false },
					),
				),
			).toThrow(NativeSyncError);
			expect(
				test.f.database.write((scope) => test.f.model.checkpoint(scope, test.f.ref())),
			).toEqual({ cursor: null, revision: 0 });
		},
	);

	it("refuses a genuine lease from another account while this exact job stays running", async () => {
		const test = await nativePages();
		const account = test.f.email();
		const another = newId();
		const lease = test.f.database.write((scope) => {
			test.f.accounts.create(scope, account);
			test.f.jobs.enqueue(scope, {
				id: another,
				accountId: account.id,
				ownerId: test.f.account.userId,
				kind: "sync",
				refId: newId(),
			});
			const claimed = test.f.jobs.claim(scope, account.id, another);
			if (!claimed) throw new Error("Expected another native job");
			return claimed;
		});
		expect(() => record(test, test.scan, lease, page())).toThrow(NativeSyncError);
		expect(test.f.database.write((scope) => test.f.jobs.get(scope, test.scan.jobId)?.state)).toBe(
			"RUNNING",
		);
		expect(test.f.database.write((scope) => test.f.model.checkpoint(scope, test.f.ref()))).toEqual({
			cursor: null,
			revision: 0,
		});
	});

	it("refuses a terminal cursor cycle and rolls back its metadata page", async () => {
		const test = await nativePages();
		const first = record(test, test.scan, test.lease, {
			changes: [emailMessage()],
			cursor: "DYTEST-a",
			more: true,
		});
		const second = record(test, first.scan, claim(test.f, first.scan), {
			changes: [],
			cursor: "DYTEST-b",
			more: true,
		});
		const lease = claim(test.f, second.scan);
		expect(() =>
			record(test, second.scan, lease, {
				changes: [emailMessage("DYTEST-refused")],
				cursor: "DYTEST-a",
				more: false,
			}),
		).toThrow(NativeSyncError);
		expect(test.f.database.write((scope) => test.f.model.checkpoint(scope, test.f.ref()))).toEqual({
			cursor: "DYTEST-b",
			revision: 2,
		});
		expect(observations(test, second.scan).map((row) => row.providerId)).toEqual([
			"DYTEST-message-1",
		]);
	});

	it("allows only the first empty delta page to retain its current cursor", async () => {
		const test = await nativePages(true);
		const result = record(test, test.scan, test.lease, {
			changes: [],
			cursor: test.scan.cursor,
			more: false,
		});
		expect(result).toMatchObject({ observationCount: 0, revision: 2, scan: { status: "waiting" } });
		expect(result.cursor).toBe(test.scan.cursor);
	});

	it("refuses a stationary delta page with real observations", async () => {
		const test = await nativePages(true);
		expect(() =>
			record(test, test.scan, test.lease, {
				changes: [emailMessage()],
				cursor: test.scan.cursor,
				more: false,
			}),
		).toThrow(NativeSyncError);
		expect(test.f.database.write((scope) => test.f.model.checkpoint(scope, test.f.ref()))).toEqual({
			cursor: test.scan.cursor,
			revision: 1,
		});
	});

	it("retains a deletion's genuine prior message identity as observation DATA", async () => {
		const test = await nativePages();
		const first = record(test, test.scan, test.lease, {
			changes: [emailMessage()],
			cursor: "DYTEST-a",
			more: true,
		});
		const oldId = observations(test, first.scan)[0]?.messageId;
		expect(oldId).toBeTypeOf("string");
		const second = record(test, first.scan, claim(test.f, first.scan), {
			changes: [{ kind: "email.deleted", providerId: "DYTEST-message-1" }],
			cursor: "DYTEST-b",
			more: false,
		});
		expect(observations(test, second.scan)[1]).toMatchObject({
			kind: "email.deleted",
			threadId: null,
			messageId: oldId,
		});
		expect(test.f.database.write((scope) => test.f.model.messages(scope, test.f.ref()))).toEqual(
			[],
		);
	});

	it("preserves duplicate provider claims without inventing an intermediate native identity", async () => {
		const test = await nativePages();
		const result = record(test, test.scan, test.lease, {
			changes: [emailMessage(), { kind: "email.deleted", providerId: "DYTEST-message-1" }],
			cursor: "DYTEST-a",
			more: false,
		});
		expect(
			observations(test, result.scan).map((row) => [row.changeIndex, row.kind, row.messageId]),
		).toEqual([
			[0, "email.message", null],
			[1, "email.deleted", null],
		]);
	});

	it("reads observations in bounded stable page/change order", async () => {
		const test = await nativePages();
		const result = record(test, test.scan, test.lease, {
			changes: [emailMessage("DYTEST-a"), emailMessage("DYTEST-b"), emailMessage("DYTEST-c")],
			cursor: "DYTEST-a",
			more: false,
		});
		const ref = { ...test.f.ref(), scanId: result.scan.scanId };
		const first = test.f.database.write((scope) =>
			test.pages.observations(scope, ref, result.scan.version, null, 2),
		);
		expect(first.map((row) => row.providerId)).toEqual(["DYTEST-a", "DYTEST-b"]);
		const last = first[1];
		if (!last) throw new Error("Expected an observation position");
		const rest = test.f.database.write((scope) =>
			test.pages.observations(
				scope,
				ref,
				result.scan.version,
				{ pageOrdinal: last.pageOrdinal, changeIndex: last.changeIndex },
				2,
			),
		);
		expect(rest.map((row) => row.providerId)).toEqual(["DYTEST-c"]);
		expect(() =>
			test.f.database.write((scope) =>
				test.pages.observations(scope, ref, result.scan.version, null, 101),
			),
		).toThrow(NativeSyncError);
	});

	it("refuses a foreign metadata service and preserves both original stores", async () => {
		const test = await nativePages();
		const other = await fixture();
		fixtures.push(other);
		const foreign = new NativeSyncPages(test.f.database, other.model, test.cursors, test.f.jobs);
		expect(() =>
			test.f.database.write((scope) =>
				foreign.record(
					scope,
					test.lease,
					{ ...test.f.ref(), scanId: test.scan.scanId },
					test.scan.version,
					page(),
				),
			),
		).toThrow(NativeSyncError);
		for (const f of [test.f, other])
			expect(f.database.write((scope) => f.model.checkpoint(scope, f.ref()))).toEqual({
				cursor: null,
				revision: 0,
			});
	});
});

const PURGE_TABLES = [
	"sync_page_observations",
	"sync_scan_pages",
	"sync_scans",
	"content_messages",
	"content_conversations",
	"content_pages",
	"content_checkpoints",
] as const;
type PurgeCounts = Readonly<Record<(typeof PURGE_TABLES)[number], number>>;
interface CombinedPurgeCounts {
	readonly content: PurgeCounts;
	readonly rawObjects: number;
	readonly rawChunks: number;
}

function accountPurgeCounts(f: NativeApplyFixture, accountId: string): PurgeCounts {
	return f.database.write((scope) => {
		const counts = {} as Record<(typeof PURGE_TABLES)[number], number>;
		for (const table of PURGE_TABLES) {
			const count = f.database
				.sql(scope)
				.get<{ count: number }>(`SELECT count(*) AS count FROM main.${table} WHERE account_id=?`, [
					accountId,
				])?.count;
			if (count === undefined || !Number.isSafeInteger(count) || count < 0)
				throw new Error("Invalid synthetic account row count");
			counts[table] = count;
		}
		return Object.freeze(counts);
	});
}

function combinedPurgeCounts(f: PurgeFixture, accountId: string): CombinedPurgeCounts {
	const raw = f.database.write((scope) => {
		const sql = f.database.sql(scope);
		const objects = sql.get<{ count: number }>(
			"SELECT count(*) AS count FROM main.rawcontent_objects WHERE account_id=?",
			[accountId],
		)?.count;
		const chunks = sql.get<{ count: number }>(
			`SELECT count(*) AS count FROM main.rawcontent_chunks c
 JOIN main.rawcontent_objects o ON o.id=c.object_id WHERE o.account_id=?`,
			[accountId],
		)?.count;
		if (objects === undefined || chunks === undefined) throw new Error("Missing Raw counts");
		return { rawObjects: objects, rawChunks: chunks };
	});
	return Object.freeze({ content: accountPurgeCounts(f, accountId), ...raw });
}

function boundedPurge(
	before: CombinedPurgeCounts,
	after: CombinedPurgeCounts,
	result: MetadataPurgeProgress,
): void {
	let deleted = 0;
	for (const table of PURGE_TABLES) {
		const difference = before.content[table] - after.content[table];
		expect(difference).toBeGreaterThanOrEqual(0);
		expect(difference).toBeLessThanOrEqual(CONTENT_PURGE_BATCH);
		deleted += difference;
	}
	const rawChunks = before.rawChunks - after.rawChunks;
	const rawObjects = before.rawObjects - after.rawObjects;
	expect(rawChunks).toBeGreaterThanOrEqual(0);
	expect(rawChunks).toBeLessThanOrEqual(64);
	expect(rawObjects).toBeGreaterThanOrEqual(0);
	expect(rawObjects).toBeLessThanOrEqual(1);
	expect(result.deleted).toBe(deleted + rawChunks + rawObjects);
	if (result.more) expect(result.lease).not.toBeNull();
	else expect(result.lease).toBeNull();
}

async function populatedPages(total: 501 | 601, raw: PurgeFixture): Promise<PagesFixture> {
	const test = await nativePages(false, 5, raw);
	let scan = test.scan;
	let lease = test.lease;
	let pageOrdinal = 0;
	for (let offset = 0; offset < total; offset += MAX_CHANGES) {
		const length = Math.min(MAX_CHANGES, total - offset);
		const more = offset + length < total;
		const committed = record(test, scan, lease, {
			changes: Array.from({ length }, (_, index) => emailMessage(`DYTEST-purge-${offset + index}`)),
			cursor: `DYTEST-purge-page-${pageOrdinal}`,
			more,
		});
		expect(committed.observationCount).toBe(length);
		scan = committed.scan;
		pageOrdinal++;
		if (more) lease = claim(test.f, scan);
	}
	expect(pageOrdinal).toBe(2);
	expect(accountPurgeCounts(test.f, test.f.account.id).sync_page_observations).toBe(total);
	return { ...test, scan, lease };
}

function addForeignPage(test: PagesFixture): MetadataAccountRef {
	const { f } = test;
	const account = f.email({ alias: "dytest-retained-foreign" });
	const created = f.database.write((scope) => f.accounts.create(scope, account));
	const ref: MetadataAccountRef = {
		...f.ref(),
		accountId: account.id,
		generation: created.generation,
		pluginInstanceId: account.pluginInstanceId,
		mode: account.mode,
	};
	const scan = f.database.write((scope) => {
		const scanId = newId();
		const jobId = newId();
		f.jobs.enqueue(scope, {
			id: jobId,
			accountId: account.id,
			ownerId: account.userId,
			kind: "sync",
			refId: scanId,
		});
		return test.cursors.create(scope, ref, {
			scanId,
			jobId,
			requestMode: "initial",
			since: Math.max(0, f.clock.wall - account.historyLimitDays * 86_400_000),
		});
	});
	const lease = f.database.write((scope) => f.jobs.claim(scope, account.id, scan.jobId));
	if (!lease) throw new Error("Expected the foreign account's genuine page job");
	f.database.write((scope) =>
		test.pages.record(scope, lease, { ...ref, scanId: scan.scanId }, scan.version, {
			changes: [emailMessage("DYTEST-foreign-message", { threadId: "DYTEST-foreign-thread" })],
			cursor: "DYTEST-foreign-page",
			more: false,
		}),
	);
	return ref;
}

async function writeRawChunks(
	f: PurgeFixture,
	ref: MetadataAccountRef,
	chunkCount: 1 | 65 | 193,
	fill = 0x44,
): Promise<BlobRef> {
	const view = rawView(f, ref);
	const signal = new AbortController().signal;
	const bytes = new Uint8Array(RAW_CONTENT_CHUNK_BYTES).fill(fill);
	const writer = f.database.write((scope) =>
		view.model.begin(scope, view.ref(), { maxBytes: chunkCount * RAW_CONTENT_CHUNK_BYTES }),
	);
	try {
		for (let index = 0; index < chunkCount; index++) await writer.write(bytes, signal);
		return await writer.commit(signal);
	} catch (error) {
		try {
			await writer.abort();
		} catch (cleanup) {
			throw new AggregateError([error, cleanup], "Owned Raw setup cleanup failed");
		}
		throw error;
	} finally {
		bytes.fill(0);
	}
}

function disconnectForPurge(f: NativeApplyFixture): MetadataAccountRef {
	const previous = f.generation;
	const changed = f.database.write((scope) =>
		f.accounts.replace(scope, { ...f.account, status: "disconnecting" }, f.generation),
	);
	if (changed.account.channel !== "email") throw new Error("Expected the synthetic email account");
	f.account = changed.account;
	f.generation = changed.generation;
	expect(f.generation).toBe(previous + 1);
	expect(f.account.status).toBe("disconnecting");
	return f.ref();
}

function finishPurge(
	f: PurgeFixture,
	ref: MetadataAccountRef,
	initial: MetadataPurgeProgress,
	foreign?: { readonly accountId: string; readonly counts: CombinedPurgeCounts },
): { readonly batches: number; readonly rawOnlyRenewals: number } {
	let result = initial;
	let batches = 1;
	let rawOnlyRenewals = 0;
	while (result.more && batches < 8) {
		const lease = result.lease;
		if (!lease) throw new Error("A continued purge needs its genuine renewed lease");
		const before = combinedPurgeCounts(f, ref.accountId);
		result = f.database.write((scope) => f.model.purge(scope, lease, ref));
		const after = combinedPurgeCounts(f, ref.accountId);
		boundedPurge(before, after, result);
		if (Object.values(after.content).every((count) => count === 0) && after.rawChunks > 0) {
			expect(after.rawChunks).toBe(1);
			expect(result.more).toBe(true);
			expect(result.lease).not.toBeNull();
			rawOnlyRenewals++;
		}
		if (result.more) {
			expect(result.lease).not.toBe(lease);
			expect(result.lease?.job.id).toBe(lease.job.id);
		}
		if (foreign) expect(combinedPurgeCounts(f, foreign.accountId)).toEqual(foreign.counts);
		batches++;
	}
	expect(result.more).toBe(false);
	expect(result.lease).toBeNull();
	expect(batches).toBeGreaterThan(1);
	const final = combinedPurgeCounts(f, ref.accountId);
	for (const count of Object.values(final.content)) expect(count).toBe(0);
	expect(final.rawChunks).toBe(0);
	expect(final.rawObjects).toBe(0);
	return { batches, rawOnlyRenewals };
}

describe("bounded sync journal retention", () => {
	it("couples Raw continuation with 601 observations from two pages while retaining another account", async () => {
		const f = await purgeFixture("current");
		const test = await populatedPages(601, f);
		const anchored = f.database.write((scope) =>
			scope.sql.all<{ scanId: string }>(
				"SELECT a.scan_id AS scanId FROM main.sync_scan_anchors a JOIN main.sync_scans s ON s.id=a.scan_id WHERE s.account_id=? LIMIT 2",
				[f.account.id],
			),
		);
		expect(anchored).toHaveLength(1);
		await writeRawChunks(f, f.ref(), 193);
		const foreignRef = addForeignPage(test);
		const foreignBlob = await writeRawChunks(f, foreignRef, 1, 0x46);
		const foreignCounts = combinedPurgeCounts(f, foreignRef.accountId);
		expect(Object.values(foreignCounts.content)).toEqual([1, 1, 1, 1, 1, 1, 1]);
		expect(foreignCounts).toMatchObject({ rawObjects: 1, rawChunks: 1 });
		const before = combinedPurgeCounts(f, f.account.id);
		expect(before.rawObjects).toBe(1);
		expect(before.rawChunks).toBe(193);
		expect(before.content).toEqual({
			sync_page_observations: 601,
			sync_scan_pages: 2,
			sync_scans: 1,
			content_messages: 601,
			content_conversations: 1,
			content_pages: 2,
			content_checkpoints: 1,
		});
		const ref = disconnectForPurge(f);
		const lease = f.lease("retention");
		const first = f.database.write((scope) => f.model.purge(scope, lease, ref));
		const after = combinedPurgeCounts(f, ref.accountId);
		boundedPurge(before, after, first);
		expect(after.rawChunks).toBe(129);
		expect(after.rawObjects).toBe(1);
		expect(after.content.sync_page_observations).toBe(101);
		expect(after.content.sync_scan_pages).toBe(1);
		expect(after.content.sync_scans).toBe(1);
		for (const table of [
			"content_messages",
			"content_conversations",
			"content_pages",
			"content_checkpoints",
		] as const)
			expect(after.content[table]).toBe(before.content[table]);
		expect(first.more).toBe(true);
		expect(first.lease).not.toBe(lease);
		expect(first.lease?.job.id).toBe(lease.job.id);
		expect(combinedPurgeCounts(f, foreignRef.accountId)).toEqual(foreignCounts);
		const finished = finishPurge(f, ref, first, {
			accountId: foreignRef.accountId,
			counts: foreignCounts,
		});
		expect(finished).toEqual({ batches: 4, rawOnlyRenewals: 1 });
		for (const anchor of anchored)
			expect(
				f.database.write((scope) =>
					scope.sql.get<{ count: number }>(
						"SELECT count(*) AS count FROM main.sync_scan_anchors WHERE scan_id=?",
						[anchor.scanId],
					),
				)?.count,
			).toBe(0);
		expect(f.database.write((scope) => f.jobs.get(scope, lease.job.id)?.state)).toBe("SUCCEEDED");
		const foreign = rawView(f, foreignRef);
		const retained = f.database.write((scope) =>
			foreign.model.read(scope, foreign.ref(), foreignBlob, 0, RAW_CONTENT_CHUNK_BYTES),
		);
		const expected = new Uint8Array(RAW_CONTENT_CHUNK_BYTES).fill(0x46);
		expect(retained.totalBytes).toBe(RAW_CONTENT_CHUNK_BYTES);
		expect(retained.nextOffset).toBeNull();
		expect(retained.bytes.byteLength).toBe(RAW_CONTENT_CHUNK_BYTES);
		expect(retained.sha256).toBe(createHash("sha256").update(expected).digest("hex"));
		expect(retained.bytes.every((byte) => byte === 0x46)).toBe(true);
	});

	it("rolls back caught copied-retention-lease deletes and continues with the original native lease", async () => {
		const f = await purgeFixture("current");
		await populatedPages(501, f);
		await writeRawChunks(f, f.ref(), 65);
		const ref = disconnectForPurge(f);
		const lease = f.lease("retention");
		const before = combinedPurgeCounts(f, ref.accountId);
		let caught: unknown;
		expect(() =>
			f.database.write((scope) => {
				try {
					f.model.purge(scope, { job: lease.job }, ref);
				} catch (error) {
					caught = error;
				}
			}),
		).toThrow();
		expect(caught).toBeInstanceOf(NativeSyncError);
		expect(combinedPurgeCounts(f, ref.accountId)).toEqual(before);
		expect(f.database.write((scope) => f.jobs.get(scope, lease.job.id)?.state)).toBe("RUNNING");
		const first = f.database.write((scope) => f.model.purge(scope, lease, ref));
		const after = combinedPurgeCounts(f, ref.accountId);
		boundedPurge(before, after, first);
		expect(after.rawChunks).toBe(1);
		expect(after.content.sync_page_observations).toBe(1);
		expect(first.more).toBe(true);
		expect(first.lease).not.toBe(lease);
		finishPurge(f, ref, first);
		expect(f.database.write((scope) => f.jobs.get(scope, lease.job.id)?.state)).toBe("SUCCEEDED");
	});
});
