import { canonicalize } from "@draftyak/protocol/jcs";
import { describe, expect, it } from "vitest";
import { newId } from "../../src/kernel/ids.ts";
import type { EgressPolicy } from "../../src/plugins/broker/network/index.ts";
import {
	PROVIDER_CONSENT_VERSION,
	type ProviderConsentTarget,
	ProviderPolicyError,
	providerConsentPinScope,
} from "../../src/policy/consent.ts";
import { providerConsentFixture } from "./provider-consent-fixture.ts";

type Fixture = Awaited<ReturnType<typeof providerConsentFixture>>;
const ACK = Object.freeze({ providerNamed: true, trainingOffAcknowledged: true });
// Literal IP classification takes the production resolver's isIP branch, never DNS or a socket.
// This is network policy DATA, not a native grant or a claim of a local provider mode.
const NETWORK: EgressPolicy = Object.freeze({
	deniedAddresses: Object.freeze([]),
	deniedPorts: Object.freeze([]),
	allowLocal: true,
});

async function withFixture(work: (fixture: Fixture) => void | Promise<void>): Promise<void> {
	const fixture = await providerConsentFixture();
	const outcome = await Promise.resolve()
		.then(() => work(fixture))
		.then(
			() => ({ ok: true as const }),
			(error: unknown) => ({ ok: false as const, error }),
		);
	try {
		await fixture.close();
	} catch (cleanupError) {
		if (!outcome.ok)
			throw new AggregateError([outcome.error, cleanupError], "Provider consent cleanup failed");
		throw cleanupError;
	}
	if (!outcome.ok) throw outcome.error;
}

function target(fixture: Fixture): ProviderConsentTarget {
	return {
		accountId: fixture.account.account.id,
		// A synthetic profile identifier is configuration DATA; it grants no plugin authority.
		instanceId: newId(),
		profileId: "dytest-compatible",
		provider: "slack",
		providerName: "DYTEST Compatible",
		endpoint: "https://8.8.8.8/v1/chat/completions",
		training: "no-train",
	};
}

function issueProof(fixture: Fixture, selected: ProviderConsentTarget) {
	return fixture.pins.verify(
		fixture.account.account.userId,
		fixture.pin,
		providerConsentPinScope("set", selected, ACK),
	);
}

async function setConsent(fixture: Fixture, selected: ProviderConsentTarget) {
	const proof = await issueProof(fixture, selected);
	fixture.consent.set(fixture.peer, selected, ACK, proof);
	return proof;
}

function authorize(fixture: Fixture, selected: ProviderConsentTarget) {
	return fixture.consent.authorize(fixture.peer, selected, NETWORK, new AbortController().signal);
}

interface SavedRow {
	readonly payload: string;
	readonly mac: string;
}
function saved(fixture: Fixture, selected: ProviderConsentTarget): SavedRow | undefined {
	return fixture.database.write((scope) =>
		fixture.database
			.sql(scope)
			.get<SavedRow>(
				"SELECT payload,mac FROM main.native_provider_consents WHERE account_id=? AND instance_id=?",
				[selected.accountId, selected.instanceId],
			),
	);
}

function providerAudit(fixture: Fixture, selected: ProviderConsentTarget) {
	return fixture.database.write((scope) => {
		const sql = fixture.database.sql(scope);
		const refs = canonicalize({ account: selected.accountId, instance: selected.instanceId });
		const row = sql.get<{ count: number }>(
			"SELECT count(*) AS count FROM main.audit_events WHERE action IN ('provider_consent.set','provider_consent.revoke') AND refs=?",
			[refs],
		);
		if (!row || !Number.isSafeInteger(row.count) || row.count < 0)
			throw new Error("DYTEST provider audit count missing");
		return {
			count: row.count,
			latest: sql.get<{ action: string; actor: string; seq: number }>(
				"SELECT action,actor_id AS actor,seq FROM main.audit_events WHERE action IN ('provider_consent.set','provider_consent.revoke') AND refs=? ORDER BY seq DESC LIMIT 1",
				[refs],
			),
		};
	});
}

describe("provider consent with a genuine native peer", () => {
	it("preserves a real admin and draft grant across the current account transaction read", async () => {
		await withFixture((fixture) => {
			const observed = fixture.database.write((scope) => {
				const sql = fixture.database.sql(scope);
				const admin = fixture.authorizer.requirePeerDevice(sql, fixture.peer, "admin");
				const account = fixture.accounts.getInTransaction(
					sql,
					admin.ownerUserId,
					fixture.account.account.id,
				);
				expect(account).toEqual(fixture.account);
				fixture.authorizer.assertCurrentGrant(sql, admin);
				const draft = fixture.authorizer.requirePeerDevice(sql, fixture.peer, "draft");
				fixture.authorizer.assertCurrentGrant(sql, admin);
				fixture.authorizer.assertCurrentGrant(sql, draft);
				return {
					deviceId: admin.deviceId,
					ownerId: admin.ownerUserId,
					epoch: admin.epoch,
					draftOwner: draft.ownerUserId,
				};
			});
			expect(observed.ownerId).toBe(fixture.account.account.userId);
			expect(observed.draftOwner).toBe(observed.ownerId);
			expect(observed.epoch).toBe(fixture.registry.currentState().epoch);
			expect(observed.deviceId).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/);
		});
	});

	it("sets real PIN-backed Slack consent and revalidates its exact issued cloud classification", async () => {
		await withFixture(async (fixture) => {
			const selected = target(fixture);
			await expect(authorize(fixture, selected)).rejects.toBeInstanceOf(ProviderPolicyError);
			const proof = await setConsent(fixture, selected);
			const row = saved(fixture, selected);
			if (!row) throw new Error("DYTEST consent was not persisted");
			expect(row.mac).toMatch(/^[a-f0-9]{64}$/);
			expect(JSON.parse(row.payload)).toMatchObject({
				target: selected,
				acknowledgement: ACK,
				version: PROVIDER_CONSENT_VERSION,
				ownerId: fixture.account.account.userId,
				accountGeneration: fixture.account.generation,
				revoked: false,
			});
			const audit = providerAudit(fixture, selected);
			expect(audit).toMatchObject({ count: 1, latest: { action: "provider_consent.set" } });
			// No helper discards this proof: refusal depends on production consumption itself.
			expect(() => fixture.consent.set(fixture.peer, selected, ACK, proof)).toThrow(
				ProviderPolicyError,
			);
			expect(saved(fixture, selected)).toEqual(row);
			expect(providerAudit(fixture, selected)).toEqual(audit);
			const classification = await authorize(fixture, selected);
			expect(classification).toMatchObject({
				endpoint: selected.endpoint,
				resolution: { hostname: "8.8.8.8", destination: "cloud" },
				answers: [{ address: "8.8.8.8", family: 4 }],
			});
			fixture.database.write((scope) =>
				fixture.consent.revalidate(scope, fixture.peer, selected, classification),
			);
		});
	});

	it("consumes a real proof bound to the wrong target without creating a consent or audit record", async () => {
		await withFixture(async (fixture) => {
			const selected = target(fixture);
			const different = { ...selected, profileId: "dytest-different-profile" };
			const proof = await issueProof(fixture, selected);
			const before = providerAudit(fixture, selected);
			expect(() => fixture.consent.set(fixture.peer, different, ACK, proof)).toThrow(
				ProviderPolicyError,
			);
			expect(() => fixture.consent.set(fixture.peer, selected, ACK, proof)).toThrow(
				ProviderPolicyError,
			);
			expect(saved(fixture, selected)).toBeUndefined();
			expect(providerAudit(fixture, selected)).toEqual(before);
			await setConsent(fixture, selected);
			const classification = await authorize(fixture, selected);
			fixture.database.write((scope) =>
				fixture.consent.revalidate(scope, fixture.peer, selected, classification),
			);
		});
	});

	it("binds revalidation to the exact service-issued object and unchanged target", async () => {
		await withFixture(async (fixture) => {
			const selected = target(fixture);
			await setConsent(fixture, selected);
			const classification = await authorize(fixture, selected);
			fixture.database.write((scope) =>
				fixture.consent.revalidate(scope, fixture.peer, selected, classification),
			);
			expect(() =>
				fixture.database.write((scope) =>
					fixture.consent.revalidate(scope, fixture.peer, selected, { ...classification }),
				),
			).toThrow(ProviderPolicyError);
			expect(() =>
				fixture.database.write((scope) =>
					fixture.consent.revalidate(
						scope,
						fixture.peer,
						{ ...selected, profileId: "dytest-other" },
						classification,
					),
				),
			).toThrow(ProviderPolicyError);
			fixture.database.write((scope) =>
				fixture.consent.revalidate(scope, fixture.peer, selected, classification),
			);
		});
	});

	it("requires a fresh real opt-in after actual account generation replacement", async () => {
		await withFixture(async (fixture) => {
			const selected = target(fixture);
			await setConsent(fixture, selected);
			const old = await authorize(fixture, selected);
			const replacement = fixture.database.write((scope) =>
				fixture.accounts.replace(
					scope,
					{
						...fixture.account.account,
						alias: "dytest-policy-generation-2",
					},
					fixture.account.generation,
				),
			);
			expect(replacement.generation).toBe(fixture.account.generation + 1);
			expect(() =>
				fixture.database.write((scope) =>
					fixture.consent.revalidate(scope, fixture.peer, selected, old),
				),
			).toThrow(ProviderPolicyError);
			await expect(authorize(fixture, selected)).rejects.toBeInstanceOf(ProviderPolicyError);
			await setConsent(fixture, selected);
			const current = await authorize(fixture, selected);
			fixture.database.write((scope) =>
				fixture.consent.revalidate(scope, fixture.peer, selected, current),
			);
			expect(() =>
				fixture.database.write((scope) =>
					fixture.consent.revalidate(scope, fixture.peer, selected, old),
				),
			).toThrow(ProviderPolicyError);
		});
	});

	it("revokes without another PIN and invalidates both old issuance and fresh cloud authorization", async () => {
		await withFixture(async (fixture) => {
			const selected = target(fixture);
			await setConsent(fixture, selected);
			const old = await authorize(fixture, selected);
			fixture.consent.revoke(fixture.peer, selected);
			expect(providerAudit(fixture, selected)).toMatchObject({
				count: 2,
				latest: { action: "provider_consent.revoke" },
			});
			expect(() =>
				fixture.database.write((scope) =>
					fixture.consent.revalidate(scope, fixture.peer, selected, old),
				),
			).toThrow(ProviderPolicyError);
			await expect(authorize(fixture, selected)).rejects.toBeInstanceOf(ProviderPolicyError);
			await setConsent(fixture, selected);
			const current = await authorize(fixture, selected);
			fixture.database.write((scope) =>
				fixture.consent.revalidate(scope, fixture.peer, selected, current),
			);
		});
	});

	it("rejects replay of its own earlier valid consent row after genuine audited revocation", async () => {
		await withFixture(async (fixture) => {
			const selected = target(fixture);
			await setConsent(fixture, selected);
			await authorize(fixture, selected);
			const earlier = saved(fixture, selected);
			if (!earlier) throw new Error("DYTEST original consent row missing");
			fixture.consent.revoke(fixture.peer, selected);
			const revokedAudit = providerAudit(fixture, selected);
			expect(revokedAudit.latest?.action).toBe("provider_consent.revoke");
			// Replay only DATA produced by the real set operation; owner/device rights stay untouched.
			fixture.database.write((scope) => {
				expect(
					fixture.database
						.sql(scope)
						.run(
							"UPDATE main.native_provider_consents SET payload=?,mac=? WHERE account_id=? AND instance_id=?",
							[earlier.payload, earlier.mac, selected.accountId, selected.instanceId],
						).changes,
				).toBe(1);
			});
			expect(saved(fixture, selected)).toEqual(earlier);
			expect(providerAudit(fixture, selected)).toEqual(revokedAudit);
			await expect(authorize(fixture, selected)).rejects.toBeInstanceOf(ProviderPolicyError);
		});
	});

	it("refuses the same original peer and issuance after its actual joined transport close", async () => {
		await withFixture(async (fixture) => {
			const selected = target(fixture);
			await setConsent(fixture, selected);
			const classification = await authorize(fixture, selected);
			await fixture.closePeer();
			expect(() =>
				fixture.database.write((scope) =>
					fixture.authorizer.requirePeerDevice(fixture.database.sql(scope), fixture.peer, "admin"),
				),
			).toThrow();
			expect(() =>
				fixture.database.write((scope) =>
					fixture.consent.revalidate(scope, fixture.peer, selected, classification),
				),
			).toThrow(ProviderPolicyError);
			await expect(authorize(fixture, selected)).rejects.toBeInstanceOf(ProviderPolicyError);
		});
	});

	it("retires issued classifications when the original consent service is destroyed", async () => {
		await withFixture(async (fixture) => {
			const selected = target(fixture);
			await setConsent(fixture, selected);
			const classification = await authorize(fixture, selected);
			fixture.consent.destroy();
			expect(() =>
				fixture.database.write((scope) =>
					fixture.consent.revalidate(scope, fixture.peer, selected, classification),
				),
			).toThrow(ProviderPolicyError);
			await expect(authorize(fixture, selected)).rejects.toBeInstanceOf(ProviderPolicyError);
		});
	});
});
