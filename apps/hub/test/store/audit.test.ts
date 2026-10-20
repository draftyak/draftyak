import { randomBytes } from "node:crypto";
import { rmSync } from "node:fs";
import type { AuditEvent } from "@draftyak/protocol/entities/audit";
import Database from "better-sqlite3-multiple-ciphers";
import { afterEach, beforeEach, expect, it } from "vitest";
import { AuditChain } from "../../src/audit/chain.ts";
import { fixture, nativeBinding } from "./helpers.ts";

let f: Awaited<ReturnType<typeof fixture>>;
let audit: AuditChain;
beforeEach(async () => {
	f = await fixture();
	audit = new AuditChain(f.key.derive("audit"));
});
afterEach(() => {
	f.store.close();
	audit.destroy();
	f.key.destroy();
	rmSync(f.dir, { recursive: true, force: true });
});
const input: AuditEvent = {
	id: "01ARZ3NDEKTSV4RRFFQ69G5FAV",
	at: 1,
	action: "hub.init",
	actor: { kind: "hub", id: null },
	refs: {},
};

it("appends within the caller's transaction and aborts update/delete", () => {
	f.store.write((tx) => audit.append(tx, input));
	f.store.read((db) => audit.verify(db));
	for (const sql of ["DELETE FROM audit_events", "UPDATE audit_events SET at=2"])
		expect(() => f.store.write((tx) => tx.run(sql))).toThrow("append only");
	expect(() =>
		f.store.write((tx) => {
			audit.append(tx, { ...input, id: "01ARZ3NDEKTSV4RRFFQ69G5FAW" });
			throw Error("rollback");
		}),
	).toThrow("rollback");
	expect(f.store.read((db) => db.all("SELECT seq FROM audit_events"))).toHaveLength(1);
	f.store.read((db) => audit.verify(db));
});
it("detects row tampering and truncation against the committed head", () => {
	f.store.write((tx) => audit.append(tx, input));
	f.store.checkpoint();
	const key = f.key.derive("db");
	const attacker = new Database(f.filename, { nativeBinding });
	attacker.pragma("cipher='chacha20'");
	attacker.key(key);
	key.fill(0);
	attacker.exec("DROP TRIGGER audit_no_update; UPDATE audit_events SET at=2");
	expect(() => f.store.read((db) => audit.verify(db))).toThrow("verification");
	attacker.exec("DROP TRIGGER audit_no_delete; DELETE FROM audit_events");
	expect(() => f.store.read((db) => audit.verify(db))).toThrow("head verification");
	attacker.close();
});
it("rejects the wrong HMAC key and arbitrary content metadata", () => {
	f.store.write((tx) => audit.append(tx, input));
	const wrong = new AuditChain(randomBytes(32));
	expect(() => f.store.read((db) => wrong.verify(db))).toThrow("verification");
	wrong.destroy();
	expect(() =>
		f.store.write((tx) => audit.append(tx, { ...input, refs: { message: "private body" } })),
	).toThrow("metadata");
});
