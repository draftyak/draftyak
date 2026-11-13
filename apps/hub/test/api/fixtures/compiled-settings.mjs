import assert from "node:assert/strict";
import { createHash, createPublicKey, generateKeyPairSync, randomBytes } from "node:crypto";
import { lstatSync, mkdirSync, readFileSync, realpathSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { connect } from "node:tls";
import { pathToFileURL } from "node:url";

function freshBuildRoot(hub, supplied) {
	assert.ok(typeof supplied === "string" && supplied.length > 0 && path.isAbsolute(supplied));
	const parent = realpathSync(path.join(hub, "node_modules"));
	const selected = path.resolve(supplied), info = lstatSync(selected);
	assert.ok(path.dirname(selected) === parent && path.basename(selected).startsWith(".m37-fresh-hub-build-"));
	assert.ok(info.isDirectory() && !info.isSymbolicLink() && realpathSync(selected) === selected);
	const entry = path.join(selected, "index.mjs"), entryInfo = lstatSync(entry);
	assert.ok(entryInfo.isFile() && !entryInfo.isSymbolicLink() && realpathSync(entry) === entry);
	return selected;
}

async function verify() {
	const [nativeBinding, directory, buildRoot] = process.argv.slice(2);
	assert.equal(process.argv.length, buildRoot === undefined ? 4 : 5);
	assert.ok(nativeBinding && directory && path.isAbsolute(nativeBinding) && path.isAbsolute(directory));
	const hub = process.cwd(), dist = buildRoot === undefined ? path.join(hub, "dist") : freshBuildRoot(hub, buildRoot);
	createRequire(import.meta.url)(path.join(hub, "test/helpers/loopback-preload.cjs")).assertActive();
	await import("reflect-metadata");
	const [compiled, { X509CertificateGenerator }, pairing, { exportSpki }] = await Promise.all([
		import(pathToFileURL(path.join(dist, "index.mjs")).href),
		import("@peculiar/x509"), import("@draftyak/protocol/pairing"), import("@draftyak/protocol/sign"),
	]);
	for (const name of ["createOwnerSettings", "OwnerSettingsError", "MasterKey", "HubStore", "openHubSession", "NativeDeviceTls", "DevicePairingAuthority"])
		assert.equal(typeof compiled[name], "function");
	assert.equal(compiled.OWNER_SETTINGS_MAX_BYTES, 4096);
	const asset = readFileSync(path.join(dist, "api/migrations/0001_owner_settings.sql"));
	assert.ok(asset.equals(readFileSync(path.join(hub, "src/api/migrations/0001_owner_settings.sql"))));
	const assetSha256 = createHash("sha256").update(asset).digest("hex");
	const folder = path.join(directory, "data");
	mkdirSync(folder);
	const material = randomBytes(32), keys = [], sessions = [], transports = [], clients = [];
	let bare;
	const value = {
		zone: "Pacific/Kiritimati",
		workingHours: { days: ["mon", "wed", "fri"], start: "09:15", end: "17:45" },
	};
	const newKey = () => { const key = new compiled.MasterKey(material); keys.push(key); return key; };
	async function clientCertificate(privateKey) {
		const algorithm = { name: "ECDSA", namedCurve: "P-256" };
		const certificate = await X509CertificateGenerator.createSelfSigned({
			name: "CN=DYTEST compiled settings device", serialNumber: `01${randomBytes(19).toString("hex")}`,
			notBefore: new Date(Date.now() - 60_000), notAfter: new Date(Date.now() + 86_400_000),
			keys: { privateKey: privateKey.toCryptoKey(algorithm, false, ["sign"]), publicKey: createPublicKey(privateKey).toCryptoKey(algorithm, true, ["verify"]) },
			signingAlgorithm: { name: "ECDSA", hash: "SHA-256" },
		});
		return certificate.toString("pem");
	}
	async function open(device) {
		const key = newKey();
		const session = await compiled.openHubSession({ folder, nativeBinding, masterKey: key });
		sessions.push(session);
		const arrived = Promise.withResolvers();
		const transport = new compiled.NativeDeviceTls(session.devices, session.identity, (peer) => arrived.resolve(peer));
		transports.push(transport);
		const port = await transport.listen();
		const transportKey = device?.transportKey ?? generateKeyPairSync("ec", { namedCurve: "prime256v1" }).privateKey;
		const signingKey = device?.signingKey ?? generateKeyPairSync("ec", { namedCurve: "prime256v1" }).privateKey;
		const certificate = device?.certificate ?? await clientCertificate(transportKey);
		const socket = connect({
			host: "127.0.0.1", port, key: transportKey.export({ format: "pem", type: "pkcs8" }), cert: certificate,
			rejectUnauthorized: false, minVersion: "TLSv1.3", maxVersion: "TLSv1.3",
		});
		clients.push(socket);
		socket.on("error", () => {});
		await new Promise((resolve, reject) => {
			const timer = setTimeout(() => { socket.destroy(); reject(new Error("Compiled settings TLS refused")); }, 5_000);
			socket.once("error", () => { clearTimeout(timer); reject(new Error("Compiled settings TLS refused")); });
			socket.once("secureConnect", () => {
				clearTimeout(timer);
				try {
					assert.equal(socket.getProtocol(), "TLSv1.3");
					const server = socket.getPeerX509Certificate();
					assert.ok(server);
					assert.equal(createHash("sha256").update(Buffer.from(exportSpki(server.publicKey), "base64url")).digest("hex"), session.identity.hid);
					resolve();
				} catch { reject(new Error("Compiled settings TLS refused")); }
			});
		});
		let timer;
		const peer = await Promise.race([arrived.promise, new Promise((_, reject) => {
			timer = setTimeout(() => reject(new Error("Compiled settings peer refused")), 5_000);
		})]).finally(() => clearTimeout(timer));
		return { key, session, transport, socket, peer, transportKey, signingKey, certificate, handle: compiled.createOwnerSettings(session) };
	}
	async function bootstrap(current) {
		const secret = randomBytes(16), nd = randomBytes(16);
		let ekm, claim, reveal;
		try {
			const authority = new compiled.DevicePairingAuthority(current.session.devices, current.session.store, current.key, secret);
			const window = { ...pairing.sidecarWindowSecrets(secret), role: "device" };
			ekm = pairing.pairingEkm(current.socket, window.pid);
			claim = Buffer.from(JSON.stringify(pairing.makePairingClaim(window, {
				name: "DYTEST compiled settings owner",
				transportSpkiSha256: createHash("sha256").update(Buffer.from(exportSpki(createPublicKey(current.transportKey)), "base64url")).digest("hex"),
				signingKey: exportSpki(createPublicKey(current.signingKey)),
			}, ekm, nd)));
			reveal = Buffer.from(JSON.stringify({ pid: window.pid, nd: nd.toString("base64url") }));
			current.session.store.write((tx) => authority.claim(tx, current.peer, claim));
			const recorded = current.session.store.write((tx) => authority.reveal(tx, current.peer, reveal));
			await current.session.devices.bootstrap(recorded.deviceId, "738294");
		} finally { secret.fill(0); nd.fill(0); ekm?.fill(0); claim?.fill(0); reveal?.fill(0); }
	}
	try {
		const first = await open();
		await bootstrap(first);
		const owner = first.session.devices.currentState().ownerUserId;
		assert.equal(typeof owner, "string");
		assert.equal(first.handle.get(first.peer), undefined);
		assert.deepEqual(first.handle.put(first.peer, Buffer.from(JSON.stringify(value))), value);
		assert.deepEqual(first.handle.get(first.peer), value);
		first.socket.destroy();
		await first.transport.close();
		await first.session.close();
		const bareKey = newKey();
		// No migrations option: the real delivered catalog must recognize every applied namespace.
		bare = new compiled.HubStore({ filename: path.join(folder, "draftyak.db"), nativeBinding, masterKey: bareKey, create: false });
		const row = bare.read((db) => db.get("SELECT settings_json FROM owner_settings WHERE user_id=?", [owner]));
		assert.equal(typeof row?.settings_json, "string");
		assert.deepEqual(JSON.parse(row.settings_json), value);
		bare.close(); bare = undefined; bareKey.destroy();
		const reopened = await open(first);
		assert.throws(() => reopened.handle.get(first.peer), (error) => error instanceof compiled.OwnerSettingsError && error.code === "FORBIDDEN");
		assert.deepEqual(reopened.handle.get(reopened.peer), value);
		return { version: 1, ok: true, exported: true, tls13: true, bareReopen: true, freshPeerRequired: true, reopened: true, assetBytes: asset.length, assetSha256 };
	} finally {
		let failed = false;
		try { bare?.close(); } catch { failed = true; }
		for (const socket of clients) socket.destroy();
		for (const transport of transports) { try { await transport.close(); } catch { failed = true; } }
		for (const session of sessions) { try { await session.close(); } catch { failed = true; } }
		for (const key of keys) { try { key.destroy(); } catch { failed = true; } }
		material.fill(0);
		if (failed) throw new Error("Compiled settings cleanup incomplete");
	}
}

try { process.stdout.write(`${JSON.stringify(await verify())}\n`); }
catch { process.stdout.write('{"version":1,"ok":false}\n'); process.exitCode = 1; }
