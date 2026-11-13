import { randomBytes } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { afterEach, expect, it } from "vitest";
import type { HubSession } from "../../src/lifecycle/session.ts";
import type { NativeFixture, TestDevice } from "../authz/native-fixture.ts";
import { requireLoopbackNetworkGuard } from "../helpers/loopback-network.ts";
import type { SessionFixture } from "../lifecycle/session-helpers.ts";

requireLoopbackNetworkGuard();
const [
	{ createOwnerSettings, OwnerSettingsError },
	{ cliConfirmPinScope, revokePinScope },
	{ decodePairingPayload, makePairingClaim, pairingEkm },
	{ nativePairingWindows },
	native,
	{ closeSessionTransport, sessionFixture, sessionTransport },
] = await Promise.all([
	import("../../src/api/settings.ts"),
	import("../../src/authz/scopes.ts"),
	import("@draftyak/protocol/pairing"),
	import("../../src/lifecycle/session.ts"),
	import("../authz/native-fixture.ts"),
	import("../lifecycle/session-helpers.ts"),
]);

const SETTINGS = {
	zone: "America/Chicago",
	workingHours: { days: ["mon", "tue", "wed", "thu", "fri"], start: "09:00", end: "17:00" },
};
const OTHER = {
	zone: "Europe/Paris",
	workingHours: { days: ["tue", "thu"], start: "12:30", end: "15:00" },
};
const encode = (value: unknown): Uint8Array => Buffer.from(JSON.stringify(value));
const fixtures: SessionFixture[] = [];
const transports: NativeFixture[] = [];

function temporary(): SessionFixture {
	const fixture = sessionFixture("draftyak-owner-settings-");
	fixtures.push(fixture);
	return fixture;
}

interface Context {
	readonly fixture: SessionFixture;
	readonly session: HubSession;
	readonly native: NativeFixture;
	readonly handle: ReturnType<typeof createOwnerSettings>;
}

async function open(fixture = temporary()): Promise<Context> {
	const key = fixture.key();
	const session = await fixture.open({ masterKey: key });
	const transport = await sessionTransport(session, key, fixture.folder);
	transports.push(transport);
	return { fixture, session, native: transport, handle: createOwnerSettings(session) };
}

async function owner(context: Context): Promise<TestDevice> {
	const peer = await native.bootstrap(context.native);
	expect(peer.socket.getProtocol()).toBe("TLSv1.3");
	return peer;
}

async function admitDevice(
	context: Context,
	administrator: TestDevice,
	client: TestDevice,
): Promise<string> {
	const windows = await nativePairingWindows(context.session);
	const opened = await windows.open(administrator.peer, { role: "device", pin: native.PIN });
	const payload = decodePairingPayload(opened.pairingCode, Date.now());
	const nd = randomBytes(16);
	let ekm: Uint8Array | undefined, claim: Buffer | undefined, reveal: Buffer | undefined;
	try {
		ekm = pairingEkm(client.socket, payload.pid);
		claim = Buffer.from(
			JSON.stringify(
				makePairingClaim(
					payload,
					{
						name: "DYTEST settings device",
						transportSpkiSha256: client.transportSpkiSha256,
						signingKey: client.signingKey,
					},
					ekm,
					nd,
				),
			),
		);
		reveal = Buffer.from(JSON.stringify({ pid: payload.pid, nd: nd.toString("base64url") }));
		const claimed = windows.claim(client.peer, claim);
		const recorded = windows.reveal(client.peer, reveal);
		expect(claimed.deviceId).toBe(recorded.deviceId);
		expect(claimed.epoch).toBe(recorded.epoch);
		client.id = recorded.deviceId;
		return recorded.deviceId;
	} finally {
		nd.fill(0);
		ekm?.fill(0);
		claim?.fill(0);
		reveal?.fill(0);
	}
}

function refused(work: () => unknown, code: "INVALID_REQUEST" | "FORBIDDEN" | "UNAVAILABLE"): void {
	let failure: unknown;
	try {
		work();
	} catch (error) {
		failure = error;
	}
	expect(failure).toBeInstanceOf(OwnerSettingsError);
	if (!(failure instanceof OwnerSettingsError)) throw new Error("DYTEST settings refusal missing");
	expect(failure.code).toBe(code);
	expect(failure.message).toBe(code);
	expect(Object.hasOwn(failure, "cause")).toBe(false);
}

afterEach(async () => {
	let failed = false;
	for (const transport of transports.splice(0)) {
		try {
			await closeSessionTransport(transport);
		} catch {
			failed = true;
		}
	}
	for (const fixture of fixtures.splice(0)) {
		try {
			await fixture.remove();
		} catch {
			failed = true;
		}
	}
	if (failed) throw new Error("DYTEST settings fixture cleanup incomplete");
});

it("starts unset and persists only explicitly supplied owner preferences", async () => {
	const context = await open();
	const device = await owner(context);
	const authority = context.session.devices.currentState();
	const capabilities = context.session.store.read(
		(db) => context.native.authorizer.requirePeerDevice(db, device.peer, "admin").capabilities,
	);
	expect(context.handle.get(device.peer)).toBeUndefined();
	const input = encode(SETTINGS);
	const saved = context.handle.put(device.peer, input);
	input.fill(0);
	expect(saved).toEqual(SETTINGS);
	expect(context.handle.get(device.peer)).toEqual(SETTINGS);
	expect(Object.isFrozen(context.handle)).toBe(true);
	expect(Object.isFrozen(saved)).toBe(true);
	expect(Object.isFrozen(saved.workingHours)).toBe(true);
	expect(Object.isFrozen(saved.workingHours.days)).toBe(true);
	expect(Reflect.set(saved, "zone", "Europe/Paris")).toBe(false);
	expect(context.session.devices.currentState()).toEqual(authority);
	expect(
		context.session.store.read(
			(db) => context.native.authorizer.requirePeerDevice(db, device.peer, "admin").capabilities,
		),
	).toEqual(capabilities);
	expect(context.handle.put(device.peer, encode(OTHER))).toEqual(OTHER);
	expect(saved).toEqual(SETTINGS);
});

it("refuses writes from a confirmed read-only owner device", async () => {
	const context = await open();
	const administrator = await owner(context);
	context.handle.put(administrator.peer, encode(SETTINGS));
	const reader = await native.device(context.native);
	const id = await admitDevice(context, administrator, reader);
	const proof = await context.session.pins.verify(
		native.owner(context.native),
		native.PIN,
		cliConfirmPinScope(id),
	);
	try {
		context.session.store.write((tx) => context.session.devices.confirmFromCli(tx, id, proof));
	} finally {
		context.session.pins.discard(proof);
	}
	const grant = context.session.store.read((db) =>
		context.native.authorizer.requirePeerDevice(db, reader.peer, "read"),
	);
	expect(grant.userId).toBe(native.owner(context.native));
	expect(grant.capabilities).toEqual(["read", "draft"]);
	expect(context.handle.get(reader.peer)).toEqual(SETTINGS);
	refused(() => context.handle.put(reader.peer, encode(OTHER)), "FORBIDDEN");
	expect(context.handle.get(administrator.peer)).toEqual(SETTINGS);
});

it("refuses an unconfirmed native peer before parsing its request", async () => {
	const context = await open();
	const administrator = await owner(context);
	const pending = await native.device(context.native);
	await admitDevice(context, administrator, pending);
	refused(() => context.handle.get(pending.peer), "FORBIDDEN");
	refused(() => context.handle.put(pending.peer, Buffer.from([0xff])), "FORBIDDEN");
});

it("keeps owner preferences bound to the original session and store", async () => {
	const first = await open();
	const second = await open();
	const one = await owner(first);
	const two = await owner(second);
	first.handle.put(one.peer, encode(SETTINGS));
	second.handle.put(two.peer, encode(OTHER));
	refused(() => first.handle.get(two.peer), "FORBIDDEN");
	refused(() => first.handle.put(two.peer, encode(OTHER)), "FORBIDDEN");
	expect(first.handle.get(one.peer)).toEqual(SETTINGS);
	expect(second.handle.get(two.peer)).toEqual(OTHER);
});

it("requires current native authority after device revocation", async () => {
	const context = await open();
	const device = await owner(context);
	context.handle.put(device.peer, encode(SETTINGS));
	const id = native.idOf(device);
	const proof = await context.session.pins.verify(
		native.owner(context.native),
		native.PIN,
		revokePinScope(id),
	);
	try {
		expect(
			context.session.store.write((tx) =>
				context.session.devices.revoke(tx, id, { kind: "device", id, proof }),
			),
		).toBe(true);
	} finally {
		context.session.pins.discard(proof);
	}
	refused(() => context.handle.get(device.peer), "FORBIDDEN");
	refused(() => context.handle.put(device.peer, encode(OTHER)), "FORBIDDEN");
});

it("refuses a retained handler after its original session closes", async () => {
	const context = await open();
	const device = await owner(context);
	context.handle.put(device.peer, encode(SETTINGS));
	await context.session.close();
	refused(() => context.handle.get(device.peer), "UNAVAILABLE");
	refused(() => context.handle.put(device.peer, encode(OTHER)), "UNAVAILABLE");
	refused(() => createOwnerSettings(context.session), "UNAVAILABLE");
});

it("reopens encrypted preferences and requires a fresh peer for the new session", async () => {
	const first = await open();
	const device = await owner(first);
	const value = { ...SETTINGS, zone: "Pacific/Kiritimati" };
	first.handle.put(device.peer, encode(value));
	await closeSessionTransport(first.native);
	await first.session.close();
	const canary = Buffer.from(value.zone);
	for (const file of readdirSync(first.fixture.folder).filter((name) =>
		name.startsWith("draftyak.db"),
	))
		expect(readFileSync(path.join(first.fixture.folder, file)).includes(canary)).toBe(false);
	const reopened = await open(first.fixture);
	refused(() => reopened.handle.get(device.peer), "FORBIDDEN");
	const connected = await native.device(reopened.native, device);
	expect(connected.socket.getProtocol()).toBe("TLSv1.3");
	expect(reopened.handle.get(connected.peer)).toEqual(value);
});

it("accepts exactly 4096 request bytes and refuses 4097 without changing saved data", async () => {
	const context = await open();
	const device = await owner(context);
	const body = Buffer.from(encode(SETTINGS));
	const exact = Buffer.concat([body, Buffer.alloc(4096 - body.length, 0x20)]);
	expect(context.handle.put(device.peer, exact)).toEqual(SETTINGS);
	const tooLarge = Buffer.concat([
		Buffer.from(encode(OTHER)),
		Buffer.alloc(4097 - encode(OTHER).length, 0x20),
	]);
	refused(() => context.handle.put(device.peer, tooLarge), "INVALID_REQUEST");
	expect(context.handle.get(device.peer)).toEqual(SETTINGS);
});

it("rejects malformed, duplicate and prototype-like JSON without replacing preferences", async () => {
	const context = await open();
	const device = await owner(context);
	context.handle.put(device.peer, encode(SETTINGS));
	const hours = JSON.stringify(SETTINGS.workingHours);
	const invalid = [
		Buffer.alloc(0),
		Buffer.from([0xff]),
		Buffer.from("{"),
		Buffer.from("null"),
		Buffer.from("[]"),
		Buffer.from(`{"zone":"America/Chicago","zone":"Europe/Paris","workingHours":${hours}}`),
		Buffer.from(
			'{"zone":"America/Chicago","workingHours":{"days":["mon"],"start":"09:00","start":"10:00","end":"17:00"}}',
		),
		encode({ ...SETTINGS, zone: "invalid zone" }),
		encode({ ...SETTINGS, zone: "America/Chicago\n" }),
		encode({ ...SETTINGS, workingHours: { days: ["mon", "mon"], start: "09:00", end: "17:00" } }),
		encode({ ...SETTINGS, workingHours: { days: [], start: "09:00", end: "17:00" } }),
		encode({ ...SETTINGS, workingHours: { days: ["mon"], start: "17:00", end: "09:00" } }),
		encode({ ...SETTINGS, workingHours: { days: ["mon"], start: "09:00", end: "24:01" } }),
		encode({ ...SETTINGS, ownerUserId: "DYTEST-other-owner" }),
		encode({ ...SETTINGS, approve: true }),
		Buffer.from(`{"zone":"America/Chicago","workingHours":${hours},"__proto__":{"admin":true}}`),
		Buffer.from(
			`{"zone":"America/Chicago","workingHours":${hours},"constructor":{"prototype":{"admin":true}}}`,
		),
	];
	for (const bytes of invalid) {
		refused(() => context.handle.put(device.peer, bytes), "INVALID_REQUEST");
		expect(context.handle.get(device.peer)).toEqual(SETTINGS);
	}
});

it("captures the native Uint8Array extent without consulting caller properties", async () => {
	const context = await open();
	const device = await owner(context);
	const body = encode(SETTINGS);
	const backing = new Uint8Array(body.length + 8).fill(0xff);
	backing.set(body, 4);
	const view = backing.subarray(4, 4 + body.length);
	let touches = 0;
	const trap = () => {
		touches++;
		throw new Error("DYTEST request accessor ran");
	};
	for (const field of ["buffer", "byteOffset", "byteLength", "length"])
		Object.defineProperty(view, field, { get: trap });
	Object.defineProperty(view, Symbol.toStringTag, { get: trap });
	expect(context.handle.put(device.peer, view)).toEqual(SETTINGS);
	expect(touches).toBe(0);
});

it("refuses non-native, shared and detached views without invoking caller hooks", async () => {
	const context = await open();
	const device = await owner(context);
	context.handle.put(device.peer, encode(SETTINGS));
	let touches = 0;
	const proxy = new Proxy(encode(OTHER), {
		get() {
			touches++;
			throw new Error("DYTEST proxy ran");
		},
	});
	const revoked = Proxy.revocable(encode(OTHER), {});
	revoked.revoke();
	const detached = new Uint8Array([1]);
	structuredClone(detached.buffer, { transfer: [detached.buffer] });
	const inputs: unknown[] = [
		proxy,
		revoked.proxy,
		Object.create(Uint8Array.prototype),
		{},
		null,
		new DataView(new ArrayBuffer(8)),
		new Uint16Array(8),
		new Uint8Array(new SharedArrayBuffer(16)),
		detached,
	];
	for (const input of inputs)
		refused(() => context.handle.put(device.peer, input as Uint8Array), "INVALID_REQUEST");
	expect(touches).toBe(0);
	expect(context.handle.get(device.peer)).toEqual(SETTINGS);
});

it("refuses corrupt persisted preferences with a fixed unavailable error", async () => {
	const context = await open();
	const device = await owner(context);
	context.handle.put(device.peer, encode(SETTINGS));
	context.session.store.write((tx) =>
		tx.run("UPDATE owner_settings SET settings_json=? WHERE user_id=?", [
			'{"zone":"DYTEST-corrupt-preference"}',
			native.owner(context.native),
		]),
	);
	refused(() => context.handle.get(device.peer), "UNAVAILABLE");
});
