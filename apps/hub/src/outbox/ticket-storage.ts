import { createHmac, timingSafeEqual } from "node:crypto";
import { types } from "node:util";
import { type HeaderList, headersSha256, sha256Hex } from "@draftyak/protocol/hash";
import { canonicalize } from "@draftyak/protocol/jcs";
import { Sha256Hex, Ulid, UtcMs } from "@draftyak/protocol/scalars";
import { SendTicket, sendTicketExp } from "@draftyak/protocol/send-ticket";
import { AuditChain } from "../audit/chain.ts";
import { type CredentialBinding, CredentialVault } from "../credentials/vault.ts";
import type { Clock } from "../kernel/clock.ts";
import { newId } from "../kernel/ids.ts";
import { MasterKey } from "../kernel/master-key.ts";
import {
	assertStoreTransaction,
	HubStore,
	type SqlReader,
	type SqlTransaction,
} from "../store/store.ts";

export const MAX_SEND_BODY_BYTES = 33_554_432;
export type SendAttemptState =
	| "ISSUED"
	| "REDEEMED"
	| "SENDING"
	| "SENT"
	| "FAILED"
	| "UNKNOWN"
	| "NEEDS_REAPPROVAL"
	| "EXPIRED";
export interface StoredSendBinding {
	readonly accountId: string;
	readonly credentialReference: string;
	readonly credentialGeneration: number;
	readonly credentialKind: "gmail-oauth" | "slack-token";
	readonly epoch: number;
	readonly contentHash: string;
	readonly flagsHash: string;
	readonly notBefore: number | null;
	readonly deliverBy: number;
}
export interface RenderedSend {
	readonly method: SendTicket["method"];
	readonly url: string;
	readonly contentType: string;
	readonly headers: HeaderList;
	readonly body: Uint8Array;
}
/** Internal persistence inputs, never evidence of approval, device rights, or account ownership. */
export interface SendTicketInsert extends StoredSendBinding, RenderedSend {
	readonly outboxId: string;
	readonly instanceId: string;
	readonly approvedHeadersSha256: string;
	readonly approvedBodySha256: string;
}
export interface SendAttempt {
	readonly id: string;
	readonly outboxId: string;
	readonly ticketId: string;
	readonly state: SendAttemptState;
	readonly updatedAt: number;
}
interface Payload extends StoredSendBinding {
	readonly ticket: SendTicket;
	readonly headers: HeaderList;
	readonly issuedAt: number;
	readonly issuedMonotonic: number;
}
export interface StoredAttempt {
	readonly id: string;
	readonly outbox_id: string;
	readonly ticket_id: string;
	readonly payload: string;
	readonly body: Uint8Array;
	readonly state: SendAttemptState;
	readonly updated_at: number;
	readonly audit_seq: number;
	readonly mac: string;
}
export class SendTicketError extends Error {
	readonly code = "SEND_TICKET_UNAVAILABLE";
	constructor() {
		super("Send ticket unavailable");
	}
}
export const unavailable = (): SendTicketError => new SendTicketError();
const typedArrayPrototype = Object.getPrototypeOf(Uint8Array.prototype);
const byteLength = Object.getOwnPropertyDescriptor(typedArrayPrototype, "byteLength")?.get;
const arrayBuffer = Object.getOwnPropertyDescriptor(typedArrayPrototype, "buffer")?.get;
const byteOffset = Object.getOwnPropertyDescriptor(typedArrayPrototype, "byteOffset")?.get;
const readStore = HubStore.prototype.read,
	writeStore = HubStore.prototype.write;
const appendAudit = AuditChain.prototype.append,
	verifyAudit = AuditChain.prototype.verify;
const describeCredential = CredentialVault.prototype.describeInTransaction;
const derive = MasterKey.prototype.derive;
const states: readonly string[] = [
	"ISSUED",
	"REDEEMED",
	"SENDING",
	"SENT",
	"FAILED",
	"UNKNOWN",
	"NEEDS_REAPPROVAL",
	"EXPIRED",
];
const SELECT = `SELECT
 CASE WHEN typeof(id)='text' AND length(CAST(id AS BLOB))=26 THEN id ELSE NULL END AS id,
 CASE WHEN typeof(outbox_id)='text' AND length(CAST(outbox_id AS BLOB))=26 THEN outbox_id ELSE NULL END AS outbox_id,
 CASE WHEN typeof(ticket_id)='text' AND length(CAST(ticket_id AS BLOB))=26 THEN ticket_id ELSE NULL END AS ticket_id,
 CASE WHEN typeof(payload)='text' AND length(CAST(payload AS BLOB)) BETWEEN 1 AND 32768 THEN payload ELSE NULL END AS payload,
 CASE WHEN typeof(body)='blob' AND length(body)<=33554432 THEN body ELSE NULL END AS body,
 CASE WHEN typeof(state)='text' AND length(CAST(state AS BLOB))<=20 THEN state ELSE NULL END AS state,
 updated_at,audit_seq,
 CASE WHEN typeof(mac)='text' AND length(CAST(mac AS BLOB))=64 THEN mac ELSE NULL END AS mac
 FROM main.native_send_attempts`;
export function dataRecord(input: unknown, keys: readonly string[]): Record<string, unknown> {
	if (
		!input ||
		typeof input !== "object" ||
		types.isProxy(input) ||
		![Object.prototype, null].includes(Object.getPrototypeOf(input)) ||
		Reflect.ownKeys(input).length !== keys.length
	)
		throw unavailable();
	const result: Record<string, unknown> = Object.create(null);
	for (const key of keys) {
		const descriptor = Object.getOwnPropertyDescriptor(input, key);
		if (!descriptor || !("value" in descriptor)) throw unavailable();
		result[key] = descriptor.value;
	}
	return result;
}
export function copyBody(input: unknown): Uint8Array {
	if (!types.isUint8Array(input) || types.isProxy(input)) throw unavailable();
	const size = byteLength?.call(input),
		buffer = arrayBuffer?.call(input),
		offset = byteOffset?.call(input);
	if (!Number.isSafeInteger(size) || size > MAX_SEND_BODY_BYTES || !types.isArrayBuffer(buffer))
		throw unavailable();
	const owned = Buffer.alloc(size);
	owned.set(new Uint8Array(buffer, offset, size));
	return owned;
}
export function copyHeaders(input: unknown): HeaderList {
	if (!Array.isArray(input) || types.isProxy(input) || input.length !== 1) throw unavailable();
	const item = Object.getOwnPropertyDescriptor(input, "0");
	if (
		!item ||
		!("value" in item) ||
		!Array.isArray(item.value) ||
		types.isProxy(item.value) ||
		item.value.length !== 2
	)
		throw unavailable();
	const name = Object.getOwnPropertyDescriptor(item.value, "0"),
		value = Object.getOwnPropertyDescriptor(item.value, "1");
	if (
		!name ||
		!("value" in name) ||
		typeof name.value !== "string" ||
		name.value.toLowerCase() !== "content-type" ||
		!value ||
		!("value" in value) ||
		typeof value.value !== "string" ||
		value.value.length > 256
	)
		throw unavailable();
	const headers: HeaderList = Object.freeze([
		Object.freeze(["content-type", value.value] as const),
	]);
	headersSha256(headers);
	return headers;
}
const bindingKeys = [
	"accountId",
	"credentialReference",
	"credentialGeneration",
	"credentialKind",
	"epoch",
	"contentHash",
	"flagsHash",
	"notBefore",
	"deliverBy",
] as const;
function binding(input: Record<string, unknown>): StoredSendBinding {
	if (
		!Ulid.safeParse(input.accountId).success ||
		!Ulid.safeParse(input.credentialReference).success ||
		!Number.isSafeInteger(input.credentialGeneration) ||
		Number(input.credentialGeneration) < 1 ||
		!["gmail-oauth", "slack-token"].includes(input.credentialKind as string) ||
		!Number.isSafeInteger(input.epoch) ||
		Number(input.epoch) < 0 ||
		!Sha256Hex.safeParse(input.contentHash).success ||
		!Sha256Hex.safeParse(input.flagsHash).success ||
		(input.notBefore !== null && !UtcMs.safeParse(input.notBefore).success) ||
		!UtcMs.safeParse(input.deliverBy).success ||
		(input.notBefore !== null && Number(input.notBefore) >= Number(input.deliverBy))
	)
		throw unavailable();
	return Object.freeze(
		Object.fromEntries(bindingKeys.map((key) => [key, input[key]])),
	) as unknown as StoredSendBinding;
}
export function credentialOwner(payload: StoredSendBinding): CredentialBinding {
	return { ownerKind: "account", ownerId: payload.accountId, kind: payload.credentialKind };
}
export function attemptView(row: StoredAttempt): SendAttempt {
	return Object.freeze({
		id: row.id,
		outboxId: row.outbox_id,
		ticketId: row.ticket_id,
		state: row.state,
		updatedAt: row.updated_at,
	});
}
/**
 * Internal encrypted transaction kernel. This module deliberately has no public authorization
 * or mint entry point. A native verifier must consume its genuine current approval and revision
 * handles in the SAME transaction before calling insertInTransaction.
 */
export class SendTicketStorage {
	readonly #store: HubStore;
	readonly #audit: AuditChain;
	readonly #vault: CredentialVault;
	readonly #clock: Clock;
	readonly #key: Buffer;
	#destroyed = false;
	constructor(
		store: HubStore,
		audit: AuditChain,
		vault: CredentialVault,
		masterKey: MasterKey,
		clock: Clock,
	) {
		let key: Buffer | undefined;
		try {
			if ([store, audit, vault, masterKey, clock].some(types.isProxy)) throw unavailable();
			HubStore.prototype.assertMasterKey.call(store, masterKey);
			key = derive.call(masterKey, "handles");
			readStore.call(store, (db: SqlReader) => {
				db.get("SELECT id FROM main.native_send_attempts LIMIT 1");
				verifyAudit.call(audit, db);
			});
		} catch {
			key?.fill(0);
			throw unavailable();
		}
		this.#store = store;
		this.#audit = audit;
		this.#vault = vault;
		this.#clock = clock;
		this.#key = key;
	}
	now(): number {
		if (this.#destroyed) throw unavailable();
		const now = this.#clock.wallMs();
		if (!UtcMs.safeParse(now).success) throw unavailable();
		return now;
	}
	monotonic(): number {
		const now = this.#clock.monotonicMs();
		if (this.#destroyed || !Number.isFinite(now) || now < 0) throw unavailable();
		return now;
	}
	#mac(row: Omit<StoredAttempt, "mac">): string {
		if (this.#destroyed) throw unavailable();
		const { body, ...rest } = row;
		return createHmac("sha256", this.#key)
			.update("draftyak/send-ticket/v1\n")
			.update(canonicalize({ ...rest, bodySha256: sha256Hex(body) }))
			.digest("hex");
	}
	#refs(row: Pick<StoredAttempt, "id" | "outbox_id" | "ticket_id">): string {
		return canonicalize({ attempt: row.id, outbox: row.outbox_id, ticket: row.ticket_id });
	}
	#valid(tx: SqlReader, row: StoredAttempt): void {
		if (
			!Ulid.safeParse(row.id).success ||
			!Ulid.safeParse(row.outbox_id).success ||
			!Ulid.safeParse(row.ticket_id).success ||
			typeof row.payload !== "string" ||
			!types.isUint8Array(row.body) ||
			!states.includes(row.state) ||
			!UtcMs.safeParse(row.updated_at).success ||
			!Number.isSafeInteger(row.audit_seq) ||
			row.audit_seq < 1 ||
			!Sha256Hex.safeParse(row.mac).success
		)
			throw unavailable();
		const { mac, ...rest } = row;
		if (!timingSafeEqual(Buffer.from(mac, "hex"), Buffer.from(this.#mac(rest), "hex")))
			throw unavailable();
		const latest = tx.get<{ seq: number; action: string }>(
			"SELECT seq,action FROM main.audit_events WHERE refs=? ORDER BY seq DESC LIMIT 1",
			[this.#refs(row)],
		);
		if (
			!latest ||
			latest.seq !== row.audit_seq ||
			latest.action !== `send.${row.state.toLowerCase()}`
		)
			throw unavailable();
		this.payload(row);
	}
	payload(row: StoredAttempt): Payload {
		const parsed = dataRecord(JSON.parse(row.payload), [
			...bindingKeys,
			"ticket",
			"headers",
			"issuedAt",
			"issuedMonotonic",
		]);
		const bound = binding(parsed),
			ticket = SendTicket.parse(parsed.ticket),
			headers = copyHeaders(parsed.headers);
		if (
			canonicalize(parsed) !== row.payload ||
			ticket.id !== row.ticket_id ||
			ticket.outboxId !== row.outbox_id ||
			!UtcMs.safeParse(parsed.issuedAt).success ||
			typeof parsed.issuedMonotonic !== "number" ||
			!Number.isFinite(parsed.issuedMonotonic) ||
			parsed.issuedMonotonic < 0 ||
			ticket.exp !== sendTicketExp(Number(parsed.issuedAt), bound.deliverBy) ||
			ticket.headersSha256 !== headersSha256(headers) ||
			ticket.contentType !== headers[0]?.[1] ||
			ticket.bodySha256 !== sha256Hex(row.body)
		)
			throw unavailable();
		return {
			...bound,
			ticket,
			headers,
			issuedAt: Number(parsed.issuedAt),
			issuedMonotonic: Number(parsed.issuedMonotonic),
		};
	}
	assertCredential(tx: SqlTransaction, payload: StoredSendBinding): void {
		if (
			describeCredential.call(
				this.#vault,
				tx,
				payload.credentialReference,
				credentialOwner(payload),
			).generation !== payload.credentialGeneration
		)
			throw unavailable();
	}
	read<T>(work: (tx: SqlReader) => T): T {
		if (this.#destroyed) throw unavailable();
		return readStore.call(this.#store, (tx: SqlReader) => {
			verifyAudit.call(this.#audit, tx);
			return work(tx);
		}) as T;
	}
	write<T>(work: (tx: SqlTransaction) => T): T {
		if (this.#destroyed) throw unavailable();
		return writeStore.call(this.#store, (tx: SqlTransaction) => {
			verifyAudit.call(this.#audit, tx);
			return work(tx);
		}) as T;
	}
	find(
		tx: SqlReader,
		column: "id" | "outbox_id" | "ticket_id",
		id: string,
	): StoredAttempt | undefined {
		if (!Ulid.safeParse(id).success) throw unavailable();
		const row = tx.get<StoredAttempt>(`${SELECT} WHERE ${column}=?`, [id]);
		if (row) this.#valid(tx, row);
		return row;
	}
	transition(tx: SqlTransaction, row: StoredAttempt, state: SendAttemptState): StoredAttempt {
		assertStoreTransaction(this.#store, tx);
		this.#valid(tx, row);
		const updatedAt = this.now();
		const allowed: Partial<Record<SendAttemptState, readonly SendAttemptState[]>> = {
			ISSUED: ["REDEEMED", "NEEDS_REAPPROVAL", "EXPIRED"],
			REDEEMED: ["SENDING", "NEEDS_REAPPROVAL"],
			SENDING: ["SENT", "FAILED", "UNKNOWN"],
		};
		if (updatedAt < row.updated_at || !allowed[row.state]?.includes(state)) throw unavailable();
		return this.#save(tx, { ...row, state, updated_at: updatedAt }, false);
	}
	#save(
		tx: SqlTransaction,
		row: Omit<StoredAttempt, "mac" | "audit_seq">,
		insert: boolean,
	): StoredAttempt {
		appendAudit.call(this.#audit, tx, {
			id: newId(row.updated_at),
			at: row.updated_at,
			action: `send.${row.state.toLowerCase()}`,
			actor: { kind: "hub", id: null },
			refs: JSON.parse(this.#refs(row)),
		});
		const seq = tx.get<{ audit_seq: number }>(
			"SELECT audit_seq FROM main.audit_meta WHERE singleton=1",
		)?.audit_seq;
		if (!seq || !Number.isSafeInteger(seq)) throw unavailable();
		const base = {
				id: row.id,
				outbox_id: row.outbox_id,
				ticket_id: row.ticket_id,
				payload: row.payload,
				body: row.body,
				state: row.state,
				updated_at: row.updated_at,
				audit_seq: seq,
			},
			saved = { ...base, mac: this.#mac(base) };
		if (insert)
			tx.run(
				"INSERT INTO main.native_send_attempts(id,outbox_id,ticket_id,payload,body,state,updated_at,audit_seq,mac) VALUES(?,?,?,?,?,?,?,?,?)",
				[
					saved.id,
					saved.outbox_id,
					saved.ticket_id,
					saved.payload,
					saved.body,
					saved.state,
					saved.updated_at,
					saved.audit_seq,
					saved.mac,
				],
			);
		else if (
			tx.run(
				"UPDATE main.native_send_attempts SET state=?,updated_at=?,audit_seq=?,mac=? WHERE id=?",
				[saved.state, saved.updated_at, saved.audit_seq, saved.mac, saved.id],
			).changes !== 1
		)
			throw unavailable();
		return saved;
	}
	insertInTransaction(tx: SqlTransaction, input: SendTicketInsert): SendTicket {
		try {
			assertStoreTransaction(this.#store, tx);
			verifyAudit.call(this.#audit, tx);
			const data = dataRecord(input, [
					...bindingKeys,
					"outboxId",
					"instanceId",
					"method",
					"url",
					"contentType",
					"headers",
					"body",
					"approvedHeadersSha256",
					"approvedBodySha256",
				]),
				bound = binding(data),
				headers = copyHeaders(data.headers),
				body = copyBody(data.body),
				now = this.now();
			const ticket = SendTicket.parse({
				id: newId(now),
				outboxId: data.outboxId,
				instanceId: data.instanceId,
				method: data.method,
				url: data.url,
				contentType: data.contentType,
				headersSha256: headersSha256(headers),
				bodySha256: sha256Hex(body),
				exp: sendTicketExp(now, bound.deliverBy),
			});
			if (
				now >= bound.deliverBy ||
				(bound.notBefore !== null && now < bound.notBefore) ||
				headers[0]?.[1] !== ticket.contentType ||
				data.approvedHeadersSha256 !== ticket.headersSha256 ||
				data.approvedBodySha256 !== ticket.bodySha256
			)
				throw unavailable();
			this.assertCredential(tx, bound);
			// Retaining the authenticated history prevents deleting a row from enabling a resend.
			if (
				tx.get(
					"SELECT 1 FROM main.audit_events WHERE action LIKE 'send.%' AND json_extract(refs,'$.outbox')=? LIMIT 1",
					[ticket.outboxId],
				)
			)
				throw unavailable();
			const payload = canonicalize({
				...bound,
				ticket,
				headers,
				issuedAt: now,
				issuedMonotonic: this.monotonic(),
			});
			if (Buffer.byteLength(payload) > 32768) throw unavailable();
			this.#save(
				tx,
				{
					id: newId(now),
					outbox_id: ticket.outboxId,
					ticket_id: ticket.id,
					payload,
					body,
					state: "ISSUED",
					updated_at: now,
				},
				true,
			);
			return Object.freeze(ticket);
		} catch {
			throw unavailable();
		}
	}
	destroy(): void {
		this.#destroyed = true;
		this.#key.fill(0);
	}
}
