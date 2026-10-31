import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import path from "node:path";

let checkpoint = 1;
async function run() {
	// Startup permissions deny network access before loading any product or external module.
	assert.equal(process.permission.has("net"), false);
	assert.equal(process.permission.has("child"), false);
	assert.equal(process.permission.has("fs.read", process.argv[4]), false);
	assert.equal(process.permission.has("fs.read", process.argv[5]), false);
	assert.equal(process.permission.has("fs.read", process.argv[6]), false);
	assert.equal(process.permission.has("fs.read", process.argv[7]), false);
	assert.ok(process.execArgv.includes("--allow-addons"));
	checkpoint = 2;
	const { openNativeStorage, HubStore, MasterKey, AuditChain } = await import("./index.mjs");
	assert.equal(typeof openNativeStorage, "function", "Built root must export openNativeStorage");
	const mode = process.argv[3];
	assert.ok(["healthy", "missing-asset", "invalid-sql"].includes(mode));
	checkpoint = 3;
	const namespaces = ["audit", "core", "jobs", "events", "revisions", "credentials", "tickets"];
	const filename = path.join(import.meta.dirname, "native-storage.db");
	const bytes = randomBytes(32);
	const masterKey = new MasterKey(bytes);
	bytes.fill(0);
	const auditBytes = masterKey.derive("audit");
	const audit = new AuditChain(auditBytes);
	auditBytes.fill(0);
	const options = { filename, masterKey, nativeBinding: process.argv[2] };
	const originalClose = HubStore.prototype.close;
	let store;
	let failedStore;
	let closeCalls = 0;
	let originalCloseReturned = false;
	try {
		if (mode !== "healthy") {
			const asset = path.join(import.meta.dirname, "credentials/migrations/0001_credentials.sql");
			const delivered = readFileSync(asset);
			HubStore.prototype.close = function () {
				failedStore = this;
				closeCalls++;
				const result = Reflect.apply(originalClose, this, []);
				originalCloseReturned = true;
				return result;
			};
			try {
				if (mode === "missing-asset") unlinkSync(asset);
				else writeFileSync(asset, "CREATE TABLE broken_bootstrap(;");
				checkpoint = 4;
				await assert.rejects(() => openNativeStorage({ ...options, create: true }));
				checkpoint = 5;
				assert.equal(closeCalls, 1, "Failed migration must close its genuine HubStore");
				assert.equal(originalCloseReturned, true, "Original native close must complete");
				assert.ok(failedStore);
				assert.throws(() => failedStore.read(() => undefined), /Database is unavailable/);
			} finally {
				HubStore.prototype.close = originalClose;
				writeFileSync(asset, delivered);
			}
			checkpoint = 6;
			store = await openNativeStorage(options);
		} else {
			// Extra runtime fields cannot replace the factory's fixed namespace registration.
			const callerSql = path.join(import.meta.dirname, "caller-sql");
			mkdirSync(callerSql);
			writeFileSync(path.join(callerSql, "0001_caller.sql"), "CREATE TABLE caller_bootstrap_override(id INTEGER);");
			checkpoint = 7;
			store = await openNativeStorage({
				...options,
				create: true,
				migrations: { intruder: callerSql },
			});
			await assert.rejects(() => store.migrate("intruder"), /Migration namespace is not registered/);
			assert.equal(store.read((sql) => sql.get("SELECT 1 FROM sqlite_schema WHERE name='caller_bootstrap_override'")), undefined);
		}
		const inspect = () =>
			store.read((sql) => {
				const rows = sql.all("SELECT rowid,name FROM main.sqlite_schema WHERE type='table'");
				const ordinal = (name) => {
					const row = rows.find((entry) => entry.name === name);
					assert.ok(row, `Missing native schema table ${name}`);
					return row.rowid;
				};
				const coreTables = ["hub_meta", "users", "approval_pins"];
				for (const name of coreTables) {
					assert.ok(ordinal("audit_events") < ordinal(name), "Audit events must precede core schema");
				}
				for (const name of [
					"jobs", "jobs_meta", "events", "event_meta", "native_drafts",
					"native_draft_revisions", "native_draft_locks", "credentials", "native_send_attempts",
				]) {
					assert.ok(ordinal("audit_meta") < ordinal(name), "Audit schema must migrate first");
					assert.ok(ordinal("audit_events") < ordinal(name), "Audit events must migrate first");
					for (const coreTable of coreTables) {
						assert.ok(ordinal(coreTable) < ordinal(name), "Core schema must precede component schemas");
					}
				}
				for (const namespace of namespaces) {
					assert.equal(sql.get(`SELECT count(*) AS n FROM _migrations_${namespace}`).n, namespace === "revisions" ? 2 : 1);
				}
				assert.equal(sql.get("SELECT count(*) AS n FROM audit_meta").n, 1);
				assert.equal(sql.get("SELECT count(*) AS n FROM hub_meta").n, 1);
				const core = sql.get("SELECT singleton,identity_wrapped,statement_wrapped,identity_cert FROM hub_meta");
				assert.deepEqual(core, { singleton: 1, identity_wrapped: null, statement_wrapped: null, identity_cert: null });
				assert.equal(sql.get("SELECT count(*) AS n FROM users").n, 0);
				assert.equal(sql.get("SELECT count(*) AS n FROM approval_pins").n, 0);
				const genesis = sql.get("SELECT audit_seq,audit_head,audit_tag FROM audit_meta");
				assert.match(genesis.audit_tag, /^[0-9a-f]{64}$/);
				audit.verify(sql);
				return { rows, genesis, core };
			});
		checkpoint = 8;
		const initial = inspect();
		checkpoint = 9;
		assert.deepEqual({ seq: initial.genesis.audit_seq, head: initial.genesis.audit_head }, { seq: 0, head: "" });
		checkpoint = 10;
		store.write((sql) => audit.append(sql, {
			id: "00000000000000000000000001",
			at: 1_000_000,
			action: "hub.init",
			actor: { kind: "hub", id: null },
			refs: {},
		}));
		const populated = inspect();
		assert.equal(populated.genesis.audit_seq, 1);
		checkpoint = 11;
		store.checkpoint();
		store.close();
		store = undefined;
		assert.notEqual(readFileSync(filename).subarray(0, 16).toString(), "SQLite format 3\0");
		checkpoint = 12;
		store = await openNativeStorage(options);
		assert.deepEqual(inspect(), populated, "Reopen must retain schema and authenticated audit head");
		return {
			ok: true,
			mode,
			networkAllowed: false,
			nativeAddonPermission: true,
			schemas: namespaces.length,
		};
	} finally {
		try {
			HubStore.prototype.close = originalClose;
			store?.close();
			if (failedStore) Reflect.apply(originalClose, failedStore, []);
			audit.destroy();
			masterKey.destroy();
		} catch {
			checkpoint = 90;
			throw new Error("Native fixture cleanup failed");
		}
	}
}

try {
	const result = await run();
	process.stdout.write(`${JSON.stringify(result)}\n`);
} catch {
	process.stdout.write(`${JSON.stringify({ ok: false, checkpoint })}\n`);
	process.exitCode = 1;
}
