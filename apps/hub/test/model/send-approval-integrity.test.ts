import type { Challenge, SignedEnvelope } from "@draftyak/protocol/device-api";
import { describe, expect, it } from "vitest";
import { requireLoopbackNetworkGuard } from "../helpers/loopback-network.ts";
import type { Fixture } from "../identity/challenges-fixture.ts";
import type { ProposalCandidate } from "../outbox/propose-fixture.ts";

requireLoopbackNetworkGuard();
const { fixture, closeFixture, proposal, envelope, issue, native } = await import(
	"../identity/challenges-fixture.ts"
);
const { ChallengeError } = await import("../../src/identity/challenges.ts");
const { AuthzError } = await import("../../src/authz/errors.ts");
const { CAPABILITY_BITS } = await import("../../src/authz/decide.ts");
const { revokePinScope } = await import("../../src/authz/scopes.ts");

type Channel = "email" | "chat";
type Fault = "signature-shape" | "signature-bit" | "signature-domain" | "statement" | "pin";
type Repair = "correct-first" | "replace-first";
type Action = "fault" | "correct-original" | "replace" | "accept-replacement";
interface FaultSpec {
	readonly kind: Fault;
	readonly burns: boolean;
	readonly failures: number;
	readonly code: string;
	readonly detail: string | null;
}
const channels: readonly Channel[] = ["email", "chat"];
const repairs: readonly Repair[] = ["correct-first", "replace-first"];
const faults: readonly FaultSpec[] = [
	{ kind: "signature-shape", burns: false, failures: 0, code: "INVALID_REQUEST", detail: null },
	{ kind: "signature-bit", burns: true, failures: 0, code: "SIGNATURE_INVALID", detail: null },
	{ kind: "signature-domain", burns: true, failures: 0, code: "SIGNATURE_INVALID", detail: null },
	{ kind: "statement", burns: false, failures: 0, code: "CHALLENGE_INVALID", detail: null },
	{ kind: "pin", burns: true, failures: 1, code: "PIN_REFUSED", detail: "PIN_INVALID" },
];
const faultCases = channels.flatMap((channel) =>
	faults.flatMap((fault) =>
		repairs.map((repair) => ({
			channel,
			fault,
			repair,
			label: `${channel} fault=${fault.kind} repair=${repair}`,
			actions: (repair === "replace-first"
				? ["fault", "replace", "correct-original", "accept-replacement"]
				: fault.burns
					? ["fault", "correct-original", "replace", "accept-replacement"]
					: ["fault", "correct-original"]) as readonly Action[],
		})),
	),
);
const revocationCases = channels.flatMap((channel) =>
	(["before-accept", "after-accept"] as const).map((order) => ({
		channel,
		order,
		label: `${channel} revoke=${order}`,
	})),
);

interface ChallengeModel {
	readonly id: string;
	readonly challenge: Challenge;
	readonly signed: SignedEnvelope;
	state: "OPEN" | "BURNED" | "CONSUMED";
}
interface TargetModel {
	readonly candidate: ProposalCandidate;
	readonly challenges: ChallengeModel[];
	accepted: ChallengeModel | undefined;
}
interface Oracle {
	readonly epoch: number;
	readonly wall: number;
	failures: number;
	revoked: boolean;
}
interface ChallengeRow {
	id: string;
	target_id: string;
	device_id: string;
	user_id: string;
	epoch: number;
	target_version: number;
	consumed_at: number | null;
	burned_at: number | null;
	has_signature: number;
}
interface ApprovalRow {
	outbox_id: string;
	account_id: string;
	challenge_id: string;
	device_id: string;
	user_id: string;
	epoch: number;
	target_version: number;
	content_hash: string;
	flags_hash: string;
	consumed_at: number | null;
	voided_at: number | null;
}

function target(f: Fixture, channel: Channel): TargetModel {
	return { candidate: proposal(f, { channel }), challenges: [], accepted: undefined };
}
function issueChallenge(f: Fixture, model: TargetModel): ChallengeModel {
	const challenge = issue(f, model.candidate.id);
	const row = f.native.store.read((db) =>
		db.get<{ id: string }>("SELECT id FROM main.approval_challenges WHERE statement=?", [
			Buffer.from(challenge.statement, "base64url"),
		]),
	);
	if (!row || model.challenges.some((previous) => previous.id === row.id))
		throw new Error("DYTEST challenge identity is missing or reused");
	for (const previous of model.challenges) if (previous.state === "OPEN") previous.state = "BURNED";
	const issued: ChallengeModel = {
		id: row.id,
		challenge,
		signed: envelope(f, challenge),
		state: "OPEN",
	};
	model.challenges.push(issued);
	return issued;
}
async function attempt(f: Fixture, challenge: ChallengeModel, signed: SignedEnvelope) {
	return f.challenges.accept(f.device.peer, challenge.challenge.kind, signed).then(
		() => ({ accepted: true as const }),
		(error: unknown) => ({ accepted: false as const, error }),
	);
}
function expectRefusal(
	actual: Awaited<ReturnType<typeof attempt>>,
	code: string,
	detail: string | null,
) {
	expect(actual.accepted).toBe(false);
	if (actual.accepted) throw new Error("DYTEST invalid command was accepted");
	expect(actual.error instanceof ChallengeError).toBe(true);
	if (!(actual.error instanceof ChallengeError)) throw new Error("DYTEST unexpected refusal");
	expect(actual.error.code).toBe(code);
	expect(actual.error.detail).toBe(detail);
}
async function acceptOriginal(
	f: Fixture,
	model: TargetModel,
	challenge: ChallengeModel,
	oracle: Oracle,
): Promise<void> {
	const allowed = !oracle.revoked && challenge.state === "OPEN" && model.accepted === undefined;
	const actual = await attempt(f, challenge, challenge.signed);
	if (allowed) {
		expect(actual.accepted).toBe(true);
		challenge.state = "CONSUMED";
		model.accepted = challenge;
		oracle.failures = 0;
	} else {
		expectRefusal(
			actual,
			oracle.revoked ? "DEVICE_REFUSED" : "CHALLENGE_INVALID",
			oracle.revoked ? "DEVICE_REVOKED" : null,
		);
	}
}
function faultEnvelope(
	f: Fixture,
	model: TargetModel,
	challenge: ChallengeModel,
	fault: Fault,
): SignedEnvelope {
	const wrongPin = `${native.PIN[0] === "0" ? "1" : "0"}${native.PIN.slice(1)}`;
	const signed = envelope(f, challenge.challenge, wrongPin);
	if (fault === "signature-shape") return { ...signed, signature: "_" };
	if (fault === "signature-domain")
		return envelope(f, challenge.challenge, wrongPin, undefined, "pair-confirm.v1");
	if (fault === "statement") {
		const original = model.candidate.record.contentHash;
		const different = `${original[0] === "0" ? "1" : "0"}${original.slice(1)}`;
		return envelope(f, challenge.challenge, wrongPin, { contentHash: different });
	}
	if (fault === "signature-bit") {
		const bytes = Buffer.from(signed.signature, "base64url");
		try {
			const first = bytes[0];
			if (first === undefined) throw new Error("DYTEST signature bytes missing");
			bytes[0] = first ^ 1;
			return { ...signed, signature: bytes.toString("base64url") };
		} finally {
			bytes.fill(0);
		}
	}
	return signed;
}
function expectState(f: Fixture, models: readonly TargetModel[], oracle: Oracle): void {
	for (const model of models) {
		const id = model.candidate.id;
		const rows = f.native.store.read((db) => ({
			outbox: db.get<{ state: string }>("SELECT state FROM main.outbox WHERE id=?", [id]),
			challenges: db.all<ChallengeRow>(
				"SELECT id,target_id,device_id,user_id,epoch,target_version,consumed_at,burned_at,signature IS NOT NULL AS has_signature FROM main.approval_challenges WHERE target_id=?",
				[id],
			),
			approvals: db.all<ApprovalRow>(
				"SELECT outbox_id,account_id,challenge_id,device_id,user_id,epoch,target_version,content_hash,flags_hash,consumed_at,voided_at FROM main.approvals WHERE outbox_id=?",
				[id],
			),
		}));
		expect(rows.outbox?.state).toBe(model.accepted ? "APPROVED" : "PENDING_APPROVAL");
		expect(rows.challenges).toHaveLength(model.challenges.length);
		expect(rows.approvals).toHaveLength(model.accepted ? 1 : 0);
		for (const expected of model.challenges) {
			expect(rows.challenges.find((row) => row.id === expected.id)).toEqual({
				id: expected.id,
				target_id: id,
				device_id: native.idOf(f.device),
				user_id: native.owner(f.native),
				epoch: oracle.epoch,
				target_version: model.candidate.record.targetVersion,
				consumed_at: expected.state === "CONSUMED" ? oracle.wall : null,
				burned_at: expected.state === "BURNED" ? oracle.wall : null,
				has_signature: expected.state === "CONSUMED" ? 1 : 0,
			});
		}
		if (model.accepted)
			expect(rows.approvals[0]).toEqual({
				outbox_id: id,
				account_id: model.candidate.record.accountId,
				challenge_id: model.accepted.id,
				device_id: native.idOf(f.device),
				user_id: native.owner(f.native),
				epoch: oracle.epoch,
				target_version: model.candidate.record.targetVersion,
				content_hash: model.candidate.record.contentHash,
				flags_hash: model.candidate.record.flagsHash,
				consumed_at: null,
				voided_at: null,
			});
	}
	const owner = native.owner(f.native);
	const observed = f.native.store.read((db) => ({
		pin: db.get<{ failures: number; locked_until: number }>(
			"SELECT failures,locked_until FROM main.approval_pins WHERE user_id=?",
			[owner],
		),
		authority: db.get<{ epoch: number; bootstrap_done: number; owner_user_id: string }>(
			"SELECT epoch,bootstrap_done,owner_user_id FROM main.device_authority WHERE singleton=1",
		),
		revoked: db.get<{ value: number }>(
			"SELECT revoked_at IS NOT NULL AS value FROM main.devices WHERE id=?",
			[native.idOf(f.device)],
		)?.value,
		approvers: db.get<{ n: number }>(
			"SELECT COUNT(*) AS n FROM main.devices WHERE revoked_at IS NULL AND confirmed_epoch=? AND (capabilities & ?)<>0",
			[oracle.epoch, CAPABILITY_BITS.approve],
		)?.n,
		revocations: db.get<{ n: number }>(
			"SELECT COUNT(*) AS n FROM main.audit_events WHERE action='device.revoked'",
		)?.n,
		approvals: db.get<{ n: number }>("SELECT COUNT(*) AS n FROM main.approvals")?.n,
		challenges: db.get<{ n: number }>("SELECT COUNT(*) AS n FROM main.approval_challenges")?.n,
	}));
	expect(observed).toEqual({
		pin: { failures: oracle.failures, locked_until: 0 },
		authority: { epoch: oracle.epoch, bootstrap_done: 1, owner_user_id: owner },
		revoked: oracle.revoked ? 1 : 0,
		approvers: oracle.revoked ? 0 : 1,
		revocations: oracle.revoked ? 1 : 0,
		approvals: models.filter((model) => model.accepted !== undefined).length,
		challenges: models.reduce((total, model) => total + model.challenges.length, 0),
	});
}
async function setup(channel: Channel) {
	const f = await fixture();
	try {
		const oracle: Oracle = {
			epoch: f.native.store.read((db) => f.native.registry.state(db).epoch),
			wall: f.time.wall,
			failures: 0,
			revoked: false,
		};
		const control = target(f, channel);
		const issued = issueChallenge(f, control);
		await acceptOriginal(f, control, issued, oracle);
		const probe = target(f, channel);
		const original = issueChallenge(f, probe);
		const models = [control, probe];
		expectState(f, models, oracle);
		return { f, oracle, models, probe, original };
	} catch (error) {
		await closeFixture(f);
		throw error;
	}
}

describe("native send approval integrity command model", () => {
	it("enumerates distinct fault-repair and revocation schedules", () => {
		expect(faultCases).toHaveLength(20);
		expect(new Set(faultCases.map((row) => row.label)).size).toBe(20);
		expect(revocationCases).toHaveLength(4);
		expect(new Set(revocationCases.map((row) => row.label)).size).toBe(4);
		for (const channel of channels) {
			expect(faultCases.filter((row) => row.channel === channel)).toHaveLength(10);
			expect(revocationCases.filter((row) => row.channel === channel)).toHaveLength(2);
		}
	});

	// 24 schedules / 48 targets. Real signatures, PINs, peers and storage are supplied by the
	// existing native fixture; malformed envelopes are negative DATA, never acceptance authority.
	// This component does not exercise lockout recovery, restore, physical sends, OS gates,
	// or replace the complete 500-run security / 10k nightly approval model.
	for (const row of faultCases) {
		it(`send approval integrity ${row.label}`, async () => {
			const { f, oracle, models, probe, original } = await setup(row.channel);
			try {
				let replacement: ChallengeModel | undefined;
				const visited: Action[] = [];
				for (const action of row.actions) {
					visited.push(action);
					if (action === "fault") {
						const actual = await attempt(
							f,
							original,
							faultEnvelope(f, probe, original, row.fault.kind),
						);
						expectRefusal(actual, row.fault.code, row.fault.detail);
						if (row.fault.burns) original.state = "BURNED";
						oracle.failures += row.fault.failures;
					} else if (action === "correct-original") {
						await acceptOriginal(f, probe, original, oracle);
					} else if (action === "replace") {
						replacement = issueChallenge(f, probe);
					} else {
						if (!replacement) throw new Error("DYTEST replacement must be issued first");
						await acceptOriginal(f, probe, replacement, oracle);
					}
					expectState(f, models, oracle);
				}
				expect(visited).toEqual(row.actions);
				expect(probe.accepted).toBe(replacement ?? original);
			} finally {
				await closeFixture(f);
			}
		});
	}

	for (const row of revocationCases) {
		it(`send approval integrity ${row.label}`, async () => {
			const { f, oracle, models, probe, original } = await setup(row.channel);
			try {
				const id = native.idOf(f.device);
				let refused: unknown;
				try {
					f.native.store.write((tx) => f.native.registry.revoke(tx, id, { kind: "cli" }));
				} catch (error) {
					refused = error;
				}
				expect(refused instanceof AuthzError).toBe(true);
				if (!(refused instanceof AuthzError))
					throw new Error("DYTEST expected last-approver refusal");
				expect(refused.code).toBe("LAST_APPROVER");
				expectState(f, models, oracle);
				if (row.order === "after-accept") {
					await acceptOriginal(f, probe, original, oracle);
					expectState(f, models, oracle);
				}
				const proof = await f.native.pins.verify(
					native.owner(f.native),
					native.PIN,
					revokePinScope(id),
				);
				try {
					expect(
						f.native.store.write((tx) =>
							f.native.registry.revoke(tx, id, { kind: "device", id, proof }),
						),
					).toBe(true);
					oracle.revoked = true;
				} finally {
					f.native.pins.discard(proof);
				}
				expectState(f, models, oracle);
				await acceptOriginal(f, probe, original, oracle);
				expectState(f, models, oracle);
				let issued: unknown;
				try {
					issue(f, probe.candidate.id);
				} catch (error) {
					issued = error;
				}
				expect(issued instanceof ChallengeError).toBe(true);
				if (!(issued instanceof ChallengeError))
					throw new Error("DYTEST revoked peer issued a challenge");
				expect(issued.code).toBe("DEVICE_REFUSED");
				expect(issued.detail).toBe("DEVICE_REVOKED");
				expectState(f, models, oracle);
				expect(
					f.native.store.write((tx) => f.native.registry.revoke(tx, id, { kind: "cli" })),
				).toBe(false);
				expectState(f, models, oracle);
			} finally {
				await closeFixture(f);
			}
		});
	}
});
