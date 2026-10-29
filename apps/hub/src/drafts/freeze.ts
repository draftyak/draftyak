import { types } from "node:util";
import { canonicalize } from "@draftyak/protocol/jcs";
import { Sha256Hex, Ulid, UtcMs } from "@draftyak/protocol/scalars";
import { CurrentSendSnapshotV1, contentHash } from "@draftyak/protocol/snapshot";
import { newId } from "../kernel/ids.ts";
import type { SqlReader, SqlTransaction } from "../store/store.ts";
import {
	captureDraftBinding,
	captureDraftData,
	type DraftBinding,
	draftRecord,
	immutableDraftData,
	NativeDraftRevisions,
	type NativeRevision,
	revisionUnavailable,
} from "./revisions.ts";

declare const frozenRevisionBrand: unique symbol;
/** A one-use proof of stored data and lock currentness. It carries no approval or caller rights. */
export interface FrozenRevisionProof {
	readonly [frozenRevisionBrand]: true;
}
export interface FrozenRevisionFacts extends DraftBinding {
	readonly rev: number;
	readonly outboxId: string;
	readonly revisionContentHash: string;
	readonly snapshotHash: string;
	readonly flagsHash: string;
	readonly snapshot: CurrentSendSnapshotV1;
}
interface FreezePayload {
	readonly binding: DraftBinding;
	readonly snapshot: CurrentSendSnapshotV1;
	readonly revisionContentHash: string;
	readonly flagsHash: string;
	readonly status: "active" | "released" | "consumed";
	readonly createdAt: number;
	readonly updatedAt: number;
}
interface FreezeRow {
	id: string;
	draft_id: string;
	outbox_id: string;
	payload: string;
	audit_seq: number;
	mac: string;
}
const proofs = new WeakMap<
	FrozenRevisionProof,
	{ revisions: NativeDraftRevisions; lockId: string }
>();
const methods = NativeDraftRevisions.prototype;
const SELECT = `SELECT id,draft_id,outbox_id,CASE WHEN typeof(payload)='text' AND length(CAST(payload AS BLOB)) BETWEEN 1 AND 2097152 THEN payload ELSE NULL END AS payload,audit_seq,CASE WHEN typeof(mac)='text' AND length(CAST(mac AS BLOB))=64 THEN mac ELSE NULL END AS mac FROM main.native_draft_locks WHERE id=?`;

function matches(
	current: NativeRevision,
	bound: DraftBinding,
	snapshot: CurrentSendSnapshotV1,
): void {
	const revision = current.revision,
		content = revision.content;
	if (
		snapshot.account !== bound.accountId ||
		snapshot.conversation !== bound.conversationId ||
		snapshot.kind !== bound.channel ||
		snapshot.source.draft !== bound.draftId ||
		snapshot.source.rev !== revision.rev ||
		snapshot.body.text !== content.body ||
		canonicalize(snapshot.source.authors) !== canonicalize(current.authors)
	)
		throw revisionUnavailable();
	if (content.channel === "email") {
		if (
			snapshot.kind !== "email" ||
			canonicalize(snapshot.email.to) !== canonicalize(content.to) ||
			canonicalize(snapshot.email.cc) !== canonicalize(content.cc) ||
			canonicalize(snapshot.email.bcc) !== canonicalize(content.bcc) ||
			snapshot.email.subject !== content.subject ||
			canonicalize(snapshot.attachments) !==
				canonicalize(content.attachments.map(({ blobId: _, ...attachment }) => attachment))
		)
			throw revisionUnavailable();
	} else if (
		snapshot.kind !== "chat" ||
		(snapshot.chat.threadTs ?? null) !== content.threadTs ||
		snapshot.chat.broadcast !== content.broadcast ||
		snapshot.attachments.length !== 0
	)
		throw revisionUnavailable();
}

/** Internal revision freeze/lock storage, joined to real authority only by its native caller. */
export class NativeDraftFreeze {
	readonly #revisions: NativeDraftRevisions;
	constructor(revisions: NativeDraftRevisions) {
		try {
			if (types.isProxy(revisions)) throw revisionUnavailable();
			methods.sign.call(revisions, "freeze", {});
		} catch {
			throw revisionUnavailable();
		}
		this.#revisions = revisions;
	}
	#facts(payload: FreezePayload): FrozenRevisionFacts {
		return immutableDraftData({
			...payload.binding,
			rev: payload.snapshot.source.rev,
			outboxId: payload.snapshot.outbox,
			revisionContentHash: payload.revisionContentHash,
			snapshotHash: contentHash(payload.snapshot),
			flagsHash: payload.flagsHash,
			snapshot: payload.snapshot,
		});
	}
	#load(db: SqlReader, id: string): { row: FreezeRow; payload: FreezePayload } {
		if (!Ulid.safeParse(id).success) throw revisionUnavailable();
		const row = db.get<FreezeRow>(SELECT, [id]);
		if (
			!row ||
			row.id !== id ||
			!Ulid.safeParse(row.draft_id).success ||
			!Ulid.safeParse(row.outbox_id).success ||
			typeof row.payload !== "string" ||
			!Number.isSafeInteger(row.audit_seq) ||
			row.audit_seq < 1
		)
			throw revisionUnavailable();
		const { mac, ...signed } = row;
		methods.checkMac.call(this.#revisions, "freeze", signed, mac);
		const data = draftRecord(JSON.parse(row.payload), [
				"binding",
				"snapshot",
				"revisionContentHash",
				"flagsHash",
				"status",
				"createdAt",
				"updatedAt",
			]),
			binding = captureDraftBinding(data.binding as DraftBinding),
			snapshot = CurrentSendSnapshotV1.parse(data.snapshot);
		if (
			canonicalize(data) !== row.payload ||
			!Sha256Hex.safeParse(data.revisionContentHash).success ||
			!Sha256Hex.safeParse(data.flagsHash).success ||
			!["active", "released", "consumed"].includes(data.status as string) ||
			!UtcMs.safeParse(data.createdAt).success ||
			!UtcMs.safeParse(data.updatedAt).success ||
			Number(data.updatedAt) < Number(data.createdAt) ||
			row.draft_id !== binding.draftId ||
			row.outbox_id !== snapshot.outbox
		)
			throw revisionUnavailable();
		const latest = db.get<{ seq: number }>(
			"SELECT seq FROM main.audit_events WHERE refs=? ORDER BY seq DESC LIMIT 1",
			[canonicalize({ draft: row.draft_id, freeze: row.id, outbox: row.outbox_id })],
		);
		if (latest?.seq !== row.audit_seq) throw revisionUnavailable();
		return {
			row,
			payload: {
				binding,
				snapshot,
				revisionContentHash: data.revisionContentHash as string,
				flagsHash: data.flagsHash as string,
				status: data.status as FreezePayload["status"],
				createdAt: Number(data.createdAt),
				updatedAt: Number(data.updatedAt),
			},
		};
	}
	#save(tx: SqlTransaction, id: string, payload: FreezePayload, insert: boolean): void {
		methods.assertTransaction.call(this.#revisions, tx);
		const audit_seq = methods.auditInTransaction.call(
				this.#revisions,
				tx,
				`draft.freeze_${payload.status}`,
				{ draft: payload.binding.draftId, freeze: id, outbox: payload.snapshot.outbox },
			),
			row = {
				id,
				draft_id: payload.binding.draftId,
				outbox_id: payload.snapshot.outbox,
				payload: canonicalize(payload),
				audit_seq,
			};
		if (Buffer.byteLength(row.payload) > 2097152) throw revisionUnavailable();
		const mac = methods.sign.call(this.#revisions, "freeze", row);
		if (insert)
			tx.run(
				"INSERT INTO main.native_draft_locks(id,draft_id,outbox_id,payload,audit_seq,mac) VALUES(?,?,?,?,?,?)",
				[row.id, row.draft_id, row.outbox_id, row.payload, audit_seq, mac],
			);
		else if (
			tx.run("UPDATE main.native_draft_locks SET payload=?,audit_seq=?,mac=? WHERE id=?", [
				row.payload,
				audit_seq,
				mac,
				id,
			]).changes !== 1
		)
			throw revisionUnavailable();
	}
	#proof(lockId: string): FrozenRevisionProof {
		const handle = Object.freeze(Object.create(null)) as FrozenRevisionProof;
		proofs.set(handle, { revisions: this.#revisions, lockId });
		return handle;
	}
	#current(
		tx: SqlTransaction,
		bound: DraftBinding,
		outboxId: string,
	): { row: FreezeRow; payload: FreezePayload; current: NativeRevision } {
		const current = methods.currentInTransaction.call(this.#revisions, tx, bound);
		if (current.lockId === null) throw revisionUnavailable();
		const stored = this.#load(tx, current.lockId);
		if (
			stored.payload.status !== "active" ||
			stored.row.outbox_id !== outboxId ||
			stored.payload.revisionContentHash !== current.revision.contentSha256 ||
			stored.payload.flagsHash !== current.flagsHash ||
			canonicalize(stored.payload.binding) !== canonicalize(bound)
		)
			throw revisionUnavailable();
		matches(current, bound, stored.payload.snapshot);
		return { ...stored, current };
	}
	freezeInTransaction(
		tx: SqlTransaction,
		binding: DraftBinding,
		expectedRev: number,
		input: CurrentSendSnapshotV1,
	): FrozenRevisionProof {
		try {
			methods.assertTransaction.call(this.#revisions, tx);
			const bound = captureDraftBinding(binding),
				snapshot = CurrentSendSnapshotV1.parse(captureDraftData(input)),
				current = methods.currentInTransaction.call(this.#revisions, tx, bound);
			if (
				current.draft.rev !== expectedRev ||
				current.draft.state !== "open" ||
				current.lockId !== null
			)
				throw revisionUnavailable();
			matches(current, bound, snapshot);
			if (
				tx.get("SELECT 1 FROM main.audit_events WHERE json_extract(refs,'$.outbox')=? LIMIT 1", [
					snapshot.outbox,
				])
			)
				throw revisionUnavailable();
			const at = methods.now.call(this.#revisions),
				id = newId(at);
			methods.setLockInTransaction.call(this.#revisions, tx, bound, expectedRev, null, id);
			this.#save(
				tx,
				id,
				{
					binding: bound,
					snapshot,
					revisionContentHash: current.revision.contentSha256,
					flagsHash: current.flagsHash,
					status: "active",
					createdAt: at,
					updatedAt: at,
				},
				true,
			);
			return this.#proof(id);
		} catch {
			throw revisionUnavailable();
		}
	}
	/** Reopen the existing active lock as data-currentness proof, never as approval. */
	proofInTransaction(
		tx: SqlTransaction,
		binding: DraftBinding,
		outboxId: string,
	): FrozenRevisionProof {
		try {
			methods.assertTransaction.call(this.#revisions, tx);
			const stored = this.#current(tx, captureDraftBinding(binding), outboxId);
			return this.#proof(stored.row.id);
		} catch {
			throw revisionUnavailable();
		}
	}
	consumeInTransaction(tx: SqlTransaction, proof: FrozenRevisionProof): FrozenRevisionFacts {
		const saved = proofs.get(proof);
		proofs.delete(proof);
		try {
			methods.assertTransaction.call(this.#revisions, tx);
			if (!saved || !methods.sameStore.call(this.#revisions, saved.revisions))
				throw revisionUnavailable();
			const loaded = this.#load(tx, saved.lockId),
				{ row, payload } = this.#current(tx, loaded.payload.binding, loaded.row.outbox_id),
				at = methods.now.call(this.#revisions);
			if (at < payload.updatedAt) throw revisionUnavailable();
			this.#save(tx, row.id, { ...payload, status: "consumed", updatedAt: at }, false);
			return this.#facts(payload);
		} catch {
			throw revisionUnavailable();
		}
	}
	/** Native cancellation/supersede composition may release only an unconsumed data lock. */
	releaseInTransaction(tx: SqlTransaction, binding: DraftBinding, outboxId: string): void {
		try {
			methods.assertTransaction.call(this.#revisions, tx);
			const bound = captureDraftBinding(binding),
				{ row, payload, current } = this.#current(tx, bound, outboxId),
				at = methods.now.call(this.#revisions);
			if (at < payload.updatedAt) throw revisionUnavailable();
			this.#save(tx, row.id, { ...payload, status: "released", updatedAt: at }, false);
			methods.setLockInTransaction.call(
				this.#revisions,
				tx,
				bound,
				current.draft.rev,
				row.id,
				null,
			);
		} catch {
			throw revisionUnavailable();
		}
	}
}
