import { randomBytes } from "node:crypto";
import { expect, it } from "vitest";
import type { NativeFixture } from "../../authz/native-fixture.ts";
import { requireLoopbackNetworkGuard } from "../../helpers/loopback-network.ts";
import type { FakeDevice } from "./index.ts";

requireLoopbackNetworkGuard();
const [
	native,
	{ nativePeerSpki },
	{ DevicePairingRefusal },
	{ connectFakeDevice },
	{ FakeDeviceError, openFakeDevice },
] = await Promise.all([
	import("../../authz/native-fixture.ts"),
	import("../../../src/authz/native-peer.ts"),
	import("../../../src/identity/devices-pairing.ts"),
	import("./harness.ts"),
	import("./index.ts"),
]);

async function close(f: NativeFixture, clients: readonly FakeDevice[]): Promise<void> {
	try {
		await Promise.all(clients.map((client) => client.close()));
	} finally {
		await native.closeFixture(f);
	}
}

export function registerTransportCases(): void {
	it("pairs a real TLS client and bootstraps its recorded keys through native authority", async () => {
		const f = await native.fixture();
		const clients: FakeDevice[] = [];
		const secret = randomBytes(16);
		try {
			const { client, device } = await connectFakeDevice(f);
			clients.push(client);
			expect(client.socket.getProtocol()).toBe("TLSv1.3");
			expect(nativePeerSpki(f.registry, device.peer)).toBe(client.transportSpkiSha256);
			const authority = native.sidecar(f, secret);
			try {
				const exchange = client.pairing(secret, "DYTEST reusable device");
				try {
					f.store.write((tx) => authority.claim(tx, device.peer, exchange.claim));
					const record = f.store.write((tx) => authority.reveal(tx, device.peer, exchange.reveal));
					f.store.read((db) => {
						expect(f.registry.facts(db, record.deviceId)).toMatchObject({
							name: "DYTEST reusable device",
							spkiSha256: client.transportSpkiSha256,
							approvalKey: client.signingKey,
							keyClass: null,
							userId: null,
						});
					});
					const grant = await f.registry.bootstrap(record.deviceId, native.PIN);
					f.ownerUserId = grant.userId;
					expect(f.registry.currentState()).toMatchObject({
						bootstrapDone: true,
						ownerUserId: grant.userId,
					});
					f.store.read((db) => {
						const current = f.authorizer.requirePeerDevice(db, device.peer, "approve");
						expect(current.deviceId).toBe(record.deviceId);
						expect(current.approvalKey).toBe(client.signingKey);
					});
					expect(native.auditActions(f)).toEqual([
						"device.claimed",
						"pin.initialized",
						"device.bootstrapped",
					]);
				} finally {
					exchange.claim.fill(0);
					exchange.reveal.fill(0);
				}
			} finally {
				authority.close();
			}
		} finally {
			secret.fill(0);
			await close(f, clients);
		}
	});

	it("refuses a wrong hub SPKI pin on an isolated native listener", async () => {
		const f = await native.fixture();
		let client: FakeDevice | undefined;
		let refusal: unknown;
		try {
			const hid = f.identity.hid === "0".repeat(64) ? "1".repeat(64) : "0".repeat(64);
			try {
				client = await openFakeDevice({ port: f.port, hid });
			} catch (error) {
				refusal = error;
			}
			expect(client === undefined).toBe(true);
			expect(refusal).toBeInstanceOf(FakeDeviceError);
		} finally {
			try {
				await client?.close();
			} finally {
				await native.closeFixture(f);
			}
		}
	});

	it("refuses a same-identity claim from another real TLS connection before recording a candidate", async () => {
		const f = await native.fixture();
		const clients: FakeDevice[] = [];
		const secret = randomBytes(16);
		try {
			const first = await connectFakeDevice(f);
			clients.push(first.client);
			const second = await connectFakeDevice(f, first.client);
			clients.push(second.client);
			expect(second.client.socket).not.toBe(first.client.socket);
			expect(second.device.peer).not.toBe(first.device.peer);
			expect(second.client.certificate).toBe(first.client.certificate);
			expect(second.client.transportSpkiSha256).toBe(first.client.transportSpkiSha256);
			expect(second.client.signingKey).toBe(first.client.signingKey);
			const snapshot = (): unknown =>
				f.store.read((db) => ({
					devices: db.get<{ n: number }>("SELECT COUNT(*) AS n FROM main.devices")?.n,
					candidates: db.get<{ n: number }>(
						"SELECT COUNT(*) AS n FROM main.devices WHERE confirmed_epoch IS NULL",
					)?.n,
					authority: f.registry.state(db),
					transport: f.registry.factsByTransport(db, first.client.transportSpkiSha256),
				}));
			const before = snapshot();
			expect(before).toEqual({
				devices: 0,
				candidates: 0,
				authority: { epoch: 0, bootstrapDone: false, ownerUserId: null },
				transport: undefined,
			});
			const auditBefore = native.auditActions(f);
			const authority = native.sidecar(f, secret);
			try {
				const foreign = first.client.pairing(secret);
				try {
					let result: unknown;
					let refusal: unknown;
					try {
						result = f.store.write((tx) => authority.claim(tx, second.device.peer, foreign.claim));
					} catch (error) {
						refusal = error;
					}
					expect(snapshot()).toEqual(before);
					expect(native.auditActions(f)).toEqual(auditBefore);
					expect(result).toBeUndefined();
					expect(refusal).toBeInstanceOf(DevicePairingRefusal);
					expect(refusal).toMatchObject({ code: "PAIR_PROOF_INVALID" });
				} finally {
					foreign.claim.fill(0);
					foreign.reveal.fill(0);
				}
				const genuine = second.client.pairing(secret);
				try {
					f.store.write((tx) => authority.claim(tx, second.device.peer, genuine.claim));
					const record = f.store.write((tx) =>
						authority.reveal(tx, second.device.peer, genuine.reveal),
					);
					const grant = await f.registry.bootstrap(record.deviceId, native.PIN);
					f.ownerUserId = grant.userId;
					f.store.read((db) => {
						expect(f.registry.facts(db, record.deviceId)).toMatchObject({
							spkiSha256: second.client.transportSpkiSha256,
							approvalKey: second.client.signingKey,
							userId: grant.userId,
						});
						expect(f.authorizer.requirePeerDevice(db, second.device.peer, "approve").deviceId).toBe(
							record.deviceId,
						);
					});
				} finally {
					genuine.claim.fill(0);
					genuine.reveal.fill(0);
				}
			} finally {
				authority.close();
			}
		} finally {
			secret.fill(0);
			await close(f, clients);
		}
	});

	it("reconnects retained keys with a newly issued native transport peer", async () => {
		const f = await native.fixture();
		const clients: FakeDevice[] = [];
		try {
			const first = await connectFakeDevice(f);
			clients.push(first.client);
			await first.client.close();
			const second = await connectFakeDevice(f, first.client);
			clients.push(second.client);
			expect(second.client.socket).not.toBe(first.client.socket);
			expect(second.device.peer).not.toBe(first.device.peer);
			expect(second.client.transportKey).toBe(first.client.transportKey);
			expect(second.client.privateKey).toBe(first.client.privateKey);
			expect(second.client.certificate).toBe(first.client.certificate);
			expect(second.client.transportSpkiSha256).toBe(first.client.transportSpkiSha256);
			expect(second.client.signingKey).toBe(first.client.signingKey);
			expect(nativePeerSpki(f.registry, second.device.peer)).toBe(
				second.client.transportSpkiSha256,
			);
		} finally {
			await close(f, clients);
		}
	});

	it("shares one completed client close and refuses further pairing", async () => {
		const f = await native.fixture();
		const clients: FakeDevice[] = [];
		const secret = randomBytes(16);
		try {
			const { client } = await connectFakeDevice(f);
			clients.push(client);
			const closing = client.close();
			expect(client.close()).toBe(closing);
			expect(() => client.pairing(secret)).toThrow(FakeDeviceError);
			await closing;
			expect(client.socket.closed).toBe(true);
			expect(client.close()).toBe(closing);
			expect(() => client.pairing(secret)).toThrow(FakeDeviceError);
		} finally {
			secret.fill(0);
			await close(f, clients);
		}
	});
}
