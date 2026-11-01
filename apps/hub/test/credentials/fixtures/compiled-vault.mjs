import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { AuditChain, CredentialRefreshError, CredentialVault, HubStore, MasterKey } from "./index.mjs";

assert.equal(process.permission?.has("net"), false);
assert.equal(process.execArgv.some(arg => arg.startsWith("--allow-net")), false);
const nativeBinding = process.argv[2];
assert.equal(typeof nativeBinding, "string");
const key = new MasterKey(randomBytes(32)), auditBytes = key.derive("audit");
const audit = new AuditChain(auditBytes);
auditBytes.fill(0);
const options = {
	filename: path.join(import.meta.dirname, "vault.db"), masterKey: key, nativeBinding,
	migrations: {
		audit: path.join(import.meta.dirname, "store/migrations/audit"),
		credentials: path.join(import.meta.dirname, "credentials/migrations"),
		fault: path.join(import.meta.dirname, "fault"),
	},
};
const secret = () => `DYTEST-${randomBytes(20).toString("hex")}`;
const account = { ownerKind: "account", ownerId: "01ARZ3NDEKTSV4RRFFQ69G5FA0", kind: "gmail-oauth" };
const provider = { ownerKind: "provider", ownerId: "01ARZ3NDEKTSV4RRFFQ69G5FA1", kind: "provider-key" };
const second = { ownerKind: "account", ownerId: "01ARZ3NDEKTSV4RRFFQ69G5FA2", kind: "gmail-oauth" };
const failedSave = { ownerKind: "account", ownerId: "01ARZ3NDEKTSV4RRFFQ69G5FA3", kind: "gmail-oauth" };
const expired = { kind: "gmail-oauth", accessToken: secret(), refreshToken: secret(), expiresAt: 0 };
const rotated = {
	kind: "gmail-oauth", accessToken: secret(), refreshToken: expired.refreshToken, expiresAt: Date.now() + 3_600_000,
};
const expiring = { kind: "gmail-oauth", accessToken: secret(), refreshToken: secret(), expiresAt: Date.now() + 600_000 };
const providerKey = { kind: "provider-key", key: secret() };
const secrets = [
	expired.accessToken, expired.refreshToken, rotated.accessToken, expiring.accessToken, expiring.refreshToken,
	providerKey.key,
];
let store, vault;
try {
	store = new HubStore({ ...options, create: true });
	assert.deepEqual(await store.migrate("audit"), ["0001_chain"]);
	assert.deepEqual(await store.migrate("credentials"), ["0001_credentials", "0002_sealed_credentials"]);
	vault = new CredentialVault(store, audit, key);
	const reference = store.write(tx => vault.createInTransaction(tx, account, expired, { kind: "cli", id: null }));
	const providerRef = store.write(tx => vault.createInTransaction(tx, provider, providerKey));
	const secondRef = store.write(tx => vault.createInTransaction(tx, second, expiring));
	const failedSaveRef = store.write(tx => vault.createInTransaction(tx, failedSave, expiring));
	let refreshes = 0;
	const generation = await vault.withCredential(reference, account, {
		requestClass: "read",
		refresh: async (value, use) => {
			refreshes++;
			assert.deepEqual(value, expired);
			assert.equal(use.generation, 2);
			return rotated;
		},
	}, (value, use) => {
		assert.deepEqual(value, rotated);
		return use.generation;
	});
	assert.equal(generation, 2);
	assert.equal(refreshes, 1);
	// Only a committed classified temporary failure restores the previous value.
	await assert.rejects(vault.withCredential(secondRef, second, {
		requestClass: "read", refreshAheadMs: 900_000,
		refresh: async () => { throw new CredentialRefreshError("temporary"); },
	}, () => "unsafe"), { code: "CREDENTIAL_UNAVAILABLE" });
	assert.deepEqual(await vault.withCredential(secondRef, second, { requestClass: "read" }, value => value), expiring);
	// Fail the first durable clear after a valid answer using a real deferred-COMMIT constraint.
	mkdirSync(options.migrations.fault);
	writeFileSync(path.join(options.migrations.fault, "0001_fail_clear.sql"), `
		CREATE TABLE clear_parent(id INTEGER PRIMARY KEY) STRICT;
		CREATE TABLE clear_child(id INTEGER REFERENCES clear_parent(id) DEFERRABLE INITIALLY DEFERRED) STRICT;
		CREATE TRIGGER clear_failure AFTER UPDATE ON credentials
		WHEN OLD.status='refreshing' AND NEW.status='refreshing' AND OLD.value IS NOT NULL AND NEW.value IS NULL
		BEGIN INSERT INTO clear_child(id) VALUES(1); END;
	`);
	await store.migrate("fault");
	let uses = 0;
	await assert.rejects(vault.withCredential(failedSaveRef, failedSave, {
		requestClass: "read", refreshAheadMs: 900_000, refresh: async () => rotated,
	}, () => { uses++; }), { code: "CREDENTIAL_UNAVAILABLE" });
	assert.equal(uses, 0);
	// An early refresh the hub never finishes cannot restore prior authority after reopen.
	let started, answer;
	const exchanging = new Promise(resolve => { started = resolve; });
	const answered = new Promise(resolve => { answer = resolve; });
	const interrupted = vault.withCredential(secondRef, second, {
		requestClass: "read",
		refreshAheadMs: 900_000,
		refresh: () => {
			started();
			return answered;
		},
	}, () => "unsafe").then(() => false, error => error?.code === "CREDENTIAL_UNAVAILABLE");
	await exchanging;
	assert.throws(() => vault.describe(secondRef, second), { code: "CREDENTIAL_UNAVAILABLE" });
	store.write(tx => vault.invalidateInTransaction(tx, reference, account, "revoke"));
	vault.destroy();
	store.close();
	store = new HubStore(options);
	vault = new CredentialVault(store, audit, key);
	assert.throws(() => vault.describe(reference, account), { code: "CREDENTIAL_UNAVAILABLE" });
	for (const [ref, owner] of [[secondRef, second], [failedSaveRef, failedSave]]) {
		await assert.rejects(vault.withCredential(ref, owner, { requestClass: "read" }, () => { uses++; }), { code: "CREDENTIAL_UNAVAILABLE" });
	}
	assert.equal(uses, 0);
	answer({ ...rotated });
	assert.equal(await interrupted, true);
	store.write(tx => {
		vault.replaceInTransaction(tx, secondRef, second, rotated);
		vault.replaceInTransaction(tx, failedSaveRef, failedSave, rotated);
	});
	assert.deepEqual(await vault.withCredential(secondRef, second, { requestClass: "read" }, value => value), rotated);
	assert.equal(await vault.withCredential(providerRef, provider, { requestClass: "read" }, value => value.key), providerKey.key);
	const rows = store.read(db => [reference, providerRef, secondRef].map(id =>
		db.get("SELECT kind,data_class,status,generation,value FROM main.credentials WHERE id=?", [id])));
	assert.deepEqual(rows.map(row => [row.kind, row.data_class, row.status, row.generation, row.value?.[0] ?? null]), [
		["gmail-oauth", "credentials", "revoked", 3, null],
		["provider-key", "credentials", "active", 1, 1],
		["gmail-oauth", "credentials", "active", 5, 1],
	]);
	for (const row of rows) for (const text of secrets) assert.equal(Buffer.from(row.value ?? []).includes(text), false);
	const actions = store.read(db => db.all("SELECT action FROM main.audit_events ORDER BY seq")).map(row => row.action);
	assert.equal(actions.filter(action => action === "credential.restored").length, 1);
	assert.deepEqual(actions.slice(-2), ["credential.replaced", "credential.replaced"]);
	store.read(db => audit.verify(db));
	process.stdout.write(JSON.stringify({ ok: true, refreshed: true, restored: true, interruptedClosed: true, failedSaveClosed: true, revoked: true, sealed: true, network: false }) + "\n");
} finally {
	vault?.destroy(); store?.close(); audit.destroy(); key.destroy();
}
