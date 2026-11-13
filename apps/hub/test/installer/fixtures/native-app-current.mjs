// Signed application admission and original Session resource lifetimes.
import "reflect-metadata";
import "draftyak-test-native-app-prelude";
import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { linkSync, lstatSync, readFileSync, realpathSync, unlinkSync } from "node:fs";
import { mkdtemp } from "node:fs/promises";
import path from "node:path";
import {
	MasterKey,
	assertNativeAppAdmissionCurrent,
	assertNativePluginInstallerCatalogueCurrent,
	nativeAppAdmissionArchive,
	nativeAppAdmissionCandidateArchive,
	nativeAppAdmissionFormat,
	nativeAppAdmissionInputs,
	nativeAppAdmissionReviewInputs,
	nativePluginInstallerCatalogue,
	openHubSession,
	openNativeAppAdmission,
	openNativeBackupRecovery,
	openNativePluginInstaller,
} from "./native-app-current-support.mjs";

const modes = new Set([
	"positive", "ownership", "currentness", "signature", "pin", "identity", "close",
	"preloaded", "missing-flag", "duplicate-flag", "node-options", "node-path",
	"during-capture", "drain-retry", "recovery-starts", "recovery-held", "recovery-retry",
	"unconfigured", "candidate-installer",
]);
const refusalModes = new Set([
	"signature", "pin", "identity", "preloaded", "missing-flag", "duplicate-flag",
	"node-options", "node-path",
]);
const PROGRESS_TIMEOUT_MS = 5_000;
const EXPECTED = {"businessTables":["accounts","approval_challenges","approval_pins","approvals","audit_events","audit_meta","credentials","device_authority","devices","event_meta","events","hub_meta","jobs","jobs_meta","native_admin_challenges","native_admin_operations","native_backup_challenges","native_backup_operations","native_backup_recovery","native_draft_locks","native_draft_revisions","native_drafts","native_send_attempts","outbox","owner_settings","pair_confirm_operations","plugin_candidates","plugin_generations","plugin_registry_identities","plugin_versions","users"],"bookkeepingTables":["_migrations_accounts","_migrations_accounts_lock","_migrations_admin","_migrations_admin_lock","_migrations_adminchallenges","_migrations_adminchallenges_lock","_migrations_audit","_migrations_audit_lock","_migrations_backup","_migrations_backup_lock","_migrations_backupchallenges","_migrations_backupchallenges_lock","_migrations_backupops","_migrations_backupops_lock","_migrations_challenges","_migrations_challenges_lock","_migrations_core","_migrations_core_lock","_migrations_credentials","_migrations_credentials_lock","_migrations_devices","_migrations_devices_lock","_migrations_events","_migrations_events_lock","_migrations_jobs","_migrations_jobs_lock","_migrations_outbox","_migrations_outbox_lock","_migrations_ownersettings","_migrations_ownersettings_lock","_migrations_pluginregistry","_migrations_pluginregistry_lock","_migrations_revisions","_migrations_revisions_lock","_migrations_tickets","_migrations_tickets_lock","_migrations_verifier","_migrations_verifier_lock"],"namespaces":[{"namespace":"audit","ledger":"_migrations_audit","migrations":["0001_chain"]},{"namespace":"core","ledger":"_migrations_core","migrations":["0001_identity"]},{"namespace":"devices","ledger":"_migrations_devices","migrations":["0001_devices"]},{"namespace":"jobs","ledger":"_migrations_jobs","migrations":["0001_jobs"]},{"namespace":"events","ledger":"_migrations_events","migrations":["0001_events"]},{"namespace":"revisions","ledger":"_migrations_revisions","migrations":["0001_native_revisions","0002_immutable_revisions"]},{"namespace":"credentials","ledger":"_migrations_credentials","migrations":["0001_credentials","0002_sealed_credentials"]},{"namespace":"tickets","ledger":"_migrations_tickets","migrations":["0001_send_attempts"]},{"namespace":"accounts","ledger":"_migrations_accounts","migrations":["0001_accounts"]},{"namespace":"pluginregistry","ledger":"_migrations_pluginregistry","migrations":["0001_registry","0002_candidates"]},{"namespace":"outbox","ledger":"_migrations_outbox","migrations":["0001_proposals"]},{"namespace":"challenges","ledger":"_migrations_challenges","migrations":["0001_challenges"]},{"namespace":"verifier","ledger":"_migrations_verifier","migrations":["0001_approvals"]},{"namespace":"admin","ledger":"_migrations_admin","migrations":["0001_operations"]},{"namespace":"adminchallenges","ledger":"_migrations_adminchallenges","migrations":["0001_admin_challenges"]},{"namespace":"backup","ledger":"_migrations_backup","migrations":["0001_backup_recovery"]},{"namespace":"backupops","ledger":"_migrations_backupops","migrations":["0001_backup_operations"]},{"namespace":"backupchallenges","ledger":"_migrations_backupchallenges","migrations":["0001_backup_challenges"]},{"namespace":"ownersettings","ledger":"_migrations_ownersettings","migrations":["0001_owner_settings"]}]};
let checkpoint = 0;
let mode = "entry";
let completed = false;
const sessions = [];
const keys = [];
const seeds = [];
const operations = [];
let io;

function ordinary(name, type) {
	const stat = lstatSync(name);
	assert.equal(stat.isSymbolicLink(), false);
	assert.equal(type === "file" ? stat.isFile() : stat.isDirectory(), true);
	assert.equal(realpathSync.native(name), name);
	return stat;
}
function unhandledMode() {
	checkpoint = 63;
	throw new Error("UNHANDLED_MODE");
}
function track(promise) {
	operations.push(promise);
	void promise.then(() => {}, () => {});
	return promise;
}
async function progress(promise) {
	let timer;
	try {
		return await Promise.race([
			promise,
			new Promise((_, reject) => {
				timer = setTimeout(() => reject(new Error("LIFECYCLE_PROGRESS_DEADLINE")), PROGRESS_TIMEOUT_MS);
			}),
		]);
	} finally {
		clearTimeout(timer);
	}
}
async function refused(work) {
	const operation = track(Promise.resolve().then(work));
	await progress(assert.rejects(operation));
}
async function waitFor(predicate) {
	const started = Date.now();
	while (!predicate()) {
		assert.equal(Date.now() - started < PROGRESS_TIMEOUT_MS, true);
		await new Promise((resolve) => setTimeout(resolve, 5));
	}
}
async function reached(signal, operation) {
	await progress(Promise.race([
		signal,
		operation.then(
			() => { throw new Error("EXPECTED_HELD_OPERATION"); },
			() => { throw new Error("EXPECTED_HELD_OPERATION"); },
		),
	]));
}
function makeKey() {
	const seed = randomBytes(32);
	seeds.push(seed);
	const copy = Buffer.from(seed);
	try {
		const key = new MasterKey(copy);
		keys.push(key);
		return key;
	} finally {
		copy.fill(0);
	}
}
async function originalSession(folder, nativeBinding) {
	const key = makeKey();
	const original = await openHubSession({ folder, nativeBinding, masterKey: key });
	const record = { original, key, store: original.store, closed: false };
	sessions.push(record);
	assert.equal(original.store.read((sql) => sql.get("SELECT 1 AS alive"))?.alive, 1);
	return record;
}
function assertClosed(record) {
	assert.throws(() => record.store.read((sql) => sql.get("SELECT 1 AS alive")));
	assert.throws(() => record.key.derive("ext/native-app-current-workload"));
}
async function close(record) {
	await record.original.close();
	record.closed = true;
	assertClosed(record);
	await record.original.close();
}
function releaseGates() {
	if (!io) return;
	io.failClose = false;
	io.releaseOpen();
	io.releaseClose();
	if (io.recovery) {
		io.recovery.failRecoveryClose = false;
		io.recovery.releaseOpen();
		io.recovery.releaseApp();
	}
}
async function cleanup() {
	releaseGates();
	await Promise.allSettled(operations);
	let failed = false;
	for (const record of [...sessions].reverse()) {
		try {
			await record.original.close();
			record.closed = true;
			assertClosed(record);
		} catch {
			failed = true;
		}
	}
	if (io?.recovery) {
		try { await io.recovery.cleanup(); } catch { failed = true; }
	}
	if (io) {
		try { await io.cleanup(); } catch { failed = true; }
	}
	for (const key of keys) {
		try { key.destroy(); } catch { failed = true; }
	}
	for (const seed of seeds) seed.fill(0);
	assert.equal(failed, false);
}
function assertModeInputs() {
	const startup = process.execArgv;
	if (mode === "missing-flag") assert.deepEqual(startup, []);
	else if (mode === "preloaded") assert.deepEqual(startup, ["--disable-sigusr1", "--no-warnings"]);
	else if (mode === "duplicate-flag")
		assert.deepEqual(startup, ["--disable-sigusr1", "--disable-sigusr1"]);
	else assert.deepEqual(startup, ["--disable-sigusr1"]);
	assert.equal(process.env.NODE_ENV, "test");
	assert.equal(process.env.NODE_OPTIONS, mode === "node-options" ? "--no-warnings" : undefined);
	assert.equal(process.env.NODE_PATH, mode === "node-path" ? "DYTEST-unused-node-path" : undefined);
}
function measuredInventory(original) {
	return original.store.read((sql) => {
		const names = (rows) => rows.map((row) => {
			assert.equal(typeof row.name, "string");
			return row.name;
		}).sort();
		const observed = names(sql.all(
			"SELECT name FROM main.sqlite_schema WHERE type='table' AND name NOT GLOB 'sqlite_*'",
		));
		assert.deepEqual(observed, [...EXPECTED.businessTables, ...EXPECTED.bookkeepingTables].sort());
		let schemas = 0, appliedMigrations = 0;
		for (const item of EXPECTED.namespaces) {
			assert.match(item.ledger, /^[a-z_]+$/);
			const applied = names(sql.all('SELECT name FROM main."' + item.ledger + '"'));
			assert.deepEqual(applied, [...item.migrations].sort());
			schemas++;
			appliedMigrations += applied.length;
		}
		assert.equal(appliedMigrations, 22);
		return schemas;
	});
}
function appFile(app, relative) {
	assert.equal(typeof relative, "string");
	assert.equal(relative.length > 0, true);
	assert.equal(relative.includes("\\"), false);
	assert.equal(relative.includes("\0"), false);
	assert.equal(path.posix.isAbsolute(relative), false);
	assert.equal(path.posix.normalize(relative), relative);
	assert.equal(relative.split("/").includes(".."), false);
	const result = path.resolve(app, relative);
	const joined = path.relative(app, result);
	assert.equal(path.isAbsolute(joined), false);
	assert.equal(joined === ".." || joined.startsWith(".." + path.sep), false);
	ordinary(result, "file");
	return result;
}
async function admitted(record, format) {
	const callerCheckpoint = checkpoint;
	checkpoint = 20;
	const admission = await openNativeAppAdmission(record.original);
	checkpoint = 21;
	assert.equal(typeof admission.close, "function");
	if (format === 2) {
		checkpoint = 22;
		assert.doesNotThrow(() => assertNativeAppAdmissionCurrent(admission, record.original));
	}
	checkpoint = 23;
	const observedFormat = await nativeAppAdmissionFormat(record.original);
	checkpoint = 24;
	assert.equal(observedFormat, format);
	checkpoint = callerCheckpoint;
	return admission;
}
function pin(row) {
	assert.ok(row && typeof row === "object");
	assert.equal(typeof row.id, "string");
	assert.ok(row.package && typeof row.package === "object");
	const lock = {};
	for (const name of ["name", "version", "integrity", "entry"]) {
		assert.equal(typeof row.package[name], "string");
		lock[name] = row.package[name];
	}
	return { id: row.id, package: lock };
}
function pins(rows) {
	assert.equal(Array.isArray(rows), true);
	return rows.map(pin).sort((a, b) =>
		a.id.localeCompare(b.id) || a.package.version.localeCompare(b.package.version),
	);
}
function facts(rows) {
	assert.equal(Array.isArray(rows), true);
	return rows.map((row) => {
		const projected = pin(row);
		assert.equal(typeof row.expectedSurfaceDigest, "string");
		return { ...projected, expectedSurfaceDigest: row.expectedSurfaceDigest };
	}).sort((a, b) => a.id.localeCompare(b.id) || a.package.version.localeCompare(b.package.version));
}
function keyed(rows, project, key) {
	assert.equal(Array.isArray(rows), true);
	const result = new Map();
	for (const row of rows) {
		const value = project(row);
		const id = key(value);
		if (result.has(id)) assert.deepEqual(result.get(id), value);
		result.set(id, value);
	}
	return result;
}
function requiredEntries(actual, expected, project, key) {
	const observed = keyed(actual, project, key);
	for (const [id, value] of keyed(expected, project, key)) {
		assert.equal(observed.has(id), true);
		assert.deepEqual(observed.get(id), value);
	}
}
function surface(row) {
	assert.ok(row && typeof row === "object");
	for (const name of ["id", "version", "expectedSurfaceDigest"])
		assert.equal(typeof row[name], "string");
	return { id: row.id, version: row.version, expectedSurfaceDigest: row.expectedSurfaceDigest };
}
const pinKey = (row) => JSON.stringify([row.id, row.package.version]);
const surfaceKey = (row) => JSON.stringify([row.id, row.version]);
async function inputData(record, admission, manifest) {
	const callerCheckpoint = checkpoint;
	checkpoint = 30;
	const inputs = await nativeAppAdmissionInputs(admission, record.original);
	checkpoint = 31;
	assert.equal(inputs.version, manifest.version);
	checkpoint = 32;
	assert.deepEqual(pins(inputs.bundles), pins(manifest.bundles));
	checkpoint = callerCheckpoint;
	return inputs;
}
async function selectedArchives(record, admission, app, manifest) {
	const callerCheckpoint = checkpoint;
	const ids = new Set();
	for (const selected of manifest.bundles) {
		checkpoint = 40;
		assert.equal(typeof selected.id, "string");
		assert.equal(ids.has(selected.id), false);
		ids.add(selected.id);
		checkpoint = 41;
		const archivePath = appFile(app, selected.archive);
		const file = manifest.files.find((row) => row.path === selected.archive);
		assert.ok(file);
		checkpoint = 42;
		const staged = readFileSync(archivePath);
		checkpoint = 43;
		assert.equal(staged.length, file.bytes);
		assert.equal(createHash("sha256").update(staged).digest("hex"), file.sha256);
		checkpoint = 44;
		const captured = await nativeAppAdmissionArchive(admission, record.original, selected.id);
		checkpoint = 45;
		assert.equal(captured instanceof Uint8Array, true);
		checkpoint = 46;
		assert.deepEqual(Buffer.from(captured), staged);
	}
	checkpoint = 47;
	assert.equal(ids.size, 5);
	checkpoint = callerCheckpoint;
}
async function positive(record, app, manifest) {
	const admission = await admitted(record, 1);
	await inputData(record, admission, manifest);
	await selectedArchives(record, admission, app, manifest);
	return admission;
}
async function ownership(record, profile, nativeBinding, app, manifest) {
	const admission = await positive(record, app, manifest);
	const otherFolder = await mkdtemp(path.join(profile, "native-app-other-session-"));
	ordinary(otherFolder, "directory");
	const other = await originalSession(otherFolder, nativeBinding);
	assert.notEqual(other.original, record.original);
	assert.notEqual(other.store, record.store);
	await refused(() => nativeAppAdmissionInputs(admission, other.original));
	await refused(() => nativeAppAdmissionArchive(
		admission, other.original, manifest.bundles[0].id,
	));
	await inputData(record, admission, manifest);
	await close(other);
}
async function closedSession(record, app, manifest) {
	const admission = await positive(record, app, manifest);
	await close(record);
	await refused(() => nativeAppAdmissionArchive(
		admission, record.original, manifest.bundles[0].id,
	));
	await refused(() => openNativeAppAdmission(record.original));
}
async function currentness(record, app, profile, manifest) {
	const admission = await positive(record, app, manifest);
	const relative = manifest.bundles[0]?.archive;
	assert.equal(typeof relative, "string");
	assert.equal(relative.startsWith("bundles/"), true);
	assert.equal(relative.includes("\\"), false);
	assert.equal(relative.includes("\0"), false);
	assert.equal(path.posix.normalize(relative), relative);
	assert.equal(relative.split("/").includes(".."), false);
	const source = path.resolve(app, relative);
	assert.equal(path.relative(app, source).startsWith(".."), false);
	const original = ordinary(source, "file");
	assert.equal(original.nlink, 1);
	const linked = path.join(profile, "native-app-currentness-owned-link.tgz");
	linkSync(source, linked);
	try {
		const current = ordinary(linked, "file");
		assert.equal(current.dev, original.dev);
		assert.equal(current.ino, original.ino);
		assert.equal(current.nlink, 2);
		await refused(() => nativeAppAdmissionArchive(
			admission, record.original, manifest.bundles[0].id,
		));
	} finally {
		const named = lstatSync(linked);
		assert.equal(named.isSymbolicLink(), false);
		assert.equal(named.dev, original.dev);
		assert.equal(named.ino, original.ino);
		unlinkSync(linked);
	}
}
async function duringCapture(record, manifest) {
	let openingSettled = false;
	const opening = track(openNativeAppAdmission(record.original));
	void opening.then(() => { openingSettled = true; }, () => { openingSettled = true; });
	await reached(io.openReached, opening);
	assert.equal(openingSettled, false);
	assert.equal(io.opened > 0, true);
	assert.equal(io.appOnly(), true);
	assert.equal(io.firstIsManifest(), true);
	let closeSettled = false;
	const closing = track(record.original.close());
	void closing.then(() => { closeSettled = true; }, () => { closeSettled = true; });
	await new Promise((resolve) => setImmediate(resolve));
	assert.equal(closeSettled, false);
	assert.equal(io.remaining() > 0, true);
	await refused(() => openNativeAppAdmission(record.original));
	io.releaseOpen();
	const [admitted, closed] = await Promise.allSettled([opening, closing]);
	assert.equal(closed.status, "fulfilled");
	record.closed = true;
	assertClosed(record);
	if (admitted.status === "fulfilled") {
		await refused(() => nativeAppAdmissionArchive(
			admitted.value, record.original, manifest.bundles[0].id,
		));
	}
	assert.equal(io.remaining(), 0);
	assert.equal(io.closed, io.opened);
	assert.equal(io.firstAttempts() > 0, true);
	await record.original.close();
}
async function drainRetry(record, app, manifest) {
	const admission = await positive(record, app, manifest);
	assert.equal(io.opened > 1, true);
	assert.equal(io.remaining() > 1, true);
	assert.equal(io.closed + io.remaining(), io.opened);
	assert.equal(io.appOnly(), true);
	assert.equal(io.firstIsManifest(), true);
	io.failClose = true;
	let settled = false;
	const first = track(record.original.close());
	void first.then(() => { settled = true; }, () => { settled = true; });
	await reached(io.closeReached, first);
	await refused(() => nativeAppAdmissionArchive(
		admission, record.original, manifest.bundles[0].id,
	));
	await refused(() => openNativeAppAdmission(record.original));
	assert.equal(await progress(Promise.race([
		io.otherCloseSettled,
		first.then(() => false, () => false),
	])), true);
	await new Promise((resolve) => setImmediate(resolve));
	assert.equal(settled, false);
	assert.equal(io.firstAttempts(), 1);
	assert.equal(io.remaining(), 1);
	io.releaseClose();
	await progress(assert.rejects(first));
	await refused(() => nativeAppAdmissionArchive(
		admission, record.original, manifest.bundles[0].id,
	));
	await refused(() => openNativeAppAdmission(record.original));
	const live = record.key.derive("ext/native-app-current-retry");
	try { assert.equal(Buffer.isBuffer(live) && live.length > 0, true); }
	finally { live.fill(0); }
	assert.equal(io.remaining(), 1);
	await close(record);
	assert.equal(io.firstAttempts(), 2);
	assert.equal(io.remaining(), 0);
	assert.equal(io.closed, io.opened);
	await refused(() => nativeAppAdmissionArchive(
		admission, record.original, manifest.bundles[0].id,
	));
}
async function candidateInstaller(record, app, manifest) {
	assert.equal(manifest.v, 2);
	assert.equal(Array.isArray(manifest.candidates), true);
	assert.equal(manifest.candidates.length, 1);
	const candidate = manifest.candidates[0];
	assert.equal(candidate.id, "channel-gmail");
	assert.equal(candidate.package.version, "99.2.3");
	const admission = await admitted(record, 2);
	await inputData(record, admission, manifest);
	await selectedArchives(record, admission, app, manifest);
	const review = await nativeAppAdmissionReviewInputs(admission, record.original);
	assert.equal(review.version, manifest.version);
	assert.deepEqual(facts(review.bundles), facts(manifest.bundles));
	assert.deepEqual(facts(review.candidates), facts(manifest.candidates));

	const installer = await openNativePluginInstaller(record.original);
	assert.equal(await openNativePluginInstaller(record.original), installer);
	const catalogue = await nativePluginInstallerCatalogue(record.original);
	assert.equal(catalogue.mode, "v2-data");
	const declared = [...review.bundles, ...review.candidates];
	requiredEntries(catalogue.pins, declared, pin, pinKey);
	requiredEntries(catalogue.expectedSurfaces, declared.map((row) => ({
		id: row.id, version: row.package.version, expectedSurfaceDigest: row.expectedSurfaceDigest,
	})), surface, surfaceKey);
	assert.doesNotThrow(() => assertNativePluginInstallerCatalogueCurrent(
		record.original, installer, catalogue,
	));

	const file = manifest.files.find((row) => row.path === candidate.archive);
	assert.ok(file);
	const staged = readFileSync(appFile(app, candidate.archive));
	assert.equal(staged.length, file.bytes);
	assert.equal(createHash("sha256").update(staged).digest("hex"), file.sha256);
	const captured = await nativeAppAdmissionCandidateArchive(
		admission, record.original, candidate.id, candidate.package.version,
	);
	assert.equal(captured instanceof Uint8Array, true);
	assert.deepEqual(Buffer.from(captured), staged);
	await refused(() => nativeAppAdmissionCandidateArchive(
		admission, record.original, candidate.id, "99.2.4",
	));
	await refused(() => nativeAppAdmissionCandidateArchive(
		admission, record.original, "channel-slack", candidate.package.version,
	));
	// Expected surface digests are signed fixture DATA, not measured surfaces or permission.
	// No inspect, installation, promotion, review approval or sending occurs here.
	await close(record);
	assert.throws(() => assertNativeAppAdmissionCurrent(admission, record.original));
	assert.throws(() => assertNativePluginInstallerCatalogueCurrent(
		record.original, installer, catalogue,
	));
	await refused(() => nativePluginInstallerCatalogue(record.original));
}
function keyLive(record) {
	const material = record.key.derive("ext/native-app-current-recovery");
	try { assert.equal(Buffer.isBuffer(material) && material.length > 0, true); }
	finally { material.fill(0); }
}
async function recoveryLifetime(record, app, manifest) {
	checkpoint = 5;
	const observed = io.recovery;
	assert.ok(observed);
	const recovery = openNativeBackupRecovery(record.original);
	for (const name of ["enroll", "adopt", "readCapsule", "lock", "close"])
		assert.equal(typeof recovery[name], "function");
	const code = randomBytes(20);
	seeds.push(code);
	const enrolling = track(Promise.resolve().then(() => recovery.enroll(code)));
	let enrolledSettled = false;
	void enrolling.then(() => { enrolledSettled = true; }, () => { enrolledSettled = true; });
	await reached(observed.openReached, enrolling);
	checkpoint = 6;
	assert.equal(enrolledSettled, false);
	assert.equal(observed.remainingRecovery(), 1);
	assert.equal(await progress(observed.recoveryHandleLive()), true);
	const admission = await positive(record, app, manifest);
	observed.sealApp();
	assert.equal(observed.appCount() > 0, true);
	observed.holdApp = true;
	observed.failRecoveryClose = mode === "recovery-retry";
	const callsBeforeClose = observed.writerCloseCalls;
	const settledBeforeClose = observed.writerCloseSettled;
	checkpoint = 7;
	let closeSettled = false;
	const first = track(record.original.close());
	void first.then(() => { closeSettled = true; }, () => { closeSettled = true; });
	await reached(observed.appStarted, first);
	await reached(observed.writerStarted, first);
	await new Promise((resolve) => setImmediate(resolve));
	checkpoint = 8;
	assert.equal(closeSettled, false);
	assert.equal(observed.writerCloseCalls > callsBeforeClose, true);
	assert.equal(observed.remainingApp() > 0, true);
	assert.equal(observed.remainingRecovery(), 1);
	assert.equal(await progress(observed.recoveryHandleLive()), true);
	keyLive(record);
	await refused(() => nativeAppAdmissionArchive(
		admission, record.original, manifest.bundles[0].id,
	));
	await refused(() => openNativeAppAdmission(record.original));
	await refused(() => recovery.enroll(code));
	observed.releaseOpen();
	checkpoint = 9;
	if (mode === "recovery-starts") {
		// Both actual closers have started while both owned I/O gates were held.
		observed.releaseApp();
		const outcomes = await progress(Promise.allSettled([enrolling, first]));
		assert.equal(outcomes[1].status, "fulfilled");
		record.closed = true;
	} else {
		await waitFor(() => observed.writerCloseSettled > settledBeforeClose);
		await new Promise((resolve) => setImmediate(resolve));
		assert.equal(closeSettled, false);
		assert.equal(observed.remainingApp() > 0, true);
		keyLive(record);
		if (mode === "recovery-held") {
			assert.equal(observed.remainingRecovery(), 0);
			assert.equal(await progress(observed.recoveryHandleLive()), false);
			observed.releaseApp();
			const outcomes = await progress(Promise.allSettled([enrolling, first]));
			assert.equal(outcomes[1].status, "fulfilled");
			record.closed = true;
		} else {
			checkpoint = 10;
			assert.equal(mode, "recovery-retry");
			assert.equal(observed.remainingRecovery(), 1);
			assert.equal(await progress(observed.recoveryHandleLive()), true);
			observed.releaseApp();
			await progress(assert.rejects(first));
			await progress(Promise.allSettled([enrolling]));
			assert.equal(observed.remainingApp(), 0);
			assert.equal(observed.remainingRecovery(), 1);
			assert.equal(await progress(observed.recoveryHandleLive()), true);
			keyLive(record);
			await refused(() => nativeAppAdmissionArchive(
		admission, record.original, manifest.bundles[0].id,
	));
			await refused(() => recovery.enroll(code));
			const previousCalls = observed.writerCloseCalls;
			observed.failRecoveryClose = false;
			checkpoint = 11;
			await close(record);
			assert.equal(observed.writerCloseCalls > previousCalls, true);
		}
	}
	checkpoint = 12;
	assertClosed(record);
	assert.equal(observed.remainingApp(), 0);
	assert.equal(observed.remainingRecovery(), 0);
	assert.equal(await progress(observed.recoveryHandleLive()), false);
	await refused(() => nativeAppAdmissionArchive(
		admission, record.original, manifest.bundles[0].id,
	));
	await refused(() => recovery.enroll(code));
	await refused(() => recovery.readCapsule());
	await record.original.close();
}
async function run() {
	checkpoint = 1;
	assert.equal(process.argv.length, 4);
	mode = process.argv[2];
	assert.equal(modes.has(mode), true);
	const profile = process.argv[3];
	assert.equal(typeof profile, "string");
	assert.equal(path.isAbsolute(profile), true);
	ordinary(profile, "directory");
	const app = realpathSync.native(import.meta.dirname);
	const nativeBinding = path.join(app, "native", "sqlite.node");
	ordinary(nativeBinding, "file");
	io = globalThis[Symbol.for("draftyak.test.native-app-io")];
	assert.equal(typeof io?.cleanup, "function");
	assertModeInputs();
	const manifest = JSON.parse(readFileSync(path.join(app, "release.manifest.json"), "utf8"));
	assert.equal(manifest.application, "draftyak");
	assert.equal(Array.isArray(manifest.bundles), true);
	const bundles = manifest.bundles.length;
	assert.equal(bundles, 5);
	checkpoint = 2;
	const record = await originalSession(profile, nativeBinding);
	const schemas = measuredInventory(record.original);
	checkpoint = 3;
	if (mode === "positive") await positive(record, app, manifest);
	else if (mode === "ownership") await ownership(record, profile, nativeBinding, app, manifest);
	else if (mode === "currentness") await currentness(record, app, profile, manifest);
	else if (mode === "close") await closedSession(record, app, manifest);
	else if (mode === "during-capture") await duringCapture(record, manifest);
	else if (mode === "drain-retry") await drainRetry(record, app, manifest);
	else if (mode === "candidate-installer") await candidateInstaller(record, app, manifest);
	else if (mode.startsWith("recovery-")) await recoveryLifetime(record, app, manifest);
	else if (refusalModes.has(mode)) {
		await refused(() => openNativeAppAdmission(record.original));
	} else if (mode === "unconfigured") {
		assert.equal(await nativeAppAdmissionFormat(record.original), undefined);
		await refused(() => openNativeAppAdmission(record.original));
	} else {
		// An added roster mode cannot silently reuse a success path.
		unhandledMode();
	}
	checkpoint = 4;
	await close(record);
	completed = true;
	return { ok: true, capture: "configured-signed-node-fixture", mode, schemas, bundles };
}

let receipt;
let runFailed = false;
let runFailureStep = 0;
let cleanupFailed = false;
try { receipt = await run(); }
catch { runFailed = true; runFailureStep = checkpoint; }
try { await cleanup(); }
catch { cleanupFailed = true; }
function failure(step, variant) {
	const reportedMode = modes.has(mode) ? mode : "entry";
	process.stderr.write(`DYTEST native application fixture checkpoint step=${step} variant=${variant}\n`);
	process.stderr.write(`DYTEST native application fixture failed (${reportedMode})\n`);
	process.exitCode = 1;
}
if (runFailed) failure(runFailureStep, cleanupFailed ? 2 : 0);
else if (cleanupFailed) failure(60, 1);
else {
	try {
		assert.equal(completed, true);
		process.stdout.write(JSON.stringify(receipt) + "\n");
	} catch { failure(61, 3); }
}
