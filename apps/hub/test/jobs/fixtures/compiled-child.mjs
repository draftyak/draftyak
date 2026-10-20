import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
	AuditChain,
	EVENT_MIGRATIONS,
	EventLog,
	HubStore,
	JOB_MIGRATIONS,
	JobQueue,
	MasterKey,
	WorkDatabase,
} from "./index.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
assert.equal(JOB_MIGRATIONS, path.join(here, "jobs-migrations", path.sep));
assert.equal(EVENT_MIGRATIONS, path.join(here, "events-migrations", path.sep));
assert.notEqual(JOB_MIGRATIONS, EVENT_MIGRATIONS);
const bytes = randomBytes(32);
const key = new MasterKey(bytes);
bytes.fill(0);
const store = new HubStore({
	filename: path.join(here, "smoke.db"),
	masterKey: key,
	nativeBinding: process.argv[2],
	create: true,
	migrations: {
		audit: path.join(here, "store", "migrations", "audit"),
		jobs: JOB_MIGRATIONS,
		events: EVENT_MIGRATIONS,
	},
});
const auditBytes = key.derive("audit");
const audit = new AuditChain(auditBytes);
auditBytes.fill(0);
try {
	for (const namespace of ["audit", "jobs", "events"]) await store.migrate(namespace);
	const database = new WorkDatabase(store);
	const events = new EventLog(database, () => 1_000_000);
	const queue = new JobQueue(database, events, {
		wallNow: () => 1_000_000,
		monotonicNow: () => 100,
	});
	const id = (n) => n.toString(16).toUpperCase().padStart(26, "0");
	database.write((scope) => {
		queue.enqueue(scope, {
			id: id(10),
			ownerId: id(2),
			accountId: id(1),
			kind: "sync",
			refId: id(3),
		});
		audit.append(scope.sql, {
			id: id(11),
			at: 1_000_000,
			action: "hub.init",
			actor: { kind: "hub", id: null },
			refs: {},
		});
	});
	const lease = database.write((scope) => queue.claim(scope, id(1)));
	assert.ok(lease);
	database.write((scope) => queue.complete(scope, lease));
	const result = database.write((scope) => ({
		state: queue.get(scope, id(10))?.state,
		events: events.page(scope, { userId: id(2), afterSeq: 0 }).events.length,
	}));
	assert.deepEqual(result, { state: "SUCCEEDED", events: 3 });
	store.read((sql) => audit.verify(sql));
	process.stdout.write(`${JSON.stringify({ ok: true, ...result })}\n`);
} finally {
	store.close();
	audit.destroy();
	key.destroy();
}
