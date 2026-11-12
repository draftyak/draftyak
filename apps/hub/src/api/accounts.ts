import { type AccountPage, type AccountRecord, NativeAccounts } from "../accounts/records.ts";
import { Authorizer, assertAuthorizerStore } from "../authz/authorizer.ts";
import { deviceApiError } from "../authz/errors.ts";
import type { NativeDevicePeer } from "../authz/native-peer.ts";
import { EventLog } from "../events/log.ts";
import { WorkDatabase, type WorkScope } from "../jobs/database.ts";
import { id } from "../jobs/values.ts";
import { assertHubSessionAdmission, type HubSession } from "../lifecycle/session.ts";
import { HubStore, type SqlReader, type SqlTransaction } from "../store/store.ts";

export type AccountReadErrorCode = "INVALID_REQUEST" | "FORBIDDEN" | "UNAVAILABLE";

const refusalCodes = new WeakMap<object, AccountReadErrorCode>();

export class AccountReadError extends Error {
	readonly code: AccountReadErrorCode;
	constructor(code: AccountReadErrorCode) {
		const fixed = code === "INVALID_REQUEST" || code === "FORBIDDEN" ? code : "UNAVAILABLE";
		super(fixed);
		this.name = "AccountReadError";
		this.code = fixed;
		refusalCodes.set(this, fixed);
		Object.freeze(this);
	}
}

export interface NativeAccountReads {
	get(peer: NativeDevicePeer, accountId: string): AccountRecord | undefined;
	page(peer: NativeDevicePeer, afterId: string | null): AccountPage;
}

const apply = Reflect.apply;
const writeStore = HubStore.prototype.write;
const readStore = HubStore.prototype.read;
const writeWork = WorkDatabase.prototype.write;
const workSql = WorkDatabase.prototype.sql;
const getAccount = NativeAccounts.prototype.getInTransaction;
const pageAccounts = NativeAccounts.prototype.page;
const requirePeer = Authorizer.prototype.requirePeerDevice;
const assertGrant = Authorizer.prototype.assertCurrentGrant;
const nativeNow = Date.now;

function requestId(value: unknown): string {
	if (typeof value !== "string") throw new AccountReadError("INVALID_REQUEST");
	try {
		return id(value);
	} catch {
		throw new AccountReadError("INVALID_REQUEST");
	}
}

function refused(error: unknown): AccountReadError {
	const own = typeof error === "object" && error !== null ? refusalCodes.get(error) : undefined;
	if (own !== undefined) return new AccountReadError(own);
	return new AccountReadError(deviceApiError(error) === "FORBIDDEN" ? "FORBIDDEN" : "UNAVAILABLE");
}

/** Native account metadata only; account records, flags and generations are not grants. */
export function createNativeAccountReads(session: HubSession): NativeAccountReads {
	try {
		assertHubSessionAdmission(session);
		const { store, audit, devices } = session;
		const authorizer = new Authorizer(devices);
		assertAuthorizerStore(authorizer, store);
		const database = new WorkDatabase(store);
		const events = new EventLog(database, nativeNow);
		const accounts = new NativeAccounts(database, events, audit, nativeNow);

		function admitted(): void {
			assertHubSessionAdmission(session);
			assertAuthorizerStore(authorizer, store);
		}

		function currentRead(
			sql: SqlReader,
			peer: NativeDevicePeer,
		): ReturnType<Authorizer["requirePeerDevice"]> {
			admitted();
			const grant = apply(requirePeer, authorizer, [sql, peer, "read"]) as ReturnType<
				Authorizer["requirePeerDevice"]
			>;
			apply(assertGrant, authorizer, [sql, grant]);
			if (grant.userId !== grant.ownerUserId) throw new AccountReadError("FORBIDDEN");
			admitted();
			return grant;
		}

		function publish<T>(peer: NativeDevicePeer, ownerUserId: string, value: T): T {
			admitted();
			const result = apply(readStore, store, [
				(sql: SqlReader): T => {
					const grant = currentRead(sql, peer);
					if (grant.ownerUserId !== ownerUserId) throw new AccountReadError("UNAVAILABLE");
					apply(assertGrant, authorizer, [sql, grant]);
					admitted();
					return value;
				},
			]) as T;
			admitted();
			return result;
		}

		const handle: NativeAccountReads = {
			get(peer, accountId): AccountRecord | undefined {
				const selected = requestId(accountId);
				try {
					admitted();
					// The existing record getter requires a genuine write facade, but runs only reads.
					const snapshot = apply(writeStore, store, [
						(sql: SqlTransaction): { ownerUserId: string; value: AccountRecord | undefined } => {
							const grant = currentRead(sql, peer);
							const value = apply(getAccount, accounts, [sql, grant.ownerUserId, selected]) as
								| AccountRecord
								| undefined;
							if (value !== undefined && value.account.userId !== grant.ownerUserId)
								throw new AccountReadError("UNAVAILABLE");
							apply(assertGrant, authorizer, [sql, grant]);
							admitted();
							return { ownerUserId: grant.ownerUserId, value };
						},
					]) as { ownerUserId: string; value: AccountRecord | undefined };
					return publish(peer, snapshot.ownerUserId, snapshot.value);
				} catch (error) {
					throw refused(error);
				}
			},
			page(peer, afterId): AccountPage {
				const after = afterId === null ? null : requestId(afterId);
				try {
					admitted();
					const snapshot = apply(writeWork, database, [
						(scope: WorkScope): { ownerUserId: string; value: AccountPage } => {
							const sql = apply(workSql, database, [scope]) as SqlTransaction;
							const first = currentRead(sql, peer);
							const value = apply(pageAccounts, accounts, [
								scope,
								first.ownerUserId,
								after,
							]) as AccountPage;
							// sql/page guard writes stale earlier stamps: sample only after the final one.
							const finalSql = apply(workSql, database, [scope]) as SqlTransaction;
							const final = currentRead(finalSql, peer);
							if (
								final.ownerUserId !== first.ownerUserId ||
								value.accounts.some((record) => record.account.userId !== final.ownerUserId)
							)
								throw new AccountReadError("UNAVAILABLE");
							apply(assertGrant, authorizer, [finalSql, final]);
							admitted();
							return { ownerUserId: final.ownerUserId, value };
						},
					]) as { ownerUserId: string; value: AccountPage };
					// WorkDatabase's last guard runs after its callback; authorize again after it.
					return publish(peer, snapshot.ownerUserId, snapshot.value);
				} catch (error) {
					throw refused(error);
				}
			},
		};
		admitted();
		return Object.freeze(handle);
	} catch (error) {
		throw refused(error);
	}
}
