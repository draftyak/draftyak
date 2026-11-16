import { Account } from "@draftyak/protocol/entities/account";
import { fromBase64Url } from "@draftyak/protocol/scalars";
import { signStatement } from "@draftyak/protocol/sign";
import { parseStatement } from "@draftyak/protocol/statements";
import { afterEach, describe, expect, it } from "vitest";
import { restrictNativeAccountsForRestoreInTransaction } from "../../src/accounts/records.ts";
import { CHALLENGE_MIGRATIONS, ChallengeService } from "../../src/identity/challenges.ts";
import { newId } from "../../src/kernel/ids.ts";
import type { NativeProposalProviders } from "../../src/outbox/propose.ts";
import { APPROVAL_MIGRATIONS, SendApprovalVerifier } from "../../src/outbox/verifier.ts";
import type { SqlTransaction } from "../../src/store/store.ts";
import { type Fixture, fixture, native, type ProposalCandidate } from "./propose-fixture.ts";

interface Harness {
	readonly base: Fixture;
	readonly verifier: SendApprovalVerifier;
	readonly challenges: ChallengeService;
}
const opened: Harness[] = [];
afterEach(async () => {
	for (const h of opened.splice(0)) {
		h.challenges.lock();
		h.verifier.lock();
		await h.base.close();
	}
});

async function setup(providers?: (base: Fixture) => NativeProposalProviders): Promise<Harness> {
	const base = await fixture({
		extraMigrations: { challenges: CHALLENGE_MIGRATIONS, verifier: APPROVAL_MIGRATIONS },
	});
	let verifier: SendApprovalVerifier | undefined;
	let challenges: ChallengeService | undefined;
	try {
		if (providers) base.replaceTarget(providers(base));
		const f = base.native;
		verifier = new SendApprovalVerifier(f.store, f.audit, f.registry, f.authorizer, {
			identity: f.identity,
			target: base.target,
			masterKey: f.key,
			clock: base.clock,
		});
		challenges = new ChallengeService(f.store, f.audit, f.pins, f.registry, f.authorizer, {
			identity: f.identity,
			send: verifier,
			clock: base.clock,
		});
		const h = { base, verifier, challenges };
		opened.push(h);
		return h;
	} catch (error) {
		challenges?.lock();
		verifier?.lock();
		await base.close();
		throw error;
	}
}

function signedApproval(h: Harness, proposal: ProposalCandidate) {
	const challenge = h.challenges.issue(h.base.device.peer, {
		kind: "approval.send.v1",
		id: proposal.id,
		flagsAcked: [],
	});
	const bytes = fromBase64Url(challenge.statement);
	const statement = bytes && parseStatement(challenge.kind, bytes);
	if (!statement) throw new Error("DYTEST genuine send statement missing");
	const envelope = {
		statement: challenge.statement,
		signature: signStatement(challenge.kind, statement, h.base.device.privateKey),
		pin: native.PIN,
	};
	return {
		challenge,
		envelope,
		accept: () => h.challenges.accept(h.base.device.peer, challenge.kind, envelope),
	};
}

interface AuditRow {
	readonly seq: number;
	readonly action: string;
	readonly refs: string;
	readonly [key: string]: unknown;
}
function snapshot(h: Harness, outboxId: string) {
	return h.base.native.store.read((db) => {
		h.base.native.audit.verify(db);
		const auditMeta = db.get<{ audit_seq: number; audit_head: string; audit_tag: string }>(
			"SELECT audit_seq,audit_head,audit_tag FROM main.audit_meta WHERE singleton=1",
		);
		if (!auditMeta) throw new Error("DYTEST audit head missing");
		return {
			business: {
				accounts: db.all("SELECT * FROM main.accounts ORDER BY id"),
				outbox: db.all("SELECT * FROM main.outbox ORDER BY id"),
				approvals: db.all("SELECT * FROM main.approvals ORDER BY id"),
				drafts: db.all("SELECT * FROM main.native_drafts ORDER BY id"),
				revisions: db.all("SELECT * FROM main.native_draft_revisions ORDER BY draft_id,rev"),
				locks: db.all("SELECT * FROM main.native_draft_locks ORDER BY id"),
				events: db.all("SELECT * FROM main.events ORDER BY seq"),
				eventMeta: db.all("SELECT * FROM main.event_meta"),
			},
			challenge: db.get<{
				id: string;
				consumed_at: number | null;
				signature: string | null;
				burned_at: number | null;
			}>(
				"SELECT id,consumed_at,signature,burned_at FROM main.approval_challenges WHERE target_id=?",
				[outboxId],
			),
			audit: db.all<AuditRow>("SELECT * FROM main.audit_events ORDER BY seq"),
			auditMeta,
		};
	});
}

function refusedAtomically(h: Harness, outboxId: string, before: ReturnType<typeof snapshot>) {
	const after = snapshot(h, outboxId);
	expect(after.business).toEqual(before.business);
	expect(before.challenge).toMatchObject({ consumed_at: null, signature: null, burned_at: null });
	expect(after.challenge).toEqual({ ...before.challenge, burned_at: h.base.time.wall });
	// PIN verification commits first; a stale challenge is burned after native apply rolls back.
	expect(after.audit.slice(0, before.audit.length)).toEqual(before.audit);
	expect(after.audit).toHaveLength(before.audit.length + 2);
	expect(after.audit.slice(before.audit.length).map((row) => row.action)).toEqual([
		"pin.verified",
		"challenge.refused.stale",
	]);
	expect(after.audit.at(-1)).toMatchObject({
		action: "challenge.refused.stale",
		refs: JSON.stringify({ challenge: before.challenge?.id }),
	});
	expect(after.auditMeta.audit_seq).toBe(before.auditMeta.audit_seq + 2);
}

/** Controlled native STORAGE substitution, not a supported account transition or an authority grant. */
function substituteAccount(base: Fixture, accountId: string, change: (value: Account) => Account) {
	const current = base.readAccount(accountId);
	if (!current) throw new Error("DYTEST original native account missing");
	const replacement = Account.parse(change(current.account));
	base.accountDatabase.write((scope) => {
		const tx = base.accountDatabase.sql(scope);
		tx.run("DELETE FROM main.accounts WHERE id=?", [accountId]);
		base.accounts.create(scope, replacement);
	});
}

const accountChanges = [
	{
		name: "read-only",
		change: (base: Fixture, id: string) =>
			base.replaceAccount(id, (value) => ({ ...value, mode: "read_only" })),
	},
	{
		name: "disconnecting",
		change: (base: Fixture, id: string) =>
			base.replaceAccount(id, (value) => ({ ...value, status: "disconnecting" })),
	},
	{
		name: "retired",
		change: (base: Fixture, id: string) => {
			const previous = base.readAccount(id);
			if (!previous) throw new Error("DYTEST native account missing");
			base.accountDatabase.write((scope) => {
				const stopping = base.accounts.replace(
					scope,
					{ ...previous.account, status: "disconnecting" },
					previous.generation,
				);
				base.accounts.retire(scope, native.owner(base.native), id, stopping.generation);
			});
		},
	},
	{
		name: "another owner",
		change: (base: Fixture, id: string) =>
			substituteAccount(base, id, (value) => ({ ...value, userId: newId() })),
	},
	{
		name: "another channel",
		change: (base: Fixture, id: string) =>
			substituteAccount(base, id, (value) => {
				if (value.channel !== "email") throw new Error("DYTEST email account required");
				const { address: _address, ...common } = value;
				return { ...common, channel: "chat", teamId: "DYTEST-team", selfUserId: "DYTEST-self" };
			}),
	},
	{
		name: "another mailbox sender",
		change: (base: Fixture, id: string) =>
			substituteAccount(base, id, (value) => {
				if (value.channel !== "email") throw new Error("DYTEST email account required");
				return { ...value, address: "dytest-other@example.invalid" };
			}),
	},
];

describe("current account during genuine native approval", () => {
	it.each(["email", "chat"] as const)(
		"approves %s after a harmless account generation change and refuses replay",
		async (channel) => {
			const h = await setup();
			const proposal = h.base.proposal({ channel });
			const signed = signedApproval(h, proposal);
			const before = h.base.readAccount(proposal.binding.accountId);
			const changed = h.base.replaceAccount(proposal.binding.accountId, (value) => ({
				...value,
				alias: "dytest-renamed-account",
			}));
			expect(changed.generation).toBe((before?.generation ?? 0) + 1);
			await expect(signed.accept()).resolves.toMatchObject({
				kind: "approval.send.v1",
				id: proposal.id,
			});
			const accepted = snapshot(h, proposal.id);
			expect(h.base.target.write((tx) => h.base.target.get(tx, proposal.id)?.state)).toBe(
				"APPROVED",
			);
			expect(accepted.business.approvals).toHaveLength(1);
			expect(accepted.challenge).toMatchObject({
				consumed_at: h.base.time.wall,
				signature: signed.envelope.signature,
				burned_at: null,
			});
			await expect(signed.accept()).rejects.toMatchObject({ code: "CHALLENGE_INVALID" });
			expect(snapshot(h, proposal.id)).toEqual(accepted);
		},
	);

	it.each(accountChanges)(
		"refuses a previously reviewed proposal when its account becomes $name",
		async ({ change }) => {
			const h = await setup();
			const proposal = h.base.proposal();
			expect(h.verifier.review(h.base.device.peer, proposal.id)).toMatchObject({ id: proposal.id });
			const signed = signedApproval(h, proposal);
			change(h.base, proposal.binding.accountId);
			const before = snapshot(h, proposal.id);
			await expect(signed.accept()).rejects.toMatchObject({ code: "STALE" });
			refusedAtomically(h, proposal.id, before);
		},
	);

	it.each(["facts", "flags", "clock", "after-save"] as const)(
		"rolls back account tightening from the %s boundary inside proof application",
		async (stage) => {
			let watched: string | undefined;
			let applyTx: SqlTransaction | undefined;
			const postVoteReads: SqlTransaction[] = [];
			let restrictions = 0;
			const h = await setup((base) => {
				const original = base.providers;
				if (!original) throw new Error("DYTEST native providers missing");
				const tighten = (tx: SqlTransaction) => {
					if (restrictions === 0)
						restrictions += restrictNativeAccountsForRestoreInTransaction(base.accounts, tx);
				};
				base.clock.wallMs = () => {
					if (
						applyTx &&
						restrictions === 0 &&
						(stage === "clock" ||
							(stage === "after-save" &&
								applyTx.get<{ state: string }>("SELECT state FROM main.outbox WHERE id=?", [
									watched ?? "",
								])?.state === "APPROVED"))
					)
						tighten(applyTx);
					return base.time.wall;
				};
				return {
					facts: (tx, binding, current) => {
						const answer = original.facts(tx, binding, current);
						if (
							watched &&
							tx.get(
								"SELECT 1 FROM main.approvals WHERE outbox_id=? AND consumed_at IS NULL AND voided_at IS NULL",
								[watched],
							)
						) {
							postVoteReads.push(tx);
							// Public consumeVerifiedSendApproval calls item first; apply's own DATA read is second.
							if (postVoteReads.length === 2) {
								applyTx = tx;
								if (stage === "facts") tighten(tx);
							}
						}
						return answer;
					},
					flags: (tx, binding, current, snapshot) => {
						const answer = original.flags(tx, binding, current, snapshot);
						if (stage === "flags" && applyTx === tx) tighten(tx);
						return answer;
					},
				};
			});
			const proposal = h.base.proposal();
			watched = proposal.id;
			const signed = signedApproval(h, proposal);
			const before = snapshot(h, proposal.id);
			await expect(signed.accept()).rejects.toMatchObject({ code: "STALE" });
			expect(postVoteReads).toHaveLength(2);
			expect(postVoteReads[0]).toBe(postVoteReads[1]);
			expect(restrictions).toBe(1);
			applyTx = undefined;
			refusedAtomically(h, proposal.id, before);
		},
	);

	it("cannot retain a partial vote if the account tightens after the final DATA callback", async () => {
		let watched: string | undefined;
		let applyTx: SqlTransaction | undefined;
		let reads = 0;
		let restrictions = 0;
		const h = await setup((base) => {
			const original = base.providers;
			if (!original) throw new Error("DYTEST native providers missing");
			base.clock.wallMs = () => {
				if (applyTx && restrictions === 0)
					restrictions += restrictNativeAccountsForRestoreInTransaction(base.accounts, applyTx);
				return base.time.wall;
			};
			return {
				facts: (tx, binding, current) => {
					if (
						watched &&
						tx.get(
							"SELECT 1 FROM main.approvals WHERE outbox_id=? AND consumed_at IS NULL AND voided_at IS NULL",
							[watched],
						)
					) {
						if (++reads === 2) applyTx = tx;
					}
					return original.facts(tx, binding, current);
				},
				flags: original.flags,
			};
		});
		const proposal = h.base.proposal({ requiredApprovals: 2 });
		watched = proposal.id;
		const signed = signedApproval(h, proposal);
		const before = snapshot(h, proposal.id);
		await expect(signed.accept()).rejects.toMatchObject({ code: "STALE" });
		expect(reads).toBe(2);
		expect(restrictions).toBe(1);
		applyTx = undefined;
		refusedAtomically(h, proposal.id, before);
	});

	it("poisons the genuine proposal scope even when a current-account refusal is caught", async () => {
		const h = await setup();
		const proposal = h.base.proposal();
		const signed = signedApproval(h, proposal);
		const before = snapshot(h, proposal.id);
		let caught = false;
		expect(() =>
			h.base.target.write((tx) => {
				restrictNativeAccountsForRestoreInTransaction(h.base.accounts, tx);
				try {
					h.base.target.item(tx, proposal.id);
				} catch {
					caught = true;
				}
				tx.run("UPDATE main.accounts SET generation=generation+100 WHERE id=?", [
					proposal.binding.accountId,
				]);
			}),
		).toThrow();
		expect(caught).toBe(true);
		expect(snapshot(h, proposal.id)).toEqual(before);
		await expect(signed.accept()).resolves.toMatchObject({ id: proposal.id });
	});
});
