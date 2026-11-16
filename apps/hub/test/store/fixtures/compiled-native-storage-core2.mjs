import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const stage = path.dirname(fileURLToPath(import.meta.url));
const [binding, mode, ...sourceRoots] = process.argv.slice(2);
const modes = ["healthy", "missing-asset", "invalid-sql", "refused-schema"];
const migrations = {
	audit: ["0001_chain"],
	core: ["0001_identity", "0002_native_runtime_state"],
	devices: ["0001_devices"],
	jobs: ["0001_jobs"],
	events: ["0001_events"],
	revisions: ["0001_native_revisions", "0002_immutable_revisions"],
	credentials: ["0001_credentials", "0002_sealed_credentials"],
	tickets: ["0001_send_attempts"],
	accounts: ["0001_accounts"],
	pluginregistry: ["0001_registry", "0002_candidates"],
	outbox: ["0001_proposals"],
	challenges: ["0001_challenges"],
	verifier: ["0001_approvals"],
	admin: ["0001_operations"],
	adminchallenges: ["0001_admin_challenges"],
	backup: ["0001_backup_recovery"],
	backupops: ["0001_backup_operations"],
	backupchallenges: ["0001_backup_challenges"],
};
const namespaces = Object.keys(migrations);
const business = "accounts,approval_challenges,approval_pins,approvals,audit_events,audit_meta,credentials,device_authority,devices,event_meta,events,hub_meta,jobs,jobs_meta,native_admin_challenges,native_admin_operations,native_backup_challenges,native_backup_operations,native_backup_recovery,native_draft_locks,native_draft_revisions,native_drafts,native_runtime_settings,native_send_attempts,outbox,pair_confirm_operations,plugin_candidates,plugin_generations,plugin_registry_identities,plugin_versions,users".split(",");
const bookkeeping = namespaces.flatMap(name => [`_migrations_${name}`, `_migrations_${name}_lock`]);
const expectedTables = [...business, ...bookkeeping].sort();
const coreAsset = path.join(stage, "store/migrations/core/0002_native_runtime_state.sql");
const digest = bytes => createHash("sha256").update(bytes).digest("hex");
const canonical = name => path.resolve(name).toLowerCase();
let checkpoint = 1, profile, seed, activeFile, observed, originalPragma, originalPrepare, Database;
let MasterKey, HubStore, AuditChain, openNativeStorage, originalMigrate, coreDefinition;
const keys = [], stores = new Set(), databases = new Set(), calls = [];
let receipt, failed = false, heldAsset;

function newKey() { const key = new MasterKey(seed); keys.push(key); return key; }
function selectedFile(filename) { activeFile = canonical(filename); observed = undefined; }
function closedDatabase() {
	assert(observed && observed.open === false);
	assert.throws(() => Reflect.apply(originalPrepare, observed, ["SELECT 1"]).get());
}
function closeStore(store, key) {
	store.close();
	assert.throws(() => store.read(() => 1));
	key.destroy();
	assert.throws(() => key.derive("db"));
	closedDatabase();
	store.close();
}
async function native(filename) {
	selectedFile(filename);
	const key = newKey();
	const store = await openNativeStorage({ filename, nativeBinding: binding, masterKey: key, create: !fs.existsSync(filename) });
	stores.add(store); store.assertMasterKey(key);
	assert(observed && observed.open === true);
	return { store, key };
}
function bare(filename) {
	selectedFile(filename);
	const key = newKey();
	const store = new HubStore({ filename, nativeBinding: binding, masterKey: key });
	stores.add(store); store.assertMasterKey(key);
	assert(observed && observed.open === true);
	return { store, key };
}
function inspect(store, paused) {
	return store.read(db => {
		const tables = db.all("SELECT name FROM main.sqlite_schema WHERE type='table' AND name NOT GLOB 'sqlite_*' ORDER BY name").map(row => row.name);
		assert.deepEqual(tables, expectedTables);
		for (const [name, files] of Object.entries(migrations)) {
			assert.deepEqual(db.all(`SELECT name FROM "_migrations_${name}" ORDER BY name`).map(row => row.name), [...files].sort());
			const ledger = `_migrations_${name}`, lock = `${ledger}_lock`;
			assert.equal(db.get("SELECT sql FROM main.sqlite_schema WHERE type='table' AND name=?", [ledger])?.sql,
				`CREATE TABLE "${ledger}" ("name" varchar(255) not null primary key, "timestamp" varchar(255) not null)`);
			assert.equal(db.get("SELECT sql FROM main.sqlite_schema WHERE type='table' AND name=?", [lock])?.sql,
				`CREATE TABLE "${lock}" ("id" varchar(255) not null primary key, "is_locked" integer default 0 not null)`);
		}
		assert.equal(db.get("SELECT sql FROM main.sqlite_schema WHERE type='table' AND name='native_runtime_settings'")?.sql, coreDefinition);
		assert.deepEqual(db.all("SELECT singleton,sync_paused FROM native_runtime_settings"), [{ singleton: 1, sync_paused: paused }]);
		const actual = tables.filter(name => name.startsWith("_migrations_") && !name.endsWith("_lock"));
		assert.equal(actual.length, namespaces.length);
		return actual.length;
	});
}
function verifyAudit(store, key) {
	const material = key.derive("audit");
	const audit = new AuditChain(material); material.fill(0);
	try { store.read(db => audit.verify(db)); } finally { audit.destroy(); }
}
function moveAsset() {
	assert(!heldAsset);
	const stat = fs.lstatSync(coreAsset); assert(stat.isFile() && !stat.isSymbolicLink());
	heldAsset = { path: path.join(profile, "saved-core2.sql"), bytes: fs.readFileSync(coreAsset), mode: stat.mode };
	fs.renameSync(coreAsset, heldAsset.path);
}
function restoreAsset() {
	if (!heldAsset) return;
	if (fs.existsSync(coreAsset)) fs.unlinkSync(coreAsset);
	fs.renameSync(heldAsset.path, coreAsset);
	assert(fs.readFileSync(coreAsset).equals(heldAsset.bytes));
	assert.equal(fs.lstatSync(coreAsset).mode, heldAsset.mode);
	heldAsset = undefined;
}
function refusedBare(filename) {
	selectedFile(filename); const key = newKey();
	assert.throws(() => new HubStore({ filename, nativeBinding: binding, masterKey: key }));
	closedDatabase();
	// A constructor that never returned has not transferred a close handle to this caller.
	key.destroy(); assert.throws(() => key.derive("db"));
}

try {
	assert(modes.includes(mode) && sourceRoots.length === 5);
	assert(typeof binding === "string" && path.isAbsolute(binding));
	assert(fs.lstatSync(binding).isFile() && !fs.lstatSync(binding).isSymbolicLink());
	assert(process.permission && typeof process.permission.has === "function");
	// The permission query API does not document an addon scope. Capture the startup flag.
	const nativeAddonPermission = process.execArgv.includes("--allow-addons");
	const networkAllowed = process.permission.has("net");
	assert.equal(nativeAddonPermission, true); assert.equal(networkAllowed, false);
	for (const root of sourceRoots) assert(path.isAbsolute(root) && !process.permission.has("fs.read", root));
	assert(fs.lstatSync(path.join(stage, "index.mjs")).isFile());
	assert(!fs.lstatSync(path.join(stage, "index.mjs")).isSymbolicLink());
	checkpoint = 2;
	Database = createRequire(import.meta.url)("better-sqlite3-multiple-ciphers");
	originalPragma = Database.prototype.pragma; originalPrepare = Database.prototype.prepare;
	Database.prototype.pragma = function (...args) {
		if (typeof this.name === "string" && canonical(this.name) === activeFile) { observed = this; databases.add(this); }
		return Reflect.apply(originalPragma, this, args);
	};
	({ MasterKey, HubStore, AuditChain, openNativeStorage } = await import(pathToFileURL(path.join(stage, "index.mjs")).href));
	assert([MasterKey, HubStore, AuditChain, openNativeStorage].every(value => typeof value === "function"));
	const coreSql = fs.readFileSync(coreAsset, "utf8");
	assert(coreSql.startsWith("CREATE TABLE native_runtime_settings (") && coreSql.includes(";"));
	coreDefinition = coreSql.slice(0, coreSql.indexOf(";")).trim();
	originalMigrate = HubStore.prototype.migrate;
	HubStore.prototype.migrate = function (namespace) {
		stores.add(this); calls.push(namespace);
		if (namespace === "core") this.read(db => {
			assert(db.get("SELECT name FROM sqlite_schema WHERE type='table' AND name='audit_events'"));
			assert(db.get("SELECT name FROM sqlite_schema WHERE type='table' AND name='audit_meta'"));
		});
		return Reflect.apply(originalMigrate, this, [namespace]);
	};
	seed = randomBytes(32); profile = fs.mkdtempSync(path.join(stage, ".core2-storage-"));
	const filename = path.join(profile, "hub.db");
	checkpoint = 3;
	const badBinding = path.join(profile, "invalid-addon.node"); fs.writeFileSync(badBinding, "not a native addon");
	const badKey = newKey();
	assert.throws(() => new HubStore({ filename: path.join(profile, "bad-binding.db"), nativeBinding: badBinding, masterKey: badKey, create: true }));
	badKey.destroy(); assert.throws(() => badKey.derive("db"));
	checkpoint = 4;
	if (mode === "missing-asset" || mode === "invalid-sql") {
		moveAsset();
		if (mode === "invalid-sql") fs.writeFileSync(coreAsset, "CREATE TABLE core2_rollback_marker(id INTEGER PRIMARY KEY);\nINSERT INTO core2_rollback_marker VALUES(1);\nINSERT INTO core2_rollback_marker VALUES(1);\n");
		selectedFile(filename); const key = newKey();
		let rejection;
		try { await openNativeStorage({ filename, nativeBinding: binding, masterKey: key, create: true }); }
		catch (error) { rejection = error; }
		assert(rejection !== undefined);
		if (mode === "invalid-sql") assert.equal(Object.getOwnPropertyDescriptor(rejection, "name")?.value, "MigrationError");
		closedDatabase(); key.destroy(); assert.throws(() => key.derive("db"));
		assert.deepEqual(calls, ["audit", "core"]);
		restoreAsset(); calls.length = 0;
	}
	checkpoint = 5;
	let opened = await native(filename);
	assert.deepEqual(calls, namespaces);
	const schemas = inspect(opened.store, 0);
	assert.equal(schemas, 18);
	checkpoint = 6;
	const sameKey = newKey(); opened.store.assertMasterKey(sameKey); sameKey.destroy();
	const differentSeed = Buffer.from(seed); differentSeed[0] ^= 1;
	const otherKey = new MasterKey(differentSeed); keys.push(otherKey); differentSeed.fill(0);
	assert.throws(() => opened.store.assertMasterKey(otherKey)); otherKey.destroy();
	const material = opened.key.derive("audit"), audit = new AuditChain(material); material.fill(0);
	try {
		opened.store.write(tx => audit.append(tx, { id: "01JAZ3W3B6Q8M2V0G5T9K4X7RC", at: 0, action: "fixture.storage_check", actor: { kind: "hub", id: null }, refs: {} }));
		opened.store.read(db => audit.verify(db));
	} finally { audit.destroy(); }
	opened.store.write(tx => assert.equal(tx.run("UPDATE native_runtime_settings SET sync_paused=1 WHERE singleton=1").changes, 1));
	inspect(opened.store, 1);
	checkpoint = 7;
	closeStore(opened.store, opened.key);
	const encrypted = fs.readFileSync(filename);
	assert(!encrypted.subarray(0, 16).equals(Buffer.from("SQLite format 3\0")));
	assert(!encrypted.includes(Buffer.from("fixture.storage_check")));
	checkpoint = 8;
	opened = bare(filename); inspect(opened.store, 1); verifyAudit(opened.store, opened.key); closeStore(opened.store, opened.key);
	checkpoint = 9;
	const copied = path.join(profile, "copy.db"), before = digest(fs.readFileSync(filename));
	assert(fs.lstatSync(filename).isFile() && !fs.lstatSync(filename).isSymbolicLink());
	fs.copyFileSync(filename, copied);
	assert(fs.lstatSync(copied).isFile() && !fs.lstatSync(copied).isSymbolicLink());
	assert.equal(digest(fs.readFileSync(copied)), before); assert.equal(digest(fs.readFileSync(filename)), before);
	opened = bare(copied); inspect(opened.store, 1); verifyAudit(opened.store, opened.key); closeStore(opened.store, opened.key);
	checkpoint = 10;
	const corrupted = fs.readFileSync(copied); corrupted[0] ^= 0x80; fs.writeFileSync(copied, corrupted);
	refusedBare(copied);
	checkpoint = 11;
	if (mode === "refused-schema") {
		moveAsset(); refusedBare(filename); restoreAsset();
		const folder = path.join(profile, "foreign-migrations"); fs.mkdirSync(folder);
		fs.writeFileSync(path.join(folder, "0001_foreign.sql"), "CREATE TABLE core2_fixture_foreign(id INTEGER PRIMARY KEY) STRICT;\n");
		selectedFile(filename); const key = newKey();
		const store = new HubStore({ filename, nativeBinding: binding, masterKey: key, migrations: { fixtureforeign: folder } }); stores.add(store);
		await store.migrate("fixtureforeign"); closeStore(store, key);
		refusedBare(filename);
	}
	checkpoint = 12;
	receipt = { mode, nativeAddonPermission, networkAllowed, ok: true, schemas };
} catch {
	failed = true;
} finally {
	const cleanup = work => { try { work(); } catch { failed = true; checkpoint = 90; } };
	cleanup(restoreAsset);
	for (const store of stores) cleanup(() => store.close());
	for (const db of databases) cleanup(() => { if (db.open) db.close(); });
	for (const key of keys) cleanup(() => key.destroy());
	cleanup(() => seed?.fill(0));
	if (profile) {
		cleanup(() => {
			assert(path.dirname(profile) === stage && path.basename(profile).startsWith(".core2-storage-"));
			assert(!fs.lstatSync(profile).isSymbolicLink() && fs.realpathSync(profile) === profile);
			fs.rmSync(profile, { recursive: true }); assert(!fs.existsSync(profile));
		});
	}
	if (originalPragma) cleanup(() => { Database.prototype.pragma = originalPragma; });
	if (originalMigrate) cleanup(() => { HubStore.prototype.migrate = originalMigrate; });
}
process.stdout.write(JSON.stringify(failed ? { ok: false, checkpoint } : receipt) + "\n");
process.exitCode = failed ? 1 : 0;
