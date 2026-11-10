import type { Challenge, SignedEnvelope } from "@draftyak/protocol/device-api";
import { afterAll, describe, expect, it } from "vitest";
import type { PinProof, PinService as Pins } from "../../src/identity/pin.ts";
import type { SendApprovalPolicy } from "../../src/outbox/verifier-types.ts";
import { requireLoopbackNetworkGuard } from "../helpers/loopback-network.ts";
import type { Fixture } from "../identity/challenges-fixture.ts";
import type { ProposalCandidate } from "../outbox/propose-fixture.ts";

requireLoopbackNetworkGuard();
const { PinService } = await import("../../src/identity/pin.ts");
const consumeDescriptor = Object.getOwnPropertyDescriptor(PinService.prototype, "consume");
const originalConsume = PinService.prototype.consume;
if (!consumeDescriptor || consumeDescriptor.value !== originalConsume)
	throw new Error("DYTEST original PIN consumption method is unavailable");
interface Consumption {
	attempted: number;
	completed: number;
}
const consumption = new WeakMap<Pins, Consumption>();
function observedConsume(this: Pins, ...args: Parameters<Pins["consume"]>): void {
	const count = consumption.get(this) ?? { attempted: 0, completed: 0 };
	consumption.set(this, count);
	count.attempted++;
	originalConsume.call(this, ...args);
	count.completed++;
}
// Both owners capture this delegate during their normal imports. It only observes calls to
// the original method; genuine proofs, receivers, arguments, results and failures are unchanged.
Object.defineProperty(PinService.prototype, "consume", {
	...consumeDescriptor,
	value: observedConsume,
});
const { fixture, closeFixture, proposal, envelope, issue, native } = await import(
	"../identity/challenges-fixture.ts"
);
const { ChallengeError } = await import("../../src/identity/challenges.ts");
const { CAPABILITY_BITS } = await import("../../src/authz/decide.ts");
const { revokePinScope } = await import("../../src/authz/scopes.ts");

type Channel = "email" | "chat";
type Command = "duplicate" | "revoke";
type ChallengeState = "OPEN" | "CONSUMED" | "BURNED";
const cases = (["email", "chat"] as const).flatMap((channel) =>
	(
		[
			["duplicate", "revoke"],
			["revoke", "duplicate"],
		] as const
	).map((commands) => ({
		channel,
		commands,
		label: `${channel} ${commands.join("-then-")}`,
	})),
);
function deferred() {
	let resolve!: () => void;
	const promise = new Promise<void>((done) => {
		resolve = done;
	});
	return { promise, resolve };
}
interface Gate {
	readonly entered: ReturnType<typeof deferred>;
	readonly released: ReturnType<typeof deferred>;
	started: number;
	finished: number;
}
const gates: Gate[] = [];
const bodies: Promise<void>[] = [];
const jobs: Promise<unknown>[] = [];
const fixtures = new Set<Fixture>();
const closing = new Map<Fixture, Promise<void>>();
function gate(): Gate {
	const value = { entered: deferred(), released: deferred(), started: 0, finished: 0 };
	gates.push(value);
	return value;
}
function retainBody(body: () => Promise<void>): Promise<void> {
	const original = Promise.resolve().then(body);
	bodies.push(original);
	void original.catch(() => {});
	return original;
}
function closeKnown(f: Fixture): Promise<void> {
	const prior = closing.get(f);
	if (prior) return prior;
	const original = Promise.resolve().then(() => closeFixture(f));
	closing.set(f, original);
	void original.then(
		() => fixtures.delete(f),
		() => {},
	);
	return original;
}
afterAll(async () => {
	// A test timeout does not settle its callback or the policy it is awaiting.
	for (const value of gates) value.released.resolve();
	await Promise.allSettled(bodies);
	await Promise.allSettled(jobs);
	const closed = await Promise.allSettled([...fixtures].map(closeKnown));
	if (Object.getOwnPropertyDescriptor(PinService.prototype, "consume")?.value !== observedConsume)
		throw new Error("DYTEST PIN consumption observer changed");
	Object.defineProperty(PinService.prototype, "consume", consumeDescriptor);
	if (closed.some((result) => result.status === "rejected"))
		throw new Error("DYTEST original fixture cleanup remains unresolved");
});

function policy(values: readonly Gate[]): SendApprovalPolicy {
	let next = 0;
	return {
		id: "DYTEST zero-approver race DATA",
		evaluate() {
			const value = values[next++];
			if (!value) throw new Error("DYTEST unexpected policy evaluation");
			const original = Promise.resolve().then(async () => {
				value.started++;
				value.entered.resolve();
				try {
					await value.released.promise;
					return { kind: "require" as const, approvals: 1 };
				} finally {
					value.finished++;
				}
			});
			jobs.push(original);
			void original.catch(() => {});
			return original;
		},
	};
}
type Attempt = { readonly accepted: true } | { readonly accepted: false; readonly error: unknown };
function accept(f: Fixture, challenge: Challenge, signed: SignedEnvelope) {
	let settled = false;
	const original = f.challenges.accept(f.device.peer, challenge.kind, signed);
	jobs.push(original);
	const observed: Promise<Attempt> = original.then(
		() => {
			settled = true;
			return { accepted: true as const };
		},
		(error: unknown) => {
			settled = true;
			return { accepted: false as const, error };
		},
	);
	return { observed, settled: () => settled };
}
function refusal(actual: Attempt, code: string, detail: string | null): void {
	expect(actual.accepted).toBe(false);
	if (actual.accepted) throw new Error("DYTEST stale acceptance succeeded");
	expect(actual.error instanceof ChallengeError).toBe(true);
	if (!(actual.error instanceof ChallengeError)) throw new Error("DYTEST unexpected refusal");
	expect(actual.error.code).toBe(code);
	expect(actual.error.detail).toBe(detail);
}
interface Target {
	readonly candidate: ProposalCandidate;
	readonly challenge: Challenge;
	readonly signed: SignedEnvelope;
	readonly challengeId: string;
	state: ChallengeState;
}
function target(f: Fixture, channel: Channel): Target {
	const candidate = proposal(f, { channel });
	const challenge = issue(f, candidate.id);
	const row = f.native.store.read((db) =>
		db.get<{ id: string }>("SELECT id FROM main.approval_challenges WHERE statement=?", [
			Buffer.from(challenge.statement, "base64url"),
		]),
	);
	if (!row) throw new Error("DYTEST original challenge identity is missing");
	return {
		candidate,
		challenge,
		signed: envelope(f, challenge),
		challengeId: row.id,
		state: "OPEN",
	};
}
const auditActions = [
	"pin.verified",
	"pin.failed",
	"pin.locked",
	"device.revoked",
	"challenge.refused.device_refused",
] as const;
type AuditAction = (typeof auditActions)[number];
function auditCounts(f: Fixture): Record<AuditAction, number> {
	return f.native.store.read(
		(db) =>
			Object.fromEntries(
				auditActions.map((action) => [
					action,
					db.get<{ n: number }>("SELECT COUNT(*) AS n FROM main.audit_events WHERE action=?", [
						action,
					])?.n ?? -1,
				]),
			) as Record<AuditAction, number>,
	);
}
function consumeCounts(pins: Pins): Consumption {
	const count = consumption.get(pins);
	return { attempted: count?.attempted ?? 0, completed: count?.completed ?? 0 };
}
interface Model {
	readonly epoch: number;
	readonly audits: Record<AuditAction, number>;
	readonly consumes: Consumption;
	readonly pinVersion: number;
	verified: number;
	consumed: number;
	revoked: boolean;
	refused: boolean;
}
function expectState(f: Fixture, targets: readonly Target[], model: Model): void {
	const owner = native.owner(f.native),
		device = native.idOf(f.device);
	const observed = f.native.store.read((db) => ({
		pin: db.get<{ version: number; failures: number; locked_until: number }>(
			"SELECT version,failures,locked_until FROM main.approval_pins WHERE user_id=?",
			[owner],
		),
		authority: db.get<{ epoch: number; bootstrap_done: number; owner_user_id: string }>(
			"SELECT epoch,bootstrap_done,owner_user_id FROM main.device_authority WHERE singleton=1",
		),
		revoked: db.get<{ value: number }>(
			"SELECT revoked_at IS NOT NULL AS value FROM main.devices WHERE id=?",
			[device],
		)?.value,
		approvers: db.get<{ n: number }>(
			"SELECT COUNT(*) AS n FROM main.devices WHERE revoked_at IS NULL AND confirmed_epoch=? AND (capabilities & ?)<>0",
			[model.epoch, CAPABILITY_BITS.approve],
		)?.n,
		challenges: db.get<{ n: number }>("SELECT COUNT(*) AS n FROM main.approval_challenges")?.n,
		approvals: db.get<{ n: number }>("SELECT COUNT(*) AS n FROM main.approvals")?.n,
	}));
	expect(observed).toEqual({
		pin: { version: model.pinVersion, failures: 0, locked_until: 0 },
		authority: { epoch: model.epoch, bootstrap_done: 1, owner_user_id: owner },
		revoked: model.revoked ? 1 : 0,
		approvers: model.revoked ? 0 : 1,
		challenges: targets.length,
		approvals: targets.filter((value) => value.state === "CONSUMED").length,
	});
	const audits = auditCounts(f);
	for (const action of auditActions) {
		const added =
			action === "pin.verified"
				? model.verified
				: action === "device.revoked"
					? Number(model.revoked)
					: action === "challenge.refused.device_refused"
						? Number(model.refused)
						: 0;
		expect(audits[action] - model.audits[action]).toBe(added);
	}
	expect(consumeCounts(f.native.pins)).toEqual({
		attempted: model.consumes.attempted + model.consumed,
		completed: model.consumes.completed + model.consumed,
	});
	for (const value of targets) {
		const accepted = value.state === "CONSUMED";
		const rows = f.native.store.read((db) => ({
			outbox: db.get<{ state: string }>("SELECT state FROM main.outbox WHERE id=?", [
				value.candidate.id,
			]),
			challenge: db.get(
				"SELECT target_id,device_id,user_id,epoch,target_version,consumed_at,burned_at,signature IS NOT NULL AS has_signature FROM main.approval_challenges WHERE id=?",
				[value.challengeId],
			),
			approvals: db.all(
				"SELECT outbox_id,challenge_id,device_id,user_id,epoch,target_version,consumed_at,voided_at FROM main.approvals WHERE outbox_id=?",
				[value.candidate.id],
			),
		}));
		expect(rows.outbox?.state).toBe(accepted ? "APPROVED" : "PENDING_APPROVAL");
		expect(rows.challenge).toEqual({
			target_id: value.candidate.id,
			device_id: device,
			user_id: owner,
			epoch: model.epoch,
			target_version: value.candidate.record.targetVersion,
			consumed_at: accepted ? f.time.wall : null,
			burned_at: value.state === "BURNED" ? f.time.wall : null,
			has_signature: Number(accepted),
		});
		expect(rows.approvals).toEqual(
			accepted
				? [
						{
							outbox_id: value.candidate.id,
							challenge_id: value.challengeId,
							device_id: device,
							user_id: owner,
							epoch: model.epoch,
							target_version: value.candidate.record.targetVersion,
							consumed_at: null,
							voided_at: null,
						},
					]
				: [],
		);
	}
	f.native.store.read((db) => f.native.audit.verify(db));
}

describe("send approval zero-approver in-flight command model", () => {
	it("enumerates both channels and both duplicate-revocation orders", () => {
		expect(cases).toHaveLength(4);
		expect(new Set(cases.map((row) => row.label)).size).toBe(4);
		for (const channel of ["email", "chat"])
			expect(cases.filter((row) => row.channel === channel)).toHaveLength(2);
	});
	// Four schedules / eight targets. The existing fixture supplies original signatures, peers,
	// PIN proofs and storage; the paused policy result is DATA. This does not exercise recovery
	// from zero approvers, physical sends, platform gates or the complete approval property model.
	for (const row of cases) {
		it(`send approval zero-approver race ${row.label}`, () =>
			retainBody(async () => {
				const healthy = gate(),
					held = gate();
				healthy.released.resolve();
				const f = await fixture(policy([healthy, held]));
				fixtures.add(f);
				let revokeProof: PinProof | undefined;
				const accepting: Promise<Attempt>[] = [];
				try {
					const control = target(f, row.channel),
						probe = target(f, row.channel);
					const targets = [control, probe];
					const initial = f.native.store.read((db) => ({
						epoch: f.native.registry.state(db).epoch,
						pin: db.get<{ version: number }>(
							"SELECT version FROM main.approval_pins WHERE user_id=?",
							[native.owner(f.native)],
						),
					}));
					if (!initial.pin) throw new Error("DYTEST original PIN row is missing");
					const model: Model = {
						epoch: initial.epoch,
						audits: auditCounts(f),
						consumes: consumeCounts(f.native.pins),
						pinVersion: initial.pin.version,
						verified: 0,
						consumed: 0,
						revoked: false,
						refused: false,
					};
					expectState(f, targets, model);
					const good = accept(f, control.challenge, control.signed);
					accepting.push(good.observed);
					expect((await good.observed).accepted).toBe(true);
					control.state = "CONSUMED";
					model.verified++;
					model.consumed++;
					expectState(f, targets, model);
					expect([healthy.started, healthy.finished]).toEqual([1, 1]);
					// Prepare the real revoke proof before entering the existing policy deadline.
					const id = native.idOf(f.device);
					const preparedRevoke = await f.native.pins.verify(
						native.owner(f.native),
						native.PIN,
						revokePinScope(id),
					);
					revokeProof = preparedRevoke;
					model.verified++;
					expectState(f, targets, model);
					const running = accept(f, probe.challenge, probe.signed);
					accepting.push(running.observed);
					const entered = await Promise.race([
						held.entered.promise.then(() => true),
						running.observed.then(() => false),
					]);
					expect(entered).toBe(true);
					if (!entered) throw new Error("DYTEST acceptance settled before policy entry");
					model.verified++;
					expect(running.settled()).toBe(false);
					expect([held.started, held.finished]).toEqual([1, 0]);
					expectState(f, targets, model);
					const visited: Command[] = [];
					for (const command of row.commands) {
						visited.push(command);
						if (command === "revoke") {
							expect(
								f.native.store.write((tx) =>
									f.native.registry.revoke(tx, id, { kind: "device", id, proof: preparedRevoke }),
								),
							).toBe(true);
							model.revoked = true;
							model.consumed++;
						} else {
							const duplicate = accept(f, probe.challenge, probe.signed);
							accepting.push(duplicate.observed);
							refusal(
								await duplicate.observed,
								model.revoked ? "DEVICE_REFUSED" : "CHALLENGE_INVALID",
								model.revoked ? "DEVICE_REVOKED" : null,
							);
						}
						expect(running.settled()).toBe(false);
						expectState(f, targets, model);
					}
					expect(visited).toEqual(row.commands);
					held.released.resolve();
					// Check the admitted call itself before subsequent issue/replay permission checks.
					refusal(await running.observed, "DEVICE_REFUSED", "DEVICE_REVOKED");
					probe.state = "BURNED";
					model.refused = true;
					expectState(f, targets, model);
					expect([held.started, held.finished]).toEqual([1, 1]);
					const replay = accept(f, probe.challenge, probe.signed);
					accepting.push(replay.observed);
					refusal(await replay.observed, "DEVICE_REFUSED", "DEVICE_REVOKED");
					let issued: Attempt;
					try {
						issue(f, probe.candidate.id);
						issued = { accepted: true };
					} catch (error) {
						issued = { accepted: false, error };
					}
					refusal(issued, "DEVICE_REFUSED", "DEVICE_REVOKED");
					expectState(f, targets, model);
				} finally {
					healthy.released.resolve();
					held.released.resolve();
					await Promise.allSettled(accepting);
					await Promise.allSettled(jobs);
					if (revokeProof) f.native.pins.discard(revokeProof);
					await closeKnown(f);
				}
			}));
	}
});
