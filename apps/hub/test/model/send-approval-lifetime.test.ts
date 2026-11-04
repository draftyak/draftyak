import type { Challenge, SignedEnvelope } from "@draftyak/protocol/device-api";
import { describe, expect, it } from "vitest";
import { requireLoopbackNetworkGuard } from "../helpers/loopback-network.ts";
import type { Fixture } from "../identity/challenges-fixture.ts";
import type { ProposalCandidate } from "../outbox/propose-fixture.ts";

requireLoopbackNetworkGuard();
const { fixture, closeFixture, proposal, envelope, issue, native } = await import(
	"../identity/challenges-fixture.ts"
);
const { ChallengeError, CHALLENGE_TTL_MS } = await import("../../src/identity/challenges.ts");
const { advanceEpochForRestore } = await import("../../src/identity/devices.ts");

// The persisted challenge contract permits at most two minutes, including the boundary.
// This oracle uses commands and that bound, never verifier results or its private proof state.
const MODEL_TTL_MS = 120_000;
type Channel = "email" | "chat";
type ClockMode = "wall" | "monotonic" | "both";
type Action = "issue" | "accept" | "replay" | "time" | "epoch";
interface ModelCase {
	readonly channel: Channel;
	readonly clock: ClockMode;
	readonly delta: number;
	readonly actions: readonly Action[];
	readonly label: string;
}
const channels: readonly Channel[] = ["email", "chat"];
const clocks: readonly ClockMode[] = ["wall", "monotonic", "both"];
const timeOrders: readonly { readonly label: string; readonly actions: readonly Action[] }[] = [
	{ label: "T-I-A-R", actions: ["time", "issue", "accept", "replay"] },
	{ label: "I-T-A-R", actions: ["issue", "time", "accept", "replay"] },
	{ label: "I-A-T-R", actions: ["issue", "accept", "time", "replay"] },
];
const epochOrders: readonly { readonly label: string; readonly actions: readonly Action[] }[] = [
	{ label: "I-E-A-R", actions: ["issue", "epoch", "accept", "replay"] },
	{ label: "I-A-E-R", actions: ["issue", "accept", "epoch", "replay"] },
];
const cases: readonly ModelCase[] = channels.flatMap((channel) => [
	...clocks.flatMap((clock) =>
		timeOrders.map((order) => ({
			channel,
			clock,
			delta: MODEL_TTL_MS + 1,
			actions: order.actions,
			label: `${channel} expiry=${clock} delta=past-limit order=${order.label}`,
		})),
	),
	...clocks.map((clock) => ({
		channel,
		clock,
		delta: MODEL_TTL_MS,
		actions: ["issue", "time", "accept", "replay"] as const,
		label: `${channel} expiry=${clock} delta=at-limit order=I-T-A-R`,
	})),
	...epochOrders.map((order) => ({
		channel,
		clock: "both" as const,
		delta: 0,
		actions: order.actions,
		label: `${channel} restore-epoch invalidation setup order=${order.label}`,
	})),
]);

interface Time {
	wall: number;
	mono: number;
}
interface Issued {
	readonly challenge: Challenge;
	readonly signed: SignedEnvelope;
	readonly wall: number;
	readonly mono: number;
}
interface TargetModel {
	readonly candidate: ProposalCandidate;
	readonly epoch: number;
	issued?: Issued;
	acceptedAt: number | null;
}
interface ChallengeRow {
	id: string;
	target_id: string;
	device_id: string;
	user_id: string;
	epoch: number;
	target_version: number;
	issued_at: number;
	expires_at: number;
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
	accepted_at: number;
	consumed_at: number | null;
	voided_at: number | null;
}

function target(f: Fixture, channel: Channel, epoch: number): TargetModel {
	return { candidate: proposal(f, { channel }), epoch, acceptedAt: null };
}
function issueChallenge(f: Fixture, model: TargetModel, time: Time): void {
	if (model.issued) throw new Error("DYTEST model issues each target once");
	const challenge = issue(f, model.candidate.id);
	model.issued = {
		challenge,
		signed: envelope(f, challenge),
		wall: time.wall,
		mono: time.mono,
	};
}
function mayAccept(model: TargetModel, time: Time, epoch: number): boolean {
	const issued = model.issued;
	return (
		issued !== undefined &&
		model.acceptedAt === null &&
		epoch === model.epoch &&
		time.wall >= issued.wall &&
		time.wall <= issued.wall + MODEL_TTL_MS &&
		time.mono >= issued.mono &&
		time.mono - issued.mono <= MODEL_TTL_MS
	);
}
async function acceptChallenge(
	f: Fixture,
	model: TargetModel,
	time: Time,
	epoch: number,
): Promise<void> {
	const issued = model.issued;
	if (!issued) throw new Error("DYTEST acceptance must follow issue");
	const allowed = mayAccept(model, time, epoch);
	const actual = await f.challenges
		.accept(f.device.peer, issued.challenge.kind, issued.signed)
		.then(
			() => ({ accepted: true as const }),
			(error: unknown) => ({ accepted: false as const, error }),
		);
	expect(actual.accepted).toBe(allowed);
	if (actual.accepted) {
		model.acceptedAt = time.wall;
	} else {
		expect(actual.error instanceof ChallengeError).toBe(true);
		if (!(actual.error instanceof ChallengeError)) throw new Error("DYTEST unexpected refusal");
		expect(actual.error.code).toBe(epoch === model.epoch ? "CHALLENGE_INVALID" : "DEVICE_REFUSED");
	}
}
function expectTarget(f: Fixture, model: TargetModel): void {
	const id = model.candidate.id;
	const observed = f.native.store.read((db) => ({
		outbox: db.get<{ state: string }>("SELECT state FROM main.outbox WHERE id=?", [id]),
		challenges: db.all<ChallengeRow>(
			"SELECT id,target_id,device_id,user_id,epoch,target_version,issued_at,expires_at,consumed_at,burned_at,signature IS NOT NULL AS has_signature FROM main.approval_challenges WHERE target_id=?",
			[id],
		),
		approvals: db.all<ApprovalRow>(
			"SELECT outbox_id,account_id,challenge_id,device_id,user_id,epoch,target_version,content_hash,flags_hash,accepted_at,consumed_at,voided_at FROM main.approvals WHERE outbox_id=?",
			[id],
		),
	}));
	const accepted = model.acceptedAt !== null;
	expect(observed.outbox?.state).toBe(accepted ? "APPROVED" : "PENDING_APPROVAL");
	expect(observed.challenges).toHaveLength(model.issued ? 1 : 0);
	expect(observed.approvals).toHaveLength(accepted ? 1 : 0);
	const challenge = observed.challenges[0];
	if (model.issued) {
		if (!challenge) throw new Error("DYTEST issued challenge is missing");
		expect(challenge).toMatchObject({
			target_id: id,
			device_id: native.idOf(f.device),
			user_id: native.owner(f.native),
			epoch: model.epoch,
			target_version: model.candidate.record.targetVersion,
			issued_at: model.issued.wall,
			expires_at: model.issued.wall + MODEL_TTL_MS,
			consumed_at: model.acceptedAt,
			burned_at: null,
			has_signature: accepted ? 1 : 0,
		});
	}
	if (accepted) {
		if (!challenge) throw new Error("DYTEST accepted challenge is missing");
		expect(observed.approvals[0]).toEqual({
			outbox_id: id,
			account_id: model.candidate.record.accountId,
			challenge_id: challenge.id,
			device_id: native.idOf(f.device),
			user_id: native.owner(f.native),
			epoch: model.epoch,
			target_version: model.candidate.record.targetVersion,
			content_hash: model.candidate.record.contentHash,
			flags_hash: model.candidate.record.flagsHash,
			accepted_at: model.acceptedAt,
			consumed_at: null,
			voided_at: null,
		});
	}
}
function expectModels(f: Fixture, models: readonly TargetModel[], epoch: number): void {
	for (const model of models) expectTarget(f, model);
	const totals = f.native.store.read((db) => ({
		challenges: db.get<{ n: number }>("SELECT COUNT(*) AS n FROM main.approval_challenges")?.n,
		approvals: db.get<{ n: number }>("SELECT COUNT(*) AS n FROM main.approvals")?.n,
		epoch: f.native.registry.state(db).epoch,
	}));
	expect(totals).toEqual({
		challenges: models.filter((model) => model.issued !== undefined).length,
		approvals: models.filter((model) => model.acceptedAt !== null).length,
		epoch,
	});
}

describe("native send approval command model", () => {
	it("enumerates the bounded clock and epoch schedules without duplicate rows", () => {
		expect(CHALLENGE_TTL_MS).toBe(MODEL_TTL_MS);
		expect(cases).toHaveLength(28);
		expect(new Set(cases.map((row) => row.label)).size).toBe(28);
		for (const channel of channels) {
			const rows = cases.filter((row) => row.channel === channel);
			expect(rows.filter((row) => row.delta === MODEL_TTL_MS + 1)).toHaveLength(9);
			expect(rows.filter((row) => row.delta === MODEL_TTL_MS)).toHaveLength(3);
			expect(rows.filter((row) => row.actions.includes("epoch"))).toHaveLength(2);
		}
		for (const row of cases) {
			expect(row.actions.filter((action) => action === "issue")).toHaveLength(1);
			expect(row.actions.indexOf("issue")).toBeLessThan(row.actions.indexOf("accept"));
			expect(row.actions.indexOf("accept")).toBeLessThan(row.actions.indexOf("replay"));
		}
	});

	// 28 schedules, each with an independently accepted control and a second target: 56 scenarios.
	// This component does not cover execution, restore workflows, recovery, bootstrap or native OS gates,
	// and does not replace the complete 500-run security / 10k nightly approval model.
	for (const row of cases) {
		it(`send approval model ${row.label}`, async () => {
			const f = await fixture();
			try {
				const time: Time = { wall: f.time.wall, mono: f.time.mono };
				let epoch = f.native.store.read((db) => f.native.registry.state(db).epoch);
				const control = target(f, row.channel, epoch);
				issueChallenge(f, control, time);
				await acceptChallenge(f, control, time, epoch);
				expect(control.acceptedAt).toBe(time.wall);
				const probe = target(f, row.channel, epoch);
				const models = [control, probe];
				expectModels(f, models, epoch);
				const visited: Action[] = [];
				for (const action of row.actions) {
					visited.push(action);
					if (action === "issue") issueChallenge(f, probe, time);
					else if (action === "accept" || action === "replay")
						await acceptChallenge(f, probe, time, epoch);
					else if (action === "time") {
						if (row.clock !== "monotonic") {
							time.wall += row.delta;
							f.time.wall += row.delta;
						}
						if (row.clock !== "wall") {
							time.mono += row.delta;
							f.time.mono += row.delta;
						}
					} else {
						// Genuine restore-epoch invalidation setup in this temporary fixture only.
						// Do not delete PINs, re-bootstrap, or substitute an epoch/grant DTO.
						f.native.store.write((tx) => advanceEpochForRestore(f.native.registry, tx));
						epoch += 1;
					}
					expectModels(f, models, epoch);
				}
				expect(visited).toEqual(row.actions);
			} finally {
				await closeFixture(f);
			}
		});
	}
});
