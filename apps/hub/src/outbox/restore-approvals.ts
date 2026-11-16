import { createHmac, timingSafeEqual } from "node:crypto";
import { types } from "node:util";
import { DataClass } from "@draftyak/protocol/data-class";
import { canonicalize } from "@draftyak/protocol/jcs";
import { Sha256Hex, Ulid } from "@draftyak/protocol/scalars";
import { AuditChain } from "../audit/chain.ts";
import { appendOutboxRestoreChangedInTransaction, EventLog } from "../events/log.ts";
import { WorkDatabase } from "../jobs/database.ts";
import { type Clock, systemClock } from "../kernel/clock.ts";
import { newId } from "../kernel/ids.ts";
import { MasterKey } from "../kernel/master-key.ts";
import { readStamp } from "../store/read-stamp.ts";
import { HubStore, type SqlReader, type SqlTransaction } from "../store/store.ts";

export class ApprovalRestoreError extends Error {
	readonly code = "APPROVAL_RESTORE_UNAVAILABLE";
	constructor() {
		super("Approval restore unavailable");
		this.name = "ApprovalRestoreError";
	}
}
const refused: () => never = () => {
	throw new ApprovalRestoreError();
};
interface Row {
	id: string;
	outbox_id: string;
	account_id: string;
	data_class: string;
	challenge_id: string;
	device_id: string;
	user_id: string;
	content_hash: string;
	flags_hash: string;
	epoch: number;
	target_version: number;
	iat: number;
	not_before: number | null;
	deliver_by: number;
	accepted_at: number;
	consumed_at: number | null;
	voided_at: number | null;
	void_reason: string | null;
	audit_seq: number;
	audit_mac: string;
	mac: string;
}
const text = {
	id: 26,
	outbox_id: 26,
	account_id: 26,
	data_class: 64,
	challenge_id: 26,
	device_id: 26,
	user_id: 26,
	content_hash: 64,
	flags_hash: 64,
	void_reason: 32,
	audit_mac: 64,
	mac: 64,
} as const;
const numbers = [
	"epoch",
	"target_version",
	"iat",
	"not_before",
	"deliver_by",
	"accepted_at",
	"consumed_at",
	"voided_at",
	"audit_seq",
] as const;
const projection = [
	...Object.entries(text).map(
		([name, max]) =>
			`CASE WHEN ${name} IS NULL OR (typeof(${name})='text' AND length(CAST(${name} AS BLOB))<=${max}) THEN ${name} ELSE '!' END AS ${name}`,
	),
	...numbers.map(
		(name) =>
			`CASE WHEN ${name} IS NULL OR (typeof(${name})='integer' AND ${name} BETWEEN 0 AND 9007199254740991) THEN ${name} ELSE -1 END AS ${name}`,
	),
].join(",");
const fields = [...Object.keys(text), ...numbers] as readonly (keyof Row)[];
const reasons = new Set([
	"missed",
	"new_reply",
	"channel_changed",
	"approver_revoked",
	"credential_lost",
	"plugin_quarantined",
	"policy",
	"restored",
	"not_found",
]);
const apply = Reflect.apply;
const assertKey = HubStore.prototype.assertMasterKey;
const read = HubStore.prototype.read;
const assertTransaction = WorkDatabase.prototype.assertTransaction;
const verify = AuditChain.prototype.verify;
const append = AuditChain.prototype.append;
const derive = MasterKey.prototype.derive;
const owners = new WeakMap<NativeApprovalRestore, HubStore>();
const integer = (n: unknown): n is number =>
	typeof n === "number" && Number.isSafeInteger(n) && n >= 0;

/** Restricts authenticated stored DATA only; never creates an approval or verifier proof. */
export class NativeApprovalRestore {
	readonly #store: HubStore;
	readonly #audit: AuditChain;
	#key: MasterKey | undefined;
	readonly #database: WorkDatabase;
	readonly #events: EventLog;
	readonly #owner: object;
	readonly #clock: Clock;
	constructor(store: HubStore, audit: AuditChain, key: MasterKey, clock: Clock = systemClock) {
		try {
			if ([store, audit, key, clock].some(types.isProxy)) refused();
			apply(assertKey, store, [key]);
			const owner = apply(read, store, [
				(db: SqlReader) => {
					apply(verify, audit, [db]);
					return readStamp(db)?.owner;
				},
			]);
			if (owner === null || typeof owner !== "object") refused();
			this.#owner = owner;
			this.#store = store;
			this.#audit = audit;
			this.#key = key;
			this.#clock = clock;
			this.#database = new WorkDatabase(store);
			this.#events = new EventLog(this.#database, () => this.#now());
			owners.set(this, store);
		} catch {
			throw new ApprovalRestoreError();
		}
	}
	#reader(tx: SqlTransaction): void {
		if (!this.#key || owners.get(this) !== this.#store) refused();
		apply(assertKey, this.#store, [this.#key]);
		apply(assertTransaction, this.#database, [tx]);
		if (readStamp(tx)?.owner !== this.#owner) refused();
		apply(verify, this.#audit, [tx]);
	}
	#now(): number {
		const at = this.#clock.wallMs();
		return integer(at) ? at : refused();
	}
	#mac(row: Omit<Row, "mac">): string {
		const key = apply(derive, this.#key ?? refused(), ["approvals"]) as Buffer;
		try {
			return createHmac("sha256", key)
				.update("draftyak/native-approval/v1\n")
				.update(canonicalize(row))
				.digest("hex");
		} finally {
			key.fill(0);
		}
	}
	#check(tx: SqlTransaction, row: Row): void {
		const { mac, ...facts } = row;
		if (
			![row.id, row.outbox_id, row.account_id, row.challenge_id, row.device_id, row.user_id].every(
				(id) => Ulid.safeParse(id).success,
			) ||
			![row.content_hash, row.flags_hash, row.audit_mac, mac].every(
				(hash) => Sha256Hex.safeParse(hash).success,
			) ||
			!DataClass.safeParse(row.data_class).success ||
			![
				row.epoch,
				row.target_version,
				row.iat,
				row.deliver_by,
				row.accepted_at,
				row.audit_seq,
			].every(integer) ||
			row.target_version < 1 ||
			row.audit_seq < 1 ||
			row.deliver_by < row.iat ||
			row.accepted_at < row.iat ||
			![row.not_before, row.consumed_at, row.voided_at].every((n) => n === null || integer(n)) ||
			(row.not_before !== null && row.not_before > row.deliver_by) ||
			(row.consumed_at !== null && row.consumed_at < row.accepted_at) ||
			(row.voided_at !== null && row.voided_at < row.accepted_at) ||
			(row.voided_at === null) !== (row.void_reason === null) ||
			(row.void_reason !== null && !reasons.has(row.void_reason)) ||
			(row.consumed_at !== null && row.voided_at !== null) ||
			!timingSafeEqual(Buffer.from(mac, "hex"), Buffer.from(this.#mac(facts), "hex"))
		)
			refused();
		const latest = tx.get<{ seq: number; mac: string; refs: string }>(
			`SELECT seq,CASE WHEN typeof(mac)='text' AND length(CAST(mac AS BLOB))=64 THEN mac END AS mac,
 CASE WHEN typeof(refs)='text' AND length(CAST(refs AS BLOB))<=4096 THEN refs END AS refs
 FROM main.audit_events WHERE action IN ('approval.accepted','approval.lapsed')
 AND json_extract(refs,'$.approval')=? ORDER BY seq DESC LIMIT 1`,
			[row.id],
		);
		if (
			!latest ||
			latest.seq !== row.audit_seq ||
			latest.mac !== row.audit_mac ||
			latest.refs !== canonicalize({ approval: row.id, outbox: row.outbox_id })
		)
			refused();
	}
	#one(tx: SqlTransaction, old: Row, capturedAt: number): void {
		this.#reader(tx);
		const at = Math.max(capturedAt, old.accepted_at);
		apply(append, this.#audit, [
			tx,
			{
				id: newId(at),
				at,
				action: "approval.lapsed",
				actor: { kind: "hub", id: null },
				refs: { approval: old.id, outbox: old.outbox_id },
			},
		]);
		const head = tx.get<{ audit_seq: number; audit_mac: string }>(
			"SELECT audit_seq,audit_head AS audit_mac FROM main.audit_meta WHERE singleton=1",
		);
		if (!head || !integer(head.audit_seq) || !Sha256Hex.safeParse(head.audit_mac).success)
			refused();
		const { mac: _, ...before } = old;
		const facts = { ...before, voided_at: at, void_reason: "restored", ...head };
		const value = { ...facts, mac: this.#mac(facts) };
		this.#reader(tx);
		if (
			tx.run(
				`UPDATE main.approvals SET voided_at=?,void_reason=?,audit_seq=?,audit_mac=?,mac=?
 WHERE ${fields.map((field) => `${field} IS ?`).join(" AND ")}`,
				[
					at,
					"restored",
					head.audit_seq,
					head.audit_mac,
					value.mac,
					...fields.map((field) => old[field]),
				],
			).changes !== 1
		)
			refused();
		appendOutboxRestoreChangedInTransaction(this.#events, tx, {
			userId: old.user_id,
			accountId: old.account_id,
			dataClass: old.data_class,
			outboxId: old.outbox_id,
		});
		this.#reader(tx);
		const saved =
			tx.get<Row>(`SELECT ${projection} FROM main.approvals WHERE id=?`, [old.id]) ?? refused();
		this.#check(tx, saved);
		if (canonicalize(saved) !== canonicalize(value)) refused();
	}
	/** The fixed receiver must propagate failure through its entire original Store.write. */
	resetInTransaction(tx: SqlTransaction): number {
		try {
			this.#reader(tx);
			const at = this.#now();
			this.#reader(tx);
			let after = "",
				changed = 0;
			for (;;) {
				this.#reader(tx);
				const rows = tx.all<{ id: string }>(
					`SELECT
 CASE WHEN typeof(id)='text' AND length(CAST(id AS BLOB))=26 THEN id END AS id FROM main.approvals
 WHERE id COLLATE BINARY>? ORDER BY id COLLATE BINARY LIMIT 128`,
					[after],
				);
				if (rows.length > 128) refused();
				for (const selected of rows) {
					if (!Ulid.safeParse(selected.id).success || selected.id <= after) refused();
					const row =
						tx.get<Row>(`SELECT ${projection} FROM main.approvals WHERE id=?`, [selected.id]) ??
						refused();
					this.#check(tx, row);
					if (row.id <= after) refused();
					if (row.consumed_at === null && row.voided_at === null) {
						this.#one(tx, row, at);
						if (!Number.isSafeInteger(++changed)) refused();
					}
					after = row.id;
				}
				if (rows.length < 128) break;
			}
			this.#reader(tx);
			// An Event clock may have inserted a live row after a short page was captured.
			if (
				tx.get(
					"SELECT 1 AS present FROM main.approvals WHERE consumed_at IS NULL AND voided_at IS NULL LIMIT 1",
				)
			)
				refused();
			return changed;
		} catch {
			throw new ApprovalRestoreError();
		}
	}
	/** Releases this wrapper only. The original MasterKey remains owned by its caller. */
	destroy(): void {
		owners.delete(this);
		this.#key = undefined;
	}
}
const reset = NativeApprovalRestore.prototype.resetInTransaction;
export function resetNativeApprovalStorageForRestoreInTransaction(
	target: unknown,
	tx: SqlTransaction,
): number {
	if (
		target === null ||
		typeof target !== "object" ||
		types.isProxy(target) ||
		!owners.has(target as NativeApprovalRestore)
	)
		refused();
	return apply(reset, target, [tx]);
}
