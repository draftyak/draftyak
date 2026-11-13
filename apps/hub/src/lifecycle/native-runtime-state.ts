import type { HubMode, SchedulingStatus } from "@draftyak/protocol/hub-runtime";
import { Authorizer } from "../authz/authorizer.ts";
import { AuthzError } from "../authz/errors.ts";
import type { NativeDevicePeer } from "../authz/native-peer.ts";
import {
	assertStoreTransaction,
	HubStore,
	type SqlReader,
	type SqlTransaction,
} from "../store/store.ts";
import { assertHubSessionAdmission, type HubSession } from "./session.ts";

export interface NativeRuntimeState {
	status(peer: NativeDevicePeer): SchedulingStatus;
	pauseSync(peer: NativeDevicePeer, paused: boolean): SchedulingStatus;
	/** Retires this child; the original session retains its store and master key. */
	close(): Promise<void>;
}

interface Owner {
	readonly session: HubSession;
	readonly mode: HubMode;
	readonly authorizer: Authorizer;
	closed: boolean;
}

const owners = new WeakMap<NativeRuntimeState, Owner>();
const sessions = new WeakSet<HubSession>();
const storeRead = HubStore.prototype.read;
const storeWrite = HubStore.prototype.write;
const requireDevice = Authorizer.prototype.requirePeerDevice;
const requireRoute = Authorizer.prototype.requirePeerRoute;
const assertGrant = Authorizer.prototype.assertCurrentGrant;

function admitted(owner: Owner): void {
	if (owner.closed) throw new AuthzError("UNAVAILABLE");
	assertHubSessionAdmission(owner.session);
}

function statusIn(owner: Owner, db: SqlReader): SchedulingStatus {
	admitted(owner);
	const row = db.get<{ paused: number | null }>(
		"SELECT CASE WHEN typeof(sync_paused)='integer' AND sync_paused IN (0,1) THEN sync_paused ELSE NULL END AS paused FROM main.native_runtime_settings WHERE singleton=1",
	);
	if (row === undefined || (row.paused !== 0 && row.paused !== 1))
		throw new AuthzError("UNAVAILABLE");
	// No loop was constructed or adopted by this owner. Availability is not a startup flag.
	const scheduler: SchedulingStatus["scheduler"] = "unavailable";
	admitted(owner);
	return Object.freeze({ mode: owner.mode, scheduler, syncPaused: row.paused === 1 });
}

function guarded<T>(work: () => T): T {
	try {
		return work();
	} catch (error) {
		throw error instanceof AuthzError ? error : new AuthzError("UNAVAILABLE");
	}
}

/**
 * Native hosting construction, with no scheduler resource. Mode is chosen here, not by HTTP.
 * The delivered migration supplies the durable initial unpaused row; a missing row refuses.
 */
export function createNativeRuntimeState(session: HubSession, mode: HubMode): NativeRuntimeState {
	return guarded(() => {
		assertHubSessionAdmission(session);
		if ((mode !== "sidecar" && mode !== "service") || sessions.has(session))
			throw new AuthzError("UNAVAILABLE");
		const owner: Owner = {
			session,
			mode,
			authorizer: new Authorizer(session.devices),
			closed: false,
		};
		storeRead.call(session.store, (db: SqlReader) => statusIn(owner, db));
		const api: NativeRuntimeState = Object.freeze({
			status(peer: NativeDevicePeer): SchedulingStatus {
				return guarded(() => {
					admitted(owner);
					return storeRead.call(session.store, (db: SqlReader) => {
						const grant = requireDevice.call(owner.authorizer, db, peer, "read");
						const result = statusIn(owner, db);
						assertGrant.call(owner.authorizer, db, grant);
						admitted(owner);
						return result;
					}) as SchedulingStatus;
				});
			},
			pauseSync(peer: NativeDevicePeer, paused: boolean): SchedulingStatus {
				return guarded(() => {
					admitted(owner);
					if (typeof paused !== "boolean") throw new AuthzError("UNAVAILABLE");
					return storeWrite.call(session.store, (tx: SqlTransaction) => {
						requireRoute.call(owner.authorizer, tx, peer, "sync-pause");
						const before = requireDevice.call(owner.authorizer, tx, peer, "organize");
						assertGrant.call(owner.authorizer, tx, before);
						if (
							tx.run("UPDATE main.native_runtime_settings SET sync_paused=? WHERE singleton=1", [
								paused ? 1 : 0,
							]).changes !== 1
						)
							throw new AuthzError("UNAVAILABLE");
						// This write changed the read stamp. Obtain a fresh real grant, not a loan
						// of the pre-mutation one, before returning the committed setting.
						const after = requireDevice.call(owner.authorizer, tx, peer, "organize");
						if (
							after.deviceId !== before.deviceId ||
							after.ownerUserId !== before.ownerUserId ||
							after.epoch !== before.epoch
						)
							throw new AuthzError("UNAVAILABLE");
						const result = statusIn(owner, tx);
						assertGrant.call(owner.authorizer, tx, after);
						admitted(owner);
						return result;
					}) as SchedulingStatus;
				});
			},
			close(): Promise<void> {
				owner.closed = true;
				// This owner acquired no loop, file, socket, session or key to release.
				return Promise.resolve();
			},
		});
		owners.set(api, owner);
		sessions.add(session);
		return api;
	});
}

/** Consuming native seam only: validates the same original active transaction, grants no rights. */
export function nativeRuntimeStatusInTransaction(
	runtime: NativeRuntimeState,
	tx: SqlTransaction,
): SchedulingStatus {
	return guarded(() => {
		const owner = owners.get(runtime);
		if (owner === undefined) throw new AuthzError("UNAVAILABLE");
		admitted(owner);
		assertStoreTransaction(owner.session.store, tx);
		return statusIn(owner, tx);
	});
}
