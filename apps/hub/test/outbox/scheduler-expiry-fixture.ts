import path from "node:path";
import { fromBase64Url } from "@draftyak/protocol/scalars";
import { signStatement } from "@draftyak/protocol/sign";
import { parseStatement } from "@draftyak/protocol/statements";
import { Authorizer } from "../../src/authz/authorizer.ts";
import { NativeDraftRevisions } from "../../src/drafts/revisions.ts";
import { EVENT_MIGRATIONS } from "../../src/events/log.ts";
import { CHALLENGE_MIGRATIONS, ChallengeService } from "../../src/identity/challenges.ts";
import { DEVICE_MIGRATIONS, DeviceRegistry } from "../../src/identity/devices.ts";
import { HubIdentity } from "../../src/identity/hub-key.ts";
import { PinService } from "../../src/identity/pin.ts";
import { JOB_MIGRATIONS } from "../../src/jobs/queue.ts";
import {
	NativeOutboxProposals,
	type NativeProposalRecord,
	OUTBOX_MIGRATIONS,
} from "../../src/outbox/propose.ts";
import { APPROVAL_MIGRATIONS, SendApprovalVerifier } from "../../src/outbox/verifier.ts";
import { HubStore } from "../../src/store/store.ts";
import { nativeBinding } from "../store/helpers.ts";
import {
	type Fixture,
	fixture,
	native,
	type ProposalCandidate,
	type ProposalFixtureOptions,
} from "./propose-fixture.ts";

export interface ExpiryFixture {
	readonly base: Fixture;
	readonly verifier: SendApprovalVerifier;
	readonly challenges: ChallengeService;
	readonly target: NativeOutboxProposals;
	readonly revisions: NativeDraftRevisions;
	approve(kind?: "now" | "at"): Promise<ProposalCandidate>;
	read(outboxId: string): NativeProposalRecord | undefined;
	reopen(): Promise<void>;
	close(): Promise<void>;
}

// An uncertain reopen retains its original key and folder rather than claiming safe disposal.
const retained = new Set<ExpiryFixture>();

export async function expiryFixture(options: ProposalFixtureOptions = {}): Promise<ExpiryFixture> {
	for (const name of ["challenges", "verifier"])
		if (Object.hasOwn(options.extraMigrations ?? {}, name))
			throw new Error("Expiry fixture migration collision");
	const base = await fixture({
		...options,
		extraMigrations: {
			...options.extraMigrations,
			challenges: CHALLENGE_MIGRATIONS,
			verifier: APPROVAL_MIGRATIONS,
		},
	});
	const f = base.native;
	let verifier: SendApprovalVerifier | undefined;
	let challenges: ChallengeService | undefined;
	try {
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
	} catch (error) {
		challenges?.lock();
		verifier?.lock();
		await base.close();
		throw error;
	}
	const approvalVerifier = verifier,
		approvalChallenges = challenges;
	let target = base.target,
		revisions = base.revisions,
		reopened = false,
		retired = false,
		closed = false;
	const read = (outboxId: string): NativeProposalRecord | undefined =>
		target.write((tx) => target.get(tx, outboxId));
	const value: ExpiryFixture = {
		base,
		verifier: approvalVerifier,
		challenges: approvalChallenges,
		get target() {
			return target;
		},
		get revisions() {
			return revisions;
		},
		async approve(kind = "now") {
			if (closed || retired || reopened) throw new Error("Expiry fixture cannot approve");
			const notBefore = Math.ceil((base.time.wall + 120_000) / 60_000) * 60_000;
			const proposal = base.proposal({
				schedule:
					kind === "now"
						? { kind: "now" }
						: {
								kind: "at",
								notBefore,
								zone: "UTC",
								localWallTime: `${new Date(notBefore).toISOString().slice(0, 16)}+00:00`,
								latenessSec: 900,
								holdIfNewInbound: true,
							},
			});
			const challenge = approvalChallenges.issue(base.device.peer, {
				kind: "approval.send.v1",
				id: proposal.id,
				flagsAcked: [],
			});
			const bytes = fromBase64Url(challenge.statement);
			const statement = bytes && parseStatement(challenge.kind, bytes);
			if (!statement) throw new Error("Expiry fixture statement unavailable");
			await approvalChallenges.accept(base.device.peer, challenge.kind, {
				statement: challenge.statement,
				signature: signStatement(challenge.kind, statement, base.device.privateKey),
				pin: native.PIN,
			});
			const record = target.write((tx) => target.item(tx, proposal.id));
			if (!record || record.state !== (kind === "now" ? "APPROVED" : "SCHEDULED"))
				throw new Error("Expiry fixture approval unavailable");
			return { ...proposal, record };
		},
		read,
		async reopen() {
			if (closed || retired || reopened) throw new Error("Expiry fixture cannot reopen");
			// Keep the original MasterKey alive; base.close is terminal and is not a reopen primitive.
			try {
				approvalChallenges.lock();
				approvalVerifier.lock();
				for (const device of f.devices) device.socket.destroy();
				await f.tls.close();
				target.destroy();
				revisions.destroy();
				f.registry.lock();
				f.pins.lock();
				f.identity.lock();
				f.store.close();
				f.store = new HubStore({
					filename: f.filename,
					nativeBinding,
					masterKey: f.key,
					migrations: {
						audit: path.resolve(import.meta.dirname, "../../src/store/migrations/audit"),
						core: path.resolve(import.meta.dirname, "../../src/store/migrations/core"),
						devices: DEVICE_MIGRATIONS,
						jobs: JOB_MIGRATIONS,
						events: EVENT_MIGRATIONS,
						revisions: path.resolve(import.meta.dirname, "../../src/drafts/migrations"),
						outbox: OUTBOX_MIGRATIONS,
						...options.extraMigrations,
						challenges: CHALLENGE_MIGRATIONS,
						verifier: APPROVAL_MIGRATIONS,
					},
				});
				f.store.read((db) => f.audit.verify(db));
				f.identity = await HubIdentity.loadOrCreate(f.store, f.key);
				f.pins = new PinService(f.store, f.audit);
				f.registry = new DeviceRegistry(f.store, f.audit, f.pins, { identity: f.identity });
				f.authorizer = new Authorizer(f.registry);
				revisions = new NativeDraftRevisions(f.store, f.audit, f.key, base.clock);
				target = new NativeOutboxProposals(
					f.store,
					f.audit,
					f.key,
					revisions,
					f.registry,
					f.authorizer,
					f.identity,
					base.clock,
					options.settings,
					base.providers,
				);
				reopened = true;
			} catch {
				retired = true;
				retained.add(value);
				throw new Error("Expiry fixture reopen incomplete");
			}
		},
		async close() {
			if (closed) return;
			if (retired) throw new Error("Expiry fixture resources retained");
			approvalChallenges.lock();
			approvalVerifier.lock();
			target.destroy();
			revisions.destroy();
			try {
				await base.close();
			} catch (error) {
				retired = true;
				retained.add(value);
				throw error;
			}
			closed = true;
		},
	};
	return value;
}
