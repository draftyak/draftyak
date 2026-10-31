import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { mkdirSync, readFileSync, realpathSync, renameSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";

// These expectations are independent of the production namespace inventory.
const migrations = [
	["audit", "0001_chain"],
	["core", "0001_identity"],
	["devices", "0001_devices"],
	["jobs", "0001_jobs"],
	["events", "0001_events"],
	["revisions", "0001_native_revisions"],
	["credentials", "0001_credentials"],
	["tickets", "0001_send_attempts"],
];
const businessTables = [
	"audit_meta", "audit_events", "hub_meta", "users", "approval_pins", "jobs", "jobs_meta",
	"events", "event_meta", "native_drafts", "native_draft_revisions", "native_draft_locks",
	"credentials", "native_send_attempts", "device_authority", "devices",
].sort();
let phase = "admission";

async function main() {
	assert.equal(process.permission?.has("net"), false);
	const [nativeBinding, mode, hub] = process.argv.slice(2);
	assert.equal(typeof nativeBinding, "string");
	assert.ok(["positive", "missing-credentials", "invalid-credentials", "missing-revision-immutability", "missing-devices", "invalid-devices"].includes(mode));
	assert.equal(typeof hub, "string");
	for (const denied of ["src/store/migrations/audit/0001_chain.sql", "dist/index.mjs"]) {
		assert.throws(() => readFileSync(path.join(hub, denied)), { code: "ERR_ACCESS_DENIED" });
	}
	mkdirSync(path.join(import.meta.dirname, "data"));
	const folder = realpathSync.native(path.join(import.meta.dirname, "data"));
	const filename = path.join(folder, "draftyak.db");
	const Database = createRequire(import.meta.url)("better-sqlite3-multiple-ciphers");
	const nativeClose = Database.prototype.close;
	const bytes = randomBytes(32);
	const keys = [];
	const sessions = [];
	const stores = new Set();
	let closed = 0;
	// Install before importing the bundle: the store captures the actual native close once.
	Database.prototype.close = function (...args) {
		const owned = this.name === filename;
		const wasOpen = this.open;
		const result = Reflect.apply(nativeClose, this, args);
		if (owned && wasOpen && this.open === false) closed++;
		return result;
	};
	let HubStore, HubIdentity, migrate, loadIdentity, closeStore;
	const requiredAsset = path.join(import.meta.dirname, mode === "missing-revision-immutability"
		? "drafts/migrations/0002_immutable_revisions.sql"
		: mode.endsWith("devices") ? "devices-migrations/0001_devices.sql"
			: "credentials/migrations/0001_credentials.sql");
	const heldAsset = path.join(import.meta.dirname, "held-schema.sql");
	let savedAsset;
	let assetMissing = false;
	let assetInvalid = false;
	try {
		phase = "import";
		const api = await import("./index.mjs");
		({ HubStore, HubIdentity } = api);
		closeStore = HubStore.prototype.close;
		const { MasterKey, HubSessionError, openHubSession } = api;
		const order = [];
		let identities = 0;
		const inspectSchemas = (store) => store.read((db) => {
			const actual = db.all("SELECT name FROM main.sqlite_schema WHERE type='table'")
				.map((row) => row.name);
			assert.deepEqual(actual.filter((name) => businessTables.includes(name)).sort(), businessTables);
			for (const [namespace, migration] of migrations) {
				assert.ok(actual.includes(`_migrations_${namespace}`));
				assert.ok(actual.includes(`_migrations_${namespace}_lock`));
				const versions = namespace === "revisions" ? [migration, "0002_immutable_revisions"] : [migration];
				assert.deepEqual(
					db.all(`SELECT name FROM main._migrations_${namespace} ORDER BY name`),
					versions.map((name) => ({ name })),
				);
			}
		});
		migrate = HubStore.prototype.migrate;
		HubStore.prototype.migrate = function (namespace) {
			stores.add(this);
			order.push(namespace);
			return Reflect.apply(migrate, this, [namespace]);
		};
		loadIdentity = HubIdentity.loadOrCreate;
		HubIdentity.loadOrCreate = function (store, key) {
			// Count entry attempts even when schema assertions refuse before the genuine loader.
			identities++;
			// This runs before the real identity loader can create any identity.
			inspectSchemas(store);
			return Reflect.apply(loadIdentity, this, [store, key]);
		};
		const key = () => {
			const value = new MasterKey(bytes);
			keys.push(value);
			return value;
		};
		const erased = (value) => {
			let derived;
			try {
				derived = value.derive("audit");
				assert.fail("Session key was retained");
			} catch (error) {
				assert.equal(error instanceof Error && error.message === "Hub is locked", true);
			} finally {
				derived?.fill(0);
			}
		};
		const open = async (ownedKey = key()) => {
			const session = await openHubSession({ folder, nativeBinding, masterKey: ownedKey });
			sessions.push(session);
			return { session, ownedKey };
		};
		const restoreAsset = () => {
			if (assetMissing) {
				renameSync(heldAsset, requiredAsset);
				assetMissing = false;
			}
			if (assetInvalid) {
				writeFileSync(requiredAsset, savedAsset);
				assetInvalid = false;
			}
		};
		let refused = null;
		if (mode !== "positive") {
			phase = "damaged-asset";
			if (mode.startsWith("missing-")) {
				renameSync(requiredAsset, heldAsset);
				assetMissing = true;
			} else {
				savedAsset = readFileSync(requiredAsset);
				writeFileSync(requiredAsset,
					"CREATE TABLE compiled_rollback_marker (singleton INTEGER PRIMARY KEY) STRICT;\nSELECT * FROM compiled_missing_relation;\n");
				assetInvalid = true;
			}
			const failedKey = key();
			const beforeClose = closed;
			await assert.rejects(open(failedKey), (error) => {
				assert.equal(error instanceof HubSessionError, true);
				assert.equal(error.code, "STORE_UNAVAILABLE");
				assert.equal(error.message, "STORE_UNAVAILABLE");
				assert.equal(Object.hasOwn(error, "cause"), false);
				return true;
			});
			refused = "STORE_UNAVAILABLE";
			assert.equal(closed, beforeClose + 1);
			assert.equal(identities, 0);
			erased(failedKey);
			// Inspect the encrypted file after the failed session closed its actual connection.
			const probeKey = key();
			const probe = new HubStore({ filename, nativeBinding, masterKey: probeKey, create: false });
			stores.add(probe);
			try {
				probe.read((db) => {
					assert.equal(db.get("SELECT 1 FROM main.sqlite_schema WHERE name='compiled_rollback_marker'"), undefined);
					if (db.get("SELECT 1 FROM main.sqlite_schema WHERE name='hub_meta'")) {
						assert.deepEqual(db.get("SELECT identity_wrapped,statement_wrapped,identity_cert FROM main.hub_meta WHERE singleton=1"),
							{ identity_wrapped: null, statement_wrapped: null, identity_cert: null });
					}
				});
			} finally {
				probe.close();
				probeKey.destroy();
			}
			restoreAsset();
		}
		phase = "healthy-open";
		const beforeHealthy = order.length;
		const first = await open();
		const identity = [first.session.hubId, first.session.hid];
		let modules;
		try {
			inspectSchemas(first.session.store);
			first.session.store.read((db) => first.session.audit.verify(db));
			modules = first.session.extensions.modules.length;
		} finally {
			first.session.close();
		}
		erased(first.ownedKey);
		phase = "healthy-reopen";
		const second = await open();
		try {
			assert.equal(second.session.hubId === identity[0] && second.session.hid === identity[1], true);
			inspectSchemas(second.session.store);
			second.session.store.read((db) => second.session.audit.verify(db));
			assert.equal(second.session.extensions.modules.length, modules);
		} finally {
			second.session.close();
		}
		erased(second.ownedKey);
		assert.equal(identities, 2);
		assert.deepEqual(order.slice(beforeHealthy), [...migrations, ...migrations].map(([namespace]) => namespace));
		assert.equal(modules, 0);
		process.stdout.write(`${JSON.stringify({
			ok: true, mode, schemas: 8, businessTables: businessTables.length, bookkeepingTables: 16,
			beforeIdentity: true, refused, failedOpenClosed: mode !== "positive",
			failedKeyErased: mode !== "positive", reopened: true, auditVerified: true, modules,
		})}\n`);
	} finally {
		let cleanupFailed = false;
		for (const session of sessions) {
			try { session.close(); } catch { cleanupFailed = true; }
		}
		for (const store of stores) {
			try { Reflect.apply(closeStore, store, []); } catch { cleanupFailed = true; }
		}
		try {
			for (const value of keys) value.destroy();
		} finally {
			bytes.fill(0);
			try {
				if (assetMissing) renameSync(heldAsset, requiredAsset);
				if (assetInvalid) writeFileSync(requiredAsset, savedAsset);
			} finally {
				savedAsset?.fill(0);
				if (migrate) HubStore.prototype.migrate = migrate;
				if (loadIdentity) HubIdentity.loadOrCreate = loadIdentity;
				Database.prototype.close = nativeClose;
			}
		}
		if (cleanupFailed) throw new Error("Compiled session cleanup failed");
	}
}

await main().catch(() => {
	process.stderr.write(`Compiled session control failed (${phase})\n`);
	process.exitCode = 1;
});
