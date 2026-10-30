import { createHmac } from "node:crypto";
import { rmSync } from "node:fs";
import { canonicalize } from "@draftyak/protocol/jcs";
import { afterEach, describe, expect, it } from "vitest";
import type { DraftBinding } from "../../src/drafts/revisions.ts";
import { type RevisionFixture, revisionFixture } from "./revision-fixture.ts";

const fixtures: RevisionFixture[] = [];
async function fixture(): Promise<RevisionFixture> {
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
const refused = expect.objectContaining({ code: "DRAFT_REVISION_UNAVAILABLE" });
const rows = {
	header: {
		domain: "header",
		select: "SELECT id,payload,audit_seq,mac FROM native_drafts WHERE id=?",
		update: "UPDATE native_drafts SET mac=? WHERE id=?",
	},
	revision: {
		domain: "revision",
		select: "SELECT draft_id,rev,payload,previous,mac FROM native_draft_revisions WHERE draft_id=?",
		update: "UPDATE native_draft_revisions SET mac=? WHERE draft_id=?",
	},
	lock: {
		domain: "freeze",
		select:
			"SELECT id,draft_id,outbox_id,payload,audit_seq,mac FROM native_draft_locks WHERE draft_id=?",
		update: "UPDATE native_draft_locks SET mac=? WHERE draft_id=?",
	},
} as const;
type Kind = keyof typeof rows;
const kinds: Kind[] = ["header", "revision", "lock"];

// The stored MAC of the draft's one row of this kind, and the value that MAC covers.
function stored(f: RevisionFixture, kind: Kind, bound: DraftBinding) {
	const row = f.store.read((db) =>
		db.get<Record<string, unknown> & { mac: string }>(rows[kind].select, [bound.draftId]),
	);
	if (!row) throw new Error("missing row");
	const { mac, ...value } = row;
	return { mac, value: kind === "revision" ? { binding: bound, ...value } : value };
}
function sign(
	f: RevisionFixture,
	kind: Kind,
	value: unknown,
	purpose: "drafts" | "handles",
): string {
	const subkey = f.key.derive(purpose);
	try {
		return createHmac("sha256", subkey)
			.update(`draftyak/draft-${rows[kind].domain}/v1\n`)
			.update(canonicalize(value))
			.digest("hex");
	} finally {
		subkey.fill(0);
	}
}
function resign(
	f: RevisionFixture,
	kind: Kind,
	bound: DraftBinding,
	purpose: "drafts" | "handles",
): void {
	const mac = sign(f, kind, stored(f, kind, bound).value, purpose);
	f.store.write((tx) => tx.run(rows[kind].update, [mac, bound.draftId]));
}

describe("draft MAC key purpose", () => {
	it("signs header, revision and lock rows with the dedicated drafts subkey", async () => {
		const f = await fixture(),
			input = f.make(),
			bound = f.bind(input),
			snapshot = f.snapshot(f.create(input));
		f.store.write((tx) => f.freeze.freezeInTransaction(tx, bound, 1, snapshot));
		for (const kind of kinds) {
			const { mac, value } = stored(f, kind, bound);
			expect(mac).toBe(sign(f, kind, value, "drafts"));
			expect(mac).not.toBe(sign(f, kind, value, "handles"));
		}
	});
	it.each(kinds)("refuses a %s row MACed under the old handles purpose", async (kind) => {
		const f = await fixture(),
			input = f.make(),
			bound = f.bind(input),
			snapshot = f.snapshot(f.create(input)),
			proof = f.store.write((tx) => f.freeze.freezeInTransaction(tx, bound, 1, snapshot));
		resign(f, kind, bound, "handles");
		if (kind !== "lock") {
			expect(() => f.revisions.current(bound)).toThrow(refused);
			expect(() => f.revisions.history(bound)).toThrow(refused);
		}
		expect(() =>
			f.store.write((tx) => f.freeze.proofInTransaction(tx, bound, snapshot.outbox)),
		).toThrow(refused);
		expect(() => f.store.write((tx) => f.freeze.consumeInTransaction(tx, proof))).toThrow(refused);
		expect(() =>
			f.store.write((tx) => f.freeze.releaseInTransaction(tx, bound, snapshot.outbox)),
		).toThrow(refused);
		resign(f, kind, bound, "drafts");
		f.store.write((tx) => f.freeze.releaseInTransaction(tx, bound, snapshot.outbox));
		expect(f.revisions.current(bound).lockId).toBeNull();
	});
	it("refuses to set a lock whose row is MACed under the old handles purpose", async () => {
		const f = await fixture(),
			input = f.make(),
			bound = f.bind(input),
			snapshot = f.snapshot(f.create(input));
		f.store.write((tx) => f.freeze.freezeInTransaction(tx, bound, 1, snapshot));
		const lock = f.revisions.current(bound).lockId as string,
			set = () => f.store.write((tx) => f.revisions.setLockInTransaction(tx, bound, 1, null, lock));
		f.store.write((tx) => f.revisions.setLockInTransaction(tx, bound, 1, lock, null));
		resign(f, "lock", bound, "handles");
		expect(set).toThrow(refused);
		expect(f.revisions.current(bound).lockId).toBeNull();
		resign(f, "lock", bound, "drafts");
		expect(set().lockId).toBe(lock);
	});
});
