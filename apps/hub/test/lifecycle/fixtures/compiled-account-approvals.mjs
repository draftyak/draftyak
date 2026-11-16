import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { mkdirSync, readFileSync, realpathSync } from "node:fs";
import path from "node:path";

const namespaces = [
	"audit", "core", "devices", "jobs", "events", "revisions", "credentials", "tickets",
	"accounts", "pluginregistry", "outbox", "challenges", "verifier", "admin", "adminchallenges", "backup",
	"backupops", "backupchallenges",
].sort();
const approvalTables = [
	"outbox", "approval_challenges", "pair_confirm_operations", "approvals",
	"native_admin_operations", "native_admin_challenges",
	"native_backup_operations", "native_backup_challenges",
];
let phase = "arguments";

async function main() {
	const [nativeBinding, mode, hub] = process.argv.slice(2);
	assert.equal(typeof nativeBinding, "string");
	assert.ok(mode === "cached" || mode === "closed-before-use");
	assert.equal(typeof hub, "string");
	assert.equal(process.permission?.has("net"), false);
	for (const denied of ["src/store/migrations/audit/0001_chain.sql", "dist/index.mjs"]) {
		assert.throws(() => readFileSync(path.join(hub, denied)), { code: "ERR_ACCESS_DENIED" });
	}
	mkdirSync(path.join(import.meta.dirname, "data"));
	const folder = realpathSync.native(path.join(import.meta.dirname, "data"));
	const bytes = randomBytes(32), keys = [], sessions = [];
	try {
		phase = "import";
		const api = await import("./index.mjs");
		assert.equal(Object.hasOwn(api, "NativeAccountApprovals"), false);
		assert.equal(typeof api.openHubSession, "function");
		const open = async () => {
			const key = new api.MasterKey(bytes);
			keys.push(key);
			const session = await api.openHubSession({ folder, nativeBinding, masterKey: key });
			sessions.push(session);
			return { session, key };
		};
		const unavailable = (error) => {
			assert.equal(error instanceof Error, true);
			assert.equal(error.code, "SESSION_UNAVAILABLE");
			assert.equal(error.message, "SESSION_UNAVAILABLE");
			return true;
		};
		const erased = (key) => {
			let material;
			try {
				assert.throws(() => { material = key.derive("db"); }, { message: "Hub is locked" });
			} finally { material?.fill(0); }
		};
		const schemas = (session) => session.store.read((db) => {
			const tables = db.all("SELECT name FROM main.sqlite_schema WHERE type='table'").map((row) => row.name);
			assert.deepEqual(tables.filter((name) => name.startsWith("_migrations_") && !name.endsWith("_lock"))
				.map((name) => name.slice("_migrations_".length)).sort(), namespaces);
			for (const table of approvalTables) assert.ok(tables.includes(table));
			for (const table of [
				"users", "devices", "plugin_versions", "plugin_registry_identities", "plugin_candidates", "native_backup_recovery",
				"native_backup_operations", "native_backup_challenges",
			]) {
				assert.deepEqual(db.get(`SELECT count(*) AS n FROM main.${table}`), { n: 0 });
			}
		});
		phase = "first-open";
		const first = await open();
		schemas(first.session);
		assert.equal(first.session.extensions.modules.length, 0);
		let retained;
		if (mode === "cached") {
			phase = "construct-before-bootstrap";
			retained = first.session.accountApprovals();
			assert.equal(first.session.accountApprovals(), retained);
			for (const name of ["open", "review", "issue", "accept"]) assert.equal(typeof retained[name], "function");
			schemas(first.session);
		}
		const identity = [first.session.hubId, first.session.hid];
		phase = "first-close";
		const closing = first.session.close();
		assert.equal(first.session.close(), closing);
		assert.throws(() => first.session.accountApprovals(), unavailable);
		if (retained) {
			// Missing arguments are untrusted calls; a closed facade must fence before inspecting them.
			for (const name of ["open", "review", "issue", "accept"]) {
				await assert.rejects(async () => Reflect.apply(retained[name], retained, []), unavailable);
			}
		}
		await closing;
		erased(first.key);
		assert.throws(() => first.session.store.read((db) => db.get("SELECT 1")), { message: /unavailable/ });
		phase = "reopen";
		const second = await open();
		try {
			assert.deepEqual([second.session.hubId, second.session.hid], identity);
			schemas(second.session);
			const current = second.session.accountApprovals();
			assert.equal(second.session.accountApprovals(), current);
			if (retained) assert.notEqual(current, retained);
			second.session.store.read((db) => second.session.audit.verify(db));
		} finally {
			await second.session.close();
		}
		erased(second.key);
		process.stdout.write(`${JSON.stringify({
			ok: true, mode, schemas: namespaces.length, cached: mode === "cached", beforeBootstrap: true,
			closedRefused: true, keyErased: true, reopened: true, runtimeConstructor: false,
		})}\n`);
	} finally {
		let failed = false;
		for (const session of sessions) {
			try { await session.close(); } catch { failed = true; }
		}
		for (const key of keys) key.destroy();
		bytes.fill(0);
		if (failed) throw new Error("Compiled account approval cleanup failed");
	}
}

await main().catch(() => {
	process.stderr.write(`Compiled account approval check failed (${phase})\n`);
	process.exitCode = 1;
});
