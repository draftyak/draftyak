import path from "node:path";
import { EVENT_MIGRATIONS, EventLog } from "../../../src/events/log.ts";
import { WorkDatabase } from "../../../src/jobs/database.ts";
import { JOB_MIGRATIONS, type JobLease, JobQueue } from "../../../src/jobs/queue.ts";
import { WorkError } from "../../../src/jobs/values.ts";
import { MasterKey } from "../../../src/kernel/master-key.ts";
import { HubStore } from "../../../src/store/store.ts";
import { migrations, nativeBinding } from "../../store/helpers.ts";

interface Request {
	readonly id: number;
	readonly command: string;
	readonly filename?: string;
	readonly key?: Uint8Array;
	readonly wall?: number;
	readonly monotonic?: number;
	readonly accountId?: string;
	readonly jobId?: string;
	readonly claims?: readonly { accountId: string; jobId: string }[];
}

let store: HubStore | undefined;
let key: MasterKey | undefined;
let database: WorkDatabase;
let queue: JobQueue;
const clock = { wall: 0, monotonic: 0 };
const leases = new Map<string, JobLease>();

function reply(id: number, value: unknown): void {
	process.send?.({ id, ok: true, value });
}

function claim(accountId: string, jobId?: string): JobLease | undefined {
	const lease = database.write((scope) => queue.claim(scope, accountId, jobId));
	if (lease) leases.set(lease.job.id, lease);
	return lease;
}

process.on("message", (request: Request) => {
	try {
		if (request.command === "init") {
			if (store || !request.key || !request.filename) throw new Error("Invalid fixture init");
			try {
				key = new MasterKey(request.key);
			} finally {
				request.key.fill(0);
			}
			clock.wall = request.wall ?? 0;
			clock.monotonic = request.monotonic ?? 0;
			store = new HubStore({
				filename: request.filename,
				nativeBinding,
				masterKey: key,
				migrations: {
					audit: path.join(migrations, "audit"),
					jobs: JOB_MIGRATIONS,
					events: EVENT_MIGRATIONS,
				},
			});
			database = new WorkDatabase(store);
			queue = new JobQueue(database, new EventLog(database, () => clock.wall), {
				wallMs: () => clock.wall,
				monotonicMs: () => clock.monotonic,
			});
			reply(request.id, { pid: process.pid });
			return;
		}
		if (!store) throw new Error("Fixture is not initialized");
		if (request.command === "clock") {
			clock.wall = request.wall ?? clock.wall;
			clock.monotonic = request.monotonic ?? clock.monotonic;
			reply(request.id, null);
		} else if (request.command === "claim") {
			const lease = claim(request.accountId ?? "", request.jobId);
			reply(request.id, lease?.job ?? null);
		} else if (request.command === "claim-many") {
			let count = 0;
			for (const item of request.claims ?? []) {
				if (claim(item.accountId, item.jobId)) count++;
			}
			reply(request.id, count);
		} else if (request.command === "recover") {
			reply(
				request.id,
				database.write((scope) => queue.recover(scope, request.accountId)),
			);
		} else if (request.command === "complete") {
			const lease = leases.get(request.jobId ?? "");
			if (!lease) throw new WorkError("lease");
			database.write((scope) => queue.complete(scope, lease));
			reply(request.id, null);
		} else if (request.command === "uncommitted-claim") {
			database.write((scope) => {
				const lease = queue.claim(scope, request.accountId ?? "", request.jobId);
				if (!lease) throw new Error("Fixture claim unavailable");
				scope.sql.run("UPDATE main.process_state SET value=7 WHERE id=1");
				reply(request.id, { staged: true, jobId: lease.job.id });
				// The parent kills this owned process after receiving the staged marker.
				Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 60_000);
				throw new Error("Uncommitted fixture timed out");
			});
		} else throw new Error("Unknown fixture command");
	} catch (error) {
		process.send?.({
			id: request.id,
			ok: false,
			code: error instanceof WorkError ? error.code : "fixture",
		});
	}
});

process.on("disconnect", () => {
	store?.close();
	key?.destroy();
});
