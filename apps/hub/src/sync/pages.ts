import { createHash } from "node:crypto";
import { types } from "node:util";
import { Cursor, SyncPage } from "@draftyak/protocol/channel-v1";
import { MAX_CHANGES, ProviderId } from "@draftyak/protocol/normalized-change";
import { WorkDatabase, type WorkScope } from "../jobs/database.ts";
import { type JobLease, JobQueue } from "../jobs/queue.ts";
import { fields, id, integer } from "../jobs/values.ts";
import { newId } from "../kernel/ids.ts";
import type { SqlTransaction } from "../store/store.ts";
import {
	MAX_APPLY_BYTES,
	type MetadataAccountRef,
	NativeMetadataStore,
	NativeSyncError,
} from "./apply.ts";
import { NativeSyncCursors, type SyncScan, type SyncScanRef } from "./cursors.ts";

const sqlFor = WorkDatabase.prototype.sql;
const abort = WorkDatabase.prototype.abort;
const applyMetadata = NativeMetadataStore.prototype.applyPage;
const checkScan = NativeSyncCursors.prototype.check;
const advanceScan = NativeSyncCursors.prototype.advanceApplied;
const enqueueJob = JobQueue.prototype.enqueue;
const getJob = JobQueue.prototype.get;
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

type EmailChange = Extract<
	SyncPage["changes"][number],
	{ readonly kind: "email.message" | "email.labels" | "email.deleted" }
>;

export interface SyncObservationPosition {
	readonly pageOrdinal: number;
	readonly changeIndex: number;
}

export interface SyncPageObservation extends SyncObservationPosition {
	readonly scanId: string;
	readonly pageJobId: string;
	readonly cursor: string;
	readonly revision: number;
	readonly kind: EmailChange["kind"];
	readonly providerId: string;
	readonly threadId: string | null;
	readonly messageId: string | null;
}

export interface RecordedSyncPage {
	readonly scan: Readonly<SyncScan>;
	readonly pageJobId: string;
	readonly pageOrdinal: number;
	readonly cursor: string;
	readonly revision: number;
	readonly observationCount: number;
}

function refuse(): never {
	throw new NativeSyncError();
}

/** Copy untrusted page DATA before a schema or caller can read its properties. */
function snapshot(input: unknown): unknown {
	let bytes = 0;
	let nodes = 0;
	const active = new Set<object>();
	const text = (value: string): string => {
		if (!value.isWellFormed()) refuse();
		bytes += Buffer.byteLength(value);
		if (bytes > MAX_APPLY_BYTES) refuse();
		return value;
	};
	const visit = (value: unknown, depth: number): unknown => {
		if (++nodes > 150_000 || depth > 10) refuse();
		if (value === null || value === undefined || typeof value === "boolean") return value;
		if (typeof value === "string") return text(value);
		if (typeof value === "number") {
			if (!Number.isSafeInteger(value)) refuse();
			return value;
		}
		if (typeof value !== "object" || types.isProxy(value) || active.has(value)) refuse();
		active.add(value);
		try {
			if (Array.isArray(value)) {
				if (Object.getPrototypeOf(value) !== Array.prototype) refuse();
				const length = Object.getOwnPropertyDescriptor(value, "length")?.value;
				if (!Number.isSafeInteger(length) || length < 0 || length > MAX_CHANGES) refuse();
				if (Reflect.ownKeys(value).length !== length + 1) refuse();
				return Array.from({ length }, (_, index) => {
					const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
					if (!descriptor || !("value" in descriptor) || !descriptor.enumerable) refuse();
					return visit(descriptor.value, depth + 1);
				});
			}
			if (![null, Object.prototype].includes(Object.getPrototypeOf(value))) refuse();
			const copy: Record<string, unknown> = Object.create(null);
			for (const key of Reflect.ownKeys(value)) {
				if (typeof key !== "string") refuse();
				text(key);
				const descriptor = Object.getOwnPropertyDescriptor(value, key);
				if (!descriptor || !("value" in descriptor) || !descriptor.enumerable) refuse();
				copy[key] = visit(descriptor.value, depth + 1);
			}
			return copy;
		} finally {
			active.delete(value);
		}
	};
	const copy = visit(input, 0);
	const json = JSON.stringify(copy);
	if (typeof json !== "string" || Buffer.byteLength(json) > MAX_APPLY_BYTES) refuse();
	return copy;
}

function frozen<T>(value: T): T {
	if (value !== null && typeof value === "object") {
		for (const item of Object.values(value)) frozen(item);
		Object.freeze(value);
	}
	return value;
}

/** A checked page remains plugin DATA; neither its cursor nor more proves a complete thread. */
export function checkedSyncPage(input: unknown): SyncPage {
	try {
		return frozen(SyncPage.parse(snapshot(input)));
	} catch {
		throw new NativeSyncError();
	}
}

function reference(input: SyncScanRef): { ref: MetadataAccountRef; scanId: string } {
	const value = fields(input, [
		"accountId",
		"generation",
		"pluginInstanceId",
		"ownerEpoch",
		"mode",
		"scanId",
	]);
	if (value.mode !== "full" && value.mode !== "read_only") refuse();
	return {
		ref: Object.freeze({
			accountId: id(value.accountId),
			generation: integer(value.generation, 1),
			pluginInstanceId: id(value.pluginInstanceId),
			ownerEpoch: integer(value.ownerEpoch),
			mode: value.mode,
		}),
		scanId: id(value.scanId),
	};
}

function emailChange(change: SyncPage["changes"][number]): EmailChange {
	if (
		change.kind !== "email.message" &&
		change.kind !== "email.labels" &&
		change.kind !== "email.deleted"
	)
		refuse();
	return change;
}

function providerId(value: unknown): string {
	if (typeof value !== "string" || !ProviderId.safeParse(value).success) refuse();
	return value;
}

interface MessageIdentity {
	readonly messageId: string;
	readonly threadId: string;
}

interface ObservationRow {
	readonly valid: number;
	readonly pageOrdinal: number;
	readonly changeIndex: number;
	readonly pageJobId: string;
	readonly cursor: string;
	readonly revision: number;
	readonly kind: string;
	readonly providerId: string;
	readonly threadId: string | null;
	readonly messageId: string | null;
}

/** Durable plugin observations only; native source and complete-thread evidence are separate. */
export class NativeSyncPages {
	readonly #database: WorkDatabase;
	readonly #metadata: NativeMetadataStore;
	readonly #cursors: NativeSyncCursors;
	readonly #jobs: JobQueue;
	constructor(
		database: WorkDatabase,
		metadata: NativeMetadataStore,
		cursors: NativeSyncCursors,
		jobs: JobQueue,
	) {
		this.#database = database;
		this.#metadata = metadata;
		this.#cursors = cursors;
		this.#jobs = jobs;
	}
	#work<T>(scope: WorkScope, work: (sql: SqlTransaction) => T): T {
		try {
			return work(sqlFor.call(this.#database, scope));
		} catch {
			try {
				abort.call(this.#database, scope);
			} catch {
				/* Foreign and retired scopes remain refused. */
			}
			throw new NativeSyncError();
		}
	}
	#message(
		sql: SqlTransaction,
		ref: MetadataAccountRef,
		ownerId: string,
		provider: string,
	): MessageIdentity | undefined {
		const row = sql.get<{ messageId: string; threadId: string }>(
			`SELECT CASE WHEN length(CAST(m.id AS BLOB))=26 THEN m.id END AS messageId,
 CASE WHEN typeof(c.provider_id)='text' AND length(CAST(c.provider_id AS BLOB)) BETWEEN 1 AND 256 THEN c.provider_id END AS threadId
 FROM main.content_messages m LEFT JOIN main.content_conversations c
 ON c.id=m.conversation_id AND c.account_id=m.account_id AND c.generation=m.generation AND c.user_id=m.user_id
 WHERE m.user_id=? AND m.account_id=? AND m.generation=? AND m.provider_id=?`,
			[ownerId, ref.accountId, ref.generation, provider],
		);
		return row
			? Object.freeze({ messageId: id(row.messageId), threadId: providerId(row.threadId) })
			: undefined;
	}
	record(
		scope: WorkScope,
		lease: JobLease,
		input: SyncScanRef,
		expectedVersion: number,
		untrustedPage: unknown,
	): RecordedSyncPage {
		return this.#work(scope, (sql) => {
			const page = checkedSyncPage(untrustedPage);
			const { ref, scanId } = reference(input);
			const scan = checkScan.call(this.#cursors, scope, ref, scanId, integer(expectedVersion, 1));
			const job = fields(fields(lease, ["job"]).job, JOB_FIELDS);
			if (
				scan.status !== "active" ||
				scan.ordinal >= 4096 ||
				job.id !== scan.jobId ||
				job.refId !== scan.scanId ||
				job.kind !== "sync" ||
				job.state !== "RUNNING" ||
				job.accountId !== ref.accountId ||
				job.ownerId !== scan.ownerId
			)
				refuse();
			const changes = page.changes.map(emailChange);
			const before = new Map<string, MessageIdentity | undefined>();
			const firstDeletion = new Map<string, number>();
			const lastDeletion = new Map<string, number>();
			for (const [index, change] of changes.entries()) {
				if (!before.has(change.providerId))
					before.set(change.providerId, this.#message(sql, ref, scan.ownerId, change.providerId));
				if (change.kind === "email.deleted") {
					if (!firstDeletion.has(change.providerId)) firstDeletion.set(change.providerId, index);
					lastDeletion.set(change.providerId, index);
				}
			}
			const applied = applyMetadata.call(this.#metadata, scope, lease, {
				...ref,
				expectedCursor: scan.cursor,
				expectedRevision: scan.revision,
				cursor: page.cursor,
				changes,
			});
			if (applied.cursor === null) refuse();
			sql.run(
				`INSERT INTO main.sync_scan_pages
 (scan_id,ordinal,account_id,generation,job_id,previous_cursor,previous_revision,reported_more,resync_count,continuation_digest)
 VALUES(?,?,?,?,?,?,?,?,?,?)`,
				[
					scan.scanId,
					scan.ordinal,
					ref.accountId,
					ref.generation,
					scan.jobId,
					scan.cursor,
					scan.revision,
					page.more ? 1 : 0,
					scan.resyncCount,
					createHash("sha256").update(applied.cursor).digest("hex"),
				],
			);
			for (const [index, change] of changes.entries()) {
				const first = firstDeletion.get(change.providerId);
				const last = lastDeletion.get(change.providerId);
				let identity: MessageIdentity | undefined;
				if (first === undefined) {
					identity = this.#message(sql, ref, scan.ownerId, change.providerId);
				} else if (index <= first) {
					identity = before.get(change.providerId);
				} else if (last !== undefined && index > last) {
					identity = this.#message(sql, ref, scan.ownerId, change.providerId);
				}
				const threadId = change.kind === "email.deleted" ? null : change.threadId;
				const messageId =
					identity && (threadId === null || identity.threadId === threadId)
						? identity.messageId
						: null;
				sql.run(
					`INSERT INTO main.sync_page_observations
 (scan_id,page_ordinal,change_index,account_id,generation,kind,provider_id,thread_id,message_id)
 VALUES(?,?,?,?,?,?,?,?,?)`,
					[
						scan.scanId,
						scan.ordinal,
						index,
						ref.accountId,
						ref.generation,
						change.kind,
						change.providerId,
						threadId,
						messageId,
					],
				);
			}
			const nextJobId = page.more ? newId() : null;
			if (nextJobId !== null) {
				const completed = getJob.call(this.#jobs, scope, scan.jobId);
				if (
					!completed ||
					completed.state !== "SUCCEEDED" ||
					completed.kind !== "sync" ||
					completed.accountId !== ref.accountId ||
					completed.ownerId !== scan.ownerId ||
					completed.refId !== scan.scanId
				)
					refuse();
				enqueueJob.call(this.#jobs, scope, {
					id: nextJobId,
					accountId: ref.accountId,
					ownerId: scan.ownerId,
					kind: "sync",
					refId: scan.scanId,
					maxAttempts: completed.maxAttempts,
				});
			}
			const next = advanceScan.call(this.#cursors, scope, ref, {
				scanId: scan.scanId,
				expectedVersion: scan.version,
				jobId: scan.jobId,
				nextJobId,
				reportedMore: page.more,
			});
			return Object.freeze({
				scan: next,
				pageJobId: scan.jobId,
				pageOrdinal: scan.ordinal,
				cursor: applied.cursor,
				revision: applied.revision,
				observationCount: changes.length,
			});
		});
	}
	observations(
		scope: WorkScope,
		input: SyncScanRef,
		expectedVersion: number,
		after: SyncObservationPosition | null = null,
		limit: number = 100,
	): readonly SyncPageObservation[] {
		return this.#work(scope, (sql) => {
			const { ref, scanId } = reference(input);
			const position = after === null ? null : fields(after, ["pageOrdinal", "changeIndex"]);
			const ordinal = position ? integer(position.pageOrdinal, 0, 4095) : -1;
			const index = position ? integer(position.changeIndex, 0, MAX_CHANGES - 1) : -1;
			const count = integer(limit, 1, 100);
			const version = integer(expectedVersion, 1);
			checkScan.call(this.#cursors, scope, ref, scanId, version);
			const rows = sql.all<ObservationRow>(
				`SELECT
 CASE WHEN typeof(o.page_ordinal)='integer' AND o.page_ordinal BETWEEN 0 AND 4095
 AND typeof(o.change_index)='integer' AND o.change_index BETWEEN 0 AND 499
 AND o.kind IN ('email.message','email.labels','email.deleted')
 AND typeof(o.provider_id)='text' AND length(CAST(o.provider_id AS BLOB)) BETWEEN 1 AND 256
 AND (o.thread_id IS NULL OR (typeof(o.thread_id)='text' AND length(CAST(o.thread_id AS BLOB)) BETWEEN 1 AND 256))
 AND (o.message_id IS NULL OR (typeof(o.message_id)='text' AND length(CAST(o.message_id AS BLOB))=26))
 THEN 1 ELSE 0 END AS valid,
 CASE WHEN typeof(o.page_ordinal)='integer' AND o.page_ordinal BETWEEN 0 AND 4095 THEN o.page_ordinal END AS pageOrdinal,
 CASE WHEN typeof(o.change_index)='integer' AND o.change_index BETWEEN 0 AND 499 THEN o.change_index END AS changeIndex,
 CASE WHEN length(CAST(p.job_id AS BLOB))=26 THEN p.job_id END AS pageJobId,
 CASE WHEN typeof(c.cursor)='text' AND length(CAST(c.cursor AS BLOB)) BETWEEN 1 AND 4096 THEN c.cursor END AS cursor,
 CASE WHEN typeof(c.revision)='integer' AND c.revision BETWEEN 1 AND 9007199254740991 THEN c.revision END AS revision,
 CASE WHEN o.kind IN ('email.message','email.labels','email.deleted') THEN o.kind END AS kind,
 CASE WHEN typeof(o.provider_id)='text' AND length(CAST(o.provider_id AS BLOB)) BETWEEN 1 AND 256 THEN o.provider_id END AS providerId,
 CASE WHEN o.thread_id IS NULL OR (typeof(o.thread_id)='text' AND length(CAST(o.thread_id AS BLOB)) BETWEEN 1 AND 256) THEN o.thread_id END AS threadId,
 CASE WHEN o.message_id IS NULL OR length(CAST(o.message_id AS BLOB))=26 THEN o.message_id END AS messageId
 FROM main.sync_page_observations o
 JOIN main.sync_scan_pages p ON p.scan_id=o.scan_id AND p.ordinal=o.page_ordinal AND p.account_id=o.account_id AND p.generation=o.generation
 JOIN main.content_pages c ON c.account_id=p.account_id AND c.generation=p.generation AND c.job_id=p.job_id
 WHERE o.scan_id=? AND o.account_id=? AND o.generation=?
 AND (o.page_ordinal>? OR (o.page_ordinal=? AND o.change_index>?))
 ORDER BY o.page_ordinal,o.change_index LIMIT ?`,
				[scanId, ref.accountId, ref.generation, ordinal, ordinal, index, count],
			);
			return Object.freeze(
				rows.map((row): SyncPageObservation => {
					if (
						row.valid !== 1 ||
						(row.kind !== "email.message" &&
							row.kind !== "email.labels" &&
							row.kind !== "email.deleted") ||
						(row.kind === "email.deleted" ? row.threadId !== null : row.threadId === null) ||
						!Cursor.safeParse(row.cursor).success
					)
						refuse();
					return Object.freeze({
						scanId,
						pageOrdinal: integer(row.pageOrdinal, 0, 4095),
						changeIndex: integer(row.changeIndex, 0, MAX_CHANGES - 1),
						pageJobId: id(row.pageJobId),
						cursor: row.cursor,
						revision: integer(row.revision, 1),
						kind: row.kind,
						providerId: providerId(row.providerId),
						threadId: row.threadId === null ? null : providerId(row.threadId),
						messageId: row.messageId === null ? null : id(row.messageId),
					});
				}),
			);
		});
	}
}
