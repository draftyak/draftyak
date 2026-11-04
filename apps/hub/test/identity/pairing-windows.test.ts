import { types } from "node:util";
import { canonicalize } from "@draftyak/protocol/jcs";
import { readPairingClaim } from "@draftyak/protocol/pairing";
import { afterAll, describe, expect, it } from "vitest";
import {
	closeOriginalSessionAdminFixtures,
	originalSessionAdminFixture,
	pairingExchange,
} from "./original-session-admin-fixture.ts";

const [
	{ AuthzError },
	{ DevicePairingRefusal },
	{ nativePairingWindows },
	{ connectFakeDevice },
	nativeFixture,
] = await Promise.all([
	import("../../src/authz/errors.ts"),
	import("../../src/identity/devices-pairing.ts"),
	import("../../src/lifecycle/session.ts"),
	import("../support/fake-device/harness.ts"),
	import("../authz/native-fixture.ts"),
]);

type Fixture = Awaited<ReturnType<typeof originalSessionAdminFixture>>;
type Connection = Awaited<ReturnType<typeof connectFakeDevice>>;
type Windows = Awaited<ReturnType<typeof nativePairingWindows>>;
type Answer = ReturnType<Windows["claim"]>;
type Candidate = ReturnType<Windows["reveal"]>;
type OwnerState = ReturnType<Fixture["originalSession"]["devices"]["state"]>;

function fixedCode(error: unknown, prototype: object, code: string): boolean {
	if (
		error === null ||
		typeof error !== "object" ||
		types.isProxy(error) ||
		!types.isNativeError(error)
	)
		return false;
	const field = Object.getOwnPropertyDescriptor(error, "code");
	return (
		Object.getPrototypeOf(error) === prototype &&
		field !== undefined &&
		"value" in field &&
		field.value === code &&
		Object.getOwnPropertyDescriptor(error, "cause") === undefined
	);
}

async function unavailable(operation: () => Promise<unknown>): Promise<boolean> {
	try {
		await operation();
		return false;
	} catch (error) {
		return fixedCode(error, AuthzError.prototype, "UNAVAILABLE");
	}
}

function pairingRefuses(operation: () => unknown, code: string): boolean {
	try {
		operation();
		return false;
	} catch (error) {
		return fixedCode(error, DevicePairingRefusal.prototype, code);
	}
}

function candidateRetained(
	f: Fixture,
	reader: Connection,
	owner: OwnerState,
	answer: Answer,
	candidate: Candidate,
	name: string,
): boolean {
	return f.originalSession.store.read((db) => {
		const facts = f.originalSession.devices.facts(db, candidate.deviceId);
		const current = f.originalSession.devices.state(db);
		return (
			candidate.deviceId === answer.deviceId &&
			candidate.epoch === answer.epoch &&
			candidate.epoch === owner.epoch &&
			facts !== undefined &&
			facts.window === "pairing" &&
			facts.confirmedEpoch === null &&
			facts.epoch === candidate.epoch &&
			facts.spkiSha256 === reader.client.transportSpkiSha256 &&
			facts.approvalKey === reader.client.signingKey &&
			facts.name === name &&
			current.bootstrapDone &&
			current.ownerUserId === owner.ownerUserId &&
			current.epoch === owner.epoch
		);
	});
}

afterAll(async () => {
	await closeOriginalSessionAdminFixtures();
});

describe("native pairing windows", { concurrent: false }, () => {
	it("refuses a bad PIN without replacing the current authenticated pairing window", async () => {
		const f = await originalSessionAdminFixture();
		const owned: Buffer[] = [];
		try {
			const windows = await nativePairingWindows(f.originalSession);
			const owner = f.originalSession.store.read((db) => f.originalSession.devices.state(db));
			const current = await windows.open(f.owner.device.peer, {
				role: "device",
				pin: nativeFixture.PIN,
			});
			const badPin = `${nativeFixture.PIN[0] === "0" ? "1" : "0"}${nativeFixture.PIN.slice(1)}`;
			expect(
				await unavailable(() => windows.open(f.owner.device.peer, { role: "device", pin: badPin })),
			).toBe(true);

			const reader = await connectFakeDevice(f.native);
			f.clients.push(reader.client);
			const exchange = pairingExchange(reader.client, current.pairingCode);
			owned.push(exchange.claim, exchange.reveal);
			const claim = readPairingClaim(exchange.claim);
			const answer = windows.claim(reader.device.peer, exchange.claim);
			const candidate = windows.reveal(reader.device.peer, exchange.reveal);
			expect(candidateRetained(f, reader, owner, answer, candidate, claim.name)).toBe(true);
		} finally {
			try {
				for (const bytes of owned) bytes.fill(0);
			} finally {
				await f.close();
			}
		}
	});

	it("refuses an invalid claim authenticator and rejects replay after a genuine exchange", async () => {
		const f = await originalSessionAdminFixture();
		const owned: Buffer[] = [];
		try {
			const windows = await nativePairingWindows(f.originalSession);
			const owner = f.originalSession.store.read((db) => f.originalSession.devices.state(db));
			const current = await windows.open(f.owner.device.peer, {
				role: "device",
				pin: nativeFixture.PIN,
			});
			const reader = await connectFakeDevice(f.native);
			f.clients.push(reader.client);
			const exchange = pairingExchange(reader.client, current.pairingCode);
			owned.push(exchange.claim, exchange.reveal);
			const claim = readPairingClaim(exchange.claim);
			const proof = `${claim.proof[0] === "0" ? "1" : "0"}${claim.proof.slice(1)}`;
			const invalidClaim = Buffer.from(canonicalize({ ...claim, proof }));
			owned.push(invalidClaim);
			expect(
				pairingRefuses(() => windows.claim(reader.device.peer, invalidClaim), "PAIR_PROOF_INVALID"),
			).toBe(true);

			const answer = windows.claim(reader.device.peer, exchange.claim);
			const candidate = windows.reveal(reader.device.peer, exchange.reveal);
			expect(candidateRetained(f, reader, owner, answer, candidate, claim.name)).toBe(true);
			expect(
				pairingRefuses(
					() => windows.claim(reader.device.peer, exchange.claim),
					"PAIR_WINDOW_CLOSED",
				),
			).toBe(true);
			expect(
				pairingRefuses(
					() => windows.reveal(reader.device.peer, exchange.reveal),
					"PAIR_WINDOW_CLOSED",
				),
			).toBe(true);
			expect(candidateRetained(f, reader, owner, answer, candidate, claim.name)).toBe(true);
		} finally {
			try {
				for (const bytes of owned) bytes.fill(0);
			} finally {
				await f.close();
			}
		}
	});
	it("fences a live authenticated pairing window before original Session shutdown completes", async () => {
		const f = await originalSessionAdminFixture();
		const owned: Buffer[] = [];
		let closeOutcome: Promise<boolean> | undefined;
		try {
			const windows = await nativePairingWindows(f.originalSession);
			const current = await windows.open(f.owner.device.peer, {
				role: "device",
				pin: nativeFixture.PIN,
			});
			const reader = await connectFakeDevice(f.native);
			f.clients.push(reader.client);
			const exchange = pairingExchange(reader.client, current.pairingCode);
			owned.push(exchange.claim, exchange.reveal);

			const closing = f.originalSession.close();
			closeOutcome = closing.then(
				() => true,
				() => false,
			);
			expect(
				!reader.client.socket.destroyed &&
					!reader.client.socket.readableEnded &&
					!reader.client.socket.writableEnded,
			).toBe(true);
			expect(
				pairingRefuses(
					() => windows.claim(reader.device.peer, exchange.claim),
					"PAIR_WINDOW_CLOSED",
				),
			).toBe(true);
			expect(f.originalSession.close() === closing).toBe(true);
			expect(f.originalSession.store.read(() => true)).toBe(true);
			expect(await closeOutcome).toBe(true);
			expect(
				await unavailable(() =>
					windows.open(f.owner.device.peer, { role: "device", pin: nativeFixture.PIN }),
				),
			).toBe(true);
		} finally {
			try {
				for (const bytes of owned) bytes.fill(0);
			} finally {
				try {
					if (closeOutcome) await closeOutcome;
				} finally {
					await f.close();
				}
			}
		}
	});
});
