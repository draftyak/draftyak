import type { Challenge, OperationReview, SignedEnvelope } from "@draftyak/protocol/device-api";
import { afterEach, describe, expect, it } from "vitest";
import type { ChallengeService as Challenges } from "../../src/identity/challenges.ts";
import { requireLoopbackNetworkGuard } from "../helpers/loopback-network.ts";
import type { FakeDeviceConnection } from "../support/fake-device/harness.ts";
import type { FakeDevice } from "../support/fake-device/index.ts";
import type { Fixture as AdminFixture } from "./admin-operations-fixture.ts";

requireLoopbackNetworkGuard();
const { fixture: nativeAdminFixture, native } = await import("./admin-operations-fixture.ts");
const { ChallengeError, ChallengeService } = await import("../../src/identity/challenges.ts");
const { connectFakeDevice } = await import("../support/fake-device/harness.ts");
const { FakeDeviceError } = await import("../support/fake-device/index.ts");
const { cliConfirmPinScope } = await import("../../src/authz/scopes.ts");
const { NativeAdminError } = await import("../../src/identity/admin-operations.ts");
const { nativePairingWindows } = await import("../../src/lifecycle/session.ts");
const { originalSessionAdminFixture, closeOriginalSessionAdminFixtures, pairingExchange } =
	await import("./original-session-admin-fixture.ts");
const { registerTransportCases } = await import("../support/fake-device/transport.cases.ts");

registerTransportCases();

interface Fixture extends AdminFixture {
	readonly service: Challenges;
	readonly owner: FakeDeviceConnection;
	readonly clients: FakeDevice[];
}
type ApprovalFixture = Pick<
	Fixture,
	"native" | "device" | "account" | "operations" | "service" | "owner"
>;
interface Evidence {
	readonly accountAudit: number;
	readonly accountEvents: number;
	readonly pinVerified: number;
	readonly pinFailures: number;
}
interface Settlement {
	readonly state: string;
	readonly consumed: number | null;
	readonly signature: string | null;
}
const fixtures: Fixture[] = [];

async function fixture(): Promise<Fixture> {
	const base = await nativeAdminFixture();
	let service: Challenges | undefined;
	try {
		service = new ChallengeService(
			base.native.store,
			base.native.audit,
			base.native.pins,
			base.native.registry,
			base.native.authorizer,
			{
				identity: base.native.identity,
				clock: base.clock,
				send: base.send,
				admin: base.operations,
			},
		);
		const owner = await connectFakeDevice(base.native, base.device);
		const result = { ...base, service, owner, clients: [owner.client] };
		fixtures.push(result);
		return result;
	} catch (error) {
		service?.lock();
		await base.close();
		throw error;
	}
}
afterEach(async () => {
	for (const f of fixtures.splice(0)) {
		f.service.lock();
		try {
			await Promise.all(f.clients.map((client) => client.close()));
		} finally {
			await f.close();
		}
	}
});
afterEach(closeOriginalSessionAdminFixtures);
function evidence(f: ApprovalFixture): Evidence {
	return f.native.store.read((tx) => ({
		accountAudit:
			tx.get<{ n: number }>(
				"SELECT count(*) AS n FROM main.audit_events WHERE action='account.changed'",
			)?.n ?? 0,
		accountEvents:
			tx.get<{ n: number }>("SELECT count(*) AS n FROM main.events WHERE kind='accounts.changed'")
				?.n ?? 0,
		pinVerified:
			tx.get<{ n: number }>(
				"SELECT count(*) AS n FROM main.audit_events WHERE action='pin.verified'",
			)?.n ?? 0,
		pinFailures:
			tx.get<{ failures: number }>("SELECT failures FROM main.approval_pins WHERE user_id=?", [
				native.owner(f.native),
			])?.failures ?? 0,
	}));
}
function settled(f: ApprovalFixture, operation: string): Settlement {
	return f.native.store.read((tx) => {
		const row = tx.get<{ state: string }>(
			"SELECT state FROM main.native_admin_operations WHERE id=?",
			[operation],
		);
		const challenge = tx.get<{ consumed_at: number | null; signature: string | null }>(
			"SELECT consumed_at,signature FROM main.native_admin_challenges WHERE target_id=?",
			[operation],
		);
		if (!row || !challenge) throw new Error("DYTEST native approval records missing");
		return { state: row.state, consumed: challenge.consumed_at, signature: challenge.signature };
	});
}
function open(f: ApprovalFixture): Extract<OperationReview, { kind: "account.mode-full" }> {
	const review = f.operations.open(f.owner.device.peer, {
		kind: "account.mode-full",
		ids: [f.account.account.id],
	});
	if (review.kind !== "account.mode-full") throw new Error("DYTEST native review kind refused");
	return review;
}
function issued(f: ApprovalFixture): {
	review: OperationReview;
	challenge: Challenge;
	envelope: SignedEnvelope;
} {
	const review = open(f);
	const request = { kind: "admin.v1", id: review.id } as const;
	const challenge = f.service.issue(f.owner.device.peer, request);
	const envelope = f.owner.client.envelope({
		challenge,
		request,
		review,
		device: native.idOf(f.device),
		pin: native.PIN,
	});
	return { review, challenge, envelope };
}

describe("fake device native approval primitives", () => {
	it("refuses a genuine challenge shown under a different native operation", async () => {
		const f = await fixture();
		const { review, challenge } = issued(f);
		const displayed = open(f);
		expect(displayed.id).not.toBe(review.id);
		expect(displayed.digest).toBe(review.digest);
		const before = f.current(),
			counts = evidence(f),
			pending = settled(f, review.id);
		let accepted: SignedEnvelope | undefined;
		let refusal: unknown;
		try {
			accepted = f.owner.client.envelope({
				challenge,
				request: { kind: "admin.v1", id: displayed.id },
				review: displayed,
				device: native.idOf(f.device),
				pin: native.PIN,
			});
		} catch (error) {
			refusal = error;
		}
		expect(accepted === undefined).toBe(true);
		expect(refusal).toBeInstanceOf(FakeDeviceError);
		expect(f.current()).toEqual(before);
		expect(evidence(f)).toEqual(counts);
		expect(settled(f, review.id)).toEqual(pending);
	});

	it("uses the owner's real reconnected TLS identity for an exact signed effect and refuses replay", async () => {
		const f = await fixture(),
			before = f.current();
		const { review, challenge, envelope } = issued(f),
			counts = evidence(f);
		expect(f.owner.device.peer).not.toBe(f.device.peer);
		expect(f.owner.client.transportSpkiSha256).toBe(f.device.transportSpkiSha256);
		expect(envelope.statement).toBe(challenge.statement);
		await expect(f.service.accept(f.owner.device.peer, "admin.v1", envelope)).resolves.toEqual({
			kind: "admin.v1",
			id: review.id,
		});
		expect(f.current()).toEqual({
			account: { ...before.account, mode: "full" },
			generation: before.generation + 1,
		});
		expect(evidence(f)).toMatchObject({
			accountAudit: counts.accountAudit + 1,
			accountEvents: counts.accountEvents + 1,
			pinVerified: counts.pinVerified + 1,
		});
		expect(settled(f, review.id)).toEqual({
			state: "applied",
			consumed: f.time.wall,
			signature: envelope.signature,
		});
		const applied = evidence(f);
		await expect(f.service.accept(f.owner.device.peer, "admin.v1", envelope)).rejects.toMatchObject(
			{ code: "CHALLENGE_INVALID" },
		);
		expect(evidence(f)).toEqual(applied);
		expect(f.current().generation).toBe(before.generation + 1);
	});

	it("rejects a genuine generation-only change during PIN work despite the unchanged review digest", async () => {
		const f = await fixture(),
			before = f.current();
		const { review, envelope } = issued(f),
			counts = evidence(f);
		const accepting = f.service.accept(f.owner.device.peer, "admin.v1", envelope);
		f.database.write((scope) => f.accounts.replace(scope, before.account, before.generation));
		const fresh = open(f);
		expect(fresh.digest).toBe(review.digest);
		await expect(accepting).rejects.toMatchObject({ code: "STALE" });
		expect(evidence(f).pinVerified).toBeGreaterThan(counts.pinVerified);
		expect(f.current()).toEqual({ account: before.account, generation: before.generation + 1 });
		expect(settled(f, review.id)).toEqual({ state: "pending", consumed: null, signature: null });
	});

	it.each(["wall", "mono"] as const)(
		"refuses a stale %s challenge after real asynchronous PIN work",
		async (clock) => {
			const f = await fixture(),
				before = f.current();
			const { review, envelope } = issued(f),
				counts = evidence(f);
			const accepting = f.service.accept(f.owner.device.peer, "admin.v1", envelope);
			f.time[clock] += 120_001;
			await expect(accepting).rejects.toThrow();
			expect(evidence(f).pinVerified).toBeGreaterThan(counts.pinVerified);
			expect(f.current()).toEqual(before);
			expect(evidence(f)).toMatchObject({
				accountAudit: counts.accountAudit,
				accountEvents: counts.accountEvents,
			});
			expect(settled(f, review.id)).toEqual({ state: "pending", consumed: null, signature: null });
		},
	);

	it("refuses a confirmed non-approver at admin open and issue before PIN work", async () => {
		const f = await originalSessionAdminFixture();
		const reader = await connectFakeDevice(f.native);
		f.clients.push(reader.client);
		const windows = await nativePairingWindows(f.originalSession);
		const opened = await windows.open(f.owner.device.peer, { role: "device", pin: native.PIN });
		const exchange = pairingExchange(reader.client, opened.pairingCode);
		let candidate: string;
		try {
			const claimed = windows.claim(reader.device.peer, exchange.claim);
			const recorded = windows.reveal(reader.device.peer, exchange.reveal);
			expect(claimed.deviceId === recorded.deviceId && claimed.epoch === recorded.epoch).toBe(true);
			candidate = recorded.deviceId;
		} finally {
			exchange.claim.fill(0);
			exchange.reveal.fill(0);
		}
		const proof = await f.native.pins.verify(
			native.owner(f.native),
			native.PIN,
			cliConfirmPinScope(candidate),
		);
		try {
			f.native.store.write((tx) => f.native.registry.confirmFromCli(tx, candidate, proof));
		} finally {
			f.native.pins.discard(proof);
		}
		const grant = f.native.store.read((tx) =>
			f.native.authorizer.requirePeerDevice(tx, reader.device.peer, "read"),
		);
		expect(
			grant.deviceId === candidate &&
				grant.userId === native.owner(f.native) &&
				grant.approvalKey === reader.client.signingKey,
		).toBe(true);
		expect(grant.capabilities.includes("approve") || grant.capabilities.includes("admin")).toBe(
			false,
		);
		const { review } = issued(f);
		const before = f.current(),
			counts = evidence(f),
			pending = settled(f, review.id);
		let openRefused = false,
			issueRefused = false;
		try {
			f.operations.open(reader.device.peer, {
				kind: "account.mode-full",
				ids: [f.account.account.id],
			});
		} catch (error) {
			openRefused = error instanceof NativeAdminError && error.code === "UNAVAILABLE";
		}
		try {
			f.service.issue(reader.device.peer, { kind: "admin.v1", id: review.id });
		} catch (error) {
			issueRefused = error instanceof ChallengeError && error.code === "UNAVAILABLE";
		}
		expect(openRefused).toBe(true);
		expect(issueRefused).toBe(true);
		expect(evidence(f)).toEqual(counts);
		expect(f.current()).toEqual(before);
		expect(settled(f, review.id)).toEqual(pending);
		const current = f.operations.review(f.owner.device.peer, review.id);
		expect(current.id === review.id && current.digest === review.digest).toBe(true);
	});

	it("refuses a different pending TLS peer before attempting the owner's PIN", async () => {
		const f = await fixture(),
			before = f.current();
		const { review, envelope } = issued(f);
		const foreign = await connectFakeDevice(f.native);
		f.clients.push(foreign.client);
		expect(foreign.client.transportSpkiSha256).not.toBe(f.owner.client.transportSpkiSha256);
		const counts = evidence(f);
		await expect(f.service.accept(foreign.device.peer, "admin.v1", envelope)).rejects.toMatchObject(
			{ code: "DEVICE_REFUSED" },
		);
		expect(evidence(f)).toEqual(counts);
		expect(f.current()).toEqual(before);
		expect(settled(f, review.id)).toEqual({ state: "pending", consumed: null, signature: null });
	});

	it("refuses a different approval key on the owner's native transport before PIN work", async () => {
		const f = await fixture(),
			before = f.current();
		const { review, challenge } = issued(f);
		const foreign = await connectFakeDevice(f.native);
		f.clients.push(foreign.client);
		const envelope = foreign.client.envelope({
			challenge,
			request: { kind: "admin.v1", id: review.id },
			review,
			device: native.idOf(f.device),
			pin: native.PIN,
		});
		const counts = evidence(f);
		await expect(f.service.accept(f.owner.device.peer, "admin.v1", envelope)).rejects.toMatchObject(
			{ code: "SIGNATURE_INVALID" },
		);
		expect(evidence(f)).toEqual(counts);
		expect(f.current()).toEqual(before);
		expect(settled(f, review.id)).toEqual({ state: "pending", consumed: null, signature: null });
	});

	it("records an isolated wrong PIN attempt without applying or settling the native operation", async () => {
		const f = await fixture(),
			before = f.current();
		const { review, envelope } = issued(f),
			counts = evidence(f);
		await expect(
			f.service.accept(f.owner.device.peer, "admin.v1", { ...envelope, pin: "000000" }),
		).rejects.toMatchObject({ code: "PIN_REFUSED" });
		expect(evidence(f)).toMatchObject({
			accountAudit: counts.accountAudit,
			accountEvents: counts.accountEvents,
			pinVerified: counts.pinVerified,
			pinFailures: counts.pinFailures + 1,
		});
		expect(f.current()).toEqual(before);
		expect(settled(f, review.id)).toEqual({ state: "pending", consumed: null, signature: null });
	});
});
