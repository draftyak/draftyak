import { type ChildProcess, spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";
import { EVENT_MIGRATIONS, EventLog } from "../../src/events/log.ts";
import { WorkDatabase } from "../../src/jobs/database.ts";
import type { Job, JobLease } from "../../src/jobs/queue.ts";
import {
	JOB_LEASE_MS,
	JOB_MIGRATIONS,
	JOB_RECOVERY_BATCH,
	JobQueue,
} from "../../src/jobs/queue.ts";
import { MasterKey } from "../../src/kernel/master-key.ts";
import { HubStore } from "../../src/store/store.ts";
import { migrations, nativeBinding } from "../store/helpers.ts";
import { ACCOUNT, OWNER, REF, testId } from "./fixture.ts";

interface Reply {
	readonly id: number;
	readonly ok: boolean;
	readonly value?: unknown;
	readonly code?: string;
}

class NativeChild {
	readonly process: ChildProcess;
	readonly closed: Promise<void>;
	readonly #pending = new Map<
		number,
		{ resolve: (reply: Reply) => void; reject: (error: Error) => void; timer: NodeJS.Timeout }
	>();
	#nextId = 0;
	#output = 0;
	constructor(dir: string) {
		this.process = spawn(
			process.execPath,
			[fileURLToPath(new URL("./fixtures/process-child.ts", import.meta.url))],
			{
				stdio: ["ignore", "pipe", "pipe", "ipc"],
				serialization: "advanced",
				windowsHide: true,
				env: { SystemRoot: process.env.SystemRoot, TEMP: dir, TMP: dir, NO_COLOR: "1" },
			},
		);
		this.process.stdout?.on("data", (chunk: Buffer) => {
			this.#output += chunk.length;
		});
		this.process.stderr?.on("data", (chunk: Buffer) => {
			this.#output += chunk.length;
		});
		this.process.on("message", (reply: Reply) => {
			const pending = this.#pending.get(reply.id);
			if (!pending) return;
			clearTimeout(pending.timer);
			this.#pending.delete(reply.id);
			pending.resolve(reply);
		});
		this.process.on("error", () => {
			for (const pending of this.#pending.values())
				pending.reject(new Error("Native child failed"));
		});
		this.closed = new Promise((resolve) => {
			this.process.once("close", () => {
				for (const pending of this.#pending.values()) {
					clearTimeout(pending.timer);
					pending.reject(new Error("Native child closed before reply"));
				}
				this.#pending.clear();
				resolve();
			});
		});
	}
	request(command: string, input: Record<string, unknown> = {}): Promise<Reply> {
		const id = ++this.#nextId;
		return new Promise((resolve, reject) => {
			const timer = setTimeout(() => {
				this.#pending.delete(id);
				reject(new Error("Native child reply timed out"));
			}, 30_000);
			this.#pending.set(id, { resolve, reject, timer });
			this.process.send?.({ ...input, id, command });
		});
	}
	async kill(): Promise<void> {
		if (this.process.exitCode === null && this.process.signalCode === null)
			this.process.kill("SIGKILL");
		await this.closed;
		expect(this.#output).toBe(0);
	}
}

function removeFixture(dir: string): void {
	if (
		path.dirname(path.resolve(dir)) !== path.resolve(os.tmpdir()) ||
		!path.basename(dir).startsWith("draftyak-job-process-")
	)
		throw new Error("Fixture cleanup target refused");
	rmSync(dir, { recursive: true, force: true });
	expect(existsSync(dir)).toBe(false);
}

async function processFixture() {
	const dir = mkdtempSync(path.join(os.tmpdir(), "draftyak-job-process-"));
	const filename = path.join(dir, "jobs.db");
	const bytes = randomBytes(32);
	const key = new MasterKey(bytes);
	const stateDir = path.join(dir, "state");
	const registered = {
		audit: path.join(migrations, "audit"),
		jobs: JOB_MIGRATIONS,
		events: EVENT_MIGRATIONS,
		state: stateDir,
	};
	const clock = { wall: 1_000_000, monotonic: 50_000 };
	const children: NativeChild[] = [];
	let opened: HubStore | undefined;
	try {
		mkdirSync(stateDir);
		writeFileSync(
			path.join(stateDir, "0001_state.sql"),
			"CREATE TABLE process_state(id INTEGER PRIMARY KEY,value INTEGER NOT NULL) STRICT; INSERT INTO process_state VALUES(1,0);",
		);
		opened = new HubStore({
			filename,
			nativeBinding,
			masterKey: key,
			create: true,
			migrations: registered,
		});
		for (const namespace of ["audit", "jobs", "events", "state"]) await opened.migrate(namespace);
	} catch (error) {
		const errors = [error];
		try {
			opened?.close();
		} catch (closeError) {
			errors.push(closeError);
		}
		key.destroy();
		bytes.fill(0);
		try {
			removeFixture(dir);
		} catch (cleanupError) {
			errors.push(cleanupError);
		}
		throw new AggregateError(errors, "Native fixture initialization failed");
	}
	let store = opened;
	let database = new WorkDatabase(store);
	let queue = new JobQueue(database, new EventLog(database, () => clock.wall), {
		wallNow: () => clock.wall,
		monotonicNow: () => clock.monotonic,
	});
	return {
		dir,
		clock,
		get store() {
			return store;
		},
		get database() {
			return database;
		},
		get queue() {
			return queue;
		},
		async child(wall = clock.wall, monotonic = clock.monotonic): Promise<NativeChild> {
			const child = new NativeChild(dir);
			children.push(child);
			const copy = Buffer.from(bytes);
			try {
				const reply = await child.request("init", { filename, key: copy, wall, monotonic });
				expect(reply.ok).toBe(true);
				expect((reply.value as { pid: number }).pid).toBe(child.process.pid);
			} finally {
				copy.fill(0);
			}
			return child;
		},
		enqueue(jobId: string, accountId = ACCOUNT, maxAttempts = 5): Job {
			return database.write((scope) =>
				queue.enqueue(scope, {
					id: jobId,
					accountId,
					ownerId: OWNER,
					kind: "sync",
					refId: REF,
					maxAttempts,
				}),
			);
		},
		job(jobId: string): Job | undefined {
			return database.write((scope) => queue.get(scope, jobId));
		},
		head(): number {
			return store.read(
				(sql) =>
					sql.get<{ n: number }>("SELECT last_seq AS n FROM main.event_meta WHERE singleton=1")
						?.n ?? -1,
			);
		},
		reopen(): void {
			store.close();
			store = new HubStore({ filename, nativeBinding, masterKey: key, migrations: registered });
			database = new WorkDatabase(store);
			queue = new JobQueue(database, new EventLog(database, () => clock.wall), {
				wallNow: () => clock.wall,
				monotonicNow: () => clock.monotonic,
			});
		},
		async cleanup(): Promise<void> {
			const errors: unknown[] = [];
			for (const result of await Promise.allSettled(children.map((child) => child.kill())))
				if (result.status === "rejected") errors.push(result.reason);
			try {
				store.close();
			} catch (error) {
				errors.push(error);
			}
			key.destroy();
			bytes.fill(0);
			try {
				removeFixture(dir);
			} catch (error) {
				errors.push(error);
			}
			if (errors.length) throw new AggregateError(errors, "Native fixture cleanup failed");
		},
	};
}

type Fixture = Awaited<ReturnType<typeof processFixture>>;
async function withFixture(work: (fixture: Fixture) => Promise<void>): Promise<void> {
	const fixture = await processFixture();
	try {
		await work(fixture);
	} finally {
		await fixture.cleanup();
	}
}

async function claimed(child: NativeChild, accountId: string, jobId?: string): Promise<Job | null> {
	const reply = await child.request("claim", { accountId, jobId });
	expect(reply.ok).toBe(true);
	return reply.value as Job | null;
}

it("serializes concurrent same-account claims across two native processes", async () => {
	await withFixture(async (f) => {
		const ids = [testId(100), testId(101)] as const;
		for (const id of ids) f.enqueue(id);
		const children = await Promise.all([f.child(), f.child()]);
		expect(children[0].process.pid).not.toBe(children[1].process.pid);
		const results = await Promise.all(
			children.map((child, index) => claimed(child, ACCOUNT, ids[index])),
		);
		expect(results.filter(Boolean)).toHaveLength(1);
		expect(ids.map((id) => f.job(id)?.state).sort()).toEqual(["PENDING", "RUNNING"]);
		expect(ids.map((id) => f.job(id)?.attempts).sort()).toEqual([0, 1]);
		const winner = results[0] ? 0 : 1;
		const claimedId = results[winner]?.id;
		expect(claimedId).toBe(ids[winner]);
		const recoveringSibling = await f.child(f.clock.wall - 10_000, 0);
		const recovery = await recoveringSibling.request("recover", { accountId: ACCOUNT });
		expect(recovery).toMatchObject({ ok: true, value: 0 });
		expect(await claimed(recoveringSibling, ACCOUNT)).toBeNull();
		expect(f.job(claimedId ?? "")?.state).toBe("RUNNING");
		expect(await children[winner].request("complete", { jobId: claimedId })).toMatchObject({
			ok: true,
		});
		const loser = winner === 0 ? 1 : 0;
		const next = await claimed(children[loser], ACCOUNT);
		expect(next?.id).toBe(ids[loser]);
	});
}, 60_000);

it("allows separate accounts to run in independent processes at the same time", async () => {
	await withFixture(async (f) => {
		const jobs = [testId(110), testId(111)] as const;
		const accounts = [ACCOUNT, testId(4)] as const;
		f.enqueue(jobs[0], accounts[0]);
		f.enqueue(jobs[1], accounts[1]);
		const children = await Promise.all([f.child(), f.child()]);
		const results = await Promise.all([
			claimed(children[0], accounts[0], jobs[0]),
			claimed(children[1], accounts[1], jobs[1]),
		]);
		expect(results.map((job) => job?.id)).toEqual(jobs);
		expect(jobs.map((id) => f.job(id)?.state)).toEqual(["RUNNING", "RUNNING"]);
	});
}, 60_000);

it("keeps the native partial unique index independent of queue admission", async () => {
	await withFixture(async (f) => {
		const ids = [testId(120), testId(121), testId(122)] as const;
		f.enqueue(ids[0]);
		f.enqueue(ids[1]);
		f.enqueue(ids[2], testId(4));
		const child = await f.child();
		expect((await claimed(child, ACCOUNT, ids[0]))?.id).toBe(ids[0]);
		const nativeClaim = (id: string) =>
			f.store.write((sql) =>
				sql.run(
					"UPDATE main.jobs SET state='RUNNING',attempts=1,token=?,lease_until=? WHERE id=?",
					["0".repeat(64), f.clock.wall + JOB_LEASE_MS, id],
				),
			);
		expect(() => nativeClaim(ids[1])).toThrow();
		expect(f.job(ids[1])?.state).toBe("PENDING");
		expect(nativeClaim(ids[2]).changes).toBe(1);
		expect(f.job(ids[2])?.state).toBe("RUNNING");
	});
}, 60_000);

it("recovers a killed durable claimant only at persisted expiry after a backward restart clock", async () => {
	await withFixture(async (f) => {
		const id = testId(130);
		f.enqueue(id, ACCOUNT, 2);
		const child = await f.child();
		const first = await claimed(child, ACCOUNT, id);
		expect(first).toMatchObject({
			id,
			state: "RUNNING",
			attempts: 1,
			leaseUntil: f.clock.wall + JOB_LEASE_MS,
		});
		expect(f.job(id)).toEqual(first);
		await child.kill();
		f.clock.wall -= 20_000;
		f.clock.monotonic = 0;
		f.reopen();
		expect(f.database.write((scope) => f.queue.recover(scope, ACCOUNT))).toBe(0);
		expect(f.database.write((scope) => f.queue.claim(scope, ACCOUNT, id))).toBeUndefined();
		f.clock.wall = (first?.leaseUntil ?? 0) - 1;
		expect(f.database.write((scope) => f.queue.recover(scope, ACCOUNT))).toBe(0);
		f.clock.wall++;
		expect(f.database.write((scope) => f.queue.recover(scope, ACCOUNT))).toBe(1);
		const next = f.database.write((scope) => f.queue.claim(scope, ACCOUNT, id));
		expect(next?.job).toMatchObject({ attempts: 2, state: "RUNNING" });
		expect(next).toBeDefined();
		f.database.write((scope) => f.queue.fail(scope, next as JobLease, 0));
		expect(f.job(id)).toMatchObject({ state: "FAILED", attempts: 2 });
		expect(f.database.write((scope) => f.queue.claim(scope, ACCOUNT, id))).toBeUndefined();
	});
}, 60_000);

it("fences an old live process after another connection recovers and claims its job", async () => {
	await withFixture(async (f) => {
		const id = testId(140);
		f.enqueue(id);
		const child = await f.child();
		const old = await claimed(child, ACCOUNT, id);
		f.clock.wall = old?.leaseUntil ?? 0;
		f.clock.monotonic = 0;
		f.reopen();
		expect(f.database.write((scope) => f.queue.recover(scope, ACCOUNT))).toBe(1);
		const fresh = f.database.write((scope) => f.queue.claim(scope, ACCOUNT, id));
		expect(fresh?.job.attempts).toBe(2);
		const before = f.head();
		expect(await child.request("complete", { jobId: id })).toMatchObject({
			ok: false,
			code: "lease",
		});
		expect(f.head()).toBe(before);
		expect(f.job(id)).toEqual(fresh?.job);
		f.database.write((scope) => f.queue.complete(scope, fresh as JobLease));
		expect(f.job(id)?.state).toBe("SUCCEEDED");
	});
}, 60_000);

it("rolls back consumer state, claim and invalidation when a process dies inside the transaction", async () => {
	await withFixture(async (f) => {
		const id = testId(150);
		f.enqueue(id);
		const head = f.head();
		const child = await f.child();
		expect(
			await child.request("uncommitted-claim", { accountId: ACCOUNT, jobId: id }),
		).toMatchObject({ ok: true, value: { staged: true, jobId: id } });
		await child.kill();
		f.reopen();
		expect(f.job(id)).toMatchObject({ state: "PENDING", attempts: 0, leaseUntil: null });
		expect(f.head()).toBe(head);
		expect(
			f.store.read((sql) =>
				sql.get<{ value: number }>("SELECT value FROM main.process_state WHERE id=1"),
			),
		).toEqual({ value: 0 });
		const next = f.database.write((scope) => f.queue.claim(scope, ACCOUNT, id));
		expect(next?.job.attempts).toBe(1);
	});
}, 60_000);

it("bounds recovery pages after a real claimant crash and preserves atomic invalidations", async () => {
	await withFixture(async (f) => {
		const claims = Array.from({ length: JOB_RECOVERY_BATCH * 2 + 5 }, (_, i) => ({
			jobId: testId(1_000 + i),
			accountId: testId(10_000 + i),
		}));
		const first = claims[0];
		if (!first) throw new Error("Native recovery fixture has no jobs");
		for (const item of claims) f.enqueue(item.jobId, item.accountId, 1);
		const child = await f.child();
		expect(await child.request("claim-many", { claims })).toMatchObject({ ok: true, value: 205 });
		const live = { jobId: testId(2_000), accountId: testId(20_000) };
		f.enqueue(live.jobId, live.accountId, 1);
		expect(await child.request("clock", { wall: f.clock.wall + 1_000 })).toMatchObject({
			ok: true,
		});
		expect((await claimed(child, live.accountId, live.jobId))?.id).toBe(live.jobId);
		await child.kill();
		f.clock.wall += JOB_LEASE_MS;
		f.clock.monotonic = 0;
		f.reopen();
		const head = f.head();
		let rolledBack = 0;
		expect(() =>
			f.database.write((scope) => {
				rolledBack = f.queue.recover(scope);
				scope.sql.run("UPDATE main.process_state SET value=9 WHERE id=1");
				throw new Error("DYTEST rollback");
			}),
		).toThrow("DYTEST rollback");
		expect(rolledBack).toBe(100);
		expect(f.head()).toBe(head);
		expect(f.job(first.jobId)?.state).toBe("RUNNING");
		const pages = Array.from({ length: 4 }, () =>
			f.database.write((scope) => f.queue.recover(scope)),
		);
		expect(pages).toEqual([100, 100, 5, 0]);
		expect(f.head()).toBe(head + 205);
		expect(claims.every((item) => f.job(item.jobId)?.state === "FAILED")).toBe(true);
		expect(f.job(live.jobId)?.state).toBe("RUNNING");
		expect(f.database.write((scope) => f.queue.claim(scope, first.accountId))).toBeUndefined();
		f.clock.wall += 1_000;
		expect(f.database.write((scope) => f.queue.recover(scope))).toBe(1);
		expect(f.job(live.jobId)).toMatchObject({ state: "FAILED", attempts: 1 });
	});
}, 120_000);
