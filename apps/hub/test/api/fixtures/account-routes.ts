import "reflect-metadata";
import assert from "node:assert/strict";
import { createHash, generateKeyPairSync, type KeyObject, randomBytes } from "node:crypto";
import { once } from "node:events";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import { connect, type TLSSocket } from "node:tls";
import type { Account } from "@draftyak/protocol/entities/account";
import { makePairingClaim, pairingEkm, sidecarWindowSecrets } from "@draftyak/protocol/pairing";
import { exportSpki } from "@draftyak/protocol/sign";
import {
	BasicConstraintsExtension,
	ExtendedKeyUsage,
	ExtendedKeyUsageExtension,
	KeyUsageFlags,
	KeyUsagesExtension,
	X509CertificateGenerator,
} from "@peculiar/x509";
import { NativeAccounts } from "../../../src/accounts/records.ts";
import { type NativeDevicePeer, NativeDeviceTls } from "../../../src/authz/native-peer.ts";
import { EventLog } from "../../../src/events/log.ts";
import { DevicePairingAuthority } from "../../../src/identity/devices-pairing.ts";
import { WorkDatabase } from "../../../src/jobs/database.ts";
import { newId } from "../../../src/kernel/ids.ts";
import { MasterKey } from "../../../src/kernel/master-key.ts";
import { type HubSession, openHubSession } from "../../../src/lifecycle/session.ts";
import { requireLoopbackNetworkGuard } from "../../helpers/loopback-network.ts";

const PREFIX = "draftyak-account-routes-";
const require = createRequire(import.meta.url);
const nativeBinding = path.join(
	path.dirname(path.dirname(require.resolve("better-sqlite3-multiple-ciphers"))),
	"prebuilds",
	`${process.platform}-${process.arch}.node`,
);

export interface AccountRouteDeviceKeys {
	readonly privateKey: KeyObject;
	readonly transportSpkiSha256: string;
	readonly signingKey: string;
	readonly certificate: string;
}
export interface AccountRouteFixture {
	readonly session: HubSession;
	readonly peer: NativeDevicePeer;
	readonly deviceId: string;
	readonly owner: string;
	readonly tls: NativeDeviceTls;
	close(): Promise<void>;
}

export async function accountRouteDeviceKeys(): Promise<AccountRouteDeviceKeys> {
	const transport = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
	const signing = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
	const algorithm = { name: "ECDSA", namedCurve: "P-256" };
	const certificate = await X509CertificateGenerator.createSelfSigned({
		name: "CN=Account route fixture device",
		serialNumber: `01${randomBytes(19).toString("hex")}`,
		notBefore: new Date(Date.now() - 60_000),
		notAfter: new Date(Date.now() + 86_400_000),
		keys: {
			privateKey: transport.privateKey.toCryptoKey(algorithm, false, ["sign"]),
			publicKey: transport.publicKey.toCryptoKey(algorithm, true, ["verify"]),
		} as unknown as CryptoKeyPair,
		signingAlgorithm: { name: "ECDSA", hash: "SHA-256" },
		extensions: [
			new BasicConstraintsExtension(false, undefined, true),
			new KeyUsagesExtension(KeyUsageFlags.digitalSignature, true),
			new ExtendedKeyUsageExtension([ExtendedKeyUsage.clientAuth]),
		],
	});
	return {
		privateKey: transport.privateKey,
		transportSpkiSha256: createHash("sha256")
			.update(Buffer.from(exportSpki(transport.publicKey), "base64url"))
			.digest("hex"),
		signingKey: exportSpki(signing.publicKey),
		certificate: certificate.toString("pem"),
	};
}

async function removeFolder(folder: string): Promise<void> {
	assert.equal(path.dirname(folder), await realpath(tmpdir()));
	assert.ok(path.basename(folder).startsWith(PREFIX));
	await rm(folder, { recursive: true, force: true });
}

export async function accountRouteFixture(
	reusedKeys?: AccountRouteDeviceKeys,
): Promise<AccountRouteFixture> {
	requireLoopbackNetworkGuard();
	const folder = await realpath(await mkdtemp(path.join(tmpdir(), PREFIX)));
	const material = randomBytes(32), key = new MasterKey(material);
	material.fill(0);
	let session: HubSession | undefined, tls: NativeDeviceTls | undefined, client: TLSSocket | undefined;
	try {
		const opened = await openHubSession({ folder, nativeBinding, masterKey: key });
		session = opened;
		const keys = reusedKeys ?? (await accountRouteDeviceKeys());
		let accept: (peer: NativeDevicePeer) => void = () => { throw new Error("Unexpected fixture connection"); };
		const accepted = new Promise<NativeDevicePeer>((resolve) => { accept = resolve; });
		const listener = new NativeDeviceTls(opened.devices, opened.identity, (peer) => accept(peer));
		tls = listener;
		const socket = connect({
			host: "127.0.0.1", port: await listener.listen(), ca: opened.identity.certificate,
			cert: keys.certificate, key: keys.privateKey.export({ type: "pkcs8", format: "pem" }),
			minVersion: "TLSv1.3", maxVersion: "TLSv1.3", rejectUnauthorized: true,
		});
		client = socket;
		socket.setTimeout(5_000, () => socket.destroy(new Error("Fixture TLS timeout")));
		await once(socket, "secureConnect");
		const peer = await accepted;
		socket.setTimeout(0); socket.on("error", () => {});
		assert.equal(socket.authorized, true); assert.equal(socket.getProtocol(), "TLSv1.3");
		const secret = randomBytes(16), nonce = randomBytes(16);
		const authority = new DevicePairingAuthority(opened.devices, opened.store, key, secret);
		try {
			const window = { ...sidecarWindowSecrets(secret), role: "device" as const };
			const ekm = pairingEkm(socket, window.pid);
			try {
				const claim = makePairingClaim(window, {
					name: "Account route fixture", transportSpkiSha256: keys.transportSpkiSha256,
					signingKey: keys.signingKey,
				}, ekm, nonce);
				const answer = opened.store.write((sql) => authority.claim(sql, peer, Buffer.from(JSON.stringify(claim))));
				const candidate = opened.store.write((sql) => authority.reveal(sql, peer,
					Buffer.from(JSON.stringify({ pid: window.pid, nd: nonce.toString("base64url") }))));
				assert.equal(candidate.deviceId, answer.deviceId);
				const grant = await opened.devices.bootstrap(candidate.deviceId, "694182");
				let closed = false;
				return Object.freeze({
					session: opened, peer, deviceId: grant.deviceId, owner: grant.ownerUserId, tls: listener,
					async close(): Promise<void> {
						if (closed) return;
						socket.destroy(); await listener.close(); await opened.close();
						await removeFolder(folder); closed = true;
					},
				});
			} finally { ekm.fill(0); }
		} finally { authority.close(); secret.fill(0); nonce.fill(0); }
	} catch (error) {
		client?.destroy(); await tls?.close(); await session?.close(); key.destroy();
		await removeFolder(folder); throw error;
	}
}

export function seedRouteAccounts(
	f: AccountRouteFixture,
	count: number,
	userId: string = f.owner,
	wide: boolean = false,
): string[] {
	const database = new WorkDatabase(f.session.store);
	const accounts = new NativeAccounts(database, new EventLog(database, Date.now), f.session.audit, Date.now);
	const pluginInstanceId = newId();
	return database.write((scope) => {
		const ids: string[] = [];
		for (let index = 0; index < count; index++) {
			const account: Account = {
				id: newId(), userId, alias: wide ? "m".repeat(32) : `mail-${index}`,
				mode: "full", status: "active", deletionDeadline: null,
				historyLimitDays: 30, disclosureVersion: 1, createdAt: Date.now(), channel: "email",
				pluginInstanceId, address: wide ? `${"界".repeat(230)}@example.invalid` : `fixture-${index}@example.invalid`,
			};
			accounts.create(scope, account); ids.push(account.id);
		}
		return ids.sort();
	});
}
