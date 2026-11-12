import { createHmac, timingSafeEqual } from "node:crypto";
import { types } from "node:util";
import { AuditEvent } from "@draftyak/protocol/entities/audit";
import { canonicalize } from "@draftyak/protocol/jcs";
import { type ReadStamp, readStamp, sameReadStamp } from "../store/read-stamp.ts";
import type { SqlReader, SqlTransaction } from "../store/store.ts";
import { auditHeadTag } from "./head.ts";

export type AuditInput = AuditEvent;
interface AuditRow {
	seq: number;
	id: string;
	at: number;
	action: string;
	actor_kind: string;
	actor_id: string | null;
	refs: string;
	previous: string;
	mac: string;
}
interface Head {
	audit_seq: number;
	audit_head: string;
	audit_tag: string;
}
interface Segment {
	readonly stamp: ReadStamp;
	readonly from: number;
	readonly previous: string;
	readonly seq: number;
	readonly mac: string;
}
export interface AuditExportOptions {
	readonly afterSeq?: number;
	readonly limit?: number;
}
export interface AuditExportHead {
	readonly seq: number;
	readonly mac: string;
}
export interface AuditExportPage {
	readonly jsonl: string;
	readonly count: number;
	readonly nextAfterSeq: number | null;
	readonly head: AuditExportHead;
}
export const AUDIT_VERIFY_BATCH_SIZE: number = 128;
export const AUDIT_EXPORT_MAX_EVENTS: number = 1000;
export const AUDIT_EXPORT_MAX_BYTES: number = 2 * 1024 * 1024;
const HASH = /^[0-9a-f]{64}$/;
const matches = (value: unknown): value is string =>
	typeof value === "string" && HASH.exec(value)?.[0] === value;
const HEAD_SQL = [
	"SELECT CASE WHEN typeof(audit_seq)='integer' AND audit_seq BETWEEN 0 AND 9007199254740991 THEN audit_seq ELSE NULL END AS audit_seq,",
	"CASE WHEN typeof(audit_head)='text' AND length(CAST(audit_head AS BLOB))<=64 THEN audit_head ELSE NULL END AS audit_head,",
	"CASE WHEN typeof(audit_tag)='text' AND length(CAST(audit_tag AS BLOB))=64 THEN audit_tag ELSE NULL END AS audit_tag",
	"FROM main.audit_meta WHERE singleton=1",
].join(" ");
// Every variable-width stored field is bounded before crossing into JavaScript.
const ROW_SQL = [
	"SELECT CASE WHEN typeof(seq)='integer' AND seq BETWEEN 1 AND 9007199254740991 THEN seq ELSE NULL END AS seq,",
	"CASE WHEN typeof(id)='text' AND length(CAST(id AS BLOB))=26 THEN id ELSE NULL END AS id,",
	"CASE WHEN typeof(at)='integer' AND at BETWEEN 0 AND 9007199254740991 THEN at ELSE NULL END AS at,",
	"CASE WHEN typeof(action)='text' AND length(CAST(action AS BLOB)) BETWEEN 1 AND 64 THEN action ELSE NULL END AS action,",
	"CASE WHEN typeof(actor_kind)='text' AND length(CAST(actor_kind AS BLOB)) BETWEEN 3 AND 7 THEN actor_kind ELSE NULL END AS actor_kind,",
	"CASE WHEN actor_id IS NULL OR (typeof(actor_id)='text' AND length(CAST(actor_id AS BLOB))=26) THEN actor_id ELSE '!' END AS actor_id,",
	"CASE WHEN typeof(refs)='text' AND length(CAST(refs AS BLOB)) BETWEEN 2 AND 4096 THEN refs ELSE NULL END AS refs,",
	"CASE WHEN typeof(previous)='text' AND length(CAST(previous AS BLOB)) IN(0,64) THEN previous ELSE NULL END AS previous,",
	"CASE WHEN typeof(mac)='text' AND length(CAST(mac AS BLOB))=64 THEN mac ELSE NULL END AS mac",
].join(" ");
const BATCH_SQL = `${ROW_SQL} FROM main.audit_events WHERE main.audit_events.seq>? AND main.audit_events.seq<=? ORDER BY main.audit_events.seq LIMIT ?`;
const ANCHOR_SQL = `${ROW_SQL} FROM main.audit_events WHERE main.audit_events.seq=?`;

class AuditVerificationError extends Error {}
const chainFailure = (): Error => new AuditVerificationError("Audit chain verification failed");
const headFailure = (): Error => new AuditVerificationError("Audit head verification failed");
const equalMac = (actual: string, expected: string): boolean =>
	matches(actual) && timingSafeEqual(Buffer.from(actual, "hex"), Buffer.from(expected, "hex"));
const sameHead = (left: Head, right: Head): boolean =>
	left.audit_seq === right.audit_seq &&
	left.audit_head === right.audit_head &&
	left.audit_tag === right.audit_tag;
// Own writes in the live scope only append; another connection's commit ends reuse.
const sameScope = (left: ReadStamp, right: ReadStamp): boolean =>
	left.owner === right.owner &&
	left.revision === right.revision &&
	left.dataVersion === right.dataVersion &&
	left.schemaVersion === right.schemaVersion;

function pageOptions(options: AuditExportOptions): { afterSeq: number; limit: number } {
	if (
		options === null ||
		typeof options !== "object" ||
		types.isProxy(options) ||
		![Object.prototype, null].includes(Object.getPrototypeOf(options))
	)
		throw new Error("Invalid export options");
	if (Reflect.ownKeys(options).some((key) => key !== "afterSeq" && key !== "limit"))
		throw new Error("Invalid export options");
	const value = (name: string, fallback: number): number => {
		const descriptor = Object.getOwnPropertyDescriptor(options, name);
		if (!descriptor) return fallback;
		if (!("value" in descriptor)) throw new Error("Invalid export options");
		if (descriptor.value === undefined) return fallback;
		if (!Number.isSafeInteger(descriptor.value)) throw new Error("Invalid export options");
		return descriptor.value as number;
	};
	const afterSeq = value("afterSeq", 0),
		limit = value("limit", 100);
	if (afterSeq < 0 || limit < 1 || limit > AUDIT_EXPORT_MAX_EVENTS)
		throw new Error("Invalid export options");
	return { afterSeq, limit };
}
function validate(input: unknown): AuditEvent {
	const parsed = AuditEvent.safeParse(input);
	if (!parsed.success || Object.keys(parsed.data.refs).length > 32)
		throw new Error("Audit metadata is invalid");
	return parsed.data;
}

export class AuditChain {
	readonly #key: Buffer;
	#destroyed = false;
	// One bounded resume position. It retains no reader, database or caller callback.
	#resume: { stamp: ReadStamp; head: Head; afterSeq: number; previous: string } | undefined;
	readonly #segments = new WeakMap<SqlReader, Segment>();
	constructor(key: Uint8Array) {
		if (key.byteLength !== 32) throw new Error("Invalid audit key");
		this.#key = Buffer.alloc(32);
		this.#key.set(key);
	}
	#mac(row: Omit<AuditRow, "mac">): string {
		if (this.#destroyed) throw new Error("Audit is locked");
		return createHmac("sha256", this.#key)
			.update("draftyak/audit/v1\n")
			.update(canonicalize(row))
			.digest("hex");
	}
	append(tx: SqlTransaction, input: AuditEvent): void {
		const event = validate(input),
			head = this.#head(tx);
		if (!Number.isSafeInteger(head.audit_seq + 1)) throw new Error("Audit head is unavailable");
		const row = {
			seq: head.audit_seq + 1,
			id: event.id,
			at: event.at,
			action: event.action,
			actor_kind: event.actor.kind,
			actor_id: event.actor.id,
			refs: canonicalize(event.refs),
			previous: head.audit_head,
		};
		const mac = this.#mac(row),
			tag = auditHeadTag(this.#key, row.seq, mac);
		tx.run(
			"INSERT INTO main.audit_events(seq,id,at,action,actor_kind,actor_id,refs,previous,mac) VALUES(?,?,?,?,?,?,?,?,?)",
			[
				row.seq,
				row.id,
				row.at,
				row.action,
				row.actor_kind,
				row.actor_id,
				row.refs,
				row.previous,
				mac,
			],
		);
		if (
			tx.run(
				"UPDATE main.audit_meta SET audit_seq=?,audit_head=?,audit_tag=? WHERE singleton=1 AND audit_seq=? AND audit_head=? AND audit_tag=?",
				[row.seq, mac, tag, head.audit_seq, head.audit_head, head.audit_tag],
			).changes !== 1
		)
			throw new Error("Audit append conflicted");
	}
	#head(db: SqlReader): Head {
		if (this.#destroyed) throw new Error("Audit is locked");
		const head = db.get<Head>(HEAD_SQL);
		if (
			!head ||
			!Number.isSafeInteger(head.audit_seq) ||
			head.audit_seq < 0 ||
			(head.audit_seq === 0 ? head.audit_head !== "" : !matches(head.audit_head)) ||
			!equalMac(head.audit_tag, auditHeadTag(this.#key, head.audit_seq, head.audit_head))
		)
			throw headFailure();
		return head;
	}
	#event(row: AuditRow): AuditEvent {
		if (typeof row.refs !== "string") throw chainFailure();
		const event = validate({
			id: row.id,
			at: row.at,
			action: row.action,
			actor: { kind: row.actor_kind, id: row.actor_id },
			refs: JSON.parse(row.refs),
		});
		if (canonicalize(event.refs) !== row.refs) throw chainFailure();
		return event;
	}
	#rows(
		db: SqlReader,
		seq: number,
		end: number,
		previous: string,
		accept?: (row: AuditRow, event: AuditEvent) => void,
	): { seq: number; previous: string } {
		while (seq < end) {
			const rows = db.all<AuditRow>(BATCH_SQL, [seq, end, AUDIT_VERIFY_BATCH_SIZE]);
			if (!Array.isArray(rows) || !rows.length || rows.length > AUDIT_VERIFY_BATCH_SIZE)
				throw chainFailure();
			for (const row of rows) {
				if (
					!Number.isSafeInteger(row.seq) ||
					row.seq !== seq + 1 ||
					row.seq > end ||
					typeof row.previous !== "string" ||
					row.previous !== previous ||
					!matches(row.mac)
				)
					throw chainFailure();
				const event = this.#event(row);
				const { mac, ...body } = row;
				if (!equalMac(mac, this.#mac(body))) throw chainFailure();
				seq = row.seq;
				previous = mac;
				accept?.(row, event);
			}
		}
		return { seq, previous };
	}
	#count(db: SqlReader, head: Head): void {
		const count = db.get<{ events: number }>("SELECT COUNT(*) AS events FROM main.audit_events");
		if (!count || !Number.isSafeInteger(count.events) || count.events !== head.audit_seq)
			throw headFailure();
	}
	#anchor(db: SqlReader, seq: number, mac: string): void {
		if (seq === 0) {
			if (mac !== "") throw chainFailure();
			return;
		}
		const row = db.get<AuditRow>(ANCHOR_SQL, [seq]);
		if (!row || row.seq !== seq || !equalMac(row.mac, mac)) throw chainFailure();
		this.#event(row);
		const { mac: actual, ...body } = row;
		if (!equalMac(actual, this.#mac(body))) throw chainFailure();
	}
	#first(db: SqlReader, seq: number): { previous: string; mac: string } {
		const row = db.get<AuditRow>(ANCHOR_SQL, [seq]);
		if (
			!row ||
			row.seq !== seq ||
			typeof row.previous !== "string" ||
			(seq === 1 ? row.previous !== "" : !matches(row.previous)) ||
			!matches(row.mac)
		)
			throw chainFailure();
		this.#event(row);
		const { mac, ...body } = row;
		if (!equalMac(mac, this.#mac(body))) throw chainFailure();
		return { previous: row.previous, mac };
	}
	#verifyPages(db: SqlReader, accept?: (row: AuditRow, event: AuditEvent) => void): Head {
		const head = this.#head(db);
		this.#count(db, head);
		const final = this.#rows(db, 0, head.audit_seq, "", accept);
		if (final.previous !== head.audit_head || !sameHead(head, this.#head(db))) throw headFailure();
		this.#count(db, head);
		return head;
	}
	verify(db: SqlReader): void {
		try {
			const stamp = readStamp(db);
			this.#verifyPages(db);
			if (stamp && !sameReadStamp(stamp, readStamp(db))) throw chainFailure();
		} catch (error) {
			if (this.#destroyed) throw new Error("Audit is locked");
			throw error instanceof AuditVerificationError ? error : chainFailure();
		}
	}
	/**
	 * Authenticates every row from fromSeq through the tag-checked head and the total count; rows
	 * before fromSeq are left to verify. Calls on one live store reader reuse the rows it has
	 * already authenticated in that scope, never another reader's or a scope after a commit.
	 */
	verifySegment(db: SqlReader, fromSeq: number): void {
		try {
			const stamp = readStamp(db),
				head = this.#head(db);
			if (!Number.isSafeInteger(fromSeq) || fromSeq < 1 || fromSeq > head.audit_seq)
				throw chainFailure();
			this.#count(db, head);
			const known = stamp ? this.#segments.get(db) : undefined;
			let from = fromSeq,
				previous: string;
			if (stamp && known && sameScope(known.stamp, stamp) && head.audit_seq >= known.seq) {
				if (this.#rows(db, known.seq, head.audit_seq, known.mac).previous !== head.audit_head)
					throw headFailure();
				if (fromSeq < known.from) {
					const first = this.#first(db, fromSeq);
					if (this.#rows(db, fromSeq, known.from - 1, first.mac).previous !== known.previous)
						throw chainFailure();
					previous = first.previous;
				} else {
					from = known.from;
					previous = known.previous;
				}
			} else {
				const first = this.#first(db, fromSeq);
				if (this.#rows(db, fromSeq, head.audit_seq, first.mac).previous !== head.audit_head)
					throw headFailure();
				previous = first.previous;
			}
			if (!sameHead(head, this.#head(db))) throw headFailure();
			this.#count(db, head);
			if (stamp) {
				if (!sameReadStamp(stamp, readStamp(db))) throw chainFailure();
				this.#segments.set(db, {
					stamp,
					from,
					previous,
					seq: head.audit_seq,
					mac: head.audit_head,
				});
			}
		} catch (error) {
			this.#segments.delete(db);
			if (this.#destroyed) throw new Error("Audit is locked");
			throw error instanceof AuditVerificationError ? error : chainFailure();
		}
	}
	/** A page is released only after its pinned chain and final authenticated head verify. */
	exportVerifiedJsonl(db: SqlReader, options: AuditExportOptions = {}): AuditExportPage {
		try {
			const { afterSeq, limit } = pageOptions(options),
				stamp = readStamp(db);
			const lines: string[] = [];
			let bytes = 0,
				last = afterSeq,
				lastMac: string | undefined = afterSeq === 0 ? "" : undefined,
				pageFull = false;
			const accept = (row: AuditRow, event: AuditEvent): void => {
				if (row.seq === afterSeq) lastMac = row.mac;
				if (row.seq <= afterSeq || lines.length >= limit || pageFull) return;
				const line = `${canonicalize({ ...event, seq: row.seq, previous: row.previous, mac: row.mac })}\n`;
				const size = Buffer.byteLength(line, "utf8");
				if (bytes + size > AUDIT_EXPORT_MAX_BYTES) {
					pageFull = true;
					return;
				}
				bytes += size;
				lines.push(line);
				last = row.seq;
				lastMac = row.mac;
			};
			let head: Head;
			if (
				this.#resume &&
				afterSeq === this.#resume.afterSeq &&
				stamp?.owner === this.#resume.stamp.owner &&
				stamp?.dataVersion === this.#resume.stamp.dataVersion &&
				stamp?.schemaVersion === this.#resume.stamp.schemaVersion
			) {
				try {
					head = this.#head(db);
					if (head.audit_seq < this.#resume.head.audit_seq) throw headFailure();
					this.#count(db, head);
					this.#anchor(db, this.#resume.head.audit_seq, this.#resume.head.audit_head);
					this.#anchor(db, afterSeq, this.#resume.previous);
					const tail = this.#rows(
						db,
						this.#resume.head.audit_seq,
						head.audit_seq,
						this.#resume.head.audit_head,
					);
					if (tail.previous !== head.audit_head) throw headFailure();
					lastMac = this.#resume.previous;
					const final = this.#rows(
						db,
						afterSeq,
						Math.min(head.audit_seq, afterSeq + limit),
						lastMac,
						accept,
					);
					if (
						(final.seq === head.audit_seq && final.previous !== head.audit_head) ||
						!sameHead(head, this.#head(db))
					)
						throw headFailure();
					this.#count(db, head);
				} catch {
					// A rolled-back write can invalidate a checkpoint without corrupting the chain.
					this.#resume = undefined;
					lines.length = 0;
					bytes = 0;
					last = afterSeq;
					lastMac = afterSeq === 0 ? "" : undefined;
					pageFull = false;
					head = this.#verifyPages(db, accept);
				}
			} else head = this.#verifyPages(db, accept);
			if (afterSeq > head.audit_seq || (stamp && !sameReadStamp(stamp, readStamp(db))))
				throw chainFailure();
			this.#resume =
				stamp && lastMac !== undefined
					? { stamp, head, afterSeq: last, previous: lastMac }
					: undefined;
			return Object.freeze({
				jsonl: lines.join(""),
				count: lines.length,
				nextAfterSeq: last < head.audit_seq ? last : null,
				head: Object.freeze({ seq: head.audit_seq, mac: head.audit_head }),
			});
		} catch {
			this.#resume = undefined;
			throw new Error("Audit export unavailable");
		}
	}
	destroy(): void {
		this.#key.fill(0);
		this.#resume = undefined;
		this.#destroyed = true;
	}
}
