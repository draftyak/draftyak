import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import path from "node:path";
import { pathToFileURL } from "node:url";

let checkpoint = 1;
try {
	assert.equal(process.permission.has("net"), false);
	assert.equal(process.permission.has("child"), false);
	const hub = process.argv[2];
	const {
		HubStore,
		MasterKey,
		ChallengeService,
		SendApprovalVerifier,
		NativeOutboxProposals,
		CHALLENGE_MIGRATIONS,
		APPROVAL_MIGRATIONS,
		OUTBOX_MIGRATIONS,
	} = await import(pathToFileURL(path.join(hub, "dist/index.mjs")).href);
	checkpoint = 2;
	for (const constructor of [ChallengeService, SendApprovalVerifier, NativeOutboxProposals])
		assert.equal(typeof constructor, "function");
	assert.equal(CHALLENGE_MIGRATIONS, path.join(hub, "dist/identity/challenges-migrations/"));
	assert.equal(APPROVAL_MIGRATIONS, path.join(hub, "dist/outbox/verifier-migrations/"));
	assert.equal(OUTBOX_MIGRATIONS, path.join(hub, "dist/outbox/propose-migrations/"));
	const bytes = randomBytes(32), masterKey = new MasterKey(bytes);
	bytes.fill(0);
	const outboxKey = masterKey.derive("outbox"), approvalKey = masterKey.derive("approvals");
	try {
		assert.equal(outboxKey.length, 32);
		assert.equal(approvalKey.length, 32);
		assert.notDeepEqual(outboxKey, approvalKey);
	} finally {
		outboxKey.fill(0);
		approvalKey.fill(0);
	}
	const migrations = {
		audit: path.join(hub, "dist/store/migrations/audit"),
		core: path.join(hub, "dist/store/migrations/core"),
		devices: path.join(hub, "dist/devices-migrations"),
		revisions: path.join(hub, "dist/drafts/migrations"),
		challenges: CHALLENGE_MIGRATIONS,
		verifier: APPROVAL_MIGRATIONS,
		outbox: OUTBOX_MIGRATIONS,
	};
	const options = {
		filename: path.join(process.argv[4], "approval.db"),
		nativeBinding: process.argv[3],
		masterKey,
		migrations,
	};
	let store;
	try {
		store = new HubStore({ ...options, create: true });
		for (const namespace of Object.keys(migrations)) await store.migrate(namespace);
		checkpoint = 3;
		const inspect = () => store.read((sql) => {
			for (const namespace of ["challenges", "verifier", "outbox"])
				assert.equal(sql.get(`SELECT count(*) AS n FROM _migrations_${namespace}`).n, 1);
			for (const name of ["approval_challenges", "pair_confirm_operations", "approvals", "outbox"])
				assert.equal(sql.get("SELECT count(*) AS n FROM sqlite_schema WHERE type='table' AND name=?", [name]).n, 1);
		});
		inspect();
		store.close();
		store = new HubStore(options);
		for (const namespace of Object.keys(migrations)) await store.migrate(namespace);
		inspect();
		checkpoint = 4;
	} finally {
		store?.close();
		masterKey.destroy();
	}
	process.stdout.write(JSON.stringify({ ok: true, network: false, child: false, migrations: 3, reopened: true }));
} catch {
	process.stdout.write(JSON.stringify({ ok: false, checkpoint }));
	process.exitCode = 1;
}
