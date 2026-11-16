import { afterEach, describe, expect, it } from "vitest";
import type { NativeProposalProviders } from "../../src/outbox/propose.ts";
import type { SendApprovalPolicy } from "../../src/outbox/verifier-types.ts";
import { requireLoopbackNetworkGuard } from "../helpers/loopback-network.ts";

requireLoopbackNetworkGuard();
const { fixture, closeFixture, proposal, envelope, issue, counts, native } = await import(
	"../identity/challenges-fixture.ts"
);
const { SendApprovalVerifier, isVerifiedSendApproval, consumeVerifiedSendApproval } = await import(
	"../../src/outbox/verifier.ts"
);
const { ChallengeService, CHALLENGE_TTL_MS } = await import("../../src/identity/challenges.ts");
const { advanceEpochForRestore } = await import("../../src/identity/devices.ts");
const { ProposalError } = await import("../../src/outbox/propose-errors.ts");
const { renderLocalWallTime } = await import("@draftyak/protocol/schedule");
const fixtures: Awaited<ReturnType<typeof fixture>>[] = [];
async function setup(policy?: SendApprovalPolicy) {
	const f = await fixture(policy);
	fixtures.push(f);
	return f;
}
afterEach(async () => {
	for (const f of fixtures.splice(0)) await closeFixture(f);
});

describe("native send approval verifier", () => {
	it("refuses a native data callback that crosses the original challenge deadline", async () => {
		const f = await setup(),
			originalProviders = f.providers;
		if (!originalProviders) throw new Error("Missing labelled native test data providers");
		let watched: { outbox: string; draft: string } | undefined;
		let advance = false,
			jumped = false,
			reached = 0;
		const TEST_ONLY_CLOCK_DATA_PROVIDER: NativeProposalProviders = {
			facts: (tx, binding, current) => {
				const facts = originalProviders.facts(tx, binding, current);
				if (
					watched?.draft === binding.draftId &&
					tx.get(
						"SELECT 1 FROM main.approval_challenges WHERE target_id=? AND consumed_at IS NOT NULL LIMIT 1",
						[watched.outbox],
					)
				) {
					reached++;
					if (advance && !jumped) {
						jumped = true;
						f.time.wall += CHALLENGE_TTL_MS + 1;
						f.time.mono += CHALLENGE_TTL_MS + 1;
					}
				}
				return facts;
			},
			flags: originalProviders.flags,
		};
		const target = f.replaceTarget(TEST_ONLY_CLOCK_DATA_PROVIDER);
		const verifier = new SendApprovalVerifier(
			f.native.store,
			f.native.audit,
			f.native.registry,
			f.native.authorizer,
			{
				identity: f.native.identity,
				target,
				masterKey: f.native.key,
				clock: f.clock,
			},
		);
		const service = new ChallengeService(
			f.native.store,
			f.native.audit,
			f.native.pins,
			f.native.registry,
			f.native.authorizer,
			{
				identity: f.native.identity,
				send: verifier,
				clock: f.clock,
			},
		);
		try {
			const baseline = proposal(f);
			watched = { outbox: baseline.id, draft: baseline.binding.draftId };
			const first = service.issue(f.device.peer, {
				kind: "approval.send.v1",
				id: baseline.id,
				flagsAcked: [],
			});
			await expect(
				service.accept(f.device.peer, first.kind, envelope(f, first)),
			).resolves.toMatchObject({ id: baseline.id });
			expect(reached).toBeGreaterThan(0);
			expect(target.write((tx) => target.item(tx, baseline.id))?.state).toBe("APPROVED");
			expect(counts(f).approvals).toBe(1);
			watched = undefined;
			reached = 0;
			const pending = proposal(f);
			watched = { outbox: pending.id, draft: pending.binding.draftId };
			const challenge = service.issue(f.device.peer, {
				kind: "approval.send.v1",
				id: pending.id,
				flagsAcked: [],
			});
			advance = true;
			const [result] = await Promise.allSettled([
				service.accept(f.device.peer, challenge.kind, envelope(f, challenge)),
			]);
			expect(jumped).toBe(true);
			expect(reached).toBeGreaterThan(0);
			expect(result?.status).toBe("rejected");
			expect(counts(f).approvals).toBe(1);
			expect(target.write((tx) => target.item(tx, pending.id))?.state).toBe("PENDING_APPROVAL");
			expect(
				f.native.store.read((db) =>
					db.get<{ consumed_at: number | null }>(
						"SELECT consumed_at FROM main.approval_challenges WHERE statement=?",
						[Buffer.from(challenge.statement, "base64url")],
					),
				)?.consumed_at,
			).toBeNull();
		} finally {
			service.lock();
			verifier.lock();
		}
	});
	it("requires native review authority and refuses unknown records", async () => {
		const f = await setup(),
			p = proposal(f);
		expect(() => f.verifier.review({} as never, p.id)).toThrow("DEVICE_REFUSED");
		expect(() => f.verifier.review(f.device.peer, p.binding.draftId)).toThrow("NOT_FOUND");
		expect(f.verifier.review(f.device.peer, p.id)).toMatchObject({
			id: p.id,
			contentHash: p.record.contentHash,
		});
		// Restore orchestration stand-in: native epoch/bootstrap leaves the existing device pending.
		f.native.store.write((tx) => {
			tx.run("DELETE FROM main.approval_pins WHERE user_id=?", [native.owner(f.native)]);
			advanceEpochForRestore(f.native.registry, tx);
		});
		await native.bootstrap(f.native);
		expect(() => f.verifier.review(f.device.peer, p.id)).toThrow("DEVICE_REFUSED");
	});
	it("poisons the native work scope when a refused operation is caught", async () => {
		const f = await setup(),
			p = proposal(f);
		expect(() =>
			f.target.write((tx, scope) => {
				tx.run("UPDATE main.approval_pins SET failures=1 WHERE user_id=?", [
					native.owner(f.native),
				]);
				try {
					f.verifier.applySend(tx, scope, {} as never);
				} catch {
					/* Caller tries to commit despite refusal. */
				}
			}),
		).toThrow();
		expect(counts(f).failures).toBe(0);
		expect(f.target.write((tx) => f.target.item(tx, p.id))?.state).toBe("PENDING_APPROVAL");
		const expired = f.target.write((tx, scope) => ({ tx, scope }));
		expect(() => f.verifier.applySend(expired.tx, expired.scope, {} as never)).toThrow(
			"UNAVAILABLE",
		);
	});
	it("binds challenge calls to initialized original verifier methods", async () => {
		const f = await setup(),
			p = proposal(f),
			original = SendApprovalVerifier.prototype.prepareSend;
		let service: InstanceType<typeof ChallengeService> | undefined;
		try {
			SendApprovalVerifier.prototype.prepareSend = () => {
				throw new Error("DYTEST replaced prototype");
			};
			service = new ChallengeService(
				f.native.store,
				f.native.audit,
				f.native.pins,
				f.native.registry,
				f.native.authorizer,
				{ identity: f.native.identity, send: f.verifier, clock: f.clock },
			);
			expect(
				service.issue(f.device.peer, { kind: "approval.send.v1", id: p.id, flagsAcked: [] }),
			).toMatchObject({ id: p.id });
		} finally {
			SendApprovalVerifier.prototype.prepareSend = original;
			service?.lock();
		}
	});
	it("requires acknowledgements before issuing authority and preserves their exact hash", async () => {
		const f = await setup(),
			p = proposal(f, { flags: [{ code: "EXTERNAL_LINK", severity: "ack" }] });
		expect(() => issue(f, p.id)).toThrow("ACK_REQUIRED");
		expect(counts(f).challenges).toBe(0);
		const challenge = issue(f, p.id, ["EXTERNAL_LINK"]);
		expect(JSON.parse(Buffer.from(challenge.statement, "base64url").toString())).toMatchObject({
			flagsAcked: ["EXTERNAL_LINK"],
			flagsHash: p.record.flagsHash,
			contentHash: p.record.contentHash,
		});
		await expect(
			f.challenges.accept(f.device.peer, challenge.kind, envelope(f, challenge)),
		).resolves.toMatchObject({ id: p.id });
	});
	it("stores the owner vote without passing a two-user threshold or counting it twice", async () => {
		const f = await setup(),
			p = proposal(f, { requiredApprovals: 2 }),
			challenge = issue(f, p.id);
		await f.challenges.accept(f.device.peer, challenge.kind, envelope(f, challenge));
		expect(f.target.write((db) => f.target.item(db, p.id))?.state).toBe("PENDING_APPROVAL");
		expect(counts(f).approvals).toBe(1);
		expect(() => issue(f, p.id)).toThrow("STALE");
		expect(f.revisions.current(p.binding).lockId).not.toBeNull();
	});
	it("lapses an old immediate vote and permits a fresh owner approval without duplicates", async () => {
		const f = await setup(),
			p = proposal(f, { requiredApprovals: 2 }),
			first = issue(f, p.id);
		await f.challenges.accept(f.device.peer, first.kind, envelope(f, first));
		f.time.wall += 900_000 - 10_000 + 1;
		f.time.mono += 900_000 - 10_000 + 1;
		const second = issue(f, p.id);
		await f.challenges.accept(f.device.peer, second.kind, envelope(f, second));
		expect(counts(f).approvals).toBe(2);
		expect(
			f.native.store.read((db) =>
				db.get<{ n: number }>(
					"SELECT COUNT(*) AS n FROM main.approvals WHERE void_reason='missed'",
				),
			)?.n,
		).toBe(1);
		expect(native.auditActions(f.native)).toContain("approval.lapsed");
	});
	it("does not let another module's audit reference hide a valid approval", async () => {
		const f = await setup(),
			p = proposal(f, { requiredApprovals: 2 }),
			challenge = issue(f, p.id);
		await f.challenges.accept(f.device.peer, challenge.kind, envelope(f, challenge));
		const approval = f.native.store.read((db) =>
			db.get<{ id: string }>("SELECT id FROM main.approvals WHERE outbox_id=?", [p.id]),
		)?.id;
		if (!approval) throw new Error("Missing native vote");
		const { newId } = await import("../../src/kernel/ids.ts");
		f.native.store.write((tx) =>
			f.native.audit.append(tx, {
				id: newId(),
				at: f.time.wall,
				action: "outbox.observed",
				actor: { kind: "hub", id: null },
				refs: { approval },
			}),
		);
		expect(() => issue(f, p.id)).toThrow("STALE");
		expect(counts(f).approvals).toBe(1);
	});
	it.each(["America/New_York", "Europe/London", "Australia/Lord_Howe"])(
		"binds the native scheduled approval window in %s",
		async (zone) => {
			const f = await setup(),
				notBefore = Math.ceil((f.time.wall + 60_000) / 60_000) * 60_000;
			const schedule = {
				kind: "at" as const,
				notBefore,
				zone,
				localWallTime: renderLocalWallTime(notBefore, zone),
				latenessSec: 900 as const,
				holdIfNewInbound: true,
			};
			const p = proposal(f, { schedule }),
				challenge = issue(f, p.id),
				statement = JSON.parse(Buffer.from(challenge.statement, "base64url").toString());
			expect(statement).toMatchObject({ notBefore, deliverBy: notBefore + 900_000 });
			await f.challenges.accept(f.device.peer, challenge.kind, envelope(f, challenge));
			expect(f.target.write((db) => f.target.item(db, p.id))?.state).toBe("SCHEDULED");
		},
	);
	it("rechecks a late scheduled approval after the PIN and never turns it into an immediate send", async () => {
		let late = () => {};
		const f = await setup({
			id: "DYTEST advance",
			evaluate: async () => {
				late();
				return { kind: "require", approvals: 1 };
			},
		});
		const notBefore = Math.ceil((f.time.wall + 60_000) / 60_000) * 60_000,
			zone = "America/New_York";
		const p = proposal(f, {
				schedule: {
					kind: "at",
					notBefore,
					zone,
					localWallTime: renderLocalWallTime(notBefore, zone),
					latenessSec: 900,
					holdIfNewInbound: false,
				},
			}),
			challenge = issue(f, p.id);
		late = () => {
			f.time.wall = notBefore - 9_999;
		};
		await expect(
			f.challenges.accept(f.device.peer, challenge.kind, envelope(f, challenge)),
		).rejects.toMatchObject({ code: "STALE" });
		expect(counts(f).approvals).toBe(0);
		expect(f.target.write((db) => f.target.item(db, p.id))?.state).toBe("PENDING_APPROVAL");
	});
	it("times out a nonsettling policy through the clock", async () => {
		const f = await setup({ id: "DYTEST timeout", evaluate: () => new Promise(() => {}) }),
			p = proposal(f),
			challenge = issue(f, p.id);
		await expect(
			f.challenges.accept(f.device.peer, challenge.kind, envelope(f, challenge)),
		).rejects.toMatchObject({ code: "POLICY_DENIED" });
		expect(counts(f).approvals).toBe(0);
	});
	it("consumes the PIN proof in the accepting transaction after a credential version change", async () => {
		let change = () => {};
		const f = await setup({
			id: "DYTEST changed credential",
			evaluate: async () => {
				change();
				return { kind: "require", approvals: 1 };
			},
		});
		const p = proposal(f),
			challenge = issue(f, p.id);
		change = () =>
			f.native.store.write((tx) =>
				tx.run("UPDATE main.approval_pins SET version=version+1 WHERE user_id=?", [
					native.owner(f.native),
				]),
			);
		await expect(
			f.challenges.accept(f.device.peer, challenge.kind, envelope(f, challenge)),
		).rejects.toMatchObject({ code: "PIN_REFUSED", detail: "PIN_CHANGED" });
		expect(counts(f).approvals).toBe(0);
		expect(
			f.native.store.read((db) =>
				db.get<{ consumed_at: number | null }>(
					"SELECT consumed_at FROM main.approval_challenges WHERE statement=?",
					[Buffer.from(challenge.statement, "base64url")],
				),
			)?.consumed_at,
		).toBeNull();
	});
	it("rolls back challenge, vote and audit when the final native target update fails", async () => {
		let failApply = () => {};
		const f = await setup({
			id: "DYTEST lock race",
			evaluate: async () => {
				failApply();
				return { kind: "require", approvals: 1 };
			},
		});
		const p = proposal(f),
			challenge = issue(f, p.id);
		failApply = () =>
			f.native.store.write((tx) =>
				tx.run("UPDATE main.dytest_challenge_faults SET outbox_state=1 WHERE singleton=1"),
			);
		await expect(
			f.challenges.accept(f.device.peer, challenge.kind, envelope(f, challenge)),
		).rejects.toMatchObject({ code: "STALE" });
		expect(counts(f).approvals).toBe(0);
		expect(
			f.native.store.read((db) =>
				db.get<{ consumed_at: number | null }>(
					"SELECT consumed_at FROM main.approval_challenges WHERE statement=?",
					[Buffer.from(challenge.statement, "base64url")],
				),
			)?.consumed_at,
		).toBeNull();
		expect(native.auditActions(f.native)).not.toContain("approval.accepted");
		expect(native.auditActions(f.native)).toContain("challenge.refused.stale");
		expect(f.target.write((db) => f.target.item(db, p.id))?.state).toBe("PENDING_APPROVAL");
	});
	it("refuses structural targets, forged approvals and edited authenticated approval rows", async () => {
		const f = await setup(),
			fake = Object.freeze({});
		expect(isVerifiedSendApproval(fake)).toBe(false);
		expect(
			() =>
				new SendApprovalVerifier(
					f.native.store,
					f.native.audit,
					f.native.registry,
					f.native.authorizer,
					{ identity: f.native.identity, masterKey: f.native.key, target: {} as never },
				),
		).toThrow("UNAVAILABLE");
		let proofRefusal: unknown;
		try {
			f.target.write((tx, scope) =>
				consumeVerifiedSendApproval(fake as never, tx, scope, f.target),
			);
		} catch (error) {
			proofRefusal = error;
		}
		expect(proofRefusal).toBeInstanceOf(ProposalError);
		expect(proofRefusal).toMatchObject({ code: "PROPOSAL_STALE" });
		const p = proposal(f, { requiredApprovals: 2 }),
			challenge = issue(f, p.id);
		await f.challenges.accept(f.device.peer, challenge.kind, envelope(f, challenge));
		f.native.store.write((tx) =>
			tx.run("UPDATE main.approvals SET mac=? WHERE outbox_id=?", ["0".repeat(64), p.id]),
		);
		expect(() => issue(f, p.id)).toThrow("UNAVAILABLE");
		expect(counts(f).approvals).toBe(1);
	});
	it("keeps challenge and approval facts immutable in the native schema", async () => {
		const f = await setup(),
			p = proposal(f, { requiredApprovals: 2 }),
			challenge = issue(f, p.id);
		expect(() =>
			f.native.store.write((tx) =>
				tx.run("UPDATE main.approval_challenges SET epoch=epoch+1 WHERE statement=?", [
					Buffer.from(challenge.statement, "base64url"),
				]),
			),
		).toThrow();
		await f.challenges.accept(f.device.peer, challenge.kind, envelope(f, challenge));
		expect(() =>
			f.native.store.write((tx) =>
				tx.run("UPDATE main.approvals SET content_hash=? WHERE outbox_id=?", [
					"b".repeat(64),
					p.id,
				]),
			),
		).toThrow();
		// History immutability does not prevent the separate owning account purge.
		expect(
			f.native.store.write((tx) => tx.run("DELETE FROM main.approvals WHERE outbox_id=?", [p.id]))
				.changes,
		).toBe(1);
	});
	it("preserves the longest plugin data class on challenge and approval rows", async () => {
		const f = await setup(),
			dataClass = `${"x".repeat(32)}.metadata`,
			p = proposal(f, { dataClass }),
			challenge = issue(f, p.id);
		await f.challenges.accept(f.device.peer, challenge.kind, envelope(f, challenge));
		expect(
			f.native.store.read((db) =>
				db.get<{ data_class: string }>("SELECT data_class FROM main.approvals WHERE outbox_id=?", [
					p.id,
				]),
			)?.data_class,
		).toBe(dataClass);
		expect(
			f.native.store.read((db) =>
				db.get<{ data_class: string }>(
					"SELECT data_class FROM main.approval_challenges WHERE statement=?",
					[Buffer.from(challenge.statement, "base64url")],
				),
			)?.data_class,
		).toBe(dataClass);
	});
});
