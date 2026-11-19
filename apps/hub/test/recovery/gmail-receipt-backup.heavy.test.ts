import { randomBytes } from "node:crypto";
import { lstatSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { type HeaderList, headersSha256, sha256Hex } from "@draftyak/protocol/hash";
import { afterEach, beforeEach, expect, it } from "vitest";
import { AuditChain } from "../../src/audit/chain.ts";
import { CredentialVault } from "../../src/credentials/vault.ts";
import { newId } from "../../src/kernel/ids.ts";
import { MasterKey } from "../../src/kernel/master-key.ts";
import { HUB_NAMESPACES, migrateHubSchemas } from "../../src/kernel/namespaces.ts";
import {
	MAX_GMAIL_RECEIPT_BLOB_BYTES,
	type NativeGmailSendReceiptData,
} from "../../src/outbox/gmail-receipt.ts";
import {
	type SendTicketInsert,
	SendTicketStorage,
	type StoredAttempt,
} from "../../src/outbox/ticket-storage.ts";
import { SendTicketLedger } from "../../src/outbox/tickets.ts";
import { BackupImageCopyError, copyBackupImageRows } from "../../src/recovery/backup-image-copy.ts";
import { openEncrypted, type SqliteDatabase } from "../../src/store/open.ts";
import { HubStore } from "../../src/store/store.ts";
import { nativeBinding } from "../store/helpers.ts";

let root: string;
let born: { readonly dev: number; readonly ino: number };
let key: MasterKey;
let audit: AuditChain;
let source: HubStore;
let template: HubStore;
const stores: HubStore[] = [];
const images: SqliteDatabase[] = [];
const vaults: CredentialVault[] = [];
const ledgers: SendTicketLedger[] = [];
const storages: SendTicketStorage[] = [];
const temporary = realpathSync.native(os.tmpdir());
const now = 1_800_000_000_000;
const clock = { wallMs: () => now, monotonicMs: () => 10_000 };

beforeEach(async () => {
	root = realpathSync.native(mkdtempSync(path.join(temporary, "draftyak-gmail-backup-")));
	born = lstatSync(root);
	const bytes = randomBytes(32);
	key = new MasterKey(bytes);
	bytes.fill(0);
	const derived = key.derive("audit");
	try {
		audit = new AuditChain(derived);
	} finally {
		derived.fill(0);
	}
	source = await store("source.db");
	template = await store("template.db");
});

afterEach(() => {
	try {
		for (const storage of storages.splice(0)) storage.destroy();
		for (const ledger of ledgers.splice(0)) ledger.destroy();
		for (const vault of vaults.splice(0)) vault.destroy();
		for (const image of images.splice(0)) if (image.open) image.close();
		for (const current of stores.splice(0)) current.close();
	} finally {
		audit.destroy();
		key.destroy();
	}
	const current = lstatSync(root);
	if (
		path.dirname(root) !== temporary ||
		realpathSync.native(root) !== root ||
		current.isSymbolicLink() ||
		current.dev !== born.dev ||
		current.ino !== born.ino
	)
		throw new Error("Unowned Gmail backup fixture folder");
	rmSync(root, { recursive: true, force: false });
});

async function store(name: string, extra: Readonly<Record<string, string>> = {}) {
	const created = new HubStore({
		filename: path.join(root, name),
		nativeBinding,
		masterKey: key,
		create: true,
		migrations: { ...HUB_NAMESPACES, ...extra },
	});
	stores.push(created);
	await migrateHubSchemas(created);
	return created;
}

function session(current: HubStore) {
	const vault = new CredentialVault(current, audit, key);
	vaults.push(vault);
	const storage = new SendTicketStorage(current, audit, vault, key, clock);
	storages.push(storage);
	const ledger = new SendTicketLedger(current, audit, vault, key, clock);
	ledgers.push(ledger);
	return { vault, storage, ledger };
}

function image(name: string): SqliteDatabase {
	const opened = openEncrypted(
		{ filename: path.join(root, name), nativeBinding, create: true },
		key,
		"db",
	);
	images.push(opened);
	return opened;
}

function copy(destination: SqliteDatabase): void {
	source.write((reader) =>
		template.read((canonical) => copyBackupImageRows(reader, destination, canonical)),
	);
}

function blob(current: HubStore, attemptId: string): Buffer {
	return current.read((sql) => {
		const row = sql.get<{ receipt: Uint8Array; storage_type: string }>(
			"SELECT receipt,typeof(receipt) AS storage_type FROM native_gmail_send_receipts WHERE attempt_id=?",
			[attemptId],
		);
		expect(row?.storage_type).toBe("blob");
		if (!row) throw new Error("Missing Gmail receipt BLOB");
		try {
			return Buffer.from(row.receipt);
		} finally {
			row.receipt.fill(0);
		}
	});
}

function completedGmail(current: HubStore) {
	const active = session(current);
	const accountId = newId(now);
	const reference = current.write((sql) =>
		active.vault.createInTransaction(
			sql,
			{ ownerKind: "account", ownerId: accountId, kind: "gmail-oauth" },
			{
				kind: "gmail-oauth",
				accessToken: `DYTEST-${randomBytes(24).toString("hex")}`,
				refreshToken: `DYTEST-${randomBytes(24).toString("hex")}`,
				expiresAt: now + 3_600_000,
			},
		),
	);
	const contentType = `multipart/related; boundary="DYTEST-${randomBytes(12).toString("hex")}"`;
	const headers: HeaderList = [["content-type", contentType]];
	const body = Buffer.from(`DYTEST-${randomBytes(24).toString("hex")}`);
	const input: SendTicketInsert = {
		accountId,
		credentialReference: reference,
		credentialGeneration: 1,
		credentialKind: "gmail-oauth",
		epoch: 4,
		contentHash: sha256Hex("DYTEST approved content"),
		flagsHash: sha256Hex("DYTEST approved flags"),
		notBefore: null,
		deliverBy: now + 120_000,
		outboxId: newId(now),
		instanceId: newId(now),
		method: "POST",
		url: "https://gmail.googleapis.com/upload/gmail/v1/users/me/messages/send?uploadType=multipart",
		contentType,
		headers,
		body,
		approvedHeadersSha256: headersSha256(headers),
		approvedBodySha256: sha256Hex(body),
	};
	// SQL DATA setup exercises persistence, without approval or native IO authority.
	const ticket = current.write((sql) => active.storage.insertInTransaction(sql, input));
	const redemption = active.ledger.redeem({
		ticket,
		instanceId: input.instanceId,
		method: input.method,
		url: input.url,
		contentType,
		headers,
		body,
	});
	const dispatched = active.ledger.beginDispatch(redemption);
	active.ledger.prepareDispatchWrite(dispatched.dispatch);
	const literal = "literal different\r\n folded Message-ID value ".repeat(1500);
	const receipt: NativeGmailSendReceiptData = {
		message: {
			kind: "email.message",
			providerId: "DYTEST-backup-message",
			threadId: "DYTEST-backup-thread",
			internalDate: now,
			labelIds: ["SENT", "DYTEST-backup-label"],
			sizeBytes: 321,
		},
		messageIdHeader: literal,
		bytesRead: Buffer.byteLength(literal) + 512,
	};
	const completed = active.ledger.completeGmailSend(dispatched.dispatch, receipt);
	const row = active.storage.read((sql) =>
		active.storage.find(sql, "outbox_id", input.outboxId),
	) as StoredAttempt;
	expect(completed.attempt.state).toBe("SENT");
	expect(completed.receipt).toEqual(receipt);
	expect(active.ledger.getAttempt(input.outboxId)).toEqual(completed.attempt);
	expect(Buffer.byteLength(row.payload)).toBeLessThanOrEqual(32768);
	return { ...active, input, receipt, row, attempt: completed.attempt };
}

it("copies an authenticated nonempty Gmail receipt and matching attempt through encrypted reopen", () => {
	const completed = completedGmail(source);
	const originalBlob = blob(source, completed.row.id);
	const destination = image("image.db");
	let restoredBlob: Buffer | undefined;
	try {
		expect(originalBlob.byteLength).toBeGreaterThan(32768);
		expect(originalBlob.byteLength).toBeLessThanOrEqual(MAX_GMAIL_RECEIPT_BLOB_BYTES);
		copy(destination);
		expect(destination.pragma("foreign_key_check")).toEqual([]);
		destination.pragma("wal_checkpoint(TRUNCATE)");
		destination.close();
		const restored = new HubStore({
			filename: path.join(root, "image.db"),
			nativeBinding,
			masterKey: key,
		});
		stores.push(restored);
		restoredBlob = blob(restored, completed.row.id);
		expect(restoredBlob).toEqual(originalBlob);
		const reopened = session(restored);
		const saved = reopened.storage.read((sql) =>
			reopened.storage.find(sql, "outbox_id", completed.input.outboxId),
		) as StoredAttempt;
		expect(saved).toEqual(completed.row);
		expect(saved.mac).toEqual(completed.row.mac);
		expect(reopened.ledger.getAttempt(completed.input.outboxId)).toEqual(completed.attempt);
		expect(reopened.storage.read((sql) => reopened.storage.gmailReceipt(sql, saved))).toEqual(
			completed.receipt,
		);
		restored.read((sql) => audit.verify(sql));
		expect(() =>
			restored.write((sql) =>
				sql.run("UPDATE native_send_attempts SET payload=? WHERE id=?", [
					"x".repeat(32769),
					saved.id,
				]),
			),
		).toThrow();
		const tooLarge = Buffer.alloc(MAX_GMAIL_RECEIPT_BLOB_BYTES + 1);
		try {
			expect(() =>
				restored.write((sql) =>
					sql.run("UPDATE native_gmail_send_receipts SET receipt=? WHERE attempt_id=?", [
						tooLarge,
						saved.id,
					]),
				),
			).toThrow();
		} finally {
			tooLarge.fill(0);
		}
		expect(reopened.ledger.getAttempt(completed.input.outboxId)).toEqual(completed.attempt);
		expect(reopened.storage.read((sql) => reopened.storage.gmailReceipt(sql, saved))).toEqual(
			completed.receipt,
		);
	} finally {
		originalBlob.fill(0);
		restoredBlob?.fill(0);
		completed.input.body.fill(0);
		completed.row.body.fill(0);
	}
});

it.each(["source", "template"] as const)(
	"keeps unknown %s schema refusal beside an authenticated Gmail receipt",
	async (side) => {
		const extra = path.join(root, "extra");
		mkdirSync(extra, { mode: 0o700 });
		writeFileSync(
			path.join(extra, "0001_extra.sql"),
			"CREATE TABLE unsupported_receipt_scope(id TEXT PRIMARY KEY) STRICT;",
			{ mode: 0o600 },
		);
		const changed = await store(`${side}-extra.db`, { extra });
		await changed.migrate("extra");
		if (side === "source") source = changed;
		else template = changed;
		const completed = completedGmail(source);
		const before = blob(source, completed.row.id);
		const destination = image("refused.db");
		try {
			expect(() => copy(destination)).toThrow(BackupImageCopyError);
			expect(destination.prepare("SELECT name FROM sqlite_schema").all()).toEqual([]);
			expect(completed.ledger.getAttempt(completed.input.outboxId)).toEqual(completed.attempt);
			const after = blob(source, completed.row.id);
			try {
				expect(after).toEqual(before);
			} finally {
				after.fill(0);
			}
			source.read((sql) => audit.verify(sql));
		} finally {
			before.fill(0);
			completed.input.body.fill(0);
			completed.row.body.fill(0);
		}
	},
);
