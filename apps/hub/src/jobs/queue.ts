import { randomBytes } from "node:crypto";
import { fileURLToPath } from "node:url";
import { EventLog } from "../events/log.ts";
import type { SqlTransaction } from "../store/store.ts";
import type { WorkDatabase, WorkScope } from "./database.ts";
import { fields, id, integer, WorkError } from "./values.ts";

export const JOB_MIGRATIONS: string = fileURLToPath(new URL("./jobs-migrations/", import.meta.url));
export const JOB_LEASE_MS = 30_000;
export const JOB_MAX_ATTEMPTS = 20;
export const JOB_MAX_RETRY_MS = 86_400_000;
export const JOB_RECOVERY_BATCH = 100;
export const JOB_MAX_HANDLES = 256;
export type JobKind = "sync" | "draft" | "retention" | "reconcile";
export type JobState = "PENDING" | "RUNNING" | "SUCCEEDED" | "FAILED" | "CANCELLED";
export interface JobInput {
	readonly id: string;
	readonly accountId: string;
	readonly ownerId: string;
	readonly kind: JobKind;
	readonly refId: string;
	readonly maxAttempts?: number;
}
export interface Job {
	readonly id: string;
	readonly accountId: string;
	readonly ownerId: string;
	readonly kind: JobKind;
	readonly refId: string;
	readonly state: JobState;
	readonly attempts: number;
	readonly maxAttempts: number;
	readonly createdAt: number;
	readonly nextAt: number;
	readonly leaseUntil: number | null;
}
export interface JobLease {
	readonly job: Job;
}
export interface JobClock {
	readonly wallNow: () => number;
	readonly monotonicNow: () => number;
}
interface Row extends Job {
	readonly token: string | null;
	readonly valid: number;
}
interface LeaseState {
	readonly queue: JobQueue;
	readonly job: Job;
	readonly token: string;
	readonly monotonicUntil: number;
	active: boolean;
}
const leases = new WeakMap<object, LeaseState>();
const appendEvent = EventLog.prototype.append;
const KINDS = new Set<string>(["sync", "draft", "retention", "reconcile"]);
const STATES = new Set<string>(["PENDING", "RUNNING", "SUCCEEDED", "FAILED", "CANCELLED"]);
const TOKEN = /^[0-9a-f]{64}$/;

// Bound values in native SQLite before a corrupt oversized TEXT/BLOB can reach JavaScript.
const ROW = `SELECT
 CASE WHEN (state='RUNNING' AND typeof(lease_until)='integer' AND lease_until BETWEEN 0 AND 9007199254740991 AND typeof(token)='text' AND length(CAST(token AS BLOB))=64)
  OR (state!='RUNNING' AND lease_until IS NULL AND token IS NULL) THEN 1 ELSE 0 END AS valid,
 CASE WHEN typeof(id)='text' AND length(CAST(id AS BLOB))=26 THEN id END AS id,
 CASE WHEN typeof(account_id)='text' AND length(CAST(account_id AS BLOB))=26 THEN account_id END AS accountId,
 CASE WHEN typeof(owner_id)='text' AND length(CAST(owner_id AS BLOB))=26 THEN owner_id END AS ownerId,
 CASE WHEN typeof(ref_id)='text' AND length(CAST(ref_id AS BLOB))=26 THEN ref_id END AS refId,
 CASE WHEN typeof(kind)='text' AND length(CAST(kind AS BLOB))<=9 THEN kind END AS kind,
 CASE WHEN typeof(state)='text' AND length(CAST(state AS BLOB))<=9 THEN state END AS state,
 CASE WHEN typeof(attempts)='integer' AND attempts BETWEEN 0 AND 20 THEN attempts END AS attempts,
 CASE WHEN typeof(max_attempts)='integer' AND max_attempts BETWEEN 1 AND 20 THEN max_attempts END AS maxAttempts,
 CASE WHEN typeof(created_at)='integer' AND created_at BETWEEN 0 AND 9007199254740991 THEN created_at END AS createdAt,
 CASE WHEN typeof(next_at)='integer' AND next_at BETWEEN 0 AND 9007199254740991 THEN next_at END AS nextAt,
 CASE WHEN typeof(lease_until)='integer' AND lease_until BETWEEN 0 AND 9007199254740991 THEN lease_until END AS leaseUntil,
 CASE WHEN typeof(token)='text' AND length(CAST(token AS BLOB))=64 THEN token END AS token
 FROM main.jobs`;

function row(raw: Row): Row {
	try {
		if (raw.valid !== 1) throw new WorkError("data");
		id(raw.id);
		id(raw.accountId);
		id(raw.ownerId);
		id(raw.refId);
		if (!KINDS.has(raw.kind) || !STATES.has(raw.state)) throw new WorkError("data");
		integer(raw.maxAttempts, 1, JOB_MAX_ATTEMPTS);
		integer(raw.attempts, 0, raw.maxAttempts);
		integer(raw.createdAt);
		integer(raw.nextAt);
		if (raw.state === "RUNNING") {
			integer(raw.attempts, 1, raw.maxAttempts);
			integer(raw.leaseUntil);
			if (typeof raw.token !== "string" || raw.token.length !== 64 || !TOKEN.test(raw.token))
				throw new WorkError("data");
		} else if (raw.leaseUntil !== null || raw.token !== null) throw new WorkError("data");
		return raw;
	} catch {
		throw new WorkError("data");
	}
}
function snapshot(raw: Row): Job {
	const { token: _token, valid: _valid, ...job } = row(raw);
	return Object.freeze(job);
}
function read(sql: SqlTransaction, jobId: string): Row | undefined {
	const value = sql.get<Row>(`${ROW} WHERE id=?`, [jobId]);
	return value === undefined ? undefined : row(value);
}

/** Native metadata queue. These IDs do not authorize an account operation or a send. */
export class JobQueue {
	readonly #database: WorkDatabase;
	readonly #events: EventLog;
	readonly #wallNow: () => number;
	readonly #monotonicNow: () => number;
	readonly #handles = new Set<LeaseState>();
	constructor(database: WorkDatabase, events: EventLog, clock: JobClock) {
		this.#database = database;
		this.#events = events;
		this.#wallNow = clock.wallNow;
		this.#monotonicNow = clock.monotonicNow;
	}
	#time(): { wall: number; monotonic: number } {
		const wall = integer(this.#wallNow());
		const monotonic = this.#monotonicNow();
		if (!Number.isFinite(monotonic) || monotonic < 0 || monotonic > Number.MAX_SAFE_INTEGER)
			throw new WorkError("input");
		return { wall, monotonic };
	}
	#event(scope: WorkScope, job: Job): void {
		appendEvent.call(this.#events, scope, {
			userId: job.ownerId,
			accountId: job.accountId,
			dataClass: "hub.state",
			kind: "jobs.changed",
			ids: [job.id],
		});
	}
	#mutate<T>(scope: WorkScope, work: () => T): T {
		try {
			return work();
		} catch (error) {
			this.#database.abort(scope);
			throw error;
		}
	}
	#retire(state: LeaseState): void {
		state.active = false;
		this.#handles.delete(state);
	}
	#capacity(time: { wall: number; monotonic: number }): void {
		for (const state of this.#handles) {
			if (time.wall >= (state.job.leaseUntil ?? 0) || time.monotonic >= state.monotonicUntil)
				this.#retire(state);
		}
		if (this.#handles.size >= JOB_MAX_HANDLES) throw new WorkError("lease");
	}
	#issue(value: Row, monotonic: number): JobLease {
		const job = snapshot(value);
		if (value.token === null) throw new WorkError("data");
		const state: LeaseState = {
			queue: this,
			job,
			token: value.token,
			monotonicUntil: monotonic + JOB_LEASE_MS,
			active: true,
		};
		if (!Number.isFinite(state.monotonicUntil) || state.monotonicUntil > Number.MAX_SAFE_INTEGER)
			throw new WorkError("input");
		const lease: JobLease = Object.freeze({ job });
		leases.set(lease, state);
		this.#handles.add(state);
		return lease;
	}
	#consume(
		scope: WorkScope,
		lease: JobLease,
	): { sql: SqlTransaction; value: Row; wall: number; monotonic: number } {
		const sql = this.#database.sql(scope);
		const state = leases.get(lease);
		if (!state || state.queue !== this || !state.active) throw new WorkError("lease");
		// A failed attempt or enclosing rollback never revives this in-process capability.
		this.#retire(state);
		const time = this.#time();
		const value = read(sql, state.job.id);
		if (
			value?.state !== "RUNNING" ||
			value.token !== state.token ||
			value.accountId !== state.job.accountId ||
			value.ownerId !== state.job.ownerId ||
			value.kind !== state.job.kind ||
			value.refId !== state.job.refId ||
			value.attempts !== state.job.attempts ||
			value.maxAttempts !== state.job.maxAttempts ||
			value.createdAt !== state.job.createdAt ||
			value.nextAt !== state.job.nextAt ||
			value.leaseUntil !== state.job.leaseUntil ||
			time.wall >= (value.leaseUntil ?? 0) ||
			time.monotonic >= state.monotonicUntil
		)
			throw new WorkError("lease");
		return { sql, value, ...time };
	}
	enqueue(scope: WorkScope, input: JobInput): Job {
		return this.#mutate(scope, () => {
			const value = fields(input, ["id", "accountId", "ownerId", "kind", "refId"], ["maxAttempts"]);
			const jobId = id(value.id),
				accountId = id(value.accountId),
				ownerId = id(value.ownerId),
				refId = id(value.refId);
			if (typeof value.kind !== "string" || !KINDS.has(value.kind)) throw new WorkError("input");
			const maxAttempts = Object.hasOwn(value, "maxAttempts")
				? integer(value.maxAttempts, 1, JOB_MAX_ATTEMPTS)
				: 5;
			const sql = this.#database.sql(scope),
				{ wall } = this.#time();
			sql.run(
				"INSERT INTO main.jobs(id,account_id,owner_id,kind,ref_id,state,attempts,max_attempts,created_at,next_at) VALUES(?,?,?,?,?,'PENDING',0,?,?,?)",
				[jobId, accountId, ownerId, value.kind, refId, maxAttempts, wall, wall],
			);
			const inserted = read(sql, jobId);
			if (!inserted) throw new WorkError("data");
			const job = snapshot(inserted);
			this.#event(scope, job);
			return job;
		});
	}
	get(scope: WorkScope, jobId: string): Job | undefined {
		const value = read(this.#database.sql(scope), id(jobId));
		return value === undefined ? undefined : snapshot(value);
	}
	#recover(scope: WorkScope, wall: number, accountId: string | null): number {
		const sql = this.#database.sql(scope);
		const expired = sql.all<Row>(
			`${ROW} WHERE state='RUNNING' AND lease_until<=? AND (? IS NULL OR account_id=?) ORDER BY lease_until,seq LIMIT ?`,
			[wall, accountId, accountId, JOB_RECOVERY_BATCH],
		);
		for (const raw of expired) {
			const job = row(raw);
			const state = job.attempts >= job.maxAttempts ? "FAILED" : "PENDING";
			if (
				sql.run(
					"UPDATE main.jobs SET state=?,next_at=?,token=NULL,lease_until=NULL WHERE id=? AND state='RUNNING' AND token=? AND lease_until<=?",
					[state, wall, job.id, job.token, wall],
				).changes !== 1
			)
				throw new WorkError("lease");
			for (const handle of this.#handles) if (handle.job.id === job.id) this.#retire(handle);
			this.#event(scope, { ...job, state, leaseUntil: null, nextAt: wall });
		}
		return expired.length;
	}
	/** Restart never implies expiry. A backward wall jump conservatively delays recovery. */
	recover(scope: WorkScope, accountId?: string): number {
		return this.#mutate(scope, () =>
			this.#recover(scope, this.#time().wall, accountId === undefined ? null : id(accountId)),
		);
	}
	claim(scope: WorkScope, accountId: string, exactJobId?: string): JobLease | undefined {
		return this.#mutate(scope, () => {
			const account = id(accountId),
				exact = exactJobId === undefined ? null : id(exactJobId);
			const sql = this.#database.sql(scope),
				time = this.#time();
			this.#capacity(time);
			this.#recover(scope, time.wall, account);
			const candidate = sql.get<Row>(
				`${ROW} WHERE account_id=? AND state='PENDING' AND attempts<max_attempts AND next_at<=? AND (? IS NULL OR id=?) AND NOT EXISTS(SELECT 1 FROM main.jobs AS running WHERE running.account_id=? AND running.state='RUNNING') ORDER BY seq LIMIT 1`,
				[account, time.wall, exact, exact, account],
			);
			if (!candidate) return undefined;
			const job = row(candidate),
				until = integer(time.wall + JOB_LEASE_MS);
			const token = randomBytes(32).toString("hex");
			if (
				sql.run(
					"UPDATE main.jobs SET state='RUNNING',attempts=attempts+1,token=?,lease_until=? WHERE id=? AND state='PENDING' AND attempts<max_attempts",
					[token, until, job.id],
				).changes !== 1
			)
				throw new WorkError("lease");
			const claimed = read(sql, job.id);
			if (!claimed) throw new WorkError("data");
			this.#event(scope, claimed);
			return this.#issue(claimed, time.monotonic);
		});
	}
	complete(scope: WorkScope, lease: JobLease): void {
		this.#mutate(scope, () => {
			const { sql, value } = this.#consume(scope, lease);
			if (
				sql.run(
					"UPDATE main.jobs SET state='SUCCEEDED',token=NULL,lease_until=NULL WHERE id=? AND state='RUNNING' AND token=?",
					[value.id, value.token],
				).changes !== 1
			)
				throw new WorkError("lease");
			this.#event(scope, { ...value, state: "SUCCEEDED", leaseUntil: null });
		});
	}
	fail(scope: WorkScope, lease: JobLease, retryAfterMs = 1_000): void {
		this.#mutate(scope, () => {
			const delay = integer(retryAfterMs, 0, JOB_MAX_RETRY_MS);
			const { sql, value, wall } = this.#consume(scope, lease);
			const state = value.attempts >= value.maxAttempts ? "FAILED" : "PENDING";
			const nextAt = integer(wall + delay);
			if (
				sql.run(
					"UPDATE main.jobs SET state=?,next_at=?,token=NULL,lease_until=NULL WHERE id=? AND state='RUNNING' AND token=?",
					[state, nextAt, value.id, value.token],
				).changes !== 1
			)
				throw new WorkError("lease");
			this.#event(scope, { ...value, state, nextAt, leaseUntil: null });
		});
	}
	renew(scope: WorkScope, lease: JobLease): JobLease {
		return this.#mutate(scope, () => {
			const { sql, value, wall, monotonic } = this.#consume(scope, lease);
			const until = integer(wall + JOB_LEASE_MS),
				token = randomBytes(32).toString("hex");
			if (
				sql.run(
					"UPDATE main.jobs SET token=?,lease_until=? WHERE id=? AND state='RUNNING' AND token=?",
					[token, until, value.id, value.token],
				).changes !== 1
			)
				throw new WorkError("lease");
			return this.#issue({ ...value, token, leaseUntil: until }, monotonic);
		});
	}
	cancel(scope: WorkScope, jobId: string): boolean {
		return this.#mutate(scope, () => {
			const sql = this.#database.sql(scope),
				value = read(sql, id(jobId));
			if (!value || (value.state !== "PENDING" && value.state !== "RUNNING")) return false;
			if (
				sql.run(
					"UPDATE main.jobs SET state='CANCELLED',token=NULL,lease_until=NULL WHERE id=? AND state IN ('PENDING','RUNNING')",
					[value.id],
				).changes !== 1
			)
				throw new WorkError("lease");
			for (const state of this.#handles) if (state.job.id === value.id) this.#retire(state);
			this.#event(scope, { ...value, state: "CANCELLED", leaseUntil: null });
			return true;
		});
	}
}
