import { randomBytes } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { type HeaderList, headersSha256, sha256Hex } from "@draftyak/protocol/hash";
import { canonicalize } from "@draftyak/protocol/jcs";
import { afterEach, describe, expect, it } from "vitest";
import { AuditChain } from "../../src/audit/chain.ts";
import { type CredentialBinding, CredentialVault } from "../../src/credentials/vault.ts";
import { newId } from "../../src/kernel/ids.ts";
import { MasterKey } from "../../src/kernel/master-key.ts";
import {
	resetSendTicketStorageForRestore,
	type SendAttemptState,
	type SendTicketInsert,
	SendTicketStorage,
	type StoredAttempt,
} from "../../src/outbox/ticket-storage.ts";
import { openEncrypted, type SqliteDatabase } from "../../src/store/open.ts";
import { HubStore, type SqlReader, type SqlTransaction } from "../../src/store/store.ts";
import { migrations, nativeBinding } from "../store/helpers.ts";

const original = Object.freeze({
	insert: SendTicketStorage.prototype.insertInTransaction,
	find: SendTicketStorage.prototype.find,
	transition: SendTicketStorage.prototype.transition,
});
interface OwnedFixture {
	dir: string;
	key: MasterKey;
	audit?: AuditChain;
	store?: HubStore;
	vault?: CredentialVault;
	storage?: SendTicketStorage;
	drain?: Promise<void>;
	constructingStore: boolean;
	constructingEditor: boolean;
	editorCloseUncertain: boolean;
	editor?: SqliteDatabase;
}
const fixtures = new Set<OwnedFixture>();
const bodies = new Set<Promise<void>>();
function owned(body: () => Promise<void>): Promise<void> {
	const result = Promise.resolve().then(body);
	bodies.add(result);
	void result.then(
		() => bodies.delete(result),
		() => bodies.delete(result),
	);
	return result;
}
function closeEditor(f: OwnedFixture): void {
	if (!f.editor) return;
	try {
		f.editor.close();
		if (f.editor.open !== false) throw new Error("Storage editor remains open");
	} catch {
		f.editorCloseUncertain = true;
		throw new Error("Storage editor cleanup is uncertain");
	}
	delete f.editor;
}
afterEach(async () => {
	while (bodies.size) await Promise.allSettled([...bodies]);
	let incomplete = false;
	for (const f of fixtures) {
		try {
			if (f.constructingStore || f.constructingEditor || f.editorCloseUncertain)
				throw new Error("Storage fixture construction or cleanup is uncertain");
			closeEditor(f);
			f.storage?.destroy();
			if (f.vault) {
				f.drain ??= f.vault.drain();
				const drain = f.drain;
				try {
					await drain;
				} catch (error) {
					if (f.drain === drain) delete f.drain;
					throw error;
				}
			}
			f.store?.close();
			f.audit?.destroy();
			f.key.destroy();
			rmSync(f.dir, { recursive: true, force: true });
			fixtures.delete(f);
		} catch {
			incomplete = true;
		}
	}
	if (incomplete) throw new Error("Storage fixture cleanup is incomplete");
});

async function fixture(readbackFault = false) {
	const dir = mkdtempSync(path.join(os.tmpdir(), "draftyak-ticket-storage-restore-")),
		key = new MasterKey(randomBytes(32)),
		tracked: OwnedFixture = {
			dir,
			key,
			constructingStore: false,
			constructingEditor: false,
			editorCloseUncertain: false,
		};
	fixtures.add(tracked);
	const auditKey = key.derive("audit");
	let audit: AuditChain;
	try {
		audit = new AuditChain(auditKey);
		tracked.audit = audit;
	} finally {
		auditKey.fill(0);
	}
	const fault = path.join(dir, "fault");
	mkdirSync(fault);
	writeFileSync(
		path.join(fault, "0001_fault.sql"),
		"CREATE TABLE ticket_parent(id INTEGER PRIMARY KEY); CREATE TABLE ticket_child(id INTEGER REFERENCES ticket_parent(id) DEFERRABLE INITIALLY DEFERRED);" +
			(readbackFault
				? `
CREATE TABLE ticket_readback_target(id TEXT PRIMARY KEY NOT NULL);
CREATE TRIGGER ticket_readback_fault AFTER UPDATE OF state ON native_send_attempts
WHEN NEW.state='NEEDS_REAPPROVAL' AND EXISTS(SELECT 1 FROM ticket_readback_target WHERE id=NEW.id)
BEGIN
  UPDATE native_send_attempts SET body=X'00' WHERE id=NEW.id;
END;
`
				: ""),
	);
	tracked.constructingStore = true;
	const store = new HubStore({
		filename: path.join(dir, "hub.db"),
		nativeBinding,
		masterKey: key,
		create: true,
		migrations: {
			audit: path.join(migrations, "audit"),
			credentials: path.resolve(import.meta.dirname, "../../src/credentials/migrations"),
			tickets: path.resolve(import.meta.dirname, "../../src/outbox/migrations"),
			fault,
		},
	});
	tracked.store = store;
	tracked.constructingStore = false;
	for (const namespace of ["audit", "credentials", "tickets", "fault"])
		await store.migrate(namespace);
	const time: {
		wall: number;
		mono: number;
		reads: number;
		onWall: (() => void) | undefined;
	} = { wall: 1_800_000_000_000, mono: 10_000, reads: 0, onWall: undefined };
	const clock = {
		wallMs: () => {
			time.reads++;
			time.onWall?.();
			return time.wall;
		},
		monotonicMs: () => time.mono,
	};
	const vault = new CredentialVault(store, audit, key);
	tracked.vault = vault;
	const accountId = newId(time.wall),
		owner: CredentialBinding = { ownerKind: "account", ownerId: accountId, kind: "slack-token" },
		reference = store.write((tx) =>
			vault.createInTransaction(tx, owner, {
				kind: "slack-token",
				accessToken: `DYTEST-${randomBytes(20).toString("hex")}`,
				expiresAt: null,
			}),
		),
		storage = new SendTicketStorage(store, audit, vault, key, clock);
	tracked.storage = storage;
	const make = (): SendTicketInsert => {
		const headers: HeaderList = [["content-type", "application/json"]],
			body = Buffer.from(JSON.stringify({ text: "Synthetic storage record DATA" }));
		return {
			accountId,
			credentialReference: reference,
			credentialGeneration: 1,
			credentialKind: "slack-token",
			epoch: 4,
			contentHash: sha256Hex("record DATA content"),
			flagsHash: sha256Hex("record DATA flags"),
			notBefore: null,
			deliverBy: time.wall + 120_000,
			outboxId: newId(time.wall),
			instanceId: newId(time.wall),
			method: "POST",
			url: "https://slack.com/api/chat.postMessage",
			contentType: "application/json",
			headers,
			body,
			approvedHeadersSha256: headersSha256(headers),
			approvedBodySha256: sha256Hex(body),
		};
	};
	return { store, audit, vault, storage, owner, reference, time, make, resources: tracked };
}
type Fixture = Awaited<ReturnType<typeof fixture>>;
const paths: Record<SendAttemptState, readonly SendAttemptState[]> = {
	ISSUED: [],
	REDEEMED: ["REDEEMED"],
	SENDING: ["REDEEMED", "SENDING"],
	SENT: ["REDEEMED", "SENDING", "SENT"],
	FAILED: ["REDEEMED", "SENDING", "FAILED"],
	UNKNOWN: ["REDEEMED", "SENDING", "UNKNOWN"],
	NEEDS_REAPPROVAL: ["NEEDS_REAPPROVAL"],
	EXPIRED: ["EXPIRED"],
};
// These are authenticated persistence DATA, not native approval or usable ticket issuance.
function seed(f: Fixture, state: SendAttemptState): void {
	f.store.write((tx) => {
		const ticket = original.insert.call(f.storage, tx, f.make());
		let row = original.find.call(f.storage, tx, "ticket_id", ticket.id);
		if (!row) throw new Error("Missing storage DATA record");
		for (const next of paths[state]) row = original.transition.call(f.storage, tx, row, next);
	});
}
function rows(db: SqlReader): StoredAttempt[] {
	return db.all<StoredAttempt>("SELECT * FROM main.native_send_attempts ORDER BY id");
}
function encoded(row: StoredAttempt) {
	return { ...row, body: Buffer.from(row.body).toString("hex") };
}
function head(db: SqlReader): number {
	const value = db.get<{ audit_seq: number }>(
		"SELECT audit_seq FROM main.audit_meta WHERE singleton=1",
	);
	if (!value) throw new Error("Missing audit head");
	return value.audit_seq;
}
function fingerprint(db: SqlReader): string {
	return sha256Hex(
		canonicalize({
			attempts: rows(db).map(encoded),
			audit: db.all("SELECT * FROM main.audit_events ORDER BY seq"),
			meta: db.get("SELECT * FROM main.audit_meta WHERE singleton=1"),
		}),
	);
}
function verify(f: Fixture): void {
	f.store.read((db) => {
		f.audit.verify(db);
		for (const row of rows(db))
			expect(original.find.call(f.storage, db, "id", row.id)?.id).toBe(row.id);
	});
}

describe("restored send-ticket storage DATA restriction", () => {
	it("reduces only three live states and preserves terminal bytes, bindings and history", () =>
		owned(async () => {
			const f = await fixture();
			for (const state of Object.keys(paths) as SendAttemptState[]) seed(f, state);
			f.store.write((tx) => f.vault.invalidateInTransaction(tx, f.reference, f.owner, "revoke"));
			f.time.wall += 120_001;
			f.time.mono += 120_001;
			const before = f.store.read((db) => rows(db).map(encoded)),
				beforeHead = f.store.read(head),
				history = f.store.read((db) => db.all("SELECT * FROM main.audit_events ORDER BY seq"));
			expect(f.store.write((tx) => resetSendTicketStorageForRestore(f.storage, tx))).toBe(3);
			const after = f.store.read((db) => rows(db).map(encoded));
			for (const prior of before) {
				const current = after.find((row) => row.id === prior.id);
				if (!current) throw new Error("Missing restored DATA record");
				const expected =
					prior.state === "SENDING"
						? "UNKNOWN"
						: prior.state === "ISSUED" || prior.state === "REDEEMED"
							? "NEEDS_REAPPROVAL"
							: prior.state;
				expect(current.state).toBe(expected);
				if (expected === prior.state) expect(current).toEqual(prior);
				else {
					expect({
						...current,
						state: prior.state,
						updated_at: prior.updated_at,
						audit_seq: prior.audit_seq,
						mac: prior.mac,
					}).toEqual(prior);
					expect(current.updated_at).toBe(f.time.wall);
					expect(current.audit_seq).toBeGreaterThan(beforeHead);
				}
			}
			expect(f.store.read(head)).toBe(beforeHead + 3);
			expect(
				f.store.read((db) =>
					db.all("SELECT * FROM main.audit_events WHERE seq<=? ORDER BY seq", [beforeHead]),
				),
			).toEqual(history);
			verify(f);
			const once = f.store.read(fingerprint);
			expect(f.store.write((tx) => resetSendTicketStorageForRestore(f.storage, tx))).toBe(0);
			expect(f.store.read(fingerprint)).toBe(once);
		}));

	it("processes all 129 eligible rows across a keyset page and repeats without new audit", () =>
		owned(async () => {
			const f = await fixture();
			for (let i = 0; i < 129; i++) seed(f, i === 128 ? "SENDING" : "ISSUED");
			seed(f, "SENT");
			const before = f.store.read((db) => rows(db).map(encoded)),
				beforeHead = f.store.read(head),
				terminal = before.find((row) => row.state === "SENT");
			expect(before).toHaveLength(130);
			expect(f.store.write((tx) => resetSendTicketStorageForRestore(f.storage, tx))).toBe(129);
			const after = f.store.read((db) => rows(db).map(encoded));
			expect(after.filter((row) => row.state === "NEEDS_REAPPROVAL")).toHaveLength(128);
			expect(after.filter((row) => row.state === "UNKNOWN")).toHaveLength(1);
			expect(after.find((row) => row.id === terminal?.id)).toEqual(terminal);
			expect(f.store.read(head)).toBe(beforeHead + 129);
			verify(f);
			const once = f.store.read(fingerprint);
			expect(f.store.write((tx) => resetSendTicketStorageForRestore(f.storage, tx))).toBe(0);
			expect(f.store.read(fingerprint)).toBe(once);
		}));

	it("refuses an empty corrupt ID before reducing later valid rows", () =>
		owned(async () => {
			const f = await fixture();
			seed(f, "ISSUED");
			seed(f, "ISSUED");
			const ordered = f.store.read(rows),
				first = ordered[0],
				second = ordered[1];
			if (!first || !second) throw new Error("Missing first-page DATA records");
			// Corrupt only fixture DATA after its original Store accepted the canonical schema.
			f.resources.constructingEditor = true;
			const editor = openEncrypted(
				{ filename: path.join(f.resources.dir, "hub.db"), nativeBinding },
				f.resources.key,
			);
			f.resources.editor = editor;
			f.resources.constructingEditor = false;
			try {
				editor.pragma("ignore_check_constraints = ON");
				try {
					expect(
						editor.prepare("UPDATE main.native_send_attempts SET id='' WHERE id=?").run(first.id)
							.changes,
					).toBe(1);
				} finally {
					editor.pragma("ignore_check_constraints = OFF");
				}
			} finally {
				closeEditor(f.resources);
			}
			expect(editor.open).toBe(false);
			expect(f.store.read((db) => rows(db).map((row) => row.id))).toEqual(["", second.id]);
			const before = f.store.read(fingerprint);
			f.time.reads = 0;
			expect(() =>
				f.store.write((tx) => resetSendTicketStorageForRestore(f.storage, tx)),
			).toThrowError("Send ticket unavailable");
			expect(f.time.reads).toBe(0);
			expect(f.store.read(fingerprint)).toBe(before);
			f.store.read((db) => f.audit.verify(db));
		}));

	it("authenticates actual trigger-altered readback and rolls back both reductions", () =>
		owned(async () => {
			const f = await fixture(true);
			seed(f, "ISSUED");
			seed(f, "ISSUED");
			const ordered = f.store.read(rows),
				first = ordered[0],
				second = ordered[1];
			if (!first || !second) throw new Error("Missing readback DATA records");
			f.store.write((tx) =>
				tx.run("INSERT INTO ticket_readback_target(id) VALUES(?)", [second.id]),
			);
			const before = f.store.read(fingerprint),
				beforeHead = f.store.read(head),
				sentinel = new Error("Roll back the actual trigger witness");
			let witnessedTrigger = false,
				witnessFailure: unknown;
			try {
				f.store.write((tx) => {
					const row = original.find.call(f.storage, tx, "id", second.id);
					if (!row) throw new Error("Missing trigger witness DATA record");
					original.transition.call(f.storage, tx, row, "NEEDS_REAPPROVAL");
					const actual = tx.get<StoredAttempt>(
						"SELECT * FROM main.native_send_attempts WHERE id=?",
						[second.id],
					);
					if (!actual) throw new Error("Missing changed trigger DATA record");
					witnessedTrigger =
						Buffer.from(actual.body).equals(Buffer.from([0])) &&
						actual.state === "NEEDS_REAPPROVAL" &&
						head(tx) === beforeHead + 1 &&
						original.find.call(f.storage, tx, "id", first.id)?.state === "ISSUED";
					throw sentinel;
				});
			} catch (error) {
				witnessFailure = error;
			}
			expect(witnessFailure).toBe(sentinel);
			expect(witnessedTrigger).toBe(true);
			expect(f.store.read(fingerprint)).toBe(before);
			verify(f);
			let txInUse: SqlTransaction | undefined,
				clockCalls = 0,
				sawEarlierReduction = false;
			f.time.onWall = () => {
				if (++clockCalls !== 2 || !txInUse) return;
				sawEarlierReduction =
					original.find.call(f.storage, txInUse, "id", first.id)?.state === "NEEDS_REAPPROVAL" &&
					head(txInUse) === beforeHead + 1;
			};
			try {
				expect(() =>
					f.store.write((tx) => {
						txInUse = tx;
						return resetSendTicketStorageForRestore(f.storage, tx);
					}),
				).toThrowError("Send ticket unavailable");
			} finally {
				f.time.onWall = undefined;
			}
			expect(clockCalls).toBe(2);
			expect(sawEarlierReduction).toBe(true);
			expect(f.store.read(fingerprint)).toBe(before);
			verify(f);
		}));

	for (const refusal of [
		"foreign transaction",
		"retired transaction",
		"proxy transaction",
		"structural transaction",
		"proxy receiver",
		"structural receiver",
		"destroyed receiver",
	] as const) {
		it(`refuses a ${refusal} before clock or hostile DATA access`, () =>
			owned(async () => {
				const f = await fixture();
				seed(f, "ISSUED");
				const before = f.store.read(fingerprint);
				let touches = 0;
				const hostile = () => {
					touches++;
					throw new Error("Hostile DATA accessed");
				};
				f.time.reads = 0;
				if (refusal === "foreign transaction") {
					const other = await fixture(),
						otherBefore = other.store.read(fingerprint);
					expect(() =>
						other.store.write((tx) => resetSendTicketStorageForRestore(f.storage, tx)),
					).toThrowError("Send ticket unavailable");
					expect(other.store.read(fingerprint)).toBe(otherBefore);
				} else if (refusal === "retired transaction") {
					let ended: SqlTransaction | undefined;
					f.store.write((tx) => {
						ended = tx;
					});
					expect(() =>
						resetSendTicketStorageForRestore(f.storage, ended as SqlTransaction),
					).toThrowError("Send ticket unavailable");
				} else if (refusal === "destroyed receiver") {
					f.storage.destroy();
					expect(() =>
						f.store.write((tx) => resetSendTicketStorageForRestore(f.storage, tx)),
					).toThrowError("Send ticket unavailable");
				} else {
					expect(() =>
						f.store.write((tx) => {
							if (refusal === "proxy transaction")
								return resetSendTicketStorageForRestore(f.storage, new Proxy(tx, { get: hostile }));
							if (refusal === "structural transaction")
								return resetSendTicketStorageForRestore(f.storage, {
									get: hostile,
									all: hostile,
									run: hostile,
								});
							if (refusal === "proxy receiver")
								return resetSendTicketStorageForRestore(new Proxy(f.storage, { get: hostile }), tx);
							const shape = Object.create(SendTicketStorage.prototype);
							Object.defineProperty(shape, "now", { get: hostile });
							return resetSendTicketStorageForRestore(shape, tx);
						}),
					).toThrowError("Send ticket unavailable");
				}
				expect(f.time.reads).toBe(0);
				expect(touches).toBe(0);
				expect(f.store.read(fingerprint)).toBe(before);
			}));
	}

	it("uses captured private reset operations despite public method overrides", () =>
		owned(async () => {
			const f = await fixture();
			for (const state of ["ISSUED", "REDEEMED", "SENDING"] as const) seed(f, state);
			const names = ["payload", "now", "transition", "write"] as const,
				descriptors = names.map(
					(name) => [name, Object.getOwnPropertyDescriptor(f.storage, name)] as const,
				);
			let calls = 0,
				result: number | undefined,
				failure: unknown;
			try {
				for (const name of names)
					Object.defineProperty(f.storage, name, {
						configurable: true,
						value: () => {
							calls++;
							throw new Error("Public method redirected");
						},
					});
				result = f.store.write((tx) => resetSendTicketStorageForRestore(f.storage, tx));
			} catch (error) {
				failure = error;
			} finally {
				for (const [name, descriptor] of descriptors) {
					if (descriptor) Object.defineProperty(f.storage, name, descriptor);
					else Reflect.deleteProperty(f.storage, name);
				}
			}
			expect(failure === undefined).toBe(true);
			expect(result).toBe(3);
			expect(calls).toBe(0);
			for (const [name, descriptor] of descriptors)
				expect(Object.getOwnPropertyDescriptor(f.storage, name)).toEqual(descriptor);
			verify(f);
		}));

	it("authenticates a late preserved row and rolls back earlier reductions and audit", () =>
		owned(async () => {
			const f = await fixture();
			for (let i = 0; i < 3; i++) seed(f, "ISSUED");
			const ordered = f.store.read(rows),
				first = ordered[0],
				last = ordered[2];
			if (!first || !last) throw new Error("Missing ordered DATA records");
			f.store.write((tx) => {
				let row = original.find.call(f.storage, tx, "id", last.id);
				if (!row) throw new Error("Missing terminal DATA record");
				for (const state of ["REDEEMED", "SENDING", "SENT"] as const)
					row = original.transition.call(f.storage, tx, row, state);
				const invalidMac = `${row.mac[0] === "0" ? "1" : "0"}${row.mac.slice(1)}`;
				tx.run("UPDATE main.native_send_attempts SET mac=? WHERE id=?", [invalidMac, last.id]);
			});
			const before = f.store.read(fingerprint),
				beforeHead = f.store.read(head);
			let txInUse: SqlTransaction | undefined,
				clockCalls = 0,
				sawEarlierReduction = false;
			f.time.onWall = () => {
				if (++clockCalls !== 2 || !txInUse) return;
				sawEarlierReduction =
					original.find.call(f.storage, txInUse, "id", first.id)?.state === "NEEDS_REAPPROVAL" &&
					head(txInUse) > beforeHead;
			};
			try {
				expect(() =>
					f.store.write((tx) => {
						txInUse = tx;
						return resetSendTicketStorageForRestore(f.storage, tx);
					}),
				).toThrowError("Send ticket unavailable");
			} finally {
				f.time.onWall = undefined;
			}
			expect(sawEarlierReduction).toBe(true);
			expect(f.store.read(fingerprint)).toBe(before);
			f.store.read((db) => f.audit.verify(db));
		}));

	it("rolls back a completed reset when the actual outer commit fails", () =>
		owned(async () => {
			const f = await fixture();
			seed(f, "ISSUED");
			seed(f, "SENDING");
			const before = f.store.read(fingerprint);
			let reachedEnd = false,
				count: number | undefined,
				insideStates: SendAttemptState[] = [];
			expect(() =>
				f.store.write((tx) => {
					count = resetSendTicketStorageForRestore(f.storage, tx);
					insideStates = rows(tx)
						.map((row) => row.state)
						.sort();
					tx.run("INSERT INTO ticket_child(id) VALUES(99)");
					reachedEnd = true;
				}),
			).toThrow();
			expect(reachedEnd).toBe(true);
			expect(count).toBe(2);
			expect(insideStates).toEqual(["NEEDS_REAPPROVAL", "UNKNOWN"]);
			expect(f.store.read(fingerprint)).toBe(before);
			verify(f);
		}));

	it("rejects a stale captured row after genuine same-transaction reentry", () =>
		owned(async () => {
			const f = await fixture();
			seed(f, "ISSUED");
			seed(f, "ISSUED");
			const ordered = f.store.read(rows),
				first = ordered[0],
				second = ordered[1];
			if (!first || !second) throw new Error("Missing CAS DATA records");
			const before = f.store.read(fingerprint),
				beforeHead = f.store.read(head);
			let txInUse: SqlTransaction | undefined,
				clockCalls = 0,
				sawPriorReduction = false,
				sawReentry = false;
			f.time.onWall = () => {
				if (++clockCalls !== 2 || !txInUse) return;
				f.time.onWall = undefined;
				const row = original.find.call(f.storage, txInUse, "id", second.id);
				if (!row) throw new Error("Missing reentrant DATA record");
				original.transition.call(f.storage, txInUse, row, "REDEEMED");
				sawPriorReduction =
					original.find.call(f.storage, txInUse, "id", first.id)?.state === "NEEDS_REAPPROVAL";
				sawReentry =
					original.find.call(f.storage, txInUse, "id", second.id)?.state === "REDEEMED" &&
					head(txInUse) >= beforeHead + 2;
			};
			try {
				expect(() =>
					f.store.write((tx) => {
						txInUse = tx;
						return resetSendTicketStorageForRestore(f.storage, tx);
					}),
				).toThrowError("Send ticket unavailable");
			} finally {
				f.time.onWall = undefined;
			}
			expect(sawPriorReduction).toBe(true);
			expect(sawReentry).toBe(true);
			expect(f.store.read(fingerprint)).toBe(before);
			verify(f);
		}));
});
