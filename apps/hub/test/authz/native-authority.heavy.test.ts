import { randomBytes } from "node:crypto";
import type { PairingRefusalCode } from "@draftyak/protocol/pairing";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { NativeDevicePeer } from "../../src/authz/native-peer.ts";
import type { VerifiedCandidate } from "../../src/identity/devices-pairing.ts";
import type { SqlReader, SqlTransaction } from "../../src/store/store.ts";
import { requireLoopbackNetworkGuard } from "../helpers/loopback-network.ts";
import type { NativeFixture, TestDevice } from "./native-fixture.ts";

requireLoopbackNetworkGuard();
const [
	{ canonicalize },
	{ toBase64Url },
	{ signStatement },
	{ auditHeadTag },
	{ assertAuthorizerStore },
	{ AuthzError, deviceApiError },
	{ NativeDeviceTls },
	{ cliConfirmPinScope, pairConfirmPinScope, revokePinScope },
	{ advanceEpochForRestore, confirmForRecovery },
	{ DevicePairingAuthority, DevicePairingRefusal },
	{ MasterKey },
	{
		admit,
		auditActions,
		bootstrap,
		claimBytes,
		claimExchange,
		closeFixture,
		device,
		fixture,
		idOf,
		owner,
		PIN,
		sidecar,
	},
] = await Promise.all([
	import("@draftyak/protocol/jcs"),
	import("@draftyak/protocol/scalars"),
	import("@draftyak/protocol/sign"),
	import("../../src/audit/head.ts"),
	import("../../src/authz/authorizer.ts"),
	import("../../src/authz/errors.ts"),
	import("../../src/authz/native-peer.ts"),
	import("../../src/authz/scopes.ts"),
	import("../../src/identity/devices.ts"),
	import("../../src/identity/devices-pairing.ts"),
	import("../../src/kernel/master-key.ts"),
	import("./native-fixture.ts"),
]);
let f: NativeFixture;
beforeEach(async () => {
	f = await fixture();
});
afterEach(async () => {
	vi.restoreAllMocks();
	if (f) await closeFixture(f);
});
const empty = Object.freeze(Object.create(null));

function pairingRefusal(action: () => unknown, code: PairingRefusalCode): void {
	let failure: unknown;
	try {
		action();
	} catch (error) {
		failure = error;
	}
	expect(failure).toBeInstanceOf(DevicePairingRefusal);
	if (!(failure instanceof DevicePairingRefusal)) throw new Error("Expected pairing refusal");
	expect(failure.code).toBe(code);
	expect(failure.message).toBe(code);
	expect(failure.name).toBe("DevicePairingRefusal");
	expect(Object.hasOwn(failure, "cause")).toBe(false);
	expect(Object.getOwnPropertyDescriptor(failure, "code")).toMatchObject({
		value: code,
		writable: false,
		configurable: false,
	});
	expect(Reflect.set(failure, "code", "PAIR_WINDOW_CLOSED")).toBe(false);
}

it("native TLS plus sidecar proof is pending until a real PIN atomically installs the owner", async () => {
	const client = await device(f),
		id = admit(f, client);
	expect(f.registry.currentState()).toEqual({ epoch: 0, bootstrapDone: false, ownerUserId: null });
	f.store.read((db) => {
		expect(f.registry.facts(db, id)?.keyClass).toBeNull();
		expect(() => f.authorizer.requirePeerDevice(db, client.peer, "approve")).toThrow(
			"DEVICE_PENDING",
		);
		expect(f.authorizer.requirePeerRoute(db, client.peer, "status").confirmed).toBe(false);
	});
	const granted = await f.registry.bootstrap(id, PIN);
	f.ownerUserId = granted.userId;
	expect(granted.capabilities).toEqual(["read", "draft", "organize", "approve", "admin"]);
	expect(f.registry.currentState().bootstrapDone).toBe(true);
	f.store.write((tx) => {
		const principal = f.authorizer.requirePeerKind(tx, client.peer, "approval.send.v1");
		expect(principal.deviceId).toBe(id);
		expect(principal.userId).toBe(owner(f));
	});
	const proof = await f.pins.verify(owner(f), PIN, "authz.test");
	f.store.write((tx) => f.pins.consume(tx, proof, owner(f), "authz.test"));
	expect(auditActions(f)).toEqual([
		"device.claimed",
		"pin.initialized",
		"device.bootstrapped",
		"pin.verified",
	]);
	await expect(f.registry.bootstrap(id, PIN)).rejects.toThrow("BOOTSTRAP_DONE");
});

it("bootstrap rolls owner, PIN, confirmation and audit back together and burns its prepared handle", async () => {
	const client = await device(f),
		id = admit(f, client),
		prepared = await f.registry.prepareBootstrap(id, PIN);
	expect(() =>
		f.store.write((tx) => {
			f.registry.completeBootstrap(tx, prepared, id);
			throw new Error("DYTEST rollback");
		}),
	).toThrow("DYTEST rollback");
	expect(f.registry.currentState()).toEqual({ epoch: 0, bootstrapDone: false, ownerUserId: null });
	f.store.read((db) => {
		expect(db.get<{ count: number }>("SELECT count(*) AS count FROM main.users")?.count).toBe(0);
		expect(
			db.get<{ count: number }>("SELECT count(*) AS count FROM main.approval_pins")?.count,
		).toBe(0);
		expect(f.registry.facts(db, id)?.confirmedEpoch).toBeNull();
		expect(() => f.authorizer.requirePeerDevice(db, client.peer, "read")).toThrow("DEVICE_PENDING");
	});
	expect(auditActions(f)).toEqual(["device.claimed"]);
	f.store.write((tx) => {
		expect(() => f.registry.completeBootstrap(tx, prepared, id)).toThrow("BOOTSTRAP_REFUSED");
	});
	const grant = await f.registry.bootstrap(id, PIN);
	f.ownerUserId = grant.userId;
	expect(auditActions(f)).toEqual(["device.claimed", "pin.initialized", "device.bootstrapped"]);
});

it("rejects structural candidates, peer facts, foreign registry peers and dead connections", async () => {
	const client = await bootstrap(f);
	f.store.write((tx) => {
		expect(() => f.registry.recordCandidate(tx, empty as VerifiedCandidate)).toThrow(AuthzError);
		expect(() => f.registry.recordCandidate(tx, empty as VerifiedCandidate)).toThrow(
			"CANDIDATE_INVALID",
		);
	});
	f.store.read((db) => {
		expect(() =>
			f.authorizer.requirePeerDevice(
				db,
				{ deviceId: idOf(client), confirmed: true } as unknown as NativeDevicePeer,
				"approve",
			),
		).toThrow("PEER_REFUSED");
	});
	const foreign = await fixture();
	try {
		foreign.store.read((db) => {
			expect(() => foreign.authorizer.requirePeerDevice(db, client.peer, "read")).toThrow(
				"PEER_REFUSED",
			);
		});
	} finally {
		await closeFixture(foreign);
	}
	client.socket.destroy();
	await new Promise<void>((resolve) => setImmediate(resolve));
	await f.tls.close();
	f.store.read((db) => {
		expect(() => f.authorizer.requirePeerDevice(db, client.peer, "read")).toThrow("PEER_REFUSED");
	});
});

it("binds proofs to the actual native TLS exporter and certificate, closes after three failures", async () => {
	const first = await device(f),
		second = await device(f),
		secret = randomBytes(16);
	const authority = sidecar(f, secret),
		wrongConnection = claimBytes(first, secret);
	for (let count = 0; count < 3; count++)
		f.store.write((tx) => {
			pairingRefusal(() => authority.claim(tx, second.peer, wrongConnection), "PAIR_PROOF_INVALID");
		});
	f.store.write((tx) => {
		pairingRefusal(() => authority.claim(tx, first.peer, wrongConnection), "PAIR_WINDOW_CLOSED");
	});
	const replacement = sidecar(f, secret);
	f.store.write((tx) => {
		pairingRefusal(() => replacement.claim(tx, first.peer, wrongConnection), "PAIR_WINDOW_CLOSED");
	});
	const differentSecret = randomBytes(16);
	try {
		sidecar(f, differentSecret);
		const spent = sidecar(f, secret);
		f.store.write((tx) => {
			pairingRefusal(() => spent.claim(tx, first.peer, wrongConnection), "PAIR_WINDOW_CLOSED");
		});
	} finally {
		differentSecret.fill(0);
	}
	expect(auditActions(f)).toEqual([]);
	secret.fill(0);
});

it("requires actual store/master-key root binding, replaces old windows and consumes a claim once", async () => {
	const client = await device(f),
		secret = randomBytes(16);
	const wrongKey = new MasterKey(randomBytes(32));
	try {
		expect(() => new DevicePairingAuthority(f.registry, f.store, wrongKey, secret)).toThrow();
		expect(
			() =>
				new DevicePairingAuthority(
					Object.create(Object.getPrototypeOf(f.registry)),
					f.store,
					f.key,
					secret,
				),
		).toThrow(AuthzError);
	} finally {
		wrongKey.destroy();
	}
	const first = sidecar(f, secret),
		replacement = sidecar(f, secret),
		exchange = claimExchange(client, secret),
		bytes = exchange.claim;
	f.store.write((tx) => {
		pairingRefusal(() => first.claim(tx, client.peer, bytes), "PAIR_WINDOW_CLOSED");
	});
	const answer = f.store.write((tx) => replacement.claim(tx, client.peer, bytes));
	expect(f.store.read((db) => f.registry.facts(db, answer.deviceId))).toBeUndefined();
	const id = f.store.write((tx) => replacement.reveal(tx, client.peer, exchange.reveal)).deviceId;
	f.store.write((tx) => {
		pairingRefusal(() => replacement.claim(tx, client.peer, bytes), "PAIR_WINDOW_CLOSED");
	});
	expect(f.store.read((db) => f.registry.facts(db, id)?.storedCapabilities)).toEqual([]);
	expect(() => replacement.claimPairing()).toThrow("KIND_UNAVAILABLE");
	expect(() => replacement.claimPairing()).toThrow(AuthzError);
	bytes.fill(0);
	exchange.reveal.fill(0);
	secret.fill(0);
});

it.each(["closed", "expired"] as const)(
	"strict claim parsing precedes a %s private window",
	async (kind) => {
		const client = await device(f),
			secret = randomBytes(16),
			bytes = claimBytes(client, secret),
			start = performance.now();
		const clock = vi.spyOn(performance, "now").mockReturnValue(start);
		const authority = sidecar(f, secret);
		try {
			if (kind === "closed") authority.close();
			else clock.mockReturnValue(start + 300_000);
			for (const body of [Buffer.from("{"), Buffer.alloc(4097)])
				f.store.write((tx) => {
					pairingRefusal(() => authority.claim(tx, client.peer, body), "PAIR_CLAIM_INVALID");
				});
			f.store.write((tx) => {
				pairingRefusal(() => authority.claim(tx, client.peer, bytes), "PAIR_WINDOW_CLOSED");
			});
			expect(auditActions(f)).toEqual([]);
		} finally {
			clock.mockRestore();
			bytes.fill(0);
			secret.fill(0);
		}
	},
);

it.each(["closed", "expired"] as const)(
	"strict reveal parsing precedes a %s private window",
	async (kind) => {
		const client = await device(f),
			secret = randomBytes(16),
			exchange = claimExchange(client, secret),
			start = performance.now();
		const clock = vi.spyOn(performance, "now").mockReturnValue(start);
		const authority = sidecar(f, secret);
		try {
			const answer = f.store.write((tx) => authority.claim(tx, client.peer, exchange.claim));
			if (kind === "closed") authority.close();
			else clock.mockReturnValue(start + 300_000);
			for (const body of [Buffer.from("{"), Buffer.alloc(1025)])
				f.store.write((tx) => {
					pairingRefusal(() => authority.reveal(tx, client.peer, body), "PAIR_REVEAL_INVALID");
				});
			f.store.write((tx) => {
				pairingRefusal(
					() => authority.reveal(tx, client.peer, exchange.reveal),
					"PAIR_WINDOW_CLOSED",
				);
			});
			expect(f.store.read((db) => f.registry.facts(db, answer.deviceId))).toBeUndefined();
			expect(auditActions(f)).toEqual([]);
		} finally {
			clock.mockRestore();
			exchange.claim.fill(0);
			exchange.reveal.fill(0);
			secret.fill(0);
		}
	},
);

it("malformed, wrong-window and same-certificate foreign-peer reveals preserve the pending exchange", async () => {
	const client = await device(f),
		other = await device(f, client),
		secret = randomBytes(16),
		exchange = claimExchange(client, secret),
		authority = sidecar(f, secret);
	try {
		expect(other.transportSpkiSha256).toBe(client.transportSpkiSha256);
		expect(other.peer).not.toBe(client.peer);
		const answer = f.store.write((tx) => authority.claim(tx, client.peer, exchange.claim));
		f.store.write((tx) => {
			pairingRefusal(
				() => authority.reveal(tx, client.peer, Buffer.from("{")),
				"PAIR_REVEAL_INVALID",
			);
			const wrong = JSON.parse(Buffer.from(exchange.reveal).toString("utf8"));
			const pid = Buffer.from(wrong.pid, "base64url");
			pid[0] = (pid[0] ?? 0) ^ 1;
			wrong.pid = pid.toString("base64url");
			pairingRefusal(
				() => authority.reveal(tx, client.peer, Buffer.from(JSON.stringify(wrong))),
				"PAIR_WINDOW_CLOSED",
			);
			pairingRefusal(() => authority.reveal(tx, other.peer, exchange.reveal), "PAIR_WINDOW_CLOSED");
			pairingRefusal(() => authority.claim(tx, client.peer, exchange.claim), "PAIR_WINDOW_CLOSED");
		});
		const recorded = f.store.write((tx) => authority.reveal(tx, client.peer, exchange.reveal));
		expect(recorded.deviceId).toBe(answer.deviceId);
		expect(f.store.read((db) => f.registry.facts(db, answer.deviceId)?.storedCapabilities)).toEqual(
			[],
		);
		expect(auditActions(f)).toEqual(["device.claimed"]);
	} finally {
		exchange.claim.fill(0);
		exchange.reveal.fill(0);
		secret.fill(0);
	}
});

it("a parsed commitment mismatch consumes the pending exchange before any candidate is persisted", async () => {
	const client = await device(f),
		secret = randomBytes(16),
		exchange = claimExchange(client, secret),
		authority = sidecar(f, secret);
	try {
		const answer = f.store.write((tx) => authority.claim(tx, client.peer, exchange.claim));
		const wrong = JSON.parse(Buffer.from(exchange.reveal).toString("utf8"));
		const nonce = Buffer.from(wrong.nd, "base64url");
		nonce[0] = (nonce[0] ?? 0) ^ 1;
		wrong.nd = nonce.toString("base64url");
		f.store.write((tx) => {
			pairingRefusal(
				() => authority.reveal(tx, client.peer, Buffer.from(JSON.stringify(wrong))),
				"PAIR_COMMITMENT_MISMATCH",
			);
			pairingRefusal(
				() => authority.reveal(tx, client.peer, exchange.reveal),
				"PAIR_WINDOW_CLOSED",
			);
		});
		expect(f.store.read((db) => f.registry.facts(db, answer.deviceId))).toBeUndefined();
		expect(auditActions(f)).toEqual([]);
	} finally {
		exchange.claim.fill(0);
		exchange.reveal.fill(0);
		secret.fill(0);
	}
});

it("private native-peer failures return only the fixed closed-window refusal", async () => {
	const client = await device(f),
		secret = randomBytes(16),
		bytes = claimBytes(client, secret),
		authority = sidecar(f, secret);
	try {
		f.store.write((tx) => {
			pairingRefusal(
				() => authority.claim(tx, empty as NativeDevicePeer, bytes),
				"PAIR_WINDOW_CLOSED",
			);
		});
		expect(auditActions(f)).toEqual([]);
	} finally {
		bytes.fill(0);
		secret.fill(0);
	}
});

it("private registry and persistence exceptions have no cause or detail in pairing refusals", async () => {
	const client = await device(f),
		secret = randomBytes(16),
		exchange = claimExchange(client, secret),
		authority = sidecar(f, secret);
	const prototype = Object.getPrototypeOf(f.registry) as NativeFixture["registry"];
	try {
		const state = vi.spyOn(prototype, "state").mockImplementation(() => {
			throw new Error("DYTEST private registry detail");
		});
		f.store.write((tx) => {
			pairingRefusal(() => authority.claim(tx, client.peer, exchange.claim), "PAIR_WINDOW_CLOSED");
		});
		state.mockRestore();
		const answer = f.store.write((tx) => authority.claim(tx, client.peer, exchange.claim));
		const record = vi.spyOn(prototype, "recordCandidate").mockImplementation(() => {
			throw new Error("DYTEST private persistence detail");
		});
		f.store.write((tx) => {
			pairingRefusal(
				() => authority.reveal(tx, client.peer, exchange.reveal),
				"PAIR_WINDOW_CLOSED",
			);
		});
		record.mockRestore();
		f.store.write((tx) => {
			pairingRefusal(
				() => authority.reveal(tx, client.peer, exchange.reveal),
				"PAIR_WINDOW_CLOSED",
			);
		});
		expect(f.store.read((db) => f.registry.facts(db, answer.deviceId))).toBeUndefined();
		expect(auditActions(f)).toEqual([]);
	} finally {
		vi.restoreAllMocks();
		exchange.claim.fill(0);
		exchange.reveal.fill(0);
		secret.fill(0);
	}
});

it("an actual restore epoch change closes a former pairing window with a fixed refusal", async () => {
	const client = await bootstrap(f),
		secret = randomBytes(16),
		bytes = claimBytes(client, secret),
		authority = sidecar(f, secret);
	try {
		f.store.write((tx) => advanceEpochForRestore(f.registry, tx));
		f.store.write((tx) => {
			pairingRefusal(() => authority.claim(tx, client.peer, bytes), "PAIR_WINDOW_CLOSED");
		});
		expect(f.registry.currentState().epoch).toBe(1);
	} finally {
		bytes.fill(0);
		secret.fill(0);
	}
});

it("schema-invalid current-window claims spend the budget while malformed and unknown-window claims do not", async () => {
	const client = await device(f),
		controlSecret = randomBytes(16),
		secret = randomBytes(16),
		controlBytes = claimBytes(client, controlSecret),
		bytes = claimBytes(client, secret);
	try {
		const control = sidecar(f, controlSecret);
		const unknown = JSON.parse(Buffer.from(controlBytes).toString("utf8"));
		const pid = Buffer.from(unknown.pid, "base64url");
		pid[0] = (pid[0] ?? 0) ^ 1;
		unknown.pid = pid.toString("base64url");
		unknown.unexpected = true;
		for (let count = 0; count < 3; count++)
			f.store.write((tx) => {
				pairingRefusal(
					() => control.claim(tx, client.peer, Buffer.from("{")),
					"PAIR_CLAIM_INVALID",
				);
				pairingRefusal(
					() => control.claim(tx, client.peer, Buffer.from(JSON.stringify(unknown))),
					"PAIR_CLAIM_INVALID",
				);
			});
		expect(f.store.write((tx) => control.claim(tx, client.peer, controlBytes)).epoch).toBe(0);
		control.close();
		const authority = sidecar(f, secret),
			invalid = { ...JSON.parse(Buffer.from(bytes).toString("utf8")), unexpected: true };
		for (let count = 0; count < 3; count++)
			f.store.write((tx) => {
				pairingRefusal(
					() => authority.claim(tx, client.peer, Buffer.from(JSON.stringify(invalid))),
					"PAIR_CLAIM_INVALID",
				);
			});
		f.store.write((tx) => {
			pairingRefusal(() => authority.claim(tx, client.peer, bytes), "PAIR_WINDOW_CLOSED");
		});
		const replacement = sidecar(f, secret);
		f.store.write((tx) => {
			pairingRefusal(() => replacement.claim(tx, client.peer, bytes), "PAIR_WINDOW_CLOSED");
		});
		expect(auditActions(f)).toEqual([]);
	} finally {
		controlBytes.fill(0);
		bytes.fill(0);
		controlSecret.fill(0);
		secret.fill(0);
	}
});

it("a private thrown proxy never runs its prototype hook and consumes the accepted pending reveal", async () => {
	const client = await device(f),
		secret = randomBytes(16),
		exchange = claimExchange(client, secret),
		authority = sidecar(f, secret);
	let prototypeReads = 0;
	const privateFailure = new Proxy(new Error("DYTEST private proxy detail"), {
		getPrototypeOf() {
			prototypeReads++;
			throw new Error("DYTEST private prototype detail");
		},
	});
	const prototype = Object.getPrototypeOf(f.registry) as NativeFixture["registry"];
	const record = Object.getOwnPropertyDescriptor(prototype, "recordCandidate");
	if (!record || !Object.hasOwn(record, "value")) throw new Error("Missing persistence method");
	try {
		const answer = f.store.write((tx) => authority.claim(tx, client.peer, exchange.claim));
		Object.defineProperty(prototype, "recordCandidate", {
			...record,
			value() {
				throw privateFailure;
			},
		});
		let failure: unknown;
		try {
			f.store.write((tx) => authority.reveal(tx, client.peer, exchange.reveal));
		} catch (error) {
			failure = error;
		}
		Object.defineProperty(prototype, "recordCandidate", record);
		expect(prototypeReads).toBe(0);
		pairingRefusal(() => {
			throw failure;
		}, "PAIR_WINDOW_CLOSED");
		f.store.write((tx) => {
			pairingRefusal(
				() => authority.reveal(tx, client.peer, exchange.reveal),
				"PAIR_WINDOW_CLOSED",
			);
		});
		expect(f.store.read((db) => f.registry.facts(db, answer.deviceId))).toBeUndefined();
		expect(auditActions(f)).toEqual([]);
	} finally {
		Object.defineProperty(prototype, "recordCandidate", record);
		vi.restoreAllMocks();
		exchange.claim.fill(0);
		exchange.reveal.fill(0);
		secret.fill(0);
	}
});

it("ordinary pairing and never-bootstrapped sidecar candidates cannot become approvers through CLI", async () => {
	const first = await device(f),
		second = await device(f);
	admit(f, first);
	admit(f, second);
	await f.registry.bootstrap(idOf(first), PIN);
	f.ownerUserId = f.registry.currentState().ownerUserId ?? undefined;
	const proof = await f.pins.verify(owner(f), PIN, cliConfirmPinScope(idOf(second)));
	f.store.write((tx) => {
		expect(() => f.registry.confirmFromCli(tx, idOf(second), proof)).toThrow("CANDIDATE_INVALID");
	});
	f.pins.discard(proof);
	expect(f.store.read((db) => f.registry.facts(db, idOf(second))?.confirmedEpoch)).toBeNull();
});

it("grants are bound to the exact live store reader, revision and connected native peer", async () => {
	const client = await bootstrap(f);
	let retired: ReturnType<typeof f.authorizer.requirePeerDevice> | undefined;
	f.store.write((tx) => {
		const grant = f.authorizer.requirePeerDevice(tx, client.peer, "draft");
		retired = grant;
		f.authorizer.assertCurrentGrant(tx, grant);
		expect(() => f.authorizer.assertCurrentGrant(tx, { ...grant })).toThrow("UNAVAILABLE");
		tx.run("UPDATE main.devices SET name=? WHERE id=?", ["DYTEST renamed", idOf(client)]);
		expect(() => f.authorizer.assertCurrentGrant(tx, grant)).toThrow("UNAVAILABLE");
	});
	f.store.read((db) => {
		expect(() =>
			f.authorizer.assertCurrentGrant(db, retired as NonNullable<typeof retired>),
		).toThrow("UNAVAILABLE");
	});
	assertAuthorizerStore(f.authorizer, f.store);
	expect(() =>
		assertAuthorizerStore(Object.create(Object.getPrototypeOf(f.authorizer)), f.store),
	).toThrow("UNAVAILABLE");
	let ended: SqlReader | undefined;
	f.store.read((db) => {
		ended = db;
	});
	expect(() => f.authorizer.requirePeerDevice(ended as SqlReader, client.peer, "read")).toThrow(
		"UNAVAILABLE",
	);
});

it("CLI cannot revoke the last approver; PIN-scoped native revocation is terminal and immediate", async () => {
	const client = await bootstrap(f),
		id = idOf(client);
	f.store.write((tx) => {
		expect(() => f.registry.revoke(tx, id, { kind: "cli" })).toThrow("LAST_APPROVER");
	});
	const wrongScope = await f.pins.verify(owner(f), PIN, "authz.other");
	f.store.write((tx) => {
		expect(() => f.registry.revoke(tx, id, { kind: "device", id, proof: wrongScope })).toThrow(
			"PIN_REQUIRED",
		);
	});
	const proof = await f.pins.verify(owner(f), PIN, revokePinScope(id));
	f.store.write((tx) => {
		expect(f.registry.revoke(tx, id, { kind: "device", id, proof })).toBe(true);
	});
	f.store.read((db) => {
		expect(() => f.authorizer.requirePeerDevice(db, client.peer, "approve")).toThrow(
			"DEVICE_REVOKED",
		);
	});
	f.store.write((tx) => {
		expect(f.registry.revoke(tx, id, { kind: "cli" })).toBe(false);
		expect(() => tx.run("UPDATE main.devices SET revoked_at=NULL WHERE id=?", [id])).toThrow();
	});
	expect(auditActions(f).filter((x) => x === "device.revoked")).toHaveLength(1);
});

async function restored(first: TestDevice): Promise<TestDevice> {
	// M2.12 stand-in only for its restore orchestration: state primitive is genuine and no
	// confirmed row is seeded. Every device still obtains its first authority via native bootstrap.
	f.store.write((tx) => {
		tx.run("DELETE FROM main.approval_pins WHERE user_id=?", [owner(f)]);
		advanceEpochForRestore(f.registry, tx);
	});
	f.store.read((db) => {
		expect(() => f.authorizer.requirePeerDevice(db, first.peer, "read")).toThrow("DEVICE_PENDING");
	});
	await expect(f.registry.bootstrap(idOf(first), PIN)).rejects.toThrow("BOOTSTRAP_REFUSED");
	return bootstrap(f);
}
function confirmation(
	first: TestDevice,
	approver: TestDevice,
	nonce: string,
): {
	approver: string;
	candidate: string;
	preset: "desktop";
	statement: Uint8Array;
	signature: string;
} {
	const at = Date.now();
	const body = {
		v: 1,
		hub: f.identity.hid,
		epoch: f.registry.currentState().epoch,
		device: idOf(approver),
		nonce,
		iat: at,
		exp: at + 30_000,
		candidate: idOf(first),
		role: "device",
		transportSpkiSha256: first.transportSpkiSha256,
		signingKey: first.signingKey,
		capabilities: ["read", "draft", "organize", "approve", "admin"],
	};
	const statement = Buffer.from(canonicalize(body));
	return {
		approver: idOf(approver),
		candidate: idOf(first),
		preset: "desktop",
		statement,
		signature: signStatement("pair-confirm.v1", body, approver.privateKey),
	};
}
// A forged audit head fails every PIN write until the real head is restored.
async function unrecordedAnswers(scope: string): Promise<string[]> {
	const head = f.store.read((db) =>
		db.get<{ audit_seq: number; audit_head: string; audit_tag: string }>(
			"SELECT audit_seq,audit_head,audit_tag FROM main.audit_meta",
		),
	);
	if (!head) throw new Error("Missing test chain head");
	const key = randomBytes(32),
		forged = auditHeadTag(key, head.audit_seq, head.audit_head);
	key.fill(0);
	f.store.write((tx) => tx.run("UPDATE main.audit_meta SET audit_tag=?", [forged]));
	const answers: string[] = [];
	try {
		for (const pin of [PIN, "999999"])
			answers.push(
				await f.pins.verify(owner(f), pin, scope).then((proof) => {
					f.pins.discard(proof);
					return "PROOF";
				}, deviceApiError),
			);
	} finally {
		f.store.write((tx) => tx.run("UPDATE main.audit_meta SET audit_tag=?", [head.audit_tag]));
	}
	return answers;
}

it("restore voids old rights and real signed confirmation plus scoped PIN rechecks the pending record", async () => {
	const first = await bootstrap(f),
		second = await restored(first);
	const nonce = toBase64Url(randomBytes(16)),
		input = confirmation(first, second, nonce);
	const recorded = auditActions(f).length;
	expect(await unrecordedAnswers(pairConfirmPinScope(nonce))).toEqual([
		"UNAVAILABLE",
		"UNAVAILABLE",
	]);
	f.store.read((db) => {
		expect(() => f.authorizer.requirePeerDevice(db, first.peer, "read")).toThrow("DEVICE_PENDING");
	});
	const proof = await f.pins.verify(owner(f), PIN, pairConfirmPinScope(nonce));
	expect(auditActions(f).slice(recorded)).toEqual(["pin.failed", "pin.verified"]);
	f.store.write((tx) => {
		expect(() =>
			f.registry.confirmByApprover(tx, { ...input, candidate: idOf(second) }, proof),
		).toThrow("CANDIDATE_INVALID");
	});
	f.store.write((tx) => {
		expect(() =>
			f.registry.confirmByApprover(
				tx,
				{ ...input, signature: `${input.signature.slice(0, 85)}!` },
				proof,
			),
		).toThrow("SIGNATURE_INVALID");
	});
	const grant = f.store.write((tx) => f.registry.confirmByApprover(tx, input, proof));
	expect(grant.epoch).toBe(1);
	f.store.read((db) => {
		expect(f.authorizer.requirePeerDevice(db, first.peer, "approve").deviceId).toBe(idOf(first));
	});
	f.store.write((tx) => {
		expect(() => f.registry.confirmByApprover(tx, input, proof)).toThrow("CANDIDATE_NOT_PENDING");
	});
});

it("CLI re-confirmation stays read/draft and its preset ceiling cannot be promoted by SQL or reapply", async () => {
	const first = await bootstrap(f);
	await restored(first);
	const proof = await f.pins.verify(owner(f), PIN, cliConfirmPinScope(idOf(first)));
	expect(
		f.store.write((tx) => f.registry.confirmFromCli(tx, idOf(first), proof)).capabilities,
	).toEqual(["read", "draft"]);
	f.store.write((tx) => {
		expect(() => f.authorizer.requirePeerDevice(tx, first.peer, "approve")).toThrow(
			"CAPABILITY_MISSING",
		);
		expect(() =>
			tx.run("UPDATE main.devices SET capabilities=31 WHERE id=?", [idOf(first)]),
		).toThrow();
		expect(() =>
			tx.run("UPDATE main.devices SET confirmed_preset='desktop' WHERE id=?", [idOf(first)]),
		).toThrow();
		expect(() =>
			tx.run(
				"UPDATE main.devices SET confirmed_epoch=NULL,capabilities=0,confirmed_preset=NULL,confirmed_via=NULL,confirmed_at=NULL WHERE id=?",
				[idOf(first)],
			),
		).toThrow();
		expect(() => f.registry.confirmFromCli(tx, idOf(first), proof)).toThrow(
			"CANDIDATE_NOT_PENDING",
		);
	});
});

it("recovery primitive cannot add a second approver or reopen bootstrap", async () => {
	const first = await bootstrap(f),
		second = await restored(first);
	f.store.write((tx) => {
		expect(() => confirmForRecovery(f.registry, tx, idOf(first))).toThrow("APPROVER_EXISTS");
	});
	const proof = await f.pins.verify(owner(f), PIN, revokePinScope(idOf(second)));
	f.store.write((tx) =>
		f.registry.revoke(tx, idOf(second), { kind: "device", id: idOf(second), proof }),
	);
	f.store.write((tx) => {
		expect(confirmForRecovery(f.registry, tx, idOf(first)).capabilities).toContain("approve");
	});
	expect(f.registry.currentState()).toEqual({
		epoch: 1,
		bootstrapDone: true,
		ownerUserId: owner(f),
	});
});

it("schema and live transaction guards retain bootstrap once and reject foreign or retired writers", async () => {
	const client = await bootstrap(f);
	f.store.write((tx) => {
		for (const sql of [
			"UPDATE main.device_authority SET bootstrap_done=0",
			"UPDATE main.device_authority SET epoch=epoch+2",
			"DELETE FROM main.devices",
		])
			expect(() => tx.run(sql)).toThrow();
	});
	let ended: SqlTransaction | undefined;
	f.store.write((tx) => {
		ended = tx;
	});
	expect(() => f.registry.revoke(ended as SqlTransaction, idOf(client), { kind: "cli" })).toThrow(
		"UNAVAILABLE",
	);
	expect(
		() =>
			new NativeDeviceTls(f.registry, Object.create(Object.getPrototypeOf(f.identity)), () => {}),
	).toThrow();
});
