import { types } from "node:util";
import { OwnerSettings } from "@draftyak/protocol/entities/settings";
import { canonicalize, parseStrict } from "@draftyak/protocol/jcs";
import { Authorizer, assertAuthorizerStore } from "../authz/authorizer.ts";
import { deviceApiError } from "../authz/errors.ts";
import type { NativeDevicePeer } from "../authz/native-peer.ts";
import { assertHubSessionAdmission, type HubSession } from "../lifecycle/session.ts";
import { HubStore, type SqlReader } from "../store/store.ts";

export const OWNER_SETTINGS_MAX_BYTES = 4096;
export type OwnerSettingsErrorCode = "INVALID_REQUEST" | "FORBIDDEN" | "UNAVAILABLE";

export class OwnerSettingsError extends Error {
	override name = "OwnerSettingsError";
	readonly code: OwnerSettingsErrorCode;
	constructor(code: OwnerSettingsErrorCode) {
		super(code);
		this.code = code;
	}
}

export interface OwnerSettingsValue {
	readonly zone: OwnerSettings["zone"];
	readonly workingHours: {
		readonly days: ReadonlyArray<OwnerSettings["workingHours"]["days"][number]>;
		readonly start: string;
		readonly end: string;
	};
}

export interface OwnerSettingsHandle {
	get(peer: NativeDevicePeer): OwnerSettingsValue | undefined;
	put(peer: NativeDevicePeer, payload: Uint8Array): OwnerSettingsValue;
}

const read = HubStore.prototype.read;
const write = HubStore.prototype.write;
const requirePeer = Authorizer.prototype.requirePeerDevice;
const assertCurrent = Authorizer.prototype.assertCurrentGrant;
const typedArray = Object.getPrototypeOf(Uint8Array.prototype);
const byteLength = Object.getOwnPropertyDescriptor(typedArray, "byteLength")?.get;
const byteOffset = Object.getOwnPropertyDescriptor(typedArray, "byteOffset")?.get;
const buffer = Object.getOwnPropertyDescriptor(typedArray, "buffer")?.get;
const tag = Object.getOwnPropertyDescriptor(typedArray, Symbol.toStringTag)?.get;
const isView = ArrayBuffer.isView;
const setBytes = Uint8Array.prototype.set;

function guard<T>(work: () => T): T {
	try {
		return work();
	} catch (error) {
		if (error instanceof OwnerSettingsError) throw error;
		throw new OwnerSettingsError(
			deviceApiError(error) === "FORBIDDEN" ? "FORBIDDEN" : "UNAVAILABLE",
		);
	}
}

/** Capture native view slots only; caller properties and shared memory are not request bytes. */
function requestBytes(value: unknown): Uint8Array {
	try {
		if (!isView(value) || tag?.call(value) !== "Uint8Array") throw new Error();
		const length = byteLength?.call(value);
		const storage = buffer?.call(value);
		if (
			!Number.isSafeInteger(length) ||
			length < 1 ||
			length > OWNER_SETTINGS_MAX_BYTES ||
			types.isSharedArrayBuffer(storage)
		)
			throw new Error();
		const view = new Uint8Array(storage, byteOffset?.call(value), length);
		const copy = new Uint8Array(length);
		setBytes.call(copy, view);
		return copy;
	} catch {
		throw new OwnerSettingsError("INVALID_REQUEST");
	}
}

function settings(input: string | Uint8Array, code: OwnerSettingsErrorCode): OwnerSettingsValue {
	try {
		const result = OwnerSettings.parse(parseStrict(input));
		// The schema's exported newline exclusion must also hold at this native boundary.
		if (/[\r\n\u2028\u2029]/u.test(result.zone)) throw new Error();
		Object.freeze(result.workingHours.days);
		Object.freeze(result.workingHours);
		return Object.freeze(result);
	} catch {
		throw new OwnerSettingsError(code);
	}
}

interface Row {
	user_id: string;
	settings_json: string;
}
function stored(db: SqlReader, owner: string): OwnerSettingsValue | undefined {
	const row = db.get<Row>("SELECT user_id, settings_json FROM owner_settings WHERE user_id=?", [
		owner,
	]);
	if (row === undefined) return undefined;
	if (
		row.user_id !== owner ||
		typeof row.settings_json !== "string" ||
		Buffer.byteLength(row.settings_json, "utf8") > OWNER_SETTINGS_MAX_BYTES
	)
		throw new OwnerSettingsError("UNAVAILABLE");
	return settings(row.settings_json, "UNAVAILABLE");
}

/** Native preferences only: no grant, routing choice, approval or operation is produced. */
export function createOwnerSettings(session: HubSession): OwnerSettingsHandle {
	return guard(() => {
		assertHubSessionAdmission(session);
		const store = session.store;
		const authorizer = new Authorizer(session.devices);
		const live = (): void => {
			assertHubSessionAdmission(session);
			assertAuthorizerStore(authorizer, store);
		};
		live();
		return Object.freeze({
			get(peer: NativeDevicePeer): OwnerSettingsValue | undefined {
				return guard(() => {
					live();
					return (read<OwnerSettingsValue | undefined>).call(store, (db) => {
						live();
						const grant = requirePeer.call(authorizer, db, peer, "read");
						live();
						const result = stored(db, grant.ownerUserId);
						live();
						assertCurrent.call(authorizer, db, grant);
						live();
						return result;
					});
				});
			},
			put(peer: NativeDevicePeer, payload: Uint8Array): OwnerSettingsValue {
				return guard(() => {
					live();
					return (write<OwnerSettingsValue>).call(store, (tx) => {
						live();
						const grant = requirePeer.call(authorizer, tx, peer, "admin");
						live();
						const bytes = requestBytes(payload);
						live();
						const value = settings(bytes, "INVALID_REQUEST");
						live();
						const json = canonicalize(value);
						live();
						assertCurrent.call(authorizer, tx, grant);
						live();
						const result = tx.run(
							"INSERT INTO owner_settings(user_id, settings_json) VALUES(?, ?) " +
								"ON CONFLICT(user_id) DO UPDATE SET settings_json=excluded.settings_json",
							[grant.ownerUserId, json],
						);
						live();
						if (result.changes !== 1) throw new OwnerSettingsError("UNAVAILABLE");
						const saved = stored(tx, grant.ownerUserId);
						live();
						if (saved === undefined || canonicalize(saved) !== json)
							throw new OwnerSettingsError("UNAVAILABLE");
						live();
						// This write changed the read stamp; bind the final check to its new state.
						const finalGrant = requirePeer.call(authorizer, tx, peer, "admin");
						live();
						if (finalGrant.ownerUserId !== grant.ownerUserId)
							throw new OwnerSettingsError("UNAVAILABLE");
						assertCurrent.call(authorizer, tx, finalGrant);
						live();
						return saved;
					});
				});
			},
		});
	});
}
