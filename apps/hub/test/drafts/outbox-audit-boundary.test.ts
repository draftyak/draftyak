import { lstatSync, realpathSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { canonicalize } from "@draftyak/protocol/jcs";
import { afterEach, expect, it } from "vitest";
import { newId } from "../../src/kernel/ids.ts";
import type { SqlReader } from "../../src/store/store.ts";
import { type RevisionFixture, revisionFixture } from "./revision-fixture.ts";

const actions = [
	"outbox.proposed",
	"outbox.superseded",
	"outbox.approved",
	"outbox.missed",
] as const;
const fixtures: {
	fixture: RevisionFixture;
	directory: string;
	parent: string;
	dev: number;
	ino: number;
}[] = [];

async function fixture(): Promise<RevisionFixture> {
	const value = await revisionFixture(),
		directory = realpathSync(value.dir),
		identity = lstatSync(directory);
	fixtures.push({
		fixture: value,
		directory,
		parent: realpathSync(os.tmpdir()),
		dev: identity.dev,
		ino: identity.ino,
	});
	return value;
}

afterEach(() => {
	for (const saved of fixtures.splice(0)) {
		const f = saved.fixture;
		for (const service of f.services) service.destroy();
		for (const store of f.stores) store.close();
		f.audit.destroy();
		f.key.destroy();
		const current = lstatSync(f.dir);
		if (
			path.dirname(saved.directory) !== saved.parent ||
			!path.basename(saved.directory).startsWith("draftyak-native-revisions-") ||
			current.isSymbolicLink() ||
			!current.isDirectory() ||
			realpathSync(f.dir) !== saved.directory ||
			current.dev !== saved.dev ||
			current.ino !== saved.ino
		)
			throw new Error("DYTEST cleanup scope refused");
		rmSync(saved.directory, { recursive: true, force: false });
	}
});

function auditRows(db: SqlReader): unknown {
	return {
		events: db.all("SELECT * FROM main.audit_events ORDER BY seq"),
		meta: db.all("SELECT * FROM main.audit_meta ORDER BY singleton"),
	};
}

it("persists every fixed outbox action with exact references and its real audit receipt", async () => {
	const f = await fixture(),
		outbox = newId(f.time.now);
	let previous = f.store.read((db) =>
		db.get<{ audit_seq: number }>("SELECT audit_seq FROM main.audit_meta WHERE singleton=1"),
	)?.audit_seq;
	if (previous === undefined) throw new Error("DYTEST missing audit head");
	for (const action of actions) {
		const receipt = f.store.write((tx) => f.revisions.auditOutboxInTransaction(tx, action, outbox));
		const persisted = f.store.read((db) => ({
			event: db.get<{ seq: number; action: string; refs: string; mac: string }>(
				"SELECT seq,action,refs,mac FROM main.audit_events WHERE seq=?",
				[receipt.seq],
			),
			head: db.get<{ audit_seq: number; audit_head: string }>(
				"SELECT audit_seq,audit_head FROM main.audit_meta WHERE singleton=1",
			),
		}));
		expect(receipt.seq).toBe(previous + 1);
		expect(receipt.mac).toMatch(/^[0-9a-f]{64}$/);
		expect(persisted.event).toEqual({
			seq: receipt.seq,
			action,
			refs: canonicalize({ outbox }),
			mac: receipt.mac,
		});
		expect(persisted.head).toEqual({ audit_seq: receipt.seq, audit_head: receipt.mac });
		expect(receipt).toEqual({ seq: persisted.event?.seq, mac: persisted.event?.mac });
		f.store.read((db) => f.audit.verify(db));
		previous = receipt.seq;
	}
});

it("refuses runtime actions and invalid outbox IDs without changing audit rows or head when caught", async () => {
	const f = await fixture(),
		outbox = newId(f.time.now);
	f.store.write((tx) => f.revisions.auditOutboxInTransaction(tx, "outbox.proposed", outbox));
	const before = f.store.read(auditRows),
		invalidActions = [
			"draft.created",
			"draft.appended",
			"draft.freeze",
			"draft.frozen",
			"outbox.sent",
			"outbox.approved.extra",
			"",
		],
		invalidIds: unknown[] = [
			"",
			"not-an-id",
			"I".repeat(26),
			outbox.slice(1),
			null,
			17,
			Object.freeze({ outbox, draft: outbox }),
		],
		calls = [
			...invalidActions.map((action) => ({ action, id: outbox as unknown })),
			...invalidIds.map((id) => ({ action: "outbox.proposed", id })),
		];
	const result = f.store.write((tx) => {
		const errors: unknown[] = [];
		for (const call of calls) {
			try {
				f.revisions.auditOutboxInTransaction(
					tx,
					call.action as (typeof actions)[number],
					call.id as string,
				);
				errors.push(undefined);
			} catch (error) {
				errors.push(error);
			}
		}
		return { errors, audit: auditRows(tx) };
	});
	// Inspect committed and in-transaction state before classifying the caught refusals.
	expect(f.store.read(auditRows)).toEqual(before);
	expect(result.audit).toEqual(before);
	expect(result.errors).toHaveLength(calls.length);
	for (const error of result.errors)
		expect(error).toMatchObject({ code: "DRAFT_REVISION_UNAVAILABLE" });
	f.store.read((db) => f.audit.verify(db));
});
