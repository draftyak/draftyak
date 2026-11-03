import "draftyak-test-native-app-prelude";
import "reflect-metadata";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash, createPublicKey, generateKeyPairSync, randomBytes } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { connect } from "node:tls";
import { fileURLToPath } from "node:url";
import { X509CertificateGenerator } from "@peculiar/x509";
import { makePairingClaim, pairingEkm, sidecarWindowSecrets } from "@draftyak/protocol/pairing";
import { exportSpki } from "@draftyak/protocol/sign";
import {
	DevicePairingAuthority,
	MasterKey,
	NativeDeviceTls,
	openHubSession,
} from "../../../src/index.ts";
import { loadExtensionConfig } from "../../../src/extensions/config.ts";
import { admitDataFolder } from "../../../src/kernel/data-directory.ts";
import {
	closeNativeAppAdmission,
	nativeAppAdmissionArchive,
	nativeAppAdmissionInputs,
	openNativeAppAdmission,
} from "../../../src/installer/native-app-admission.ts";

const mode = process.argv[2];
const modes = new Set([
	"positive", "ownership", "currentness", "signature", "pin", "identity", "close",
	"preloaded", "missing-flag", "duplicate-flag", "node-options", "node-path",
	"during-capture", "drain-retry", "unconfigured",
]);
const profile = process.argv[3];
const install = path.dirname(fileURLToPath(import.meta.url));
const control = globalThis[Symbol.for("draftyak.test.native-app-io")];
let phase = "entry";
let step = 0;
let variant = 0;
const sessions = [];
const keys = [];
const authorities = [];
const listeners = [];
const sockets = [];
const rawKey = randomBytes(32);
const ownedBytes = [rawKey];
let tls, socket;

const turn = () => new Promise((resolve) => setImmediate(resolve));
function keyLive(key) {
	let bytes;
	try { bytes = key.derive("db"); return bytes.length === 32; }
	catch { return false; }
	finally { bytes?.fill(0); }
}
function held(folder) {
	try { const lease = admitDataFolder(folder, { nativeBinding: path.join(install, "native/sqlite.node") }); lease.release(); return false; }
	catch (error) { return error?.code === "DATA_DIR_LOCKED"; }
}
async function refuses(operation, message = "Native application admission unavailable.") {
	let error;
	try { await operation(); } catch (value) { error = value; }
	assert.equal(error instanceof Error, true);
	assert.equal(error.message === message, true);
	assert.equal(Object.hasOwn(error, "cause"), false);
}
async function bootstrap(session, key) {
	phase = "bootstrap";
	let resolvePeer;
	const peerReady = new Promise((resolve) => { resolvePeer = resolve; });
	tls = new NativeDeviceTls(session.devices, session.identity, (peer) => resolvePeer(peer));
	listeners.push(tls);
	const port = await tls.listen();
	const transport = generateKeyPairSync("ec", { namedCurve: "prime256v1" }).privateKey;
	const signing = generateKeyPairSync("ec", { namedCurve: "prime256v1" }).privateKey;
	const algorithm = { name: "ECDSA", namedCurve: "P-256" };
	const certificate = await X509CertificateGenerator.createSelfSigned({
		name: "CN=DYTEST application device",
		serialNumber: "01" + randomBytes(19).toString("hex"),
		notBefore: new Date(Date.now() - 60000),
		notAfter: new Date(Date.now() + 86400000),
		keys: {
			privateKey: transport.toCryptoKey(algorithm, false, ["sign"]),
			publicKey: createPublicKey(transport).toCryptoKey(algorithm, true, ["verify"]),
		},
		signingAlgorithm: { name: "ECDSA", hash: "SHA-256" },
	});
	const transportPem = Buffer.from(transport.export({ type: "pkcs8", format: "pem" }));
	ownedBytes.push(transportPem);
	try {
		socket = connect({
			host: "127.0.0.1", port,
			key: transportPem,
			cert: certificate.toString("pem"), rejectUnauthorized: false,
			minVersion: "TLSv1.3", maxVersion: "TLSv1.3",
		});
		sockets.push(socket);
		await new Promise((resolve, reject) => {
			socket.once("secureConnect", resolve);
			socket.once("error", () => reject(new Error("DYTEST generated TLS refused")));
		});
	} finally { transportPem.fill(0); }
	const server = socket.getPeerX509Certificate();
	const pin = createHash("sha256")
		.update(Buffer.from(exportSpki(server.publicKey), "base64url")).digest("hex");
	assert.equal(pin === session.hid && socket.getProtocol() === "TLSv1.3", true);
	const peer = await peerReady;
	const secret = randomBytes(16);
	ownedBytes.push(secret);
	const nonce = randomBytes(16);
	ownedBytes.push(nonce);
	const window = { ...sidecarWindowSecrets(secret), role: "device" };
	const ekm = pairingEkm(socket, window.pid);
	ownedBytes.push(ekm);
	try {
		const claim = Buffer.from(JSON.stringify(makePairingClaim(window, {
			name: "DYTEST application",
			transportSpkiSha256: createHash("sha256")
				.update(Buffer.from(exportSpki(createPublicKey(transport)), "base64url")).digest("hex"),
			signingKey: exportSpki(createPublicKey(signing)),
		}, ekm, nonce)));
		ownedBytes.push(claim);
		const reveal = Buffer.from(JSON.stringify({ pid: window.pid, nd: nonce.toString("base64url") }));
		ownedBytes.push(reveal);
		try {
			const authority = new DevicePairingAuthority(session.devices, session.store, key, secret);
			authorities.push(authority);
			session.store.write((tx) => authority.claim(tx, peer, claim));
			const paired = session.store.write((tx) => authority.reveal(tx, peer, reveal));
			await session.devices.bootstrap(paired.deviceId, "738294");
		} finally { claim.fill(0); reveal.fill(0); }
	} finally { secret.fill(0); nonce.fill(0); ekm.fill(0); }
	socket.destroy(); socket = undefined;
	await tls.close(); tls = undefined;
	assert.equal(session.devices.currentState().bootstrapDone, true);
}
async function open(folder, bundles) {
	mkdirSync(folder, { mode: 0o700 });
	assert.equal(loadExtensionConfig(folder).modules.length, 0);
	const key = new MasterKey(rawKey);
	keys.push(key);
	const session = await openHubSession({
		folder, masterKey: key, nativeBinding: path.join(install, "native/sqlite.node"), bundles,
	});
	sessions.push(session);
	assert.equal(loadExtensionConfig(folder).modules.length, 0);
	return { session, key };
}
async function main() {
	assert.equal(modes.has(mode), true);
	assert.equal(typeof profile === "string" && path.isAbsolute(profile), true);
	assert.equal(path.dirname(profile) !== install, true);
	assert.equal(process.env.NODE_OPTIONS === (mode === "node-options" ? "--no-warnings" : undefined), true);
	assert.equal(process.env.NODE_PATH === (mode === "node-path" ? "DYTEST-unused-node-path" : undefined), true);
	const expectedFlags = mode === "missing-flag" ? []
		: mode === "preloaded" ? ["--disable-sigusr1", "--no-warnings"]
		: mode === "duplicate-flag" ? ["--disable-sigusr1", "--disable-sigusr1"]
		: ["--disable-sigusr1"];
	assert.equal(process.execArgv.length === expectedFlags.length && process.execArgv.every((flag, index) => flag === expectedFlags[index]), true);
	assert.equal(typeof openHubSession, "function");
	assert.equal(typeof openNativeAppAdmission, "function");
	const release = JSON.parse(readFileSync(path.join(install, "release.manifest.json"), "utf8"));
	const current = await open(path.join(profile, "data"), release.bundles.map((b) => ({
		id: b.id, package: b.package,
	})));
	const { session, key } = current;
	await bootstrap(session, key);
	assert.equal(loadExtensionConfig(path.join(profile, "data")).modules.length, 0);
	assert.equal(session.store.read((db) => db.all(
		"SELECT name FROM main.sqlite_schema WHERE type='table' AND name LIKE '_migrations_%'",
	)).filter((row) => !row.name.endsWith("_lock")).length, 18);
	phase = mode;
	if (["signature", "pin", "identity", "preloaded", "missing-flag", "duplicate-flag", "node-options", "node-path", "unconfigured"].includes(mode)) {
		await refuses(() => openNativeAppAdmission(session));
		return;
	}
	if (mode === "during-capture") {
		step = 10;
		const opening = openNativeAppAdmission(session);
		const outcome = opening.then(() => false, () => true);
		step = 11;
		assert.equal(await Promise.race([
			control.openReached.then(() => true),
			opening.then(() => false, () => false),
		]), true);
		step = 12;
		assert.equal(control.appOnly(), true);
		assert.equal(control.firstIsManifest(), true);
		step = 13;
		const closing = session.close();
		let settled = false; void closing.finally(() => { settled = true; }).catch(() => {});
		try {
			await turn();
			step = 14;
			assert.equal(settled, false);
			step = 15;
			assert.equal(session.store.read((db) => db.get("SELECT 1 AS alive")).alive, 1);
			step = 16;
			assert.equal(keyLive(key), true);
			step = 17;
			assert.equal(held(path.join(profile, "data")), true);
		} finally { control.releaseOpen(); }
		step = 18;
		assert.equal(await outcome, true);
		step = 19;
		await closing;
		step = 20;
		assert.equal(keyLive(key), false);
		step = 21;
		assert.equal(control.remaining(), 0);
		return;
	}
	let other;
	if (mode === "ownership") {
		step = 30;
		other = await open(path.join(profile, "other"), release.bundles.map((b) => ({ id: b.id, package: b.package })));
	}
	assert.equal(globalThis[Symbol.for("draftyak.test.installer.executed")] === true, false);
	step = 1;
	const admission = await openNativeAppAdmission(session);
	assert.equal(admission === await openNativeAppAdmission(session), true);
	step = 2;
	const inputs = await nativeAppAdmissionInputs(admission, session);
	assert.equal(Object.isFrozen(inputs) && Object.isFrozen(inputs.bundles), true);
	assert.equal(inputs.bundles.length, 5);
	assert.equal(globalThis[Symbol.for("draftyak.test.installer.executed")] === true, false);
	assert.equal(inputs.bundles.every((row, index) => row.package.version === (index + 1) + ".2.3"), true);
	const first = inputs.bundles[0];
	if (mode === "positive") {
		for (const bundle of inputs.bundles) {
			const archive = await nativeAppAdmissionArchive(admission, session, bundle.id);
			assert.equal("sha512-" + createHash("sha512").update(archive).digest("base64") === bundle.package.integrity, true);
		}
		const copy = await nativeAppAdmissionArchive(admission, session, first.id);
		copy.fill(0);
		assert.equal("sha512-" + createHash("sha512").update(copy).digest("base64") === first.package.integrity, false);
		const fresh = await nativeAppAdmissionArchive(admission, session, first.id);
		assert.equal("sha512-" + createHash("sha512").update(fresh).digest("base64") === first.package.integrity, true);
		assert.equal(globalThis[Symbol.for("draftyak.test.installer.executed")] === true, false);
		step = 3;
		const env = {};
		for (const name of ["SystemRoot", "TEMP", "TMP"])
			if (process.env[name] !== undefined) env[name] = process.env[name];
		const child = spawnSync(process.execPath, ["-e", "process.exit(0)"], {
			cwd: install, env, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"],
			windowsHide: true, timeout: 10_000,
		});
		assert.equal(child.error === undefined, true);
		assert.equal(child.status === 0, true);
		assert.equal(typeof child.stdout === "string" && child.stdout.length === 0, true);
		assert.equal(typeof child.stderr === "string" && child.stderr.length === 0, true);
	} else if (mode === "ownership") {
		// Invalid ownership must refuse before touching the deliberately invalid archive tree.
		step = 31;
		writeFileSync(path.join(install, "unlisted.bin"), "DYTEST ownership before archive I/O");
		step = 32;
		await refuses(() => nativeAppAdmissionArchive(admission, session, "DYTEST-unknown-bundle"));
		let reads = 0;
		const proxy = new Proxy(admission, { get() { reads++; throw new Error("DYTEST unreachable"); } });
		for (const [index, forged] of [{}, { ...admission }, Object.create(admission), proxy].entries()) {
			variant = index;
			step = 33;
			await refuses(() => nativeAppAdmissionInputs(forged, session));
			step = 34;
			await refuses(() => nativeAppAdmissionArchive(forged, session, first.id));
		}
		variant = 0;
		step = 35;
		await refuses(() => nativeAppAdmissionInputs(admission, other.session));
		step = 36;
		await refuses(() => nativeAppAdmissionArchive(admission, other.session, first.id));
		const foreign = new Proxy(session, {
			get() { reads++; throw new Error("DYTEST unreachable"); },
			getPrototypeOf() { reads++; throw new Error("DYTEST unreachable"); },
		});
		step = 37;
		await refuses(() => openNativeAppAdmission(foreign), "PLUGINS_UNAVAILABLE");
		step = 38;
		await refuses(() => nativeAppAdmissionArchive(admission, foreign, first.id));
		step = 39;
		assert.equal(reads, 0);
	} else if (mode === "currentness") {
		writeFileSync(path.join(install, "unlisted.bin"), "DYTEST unlisted");
		await refuses(() => nativeAppAdmissionArchive(admission, session, first.id), "Native application files unavailable.");
		await refuses(() => nativeAppAdmissionInputs(admission, session), "Native application files unavailable.");
	} else if (mode === "close") {
		const closing = admission.close();
		assert.equal(closing === admission.close(), true);
		await refuses(() => nativeAppAdmissionArchive(admission, session, first.id));
		await closing;
		await refuses(() => nativeAppAdmissionInputs(admission, session));
	} else if (mode === "drain-retry") {
		step = 40;
		control.failClose = true;
		const closing = session.close();
		const outcome = closing.then(() => false, (error) => error?.code === "CLOSE_INCOMPLETE");
		step = 41;
		assert.equal(await Promise.race([
			control.closeReached.then(() => true),
			closing.then(() => false, () => false),
		]), true);
		step = 42;
		assert.equal(control.appOnly(), true);
		assert.equal(control.firstIsManifest(), true);
		try {
			await turn();
			step = 43;
			await refuses(() => nativeAppAdmissionArchive(admission, session, first.id));
			step = 44;
			assert.equal(control.attempts === control.opened, true);
			step = 45;
			assert.equal(await Promise.race([
				control.otherCloseSettled,
				closing.then(() => false, () => false),
			]), true);
			assert.equal(control.closed > 0, true);
			step = 46;
			assert.equal(session.store.read((db) => db.get("SELECT 1 AS alive")).alive, 1);
			step = 47;
			assert.equal(keyLive(key), true);
			step = 48;
			assert.equal(held(path.join(profile, "data")), true);
		} finally { control.releaseClose(); }
		step = 49;
		assert.equal(await outcome, true);
		step = 50;
		assert.equal(keyLive(key), false);
		step = 51;
		await session.close();
		step = 52;
		assert.equal(control.remaining(), 0);
		step = 53;
		assert.equal(control.firstAttempts(), 2);
	}
	step = 60;
	await session.close();
	step = 61;
	await refuses(() => nativeAppAdmissionInputs(admission, session));
	step = 62;
	await refuses(() => nativeAppAdmissionArchive(admission, session, first.id));
	step = 63;
	assert.equal(keyLive(key), false);
}

async function attemptAll(operations) {
	const results = await Promise.allSettled(operations.map(async (operation) => { await operation(); }));
	return operations.filter((_operation, index) => results[index].status === "rejected");
}

async function closeSocket(client) {
	if (client.closed) return;
	await new Promise((resolve, reject) => {
		const closed = () => resolve();
		client.once("close", closed);
		try { client.destroy(); }
		catch (error) { client.removeListener("close", closed); reject(error); }
	});
}

async function cleanupOwned() {
	let failed = false;
	const gateFailures = await attemptAll([
		() => { control.failClose = false; },
		() => control.releaseOpen(),
		() => control.releaseClose(),
	]);
	if (gateFailures.length !== 0) {
		failed = true;
		await attemptAll(gateFailures);
	}
	const closing = [
		...authorities.map((authority) => () => authority.close()),
		...sockets.map((client) => () => closeSocket(client)),
		...listeners.map((listener) => () => listener.close()),
		...sessions.flatMap((session) => [
			() => closeNativeAppAdmission(session),
			() => session.close(),
		]),
	];
	const failures = await attemptAll(closing);
	if (failures.length !== 0) {
		failed = true;
		await attemptAll(failures);
	}
	const controlFailures = await attemptAll([() => control.cleanup()]);
	if (controlFailures.length !== 0) {
		failed = true;
		await attemptAll(controlFailures);
	}
	if (control.remaining() !== 0) failed = true;
	return failed;
}

let bodyFailed = false;
let bodyPhase = "entry";
let bodyStep = 0;
let bodyVariant = 0;
let cleanupFailed = false;
try { await main(); }
catch {
	bodyFailed = true;
	bodyPhase = phase === "entry" || phase === "bootstrap" || modes.has(phase) ? phase : "entry";
	bodyStep = step;
	bodyVariant = variant;
}
try { cleanupFailed = await cleanupOwned(); }
catch { cleanupFailed = true; }
finally {
	const failures = await attemptAll([
		...keys.map((key) => () => key.destroy()),
		...ownedBytes.map((bytes) => () => bytes.fill(0)),
	]);
	if (failures.length !== 0) {
		cleanupFailed = true;
		await attemptAll(failures);
	}
}
if (bodyFailed || cleanupFailed) {
	process.stderr.write("DYTEST native application fixture failed (" + (bodyFailed ? bodyPhase : "cleanup") + ")\n");
	process.stderr.write("DYTEST native application fixture checkpoint step=" + bodyStep + " variant=" + bodyVariant + "\n");
	process.exitCode = 1;
} else {
	process.stdout.write(JSON.stringify({ ok: true, capture: "configured-signed-node-fixture", mode, schemas: 18, bundles: 5 }) + "\n");
}
