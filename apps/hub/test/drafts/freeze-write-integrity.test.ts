import { rmSync } from "node:fs";
import { canonicalize } from "@draftyak/protocol/jcs";
import { contentHash } from "@draftyak/protocol/snapshot";
import { afterEach, describe, expect, it } from "vitest";
import type { FrozenRevisionProof } from "../../src/drafts/freeze.ts";
import { newId } from "../../src/kernel/ids.ts";
import { openEncrypted } from "../../src/store/open.ts";
import type { SqlTransaction } from "../../src/store/store.ts";
import { nativeBinding } from "../store/helpers.ts";
import { signFixtureDraftRow } from "./revision-corruption.ts";
import { type RevisionFixture, revisionFixture } from "./revision-fixture.ts";

interface LockRow {
	id: string;
	draft_id: string;
	outbox_id: string;
	payload: string;
	audit_seq: number;
	mac: string;
}

const fixtures: RevisionFixture[] = [];
const OUTER_MARKER = 7101;
const TRIGGER_MARKER = 7102;
const triggerName = "dytest_freeze_write_integrity";
const refused = "Draft revision unavailable";

async function fixture() {
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
		rmSync(f.dir, { recursive: true, force: true });
	}
});

function stored(f: RevisionFixture) {
	return f.store.read((db) => ({
		headers: db.all("SELECT * FROM native_drafts ORDER BY id"),
		revisions: db.all("SELECT * FROM native_draft_revisions ORDER BY draft_id,rev"),
		locks: db.all("SELECT * FROM native_draft_locks ORDER BY id"),
		events: db.all("SELECT * FROM audit_events ORDER BY seq"),
		meta: db.all("SELECT * FROM audit_meta ORDER BY singleton"),
		parents: db.all("SELECT * FROM revision_parent ORDER BY id"),
		children: db.all("SELECT * FROM revision_child ORDER BY id"),
	}));
}

function lock(f: RevisionFixture, outbox: string): LockRow {
	const value = f.store.read((db) =>
		db.get<LockRow>("SELECT * FROM native_draft_locks WHERE outbox_id=?", [outbox]),
	);
	if (!value) throw new Error("DYTEST active lock required");
	return value;
}

function active(f: RevisionFixture, channel: "email" | "chat" = "email") {
	const input = f.make(channel);
	const binding = f.bind(input);
	const current = f.create(input);
	const snapshot = f.snapshot(current);
	const proof = f.store.write((tx) =>
		f.freeze.freezeInTransaction(tx, binding, current.revision.rev, snapshot),
	);
	return { input, binding, current, snapshot, proof, row: lock(f, snapshot.outbox) };
}

function literal(value: string): string {
	return `'${value.replaceAll("'", "''")}'`;
}

/** Install only after the real store has accepted its original schema. */
function installTrigger(f: RevisionFixture, declaration: string): () => void {
	const raw = openEncrypted({ filename: f.filename, nativeBinding }, f.key);
	const catalogSql =
		"SELECT type,name,tbl_name,sql FROM main.sqlite_schema ORDER BY type,name,tbl_name,sql";
	let before: unknown[];
	try {
		before = raw.prepare(catalogSql).all();
		raw.exec(`CREATE TRIGGER ${triggerName} ${declaration}`);
		expect(
			raw
				.prepare("SELECT name FROM main.sqlite_schema WHERE type='trigger' AND name=?")
				.get(triggerName),
		).toEqual({ name: triggerName });
	} finally {
		raw.close();
	}
	return () => {
		const connection = openEncrypted({ filename: f.filename, nativeBinding }, f.key);
		try {
			connection.exec(`DROP TRIGGER ${triggerName}`);
			expect(connection.prepare(catalogSql).all()).toEqual(before);
		} finally {
			connection.close();
		}
	};
}

function markedAttempt<T>(f: RevisionFixture, operation: (tx: SqlTransaction) => T) {
	let triggerReached = false;
	let returned: T | undefined;
	const invoke = () =>
		f.store.write((tx) => {
			tx.run("INSERT INTO revision_parent(id) VALUES(?)", [OUTER_MARKER]);
			try {
				returned = operation(tx);
				return returned;
			} finally {
				// Inspect before HubStore rolls back; a pre-write refusal cannot satisfy this.
				triggerReached =
					tx.get("SELECT id FROM revision_parent WHERE id=?", [TRIGGER_MARKER]) !== undefined;
			}
		});
	return { invoke, reached: () => triggerReached, returned: () => returned };
}

function assertMarkedRefusal(attempt: {
	invoke(): unknown;
	reached(): boolean;
	returned(): unknown;
}): void {
	let failure: unknown;
	try {
		attempt.invoke();
	} catch (error) {
		failure = error;
	}
	expect(attempt.reached()).toBe(true);
	expect(failure).toMatchObject({
		message: refused,
		code: "DRAFT_REVISION_UNAVAILABLE",
	});
	expect(attempt.returned()).toBeUndefined();
}

function verified(f: RevisionFixture) {
	f.store.read((db) => f.audit.verify(db));
}

describe("authenticated freeze writes", () => {
	it.each(["restore", "delete", "corrupt"] as const)(
		"rejects a consumed lock changed by an AFTER UPDATE %s trigger",
		async (attack) => {
			const f = await fixture();
			const value = active(f);
			const mutation =
				attack === "restore"
					? "UPDATE native_draft_locks SET payload=OLD.payload,audit_seq=OLD.audit_seq,mac=OLD.mac WHERE id=OLD.id;"
					: attack === "delete"
						? "DELETE FROM native_draft_locks WHERE id=OLD.id;"
						: "UPDATE native_draft_locks SET mac=printf('%064d',0) WHERE id=OLD.id;";
			const remove = installTrigger(
				f,
				`AFTER UPDATE ON native_draft_locks
				WHEN NEW.id=${literal(value.row.id)}
				AND json_extract(OLD.payload,'$.status')='active'
				AND json_extract(NEW.payload,'$.status')='consumed'
				BEGIN
				INSERT INTO revision_parent(id) VALUES(${TRIGGER_MARKER});
				${mutation}
				END`,
			);
			const before = stored(f);
			const attempt = markedAttempt(f, (tx) => f.freeze.consumeInTransaction(tx, value.proof));
			try {
				assertMarkedRefusal(attempt);
				expect(stored(f)).toEqual(before);
				verified(f);
			} finally {
				remove();
			}
			// Persistent state rolled back, but an attempted in-memory proof is still one-use.
			expect(() => f.store.write((tx) => f.freeze.consumeInTransaction(tx, value.proof))).toThrow(
				refused,
			);
			expect(stored(f)).toEqual(before);
			const facts = f.store.write((tx) => {
				const fresh = f.freeze.proofInTransaction(tx, value.binding, value.snapshot.outbox);
				return f.freeze.consumeInTransaction(tx, fresh);
			});
			expect(facts.snapshotHash).toBe(contentHash(value.snapshot));
			expect(JSON.parse(lock(f, value.snapshot.outbox).payload).status).toBe("consumed");
			verified(f);
		},
	);

	it("does not overwrite a different authentic preimage installed during audit append", async () => {
		const f = await fixture();
		const value = active(f, "chat");
		const payload = canonicalize({
			...JSON.parse(value.row.payload),
			updatedAt: f.time.now + 1,
		});
		const { mac: previousMac, ...signed } = value.row;
		const replacement = { ...signed, payload };
		const replacementMac = signFixtureDraftRow(f, "freeze", replacement);
		expect(replacementMac).not.toBe(previousMac);
		const remove = installTrigger(
			f,
			`AFTER INSERT ON audit_events
			WHEN NEW.action='draft.freeze_consumed'
			AND json_extract(NEW.refs,'$.freeze')=${literal(value.row.id)}
			BEGIN
			INSERT INTO revision_parent(id) VALUES(${TRIGGER_MARKER});
			UPDATE native_draft_locks SET payload=${literal(payload)},mac=${literal(replacementMac)}
			WHERE id=${literal(value.row.id)};
			END`,
		);
		const before = stored(f);
		const attempt = markedAttempt(f, (tx) => f.freeze.consumeInTransaction(tx, value.proof));
		try {
			assertMarkedRefusal(attempt);
			expect(stored(f)).toEqual(before);
			verified(f);
		} finally {
			remove();
		}
		const fresh = f.store.write((tx) =>
			f.freeze.proofInTransaction(tx, value.binding, value.snapshot.outbox),
		);
		expect(f.store.write((tx) => f.freeze.consumeInTransaction(tx, fresh)).snapshot).toEqual(
			value.snapshot,
		);
		verified(f);
	});

	it.each(["audit sequence", "MAC"] as const)(
		"compares the original %s instead of repairing an intervening audit-trigger change",
		async (field) => {
			const f = await fixture();
			const value = active(f);
			const assignment =
				field === "audit sequence" ? "audit_seq=audit_seq+100" : "mac=printf('%064d',0)";
			const remove = installTrigger(
				f,
				`AFTER INSERT ON audit_events
				WHEN NEW.action='draft.freeze_consumed'
				AND json_extract(NEW.refs,'$.freeze')=${literal(value.row.id)}
				BEGIN
				INSERT INTO revision_parent(id) VALUES(${TRIGGER_MARKER});
				UPDATE native_draft_locks SET ${assignment} WHERE id=${literal(value.row.id)};
				END`,
			);
			const before = stored(f);
			const attempt = markedAttempt(f, (tx) => f.freeze.consumeInTransaction(tx, value.proof));
			try {
				assertMarkedRefusal(attempt);
				expect(stored(f)).toEqual(before);
				verified(f);
			} finally {
				remove();
			}
		},
	);

	it("allows unrelated writes between proof creation and the actual consume", async () => {
		const f = await fixture();
		const value = active(f);
		const marker = 6107;
		const facts = f.store.write((tx) => {
			tx.run("INSERT INTO revision_parent(id) VALUES(?)", [marker]);
			f.audit.append(tx, {
				id: newId(f.time.now),
				at: f.time.now,
				action: "dytest.unrelated_storage_write",
				actor: { kind: "hub", id: null },
				refs: {},
			});
			return f.freeze.consumeInTransaction(tx, value.proof);
		});
		expect(facts.snapshot).toEqual(value.snapshot);
		expect(statusFromRow(lock(f, value.snapshot.outbox))).toBe("consumed");
		expect(f.store.read((db) => db.all("SELECT id FROM revision_parent"))).toEqual([
			{ id: marker },
		]);
		const events = f.store.read((db) =>
			db.all<{ action: string }>("SELECT action FROM audit_events ORDER BY seq"),
		);
		expect(events.slice(-2)).toEqual([
			{ action: "dytest.unrelated_storage_write" },
			{ action: "draft.freeze_consumed" },
		]);
		verified(f);
	});

	it("refuses header corruption from the clock after loading the active freeze", async () => {
		const f = await fixture();
		const value = active(f);
		const before = stored(f);
		const ordinaryClock = f.clock.wallMs;
		let clockReached = false;
		let lockUnchanged = false;
		let headerChanges = 0;
		let observedMac: string | undefined;
		const attempt = markedAttempt(f, (tx) => {
			let armed = true;
			f.clock.wallMs = () => {
				if (armed) {
					armed = false;
					const lockBefore = tx.get<LockRow>("SELECT * FROM native_draft_locks WHERE id=?", [
						value.row.id,
					]);
					headerChanges = tx.run("UPDATE native_drafts SET mac=? WHERE id=?", [
						"0".repeat(64),
						value.binding.draftId,
					]).changes;
					observedMac = tx.get<{ mac: string }>("SELECT mac FROM native_drafts WHERE id=?", [
						value.binding.draftId,
					])?.mac;
					const lockAfter = tx.get<LockRow>("SELECT * FROM native_draft_locks WHERE id=?", [
						value.row.id,
					]);
					lockUnchanged =
						canonicalize(lockBefore) === canonicalize(value.row) &&
						canonicalize(lockAfter) === canonicalize(value.row);
					tx.run("INSERT INTO revision_parent(id) VALUES(?)", [TRIGGER_MARKER]);
					clockReached = true;
				}
				return f.time.now;
			};
			try {
				return f.freeze.consumeInTransaction(tx, value.proof);
			} finally {
				f.clock.wallMs = ordinaryClock;
			}
		});
		let failure: unknown;
		try {
			attempt.invoke();
		} catch (error) {
			failure = error;
		}
		expect(clockReached).toBe(true);
		expect(attempt.reached()).toBe(true);
		expect(headerChanges).toBe(1);
		expect(observedMac).toBe("0".repeat(64));
		expect(lockUnchanged).toBe(true);
		expect(failure).toMatchObject({
			message: refused,
			code: "DRAFT_REVISION_UNAVAILABLE",
		});
		expect(attempt.returned()).toBeUndefined();
		expect(stored(f)).toEqual(before);
		expect(() => f.store.write((tx) => f.freeze.consumeInTransaction(tx, value.proof))).toThrow(
			refused,
		);
		const fresh = f.store.write((tx) =>
			f.freeze.proofInTransaction(tx, value.binding, value.snapshot.outbox),
		);
		expect(f.store.write((tx) => f.freeze.consumeInTransaction(tx, fresh)).snapshot).toEqual(
			value.snapshot,
		);
		verified(f);
	});

	it.each(["freeze", "release"] as const)(
		"retains the existing %s readback refusal when its written lock disappears",
		async (operation) => {
			const f = await fixture();
			const input = f.make();
			const binding = f.bind(input);
			const current = f.create(input);
			const snapshot = f.snapshot(current);
			if (operation === "release")
				f.store.write((tx) => f.freeze.freezeInTransaction(tx, binding, 1, snapshot));
			const event = operation === "freeze" ? "INSERT" : "UPDATE";
			const status = operation === "freeze" ? "active" : "released";
			const remove = installTrigger(
				f,
				`AFTER ${event} ON native_draft_locks
				WHEN NEW.outbox_id=${literal(snapshot.outbox)}
				AND json_extract(NEW.payload,'$.status')=${literal(status)}
				BEGIN
				INSERT INTO revision_parent(id) VALUES(${TRIGGER_MARKER});
				DELETE FROM native_draft_locks WHERE id=NEW.id;
				END`,
			);
			const before = stored(f);
			const attempt = markedAttempt(f, (tx) =>
				operation === "freeze"
					? f.freeze.freezeInTransaction(tx, binding, 1, snapshot)
					: f.freeze.releaseInTransaction(tx, binding, snapshot.outbox),
			);
			try {
				assertMarkedRefusal(attempt);
				expect(stored(f)).toEqual(before);
				verified(f);
			} finally {
				remove();
			}
			if (operation === "freeze") {
				const proof = f.store.write((tx) => f.freeze.freezeInTransaction(tx, binding, 1, snapshot));
				expect(f.store.write((tx) => f.freeze.consumeInTransaction(tx, proof)).outboxId).toBe(
					snapshot.outbox,
				);
			} else {
				f.store.write((tx) => f.freeze.releaseInTransaction(tx, binding, snapshot.outbox));
				expect(f.revisions.current(binding).lockId).toBeNull();
			}
			verified(f);
		},
	);

	it("keeps unrelated active locks and returns exactly the committed consumed snapshot", async () => {
		const f = await fixture();
		const selected = active(f);
		const other = active(f, "chat");
		const otherBefore = lock(f, other.snapshot.outbox);
		f.time.now += 25;
		const facts = f.store.write((tx) => f.freeze.consumeInTransaction(tx, selected.proof));
		expect(facts).toEqual({
			...selected.binding,
			rev: selected.current.revision.rev,
			outboxId: selected.snapshot.outbox,
			revisionContentHash: selected.current.revision.contentSha256,
			snapshotHash: contentHash(selected.snapshot),
			flagsHash: selected.current.flagsHash,
			snapshot: selected.snapshot,
		});
		expect(Object.isFrozen(facts)).toBe(true);
		expect(Object.isFrozen(facts.snapshot)).toBe(true);
		expect(lock(f, other.snapshot.outbox)).toEqual(otherBefore);
		const consumed = lock(f, selected.snapshot.outbox);
		expect(JSON.parse(consumed.payload)).toMatchObject({
			status: "consumed",
			updatedAt: f.time.now,
			snapshot: selected.snapshot,
		});
		const beforeReplay = stored(f);
		expect(() => f.store.write((tx) => f.freeze.consumeInTransaction(tx, selected.proof))).toThrow(
			refused,
		);
		expect(() =>
			f.store.write((tx) =>
				f.freeze.proofInTransaction(tx, selected.binding, selected.snapshot.outbox),
			),
		).toThrow(refused);
		expect(stored(f)).toEqual(beforeReplay);
		verified(f);
		const reopened = f.reopen();
		expect(() =>
			reopened.store.write((tx) =>
				reopened.freeze.proofInTransaction(tx, selected.binding, selected.snapshot.outbox),
			),
		).toThrow(refused);
		expect(reopened.revisions.current(other.binding).lockId).toBe(other.row.id);
		reopened.store.read((db) => f.audit.verify(db));
	});

	it("rolls back a successful consume when the enclosing write cannot commit", async () => {
		const f = await fixture();
		const value = active(f);
		const before = stored(f);
		expect(() =>
			f.store.write((tx) => {
				tx.run("INSERT INTO revision_child(id) VALUES(?)", [98123]);
				expect(f.freeze.consumeInTransaction(tx, value.proof).snapshot).toEqual(value.snapshot);
			}),
		).toThrow();
		expect(stored(f)).toEqual(before);
		expect(() => f.store.write((tx) => f.freeze.consumeInTransaction(tx, value.proof))).toThrow(
			refused,
		);
		const fresh = f.store.write((tx) =>
			f.freeze.proofInTransaction(tx, value.binding, value.snapshot.outbox),
		);
		expect(f.store.write((tx) => f.freeze.consumeInTransaction(tx, fresh)).snapshotHash).toBe(
			contentHash(value.snapshot),
		);
		verified(f);
	});

	it("leaves the original proof usable when a completed release cannot commit", async () => {
		const f = await fixture();
		const value = active(f, "chat");
		const before = stored(f);
		expect(() =>
			f.store.write((tx) => {
				tx.run("INSERT INTO revision_child(id) VALUES(?)", [98124]);
				f.freeze.releaseInTransaction(tx, value.binding, value.snapshot.outbox);
			}),
		).toThrow();
		expect(stored(f)).toEqual(before);
		const facts = f.store.write((tx) => f.freeze.consumeInTransaction(tx, value.proof));
		expect(facts.snapshotHash).toBe(contentHash(value.snapshot));
		expect(statusFromRow(lock(f, value.snapshot.outbox))).toBe("consumed");
		verified(f);
	});

	it("keeps a failed freeze transaction from making its returned proof usable", async () => {
		const f = await fixture();
		const input = f.make();
		const binding = f.bind(input);
		const snapshot = f.snapshot(f.create(input));
		const before = stored(f);
		let discarded: FrozenRevisionProof | undefined;
		expect(() =>
			f.store.write((tx) => {
				discarded = f.freeze.freezeInTransaction(tx, binding, 1, snapshot);
				throw new Error("DYTEST discard frozen transaction");
			}),
		).toThrow("DYTEST discard frozen transaction");
		expect(stored(f)).toEqual(before);
		if (!discarded) throw new Error("DYTEST proof must have been issued before rollback");
		const discardedProof = discarded;
		expect(() => f.store.write((tx) => f.freeze.consumeInTransaction(tx, discardedProof))).toThrow(
			refused,
		);
		expect(stored(f)).toEqual(before);
		const replacement = { ...snapshot, outbox: newId(f.time.now) };
		const facts = f.store.write((tx) => {
			const proof = f.freeze.freezeInTransaction(tx, binding, 1, replacement);
			return f.freeze.consumeInTransaction(tx, proof);
		});
		expect(facts.outboxId).toBe(replacement.outbox);
		verified(f);
	});
});

function statusFromRow(row: LockRow): string {
	return (JSON.parse(row.payload) as { status: string }).status;
}
