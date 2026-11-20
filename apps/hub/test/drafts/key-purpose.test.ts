import { createHmac } from "node:crypto";
import { rmSync } from "node:fs";
import { canonicalize } from "@draftyak/protocol/jcs";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { DraftBinding } from "../../src/drafts/revisions.ts";
import { HubStore } from "../../src/store/store.ts";
import { corruptRevisionStorage } from "./revision-corruption.ts";
import { type RevisionFixture, revisionFixture } from "./revision-fixture.ts";

const fixtures: RevisionFixture[] = [];
async function fixture(): Promise<RevisionFixture> {
	const f = await revisionFixture();
	fixtures.push(f);
	return f;
}
afterEach(() => {
	vi.restoreAllMocks();
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
	if (kind === "revision") {
		corruptRevisionStorage(f, (database) => {
			expect(database.prepare(rows[kind].update).run(mac, bound.draftId).changes).toBe(1);
		});
	} else {
		expect(f.store.write((tx) => tx.run(rows[kind].update, [mac, bound.draftId])).changes).toBe(1);
	}
}

function startup(f: RevisionFixture): void {
	const store = new HubStore(f.options);
	try {
		expect(() => store.read((db) => f.audit.verify(db))).not.toThrow();
	} finally {
		store.close();
	}
}

function fences(f: RevisionFixture, draftId: string): void {
	const immutable = expect.objectContaining({ code: "SQLITE_CONSTRAINT_TRIGGER" });
	f.store.write((tx) => {
		expect(() =>
			tx.run("UPDATE native_draft_revisions SET mac=mac WHERE draft_id=?", [draftId]),
		).toThrow(immutable);
		expect(() =>
			tx.run(
				"INSERT INTO native_draft_revisions SELECT * FROM native_draft_revisions WHERE draft_id=?",
				[draftId],
			),
		).toThrow(immutable);
	});
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
		const original = await fixture(),
			input = original.make(),
			bound = original.bind(input),
			snapshot = original.snapshot(original.create(input));
		original.store.write((tx) => original.freeze.freezeInTransaction(tx, bound, 1, snapshot));
		const f = { ...original, ...original.reopen() },
			proof = f.store.write((tx) => f.freeze.proofInTransaction(tx, bound, snapshot.outbox));
		resign(f, kind, bound, "handles");
		fences(f, bound.draftId);
		startup(f);
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
		startup(f);
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
	it.each(["callback", "restoration"] as const)(
		"rolls back a failed %s without leaving changed rows or schema",
		async (failure) => {
			const f = await fixture(),
				input = f.make(),
				bound = f.bind(input),
				current = f.create(input);
			const before = f.store.read((db) => ({
				rows: db.all("SELECT * FROM native_draft_revisions"),
				catalog: db.all(
					"SELECT type,name,tbl_name,sql FROM main.sqlite_schema ORDER BY type,name,tbl_name,sql",
				),
			}));
			const refusedSetup = new Error("Revision fixture change rolled back");
			expect(() =>
				corruptRevisionStorage(f, (database) => {
					expect(
						database
							.prepare("UPDATE native_draft_revisions SET mac=? WHERE draft_id=?")
							.run("0".repeat(64), bound.draftId).changes,
					).toBe(1);
					if (failure === "callback") throw refusedSetup;
					const execute = database.exec.bind(database);
					vi.spyOn(database, "exec").mockImplementation((sql) => {
						if (sql.startsWith("CREATE TRIGGER native_draft_revisions_no_update"))
							throw refusedSetup;
						return execute(sql);
					});
				}),
			).toThrow(refusedSetup);
			const after = f.store.read((db) => ({
				rows: db.all("SELECT * FROM native_draft_revisions"),
				catalog: db.all(
					"SELECT type,name,tbl_name,sql FROM main.sqlite_schema ORDER BY type,name,tbl_name,sql",
				),
			}));
			expect(after).toEqual(before);
			fences(f, bound.draftId);
			startup(f);
			const next = f.reopen();
			expect(next.revisions.current(bound)).toEqual(current);
		},
	);
});
