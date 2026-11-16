import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { CurrentSendSnapshotV1 } from "@draftyak/protocol/snapshot";

const [stage, nativeBinding] = process.argv.slice(2);
let phase = "setup", store, revisions, audit, key;
try {
	const { HubStore, MasterKey, AuditChain, NativeDraftRevisions, NativeDraftFreeze } =
		await import(pathToFileURL(path.join(stage, "index.mjs")).href);
	const bytes = randomBytes(32);
	key = new MasterKey(bytes);
	bytes.fill(0);
	const auditKey = key.derive("audit");
	audit = new AuditChain(auditKey);
	auditKey.fill(0);
	const options = {
		filename: path.join(stage, "corrections.db"), nativeBinding, masterKey: key,
		migrations: {
			audit: path.join(stage, "store/migrations/audit"),
			core: path.join(stage, "store/migrations/core"),
			revisions: path.join(stage, "drafts/migrations"),
		},
	};
	store = new HubStore({ ...options, create: true });
	for (const namespace of ["audit", "core", "revisions"]) await store.migrate(namespace);
	let now = 1_800_000_000_000, refused = 0;
	const clock = { wallMs: () => now, monotonicMs: () => 10_000 };
	const id = () => `0${randomBytes(16).toString("hex").slice(0, 25).toUpperCase()}`;
	const emptyHash = createHash("sha256").update("[]").digest("hex");
	const seenDrafts = new Set();
	const state = () => store.read((db) => JSON.stringify([
		db.all("SELECT * FROM native_drafts ORDER BY id"),
		db.all("SELECT * FROM native_draft_revisions ORDER BY draft_id,rev"),
		db.all("SELECT * FROM native_draft_locks ORDER BY id"),
		db.all("SELECT * FROM audit_events ORDER BY seq"), db.all("SELECT * FROM audit_meta"),
	]));
	for (const channel of ["email", "chat"]) {
		phase = "model";
		revisions = new NativeDraftRevisions(store, audit, key, clock);
		let freeze = new NativeDraftFreeze(revisions);
		const bound = { draftId: id(), accountId: id(), conversationId: channel === "email" ? null : id(), channel };
		seenDrafts.add(bound.draftId);
		const content = channel === "email"
			? { channel, to: ["recipient@example.test"], cc: [], bcc: [], subject: "Fixture", body: "https://retired.example.test", attachments: [] }
			: { channel, body: "https://retired.example.test", threadTs: null, broadcast: false };
		const one = store.write((tx) => revisions.createInTransaction(tx, {
			...bound, author: { kind: "owner", id: id() }, content,
			flags: [{ code: "EXTERNAL_LINK", severity: "ack" }],
		}));
		now -= 100;
		const two = store.write((tx) => revisions.appendModelBodyInTransaction(tx, {
			...bound, expectedRev: 1, author: { kind: "ai", id: id() }, body: "Cafe\u0301\r\nclean", flags: [],
		}));
		assert.deepEqual(two.revision.flags, []);
		assert.equal(two.flagsHash, emptyHash);
		assert.deepEqual(two.revision.content, { ...one.revision.content, body: "Café\nclean" });
		assert.equal(two.revision.createdAt, one.revision.createdAt);
		assert.deepEqual(revisions.history(bound), [one.revision, two.revision]);
		const snapshot = () => {
			const common = { v: 1, hub: "a".repeat(64), epoch: 1, outbox: id(), account: bound.accountId,
				conversation: bound.conversationId, body: { text: two.revision.content.body, footer: "" },
				attachments: [], schedule: { kind: "now" },
				source: { draft: bound.draftId, rev: 2, authors: two.authors } };
			return channel === "email"
				? { ...common, kind: "email", email: { from: "sender@example.test", to: content.to, cc: [], bcc: [], subject: content.subject, references: [] } }
				: { ...common, kind: "chat", chat: { channelId: "C1", channelName: "fixture", channelType: "public", external: false, shared: false, memberCount: 2, broadcast: false } };
		};
		phase = "applicability";
		const valid = snapshot();
		const invalid = [{ ...valid, render: { method: "POST", url: "https://api.example.test/send", headersSha256: "b".repeat(64), bodySha256: "c".repeat(64) } }];
		if (channel === "email") for (const headers of [
			{ threadId: "fixture-thread" }, { inReplyTo: "fixture-parent" }, { references: ["fixture-parent"] },
		]) invalid.push({ ...valid, email: { ...valid.email, ...headers } });
		for (const candidate of invalid) {
			assert.deepEqual(CurrentSendSnapshotV1.parse(candidate), candidate);
			const before = state();
			assert.throws(() => store.write((tx) => freeze.freezeInTransaction(tx, bound, 2, candidate)),
				{ code: "DRAFT_REVISION_UNAVAILABLE" });
			assert.equal(state(), before);
			refused++;
		}
		phase = "release";
		store.write((tx) => freeze.freezeInTransaction(tx, bound, 2, valid));
		now -= 100;
		store.write((tx) => freeze.releaseInTransaction(tx, bound, valid.outbox));
		assert.equal(revisions.current(bound).lockId, null);
		const kept = snapshot();
		store.write((tx) => freeze.freezeInTransaction(tx, bound, 2, kept));
		revisions.destroy(); store.close();
		phase = "reopen";
		store = new HubStore(options);
		revisions = new NativeDraftRevisions(store, audit, key, clock);
		freeze = new NativeDraftFreeze(revisions);
		assert.deepEqual(revisions.history(bound), [one.revision, two.revision]);
		phase = "consume";
		now -= 100;
		const facts = store.write((tx) => freeze.consumeInTransaction(tx,
			freeze.proofInTransaction(tx, bound, kept.outbox)));
		assert.deepEqual(facts.snapshot, kept);
		assert.equal(facts.flagsHash, emptyHash);
		assert.equal(revisions.current(bound).revision.createdAt, one.revision.createdAt);
		revisions.destroy();
	}
	phase = "audit";
	const events = store.read((db) => {
		audit.verify(db);
		return audit.exportVerifiedJsonl(db).jsonl.trim().split("\n").map((line) => JSON.parse(line));
	});
	const skew = events.filter((event) => event.action === "draft.clock_skew");
	assert.ok(skew.length > 0);
	for (const event of skew) {
		assert.deepEqual(Object.keys(event.refs), ["clockSkewDraft"]);
		assert.ok(seenDrafts.has(event.refs.clockSkewDraft));
		assert.deepEqual(event.actor, { kind: "hub", id: null });
	}
	process.stdout.write(JSON.stringify({ ok: true, channels: 2, refused, modelFlags: "current",
		clock: "clamped", skew: "signed-id-only", reopened: true }));
} catch {
	process.stdout.write(JSON.stringify({ ok: false, phase }));
	process.exitCode = 1;
} finally {
	revisions?.destroy(); store?.close(); audit?.destroy(); key?.destroy();
}
