import { createHmac, timingSafeEqual } from "node:crypto";
import { canonicalize } from "@draftyak/protocol/jcs";
import { Sha256Hex, Ulid } from "@draftyak/protocol/scalars";
import { AuditChain } from "../audit/chain.ts";
import { refuse } from "../identity/challenges-support.ts";
import { newId } from "../kernel/ids.ts";
import { MasterKey } from "../kernel/master-key.ts";
import {
	assertStoreTransaction,
	HubStore,
	type SqlReader,
	type SqlTransaction,
} from "../store/store.ts";
import type { StoredSendApproval, VerifiedSendApprovalFacts } from "./verifier-types.ts";

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
const columns = {
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
];
const projection = [
	...Object.entries(columns).map(
		([name, max]) =>
			`CASE WHEN ${name} IS NULL OR (typeof(${name})='text' AND length(CAST(${name} AS BLOB))<=${max}) THEN ${name} END AS ${name}`,
	),
	...numbers.map(
		(name) =>
			`CASE WHEN ${name} IS NULL OR (typeof(${name})='integer' AND ${name} BETWEEN 0 AND 9007199254740991) THEN ${name} END AS ${name}`,
	),
].join(",");
const derive = MasterKey.prototype.derive,
	verify = AuditChain.prototype.verify,
	append = AuditChain.prototype.append;
const sameMac = (left: string, right: string): boolean =>
	Sha256Hex.safeParse(left).success &&
	timingSafeEqual(Buffer.from(left, "hex"), Buffer.from(right, "hex"));

/** Authenticated approval data. Only the verifier's private proof can turn rows into a tally. */
export class ApprovalRows {
	readonly store: HubStore;
	readonly audit: AuditChain;
	readonly key: MasterKey;
	constructor(store: HubStore, audit: AuditChain, key: MasterKey) {
		HubStore.prototype.assertMasterKey.call(store, key);
		this.store = store;
		this.audit = audit;
		this.key = key;
	}
	#mac(row: Omit<Row, "mac">): string {
		const key = derive.call(this.key, "approvals");
		try {
			return createHmac("sha256", key)
				.update("draftyak/native-approval/v1\n")
				.update(canonicalize(row))
				.digest("hex");
		} finally {
			key.fill(0);
		}
	}
	#check(db: SqlReader, row: Row): void {
		const { mac, ...facts } = row;
		if (
			![row.id, row.outbox_id, row.account_id, row.challenge_id, row.device_id, row.user_id].every(
				(id) => Ulid.safeParse(id).success,
			) ||
			!Sha256Hex.safeParse(row.content_hash).success ||
			!Sha256Hex.safeParse(row.flags_hash).success ||
			typeof row.data_class !== "string" ||
			row.data_class.length < 1 ||
			![
				row.epoch,
				row.iat,
				row.deliver_by,
				row.accepted_at,
				row.audit_seq,
				row.target_version,
			].every((n) => Number.isSafeInteger(n) && n >= 0) ||
			![row.not_before, row.consumed_at, row.voided_at].every(
				(n) => n === null || (Number.isSafeInteger(n) && n >= 0),
			) ||
			!sameMac(mac, this.#mac(facts))
		)
			refuse("UNAVAILABLE");
		const latest = db.get<{ seq: number; mac: string }>(
			`SELECT seq,CASE WHEN typeof(mac)='text' AND length(CAST(mac AS BLOB))=64 THEN mac END AS mac
   FROM main.audit_events WHERE action IN ('approval.accepted','approval.lapsed') AND json_extract(refs,'$.approval')=? ORDER BY seq DESC LIMIT 1`,
			[row.id],
		);
		if (!latest || latest.seq !== row.audit_seq || latest.mac !== row.audit_mac)
			refuse("UNAVAILABLE");
	}
	#audit(
		tx: SqlTransaction,
		at: number,
		action: string,
		device: string,
		approval: string,
		outbox: string,
	): { audit_seq: number; audit_mac: string } {
		append.call(this.audit, tx, {
			id: newId(at),
			at,
			action,
			actor: { kind: "device", id: device },
			refs: { approval, outbox },
		});
		const head = tx.get<{ audit_seq: number; audit_mac: string }>(
			"SELECT audit_seq,audit_head AS audit_mac FROM main.audit_meta WHERE singleton=1",
		);
		return head ?? refuse("UNAVAILABLE");
	}
	#live(db: SqlReader, outbox: string): Row[] {
		assertStoreTransaction(this.store, db as SqlTransaction);
		verify.call(this.audit, db);
		const rows = db.all<Row>(
			`SELECT ${projection} FROM main.approvals WHERE outbox_id=? AND consumed_at IS NULL AND voided_at IS NULL ORDER BY accepted_at,id LIMIT 65`,
			[outbox],
		);
		if (rows.length > 64) refuse("UNAVAILABLE");
		for (const row of rows) this.#check(db, row);
		return rows;
	}
	lapse(tx: SqlTransaction, outbox: string, at: number, undo: number, actor: string): void {
		assertStoreTransaction(this.store, tx);
		for (const old of this.#live(tx, outbox))
			if (old.not_before === null && old.deliver_by < at + undo) {
				const { mac: _, ...oldFacts } = old;
				const facts = {
					...oldFacts,
					voided_at: at,
					void_reason: "missed",
					...this.#audit(tx, at, "approval.lapsed", actor, old.id, outbox),
				};
				if (
					tx.run(
						"UPDATE main.approvals SET voided_at=?,void_reason='missed',audit_seq=?,audit_mac=?,mac=? WHERE id=? AND consumed_at IS NULL AND voided_at IS NULL",
						[at, facts.audit_seq, facts.audit_mac, this.#mac(facts), old.id],
					).changes !== 1
				)
					refuse("STALE");
			}
	}
	insert(
		tx: SqlTransaction,
		approval: VerifiedSendApprovalFacts,
		account: string,
		dataClass: string,
	): void {
		assertStoreTransaction(this.store, tx);
		const facts: Omit<Row, "mac"> = {
			id: approval.approvalId,
			outbox_id: approval.outboxId,
			account_id: account,
			data_class: dataClass,
			challenge_id: approval.challengeId,
			device_id: approval.deviceId,
			user_id: approval.userId,
			content_hash: approval.contentHash,
			flags_hash: approval.flagsHash,
			epoch: approval.epoch,
			target_version: approval.targetVersion,
			iat: approval.iat,
			not_before: approval.notBefore,
			deliver_by: approval.deliverBy,
			accepted_at: approval.approvedAt,
			consumed_at: null,
			voided_at: null,
			void_reason: null,
			...this.#audit(
				tx,
				approval.approvedAt,
				"approval.accepted",
				approval.deviceId,
				approval.approvalId,
				approval.outboxId,
			),
		};
		const names = Object.keys(facts);
		tx.run(
			`INSERT INTO main.approvals(${names.join(",")},mac) VALUES(${names.map(() => "?").join(",")},?)`,
			[...Object.values(facts), this.#mac(facts)],
		);
	}
	current(db: SqlReader, approval: VerifiedSendApprovalFacts): readonly StoredSendApproval[] {
		return Object.freeze(
			this.#live(db, approval.outboxId).map((row) => {
				if (
					row.content_hash !== approval.contentHash ||
					row.flags_hash !== approval.flagsHash ||
					row.epoch !== approval.epoch ||
					row.target_version !== approval.targetVersion
				)
					refuse("STALE");
				return Object.freeze({
					approvalId: row.id,
					userId: row.user_id,
					deviceId: row.device_id,
					iat: row.iat,
					notBefore: row.not_before,
					deliverBy: row.deliver_by,
					approvedAt: row.accepted_at,
				});
			}),
		);
	}
}
