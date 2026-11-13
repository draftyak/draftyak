import "reflect-metadata";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { lstat, mkdtemp, realpath, rm, stat } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

assert.equal(process.argv.length, 4);
const [bindingArgument, mode] = process.argv.slice(2);
assert.ok(mode === "cached" || mode === "closed-before-use");
assert.equal(typeof bindingArgument, "string");
assert.ok(path.isAbsolute(bindingArgument));
const nativeBinding = await realpath(bindingArgument);
assert.equal(path.extname(nativeBinding), ".node");
assert.ok((await stat(nativeBinding)).isFile());
const stage = await realpath(import.meta.dirname);
const entry = await realpath(path.join(stage, "index.mjs"));
assert.equal(path.dirname(entry), stage);
assert.ok((await stat(entry)).isFile());

// All Hub constructors and receivers belong to this one staged compiled namespace.
const hub = await import(pathToFileURL(entry).href);
for (const name of ["openHubSession", "MasterKey"])
	assert.equal(typeof hub[name], "function");
assert.equal(Object.hasOwn(hub, "NativeAccountApprovals"), false);
assert.equal(hub.NativeAccountApprovals, undefined);
const checks = ["single-compiled-namespace", "approval-constructor-not-exported"];
const methods = ["accept", "issue", "open", "review"];
const prefix = "native-account-approvals-session-";
const folder = await realpath(await mkdtemp(path.join(stage, prefix)));
const owned = await lstat(folder, { bigint: true });
assert.ok(owned.isDirectory() && !owned.isSymbolicLink() && owned.ino > 0n);
const seed = randomBytes(32);
const purpose = "ext/compiled-account-approvals-lifecycle";
let active;
let originalKey;
let reopenedKey;
let completed = false;
let originalFacade;
const preBootstrapWitnesses = [];

function newKey() {
	const material = Buffer.from(seed);
	try {
		return new hub.MasterKey(material);
	} finally {
		material.fill(0);
	}
}
function liveKey(key) {
	const derived = key.derive(purpose);
	try {
		assert.ok(Buffer.isBuffer(derived) && derived.length > 0);
	} finally {
		derived.fill(0);
	}
}
function readable(store) {
	assert.equal(store.read((sql) => sql.get("SELECT 1 AS alive"))?.alive, 1);
}
function preBootstrapState(session) {
	const observed = session.store.read((sql) => {
		const users = sql.get("SELECT COUNT(*) AS n FROM main.users");
		const authority = sql.get(
			"SELECT bootstrap_done, owner_user_id FROM main.device_authority WHERE singleton=1",
		);
		assert.ok(users && authority);
		return { users: users.n, bootstrapDone: authority.bootstrap_done, ownerUserId: authority.owner_user_id };
	});
	assert.deepEqual(observed, { users: 0, bootstrapDone: 0, ownerUserId: null });
	return Object.freeze(observed);
}
function observedGetter(session, phase, call) {
	const before = preBootstrapState(session);
	checks.push(phase + "-" + call + "-zero-users-before-getter");
	const facade = session.accountApprovals();
	const after = preBootstrapState(session);
	checks.push(phase + "-" + call + "-zero-users-after-getter");
	preBootstrapWitnesses.push({ phase, call, before, after });
	return facade;
}
function frozenFacade(session, prefix) {
	const facade = observedGetter(session, prefix, "first");
	assert.ok(Object.isFrozen(facade));
	checks.push(prefix + "-facade-frozen");
	assert.deepEqual(Reflect.ownKeys(facade).sort(), methods);
	for (const name of methods) assert.equal(typeof facade[name], "function");
	checks.push(prefix + "-facade-exact-methods");
	assert.equal(observedGetter(session, prefix, "cached"), facade);
	checks.push(prefix + "-facade-cached");
	return facade;
}
function closed(session, key, store, prefix) {
	assert.throws(() => session.accountApprovals());
	checks.push(prefix + "-getter-refused");
	assert.throws(() => key.derive(purpose));
	checks.push(prefix + "-key-erased");
	assert.throws(() => store.read((sql) => sql.get("SELECT 1 AS alive")));
	checks.push(prefix + "-store-closed");
}
async function removeOwnedFolder() {
	const named = await lstat(folder, { bigint: true });
	assert.equal(path.dirname(folder), stage);
	assert.ok(path.basename(folder).startsWith(prefix));
	assert.ok(named.isDirectory() && !named.isSymbolicLink());
	assert.equal(named.dev, owned.dev);
	assert.equal(named.ino, owned.ino);
	assert.equal(await realpath(folder), folder);
	await rm(folder, { recursive: true, force: true });
	await assert.rejects(lstat(folder), (error) => error?.code === "ENOENT");
}

try {
	originalKey = newKey();
	liveKey(originalKey);
	checks.push("original-key-live");
	const original = await hub.openHubSession({ folder, nativeBinding, masterKey: originalKey });
	active = original;
	assert.equal(typeof original.hubId, "string");
	assert.equal(typeof original.hid, "string");
	const hubId = original.hubId;
	const hid = original.hid;
	const originalStore = original.store;
	readable(originalStore);
	checks.push("original-store-readable");
	if (mode === "cached") {
		originalFacade = frozenFacade(original, "original");
	}
	// In closed-before-use mode the first getter invocation is deliberately after close.
	await original.close();
	active = undefined;
	closed(original, originalKey, originalStore, "original");
	await original.close();
	checks.push("original-repeat-close-resolved");

	reopenedKey = newKey();
	liveKey(reopenedKey);
	assert.notEqual(reopenedKey, originalKey);
	const reopened = await hub.openHubSession({ folder, nativeBinding, masterKey: reopenedKey });
	active = reopened;
	assert.equal(reopened.hubId, hubId);
	assert.equal(reopened.hid, hid);
	checks.push("same-seed-reopen-original-hub");
	const reopenedStore = reopened.store;
	readable(reopenedStore);
	checks.push("reopened-store-readable");
	const reopenedFacade = frozenFacade(reopened, "reopened");
	if (mode === "cached") {
		assert.notEqual(reopenedFacade, originalFacade);
		checks.push("facade-is-per-session");
	}
	await reopened.close();
	active = undefined;
	closed(reopened, reopenedKey, reopenedStore, "reopened");
	completed = true;
} finally {
	seed.fill(0);
	// If a genuine close fails, retain its owned folder instead of reporting successful cleanup.
	if (active !== undefined) await active.close();
	await removeOwnedFolder();
}
assert.equal(completed, true);
const expectedWitnesses = mode === "cached" ? 4 : 2;
const beforeBootstrap = preBootstrapWitnesses.length === expectedWitnesses &&
	preBootstrapWitnesses.every(({ before, after }) => [before, after].every(
		(state) => state.users === 0 && state.bootstrapDone === 0 && state.ownerUserId === null,
	));
assert.equal(beforeBootstrap, true);
checks.push("owned-directory-removed");
process.stdout.write(
	JSON.stringify({
		schema: "native-account-approvals-session/v1",
		mode,
		checks,
		beforeBootstrap,
		preBootstrapWitnesses,
	}) + "\n",
);
