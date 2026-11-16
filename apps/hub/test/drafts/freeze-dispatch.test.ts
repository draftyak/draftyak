import { randomBytes } from "node:crypto";
import { rmSync } from "node:fs";
import { canonicalize } from "@draftyak/protocol/jcs";
import { contentHash } from "@draftyak/protocol/snapshot";
import { afterEach, describe, expect, it } from "vitest";
import { AuditChain } from "../../src/audit/chain.ts";
import { NativeDraftFreeze } from "../../src/drafts/freeze.ts";
import { NativeDraftRevisions } from "../../src/drafts/revisions.ts";
import { MasterKey } from "../../src/kernel/master-key.ts";
import { openEncrypted } from "../../src/store/open.ts";
import { HubStore, type SqlTransaction } from "../../src/store/store.ts";
import { nativeBinding } from "../store/helpers.ts";
import { type RevisionFixture, revisionFixture } from "./revision-fixture.ts";

const fixtures: RevisionFixture[] = [];
const refused = "Draft revision unavailable";
type FieldKind = "data" | "getter";

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
	}));
}

function status(f: RevisionFixture, outbox: string) {
	const row = f.store.read((db) =>
		db.get<{ payload: string }>("SELECT payload FROM native_draft_locks WHERE outbox_id=?", [
			outbox,
		]),
	);
	if (!row) throw new Error("DYTEST persisted lock required");
	return JSON.parse(row.payload) as { status: string; updatedAt: number };
}

function withCallField<T>(
	target: object,
	kind: FieldKind,
	handler: () => unknown,
	work: () => T,
): { result: T; observations: number } {
	const original = Object.getOwnPropertyDescriptor(target, "call");
	let observations = 0;
	const invoked = () => {
		observations++;
		return handler();
	};
	Object.defineProperty(
		target,
		"call",
		kind === "data"
			? { configurable: true, value: invoked }
			: {
					configurable: true,
					get() {
						observations++;
						return handler;
					},
				},
	);
	try {
		return { result: work(), observations };
	} finally {
		if (original) Object.defineProperty(target, "call", original);
		else Reflect.deleteProperty(target, "call");
	}
}

const unexpectedDispatch = (): never => {
	throw new Error("DYTEST own call field must not dispatch");
};

function lifecycle(f: RevisionFixture) {
	const one = f.make("email");
	const two = f.make("chat");
	const first = f.create(one);
	const second = f.create(two);
	const binding = f.bind(one);
	const releasedBinding = f.bind(two);
	const snapshot = f.snapshot(first);
	const releasedSnapshot = f.snapshot(second);
	const proof = f.store.write((tx) => f.freeze.freezeInTransaction(tx, binding, 1, snapshot));
	const reopenedProof = f.store.write((tx) =>
		f.freeze.proofInTransaction(tx, binding, snapshot.outbox),
	);
	f.time.now += 43;
	const facts = f.store.write((tx) => f.freeze.consumeInTransaction(tx, reopenedProof));
	f.store.write((tx) => f.freeze.freezeInTransaction(tx, releasedBinding, 1, releasedSnapshot));
	f.store.write((tx) =>
		f.freeze.releaseInTransaction(tx, releasedBinding, releasedSnapshot.outbox),
	);
	expect(facts.snapshotHash).toBe(contentHash(snapshot));
	expect(facts.snapshot).toEqual(snapshot);
	expect(facts.flagsHash).toBe(first.flagsHash);
	expect(status(f, snapshot.outbox)).toMatchObject({ status: "consumed", updatedAt: f.time.now });
	expect(status(f, releasedSnapshot.outbox).status).toBe("released");
	expect(f.revisions.current(binding).lockId).not.toBeNull();
	expect(f.revisions.current(releasedBinding).lockId).toBeNull();
	const beforeReplay = stored(f);
	expect(() => f.store.write((tx) => f.freeze.consumeInTransaction(tx, proof))).toThrow(refused);
	expect(stored(f)).toEqual(beforeReplay);
	f.store.read((db) => f.audit.verify(db));
	return facts;
}

/** Change an authenticated audit segment using only this fixture's encrypted database. */
function alterFreezeAudit(f: RevisionFixture): () => void {
	const raw = openEncrypted({ filename: f.filename, nativeBinding }, f.key);
	const trigger = raw
		.prepare("SELECT sql FROM main.sqlite_schema WHERE type='trigger' AND name='audit_no_update'")
		.get() as { sql: string } | undefined;
	const row = raw
		.prepare(
			"SELECT seq,at FROM audit_events WHERE action='draft.freeze_active' ORDER BY seq DESC LIMIT 1",
		)
		.get() as { seq: number; at: number } | undefined;
	if (!trigger || !row) {
		raw.close();
		throw new Error("DYTEST original audit row and fence required");
	}
	const write = (connection: ReturnType<typeof openEncrypted>, at: number) => {
		connection.exec("BEGIN IMMEDIATE");
		try {
			connection.exec("DROP TRIGGER audit_no_update");
			expect(
				connection.prepare("UPDATE audit_events SET at=? WHERE seq=?").run(at, row.seq).changes,
			).toBe(1);
			connection.exec(trigger.sql);
			connection.exec("COMMIT");
		} finally {
			if (connection.inTransaction) connection.exec("ROLLBACK");
		}
	};
	try {
		write(raw, row.at + 1);
	} finally {
		raw.close();
	}
	return () => {
		const connection = openEncrypted({ filename: f.filename, nativeBinding }, f.key);
		try {
			write(connection, row.at);
		} finally {
			connection.close();
		}
	};
}

describe("captured freeze method dispatch", () => {
	const methods = [
		"assertTransaction",
		"currentInTransaction",
		"now",
		"prepareLockInTransaction",
		"setPreparedLockInTransaction",
		"sameStore",
	] as const;
	for (const name of methods) {
		it.each(["data", "getter"] as const)(
			`ignores an own %s call field on the captured ${name} method`,
			async (kind) => {
				const f = await fixture();
				const result = withCallField(
					NativeDraftRevisions.prototype[name],
					kind,
					unexpectedDispatch,
					() => lifecycle(f),
				);
				expect(result.observations).toBe(0);
				expect(Object.isFrozen(result.result)).toBe(true);
			},
		);
	}

	it("does not let a call-field lie transfer a proof to another real store", async () => {
		const f = await fixture();
		const input = f.make();
		const binding = f.bind(input);
		const snapshot = f.snapshot(f.create(input));
		const proof = f.store.write((tx) => f.freeze.freezeInTransaction(tx, binding, 1, snapshot));
		const foreignStore = new HubStore(f.options);
		const foreignRevisions = new NativeDraftRevisions(foreignStore, f.audit, f.key, f.clock);
		f.stores.push(foreignStore);
		f.services.push(foreignRevisions);
		const foreignFreeze = new NativeDraftFreeze(foreignRevisions);
		const before = stored(f);
		const result = withCallField(
			NativeDraftRevisions.prototype.sameStore,
			"data",
			() => true,
			() => {
				expect(() =>
					foreignStore.write((tx) => foreignFreeze.consumeInTransaction(tx, proof)),
				).toThrow(refused);
				expect(stored(f)).toEqual(before);
				foreignStore.read((db) => f.audit.verify(db));
			},
		);
		expect(result.observations).toBe(0);
		const sharedRevisions = new NativeDraftRevisions(f.store, f.audit, f.key, f.clock);
		const sharedFreeze = new NativeDraftFreeze(sharedRevisions);
		f.services.push(sharedRevisions);
		const fresh = f.store.write((tx) => f.freeze.proofInTransaction(tx, binding, snapshot.outbox));
		const facts = f.store.write((tx) => sharedFreeze.consumeInTransaction(tx, fresh));
		expect(facts.snapshot).toEqual(snapshot);
		expect(() => f.store.write((tx) => sharedFreeze.consumeInTransaction(tx, fresh))).toThrow(
			refused,
		);
		f.store.read((db) => f.audit.verify(db));
	});

	it.each(["foreign", "retired"] as const)(
		"runs the captured transaction assertion for a real %s transaction",
		async (kind) => {
			const f = await fixture();
			const other = await fixture();
			const input = f.make();
			const binding = f.bind(input);
			const snapshot = f.snapshot(f.create(input));
			const proof = f.store.write((tx) => f.freeze.freezeInTransaction(tx, binding, 1, snapshot));
			let retired: SqlTransaction | undefined;
			f.store.write((tx) => {
				retired = tx;
			});
			if (!retired) throw new Error("DYTEST ended real transaction required");
			const ended = retired;
			const before = stored(f);
			const foreignBefore = stored(other);
			const result = withCallField(
				NativeDraftRevisions.prototype.assertTransaction,
				"data",
				() => undefined,
				() => {
					expect(() => {
						if (kind === "foreign") {
							other.store.write((tx) => {
								tx.run("INSERT INTO revision_parent(id) VALUES(8117)");
								f.freeze.consumeInTransaction(tx, proof);
							});
						} else f.freeze.consumeInTransaction(ended, proof);
					}).toThrow(refused);
				},
			);
			expect(result.observations).toBe(0);
			expect(stored(f)).toEqual(before);
			expect(stored(other)).toEqual(foreignBefore);
			const fresh = f.store.write((tx) =>
				f.freeze.proofInTransaction(tx, binding, snapshot.outbox),
			);
			expect(f.store.write((tx) => f.freeze.consumeInTransaction(tx, fresh)).snapshot).toEqual(
				snapshot,
			);
			f.store.read((db) => f.audit.verify(db));
			other.store.read((db) => other.audit.verify(db));
		},
	);
});

describe("captured freeze dependencies", () => {
	const dependencies = [
		["store key identity", HubStore.prototype.assertMasterKey],
		["store read", HubStore.prototype.read],
		["key derivation", MasterKey.prototype.derive],
		["audit append", AuditChain.prototype.append],
		["audit verification", AuditChain.prototype.verify],
		["audit segment verification", AuditChain.prototype.verifySegment],
	] as const;
	for (const [name, target] of dependencies) {
		it.each(["data", "getter"] as const)(
			`ignores an own %s call field on captured ${name}`,
			async (kind) => {
				const f = await fixture();
				const result = withCallField(target, kind, unexpectedDispatch, () => {
					const revisions = new NativeDraftRevisions(f.store, f.audit, f.key, f.clock);
					f.services.push(revisions);
					const facts = lifecycle(f);
					expect(
						revisions.current({
							draftId: facts.draftId,
							accountId: facts.accountId,
							conversationId: facts.conversationId,
							channel: facts.channel,
						}).revision.contentSha256,
					).toBe(facts.revisionContentHash);
					if (name === "key derivation") {
						const connection = openEncrypted({ filename: f.filename, nativeBinding }, f.key);
						try {
							const row = connection
								.prepare("SELECT id,payload FROM main.native_drafts WHERE id=?")
								.get(facts.draftId) as { id: string; payload: string } | undefined;
							expect(row?.id).toBe(facts.draftId);
							expect(JSON.parse(row?.payload ?? "null")).toMatchObject({
								draft: {
									id: facts.draftId,
									accountId: facts.accountId,
									conversationId: facts.conversationId,
									rev: facts.rev,
								},
								channel: facts.channel,
							});
						} finally {
							connection.close();
						}
					}
					return facts;
				});
				expect(result.observations).toBe(0);
			},
		);
	}

	it("still appends the actual consumed audit event when append.call is a no-op", async () => {
		const f = await fixture();
		const input = f.make();
		const binding = f.bind(input);
		const snapshot = f.snapshot(f.create(input));
		const proof = f.store.write((tx) => f.freeze.freezeInTransaction(tx, binding, 1, snapshot));
		const result = withCallField(
			AuditChain.prototype.append,
			"data",
			() => undefined,
			() => f.store.write((tx) => f.freeze.consumeInTransaction(tx, proof)),
		);
		expect(result.observations).toBe(0);
		expect(result.result.snapshotHash).toBe(contentHash(snapshot));
		const events = f.store.read((db) => {
			f.audit.verify(db);
			return db.all<{ action: string; refs: string }>(
				"SELECT action,refs FROM audit_events WHERE action='draft.freeze_consumed' ORDER BY seq",
			);
		});
		expect(events).toHaveLength(1);
		expect(JSON.parse(events[0]?.refs ?? "null")).toMatchObject({
			draft: binding.draftId,
			outbox: snapshot.outbox,
		});
		expect(canonicalize(events)).not.toContain(f.canary);
	});

	it("authenticates the segment even when verifySegment.call claims success", async () => {
		const f = await fixture();
		const input = f.make();
		const binding = f.bind(input);
		const snapshot = f.snapshot(f.create(input));
		const proof = f.store.write((tx) => f.freeze.freezeInTransaction(tx, binding, 1, snapshot));
		const restore = alterFreezeAudit(f);
		const before = stored(f);
		try {
			const result = withCallField(
				AuditChain.prototype.verifySegment,
				"data",
				() => undefined,
				() => {
					expect(() => f.store.write((tx) => f.freeze.consumeInTransaction(tx, proof))).toThrow(
						refused,
					);
					expect(stored(f)).toEqual(before);
				},
			);
			expect(result.observations).toBe(0);
		} finally {
			restore();
		}
		const fresh = f.store.write((tx) => f.freeze.proofInTransaction(tx, binding, snapshot.outbox));
		expect(f.store.write((tx) => f.freeze.consumeInTransaction(tx, fresh)).snapshot).toEqual(
			snapshot,
		);
		f.store.read((db) => f.audit.verify(db));
	});

	it("refuses construction over a corrupt chain when verify.call is a no-op", async () => {
		const f = await fixture();
		const input = f.make();
		const binding = f.bind(input);
		const snapshot = f.snapshot(f.create(input));
		f.store.write((tx) => f.freeze.freezeInTransaction(tx, binding, 1, snapshot));
		const restore = alterFreezeAudit(f);
		const before = stored(f);
		try {
			const result = withCallField(
				AuditChain.prototype.verify,
				"data",
				() => undefined,
				() => {
					expect(() => {
						const service = new NativeDraftRevisions(f.store, f.audit, f.key, f.clock);
						f.services.push(service);
					}).toThrow(refused);
					expect(stored(f)).toEqual(before);
				},
			);
			expect(result.observations).toBe(0);
		} finally {
			restore();
		}
		f.store.read((db) => f.audit.verify(db));
	});

	it("checks the real store key identity despite an assertMasterKey.call no-op", async () => {
		const f = await fixture();
		const input = f.make();
		const original = f.create(input);
		const before = stored(f);
		const foreignKey = new MasterKey(randomBytes(32));
		try {
			const result = withCallField(
				HubStore.prototype.assertMasterKey,
				"data",
				() => undefined,
				() => {
					expect(() => {
						const service = new NativeDraftRevisions(f.store, f.audit, foreignKey, f.clock);
						f.services.push(service);
					}).toThrow(refused);
				},
			);
			expect(result.observations).toBe(0);
			expect(stored(f)).toEqual(before);
			expect(f.revisions.current(f.bind(input))).toEqual(original);
		} finally {
			foreignKey.destroy();
		}
	});
});
