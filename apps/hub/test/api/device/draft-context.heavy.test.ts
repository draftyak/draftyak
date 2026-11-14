import { createHash, randomBytes } from "node:crypto";
import type { Socket } from "node:net";
import path from "node:path";
import type { DraftContent } from "@draftyak/protocol/entities/draft";
import { afterEach, expect, it } from "vitest";
import type { NativeDraftReadContext } from "../../../src/api/device/draft-context.ts";
import type { DraftBinding } from "../../../src/drafts/revisions.ts";
import type { HubSession } from "../../../src/lifecycle/session.ts";
import type { NativeFixture } from "../../authz/native-fixture.ts";
import { corruptRevisionStorage } from "../../drafts/revision-corruption.ts";
import { requireLoopbackNetworkGuard } from "../../helpers/loopback-network.ts";
import type { SessionFixture } from "../../lifecycle/session-helpers.ts";

requireLoopbackNetworkGuard();
const [
	{ createNativeDraftReadContext },
	{ AuthzError },
	{ cliConfirmPinScope, revokePinScope },
	{ NativeDraftRevisions },
	{ NativeAccounts },
	{ EventLog },
	{ WorkDatabase },
	{ newId },
	{ systemClock },
	{ nativePairingWindows },
	{ decodePairingPayload, makePairingClaim, pairingEkm, PairingReveal },
	{ canonicalize },
	{ sessionFixture, sessionTransport, closeSessionTransport, expectErased, expectUsable },
	{ admit, bootstrap, device, idOf, owner, PIN },
] = await Promise.all([
	import("../../../src/api/device/draft-context.ts"),
	import("../../../src/authz/errors.ts"),
	import("../../../src/authz/scopes.ts"),
	import("../../../src/drafts/revisions.ts"),
	import("../../../src/accounts/records.ts"),
	import("../../../src/events/log.ts"),
	import("../../../src/jobs/database.ts"),
	import("../../../src/kernel/ids.ts"),
	import("../../../src/kernel/clock.ts"),
	import("../../../src/lifecycle/session.ts"),
	import("@draftyak/protocol/pairing"),
	import("@draftyak/protocol/jcs"),
	import("../../lifecycle/session-helpers.ts"),
	import("../../authz/native-fixture.ts"),
]);

const fixtures: SessionFixture[] = [];
const sessions: HubSession[] = [];
const transports: NativeFixture[] = [];
const children = new Set<NativeDraftReadContext>();
const writers = new Set<InstanceType<typeof NativeDraftRevisions>>();

async function destroy(socket: Socket): Promise<void> {
	if (socket.closed) return;
	const closed = new Promise<void>((resolve) => socket.once("close", () => resolve()));
	socket.destroy();
	await closed;
}
afterEach(async () => {
	let failed = false;
	for (const child of children) {
		try {
			await child.close();
		} catch {
			failed = true;
		}
	}
	for (const writer of writers) {
		try {
			writer.destroy();
		} catch {
			failed = true;
		}
	}
	const sockets = await Promise.allSettled(
		transports.flatMap((native) => native.devices.map((client) => destroy(client.socket))),
	);
	const listeners = await Promise.allSettled(transports.map(closeSessionTransport));
	const owners = await Promise.allSettled(sessions.map((session) => session.close()));
	if (
		failed ||
		[...sockets, ...listeners, ...owners].some((result) => result.status === "rejected")
	)
		throw new Error("Native draft read fixture cleanup incomplete");
	children.clear();
	writers.clear();
	transports.length = 0;
	sessions.length = 0;
	for (const fixture of fixtures.splice(0)) await fixture.remove();
});

async function limitedReader(
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
		claimBytes = Buffer.from(
			canonicalize(
				makePairingClaim(
					{ pid: payload.pid, role: payload.role, sec: payload.sec },
					{
						name: "DYTEST draft reader",
						transportSpkiSha256: limited.transportSpkiSha256,
						signingKey: limited.signingKey,
					},
					ekm,
					nonce,
				),
			),
		);
		revealBytes = Buffer.from(
			canonicalize(
				PairingReveal.parse({
					pid: payload.pid,
					nd: nonce.toString("base64url"),
				}),
			),
		);
		const answer = windows.claim(limited.peer, claimBytes);
		const revealed = windows.reveal(limited.peer, revealBytes);
		if (answer.deviceId !== revealed.deviceId)
			throw new Error("Native draft reader pairing identity refused");
		limited.id = revealed.deviceId;
		const proof = await native.pins.verify(
			owner(native),
			PIN,
			cliConfirmPinScope(revealed.deviceId),
		);
		const granted = native.store.write((tx) =>
			native.registry.confirmFromCli(tx, revealed.deviceId, proof),
		);
		expect(granted.capabilities).toEqual(["read", "draft"]);
		return limited;
	} finally {
		nonce.fill(0);
		ekm?.fill(0);
		claimBytes?.fill(0);
		revealBytes?.fill(0);
	}
}
async function setup() {
	const fixture = sessionFixture("draftyak-native-draft-read-");
	fixtures.push(fixture);
	const key = fixture.key();
	const session = await fixture.open({ masterKey: key });
	sessions.push(session);
	const native = await sessionTransport(session, key, fixture.folder);
	transports.push(native);
	const pending = await device(native);
	admit(native, pending);
	const confirmed = await bootstrap(native);
	const limited = await limitedReader(session, native, confirmed);
	return { fixture, key, session, native, pending, confirmed, limited };
}
function savedDraft(
	f: Awaited<ReturnType<typeof setup>>,
	user = owner(f.native),
	accountChannel: DraftBinding["channel"] = "email",
) {
	const now = Date.now();
	const database = new WorkDatabase(f.session.store);
	const accounts = new NativeAccounts(
		database,
		new EventLog(database, systemClock.wallMs),
		f.session.audit,
		systemClock.wallMs,
	);
	const binding: DraftBinding = {
		draftId: newId(now),
		accountId: newId(now),
		conversationId: null,
		channel: "email",
	};
	database.write((scope) =>
		accounts.create(scope, {
			id: binding.accountId,
			userId: user,
			pluginInstanceId: newId(now),
			...(accountChannel === "chat"
				? { channel: "chat" as const, teamId: "DYTEST-team", selfUserId: "DYTEST-self" }
				: { channel: "email" as const, address: "dytest-draft-owner@example.invalid" }),
			alias: "dytest-draft-read",
			mode: "read_only",
			status: "active",
			deletionDeadline: null,
			historyLimitDays: 30,
			disclosureVersion: 1,
			createdAt: now,
		}),
	);
	const revisions = new NativeDraftRevisions(f.session.store, f.session.audit, f.key, systemClock);
	writers.add(revisions);
	const content: DraftContent = {
		channel: "email",
		to: ["dytest-recipient@example.invalid"],
		cc: [],
		bcc: [],
		subject: "DYTEST saved draft",
		body: "DYTEST original saved body",
		attachments: [],
	};
	const first = f.session.store.write((tx) =>
		revisions.createInTransaction(tx, {
			...binding,
			content,
			flags: [],
			author: { kind: "owner", id: user },
		}),
	);
	const current = f.session.store.write((tx) =>
		revisions.appendInTransaction(tx, {
			...binding,
			expectedRev: first.revision.rev,
			content: { ...content, body: "DYTEST current saved body" },
			flags: [],
			author: { kind: "owner", id: user },
		}),
	);
	expect(current.revision.rev).toBe(2);
	const account = () => database.write((scope) => accounts.get(scope, user, binding.accountId));
	return { binding, first, current, revisions, account };
}
function persisted(session: HubSession) {
	return session.store.read((db) =>
		Object.fromEntries(
			[
				"accounts",
				"native_drafts",
				"native_draft_revisions",
				"native_draft_locks",
				"audit_events",
				"events",
			].map((table) => {
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
		),
	);
}
function refusal(work: () => unknown, code: string): void {
	let caught: unknown;
	try {
		work();
	} catch (error) {
		caught = error;
	}
	expect(caught instanceof AuthzError).toBe(true);
	expect(caught instanceof AuthzError && caught.code === code).toBe(true);
}

it("reads the authenticated saved current revision through the original cached READ facade", async () => {
	const f = await setup();
	const saved = savedDraft(f);
	const before = persisted(f.session);
	const reads = f.session.draftReads();
	expect(f.session.draftReads()).toBe(reads);
	expect(Object.isFrozen(reads)).toBe(true);
	expect(Reflect.ownKeys(reads)).toEqual(["get", "history"]);
	for (const peer of [f.confirmed.peer, f.limited.peer]) {
		const actual = reads.get(peer, saved.binding.draftId);
		expect(actual).toEqual(saved.current);
		expect(actual?.revision.rev).toBe(2);
		expect(actual?.revision.content.body).toBe("DYTEST current saved body");
	}
	expect(persisted(f.session)).toEqual(before);
	f.session.store.read((db) => f.session.audit.verify(db));
	expectUsable(f.key);
});

it("requires original current READ peers and withdraws a genuinely revoked reader", async () => {
	const f = await setup();
	const foreign = await setup();
	const saved = savedDraft(f);
	const reads = f.session.draftReads();
	const before = persisted(f.session);
	refusal(() => reads.get(f.pending.peer, saved.binding.draftId), "DEVICE_PENDING");
	refusal(() => reads.history(f.pending.peer, saved.binding.draftId), "DEVICE_PENDING");
	refusal(() => reads.get(foreign.confirmed.peer, saved.binding.draftId), "PEER_REFUSED");
	refusal(() => reads.history(foreign.confirmed.peer, saved.binding.draftId), "PEER_REFUSED");
	expect(reads.get(f.limited.peer, saved.binding.draftId)).toEqual(saved.current);
	expect(persisted(f.session)).toEqual(before);
	const limitedId = idOf(f.limited);
	const proof = await f.native.pins.verify(owner(f.native), PIN, revokePinScope(limitedId));
	expect(
		f.native.store.write((tx) =>
			f.native.registry.revoke(tx, limitedId, {
				kind: "device",
				id: idOf(f.confirmed),
				proof,
			}),
		),
	).toBe(true);
	const revoked = persisted(f.session);
	refusal(() => reads.get(f.limited.peer, saved.binding.draftId), "DEVICE_REVOKED");
	refusal(() => reads.history(f.limited.peer, saved.binding.draftId), "DEVICE_REVOKED");
	expect(reads.get(f.confirmed.peer, saved.binding.draftId)).toEqual(saved.current);
	expect(persisted(f.session)).toEqual(revoked);
	expectUsable(f.key);
});

it("distinguishes an authentic unused id from an unauthenticated stored header", async () => {
	const f = await setup();
	const saved = savedDraft(f);
	const reads = f.session.draftReads();
	const before = persisted(f.session);
	expect(reads.get(f.confirmed.peer, newId(Date.now()))).toBeUndefined();
	expect(persisted(f.session)).toEqual(before);
	// Negative tampering DATA cannot replace a domain-authenticated positive revision.
	f.session.store.write((tx) =>
		tx.run("UPDATE native_drafts SET mac=? WHERE id=?", ["0".repeat(64), saved.binding.draftId]),
	);
	const tampered = persisted(f.session);
	refusal(() => reads.get(f.confirmed.peer, saved.binding.draftId), "UNAVAILABLE");
	expect(persisted(f.session)).toEqual(tampered);
	expectUsable(f.key);
});

it("closes only a standalone child and fences cached reads on original session retirement", async () => {
	const f = await setup();
	const saved = savedDraft(f);
	const child = createNativeDraftReadContext(f.session, f.key);
	children.add(child);
	expect(child.get(f.confirmed.peer, saved.binding.draftId)).toEqual(saved.current);
	await child.close();
	await child.close();
	refusal(() => child.get(f.confirmed.peer, saved.binding.draftId), "UNAVAILABLE");
	refusal(() => child.history(f.confirmed.peer, saved.binding.draftId), "UNAVAILABLE");
	expectUsable(f.key);
	expect(
		f.session.store.read(
			(db) => f.native.authorizer.requirePeerDevice(db, f.confirmed.peer, "read").deviceId,
		),
	).toBe(idOf(f.confirmed));
	const cached = f.session.draftReads();
	expect(cached.get(f.confirmed.peer, saved.binding.draftId)).toEqual(saved.current);
	await f.session.close();
	expectErased(f.key);
	expect(() => cached.get(f.confirmed.peer, saved.binding.draftId)).toThrow();
	expect(() => cached.history(f.confirmed.peer, saved.binding.draftId)).toThrow();
	expect(() => f.session.draftReads()).toThrow();
});

it("pages authenticated history in saved order and distinguishes an empty page from a missing draft", async () => {
	const f = await setup();
	const saved = savedDraft(f);
	const reads = f.session.draftReads();
	const before = persisted(f.session);
	for (const peer of [f.confirmed.peer, f.limited.peer]) {
		const history = reads.history(peer, saved.binding.draftId);
		expect(history).toEqual([saved.first.revision, saved.current.revision]);
		expect(history?.map((revision) => revision.rev)).toEqual([1, 2]);
		expect(reads.history(peer, saved.binding.draftId, 0, 1)).toEqual([saved.first.revision]);
		expect(reads.history(peer, saved.binding.draftId, 1, 1)).toEqual([saved.current.revision]);
		expect(reads.history(peer, saved.binding.draftId, 2, 1)).toEqual([]);
		expect(reads.history(peer, newId(Date.now()))).toBeUndefined();
	}
	for (const id of [saved.binding.draftId, newId(Date.now())]) {
		refusal(() => reads.history(f.confirmed.peer, id, -1, 1), "UNAVAILABLE");
		refusal(() => reads.history(f.confirmed.peer, id, 0, 33), "UNAVAILABLE");
	}
	expect(persisted(f.session)).toEqual(before);
	f.session.store.read((db) => f.session.audit.verify(db));
	expectUsable(f.key);
});

it("refuses corruption outside the requested history page without changing the saved rows", async () => {
	const f = await setup();
	const saved = savedDraft(f);
	const reads = f.session.draftReads();
	expect(reads.history(f.confirmed.peer, saved.binding.draftId, 1, 1)).toEqual([
		saved.current.revision,
	]);
	// This public negative fixture changes one real stored row and restores the original SQL fence.
	corruptRevisionStorage(
		{
			filename: path.join(f.fixture.folder, "draftyak.db"),
			store: f.session.store,
			key: f.key,
		},
		(database) => {
			database
				.prepare("UPDATE native_draft_revisions SET mac=? WHERE draft_id=? AND rev=1")
				.run("0".repeat(64), saved.binding.draftId);
		},
	);
	const tampered = persisted(f.session);
	for (const peer of [f.confirmed.peer, f.limited.peer])
		refusal(() => reads.history(peer, saved.binding.draftId, 1, 1), "UNAVAILABLE");
	expect(persisted(f.session)).toEqual(tampered);
	expectUsable(f.key);
});

it("refuses an authentic saved draft belonging to a different actual account owner", async () => {
	const f = await setup();
	const foreign = await setup();
	const foreignOwner = owner(foreign.native);
	expect(foreignOwner === owner(f.native)).toBe(false);
	// Account and revision DATA come from the real domain constructors, never a forged grant.
	const saved = savedDraft(f, foreignOwner);
	expect(saved.current.revision.rev).toBe(2);
	expect(
		f.session.store.read((db) =>
			db.get<{ user_id: string }>("SELECT user_id FROM main.accounts WHERE id=?", [
				saved.binding.accountId,
			]),
		)?.user_id,
	).toBe(foreignOwner);
	const reads = f.session.draftReads();
	const before = persisted(f.session);
	for (const peer of [f.confirmed.peer, f.limited.peer]) {
		refusal(() => reads.get(peer, saved.binding.draftId), "UNAVAILABLE");
		refusal(() => reads.history(peer, saved.binding.draftId), "UNAVAILABLE");
	}
	expect(persisted(f.session)).toEqual(before);
	f.session.store.read((db) => f.session.audit.verify(db));
	expectUsable(f.key);
});

it("refuses authentic email draft reads when the same owner's account is chat", async () => {
	const f = await setup();
	const saved = savedDraft(f, owner(f.native), "chat");
	expect(saved.binding.channel).toBe("email");
	const account = saved.account()?.account;
	expect(account?.userId).toBe(owner(f.native));
	expect(account?.channel).toBe("chat");
	// The original domain receiver authenticates the complete chain and lower revision.
	expect(saved.revisions.current(saved.binding)).toEqual(saved.current);
	expect(saved.revisions.history(saved.binding)).toEqual([
		saved.first.revision,
		saved.current.revision,
	]);
	expect(saved.revisions.history(saved.binding, 0, 1)).toEqual([saved.first.revision]);
	const reads = f.session.draftReads();
	expect(f.session.draftReads()).toBe(reads);
	const before = persisted(f.session);
	const outcome = (read: () => unknown): string => {
		try {
			read();
			return "RETURNED";
		} catch (error) {
			return error instanceof AuthzError ? error.code : "UNEXPECTED_ERROR";
		}
	};
	const outcomes: string[] = [];
	for (const peer of [f.confirmed.peer, f.limited.peer]) {
		outcomes.push(outcome(() => reads.get(peer, saved.binding.draftId)));
		outcomes.push(outcome(() => reads.history(peer, saved.binding.draftId)));
	}
	// Collect every endpoint/peer outcome before asserting any refusal.
	expect(outcomes).toEqual(["UNAVAILABLE", "UNAVAILABLE", "UNAVAILABLE", "UNAVAILABLE"]);
	expect(persisted(f.session)).toEqual(before);
	f.session.store.read((db) => f.session.audit.verify(db));
	expectUsable(f.key);
});
