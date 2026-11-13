import "reflect-metadata";
import { createHash, generateKeyPairSync, randomBytes } from "node:crypto";
import { once } from "node:events";
import { lstatSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { createServer, type IncomingMessage, type Server } from "node:http";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import { type ConnectionOptions, connect, type TLSSocket } from "node:tls";
import { canonicalize } from "@draftyak/protocol/jcs";
import { makePairingClaim, sidecarWindowSecrets } from "@draftyak/protocol/pairing";
import {
	BasicConstraintsExtension,
	ExtendedKeyUsage,
	ExtendedKeyUsageExtension,
	KeyUsageFlags,
	KeyUsagesExtension,
	X509CertificateGenerator,
} from "@peculiar/x509";
import { type NativeDevicePeer, NativeDeviceTls } from "../../../src/authz/native-peer.ts";
import { EventLog } from "../../../src/events/log.ts";
import { DevicePairingAuthority } from "../../../src/identity/devices-pairing.ts";
import { WorkDatabase } from "../../../src/jobs/database.ts";
import { MasterKey } from "../../../src/kernel/master-key.ts";
import {
	assertHubSessionAdmission,
	type HubSession,
	openHubSession,
} from "../../../src/lifecycle/session.ts";

export interface FixtureSocketManager {
	upgrade(peer: NativeDevicePeer, request: IncomingMessage, socket: TLSSocket, head: Buffer): void;
	close(): Promise<void>;
}
export interface EventSocketFixture {
	readonly session: HubSession;
	readonly database: WorkDatabase;
	readonly events: EventLog;
	readonly clock: { now: number };
	readonly deviceId: string;
	readonly ownerUserId: string | undefined;
	readonly url: string;
	readonly tls: ConnectionOptions;
	readonly servers: readonly TLSSocket[];
	mount(manager: FixtureSocketManager): void;
	bootstrap(): Promise<string>;
	connectTls(): Promise<TLSSocket>;
	closeSessionOnly(): Promise<void>;
	closeSession(): Promise<void>;
}
export const EVENT_PIN = "640281";
export const eventId = (value: number): string => String(value).padStart(26, "0");
const encode = (value: unknown): Uint8Array => Buffer.from(canonicalize(value), "utf8");
const PREFIX = "draftyak-event-ws-";
const require = createRequire(import.meta.url);
const cleanupDebt = new Set<() => Promise<void>>();

function binding(): string {
	const manifest = require.resolve("better-sqlite3-multiple-ciphers/package.json");
	let platform: string = process.platform;
	if (platform === "linux") {
		const report = process.report.getReport() as { header: { glibcVersionRuntime?: string } };
		if (!report.header.glibcVersionRuntime) platform = "linuxmusl";
	}
	return realpathSync.native(
		path.join(path.dirname(manifest), "prebuilds", `${platform}-${process.arch}.node`),
	);
}
function directoryIdentity(directory: string): string {
	const stat = lstatSync(directory, { bigint: true });
	if (
		!stat.isDirectory() ||
		stat.isSymbolicLink() ||
		stat.ino === 0n ||
		realpathSync.native(directory) !== directory
	)
		throw new Error("Unsafe event WebSocket fixture directory");
	return `${stat.dev}:${stat.ino}:${stat.birthtimeNs}`;
}
async function destroyTls(socket: TLSSocket): Promise<void> {
	if (socket.closed) return;
	const closed = new Promise<void>((resolve) => socket.once("close", () => resolve()));
	socket.destroy();
	await closed;
}
export async function cleanupEventSocketFixtures(): Promise<void> {
	let failed = false;
	for (const close of [...cleanupDebt].reverse()) {
		try {
			await close();
		} catch {
			failed = true;
		}
	}
	if (failed || cleanupDebt.size !== 0)
		throw new Error("Unresolved event WebSocket fixture cleanup");
}

export async function createEventSocketFixture(bootstrap = true): Promise<EventSocketFixture> {
	const parent = realpathSync.native(tmpdir());
	const parentIdentity = directoryIdentity(parent);
	const folder = mkdtempSync(path.join(parent, PREFIX));
	const identity = directoryIdentity(folder);
	const offered = randomBytes(32);
	const key = new MasterKey(offered);
	offered.fill(0);
	let session: HubSession | undefined;
	let attemptedOpen = false;
	let listener: NativeDeviceTls | undefined;
	let authority: DevicePairingAuthority | undefined;
	let listenerJoin: Promise<void> | undefined;
	let sessionJoin: Promise<void> | undefined;
	let cleanupJoin: Promise<void> | undefined;
	let startup: Promise<EventSocketFixture> | undefined;
	let closing = false;
	let stopWaitingForPeer: (() => void) | undefined;
	let currentManager: FixtureSocketManager | undefined;
	const managers = new Set<FixtureSocketManager>();
	const clients: TLSSocket[] = [];
	const servers: TLSSocket[] = [];
	const parsers: Server[] = [];
	const assertOpen = (): void => {
		if (closing) throw new Error("Event WebSocket fixture is closing");
	};
	const beginClosing = (): void => {
		closing = true;
		stopWaitingForPeer?.();
	};
	const joinStartup = async (): Promise<void> => {
		try {
			await startup;
		} catch {
			// A failed startup still has to settle before its acquired resources are closed.
		}
	};
	const closeSessionOnly = async (): Promise<void> => {
		beginClosing();
		await joinStartup();
		if (session) {
			sessionJoin ??= session.close();
			await sessionJoin;
		} else if (attemptedOpen)
			throw new Error("Event WebSocket fixture session open did not complete");
		else key.destroy();
	};
	const closeSession = async (): Promise<void> => {
		beginClosing();
		await joinStartup();
		if (authority) {
			authority.close();
			authority = undefined;
		}
		await Promise.all(clients.map(destroyTls));
		if (listener) {
			listenerJoin ??= listener.close();
			await listenerJoin;
		}
		await Promise.all(servers.map(destroyTls));
		await closeSessionOnly();
	};
	const close = async (): Promise<void> => {
		beginClosing();
		cleanupJoin ??= (async () => {
			await joinStartup();
			await Promise.all([...managers].map((manager) => manager.close()));
			await closeSession();
			for (const parser of parsers) {
				parser.closeAllConnections();
				parser.removeAllListeners();
			}
			if (
				path.dirname(folder) !== parent ||
				!path.basename(folder).startsWith(PREFIX) ||
				directoryIdentity(parent) !== parentIdentity ||
				directoryIdentity(folder) !== identity
			)
				throw new Error("Unsafe event WebSocket fixture cleanup target");
			rmSync(folder, { recursive: true, force: true });
			cleanupDebt.delete(close);
		})();
		try {
			await cleanupJoin;
		} catch (error) {
			cleanupJoin = undefined;
			throw error;
		}
	};
	cleanupDebt.add(close);
	const start = async (): Promise<EventSocketFixture> => {
		assertOpen();
		const nativeBinding = binding();
		attemptedOpen = true;
		session = await openHubSession({ folder, nativeBinding, masterKey: key });
		assertOpen();
		assertHubSessionAdmission(session);
		const original = session;
		const database = new WorkDatabase(original.store);
		const clock = { now: Date.now() };
		const events = new EventLog(database, () => clock.now);
		const transport = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
		const algorithm = { name: "ECDSA", namedCurve: "P-256" };
		const certificate = await X509CertificateGenerator.createSelfSigned({
			name: "CN=DYTEST event WebSocket device",
			serialNumber: `01${randomBytes(19).toString("hex")}`,
			notBefore: new Date(Date.now() - 300_000),
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
		assertOpen();
		const incoming = Promise.withResolvers<{ peer: NativeDevicePeer; server: TLSSocket }>();
		void incoming.promise.catch(() => {});
		stopWaitingForPeer = () => incoming.reject(new Error("Event WebSocket fixture is closing"));
		let pairingConnection = true;
		listener = new NativeDeviceTls(original.devices, original.identity, (peer, server) => {
			servers.push(server);
			if (pairingConnection) {
				pairingConnection = false;
				incoming.resolve({ peer, server });
				if (closing) server.destroy();
				return;
			}
			if (closing || !currentManager) {
				server.destroy();
				return;
			}
			const manager = currentManager;
			const parser = createServer((_request, response) => {
				response.writeHead(400);
				response.end();
			});
			parsers.push(parser);
			parser.on("clientError", (_error, socket) => socket.destroy());
			parser.on("upgrade", (request, socket, head) => {
				if (socket !== server) {
					socket.destroy();
					return;
				}
				manager.upgrade(peer, request, server, head);
			});
			parser.emit("connection", server);
		});
		const port = await listener.listen();
		assertOpen();
		const tls: ConnectionOptions = {
			host: "127.0.0.1",
			port,
			key: transport.privateKey.export({ type: "pkcs8", format: "pem" }),
			cert: certificate.toString("pem"),
			ca: original.identity.certificate,
			rejectUnauthorized: true,
			minVersion: "TLSv1.3",
			maxVersion: "TLSv1.3",
		};
		const connectTls = async (): Promise<TLSSocket> => {
			assertOpen();
			const socket = connect(tls);
			clients.push(socket);
			socket.on("error", () => {});
			await once(socket, "secureConnect");
			assertOpen();
			if (!socket.authorized || socket.getProtocol() !== "TLSv1.3")
				throw new Error("Event WebSocket fixture requires authenticated TLS 1.3");
			return socket;
		};
		const client = await connectTls();
		assertOpen();
		const pairedPeer = await incoming.promise;
		assertOpen();
		stopWaitingForPeer = undefined;
		const secret = randomBytes(16);
		const pairingAuthority = new DevicePairingAuthority(
			original.devices,
			original.store,
			key,
			secret,
		);
		authority = pairingAuthority;
		const window = { ...sidecarWindowSecrets(secret), role: "device" as const };
		secret.fill(0);
		const nonce = randomBytes(16);
		const signing = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
		const ekm = client.exportKeyingMaterial(
			32,
			"EXPERIMENTAL-draftyak-pair-v1",
			Buffer.from(window.pid, "base64url"),
		);
		let deviceId: string;
		try {
			const claim = makePairingClaim(
				window,
				{
					name: "DYTEST event WebSocket device",
					transportSpkiSha256: createHash("sha256")
						.update(transport.publicKey.export({ type: "spki", format: "der" }))
						.digest("hex"),
					signingKey: signing.publicKey
						.export({ type: "spki", format: "der" })
						.toString("base64url"),
				},
				ekm,
				nonce,
			);
			const answer = original.store.write((sql) =>
				pairingAuthority.claim(sql, pairedPeer.peer, encode(claim)),
			);
			const paired = original.store.write((sql) =>
				pairingAuthority.reveal(
					sql,
					pairedPeer.peer,
					encode({ pid: window.pid, nd: nonce.toString("base64url") }),
				),
			);
			if (paired.deviceId !== answer.deviceId || paired.epoch !== answer.epoch)
				throw new Error("Event WebSocket fixture pairing did not complete");
			deviceId = paired.deviceId;
		} finally {
			ekm.fill(0);
			nonce.fill(0);
		}
		let ownerUserId: string | undefined;
		const authorize = async (): Promise<string> => {
			assertOpen();
			const grant = await original.devices.bootstrap(deviceId, EVENT_PIN);
			assertOpen();
			ownerUserId = grant.userId;
			return ownerUserId;
		};
		if (bootstrap) await authorize();
		assertOpen();
		return {
			session: original,
			database,
			events,
			clock,
			deviceId,
			get ownerUserId() {
				return ownerUserId;
			},
			url: `wss://127.0.0.1:${port}/device/v1/events`,
			tls,
			servers,
			mount(manager) {
				assertOpen();
				managers.add(manager);
				currentManager = manager;
			},
			bootstrap: authorize,
			connectTls,
			closeSessionOnly,
			closeSession,
		};
	};
	startup = Promise.resolve().then(start);
	return startup;
}
