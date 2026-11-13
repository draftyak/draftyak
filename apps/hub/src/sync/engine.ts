import { SyncRequest } from "@draftyak/protocol/channel-v1";
import { NativeAccounts } from "../accounts/records.ts";
import { WorkDatabase, type WorkScope } from "../jobs/database.ts";
import {
	JOB_MAX_ATTEMPTS,
	JOB_MAX_RETRY_MS,
	type Job,
	type JobLease,
	JobQueue,
} from "../jobs/queue.ts";
import { fields, id, integer } from "../jobs/values.ts";
import type { Clock } from "../kernel/clock.ts";
import {
	type MetadataAccountRef,
	type MetadataCheckpoint,
	NativeMetadataStore,
	NativeSyncError,
} from "./apply.ts";
import { NativeSyncCursors, SYNC_MAX_PAGES, type SyncScan, type SyncScanRef } from "./cursors.ts";

export interface EnqueueSync {
	readonly scanId: string;
	readonly jobId: string;
	readonly maxAttempts?: number;
}

export interface ClaimedSyncPage {
	readonly scan: SyncScan;
	readonly lease: JobLease;
}

export interface PreparedSyncPage extends ClaimedSyncPage {
	readonly request: SyncRequest;
}

export interface ClaimSyncMessage {
	readonly jobId: string;
	readonly messageId: string;
	readonly expectedCheckpoint: MetadataCheckpoint;
	readonly afterId: string | null;
	readonly limit: number;
	readonly maxAttempts?: number;
}

const write = WorkDatabase.prototype.write;
const abort = WorkDatabase.prototype.abort;
const getAccount = NativeAccounts.prototype.get;
const enqueueJob = JobQueue.prototype.enqueue;
const getJob = JobQueue.prototype.get;
const claimJob = JobQueue.prototype.claim;
const renewJob = JobQueue.prototype.renew;
const failJob = JobQueue.prototype.fail;
const cancelJob = JobQueue.prototype.cancel;
const current = NativeSyncCursors.prototype.current;
const activeScan = NativeSyncCursors.prototype.active;
const retireUnanchored = NativeSyncCursors.prototype.retireUnanchored;
const createScan = NativeSyncCursors.prototype.create;
const checkScan = NativeSyncCursors.prototype.check;
const scanContinuation = NativeSyncCursors.prototype.continuation;
const stopScan = NativeSyncCursors.prototype.stop;
const resyncScan = NativeSyncCursors.prototype.resync;
const metadataCheckpoint = NativeMetadataStore.prototype.checkpoint;
const metadataMessages = NativeMetadataStore.prototype.messages;
const DAY_MS = 86_400_000;
const REF_FIELDS = ["accountId", "generation", "pluginInstanceId", "ownerEpoch", "mode"];
const JOB_FIELDS = [
	"id",
	"accountId",
	"ownerId",
	"kind",
	"refId",
	"state",
	"attempts",
	"maxAttempts",
	"createdAt",
	"nextAt",
	"leaseUntil",
];

function refuse(): never {
	throw new NativeSyncError();
}

function reference(row: Readonly<Record<string, unknown>>): MetadataAccountRef {
	if (row.mode !== "full" && row.mode !== "read_only") refuse();
	return Object.freeze({
		accountId: id(row.accountId),
		generation: integer(row.generation, 1),
		pluginInstanceId: id(row.pluginInstanceId),
		ownerEpoch: integer(row.ownerEpoch),
		mode: row.mode,
	});
}

function accountRef(input: MetadataAccountRef): MetadataAccountRef {
	try {
		return reference(fields(input, REF_FIELDS));
	} catch {
		return refuse();
	}
}

function scanRef(input: SyncScanRef): SyncScanRef {
	try {
		const row = fields(input, [...REF_FIELDS, "scanId"]);
		return Object.freeze({ ...reference(row), scanId: id(row.scanId) });
	} catch {
		return refuse();
	}
}

function metadataRef(ref: SyncScanRef): MetadataAccountRef {
	return Object.freeze({
		accountId: ref.accountId,
		generation: ref.generation,
		pluginInstanceId: ref.pluginInstanceId,
		ownerEpoch: ref.ownerEpoch,
		mode: ref.mode,
	});
}

function enqueueInput(input: EnqueueSync): Required<EnqueueSync> {
	try {
		const row = fields(input, ["scanId", "jobId"], ["maxAttempts"]);
		return Object.freeze({
			scanId: id(row.scanId),
			jobId: id(row.jobId),
			maxAttempts: Object.hasOwn(row, "maxAttempts")
				? integer(row.maxAttempts, 1, JOB_MAX_ATTEMPTS)
				: 5,
		});
	} catch {
		return refuse();
	}
}

function messageInput(input: ClaimSyncMessage): Required<ClaimSyncMessage> {
	try {
		const row = fields(
			input,
			["jobId", "messageId", "expectedCheckpoint", "afterId", "limit"],
			["maxAttempts"],
		);
		const checkpoint = fields(row.expectedCheckpoint, ["cursor", "revision"]);
		const cursor = checkpoint.cursor;
		if (cursor !== null && (typeof cursor !== "string" || cursor.length > 4096)) refuse();
		return Object.freeze({
			jobId: id(row.jobId),
			messageId: id(row.messageId),
			expectedCheckpoint: Object.freeze({
				cursor,
				revision: integer(checkpoint.revision),
			}),
			afterId: row.afterId === null ? null : id(row.afterId),
			limit: integer(row.limit, 1, 100),
			maxAttempts: Object.hasOwn(row, "maxAttempts")
				? integer(row.maxAttempts, 1, JOB_MAX_ATTEMPTS)
				: 5,
		});
	} catch {
		return refuse();
	}
}

function pageRequest(scan: SyncScan, continuation: string | null, now: number): SyncRequest {
	if (scan.requestMode === "delta")
		return Object.freeze(SyncRequest.parse({ mode: "delta", cursor: continuation }));
	if (scan.since === null || scan.since > now) refuse();
	return Object.freeze(
		SyncRequest.parse({
			mode: scan.requestMode,
			since: integer(scan.since),
			...(continuation === null ? {} : { cursor: continuation }),
		}),
	);
}

/**
 * Durable sync-job coordination, not a channel invoker or a completion issuer.
 * Every operation owns one short native write. Broker and parser work must run
 * outside it; the page store subsequently applies and completes each page lease.
 */
export class NativeSyncEngine {
	readonly #database: WorkDatabase;
	readonly #accounts: NativeAccounts;
	readonly #jobs: JobQueue;
	readonly #cursors: NativeSyncCursors;
	readonly #clock: Clock;
	readonly #metadata: NativeMetadataStore | undefined;

	constructor(
		database: WorkDatabase,
		accounts: NativeAccounts,
		jobs: JobQueue,
		cursors: NativeSyncCursors,
		clock: Clock,
		metadata?: NativeMetadataStore,
	) {
		this.#database = database;
		this.#accounts = accounts;
		this.#jobs = jobs;
		this.#cursors = cursors;
		this.#clock = clock;
		this.#metadata = metadata;
	}

	#work<T>(work: (scope: WorkScope) => T): T {
		try {
			return write.call(this.#database, (scope) => {
				try {
					return work(scope);
				} catch {
					abort.call(this.#database, scope);
					return refuse();
				}
			}) as T;
		} catch {
			return refuse();
		}
	}

	#history(scope: WorkScope, ref: MetadataAccountRef) {
		const state = current.call(this.#cursors, scope, ref);
		const record = getAccount.call(this.#accounts, scope, state.ownerId, ref.accountId);
		const now = integer(this.#clock.wallMs());
		if (
			!record ||
			record.generation !== ref.generation ||
			record.account.channel !== "email" ||
			record.account.id !== ref.accountId ||
			record.account.userId !== state.ownerId ||
			record.account.pluginInstanceId !== ref.pluginInstanceId ||
			record.account.mode !== ref.mode ||
			record.account.status !== "active" ||
			record.account.createdAt > now ||
			(record.account.deletionDeadline !== null && record.account.deletionDeadline <= now)
		)
			refuse();
		const span = integer(integer(record.account.historyLimitDays, 1, 365) * DAY_MS, 1);
		return { ...state, now, since: Math.max(0, now - span), account: record.account };
	}

	#messageState(scope: WorkScope, ref: MetadataAccountRef, value: Required<ClaimSyncMessage>) {
		if (this.#metadata === undefined) refuse();
		const state = this.#history(scope, ref);
		const checkpoint = metadataCheckpoint.call(this.#metadata, scope, ref);
		if (
			checkpoint.cursor !== value.expectedCheckpoint.cursor ||
			checkpoint.revision !== value.expectedCheckpoint.revision
		)
			refuse();
		const selected = metadataMessages
			.call(this.#metadata, scope, ref, value.afterId, value.limit)
			.find((message) => message.id === value.messageId);
		if (!selected || selected.internalDate < state.since) refuse();
		// The final native reads close account/checkpoint changes caused by earlier hooks.
		const currentState = current.call(this.#cursors, scope, ref);
		const record = getAccount.call(this.#accounts, scope, state.ownerId, ref.accountId);
		if (
			currentState.ownerId !== state.ownerId ||
			currentState.checkpoint.cursor !== checkpoint.cursor ||
			currentState.checkpoint.revision !== checkpoint.revision ||
			!record ||
			record.generation !== ref.generation ||
			JSON.stringify(record.account) !== JSON.stringify(state.account)
		)
			refuse();
		return Object.freeze({ ownerId: state.ownerId, message: JSON.stringify(selected) });
	}

	#messageJob(
		scope: WorkScope,
		ref: MetadataAccountRef,
		value: Required<ClaimSyncMessage>,
		ownerId: string,
	): Job | undefined {
		const job = getJob.call(this.#jobs, scope, value.jobId);
		if (
			job &&
			(job.accountId !== ref.accountId ||
				job.ownerId !== ownerId ||
				job.kind !== "sync" ||
				job.refId !== value.messageId ||
				job.maxAttempts !== value.maxAttempts)
		)
			refuse();
		return job;
	}

	#job(scope: WorkScope, ref: SyncScanRef, scan: SyncScan): Job {
		const job = getJob.call(this.#jobs, scope, scan.jobId);
		if (
			!job ||
			job.id !== scan.jobId ||
			job.kind !== "sync" ||
			job.accountId !== ref.accountId ||
			job.ownerId !== scan.ownerId ||
			job.refId !== ref.scanId
		)
			refuse();
		return job;
	}

	#scan(scope: WorkScope, ref: SyncScanRef, expectedVersion: number): SyncScan {
		return checkScan.call(this.#cursors, scope, metadataRef(ref), ref.scanId, expectedVersion);
	}

	#lease(input: JobLease, ref: SyncScanRef, scan: SyncScan): void {
		const row = fields(fields(input, ["job"]).job, JOB_FIELDS);
		if (
			row.id !== scan.jobId ||
			row.kind !== "sync" ||
			row.accountId !== ref.accountId ||
			row.ownerId !== scan.ownerId ||
			row.refId !== ref.scanId ||
			row.state !== "RUNNING"
		)
			refuse();
		// Only the original queue method below can consume the private native lease.
	}

	enqueue(input: MetadataAccountRef, options: EnqueueSync): SyncScan {
		const ref = accountRef(input);
		const value = enqueueInput(options);
		return this.#work((scope) => {
			const state = this.#history(scope, ref);
			retireUnanchored.call(this.#cursors, scope, ref);
			const existing = activeScan.call(this.#cursors, scope, ref);
			if (existing) return existing;
			enqueueJob.call(this.#jobs, scope, {
				id: value.jobId,
				accountId: ref.accountId,
				ownerId: state.ownerId,
				kind: "sync",
				refId: value.scanId,
				maxAttempts: value.maxAttempts,
			});
			return createScan.call(this.#cursors, scope, ref, {
				scanId: value.scanId,
				jobId: value.jobId,
				requestMode: state.checkpoint.cursor === null ? "initial" : "delta",
			});
		});
	}

	/** Claim one current message from an explicit bounded native metadata page. */
	claimMessage(input: MetadataAccountRef, options: ClaimSyncMessage): JobLease | undefined {
		const ref = accountRef(input);
		const value = messageInput(options);
		if (this.#metadata === undefined) refuse();
		return this.#work((scope) => {
			const before = this.#messageState(scope, ref, value);
			if (this.#messageJob(scope, ref, value, before.ownerId) === undefined) {
				enqueueJob.call(this.#jobs, scope, {
					id: value.jobId,
					accountId: ref.accountId,
					ownerId: before.ownerId,
					kind: "sync",
					refId: value.messageId,
					maxAttempts: value.maxAttempts,
				});
				const afterEnqueue = this.#messageState(scope, ref, value);
				if (afterEnqueue.ownerId !== before.ownerId || afterEnqueue.message !== before.message)
					refuse();
			}
			this.#messageJob(scope, ref, value, before.ownerId);
			const lease = claimJob.call(this.#jobs, scope, ref.accountId, value.jobId);
			const afterClaim = this.#messageState(scope, ref, value);
			if (afterClaim.ownerId !== before.ownerId || afterClaim.message !== before.message) refuse();
			const job = this.#messageJob(scope, ref, value, before.ownerId);
			if (
				job === undefined ||
				(lease !== undefined &&
					(job.state !== "RUNNING" || JSON.stringify(job) !== JSON.stringify(lease.job)))
			)
				refuse();
			// Undefined preserves ordinary unavailability and native recovery/FAILED transitions.
			return lease;
		});
	}

	claim(input: SyncScanRef, expectedVersion: number): ClaimedSyncPage | undefined {
		const ref = scanRef(input);
		return this.#work((scope) => {
			const scan = this.#scan(scope, ref, expectedVersion);
			if (scan.status !== "active") return undefined;
			this.#job(scope, ref, scan);
			const lease = claimJob.call(this.#jobs, scope, ref.accountId, scan.jobId);
			if (lease) return Object.freeze({ scan, lease });
			const job = this.#job(scope, ref, scan);
			if (job.state === "FAILED" || job.state === "CANCELLED")
				stopScan.call(
					this.#cursors,
					scope,
					metadataRef(ref),
					ref.scanId,
					expectedVersion,
					job.state === "FAILED" ? "failed" : "cancelled",
				);
			return undefined;
		});
	}

	renew(input: SyncScanRef, expectedVersion: number, lease: JobLease): ClaimedSyncPage {
		const ref = scanRef(input);
		return this.#work((scope) => {
			const scan = this.#scan(scope, ref, expectedVersion);
			if (scan.status !== "active") refuse();
			this.#job(scope, ref, scan);
			this.#lease(lease, ref, scan);
			return Object.freeze({ scan, lease: renewJob.call(this.#jobs, scope, lease) });
		});
	}

	/** The native pass boundary is stable; the host still rechecks current account and lease state. */
	preparePage(input: SyncScanRef, expectedVersion: number, lease: JobLease): PreparedSyncPage {
		const ref = scanRef(input);
		return this.#work((scope) => {
			const version = integer(expectedVersion, 1);
			const scan = this.#scan(scope, ref, version);
			if (scan.status !== "active" || scan.ordinal >= SYNC_MAX_PAGES) refuse();
			const nativeRef = metadataRef(ref);
			const before = this.#history(scope, nativeRef);
			if (
				before.ownerId !== scan.ownerId ||
				before.checkpoint.cursor !== scan.cursor ||
				before.checkpoint.revision !== scan.revision
			)
				refuse();
			const continuation = scanContinuation.call(
				this.#cursors,
				scope,
				nativeRef,
				ref.scanId,
				version,
			);
			pageRequest(scan, continuation, before.now);
			this.#job(scope, ref, scan);
			this.#lease(lease, ref, scan);
			const replacement = renewJob.call(this.#jobs, scope, lease);
			const after = this.#scan(scope, ref, version);
			if (JSON.stringify(after) !== JSON.stringify(scan)) refuse();
			const state = this.#history(scope, nativeRef);
			const currentScan = this.#scan(scope, ref, version);
			const nextContinuation = scanContinuation.call(
				this.#cursors,
				scope,
				nativeRef,
				ref.scanId,
				version,
			);
			const record = getAccount.call(this.#accounts, scope, state.ownerId, ref.accountId);
			const job = this.#job(scope, ref, currentScan);
			if (
				JSON.stringify(currentScan) !== JSON.stringify(scan) ||
				nextContinuation !== continuation ||
				state.ownerId !== scan.ownerId ||
				state.checkpoint.cursor !== scan.cursor ||
				state.checkpoint.revision !== scan.revision ||
				JSON.stringify(state.account) !== JSON.stringify(before.account) ||
				!record ||
				record.generation !== ref.generation ||
				JSON.stringify(record.account) !== JSON.stringify(state.account) ||
				job.state !== "RUNNING" ||
				JSON.stringify(job) !== JSON.stringify(replacement.job)
			)
				refuse();
			return Object.freeze({
				scan: currentScan,
				lease: replacement,
				request: pageRequest(currentScan, nextContinuation, state.now),
			});
		});
	}

	retry(
		input: SyncScanRef,
		expectedVersion: number,
		lease: JobLease,
		retryAfterMs = 1_000,
	): SyncScan {
		const ref = scanRef(input);
		return this.#work((scope) => {
			const delay = integer(retryAfterMs, 0, JOB_MAX_RETRY_MS);
			const scan = this.#scan(scope, ref, expectedVersion);
			if (scan.status !== "active") refuse();
			this.#job(scope, ref, scan);
			this.#lease(lease, ref, scan);
			failJob.call(this.#jobs, scope, lease, delay);
			const job = this.#job(scope, ref, scan);
			if (job.state === "FAILED")
				return stopScan.call(
					this.#cursors,
					scope,
					metadataRef(ref),
					ref.scanId,
					expectedVersion,
					"failed",
				);
			if (job.state !== "PENDING") refuse();
			return this.#scan(scope, ref, expectedVersion);
		});
	}

	cancel(input: SyncScanRef, expectedVersion: number): SyncScan {
		const ref = scanRef(input);
		return this.#work((scope) => {
			const scan = this.#scan(scope, ref, expectedVersion);
			if (scan.status !== "active") return scan;
			this.#job(scope, ref, scan);
			if (!cancelJob.call(this.#jobs, scope, scan.jobId)) refuse();
			return stopScan.call(
				this.#cursors,
				scope,
				metadataRef(ref),
				ref.scanId,
				expectedVersion,
				"cancelled",
			);
		});
	}

	resync(input: SyncScanRef, expectedVersion: number, lease: JobLease, newJobId: string): SyncScan {
		const ref = scanRef(input);
		return this.#work((scope) => {
			const scan = this.#scan(scope, ref, expectedVersion);
			if (scan.status !== "active" || scan.since === null || scan.resyncCount !== 0) refuse();
			const state = this.#history(scope, metadataRef(ref));
			if (scan.since > state.now) refuse();
			const job = this.#job(scope, ref, scan);
			this.#lease(lease, ref, scan);
			const replacement = id(newJobId);
			failJob.call(this.#jobs, scope, lease, 0);
			const previous = this.#job(scope, ref, scan);
			if (previous.state === "PENDING") {
				if (!cancelJob.call(this.#jobs, scope, scan.jobId)) refuse();
			} else if (previous.state !== "FAILED") refuse();
			enqueueJob.call(this.#jobs, scope, {
				id: replacement,
				accountId: ref.accountId,
				ownerId: state.ownerId,
				kind: "sync",
				refId: ref.scanId,
				maxAttempts: job.maxAttempts,
			});
			return resyncScan.call(
				this.#cursors,
				scope,
				metadataRef(ref),
				ref.scanId,
				expectedVersion,
				replacement,
			);
		});
	}
}
