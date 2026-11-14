import { createHmac, timingSafeEqual } from "node:crypto";
import { fileURLToPath } from "node:url";
import { jcsSha256 } from "@draftyak/protocol/hash";
import { canonicalize } from "@draftyak/protocol/jcs";
import { WorkDatabase, type WorkScope } from "../jobs/database.ts";
import { id, integer } from "../jobs/values.ts";
import { MasterKey } from "../kernel/master-key.ts";
import { assertStoreTransaction, HubStore, type SqlTransaction } from "../store/store.ts";
import type { MetadataAccountRef } from "../sync/apply.ts";
import { type NativeParsedRecord, NativeParsedStore } from "../sync/parsed.ts";
import {
	captureDraftBinding,
	type DraftBinding,
	type DraftCreation,
	draftRecord,
	immutableDraftData,
	NativeDraftRevisions,
	type NativeRevision,
} from "./revisions.ts";

export const REPLY_SOURCE_NAMESPACE = "replysources";
export const REPLY_SOURCE_MIGRATIONS: string = fileURLToPath(
	new URL(
		import.meta.url.endsWith(".ts")
			? "./reply-source-migrations/"
			: "./drafts/reply-source-migrations/",
		import.meta.url,
	),
);

const MAX_PAYLOAD_BYTES = 1_048_576;
const MAC_DOMAIN = "draftyak/native-reply-source/v1\0";
const BINDING_FIELDS = ["draftId", "accountId", "conversationId", "channel"];
const CREATION_FIELDS = [...BINDING_FIELDS, "author", "content", "flags"];
const ACCOUNT_FIELDS = ["accountId", "generation", "pluginInstanceId", "ownerEpoch", "mode"];
const SOURCE_FIELDS = [
	"account",
	"messageId",
	"providerId",
	"threadId",
	"conversationId",
	"raw",
	"rawSha256",
	"rawBytes",
	"sourceCheckpoint",
	"mailSha256",
];
const original = Object.freeze({
	sql: WorkDatabase.prototype.sql,
	abort: WorkDatabase.prototype.abort,
	assertStoreKey: HubStore.prototype.assertMasterKey,
	assertRevisionStore: NativeDraftRevisions.prototype.assertStore,
	assertRevisionTransaction: NativeDraftRevisions.prototype.assertTransaction,
	create: NativeDraftRevisions.prototype.createInTransaction,
	current: NativeDraftRevisions.prototype.currentInTransaction,
	readParsed: NativeParsedStore.prototype.read,
	derive: MasterKey.prototype.derive,
});

export interface EmailReplySourceSelection {
	readonly account: MetadataAccountRef;
	readonly messageId: string;
}
export interface EmailReplySourceAnchor {
	readonly account: Readonly<MetadataAccountRef>;
	readonly messageId: string;
	readonly providerId: string;
	readonly threadId: string;
	readonly conversationId: string;
	readonly raw: { readonly ref: string };
	readonly rawSha256: string;
	readonly rawBytes: number;
	readonly sourceCheckpoint: { readonly cursor: string; readonly revision: number };
	readonly mailSha256: string;
}
export interface ReplySourceAssociation {
	readonly binding: Readonly<DraftBinding>;
	readonly initialRev: 1;
	readonly initialRevisionSha256: string;
	readonly currentRev: number;
	readonly source: EmailReplySourceAnchor;
	readonly association: "unverified";
}
interface Payload {
	readonly version: 1;
	readonly binding: DraftBinding;
	readonly initialRev: 1;
	readonly initialRevisionSha256: string;
	readonly source: EmailReplySourceAnchor;
}
interface StoredAssociation {
	readonly initialRev: number;
	readonly payload: string | null;
	readonly mac: string | null;
}

export class ReplySourceError extends Error {
	readonly code = "REPLY_SOURCE_UNAVAILABLE";
	constructor() {
		super("Reply source unavailable");
		this.name = "ReplySourceError";
	}
}
function refuse(): never {
	throw new ReplySourceError();
}
function text(value: unknown, maximum: number): string {
	if (
		typeof value !== "string" ||
		!value.isWellFormed() ||
		value.length < 1 ||
		value.length > maximum ||
		Buffer.byteLength(value, "utf8") > maximum
	)
		refuse();
	return value;
}
function sha(value: unknown): string {
	if (typeof value !== "string" || !/^[0-9a-f]{64}$/.test(value)) refuse();
	return value;
}
function emailBinding(input: DraftBinding): DraftBinding {
	const bound = captureDraftBinding(input);
	if (bound.channel !== "email" || bound.conversationId === null) refuse();
	return bound;
}
function account(input: unknown): MetadataAccountRef {
	const value = draftRecord(input, ACCOUNT_FIELDS);
	if (value.mode !== "full" && value.mode !== "read_only") refuse();
	return Object.freeze({
		accountId: id(value.accountId),
		generation: integer(value.generation, 1),
		pluginInstanceId: id(value.pluginInstanceId),
		ownerEpoch: integer(value.ownerEpoch),
		mode: value.mode,
	});
}
function selection(input: EmailReplySourceSelection): EmailReplySourceSelection {
	const value = draftRecord(input, ["account", "messageId"]);
	return Object.freeze({ account: account(value.account), messageId: id(value.messageId) });
}
function anchor(input: unknown): EmailReplySourceAnchor {
	const value = draftRecord(input, SOURCE_FIELDS);
	const raw = draftRecord(value.raw, ["ref"]);
	const checkpoint = draftRecord(value.sourceCheckpoint, ["cursor", "revision"]);
	return immutableDraftData({
		account: account(value.account),
		messageId: id(value.messageId),
		providerId: text(value.providerId, 256),
		threadId: text(value.threadId, 256),
		conversationId: id(value.conversationId),
		raw: { ref: id(raw.ref) },
		rawSha256: sha(value.rawSha256),
		rawBytes: integer(value.rawBytes, 1),
		sourceCheckpoint: {
			cursor: text(checkpoint.cursor, 4096),
			revision: integer(checkpoint.revision, 1),
		},
		mailSha256: sha(value.mailSha256),
	});
}
function payload(input: unknown): Payload {
	const value = draftRecord(input, [
		"version",
		"binding",
		"initialRev",
		"initialRevisionSha256",
		"source",
	]);
	if (value.version !== 1 || value.initialRev !== 1) refuse();
	const bound = emailBinding(value.binding as DraftBinding);
	const source = anchor(value.source);
	if (
		bound.accountId !== source.account.accountId ||
		bound.conversationId !== source.conversationId
	)
		refuse();
	return immutableDraftData({
		version: 1,
		binding: bound,
		initialRev: 1,
		initialRevisionSha256: sha(value.initialRevisionSha256),
		source,
	});
}
function sameBinding(left: DraftBinding, right: DraftBinding): boolean {
	return BINDING_FIELDS.every((field) => Reflect.get(left, field) === Reflect.get(right, field));
}

/**
 * Immutable email reply-source DATA tied to the original native store transaction.
 * The caller still owns envelope/flags/authorization and must register the migration namespace.
 * No incoming chat producer or verified MAIL/class/approval authority is supplied here.
 */
export class NativeReplySourceStore {
	readonly #database: WorkDatabase;
	readonly #store: HubStore;
	readonly #revisions: NativeDraftRevisions;
	readonly #parsed: NativeParsedStore;
	#key: Buffer | undefined;
	constructor(
		database: WorkDatabase,
		store: HubStore,
		revisions: NativeDraftRevisions,
		parsed: NativeParsedStore,
		masterKey: MasterKey,
	) {
		this.#database = database;
		this.#store = store;
		this.#revisions = revisions;
		this.#parsed = parsed;
		let derived: Buffer | undefined;
		try {
			original.assertStoreKey.call(store, masterKey);
			original.assertRevisionStore.call(revisions, store);
			derived = original.derive.call(masterKey, "drafts");
			if (derived.length !== 32) refuse();
			this.#key = derived;
		} catch {
			derived?.fill(0);
			throw new ReplySourceError();
		}
	}
	#live(): Buffer {
		if (!this.#key) refuse();
		return this.#key;
	}
	#work<T>(scope: WorkScope, work: (tx: SqlTransaction) => T): T {
		try {
			this.#live();
			const tx = original.sql.call(this.#database, scope);
			assertStoreTransaction(this.#store, tx);
			original.assertRevisionTransaction.call(this.#revisions, tx);
			return work(tx);
		} catch {
			try {
				original.abort.call(this.#database, scope);
			} catch {
				/* A foreign or retired scope cannot be adopted or repaired. */
			}
			throw new ReplySourceError();
		}
	}
	#mac(bytes: string): Buffer {
		return createHmac("sha256", this.#live()).update(MAC_DOMAIN).update(bytes, "utf8").digest();
	}
	#source(scope: WorkScope, chosen: EmailReplySourceSelection): EmailReplySourceAnchor {
		const record: NativeParsedRecord | undefined = original.readParsed.call(
			this.#parsed,
			scope,
			chosen.account,
			chosen.messageId,
		);
		if (
			!record ||
			record.association !== "unverified" ||
			record.messageId !== chosen.messageId ||
			record.mail.direction !== "inbound"
		)
			refuse();
		return anchor({
			account: chosen.account,
			messageId: record.messageId,
			providerId: record.providerId,
			threadId: record.threadId,
			conversationId: record.conversationId,
			raw: record.raw,
			rawSha256: record.rawSha256,
			rawBytes: record.rawBytes,
			sourceCheckpoint: record.sourceCheckpoint,
			mailSha256: jcsSha256(record.mail),
		});
	}
	#stored(tx: SqlTransaction, bound: DraftBinding): Payload {
		const row = tx.get<StoredAssociation>(
			`SELECT initial_rev AS initialRev,
 CASE WHEN typeof(payload)='text' AND length(CAST(payload AS BLOB)) BETWEEN 1 AND ${MAX_PAYLOAD_BYTES} THEN payload END AS payload,
 CASE WHEN typeof(mac)='text' AND length(CAST(mac AS BLOB))=64 THEN mac END AS mac
 FROM main.native_reply_sources WHERE draft_id=?`,
			[bound.draftId],
		);
		if (!row || row.initialRev !== 1 || row.payload === null || row.mac === null) refuse();
		const supplied = Buffer.from(sha(row.mac), "hex");
		const expected = this.#mac(row.payload);
		try {
			if (!timingSafeEqual(supplied, expected)) refuse();
		} finally {
			supplied.fill(0);
			expected.fill(0);
		}
		const captured = payload(JSON.parse(row.payload));
		if (canonicalize(captured) !== row.payload || !sameBinding(captured.binding, bound)) refuse();
		return captured;
	}
	#read(scope: WorkScope, tx: SqlTransaction, bound: DraftBinding): ReplySourceAssociation {
		const stored = this.#stored(tx, bound);
		const current = original.current.call(this.#revisions, tx, bound);
		if (
			current.channel !== "email" ||
			current.draft.id !== bound.draftId ||
			current.revision.draftId !== bound.draftId ||
			current.draft.rev !== current.revision.rev ||
			current.revision.rev < 1 ||
			(current.revision.rev === 1 && jcsSha256(current.revision) !== stored.initialRevisionSha256)
		)
			refuse();
		const live = this.#source(scope, {
			account: stored.source.account,
			messageId: stored.source.messageId,
		});
		if (canonicalize(live) !== canonicalize(stored.source)) refuse();
		return immutableDraftData({
			binding: stored.binding,
			initialRev: 1,
			initialRevisionSha256: stored.initialRevisionSha256,
			currentRev: current.revision.rev,
			source: stored.source,
			association: "unverified",
		});
	}
	/** Creates the initial revision and its original source link in this exact live scope/tx. */
	create(
		scope: WorkScope,
		input: DraftCreation,
		selected: EmailReplySourceSelection,
	): ReplySourceAssociation {
		return this.#work(scope, (tx) => {
			const captured = draftRecord(input, CREATION_FIELDS);
			const bound = emailBinding({
				draftId: captured.draftId as string,
				accountId: captured.accountId as string,
				conversationId: captured.conversationId as string | null,
				channel: captured.channel as DraftBinding["channel"],
			});
			const chosen = selection(selected);
			if (chosen.account.accountId !== bound.accountId) refuse();
			const source = this.#source(scope, chosen);
			if (source.conversationId !== bound.conversationId) refuse();
			const created: NativeRevision = original.create.call(
				this.#revisions,
				tx,
				captured as unknown as DraftCreation,
			);
			if (
				created.channel !== "email" ||
				created.draft.id !== bound.draftId ||
				created.revision.draftId !== bound.draftId ||
				created.draft.rev !== 1 ||
				created.revision.rev !== 1
			)
				refuse();
			const value = payload({
				version: 1,
				binding: bound,
				initialRev: 1,
				initialRevisionSha256: jcsSha256(created.revision),
				source,
			});
			const bytes = canonicalize(value);
			if (Buffer.byteLength(bytes, "utf8") > MAX_PAYLOAD_BYTES) refuse();
			const macBytes = this.#mac(bytes);
			try {
				if (
					tx.run(
						"INSERT INTO main.native_reply_sources(draft_id,initial_rev,payload,mac) VALUES(?,1,?,?)",
						[bound.draftId, bytes, macBytes.toString("hex")],
					).changes !== 1
				)
					refuse();
			} finally {
				macBytes.fill(0);
			}
			// Re-read after the final write as well: a late trigger/error cannot leave a ready link.
			const result = this.#read(scope, tx, bound);
			if (result.currentRev !== 1) refuse();
			return result;
		});
	}
	/** Revalidates the stored original ID/anchor; never selects a newer message or checkpoint. */
	read(scope: WorkScope, input: DraftBinding): ReplySourceAssociation {
		return this.#work(scope, (tx) => this.#read(scope, tx, emailBinding(input)));
	}
	/** Terminal and idempotent; destroys only this service's derived key. */
	destroy(): void {
		const key = this.#key;
		this.#key = undefined;
		key?.fill(0);
	}
}
