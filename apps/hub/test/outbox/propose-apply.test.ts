import { fromBase64Url } from "@draftyak/protocol/scalars";
import { signStatement } from "@draftyak/protocol/sign";
import { parseStatement } from "@draftyak/protocol/statements";
import { afterEach, expect, it } from "vitest";
import { CHALLENGE_MIGRATIONS, ChallengeService } from "../../src/identity/challenges.ts";
import type { NativeProposalProviders } from "../../src/outbox/propose.ts";
import { APPROVAL_MIGRATIONS, SendApprovalVerifier } from "../../src/outbox/verifier.ts";
import type { SqlTransaction } from "../../src/store/store.ts";
import { type Fixture, fixture, native } from "./propose-fixture.ts";

const fixtures: {
	readonly base: Fixture;
	readonly verifier: SendApprovalVerifier;
	readonly challenges: ChallengeService;
}[] = [];
afterEach(async () => {
	for (const f of fixtures.splice(0)) {
		f.challenges.lock();
		f.verifier.lock();
		await f.base.close();
	}
});

it("starts the full undo window after the final native DATA callback", async () => {
	const base = await fixture({
		extraMigrations: {
			challenges: CHALLENGE_MIGRATIONS,
			verifier: APPROVAL_MIGRATIONS,
		},
	});
	let verifier: SendApprovalVerifier | undefined;
	let challenges: ChallengeService | undefined;
	try {
		const original = base.providers;
		if (!original) throw new Error("DYTEST native DATA provider missing");
		let watchedOutbox: string | undefined;
		const postVoteReads: SqlTransaction[] = [];
		const TEST_ONLY_ADVANCING_DATA = Object.freeze<NativeProposalProviders>({
			facts: (tx, binding, revision) => {
				if (
					watchedOutbox &&
					tx.get(
						"SELECT 1 FROM main.approvals WHERE outbox_id=? AND consumed_at IS NULL AND voided_at IS NULL LIMIT 1",
						[watchedOutbox],
					)
				) {
					postVoteReads.push(tx);
					if (postVoteReads.length === 2) {
						base.time.wall += 37;
						base.time.mono += 37;
					}
				}
				return original.facts(tx, binding, revision);
			},
			flags: original.flags,
		});
		const target = base.replaceTarget(TEST_ONLY_ADVANCING_DATA);
		const f = base.native;
		verifier = new SendApprovalVerifier(f.store, f.audit, f.registry, f.authorizer, {
			identity: f.identity,
			target,
			masterKey: f.key,
			clock: base.clock,
		});
		challenges = new ChallengeService(f.store, f.audit, f.pins, f.registry, f.authorizer, {
			identity: f.identity,
			send: verifier,
			clock: base.clock,
		});
		fixtures.push({ base, verifier, challenges });
		const proposal = base.proposal();
		watchedOutbox = proposal.id;
		const challenge = challenges.issue(base.device.peer, {
			kind: "approval.send.v1",
			id: proposal.id,
			flagsAcked: [],
		});
		const bytes = fromBase64Url(challenge.statement);
		const statement = bytes && parseStatement(challenge.kind, bytes);
		if (!statement) throw new Error("DYTEST native statement missing");
		const before = { ...base.time };
		await expect(
			challenges.accept(base.device.peer, challenge.kind, {
				statement: challenge.statement,
				signature: signStatement(challenge.kind, statement, base.device.privateKey),
				pin: native.PIN,
			}),
		).resolves.toMatchObject({ kind: challenge.kind, id: proposal.id });
		expect(postVoteReads).toHaveLength(2);
		expect(postVoteReads[1]).toBe(postVoteReads[0]);
		expect(base.time).toEqual({ wall: before.wall + 37, mono: before.mono + 37 });
		const stored = target.write((tx) => target.get(tx, proposal.id));
		expect(stored?.state).toBe("APPROVED");
		expect(stored?.notBefore).toBe(base.time.wall + proposal.record.undoWindowMs);
		expect(stored?.notBefore).not.toBe(before.wall + proposal.record.undoWindowMs);
	} catch (error) {
		if (!fixtures.some((f) => f.base === base)) {
			challenges?.lock();
			verifier?.lock();
			await base.close();
		}
		throw error;
	}
});

it.each([
	{ name: "approves with native DATA still available at apply", unavailable: false },
	{
		name: "rolls back a genuine approval when native DATA disappears only at apply",
		unavailable: true,
	},
])("$name", async ({ unavailable }) => {
	const base = await fixture({
		extraMigrations: {
			challenges: CHALLENGE_MIGRATIONS,
			verifier: APPROVAL_MIGRATIONS,
		},
	});
	let verifier: SendApprovalVerifier | undefined;
	let challenges: ChallengeService | undefined;
	try {
		const original = base.providers;
		if (!original) throw new Error("DYTEST native DATA provider missing");
		let watchedOutbox: string | undefined;
		const postVoteReads: SqlTransaction[] = [];
		// The native vote INSERT occurs before proof consumption. Its first subsequent DATA read
		// is consumeVerifiedSendApproval -> item; the second is the target's own apply recheck.
		const TEST_ONLY_NATIVE_DATA = Object.freeze<NativeProposalProviders>({
			facts: (tx, binding, revision) => {
				if (
					watchedOutbox &&
					tx.get(
						"SELECT 1 FROM main.approvals WHERE outbox_id=? AND consumed_at IS NULL AND voided_at IS NULL LIMIT 1",
						[watchedOutbox],
					)
				) {
					postVoteReads.push(tx);
					if (unavailable && postVoteReads.length === 2) return undefined;
				}
				return original.facts(tx, binding, revision);
			},
			flags: original.flags,
		});
		const target = base.replaceTarget(TEST_ONLY_NATIVE_DATA);
		const f = base.native;
		verifier = new SendApprovalVerifier(f.store, f.audit, f.registry, f.authorizer, {
			identity: f.identity,
			target,
			masterKey: f.key,
			clock: base.clock,
		});
		challenges = new ChallengeService(f.store, f.audit, f.pins, f.registry, f.authorizer, {
			identity: f.identity,
			send: verifier,
			clock: base.clock,
		});
		fixtures.push({ base, verifier, challenges });
		const proposal = base.proposal();
		watchedOutbox = proposal.id;
		const challenge = challenges.issue(base.device.peer, {
			kind: "approval.send.v1",
			id: proposal.id,
			flagsAcked: [],
		});
		const bytes = fromBase64Url(challenge.statement);
		const statement = bytes && parseStatement(challenge.kind, bytes);
		if (!statement) throw new Error("DYTEST native statement missing");
		const envelope = {
			statement: challenge.statement,
			signature: signStatement(challenge.kind, statement, base.device.privateKey),
			pin: native.PIN,
		};
		const before = f.store.read((tx) => ({
			row: tx.get("SELECT state,payload,audit_seq,mac FROM main.outbox WHERE id=?", [proposal.id]),
			events: tx.get<{ n: number }>(
				"SELECT count(*) AS n FROM main.events WHERE kind='outbox.changed'",
			)?.n,
		}));
		const lockBefore = base.revisions.current(proposal.binding).lockId;
		const accepted = challenges.accept(base.device.peer, challenge.kind, envelope);
		if (unavailable) await expect(accepted).rejects.toMatchObject({ code: "STALE" });
		else await expect(accepted).resolves.toMatchObject({ kind: challenge.kind, id: proposal.id });
		expect(postVoteReads).toHaveLength(2);
		expect(postVoteReads[1]).toBe(postVoteReads[0]);
		const after = f.store.read((tx) => ({
			row: tx.get<{ state: string }>(
				"SELECT state,payload,audit_seq,mac FROM main.outbox WHERE id=?",
				[proposal.id],
			),
			challenge: tx.get<{ consumed_at: number | null; signature: string | null }>(
				"SELECT consumed_at,signature FROM main.approval_challenges WHERE target_id=?",
				[proposal.id],
			),
			votes: tx.get<{ n: number }>("SELECT count(*) AS n FROM main.approvals WHERE outbox_id=?", [
				proposal.id,
			])?.n,
			events: tx.get<{ n: number }>(
				"SELECT count(*) AS n FROM main.events WHERE kind='outbox.changed'",
			)?.n,
		}));
		if (unavailable) {
			expect(after.row).toEqual(before.row);
			expect(after.challenge).toEqual({ consumed_at: null, signature: null });
			expect(after.votes).toBe(0);
			expect(after.events).toBe(before.events);
			expect(native.auditActions(f)).not.toContain("approval.accepted");
			expect(native.auditActions(f)).not.toContain("outbox.approved");
		} else {
			expect(after.row?.state).toBe("APPROVED");
			expect(after.challenge?.consumed_at).toBe(base.time.wall);
			expect(after.challenge?.signature).toBe(envelope.signature);
			expect(after.votes).toBe(1);
			expect(after.events).toBe((before.events ?? 0) + 1);
			expect(native.auditActions(f)).toContain("approval.accepted");
			expect(native.auditActions(f)).toContain("outbox.approved");
		}
		expect(base.revisions.current(proposal.binding).lockId).toBe(lockBefore);
	} catch (error) {
		if (!fixtures.some((f) => f.base === base)) {
			challenges?.lock();
			verifier?.lock();
			await base.close();
		}
		throw error;
	}
});
