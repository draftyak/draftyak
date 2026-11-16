import { randomBytes } from "node:crypto";
import type { Socket } from "node:net";
import { afterEach, expect, it } from "vitest";
import type { NativeRuntimeState } from "../../src/lifecycle/native-runtime-state.ts";
import type { HubSession } from "../../src/lifecycle/session.ts";
import type { NativeFixture, TestDevice } from "../authz/native-fixture.ts";
import { requireLoopbackNetworkGuard } from "../helpers/loopback-network.ts";
import type { SessionFixture } from "./session-helpers.ts";

requireLoopbackNetworkGuard();
const [
	{ createNativeRuntimeState },
	{ AuthzError },
	{ cliConfirmPinScope, revokePinScope },
	{ nativePairingWindows },
	{ decodePairingPayload, makePairingClaim, pairingEkm, PairingReveal },
	{ canonicalize },
	{ SchedulingStatus },
	{ sessionFixture, sessionTransport, closeSessionTransport, expectErased, expectUsable },
	{ admit, bootstrap, device, idOf, owner, PIN },
] = await Promise.all([
	import("../../src/lifecycle/native-runtime-state.ts"),
	import("../../src/authz/errors.ts"),
	import("../../src/authz/scopes.ts"),
	import("../../src/lifecycle/session.ts"),
	import("@draftyak/protocol/pairing"),
	import("@draftyak/protocol/jcs"),
	import("@draftyak/protocol/hub-runtime"),
	import("./session-helpers.ts"),
	import("../authz/native-fixture.ts"),
]);

const fixtures: SessionFixture[] = [];
const sessions: HubSession[] = [];
const transports: NativeFixture[] = [];
const runtimes = new Set<NativeRuntimeState>();

async function destroy(socket: Socket): Promise<void> {
	if (socket.closed) return;
	const ending = new Promise<void>((resolve) => socket.once("close", () => resolve()));
	socket.destroy();
	await ending;
}
afterEach(async () => {
	const children = await Promise.allSettled([...runtimes].map((runtime) => runtime.close()));
	const sockets = await Promise.allSettled(
		transports.flatMap((native) => native.devices.map((client) => destroy(client.socket))),
	);
	const listeners = await Promise.allSettled(transports.map(closeSessionTransport));
	const parents = await Promise.allSettled(sessions.map((session) => session.close()));
	if (
		[...children, ...sockets, ...listeners, ...parents].some(
			(result) => result.status === "rejected",
		)
	)
		throw new Error("Native runtime fixture cleanup incomplete");
	runtimes.clear();
	transports.length = 0;
	sessions.length = 0;
	for (const fixture of fixtures.splice(0)) await fixture.remove();
});

async function limitedCandidate(session: HubSession, native: NativeFixture, confirmed: TestDevice) {
	const windows = await nativePairingWindows(session);
	const opened = await windows.open(confirmed.peer, { role: "device", pin: PIN });
	const limited = await device(native);
	const nonce = randomBytes(16);
	let ekm: Uint8Array | undefined;
	let claimBytes: Buffer | undefined;
	let revealBytes: Buffer | undefined;
	try {
		const payload = decodePairingPayload(opened.pairingCode, Date.now());
		ekm = pairingEkm(limited.socket, payload.pid);
		const claim = makePairingClaim(
			{ pid: payload.pid, role: payload.role, sec: payload.sec },
			{
				name: "DYTEST limited runtime reader",
				transportSpkiSha256: limited.transportSpkiSha256,
				signingKey: limited.signingKey,
			},
			ekm,
			nonce,
		);
		claimBytes = Buffer.from(canonicalize(claim));
		revealBytes = Buffer.from(
			canonicalize(PairingReveal.parse({ pid: payload.pid, nd: nonce.toString("base64url") })),
		);
		const answer = windows.claim(limited.peer, claimBytes);
		const candidate = windows.reveal(limited.peer, revealBytes);
		if (answer.deviceId !== candidate.deviceId)
			throw new Error("Native candidate identity refused");
		limited.id = candidate.deviceId;
		return limited;
	} catch {
		throw new Error("Native runtime reader pairing setup refused");
	} finally {
		nonce.fill(0);
		ekm?.fill(0);
		claimBytes?.fill(0);
		revealBytes?.fill(0);
	}
}

async function setup(mode: "sidecar" | "service") {
	const fixture = sessionFixture("draftyak-runtime-state-");
	fixtures.push(fixture);
	const key = fixture.key();
	const session = await fixture.open({ masterKey: key });
	sessions.push(session);
	const native = await sessionTransport(session, key, fixture.folder);
	transports.push(native);
	const pending = await device(native);
	admit(native, pending);
	const revoked = await device(native);
	const revokedId = admit(native, revoked);
	const confirmed = await bootstrap(native);
	const limited = await limitedCandidate(session, native, confirmed);
	const proof = await native.pins.verify(owner(native), PIN, cliConfirmPinScope(idOf(limited)));
	expect(
		native.store.write((tx) => native.registry.confirmFromCli(tx, idOf(limited), proof))
			.capabilities,
	).toEqual(["read", "draft"]);
	const revokeProof = await native.pins.verify(owner(native), PIN, revokePinScope(revokedId));
	expect(
		native.store.write((tx) =>
			native.registry.revoke(tx, revokedId, {
				kind: "device",
				id: idOf(confirmed),
				proof: revokeProof,
			}),
		),
	).toBe(true);
	const runtime = createNativeRuntimeState(session, mode);
	runtimes.add(runtime);
	return { fixture, key, session, native, runtime, confirmed, pending, revoked, limited };
}

function refused(operation: () => unknown, code: string): void {
	let error: unknown;
	try {
		operation();
	} catch (caught) {
		error = caught;
	}
	expect(error instanceof AuthzError).toBe(true);
	expect(error instanceof AuthzError && error.code === code).toBe(true);
}

it.each(["sidecar", "service"] as const)(
	"reports actual native %s mode and no scheduler resource to owner and CLI readers",
	async (mode) => {
		const f = await setup(mode);
		const actual = f.runtime.status(f.confirmed.peer);
		expect(SchedulingStatus.safeParse(actual).success).toBe(true);
		expect(actual).toEqual({ mode, scheduler: "unavailable", syncPaused: false });
		expect(f.runtime.status(f.limited.peer)).toEqual(actual);
		expectUsable(f.key);
	},
);

it("persists real Pause across child retirement and a new original session without releasing the parent key", async () => {
	const f = await setup("sidecar");
	expect(f.runtime.pauseSync(f.confirmed.peer, true)).toEqual({
		mode: "sidecar",
		scheduler: "unavailable",
		syncPaused: true,
	});
	expect(f.runtime.status(f.limited.peer).syncPaused).toBe(true);
	await f.runtime.close();
	await f.runtime.close();
	refused(() => f.runtime.status(f.confirmed.peer), "UNAVAILABLE");
	refused(() => f.runtime.pauseSync(f.confirmed.peer, false), "UNAVAILABLE");
	expectUsable(f.key);
	expect(
		f.session.store.read(
			(db) => f.native.authorizer.requirePeerDevice(db, f.confirmed.peer, "read").deviceId,
		),
	).toBe(idOf(f.confirmed));
	// A runtime is unique to its original session; a replacement needs a genuine new parent.
	refused(() => createNativeRuntimeState(f.session, "sidecar"), "UNAVAILABLE");
	await Promise.all(f.native.devices.map((client) => destroy(client.socket)));
	await closeSessionTransport(f.native);
	await f.session.close();
	expectErased(f.key);
	const key = f.fixture.key();
	const session = await f.fixture.open({ masterKey: key });
	sessions.push(session);
	const native = await sessionTransport(session, key, f.fixture.folder);
	transports.push(native);
	const confirmed = await device(native, f.confirmed);
	const runtime = createNativeRuntimeState(session, "service");
	runtimes.add(runtime);
	expect(runtime.status(confirmed.peer)).toEqual({
		mode: "service",
		scheduler: "unavailable",
		syncPaused: true,
	});
	expect(runtime.pauseSync(confirmed.peer, false).syncPaused).toBe(false);
	expect(runtime.status(confirmed.peer).syncPaused).toBe(false);
	await runtime.close();
	expectUsable(key);
});

it("requires current READ for status and current organize authority for durable Pause", async () => {
	const f = await setup("sidecar");
	const foreign = await setup("service");
	const before = f.runtime.status(f.confirmed.peer);
	for (const [peer, code] of [
		[f.pending.peer, "DEVICE_PENDING"],
		[f.revoked.peer, "DEVICE_REVOKED"],
		[foreign.confirmed.peer, "PEER_REFUSED"],
	] as const) {
		refused(() => f.runtime.status(peer), code);
		refused(() => f.runtime.pauseSync(peer, true), code);
		expect(f.runtime.status(f.confirmed.peer)).toEqual(before);
	}
	expect(f.runtime.status(f.limited.peer)).toEqual(before);
	refused(() => f.runtime.pauseSync(f.limited.peer, true), "CAPABILITY_MISSING");
	expect(f.runtime.status(f.confirmed.peer)).toEqual(before);
	expect(f.runtime.pauseSync(f.confirmed.peer, true).syncPaused).toBe(true);
	expect(f.runtime.status(f.limited.peer).syncPaused).toBe(true);
	expect(foreign.runtime.status(foreign.confirmed.peer).syncPaused).toBe(false);
	expectUsable(f.key);
});
