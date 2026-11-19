import { expect, it, vi } from "vitest";
import type { BootstrapPreparation } from "../../src/identity/devices.ts";
import type { SqlTransaction } from "../../src/store/store.ts";
import { requireLoopbackNetworkGuard } from "../helpers/loopback-network.ts";
import type { NativeFixture } from "./native-fixture.ts";

requireLoopbackNetworkGuard();

// PIN replacement and bootstrap use their original native producers and one-shot handles.
const [
	{ advanceEpochForRestore },
	{ installPinForRestore },
	{ admit, auditActions, bootstrap, closeFixture, device, fixture, idOf, owner, PIN },
] = await Promise.all([
	import("../../src/identity/devices.ts"),
	import("../../src/identity/pin.ts"),
	import("./native-fixture.ts"),
]);

const NEW_PIN = "482617";
const NEXT_PIN = "619428";
const WRONG_PIN = "000000";
const PROOF_SCOPE = "restore.test";

interface PinState {
	readonly version: number;
	readonly failures: number;
	readonly locked_until: number;
}

function pinState(f: NativeFixture): PinState {
	const row = f.store.read((db) =>
		db.get<PinState>(
			"SELECT version,failures,locked_until FROM main.approval_pins WHERE user_id=?",
			[owner(f)],
		),
	);
	if (!row) throw new Error("DYTEST PIN row missing");
	return row;
}

function countAction(f: NativeFixture, action: string): number {
	return auditActions(f).filter((value) => value === action).length;
}

function durableState(f: NativeFixture, candidate: string) {
	const authority = f.registry.currentState();
	return f.store.read((db) => {
		f.audit.verify(db);
		const facts = f.registry.facts(db, candidate);
		return {
			epoch: authority.epoch,
			bootstrapDone: authority.bootstrapDone,
			owner: authority.ownerUserId,
			confirmedEpoch: facts?.confirmedEpoch,
			confirmedPreset: facts?.confirmedPreset,
			users: db.get<{ n: number }>("SELECT count(*) AS n FROM main.users")?.n,
			pins: db.get<{ n: number }>("SELECT count(*) AS n FROM main.approval_pins")?.n,
			head: db.get<{ audit_seq: number; audit_head: string; audit_tag: string }>(
				"SELECT audit_seq,audit_head,audit_tag FROM main.audit_meta WHERE singleton=1",
			),
		};
	});
}

function expectDurableUnchanged(
	f: NativeFixture,
	candidate: string,
	before: ReturnType<typeof durableState>,
): void {
	expect(JSON.stringify(durableState(f, candidate)) === JSON.stringify(before)).toBe(true);
}

async function withFixture(run: (f: NativeFixture) => Promise<void>): Promise<void> {
	const f = await fixture();
	try {
		await run(f);
	} finally {
		vi.restoreAllMocks();
		await closeFixture(f);
	}
}

async function verifyAndDiscard(f: NativeFixture, pin: string): Promise<void> {
	const proof = await f.pins.verify(owner(f), pin, PROOF_SCOPE);
	f.pins.discard(proof);
}

async function replacePin(f: NativeFixture, pin: string): Promise<void> {
	const user = owner(f);
	const prepared = await f.pins.prepareInitialization(user, pin);
	try {
		f.store.write((tx) => installPinForRestore(f.pins, tx, prepared, user));
	} finally {
		f.pins.discard(prepared);
	}
}

async function restoredCandidate(f: NativeFixture) {
	const original = await bootstrap(f);
	const user = owner(f);
	const epoch = f.registry.currentState().epoch;
	const prepared = await f.pins.prepareInitialization(user, NEW_PIN);
	try {
		f.store.write((tx) => {
			installPinForRestore(f.pins, tx, prepared, user);
			advanceEpochForRestore(f.registry, tx);
		});
	} finally {
		f.pins.discard(prepared);
	}
	const current = f.registry.currentState();
	expect(
		current.epoch === epoch + 1 && !current.bootstrapDone && current.ownerUserId === user,
	).toBe(true);
	const candidate = await device(f);
	const id = admit(f, candidate);
	return { original, candidate, id, user, epoch: current.epoch };
}

function complete(f: NativeFixture, prepared: BootstrapPreparation, candidate: string) {
	return f.store.write((tx) => f.registry.completeBootstrap(tx, prepared, candidate));
}

it("replaces an original PIN once, resets its lock and invalidates old material without changing ordinary install", async () => {
	await withFixture(async (f) => {
		await bootstrap(f);
		const user = owner(f);
		const before = pinState(f);
		const oldProof = await f.pins.verify(user, PIN, PROOF_SCOPE);
		for (let index = 0; index < 5; index++) {
			await expect(f.pins.verify(user, WRONG_PIN, PROOF_SCOPE)).rejects.toThrow(
				index === 4 ? "PIN_LOCKED" : "PIN_INVALID",
			);
		}
		expect(pinState(f).failures === 5 && pinState(f).locked_until > 0).toBe(true);
		await replacePin(f, NEW_PIN);
		expect(pinState(f)).toEqual({ version: before.version + 1, failures: 0, locked_until: 0 });
		expect(countAction(f, "pin.restored")).toBe(1);
		expect(() => f.store.write((tx) => f.pins.consume(tx, oldProof, user, PROOF_SCOPE))).toThrow(
			"PIN_CHANGED",
		);
		await expect(f.pins.verify(user, PIN, PROOF_SCOPE)).rejects.toThrow("PIN_INVALID");
		await verifyAndDiscard(f, NEW_PIN);
		const unchanged = pinState(f);
		const actions = auditActions(f);
		await expect(f.pins.initialize(user, NEXT_PIN)).rejects.toThrow("PIN_CHANGED");
		expect(pinState(f)).toEqual(unchanged);
		expect(auditActions(f)).toEqual(actions);
	});
});

it("rolls PIN replacement and its audit back after a real late failure and consumes the preparation", async () => {
	await withFixture(async (f) => {
		const client = await bootstrap(f);
		const user = owner(f);
		const before = durableState(f, idOf(client));
		const pin = pinState(f);
		const oldProof = await f.pins.verify(user, PIN, PROOF_SCOPE);
		const prepared = await f.pins.prepareInitialization(user, NEW_PIN);
		const afterVerification = durableState(f, idOf(client));
		let firstReturned = false;
		try {
			expect(() =>
				f.store.write((tx) => {
					installPinForRestore(f.pins, tx, prepared, user);
					firstReturned = true;
					installPinForRestore(f.pins, tx, prepared, user);
				}),
			).toThrow("PIN_REQUIRED");
			expect(firstReturned).toBe(true);
			expect(pinState(f)).toEqual(pin);
			expectDurableUnchanged(f, idOf(client), afterVerification);
			expect(afterVerification.epoch === before.epoch).toBe(true);
			expect(() => f.store.write((tx) => installPinForRestore(f.pins, tx, prepared, user))).toThrow(
				"PIN_REQUIRED",
			);
			f.store.write((tx) => f.pins.consume(tx, oldProof, user, PROOF_SCOPE));
			await verifyAndDiscard(f, PIN);
			await replacePin(f, NEW_PIN);
			await verifyAndDiscard(f, NEW_PIN);
		} finally {
			f.pins.discard(prepared);
			f.pins.discard(oldProof);
		}
	});
});

it("binds a restore preparation to its original user and rejects replay after successful replacement", async () => {
	await withFixture(async (f) => {
		await bootstrap(f);
		const other = await fixture();
		try {
			await bootstrap(other);
			const user = owner(f);
			const foreignUser = owner(other);
			expect(user !== foreignUser).toBe(true);
			const before = pinState(f);
			const actions = auditActions(f);
			const wrongUser = await f.pins.prepareInitialization(foreignUser, NEW_PIN);
			try {
				expect(() =>
					f.store.write((tx) => installPinForRestore(f.pins, tx, wrongUser, user)),
				).toThrow("PIN_REQUIRED");
				expect(pinState(f)).toEqual(before);
				expect(auditActions(f)).toEqual(actions);
			} finally {
				f.pins.discard(wrongUser);
			}
			const prepared = await f.pins.prepareInitialization(user, NEW_PIN);
			try {
				f.store.write((tx) => installPinForRestore(f.pins, tx, prepared, user));
				const committed = pinState(f);
				const committedActions = auditActions(f);
				expect(() =>
					f.store.write((tx) => installPinForRestore(f.pins, tx, prepared, user)),
				).toThrow("PIN_REQUIRED");
				expect(pinState(f)).toEqual(committed);
				expect(auditActions(f)).toEqual(committedActions);
				await verifyAndDiscard(f, NEW_PIN);
			} finally {
				f.pins.discard(prepared);
			}
		} finally {
			await closeFixture(other);
		}
	});
});

it("preserves a real preparation across foreign and retired transaction refusals", async () => {
	await withFixture(async (f) => {
		await bootstrap(f);
		const other = await fixture();
		const prepared = await f.pins.prepareInitialization(owner(f), NEW_PIN);
		try {
			let retired: SqlTransaction | undefined;
			f.store.write((tx) => {
				retired = tx;
			});
			const retiredScope = retired;
			if (!retiredScope) throw new Error("DYTEST retired transaction missing");
			expect(() => installPinForRestore(f.pins, retiredScope, prepared, owner(f))).toThrow(
				"Database transaction unavailable",
			);
			other.store.write((tx) => {
				expect(() => installPinForRestore(f.pins, tx, prepared, owner(f))).toThrow(
					"Database transaction unavailable",
				);
			});
			f.store.write((tx) => installPinForRestore(f.pins, tx, prepared, owner(f)));
			await verifyAndDiscard(f, NEW_PIN);
		} finally {
			f.pins.discard(prepared);
			await closeFixture(other);
		}
	});
});

it("preserves genuine initial bootstrap rollback, one-shot completion and first PIN initialization", async () => {
	await withFixture(async (f) => {
		const client = await device(f);
		const id = admit(f, client);
		const before = durableState(f, id);
		const prepared = await f.registry.prepareBootstrap(id, PIN);
		let firstReturned = false;
		expect(() =>
			f.store.write((tx) => {
				f.registry.completeBootstrap(tx, prepared, id);
				firstReturned = true;
				f.registry.completeBootstrap(tx, prepared, id);
			}),
		).toThrow("BOOTSTRAP_REFUSED");
		expect(firstReturned).toBe(true);
		expectDurableUnchanged(f, id, before);
		expect(() => complete(f, prepared, id)).toThrow("BOOTSTRAP_REFUSED");
		const fresh = await f.registry.prepareBootstrap(id, PIN);
		const granted = complete(f, fresh, id);
		f.ownerUserId = granted.userId;
		expect(pinState(f)).toEqual({ version: 1, failures: 0, locked_until: 0 });
		expect(countAction(f, "pin.initialized")).toBe(1);
		expect(countAction(f, "pin.restored")).toBe(0);
		expect(countAction(f, "device.bootstrapped")).toBe(1);
		await verifyAndDiscard(f, PIN);
		await expect(f.registry.bootstrap(id, PIN)).rejects.toThrow("BOOTSTRAP_DONE");
	});
});

it("bootstraps an existing restored owner once through its installed PIN without inserting another PIN", async () => {
	await withFixture(async (f) => {
		const state = await restoredCandidate(f);
		const pin = pinState(f);
		const prepared = await f.registry.prepareBootstrap(state.id, NEW_PIN);
		const granted = complete(f, prepared, state.id);
		expect(granted.userId === state.user && granted.epoch === state.epoch).toBe(true);
		expect(pinState(f)).toEqual(pin);
		expect(countAction(f, "pin.initialized")).toBe(1);
		expect(countAction(f, "pin.restored")).toBe(1);
		expect(countAction(f, "device.bootstrapped")).toBe(2);
		const durable = durableState(f, state.id);
		expect(durable.bootstrapDone && durable.users === 1 && durable.pins === 1).toBe(true);
		f.store.read((db) => {
			const facts = f.registry.facts(db, state.id);
			expect(facts?.approvalKey === state.candidate.signingKey).toBe(true);
			expect(facts?.spkiSha256 === state.candidate.transportSpkiSha256).toBe(true);
			expect(
				f.authorizer.requirePeerKind(db, state.candidate.peer, "approval.send.v1").deviceId ===
					state.id,
			).toBe(true);
			expect(() =>
				f.authorizer.requirePeerKind(db, state.original.peer, "approval.send.v1"),
			).toThrow("DEVICE_PENDING");
		});
		expect(() => complete(f, prepared, state.id)).toThrow("BOOTSTRAP_REFUSED");
		expectDurableUnchanged(f, state.id, durable);
	});
});

it("refuses a wrong restored PIN and substitution of a second genuine candidate with different keys", async () => {
	await withFixture(async (f) => {
		const state = await restoredCandidate(f);
		await expect(f.registry.prepareBootstrap(state.id, WRONG_PIN)).rejects.toThrow("PIN_INVALID");
		expect(pinState(f).failures).toBe(1);
		expect(!f.registry.currentState().bootstrapDone).toBe(true);
		const other = await device(f);
		const otherId = admit(f, other);
		expect(other.signingKey !== state.candidate.signingKey).toBe(true);
		expect(other.transportSpkiSha256 !== state.candidate.transportSpkiSha256).toBe(true);
		const prepared = await f.registry.prepareBootstrap(state.id, NEW_PIN);
		const before = durableState(f, state.id);
		expect(() => complete(f, prepared, otherId)).toThrow("BOOTSTRAP_REFUSED");
		expectDurableUnchanged(f, state.id, before);
		expect(() => complete(f, prepared, state.id)).toThrow("BOOTSTRAP_REFUSED");
		const fresh = await f.registry.prepareBootstrap(state.id, NEW_PIN);
		complete(f, fresh, state.id);
		expect(f.registry.currentState().bootstrapDone).toBe(true);
	});
});

it("refuses an original restored bootstrap preparation after a genuine epoch transition", async () => {
	await withFixture(async (f) => {
		const state = await restoredCandidate(f);
		const prepared = await f.registry.prepareBootstrap(state.id, NEW_PIN);
		f.store.write((tx) => advanceEpochForRestore(f.registry, tx));
		const before = durableState(f, state.id);
		expect(() => complete(f, prepared, state.id)).toThrow("BOOTSTRAP_REFUSED");
		expectDurableUnchanged(f, state.id, before);
		const next = await device(f);
		const nextId = admit(f, next);
		const fresh = await f.registry.prepareBootstrap(nextId, NEW_PIN);
		const granted = complete(f, fresh, nextId);
		expect(granted.epoch === state.epoch + 1 && granted.userId === state.user).toBe(true);
	});
});

it("refuses a prepared restored bootstrap after the original PIN owner advances its version", async () => {
	await withFixture(async (f) => {
		const state = await restoredCandidate(f);
		const prepared = await f.registry.prepareBootstrap(state.id, NEW_PIN);
		await replacePin(f, NEXT_PIN);
		const before = durableState(f, state.id);
		const pin = pinState(f);
		expect(() => complete(f, prepared, state.id)).toThrow("PIN_CHANGED");
		expectDurableUnchanged(f, state.id, before);
		expect(pinState(f)).toEqual(pin);
		const fresh = await f.registry.prepareBootstrap(state.id, NEXT_PIN);
		complete(f, fresh, state.id);
		expect(f.registry.currentState().bootstrapDone).toBe(true);
	});
});

it("refuses an expired original restored PIN proof before confirming or finishing bootstrap", async () => {
	await withFixture(async (f) => {
		const state = await restoredCandidate(f);
		const prepared = await f.registry.prepareBootstrap(state.id, NEW_PIN);
		const before = durableState(f, state.id);
		const advanced = Date.now() + 30_001;
		const clock = vi.spyOn(Date, "now").mockReturnValue(advanced);
		try {
			expect(() => complete(f, prepared, state.id)).toThrow("PIN_REQUIRED");
			expectDurableUnchanged(f, state.id, before);
		} finally {
			clock.mockRestore();
		}
		const fresh = await f.registry.prepareBootstrap(state.id, NEW_PIN);
		complete(f, fresh, state.id);
		expect(f.registry.currentState().bootstrapDone).toBe(true);
	});
});

it("rolls a restored bootstrap late failure back and requires a fresh original proof for recovery", async () => {
	await withFixture(async (f) => {
		const state = await restoredCandidate(f);
		const prepared = await f.registry.prepareBootstrap(state.id, NEW_PIN);
		const before = durableState(f, state.id);
		const pin = pinState(f);
		let firstReturned = false;
		expect(() =>
			f.store.write((tx) => {
				f.registry.completeBootstrap(tx, prepared, state.id);
				firstReturned = true;
				f.registry.completeBootstrap(tx, prepared, state.id);
			}),
		).toThrow("BOOTSTRAP_REFUSED");
		expect(firstReturned).toBe(true);
		expectDurableUnchanged(f, state.id, before);
		expect(pinState(f)).toEqual(pin);
		expect(() => complete(f, prepared, state.id)).toThrow("BOOTSTRAP_REFUSED");
		const fresh = await f.registry.prepareBootstrap(state.id, NEW_PIN);
		complete(f, fresh, state.id);
		expect(f.registry.currentState().bootstrapDone).toBe(true);
	});
});

// These are identity/PIN producer tests. They do not qualify backup import, restored send
// reconciliation, delay/alert recovery, arbitrary device-key replacement or native operations.
