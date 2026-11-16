import { createHash } from "node:crypto";
import { Cursor } from "@draftyak/protocol/channel-v1";
import { NativeAccounts } from "../accounts/records.ts";
import { DeviceRegistry } from "../identity/devices.ts";
import { WorkDatabase, type WorkScope } from "../jobs/database.ts";
import { type Job, JobQueue } from "../jobs/queue.ts";
import { fields, id, integer } from "../jobs/values.ts";
import type { Clock } from "../kernel/clock.ts";
import type { SqlTransaction } from "../store/store.ts";
import { type MetadataAccountRef, type MetadataCheckpoint, NativeMetadataStore } from "./apply.ts";

export const SYNC_MAX_PAGES = 4096;
export interface SyncScanRef extends MetadataAccountRef {
	readonly scanId: string;
}
export interface SyncScan extends SyncScanRef {
	readonly ownerId: string;
	readonly jobId: string;
	readonly status: "active" | "waiting" | "cancelled" | "failed";
	readonly version: number;
	readonly ordinal: number;
	readonly resyncCount: 0 | 1;
	readonly requestMode: "initial" | "resync" | "delta";
	readonly since: number | null;
	readonly cursor: string | null;
	readonly revision: number;
}
export interface CreateSyncScan {
	readonly scanId: string;
	readonly jobId: string;
	readonly requestMode: "initial" | "resync" | "delta";
	/** Optional DATA restriction; it cannot widen the original native history boundary. */
	readonly since?: number;
}
export interface AdvanceSyncScan {
	readonly scanId: string;
	readonly expectedVersion: number;
	readonly jobId: string;
	readonly nextJobId: string | null;
	readonly reportedMore: boolean;
}
export class NativeSyncCursorError extends Error {
	readonly code = "SYNC_UNAVAILABLE";
	constructor() {
		super("Sync state unavailable");
		this.name = "NativeSyncCursorError";
	}
}

const sqlFor = WorkDatabase.prototype.sql;
const abort = WorkDatabase.prototype.abort;
const checkpoint = NativeMetadataStore.prototype.checkpoint;
const registryState = DeviceRegistry.prototype.state;
const getJob = JobQueue.prototype.get;
const cancelJob = JobQueue.prototype.cancel;
const getAccount = NativeAccounts.prototype.get;
const DAY_MS = 86_400_000;
const REF = ["accountId", "generation", "pluginInstanceId", "ownerEpoch", "mode"];
function refuse(): never {
	throw new NativeSyncCursorError();
}
function reference(input: MetadataAccountRef): MetadataAccountRef {
	const value = fields(input, REF);
	if (value.mode !== "full" && value.mode !== "read_only") refuse();
	return Object.freeze({
		accountId: id(value.accountId),
		generation: integer(value.generation, 1),
		pluginInstanceId: id(value.pluginInstanceId),
		ownerEpoch: integer(value.ownerEpoch),
		mode: value.mode,
	});
}
function cursor(input: unknown): string {
	if (typeof input !== "string" || input.length < 1 || input.length > 4096) refuse();
	for (let i = 0; i < input.length; i++) {
		const code = input.charCodeAt(i);
		if (code < 33 || code > 126) refuse();
	}
	if (!Cursor.safeParse(input).success) refuse();
	return input;
}
function digest(input: string): string {
	return createHash("sha256").update(input).digest("hex");
}
interface StoredScan extends SyncScan {
	readonly originCursor: string | null;
	readonly originRevision: number;
	readonly anchorVersion: 0 | 1;
	readonly anchorAt: number | null;
	readonly anchorDays: number | null;
	readonly anchorJobId: string | null;
	readonly anchorJobCreatedAt: number | null;
}
type ScanRow = Record<keyof StoredScan, unknown> & {
	readonly valid: unknown;
	readonly anchorPresent: unknown;
};
function text(column: string, name: string, max: number): string {
	return `CASE WHEN typeof(${column})='text' AND length(CAST(${column} AS BLOB)) BETWEEN 1 AND ${max} THEN ${column} END AS ${name}`;
}
function number(column: string, name: string, min = 0, max = Number.MAX_SAFE_INTEGER): string {
	return `CASE WHEN typeof(${column})='integer' AND ${column} BETWEEN ${min} AND ${max} THEN ${column} END AS ${name}`;
}
const ROW = `SELECT CASE WHEN data_class='gmail.metadata'
 AND (cursor IS NULL OR (typeof(cursor)='text' AND length(CAST(cursor AS BLOB)) BETWEEN 1 AND 4096))
 AND (origin_cursor IS NULL OR (typeof(origin_cursor)='text' AND length(CAST(origin_cursor AS BLOB)) BETWEEN 1 AND 4096))
 THEN 1 ELSE 0 END AS valid,
 CASE WHEN a.scan_id IS NULL THEN 0 ELSE 1 END AS anchorPresent,${[
		text("id", "scanId", 26),
		text("account_id", "accountId", 26),
		text("user_id", "ownerId", 26),
		number("generation", "generation", 1),
		text("plugin_instance_id", "pluginInstanceId", 26),
		number("owner_epoch", "ownerEpoch"),
		text("mode", "mode", 9),
		text("job_id", "jobId", 26),
		text("status", "status", 9),
		number("version", "version", 1),
		number("ordinal", "ordinal", 0, SYNC_MAX_PAGES),
		number("resync_count", "resyncCount", 0, 1),
		text("request_mode", "requestMode", 7),
		number("since", "since"),
		text("cursor", "cursor", 4096),
		number("revision", "revision"),
		text("origin_cursor", "originCursor", 4096),
		number("origin_revision", "originRevision"),
		number("a.anchor_version", "anchorVersion", 1, 1),
		number("a.sampled_at", "anchorAt"),
		number("a.history_days", "anchorDays", 1, 365),
		text("a.anchor_job_id", "anchorJobId", 26),
		number("a.job_created_at", "anchorJobCreatedAt"),
 ].join(",")} FROM main.sync_scans LEFT JOIN main.sync_scan_anchors a ON a.scan_id=sync_scans.id`;
function stored(raw: ScanRow): StoredScan {
	if (
		raw.valid !== 1 ||
		(raw.mode !== "full" && raw.mode !== "read_only") ||
		!["active", "waiting", "cancelled", "failed"].includes(String(raw.status)) ||
		!["initial", "resync", "delta"].includes(String(raw.requestMode))
	)
		refuse();
	const revision = integer(raw.revision);
	const originRevision = integer(raw.originRevision, 0, revision);
	const currentCursor = raw.cursor === null ? null : cursor(raw.cursor);
	const originCursor = raw.originCursor === null ? null : cursor(raw.originCursor);
	if ((currentCursor === null) !== (revision === 0)) refuse();
	if ((originCursor === null) !== (originRevision === 0)) refuse();
	if (raw.anchorPresent !== 0 && raw.anchorPresent !== 1) refuse();
	const legacy = raw.anchorPresent === 0;
	if (
		legacy &&
		![
			raw.anchorVersion,
			raw.anchorAt,
			raw.anchorDays,
			raw.anchorJobId,
			raw.anchorJobCreatedAt,
		].every((value) => value === null)
	)
		refuse();
	return Object.freeze({
		scanId: id(raw.scanId),
		accountId: id(raw.accountId),
		ownerId: id(raw.ownerId),
		generation: integer(raw.generation, 1),
		pluginInstanceId: id(raw.pluginInstanceId),
		ownerEpoch: integer(raw.ownerEpoch),
		mode: raw.mode,
		jobId: id(raw.jobId),
		status: raw.status as SyncScan["status"],
		version: integer(raw.version, 1),
		ordinal: integer(raw.ordinal, 0, SYNC_MAX_PAGES),
		resyncCount: integer(raw.resyncCount, 0, 1) as 0 | 1,
		requestMode: raw.requestMode as SyncScan["requestMode"],
		since: integer(raw.since),
		cursor: currentCursor,
		revision,
		originCursor,
		originRevision,
		anchorVersion: legacy ? 0 : (integer(raw.anchorVersion, 1, 1) as 1),
		anchorAt: legacy ? null : integer(raw.anchorAt),
		anchorDays: legacy ? null : integer(raw.anchorDays, 1, 365),
		anchorJobId: legacy ? null : id(raw.anchorJobId),
		anchorJobCreatedAt: legacy ? null : integer(raw.anchorJobCreatedAt),
	});
}
function view(row: StoredScan): Readonly<SyncScan> {
	const {
		originCursor: _originCursor,
		originRevision: _originRevision,
		anchorVersion: _anchorVersion,
		anchorAt: _anchorAt,
		anchorDays: _anchorDays,
		anchorJobId: _anchorJobId,
		anchorJobCreatedAt: _anchorJobCreatedAt,
		...value
	} = row;
	return Object.freeze(value);
}
function same(ref: MetadataAccountRef, row: StoredScan, owner: string): boolean {
	return (
		row.accountId === ref.accountId &&
		row.ownerId === owner &&
		row.generation === ref.generation &&
		row.pluginInstanceId === ref.pluginInstanceId &&
		row.ownerEpoch === ref.ownerEpoch &&
		row.mode === ref.mode
	);
}

/** Durable pagination DATA. This journal never issues source or thread-completion authority. */
export class NativeSyncCursors {
	readonly #database: WorkDatabase;
	readonly #metadata: NativeMetadataStore;
	readonly #registry: DeviceRegistry;
	readonly #jobs: JobQueue;
	readonly #accounts: NativeAccounts;
	readonly #clock: Clock;
	constructor(
		database: WorkDatabase,
		metadata: NativeMetadataStore,
		registry: DeviceRegistry,
		jobs: JobQueue,
		accounts: NativeAccounts,
		clock: Clock,
	) {
		this.#database = database;
		this.#metadata = metadata;
		this.#registry = registry;
		this.#jobs = jobs;
		this.#accounts = accounts;
		this.#clock = clock;
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
			throw new NativeSyncCursorError();
		}
	}
	#current(scope: WorkScope, sql: SqlTransaction, ref: MetadataAccountRef) {
		const current = checkpoint.call(this.#metadata, scope, ref);
		const state = registryState.call(this.#registry, sql);
		if (!state.bootstrapDone || state.ownerUserId === null || state.epoch !== ref.ownerEpoch)
			refuse();
		return Object.freeze({ ownerId: id(state.ownerUserId), checkpoint: current });
	}
	#read(sql: SqlTransaction, scanId: string): StoredScan | undefined {
		const raw = sql.get<ScanRow>(`${ROW} WHERE id=?`, [scanId]);
		return raw === undefined ? undefined : stored(raw);
	}
	#required(sql: SqlTransaction, scanId: string): StoredScan {
		return this.#read(sql, scanId) ?? refuse();
	}
	#job(scope: WorkScope, scan: StoredScan, jobId: string): Job {
		const job = getJob.call(this.#jobs, scope, jobId);
		if (
			!job ||
			job.accountId !== scan.accountId ||
			job.ownerId !== scan.ownerId ||
			job.kind !== "sync" ||
			job.refId !== scan.scanId
		)
			refuse();
		return job;
	}
	#boundary(scope: WorkScope, ref: MetadataAccountRef, owner: string) {
		const before = getAccount.call(this.#accounts, scope, owner, ref.accountId);
		const at = integer(this.#clock.wallMs());
		const after = getAccount.call(this.#accounts, scope, owner, ref.accountId);
		const current = this.#current(scope, sqlFor.call(this.#database, scope), ref);
		if (
			!before ||
			!after ||
			before.generation !== ref.generation ||
			after.generation !== ref.generation ||
			JSON.stringify(before.account) !== JSON.stringify(after.account) ||
			current.ownerId !== owner ||
			after.account.id !== ref.accountId ||
			after.account.userId !== owner ||
			after.account.channel !== "email" ||
			after.account.pluginInstanceId !== ref.pluginInstanceId ||
			after.account.mode !== ref.mode ||
			after.account.status !== "active" ||
			after.account.createdAt > at ||
			(after.account.deletionDeadline !== null && after.account.deletionDeadline <= at)
		)
			refuse();
		const days = integer(after.account.historyLimitDays, 1, 365);
		return { at, days, createdAt: after.account.createdAt, since: Math.max(0, at - days * DAY_MS) };
	}
	#anchor(scope: WorkScope, ref: MetadataAccountRef, row: StoredScan, owner: string): void {
		if (
			row.anchorVersion !== 1 ||
			row.anchorAt === null ||
			row.anchorDays === null ||
			row.anchorJobId === null ||
			row.anchorJobCreatedAt === null ||
			row.since === null
		)
			refuse();
		const current = this.#boundary(scope, ref, owner);
		if (
			row.anchorDays !== current.days ||
			row.anchorAt > current.at ||
			row.anchorAt < current.createdAt ||
			row.anchorJobCreatedAt > row.anchorAt ||
			(row.revision === row.originRevision && row.anchorJobId !== row.jobId) ||
			row.since < Math.max(0, row.anchorAt - row.anchorDays * DAY_MS) ||
			row.since > row.anchorAt
		)
			refuse();
	}
	#retireUnanchored(
		scope: WorkScope,
		sql: SqlTransaction,
		ref: MetadataAccountRef,
		owner: string,
	): boolean {
		const raw = sql.get<ScanRow>(`${ROW} WHERE account_id=? AND status='active' LIMIT 1`, [
			ref.accountId,
		]);
		if (!raw) return false;
		const row = stored(raw);
		if (row.anchorVersion !== 0) return false;
		if (row.accountId !== ref.accountId || row.ownerId !== owner) refuse();
		const job = this.#job(scope, row, row.jobId);
		if (
			(job.state === "PENDING" || job.state === "RUNNING") &&
			!cancelJob.call(this.#jobs, scope, job.id)
		)
			refuse();
		if (
			row.version === Number.MAX_SAFE_INTEGER ||
			sql.run(
				"UPDATE main.sync_scans SET status='cancelled',version=version+1 WHERE id=? AND version=? AND status='active'",
				[row.scanId, row.version],
			).changes !== 1
		)
			refuse();
		return true;
	}
	#checked(
		scope: WorkScope,
		sql: SqlTransaction,
		ref: MetadataAccountRef,
		scanId: string,
		version: number,
	): StoredScan {
		const current = this.#current(scope, sql, ref);
		const row = this.#required(sql, scanId);
		if (!same(ref, row, current.ownerId) || row.version !== version) refuse();
		if (
			row.status === "active" &&
			(row.cursor !== current.checkpoint.cursor || row.revision !== current.checkpoint.revision)
		)
			refuse();
		this.#job(scope, row, row.jobId);
		this.#anchor(scope, ref, row, current.ownerId);
		return row;
	}
	current(
		scope: WorkScope,
		input: MetadataAccountRef,
	): Readonly<{ ownerId: string; checkpoint: MetadataCheckpoint }> {
		return this.#work(scope, (sql) => this.#current(scope, sql, reference(input)));
	}
	/** Retires at most one active pre-anchor journal; checkpoints and history remain untouched. */
	retireUnanchored(scope: WorkScope, input: MetadataAccountRef): boolean {
		return this.#work(scope, (sql) => {
			const ref = reference(input);
			const current = this.#current(scope, sql, ref);
			this.#boundary(scope, ref, current.ownerId);
			return this.#retireUnanchored(scope, sql, ref, current.ownerId);
		});
	}
	create(
		scope: WorkScope,
		input: MetadataAccountRef,
		creation: CreateSyncScan,
	): Readonly<SyncScan> {
		return this.#work(scope, (sql) => {
			const ref = reference(input);
			const value = fields(creation, ["scanId", "jobId", "requestMode"], ["since"]);
			const scanId = id(value.scanId),
				jobId = id(value.jobId);
			const requestedSince = Object.hasOwn(value, "since") ? integer(value.since) : 0;
			const current = this.#current(scope, sql, ref);
			const boundary = this.#boundary(scope, ref, current.ownerId);
			const since = Math.max(boundary.since, requestedSince);
			if (since > boundary.at) refuse();
			this.#retireUnanchored(scope, sql, ref, current.ownerId);
			const mode = current.checkpoint.cursor === null ? "initial" : "delta";
			if (value.requestMode !== mode) refuse();
			const active = sql.get<{ id: string }>(
				"SELECT CASE WHEN length(CAST(id AS BLOB))=26 THEN id END AS id FROM main.sync_scans WHERE account_id=? AND status='active' LIMIT 1",
				[ref.accountId],
			);
			if (active) {
				const prior = this.#required(sql, id(active.id));
				if (same(ref, prior, current.ownerId)) refuse();
				const job = this.#job(scope, prior, prior.jobId);
				if (
					(job.state === "PENDING" || job.state === "RUNNING") &&
					!cancelJob.call(this.#jobs, scope, job.id)
				)
					refuse();
				if (
					prior.version === Number.MAX_SAFE_INTEGER ||
					sql.run(
						"UPDATE main.sync_scans SET status='cancelled',version=version+1 WHERE id=? AND version=? AND status='active'",
						[prior.scanId, prior.version],
					).changes !== 1
				)
					refuse();
			}
			const job = getJob.call(this.#jobs, scope, jobId);
			if (
				!job ||
				job.state !== "PENDING" ||
				job.accountId !== ref.accountId ||
				job.ownerId !== current.ownerId ||
				job.kind !== "sync" ||
				job.refId !== scanId ||
				job.createdAt > boundary.at
			)
				refuse();
			sql.run(
				`INSERT INTO main.sync_scans(id,account_id,user_id,generation,plugin_instance_id,owner_epoch,mode,job_id,status,version,ordinal,resync_count,request_mode,since,cursor,revision,origin_cursor,origin_revision)
 VALUES(?,?,?,?,?,?,?,?,'active',1,0,0,?,?,?,?,?,?)`,
				[
					scanId,
					ref.accountId,
					current.ownerId,
					ref.generation,
					ref.pluginInstanceId,
					ref.ownerEpoch,
					ref.mode,
					jobId,
					mode,
					since,
					current.checkpoint.cursor,
					current.checkpoint.revision,
					current.checkpoint.cursor,
					current.checkpoint.revision,
				],
			);
			sql.run(
				"INSERT INTO main.sync_scan_anchors(scan_id,anchor_version,sampled_at,history_days,anchor_job_id,job_created_at) VALUES(?,1,?,?,?,?)",
				[scanId, boundary.at, boundary.days, jobId, job.createdAt],
			);
			return view(this.#required(sql, scanId));
		});
	}
	get(scope: WorkScope, input: MetadataAccountRef, scanId: string): Readonly<SyncScan> | undefined {
		return this.#work(scope, (sql) => {
			const ref = reference(input),
				current = this.#current(scope, sql, ref);
			const row = this.#read(sql, id(scanId));
			if (!row) return undefined;
			if (!same(ref, row, current.ownerId)) refuse();
			return view(row);
		});
	}
	active(scope: WorkScope, input: MetadataAccountRef): Readonly<SyncScan> | undefined {
		return this.#work(scope, (sql) => {
			const ref = reference(input),
				current = this.#current(scope, sql, ref);
			const raw = sql.get<ScanRow>(
				`${ROW} WHERE account_id=? AND generation=? AND user_id=? AND plugin_instance_id=? AND mode=? AND owner_epoch=? AND status='active' LIMIT 1`,
				[
					ref.accountId,
					ref.generation,
					current.ownerId,
					ref.pluginInstanceId,
					ref.mode,
					ref.ownerEpoch,
				],
			);
			if (!raw) return undefined;
			const row = stored(raw);
			if (
				!same(ref, row, current.ownerId) ||
				row.status !== "active" ||
				row.cursor !== current.checkpoint.cursor ||
				row.revision !== current.checkpoint.revision
			)
				refuse();
			this.#job(scope, row, row.jobId);
			this.#anchor(scope, ref, row, current.ownerId);
			return view(row);
		});
	}
	list(
		scope: WorkScope,
		input: MetadataAccountRef,
		afterId: string | null = null,
		limit = 100,
	): readonly Readonly<SyncScan>[] {
		return this.#work(scope, (sql) => {
			const ref = reference(input),
				current = this.#current(scope, sql, ref);
			const after = afterId === null ? "" : id(afterId);
			const rows = sql.all<ScanRow>(
				`${ROW} WHERE account_id=? AND generation=? AND id>? ORDER BY id LIMIT ?`,
				[ref.accountId, ref.generation, after, integer(limit, 1, 100)],
			);
			return Object.freeze(
				rows.map((raw) => {
					const row = stored(raw);
					if (!same(ref, row, current.ownerId)) refuse();
					return view(row);
				}),
			);
		});
	}
	check(
		scope: WorkScope,
		input: MetadataAccountRef,
		scanId: string,
		expectedVersion: number,
	): Readonly<SyncScan> {
		return this.#work(scope, (sql) =>
			view(this.#checked(scope, sql, reference(input), id(scanId), integer(expectedVersion, 1))),
		);
	}
	/** Opaque request continuation DATA, distinct from the checkpoint held for apply CAS. */
	continuation(
		scope: WorkScope,
		input: MetadataAccountRef,
		scanId: string,
		expectedVersion: number,
	): string | null {
		return this.#work(scope, (sql) => {
			const ref = reference(input);
			const row = this.#checked(scope, sql, ref, id(scanId), integer(expectedVersion, 1));
			if (row.status !== "active" || row.ordinal >= SYNC_MAX_PAGES) refuse();
			if (row.requestMode === "delta" || row.revision > row.originRevision)
				return row.cursor ?? refuse();
			return null;
		});
	}
	advanceApplied(
		scope: WorkScope,
		input: MetadataAccountRef,
		advance: AdvanceSyncScan,
	): Readonly<SyncScan> {
		return this.#work(scope, (sql) => {
			const ref = reference(input);
			const value = fields(advance, [
				"scanId",
				"expectedVersion",
				"jobId",
				"nextJobId",
				"reportedMore",
			]);
			const row = this.#required(sql, id(value.scanId));
			const current = this.#current(scope, sql, ref);
			this.#anchor(scope, ref, row, current.ownerId);
			if (
				!same(ref, row, current.ownerId) ||
				row.status !== "active" ||
				row.version !== integer(value.expectedVersion, 1) ||
				row.version === Number.MAX_SAFE_INTEGER ||
				row.ordinal >= SYNC_MAX_PAGES ||
				row.revision === Number.MAX_SAFE_INTEGER ||
				row.jobId !== id(value.jobId) ||
				typeof value.reportedMore !== "boolean"
			)
				refuse();
			const job = this.#job(scope, row, row.jobId);
			if (job.state !== "SUCCEEDED") refuse();
			const page = sql.get<{
				valid: number;
				cursor: string;
				revision: number;
				more: number;
				resync: number;
				digest: string;
				previousCursor: string | null;
				previousRevision: number;
			}>(
				`SELECT CASE WHEN p.previous_cursor IS NULL OR (typeof(p.previous_cursor)='text'
 AND length(CAST(p.previous_cursor AS BLOB)) BETWEEN 1 AND 4096) THEN 1 ELSE 0 END AS valid,
 ${text("c.cursor", "cursor", 4096)},${number("c.revision", "revision", 1)},
 ${number("p.reported_more", "more", 0, 1)},${number("p.resync_count", "resync", 0, 1)},
 ${text("p.continuation_digest", "digest", 64)},${text("p.previous_cursor", "previousCursor", 4096)},${number("p.previous_revision", "previousRevision")}
 FROM main.sync_scan_pages p JOIN main.content_pages c ON c.account_id=p.account_id AND c.generation=p.generation AND c.job_id=p.job_id
 WHERE p.scan_id=? AND p.ordinal=? AND p.account_id=? AND p.generation=? AND p.job_id=?`,
				[row.scanId, row.ordinal, row.accountId, row.generation, row.jobId],
			);
			if (!page || page.valid !== 1) refuse();
			const nextCursor = cursor(page.cursor);
			if (
				page.revision !== row.revision + 1 ||
				current.checkpoint.cursor !== nextCursor ||
				current.checkpoint.revision !== page.revision ||
				page.previousCursor !== row.cursor ||
				page.previousRevision !== row.revision ||
				page.resync !== row.resyncCount ||
				page.more !== (value.reportedMore ? 1 : 0) ||
				page.digest !== digest(nextCursor)
			)
				refuse();
			const observationCount = sql.get<{ count: number }>(
				"SELECT count(*) AS count FROM main.sync_page_observations WHERE scan_id=? AND page_ordinal=? AND account_id=? AND generation=?",
				[row.scanId, row.ordinal, row.accountId, row.generation],
			)?.count;
			integer(observationCount, 0, 500);
			const stationary =
				row.ordinal === 0 &&
				row.requestMode === "delta" &&
				observationCount === 0 &&
				!value.reportedMore &&
				nextCursor === row.cursor;
			if (!stationary && (nextCursor === row.cursor || nextCursor === row.originCursor)) refuse();
			if (
				sql.get(
					"SELECT 1 FROM main.sync_scan_pages WHERE scan_id=? AND resync_count=? AND continuation_digest=? AND ordinal<>? LIMIT 1",
					[row.scanId, row.resyncCount, page.digest, row.ordinal],
				)
			)
				refuse();
			const nextJobId = value.nextJobId === null ? null : id(value.nextJobId);
			if (value.reportedMore) {
				if (nextJobId === null || nextJobId === row.jobId || row.ordinal + 1 >= SYNC_MAX_PAGES)
					refuse();
				if (this.#job(scope, row, nextJobId).state !== "PENDING") refuse();
			} else if (nextJobId !== null) refuse();
			if (
				sql.run(
					"UPDATE main.sync_scans SET job_id=?,status=?,version=version+1,ordinal=ordinal+1,cursor=?,revision=? WHERE id=? AND version=? AND status='active'",
					[
						nextJobId ?? row.jobId,
						value.reportedMore ? "active" : "waiting",
						nextCursor,
						page.revision,
						row.scanId,
						row.version,
					],
				).changes !== 1
			)
				refuse();
			return view(this.#required(sql, row.scanId));
		});
	}
	stop(
		scope: WorkScope,
		input: MetadataAccountRef,
		scanId: string,
		expectedVersion: number,
		status: "cancelled" | "failed",
	): Readonly<SyncScan> {
		return this.#work(scope, (sql) => {
			if (status !== "cancelled" && status !== "failed") refuse();
			const row = this.#checked(
				scope,
				sql,
				reference(input),
				id(scanId),
				integer(expectedVersion, 1),
			);
			if (
				row.status !== "active" ||
				row.version === Number.MAX_SAFE_INTEGER ||
				this.#job(scope, row, row.jobId).state !== (status === "cancelled" ? "CANCELLED" : "FAILED")
			)
				refuse();
			if (
				sql.run(
					"UPDATE main.sync_scans SET status=?,version=version+1 WHERE id=? AND version=? AND status='active'",
					[status, row.scanId, row.version],
				).changes !== 1
			)
				refuse();
			return view(this.#required(sql, row.scanId));
		});
	}
	resync(
		scope: WorkScope,
		input: MetadataAccountRef,
		scanId: string,
		expectedVersion: number,
		newJobId: string,
		since?: number,
	): Readonly<SyncScan> {
		return this.#work(scope, (sql) => {
			const ref = reference(input);
			const row = this.#checked(scope, sql, ref, id(scanId), integer(expectedVersion, 1));
			const requestedSince = since === undefined ? row.since : integer(since);
			const boundary = this.#boundary(scope, ref, row.ownerId);
			const floor = Math.max(requestedSince ?? 0, boundary.since),
				nextId = id(newJobId);
			if (
				row.status !== "active" ||
				row.version === Number.MAX_SAFE_INTEGER ||
				row.resyncCount !== 0 ||
				row.since === null ||
				requestedSince === null ||
				requestedSince < row.since ||
				(row.anchorAt !== null && boundary.at < row.anchorAt) ||
				floor > boundary.at ||
				row.ordinal >= SYNC_MAX_PAGES ||
				nextId === row.jobId
			)
				refuse();
			const prior = this.#job(scope, row, row.jobId);
			if (
				(prior.state !== "CANCELLED" && prior.state !== "FAILED") ||
				this.#job(scope, row, nextId).state !== "PENDING"
			)
				refuse();
			if (this.#job(scope, row, nextId).createdAt > boundary.at) refuse();
			if (
				sql.run(
					"UPDATE main.sync_scans SET job_id=?,request_mode='resync',since=?,resync_count=1,version=version+1,origin_cursor=cursor,origin_revision=revision WHERE id=? AND version=? AND status='active' AND resync_count=0",
					[nextId, floor, row.scanId, row.version],
				).changes !== 1
			)
				refuse();
			if (
				sql.run(
					"UPDATE main.sync_scan_anchors SET sampled_at=?,history_days=?,anchor_job_id=?,job_created_at=? WHERE scan_id=? AND anchor_version=1",
					[boundary.at, boundary.days, nextId, this.#job(scope, row, nextId).createdAt, row.scanId],
				).changes !== 1
			)
				refuse();
			return view(this.#required(sql, row.scanId));
		});
	}
}
