import "reflect-metadata";
import { createHash, generateKeyPairSync, randomBytes, randomInt } from "node:crypto";
import { lstatSync, mkdtempSync, readdirSync, realpathSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { connect, type TLSSocket } from "node:tls";
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
import { type AccountRecord, NativeAccounts } from "../../src/accounts/records.ts";
import { AuditChain } from "../../src/audit/chain.ts";
import { Authorizer } from "../../src/authz/authorizer.ts";
import { type NativeDevicePeer, NativeDeviceTls } from "../../src/authz/native-peer.ts";
import { EVENT_MIGRATIONS, EventLog } from "../../src/events/log.ts";
import { DEVICE_MIGRATIONS, DeviceRegistry } from "../../src/identity/devices.ts";
import { DevicePairingAuthority } from "../../src/identity/devices-pairing.ts";
import { HubIdentity } from "../../src/identity/hub-key.ts";
import { PinService } from "../../src/identity/pin.ts";
import { WorkDatabase } from "../../src/jobs/database.ts";
import { JOB_MIGRATIONS, JobQueue } from "../../src/jobs/queue.ts";
import { newId } from "../../src/kernel/ids.ts";
import { MasterKey } from "../../src/kernel/master-key.ts";
import { NativeProviderConsent, PROVIDER_CONSENT_MIGRATIONS } from "../../src/policy/consent.ts";
import { HubStore } from "../../src/store/store.ts";
import { migrations, nativeBinding } from "../store/helpers.ts";

export interface ProviderConsentFixture {
	readonly store: HubStore;
	readonly database: WorkDatabase;
	readonly events: EventLog;
	readonly queue: JobQueue;
	readonly accounts: NativeAccounts;
	readonly registry: DeviceRegistry;
	readonly pins: PinService;
	readonly authorizer: Authorizer;
	readonly consent: NativeProviderConsent;
	readonly peer: NativeDevicePeer;
	readonly pin: string;
	readonly account: AccountRecord;
	readonly clock: { wall: number; monotonic: number };
	closePeer(): Promise<void>;
	close(): Promise<void>;
}

interface Owned {
	readonly store: HubStore;
	audit?: AuditChain;
	pins?: PinService;
	identity?: HubIdentity;
	registry?: DeviceRegistry;
	consent?: NativeProviderConsent;
	closed?: boolean;
}

// A failed close retains its actual resources, key and directory for diagnosis.
const uncertain = new Set<object>();
const unavailable = (): Error => new Error("Provider consent fixture unavailable");

function privatePem(der: Buffer): Buffer {
	const alphabet = Buffer.from("ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/");
	const header = Buffer.from("-----BEGIN PRIVATE KEY-----\n");
	const footer = Buffer.from("-----END PRIVATE KEY-----\n");
	const chars = Math.ceil(der.length / 3) * 4;
	const result = Buffer.alloc(header.length + chars + Math.ceil(chars / 64) + footer.length);
	header.copy(result);
	let at = header.length,
		column = 0;
	const emit = (byte: number): void => {
		result[at++] = byte;
		if (++column === 64) {
			result[at++] = 10;
			column = 0;
		}
	};
	for (let i = 0; i < der.length; i += 3) {
		const a = der[i] ?? 0,
			b = der[i + 1] ?? 0,
			c = der[i + 2] ?? 0;
		emit(alphabet[a >> 2] ?? 0);
		emit(alphabet[((a & 3) << 4) | (b >> 4)] ?? 0);
		emit(i + 1 < der.length ? (alphabet[((b & 15) << 2) | (c >> 6)] ?? 0) : 61);
		emit(i + 2 < der.length ? (alphabet[c & 63] ?? 0) : 61);
	}
	if (column !== 0) result[at++] = 10;
	footer.copy(result, at);
	return result;
}

/** A live original TLS peer, genuine bootstrap PIN and encrypted policy resources. */
export async function providerConsentFixture(): Promise<ProviderConsentFixture> {
	const parent = realpathSync(os.tmpdir());
	const dir = realpathSync(mkdtempSync(path.join(parent, "draftyak-provider-consent-test-")));
	const root = lstatSync(dir, { bigint: true });
	const keyBytes = randomBytes(32);
	const key = new MasterKey(keyBytes);
	keyBytes.fill(0);
	const filename = path.join(dir, "fixture.db");
	const registered = Object.freeze({
		audit: path.join(migrations, "audit"),
		core: path.join(migrations, "core"),
		devices: DEVICE_MIGRATIONS,
		jobs: JOB_MIGRATIONS,
		events: EVENT_MIGRATIONS,
		accounts: path.resolve(import.meta.dirname, "../../src/accounts/migrations"),
		providerconsents: PROVIDER_CONSENT_MIGRATIONS,
	});
	const clock = { wall: Date.now(), monotonic: 50_000 };
	const nativeClock = { wallMs: () => clock.wall, monotonicMs: () => clock.monotonic };
	const owned = new Set<Owned>();
	const pending = new Set<Promise<unknown>>();
	const transient = new Set<Uint8Array>();
	const sockets = new Map<TLSSocket, { readonly closed: Promise<void>; done: boolean }>();
	let listener: NativeDeviceTls | undefined;
	let pairing: DevicePairingAuthority | undefined;
	let rejectPeer: ((reason: Error) => void) | undefined;
	let peerTimeout: ReturnType<typeof setTimeout> | undefined;
	let transportClosing: Promise<void> | undefined;
	let closing: Promise<void> | undefined;
	let closed = false;
	let setupStage = "open";
	const retain = <T>(original: Promise<T>): Promise<T> => {
		pending.add(original);
		void original.then(
			() => pending.delete(original),
			() => pending.delete(original),
		);
		return original;
	};
	const secret = <T extends Uint8Array>(bytes: T): T => {
		transient.add(bytes);
		return bytes;
	};
	const ownSocket = (socket: TLSSocket): void => {
		const done = Promise.withResolvers<void>();
		const record = { closed: done.promise, done: false };
		sockets.set(socket, record);
		socket.once("close", () => {
			record.done = true;
			done.resolve();
		});
		// Original handshake/peer observers handle errors; close is the resource join.
		socket.on("error", () => {});
	};
	const closePeer = (): Promise<void> => {
		transportClosing ??= Promise.resolve().then(async () => {
			if (peerTimeout) clearTimeout(peerTimeout);
			rejectPeer?.(unavailable());
			let failed = false;
			try {
				pairing?.close();
			} catch {
				failed = true;
			}
			for (const socket of sockets.keys()) {
				try {
					socket.destroy();
				} catch {
					failed = true;
				}
			}
			let originalClose: Promise<void> | undefined;
			try {
				originalClose = listener ? NativeDeviceTls.prototype.close.call(listener) : undefined;
			} catch {
				failed = true;
			}
			const joins = await Promise.allSettled([
				...(originalClose ? [originalClose] : []),
				...[...sockets.values()].map((record) => record.closed),
			]);
			if (
				failed ||
				joins.some((join) => join.status === "rejected") ||
				[...sockets.values()].some((record) => !record.done)
			)
				throw unavailable();
		});
		return transportClosing;
	};
	const dispose = (resource: Owned): void => {
		if (resource.closed) return;
		if (resource.consent) NativeProviderConsent.prototype.destroy.call(resource.consent);
		if (resource.registry) DeviceRegistry.prototype.lock.call(resource.registry);
		if (resource.pins) PinService.prototype.lock.call(resource.pins);
		if (resource.identity) HubIdentity.prototype.lock.call(resource.identity);
		HubStore.prototype.close.call(resource.store);
		if (resource.audit) AuditChain.prototype.destroy.call(resource.audit);
		resource.closed = true;
	};
	const remove = (): void => {
		const current = lstatSync(dir, { bigint: true });
		if (
			path.dirname(dir) !== parent ||
			!path.basename(dir).startsWith("draftyak-provider-consent-test-") ||
			!current.isDirectory() ||
			current.isSymbolicLink() ||
			realpathSync(dir) !== dir ||
			current.dev !== root.dev ||
			current.ino !== root.ino ||
			current.birthtimeNs !== root.birthtimeNs ||
			current.mode !== root.mode
		)
			throw unavailable();
		for (const name of readdirSync(dir)) {
			if (!/^fixture\.db(?:-wal|-shm|-journal)?$/.test(name)) throw unavailable();
			const entry = path.join(dir, name),
				stat = lstatSync(entry);
			if (
				!stat.isFile() ||
				stat.isSymbolicLink() ||
				stat.nlink !== 1 ||
				realpathSync(entry) !== entry
			)
				throw unavailable();
		}
		rmSync(dir, { recursive: true, force: false });
		try {
			lstatSync(dir);
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
			throw unavailable();
		}
		throw unavailable();
	};
	const close = (): Promise<void> => {
		if (closing) return closing;
		closed = true;
		closing = Promise.resolve().then(async () => {
			try {
				let transportFailed = false;
				try {
					await closePeer();
				} catch {
					transportFailed = true;
				}
				await Promise.allSettled([...pending]);
				if (transportFailed) throw unavailable();
				let failed = false;
				for (const resource of owned) {
					try {
						dispose(resource);
					} catch {
						failed = true;
					}
				}
				if (failed) throw unavailable();
				for (const bytes of transient) bytes.fill(0);
				transient.clear();
				remove();
				key.destroy();
			} catch {
				uncertain.add({ close, key, dir, owned, pending, sockets, transient, listener, pairing });
				throw unavailable();
			}
		});
		return closing;
	};
	try {
		const store = new HubStore({
			filename,
			nativeBinding,
			masterKey: key,
			create: true,
			migrations: registered,
		});
		const resource: Owned = { store };
		owned.add(resource);
		for (const namespace of Object.keys(registered)) await retain(store.migrate(namespace));
		const auditBytes = key.derive("audit");
		let audit: AuditChain;
		try {
			audit = new AuditChain(auditBytes);
		} finally {
			auditBytes.fill(0);
		}
		resource.audit = audit;
		const identity = await retain(HubIdentity.loadOrCreate(store, key));
		resource.identity = identity;
		if (closed) throw unavailable();
		const database = new WorkDatabase(store);
		const events = new EventLog(database, () => clock.wall);
		const queue = new JobQueue(database, events, nativeClock);
		const pins = new PinService(store, audit, nativeClock);
		resource.pins = pins;
		const registry = new DeviceRegistry(store, audit, pins, { identity, clock: nativeClock });
		resource.registry = registry;
		const accounts = new NativeAccounts(database, events, audit, () => clock.wall);
		const authorizer = new Authorizer(registry);
		const consent = new NativeProviderConsent(
			store,
			database,
			authorizer,
			accounts,
			audit,
			pins,
			key,
			nativeClock,
		);
		resource.consent = consent;
		setupStage = "certificate";
		const transport = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
		const signing = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
		const algorithm = { name: "ECDSA", namedCurve: "P-256" };
		const certificate = await retain(
			X509CertificateGenerator.createSelfSigned({
				name: "CN=DYTEST provider consent device",
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
			}),
		);
		const expectedSpki = createHash("sha256")
			.update(Buffer.from(exportSpki(transport.publicKey), "base64url"))
			.digest("hex");
		const peer = Promise.withResolvers<NativeDevicePeer>();
		rejectPeer = peer.reject;
		retain(peer.promise);
		listener = new NativeDeviceTls(registry, identity, (originalPeer, socket) => {
			ownSocket(socket);
			try {
				const actual = socket.getPeerX509Certificate();
				if (
					!actual ||
					createHash("sha256")
						.update(Buffer.from(exportSpki(actual.publicKey), "base64url"))
						.digest("hex") !== expectedSpki ||
					sockets.size > 2
				)
					throw unavailable();
				peer.resolve(originalPeer);
			} catch {
				peer.reject(unavailable());
				socket.destroy();
			}
		});
		peerTimeout = setTimeout(() => peer.reject(unavailable()), 5_000);
		setupStage = "listen";
		const port = await retain(listener.listen());
		const der = secret(transport.privateKey.export({ type: "pkcs8", format: "der" }));
		const pem = secret(privatePem(der));
		setupStage = "connect";
		const client = connect({
			host: "127.0.0.1",
			port,
			key: pem,
			cert: certificate.toString("pem"),
			ca: identity.certificate,
			minVersion: "TLSv1.3",
			maxVersion: "TLSv1.3",
			rejectUnauthorized: true,
		});
		ownSocket(client);
		const handshake = retain(
			new Promise<void>((resolve, reject) => {
				client.once("secureConnect", () => {
					if (!client.authorized || client.getProtocol() !== "TLSv1.3") reject(unavailable());
					else resolve();
				});
				client.once("error", () => {
					reject(unavailable());
					peer.reject(unavailable());
				});
				client.once("close", () => {
					reject(unavailable());
					peer.reject(unavailable());
				});
			}),
		);
		setupStage = "peer";
		const originalPeer = (await retain(Promise.all([peer.promise, handshake])))[0];
		if (peerTimeout) clearTimeout(peerTimeout);
		const bootstrap = secret(randomBytes(16)),
			nonce = secret(randomBytes(16));
		pairing = new DevicePairingAuthority(registry, store, key, bootstrap);
		const window = { ...sidecarWindowSecrets(bootstrap), role: "device" as const };
		const ekm = secret(pairingEkm(client, window.pid));
		const claim = makePairingClaim(
			window,
			{
				name: "DYTEST provider consent device",
				transportSpkiSha256: expectedSpki,
				signingKey: exportSpki(signing.publicKey),
			},
			ekm,
			nonce,
		);
		const claimBytes = secret(Buffer.from(JSON.stringify(claim)));
		setupStage = "claim";
		store.write((sql) => pairing?.claim(sql, originalPeer, claimBytes));
		const revealBytes = secret(
			Buffer.from(JSON.stringify({ pid: window.pid, nd: nonce.toString("base64url") })),
		);
		setupStage = "reveal";
		const candidate = store.write((sql) => pairing?.reveal(sql, originalPeer, revealBytes));
		if (!candidate) throw unavailable();
		const pin = randomInt(10_000_000, 100_000_000).toString();
		setupStage = "bootstrap";
		const grant = await retain(registry.bootstrap(candidate.deviceId, pin));
		setupStage = "account";
		const account = database.write((scope) =>
			accounts.create(scope, {
				id: newId(clock.wall),
				userId: grant.userId,
				pluginInstanceId: newId(clock.wall),
				channel: "chat",
				alias: "dytest-consent",
				mode: "full",
				status: "active",
				deletionDeadline: null,
				historyLimitDays: 365,
				disclosureVersion: 1,
				createdAt: clock.wall,
				teamId: "T_DYTEST",
				selfUserId: "U_DYTEST",
			}),
		);
		const state = registry.currentState();
		if (!state.bootstrapDone || state.ownerUserId !== account.account.userId) throw unavailable();
		return Object.freeze({
			store,
			database,
			events,
			queue,
			accounts,
			registry,
			pins,
			authorizer,
			consent,
			peer: originalPeer,
			pin,
			account,
			clock,
			closePeer,
			close,
		});
	} catch (error) {
		const rawCode =
			error !== null && typeof error === "object"
				? Object.getOwnPropertyDescriptor(error, "code")?.value
				: undefined;
		const code =
			typeof rawCode === "string" && /^[A-Z0-9_]{1,64}$/.test(rawCode) ? rawCode : "UNCLASSIFIED";
		await close();
		throw new Error(`Provider consent fixture unavailable at ${setupStage}: ${code}`);
	}
}
