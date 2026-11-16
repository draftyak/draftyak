import { rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { DraftRevision } from "@draftyak/protocol/entities/draft";
import { canonicalize } from "@draftyak/protocol/jcs";
import { contentHash } from "@draftyak/protocol/snapshot";
import { afterEach, describe, expect, it } from "vitest";
import { type FrozenRevisionProof, NativeDraftFreeze } from "../../src/drafts/freeze.ts";
import { NativeDraftRevisions, type NativeRevision } from "../../src/drafts/revisions.ts";
import { newId } from "../../src/kernel/ids.ts";
import type { HubStore, SqlTransaction } from "../../src/store/store.ts";
import { revisionFixture } from "./revision-fixture.ts";

type Fixture = Awaited<ReturnType<typeof revisionFixture>>;
interface RevisionRow {
	draft_id: string;
	rev: number;
	payload: string;
	previous: string;
	mac: string;
}
interface HeaderRow {
	id: string;
	payload: string;
	audit_seq: number;
	mac: string;
}
type LegacySign = (domain: "header" | "revision" | "freeze", value: unknown) => string;
type LegacyAudit = (
	tx: SqlTransaction,
	action: string,
	refs: Record<string, string>,
) => { seq: number; mac: string };
const genericHelpers = ["sign", "checkMac", "read", "write", "auditInTransaction"] as const;
const fixtures: Fixture[] = [];

async function fixture(): Promise<Fixture> {
	const value = await revisionFixture();
	fixtures.push(value);
	return value;
}
afterEach(() => {
	for (const f of fixtures.splice(0)) {
		for (const service of f.services) service.destroy();
		for (const store of f.stores) store.close();
		f.audit.destroy();
		f.key.destroy();
		const target = path.resolve(f.dir);
		if (
			path.dirname(target) !== path.resolve(os.tmpdir()) ||
			!path.basename(target).startsWith("draftyak-native-revisions-")
		)
			throw new Error("DYTEST cleanup scope refused");
		rmSync(target, { recursive: true, force: true });
	}
});

function stored(store: HubStore): unknown {
	return store.read((tx) => ({
		headers: tx.all("SELECT * FROM main.native_drafts ORDER BY id"),
		revisions: tx.all("SELECT * FROM main.native_draft_revisions ORDER BY draft_id,rev"),
		locks: tx.all("SELECT * FROM main.native_draft_locks ORDER BY id"),
		audit: tx.all("SELECT * FROM main.audit_events ORDER BY seq"),
		meta: tx.all("SELECT * FROM main.audit_meta"),
	}));
}

describe("native draft authentication authority", () => {
	it("refuses replacement of purged history through caller-visible native helpers", async () => {
		const f = await fixture(),
			input = f.make("chat"),
			bound = f.bind(input),
			original = f.create(input);
		const donor = f.create({
			...input,
			draftId: newId(f.time.now),
			content: { ...input.content, body: "DYTEST forged history" },
		});
		// Native creation supplies a valid normalized payload/hash; the attacker never derives a key.
		const replacement = DraftRevision.parse({
			...donor.revision,
			draftId: input.draftId,
			rev: 1,
			createdAt: original.revision.createdAt,
		});
		expect(replacement.content.body).not.toBe(original.revision.content.body);
		expect(replacement.contentSha256).not.toBe(original.revision.contentSha256);
		const old = f.store.read((tx) => ({
			revision: tx.get<RevisionRow>(
				"SELECT * FROM main.native_draft_revisions WHERE draft_id=? AND rev=1",
				[input.draftId],
			),
			header: tx.get<HeaderRow>("SELECT * FROM main.native_drafts WHERE id=?", [input.draftId]),
		}));
		if (!old.revision || !old.header) throw new Error("DYTEST native rows missing");
		const previousRevision = old.revision,
			previousHeader = old.header;
		const sign = Reflect.get(f.revisions, "sign"),
			audit = Reflect.get(f.revisions, "auditInTransaction");
		const legacy = typeof sign === "function" && typeof audit === "function";
		f.store.write((tx) => {
			const row = {
				draft_id: input.draftId,
				rev: 1,
				payload: canonicalize(replacement),
				previous: previousRevision.previous,
			};
			const mac = legacy
				? (sign as LegacySign).call(f.revisions, "revision", { binding: bound, ...row })
				: previousRevision.mac;
			expect(
				tx.run("DELETE FROM main.native_draft_revisions WHERE draft_id=? AND rev=1", [
					input.draftId,
				]).changes,
			).toBe(1);
			expect(
				tx.run(
					"INSERT INTO main.native_draft_revisions(draft_id,rev,payload,previous,mac) VALUES(?,?,?,?,?)",
					[row.draft_id, row.rev, row.payload, row.previous, mac],
				).changes,
			).toBe(1);
			if (legacy) {
				const receipt = (audit as LegacyAudit).call(f.revisions, tx, "draft.appended", {
					draft: input.draftId,
				});
				const payload = JSON.parse(previousHeader.payload);
				payload.latestRevisionMac = mac;
				payload.auditEventMac = receipt.mac;
				const header = {
					id: input.draftId,
					payload: canonicalize(payload),
					audit_seq: receipt.seq,
				};
				const headerMac = (sign as LegacySign).call(f.revisions, "header", header);
				expect(
					tx.run("UPDATE main.native_drafts SET payload=?,audit_seq=?,mac=? WHERE id=?", [
						header.payload,
						header.audit_seq,
						headerMac,
						header.id,
					]).changes,
				).toBe(1);
			}
		});
		const replaced = f.store.read((tx) =>
			tx.get<RevisionRow>("SELECT * FROM main.native_draft_revisions WHERE draft_id=? AND rev=1", [
				input.draftId,
			]),
		);
		expect(replaced?.draft_id).toBe(input.draftId);
		expect(replaced?.rev).toBe(1);
		expect(JSON.parse(replaced?.payload ?? "null")).toEqual(replacement);
		const damaged = stored(f.store);
		let accepted: NativeRevision | undefined;
		let refusal: unknown;
		try {
			accepted = f.revisions.current(bound);
		} catch (error) {
			refusal = error;
		}
		// On the unfixed API this prints the genuinely accepted forged body, rather than a parser failure.
		expect(accepted).toBeUndefined();
		expect(refusal).toMatchObject({ code: "DRAFT_REVISION_UNAVAILABLE" });
		expect(() => f.revisions.history(bound)).toThrow("Draft revision unavailable");
		expect(stored(f.store)).toEqual(damaged);
		if (!legacy)
			for (const name of genericHelpers) expect(Reflect.get(f.revisions, name)).toBeUndefined();
		const reopened = f.reopen();
		expect(() => reopened.revisions.current(bound)).toThrow("Draft revision unavailable");
		expect(() => reopened.revisions.history(bound)).toThrow("Draft revision unavailable");
		expect(stored(reopened.store)).toEqual(damaged);
	});

	it("preserves genuine append, freeze, reopen, release and explicit purge operations", async () => {
		const f = await fixture(),
			input = f.make("chat"),
			bound = f.bind(input),
			untouched = f.create();
		f.create(input);
		const second = f.store.write((tx) =>
			f.revisions.appendInTransaction(tx, {
				...input,
				expectedRev: 1,
				content: { ...input.content, body: "DYTEST legitimate append" },
			}),
		);
		expect(second.draft.rev).toBe(2);
		expect(second.revision.content.body).toBe("DYTEST legitimate append");
		const snapshot = f.snapshot(second);
		f.store.write((tx) => f.freeze.freezeInTransaction(tx, bound, 2, snapshot));
		expect(f.revisions.current(bound).lockId).not.toBeNull();
		const next = f.reopen();
		expect(next.revisions.history(bound)).toHaveLength(2);
		next.store.write((tx) => next.freeze.proofInTransaction(tx, bound, snapshot.outbox));
		next.store.write((tx) => next.freeze.releaseInTransaction(tx, bound, snapshot.outbox));
		expect(next.revisions.current(bound).lockId).toBeNull();
		const third = next.store.write((tx) =>
			next.revisions.appendInTransaction(tx, {
				...input,
				expectedRev: 2,
				content: { ...input.content, body: "DYTEST append after release" },
			}),
		);
		const finalSnapshot = f.snapshot(third);
		const facts = next.store.write((tx) => {
			const proof = next.freeze.freezeInTransaction(tx, bound, 3, finalSnapshot);
			return next.freeze.consumeInTransaction(tx, proof);
		});
		expect(facts.rev).toBe(3);
		expect(facts.snapshotHash).toBe(contentHash(finalSnapshot));
		expect(next.revisions.history(bound)).toHaveLength(3);
		next.store.write((tx) => {
			tx.run("DELETE FROM main.native_draft_locks WHERE draft_id=?", [input.draftId]);
			tx.run("DELETE FROM main.native_draft_revisions WHERE draft_id=?", [input.draftId]);
			expect(tx.run("DELETE FROM main.native_drafts WHERE id=?", [input.draftId]).changes).toBe(1);
		});
		expect(() => next.revisions.current(bound)).toThrow("Draft revision unavailable");
		const other = {
			draftId: untouched.draft.id,
			accountId: untouched.draft.accountId,
			conversationId: untouched.draft.conversationId,
			channel: untouched.channel,
		};
		expect(next.revisions.current(other)).toEqual(untouched);
	});

	it("requires real native revisions and ignores substituted public helper methods", async () => {
		const f = await fixture(),
			input = f.make("chat"),
			bound = f.bind(input),
			current = f.create(input);
		for (const fake of [
			{},
			Object.create(NativeDraftRevisions.prototype),
			new Proxy(f.revisions, {}),
		])
			expect(() => new NativeDraftFreeze(fake as NativeDraftRevisions)).toThrow(
				"Draft revision unavailable",
			);
		let calls = 0;
		for (const name of [
			...genericHelpers,
			"assertTransaction",
			"currentInTransaction",
			"sameStore",
			"now",
			"prepareLockInTransaction",
			"setPreparedLockInTransaction",
		])
			Object.defineProperty(f.revisions, name, {
				configurable: true,
				value: () => {
					calls++;
					throw new Error("DYTEST substituted public helper");
				},
			});
		const freeze = new NativeDraftFreeze(f.revisions),
			snapshot = f.snapshot(current);
		const proof = f.store.write((tx) => freeze.freezeInTransaction(tx, bound, 1, snapshot));
		const before = stored(f.store);
		expect(() =>
			f.store.write((tx) =>
				freeze.consumeInTransaction(tx, Object.freeze({}) as FrozenRevisionProof),
			),
		).toThrow("Draft revision unavailable");
		expect(stored(f.store)).toEqual(before);
		const facts = f.store.write((tx) => freeze.consumeInTransaction(tx, proof));
		expect(facts.snapshotHash).toBe(contentHash(snapshot));
		expect(calls).toBe(0);
	});
});
