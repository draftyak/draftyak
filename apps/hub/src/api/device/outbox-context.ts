import { types } from "node:util";
import { checkHubRuntimeResponse } from "@draftyak/protocol/hub-runtime";
import { boundedText, Ulid } from "@draftyak/protocol/scalars";
import {
	checkScheduledItemSource,
	cutDestination,
	MAX_PENDING_APPROVAL_IDS,
	MAX_SCHEDULED_ITEMS,
	ScheduledItem,
	ScheduledSummary,
	scopeHash,
} from "@draftyak/protocol/scheduled-summary";
import { checkBodyText } from "@draftyak/protocol/snapshot";
import { NativeAccounts } from "../../accounts/records.ts";
import { Authorizer } from "../../authz/authorizer.ts";
import { AuthzError } from "../../authz/errors.ts";
import type { NativeDevicePeer } from "../../authz/native-peer.ts";
import { immutableDraftData, NativeDraftRevisions } from "../../drafts/revisions.ts";
import { EventLog } from "../../events/log.ts";
import type { DeviceGrant } from "../../identity/devices.ts";
import { WorkDatabase } from "../../jobs/database.ts";
import { systemClock } from "../../kernel/clock.ts";
import type { MasterKey } from "../../kernel/master-key.ts";
import {
	type NativeRuntimeState,
	nativeRuntimeStatusInTransaction,
} from "../../lifecycle/native-runtime-state.ts";
import { assertHubSessionAdmission, type HubSession } from "../../lifecycle/session.ts";
import {
	destroyNativeOutboxProposals,
	NativeOutboxProposals,
	type NativeProposalRecord,
} from "../../outbox/propose.ts";
import type { SendTargetRecord } from "../../outbox/verifier-types.ts";
import { HubStore, type SqlTransaction } from "../../store/store.ts";

export interface NativeOutboxFooterPolicy {
	readonly footer: string;
}

const footerText = boundedText(10_000);

/** Captures explicit native startup DATA, never a request or proposal's footer. */
export function captureNativeOutboxFooterPolicy(
	input: NativeOutboxFooterPolicy,
): NativeOutboxFooterPolicy {
	try {
		if (
			!input ||
			typeof input !== "object" ||
			types.isProxy(input) ||
			![Object.prototype, null].includes(Object.getPrototypeOf(input)) ||
			Reflect.ownKeys(input).length !== 1
		)
			throw new AuthzError("UNAVAILABLE");
		const slot = Object.getOwnPropertyDescriptor(input, "footer");
		if (!slot?.enumerable || !("value" in slot)) throw new AuthzError("UNAVAILABLE");
		const value: unknown = slot.value;
		if (typeof value !== "string" || value.length > 20_000 || !checkBodyText(value))
			throw new AuthzError("UNAVAILABLE");
		return Object.freeze({ footer: footerText.parse(value) });
	} catch {
		throw new AuthzError("UNAVAILABLE");
	}
}

export interface NativeOutboxReadContext {
	/** The authenticated saved record; it is not a current approval target. */
	get(peer: NativeDevicePeer, id: string): NativeProposalRecord | undefined;
	/** Rechecks the domain engine's current target requirements, including native facts. */
	item(peer: NativeDevicePeer, id: string): SendTargetRecord | undefined;
	/** Owner counts and bounded frozen destinations, joined to the original native runtime. */
	summary(peer: NativeDevicePeer): ScheduledSummary;
	/** Retires this child only. The original session still owns its master key. */
	close(): void;
}

const assertMasterKey = HubStore.prototype.assertMasterKey;
const requireRoute = Authorizer.prototype.requirePeerRoute;
const requireDevice = Authorizer.prototype.requirePeerDevice;
const assertGrant = Authorizer.prototype.assertCurrentGrant;
const write = NativeOutboxProposals.prototype.write;
const get = NativeOutboxProposals.prototype.get;
const item = NativeOutboxProposals.prototype.item;
const destroyRevisions = NativeDraftRevisions.prototype.destroy;
const accountGet = NativeAccounts.prototype.getInTransaction;

interface Operation {
	revisions?: NativeDraftRevisions;
	proposals?: NativeOutboxProposals;
}

/** Same-session native composition. No SQL scope, device grant or derived key is exported. */
export function createNativeOutboxReadContext(
	session: HubSession,
	masterKey: MasterKey,
	runtime?: NativeRuntimeState,
): NativeOutboxReadContext {
	assertHubSessionAdmission(session);
	assertMasterKey.call(session.store, masterKey);
	const authorizer = new Authorizer(session.devices);
	const retained = new Set<Operation>();
	let closed = false;
	let active = false;

	function admitted(): void {
		if (closed) throw new AuthzError("UNAVAILABLE");
		assertHubSessionAdmission(session);
		assertMasterKey.call(session.store, masterKey);
	}

	function cleanup(operation: Operation): void {
		let failed = false;
		if (operation.proposals !== undefined) {
			try {
				destroyNativeOutboxProposals(operation.proposals);
				operation.proposals = undefined;
			} catch {
				failed = true;
			}
		}
		if (operation.revisions !== undefined) {
			try {
				destroyRevisions.call(operation.revisions);
				operation.revisions = undefined;
			} catch {
				failed = true;
			}
		}
		if (!failed) retained.delete(operation);
		else throw new AuthzError("UNAVAILABLE");
	}

	function operate<T>(
		peer: NativeDevicePeer,
		capability: "approve" | "read",
		work: (proposals: NativeOutboxProposals, tx: SqlTransaction, grant: DeviceGrant) => T,
	): T {
		admitted();
		if (active || retained.size !== 0) throw new AuthzError("UNAVAILABLE");
		active = true;
		const operation: Operation = {};
		retained.add(operation);
		try {
			operation.revisions = new NativeDraftRevisions(session.store, session.audit, masterKey);
			operation.proposals = new NativeOutboxProposals(
				session.store,
				session.audit,
				masterKey,
				operation.revisions,
				session.devices,
				authorizer,
				session.identity,
			);
			const proposals = operation.proposals;
			let authorizationError: AuthzError | undefined;
			try {
				// The domain reader requires this receiver's real write scope. Its jobs_meta
				// guards execute UPDATEs, and the store advances its in-memory revision.
				return write.call(proposals, (tx: SqlTransaction) => {
					try {
						admitted();
						if (capability === "approve") requireRoute.call(authorizer, tx, peer, "send-review");
						const grant = requireDevice.call(authorizer, tx, peer, capability);
						const result = work(proposals, tx, grant);
						assertGrant.call(authorizer, tx, grant);
						admitted();
						return result;
					} catch (error) {
						if (error instanceof AuthzError) authorizationError = error;
						throw error;
					}
				}) as T;
			} catch (error) {
				// The domain writer rolls back and wraps foreign errors. Preserve the actual
				// authorization refusal only after that original write has unwound.
				throw authorizationError ?? error;
			}
		} finally {
			active = false;
			cleanup(operation);
		}
	}

	function read<T extends NativeProposalRecord | SendTargetRecord>(
		peer: NativeDevicePeer,
		id: string,
		load: (this: NativeOutboxProposals, tx: SqlTransaction, id: string) => T | undefined,
	): T | undefined {
		return operate(peer, "approve", (proposals, tx, grant) => {
			const result = load.call(proposals, tx, id);
			if (result !== undefined && result.userId !== grant.ownerUserId)
				throw new AuthzError("PRINCIPAL_REFUSED");
			return result;
		});
	}

	function summary(peer: NativeDevicePeer): ScheduledSummary {
		admitted();
		return operate(peer, "read", (proposals, tx, grant) => {
			if (runtime === undefined) throw new AuthzError("UNAVAILABLE");
			// This consuming call verifies that runtime and transaction share the original store.
			nativeRuntimeStatusInTransaction(runtime, tx);
			const pending = tx.get<{ n: number }>(
				"SELECT count(*) AS n FROM main.outbox WHERE user_id=? AND state='PENDING_APPROVAL'",
				[grant.ownerUserId],
			);
			const scheduled = tx.get<{ n: number }>(
				"SELECT count(*) AS n FROM main.outbox WHERE user_id=? AND state='SCHEDULED' AND schedule_kind='at'",
				[grant.ownerUserId],
			);
			if (
				pending === undefined ||
				scheduled === undefined ||
				!Number.isSafeInteger(pending.n) ||
				pending.n < 0 ||
				!Number.isSafeInteger(scheduled.n) ||
				scheduled.n < 0
			)
				throw new AuthzError("UNAVAILABLE");
			const database = new WorkDatabase(session.store);
			const accounts = new NativeAccounts(
				database,
				new EventLog(database, systemClock.wallMs),
				session.audit,
				systemClock.wallMs,
			);
			function ownedRecord(rawId: string, state: "PENDING_APPROVAL" | "SCHEDULED") {
				const id = Ulid.parse(rawId);
				const record = get.call(proposals, tx, id);
				if (record === undefined || record.userId !== grant.ownerUserId || record.state !== state)
					throw new AuthzError("UNAVAILABLE");
				const account = accountGet.call(accounts, tx, grant.ownerUserId, record.accountId)?.account;
				if (
					account === undefined ||
					account.id !== record.accountId ||
					account.userId !== grant.ownerUserId ||
					account.channel !== record.snapshot.kind
				)
					throw new AuthzError("UNAVAILABLE");
				return { record, account };
			}
			// Selection returns ids only. The original domain reader authenticates every listed record.
			const pendingApprovalIds = tx
				.all<{ id: string }>(
					"SELECT id FROM main.outbox WHERE user_id=? AND state='PENDING_APPROVAL' ORDER BY id LIMIT ?",
					[grant.ownerUserId, MAX_PENDING_APPROVAL_IDS],
				)
				.map(({ id }) => ownedRecord(id, "PENDING_APPROVAL").record.id);
			const listed = tx
				.all<{ id: string }>(
					"SELECT id FROM main.outbox WHERE user_id=? AND state='SCHEDULED' AND schedule_kind='at' ORDER BY json_extract(payload,'$.snapshot.schedule.notBefore'),id LIMIT ?",
					[grant.ownerUserId, MAX_SCHEDULED_ITEMS],
				)
				.map(({ id }) => ownedRecord(id, "SCHEDULED"));
			const items = listed.map(({ record, account }) => {
				const snapshot = record.snapshot;
				if (snapshot.schedule.kind !== "at") throw new AuthzError("UNAVAILABLE");
				const recipients =
					snapshot.kind === "email"
						? [...snapshot.email.to, ...snapshot.email.cc, ...snapshot.email.bcc]
						: [];
				const first = snapshot.kind === "email" ? recipients[0] : snapshot.chat.channelName;
				if (first === undefined) throw new AuthzError("UNAVAILABLE");
				const shown = cutDestination(first);
				const sourceItem: ScheduledItem = {
					outboxId: record.id,
					accountId: record.accountId,
					alias: account.alias,
					destination: shown.destination,
					destinationTruncated: shown.destinationTruncated,
					moreRecipients: snapshot.kind === "email" ? recipients.length - 1 : 0,
					schedule: snapshot.schedule,
					deliverBy: snapshot.schedule.notBefore + snapshot.schedule.latenessSec * 1000,
				};
				const projected = ScheduledItem.parse(sourceItem);
				if (!checkScheduledItemSource(projected, snapshot)) throw new AuthzError("UNAVAILABLE");
				return projected;
			});
			const scheduling = nativeRuntimeStatusInTransaction(runtime, tx);
			const result = ScheduledSummary.parse({
				scheduling,
				scopeHash: scopeHash({
					hub: session.identity.hid,
					owner: grant.ownerUserId,
					epoch: grant.epoch,
					scheduling,
					pendingApprovalCount: pending.n,
					pendingApprovalIds,
					scheduledCount: scheduled.n,
					items: listed.map(({ record }) => ({
						outboxId: record.id,
						contentHash: record.contentHash,
						flagsHash: record.flagsHash,
						state: record.state,
					})),
				}),
				pendingApprovalCount: pending.n,
				pendingApprovalIds,
				scheduledCount: scheduled.n,
				items,
			});
			if (!checkHubRuntimeResponse("scheduling-outbox", result))
				throw new AuthzError("UNAVAILABLE");
			return immutableDraftData(result) as ScheduledSummary;
		});
	}

	return Object.freeze({
		get(peer: NativeDevicePeer, id: string): NativeProposalRecord | undefined {
			return read(peer, id, get);
		},
		item(peer: NativeDevicePeer, id: string): SendTargetRecord | undefined {
			return read(peer, id, item);
		},
		summary,
		close(): void {
			closed = true;
			if (active) return;
			let failed = false;
			for (const operation of retained) {
				try {
					cleanup(operation);
				} catch {
					failed = true;
				}
			}
			if (failed) throw new AuthzError("UNAVAILABLE");
		},
	});
}
