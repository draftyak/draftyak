import { afterAll, describe, expect, it } from "vitest";
import { PinService } from "../../src/identity/pin.ts";
import type {
	SendApprovalPolicy,
	SendApprovalPolicyResult,
} from "../../src/outbox/verifier-types.ts";
import { requireLoopbackNetworkGuard } from "../helpers/loopback-network.ts";
import type { Fixture } from "../identity/challenges-fixture.ts";
import type { ProposalCandidate } from "../outbox/propose-fixture.ts";

requireLoopbackNetworkGuard();

const CHALLENGE_LIMIT_MS = 120_000;
const cases = (["email", "chat"] as const).flatMap((channel) =>
	([CHALLENGE_LIMIT_MS, CHALLENGE_LIMIT_MS + 1] as const).map((delta) => ({
		channel,
		delta,
		label: `${channel} wall=${delta === CHALLENGE_LIMIT_MS ? "at-limit" : "past-limit"}`,
	})),
);
type Outcome<T> =
	| { readonly accepted: true; readonly value: T }
	| { readonly accepted: false; readonly error: unknown };
interface ConsumeCount {
	entered: number;
	returned: number;
}
interface Basis {
	readonly wall: number;
	readonly mono: number;
	readonly owner: string;
	readonly device: string;
	readonly epoch: number;
	readonly pinVersion: number;
	readonly auditHead: number;
	readonly challenge: string;
}
interface Model {
	phase: "OPEN" | "CONSUMED" | "BURNED";
	terminalAt: number | null;
	pinVerified: number;
	consumeEntered: number;
	consumeReturned: number;
}
const bodies: Promise<unknown>[] = [];
const jobs: Promise<unknown>[] = [];
const fixtures = new Set<Fixture>();
const closing = new Map<Fixture, Promise<void>>();
const consumeCounts = new WeakMap<PinService, ConsumeCount>();
const gates: ReturnType<typeof gate>[] = [];
const descriptor = Object.getOwnPropertyDescriptor(PinService.prototype, "consume");
const originalConsume = PinService.prototype.consume;
if (!descriptor || descriptor.value !== originalConsume)
	throw new Error("DYTEST original PIN consumer unavailable");
const originalDescriptor = descriptor;
function observedConsume(this: PinService, ...args: Parameters<PinService["consume"]>): void {
	const count = consumeCounts.get(this);
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
	return {
		entered: deferred(),
		released: deferred(),
		jobs: [] as Promise<unknown>[],
		calls: 0,
	};
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
		id: "dytest-policy-expiry-race",
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
	const cleanupIncomplete =
		closed.some((result) => result.status === "rejected") || fixtures.size !== 0;
	Object.defineProperty(PinService.prototype, "consume", originalDescriptor);
	const restored = Object.getOwnPropertyDescriptor(PinService.prototype, "consume");
	if (!restored) throw new Error("DYTEST PIN consumer descriptor missing after cleanup");
	expect(
		restored.value === originalDescriptor.value &&
			restored.writable === originalDescriptor.writable &&
			restored.enumerable === originalDescriptor.enumerable &&
			restored.configurable === originalDescriptor.configurable,
	).toBe(true);
	if (cleanupIncomplete) throw new Error("DYTEST original expiry fixture cleanup incomplete");
});

// Preserve the original consumer before the genuine challenge module captures it.
const { fixture, closeFixture, proposal, envelope, issue, native } = await import(
	"../identity/challenges-fixture.ts"
).catch((error: unknown) => {
	Object.defineProperty(PinService.prototype, "consume", originalDescriptor);
	throw error;
});
const { ChallengeError } = await import("../../src/identity/challenges.ts");
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
				throw new Error("DYTEST original expiry baseline unavailable");
			return {
				wall: f.time.wall,
				mono: f.time.mono,
				owner,
				device,
				epoch: authority.epoch,
				pinVersion: pin.version,
				auditHead: head.n,
				challenge: row.id,
			};
		});
	} finally {
		bytes.fill(0);
	}
}
function expectRefusal(actual: Outcome<unknown>): void {
	expect(actual.accepted).toBe(false);
	if (actual.accepted) throw new Error("DYTEST retired approval was accepted");
	expect(actual.error instanceof ChallengeError).toBe(true);
	if (!(actual.error instanceof ChallengeError)) throw new Error("DYTEST expiry refusal missing");
	expect(actual.error.code).toBe("CHALLENGE_INVALID");
	expect(actual.error.detail).toBeNull();
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
				issued_at: number;
				expires_at: number;
				consumed_at: number | null;
				burned_at: number | null;
				has_signature: number;
			}>(
				"SELECT target_id,device_id,user_id,epoch,issued_at,expires_at,consumed_at,burned_at,signature IS NOT NULL AS has_signature FROM main.approval_challenges WHERE id=?",
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
			pinVerified: count("pin.verified"),
			pinFailed: count("pin.failed"),
			pinLocked: count("pin.locked"),
			refused: count("challenge.refused.challenge_invalid"),
			approved: count("outbox.approved"),
		};
	});
	expect(rows.pin).toEqual({ version: basis.pinVersion, failures: 0, locked_until: 0 });
	const challenge = rows.challenge;
	if (!challenge) throw new Error("DYTEST original challenge row missing");
	expect(
		challenge.target_id === target.id &&
			challenge.device_id === basis.device &&
			challenge.user_id === basis.owner &&
			challenge.epoch === basis.epoch,
	).toBe(true);
	expect(challenge.issued_at).toBe(basis.wall);
	expect(challenge.expires_at).toBe(basis.wall + CHALLENGE_LIMIT_MS);
	// Durable retirement is independent from the refusal and from a later replay attempt.
	expect(challenge.burned_at === (model.phase === "BURNED" ? model.terminalAt : null)).toBe(true);
	expect(challenge.consumed_at).toBe(model.phase === "CONSUMED" ? model.terminalAt : null);
	expect(challenge.has_signature).toBe(model.phase === "CONSUMED" ? 1 : 0);
	expect(rows.approvals).toHaveLength(model.phase === "CONSUMED" ? 1 : 0);
	for (const approval of rows.approvals)
		expect(
			approval.challenge_id === basis.challenge &&
				approval.device_id === basis.device &&
				approval.user_id === basis.owner &&
				approval.epoch === basis.epoch &&
				approval.consumed_at === null &&
				approval.voided_at === null,
		).toBe(true);
	expect(rows.state).toBe(model.phase === "CONSUMED" ? "APPROVED" : "PENDING_APPROVAL");
	expect([rows.pinVerified, rows.pinFailed, rows.pinLocked, rows.refused, rows.approved]).toEqual([
		model.pinVerified,
		0,
		0,
		model.phase === "BURNED" ? 1 : 0,
		model.phase === "CONSUMED" ? 1 : 0,
	]);
	expect(consumeCounts.get(f.native.pins)).toEqual({
		entered: model.consumeEntered,
		returned: model.consumeReturned,
	});
}

describe("native send approval policy-expiry race model", () => {
	// Real fixture clocks drive this same-process interleaving; no external rollback anchor is claimed.
	for (const row of cases) {
		it(
			`send approval policy-expiry race ${row.label}`,
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
					consumeCounts.set(f.native.pins, { entered: 0, returned: 0 });
					const target = proposal(f, { channel: row.channel });
					const challenge = issue(f, target.id);
					const signed = envelope(f, challenge);
					const basis = basisFor(f, target, challenge);
					const model: Model = {
						phase: "OPEN",
						terminalAt: null,
						pinVerified: 0,
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
					// Only synchronous clock DATA and checks occur while the genuine 2s policy timer runs.
					expect(held.calls === 1 && held.jobs.length === 1).toBe(true);
					expect(consumeCounts.get(f.native.pins)).toEqual({ entered: 0, returned: 0 });
					f.time.wall = basis.wall + row.delta;
					expect(f.time.mono === basis.mono && f.clock.monotonicMs() === basis.mono).toBe(true);
					held.released.resolve();
					const outcome = await accepting;
					if (row.delta === CHALLENGE_LIMIT_MS) {
						expect(outcome.accepted).toBe(true);
						model.phase = "CONSUMED";
						model.consumeEntered = 1;
						model.consumeReturned = 1;
					} else {
						expectRefusal(outcome);
						model.phase = "BURNED";
					}
					model.pinVerified = 1;
					model.terminalAt = basis.wall + row.delta;
					await Promise.allSettled(held.jobs);
					expect(f.time.mono === basis.mono && f.clock.monotonicMs() === basis.mono).toBe(true);
					expectState(f, target, basis, model);

					// This is only same-process replay of the original signed envelope after clock return.
					f.time.wall = basis.wall;
					expect(f.time.mono).toBe(basis.mono);
					const replay = await observe(
						f.challenges.accept(f.device.peer, challenge.kind, signed),
						owned,
					);
					expectRefusal(replay);
					expect(held.calls).toBe(1);
					expectState(f, target, basis, model);
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
