import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { types } from "node:util";
import { DataClass } from "@draftyak/protocol/data-class";
import {
	checkFrameLength,
	EventFrame,
	EventsRequest as M1EventsRequest,
} from "@draftyak/protocol/device-api";
import { canonicalize, parseStrict } from "@draftyak/protocol/jcs";
import { Authorizer, assertAuthorizerStore } from "../authz/authorizer.ts";
import { deviceApiError } from "../authz/errors.ts";
import type { NativeDevicePeer } from "../authz/native-peer.ts";
import { EVENT_PAGE_SIZE, EventLog, type EventPage } from "../events/log.ts";
import { WorkDatabase } from "../jobs/database.ts";
import { WorkError } from "../jobs/values.ts";
import { assertHubSessionAdmission, type HubSession } from "../lifecycle/session.ts";
import { readStamp, sameReadStamp } from "../store/read-stamp.ts";
import type { SqlReader } from "../store/store.ts";

export type NativeEventPageErrorCode = "INVALID_REQUEST" | "FORBIDDEN" | "UNAVAILABLE";
export class NativeEventPageError extends Error {
	readonly code: NativeEventPageErrorCode;
	constructor(code: NativeEventPageErrorCode) {
		super(code);
		this.name = "NativeEventPageError";
		this.code = code;
	}
}

export interface NativeEventPage {
	readonly frames: readonly EventFrame[];
	/** Internal scan progress, including suppressed rows; only frames belong on the wire. */
	readonly nextCursor: string | null;
	readonly more: boolean;
}
export interface NativeEventPageReader {
	read(peer: NativeDevicePeer, requestBytes: Uint8Array): NativeEventPage;
	/** Retires only this reader and its cursor key, never the original session. */
	close(): void;
}

type ResetReason = Extract<EventFrame, { type: "reset" }>["reason"];
interface Position {
	readonly epoch: number;
	readonly seq: number;
}
interface CapturedPage {
	readonly userId: string;
	readonly deviceId: string;
	readonly epoch: number;
	readonly after: string | null;
	readonly afterSeq: number;
	readonly page?: EventPage;
	readonly reset?: ResetReason;
}

const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8", { fatal: true });
const typedArrayPrototype = Object.getPrototypeOf(Uint8Array.prototype) as object;
const nativeBuffer = Object.getOwnPropertyDescriptor(typedArrayPrototype, "buffer")?.get;
const nativeLength = Object.getOwnPropertyDescriptor(typedArrayPrototype, "byteLength")?.get;
const nativeValues = Uint8Array.prototype.values;
const nativeSet = Uint8Array.prototype.set;
const counter = (value: unknown): value is number =>
	typeof value === "number" && Number.isSafeInteger(value) && value >= 0;

function request(raw: Uint8Array): M1EventsRequest {
	try {
		if (types.isProxy(raw) || !types.isUint8Array(raw) || !nativeBuffer || !nativeLength)
			throw new Error();
		// Validate detached/out-of-bounds views, then use only native typed-array slots.
		Reflect.apply(nativeValues, raw, []);
		const backing: unknown = Reflect.apply(nativeBuffer, raw, []);
		const length: unknown = Reflect.apply(nativeLength, raw, []);
		if (
			!types.isAnyArrayBuffer(backing) ||
			types.isSharedArrayBuffer(backing) ||
			typeof length !== "number" ||
			!Number.isSafeInteger(length) ||
			length < 0 ||
			length > 1024
		)
			throw new Error();
		const snapshot = new Uint8Array(length);
		Reflect.apply(nativeSet, snapshot, [raw]);
		const parsed = M1EventsRequest.parse(parseStrict(decoder.decode(snapshot)));
		const canonical = encoder.encode(canonicalize(parsed));
		if (
			canonical.byteLength !== snapshot.byteLength ||
			canonical.some((byte, index) => byte !== snapshot[index])
		)
			throw new Error();
		return Object.freeze({ after: parsed.after });
	} catch {
		throw new NativeEventPageError("INVALID_REQUEST");
	}
}

function seal(key: Buffer, binding: Buffer, epoch: number, seq: number): string {
	if (!counter(epoch) || !counter(seq)) throw new NativeEventPageError("UNAVAILABLE");
	const nonce = randomBytes(12);
	const cipher = createCipheriv("aes-256-gcm", key, nonce);
	cipher.setAAD(binding);
	const payload = Buffer.concat([
		cipher.update(canonicalize([epoch, seq]), "utf8"),
		cipher.final(),
	]);
	const cursor = `v1.${Buffer.concat([nonce, cipher.getAuthTag(), payload]).toString("base64url")}`;
	if (!M1EventsRequest.safeParse({ after: cursor }).success)
		throw new NativeEventPageError("UNAVAILABLE");
	return cursor;
}

function unseal(key: Buffer, binding: Buffer, cursor: string): Position | undefined {
	try {
		if (!cursor.startsWith("v1.")) return undefined;
		const encoded = cursor.slice(3);
		const bytes = Buffer.from(encoded, "base64url");
		if (bytes.length <= 28 || bytes.toString("base64url") !== encoded) return undefined;
		const decipher = createDecipheriv("aes-256-gcm", key, bytes.subarray(0, 12));
		decipher.setAAD(binding);
		decipher.setAuthTag(bytes.subarray(12, 28));
		const plaintext = decoder.decode(
			Buffer.concat([decipher.update(bytes.subarray(28)), decipher.final()]),
		);
		const position: unknown = parseStrict(plaintext);
		if (
			!Array.isArray(position) ||
			position.length !== 2 ||
			!counter(position[0]) ||
			!counter(position[1]) ||
			canonicalize(position) !== plaintext
		)
			return undefined;
		return Object.freeze({ epoch: position[0], seq: position[1] });
	} catch {
		return undefined;
	}
}

function frame(value: EventFrame): EventFrame {
	const parsed = EventFrame.parse(value);
	if (!checkFrameLength(encoder.encode(canonicalize(parsed)).byteLength))
		throw new NativeEventPageError("UNAVAILABLE");
	return parsed.type === "event"
		? Object.freeze({ ...parsed, ids: Object.freeze([...parsed.ids]) })
		: Object.freeze(parsed);
}

function ownedAccount(db: SqlReader, accountId: string, userId: string): boolean {
	const account = db.get<{ id: unknown; user_id: unknown }>(
		`SELECT
 CASE WHEN typeof(id)='text' AND length(CAST(id AS BLOB))=26 THEN id ELSE NULL END AS id,
 CASE WHEN typeof(user_id)='text' AND length(CAST(user_id AS BLOB))=26 THEN user_id ELSE NULL END AS user_id
 FROM main.accounts WHERE id=?`,
		[accountId],
	);
	return account?.id === accountId && account.user_id === userId;
}

function failure(error: unknown): NativeEventPageError {
	if (!types.isProxy(error) && error instanceof NativeEventPageError) return error;
	return new NativeEventPageError(
		deviceApiError(error) === "FORBIDDEN" ? "FORBIDDEN" : "UNAVAILABLE",
	);
}

/** Internally bound native ID-only pages. Cursors never replace current peer authorization. */
export function createNativeEventPageReader(session: HubSession): NativeEventPageReader {
	try {
		assertHubSessionAdmission(session);
		const store = session.store;
		const authorizer = new Authorizer(session.devices);
		Object.freeze(authorizer);
		assertAuthorizerStore(authorizer, store);
		const database = new WorkDatabase(store);
		Object.freeze(database);
		const log = new EventLog(database, Date.now);
		Object.freeze(log);
		const key = randomBytes(32);
		let closed = false;
		const close = (): void => {
			if (closed) return;
			closed = true;
			key.fill(0);
		};
		const admit = (): void => {
			if (closed) throw new NativeEventPageError("UNAVAILABLE");
			try {
				assertHubSessionAdmission(session);
			} catch {
				close();
				throw new NativeEventPageError("UNAVAILABLE");
			}
		};
		return Object.freeze({
			close,
			read(peer: NativeDevicePeer, requestBytes: Uint8Array): NativeEventPage {
				try {
					admit();
					const input = request(requestBytes);
					const captured = database.write<CapturedPage>((scope) => {
						const sql = database.sql(scope);
						const grant = authorizer.requirePeerDevice(sql, peer, "read");
						if (grant.userId !== grant.ownerUserId) throw new NativeEventPageError("UNAVAILABLE");
						const initial = {
							userId: grant.userId,
							deviceId: grant.deviceId,
							epoch: grant.epoch,
							after: input.after,
						};
						const binding = Buffer.from(
							canonicalize(["draftyak.events.v1", session.hid, initial.deviceId, initial.userId]),
						);
						const position = input.after === null ? undefined : unseal(key, binding, input.after);
						if (input.after !== null && position === undefined)
							return { ...initial, afterSeq: 0, reset: "resync_required" };
						if (position && position.epoch !== initial.epoch)
							return { ...initial, afterSeq: position.seq, reset: "epoch_changed" };
						const afterSeq = position?.seq ?? 0;
						let page: EventPage;
						try {
							page = log.page(scope, {
								userId: initial.userId,
								afterSeq,
								limit: input.after === null ? 1 : EVENT_PAGE_SIZE,
							});
						} catch (error) {
							if (position && error instanceof WorkError && error.code === "input")
								return { ...initial, afterSeq, reset: "resync_required" };
							throw error;
						}
						return input.after !== null && page.resyncRequired
							? { ...initial, afterSeq, reset: "cursor_expired" }
							: { ...initial, afterSeq, page };
					});
					// WorkDatabase's final no-op write has now completed; no scope or grant escaped it.
					return store.read((db) => {
						const before = readStamp(db);
						const binding = Buffer.from(
							canonicalize(["draftyak.events.v1", session.hid, captured.deviceId, captured.userId]),
						);
						const cursors = new Map<number, string>();
						if (captured.after !== null) cursors.set(captured.afterSeq, captured.after);
						const cursor = (seq: number): string => {
							const known = cursors.get(seq);
							if (known !== undefined) return known;
							const value = seal(key, binding, captured.epoch, seq);
							cursors.set(seq, value);
							return value;
						};
						let result: NativeEventPage;
						if (captured.reset !== undefined) {
							result = Object.freeze({
								frames: Object.freeze([frame({ type: "reset", reason: captured.reset })]),
								nextCursor: null,
								more: false,
							});
						} else {
							const page = captured.page;
							if (!page) throw new NativeEventPageError("UNAVAILABLE");
							const start = captured.after === null ? page.lastSeq : captured.afterSeq;
							const frames: EventFrame[] = [frame({ type: "ready", cursor: cursor(start) })];
							if (captured.after !== null) {
								for (const event of page.events) {
									if (
										event.userId !== captured.userId ||
										!DataClass.safeParse(event.dataClass).success ||
										![...event.dataClass].every((value) => {
											const code = value.codePointAt(0) ?? 0;
											return code >= 0x21 && code <= 0x7e;
										})
									)
										throw new NativeEventPageError("UNAVAILABLE");
									if (event.dataClass === "credentials") continue;
									if (
										event.accountId !== null &&
										!ownedAccount(db, event.accountId, captured.userId)
									)
										continue;
									frames.push(
										frame({
											type: "event",
											cursor: cursor(event.seq),
											kind: event.kind,
											ids: event.ids,
										}),
									);
								}
							}
							result = Object.freeze({
								frames: Object.freeze(frames),
								nextCursor: cursor(captured.after === null ? page.lastSeq : page.nextSeq),
								more: captured.after !== null && page.more,
							});
						}
						// Acquire current rights only after all page writes and account reads.
						const grant = authorizer.requirePeerDevice(db, peer, "read");
						if (
							grant.userId !== grant.ownerUserId ||
							grant.userId !== captured.userId ||
							grant.deviceId !== captured.deviceId ||
							grant.epoch !== captured.epoch
						)
							throw new NativeEventPageError("UNAVAILABLE");
						authorizer.assertCurrentGrant(db, grant);
						admit();
						if (!sameReadStamp(before, readStamp(db)))
							throw new NativeEventPageError("UNAVAILABLE");
						return result;
					});
				} catch (error) {
					admit();
					throw failure(error);
				}
			},
		});
	} catch (error) {
		throw failure(error);
	}
}
