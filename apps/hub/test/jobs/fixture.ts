import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { AuditChain } from "../../src/audit/chain.ts";
import { EVENT_MIGRATIONS, EventLog } from "../../src/events/log.ts";
import { WorkDatabase } from "../../src/jobs/database.ts";
import { JOB_MIGRATIONS, JobQueue } from "../../src/jobs/queue.ts";
import { MasterKey } from "../../src/kernel/master-key.ts";
import { HubStore } from "../../src/store/store.ts";
import { migrations, nativeBinding } from "../store/helpers.ts";

export const testId = (n: number): string => n.toString(16).toUpperCase().padStart(26, "0");
export const ACCOUNT: string = testId(1);
export const OWNER: string = testId(2);
export const REF: string = testId(3);

export async function fixture(): Promise<{
	dir: string;
	filename: string;
	key: MasterKey;
	store: HubStore;
	database: WorkDatabase;
	events: EventLog;
	queue: JobQueue;
	audit: AuditChain;
	clock: { wall: number; monotonic: number };
	reopen: () => HubStore;
	cleanup: () => void;
}> {
	const dir = mkdtempSync(path.join(os.tmpdir(), "draftyak-jobs-test-"));
	const filename = path.join(dir, "fixture.db");
	const key = new MasterKey(randomBytes(32));
	const state = path.join(dir, "state");
	mkdirSync(state);
	writeFileSync(
		path.join(state, "0001_state.sql"),
		"CREATE TABLE consumer_state(id INTEGER PRIMARY KEY, value INTEGER NOT NULL) STRICT; INSERT INTO consumer_state VALUES(1,0);",
	);
	const registered = {
		audit: path.join(migrations, "audit"),
		jobs: JOB_MIGRATIONS,
		events: EVENT_MIGRATIONS,
		state,
	};
	const store = new HubStore({
		filename,
		nativeBinding,
		masterKey: key,
		create: true,
		migrations: registered,
	});
	try {
		for (const namespace of ["audit", "jobs", "events", "state"]) await store.migrate(namespace);
	} catch (error) {
		store.close();
		key.destroy();
		rmSync(dir, { recursive: true, force: true });
		throw error;
	}
	const database = new WorkDatabase(store);
	const clock = { wall: 1_000_000, monotonic: 50_000 };
	const events = new EventLog(database, () => clock.wall);
	const queue = new JobQueue(database, events, {
		wallNow: () => clock.wall,
		monotonicNow: () => clock.monotonic,
	});
	const auditBytes = key.derive("audit");
	const audit = new AuditChain(auditBytes);
	auditBytes.fill(0);
	return {
		dir,
		filename,
		key,
		store,
		database,
		events,
		queue,
		audit,
		clock,
		reopen: () => new HubStore({ filename, nativeBinding, masterKey: key, migrations: registered }),
		cleanup: () => {
			store.close();
			audit.destroy();
			key.destroy();
			rmSync(dir, { recursive: true, force: true });
			if (existsSync(dir)) throw new Error("Test fixture cleanup failed");
		},
	};
}
