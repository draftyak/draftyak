import { createHash, randomBytes } from "node:crypto";
import type { Socket } from "node:net";
import type { Account } from "@draftyak/protocol/entities/account";
import type { DraftContent } from "@draftyak/protocol/entities/draft";
import type { CurrentSendSnapshotV1, Schedule } from "@draftyak/protocol/snapshot";
import { afterEach, expect, it } from "vitest";
import type { NativeOutboxReadContext } from "../../../src/api/device/outbox-context.ts";
import type { DraftBinding } from "../../../src/drafts/revisions.ts";
import type { NativeRuntimeState } from "../../../src/lifecycle/native-runtime-state.ts";
import type { HubSession } from "../../../src/lifecycle/session.ts";
import type {
	NativeProposalFacts,
	NativeProposalInput,
	NativeProposalProviders,
	NativeProposalRecord,
} from "../../../src/outbox/propose.ts";
import type { NativeFixture } from "../../authz/native-fixture.ts";
import { requireLoopbackNetworkGuard } from "../../helpers/loopback-network.ts";
import type { SessionFixture } from "../../lifecycle/session-helpers.ts";

requireLoopbackNetworkGuard();
const [
	{ createNativeOutboxReadContext },
	{ AuthzError },
	{ cliConfirmPinScope, revokePinScope },
	{ newId },
	{ readStamp },
	{ createNativeRuntimeState },
	{ ScheduledSummary, scopeHash },
	{ canonicalize },
	{ nativePairingWindows },
	{ decodePairingPayload, makePairingClaim, pairingEkm, PairingReveal },
	{ NativeAccounts },
	{ NativeDraftRevisions },
	{ EventLog },
	{ WorkDatabase },
	{ NativeOutboxProposals, destroyNativeOutboxProposals },
	{ SendApprovalVerifier },
	{ ChallengeService },
	{ systemClock },
	{ renderLocalWallTime },
	{ fromBase64Url },
	{ signStatement },
	{ parseStatement },
	{ sessionFixture, sessionTransport, closeSessionTransport, expectErased, expectUsable },
	{ admit, bootstrap, device, idOf, owner, PIN },
] = await Promise.all([
	import("../../../src/api/device/outbox-context.ts"),
	import("../../../src/authz/errors.ts"),
	import("../../../src/authz/scopes.ts"),
	import("../../../src/kernel/ids.ts"),
	import("../../../src/store/read-stamp.ts"),
	import("../../../src/lifecycle/native-runtime-state.ts"),
	import("@draftyak/protocol/scheduled-summary"),
	import("@draftyak/protocol/jcs"),
	import("../../../src/lifecycle/session.ts"),
	import("@draftyak/protocol/pairing"),
	import("../../../src/accounts/records.ts"),
	import("../../../src/drafts/revisions.ts"),
	import("../../../src/events/log.ts"),
	import("../../../src/jobs/database.ts"),
	import("../../../src/outbox/propose.ts"),
	import("../../../src/outbox/verifier.ts"),
	import("../../../src/identity/challenges.ts"),
	import("../../../src/kernel/clock.ts"),
	import("@draftyak/protocol/schedule"),
	import("@draftyak/protocol/scalars"),
	import("@draftyak/protocol/sign"),
	import("@draftyak/protocol/statements"),
	import("../../lifecycle/session-helpers.ts"),
	import("../../authz/native-fixture.ts"),
]);

const fixtures: SessionFixture[] = [];
const sessions: HubSession[] = [];
const transports: NativeFixture[] = [];
const children = new Set<NativeOutboxReadContext>();
const runtimes = new Set<NativeRuntimeState>();
const proposalTargets = new Set<InstanceType<typeof NativeOutboxProposals>>();
const draftStores = new Set<InstanceType<typeof NativeDraftRevisions>>();
const verifiers = new Set<InstanceType<typeof SendApprovalVerifier>>();
const challengeServices = new Set<InstanceType<typeof ChallengeService>>();

async function destroy(socket: Socket): Promise<void> {
	if (socket.closed) return;
	const ending = new Promise<void>((resolve) => socket.once("close", () => resolve()));
	socket.destroy();
	await ending;
}
afterEach(async () => {
	let failed = false;
	const release = [
		...[...challengeServices].map((service) => () => service.lock()),
		...[...verifiers].map((verifier) => () => verifier.lock()),
		...[...proposalTargets].map((target) => () => destroyNativeOutboxProposals(target)),
		...[...draftStores].map((drafts) => () => drafts.destroy()),
	];
	for (const retire of release) {
		try {
			retire();
		} catch {
			failed = true;
		}
	}
	for (const child of children) {
		try {
			child.close();
		} catch {
			failed = true;
		}
	}
	const runtimeResults = await Promise.allSettled([...runtimes].map((runtime) => runtime.close()));
	const sockets = await Promise.allSettled(
		transports.flatMap((native) => native.devices.map((client) => destroy(client.socket))),
	);
	const listeners = await Promise.allSettled(transports.map(closeSessionTransport));
	const owners = await Promise.allSettled(sessions.map((session) => session.close()));
	if (
		failed ||
		[...runtimeResults, ...sockets, ...listeners, ...owners].some(
			(result) => result.status === "rejected",
		)
	)
		throw new Error("Native outbox context fixture cleanup incomplete");
	children.clear();
	runtimes.clear();
	challengeServices.clear();
	verifiers.clear();
	proposalTargets.clear();
	draftStores.clear();
	transports.length = 0;
	sessions.length = 0;
	for (const fixture of fixtures.splice(0)) await fixture.remove();
});

async function limitedCandidate(
	session: HubSession,
	native: NativeFixture,
	confirmed: Awaited<ReturnType<typeof device>>,
) {
	const windows = await nativePairingWindows(session);
	const opened = await windows.open(confirmed.peer, { role: "device", pin: PIN });
	const limited = await device(native);
	let claimBytes: Buffer | undefined;
	let revealBytes: Buffer | undefined;
	let ekm: Uint8Array | undefined;
	const nonce = randomBytes(16);
	try {
		const payload = decodePairingPayload(opened.pairingCode, Date.now());
		ekm = pairingEkm(limited.socket, payload.pid);
		const claim = makePairingClaim(
			{ pid: payload.pid, role: payload.role, sec: payload.sec },
			{
				name: "DYTEST limited outbox reader",
				transportSpkiSha256: limited.transportSpkiSha256,
				signingKey: limited.signingKey,
			},
			ekm,
			nonce,
		);
		claimBytes = Buffer.from(canonicalize(claim));
		revealBytes = Buffer.from(
			canonicalize(PairingReveal.parse({ pid: payload.pid, nd: nonce.toString("base64url") })),
		);
		const answer = windows.claim(limited.peer, claimBytes);
		const candidate = windows.reveal(limited.peer, revealBytes);
		if (candidate.deviceId !== answer.deviceId)
			throw new Error("Native candidate identity refused");
		limited.id = candidate.deviceId;
		return limited;
	} catch {
		throw new Error("Native limited-device pairing setup refused");
	} finally {
		nonce.fill(0);
		ekm?.fill(0);
		claimBytes?.fill(0);
		revealBytes?.fill(0);
	}
}

async function setup(mode?: "sidecar" | "service") {
	const fixture = sessionFixture("draftyak-outbox-context-");
	fixtures.push(fixture);
	const key = fixture.key();
	const session = await fixture.open({ masterKey: key });
	sessions.push(session);
	const native = await sessionTransport(session, key, fixture.folder);
	transports.push(native);
	// All initial claims precede bootstrap; no SQL row or device authority is fabricated.
	const pending = await device(native);
	admit(native, pending);
	const revoked = await device(native);
	const revokedId = admit(native, revoked);
	const confirmed = await bootstrap(native);
	const limited = await limitedCandidate(session, native, confirmed);
	const limitedId = idOf(limited);
	const cliProof = await native.pins.verify(owner(native), PIN, cliConfirmPinScope(limitedId));
	const cli = native.store.write((tx) => native.registry.confirmFromCli(tx, limitedId, cliProof));
	expect(cli.capabilities).toEqual(["read", "draft"]);
	const revokeProof = await native.pins.verify(owner(native), PIN, revokePinScope(revokedId));
	expect(
		native.store.write((tx) =>
			native.registry.revoke(tx, revokedId, {
				kind: "device",
				id: idOf(confirmed),
				proof: revokeProof,
			}),
		),
	).toBe(true);
	const runtime = mode === undefined ? undefined : createNativeRuntimeState(session, mode);
	if (runtime) runtimes.add(runtime);
	const context =
		runtime === undefined
			? createNativeOutboxReadContext(session, key)
			: createNativeOutboxReadContext(session, key, runtime);
	children.add(context);
	return { fixture, key, session, native, context, runtime, confirmed, pending, revoked, limited };
}

/** Stored row equality does not claim the receiver's real write-scope guards are inert. */
function persisted(session: HubSession) {
	return session.store.read((db) => {
		const tables = ["outbox", "native_draft_locks", "audit_events", "events", "jobs_meta"] as const;
		return Object.fromEntries(
			tables.map((table) => {
				const rows = db
					.all<Record<string, unknown>>(`SELECT * FROM main.${table}`)
					.map((row) => JSON.stringify(row))
					.sort();
				return [
					table,
					{
						count: rows.length,
						sha256: createHash("sha256").update(rows.join("\n")).digest("hex"),
					},
				];
			}),
		);
	});
}
function revision(session: HubSession): number {
	const value = session.store.read((db) => readStamp(db)?.revision);
	if (value === undefined) throw new Error("Original store read stamp missing");
	return value;
}
function authorizationRefusal(operation: () => unknown, code: string): void {
	let error: unknown;
	try {
		operation();
	} catch (caught) {
		error = caught;
	}
	expect(error instanceof AuthzError).toBe(true);
	expect(error instanceof AuthzError && error.code === code).toBe(true);
}

function domainProposals(f: Awaited<ReturnType<typeof setup>>) {
	const user = owner(f.native);
	const database = new WorkDatabase(f.session.store);
	const accounts = new NativeAccounts(
		database,
		new EventLog(database, systemClock.wallMs),
		f.session.audit,
		systemClock.wallMs,
	);
	const revisions = new NativeDraftRevisions(f.session.store, f.session.audit, f.key, systemClock);
	draftStores.add(revisions);
	// Synthetic domain DATA from the public proposal fixture; no production manifest/profile authority.
	const TEST_ONLY_FACTS = new Map<string, NativeProposalFacts>();
	const TEST_ONLY_PROVIDERS = Object.freeze<NativeProposalProviders>({
		facts: (_tx, binding) => TEST_ONLY_FACTS.get(binding.draftId),
		flags: (_tx, _binding, current) => current.revision.flags,
	});
	const target = new NativeOutboxProposals(
		f.session.store,
		f.session.audit,
		f.key,
		revisions,
		f.session.devices,
		f.native.authorizer,
		f.session.identity,
		systemClock,
		{},
		TEST_ONLY_PROVIDERS,
	);
	proposalTargets.add(target);
	const verifier = new SendApprovalVerifier(
		f.session.store,
		f.session.audit,
		f.session.devices,
		f.native.authorizer,
		{
			identity: f.session.identity,
			target,
			masterKey: f.key,
			clock: systemClock,
		},
	);
	verifiers.add(verifier);
	const challenges = new ChallengeService(
		f.session.store,
		f.session.audit,
		f.session.pins,
		f.session.devices,
		f.native.authorizer,
		{
			identity: f.session.identity,
			send: verifier,
			clock: systemClock,
		},
	);
	challengeServices.add(challenges);
	const accountById = new Map<string, Account>();
	function saved(id: string): NativeProposalRecord {
		const value = target.write((tx) => target.get(tx, id));
		if (value === undefined) throw new Error("Genuine proposal record missing");
		return value;
	}
	function propose(channel: "email" | "chat", schedule: Schedule): NativeProposalRecord {
		const now = Date.now();
		const binding: DraftBinding = {
			draftId: newId(now),
			accountId: newId(now),
			conversationId: channel === "email" ? null : newId(now),
			channel,
		};
		const common = {
			id: binding.accountId,
			userId: user,
			alias: `dytest-summary-${channel}`,
			mode: "full" as const,
			status: "active" as const,
			deletionDeadline: null,
			historyLimitDays: 30,
			disclosureVersion: 1,
			createdAt: now,
			pluginInstanceId: newId(now),
		};
		const account: Account =
			channel === "email"
				? { ...common, channel, address: "dytest-summary-owner@example.invalid" }
				: { ...common, channel, teamId: "DYTEST-summary-team", selfUserId: "DYTEST-summary-owner" };
		const created = database.write((scope) => accounts.create(scope, account));
		accountById.set(account.id, created.account);
		const content: DraftContent =
			channel === "email"
				? {
						channel,
						to: ["dytest-first@example.invalid", "dytest-second@example.invalid"],
						cc: ["dytest-copy@example.invalid"],
						bcc: [],
						subject: "DYTEST summary subject",
						body: "DYTEST saved email body",
						attachments: [],
					}
				: { channel, body: "DYTEST saved chat body", threadTs: null, broadcast: false };
		const current = f.session.store.write((tx) =>
			revisions.createInTransaction(tx, {
				...binding,
				content,
				flags: [],
				author: { kind: "owner", id: user },
			}),
		);
		const base = {
			v: 1 as const,
			hub: f.session.identity.hid,
			epoch: f.session.devices.currentState().epoch,
			outbox: newId(now),
			account: account.id,
			conversation: binding.conversationId,
			body: { text: content.body, footer: "DYTEST domain fixture footer" },
			attachments: [],
			schedule,
			source: { draft: binding.draftId, rev: current.revision.rev, authors: current.authors },
		};
		let snapshot: CurrentSendSnapshotV1;
		if (content.channel === "email") {
			if (account.channel !== "email") throw new Error("Domain email fixture mismatch");
			snapshot = {
				...base,
				kind: "email",
				email: {
					from: account.address,
					to: content.to,
					cc: content.cc,
					bcc: content.bcc,
					subject: content.subject,
					references: [],
				},
			};
			TEST_ONLY_FACTS.set(binding.draftId, {
				kind: "email",
				accountId: account.id,
				conversationId: binding.conversationId,
				dataClass: "gmail.content",
				footer: base.body.footer,
				email: { from: account.address, references: [] },
			});
		} else {
			const chat = {
				channelId: "DYTEST-summary-channel",
				channelName: "DYTEST saved room",
				channelType: "public" as const,
				external: false,
				shared: false,
				memberCount: 2,
				broadcast: false,
			};
			if (binding.conversationId === null) throw new Error("Domain chat fixture mismatch");
			snapshot = { ...base, conversation: binding.conversationId, kind: "chat", chat };
			TEST_ONLY_FACTS.set(binding.draftId, {
				kind: "chat",
				accountId: account.id,
				conversationId: binding.conversationId,
				dataClass: "slack.content",
				footer: base.body.footer,
				chat,
			});
		}
		const input: NativeProposalInput = {
			binding,
			expectedRev: current.revision.rev,
			snapshot,
			dataClass: channel === "email" ? "gmail.content" : "slack.content",
			requiredApprovals: 1,
			requiredUsers: [user],
			undoWindowMs: 10_000,
			expiresAt: now + 86_400_000,
		};
		const proposed = target.propose(f.confirmed.peer, input);
		return saved(proposed.id);
	}
	async function approve(record: NativeProposalRecord): Promise<NativeProposalRecord> {
		const challenge = challenges.issue(f.confirmed.peer, {
			kind: "approval.send.v1",
			id: record.id,
			flagsAcked: [],
		});
		const bytes = fromBase64Url(challenge.statement);
		try {
			const statement = bytes && parseStatement(challenge.kind, bytes);
			if (!statement) throw new Error("Genuine send statement missing");
			await expect(
				challenges.accept(f.confirmed.peer, challenge.kind, {
					statement: challenge.statement,
					signature: signStatement(challenge.kind, statement, f.confirmed.privateKey),
					pin: PIN,
				}),
			).resolves.toMatchObject({ kind: "approval.send.v1", id: record.id });
			return saved(record.id);
		} finally {
			bytes?.fill(0);
		}
	}
	return { propose, approve, accountById };
}

it("reads a genuinely absent id in the original receiver scope without changing stored domain rows", async () => {
	const f = await setup();
	const id = newId(Date.now());
	const before = persisted(f.session);
	const beforeRevision = revision(f.session);
	expect(Object.isFrozen(f.context)).toBe(true);
	expect(f.context.get(f.confirmed.peer, id)).toBeUndefined();
	expect(f.context.item(f.confirmed.peer, id)).toBeUndefined();
	expect(persisted(f.session)).toEqual(before);
	// jobs_meta UPDATE guards are real, and successful native writes advance this private revision.
	expect(revision(f.session)).toBeGreaterThan(beforeRevision);
	expectUsable(f.key);
});

it("requires the actual current confirmed approve peer, including against a genuine foreign listener", async () => {
	const f = await setup();
	const foreign = await setup();
	const id = newId(Date.now());
	const before = persisted(f.session);
	for (const [peer, code] of [
		[f.pending.peer, "DEVICE_PENDING"],
		[f.revoked.peer, "DEVICE_REVOKED"],
		[f.limited.peer, "CAPABILITY_MISSING"],
		[foreign.confirmed.peer, "PEER_REFUSED"],
	] as const) {
		authorizationRefusal(() => f.context.get(peer, id), code);
		authorizationRefusal(() => f.context.item(peer, id), code);
	}
	expect(persisted(f.session)).toEqual(before);
	expect(f.context.get(f.confirmed.peer, id)).toBeUndefined();
	expect(persisted(f.session)).toEqual(before);
	expectUsable(f.key);
});

it("retires only its own child while the actual session, key, and current peer remain usable", async () => {
	const f = await setup();
	const id = newId(Date.now());
	const before = persisted(f.session);
	f.context.close();
	f.context.close();
	authorizationRefusal(() => f.context.get(f.confirmed.peer, id), "UNAVAILABLE");
	authorizationRefusal(() => f.context.item(f.confirmed.peer, id), "UNAVAILABLE");
	expectUsable(f.key);
	expect(
		f.session.store.read(
			(db) => f.native.authorizer.requirePeerDevice(db, f.confirmed.peer, "approve").deviceId,
		),
	).toBe(idOf(f.confirmed));
	const next = createNativeOutboxReadContext(f.session, f.key);
	children.add(next);
	expect(next.get(f.confirmed.peer, id)).toBeUndefined();
	expect(persisted(f.session)).toEqual(before);
	expectUsable(f.key);
});

it("withdraws the original peer on real listener close and refuses after its original session closes", async () => {
	const f = await setup();
	const id = newId(Date.now());
	const before = persisted(f.session);
	await f.native.tls.close();
	authorizationRefusal(() => f.context.get(f.confirmed.peer, id), "PEER_REFUSED");
	authorizationRefusal(() => f.context.item(f.confirmed.peer, id), "PEER_REFUSED");
	expect(persisted(f.session)).toEqual(before);
	expectUsable(f.key);
	await f.session.close();
	expectErased(f.key);
	expect(() => f.context.get(f.confirmed.peer, id)).toThrow("SESSION_UNAVAILABLE");
	expect(() => f.context.item(f.confirmed.peer, id)).toThrow("SESSION_UNAVAILABLE");
	f.context.close();
});

function emptySummary(f: Awaited<ReturnType<typeof setup>>, peer = f.confirmed.peer) {
	if (f.runtime === undefined) throw new Error("Original runtime fixture missing");
	const actual = f.context.summary(peer);
	const state = f.session.devices.currentState();
	if (state.ownerUserId === null) throw new Error("Original owner fixture missing");
	const scheduling = f.runtime.status(f.confirmed.peer);
	expect(ScheduledSummary.safeParse(actual).success).toBe(true);
	expect(Buffer.byteLength(canonicalize(actual))).toBeLessThanOrEqual(8192);
	expect(actual).toEqual({
		scheduling,
		scopeHash: scopeHash({
			hub: f.session.identity.hid,
			owner: state.ownerUserId,
			epoch: state.epoch,
			scheduling,
			pendingApprovalCount: 0,
			pendingApprovalIds: [],
			scheduledCount: 0,
			items: [],
		}),
		pendingApprovalCount: 0,
		pendingApprovalIds: [],
		scheduledCount: 0,
		items: [],
	});
	return actual;
}

it("joins the genuine empty outbox and native runtime into the owner scope for READ peers", async () => {
	const f = await setup("sidecar");
	if (f.runtime === undefined) throw new Error("Original runtime fixture missing");
	const before = persisted(f.session);
	expect(before.outbox?.count).toBe(0);
	const beforeRevision = revision(f.session);
	const first = emptySummary(f);
	expect(first.scheduling).toEqual({
		mode: "sidecar",
		scheduler: "unavailable",
		syncPaused: false,
	});
	expect(emptySummary(f, f.limited.peer)).toEqual(first);
	expect(persisted(f.session)).toEqual(before);
	expect(revision(f.session)).toBeGreaterThan(beforeRevision);
	// A real authorized durable write changes the genuine status bound into the summary hash.
	f.runtime.pauseSync(f.confirmed.peer, true);
	const afterPause = persisted(f.session);
	const paused = emptySummary(f);
	expect(paused.scheduling).toEqual({
		mode: "sidecar",
		scheduler: "unavailable",
		syncPaused: true,
	});
	expect(paused.scopeHash === first.scopeHash).toBe(false);
	expect(emptySummary(f, f.limited.peer)).toEqual(paused);
	expect(persisted(f.session)).toEqual(afterPause);
	expectUsable(f.key);
});

it("requires current READ and original live children for the genuine scheduling summary", async () => {
	const f = await setup("service");
	const foreign = await setup();
	if (f.runtime === undefined) throw new Error("Original runtime fixture missing");
	const before = persisted(f.session);
	for (const [peer, code] of [
		[f.pending.peer, "DEVICE_PENDING"],
		[f.revoked.peer, "DEVICE_REVOKED"],
		[foreign.confirmed.peer, "PEER_REFUSED"],
	] as const)
		authorizationRefusal(() => f.context.summary(peer), code);
	expect(emptySummary(f, f.limited.peer).scheduling).toEqual({
		mode: "service",
		scheduler: "unavailable",
		syncPaused: false,
	});
	expect(persisted(f.session)).toEqual(before);
	f.context.close();
	authorizationRefusal(() => f.context.summary(f.confirmed.peer), "UNAVAILABLE");
	expectUsable(f.key);
	expect(f.runtime.status(f.confirmed.peer).mode).toBe("service");
	const next = createNativeOutboxReadContext(f.session, f.key, f.runtime);
	children.add(next);
	expect(ScheduledSummary.safeParse(next.summary(f.limited.peer)).success).toBe(true);
	await f.runtime.close();
	authorizationRefusal(() => next.summary(f.confirmed.peer), "UNAVAILABLE");
	expect(persisted(f.session)).toEqual(before);
	await f.native.tls.close();
	await f.session.close();
	expectErased(f.key);
	expect(() => next.summary(f.confirmed.peer)).toThrow("SESSION_UNAVAILABLE");
	next.close();
});

it("selects genuine pending and approved-at records by saved time with the actual scoped hashes", async () => {
	const f = await setup("sidecar");
	if (f.runtime === undefined) throw new Error("Original runtime fixture missing");
	const domain = domainProposals(f);
	const firstTime = Math.ceil((Date.now() + 600_000) / 60_000) * 60_000;
	const at = (notBefore: number): Schedule => ({
		kind: "at",
		notBefore,
		zone: "UTC",
		localWallTime: renderLocalWallTime(notBefore, "UTC"),
		latenessSec: 900,
		holdIfNewInbound: true,
	});
	// Reverse insertion order so the result must use saved notBefore, not creation order.
	const later = await domain.approve(domain.propose("chat", at(firstTime + 120_000)));
	const earlier = await domain.approve(domain.propose("email", at(firstTime)));
	const pending = domain.propose("email", { kind: "now" });
	expect([earlier.state, later.state, pending.state]).toEqual([
		"SCHEDULED",
		"SCHEDULED",
		"PENDING_APPROVAL",
	]);
	const before = persisted(f.session);
	const actual = f.context.summary(f.confirmed.peer);
	expect(ScheduledSummary.safeParse(actual).success).toBe(true);
	expect(Buffer.byteLength(canonicalize(actual))).toBeLessThanOrEqual(8192);
	expect(actual.pendingApprovalCount).toBe(1);
	expect(actual.pendingApprovalIds).toEqual([pending.id]);
	expect(actual.scheduledCount).toBe(2);
	const selected = [earlier, later];
	const expected = selected.map((record) => {
		const snapshot = record.snapshot;
		const account = domain.accountById.get(record.accountId);
		if (snapshot.schedule.kind !== "at" || record.deliverBy === null || account === undefined)
			throw new Error("Genuine scheduled record fixture missing");
		expect(record.notBefore).toBe(snapshot.schedule.notBefore);
		const recipients =
			snapshot.kind === "email"
				? [...snapshot.email.to, ...snapshot.email.cc, ...snapshot.email.bcc]
				: [];
		const destination = snapshot.kind === "email" ? recipients[0] : snapshot.chat.channelName;
		if (destination === undefined) throw new Error("Saved destination fixture missing");
		return {
			outboxId: record.id,
			accountId: record.accountId,
			alias: account.alias,
			destination,
			destinationTruncated: false,
			moreRecipients: snapshot.kind === "email" ? recipients.length - 1 : 0,
			schedule: snapshot.schedule,
			deliverBy: record.deliverBy,
		};
	});
	expect(actual.items).toEqual(expected);
	const authority = f.session.devices.currentState();
	if (authority.ownerUserId === null) throw new Error("Original owner fixture missing");
	expect(actual.scopeHash).toBe(
		scopeHash({
			hub: f.session.identity.hid,
			owner: authority.ownerUserId,
			epoch: authority.epoch,
			scheduling: f.runtime.status(f.confirmed.peer),
			pendingApprovalCount: 1,
			pendingApprovalIds: [pending.id],
			scheduledCount: 2,
			items: selected.map((record) => ({
				outboxId: record.id,
				contentHash: record.contentHash,
				flagsHash: record.flagsHash,
				state: record.state,
			})),
		}),
	);
	expect(f.context.summary(f.limited.peer)).toEqual(actual);
	expect(persisted(f.session)).toEqual(before);
	// This single-owner native fixture has no second same-store owner to manufacture or hide.
	expectUsable(f.key);
});
it("returns the exact saved proposal only to the actual confirmed APPROVE peer without changing stored rows", async () => {
	const f = await setup();
	const foreign = await setup();
	const record = domainProposals(f).propose("email", { kind: "now" });
	expect(record.state).toBe("PENDING_APPROVAL");
	const savedSnapshot = canonicalize(record.snapshot);
	const before = persisted(f.session);
	const actual = f.context.get(f.confirmed.peer, record.id);
	if (actual === undefined) throw new Error("Genuine saved proposal read missing");
	expect(actual).toEqual(record);
	expect(canonicalize(actual.snapshot)).toBe(savedSnapshot);
	expect(actual.contentHash).toBe(record.contentHash);
	expect(actual.flags).toEqual(record.flags);
	expect(actual.flagsHash).toBe(record.flagsHash);
	expect(actual.state).toBe(record.state);
	expect(actual.stateReason).toBe(record.stateReason);
	expect(actual.requiredUsers).toEqual(record.requiredUsers);
	expect(actual.expiresAt).toBe(record.expiresAt);
	expect(persisted(f.session)).toEqual(before);
	for (const [peer, code] of [
		[f.pending.peer, "DEVICE_PENDING"],
		[f.revoked.peer, "DEVICE_REVOKED"],
		[f.limited.peer, "CAPABILITY_MISSING"],
		[foreign.confirmed.peer, "PEER_REFUSED"],
	] as const) {
		authorizationRefusal(() => f.context.get(peer, record.id), code);
		expect(persisted(f.session)).toEqual(before);
	}
	expect(f.context.get(f.confirmed.peer, record.id)).toEqual(record);
	expect(persisted(f.session)).toEqual(before);
	expectUsable(f.key);
});
