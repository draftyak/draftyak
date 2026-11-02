import { existsSync } from "node:fs";
import path from "node:path";
import type { OperationRequest } from "@draftyak/protocol/device-api";
import { jcsSha256 } from "@draftyak/protocol/hash";
import { fromBase64Url } from "@draftyak/protocol/scalars";
import { openStatement } from "@draftyak/protocol/sign";
import { AdminStatement } from "@draftyak/protocol/statements/admin";
import { afterEach, describe, expect, it } from "vitest";
import { requireLoopbackNetworkGuard } from "../helpers/loopback-network.ts";
import type { NativeAccountApprovalsFixture } from "./native-account-approvals-fixture.ts";

requireLoopbackNetworkGuard();
const { nativeAccountApprovalsFixture, issueAccountApproval, accountApprovalEvidence } =
	await import("./native-account-approvals-fixture.ts");
const fixtures: NativeAccountApprovalsFixture[] = [];

async function fixture(): Promise<NativeAccountApprovalsFixture> {
	const created = await nativeAccountApprovalsFixture();
	fixtures.push(created);
	return created;
}

afterEach(async () => {
	for (const f of fixtures.splice(0)) await f.close();
});

function settled(
	f: NativeAccountApprovalsFixture,
	id: string,
): {
	readonly state: string;
	readonly consumed: number | null;
	readonly signature: string | null;
} {
	return f.session.store.read((tx) => {
		const operation = tx.get<{ state: string }>(
			"SELECT state FROM main.native_admin_operations WHERE id=?",
			[id],
		);
		const challenge = tx.get<{ consumed_at: number | null; signature: string | null }>(
			"SELECT consumed_at,signature FROM main.native_admin_challenges WHERE target_id=?",
			[id],
		);
		if (!operation || !challenge) throw new Error("DYTEST native approval records missing");
		return {
			state: operation.state,
			consumed: challenge.consumed_at,
			signature: challenge.signature,
		};
	});
}

describe("original session native account approvals", () => {
	it("uses one immutable cached facade for an exact signed owner effect without widening purposes", async () => {
		const f = await fixture();
		expect(f.session.accountApprovals()).toBe(f.approvals);
		expect(Object.isFrozen(f.approvals)).toBe(true);
		expect(Object.keys(f.approvals).toSorted()).toEqual(["accept", "issue", "open", "review"]);
		expect(Reflect.set(f.approvals, "open", () => undefined)).toBe(false);
		expect(existsSync(path.join(f.storage.folder, "plugins"))).toBe(false);
		const before = f.current();
		const initial = accountApprovalEvidence(f);
		const deviceId = f.owner.device.id;
		if (!deviceId) throw new Error("DYTEST owner was not admitted");
		const unsupported: OperationRequest[] = [
			{ kind: "data.backup", ids: [] },
			{ kind: "plugin.install", ids: [f.account.account.id] },
			{ kind: "pair-confirm", ids: [deviceId], preset: "desktop" },
		];
		for (const request of unsupported)
			expect(() => f.approvals.open(f.owner.device.peer, request)).toThrow();
		expect(f.current()).toEqual(before);
		expect(accountApprovalEvidence(f)).toEqual(initial);

		const { review, challenge, envelope } = issueAccountApproval(f);
		expect(review.subject).toEqual({
			account: before.account.id,
			alias: before.account.alias,
			channel: "email",
			address: "dytest-owner@example.invalid",
			createdAt: before.account.createdAt,
		});
		expect(review.digest).toBe(jcsSha256(review.subject));
		expect(f.approvals.review(f.owner.device.peer, review.id)).toMatchObject({
			id: review.id,
			kind: "account.mode-full",
			digest: review.digest,
			subject: review.subject,
			expiresAt: review.expiresAt,
		});
		expect(challenge.kind).toBe("admin.v1");
		expect(envelope.statement).toBe(challenge.statement);
		const bytes = fromBase64Url(envelope.statement);
		if (!bytes) throw new Error("DYTEST challenge bytes missing");
		const statement = AdminStatement.parse(
			openStatement("admin.v1", bytes, envelope.signature, f.owner.client.signingKey),
		);
		expect(statement).toMatchObject({
			op: review.id,
			kind: "account.mode-full",
			digest: review.digest,
			hub: f.session.hid,
			device: deviceId,
			epoch: f.session.devices.currentState().epoch,
		});
		expect(f.current()).toEqual(before);
		const counts = accountApprovalEvidence(f);
		const accepting = f.approvals.accept(f.owner.device.peer, envelope);
		expect(accepting).toBeInstanceOf(Promise);
		await expect(accepting).resolves.toEqual({ kind: "admin.v1", id: review.id });
		expect(f.current()).toEqual({
			account: { ...before.account, mode: "full" },
			generation: before.generation + 1,
		});
		expect(accountApprovalEvidence(f)).toEqual({
			accountAudit: counts.accountAudit + 1,
			accountEvents: counts.accountEvents + 1,
			adminApplied: counts.adminApplied + 1,
			pinVerified: counts.pinVerified + 1,
			pinFailures: counts.pinFailures,
		});
		expect(settled(f, review.id)).toEqual({
			state: "applied",
			consumed: expect.any(Number),
			signature: envelope.signature,
		});
		const applied = accountApprovalEvidence(f);
		await expect(f.approvals.accept(f.owner.device.peer, envelope)).rejects.toThrow();
		expect(accountApprovalEvidence(f)).toEqual(applied);
		expect(f.current().generation).toBe(before.generation + 1);
		f.session.store.read((tx) => f.session.audit.verify(tx));
	});

	it("refuses another original session's genuine owner peer before PIN or account effects", async () => {
		const f = await fixture();
		const foreign = await fixture();
		const { review, envelope } = issueAccountApproval(f);
		const before = f.current();
		const counts = accountApprovalEvidence(f);
		const pending = settled(f, review.id);
		expect(foreign.session.store).not.toBe(f.session.store);
		expect(foreign.owner.client.transportSpkiSha256).not.toBe(f.owner.client.transportSpkiSha256);
		for (const call of [
			() =>
				f.approvals.open(foreign.owner.device.peer, {
					kind: "account.mode-full",
					ids: [f.account.account.id],
				}),
			() => f.approvals.review(foreign.owner.device.peer, review.id),
			() => f.approvals.issue(foreign.owner.device.peer, review.id),
		])
			expect(call).toThrow();
		await expect(f.approvals.accept(foreign.owner.device.peer, envelope)).rejects.toThrow();
		expect(f.current()).toEqual(before);
		expect(accountApprovalEvidence(f)).toEqual(counts);
		expect(settled(f, review.id)).toEqual(pending);
		await expect(f.approvals.accept(f.owner.device.peer, envelope)).resolves.toEqual({
			kind: "admin.v1",
			id: review.id,
		});
		expect(f.current().account.mode).toBe("full");
		expect(f.current().generation).toBe(before.generation + 1);
	});
});
