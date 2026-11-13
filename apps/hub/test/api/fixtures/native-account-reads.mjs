import "reflect-metadata";
import assert from "node:assert/strict";
import { createHash, generateKeyPairSync, randomBytes } from "node:crypto";
import { once } from "node:events";
import { mkdtemp, realpath, rm, stat } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import { connect } from "node:tls";
import { pathToFileURL } from "node:url";
import {
	makePairingClaim,
	pairingEkm,
	sidecarWindowSecrets,
} from "@draftyak/protocol/pairing";
import { exportSpki } from "@draftyak/protocol/sign";
import {
	BasicConstraintsExtension,
	ExtendedKeyUsage,
	ExtendedKeyUsageExtension,
	KeyUsageFlags,
	KeyUsagesExtension,
	X509CertificateGenerator,
} from "@peculiar/x509";

assert.equal(process.argv.length, 4);
const [entryArgument, bindingArgument] = process.argv.slice(2);
assert.equal(typeof entryArgument, "string");
assert.equal(typeof bindingArgument, "string");
assert.ok(path.isAbsolute(entryArgument) && path.isAbsolute(bindingArgument));
const entry = await realpath(entryArgument);
const nativeBinding = await realpath(bindingArgument);
assert.equal(path.basename(entry), "index.mjs");
assert.equal(path.extname(nativeBinding), ".node");
assert.ok((await stat(entry)).isFile() && (await stat(nativeBinding)).isFile());
createRequire(import.meta.url)("../../helpers/loopback-preload.cjs").assertActive();

// Every Hub constructor and API comes from this one built namespace, never source modules.
const hub = await import(pathToFileURL(entry).href);
for (const name of [
	"openHubSession",
	"NativeDeviceTls",
	"DevicePairingAuthority",
	"MasterKey",
	"createNativeAccountReads",
	"AccountReadError",
	"WorkDatabase",
	"EventLog",
	"NativeAccounts",
])
	assert.equal(typeof hub[name], "function");

const PREFIX = "draftyak-compiled-account-reads-";
const PIN = "694182";
const folder = await realpath(await mkdtemp(path.join(tmpdir(), PREFIX)));
const material = randomBytes(32);
const key = new hub.MasterKey(material);
material.fill(0);
let session;
let tls;
let client;
let authority;
const secret = randomBytes(16);
const nonce = randomBytes(16);
let serial = 0;
const id = () => `01${(++serial).toString(16).toUpperCase().padStart(24, "0")}`;

function refused(work, code) {
	assert.throws(work, (error) => {
		assert.ok(error instanceof hub.AccountReadError);
		assert.equal(error.code, code);
		assert.equal(error.message, code);
		assert.equal(Object.hasOwn(error, "cause"), false);
		return true;
	});
}

try {
	session = await hub.openHubSession({ folder, nativeBinding, masterKey: key });
	const transport = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
	const signing = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
	const algorithm = { name: "ECDSA", namedCurve: "P-256" };
	const certificate = await X509CertificateGenerator.createSelfSigned({
		name: "CN=Compiled account read fixture device",
		serialNumber: `01${randomBytes(19).toString("hex")}`,
		notBefore: new Date(Date.now() - 60_000),
		notAfter: new Date(Date.now() + 86_400_000),
		keys: {
			privateKey: transport.privateKey.toCryptoKey(algorithm, false, ["sign"]),
			publicKey: transport.publicKey.toCryptoKey(algorithm, true, ["verify"]),
		},
		signingAlgorithm: { name: "ECDSA", hash: "SHA-256" },
		extensions: [
			new BasicConstraintsExtension(false, undefined, true),
			new KeyUsagesExtension(KeyUsageFlags.digitalSignature, true),
			new ExtendedKeyUsageExtension([ExtendedKeyUsage.clientAuth]),
		],
	});
	let accept;
	const accepted = new Promise((resolve) => {
		accept = resolve;
	});
	tls = new hub.NativeDeviceTls(session.devices, session.identity, (peer) => accept(peer));
	client = connect({
		host: "127.0.0.1",
		port: await tls.listen(),
		ca: session.identity.certificate,
		cert: certificate.toString("pem"),
		key: transport.privateKey.export({ type: "pkcs8", format: "pem" }),
		minVersion: "TLSv1.3",
		maxVersion: "TLSv1.3",
		rejectUnauthorized: true,
	});
	client.setTimeout(5_000, () => client.destroy(new Error("Fixture TLS timeout")));
	await once(client, "secureConnect");
	const peer = await accepted;
	client.setTimeout(0);
	client.on("error", () => {});
	assert.equal(client.authorized, true);
	assert.equal(client.getProtocol(), "TLSv1.3");
	authority = new hub.DevicePairingAuthority(session.devices, session.store, key, secret);
	const window = { ...sidecarWindowSecrets(secret), role: "device" };
	const ekm = pairingEkm(client, window.pid);
	let candidate;
	try {
		const claim = makePairingClaim(
			window,
			{
				name: "Compiled account read fixture",
				transportSpkiSha256: createHash("sha256")
					.update(Buffer.from(exportSpki(transport.publicKey), "base64url"))
					.digest("hex"),
				signingKey: exportSpki(signing.publicKey),
			},
			ekm,
			nonce,
		);
		const answer = session.store.write((sql) =>
			authority.claim(sql, peer, Buffer.from(JSON.stringify(claim))),
		);
		candidate = session.store.write((sql) =>
			authority.reveal(
				sql,
				peer,
				Buffer.from(JSON.stringify({ pid: window.pid, nd: nonce.toString("base64url") })),
			),
		);
		assert.equal(candidate.deviceId, answer.deviceId);
	} finally {
		ekm.fill(0);
	}
	const grant = await session.devices.bootstrap(candidate.deviceId, PIN);
	authority.close();
	const database = new hub.WorkDatabase(session.store);
	const accounts = new hub.NativeAccounts(
		database,
		new hub.EventLog(database, Date.now),
		session.audit,
		Date.now,
	);
	const ownerIds = [];
	const privateId = id();
	const pluginInstanceId = id();
	database.write((scope) => {
		for (let index = 0; index < 104; index++) {
			const accountId = index === 103 ? privateId : id();
			accounts.create(scope, {
				id: accountId,
				userId: index === 103 ? id() : grant.ownerUserId,
				alias: `mail-${index}`,
				mode: "full",
				status: "active",
				deletionDeadline: null,
				historyLimitDays: 30,
				disclosureVersion: 1,
				createdAt: Date.now(),
				channel: "email",
				pluginInstanceId,
				address: `fixture-${index}@example.invalid`,
			});
			if (index !== 103) ownerIds.push(accountId);
		}
	});
	ownerIds.sort();
	const reads = hub.createNativeAccountReads(session);
	assert.ok(Object.isFrozen(reads));
	const record = reads.get(peer, ownerIds[0]);
	assert.equal(record.account.id, ownerIds[0]);
	assert.equal(record.account.userId, grant.ownerUserId);
	assert.equal(record.generation, 1);
	assert.ok(Object.isFrozen(record) && Object.isFrozen(record.account));
	assert.equal(reads.get(peer, privateId), undefined);
	const first = reads.page(peer, null);
	const second = reads.page(peer, first.nextId);
	assert.deepEqual(first.accounts.map((item) => item.account.id), ownerIds.slice(0, 100));
	assert.equal(first.nextId, ownerIds[99]);
	assert.deepEqual(second.accounts.map((item) => item.account.id), ownerIds.slice(100));
	assert.equal(second.nextId, null);
	assert.equal(new Set([...first.accounts, ...second.accounts].map((item) => item.account.id)).size, 103);
	for (const page of [first, second]) {
		assert.ok(Object.isFrozen(page) && Object.isFrozen(page.accounts));
		for (const item of page.accounts) {
			assert.equal(item.account.userId, grant.ownerUserId);
			assert.ok(Object.isFrozen(item) && Object.isFrozen(item.account));
		}
	}
	session.store.write((sql) => {
		assert.equal(sql.run("UPDATE main.devices SET capabilities=1 WHERE id=?", [grant.deviceId]).changes, 1);
	});
	assert.equal(reads.get(peer, ownerIds[0]).account.id, ownerIds[0]);
	assert.equal(reads.page(peer, null).accounts.length, 100);
	session.store.write((sql) => {
		assert.equal(session.devices.revoke(sql, grant.deviceId, { kind: "cli" }), true);
	});
	refused(() => reads.get(peer, ownerIds[0]), "FORBIDDEN");
	refused(() => reads.page(peer, null), "FORBIDDEN");
	await tls.close();
	await session.close();
	refused(() => reads.get(peer, ownerIds[0]), "UNAVAILABLE");
	refused(() => reads.page(peer, null), "UNAVAILABLE");
} finally {
	authority?.close();
	secret.fill(0);
	nonce.fill(0);
	client?.destroy();
	await tls?.close();
	await session?.close();
	key.destroy();
	assert.equal(path.dirname(folder), await realpath(tmpdir()));
	assert.ok(path.basename(folder).startsWith(PREFIX));
	await rm(folder, { recursive: true, force: true });
}

process.stdout.write("COMPILED_ACCOUNT_READS_OK\n");
