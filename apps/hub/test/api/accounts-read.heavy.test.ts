import "reflect-metadata";
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
import { afterEach, expect, it } from "vitest";
import { NativeAccounts } from "../../src/accounts/records.ts";
import {
	AccountReadError,
	type AccountReadErrorCode,
	createNativeAccountReads,
} from "../../src/api/accounts.ts";
import { Authorizer } from "../../src/authz/authorizer.ts";
import { type NativeDevicePeer, NativeDeviceTls } from "../../src/authz/native-peer.ts";
import { EventLog } from "../../src/events/log.ts";
import { DevicePairingAuthority } from "../../src/identity/devices-pairing.ts";
import { WorkDatabase } from "../../src/jobs/database.ts";
import { newId } from "../../src/kernel/ids.ts";
import { MasterKey } from "../../src/kernel/master-key.ts";
import { type HubSession, openHubSession } from "../../src/lifecycle/session.ts";
import { requireLoopbackNetworkGuard } from "../helpers/loopback-network.ts";

const PIN = "694182";
const PREFIX = "draftyak-account-reads-";
const require = createRequire(import.meta.url);
const nativeBinding = path.join(
	path.dirname(path.dirname(require.resolve("better-sqlite3-multiple-ciphers"))),
	"prebuilds",
	`${process.platform}-${process.arch}.node`,
);

interface Fixture {
	readonly session: HubSession;
	readonly peer: NativeDevicePeer;
	readonly client: TLSSocket;
	readonly server: TLSSocket;
	readonly tls: NativeDeviceTls;
	readonly deviceId: string;
	readonly owner: string;
	readonly folder: string;
}
const fixtures: Fixture[] = [];

interface DeviceKeys {
	readonly privateKey: KeyObject;
	readonly transportSpkiSha256: string;
	readonly signingKey: string;
	readonly certificate: string;
}

async function deviceKeys(): Promise<DeviceKeys> {
	const transport = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
	const signing = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
	const algorithm = { name: "ECDSA", namedCurve: "P-256" };
	const cert = await X509CertificateGenerator.createSelfSigned({
		name: "CN=Account read fixture device",
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
		certificate: cert.toString("pem"),
	};
}

// Each peer below is issued by the production listener after a real mutual TLS handshake.
// Only the account rows and generated local device keys are synthetic fixture data.
async function fixture(reusedKeys?: DeviceKeys): Promise<Fixture> {
	requireLoopbackNetworkGuard();
	const folder = await realpath(await mkdtemp(path.join(tmpdir(), PREFIX)));
	const bytes = randomBytes(32);
	const key = new MasterKey(bytes);
	bytes.fill(0);
	let session: HubSession | undefined;
	let tls: NativeDeviceTls | undefined;
	let client: TLSSocket | undefined;
	try {
		session = await openHubSession({ folder, nativeBinding, masterKey: key });
		const keys = reusedKeys ?? (await deviceKeys());
		let accept: (value: { peer: NativeDevicePeer; server: TLSSocket }) => void = () => {
			throw new Error("Unexpected fixture connection");
		};
		const accepted = new Promise<{ peer: NativeDevicePeer; server: TLSSocket }>((resolve) => {
			accept = resolve;
		});
		tls = new NativeDeviceTls(session.devices, session.identity, (peer, server) => {
			accept({ peer, server });
		});
		const port = await tls.listen();
		client = connect({
			host: "127.0.0.1",
			port,
			ca: session.identity.certificate,
			cert: keys.certificate,
			key: keys.privateKey.export({ type: "pkcs8", format: "pem" }),
			minVersion: "TLSv1.3",
			maxVersion: "TLSv1.3",
			rejectUnauthorized: true,
		});
		client.setTimeout(5_000, () => client?.destroy(new Error("Fixture TLS timeout")));
		await once(client, "secureConnect");
		const { peer, server } = await accepted;
		client.setTimeout(0);
		client.on("error", () => {});
		expect(client.authorized).toBe(true);
		expect(client.getProtocol()).toBe("TLSv1.3");
		const secret = randomBytes(16);
		const nonce = randomBytes(16);
		const authority = new DevicePairingAuthority(session.devices, session.store, key, secret);
		try {
			const window = { ...sidecarWindowSecrets(secret), role: "device" as const };
			const ekm = pairingEkm(client, window.pid);
			try {
				const claim = makePairingClaim(
					window,
					{
						name: "Account read fixture",
						transportSpkiSha256: keys.transportSpkiSha256,
						signingKey: keys.signingKey,
					},
					ekm,
					nonce,
				);
				const answer = session.store.write((sql) =>
					authority.claim(sql, peer, Buffer.from(JSON.stringify(claim))),
				);
				const candidate = session.store.write((sql) =>
					authority.reveal(
						sql,
						peer,
						Buffer.from(JSON.stringify({ pid: window.pid, nd: nonce.toString("base64url") })),
					),
				);
				expect(candidate.deviceId).toBe(answer.deviceId);
				const grant = await session.devices.bootstrap(candidate.deviceId, PIN);
				const result: Fixture = {
					session,
					peer,
					client,
					server,
					tls,
					deviceId: grant.deviceId,
					owner: grant.ownerUserId,
					folder,
				};
				fixtures.push(result);
				return result;
			} finally {
				ekm.fill(0);
			}
		} finally {
			authority.close();
			secret.fill(0);
			nonce.fill(0);
		}
	} catch (error) {
		client?.destroy();
		await tls?.close();
		await session?.close();
		key.destroy();
		await removeFolder(folder);
		throw error;
	}
}

async function removeFolder(folder: string): Promise<void> {
	if (
		path.dirname(folder) !== (await realpath(tmpdir())) ||
		!path.basename(folder).startsWith(PREFIX)
	)
		throw new Error("Fixture directory refused");
	await rm(folder, { recursive: true, force: true });
}

afterEach(async () => {
	for (const f of fixtures.splice(0).reverse()) {
		f.client.destroy();
		await f.tls.close();
		await f.session.close();
		await removeFolder(f.folder);
	}
});

function addAccounts(f: Fixture, count: number, userId = f.owner): string[] {
	const database = new WorkDatabase(f.session.store);
	const accounts = new NativeAccounts(
		database,
		new EventLog(database, Date.now),
		f.session.audit,
		Date.now,
	);
	const pluginInstanceId = newId();
	return database.write((scope) => {
		const ids: string[] = [];
		for (let index = 0; index < count; index++) {
			const account: Account = {
				id: newId(),
				userId,
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
			};
			accounts.create(scope, account);
			ids.push(account.id);
		}
		return ids.sort();
	});
}

function refused(work: () => unknown, code: AccountReadErrorCode): void {
	let failure: unknown;
	try {
		work();
	} catch (error) {
		failure = error;
	}
	expect(failure).toBeInstanceOf(AccountReadError);
	expect(failure).toMatchObject({ code, message: code, name: "AccountReadError" });
	expect(Object.hasOwn(failure as object, "cause")).toBe(false);
}

it("reads only the current owner's immutable account metadata", async () => {
	const f = await fixture();
	const [id] = addAccounts(f, 1);
	const [privateId] = addAccounts(f, 1, newId());
	if (!id || !privateId) throw new Error("Missing fixture account");
	const reads = createNativeAccountReads(f.session);
	expect(Object.isFrozen(reads)).toBe(true);
	const record = reads.get(f.peer, id);
	expect(record?.account.id).toBe(id);
	expect(record?.account.userId).toBe(f.owner);
	expect(record?.generation).toBe(1);
	expect(Object.isFrozen(record)).toBe(true);
	expect(Object.isFrozen(record?.account)).toBe(true);
	expect(reads.get(f.peer, privateId)).toBeUndefined();
	expect(reads.get(f.peer, newId())).toBeUndefined();
});

it("pages more than one hundred owner records without duplicates or foreign rows", async () => {
	const f = await fixture();
	const ids = addAccounts(f, 103);
	addAccounts(f, 2, newId());
	const reads = createNativeAccountReads(f.session);
	const first = reads.page(f.peer, null);
	expect(first.accounts.map((record) => record.account.id)).toEqual(ids.slice(0, 100));
	expect(first.nextId).toBe(ids[99]);
	const second = reads.page(f.peer, first.nextId);
	expect(second.accounts.map((record) => record.account.id)).toEqual(ids.slice(100));
	expect(second.nextId).toBeNull();
	const all = [...first.accounts, ...second.accounts];
	expect(new Set(all.map((record) => record.account.id)).size).toBe(103);
	for (const page of [first, second]) {
		expect(Object.isFrozen(page)).toBe(true);
		expect(Object.isFrozen(page.accounts)).toBe(true);
		for (const record of page.accounts) {
			expect(record.account.userId).toBe(f.owner);
			expect(Object.isFrozen(record)).toBe(true);
			expect(Object.isFrozen(record.account)).toBe(true);
		}
	}
	const last = ids.at(-1);
	if (!last) throw new Error("Missing final fixture account");
	expect(reads.page(f.peer, last)).toEqual({ accounts: [], nextId: null });
});

it("accepts a real owner peer reduced to read only and samples grants after work guards", async () => {
	const f = await fixture();
	const [id] = addAccounts(f, 1);
	if (!id) throw new Error("Missing fixture account");
	f.session.store.write((sql) => {
		expect(sql.run("UPDATE main.devices SET capabilities=1 WHERE id=?", [f.deviceId]).changes).toBe(
			1,
		);
	});
	const authorizer = new Authorizer(f.session.devices);
	const capabilities = f.session.store.read(
		(sql) => authorizer.requirePeerDevice(sql, f.peer, "read").capabilities,
	);
	expect(capabilities).toEqual(["read"]);
	const reads = createNativeAccountReads(f.session);
	expect(reads.get(f.peer, id)?.account.id).toBe(id);
	// WorkDatabase.sql/page and its final scope guard write jobs_meta; a prior stamp is stale.
	expect(reads.page(f.peer, null).accounts.map((record) => record.account.id)).toEqual([id]);
});

it("does not change account, audit or event data while performing a point read", async () => {
	const f = await fixture();
	const [id] = addAccounts(f, 1);
	if (!id) throw new Error("Missing fixture account");
	const changes = (): unknown =>
		f.session.store.read((sql) => sql.get("SELECT total_changes() AS count"));
	const before = changes();
	expect(createNativeAccountReads(f.session).get(f.peer, id)?.account.id).toBe(id);
	expect(changes()).toEqual(before);
});

it("refuses a genuine peer issued by another original session", async () => {
	// A shared real device key must not turn another listener's issued peer into authority.
	const keys = await deviceKeys();
	const first = await fixture(keys);
	const second = await fixture(keys);
	const [firstId] = addAccounts(first, 1);
	const [secondId] = addAccounts(second, 1);
	if (!firstId || !secondId) throw new Error("Missing fixture account");
	const a = createNativeAccountReads(first.session);
	const b = createNativeAccountReads(second.session);
	expect(a.get(first.peer, firstId)?.account.id).toBe(firstId);
	expect(b.get(second.peer, secondId)?.account.id).toBe(secondId);
	refused(() => a.get(second.peer, firstId), "FORBIDDEN");
	refused(() => a.page(second.peer, null), "FORBIDDEN");
	refused(() => b.get(first.peer, secondId), "FORBIDDEN");
	refused(() => b.page(first.peer, null), "FORBIDDEN");
});

it("rechecks durable revocation on an already constructed read handle", async () => {
	const f = await fixture();
	const [id] = addAccounts(f, 1);
	if (!id) throw new Error("Missing fixture account");
	const reads = createNativeAccountReads(f.session);
	expect(reads.get(f.peer, id)?.account.id).toBe(id);
	// Narrow the sole bootstrap device before revoking it; no last-approver bypass is needed.
	f.session.store.write((sql) => {
		sql.run("UPDATE main.devices SET capabilities=1 WHERE id=?", [f.deviceId]);
		expect(f.session.devices.revoke(sql, f.deviceId, { kind: "cli" })).toBe(true);
	});
	refused(() => reads.get(f.peer, id), "FORBIDDEN");
	refused(() => reads.page(f.peer, null), "FORBIDDEN");
});

it("rejects invalid primitive ids and cursors without coercing caller objects", async () => {
	const f = await fixture();
	const reads = createNativeAccountReads(f.session);
	let touches = 0;
	const object = {
		toString() {
			touches++;
			return newId();
		},
	};
	const proxy = new Proxy(object, {
		get() {
			touches++;
			throw new Error("Caller property touched");
		},
	});
	const revoked = Proxy.revocable({}, {});
	revoked.revoke();
	for (const value of [
		undefined,
		null,
		0,
		false,
		"",
		"A".repeat(25),
		"A".repeat(27),
		"I".repeat(26),
		[],
		Object(newId()),
		object,
		proxy,
		revoked.proxy,
	]) {
		refused(() => reads.get(f.peer, value as never), "INVALID_REQUEST");
		if (value !== null) refused(() => reads.page(f.peer, value as never), "INVALID_REQUEST");
	}
	expect(touches).toBe(0);
	expect(reads.page(f.peer, null)).toEqual({ accounts: [], nextId: null });
});

// Observe only the real socket's native lifetime getter. The peer and native getter are
// never replaced. On the second call, destroy that same socket at the fresh publish gate.
function closeAtPublication(socket: TLSSocket, work: () => unknown): () => boolean {
	if (Object.hasOwn(socket, "destroyed")) throw new Error("Unexpected socket lifetime property");
	let prototype: object | null = Object.getPrototypeOf(socket);
	let get: (() => boolean) | undefined;
	while (prototype !== null && get === undefined) {
		get = Object.getOwnPropertyDescriptor(prototype, "destroyed")?.get;
		prototype = Object.getPrototypeOf(prototype);
	}
	if (get === undefined) throw new Error("Native socket lifetime getter unavailable");
	const nativeGet = get;
	let count = 0;
	let closeAt: number | undefined;
	let closed = false;
	const remove = (): void => {
		if (!Reflect.deleteProperty(socket, "destroyed"))
			throw new Error("Fixture lifetime observation could not be removed");
	};
	Object.defineProperty(socket, "destroyed", {
		configurable: true,
		get() {
			count++;
			if (count === closeAt) {
				remove();
				closed = true;
				socket.destroy();
			}
			return Reflect.apply(nativeGet, socket, []);
		},
	});
	try {
		work();
		// The final read gate has requirePeer, currentGrant and the explicit tail assertion.
		// Count with the genuine positive path, then close on the first of those last three.
		expect(count).toBeGreaterThanOrEqual(4);
		closeAt = count - 2;
		count = 0;
		return () => {
			remove();
			return closed;
		};
	} catch (error) {
		remove();
		throw error;
	}
}

it.each(["get", "page"] as const)(
	"refuses %s publication when its genuine TLS peer closes after the account scope",
	async (operation) => {
		const f = await fixture();
		const [id] = addAccounts(f, 1);
		if (!id) throw new Error("Missing fixture account");
		const reads = createNativeAccountReads(f.session);
		const work = (): unknown =>
			operation === "get" ? reads.get(f.peer, id) : reads.page(f.peer, null);
		const restore = closeAtPublication(f.server, work);
		try {
			refused(work, "FORBIDDEN");
		} finally {
			expect(restore()).toBe(true);
		}
	},
);

it("refuses a closed real transport and a closed original session", async () => {
	const f = await fixture();
	const [id] = addAccounts(f, 1);
	if (!id) throw new Error("Missing fixture account");
	const reads = createNativeAccountReads(f.session);
	await f.tls.close();
	refused(() => reads.get(f.peer, id), "FORBIDDEN");
	refused(() => reads.page(f.peer, null), "FORBIDDEN");
	await f.session.close();
	refused(() => reads.get(f.peer, id), "UNAVAILABLE");
	refused(() => reads.page(f.peer, null), "UNAVAILABLE");
	refused(() => createNativeAccountReads(f.session), "UNAVAILABLE");
});
