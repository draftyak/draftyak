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
import type { NativeGmailSendReceiptData } from "../../src/outbox/gmail-receipt.ts";
import { MAX_GMAIL_RECEIPT_BLOB_BYTES } from "../../src/outbox/gmail-receipt.ts";
import {
	type SendTicketInsert,
	SendTicketStorage,
	type StoredAttempt,
} from "../../src/outbox/ticket-storage.ts";
import { type SendDispatch, SendTicketLedger } from "../../src/outbox/tickets.ts";
import { HubStore } from "../../src/store/store.ts";
import { migrations, nativeBinding } from "../store/helpers.ts";

const cleanup: (() => void)[] = [];
afterEach(() => {
	for (const close of cleanup.splice(0).reverse()) close();
});

async function fixture(kind: "gmail-oauth" | "slack-token" = "gmail-oauth", faultAction?: string) {
	const taskTempRoot = path.resolve(os.tmpdir()),
		taskTempPrefix = "draftyak-gmail-receipt-",
		dir = mkdtempSync(path.join(taskTempRoot, taskTempPrefix)),
		fault = path.join(dir, "fault"),
		key = new MasterKey(randomBytes(32)),
		auditKey = key.derive("audit"),
		audit = new AuditChain(auditKey);
	auditKey.fill(0);
	const stores: HubStore[] = [],
		vaults: CredentialVault[] = [],
		ledgers: SendTicketLedger[] = [],
		storages: SendTicketStorage[] = [];
	cleanup.push(() => {
		for (const current of storages.reverse()) current.destroy();
		for (const current of ledgers.reverse()) current.destroy();
		for (const current of vaults.reverse()) current.destroy();
		for (const current of stores.reverse()) current.close();
		audit.destroy();
		key.destroy();
		const target = path.resolve(dir);
		if (path.dirname(target) !== taskTempRoot || !path.basename(target).startsWith(taskTempPrefix))
			throw new Error("Unexpected receipt test directory");
		rmSync(target, { recursive: true, force: true });
	});
	mkdirSync(fault);
	writeFileSync(
		path.join(fault, "0001_fault.sql"),
		"CREATE TABLE receipt_parent(id INTEGER PRIMARY KEY); CREATE TABLE receipt_child(id INTEGER REFERENCES receipt_parent(id) DEFERRABLE INITIALLY DEFERRED);" +
			(faultAction
				? `CREATE TRIGGER receipt_fault AFTER UPDATE OF state ON native_send_attempts WHEN NEW.state='SENT' BEGIN ${faultAction} END;`
				: ""),
	);
	const time = { wall: 1_800_000_000_000, mono: 10_000 },
		clock = { wallMs: () => time.wall, monotonicMs: () => time.mono },
		options = {
			filename: path.join(dir, "hub.db"),
			nativeBinding,
			masterKey: key,
			migrations: {
				audit: path.join(migrations, "audit"),
				credentials: path.resolve(import.meta.dirname, "../../src/credentials/migrations"),
				tickets: path.resolve(import.meta.dirname, "../../src/outbox/migrations"),
				fault,
			},
		};
	const store = new HubStore({ ...options, create: true });
	stores.push(store);
	for (const name of ["audit", "credentials", "tickets", "fault"]) await store.migrate(name);
	const accountId = newId(time.wall),
		owner: CredentialBinding = { ownerKind: "account", ownerId: accountId, kind },
		vault = new CredentialVault(store, audit, key),
		secret = `DYTEST-${randomBytes(24).toString("hex")}`;
	vaults.push(vault);
	const reference = store.write((tx) =>
		vault.createInTransaction(
			tx,
			owner,
			kind === "gmail-oauth"
				? {
						kind,
						accessToken: secret,
						refreshToken: `DYTEST-${randomBytes(24).toString("hex")}`,
						expiresAt: time.wall + 3_600_000,
					}
				: { kind, accessToken: secret, expiresAt: null },
		),
	);
	const session = (current: HubStore, currentVault: CredentialVault) => {
		const ledger = new SendTicketLedger(current, audit, currentVault, key, clock);
		ledgers.push(ledger);
		const storage = new SendTicketStorage(current, audit, currentVault, key, clock);
		storages.push(storage);
		const value = {
			store: current,
			ledger,
			storage,
		};
		return value;
	};
	const current = session(store, vault);
	const contentType =
			kind === "gmail-oauth"
				? `multipart/related; boundary="DYTEST-${randomBytes(12).toString("hex")}"`
				: "application/json",
		headers: HeaderList = [["content-type", contentType]],
		body = Buffer.from(`DYTEST-${randomBytes(24).toString("hex")}`),
		input: SendTicketInsert = {
			accountId,
			credentialReference: reference,
			credentialGeneration: 1,
			credentialKind: kind,
			epoch: 4,
			contentHash: sha256Hex("DYTEST approved content"),
			flagsHash: sha256Hex("DYTEST approved flags"),
			notBefore: null,
			deliverBy: time.wall + 120_000,
			outboxId: newId(time.wall),
			instanceId: newId(time.wall),
			method: "POST",
			url:
				kind === "gmail-oauth"
					? "https://gmail.googleapis.com/upload/gmail/v1/users/me/messages/send?uploadType=multipart"
					: "https://slack.com/api/chat.postMessage",
			contentType,
			headers,
			body,
			approvedHeadersSha256: headersSha256(headers),
			approvedBodySha256: sha256Hex(body),
		};
	// Internal DML setup proves persistence semantics, not approval, account or native IO authority.
	const ticket = store.write((tx) => current.storage.insertInTransaction(tx, input)),
		redemption = current.ledger.redeem({
			ticket,
			instanceId: input.instanceId,
			method: input.method,
			url: input.url,
			contentType,
			headers,
			body,
		}),
		dispatched = current.ledger.beginDispatch(redemption);
	const row = () =>
		current.storage.read((tx) =>
			current.storage.find(tx, "outbox_id", input.outboxId),
		) as StoredAttempt;
	const auditSequence = () =>
		store.read(
			(tx) => tx.get<{ audit_seq: number }>("SELECT audit_seq FROM audit_meta")?.audit_seq,
		);
	const storedReceipt = () =>
		current.storage.read((tx) => {
			const saved = current.storage.find(tx, "outbox_id", input.outboxId);
			return saved ? current.storage.gmailReceipt(tx, saved) : undefined;
		});
	const receiptCount = () =>
		store.read(
			(tx) =>
				tx.get<{ count: number }>("SELECT count(*) AS count FROM native_gmail_send_receipts")
					?.count,
		);
	return {
		...current,
		input,
		vault,
		owner,
		reference,
		time,
		audit,
		dispatch: dispatched.dispatch,
		row,
		auditSequence,
		storedReceipt,
		receiptCount,
		prepare: () => current.ledger.prepareDispatchWrite(dispatched.dispatch),
		reopen: () => {
			store.close();
			const next = new HubStore(options);
			stores.push(next);
			const nextVault = new CredentialVault(next, audit, key);
			vaults.push(nextVault);
			return session(next, nextVault);
		},
	};
}

function receipt(): NativeGmailSendReceiptData {
	return {
		message: {
			kind: "email.message",
			providerId: "DYTEST-provider-message",
			threadId: "DYTEST-provider-thread",
			internalDate: 1_800_000_000_000,
			labelIds: ["SENT", "DYTEST-label"],
			sizeBytes: 321,
		},
		messageIdHeader: "literal different\r\n folded Message-ID value",
		bytesRead: 512,
	};
}

describe("atomic native Gmail receipt persistence", () => {
	it("persists literal metadata and SENT together, preserves the approved request, and survives reopen", async () => {
		const f = await fixture(),
			prior = f.row();
		f.prepare();
		const input = receipt(),
			result = f.ledger.completeGmailSend(f.dispatch, input),
			actual = f.row();
		expect(result.attempt.state).toBe("SENT");
		expect(result.receipt).toEqual(input);
		expect(f.storedReceipt()).toEqual(input);
		expect(actual.payload).toBe(prior.payload);
		expect(actual.body).toEqual(prior.body);
		expect([actual.id, actual.outbox_id, actual.ticket_id]).toEqual([
			prior.id,
			prior.outbox_id,
			prior.ticket_id,
		]);
		for (const value of [
			result,
			result.attempt,
			result.receipt,
			result.receipt.message,
			result.receipt.message.labelIds,
		])
			expect(Object.isFrozen(value)).toBe(true);
		const next = f.reopen(),
			saved = next.storage.read((tx) => next.storage.find(tx, "outbox_id", f.input.outboxId));
		expect(saved?.state).toBe("SENT");
		expect(
			next.storage.read((tx) => next.storage.gmailReceipt(tx, saved as StoredAttempt)),
		).toEqual(input);
		next.store.read((tx) => f.audit.verify(tx));
	});

	it("records completed IO after ticket expiry without granting another dispatch", async () => {
		const f = await fixture();
		f.prepare();
		f.time.wall += 240_000;
		f.time.mono += 240_000;
		expect(f.ledger.completeGmailSend(f.dispatch, receipt()).attempt.state).toBe("SENT");
		expect(() => f.ledger.completeGmailSend(f.dispatch, receipt())).toThrow();
		expect(() => f.ledger.recordOutcome(f.dispatch, "UNKNOWN")).toThrow();
	});

	it.each(["revoke", "destroy facade"] as const)(
		"records an existing prepared observation after %s without acquiring credential use",
		async (change) => {
			const f = await fixture();
			f.prepare();
			if (change === "revoke")
				f.store.write((tx) => f.vault.invalidateInTransaction(tx, f.reference, f.owner, "revoke"));
			else f.vault.destroy();
			expect(f.ledger.completeGmailSend(f.dispatch, receipt()).attempt.state).toBe("SENT");
			expect(() => f.ledger.completeGmailSend(f.dispatch, receipt())).toThrow();
		},
	);

	it("requires its own prepared Gmail dispatch and refuses generic Gmail success", async () => {
		const f = await fixture(),
			other = await fixture(),
			unprepared = await fixture();
		f.prepare();
		expect(() => other.ledger.completeGmailSend(f.dispatch, receipt())).toThrow();
		expect(() =>
			f.ledger.completeGmailSend(Object.freeze({}) as SendDispatch, receipt()),
		).toThrow();
		expect(() => unprepared.ledger.completeGmailSend(unprepared.dispatch, receipt())).toThrow();
		expect(unprepared.row().state).toBe("SENDING");
		expect(() => f.ledger.recordOutcome(f.dispatch, "SENT")).toThrow();
		expect(f.row().state).toBe("SENDING");
		expect(f.storedReceipt()).toBeUndefined();
		const slack = await fixture("slack-token");
		expect(slack.ledger.recordOutcome(slack.dispatch, "SENT").state).toBe("SENT");
	});

	it("keeps malformed receipt failure atomic and consumes the attempted completion", async () => {
		const f = await fixture(),
			before = f.row(),
			sequence = f.auditSequence();
		f.prepare();
		expect(() =>
			f.ledger.completeGmailSend(f.dispatch, { ...receipt(), messageIdHeader: "" }),
		).toThrow();
		expect(f.row()).toEqual(before);
		expect(f.auditSequence()).toBe(sequence);
		expect(f.receiptCount()).toBe(0);
		expect(() => f.ledger.completeGmailSend(f.dispatch, receipt())).toThrow();
	});

	it("rolls receipt, outcome and audit back when the containing write fails", async () => {
		const f = await fixture(),
			before = f.row(),
			sequence = f.auditSequence();
		expect(() =>
			f.storage.write((tx) => {
				const current = f.storage.find(tx, "id", before.id) as StoredAttempt;
				f.storage.completeGmailSendInTransaction(tx, current, receipt());
				throw new Error("DYTEST rollback");
			}),
		).toThrow("DYTEST rollback");
		expect(f.row()).toEqual(before);
		expect(f.auditSequence()).toBe(sequence);
		expect(f.receiptCount()).toBe(0);
	});

	it.each([
		[
			"rewritten",
			"UPDATE native_send_attempts SET payload=OLD.payload,state=OLD.state,updated_at=OLD.updated_at,audit_seq=OLD.audit_seq,mac=OLD.mac WHERE id=NEW.id;",
		],
		[
			"deleted",
			"DELETE FROM native_gmail_send_receipts WHERE attempt_id=NEW.id; DELETE FROM native_send_attempts WHERE id=NEW.id;",
		],
		["failed commit", "INSERT INTO receipt_child(id) VALUES(1);"],
		[
			"tampered receipt",
			"UPDATE native_gmail_send_receipts SET receipt=X'7b7d' WHERE attempt_id=NEW.id;",
		],
		["deleted receipt", "DELETE FROM native_gmail_send_receipts WHERE attempt_id=NEW.id;"],
	] as const)("refuses a %s durable completion and rolls every write back", async (_, action) => {
		const f = await fixture("gmail-oauth", action);
		f.prepare();
		const before = f.row(),
			sequence = f.auditSequence();
		expect(() => f.ledger.completeGmailSend(f.dispatch, receipt())).toThrow();
		expect(f.row()).toEqual(before);
		expect(f.auditSequence()).toBe(sequence);
		expect(f.receiptCount()).toBe(0);
	});

	it("retains a literal header larger than the old payload cap without truncation", async () => {
		const f = await fixture();
		f.prepare();
		const priorPayload = f.row().payload;
		const literal = "DYTEST-".repeat(15_000),
			input = { ...receipt(), messageIdHeader: literal, bytesRead: literal.length + 512 };
		expect(f.ledger.completeGmailSend(f.dispatch, input).receipt.messageIdHeader).toBe(literal);
		expect(f.storedReceipt()?.messageIdHeader).toBe(literal);
		expect(f.row().payload).toBe(priorPayload);
		expect(Buffer.byteLength(priorPayload)).toBeLessThanOrEqual(32768);
	});

	it("keeps authenticated legacy receiptless Gmail history readable", async () => {
		const f = await fixture(),
			id = f.row().id;
		f.storage.write((tx) => {
			const current = f.storage.find(tx, "id", id) as StoredAttempt;
			f.storage.transition(tx, current, "SENT");
		});
		const prior = f.row();
		const next = f.reopen(),
			saved = next.storage.read((tx) => next.storage.find(tx, "outbox_id", f.input.outboxId));
		expect(saved?.state).toBe("SENT");
		expect(saved).toEqual(prior);
		expect(
			next.storage.read((tx) => next.storage.gmailReceipt(tx, saved as StoredAttempt)),
		).toBeUndefined();
	});

	it.each(["alter", "delete", "swap"] as const)(
		"authenticates the receipt BLOB and refuses a committed %s without legacy fallback",
		async (change) => {
			const f = await fixture();
			f.prepare();
			f.ledger.completeGmailSend(f.dispatch, receipt());
			const prior = f.row();
			if (change === "delete")
				f.store.write((tx) =>
					tx.run("DELETE FROM native_gmail_send_receipts WHERE attempt_id=?", [prior.id]),
				);
			else {
				let replacement: Buffer;
				if (change === "swap") {
					const other = await fixture();
					other.prepare();
					other.ledger.completeGmailSend(other.dispatch, {
						...receipt(),
						messageIdHeader: "DYTEST-other-receipt",
					});
					replacement = other.store.read((tx) => {
						const saved = tx.get<{ receipt: Uint8Array }>(
							"SELECT receipt FROM native_gmail_send_receipts LIMIT 1",
						) as { receipt: Uint8Array };
						try {
							return Buffer.from(saved.receipt);
						} finally {
							saved.receipt.fill(0);
						}
					});
				} else
					replacement = Buffer.from(
						canonicalize({ ...receipt(), messageIdHeader: "DYTEST-altered" }),
					);
				try {
					f.store.write((tx) =>
						tx.run("UPDATE native_gmail_send_receipts SET receipt=? WHERE attempt_id=?", [
							replacement,
							prior.id,
						]),
					);
				} finally {
					replacement.fill(0);
				}
			}
			expect(() => f.ledger.getAttempt(f.input.outboxId)).toThrow();
			expect(() => f.storedReceipt()).toThrow();
			const actual = f.store.read((tx) =>
				tx.get<StoredAttempt>("SELECT * FROM native_send_attempts WHERE id=?", [prior.id]),
			);
			expect(actual).toEqual(prior);
		},
	);

	it("refuses attaching a receipt to an authenticated legacy MAC", async () => {
		const f = await fixture(),
			id = f.row().id;
		f.storage.write((tx) => {
			const current = f.storage.find(tx, "id", id) as StoredAttempt;
			f.storage.transition(tx, current, "SENT");
		});
		const data = Buffer.from(canonicalize(receipt()));
		try {
			f.store.write((tx) =>
				tx.run("INSERT INTO native_gmail_send_receipts(attempt_id,receipt) VALUES(?,?)", [
					id,
					data,
				]),
			);
		} finally {
			data.fill(0);
		}
		expect(() => f.ledger.getAttempt(f.input.outboxId)).toThrow();
		expect(() => f.storedReceipt()).toThrow();
	});

	it("keeps the original payload limit and enforces the receipt FK and BLOB budget", async () => {
		const f = await fixture(),
			prior = f.row();
		expect(() =>
			f.store.write((tx) =>
				tx.run("UPDATE native_send_attempts SET payload=? WHERE id=?", [
					"x".repeat(32769),
					prior.id,
				]),
			),
		).toThrow();
		for (const bytes of [Buffer.alloc(0), Buffer.alloc(MAX_GMAIL_RECEIPT_BLOB_BYTES + 1)]) {
			try {
				expect(() =>
					f.store.write((tx) =>
						tx.run("INSERT INTO native_gmail_send_receipts(attempt_id,receipt) VALUES(?,?)", [
							prior.id,
							bytes,
						]),
					),
				).toThrow();
			} finally {
				bytes.fill(0);
			}
		}
		expect(() =>
			f.store.write((tx) =>
				tx.run("INSERT INTO native_gmail_send_receipts(attempt_id,receipt) VALUES(?,?)", [
					newId(),
					Buffer.from("{}"),
				]),
			),
		).toThrow();
		expect(f.row()).toEqual(prior);
		expect(f.receiptCount()).toBe(0);
	});
});
