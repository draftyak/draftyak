import "reflect-metadata";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import {
	chmodSync, lstatSync, mkdtempSync,
	readFileSync, realpathSync, rmSync, unlinkSync, writeFileSync,
} from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";

// Named expected Source inventory; every receipt count below comes from actual SQL rows.
const EXPECTED = {"businessTables":["accounts","approval_challenges","approval_pins","approvals","audit_events","audit_meta","credentials","device_authority","devices","event_meta","events","hub_meta","jobs","jobs_meta","native_admin_challenges","native_admin_operations","native_backup_challenges","native_backup_operations","native_backup_recovery","native_draft_locks","native_draft_revisions","native_drafts","native_send_attempts","outbox","owner_settings","pair_confirm_operations","plugin_candidates","plugin_generations","plugin_registry_identities","plugin_versions","users"],"bookkeepingTables":["_migrations_accounts","_migrations_accounts_lock","_migrations_admin","_migrations_admin_lock","_migrations_adminchallenges","_migrations_adminchallenges_lock","_migrations_audit","_migrations_audit_lock","_migrations_backup","_migrations_backup_lock","_migrations_backupchallenges","_migrations_backupchallenges_lock","_migrations_backupops","_migrations_backupops_lock","_migrations_challenges","_migrations_challenges_lock","_migrations_core","_migrations_core_lock","_migrations_credentials","_migrations_credentials_lock","_migrations_devices","_migrations_devices_lock","_migrations_events","_migrations_events_lock","_migrations_jobs","_migrations_jobs_lock","_migrations_outbox","_migrations_outbox_lock","_migrations_ownersettings","_migrations_ownersettings_lock","_migrations_pluginregistry","_migrations_pluginregistry_lock","_migrations_revisions","_migrations_revisions_lock","_migrations_tickets","_migrations_tickets_lock","_migrations_verifier","_migrations_verifier_lock"],"namespaces":[{"namespace":"audit","ledger":"_migrations_audit","migrations":["0001_chain"]},{"namespace":"core","ledger":"_migrations_core","migrations":["0001_identity"]},{"namespace":"devices","ledger":"_migrations_devices","migrations":["0001_devices"]},{"namespace":"jobs","ledger":"_migrations_jobs","migrations":["0001_jobs"]},{"namespace":"events","ledger":"_migrations_events","migrations":["0001_events"]},{"namespace":"revisions","ledger":"_migrations_revisions","migrations":["0001_native_revisions","0002_immutable_revisions"]},{"namespace":"credentials","ledger":"_migrations_credentials","migrations":["0001_credentials","0002_sealed_credentials"]},{"namespace":"tickets","ledger":"_migrations_tickets","migrations":["0001_send_attempts"]},{"namespace":"accounts","ledger":"_migrations_accounts","migrations":["0001_accounts"]},{"namespace":"pluginregistry","ledger":"_migrations_pluginregistry","migrations":["0001_registry","0002_candidates"]},{"namespace":"outbox","ledger":"_migrations_outbox","migrations":["0001_proposals"]},{"namespace":"challenges","ledger":"_migrations_challenges","migrations":["0001_challenges"]},{"namespace":"verifier","ledger":"_migrations_verifier","migrations":["0001_approvals"]},{"namespace":"admin","ledger":"_migrations_admin","migrations":["0001_operations"]},{"namespace":"adminchallenges","ledger":"_migrations_adminchallenges","migrations":["0001_admin_challenges"]},{"namespace":"backup","ledger":"_migrations_backup","migrations":["0001_backup_recovery"]},{"namespace":"backupops","ledger":"_migrations_backupops","migrations":["0001_backup_operations"]},{"namespace":"backupchallenges","ledger":"_migrations_backupchallenges","migrations":["0001_backup_challenges"]},{"namespace":"ownersettings","ledger":"_migrations_ownersettings","migrations":["0001_owner_settings"]}]};
const FAULTS = {
	"missing-credentials": ["credentials/migrations/0001_credentials.sql", "missing"],
	"missing-sealed-credentials": ["credentials/migrations/0002_sealed_credentials.sql", "missing"],
	"invalid-credentials": ["credentials/migrations/0001_credentials.sql", "invalid"],
	"missing-revision-immutability": ["drafts/migrations/0002_immutable_revisions.sql", "missing"],
	"missing-devices": ["devices-migrations/0001_devices.sql", "missing"],
	"invalid-devices": ["devices-migrations/0001_devices.sql", "invalid"],
	"missing-accounts": ["accounts/migrations/0001_accounts.sql", "missing"],
	"missing-pluginregistry": ["plugins/registry/migrations/0001_registry.sql", "missing"],
	"missing-outbox": ["outbox/propose-migrations/0001_proposals.sql", "missing"],
	"missing-challenges": ["identity/challenges-migrations/0001_challenges.sql", "missing"],
	"missing-verifier": ["outbox/verifier-migrations/0001_approvals.sql", "missing"],
	"missing-admin": ["identity/admin-migrations/0001_operations.sql", "missing"],
	"missing-adminchallenges": ["identity/admin-challenge-migrations/0001_admin_challenges.sql", "missing"],
	"missing-backup": ["recovery/backup-migrations/0001_backup_recovery.sql", "missing"],
	"missing-backupops": ["identity/backup-migrations/0001_backup_operations.sql", "missing"],
	"missing-backupchallenges": ["identity/backup-challenge-migrations/0001_backup_challenges.sql", "missing"],
	"missing-owner-settings": ["api/migrations/0001_owner_settings.sql", "missing"],
};
assert.equal(process.argv.length, 5);
const [bindingArgument, mode, sourceHubArgument] = process.argv.slice(2);
assert.ok(mode === "positive" || Object.hasOwn(FAULTS, mode));
assert.ok(path.isAbsolute(bindingArgument) && path.isAbsolute(sourceHubArgument));
const binding = realpathSync.native(bindingArgument);
assert.equal(path.extname(binding), ".node");
assert.ok(lstatSync(binding).isFile() && !lstatSync(binding).isSymbolicLink());
const stage = realpathSync.native(import.meta.dirname);
const entry = realpathSync.native(path.join(stage, "index.mjs"));
assert.equal(path.dirname(entry), stage);
assert.ok(lstatSync(entry).isFile() && !lstatSync(entry).isSymbolicLink());
// sourceHubArgument describes wrapper placement only; no Source or old dist is read here.
const prefix = "compiled-session-current-";
const folder = realpathSync.native(mkdtempSync(path.join(stage, prefix)));
const born = lstatSync(folder, { bigint: true });
assert.ok(born.isDirectory() && !born.isSymbolicLink() && born.ino > 0n);
const seed = randomBytes(32), code = randomBytes(20);
const purpose = "ext/compiled-session-current";
const keys = [], phases = new Map(), active = new Set(), snapshots = [];
const observers = [];
let phase = "module", asset, completed = false, capsule;
const profile = path.join(folder, "draftyak.db");
const require = createRequire(import.meta.url);
const Database = require("better-sqlite3-multiple-ciphers");
const packageJson = JSON.parse(readFileSync(require.resolve("better-sqlite3-multiple-ciphers/package.json"), "utf8"));
assert.equal(packageJson.name, "better-sqlite3-multiple-ciphers");
assert.equal(packageJson.version, "13.0.3");
assert.equal(require("better-sqlite3-multiple-ciphers"), Database);
const addon = require(binding);
assert.equal(require(binding), addon);
assert.equal(typeof addon.Database, "function");
const prepareDescriptor = Object.getOwnPropertyDescriptor(Database.prototype, "prepare");
assert.ok(prepareDescriptor && typeof prepareDescriptor.value === "function");
const originalPrepare = prepareDescriptor.value;

function state() {
	let value = phases.get(phase);
	if (value === undefined) {
		value = { databases: new Set(), prepares: 0, pragmas: 0, nativeCloses: 0, identityCalls: 0, identityInventories: [] };
		phases.set(phase, value);
	}
	return value;
}
function installObserver(target, name, observe) {
	const descriptor = Object.getOwnPropertyDescriptor(target, name);
	assert.ok(descriptor && typeof descriptor.value === "function" && (descriptor.configurable || descriptor.writable));
	const original = descriptor.value;
	const wrapped = function (...args) {
		observe(this, args);
		return Reflect.apply(original, this, args);
	};
	Object.defineProperty(target, name, { ...descriptor, value: wrapped });
	observers.push({ target, name, descriptor, wrapped });
}
function names(rows) {
	return rows.map((row) => {
		assert.equal(typeof row.name, "string");
		return row.name;
	}).sort();
}
function identifier(value) {
	assert.match(value, /^[a-z_]+$/);
	return '"' + value + '"';
}
function measure(all) {
		const tables = names(all("SELECT name FROM main.sqlite_schema WHERE type='table' AND name NOT GLOB 'sqlite_*'"));
		assert.deepEqual(tables, [...EXPECTED.businessTables, ...EXPECTED.bookkeepingTables].sort());
		const namespaces = [];
		for (const item of EXPECTED.namespaces) {
			const applied = names(all(`SELECT name FROM main.${identifier(item.ledger)}`));
			assert.deepEqual(applied, [...item.migrations].sort());
			namespaces.push({ namespace: item.namespace, applied });
		}
		return {
			schemas: namespaces.length,
			businessTables: tables.filter((name) => !name.startsWith("_migrations_")).length,
			bookkeepingTables: tables.filter((name) => name.startsWith("_migrations_")).length,
			appliedMigrations: namespaces.reduce((n, item) => n + item.applied.length, 0),
			namespaces,
		};
}
function inventory(store) {
	return store.read((sql) => measure((text) => sql.all(text)));
}
function profileDatabase(receiver) {
	assert.ok(receiver instanceof Database);
	if (typeof receiver.name !== "string" || !path.isAbsolute(receiver.name)) return false;
	if (path.resolve(receiver.name) !== profile) return false;
	state().databases.add(receiver);
	return true;
}
// Install stock public delegates BEFORE Hub import so module-init capture uses these functions.
installObserver(Database.prototype, "pragma", (receiver) => {
	if (profileDatabase(receiver)) state().pragmas++;
});
installObserver(Database.prototype, "prepare", (receiver, args) => {
	if (!profileDatabase(receiver)) return;
	state().prepares++;
	const text = args[0];
	if (typeof text === "string" && /\bFROM\s+main\.hub_meta\b/iu.test(text) && /\bidentity_wrapped\b/u.test(text)) {
		state().identityCalls++;
		state().identityInventories.push(measure((query) => Reflect.apply(originalPrepare, receiver, [query]).all()));
	}
});
// The actual selected addon close is the public native boundary captured by current Store code.
installObserver(addon.Database.prototype, "close", () => { state().nativeCloses++; });
const hub = await import(pathToFileURL(entry).href);
for (const name of ["openHubSession", "MasterKey", "HubStore", "WorkDatabase", "EventLog", "NativeAccounts"])
	assert.equal(typeof hub[name], "function");
function closedProfile(observed) {
	assert.equal(observed.databases.size, 1, "Expected one actual owned profile wrapper database");
	assert.ok(observed.pragmas > 0 && observed.nativeCloses > 0);
	for (const database of observed.databases) {
		assert.equal(database.open, false);
		assert.throws(() => Reflect.apply(originalPrepare, database, ["SELECT 1 AS alive"]).get());
	}
}
function newKey() {
	const material = Buffer.from(seed);
	try {
		const key = new hub.MasterKey(material);
		keys.push(key);
		return key;
	} finally { material.fill(0); }
}
function alive(key) {
	const bytes = key.derive(purpose);
	try { assert.ok(Buffer.isBuffer(bytes) && bytes.length === 32); }
	finally { bytes.fill(0); }
}
function modules(session) {
	const values = session.extensions.modules;
	assert.ok(Array.isArray(values));
	assert.equal(values.length, 0);
	return values.length;
}
async function open(key, label) {
	phase = label;
	const session = await hub.openHubSession({ folder, nativeBinding: binding, masterKey: key });
	active.add(session);
	const observed = state();
	assert.ok(observed.identityCalls > 0, "Public identity-storage SQL observer was not exercised");
	assert.ok(observed.identityInventories.length === observed.identityCalls);
	assert.equal(observed.databases.size, 1);
	assert.ok(observed.prepares > 0 && observed.pragmas > 0);
	const observedInventory = inventory(session.store);
	assert.ok(observed.identityInventories.every((item) => JSON.stringify(item) === JSON.stringify(observedInventory)));
	snapshots.push(observedInventory);
	modules(session);
	return session;
}
function audit(session) {
	session.store.read((sql) => session.audit.verify(sql));
}
async function close(session, key) {
	const store = session.store;
	const observed = state(), beforeNativeClose = observed.nativeCloses;
	await session.close();
	active.delete(session);
	assert.ok(observed.nativeCloses > beforeNativeClose, "Actual native close delegate was not exercised");
	closedProfile(observed);
	assert.throws(() => store.read((sql) => sql.get("SELECT 1 AS alive")));
	assert.throws(() => key.derive(purpose));
	await session.close();
}
const account = {
	id: "00000000000000000000000020", userId: "00000000000000000000000090",
	pluginInstanceId: "00000000000000000000000099", alias: "compiled-session-account",
	channel: "email", address: "owner@example.invalid", mode: "full", status: "active",
	deletionDeadline: null, historyLimitDays: 30, disclosureVersion: 1, createdAt: 0,
};
function accounts(session) {
	const database = new hub.WorkDatabase(session.store);
	return { database, records: new hub.NativeAccounts(database, new hub.EventLog(database, () => 0), session.audit, () => 0) };
}
function roundTrip(session) {
	const { database, records } = accounts(session);
	const value = database.write((scope) => records.get(scope, account.userId, account.id));
	assert.ok(value && Object.isFrozen(value) && Object.isFrozen(value.account));
	assert.deepEqual(value, { account, generation: 1 });
	audit(session);
}
function ownedAsset(relative) {
	const file = path.resolve(stage, relative);
	assert.ok(file.startsWith(stage + path.sep));
	const row = lstatSync(file, { bigint: true });
	assert.ok(row.isFile() && !row.isSymbolicLink());
	assert.equal(realpathSync.native(file), file);
	return { file, bytes: readFileSync(file), mode: Number(row.mode & 0o777n) };
}
function restoreAsset() {
	if (asset === undefined) return;
	writeFileSync(asset.file, asset.bytes);
	chmodSync(asset.file, asset.mode);
	assert.deepEqual(readFileSync(asset.file), asset.bytes);
	assert.equal(Number(lstatSync(asset.file, { bigint: true }).mode & 0o777n), asset.mode);
	asset = undefined;
}
function capsuleShape(bytes) {
	assert.ok(Buffer.isBuffer(bytes));
	assert.equal(bytes.length, 94);
	assert.deepEqual(bytes.subarray(0, 18), Buffer.concat([Buffer.from("draftyak-recovery"), Buffer.of(1)]));
}
const capsuleFile = path.join(folder, "mk.recovery");
function capsuleRetained() {
	if (capsule !== undefined) assert.deepEqual(readFileSync(capsuleFile), capsule);
}
function removeOwnedFolder() {
	const now = lstatSync(folder, { bigint: true });
	assert.equal(path.dirname(folder), stage);
	assert.ok(path.basename(folder).startsWith(prefix));
	assert.ok(now.isDirectory() && !now.isSymbolicLink());
	assert.equal(now.dev, born.dev); assert.equal(now.ino, born.ino);
	assert.equal(realpathSync.native(folder), folder);
	rmSync(folder, { recursive: true, force: false });
	assert.throws(() => lstatSync(folder), (error) => error?.code === "ENOENT");
}

let failedOpenClosed = false, failedKeyErased = false, refused = null, moduleCount;
try {
	const firstKey = newKey();
	alive(firstKey);
	const first = await open(firstKey, "initial");
	const identity = { hubId: first.hubId, hid: first.hid };
	assert.ok(typeof identity.hubId === "string" && typeof identity.hid === "string");
	moduleCount = modules(first);
	const { database, records } = accounts(first);
	const created = database.write((scope) => records.create(scope, account));
	assert.deepEqual(created, { account, generation: 1 });
	roundTrip(first);
	if (mode === "positive") {
		capsule = firstKey.wrapRecovery(code);
		capsuleShape(capsule);
		const another = firstKey.wrapRecovery(code);
		try { capsuleShape(another); assert.ok(!capsule.equals(another)); }
		finally { another.fill(0); }
		assert.throws(() => firstKey.wrapRecovery(Buffer.alloc(19)));
		writeFileSync(capsuleFile, capsule, { flag: "wx", mode: 0o600 });
		capsuleRetained();
	}
	await close(first, firstKey);
	capsuleRetained();

	if (mode !== "positive") {
		const [relative, kind] = FAULTS[mode];
		asset = ownedAsset(relative);
		if (kind === "missing") unlinkSync(asset.file);
		else writeFileSync(asset.file, "THIS IS NOT VALID SQLITE MIGRATION SQL;\n");
		const failedKey = newKey();
		alive(failedKey);
		phase = "failed";
		let failure;
		try {
			const unexpected = await hub.openHubSession({ folder, nativeBinding: binding, masterKey: failedKey });
			active.add(unexpected);
		} catch (error) { failure = error; }
		finally { restoreAsset(); }
		assert.ok(failure instanceof hub.HubSessionError);
		assert.equal(failure.code, "STORE_UNAVAILABLE");
		refused = failure.code;
		const observed = state();
		assert.equal(observed.identityCalls, 0);
		closedProfile(observed);
		failedOpenClosed = true;
		assert.throws(() => failedKey.derive(purpose));
		failedKeyErased = true;
	}

	const reopenedKey = newKey();
	alive(reopenedKey);
	const reopened = await open(reopenedKey, "reopened");
	assert.deepEqual({ hubId: reopened.hubId, hid: reopened.hid }, identity);
	assert.equal(modules(reopened), moduleCount);
	roundTrip(reopened);
	capsuleRetained();
	if (capsule !== undefined) {
		const freshCapsule = reopenedKey.wrapRecovery(code);
		try { capsuleShape(freshCapsule); assert.ok(!capsule.equals(freshCapsule)); }
		finally { freshCapsule.fill(0); }
	}
	await close(reopened, reopenedKey);
	capsuleRetained();
	completed = true;
} finally {
	restoreAsset();
	try {
		for (const session of active) await session.close();
		active.clear();
	} finally {
		for (const key of keys) key.destroy();
		seed.fill(0); code.fill(0); capsule?.fill(0);
		for (const { target, name, descriptor, wrapped } of observers.reverse()) {
			assert.equal(Object.getOwnPropertyDescriptor(target, name)?.value, wrapped);
			Object.defineProperty(target, name, descriptor);
		}
	}
	removeOwnedFolder();
}
assert.equal(completed, true);
assert.ok(snapshots.length >= 2);
const actual = snapshots.at(-1);
assert.deepEqual(snapshots[0], actual);
process.stdout.write(JSON.stringify({
	ok: true, mode, schemas: actual.schemas, businessTables: actual.businessTables,
	bookkeepingTables: actual.bookkeepingTables, recoveryCapsule: mode === "positive",
	beforeIdentity: true, refused, failedOpenClosed, failedKeyErased,
	reopened: true, auditVerified: true, accountsRoundTrip: true, modules: moduleCount,
}) + "\n");
