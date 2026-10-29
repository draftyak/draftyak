import "reflect-metadata";
import { createHash, generateKeyPairSync, type KeyObject, randomBytes } from "node:crypto";
import { existsSync, lstatSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { connect, type TLSSocket } from "node:tls";
import type { AuditChain as AuditChainType } from "../../src/audit/chain.ts";
import type { Authorizer as AuthorizerType } from "../../src/authz/authorizer.ts";
import type {
	NativeDevicePeer,
	NativeDeviceTls as NativeDeviceTlsType,
} from "../../src/authz/native-peer.ts";
import type { DeviceRegistry as DeviceRegistryType } from "../../src/identity/devices.ts";
import type { DevicePairingAuthority as DevicePairingAuthorityType } from "../../src/identity/devices-pairing.ts";
import type { HubIdentity as HubIdentityType } from "../../src/identity/hub-key.ts";
import type { PinService as PinServiceType } from "../../src/identity/pin.ts";
import type { MasterKey as MasterKeyType } from "../../src/kernel/master-key.ts";
import type { HubStore as HubStoreType } from "../../src/store/store.ts";
import { requireLoopbackNetworkGuard } from "../helpers/loopback-network.ts";

requireLoopbackNetworkGuard();
const [
	{ makePairingClaim, pairingEkm, sidecarWindowSecrets },
	{ exportSpki },
	{ X509CertificateGenerator },
	{ AuditChain },
	{ Authorizer },
	{ NativeDeviceTls },
	{ DEVICE_MIGRATIONS, DeviceRegistry },
	{ DevicePairingAuthority },
	{ HubIdentity },
	{ PinService },
	{ MasterKey },
	{ HubStore },
	{ nativeBinding },
] = await Promise.all([
	import("@draftyak/protocol/pairing"),
	import("@draftyak/protocol/sign"),
	import("@peculiar/x509"),
	import("../../src/audit/chain.ts"),
	import("../../src/authz/authorizer.ts"),
	import("../../src/authz/native-peer.ts"),
	import("../../src/identity/devices.ts"),
	import("../../src/identity/devices-pairing.ts"),
	import("../../src/identity/hub-key.ts"),
	import("../../src/identity/pin.ts"),
	import("../../src/kernel/master-key.ts"),
	import("../../src/store/store.ts"),
	import("../store/helpers.ts"),
]);
export const PIN: string = "738294";
export interface TestDevice {
	readonly socket: TLSSocket;
	readonly peer: NativeDevicePeer;
	readonly transportKey: KeyObject;
	readonly certificate: string;
	readonly transportSpkiSha256: string;
	readonly signingKey: string;
	readonly privateKey: KeyObject;
	id?: string;
}
export interface NativeFixture {
	readonly dir: string;
	readonly filename: string;
	readonly key: MasterKeyType;
	store: HubStoreType;
	audit: AuditChainType;
	pins: PinServiceType;
	identity: HubIdentityType;
	registry: DeviceRegistryType;
	authorizer: AuthorizerType;
	tls: NativeDeviceTlsType;
	port: number;
	ownerUserId?: string;
	readonly devices: TestDevice[];
	readonly nextPeers: NativeDevicePeer[];
	readonly waiting: Array<(peer: NativeDevicePeer) => void>;
}
const temp = realpathSync(os.tmpdir());
const owned = new Map<string, { dev: number; ino: number; born: number }>();
const migrations = {
	audit: path.resolve(import.meta.dirname, "../../src/store/migrations/audit"),
	core: path.resolve(import.meta.dirname, "../../src/store/migrations/core"),
	devices: DEVICE_MIGRATIONS,
};
function remove(dir: string): void {
	const absolute = path.resolve(dir),
		relative = path.relative(temp, absolute),
		identity = owned.get(absolute);
	if (!identity || path.dirname(relative) !== "." || !relative.startsWith("draftyak-native-authz-"))
		throw new Error("Unowned fixture path");
	const now = lstatSync(absolute);
	if (
		!now.isDirectory() ||
		now.isSymbolicLink() ||
		realpathSync(absolute) !== absolute ||
		now.dev !== identity.dev ||
		now.ino !== identity.ino ||
		now.birthtimeMs !== identity.born
	)
		throw new Error("Fixture identity changed");
	rmSync(absolute, { recursive: true, force: false });
	if (existsSync(absolute)) throw new Error("Fixture cleanup incomplete");
	owned.delete(absolute);
}
export async function fixture(
	extraMigrations: Readonly<Record<string, string>> = {},
): Promise<NativeFixture> {
	requireLoopbackNetworkGuard();
	for (const namespace of Object.keys(extraMigrations))
		if (Object.hasOwn(migrations, namespace)) throw new Error("Fixture migration collision");
	const allMigrations = { ...migrations, ...extraMigrations };
	const dir = realpathSync(mkdtempSync(path.join(temp, "draftyak-native-authz-"))),
		stat = lstatSync(dir);
	owned.set(dir, { dev: stat.dev, ino: stat.ino, born: stat.birthtimeMs });
	const bytes = randomBytes(32),
		key = new MasterKey(bytes);
	bytes.fill(0);
	let store: HubStoreType | undefined;
	let audit: AuditChainType | undefined;
	let identity: HubIdentityType | undefined;
	let pins: PinServiceType | undefined;
	let tls: NativeDeviceTlsType | undefined;
	try {
		const filename = path.join(dir, "hub.db");
		store = new HubStore({
			filename,
			nativeBinding,
			masterKey: key,
			create: true,
			migrations: allMigrations,
		});
		for (const namespace of Object.keys(allMigrations)) await store.migrate(namespace);
		const subkey = key.derive("audit");
		try {
			audit = new AuditChain(subkey);
		} finally {
			subkey.fill(0);
		}
		identity = await HubIdentity.loadOrCreate(store, key);
		pins = new PinService(store, audit);
		const registry = new DeviceRegistry(store, audit, pins, { identity });
		const nextPeers: NativeDevicePeer[] = [],
			waiting: Array<(peer: NativeDevicePeer) => void> = [];
		tls = new NativeDeviceTls(registry, identity, (peer) => {
			const resolve = waiting.shift();
			if (resolve) resolve(peer);
			else nextPeers.push(peer);
		});
		const port = await tls.listen();
		return {
			dir,
			filename,
			key,
			store,
			audit,
			identity,
			pins,
			registry,
			authorizer: new Authorizer(registry),
			tls,
			port,
			devices: [],
			nextPeers,
			waiting,
		};
	} catch {
		await tls?.close();
		pins?.lock();
		identity?.lock();
		store?.close();
		audit?.destroy();
		key.destroy();
		remove(dir);
		throw new Error("Native fixture setup failed");
	}
}
export async function closeFixture(f: NativeFixture): Promise<void> {
	try {
		for (const device of f.devices) device.socket.destroy();
		await f.tls.close();
		f.store.read((db) => f.audit.verify(db));
	} finally {
		f.registry.lock();
		f.pins.lock();
		f.identity.lock();
		f.store.close();
		f.audit.destroy();
		f.key.destroy();
		remove(f.dir);
	}
}
async function clientCertificate(privateKey: KeyObject): Promise<string> {
	const { createPublicKey } = await import("node:crypto");
	const algorithm = { name: "ECDSA", namedCurve: "P-256" };
	const cert = await X509CertificateGenerator.createSelfSigned({
		name: "CN=DYTEST device",
		serialNumber: `01${randomBytes(19).toString("hex")}`,
		notBefore: new Date(Date.now() - 60_000),
		notAfter: new Date(Date.now() + 86_400_000),
		keys: {
			privateKey: privateKey.toCryptoKey(algorithm, false, ["sign"]),
			publicKey: createPublicKey(privateKey).toCryptoKey(algorithm, true, ["verify"]),
		} as CryptoKeyPair,
		signingAlgorithm: { name: "ECDSA", hash: "SHA-256" },
	});
	return cert.toString("pem");
}
export async function device(f: NativeFixture, reuse?: TestDevice): Promise<TestDevice> {
	requireLoopbackNetworkGuard();
	const transport =
		reuse?.transportKey ?? generateKeyPairSync("ec", { namedCurve: "prime256v1" }).privateKey;
	const signing =
		reuse?.privateKey ?? generateKeyPairSync("ec", { namedCurve: "prime256v1" }).privateKey;
	const certificate = reuse?.certificate ?? (await clientCertificate(transport));
	const pem = transport.export({ format: "pem", type: "pkcs8" });
	const socket = connect({
		host: "127.0.0.1",
		port: f.port,
		key: pem,
		cert: certificate,
		rejectUnauthorized: false,
		minVersion: "TLSv1.3",
		maxVersion: "TLSv1.3",
	});
	socket.on("error", () => {});
	await new Promise<void>((resolve, reject) => {
		const timeout = setTimeout(() => {
			socket.destroy();
			reject(new Error("Native TLS timeout"));
		}, 5_000);
		socket.once("error", () => {
			clearTimeout(timeout);
			reject(new Error("Native TLS refused"));
		});
		socket.once("secureConnect", () => {
			clearTimeout(timeout);
			const cert = socket.getPeerX509Certificate();
			const pin =
				cert &&
				createHash("sha256")
					.update(Buffer.from(exportSpki(cert.publicKey), "base64url"))
					.digest("hex");
			if (pin !== f.identity.hid || socket.getProtocol() !== "TLSv1.3") {
				socket.destroy();
				reject(new Error("Hub pin refused"));
			} else resolve();
		});
	});
	const peer =
		f.nextPeers.shift() ??
		(await new Promise<NativeDevicePeer>((resolve, reject) => {
			const timeout = setTimeout(() => reject(new Error("Native peer timeout")), 5_000);
			f.waiting.push((value) => {
				clearTimeout(timeout);
				resolve(value);
			});
		}));
	const { createPublicKey } = await import("node:crypto");
	const result: TestDevice = {
		socket,
		peer,
		transportKey: transport,
		certificate,
		transportSpkiSha256: createHash("sha256")
			.update(Buffer.from(exportSpki(createPublicKey(transport)), "base64url"))
			.digest("hex"),
		signingKey: exportSpki(createPublicKey(signing)),
		privateKey: signing,
		...(reuse?.id ? { id: reuse.id } : {}),
	};
	f.devices.push(result);
	return result;
}
export function claimBytes(
	client: TestDevice,
	secret: Uint8Array,
	name = "DYTEST desktop",
): Uint8Array {
	const window = { ...sidecarWindowSecrets(secret), role: "device" as const };
	const ekm = pairingEkm(client.socket, window.pid);
	try {
		return Buffer.from(
			JSON.stringify(
				makePairingClaim(
					window,
					{ name, transportSpkiSha256: client.transportSpkiSha256, signingKey: client.signingKey },
					ekm,
				),
			),
		);
	} finally {
		ekm.fill(0);
	}
}
export function sidecar(
	f: NativeFixture,
	secret: Uint8Array = randomBytes(16),
): DevicePairingAuthorityType {
	return new DevicePairingAuthority(f.registry, f.store, f.key, secret);
}
export function admit(f: NativeFixture, client: TestDevice): string {
	const secret = randomBytes(16),
		authority = sidecar(f, secret);
	try {
		const recorded = f.store.write((tx) =>
			authority.claim(tx, client.peer, claimBytes(client, secret)),
		);
		client.id = recorded.deviceId;
		return recorded.deviceId;
	} finally {
		secret.fill(0);
	}
}
export async function bootstrap(f: NativeFixture, input?: TestDevice): Promise<TestDevice> {
	const client = input ?? (await device(f));
	const id = admit(f, client);
	const grant = await f.registry.bootstrap(id, PIN);
	f.ownerUserId = grant.userId;
	return client;
}
export function idOf(client: TestDevice): string {
	if (!client.id) throw new Error("Device not admitted");
	return client.id;
}
export function owner(f: NativeFixture): string {
	const id = f.ownerUserId;
	if (!id) throw new Error("Hub not bootstrapped");
	return id;
}
export function auditActions(f: NativeFixture): string[] {
	return f.store.read((db) => {
		f.audit.verify(db);
		const page = f.audit.exportVerifiedJsonl(db, { afterSeq: 0, limit: 1000 });
		return page.jsonl
			.split("\n")
			.filter(Boolean)
			.map((line) => (JSON.parse(line) as { action: string }).action);
	});
}
