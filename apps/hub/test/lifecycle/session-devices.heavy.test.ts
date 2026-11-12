import { afterEach, beforeEach, expect, it } from "vitest";
import { requireLoopbackNetworkGuard } from "../helpers/loopback-network.ts";

requireLoopbackNetworkGuard();
const [
	{ Authorizer },
	{ NativeDeviceTls },
	{ advanceEpochForRestore },
	{ systemClock },
	{ admit, bootstrap, device, idOf, owner, PIN },
	{ configureIdentityModule, DIRECTORY_USER, sessionFixture },
] = await Promise.all([
	import("../../src/authz/authorizer.ts"),
	import("../../src/authz/native-peer.ts"),
	import("../../src/identity/devices.ts"),
	import("../../src/kernel/clock.ts"),
	import("../authz/native-fixture.ts"),
	import("./session-helpers.ts"),
]);
type NativeFixture = import("../authz/native-fixture.ts").NativeFixture;
type NativeDevicePeer = import("../../src/authz/native-peer.ts").NativeDevicePeer;
type SessionFixture = ReturnType<typeof sessionFixture>;
let f: SessionFixture;
const transports: NativeFixture[] = [];
beforeEach(() => {
	f = sessionFixture("draftyak-session-native-devices-");
});
afterEach(async () => {
	for (const transport of transports.splice(0)) {
		for (const client of transport.devices) client.socket.destroy();
		await transport.tls.close();
	}
	f.remove();
});

const WALL = 1_800_000_000_000;
async function open() {
	const key = f.key();
	const session = await f.open({ masterKey: key, clock: { ...systemClock, wallMs: () => WALL } });
	const nextPeers: NativeDevicePeer[] = [];
	const waiting: Array<(peer: NativeDevicePeer) => void> = [];
	const tls = new NativeDeviceTls(session.devices, session.identity, (peer) => {
		const next = waiting.shift();
		if (next) next(peer);
		else nextPeers.push(peer);
	});
	const port = await tls.listen();
	// Every authority service is the actual public session service; the existing helper supplies
	// only generated TLS clients and sidecar pairing bytes for this real native producer.
	const native: NativeFixture = {
		dir: f.folder,
		filename: f.database,
		key,
		store: session.store,
		audit: session.audit,
		pins: session.pins,
		identity: session.identity,
		registry: session.devices,
		authorizer: new Authorizer(session.devices),
		tls,
		port,
		devices: [],
		nextPeers,
		waiting,
	};
	transports.push(native);
	return { session, native };
}

async function closeTransport(native: NativeFixture): Promise<void> {
	for (const client of native.devices) client.socket.destroy();
	await native.tls.close();
}

it("bootstraps a real session owner over TLS and PIN, preserves it on reopen and requires a new native peer", async () => {
	const first = await open();
	const client = await bootstrap(first.native);
	const ownerId = owner(first.native);
	const before = first.session.devices.currentState();
	expect(await first.session.identityProvider.users()).toEqual([{ id: ownerId }]);
	expect(before).toEqual({ epoch: 0, bootstrapDone: true, ownerUserId: ownerId });
	first.session.store.read((db) => {
		expect(first.native.authorizer.requirePeerDevice(db, client.peer, "approve")).toMatchObject({
			deviceId: idOf(client),
			ownerUserId: ownerId,
		});
		const lines = first.session.audit.exportVerifiedJsonl(db).jsonl.trim().split("\n");
		const events = lines.map((line) => JSON.parse(line) as { action: string; at: number });
		expect(events.filter(({ action }) => action.startsWith("device.")).map(({ at }) => at)).toEqual(
			[WALL, WALL],
		);
	});
	await closeTransport(first.native);
	first.session.close();
	expect(() => first.session.devices.currentState()).toThrow("UNAVAILABLE");
	const second = await open();
	expect(second.session.devices).not.toBe(first.session.devices);
	expect(second.session.devices.currentState()).toEqual(before);
	expect(await second.session.identityProvider.users()).toEqual([{ id: ownerId }]);
	second.session.store.read((db) => {
		expect(() => second.native.authorizer.requirePeerDevice(db, client.peer, "approve")).toThrow();
	});
	const connected = await device(second.native, client);
	second.session.store.read((db) => {
		expect(second.native.authorizer.requirePeerDevice(db, connected.peer, "approve")).toMatchObject(
			{
				deviceId: idOf(client),
				ownerUserId: ownerId,
			},
		);
	});
});

it("persists a restore epoch without restoring the earlier peer's approval authority", async () => {
	const first = await open();
	const client = await bootstrap(first.native);
	const ownerId = owner(first.native);
	first.session.store.write((db) => advanceEpochForRestore(first.session.devices, db));
	const restored = { epoch: 1, bootstrapDone: false, ownerUserId: ownerId };
	expect(first.session.devices.currentState()).toEqual(restored);
	expect(await first.session.identityProvider.users()).toEqual([{ id: ownerId }]);
	first.session.store.read((db) => {
		expect(() => first.native.authorizer.requirePeerDevice(db, client.peer, "approve")).toThrow();
	});
	await closeTransport(first.native);
	first.session.close();
	const second = await open();
	expect(second.session.devices.currentState()).toEqual(restored);
	expect(await second.session.identityProvider.users()).toEqual([{ id: ownerId }]);
	const connected = await device(second.native, client);
	second.session.store.read((db) => {
		expect(() =>
			second.native.authorizer.requirePeerDevice(db, connected.peer, "approve"),
		).toThrow();
	});
});

it("refuses an in-flight native bootstrap after the session closes", async () => {
	const { session, native } = await open();
	const client = await device(native);
	const candidate = admit(native, client);
	const preparing = session.devices.prepareBootstrap(candidate, PIN);
	const rejected = expect(preparing).rejects.toThrow();
	session.close();
	await rejected;
	expect(() => session.devices.currentState()).toThrow("UNAVAILABLE");
	const reopened = await f.open();
	expect(reopened.devices.currentState()).toEqual({
		epoch: 0,
		bootstrapDone: false,
		ownerUserId: null,
	});
});

it("selects the captured module identity directory without granting its users native authority", async () => {
	configureIdentityModule(f);
	const { session, native } = await open();
	expect(session.identityProvider).toBe(session.extensions.providers("identity")[0]);
	expect(await session.identityProvider.users()).toEqual([{ id: DIRECTORY_USER }]);
	expect(session.identityProvider.maxOwners()).toBe(3);
	expect(session.identityProvider.authenticateBrowser).toBeUndefined();
	expect(session.devices.currentState()).toEqual({
		epoch: 0,
		bootstrapDone: false,
		ownerUserId: null,
	});
	expect(session.store.read((db) => db.get("SELECT count(*) AS count FROM main.users"))).toEqual({
		count: 0,
	});
	const client = await device(native);
	session.store.read((db) => {
		expect(() => native.authorizer.requirePeerDevice(db, client.peer, "approve")).toThrow();
	});
	await bootstrap(native, client);
	expect(owner(native)).not.toBe(DIRECTORY_USER);
	expect(session.devices.currentState().ownerUserId).toBe(owner(native));
	expect(await session.identityProvider.users()).toEqual([{ id: DIRECTORY_USER }]);
	session.close();
	expect(() => session.identityProvider.users()).toThrow();
	expect(() => session.identityProvider.maxOwners()).toThrow();
});
