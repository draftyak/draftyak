import type { Challenge } from "@draftyak/protocol/device-api";
import type { SendStatement as SendStatementData } from "@draftyak/protocol/statements/send";
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { requireLoopbackNetworkGuard } from "../helpers/loopback-network.ts";
import type { Fixture } from "../identity/challenges-fixture.ts";
import type { ProposalCandidate } from "../outbox/propose-fixture.ts";

function runCount(value: string | undefined): 500 | 10_000 {
	if (value === undefined || value === "500") return 500;
	if (value === "10000") return 10_000;
	throw new Error("DYTEST invalid approval binding run count");
}
const RUNS = runCount(process.env.DRAFTYAK_APPROVAL_BINDING_RUNS);
requireLoopbackNetworkGuard();
const { fixture, closeFixture, proposal, envelope, issue, native } = await import(
	"../identity/challenges-fixture.ts"
);
const { ChallengeError } = await import("../../src/identity/challenges.ts");
const { SendStatement } = await import("@draftyak/protocol/statements/send");
const { decodeDeviceStatement, SignedEnvelope } = await import("@draftyak/protocol/device-api");
const { FlagCode } = await import("@draftyak/protocol/flags");

const FIELDS = [
	"hub",
	"contentHash",
	"flagsHash",
	"device",
	"outbox",
	"epoch",
	"flagsAcked",
	"notBefore",
	"deliverBy",
] as const;
type Field = (typeof FIELDS)[number];
const ACK_CODES = ["NEW_RECIPIENT", "EXTERNAL_LINK", "MASS_MENTION", "CROSS_THREAD_DATA"] as const;
const channels = ["email", "chat"] as const;
const seeds = { email: 0x5e1ec7, chat: 0x5e1ec8 } as const;
const HEX = "0123456789abcdef";
const CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
const mutations = fc.record({
	field: fc.constantFrom(...FIELDS),
	position: fc.integer({ min: 0, max: 63 }),
	step: fc.integer({ min: 1, max: 15 }),
	ack: fc.constantFrom(...ACK_CODES),
});
interface Mutation {
	readonly field: Field;
	readonly position: number;
	readonly step: number;
	readonly ack: (typeof ACK_CODES)[number];
}
function differentHex(original: string, position: number, step: number): string {
	const old = HEX.indexOf(original.charAt(position));
	const next = HEX.charAt(old ^ step);
	if (old < 0 || next.length !== 1) throw new Error("DYTEST invalid hexadecimal mutation");
	return original.slice(0, position) + next + original.slice(position + 1);
}
function differentId(original: string, step: number): string {
	const old = CROCKFORD.indexOf(original.charAt(original.length - 1));
	if (old < 0) throw new Error("DYTEST invalid identifier mutation");
	return original.slice(0, -1) + CROCKFORD.charAt((old + step) % CROCKFORD.length);
}
function differentInteger(original: number, step: number): number {
	return original >= step ? original - step : original + step;
}
function changesFor(base: SendStatementData, mutation: Mutation): Record<string, unknown> {
	const { field, position, step, ack } = mutation;
	if (field === "hub" || field === "contentHash" || field === "flagsHash")
		return { [field]: differentHex(base[field], position, step) };
	if (field === "device" || field === "outbox") return { [field]: differentId(base[field], step) };
	if (field === "epoch" || field === "deliverBy")
		return { [field]: differentInteger(base[field], step) };
	if (field === "flagsAcked") return { flagsAcked: [ack] };
	return { notBefore: position };
}
interface Target {
	readonly candidate: ProposalCandidate;
	readonly challengeId: string;
	readonly challenge: Challenge;
}
function expectPersisted(
	f: Fixture,
	control: Target,
	probe: Target,
	epoch: number,
	probeAccepted: boolean,
): void {
	const observed = f.native.store.read((db) => ({
		control: db.get<{ state: string; audit_seq: number }>(
			"SELECT state,audit_seq FROM main.outbox WHERE id=?",
			[control.candidate.id],
		),
		probe: db.get<{ state: string; audit_seq: number }>(
			"SELECT state,audit_seq FROM main.outbox WHERE id=?",
			[probe.candidate.id],
		),
		challenge: db.get<{
			id: string;
			target_id: string;
			device_id: string;
			user_id: string;
			epoch: number;
			target_version: number;
			consumed_at: number | null;
			burned_at: number | null;
			has_signature: number;
		}>(
			"SELECT id,target_id,device_id,user_id,epoch,target_version,consumed_at,burned_at,signature IS NOT NULL AS has_signature FROM main.approval_challenges WHERE id=?",
			[probe.challengeId],
		),
		pin: db.get<{ failures: number; locked_until: number }>(
			"SELECT failures,locked_until FROM main.approval_pins WHERE user_id=?",
			[native.owner(f.native)],
		),
		counts: db.get<{
			approvals: number;
			challenges: number;
			outbox: number;
			probeApprovals: number;
		}>(
			"SELECT (SELECT COUNT(*) FROM main.approvals) AS approvals,(SELECT COUNT(*) FROM main.approval_challenges) AS challenges,(SELECT COUNT(*) FROM main.outbox) AS outbox,(SELECT COUNT(*) FROM main.approvals WHERE outbox_id=?) AS probeApprovals",
			[probe.candidate.id],
		),
	}));
	expect(observed.control?.state).toBe("APPROVED");
	expect(observed.probe?.state).toBe(probeAccepted ? "APPROVED" : "PENDING_APPROVAL");
	if (!probeAccepted) expect(observed.probe?.audit_seq).toBe(probe.candidate.record.targetVersion);
	expect(observed.challenge).toEqual({
		id: probe.challengeId,
		target_id: probe.candidate.id,
		device_id: native.idOf(f.device),
		user_id: native.owner(f.native),
		epoch,
		target_version: probe.candidate.record.targetVersion,
		consumed_at: probeAccepted ? f.time.wall : null,
		burned_at: null,
		has_signature: probeAccepted ? 1 : 0,
	});
	expect(observed.pin).toEqual({ failures: 0, locked_until: 0 });
	expect(observed.counts).toEqual({
		approvals: probeAccepted ? 2 : 1,
		challenges: 2,
		outbox: 2,
		probeApprovals: probeAccepted ? 1 : 0,
	});
}

describe("native send statement binding property", () => {
	it("keeps a closed mutation domain and strict run count", () => {
		expect(FIELDS).toHaveLength(9);
		expect(new Set(FIELDS).size).toBe(9);
		expect(RUNS === 500 || RUNS === 10_000).toBe(true);
		for (const ack of ACK_CODES) expect(FlagCode.safeParse(ack).success).toBe(true);
	});

	// One real native fixture per channel. Generated changes are signed DATA, never a proof or grant.
	// Default: 500 generated attempts/channel; explicit 10000 mode: 10k/channel. These are not
	// whole-model, scheduled-nightly, physical-send, restore or native OS acceptance claims.
	for (const channel of channels) {
		it(
			`rejects re-signed byte-different ${channel} statements before PIN spending`,
			async () => {
				const f = await fixture();
				try {
					const epoch = f.native.store.read((db) => f.native.registry.state(db).epoch);
					const createTarget = (): Target => {
						const candidate = proposal(f, { channel });
						const challenge = issue(f, candidate.id);
						const row = f.native.store.read((db) =>
							db.get<{ id: string }>("SELECT id FROM main.approval_challenges WHERE statement=?", [
								Buffer.from(challenge.statement, "base64url"),
							]),
						);
						if (!row) throw new Error("DYTEST issued challenge is missing");
						return { candidate, challengeId: row.id, challenge };
					};
					const control = createTarget();
					const controlChallenge = control.challenge;
					await f.challenges.accept(
						f.device.peer,
						controlChallenge.kind,
						envelope(f, controlChallenge),
					);
					const probe = createTarget();
					const challenge = probe.challenge;
					const decodedBase = decodeDeviceStatement(challenge.kind, challenge.statement);
					const parsedBase = SendStatement.safeParse(decodedBase);
					expect(parsedBase.success).toBe(true);
					if (!parsedBase.success) throw new Error("DYTEST invalid original send statement");
					const base = parsedBase.data;
					expect(base.flagsAcked).toHaveLength(0);
					expect(base.notBefore).toBeNull();
					const originalBytes = Buffer.from(challenge.statement, "base64url");
					const wrongPin = `${native.PIN[0] === "0" ? "1" : "0"}${native.PIN.slice(1)}`;
					const coverage = new Map<Field, number>();
					for (const field of FIELDS) coverage.set(field, 0);
					let attempted = 0;
					let verified = 0;
					const firstFailure: { caught: boolean; error: unknown } = {
						caught: false,
						error: undefined,
					};
					try {
						expectPersisted(f, control, probe, epoch, false);
						const details = await fc.check(
							fc.asyncProperty(mutations, async (mutation) => {
								try {
									attempted++;
									const changes = changesFor(base, mutation);
									expect(Object.keys(changes)).toEqual([mutation.field]);
									const candidate = { ...base, ...changes };
									// Wire-schema validation describes generated DATA, not the expected refusal.
									expect(SendStatement.safeParse(candidate).success).toBe(true);
									expect(candidate.nonce === base.nonce).toBe(true);
									expect(
										candidate.v === base.v &&
											candidate.iat === base.iat &&
											candidate.exp === base.exp,
									).toBe(true);
									const signed = envelope(f, challenge, wrongPin, changes);
									expect(SignedEnvelope.safeParse(signed).success).toBe(true);
									expect(
										decodeDeviceStatement(challenge.kind, signed.statement) !== undefined,
									).toBe(true);
									const bytes = Buffer.from(signed.statement, "base64url");
									try {
										expect(bytes.equals(originalBytes)).toBe(false);
									} finally {
										bytes.fill(0);
									}
									const result = await f.challenges
										.accept(f.device.peer, challenge.kind, signed)
										.then(
											() => ({ accepted: true as const }),
											(error: unknown) => ({ accepted: false as const, error }),
										);
									expect(result.accepted).toBe(false);
									if (result.accepted) throw new Error("DYTEST changed statement was accepted");
									expect(result.error instanceof ChallengeError).toBe(true);
									if (!(result.error instanceof ChallengeError))
										throw new Error("DYTEST unexpected refusal");
									expect(result.error.code).toBe("CHALLENGE_INVALID");
									expect(result.error.detail).toBeNull();
									expectPersisted(f, control, probe, epoch, false);
									coverage.set(mutation.field, (coverage.get(mutation.field) ?? 0) + 1);
									verified++;
								} catch (error) {
									if (!firstFailure.caught) {
										firstFailure.caught = true;
										firstFailure.error = error;
									}
									throw error;
								}
							}),
							{ numRuns: RUNS, seed: seeds[channel], endOnFailure: true },
						);
						if (details.failed) {
							throw new Error(
								`DYTEST statement binding failed seed=${seeds[channel]} runs=${details.numRuns} verified=${verified} callback=${firstFailure.caught}`,
								{ cause: firstFailure.error },
							);
						}
						expect({
							failed: details.failed,
							runs: details.numRuns,
							skips: details.numSkips,
							interrupted: details.interrupted,
							attempted,
							verified,
						}).toEqual({
							failed: false,
							runs: RUNS,
							skips: 0,
							interrupted: false,
							attempted: RUNS,
							verified: RUNS,
						});
						for (const field of FIELDS) expect((coverage.get(field) ?? 0) > 0).toBe(true);
						await f.challenges.accept(f.device.peer, challenge.kind, envelope(f, challenge));
						expectPersisted(f, control, probe, epoch, true);
					} finally {
						originalBytes.fill(0);
					}
				} finally {
					await closeFixture(f);
				}
			},
			RUNS === 10_000 ? 720_000 : undefined,
		);
	}
});
