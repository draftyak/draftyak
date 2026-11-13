import { createHash, randomBytes } from "node:crypto";
import { connect as netConnect, Server, type Socket } from "node:net";
import path from "node:path";
import { type TLSSocket, connect as tlsConnect } from "node:tls";
import { pathToFileURL } from "node:url";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { NativeDeviceContext } from "../../../src/api/device/context.ts";
import type { NativeDevicePeer } from "../../../src/authz/native-peer.ts";
import type { MasterKey } from "../../../src/kernel/master-key.ts";
import type { SqlTransaction } from "../../../src/store/store.ts";
import type { NativeFixture, TestDevice } from "../../authz/native-fixture.ts";
import { requireLoopbackNetworkGuard } from "../../helpers/loopback-network.ts";
import type { SessionFixture } from "../../lifecycle/session-helpers.ts";

requireLoopbackNetworkGuard();
const [
	{ openNativeDeviceContext, closeFailedNativeDeviceContext },
	{ exportSpki },
	{ admit, bootstrap, claimExchange, device, idOf, PIN },
	{ blockNativeClose },
	{
		sessionFixture,
		sessionTransport,
		closeSessionTransport,
		nativeBinding,
		expectErased,
		expectUsable,
	},
] = await Promise.all([
	import("../../../src/index.ts"),
	import("@draftyak/protocol/sign"),
	import("../../authz/native-fixture.ts"),
	import("../../extensions/helpers.ts"),
	import("../../lifecycle/session-helpers.ts"),
]);

interface AcceptedPeer {
	readonly peer: NativeDevicePeer;
	readonly socket: TLSSocket;
	readonly context: NativeDeviceContext;
}
interface RunningContext {
	readonly context: NativeDeviceContext;
	readonly key: MasterKey;
	readonly accepted: AcceptedPeer[];
	next(): Promise<AcceptedPeer>;
}
interface PairedDevices {
	readonly confirmed: TestDevice;
	readonly pending: TestDevice;
	readonly confirmedId: string;
	readonly pendingId: string;
	readonly hid: string;
}

let f: SessionFixture;
const fixtures: SessionFixture[] = [];
const contexts = new Set<NativeDeviceContext>();
const sockets = new Set<Socket>();
const failedOwners = new Set<unknown>();

beforeEach(() => {
	f = sessionFixture("draftyak-device-context-");
	fixtures.push(f);
});
afterEach(async () => {
	vi.restoreAllMocks();
	await Promise.all([...sockets].map(destroy));
	sockets.clear();
	const results = await Promise.allSettled([
		...[...contexts].map((context) => context.close()),
		...[...failedOwners].map((error) => closeFailedNativeDeviceContext(error)),
	]);
	contexts.clear();
	failedOwners.clear();
	if (results.some((result) => result.status === "rejected"))
		throw new Error("Native device context fixture cleanup incomplete");
	for (const fixture of fixtures.splice(0)) await fixture.remove();
});

async function bounded<T>(work: Promise<T>): Promise<T> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	try {
		return await Promise.race([
			work,
			new Promise<never>((_resolve, reject) => {
				timer = setTimeout(
					() => reject(new Error("Native context operation did not settle")),
					5_000,
				);
			}),
		]);
	} finally {
		clearTimeout(timer);
	}
}
function closed(socket: Socket): Promise<void> {
	return socket.closed
		? Promise.resolve()
		: new Promise<void>((resolve) => socket.once("close", resolve));
}
function destroy(socket: Socket): Promise<void> {
	const completion = closed(socket);
	socket.destroy();
	return completion;
}
async function failure(work: Promise<NativeDeviceContext>): Promise<unknown> {
	return work.then(
		(context) => {
			contexts.add(context);
			return expect.unreachable("operation was not refused");
		},
		(error: unknown) => error,
	);
}

async function preparePairedDevices(fixture: SessionFixture): Promise<PairedDevices> {
	const key = fixture.key();
	const session = await fixture.open({ masterKey: key });
	const native = await sessionTransport(session, key, fixture.folder);
	try {
		const pending = await device(native);
		const pendingId = admit(native, pending);
		const confirmed = await bootstrap(native);
		return {
			confirmed,
			pending,
			confirmedId: idOf(confirmed),
			pendingId,
			hid: session.hid,
		};
	} finally {
		await Promise.all(native.devices.map((client) => destroy(client.socket)));
		await closeSessionTransport(native);
		await session.close();
	}
}

async function start(
	fixture = f,
	runtime?: { readonly key: MasterKey; readonly open: typeof openNativeDeviceContext },
): Promise<RunningContext> {
	const accepted: AcceptedPeer[] = [];
	const queued: AcceptedPeer[] = [];
	const waiting: Array<(value: AcceptedPeer) => void> = [];
	const key = runtime?.key ?? fixture.key();
	const context = await (runtime?.open ?? openNativeDeviceContext)(
		{ folder: fixture.folder, nativeBinding, masterKey: key },
		(peer, socket, owner) => {
			sockets.add(socket);
			const value = { peer, socket, context: owner };
			accepted.push(value);
			const next = waiting.shift();
			if (next) next(value);
			else queued.push(value);
		},
	);
	contexts.add(context);
	return {
		context,
		key,
		accepted,
		next: () => {
			const ready = queued.shift();
			return bounded(
				ready
					? Promise.resolve(ready)
					: new Promise<AcceptedPeer>((resolve) => waiting.push(resolve)),
			);
		},
	};
}

async function connect(running: RunningContext, credential: TestDevice): Promise<AcceptedPeer> {
	const endpoint = running.context.endpoint;
	const socket = tlsConnect({
		host: endpoint.address,
		port: endpoint.port,
		key: credential.transportKey.export({ format: "pem", type: "pkcs8" }),
		cert: credential.certificate,
		rejectUnauthorized: false,
		minVersion: "TLSv1.3",
		maxVersion: "TLSv1.3",
	});
	sockets.add(socket);
	socket.on("error", () => {});
	await bounded(
		new Promise<void>((resolve, reject) => {
			socket.once("error", reject);
			socket.once("secureConnect", resolve);
		}),
	);
	const certificate = socket.getPeerX509Certificate();
	expect(certificate).toBeDefined();
	if (!certificate) throw new Error("Native context has no certificate");
	expect(
		createHash("sha256")
			.update(Buffer.from(exportSpki(certificate.publicKey), "base64url"))
			.digest("hex"),
	).toBe(endpoint.hid);
	expect(socket.getProtocol()).toBe("TLSv1.3");
	const accepted = await running.next();
	expect(accepted.context).toBe(running.context);
	return accepted;
}

it("refuses invalid session admission before binding a listener", async () => {
	const listening = vi.spyOn(Server.prototype, "listen");
	const key = f.key();
	const error = await failure(
		openNativeDeviceContext({ folder: "relative", nativeBinding, masterKey: key }, () => {}),
	);
	expect(error).toBeInstanceOf(Error);
	expect(listening).not.toHaveBeenCalled();
	expectErased(key);
	await expect(closeFailedNativeDeviceContext(new Error("DYTEST unrelated error"))).rejects.toThrow(
		"CONTEXT_UNAVAILABLE",
	);
});

it("reopens the genuine session and authorizes only current listener-issued peers", async () => {
	const prepared = await preparePairedDevices(f);
	const running = await start();
	expect(running.context.endpoint).toMatchObject({ address: "127.0.0.1", hid: prepared.hid });
	const confirmed = await connect(running, prepared.confirmed);
	const pending = await connect(running, prepared.pending);
	const { requirePeerDevice, requirePeerKind, requirePeerRoute } = running.context;
	expect(requirePeerDevice(confirmed.peer, "read").deviceId).toBe(prepared.confirmedId);
	expect(requirePeerKind(confirmed.peer, "approval.send.v1").deviceId).toBe(prepared.confirmedId);
	expect(requirePeerRoute(confirmed.peer, "status")).toMatchObject({
		deviceId: prepared.confirmedId,
		confirmed: true,
	});
	expect(requirePeerRoute(pending.peer, "status")).toMatchObject({
		deviceId: prepared.pendingId,
		confirmed: false,
	});
	expect(() => requirePeerDevice(pending.peer, "read")).toThrow("DEVICE_PENDING");
	expect(() => requirePeerKind(pending.peer, "approval.send.v1")).toThrow("DEVICE_PENDING");
	// Structural copies are negative controls, never accepted authority.
	expect(() => requirePeerDevice({ ...confirmed.peer } as NativeDevicePeer, "read")).toThrow(
		"PEER_REFUSED",
	);
	const foreignFixture = sessionFixture("draftyak-device-context-");
	fixtures.push(foreignFixture);
	const foreignPrepared = await preparePairedDevices(foreignFixture);
	const foreign = await start(foreignFixture);
	const foreignPeer = await connect(foreign, foreignPrepared.confirmed);
	expect(() => requirePeerDevice(foreignPeer.peer, "read")).toThrow("PEER_REFUSED");
	expect(new Set(Object.keys(running.context))).toEqual(
		new Set(["endpoint", "requirePeerRoute", "requirePeerDevice", "requirePeerKind", "close"]),
	);
});

it("fences authority and joins listener closure before releasing the session", async () => {
	const prepared = await preparePairedDevices(f);
	const running = await start();
	const peer = await connect(running, prepared.confirmed);
	const nativeClosed = Promise.withResolvers<void>();
	const release = Promise.withResolvers<void>();
	const originalClose = Server.prototype.close;
	const closing = vi.spyOn(Server.prototype, "close").mockImplementation(function (
		this: Server,
		callback?: (error?: Error) => void,
	) {
		return originalClose.call(this, (error?: Error) => {
			nativeClosed.resolve();
			void release.promise.then(() => callback?.(error));
		});
	});
	let finished = false;
	const first = running.context.close();
	const second = running.context.close();
	const ending = Promise.all([first, second]).then(() => {
		finished = true;
	});
	void ending.catch(() => {});
	try {
		expect(() => running.context.endpoint).toThrow("CONTEXT_UNAVAILABLE");
		expect(() => running.context.requirePeerDevice(peer.peer, "read")).toThrow(
			"CONTEXT_UNAVAILABLE",
		);
		await bounded(nativeClosed.promise);
		await bounded(closed(peer.socket));
		expect(finished).toBe(false);
		expectUsable(running.key);
		await expect(f.open()).rejects.toMatchObject({ code: "SESSION_ACTIVE" });
		expect(closing).toHaveBeenCalledTimes(1);
	} finally {
		release.resolve();
		await bounded(ending);
		closing.mockRestore();
	}
	expectErased(running.key);
	await expect(running.context.close()).resolves.toBeUndefined();
	const reopened = await f.open();
	expect(reopened.hid).toBe(prepared.hid);
	await reopened.close();
});

it("issues no peer when an accepted TCP connection completes TLS after stop begins", async () => {
	const prepared = await preparePairedDevices(f);
	const listening = vi.spyOn(Server.prototype, "listen");
	const running = await start();
	const port = running.context.endpoint.port;
	const server = listening.mock.contexts.find((value) => value instanceof Server);
	listening.mockRestore();
	if (!(server instanceof Server)) throw new Error("Native context listener was not created");
	const accepted = new Promise<void>((resolve) => server.once("connection", () => resolve()));
	const handshake = new Promise<void>((resolve) =>
		server.once("secureConnection", (socket: TLSSocket) => {
			sockets.add(socket);
			resolve();
		}),
	);
	const serverClosed = new Promise<void>((resolve) => server.once("close", () => resolve()));
	const raw = netConnect({ host: "127.0.0.1", port });
	sockets.add(raw);
	raw.on("error", () => {});
	await bounded(accepted);
	let finished = false;
	const ending = running.context.close().then(() => {
		finished = true;
	});
	void ending.catch(() => {});
	expect(() => running.context.endpoint).toThrow("CONTEXT_UNAVAILABLE");
	await Promise.resolve();
	expect(finished).toBe(false);
	const client = tlsConnect({
		socket: raw,
		key: prepared.confirmed.transportKey.export({ format: "pem", type: "pkcs8" }),
		cert: prepared.confirmed.certificate,
		rejectUnauthorized: false,
		minVersion: "TLSv1.3",
		maxVersion: "TLSv1.3",
	});
	sockets.add(client);
	client.on("error", () => {});
	await bounded(handshake);
	await bounded(Promise.all([ending, serverClosed, closed(client)]));
	expect(server.listening).toBe(false);
	expect(running.accepted).toEqual([]);
	expectErased(running.key);
});

it("retains and retries the original session after a real native close failure", async () => {
	const prepared = await preparePairedDevices(f);
	const running = await start();
	const peer = await connect(running, prepared.confirmed);
	const control = blockNativeClose();
	try {
		await expect(running.context.close()).rejects.toMatchObject({ code: "CLOSE_INCOMPLETE" });
		expect(control.attempts).toBeGreaterThan(0);
		expectErased(running.key);
		expect(() => running.context.requirePeerRoute(peer.peer, "status")).toThrow(
			"CONTEXT_UNAVAILABLE",
		);
		await expect(f.open()).rejects.toMatchObject({ code: "SESSION_ACTIVE" });
		const attempts = control.attempts;
		control.blocked = false;
		await bounded(running.context.close());
		expect(control.attempts).toBeGreaterThan(attempts);
		await bounded(running.context.close());
	} finally {
		control.blocked = false;
		control.restore();
	}
	const reopened = await f.open();
	expect(reopened.hid).toBe(prepared.hid);
	await reopened.close();
});

it("retains failed-open cleanup under its exact error until the store closes", async () => {
	const key = f.key();
	const control = blockNativeClose();
	control.blocked = false;
	const listening = vi.spyOn(Server.prototype, "listen").mockImplementationOnce(function (
		this: Server,
	) {
		control.blocked = true;
		process.nextTick(() => this.emit("error", new Error("DYTEST native bind failure")));
		return this;
	});
	let openingError: unknown;
	try {
		openingError = await failure(
			openNativeDeviceContext({ folder: f.folder, nativeBinding, masterKey: key }, () => {}),
		);
		failedOwners.add(openingError);
		expect(openingError).toMatchObject({ code: "OPEN_INCOMPLETE" });
		expectErased(key);
		await expect(f.open()).rejects.toMatchObject({ code: "SESSION_ACTIVE" });
		await expect(
			closeFailedNativeDeviceContext(Object.assign(new Error("DYTEST copy"), openingError)),
		).rejects.toThrow("CONTEXT_UNAVAILABLE");
		await expect(closeFailedNativeDeviceContext(openingError)).rejects.toMatchObject({
			code: "CLOSE_INCOMPLETE",
		});
		control.blocked = false;
		await bounded(closeFailedNativeDeviceContext(openingError));
		failedOwners.delete(openingError);
		await expect(closeFailedNativeDeviceContext(openingError)).rejects.toThrow(
			"CONTEXT_UNAVAILABLE",
		);
		expect(listening).toHaveBeenCalledTimes(1);
	} finally {
		control.blocked = false;
		control.restore();
		listening.mockRestore();
	}
	const reopened = await f.open();
	await reopened.close();
});

it("opens compiled original session and context authority through the public entry", async () => {
	const built = await import(
		pathToFileURL(path.resolve(import.meta.dirname, "../../../dist/index.mjs")).href
	);
	for (const name of [
		"MasterKey",
		"openHubSession",
		"NativeDeviceTls",
		"Authorizer",
		"DevicePairingAuthority",
		"openNativeDeviceContext",
		"closeFailedNativeDeviceContext",
	])
		expect(typeof built[name]).toBe("function");
	const fixture = sessionFixture("draftyak-compiled-device-context-");
	const bytes = randomBytes(32);
	const keys = [new built.MasterKey(bytes), new built.MasterKey(bytes)];
	bytes.fill(0);
	const sessions: { close(): Promise<void> }[] = [];
	let preparation: NativeFixture | undefined;
	let running: RunningContext | undefined;
	let failedOpen: unknown;
	let hasFailedOpen = false;
	let cleanupFailed = false;
	try {
		const session = await built.openHubSession({
			folder: fixture.folder,
			nativeBinding,
			masterKey: keys[0],
		});
		sessions.push(session);
		preparation = await sessionTransport(session, keys[0], fixture.folder, built);
		const credential = await device(preparation);
		const secret = randomBytes(16);
		const authority = new built.DevicePairingAuthority(
			session.devices,
			session.store,
			keys[0],
			secret,
		);
		const exchange = claimExchange(credential, secret);
		let deviceId: string;
		try {
			session.store.write((tx: SqlTransaction) =>
				authority.claim(tx, credential.peer, exchange.claim),
			);
			const paired = session.store.write((tx: SqlTransaction) =>
				authority.reveal(tx, credential.peer, exchange.reveal),
			);
			deviceId = paired.deviceId;
			await session.devices.bootstrap(deviceId, PIN);
		} finally {
			secret.fill(0);
			exchange.claim.fill(0);
			exchange.reveal.fill(0);
		}
		const hid = session.hid;
		await Promise.all(preparation.devices.map((client) => destroy(client.socket)));
		await closeSessionTransport(preparation);
		preparation = undefined;
		await session.close();
		expect(() => keys[0].derive("db")).toThrow("Hub is locked");
		try {
			running = await start(fixture, { key: keys[1], open: built.openNativeDeviceContext });
		} catch (error) {
			failedOpen = error;
			hasFailedOpen = true;
			throw error;
		}
		const context = running.context;
		expect(context.endpoint).toMatchObject({ address: "127.0.0.1", hid });
		const accepted = await connect(running, credential);
		expect(context.requirePeerDevice(accepted.peer, "read").deviceId).toBe(deviceId);
		expect(context.requirePeerKind(accepted.peer, "approval.send.v1").deviceId).toBe(deviceId);
		const ending = context.close();
		expect(() => context.requirePeerRoute(accepted.peer, "status")).toThrow("CONTEXT_UNAVAILABLE");
		await bounded(ending);
		await bounded(closed(accepted.socket));
		expect(() => keys[1].derive("db")).toThrow("Hub is locked");
	} finally {
		const results = await Promise.allSettled([
			...(preparation ? [closeSessionTransport(preparation)] : []),
			...(running ? [running.context.close()] : []),
			...sessions.map((session) => session.close()),
			...(hasFailedOpen ? [built.closeFailedNativeDeviceContext(failedOpen)] : []),
		]);
		for (const key of keys) key.destroy();
		cleanupFailed = results.some((result) => result.status === "rejected");
		if (!cleanupFailed) await fixture.remove();
	}
	if (cleanupFailed) throw new Error("Compiled native context cleanup incomplete");
});

it.each(["throws synchronously", "returns a rejected Promise"] as const)(
	"destroys both TLS sockets when onPeer %s",
	async (mode) => {
		const prepared = await preparePairedDevices(f);
		const invoked = Promise.withResolvers<void>();
		const serverClosed = Promise.withResolvers<void>();
		let serverSocket: TLSSocket | undefined;
		let observedOwner: NativeDeviceContext | undefined;
		let grantedDeviceId: string | undefined;
		let calls = 0;
		const context = await openNativeDeviceContext(
			{ folder: f.folder, nativeBinding, masterKey: f.key() },
			(peer, socket, owner) => {
				sockets.add(socket);
				serverSocket = socket;
				observedOwner = owner;
				calls++;
				socket.once("close", () => serverClosed.resolve());
				try {
					grantedDeviceId = owner.requirePeerDevice(peer, "read").deviceId;
					invoked.resolve();
				} catch (error) {
					invoked.reject(error);
					throw error;
				}
				if (mode === "throws synchronously")
					throw new Error("DYTEST synchronous peer handler failure");
				return Promise.reject(new Error("DYTEST rejected peer handler failure"));
			},
		);
		contexts.add(context);
		const endpoint = context.endpoint;
		const client = tlsConnect({
			host: endpoint.address,
			port: endpoint.port,
			key: prepared.confirmed.transportKey.export({ format: "pem", type: "pkcs8" }),
			cert: prepared.confirmed.certificate,
			rejectUnauthorized: false,
			minVersion: "TLSv1.3",
			maxVersion: "TLSv1.3",
		});
		sockets.add(client);
		client.on("error", () => {});
		const clientClosed = closed(client);
		await bounded(invoked.promise);
		await bounded(Promise.all([serverClosed.promise, clientClosed]));
		expect(grantedDeviceId).toBe(prepared.confirmedId);
		expect(observedOwner).toBe(context);
		expect(calls).toBe(1);
		expect(serverSocket?.closed).toBe(true);
		expect(client.closed).toBe(true);
		expect(context.endpoint).toBe(endpoint);
		// Keep Vitest's normal unhandled-rejection reporting active through the next turn.
		await new Promise<void>((resolve) => setImmediate(resolve));
	},
);
