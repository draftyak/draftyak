import "reflect-metadata";
import { createHash, generateKeyPairSync, randomBytes, X509Certificate } from "node:crypto";
import { once } from "node:events";
import { lstatSync, mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import { connect, type TLSSocket } from "node:tls";
import {
	checkEventStream,
	checkFrameLength,
	EventFrame,
	EventsRequest,
} from "@draftyak/protocol/device-api";
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
import { afterEach, describe, expect, it } from "vitest";
import { createNativeEventPageReader, NativeEventPageError } from "../../src/api/events.ts";
import { type NativeDevicePeer, NativeDeviceTls } from "../../src/authz/native-peer.ts";
import { revokePinScope } from "../../src/authz/scopes.ts";
import { EventLog } from "../../src/events/log.ts";
import { advanceEpochForRestore } from "../../src/identity/devices.ts";
import { DevicePairingAuthority } from "../../src/identity/devices-pairing.ts";
import { WorkDatabase } from "../../src/jobs/database.ts";
import { MasterKey } from "../../src/kernel/master-key.ts";
import {
	assertHubSessionAdmission,
	type HubSession,
	openHubSession,
} from "../../src/lifecycle/session.ts";
import { readStamp } from "../../src/store/read-stamp.ts";

type Reader = ReturnType<typeof createNativeEventPageReader>;
type Page = ReturnType<Reader["read"]>;
type AppendInput = Parameters<EventLog["append"]>[1];
type ErrorCode = "INVALID_REQUEST" | "FORBIDDEN" | "UNAVAILABLE";

const PIN = "640281";
const DAY = 86_400_000;
const FOLDER_PREFIX = "draftyak-event-page-";
const id = (value: number): string => String(value).padStart(26, "0");
const bytes = (value: unknown): Uint8Array => Buffer.from(canonicalize(value), "utf8");
const request = (after: string | null): Uint8Array => bytes(EventsRequest.parse({ after }));
const require = createRequire(import.meta.url);

function nativeBinding(): string {
	const manifestPath = require.resolve("better-sqlite3-multiple-ciphers/package.json");
	const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as {
		name?: unknown;
		version?: unknown;
	};
	if (manifest.name !== "better-sqlite3-multiple-ciphers" || manifest.version !== "13.0.3")
		throw new Error("Event fixture requires the pinned SQLite package");
	let platform: string = process.platform;
	if (platform === "linux") {
		const report = process.report.getReport() as {
			header: { glibcVersionRuntime?: string };
		};
		if (!report.header.glibcVersionRuntime) platform = "linuxmusl";
	}
	const target = `${platform}-${process.arch}`;
	if (
		![
			"darwin-arm64",
			"darwin-x64",
			"linux-arm64",
			"linux-x64",
			"linuxmusl-arm64",
			"linuxmusl-x64",
			"win32-arm64",
			"win32-x64",
		].includes(target)
	)
		throw new Error("Event fixture requires a supported SQLite target");
	return realpathSync.native(path.join(path.dirname(manifestPath), "prebuilds", `${target}.node`));
}

interface DirectoryIdentity {
	readonly dev: bigint;
	readonly ino: bigint;
	readonly birthtimeNs: bigint;
}
interface Resources {
	readonly folder: string;
	readonly tmpRoot: string;
	readonly tmpRootIdentity: DirectoryIdentity;
	folderIdentity?: DirectoryIdentity;
	readonly clients: TLSSocket[];
	readonly listeners: NativeDeviceTls[];
	readonly listenerJoins: Map<NativeDeviceTls, Promise<void>>;
	readonly authorities: DevicePairingAuthority[];
	readonly readers: Reader[];
	key?: MasterKey;
	session?: HubSession;
	sessionOpenAttempted: boolean;
	openFailure?: unknown;
	sessionJoin?: Promise<void>;
}
interface SessionFixture {
	readonly session: HubSession;
	readonly key: MasterKey;
	readonly database: WorkDatabase;
	readonly events: EventLog;
	readonly resources: Resources;
	readonly clock: { now: number };
}
interface PairedDevice {
	readonly peer: NativeDevicePeer;
	readonly server: TLSSocket;
	readonly client: TLSSocket;
	readonly deviceId: string;
}
interface AuthorizedFixture extends SessionFixture {
	readonly device: PairedDevice;
	readonly ownerUserId: string;
}
const resources: Resources[] = [];
const failedCleanupDebt: Resources[] = [];

function directoryIdentity(directory: string): DirectoryIdentity {
	const stat = lstatSync(directory, { bigint: true });
	if (
		!stat.isDirectory() ||
		stat.isSymbolicLink() ||
		stat.ino === 0n ||
		realpathSync.native(directory) !== directory
	)
		throw new Error("Unsafe event fixture directory");
	return { dev: stat.dev, ino: stat.ino, birthtimeNs: stat.birthtimeNs };
}

function sameDirectory(left: DirectoryIdentity, right: DirectoryIdentity): boolean {
	return left.dev === right.dev && left.ino === right.ino && left.birthtimeNs === right.birthtimeNs;
}

function removeOwnedFolder(owned: Resources): void {
	const resolved = path.resolve(owned.folder);
	if (
		!path.isAbsolute(owned.folder) ||
		resolved !== owned.folder ||
		path.dirname(resolved) !== owned.tmpRoot ||
		!path.basename(resolved).startsWith(FOLDER_PREFIX) ||
		path.basename(resolved).length <= FOLDER_PREFIX.length ||
		owned.folderIdentity === undefined ||
		!sameDirectory(directoryIdentity(owned.tmpRoot), owned.tmpRootIdentity) ||
		!sameDirectory(directoryIdentity(resolved), owned.folderIdentity)
	)
		throw new Error("Unsafe event fixture cleanup target");
	rmSync(resolved, { recursive: true, force: true });
}

async function joinListeners(owned: Resources): Promise<boolean> {
	const joins = owned.listeners.map((listener) => {
		let joined = owned.listenerJoins.get(listener);
		if (joined === undefined) {
			joined = Promise.resolve().then(() => listener.close());
			owned.listenerJoins.set(listener, joined);
		}
		return joined;
	});
	return (await Promise.allSettled(joins)).every((result) => result.status === "fulfilled");
}

function joinSession(owned: Resources): Promise<void> {
	const session = owned.session;
	if (session === undefined) {
		if (owned.sessionOpenAttempted)
			return Promise.reject(new Error("Event fixture session open did not complete"));
		owned.key?.destroy();
		return Promise.resolve();
	}
	owned.sessionJoin ??= Promise.resolve().then(() => session.close());
	return owned.sessionJoin;
}

afterEach(async () => {
	let failed = false;
	for (const owned of resources.splice(0).reverse()) {
		failedCleanupDebt.push(owned);
		let complete = true;
		for (const reader of owned.readers) {
			try {
				reader.close();
			} catch {
				complete = false;
			}
		}
		for (const authority of owned.authorities) {
			try {
				authority.close();
			} catch {
				complete = false;
			}
		}
		const clientJoins = owned.clients.map(async (client) => {
			if (client.closed) return;
			const closed = new Promise<void>((resolve) => client.once("close", () => resolve()));
			client.destroy();
			await closed;
		});
		const listenersClosing = joinListeners(owned);
		if (!(await Promise.allSettled(clientJoins)).every((result) => result.status === "fulfilled"))
			complete = false;
		const listenersJoined = await listenersClosing;
		if (!listenersJoined) complete = false;
		try {
			if (listenersJoined) await joinSession(owned);
			if (complete) removeOwnedFolder(owned);
		} catch {
			complete = false;
		}
		if (complete) failedCleanupDebt.splice(failedCleanupDebt.indexOf(owned), 1);
		else failed = true;
	}
	expect(failed, "fresh event fixture cleanup").toBe(false);
	expect(failedCleanupDebt.length, "unresolved event fixture cleanup debt").toBe(0);
});

async function sessionFixture(): Promise<SessionFixture> {
	const tmpRoot = realpathSync.native(tmpdir());
	const tmpRootIdentity = directoryIdentity(tmpRoot);
	const folder = mkdtempSync(path.join(tmpRoot, FOLDER_PREFIX));
	const owned: Resources = {
		folder,
		tmpRoot,
		tmpRootIdentity,
		clients: [],
		listeners: [],
		listenerJoins: new Map(),
		authorities: [],
		readers: [],
		sessionOpenAttempted: false,
	};
	resources.push(owned);
	owned.folderIdentity = directoryIdentity(folder);
	const offered = randomBytes(32);
	const key = new MasterKey(offered);
	owned.key = key;
	offered.fill(0);
	const binding = nativeBinding();
	owned.sessionOpenAttempted = true;
	let session: HubSession;
	try {
		session = await openHubSession({ folder, nativeBinding: binding, masterKey: key });
	} catch (error) {
		owned.openFailure = error;
		throw error;
	}
	owned.session = session;
	const database = new WorkDatabase(session.store);
	const clock = { now: Date.now() };
	const result: SessionFixture = {
		session,
		key,
		database,
		events: new EventLog(database, () => clock.now),
		resources: owned,
		clock,
	};
	assertHubSessionAdmission(session);
	return result;
}

async function pairDevice(system: SessionFixture): Promise<PairedDevice> {
	const transport = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
	const algorithm = { name: "ECDSA", namedCurve: "P-256" };
	const certificate = await X509CertificateGenerator.createSelfSigned({
		name: "CN=DYTEST event device",
		serialNumber: `01${randomBytes(19).toString("hex")}`,
		notBefore: new Date(Date.now() - 300_000),
		notAfter: new Date(Date.now() + DAY),
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
	const received = Promise.withResolvers<{ peer: NativeDevicePeer; server: TLSSocket }>();
	const listener = new NativeDeviceTls(
		system.session.devices,
		system.session.identity,
		(peer, server) => {
			received.resolve({ peer, server });
		},
	);
	system.resources.listeners.push(listener);
	const port = await listener.listen();
	const key = transport.privateKey.export({ type: "pkcs8", format: "pem" });
	const client = connect({
		host: "127.0.0.1",
		port,
		key,
		cert: certificate.toString("pem"),
		ca: system.session.identity.certificate,
		rejectUnauthorized: true,
		minVersion: "TLSv1.3",
		maxVersion: "TLSv1.3",
	});
	system.resources.clients.push(client);
	client.on("error", () => {});
	const [incoming] = await Promise.all([received.promise, once(client, "secureConnect")]);
	expect(client.authorized).toBe(true);
	expect(client.getProtocol()).toBe("TLSv1.3");
	expect(client.getPeerX509Certificate()?.raw).toEqual(
		new X509Certificate(system.session.identity.certificate).raw,
	);
	const secret = randomBytes(16);
	const authority = new DevicePairingAuthority(
		system.session.devices,
		system.session.store,
		system.key,
		secret,
	);
	system.resources.authorities.push(authority);
	const window = { ...sidecarWindowSecrets(secret), role: "device" as const };
	secret.fill(0);
	const nonce = randomBytes(16);
	const signing = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
	const ekm = client.exportKeyingMaterial(
		32,
		"EXPERIMENTAL-draftyak-pair-v1",
		Buffer.from(window.pid, "base64url"),
	);
	try {
		const claim = makePairingClaim(
			window,
			{
				name: "DYTEST event device",
				transportSpkiSha256: createHash("sha256")
					.update(transport.publicKey.export({ type: "spki", format: "der" }))
					.digest("hex"),
				signingKey: signing.publicKey.export({ type: "spki", format: "der" }).toString("base64url"),
			},
			ekm,
			nonce,
		);
		const answer = system.session.store.write((sql) =>
			authority.claim(sql, incoming.peer, bytes(claim)),
		);
		const paired = system.session.store.write((sql) =>
			authority.reveal(
				sql,
				incoming.peer,
				bytes({ pid: window.pid, nd: nonce.toString("base64url") }),
			),
		);
		expect(paired).toEqual({ deviceId: answer.deviceId, epoch: answer.epoch });
		return { ...incoming, client, deviceId: paired.deviceId };
	} finally {
		ekm.fill(0);
		nonce.fill(0);
	}
}

async function authorizedFixture(): Promise<AuthorizedFixture> {
	const system = await sessionFixture();
	const device = await pairDevice(system);
	const grant = await system.session.devices.bootstrap(device.deviceId, PIN);
	return { ...system, device, ownerUserId: grant.userId };
}

function reader(system: SessionFixture): Reader {
	const result = createNativeEventPageReader(system.session);
	expect(Object.isFrozen(result)).toBe(true);
	system.resources.readers.push(result);
	return result;
}

function append(system: AuthorizedFixture, index: number, changes: Partial<AppendInput> = {}) {
	return system.database.write((scope) =>
		system.events.append(scope, {
			userId: system.ownerUserId,
			accountId: null,
			dataClass: "slack.content",
			kind: "messages.changed",
			ids: [id(index)],
			...changes,
		}),
	);
}

function account(system: AuthorizedFixture, accountId: string, userId: string): void {
	system.database.write((scope) =>
		system.database
			.sql(scope)
			.run(
				"INSERT INTO main.accounts(id,user_id,plugin_instance_id,generation,account_json) VALUES(?,?,?,1,NULL)",
				[accountId, userId, id(9000)],
			),
	);
}

function refused(work: () => unknown, code: ErrorCode): void {
	let error: unknown;
	try {
		work();
	} catch (caught) {
		error = caught;
	}
	expect(error).toBeInstanceOf(NativeEventPageError);
	expect(error).toMatchObject({ name: "NativeEventPageError", code, message: code });
	expect(Object.hasOwn(error as object, "cause")).toBe(false);
}

function checked(page: Page): Page {
	expect(Reflect.ownKeys(page).sort()).toEqual(["frames", "more", "nextCursor"]);
	expect(Object.isFrozen(page)).toBe(true);
	expect(Object.isFrozen(page.frames)).toBe(true);
	expect(page.frames.length).toBeGreaterThan(0);
	expect(page.frames.length).toBeLessThanOrEqual(101);
	expect(checkEventStream(page.frames)).toBe(true);
	for (const frame of page.frames) {
		expect(EventFrame.safeParse(frame).success).toBe(true);
		expect(Object.isFrozen(frame)).toBe(true);
		expect(checkFrameLength(Buffer.byteLength(canonicalize(frame), "utf8"))).toBe(true);
		if (frame.type === "event") {
			expect(Reflect.ownKeys(frame).sort()).toEqual(["cursor", "ids", "kind", "type"]);
			expect(Object.isFrozen(frame.ids)).toBe(true);
		} else if (frame.type === "ready") {
			expect(Reflect.ownKeys(frame).sort()).toEqual(["cursor", "type"]);
		} else {
			expect(Reflect.ownKeys(frame).sort()).toEqual(["reason", "type"]);
		}
	}
	return page;
}

function cursor(page: Page): string {
	expect(typeof page.nextCursor).toBe("string");
	const value = page.nextCursor as string;
	expect(value.length).toBeLessThanOrEqual(512);
	expect([...value].every((character) => (character.codePointAt(0) ?? 128) <= 127)).toBe(true);
	return value;
}

function events(page: Page) {
	return page.frames.filter((frame) => frame.type === "event");
}

describe("native ids-only event pages", () => {
	it("requires the original session before reading its public members", async () => {
		const system = await authorizedFixture();
		refused(() => createNativeEventPageReader({ ...system.session }), "UNAVAILABLE");
		let reads = 0;
		const clone = Object.create(null);
		Object.defineProperty(clone, "store", {
			get() {
				reads++;
				throw new Error("DYTEST structural session getter");
			},
		});
		refused(() => createNativeEventPageReader(clone as HubSession), "UNAVAILABLE");
		expect(reads).toBe(0);
		checked(reader(system).read(system.device.peer, request(null)));
	});

	it("starts at the current head and returns fresh immutable canonical DATA", async () => {
		const system = await authorizedFixture();
		append(system, 1);
		const source = reader(system);
		const before = system.session.store.read((sql) => readStamp(sql)?.revision);
		const first = checked(source.read(system.device.peer, request(null)));
		const afterWrite = system.session.store.read((sql) => readStamp(sql)?.revision);
		expect(before).toEqual(expect.any(Number));
		expect(afterWrite).toBeGreaterThan(before as number);
		expect(first.frames).toHaveLength(1);
		expect(first.frames[0]).toMatchObject({ type: "ready" });
		expect(first.more).toBe(false);
		const after = cursor(first);
		const empty = checked(source.read(system.device.peer, request(after)));
		expect(events(empty)).toEqual([]);
		const added = append(system, 2);
		const page = checked(source.read(system.device.peer, request(after)));
		expect(events(page).map(({ kind, ids }) => ({ kind, ids }))).toEqual([
			{ kind: added.kind, ids: [id(2)] },
		]);
		expect(page).not.toBe(first);
		expect(page.frames).not.toBe(first.frames);
		expect(JSON.stringify(page)).not.toContain(system.ownerUserId);
		expect(JSON.stringify(page)).not.toContain(system.device.deviceId);
	});

	it("refuses pending, cloned and foreign peers without adopting their fields", async () => {
		const pending = await sessionFixture();
		const device = await pairDevice(pending);
		const source = reader(pending);
		refused(() => source.read(device.peer, request(null)), "FORBIDDEN");
		await pending.session.devices.bootstrap(device.deviceId, PIN);
		checked(source.read(device.peer, request(null)));
		refused(() => source.read({ ...device.peer } as NativeDevicePeer, request(null)), "FORBIDDEN");
		let reads = 0;
		const proxy = new Proxy(device.peer, {
			get() {
				reads++;
				throw new Error("DYTEST peer getter");
			},
		});
		refused(() => source.read(proxy, request(null)), "FORBIDDEN");
		expect(reads).toBe(0);
		const other = await authorizedFixture();
		refused(() => source.read(other.device.peer, request(null)), "FORBIDDEN");
	});

	it("refuses current revocation and a closed native TLS peer", async () => {
		const revoked = await authorizedFixture();
		const source = reader(revoked);
		checked(source.read(revoked.device.peer, request(null)));
		const proof = await revoked.session.pins.verify(
			revoked.ownerUserId,
			PIN,
			revokePinScope(revoked.device.deviceId),
		);
		revoked.session.store.write((sql) =>
			revoked.session.devices.revoke(sql, revoked.device.deviceId, {
				kind: "device",
				id: revoked.device.deviceId,
				proof,
			}),
		);
		refused(() => source.read(revoked.device.peer, request(null)), "FORBIDDEN");
		const closed = await authorizedFixture();
		const next = reader(closed);
		const peerClosed = once(closed.device.server, "close");
		closed.device.server.destroy();
		await peerClosed;
		refused(() => next.read(closed.device.peer, request(null)), "FORBIDDEN");
	});

	it("does not reuse old device rights after an epoch transition", async () => {
		const system = await authorizedFixture();
		const source = reader(system);
		const after = cursor(checked(source.read(system.device.peer, request(null))));
		system.session.store.write((sql) => advanceEpochForRestore(system.session.devices, sql));
		refused(() => source.read(system.device.peer, request(after)), "FORBIDDEN");
	});

	it("closes only its reader and refuses an actually closed original session", async () => {
		const system = await authorizedFixture();
		const source = reader(system);
		source.close();
		source.close();
		refused(() => source.read(system.device.peer, request(null)), "UNAVAILABLE");
		assertHubSessionAdmission(system.session);
		const fresh = reader(system);
		checked(fresh.read(system.device.peer, request(null)));
		expect(await joinListeners(system.resources)).toBe(true);
		await joinSession(system.resources);
		refused(() => fresh.read(system.device.peer, request(null)), "UNAVAILABLE");
	});

	it("refuses noncanonical, malformed, oversized and shared request bytes", async () => {
		const system = await authorizedFixture();
		const source = reader(system);
		const valid = request(null);
		const shared = new Uint8Array(new SharedArrayBuffer(valid.byteLength));
		shared.set(valid);
		const invalid = [
			new TextEncoder().encode('{"after":null }'),
			new TextEncoder().encode('{"after":null,"after":null}'),
			new Uint8Array([0xc3, 0x28]),
			new Uint8Array([0xef, 0xbb, 0xbf, ...valid]),
			bytes({}),
			bytes({ after: null, userId: system.ownerUserId }),
			bytes({ after: "x".repeat(513) }),
			bytes({ after: "\u0000".repeat(512) }),
			new Uint8Array(1025),
			shared,
		];
		for (const input of invalid)
			refused(() => source.read(system.device.peer, input), "INVALID_REQUEST");
		checked(source.read(system.device.peer, valid));
		expect(valid).toEqual(request(null));
	});

	it("filters owner/account scope including null and missing accounts", async () => {
		const system = await authorizedFixture();
		const source = reader(system);
		const after = cursor(checked(source.read(system.device.peer, request(null))));
		const foreign = system.ownerUserId === id(7000) ? id(7001) : id(7000);
		account(system, id(8000), system.ownerUserId);
		account(system, id(8001), foreign);
		append(system, 1, { accountId: id(8000) });
		append(system, 2);
		append(system, 3, { accountId: id(8001) });
		append(system, 4, { accountId: id(8002) });
		append(system, 5, { userId: foreign });
		const page = checked(source.read(system.device.peer, request(after)));
		expect(events(page).flatMap((event) => event.ids)).toEqual([id(1), id(2)]);
		expect(page.more).toBe(false);
		const resumed = checked(source.read(system.device.peer, request(cursor(page))));
		expect(events(resumed)).toEqual([]);
	});

	it("rechecks account ownership at delivery", async () => {
		const system = await authorizedFixture();
		const source = reader(system);
		const after = cursor(checked(source.read(system.device.peer, request(null))));
		account(system, id(8000), system.ownerUserId);
		append(system, 1, { accountId: id(8000) });
		const foreign = system.ownerUserId === id(7000) ? id(7001) : id(7000);
		system.database.write((scope) =>
			system.database
				.sql(scope)
				.run("UPDATE main.accounts SET user_id=? WHERE id=?", [foreign, id(8000)]),
		);
		expect(events(checked(source.read(system.device.peer, request(after))))).toEqual([]);
	});

	it("scans at most 100 rows and resumes past suppressed credentials", async () => {
		const system = await authorizedFixture();
		const source = reader(system);
		const after = cursor(checked(source.read(system.device.peer, request(null))));
		for (let index = 1; index <= 100; index++) append(system, index, { dataClass: "credentials" });
		append(system, 101);
		const first = checked(source.read(system.device.peer, request(after)));
		expect(events(first)).toEqual([]);
		expect(first.more).toBe(true);
		expect(cursor(first)).not.toBe(after);
		const last = checked(source.read(system.device.peer, request(cursor(first))));
		expect(events(last).flatMap((event) => event.ids)).toEqual([id(101)]);
		expect(last.more).toBe(false);
	});

	it("bounds emitted events and projects a full 100-id event without row metadata", async () => {
		const system = await authorizedFixture();
		const source = reader(system);
		const after = cursor(checked(source.read(system.device.peer, request(null))));
		const ids = Array.from({ length: 100 }, (_, index) => id(index + 1));
		append(system, 1, { ids });
		for (let index = 101; index <= 200; index++) append(system, index);
		const first = checked(source.read(system.device.peer, request(after)));
		expect(events(first)).toHaveLength(100);
		expect(events(first)[0]?.ids).toEqual(ids);
		expect(first.more).toBe(true);
		const last = checked(source.read(system.device.peer, request(cursor(first))));
		expect(events(last)).toHaveLength(1);
		expect(events(last)[0]?.ids).toEqual([id(200)]);
		expect(last.more).toBe(false);
	});

	it("refuses an unknown stored class for the whole page", async () => {
		const system = await authorizedFixture();
		const source = reader(system);
		const after = cursor(checked(source.read(system.device.peer, request(null))));
		append(system, 1);
		const damaged = append(system, 2);
		system.database.write((scope) =>
			system.database
				.sql(scope)
				.run("UPDATE main.events SET data_class='unknown' WHERE seq=?", [damaged.seq]),
		);
		refused(() => source.read(system.device.peer, request(after)), "UNAVAILABLE");
	});

	it("returns a retention reset after an actual bounded EventLog purge", async () => {
		const system = await authorizedFixture();
		const source = reader(system);
		const after = cursor(checked(source.read(system.device.peer, request(null))));
		system.clock.now -= 8 * DAY;
		const expired = append(system, 1);
		system.clock.now += 8 * DAY;
		const purged = system.database.write((scope) => system.events.purge(scope));
		expect(purged.deleted).toBeGreaterThanOrEqual(1);
		expect(purged.more).toBe(false);
		expect(
			system.session.store.read((sql) =>
				sql.get("SELECT seq FROM main.events WHERE seq=?", [expired.seq]),
			),
		).toBeUndefined();
		const page = checked(source.read(system.device.peer, request(after)));
		expect(page).toEqual({
			frames: [{ type: "reset", reason: "cursor_expired" }],
			nextCursor: null,
			more: false,
		});
	});

	it("resets unknown, tampered and restarted-reader cursors", async () => {
		const system = await authorizedFixture();
		const source = reader(system);
		const after = cursor(checked(source.read(system.device.peer, request(null))));
		const at = Math.floor(after.length / 2);
		const tampered = `${after.slice(0, at)}${after[at] === "A" ? "B" : "A"}${after.slice(at + 1)}`;
		for (const input of ["DYTEST-unknown-cursor", tampered]) {
			expect(checked(source.read(system.device.peer, request(input)))).toEqual({
				frames: [{ type: "reset", reason: "resync_required" }],
				nextCursor: null,
				more: false,
			});
		}
		expect(checked(reader(system).read(system.device.peer, request(after)))).toEqual({
			frames: [{ type: "reset", reason: "resync_required" }],
			nextCursor: null,
			more: false,
		});
	});
});
