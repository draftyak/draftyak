import {
	checkRouteResponse,
	OperationRequest,
	OperationReview,
	PairConfirmSubject,
} from "@draftyak/protocol/device-api";
import type { ConfirmationPreset } from "@draftyak/protocol/entities/device";
import { jcsSha256 } from "@draftyak/protocol/hash";
import type { PairConfirmStatement } from "@draftyak/protocol/statements/pair-confirm";
import { AuditChain } from "../audit/chain.ts";
import { Authorizer } from "../authz/authorizer.ts";
import type { NativeDevicePeer } from "../authz/native-peer.ts";
import type { Clock } from "../kernel/clock.ts";
import { newId } from "../kernel/ids.ts";
import { HubStore, type SqlReader, type SqlTransaction } from "../store/store.ts";
import type { ClockSample } from "./challenges-support.ts";
import { dataCopy, guard, refuse, sample } from "./challenges-support.ts";
import { DeviceRegistry } from "./devices.ts";
import type { PinProof } from "./pin.ts";

export const PAIR_CONFIRM_OPERATION_TTL_MS = 120_000;
interface Operation {
	readonly id: string;
	readonly approver: string;
	readonly candidate: string;
	readonly preset: ConfirmationPreset;
	readonly digest: string;
	readonly at: number;
	readonly expires: number;
	readonly mono: number;
}
const read = HubStore.prototype.read,
	write = HubStore.prototype.write;
const requireRoute = Authorizer.prototype.requirePeerRoute;
const requireKind = Authorizer.prototype.requirePeerKind;
const confirmable = Authorizer.prototype.requireConfirmable;
const confirm = DeviceRegistry.prototype.confirmByApprover;
const append = AuditChain.prototype.append;
const OPERATION_SQL = `SELECT CASE WHEN typeof(id)='text' AND length(CAST(id AS BLOB))=26 THEN id END AS id,
 CASE WHEN typeof(approver_id)='text' AND length(CAST(approver_id AS BLOB))=26 THEN approver_id END AS approver,
 CASE WHEN typeof(candidate_id)='text' AND length(CAST(candidate_id AS BLOB))=26 THEN candidate_id END AS candidate,
 CASE WHEN preset IN ('desktop','mobile','cli') THEN preset END AS preset,
 CASE WHEN typeof(digest)='text' AND length(CAST(digest AS BLOB))=64 THEN digest END AS digest,
 CASE WHEN typeof(created_at)='integer' THEN created_at END AS at,
 CASE WHEN typeof(expires_at)='integer' THEN expires_at END AS expires,
 used_at FROM main.pair_confirm_operations WHERE id=?`;

/** Internal operation storage; every entry still requires a live native peer and current rights. */
export class PairConfirmOperations {
	readonly #entries: Map<string, Operation>;
	readonly store: HubStore;
	readonly audit: AuditChain;
	readonly registry: DeviceRegistry;
	readonly authorizer: Authorizer;
	readonly clock: Clock;
	readonly #sas: ((candidateId: string) => string | undefined) | undefined;
	constructor(
		store: HubStore,
		audit: AuditChain,
		registry: DeviceRegistry,
		authorizer: Authorizer,
		clock: Clock,
		sas?: (candidateId: string) => string | undefined,
	) {
		this.store = store;
		this.audit = audit;
		this.registry = registry;
		this.authorizer = authorizer;
		this.clock = clock;
		this.#entries = new Map();
		this.#sas = sas;
	}
	#subject(db: SqlReader, operation: Operation) {
		let sas: string | undefined;
		try {
			sas = this.#sas?.(operation.candidate);
		} catch {
			refuse("NOT_FOUND");
		}
		if (typeof sas !== "string" || !/^[0-9]{6}$/.test(sas)) refuse("NOT_FOUND");
		const target = confirmable.call(
			this.authorizer,
			db,
			operation.approver,
			operation.candidate,
			operation.preset,
		);
		const subject = PairConfirmSubject.parse({
			candidate: target.candidate,
			name: target.name,
			role: target.role,
			transportSpkiSha256: target.transportSpkiSha256,
			signingKey: target.signingKey,
			preset: target.preset,
			capabilities: [...target.capabilities],
			sas,
		});
		this.#checkTime(operation, sample(this.clock));
		return subject;
	}
	#checkTime(operation: Operation, now: ClockSample): void {
		if (
			now.wall < operation.at ||
			now.wall > operation.expires ||
			now.mono < operation.mono ||
			now.mono - operation.mono > PAIR_CONFIRM_OPERATION_TTL_MS
		)
			refuse("STALE");
	}
	#load(db: SqlReader, peer: NativeDevicePeer, id: string, now: ClockSample): Operation {
		const actor = requireKind.call(this.authorizer, db, peer, "pair-confirm.v1");
		const op = this.#entries.get(id);
		if (!op || op.approver !== actor.deviceId) refuse("NOT_FOUND");
		const row = db.get<Operation & { used_at: number | null }>(OPERATION_SQL, [id]);
		if (
			!row ||
			row.used_at !== null ||
			row.id !== op.id ||
			row.approver !== op.approver ||
			row.candidate !== op.candidate ||
			row.preset !== op.preset ||
			row.digest !== op.digest ||
			row.at !== op.at ||
			row.expires !== op.expires
		)
			refuse("STALE");
		this.#checkTime(op, now);
		if (jcsSha256(this.#subject(db, op)) !== op.digest) refuse("STALE");
		return op;
	}
	open(peer: NativeDevicePeer, raw: unknown): { id: string } {
		const input = dataCopy(raw);
		const parsed = OperationRequest.safeParse(input);
		if (!parsed.success) refuse("INVALID_REQUEST");
		if (parsed.data.kind !== "pair-confirm") refuse("KIND_UNAVAILABLE");
		const request = parsed.data;
		const now = sample(this.clock);
		for (const [id, op] of this.#entries)
			if (now.mono < op.mono || now.mono - op.mono > PAIR_CONFIRM_OPERATION_TTL_MS)
				this.#entries.delete(id);
		const operation = guard(
			() =>
				write.call(this.store, (tx: SqlTransaction) => {
					requireRoute.call(this.authorizer, tx, peer, "new-operation", {
						kind: "pair-confirm",
						preset: request.preset,
					});
					const actor = requireKind.call(this.authorizer, tx, peer, "pair-confirm.v1");
					if (
						this.#entries.size >= 256 ||
						[...this.#entries.values()].filter((op) => op.approver === actor.deviceId).length >= 16
					)
						refuse("UNAVAILABLE");
					const basic = {
						id: newId(now.wall),
						approver: actor.deviceId,
						candidate: request.ids[0],
						preset: request.preset,
						at: now.wall,
						expires: now.wall + PAIR_CONFIRM_OPERATION_TTL_MS,
						mono: now.mono,
					};
					const op = Object.freeze({
						...basic,
						digest: jcsSha256(this.#subject(tx, { ...basic, digest: "" })),
					});
					tx.run(
						"INSERT INTO main.pair_confirm_operations(id,approver_id,candidate_id,preset,digest,created_at,expires_at) VALUES(?,?,?,?,?,?,?)",
						[op.id, op.approver, op.candidate, op.preset, op.digest, op.at, op.expires],
					);
					tx.run(
						"DELETE FROM main.pair_confirm_operations WHERE id IN(SELECT id FROM main.pair_confirm_operations WHERE used_at IS NULL AND expires_at<? ORDER BY expires_at LIMIT 64)",
						[Math.max(0, now.wall - 86_400_000)],
					);
					append.call(this.audit, tx, {
						id: newId(now.wall),
						at: now.wall,
						action: "pair_confirm.requested",
						actor: { kind: "device", id: actor.deviceId },
						refs: { operation: op.id, candidate: op.candidate },
					});
					return op;
				}) as Operation,
		);
		this.#entries.set(operation.id, operation);
		return Object.freeze({ id: operation.id });
	}
	review(peer: NativeDevicePeer, id: string): OperationReview {
		return guard(
			() =>
				read.call(this.store, (db: SqlReader) => {
					const now = sample(this.clock);
					const op = this.#load(db, peer, id, now);
					requireRoute.call(this.authorizer, db, peer, "operation-review", {
						kind: "pair-confirm",
					});
					const result = OperationReview.parse({
						id: op.id,
						kind: "pair-confirm",
						digest: op.digest,
						subject: this.#subject(db, op),
						expiresAt: op.expires,
						remainingMs: Math.max(
							0,
							Math.min(op.expires - now.wall, PAIR_CONFIRM_OPERATION_TTL_MS - (now.mono - op.mono)),
						),
					});
					if (!checkRouteResponse("operation-review", result)) refuse("UNAVAILABLE");
					return dataCopy(result) as OperationReview;
				}) as OperationReview,
		);
	}
	prepare(
		tx: SqlTransaction,
		peer: NativeDevicePeer,
		id: string,
		now: ClockSample,
	): Pick<
		PairConfirmStatement,
		"candidate" | "role" | "transportSpkiSha256" | "signingKey" | "capabilities"
	> {
		const op = this.#load(tx, peer, id, now);
		requireRoute.call(this.authorizer, tx, peer, "challenge", {
			kind: "pair-confirm.v1",
			preset: op.preset,
		});
		const subject = this.#subject(tx, op);
		return {
			candidate: subject.candidate,
			role: subject.role,
			transportSpkiSha256: subject.transportSpkiSha256,
			signingKey: subject.signingKey,
			capabilities: subject.capabilities,
		};
	}
	apply(
		tx: SqlTransaction,
		peer: NativeDevicePeer,
		id: string,
		statement: PairConfirmStatement,
		bytes: Uint8Array,
		signature: string,
		proof: PinProof,
		now: ClockSample,
	): void {
		const op = this.#load(tx, peer, id, now);
		if (statement.candidate !== op.candidate) refuse("STALE");
		confirm.call(
			this.registry,
			tx,
			{
				approver: op.approver,
				candidate: op.candidate,
				preset: op.preset,
				statement: bytes,
				signature,
			},
			proof,
		);
		if (
			tx.run("UPDATE main.pair_confirm_operations SET used_at=? WHERE id=? AND used_at IS NULL", [
				now.wall,
				id,
			]).changes !== 1
		)
			refuse("STALE");
		append.call(this.audit, tx, {
			id: newId(now.wall),
			at: now.wall,
			action: "pair_confirm.accepted",
			actor: { kind: "device", id: op.approver },
			refs: { operation: id, candidate: op.candidate },
		});
		this.#checkTime(op, sample(this.clock));
	}
}
