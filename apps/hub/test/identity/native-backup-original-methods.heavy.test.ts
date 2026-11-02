import { expect, it } from "vitest";
import { requireLoopbackNetworkGuard } from "../helpers/loopback-network.ts";
import type { NativeAccountApprovalsFixture } from "./native-account-approvals-fixture.ts";

requireLoopbackNetworkGuard();
const [
	{ NativeAccountModeOperations, ChallengeService, NativeOutboxProposals, SendApprovalVerifier },
	{ nativeAccountApprovalsFixture, issueAccountApproval, accountApprovalEvidence },
	{ closeSessionTransport },
] = await Promise.all([
	import("../../src/index.ts"),
	import("./native-account-approvals-fixture.ts"),
	import("../lifecycle/session-helpers.ts"),
]);

it("uses original owner-module methods for one genuine account approval and session cleanup", async () => {
	const methods = [
		[NativeAccountModeOperations.prototype, "open"],
		[NativeAccountModeOperations.prototype, "review"],
		[NativeAccountModeOperations.prototype, "lock"],
		[ChallengeService.prototype, "issue"],
		[ChallengeService.prototype, "accept"],
		[ChallengeService.prototype, "lock"],
		[NativeOutboxProposals.prototype, "destroy"],
		[SendApprovalVerifier.prototype, "lock"],
	] as const;
	const originals = methods.map(([prototype, method]) => {
		const descriptor = Object.getOwnPropertyDescriptor(prototype, method);
		if (!descriptor || typeof descriptor.value !== "function" || !descriptor.configurable)
			throw new Error("DYTEST original method fixture unavailable");
		return { prototype, method, descriptor };
	});
	const hits = new Array<number>(methods.length).fill(0);
	let f: NativeAccountApprovalsFixture | undefined;
	let closed = false;
	let phase = 0;
	let initiallyReadOnly = false;
	let sameReview = false;
	let unchangedBeforeAccept = false;
	let acceptedOperation = false;
	let fullMode = false;
	let generationDelta = -1;
	let accountAuditDelta = -1;
	let accountEventsDelta = -1;
	let appliedDelta = -1;
	let pinVerifiedDelta = -1;
	let pinFailuresDelta = -1;
	let storeClosed = false;
	let cleanupFailed = false;
	try {
		for (const [index, original] of originals.entries())
			Object.defineProperty(original.prototype, original.method, {
				...original.descriptor,
				value() {
					hits[index] = (hits[index] ?? 0) + 1;
					throw new Error("DYTEST mutable public method reached");
				},
			});
		try {
			// Modules are already loaded; the fixture has not constructed its lazy approval graph.
			f = await nativeAccountApprovalsFixture();
			const session = f.session;
			phase = 1;
			const before = f.current();
			initiallyReadOnly = before.account.mode === "read_only";
			const issued = issueAccountApproval(f);
			phase = 2;
			const reviewed = f.approvals.review(f.owner.device.peer, issued.review.id);
			sameReview =
				reviewed.kind === "account.mode-full" &&
				reviewed.id === issued.review.id &&
				reviewed.digest === issued.review.digest;
			const pending = f.current();
			unchangedBeforeAccept =
				pending.generation === before.generation && pending.account.mode === before.account.mode;
			const counts = accountApprovalEvidence(f);
			phase = 3;
			const accepted = await f.approvals.accept(f.owner.device.peer, issued.envelope);
			acceptedOperation = accepted.kind === "admin.v1" && accepted.id === issued.review.id;
			const after = f.current();
			fullMode = after.account.mode === "full";
			generationDelta = after.generation - before.generation;
			const applied = accountApprovalEvidence(f);
			accountAuditDelta = applied.accountAudit - counts.accountAudit;
			accountEventsDelta = applied.accountEvents - counts.accountEvents;
			appliedDelta = applied.adminApplied - counts.adminApplied;
			pinVerifiedDelta = applied.pinVerified - counts.pinVerified;
			pinFailuresDelta = applied.pinFailures - counts.pinFailures;
			phase = 4;
			session.store.read((tx) => session.audit.verify(tx));
			phase = 5;
			await f.close();
			closed = true;
			try {
				session.store.read((tx) => tx.get("SELECT 1 AS alive"));
			} catch (error) {
				storeClosed = error instanceof Error && /unavailable/.test(error.message);
			}
			phase = 6;
		} catch {
			// Only scalar observations reach matchers, including a deliberately reached sentinel.
		}
		// First material oracle for a fresh-public-method lookup, before classifying flow failure.
		expect(hits.reduce((sum, count) => sum + count, 0)).toBe(0);
		expect(phase).toBe(6);
		expect(initiallyReadOnly).toBe(true);
		expect(sameReview).toBe(true);
		expect(unchangedBeforeAccept).toBe(true);
		expect(acceptedOperation).toBe(true);
		expect(fullMode).toBe(true);
		expect(generationDelta).toBe(1);
		expect(accountAuditDelta).toBe(1);
		expect(accountEventsDelta).toBe(1);
		expect(appliedDelta).toBe(1);
		expect(pinVerifiedDelta).toBe(1);
		expect(pinFailuresDelta).toBe(0);
		expect(closed).toBe(true);
		expect(storeClosed).toBe(true);
	} finally {
		for (const original of originals.toReversed())
			try {
				Object.defineProperty(original.prototype, original.method, original.descriptor);
			} catch {
				cleanupFailed = true;
			}
		// Restore every prototype before fallback. A failed fixture close memo may already reject.
		if (f && !closed) {
			try {
				await f.owner.client.close();
			} catch {
				cleanupFailed = true;
			}
			try {
				await closeSessionTransport(f.native);
			} catch {
				cleanupFailed = true;
			}
			try {
				await f.session.close();
			} catch {
				cleanupFailed = true;
			}
			if (!cleanupFailed)
				try {
					await f.storage.remove();
				} catch {
					cleanupFailed = true;
				}
		}
	}
	if (cleanupFailed) throw new Error("DYTEST original method cleanup incomplete");
});
