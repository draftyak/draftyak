import { randomBytes } from "node:crypto";
import { afterEach, expect, it } from "vitest";
import type { DeviceGrant } from "../../src/identity/devices.ts";
import type { SqlReader } from "../../src/store/store.ts";
import type { NativeFixture, TestDevice } from "../authz/native-fixture.ts";
import { requireLoopbackNetworkGuard } from "../helpers/loopback-network.ts";

requireLoopbackNetworkGuard();
const [
	{ CONFIRMATION_PRESETS },
	{ canonicalize },
	{ toBase64Url },
	{ signStatement },
	{ AuthzError },
	{ pairConfirmPinScope, revokePinScope },
	{ nativePairingWindows },
	{ requireNativeOutboxCancelPermission },
	{ admit, auditActions, bootstrap, closeFixture, device, fixture, idOf, owner, PIN },
	{ originalSessionAdminFixture, closeOriginalSessionAdminFixtures, pairingExchange },
	{ connectFakeDevice },
] = await Promise.all([
	import("@draftyak/protocol/entities/device"),
	import("@draftyak/protocol/jcs"),
	import("@draftyak/protocol/scalars"),
	import("@draftyak/protocol/sign"),
	import("../../src/authz/errors.ts"),
	import("../../src/authz/scopes.ts"),
	import("../../src/lifecycle/session.ts"),
	import("../../src/outbox/cancel-permission.ts"),
	import("../authz/native-fixture.ts"),
	import("../identity/original-session-admin-fixture.ts"),
	import("../support/fake-device/harness.ts"),
]);

const fixtures: NativeFixture[] = [];
type OriginalFixture = Awaited<ReturnType<typeof originalSessionAdminFixture>>;
const originalFixtures: OriginalFixture[] = [];

async function createFixture(): Promise<NativeFixture> {
	const value = await fixture();
	fixtures.push(value);
	return value;
}

afterEach(async () => {
	let failure: unknown;
	for (const value of originalFixtures.splice(0).reverse()) {
		try {
			await value.close();
		} catch (error) {
			failure ??= error;
		}
	}
	for (const value of fixtures.splice(0).reverse()) {
		try {
			await closeFixture(value);
		} catch (error) {
			failure ??= error;
		}
	}
	try {
		await closeOriginalSessionAdminFixtures();
	} catch (error) {
		failure ??= error;
	}
	if (failure !== undefined) throw failure;
});

function refusal(operation: () => unknown, code: string): void {
	let error: unknown;
	try {
		operation();
	} catch (caught) {
		error = caught;
	}
	expect(error).toBeInstanceOf(AuthzError);
	if (!(error instanceof AuthzError)) throw new Error("Expected authorization refusal");
	expect(error.code).toBe(code);
	expect(error.message).toBe(code);
	expect(Object.hasOwn(error, "cause")).toBe(false);
}

function authority(f: NativeFixture, client: TestDevice) {
	return {
		state: f.registry.currentState(),
		facts: f.store.read((db) => f.registry.facts(db, idOf(client))),
		audit: auditActions(f),
	};
}

async function confirmedClient(preset: "cli" | "mobile") {
	const original = await originalSessionAdminFixture();
	originalFixtures.push(original);
	const f = original.native;
	expect(f.store).toBe(original.originalSession.store);
	expect(f.registry).toBe(original.originalSession.devices);
	const windows = await nativePairingWindows(original.originalSession);
	const opened = await windows.open(original.owner.device.peer, { role: "device", pin: PIN });
	const connection = await connectFakeDevice(f);
	original.clients.push(connection.client);
	const exchange = pairingExchange(connection.client, opened.pairingCode);
	let candidate: ReturnType<typeof windows.reveal>;
	try {
		const admitted = windows.claim(connection.device.peer, exchange.claim);
		candidate = windows.reveal(connection.device.peer, exchange.reveal);
		expect(candidate.deviceId).toBe(admitted.deviceId);
		expect(candidate.epoch).toBe(admitted.epoch);
	} finally {
		exchange.claim.fill(0);
		exchange.reveal.fill(0);
	}
	connection.device.id = candidate.deviceId;
	const nonce = toBase64Url(randomBytes(16));
	const now = Date.now();
	const body = {
		v: 1,
		hub: f.identity.hid,
		epoch: f.registry.currentState().epoch,
		device: idOf(original.device),
		nonce,
		iat: now,
		exp: now + 30_000,
		candidate: candidate.deviceId,
		role: "device",
		transportSpkiSha256: connection.device.transportSpkiSha256,
		signingKey: connection.device.signingKey,
		capabilities: CONFIRMATION_PRESETS[preset],
	};
	const statement = Buffer.from(canonicalize(body));
	try {
		const proof = await f.pins.verify(owner(f), PIN, pairConfirmPinScope(nonce));
		try {
			f.store.write((tx) =>
				f.registry.confirmByApprover(
					tx,
					{
						approver: idOf(original.device),
						candidate: candidate.deviceId,
						preset,
						statement,
						signature: signStatement("pair-confirm.v1", body, original.device.privateKey),
					},
					proof,
				),
			);
		} finally {
			f.pins.discard(proof);
		}
	} finally {
		statement.fill(0);
	}
	return { f, client: connection.device };
}

it("returns an original current grant for a real desktop without changing device authority", async () => {
	const f = await createFixture();
	const client = await bootstrap(f);
	const before = authority(f, client);
	expect(before.facts?.confirmedPreset).toBe("desktop");
	f.store.read((db) => {
		const grant = requireNativeOutboxCancelPermission(
			f.store,
			f.registry,
			f.authorizer,
			db,
			client.peer,
		);
		expect(grant.deviceId).toBe(idOf(client));
		expect(grant.userId).toBe(owner(f));
		expect(grant.epoch).toBe(before.state.epoch);
		expect(grant.capabilities).toContain("draft");
		expect(() => f.authorizer.assertCurrentGrant(db, grant)).not.toThrow();
	});
	expect(authority(f, client)).toEqual(before);
});

it("accepts a genuinely server-confirmed CLI with draft but no approve authority", async () => {
	const { f, client } = await confirmedClient("cli");
	const before = authority(f, client);
	expect(before.facts?.confirmedPreset).toBe("cli");
	f.store.read((db) => {
		refusal(() => f.authorizer.requirePeerDevice(db, client.peer, "approve"), "CAPABILITY_MISSING");
		const grant = requireNativeOutboxCancelPermission(
			f.store,
			f.registry,
			f.authorizer,
			db,
			client.peer,
		);
		expect(grant.deviceId).toBe(idOf(client));
		expect(grant.capabilities).toEqual(CONFIRMATION_PRESETS.cli);
		f.authorizer.assertCurrentGrant(db, grant);
	});
	expect(authority(f, client)).toEqual(before);
});

it("refuses a server-confirmed mobile even though its genuine draft grant is current", async () => {
	const { f, client } = await confirmedClient("mobile");
	const before = authority(f, client);
	expect(before.facts?.confirmedPreset).toBe("mobile");
	f.store.read((db) => {
		const draft = f.authorizer.requirePeerDevice(db, client.peer, "draft");
		expect(draft.capabilities).toEqual(CONFIRMATION_PRESETS.mobile);
		f.authorizer.assertCurrentGrant(db, draft);
		refusal(
			() => requireNativeOutboxCancelPermission(f.store, f.registry, f.authorizer, db, client.peer),
			"UNAVAILABLE",
		);
	});
	expect(authority(f, client)).toEqual(before);
});

it("refuses a real admitted but unconfirmed peer without confirming it", async () => {
	const f = await createFixture();
	const pending = await device(f);
	admit(f, pending);
	await bootstrap(f);
	const before = authority(f, pending);
	expect(before.facts?.confirmedPreset).toBeNull();
	expect(before.facts?.confirmedEpoch).toBeNull();
	f.store.read((db) => {
		refusal(
			() =>
				requireNativeOutboxCancelPermission(f.store, f.registry, f.authorizer, db, pending.peer),
			"DEVICE_PENDING",
		);
	});
	expect(authority(f, pending)).toEqual(before);
});

it("refuses an actual TLS peer that has no admitted device record", async () => {
	const f = await createFixture();
	const first = await bootstrap(f);
	const unregistered = await device(f);
	const before = authority(f, first);
	f.store.read((db) => {
		refusal(
			() =>
				requireNativeOutboxCancelPermission(
					f.store,
					f.registry,
					f.authorizer,
					db,
					unregistered.peer,
				),
			"DEVICE_UNKNOWN",
		);
	});
	expect(authority(f, first)).toEqual(before);
});

it("refuses a desktop after genuine PIN-scoped server revocation", async () => {
	const f = await createFixture();
	const client = await bootstrap(f);
	f.store.read((db) => {
		const grant = requireNativeOutboxCancelPermission(
			f.store,
			f.registry,
			f.authorizer,
			db,
			client.peer,
		);
		f.authorizer.assertCurrentGrant(db, grant);
	});
	const proof = await f.pins.verify(owner(f), PIN, revokePinScope(idOf(client)));
	f.store.write((tx) => {
		expect(f.registry.revoke(tx, idOf(client), { kind: "device", id: idOf(client), proof })).toBe(
			true,
		);
	});
	const before = authority(f, client);
	expect(before.facts?.revoked).toBe(true);
	f.store.read((db) => {
		refusal(
			() => requireNativeOutboxCancelPermission(f.store, f.registry, f.authorizer, db, client.peer),
			"DEVICE_REVOKED",
		);
	});
	expect(authority(f, client)).toEqual(before);
});

it("retires the returned grant and reader when their original read ends", async () => {
	const f = await createFixture();
	const client = await bootstrap(f);
	let ended: SqlReader | undefined;
	let grant: DeviceGrant | undefined;
	f.store.read((db) => {
		ended = db;
		grant = requireNativeOutboxCancelPermission(f.store, f.registry, f.authorizer, db, client.peer);
		f.authorizer.assertCurrentGrant(db, grant);
	});
	if (ended === undefined || grant === undefined) throw new Error("Expected original read grant");
	const retiredReader = ended;
	const retiredGrant = grant;
	refusal(
		() =>
			requireNativeOutboxCancelPermission(
				f.store,
				f.registry,
				f.authorizer,
				retiredReader,
				client.peer,
			),
		"UNAVAILABLE",
	);
	f.store.read((db) => {
		refusal(() => f.authorizer.assertCurrentGrant(db, retiredGrant), "UNAVAILABLE");
		const current = requireNativeOutboxCancelPermission(
			f.store,
			f.registry,
			f.authorizer,
			db,
			client.peer,
		);
		f.authorizer.assertCurrentGrant(db, current);
	});
});

it("refuses a real peer as soon as its native listener retires", async () => {
	const f = await createFixture();
	const client = await bootstrap(f);
	const closing = f.tls.close();
	try {
		f.store.read((db) => {
			refusal(
				() =>
					requireNativeOutboxCancelPermission(f.store, f.registry, f.authorizer, db, client.peer),
				"PEER_REFUSED",
			);
		});
	} finally {
		await closing;
	}
});

it.each(["store", "registry", "authorizer", "reader", "peer"] as const)(
	"refuses a foreign genuine fixture's %s without changing either authority",
	async (foreign) => {
		const first = await createFixture();
		const second = await createFixture();
		const firstClient = await bootstrap(first);
		const secondClient = await bootstrap(second);
		const firstBefore = authority(first, firstClient);
		const secondBefore = authority(second, secondClient);
		second.store.read((db) => {
			const grant = requireNativeOutboxCancelPermission(
				second.store,
				second.registry,
				second.authorizer,
				db,
				secondClient.peer,
			);
			second.authorizer.assertCurrentGrant(db, grant);
		});
		first.store.read((db) => {
			if (foreign === "reader") {
				second.store.read((other) => {
					refusal(
						() =>
							requireNativeOutboxCancelPermission(
								first.store,
								first.registry,
								first.authorizer,
								other,
								firstClient.peer,
							),
						"UNAVAILABLE",
					);
				});
				return;
			}
			refusal(
				() =>
					requireNativeOutboxCancelPermission(
						foreign === "store" ? second.store : first.store,
						foreign === "registry" ? second.registry : first.registry,
						foreign === "authorizer" ? second.authorizer : first.authorizer,
						db,
						foreign === "peer" ? secondClient.peer : firstClient.peer,
					),
				foreign === "peer" ? "PEER_REFUSED" : "UNAVAILABLE",
			);
		});
		expect(authority(first, firstClient)).toEqual(firstBefore);
		expect(authority(second, secondClient)).toEqual(secondBefore);
	},
);
