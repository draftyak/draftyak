import { fromBase64Url } from "@draftyak/protocol/scalars";
import { signStatement } from "@draftyak/protocol/sign";
import { parseStatement } from "@draftyak/protocol/statements";
import { expect, it } from "vitest";
import { restrictNativeAccountsForRestoreInTransaction } from "../../src/accounts/records.ts";
import { CHALLENGE_MIGRATIONS, ChallengeService } from "../../src/identity/challenges.ts";
import { APPROVAL_MIGRATIONS, SendApprovalVerifier } from "../../src/outbox/verifier.ts";
import type { SqlTransaction } from "../../src/store/store.ts";
import { type Fixture, fixture, native } from "./propose-fixture.ts";

interface AuditRow {
	readonly seq: number;
	readonly action: string;
	readonly refs: string;
	readonly [key: string]: unknown;
}
function snapshot(f: Fixture, outboxId: string) {
	return f.native.store.read((db) => {
		f.native.audit.verify(db);
		const auditMeta = db.get<{ audit_seq: number }>(
			"SELECT audit_seq FROM main.audit_meta WHERE singleton=1",
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
				jobs: db.all("SELECT * FROM main.jobs ORDER BY seq"),
				events: db.all("SELECT * FROM main.events ORDER BY seq"),
				eventMeta: db.all("SELECT * FROM main.event_meta ORDER BY singleton"),
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
			auditSeq: auditMeta.audit_seq,
		};
	});
}

it("rolls back approval when the final challenge clock sample restricts the real account", async () => {
	const f = await fixture({
		extraMigrations: { challenges: CHALLENGE_MIGRATIONS, verifier: APPROVAL_MIGRATIONS },
	});
	let verifier: SendApprovalVerifier | undefined;
	let challenges: ChallengeService | undefined;
	let active: SqlTransaction | undefined;
	let watched: string | undefined;
	let armed = false;
	let restrictions = 0;
	let observedState: string | undefined;
	const monotonicMs = f.clock.monotonicMs;
	try {
		const providers = f.providers;
		if (!providers) throw new Error("DYTEST native DATA providers missing");
		f.replaceTarget({
			facts: (tx, binding, current) => {
				if (
					watched &&
					tx.get(
						"SELECT 1 FROM main.approvals WHERE outbox_id=? AND consumed_at IS NULL AND voided_at IS NULL",
						[watched],
					)
				) {
					active = tx;
					armed = true;
				}
				return providers.facts(tx, binding, current);
			},
			flags: providers.flags,
		});
		const store = f.native;
		verifier = new SendApprovalVerifier(
			store.store,
			store.audit,
			store.registry,
			store.authorizer,
			{
				identity: store.identity,
				target: f.target,
				masterKey: store.key,
				clock: f.clock,
			},
		);
		challenges = new ChallengeService(
			store.store,
			store.audit,
			store.pins,
			store.registry,
			store.authorizer,
			{
				identity: store.identity,
				send: verifier,
				clock: f.clock,
			},
		);
		const proposal = f.proposal();
		watched = proposal.id;
		const challenge = challenges.issue(f.device.peer, {
			kind: "approval.send.v1",
			id: proposal.id,
			flagsAcked: [],
		});
		const bytes = fromBase64Url(challenge.statement);
		const statement = bytes && parseStatement(challenge.kind, bytes);
		if (!statement) throw new Error("DYTEST genuine send statement missing");
		const envelope = {
			statement: challenge.statement,
			signature: signStatement(challenge.kind, statement, f.device.privateKey),
			pin: native.PIN,
		};
		const before = snapshot(f, proposal.id);
		f.clock.monotonicMs = () => {
			if (armed && active) {
				const state = active.get<{ state: string }>("SELECT state FROM main.outbox WHERE id=?", [
					proposal.id,
				])?.state;
				if (state === "APPROVED") {
					armed = false;
					observedState = state;
					restrictions += restrictNativeAccountsForRestoreInTransaction(f.accounts, active);
				}
			}
			return monotonicMs();
		};
		let result: unknown;
		let failure: unknown;
		try {
			result = await challenges.accept(f.device.peer, challenge.kind, envelope);
		} catch (error) {
			failure = error;
		} finally {
			active = undefined;
			armed = false;
			f.clock.monotonicMs = monotonicMs;
		}
		expect(observedState).toBe("APPROVED");
		expect(restrictions).toBe(1);
		expect(result).toBeUndefined();
		expect(failure).toMatchObject({
			code: "DEVICE_REFUSED",
			detail: "UNAVAILABLE",
			wire: "UNAVAILABLE",
		});
		const after = snapshot(f, proposal.id);
		expect(after.business).toEqual(before.business);
		expect(before.challenge).toMatchObject({ consumed_at: null, signature: null, burned_at: null });
		expect(after.challenge).toEqual(before.challenge);
		// PIN verification commits first; transient native unavailability does not burn the challenge.
		expect(after.audit.slice(0, before.audit.length)).toEqual(before.audit);
		expect(after.audit.slice(before.audit.length).map((row) => row.action)).toEqual([
			"pin.verified",
		]);
		expect(after.auditSeq).toBe(before.auditSeq + 1);
		await expect(challenges.accept(f.device.peer, challenge.kind, envelope)).resolves.toMatchObject(
			{
				kind: "approval.send.v1",
				id: proposal.id,
			},
		);
	} finally {
		active = undefined;
		f.clock.monotonicMs = monotonicMs;
		challenges?.lock();
		verifier?.lock();
		await f.close();
	}
});
