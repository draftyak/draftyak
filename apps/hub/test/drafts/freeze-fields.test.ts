import { rmSync } from "node:fs";
import { canonicalize } from "@draftyak/protocol/jcs";
import { CurrentSendSnapshotV1 } from "@draftyak/protocol/snapshot";
import { afterEach, expect, it } from "vitest";
import { newId } from "../../src/kernel/ids.ts";
import { type RevisionFixture, revisionFixture } from "./revision-fixture.ts";

const fixtures: RevisionFixture[] = [];
async function fixture() {
	const f = await revisionFixture();
	fixtures.push(f);
	return f;
}
afterEach(() => {
	for (const f of fixtures.splice(0)) {
		for (const service of f.services) service.destroy();
		for (const store of f.stores) store.close();
		f.audit.destroy();
		f.key.destroy();
		rmSync(f.dir, { recursive: true, force: true });
	}
});

function prepared(f: RevisionFixture, channel: "email" | "chat", linked = false) {
	const initial = f.make(channel);
	const input = linked ? { ...initial, conversationId: newId() } : initial;
	const current = f.create(input);
	return { bound: f.bind(input), current, snapshot: f.snapshot(current) };
}
function stored(f: RevisionFixture) {
	return f.store.read((db) => ({
		drafts: db.all("SELECT * FROM native_drafts ORDER BY id"),
		revisions: db.all("SELECT * FROM native_draft_revisions ORDER BY draft_id,rev"),
		locks: db.all("SELECT * FROM native_draft_locks ORDER BY id"),
		events: db.all("SELECT * FROM audit_events ORDER BY seq"),
		audit: db.all("SELECT * FROM audit_meta"),
	}));
}
const requestRender = {
	method: "POST" as const,
	url: "https://api.example.test/send",
	headersSha256: "a".repeat(64),
	bodySha256: "b".repeat(64),
};
const thread = {
	threadId: "DYTEST-thread",
	inReplyTo: "DYTEST-parent",
	references: ["DYTEST-reference"],
};

it.each(["email", "chat"] as const)(
	"refuses a request render on a schema-valid %s snapshot without changing stored state",
	async (channel) => {
		const f = await fixture();
		const { bound, current, snapshot } = prepared(f, channel);
		const candidate = { ...snapshot, render: requestRender };
		expect(CurrentSendSnapshotV1.parse(candidate)).toEqual(candidate);
		const before = stored(f);
		expect(() =>
			f.store.write((tx) => f.freeze.freezeInTransaction(tx, bound, 1, candidate)),
		).toThrow("Draft revision unavailable");
		expect(stored(f)).toEqual(before);
		expect(f.revisions.current(bound)).toEqual(current);
	},
);

it.each([
	["threadId", { threadId: thread.threadId }],
	["inReplyTo", { inReplyTo: thread.inReplyTo }],
	["references", { references: thread.references }],
	["all threading fields", thread],
] as const)(
	"refuses %s on a new email even when the snapshot schema admits it",
	async (_field, headers) => {
		const f = await fixture();
		const { bound, current, snapshot } = prepared(f, "email");
		if (snapshot.kind !== "email") throw new Error("Expected an email fixture");
		expect(bound.conversationId).toBeNull();
		const candidate = { ...snapshot, email: { ...snapshot.email, ...headers } };
		expect(CurrentSendSnapshotV1.parse(candidate)).toEqual(candidate);
		const before = stored(f);
		expect(() =>
			f.store.write((tx) => f.freeze.freezeInTransaction(tx, bound, 1, candidate)),
		).toThrow("Draft revision unavailable");
		expect(stored(f)).toEqual(before);
		expect(f.revisions.current(bound)).toEqual(current);
	},
);

it.each([false, true])(
	"preserves a valid email freeze and consumption (existing conversation: %s)",
	async (linked) => {
		const f = await fixture();
		const { bound, snapshot } = prepared(f, "email", linked);
		if (snapshot.kind !== "email") throw new Error("Expected an email fixture");
		const candidate = linked ? { ...snapshot, email: { ...snapshot.email, ...thread } } : snapshot;
		expect(bound.conversationId === null).toBe(!linked);
		expect(CurrentSendSnapshotV1.parse(candidate)).toEqual(candidate);
		const facts = f.store.write((tx) => {
			const proof = f.freeze.freezeInTransaction(tx, bound, 1, candidate);
			return f.freeze.consumeInTransaction(tx, proof);
		});
		expect(facts.snapshot).toEqual(candidate);
	},
);

interface FreezeRow {
	id: string;
	draft_id: string;
	outbox_id: string;
	payload: string;
	audit_seq: number;
	mac: string;
}

it.each(["email-render", "chat-render", "new-email-thread"] as const)(
	"rechecks an authenticated stored %s snapshot before reopening or consuming its proof",
	async (variant) => {
		const f = await fixture();
		const { bound, snapshot } = prepared(f, variant === "chat-render" ? "chat" : "email");
		const proof = f.store.write((tx) => f.freeze.freezeInTransaction(tx, bound, 1, snapshot));
		const row = f.store.read((db) =>
			db.get<FreezeRow>("SELECT * FROM native_draft_locks WHERE outbox_id=?", [snapshot.outbox]),
		);
		if (!row) throw new Error("Expected a stored fixture lock");
		const payload = JSON.parse(row.payload);
		if (variant === "new-email-thread")
			payload.snapshot.email = { ...payload.snapshot.email, ...thread };
		else payload.snapshot.render = requestRender;
		expect(CurrentSendSnapshotV1.parse(payload.snapshot)).toEqual(payload.snapshot);
		const { mac: _oldMac, ...signed } = row;
		const changed = { ...signed, payload: canonicalize(payload) };
		// Model a correctly authenticated legacy lock, so refusal must come from applicability.
		const mac = f.revisions.sign("freeze", changed);
		f.store.write((tx) =>
			tx.run("UPDATE native_draft_locks SET payload=?,mac=? WHERE id=?", [
				changed.payload,
				mac,
				row.id,
			]),
		);
		const before = stored(f);
		expect(() =>
			f.store.write((tx) => f.freeze.proofInTransaction(tx, bound, snapshot.outbox)),
		).toThrow("Draft revision unavailable");
		expect(() => f.store.write((tx) => f.freeze.consumeInTransaction(tx, proof))).toThrow(
			"Draft revision unavailable",
		);
		expect(stored(f)).toEqual(before);
	},
);
