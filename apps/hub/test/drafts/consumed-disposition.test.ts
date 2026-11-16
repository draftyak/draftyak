import { existsSync, rmSync } from "node:fs";
import { canonicalize } from "@draftyak/protocol/jcs";
import { afterEach, describe, expect, it } from "vitest";
import { type ConsumedDraftDisposition, NativeDraftRevisions } from "../../src/drafts/revisions.ts";
import { newId } from "../../src/kernel/ids.ts";
import { openEncrypted } from "../../src/store/open.ts";
import { HubStore, type SqlTransaction } from "../../src/store/store.ts";
import { nativeBinding } from "../store/helpers.ts";
import { corruptRevisionStorage, signFixtureDraftRow } from "./revision-corruption.ts";
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
const refused = "Draft revision unavailable";
const triggerName = "dytest_consumed_disposition";
const marker = 7201;

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
		expect(existsSync(f.dir)).toBe(false);
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

function lock(f: RevisionFixture, outboxId: string): LockRow {
	const row = f.store.read((db) =>
		db.get<LockRow>("SELECT * FROM native_draft_locks WHERE outbox_id=?", [outboxId]),
	);
	if (!row) throw new Error("DYTEST stored lock required");
	return row;
}

function active(f: RevisionFixture, channel: "email" | "chat" = "email") {
	const input = f.make(channel);
	const bound = f.bind(input);
	const current = f.create(input);
	const snapshot = f.snapshot(current);
	const proof = f.store.write((tx) => f.freeze.freezeInTransaction(tx, bound, 1, snapshot));
	const row = lock(f, snapshot.outbox);
	const disposition: ConsumedDraftDisposition = {
		...bound,
		expectedRev: 1,
		lockId: row.id,
		outboxId: snapshot.outbox,
		outcome: "sent",
	};
	return { input, bound, current, snapshot, proof, disposition };
}

function consumed(f: RevisionFixture, channel: "email" | "chat" = "email") {
	const value = active(f, channel);
	f.store.write((tx) => f.freeze.consumeInTransaction(tx, value.proof));
	const row = lock(f, value.snapshot.outbox);
	expect(JSON.parse(row.payload).status).toBe("consumed");
	return { ...value, row };
}

function settle(f: RevisionFixture, input: ConsumedDraftDisposition) {
	// This records a caller's storage decision, without asserting delivery authority.
	return f.store.write((tx) => f.revisions.settleConsumedInTransaction(tx, input));
}

function verify(f: RevisionFixture): void {
	f.store.read((db) => f.audit.verify(db));
}

function unchangedRefusal(f: RevisionFixture, operation: () => unknown): void {
	const before = stored(f);
	expect(operation).toThrow(refused);
	expect(stored(f)).toEqual(before);
	verify(f);
}

function literal(value: string): string {
	return `'${value.replaceAll("'", "''")}'`;
}

function installTrigger(f: RevisionFixture, declaration: string): () => void {
	const catalog =
		"SELECT type,name,tbl_name,sql FROM main.sqlite_schema ORDER BY type,name,tbl_name,sql";
	const raw = openEncrypted({ filename: f.filename, nativeBinding }, f.key);
	let before: unknown[];
	try {
		before = raw.prepare(catalog).all();
		raw.exec(`CREATE TRIGGER ${triggerName} ${declaration}`);
		expect(
			raw.prepare("SELECT name FROM main.sqlite_schema WHERE name=?").get(triggerName),
		).toEqual({ name: triggerName });
	} finally {
		raw.close();
	}
	return () => {
		const connection = openEncrypted({ filename: f.filename, nativeBinding }, f.key);
		try {
			connection.exec(`DROP TRIGGER ${triggerName}`);
			expect(connection.prepare(catalog).all()).toEqual(before);
		} finally {
			connection.close();
		}
	};
}

function markedRefusal(f: RevisionFixture, input: ConsumedDraftDisposition): void {
	const before = stored(f);
	let reached = false;
	let returned = false;
	// The refusal must escape the enclosing write; caught storage errors do not abort it.
	expect(() =>
		f.store.write((tx) => {
			try {
				f.revisions.settleConsumedInTransaction(tx, input);
				returned = true;
			} finally {
				reached = tx.get("SELECT id FROM revision_parent WHERE id=?", [marker]) !== undefined;
			}
		}),
	).toThrow(expect.objectContaining({ message: refused, code: "DRAFT_REVISION_UNAVAILABLE" }));
	expect(reached).toBe(true);
	expect(returned).toBe(false);
	expect(stored(f)).toEqual(before);
	verify(f);
}

describe("consumed native draft disposition storage", () => {
	it.each(["email", "chat"] as const)(
		"records sent %s once without rewriting consumed evidence or revision bytes",
		async (channel) => {
			const f = await fixture();
			const value = consumed(f, channel);
			const before = stored(f);
			f.time.now += 1000;
			const sent = settle(f, value.disposition);
			expect(sent).toEqual({
				...value.current,
				draft: { ...value.current.draft, state: "sent", updatedAt: f.time.now },
				lockId: null,
			});
			expect(Object.isFrozen(sent)).toBe(true);
			expect(Object.isFrozen(sent.draft)).toBe(true);
			expect(lock(f, value.snapshot.outbox)).toEqual(value.row);
			expect(stored(f).revisions).toEqual(before.revisions);
			expect(f.revisions.current(value.bound)).toEqual(sent);
			expect(f.revisions.history(value.bound)).toEqual([value.current.revision]);
			expect(
				f.store.read((db) =>
					db.all("SELECT action,refs FROM audit_events WHERE action='draft.sent'"),
				),
			).toEqual([{ action: "draft.sent", refs: canonicalize({ draft: value.input.draftId }) }]);
			unchangedRefusal(f, () => settle(f, value.disposition));
			unchangedRefusal(f, () => settle(f, { ...value.disposition, outcome: "returned" }));
			unchangedRefusal(f, () =>
				f.store.write((tx) =>
					f.revisions.appendInTransaction(tx, { ...value.input, expectedRev: 1 }),
				),
			);
			unchangedRefusal(f, () =>
				f.store.write((tx) => f.freeze.freezeInTransaction(tx, value.bound, 1, f.snapshot(sent))),
			);
			unchangedRefusal(f, () =>
				f.store.write((tx) => f.freeze.consumeInTransaction(tx, value.proof)),
			);
			unchangedRefusal(f, () =>
				f.store.write((tx) => f.freeze.proofInTransaction(tx, value.bound, value.snapshot.outbox)),
			);
			unchangedRefusal(f, () =>
				f.store.write((tx) =>
					f.freeze.releaseInTransaction(tx, value.bound, value.snapshot.outbox),
				),
			);
			const reopened = f.reopen();
			expect(reopened.revisions.current(value.bound)).toEqual(sent);
			expect(lock({ ...f, store: reopened.store }, value.snapshot.outbox)).toEqual(value.row);
			reopened.store.read((db) => f.audit.verify(db));
		},
	);

	it.each(["email", "chat"] as const)(
		"returns %s for a new edit and new outbox while retaining the old consumed tombstone",
		async (channel) => {
			const f = await fixture();
			const value = consumed(f, channel);
			const request = { ...value.disposition, outcome: "returned" as const };
			const returned = settle(f, request);
			expect(returned.draft.state).toBe("open");
			expect(returned.lockId).toBeNull();
			expect(returned.revision).toEqual(value.current.revision);
			expect(lock(f, value.snapshot.outbox)).toEqual(value.row);
			expect(
				f.store.read((db) =>
					db.all("SELECT action,refs FROM audit_events WHERE action='draft.returned'"),
				),
			).toEqual([{ action: "draft.returned", refs: canonicalize({ draft: value.input.draftId }) }]);
			unchangedRefusal(f, () => settle(f, request));
			unchangedRefusal(f, () =>
				f.store.write((tx) => f.freeze.consumeInTransaction(tx, value.proof)),
			);
			unchangedRefusal(f, () =>
				f.store.write((tx) => f.freeze.proofInTransaction(tx, value.bound, value.snapshot.outbox)),
			);
			unchangedRefusal(f, () =>
				f.store.write((tx) =>
					f.freeze.releaseInTransaction(tx, value.bound, value.snapshot.outbox),
				),
			);
			const edited = f.store.write((tx) =>
				f.revisions.appendInTransaction(tx, {
					...value.input,
					expectedRev: 1,
					content: { ...value.current.revision.content, body: "DYTEST returned revision" },
				}),
			);
			expect(edited.draft.rev).toBe(2);
			const nextSnapshot = f.snapshot(edited);
			unchangedRefusal(f, () =>
				f.store.write((tx) =>
					f.freeze.freezeInTransaction(tx, value.bound, 2, {
						...nextSnapshot,
						outbox: value.snapshot.outbox,
					}),
				),
			);
			const proof = f.store.write((tx) =>
				f.freeze.freezeInTransaction(tx, value.bound, 2, nextSnapshot),
			);
			const next = lock(f, nextSnapshot.outbox);
			expect(next.id).not.toBe(value.row.id);
			f.store.write((tx) => f.freeze.consumeInTransaction(tx, proof));
			const sent = settle(f, {
				...value.bound,
				expectedRev: 2,
				lockId: next.id,
				outboxId: nextSnapshot.outbox,
				outcome: "sent",
			});
			expect(sent.draft.state).toBe("sent");
			expect(lock(f, value.snapshot.outbox)).toEqual(value.row);
			expect(stored(f).locks).toHaveLength(2);
			expect(f.revisions.history(value.bound).map((revision) => revision.rev)).toEqual([1, 2]);
			unchangedRefusal(f, () => settle(f, value.disposition));
			verify(f);
			const reopened = f.reopen();
			expect(reopened.revisions.current(value.bound)).toEqual(sent);
			expect(lock({ ...f, store: reopened.store }, value.snapshot.outbox)).toEqual(value.row);
			expect(reopened.revisions.history(value.bound)).toEqual([
				value.current.revision,
				edited.revision,
			]);
		},
	);

	it("keeps an unreconciled consumed draft held until the caller supplies a disposition", async () => {
		const f = await fixture();
		const value = consumed(f);
		expect(f.revisions.current(value.bound)).toMatchObject({
			draft: { state: "open", rev: 1 },
			lockId: value.row.id,
		});
		unchangedRefusal(f, () =>
			f.store.write((tx) =>
				f.revisions.appendInTransaction(tx, { ...value.input, expectedRev: 1 }),
			),
		);
		unchangedRefusal(f, () =>
			f.store.write((tx) =>
				f.freeze.freezeInTransaction(tx, value.bound, 1, f.snapshot(value.current)),
			),
		);
		unchangedRefusal(f, () =>
			f.store.write((tx) => f.freeze.releaseInTransaction(tx, value.bound, value.snapshot.outbox)),
		);
		expect(lock(f, value.snapshot.outbox)).toEqual(value.row);
	});

	it.each(["unlocked", "active", "released"] as const)(
		"refuses a %s draft without changing its rows or audit",
		async (state) => {
			const f = await fixture();
			if (state === "unlocked") {
				const input = f.make();
				f.create(input);
				unchangedRefusal(f, () =>
					settle(f, {
						...f.bind(input),
						expectedRev: 1,
						lockId: newId(),
						outboxId: newId(),
						outcome: "sent",
					}),
				);
			} else {
				const value = active(f);
				if (state === "released")
					f.store.write((tx) =>
						f.freeze.releaseInTransaction(tx, value.bound, value.snapshot.outbox),
					);
				unchangedRefusal(f, () => settle(f, value.disposition));
			}
		},
	);

	it("refuses malformed, stale and mismatched consumed disposition data without writes", async () => {
		const f = await fixture();
		const value = consumed(f, "chat");
		const other = consumed(f, "chat");
		const wrong: unknown[] = [
			{ ...value.bound, expectedRev: 1, lockId: value.row.id, outcome: "sent" },
			{ ...value.disposition, extra: true },
			{ ...value.disposition, draftId: newId() },
			{ ...value.disposition, accountId: newId() },
			{ ...value.disposition, conversationId: newId() },
			{ ...value.disposition, channel: "email" },
			{ ...value.disposition, lockId: newId() },
			{ ...value.disposition, outboxId: newId() },
			{ ...value.disposition, lockId: other.disposition.lockId },
			{ ...value.disposition, outboxId: other.disposition.outboxId },
			{ ...other.disposition, lockId: value.disposition.lockId },
			{ ...value.disposition, lockId: null },
			{ ...value.disposition, outboxId: "not-an-id" },
			{ ...value.disposition, outcome: "inflight" },
			{ ...value.disposition, outcome: "SENT" },
			...[0, -1, 1.5, 2, Number.NaN, Number.POSITIVE_INFINITY].map((expectedRev) => ({
				...value.disposition,
				expectedRev,
			})),
		];
		for (const input of wrong)
			unchangedRefusal(f, () => settle(f, input as ConsumedDraftDisposition));
		expect(settle(f, value.disposition).draft.state).toBe("sent");
	});

	it("does not invoke hostile disposition accessors or proxy traps", async () => {
		const f = await fixture();
		const value = consumed(f);
		let calls = 0;
		const accessor = { ...value.disposition };
		Object.defineProperty(accessor, "outcome", {
			enumerable: true,
			get() {
				calls++;
				throw new Error("DYTEST accessor must not run");
			},
		});
		const proxy = new Proxy(value.disposition, {
			getPrototypeOf() {
				calls++;
				throw new Error("DYTEST proxy must not run");
			},
			ownKeys() {
				calls++;
				throw new Error("DYTEST proxy must not run");
			},
		});
		for (const input of [accessor, proxy]) unchangedRefusal(f, () => settle(f, input));
		expect(calls).toBe(0);
		expect(lock(f, value.snapshot.outbox)).toEqual(value.row);
	});

	it("requires its original live write transaction and a live same-store receiver", async () => {
		const f = await fixture();
		const value = consumed(f);
		const foreign = new HubStore(f.options);
		f.stores.push(foreign);
		unchangedRefusal(f, () =>
			foreign.write((tx) => f.revisions.settleConsumedInTransaction(tx, value.disposition)),
		);
		unchangedRefusal(f, () =>
			f.store.read((reader) =>
				f.revisions.settleConsumedInTransaction(
					reader as unknown as SqlTransaction,
					value.disposition,
				),
			),
		);
		let ended: SqlTransaction | undefined;
		f.store.write((tx) => {
			ended = tx;
		});
		if (!ended) throw new Error("DYTEST real transaction required");
		const retired = ended;
		unchangedRefusal(f, () => f.revisions.settleConsumedInTransaction(retired, value.disposition));
		const destroyed = new NativeDraftRevisions(f.store, f.audit, f.key, f.clock);
		f.services.push(destroyed);
		destroyed.destroy();
		unchangedRefusal(f, () =>
			f.store.write((tx) => destroyed.settleConsumedInTransaction(tx, value.disposition)),
		);
		expect(settle(f, value.disposition).draft.state).toBe("sent");
	});

	it.each(["sent", "returned"] as const)(
		"rolls back %s header and audit on an explicit abort and deferred commit failure",
		async (outcome) => {
			const f = await fixture();
			const value = consumed(f);
			const input = { ...value.disposition, outcome };
			const before = stored(f);
			let completed = 0;
			for (const deferred of [false, true]) {
				expect(() =>
					f.store.write((tx) => {
						const current = f.revisions.settleConsumedInTransaction(tx, input);
						expect(current.lockId).toBeNull();
						expect(current.draft.state).toBe(outcome === "sent" ? "sent" : "open");
						completed++;
						if (deferred) tx.run("INSERT INTO revision_child(id) VALUES(987654)");
						else throw new Error("DYTEST rollback disposition");
					}),
				).toThrow(
					deferred
						? expect.objectContaining({ code: "SQLITE_CONSTRAINT_FOREIGNKEY" })
						: "DYTEST rollback disposition",
				);
				expect(stored(f)).toEqual(before);
				verify(f);
			}
			expect(completed).toBe(2);
			const reopened = f.reopen();
			expect(reopened.revisions.current(value.bound).lockId).toBe(value.row.id);
			expect(
				reopened.store.write((tx) => reopened.revisions.settleConsumedInTransaction(tx, input))
					.lockId,
			).toBeNull();
			expect(lock({ ...f, store: reopened.store }, value.snapshot.outbox)).toEqual(value.row);
			reopened.store.read((db) => f.audit.verify(db));
		},
	);

	it.each(["sent", "returned"] as const)(
		"clamps a %s timestamp to consumed evidence after a backward clock step",
		async (outcome) => {
			const f = await fixture();
			const value = active(f);
			f.time.now += 5000;
			f.store.write((tx) => f.freeze.consumeInTransaction(tx, value.proof));
			const consumedRow = lock(f, value.snapshot.outbox);
			const floor = f.time.now;
			f.time.now -= 10000;
			const result = settle(f, { ...value.disposition, outcome });
			expect(result.draft.updatedAt).toBe(floor);
			expect(result.revision.createdAt).toBe(value.current.revision.createdAt);
			expect(lock(f, value.snapshot.outbox)).toEqual(consumedRow);
			expect(
				f.store.read((db) =>
					db.all("SELECT at,refs FROM audit_events WHERE action='draft.clock_skew'"),
				),
			).toEqual([{ at: f.time.now, refs: canonicalize({ clockSkewDraft: value.input.draftId }) }]);
			verify(f);
			expect(f.reopen().revisions.current(value.bound)).toEqual(result);
		},
	);

	it("rejects invalid clock values before changing consumed state", async () => {
		const f = await fixture();
		const value = consumed(f);
		for (const invalid of [-1, 0.5, Number.NaN, Number.POSITIVE_INFINITY]) {
			f.time.now = invalid;
			unchangedRefusal(f, () => settle(f, value.disposition));
		}
		f.time.now = value.current.draft.updatedAt;
		expect(settle(f, value.disposition).draft.state).toBe("sent");
	});

	it("authenticates earlier immutable history before settling a consumed current revision", async () => {
		const f = await fixture();
		const input = f.make();
		f.create(input);
		const current = f.store.write((tx) =>
			f.revisions.appendInTransaction(tx, { ...input, expectedRev: 1 }),
		);
		const bound = f.bind(input);
		const snapshot = f.snapshot(current);
		const proof = f.store.write((tx) => f.freeze.freezeInTransaction(tx, bound, 2, snapshot));
		f.store.write((tx) => f.freeze.consumeInTransaction(tx, proof));
		const row = lock(f, snapshot.outbox);
		corruptRevisionStorage(f, (database) => {
			expect(
				database
					.prepare("UPDATE native_draft_revisions SET mac=? WHERE draft_id=? AND rev=1")
					.run("0".repeat(64), input.draftId).changes,
			).toBe(1);
		});
		const before = stored(f);
		expect(() =>
			settle(f, {
				...bound,
				expectedRev: 2,
				lockId: row.id,
				outboxId: snapshot.outbox,
				outcome: "sent",
			}),
		).toThrow(refused);
		expect(stored(f)).toEqual(before);
	});

	it.each(["payload", "audit sequence", "MAC"] as const)(
		"does not repair a header %s changed by its audit trigger",
		async (field) => {
			const f = await fixture();
			const value = consumed(f);
			const change =
				field === "payload"
					? "payload=payload||' '"
					: field === "audit sequence"
						? "audit_seq=audit_seq+100"
						: "mac=printf('%064d',0)";
			const remove = installTrigger(
				f,
				`AFTER INSERT ON audit_events
				WHEN NEW.action='draft.sent' AND json_extract(NEW.refs,'$.draft')=${literal(value.input.draftId)}
				BEGIN
				INSERT INTO revision_parent(id) VALUES(${marker});
				UPDATE native_drafts SET ${change} WHERE id=${literal(value.input.draftId)};
				END`,
			);
			try {
				markedRefusal(f, value.disposition);
			} finally {
				remove();
			}
			expect(settle(f, value.disposition).draft.state).toBe("sent");
		},
	);

	it.each(["restore header", "rewrite authenticated consumed evidence"] as const)(
		"rejects an AFTER UPDATE trigger that can %s instead of persisting the disposition",
		async (attack) => {
			const f = await fixture();
			const value = consumed(f);
			const { mac, ...signed } = value.row;
			const replacement = {
				...signed,
				payload: canonicalize({
					...JSON.parse(value.row.payload),
					updatedAt: f.time.now + 1,
				}),
			};
			const replacementMac = signFixtureDraftRow(f, "freeze", replacement);
			expect(replacementMac).not.toBe(mac);
			const change =
				attack === "restore header"
					? "UPDATE native_drafts SET payload=OLD.payload,audit_seq=OLD.audit_seq,mac=OLD.mac WHERE id=OLD.id;"
					: `UPDATE native_draft_locks SET payload=${literal(replacement.payload)},mac=${literal(replacementMac)} WHERE id=${literal(value.row.id)};`;
			const remove = installTrigger(
				f,
				`AFTER UPDATE ON native_drafts
				WHEN NEW.id=${literal(value.input.draftId)} AND json_extract(NEW.payload,'$.lockId') IS NULL
				BEGIN
				INSERT INTO revision_parent(id) VALUES(${marker});
				${change}
				END`,
			);
			try {
				markedRefusal(f, { ...value.disposition, outcome: "returned" });
			} finally {
				remove();
			}
			expect(settle(f, { ...value.disposition, outcome: "returned" }).lockId).toBeNull();
		},
	);
});
