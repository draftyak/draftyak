import { afterAll, describe, expect, it } from "vitest";
import { PinError, PinService } from "../../src/identity/pin.ts";
import type {
	SendApprovalPolicy,
	SendApprovalPolicyResult,
} from "../../src/outbox/verifier-types.ts";
import { requireLoopbackNetworkGuard } from "../helpers/loopback-network.ts";
import type { Fixture } from "../identity/challenges-fixture.ts";
import type { ProposalCandidate } from "../outbox/propose-fixture.ts";

requireLoopbackNetworkGuard();

type Channel = "email" | "chat";
type Outcome<T> =
	| { readonly accepted: true; readonly value: T }
	| { readonly accepted: false; readonly error: unknown };
interface ConsumeCount {
	entered: number;
	returned: number;
}
interface Model {
	failures: number;
	verified: number;
	failed: number;
	locked: number;
	refused: number;
	approved: boolean;
	challenge: "OPEN" | "CONSUMED" | "BURNED";
	consumeEntered: number;
	consumeReturned: number;
}
interface Basis {
	readonly owner: string;
	readonly device: string;
	readonly epoch: number;
	readonly wall: number;
	readonly pinVersion: number;
	readonly auditHead: number;
	readonly challenge: string;
}
const channels: readonly Channel[] = ["email", "chat"];
const cases = channels.flatMap((channel) =>
	([4, 5] as const).map((failures) => ({
		channel,
		failures,
		label: `${channel} failures=${failures}`,
	})),
);
const bodies: Promise<unknown>[] = [];
const jobs: Promise<unknown>[] = [];
const fixtures = new Set<Fixture>();
const closing = new Map<Fixture, Promise<void>>();
const counts = new WeakMap<PinService, ConsumeCount>();
const gates: ReturnType<typeof gate>[] = [];
const descriptor = Object.getOwnPropertyDescriptor(PinService.prototype, "consume");
const originalConsume = PinService.prototype.consume;
if (!descriptor || descriptor.value !== originalConsume)
	throw new Error("DYTEST original PIN consumer unavailable");
const originalDescriptor = descriptor;
function observedConsume(this: PinService, ...args: Parameters<PinService["consume"]>): void {
	const count = counts.get(this);
	if (count) count.entered++;
	Reflect.apply(originalConsume, this, args);
	if (count) count.returned++;
}
Object.defineProperty(PinService.prototype, "consume", {
	...originalDescriptor,
	value: observedConsume,
});

function deferred() {
	let resolve!: () => void;
	const promise = new Promise<void>((done) => {
		resolve = done;
	});
	return { promise, resolve };
}
function gate() {
	return { entered: deferred(), released: deferred(), jobs: [] as Promise<unknown>[], calls: 0 };
}
function track<T>(promise: Promise<T>): Promise<T> {
	jobs.push(promise);
	void promise.catch(() => undefined);
	return promise;
}
function observe<T>(promise: Promise<T>, owned: Promise<unknown>[]): Promise<Outcome<T>> {
	track(promise);
	owned.push(promise);
	const observed = track(
		promise.then(
			(value) => ({ accepted: true as const, value }),
			(error: unknown) => ({ accepted: false as const, error }),
		),
	);
	owned.push(observed);
	return observed;
}
function retainBody(body: () => Promise<void>): () => Promise<void> {
	return () => {
		const original = Promise.resolve().then(body);
		bodies.push(original);
		return original;
	};
}
function policyFor(held: ReturnType<typeof gate>): SendApprovalPolicy {
	return {
		id: "dytest-pin-lock-race",
		evaluate() {
			held.calls++;
			const original = (async (): Promise<SendApprovalPolicyResult> => {
				held.entered.resolve();
				await held.released.promise;
				return { kind: "require", approvals: 1 };
			})();
			held.jobs.push(original);
			return track(original);
		},
	};
}
async function closeKnown(f: Fixture): Promise<void> {
	let original = closing.get(f);
	if (!original) {
		original = closeFixture(f);
		closing.set(f, original);
		void original.then(
			() => fixtures.delete(f),
			() => undefined,
		);
	}
	await original;
}
afterAll(async () => {
	for (const held of gates) held.released.resolve();
	await Promise.allSettled(bodies);
	await Promise.allSettled(jobs);
	await Promise.allSettled(gates.flatMap((held) => held.jobs));
	const closed = await Promise.allSettled([...fixtures].map(closeKnown));
	if (closed.some((result) => result.status === "rejected") || fixtures.size !== 0)
		throw new Error("DYTEST original PIN-lock fixture cleanup incomplete");
	Object.defineProperty(PinService.prototype, "consume", originalDescriptor);
	const restored = Object.getOwnPropertyDescriptor(PinService.prototype, "consume");
	if (!restored) throw new Error("DYTEST PIN consumer descriptor missing after cleanup");
	expect(
		restored.value === originalDescriptor.value &&
			restored.writable === originalDescriptor.writable &&
			restored.enumerable === originalDescriptor.enumerable &&
			restored.configurable === originalDescriptor.configurable,
	).toBe(true);
});

// Install the observer before the original challenge module captures its PIN consumer.
const { fixture, closeFixture, proposal, envelope, issue, native } = await import(
	"../identity/challenges-fixture.ts"
).catch((error: unknown) => {
	Object.defineProperty(PinService.prototype, "consume", originalDescriptor);
	throw error;
});
const { ChallengeError, sendApprovalPinScope } = await import("../../src/identity/challenges.ts");
const { parseStatement } = await import("@draftyak/protocol/statements");

type Issued = ReturnType<typeof issue>;
function basisFor(f: Fixture, target: ProposalCandidate, challenge: Issued): Basis {
	const bytes = Buffer.from(challenge.statement, "base64url");
	const owner = native.owner(f.native);
	const device = native.idOf(f.device);
	try {
		return f.native.store.read((db) => {
			f.native.audit.verify(db);
			const authority = db.get<{ epoch: number }>(
				"SELECT epoch FROM main.device_authority WHERE singleton=1",
			);
			const pin = db.get<{ version: number; failures: number; locked_until: number }>(
				"SELECT version,failures,locked_until FROM main.approval_pins WHERE user_id=?",
				[owner],
			);
			const head = db.get<{ n: number }>("SELECT coalesce(max(seq),0) AS n FROM main.audit_events");
			const row = db.get<{ id: string }>(
				"SELECT id FROM main.approval_challenges WHERE target_id=? AND statement=?",
				[target.id, bytes],
			);
			if (!authority || !pin || !head || !row || pin.failures !== 0 || pin.locked_until !== 0)
				throw new Error("DYTEST original challenge baseline unavailable");
			return {
				owner,
				device,
				epoch: authority.epoch,
				wall: f.time.wall,
				pinVersion: pin.version,
				auditHead: head.n,
				challenge: row.id,
			};
		});
	} finally {
		bytes.fill(0);
	}
}
function actualScope(challenge: Issued): string {
	const bytes = Buffer.from(challenge.statement, "base64url");
	try {
		const statement = parseStatement("approval.send.v1", bytes);
		if (!statement) throw new Error("DYTEST original signed statement unavailable");
		return sendApprovalPinScope(statement.nonce);
	} finally {
		bytes.fill(0);
	}
}
function expectState(f: Fixture, target: ProposalCandidate, basis: Basis, model: Model): void {
	const rows = f.native.store.read((db) => {
		f.native.audit.verify(db);
		const count = (action: string) =>
			db.get<{ n: number }>(
				"SELECT count(*) AS n FROM main.audit_events WHERE seq>? AND action=?",
				[basis.auditHead, action],
			)?.n;
		return {
			pin: db.get<{ version: number; failures: number; locked_until: number }>(
				"SELECT version,failures,locked_until FROM main.approval_pins WHERE user_id=?",
				[basis.owner],
			),
			challenge: db.get<{
				target_id: string;
				device_id: string;
				user_id: string;
				epoch: number;
				consumed_at: number | null;
				burned_at: number | null;
				has_signature: number;
			}>(
				"SELECT target_id,device_id,user_id,epoch,consumed_at,burned_at,signature IS NOT NULL AS has_signature FROM main.approval_challenges WHERE id=?",
				[basis.challenge],
			),
			approvals: db.all<{
				challenge_id: string;
				device_id: string;
				user_id: string;
				epoch: number;
				consumed_at: number | null;
				voided_at: number | null;
			}>(
				"SELECT challenge_id,device_id,user_id,epoch,consumed_at,voided_at FROM main.approvals WHERE outbox_id=?",
				[target.id],
			),
			state: db.get<{ state: string }>("SELECT state FROM main.outbox WHERE id=?", [target.id])
				?.state,
			lockEvents: db.all<{
				at: number;
				refs: string;
				actor_kind: string;
				actor_id: string | null;
			}>(
				"SELECT at,refs,actor_kind,actor_id FROM main.audit_events WHERE seq>? AND action='pin.locked'",
				[basis.auditHead],
			),
			verified: count("pin.verified"),
			failed: count("pin.failed"),
			locked: count("pin.locked"),
			refused: count("challenge.refused.pin_refused"),
			approved: count("outbox.approved"),
		};
	});
	expect(rows.pin !== undefined).toBe(true);
	const pin = rows.pin;
	if (!pin) throw new Error("DYTEST original PIN row missing");
	expect(pin.version).toBe(basis.pinVersion);
	expect(pin.failures).toBe(model.failures);
	expect(rows.lockEvents).toHaveLength(model.locked);
	if (model.locked === 0) expect(pin.locked_until).toBe(0);
	else {
		const event = rows.lockEvents[0];
		if (!event) throw new Error("DYTEST authenticated PIN lock event missing");
		const refs: unknown = JSON.parse(event.refs);
		expect(
			refs !== null &&
				typeof refs === "object" &&
				!Array.isArray(refs) &&
				Object.keys(refs).length === 1 &&
				"user" in refs &&
				refs.user === basis.owner,
		).toBe(true);
		expect(event.actor_kind === "hub" && event.actor_id === null).toBe(true);
		expect(
			Number.isSafeInteger(event.at) && event.at > 0 && Number.isSafeInteger(event.at + 900_000),
		).toBe(true);
		// The genuine PIN service has its own wall clock; its authenticated audit fixes the deadline.
		expect(pin.locked_until).toBe(event.at + 900_000);
	}
	expect(rows.challenge !== undefined).toBe(true);
	const challenge = rows.challenge;
	if (!challenge) throw new Error("DYTEST original challenge row missing");
	expect(
		challenge.target_id === target.id &&
			challenge.device_id === basis.device &&
			challenge.user_id === basis.owner &&
			challenge.epoch === basis.epoch,
	).toBe(true);
	expect(challenge.consumed_at).toBe(model.challenge === "CONSUMED" ? basis.wall : null);
	expect(challenge.burned_at).toBe(model.challenge === "BURNED" ? basis.wall : null);
	expect(challenge.has_signature).toBe(model.challenge === "CONSUMED" ? 1 : 0);
	expect(rows.approvals).toHaveLength(model.approved ? 1 : 0);
	for (const approval of rows.approvals)
		expect(
			approval.challenge_id === basis.challenge &&
				approval.device_id === basis.device &&
				approval.user_id === basis.owner &&
				approval.epoch === basis.epoch &&
				approval.consumed_at === null &&
				approval.voided_at === null,
		).toBe(true);
	expect(rows.state).toBe(model.approved ? "APPROVED" : "PENDING_APPROVAL");
	expect([rows.verified, rows.failed, rows.locked, rows.refused, rows.approved]).toEqual([
		model.verified,
		model.failed,
		model.locked,
		model.refused,
		model.approved ? 1 : 0,
	]);
	expect(counts.get(f.native.pins)).toEqual({
		entered: model.consumeEntered,
		returned: model.consumeReturned,
	});
}
async function wrongAttempts(
	f: Fixture,
	owner: string,
	scope: string,
	failures: 4 | 5,
	owned: Promise<unknown>[],
): Promise<void> {
	const wrongPin = `${native.PIN[0] === "0" ? "1" : "0"}${native.PIN.slice(1)}`;
	const attempts = Array.from({ length: 4 }, () =>
		observe(f.native.pins.verify(owner, wrongPin, scope), owned),
	);
	// The genuine service permits four KDFs in flight. A settled original frees the fifth slot.
	if (failures === 5) {
		await Promise.race(attempts);
		attempts.push(observe(f.native.pins.verify(owner, wrongPin, scope), owned));
	}
	const results = await Promise.all(attempts);
	for (const result of results) if (result.accepted) f.native.pins.discard(result.value);
	expect(results.every((result) => !result.accepted && result.error instanceof PinError)).toBe(
		true,
	);
	const errors = results.flatMap((result) => (result.accepted ? [] : [result.error]));
	expect(
		errors.filter((error) => error instanceof PinError && error.code === "PIN_INVALID"),
	).toHaveLength(4);
	expect(
		errors.filter((error) => error instanceof PinError && error.code === "PIN_LOCKED"),
	).toHaveLength(failures === 5 ? 1 : 0);
}

describe("native send approval pin-lock race model", () => {
	it("covers both channels on each side of the persisted lock boundary", () => {
		expect(cases).toHaveLength(4);
		expect(new Set(cases.map((row) => row.label)).size).toBe(4);
		for (const channel of ["email", "chat"])
			expect(cases.filter((row) => row.channel === channel).map((row) => row.failures)).toEqual([
				4, 5,
			]);
	});

	// These four traces use genuine signatures, peers, PIN proofs and transactions.
	// The held policy returns DATA only. No deadline, clock, authority or PIN guard is replaced.
	for (const row of cases) {
		it(
			`send approval pin-lock race ${row.label}`,
			retainBody(async () => {
				const held = gate();
				const owned: Promise<unknown>[] = [];
				gates.push(held);
				let f: Fixture | undefined;
				try {
					const creating = track(fixture(policyFor(held)));
					owned.push(creating);
					f = await creating;
					fixtures.add(f);
					counts.set(f.native.pins, { entered: 0, returned: 0 });
					const target = proposal(f, { channel: row.channel });
					const challenge = issue(f, target.id);
					const signed = envelope(f, challenge);
					const basis = basisFor(f, target, challenge);
					const model: Model = {
						failures: 0,
						verified: 0,
						failed: 0,
						locked: 0,
						refused: 0,
						approved: false,
						challenge: "OPEN",
						consumeEntered: 0,
						consumeReturned: 0,
					};
					expectState(f, target, basis, model);
					const accepting = observe(
						f.challenges.accept(f.device.peer, challenge.kind, signed),
						owned,
					);
					await Promise.race([
						held.entered.promise,
						accepting.then(() => {
							throw new Error("DYTEST accept settled before actual policy entry");
						}),
					]);
					expect(held.calls === 1 && held.jobs.length === 1).toBe(true);
					model.verified = 1;
					expectState(f, target, basis, model);
					await wrongAttempts(f, basis.owner, actualScope(challenge), row.failures, owned);
					model.failures = row.failures;
					model.failed = 4;
					model.locked = row.failures === 5 ? 1 : 0;
					expectState(f, target, basis, model);
					held.released.resolve();
					const outcome = await accepting;
					if (row.failures === 5) {
						// First lock-dependent assertion: the actual native accept must refuse.
						expect(outcome.accepted).toBe(false);
						if (outcome.accepted) throw new Error("DYTEST locked PIN accepted a send approval");
						expect(outcome.error instanceof ChallengeError).toBe(true);
						if (!(outcome.error instanceof ChallengeError))
							throw new Error("DYTEST native PIN refusal missing");
						expect(outcome.error.code).toBe("PIN_REFUSED");
						expect(outcome.error.detail).toBe("PIN_CHANGED");
						model.challenge = "BURNED";
						model.refused = 1;
					} else {
						expect(outcome.accepted).toBe(true);
						model.approved = true;
						model.challenge = "CONSUMED";
						model.consumeReturned = 1;
					}
					model.consumeEntered = 1;
					expectState(f, target, basis, model);
					await Promise.allSettled(held.jobs);
				} finally {
					held.released.resolve();
					await Promise.allSettled(owned);
					await Promise.allSettled(held.jobs);
					if (f) await closeKnown(f);
				}
			}),
		);
	}
});
