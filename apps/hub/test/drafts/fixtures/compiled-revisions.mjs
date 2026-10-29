import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import path from "node:path";
import {
	AuditChain, HubStore, MasterKey, NativeDraftFreeze, NativeDraftRevisions,
} from "./index.mjs";

assert.equal(process.permission?.has("net"), false);
assert.equal(process.execArgv.some(arg => arg.startsWith("--allow-net")), false);
const nativeBinding = process.argv[2];
assert.equal(typeof nativeBinding, "string");
const key = new MasterKey(randomBytes(32)), auditBytes = key.derive("audit");
const audit = new AuditChain(auditBytes);
auditBytes.fill(0);
const options = {
	filename: path.join(import.meta.dirname, "revisions.db"), masterKey: key, nativeBinding,
	migrations: {
		audit: path.join(import.meta.dirname, "store/migrations/audit"),
		revisions: path.join(import.meta.dirname, "drafts/migrations"),
	},
};
const bound = {
	draftId: "01ARZ3NDEKTSV4RRFFQ69G5FA0", accountId: "01ARZ3NDEKTSV4RRFFQ69G5FA1",
	conversationId: "01ARZ3NDEKTSV4RRFFQ69G5FA2", channel: "chat",
};
const author = { kind: "owner", id: "01ARZ3NDEKTSV4RRFFQ69G5FA3" };
let store, revisions;
try {
	store = new HubStore({ ...options, create: true });
	await store.migrate("audit");
	await store.migrate("revisions");
	revisions = new NativeDraftRevisions(store, audit, key);
	const first = store.write(tx => revisions.createInTransaction(tx, {
		...bound, author, content: { channel: "chat", body: "DYTEST original", threadTs: "100.200", broadcast: false }, flags: [],
	}));
	assert.equal(first.draft.rev, 1);
	const second = store.write(tx => revisions.appendInTransaction(tx, {
		...bound, author, expectedRev: 1,
		content: { channel: "chat", body: "DYTEST revised\r\nCafe\u0301", threadTs: "100.200", broadcast: false }, flags: [],
	}));
	assert.equal(second.revision.content.body, "DYTEST revised\nCafé");
	const freeze = new NativeDraftFreeze(revisions), snapshot = {
		v: 1, hub: createHash("sha256").update("DYTEST compiled hub").digest("hex"), epoch: 1,
		outbox: "01ARZ3NDEKTSV4RRFFQ69G5FA4", account: bound.accountId, conversation: bound.conversationId,
		kind: "chat", body: { text: second.revision.content.body, footer: "" }, attachments: [], schedule: { kind: "now" },
		source: { draft: bound.draftId, rev: 2, authors: second.authors },
		chat: { channelId: "C1", channelName: "DYTEST", channelType: "public", external: false, shared: false, memberCount: 2, threadTs: "100.200", broadcast: false },
	};
	const proof = store.write(tx => freeze.freezeInTransaction(tx, bound, 2, snapshot));
	const facts = store.write(tx => freeze.consumeInTransaction(tx, proof));
	assert.equal(facts.rev, 2);
	assert.throws(() => store.write(tx => freeze.consumeInTransaction(tx, proof)));
	revisions.destroy();
	store.close();
	store = new HubStore(options);
	revisions = new NativeDraftRevisions(store, audit, key);
	assert.equal(revisions.current(bound).revision.content.body, "DYTEST revised\nCafé");
	assert.equal(revisions.history(bound).length, 2);
	assert.equal(typeof revisions.current(bound).lockId, "string");
	process.stdout.write(JSON.stringify({ ok: true, revisions: 2, consumed: true, network: false }) + "\n");
} finally {
	revisions?.destroy(); store?.close(); audit.destroy(); key.destroy();
}
