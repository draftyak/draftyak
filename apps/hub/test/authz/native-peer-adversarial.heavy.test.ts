import { randomBytes } from "node:crypto";
import type { TLSSocket } from "node:tls";
import { afterEach, expect, it, vi } from "vitest";
import type { NativeDevicePeer } from "../../src/authz/native-peer.ts";
import type { VerifiedCandidate } from "../../src/identity/devices-pairing.ts";
import { requireLoopbackNetworkGuard } from "../helpers/loopback-network.ts";
import type { NativeFixture, TestDevice } from "./native-fixture.ts";

requireLoopbackNetworkGuard();
const { Authorizer } = await import("../../src/authz/authorizer.ts");
const { AuthzError } = await import("../../src/authz/errors.ts");
const { NativeDeviceTls, nativePeerEkm, nativePeerSpki } = await import(
	"../../src/authz/native-peer.ts"
);
const { DeviceRegistry, advanceEpochForRestore } = await import("../../src/identity/devices.ts");
const { HubIdentity } = await import("../../src/identity/hub-key.ts");
const { makePairingClaim, pairingEkm, sidecarWindowSecrets } = await import(
	"@draftyak/protocol/pairing"
);
const {
	bootstrap,
	claimBytes,
	claimExchange,
	closeFixture,
	device,
	fixture: createFixture,
	sidecar,
} = await import("./native-fixture.ts");

const fixtures: NativeFixture[] = [];
const secrets: Uint8Array[] = [];
const servers = new WeakMap<NativeDevicePeer, TLSSocket>();

function refusal(work: () => unknown, expected: string): void {
	let code = "NO_REFUSAL";
	try {
		work();
	} catch (error) {
		code = error instanceof AuthzError ? error.code : "UNEXPECTED_ERROR";
	}
	expect(code).toBe(expected);
}

async function bounded<T>(work: Promise<T>): Promise<T> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	try {
		return await Promise.race([
			work,
			new Promise<never>((_resolve, reject) => {
				timer = setTimeout(() => reject(new Error("Native fixture did not settle")), 5_000);
			}),
		]);
	} finally {
		clearTimeout(timer);
	}
}

function closed(socket: TLSSocket): Promise<void> {
	return socket.closed
		? Promise.resolve()
		: new Promise<void>((resolve) => socket.once("close", () => resolve()));
}

function server(client: TestDevice): TLSSocket {
	const socket = servers.get(client.peer);
	if (!socket) throw new Error("Actual native server socket missing");
	return socket;
}

async function fixture(): Promise<NativeFixture> {
	requireLoopbackNetworkGuard();
	const f = await createFixture();
	fixtures.push(f);
	await f.tls.close();
	// Keep the actual listener-issued peer and socket; this callback grants no durable rights.
	f.tls = new NativeDeviceTls(f.registry, f.identity, (peer, socket) => {
		servers.set(peer, socket);
		const resolve = f.waiting.shift();
		if (resolve) resolve(peer);
		else f.nextPeers.push(peer);
	});
	f.port = await f.tls.listen();
	return f;
}

function window(f: NativeFixture) {
	const secret = randomBytes(16);
	secrets.push(secret);
	return { secret, pairer: sidecar(f, secret) };
}

afterEach(async () => {
	try {
		while (fixtures.length) {
			const f = fixtures.pop();
			if (f) await bounded(closeFixture(f));
		}
	} finally {
		for (const secret of secrets.splice(0)) secret.fill(0);
	}
});

function snapshot(f: NativeFixture) {
	return f.store.read((db) => {
		const state = f.registry.state(db);
		return {
			epoch: state.epoch,
			bootstrapDone: state.bootstrapDone,
			ownerAssigned: state.ownerUserId !== null,
			devices: db.get<{ count: number }>("SELECT count(*) AS count FROM main.devices")?.count,
			users: db.get<{ count: number }>("SELECT count(*) AS count FROM main.users")?.count,
			pins: db.get<{ count: number }>("SELECT count(*) AS count FROM main.approval_pins")?.count,
			audit: db.get<{ audit_seq: number; audit_head: string }>(
				"SELECT audit_seq,audit_head FROM main.audit_meta WHERE singleton=1",
			),
		};
	});
}

function record(f: NativeFixture, client: TestDevice, current: ReturnType<typeof window>) {
	const exchange = claimExchange(client, current.secret);
	try {
		f.store.write((tx) => current.pairer.claim(tx, client.peer, exchange.claim));
		return f.store.write((tx) => current.pairer.reveal(tx, client.peer, exchange.reveal));
	} finally {
		exchange.claim.fill(0);
		exchange.reveal.fill(0);
	}
}

it("refuses forged peers, candidate copies, cross-registry peers and native facades", async () => {
	const f = await fixture();
	const client = await device(f);
	const candidate = record(f, client, window(f));
	expect(nativePeerSpki(f.registry, client.peer) === client.transportSpkiSha256).toBe(true);
	const before = snapshot(f);
	let facadeCalls = 0;
	const fakeSocket = {
		getPeerX509Certificate: () => {
			facadeCalls++;
		},
		exportKeyingMaterial: () => {
			facadeCalls++;
		},
	};
	for (const fake of [
		{},
		{ ...client.peer },
		Object.create(Object.getPrototypeOf(client.peer)),
		Object.create(client.peer),
		new Proxy(client.peer, {}),
		client.socket,
		server(client),
		fakeSocket,
		Object.create(NativeDeviceTls.prototype),
	]) {
		const peer = fake as NativeDevicePeer;
		refusal(() => nativePeerSpki(f.registry, peer), "PEER_REFUSED");
		refusal(() => nativePeerEkm(f.registry, peer, randomBytes(16)), "PEER_REFUSED");
		f.store.read((db) =>
			refusal(() => f.authorizer.requirePeerDevice(db, peer, "approve"), "PEER_REFUSED"),
		);
	}
	expect(facadeCalls).toBe(0);
	const evidence = {
		deviceId: candidate.deviceId,
		window: "sidecar",
		role: "device",
		name: "DYTEST native peer",
		transportSpkiSha256: client.transportSpkiSha256,
		signingKey: client.signingKey,
	};
	for (const fake of [
		candidate,
		{ ...candidate },
		evidence,
		Object.create(candidate),
		new Proxy(candidate, {}),
	]) {
		refusal(
			() =>
				f.store.write((tx) => f.registry.recordCandidate(tx, fake as unknown as VerifiedCandidate)),
			"CANDIDATE_INVALID",
		);
	}
	const second = new DeviceRegistry(f.store, f.audit, f.pins, { identity: f.identity });
	f.store.read((db) =>
		refusal(
			() => new Authorizer(second).requirePeerDevice(db, client.peer, "approve"),
			"PEER_REFUSED",
		),
	);
	const facade = Object.assign(Object.create(HubIdentity.prototype), {
		hid: f.identity.hid,
		certificate: f.identity.certificate,
		tlsPrivateKey: () => {
			facadeCalls++;
			return Buffer.alloc(0);
		},
	});
	const facadeRegistry = new DeviceRegistry(f.store, f.audit, f.pins, { identity: facade });
	refusal(() => new NativeDeviceTls(facadeRegistry, facade, () => {}), "PEER_REFUSED");
	expect(facadeCalls).toBe(0);
	expect(snapshot(f)).toEqual(before);
	f.store.read((db) =>
		refusal(() => f.authorizer.requirePeerDevice(db, client.peer, "approve"), "DEVICE_PENDING"),
	);
});

it("refuses a valid wire claim after its actual native TLS peer closes", async () => {
	const f = await fixture();
	const client = await device(f);
	const current = window(f);
	const bytes = claimBytes(client, current.secret);
	const before = snapshot(f);
	const serverClosed = closed(server(client));
	client.socket.destroy();
	await bounded(serverClosed);
	try {
		expect(server(client).destroyed).toBe(true);
		refusal(
			() => f.store.write((tx) => current.pairer.claim(tx, client.peer, bytes)),
			"PEER_REFUSED",
		);
		expect(snapshot(f)).toEqual(before);
	} finally {
		bytes.fill(0);
	}
});

it("retires live peer-bound grants on native socket death and listener closure", async () => {
	const f = await fixture();
	const first = await bootstrap(f);
	const second = await device(f, first);
	const before = snapshot(f);
	expect(f.store.read((db) => f.registry.facts(db, first.id ?? "")?.keyClass)).toBeNull();
	const firstClosed = closed(server(first));
	f.store.read((db) => {
		const grant = f.authorizer.requirePeerDevice(db, first.peer, "approve");
		f.authorizer.assertCurrentGrant(db, grant);
		server(first).destroy();
		refusal(() => f.authorizer.assertCurrentGrant(db, grant), "PEER_REFUSED");
	});
	await bounded(firstClosed);
	f.store.read((db) => {
		refusal(() => f.authorizer.requirePeerDevice(db, first.peer, "approve"), "PEER_REFUSED");
		expect(
			f.authorizer.requirePeerDevice(db, second.peer, "approve").capabilities.includes("approve"),
		).toBe(true);
	});
	let retired: Promise<void> | undefined;
	f.store.read((db) => {
		const grant = f.authorizer.requirePeerDevice(db, second.peer, "approve");
		f.authorizer.assertCurrentGrant(db, grant);
		retired = f.tls.close();
		refusal(() => f.authorizer.assertCurrentGrant(db, grant), "PEER_REFUSED");
	});
	await bounded(retired ?? Promise.reject(new Error("Listener retirement did not start")));
	f.store.read((db) =>
		refusal(() => f.authorizer.requirePeerDevice(db, second.peer, "approve"), "PEER_REFUSED"),
	);
	expect(snapshot(f)).toEqual(before);
});

it("binds a valid sidecar claim to the actual exporter and client SPKI", async () => {
	const f = await fixture();
	const first = await device(f);
	const second = await device(f, first);
	const unrelated = await device(f);
	const current = window(f);
	const secrets = { ...sidecarWindowSecrets(current.secret), role: "device" as const };
	const a = pairingEkm(first.socket, secrets.pid);
	const b = pairingEkm(second.socket, secrets.pid);
	const actual = nativePeerEkm(f.registry, first.peer, Buffer.from(secrets.pid, "base64url"));
	let wrongSpki: Uint8Array;
	try {
		expect(Buffer.from(a).equals(Buffer.from(b))).toBe(false);
		expect(Buffer.from(a).equals(Buffer.from(actual))).toBe(true);
		expect(nativePeerSpki(f.registry, first.peer) === nativePeerSpki(f.registry, second.peer)).toBe(
			true,
		);
		wrongSpki = Buffer.from(
			JSON.stringify(
				makePairingClaim(
					secrets,
					{
						name: "DYTEST native peer",
						transportSpkiSha256: unrelated.transportSpkiSha256,
						signingKey: first.signingKey,
					},
					a,
					randomBytes(16),
				),
			),
		);
	} finally {
		a.fill(0);
		b.fill(0);
		actual.fill(0);
	}
	const exchange = claimExchange(first, current.secret);
	const bytes = exchange.claim;
	const before = snapshot(f);
	try {
		refusal(
			() => f.store.write((tx) => current.pairer.claim(tx, first.peer, wrongSpki)),
			"CANDIDATE_INVALID",
		);
		expect(snapshot(f)).toEqual(before);
		refusal(
			() => f.store.write((tx) => current.pairer.claim(tx, second.peer, bytes)),
			"CANDIDATE_INVALID",
		);
		expect(snapshot(f)).toEqual(before);
		const answer = f.store.write((tx) => current.pairer.claim(tx, first.peer, bytes));
		expect(answer.nh).toMatch(/^[A-Za-z0-9_-]{22}$/);
		expect(snapshot(f)).toEqual(before);
		const candidate = f.store.write((tx) => current.pairer.reveal(tx, first.peer, exchange.reveal));
		expect(candidate).toEqual({ deviceId: answer.deviceId, epoch: answer.epoch });
		expect(snapshot(f).devices).toBe(1);
		expect(snapshot(f).bootstrapDone).toBe(false);
		expect(snapshot(f).ownerAssigned).toBe(false);
		f.store.read((db) => {
			refusal(() => f.authorizer.requirePeerDevice(db, first.peer, "approve"), "DEVICE_PENDING");
			expect(f.registry.facts(db, candidate.deviceId)?.storedCapabilities).toEqual([]);
		});
	} finally {
		bytes.fill(0);
		exchange.reveal.fill(0);
		wrongSpki.fill(0);
	}
});

it("retires the old sidecar window before accepting a new window claim", async () => {
	const f = await fixture();
	const client = await device(f);
	const old = window(f);
	const bytes = claimBytes(client, old.secret);
	const current = window(f);
	const before = snapshot(f);
	try {
		refusal(
			() => f.store.write((tx) => old.pairer.claim(tx, client.peer, bytes)),
			"CANDIDATE_INVALID",
		);
		expect(snapshot(f)).toEqual(before);
		refusal(
			() => f.store.write((tx) => current.pairer.claim(tx, client.peer, bytes)),
			"CANDIDATE_INVALID",
		);
		expect(snapshot(f)).toEqual(before);
		record(f, client, current);
		expect(snapshot(f).devices).toBe(1);
		expect(snapshot(f).bootstrapDone).toBe(false);
		expect(snapshot(f).ownerAssigned).toBe(false);
	} finally {
		bytes.fill(0);
	}
});

it("keeps a held claim after malformed, wrong-window and other-connection reveals", async () => {
	const f = await fixture();
	const client = await device(f);
	const otherConnection = await device(f, client);
	const current = window(f);
	const exchange = claimExchange(client, current.secret);
	try {
		const before = snapshot(f);
		const answer = f.store.write((tx) => current.pairer.claim(tx, client.peer, exchange.claim));
		expect(snapshot(f)).toEqual(before);
		refusal(
			() => f.store.write((tx) => current.pairer.claim(tx, client.peer, exchange.claim)),
			"CANDIDATE_INVALID",
		);
		for (const malformed of [Buffer.from("{"), Buffer.alloc(1025), Buffer.from([0xc3])]) {
			refusal(
				() => f.store.write((tx) => current.pairer.reveal(tx, client.peer, malformed)),
				"CANDIDATE_INVALID",
			);
			expect(snapshot(f)).toEqual(before);
		}
		const reveal = JSON.parse(Buffer.from(exchange.reveal).toString()) as {
			pid: string;
			nd: string;
		};
		const wrongPid = Buffer.from(reveal.pid, "base64url");
		wrongPid[0] = (wrongPid[0] ?? 0) ^ 1;
		refusal(
			() =>
				f.store.write((tx) =>
					current.pairer.reveal(
						tx,
						client.peer,
						Buffer.from(JSON.stringify({ ...reveal, pid: wrongPid.toString("base64url") })),
					),
				),
			"CANDIDATE_INVALID",
		);
		refusal(
			() => f.store.write((tx) => current.pairer.reveal(tx, otherConnection.peer, exchange.reveal)),
			"CANDIDATE_INVALID",
		);
		expect(snapshot(f)).toEqual(before);
		const recorded = f.store.write((tx) => current.pairer.reveal(tx, client.peer, exchange.reveal));
		expect(recorded).toEqual({ deviceId: answer.deviceId, epoch: answer.epoch });
		expect(snapshot(f).devices).toBe(1);
		const after = snapshot(f);
		refusal(
			() => f.store.write((tx) => current.pairer.reveal(tx, client.peer, exchange.reveal)),
			"CANDIDATE_INVALID",
		);
		expect(snapshot(f)).toEqual(after);
	} finally {
		exchange.claim.fill(0);
		exchange.reveal.fill(0);
	}
});

it("consumes a held claim on its first commitment comparison, including a mismatch", async () => {
	const f = await fixture();
	const client = await device(f);
	const current = window(f);
	const exchange = claimExchange(client, current.secret);
	try {
		const before = snapshot(f);
		f.store.write((tx) => current.pairer.claim(tx, client.peer, exchange.claim));
		const reveal = JSON.parse(Buffer.from(exchange.reveal).toString()) as {
			pid: string;
			nd: string;
		};
		const wrongNonce = Buffer.from(reveal.nd, "base64url");
		wrongNonce[0] = (wrongNonce[0] ?? 0) ^ 1;
		const wrongReveal = Buffer.from(
			JSON.stringify({ ...reveal, nd: wrongNonce.toString("base64url") }),
		);
		refusal(
			() => f.store.write((tx) => current.pairer.reveal(tx, client.peer, wrongReveal)),
			"CANDIDATE_INVALID",
		);
		refusal(
			() => f.store.write((tx) => current.pairer.reveal(tx, client.peer, exchange.reveal)),
			"CANDIDATE_INVALID",
		);
		refusal(
			() => f.store.write((tx) => current.pairer.claim(tx, client.peer, exchange.claim)),
			"CANDIDATE_INVALID",
		);
		window(f);
		const replacement = sidecar(f, current.secret);
		refusal(
			() => f.store.write((tx) => replacement.claim(tx, client.peer, exchange.claim)),
			"CANDIDATE_INVALID",
		);
		expect(snapshot(f)).toEqual(before);
		wrongNonce.fill(0);
		wrongReveal.fill(0);
	} finally {
		exchange.claim.fill(0);
		exchange.reveal.fill(0);
	}
});

it("does not reopen or transfer a held claim when the same bootstrap secret is reused", async () => {
	const f = await fixture();
	const client = await device(f);
	const current = window(f);
	const exchange = claimExchange(client, current.secret);
	try {
		const before = snapshot(f);
		f.store.write((tx) => current.pairer.claim(tx, client.peer, exchange.claim));
		const replacement = sidecar(f, current.secret);
		for (const authority of [current.pairer, replacement]) {
			refusal(
				() => f.store.write((tx) => authority.claim(tx, client.peer, exchange.claim)),
				"CANDIDATE_INVALID",
			);
			refusal(
				() => f.store.write((tx) => authority.reveal(tx, client.peer, exchange.reveal)),
				"CANDIDATE_INVALID",
			);
		}
		expect(snapshot(f)).toEqual(before);
	} finally {
		exchange.claim.fill(0);
		exchange.reveal.fill(0);
	}
});

it("refuses a claim at the original window deadline without reopening that bootstrap secret", async () => {
	const f = await fixture();
	const client = await device(f);
	const started = performance.now();
	const clock = vi.spyOn(performance, "now").mockReturnValue(started);
	const current = window(f);
	const exchange = claimExchange(client, current.secret);
	try {
		const before = snapshot(f);
		clock.mockReturnValue(started + 300_000);
		refusal(
			() => f.store.write((tx) => current.pairer.claim(tx, client.peer, exchange.claim)),
			"CANDIDATE_INVALID",
		);
		clock.mockRestore();
		const replacement = sidecar(f, current.secret);
		refusal(
			() => f.store.write((tx) => replacement.claim(tx, client.peer, exchange.claim)),
			"CANDIDATE_INVALID",
		);
		expect(snapshot(f)).toEqual(before);
	} finally {
		clock.mockRestore();
		exchange.claim.fill(0);
		exchange.reveal.fill(0);
	}
});

it.each(["closed", "replaced", "epoch", "expired", "disconnected"])(
	"discards a held claim when its authority is %s",
	async (reason) => {
		const f = await fixture();
		const client = await device(f);
		const started = performance.now();
		let clock: { mockRestore(): void; mockReturnValue(value: number): unknown } | undefined =
			reason === "expired" ? vi.spyOn(performance, "now").mockReturnValue(started) : undefined;
		const current = window(f);
		const exchange = claimExchange(client, current.secret);
		try {
			f.store.write((tx) => current.pairer.claim(tx, client.peer, exchange.claim));
			if (reason === "closed") current.pairer.close();
			if (reason === "replaced") window(f);
			if (reason === "epoch") f.store.write((tx) => advanceEpochForRestore(f.registry, tx));
			if (reason === "expired") clock?.mockReturnValue(started + 300_000);
			if (reason === "disconnected") {
				const native = server(client);
				client.socket.destroy();
				await bounded(Promise.all([closed(client.socket), closed(native)]));
			}
			const before = snapshot(f);
			expect(() =>
				f.store.write((tx) => current.pairer.reveal(tx, client.peer, exchange.reveal)),
			).toThrow(AuthzError);
			const replacement = sidecar(f, current.secret);
			refusal(
				() => f.store.write((tx) => replacement.claim(tx, client.peer, exchange.claim)),
				"CANDIDATE_INVALID",
			);
			clock?.mockRestore();
			clock = undefined;
			expect(() =>
				f.store.write((tx) => current.pairer.reveal(tx, client.peer, exchange.reveal)),
			).toThrow(AuthzError);
			expect(snapshot(f)).toEqual(before);
		} finally {
			clock?.mockRestore();
			exchange.claim.fill(0);
			exchange.reveal.fill(0);
		}
	},
);

it("refuses an unused old-window wire claim after an actual epoch advance", async () => {
	const f = await fixture();
	const client = await device(f);
	const old = window(f);
	const bytes = claimBytes(client, old.secret);
	const epoch = snapshot(f).epoch;
	expect(f.store.write((tx) => advanceEpochForRestore(f.registry, tx))).toBe(epoch + 1);
	const before = snapshot(f);
	expect(nativePeerSpki(f.registry, client.peer) === client.transportSpkiSha256).toBe(true);
	try {
		refusal(
			() => f.store.write((tx) => old.pairer.claim(tx, client.peer, bytes)),
			"CANDIDATE_INVALID",
		);
		expect(snapshot(f)).toEqual(before);
		const sameWindow = sidecar(f, old.secret);
		refusal(
			() => f.store.write((tx) => sameWindow.claim(tx, client.peer, bytes)),
			"CANDIDATE_INVALID",
		);
		expect(snapshot(f)).toEqual(before);
		const candidate = record(f, client, window(f));
		expect(candidate.epoch).toBe(epoch + 1);
		expect(snapshot(f).devices).toBe(1);
		expect(snapshot(f).bootstrapDone).toBe(false);
		expect(snapshot(f).ownerAssigned).toBe(false);
	} finally {
		bytes.fill(0);
	}
});

it("rechecks current-epoch rights on a still-live native TLS peer", async () => {
	const f = await fixture();
	const client = await bootstrap(f);
	const previous = snapshot(f);
	f.store.read((db) => {
		expect(
			f.authorizer.requirePeerDevice(db, client.peer, "approve").capabilities.includes("approve"),
		).toBe(true);
	});
	expect(f.store.write((tx) => advanceEpochForRestore(f.registry, tx))).toBe(previous.epoch + 1);
	expect(nativePeerSpki(f.registry, client.peer) === client.transportSpkiSha256).toBe(true);
	f.store.read((db) => {
		const state = f.registry.state(db);
		const facts = f.registry.facts(db, client.id ?? "");
		expect(facts?.confirmedEpoch).toBe(previous.epoch);
		expect(state.epoch).toBe(previous.epoch + 1);
		refusal(() => f.authorizer.requirePeerDevice(db, client.peer, "approve"), "DEVICE_PENDING");
	});
	const current = snapshot(f);
	expect(current.devices).toBe(previous.devices);
	expect(current.users).toBe(previous.users);
	expect(current.pins).toBe(previous.pins);
	expect(current.bootstrapDone).toBe(false);
	expect(current.ownerAssigned).toBe(true);
});
