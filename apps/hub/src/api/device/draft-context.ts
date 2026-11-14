import { Draft, type DraftRevision } from "@draftyak/protocol/entities/draft";
import { Ulid } from "@draftyak/protocol/scalars";
import { NativeAccounts } from "../../accounts/records.ts";
import { Authorizer } from "../../authz/authorizer.ts";
import { AuthzError } from "../../authz/errors.ts";
import type { NativeDevicePeer } from "../../authz/native-peer.ts";
import {
	DRAFT_USED_SQL,
	type DraftBinding,
	NativeDraftRevisions,
	type NativeRevision,
} from "../../drafts/revisions.ts";
import { EventLog } from "../../events/log.ts";
import { WorkDatabase } from "../../jobs/database.ts";
import { systemClock } from "../../kernel/clock.ts";
import type { MasterKey } from "../../kernel/master-key.ts";
import { assertHubSessionAdmission, type HubSession } from "../../lifecycle/session.ts";
import { HubStore, type SqlTransaction } from "../../store/store.ts";

export interface NativeDraftReads {
	/** The authenticated saved current revision, not an edit or send permission. */
	get(peer: NativeDevicePeer, id: string): NativeRevision | undefined;
	/** An authenticated bounded history page; undefined means the draft does not exist. */
	history(
		peer: NativeDevicePeer,
		id: string,
		afterRev?: number,
		limit?: number,
	): readonly DraftRevision[] | undefined;
}

/** Internal child lifetime; the original Session exports only NativeDraftReads. */
export interface NativeDraftReadContext extends NativeDraftReads {
	beginClose(): void;
	/** Retires this child only; the original session owns its master key. */
	close(): Promise<void>;
}

const assertMasterKey = HubStore.prototype.assertMasterKey;
const write = HubStore.prototype.write;
const requireRead = Authorizer.prototype.requirePeerDevice;
const assertGrant = Authorizer.prototype.assertCurrentGrant;
const current = NativeDraftRevisions.prototype.currentInTransaction;
const history = NativeDraftRevisions.prototype.historyInTransaction;
const destroy = NativeDraftRevisions.prototype.destroy;
const accountGet = NativeAccounts.prototype.getInTransaction;

interface Operation {
	revisions?: NativeDraftRevisions;
}

// These bounded fields are routing hints only. The original domain reader authenticates them.
function binding(tx: SqlTransaction, id: string): DraftBinding | undefined {
	const row = tx.get<{ payload: string | null }>(
		`SELECT CASE WHEN typeof(payload)='text' AND length(CAST(payload AS BLOB)) BETWEEN 1 AND 8192 THEN payload ELSE NULL END AS payload FROM main.native_drafts WHERE id=?`,
		[id],
	);
	if (row === undefined) {
		if (tx.get(DRAFT_USED_SQL, [id]) !== undefined) throw new AuthzError("UNAVAILABLE");
		return undefined;
	}
	if (typeof row.payload !== "string") throw new AuthzError("UNAVAILABLE");
	const raw: unknown = JSON.parse(row.payload);
	if (raw === null || typeof raw !== "object" || Array.isArray(raw))
		throw new AuthzError("UNAVAILABLE");
	const header = raw as Record<string, unknown>;
	const draft = Draft.parse(header.draft);
	if (draft.id !== id || (header.channel !== "email" && header.channel !== "chat"))
		throw new AuthzError("UNAVAILABLE");
	return {
		draftId: draft.id,
		accountId: draft.accountId,
		conversationId: draft.conversationId,
		channel: header.channel,
	};
}

/** Same-session saved-data composition; no SQL reader, grant or derived key is exported. */
export function createNativeDraftReadContext(
	session: HubSession,
	masterKey: MasterKey,
): NativeDraftReadContext {
	assertHubSessionAdmission(session);
	assertMasterKey.call(session.store, masterKey);
	const authorizer = new Authorizer(session.devices);
	const database = new WorkDatabase(session.store);
	const now = (): number => systemClock.wallMs();
	const accounts = new NativeAccounts(database, new EventLog(database, now), session.audit, now);
	const retained = new Set<Operation>();
	let closed = false;
	let active = false;
	let closing: Promise<void> | undefined;
	let unwind: ReturnType<typeof Promise.withResolvers<void>> | undefined;

	function admitted(): void {
		if (closed) throw new AuthzError("UNAVAILABLE");
		assertHubSessionAdmission(session);
		assertMasterKey.call(session.store, masterKey);
	}

	function cleanup(operation: Operation): void {
		if (operation.revisions !== undefined) {
			destroy.call(operation.revisions);
			operation.revisions = undefined;
		}
		retained.delete(operation);
	}

	function read<T>(
		peer: NativeDevicePeer,
		rawId: string,
		readSaved: (revisions: NativeDraftRevisions, tx: SqlTransaction, bound: DraftBinding) => T,
	): T | undefined {
		admitted();
		if (active || retained.size !== 0) throw new AuthzError("UNAVAILABLE");
		const parsed = Ulid.safeParse(rawId);
		if (!parsed.success) throw new AuthzError("UNAVAILABLE");
		const id = parsed.data;
		const operation: Operation = {};
		retained.add(operation);
		active = true;
		let result: T | undefined;
		let failure: AuthzError | undefined;
		try {
			operation.revisions = new NativeDraftRevisions(session.store, session.audit, masterKey);
			const revisions = operation.revisions;
			result = write.call(session.store, (tx: SqlTransaction) => {
				admitted();
				const grant = requireRead.call(authorizer, tx, peer, "read");
				const bound = binding(tx, id);
				let result: T | undefined;
				if (bound !== undefined) {
					result = readSaved(revisions, tx, bound);
					const account = accountGet.call(
						accounts,
						tx,
						grant.ownerUserId,
						bound.accountId,
					)?.account;
					if (
						account === undefined ||
						account.id !== bound.accountId ||
						account.userId !== grant.ownerUserId ||
						account.channel !== bound.channel
					)
						throw new AuthzError("UNAVAILABLE");
				}
				assertGrant.call(authorizer, tx, grant);
				admitted();
				return result;
			}) as T | undefined;
		} catch (error) {
			failure = error instanceof AuthzError ? error : new AuthzError("UNAVAILABLE");
		} finally {
			try {
				cleanup(operation);
			} catch {
				failure = new AuthzError("UNAVAILABLE");
			} finally {
				active = false;
				unwind?.resolve();
				unwind = undefined;
			}
		}
		if (failure !== undefined) throw failure;
		admitted();
		return result;
	}

	return Object.freeze({
		get(peer: NativeDevicePeer, id: string): NativeRevision | undefined {
			return read(peer, id, (revisions, tx, bound) => current.call(revisions, tx, bound));
		},
		history(
			peer: NativeDevicePeer,
			id: string,
			afterRev = 0,
			limit = 32,
		): readonly DraftRevision[] | undefined {
			admitted();
			if (
				!Number.isSafeInteger(afterRev) ||
				afterRev < 0 ||
				!Number.isSafeInteger(limit) ||
				limit < 1 ||
				limit > 32
			)
				throw new AuthzError("UNAVAILABLE");
			return read(peer, id, (revisions, tx, bound) =>
				history.call(revisions, tx, bound, afterRev, limit),
			);
		},
		beginClose(): void {
			closed = true;
		},
		close(): Promise<void> {
			closed = true;
			if (closing) return closing;
			const attempt = (async (): Promise<void> => {
				if (active) {
					unwind ??= Promise.withResolvers<void>();
					await unwind.promise;
				}
				let failed = false;
				for (const operation of retained) {
					try {
						cleanup(operation);
					} catch {
						failed = true;
					}
				}
				if (failed) throw new AuthzError("UNAVAILABLE");
			})();
			closing = attempt;
			void attempt.catch(() => {
				if (closing === attempt) closing = undefined;
			});
			return attempt;
		},
	});
}
