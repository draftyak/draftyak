import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { addAbortListener } from "node:events";
import { types } from "node:util";
import { canonicalize } from "@draftyak/protocol/jcs";
import { Ulid, UtcMs } from "@draftyak/protocol/scalars";
import { AuditChain } from "../audit/chain.ts";
import { MAX_WAIT_MS, systemClock, type TimerClock } from "../kernel/clock.ts";
import { newId } from "../kernel/ids.ts";
import { MasterKey } from "../kernel/master-key.ts";
import {
	assertStoreTransaction,
	HubStore,
	type SqlReader,
	type SqlTransaction,
} from "../store/store.ts";

export type CredentialKind = "gmail-oauth" | "slack-token" | "slack-app-token" | "provider-key";
export type CredentialBinding =
	| {
			readonly ownerKind: "account";
			readonly ownerId: string;
			readonly kind: "gmail-oauth" | "slack-token" | "slack-app-token";
	  }
	| { readonly ownerKind: "provider"; readonly ownerId: string; readonly kind: "provider-key" };
export interface CredentialOwner {
	readonly ownerKind: "account" | "provider";
	readonly ownerId: string;
}
export type CredentialValue =
	| { readonly kind: "provider-key"; readonly key: string }
	| {
			readonly kind: "slack-token";
			readonly accessToken: string;
			readonly expiresAt: number | null;
	  }
	| { readonly kind: "slack-app-token"; readonly accessToken: string }
	| {
			readonly kind: "gmail-oauth";
			readonly accessToken: string;
			readonly refreshToken: string;
			readonly expiresAt: number;
	  };
/** Who made an already authorized change. Attribution only; it grants nothing. */
export type CredentialActor =
	| { readonly kind: "hub" | "cli"; readonly id: null }
	| { readonly kind: "device"; readonly id: string };
export interface CredentialDescriptor {
	readonly reference: string;
	readonly generation: number;
	readonly binding: CredentialBinding;
}
export interface CredentialUse extends CredentialDescriptor {
	readonly signal: AbortSignal;
}
export type CredentialRefresh = (
	value: CredentialValue,
	context: CredentialUse,
) => Promise<CredentialValue>;
export interface CredentialRequest {
	readonly requestClass: "read" | "send";
	readonly refresh?: CredentialRefresh;
	readonly signal?: AbortSignal;
	/** Read class only: refresh a value that expires within this many milliseconds. */
	readonly refreshAheadMs?: number;
}
export class CredentialError extends Error {
	readonly code = "CREDENTIAL_UNAVAILABLE";
	constructor() {
		super("Credential unavailable");
	}
}
export type CredentialRefreshFailure = "temporary" | "invalid_grant";
let refreshFailure: (error: unknown) => CredentialRefreshFailure | undefined = () => undefined;
/**
 * A refresh adapter throws this to classify its failure. "temporary" restores the previous value;
 * "invalid_grant" revokes the credential. Any other failure or the refresh time limit keeps the
 * credential unavailable until an authorized replacement, including after the store is reopened.
 */
export class CredentialRefreshError extends Error {
	readonly #failure: CredentialRefreshFailure;
	static {
		// A brand check reads no caller property and runs no proxy trap.
		refreshFailure = (error) =>
			typeof error === "object" && error !== null && #failure in error ? error.#failure : undefined;
	}
	constructor(failure: CredentialRefreshFailure) {
		super("Credential refresh failed");
		if (failure !== "temporary" && failure !== "invalid_grant")
			throw new TypeError("Unknown credential refresh failure");
		this.#failure = failure;
	}
	get failure(): CredentialRefreshFailure {
		return this.#failure;
	}
}
/** A refresh exchange that has not settled by then is abandoned and its caller fails. */
export const CREDENTIAL_REFRESH_TIMEOUT_MS = 30_000;
/** Below the shortest access token lifetime, so a fresh value never asks for another refresh. */
export const MAX_REFRESH_AHEAD_MS = 1_800_000;
const unavailable = (): CredentialError => new CredentialError();
const readStore = HubStore.prototype.read;
const writeStore = HubStore.prototype.write;
const assertStoreKey = HubStore.prototype.assertMasterKey;
const deriveKey = MasterKey.prototype.derive;
const appendAudit = AuditChain.prototype.append;
const verifyAudit = AuditChain.prototype.verify;
const MAX_VALUE_BYTES = 24576;
// Sealed values: version 1, a 12-byte nonce, a 16-byte tag, then the AES-256-GCM ciphertext.
const SEALED_VERSION = 1;
const SEALED_HEADER_BYTES = 29;
const MAX_SEALED_BYTES = SEALED_HEADER_BYTES + MAX_VALUE_BYTES;
const HUB_ACTOR: CredentialActor = Object.freeze({ kind: "hub", id: null });
interface SavedCredential {
	valid: number;
	owner_kind: string;
	owner_id: string;
	kind: CredentialKind;
	generation: number;
	status: string;
	value: Uint8Array | null;
}
const KINDS = "'gmail-oauth','slack-token','slack-app-token','provider-key'";
const STATUSES = "'active','refreshing','revoked','disconnected','deleted'";
const SEALED = `typeof(value)='blob' AND length(value) BETWEEN ${SEALED_HEADER_BYTES + 1} AND ${MAX_SEALED_BYTES}`;
const SELECT = `SELECT
	CASE WHEN typeof(owner_kind)='text' AND owner_kind IN ('account','provider') AND
		typeof(owner_id)='text' AND length(CAST(owner_id AS BLOB))=26 AND
		typeof(kind)='text' AND kind IN (${KINDS}) AND
		data_class IS (CASE WHEN kind IN ('slack-token','slack-app-token') THEN 'slack.metadata' ELSE 'credentials' END) AND
		typeof(generation)='integer' AND generation BETWEEN 1 AND 9007199254740991 AND
		((status='active' AND ${SEALED}) OR
		(status='refreshing' AND (value IS NULL OR ${SEALED})) OR
		(status IN ('revoked','disconnected','deleted') AND value IS NULL))
	THEN 1 ELSE 0 END AS valid,
	CASE WHEN owner_kind IN ('account','provider') THEN owner_kind ELSE NULL END AS owner_kind,
	CASE WHEN length(CAST(owner_id AS BLOB))=26 THEN owner_id ELSE NULL END AS owner_id,
	CASE WHEN kind IN (${KINDS}) THEN kind ELSE NULL END AS kind,
	CASE WHEN typeof(generation)='integer' THEN generation ELSE NULL END AS generation,
	CASE WHEN status IN (${STATUSES}) THEN status ELSE NULL END AS status,
	CASE WHEN ${SEALED} THEN value ELSE NULL END AS value
	FROM main.credentials WHERE id=?`;

// Shared even when native callers construct separate facades around the same store.
interface CredentialLock {
	readonly waiters: Set<() => void>;
}
interface Coordination {
	readonly locks: Map<string, CredentialLock>;
	readonly pending: Map<string, Set<AbortController>>;
	readonly using: WeakSet<AbortController>;
}
const coordinators = new WeakMap<HubStore, Coordination>();
const signalAborted = Object.getOwnPropertyDescriptor(AbortSignal.prototype, "aborted")?.get;
function captureSignal(input: unknown): AbortSignal {
	if (
		!input ||
		typeof input !== "object" ||
		types.isProxy(input) ||
		Object.getPrototypeOf(input) !== AbortSignal.prototype ||
		["aborted", "reason", "addEventListener", "removeEventListener"].some((name) =>
			Object.hasOwn(input, name),
		)
	)
		throw unavailable();
	// The native getter requires the actual signal brand without consulting caller properties.
	if (typeof signalAborted?.call(input) !== "boolean") throw unavailable();
	return input as AbortSignal;
}
interface VaultClock {
	readonly wall: () => number;
	readonly monotonic: () => number;
	readonly after: (ms: number, signal: AbortSignal) => Promise<void>;
}
function captureClock(input: TimerClock): VaultClock {
	if (!input || typeof input !== "object" || types.isProxy(input)) throw unavailable();
	const { wallMs, monotonicMs, after } = input;
	if (
		[wallMs, monotonicMs, after].some((item) => typeof item !== "function" || types.isProxy(item))
	)
		throw unavailable();
	return Object.freeze({
		wall: () => wallMs.call(input),
		monotonic: () => monotonicMs.call(input),
		after: (ms: number, signal: AbortSignal) => after.call(input, ms, signal),
	});
}
function cancellable<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
	return new Promise<T>((resolve, reject) => {
		const listener = addAbortListener(signal, () => reject(unavailable()));
		work.then(
			(value) => {
				listener[Symbol.dispose]();
				if (signal.aborted) reject(unavailable());
				else resolve(value);
			},
			(error: unknown) => {
				listener[Symbol.dispose]();
				reject(error);
			},
		);
	});
}
function record(input: unknown, keys: readonly string[]): Record<string, unknown> {
	if (
		!input ||
		typeof input !== "object" ||
		types.isProxy(input) ||
		![Object.prototype, null].includes(Object.getPrototypeOf(input)) ||
		Reflect.ownKeys(input).length !== keys.length
	)
		throw unavailable();
	const result: Record<string, unknown> = Object.create(null);
	for (const key of keys) {
		const descriptor = Object.getOwnPropertyDescriptor(input, key);
		if (!descriptor || !("value" in descriptor)) throw unavailable();
		result[key] = descriptor.value;
	}
	return result;
}
function binding(input: CredentialBinding): CredentialBinding {
	const value = record(input, ["ownerKind", "ownerId", "kind"]);
	if (
		!Ulid.safeParse(value.ownerId).success ||
		!(value.kind === "provider-key"
			? value.ownerKind === "provider"
			: (value.kind === "gmail-oauth" ||
					value.kind === "slack-token" ||
					value.kind === "slack-app-token") &&
				value.ownerKind === "account")
	)
		throw unavailable();
	return Object.freeze({
		ownerKind: value.ownerKind,
		ownerId: value.ownerId,
		kind: value.kind,
	}) as CredentialBinding;
}
function credentialOwner(input: CredentialOwner): CredentialOwner {
	const value = record(input, ["ownerKind", "ownerId"]);
	if (
		(value.ownerKind !== "account" && value.ownerKind !== "provider") ||
		!Ulid.safeParse(value.ownerId).success
	)
		throw unavailable();
	return Object.freeze({ ownerKind: value.ownerKind, ownerId: value.ownerId as string });
}
function auditActor(input: CredentialActor | undefined): CredentialActor {
	if (input === undefined) return HUB_ACTOR;
	const value = record(input, ["kind", "id"]);
	if ((value.kind === "hub" || value.kind === "cli") && value.id === null)
		return Object.freeze({ kind: value.kind, id: null });
	if (value.kind === "device" && Ulid.safeParse(value.id).success)
		return Object.freeze({ kind: "device", id: value.id as string });
	throw unavailable();
}
function secret(input: unknown): string {
	if (
		typeof input !== "string" ||
		input.length === 0 ||
		Buffer.byteLength(input) > 8192 ||
		/\p{Cc}/u.test(input)
	)
		throw unavailable();
	return input;
}
function credential(input: CredentialValue, expected: CredentialKind): CredentialValue {
	const keys =
		expected === "provider-key"
			? ["kind", "key"]
			: expected === "slack-app-token"
				? ["kind", "accessToken"]
				: expected === "slack-token"
					? ["kind", "accessToken", "expiresAt"]
					: ["kind", "accessToken", "refreshToken", "expiresAt"];
	const value = record(input, keys);
	if (value.kind !== expected) throw unavailable();
	if (expected === "provider-key") return Object.freeze({ kind: expected, key: secret(value.key) });
	const accessToken = secret(value.accessToken);
	if (expected === "slack-app-token") return Object.freeze({ kind: expected, accessToken });
	if (
		!(expected === "slack-token" && value.expiresAt === null) &&
		!UtcMs.safeParse(value.expiresAt).success
	)
		throw unavailable();
	if (expected === "slack-token")
		return Object.freeze({
			kind: expected,
			accessToken,
			expiresAt: value.expiresAt as number | null,
		});
	return Object.freeze({
		kind: expected,
		accessToken,
		refreshToken: secret(value.refreshToken),
		expiresAt: value.expiresAt as number,
	});
}
interface RequestOptions {
	readonly requestClass: "read" | "send";
	readonly refresh: CredentialRefresh | undefined;
	readonly signal: AbortSignal | undefined;
	readonly refreshAheadMs: number;
}
function requestOptions(input: CredentialRequest): RequestOptions {
	if (!input || typeof input !== "object" || types.isProxy(input)) throw unavailable();
	const keys = [
		"requestClass",
		...["refresh", "signal", "refreshAheadMs"].filter((key) => Object.hasOwn(input, key)),
	];
	const value = record(input, keys);
	const ahead = value.refreshAheadMs === undefined ? 0 : value.refreshAheadMs;
	if (
		(value.requestClass !== "read" && value.requestClass !== "send") ||
		(value.refresh !== undefined && typeof value.refresh !== "function") ||
		(value.refreshAheadMs !== undefined && value.requestClass !== "read") ||
		!Number.isSafeInteger(ahead) ||
		(ahead as number) < 0 ||
		(ahead as number) > MAX_REFRESH_AHEAD_MS
	)
		throw unavailable();
	return Object.freeze({
		requestClass: value.requestClass,
		refresh: value.refresh as CredentialRefresh | undefined,
		signal: value.signal === undefined ? undefined : captureSignal(value.signal),
		refreshAheadMs: ahead as number,
	});
}
const expiresWithin = (value: CredentialValue, now: number, ms: number): boolean =>
	(value.kind === "gmail-oauth" || value.kind === "slack-token") &&
	value.expiresAt !== null &&
	value.expiresAt <= now + ms;
// A fixed label and the canonical binding keep these tags apart from other uses of the subkey.
const sealingContext = (reference: string, owner: CredentialBinding, generation: number): Buffer =>
	Buffer.from(
		`draftyak/v1/credential-value\n${canonicalize({
			reference,
			ownerKind: owner.ownerKind,
			ownerId: owner.ownerId,
			kind: owner.kind,
			generation,
		})}`,
	);
function saved(db: SqlReader, reference: string, expected: CredentialBinding): SavedCredential {
	if (!Ulid.safeParse(reference).success) throw unavailable();
	const row = db.get<SavedCredential>(SELECT, [reference]);
	if (
		row?.valid !== 1 ||
		row.owner_kind !== expected.ownerKind ||
		row.owner_id !== expected.ownerId ||
		row.kind !== expected.kind
	)
		throw unavailable();
	return row;
}
const nextGeneration = (generation: number): number => {
	if (!Number.isSafeInteger(generation + 1)) throw unavailable();
	return generation + 1;
};

/**
 * Native persistence only. The account/admin owner must authorize lifecycle changes before these
 * calls. An unfinished refresh stays unavailable across store opens until authorized replacement.
 */
export class CredentialVault {
	readonly #store: HubStore;
	readonly #audit: AuditChain;
	readonly #clock: VaultClock;
	readonly #coordination: Coordination;
	readonly #exchanges = new Set<AbortController>();
	#masterKey: MasterKey | undefined;
	constructor(
		store: HubStore,
		audit: AuditChain,
		masterKey: MasterKey,
		clock: TimerClock = systemClock,
	) {
		let captured: VaultClock;
		try {
			if ([store, audit, masterKey, clock].some((item) => types.isProxy(item))) throw unavailable();
			assertStoreKey.call(store, masterKey);
			captured = captureClock(clock);
			readStore.call(store, (db: SqlReader) => {
				db.get("SELECT id,data_class,value FROM main.credentials LIMIT 1");
				verifyAudit.call(audit, db);
			});
			deriveKey.call(masterKey, "secrets").fill(0);
		} catch {
			throw unavailable();
		}
		this.#store = store;
		this.#audit = audit;
		this.#masterKey = masterKey;
		this.#clock = captured;
		const shared = coordinators.get(store);
		this.#coordination = shared ?? { locks: new Map(), pending: new Map(), using: new WeakSet() };
		if (!shared) coordinators.set(store, this.#coordination);
	}
	// Derived for each use and erased after it, so destroying the master key locks every facade.
	#subkey(): Buffer {
		const masterKey = this.#masterKey;
		if (!masterKey) throw unavailable();
		try {
			return deriveKey.call(masterKey, "secrets");
		} catch {
			throw unavailable();
		}
	}
	#unlocked(): void {
		this.#subkey().fill(0);
	}
	#now(): number {
		const at = this.#clock.wall();
		if (!UtcMs.safeParse(at).success || at > 0xffffffffffff) throw unavailable();
		return at;
	}
	#seal(
		reference: string,
		owner: CredentialBinding,
		generation: number,
		value: CredentialValue,
	): Buffer {
		const key = this.#subkey();
		let plain: Buffer | undefined;
		try {
			plain = Buffer.from(JSON.stringify(value), "utf8");
			if (plain.length > MAX_VALUE_BYTES) throw unavailable();
			const nonce = randomBytes(12);
			const cipher = createCipheriv("aes-256-gcm", key, nonce, { authTagLength: 16 });
			cipher.setAAD(sealingContext(reference, owner, generation));
			const sealed = Buffer.concat([cipher.update(plain), cipher.final()]);
			return Buffer.concat([Buffer.from([SEALED_VERSION]), nonce, cipher.getAuthTag(), sealed]);
		} finally {
			key.fill(0);
			plain?.fill(0);
		}
	}
	#open(row: SavedCredential, reference: string, owner: CredentialBinding): CredentialValue {
		if (row.status !== "active" || !types.isUint8Array(row.value)) throw unavailable();
		return this.#unseal(row.value, reference, owner, row.generation);
	}
	#unseal(
		value: Uint8Array,
		reference: string,
		owner: CredentialBinding,
		generation: number,
	): CredentialValue {
		const sealed = Buffer.from(value);
		if (
			sealed.length <= SEALED_HEADER_BYTES ||
			sealed.length > MAX_SEALED_BYTES ||
			sealed[0] !== SEALED_VERSION
		)
			throw unavailable();
		const key = this.#subkey();
		let first: Buffer | undefined;
		let last: Buffer | undefined;
		let plain: Buffer | undefined;
		try {
			const decipher = createDecipheriv("aes-256-gcm", key, sealed.subarray(1, 13), {
				authTagLength: 16,
			});
			decipher.setAAD(sealingContext(reference, owner, generation));
			decipher.setAuthTag(sealed.subarray(13, SEALED_HEADER_BYTES));
			first = decipher.update(sealed.subarray(SEALED_HEADER_BYTES));
			last = decipher.final();
			plain = Buffer.concat([first, last]);
			return credential(JSON.parse(plain.toString("utf8")), owner.kind);
		} finally {
			key.fill(0);
			first?.fill(0);
			last?.fill(0);
			plain?.fill(0);
		}
	}
	#auditChange(
		tx: SqlTransaction,
		reference: string,
		owner: CredentialOwner,
		action: string,
		actor: CredentialActor,
	): void {
		const at = this.#now();
		appendAudit.call(this.#audit, tx, {
			id: newId(at),
			at,
			action,
			actor,
			refs: { credential: reference, [owner.ownerKind]: owner.ownerId },
		});
	}
	#abort(reference: string): void {
		for (const controller of this.#coordination.pending.get(reference) ?? []) controller.abort();
	}
	#abortUses(reference: string): void {
		for (const controller of this.#coordination.pending.get(reference) ?? [])
			if (this.#coordination.using.has(controller)) controller.abort();
	}
	#abortWaiters(reference: string): void {
		for (const controller of this.#coordination.pending.get(reference) ?? [])
			if (!this.#coordination.using.has(controller)) controller.abort();
	}
	#track(reference: string): AbortController {
		const controller = new AbortController();
		let pending = this.#coordination.pending.get(reference);
		if (!pending) {
			pending = new Set();
			this.#coordination.pending.set(reference, pending);
		}
		pending.add(controller);
		return controller;
	}
	#untrack(reference: string, controller: AbortController): void {
		const pending = this.#coordination.pending.get(reference);
		pending?.delete(controller);
		if (pending?.size === 0) this.#coordination.pending.delete(reference);
	}
	// Puts the value a refresh kept back in use under the next generation. Callers still waiting on
	// that refresh fail with it; uses already running on that value go on.
	#restoreKept(
		tx: SqlTransaction,
		reference: string,
		bound: CredentialBinding,
		row: SavedCredential,
	): void {
		if (row.status !== "refreshing" || !types.isUint8Array(row.value)) throw unavailable();
		const generation = nextGeneration(row.generation),
			sealed = this.#seal(
				reference,
				bound,
				generation,
				this.#unseal(row.value, reference, bound, row.generation),
			);
		if (
			tx.run(
				"UPDATE main.credentials SET generation=?,status='active',value=? WHERE id=? AND generation=? AND status='refreshing'",
				[generation, sealed, reference, row.generation],
			).changes !== 1
		)
			throw unavailable();
		this.#abortWaiters(reference);
		this.#auditChange(tx, reference, bound, "credential.restored", HUB_ACTOR);
	}
	#refreshFailed(
		reference: string,
		bound: CredentialBinding,
		generation: number,
		failure: CredentialRefreshFailure,
	): void {
		try {
			writeStore.call(this.#store, (tx: SqlTransaction) => {
				const row = saved(tx, reference, bound);
				if (row.status !== "refreshing" || row.generation !== generation) throw unavailable();
				if (failure === "temporary") {
					this.#restoreKept(tx, reference, bound, row);
					return;
				}
				if (
					tx.run(
						"UPDATE main.credentials SET generation=?,status='revoked',value=NULL WHERE id=? AND generation=? AND status='refreshing'",
						[nextGeneration(generation), reference, generation],
					).changes !== 1
				)
					throw unavailable();
				this.#abort(reference);
				this.#auditChange(tx, reference, bound, "credential.revoked", HUB_ACTOR);
			});
		} catch {
			// A failed recovery commit stays unavailable, including after a later store open.
		}
	}
	createInTransaction(
		tx: SqlTransaction,
		owner: CredentialBinding,
		value: CredentialValue,
		actor?: CredentialActor,
	): string {
		try {
			this.#unlocked();
			assertStoreTransaction(this.#store, tx);
			const bound = binding(owner),
				checked = credential(value, bound.kind),
				by = auditActor(actor),
				reference = newId();
			tx.run(
				"INSERT INTO main.credentials(id,owner_kind,owner_id,kind,generation,status,value) VALUES(?,?,?,?,1,'active',?)",
				[
					reference,
					bound.ownerKind,
					bound.ownerId,
					bound.kind,
					this.#seal(reference, bound, 1, checked),
				],
			);
			this.#auditChange(tx, reference, bound, "credential.created", by);
			return reference;
		} catch {
			throw unavailable();
		}
	}
	replaceInTransaction(
		tx: SqlTransaction,
		reference: string,
		owner: CredentialBinding,
		value: CredentialValue,
		actor?: CredentialActor,
	): void {
		try {
			this.#unlocked();
			assertStoreTransaction(this.#store, tx);
			const bound = binding(owner),
				checked = credential(value, bound.kind),
				by = auditActor(actor),
				row = saved(tx, reference, bound);
			if (row.status === "deleted") throw unavailable();
			const generation = nextGeneration(row.generation),
				sealed = this.#seal(reference, bound, generation, checked);
			this.#abort(reference);
			if (
				tx.run(
					"UPDATE main.credentials SET generation=?,status='active',value=? WHERE id=? AND generation=?",
					[generation, sealed, reference, row.generation],
				).changes !== 1
			)
				throw unavailable();
			this.#auditChange(tx, reference, bound, "credential.replaced", by);
		} catch {
			throw unavailable();
		}
	}
	invalidateInTransaction(
		tx: SqlTransaction,
		reference: string,
		owner: CredentialBinding,
		reason: "revoke" | "disconnect" | "delete",
		actor?: CredentialActor,
	): void {
		try {
			this.#unlocked();
			assertStoreTransaction(this.#store, tx);
			const status =
				reason === "revoke"
					? "revoked"
					: reason === "disconnect"
						? "disconnected"
						: reason === "delete"
							? "deleted"
							: undefined;
			if (!status) throw unavailable();
			const bound = binding(owner),
				by = auditActor(actor),
				row = saved(tx, reference, bound);
			if (row.status === "deleted") throw unavailable();
			const generation = nextGeneration(row.generation);
			this.#abort(reference);
			if (
				tx.run(
					"UPDATE main.credentials SET generation=?,status=?,value=NULL WHERE id=? AND generation=?",
					[generation, status, reference, row.generation],
				).changes !== 1
			)
				throw unavailable();
			this.#auditChange(tx, reference, bound, `credential.${status}`, by);
		} catch {
			throw unavailable();
		}
	}
	/** Removes the row in any state; pending uses and refreshes of it fail. */
	purgeInTransaction(
		tx: SqlTransaction,
		reference: string,
		owner: CredentialBinding,
		actor?: CredentialActor,
	): void {
		try {
			this.#unlocked();
			assertStoreTransaction(this.#store, tx);
			const bound = binding(owner),
				by = auditActor(actor),
				row = saved(tx, reference, bound);
			this.#abort(reference);
			if (
				tx.run("DELETE FROM main.credentials WHERE id=? AND generation=?", [
					reference,
					row.generation,
				]).changes !== 1
			)
				throw unavailable();
			this.#auditChange(tx, reference, bound, "credential.purged", by);
		} catch {
			throw unavailable();
		}
	}
	/** Removes every credential row of one owner, in any state, and returns how many it removed. */
	purgeOwnerInTransaction(
		tx: SqlTransaction,
		owner: CredentialOwner,
		actor?: CredentialActor,
	): number {
		try {
			this.#unlocked();
			assertStoreTransaction(this.#store, tx);
			const bound = credentialOwner(owner),
				by = auditActor(actor);
			const rows = tx.all<{ id: unknown }>(
				"SELECT CASE WHEN typeof(id)='text' AND length(CAST(id AS BLOB))=26 THEN id ELSE NULL END AS id FROM main.credentials WHERE owner_kind=? AND owner_id=? ORDER BY id",
				[bound.ownerKind, bound.ownerId],
			);
			for (const { id } of rows) {
				if (typeof id !== "string" || !Ulid.safeParse(id).success) throw unavailable();
				this.#abort(id);
				if (tx.run("DELETE FROM main.credentials WHERE id=?", [id]).changes !== 1)
					throw unavailable();
				this.#auditChange(tx, id, bound, "credential.purged", by);
			}
			return rows.length;
		} catch {
			throw unavailable();
		}
	}
	describe(reference: string, owner: CredentialBinding): CredentialDescriptor {
		try {
			this.#unlocked();
			const bound = binding(owner);
			const row = readStore.call(this.#store, (db: SqlReader) =>
				saved(db, reference, bound),
			) as SavedCredential;
			if (row.status !== "active") throw unavailable();
			return Object.freeze({ reference, generation: row.generation, binding: bound });
		} catch {
			throw unavailable();
		}
	}
	/** Native transaction composition; storage currentness does not grant account authority. */
	describeInTransaction(
		tx: SqlTransaction,
		reference: string,
		owner: CredentialBinding,
	): CredentialDescriptor {
		try {
			this.#unlocked();
			assertStoreTransaction(this.#store, tx);
			const bound = binding(owner),
				row = saved(tx, reference, bound);
			if (row.status !== "active") throw unavailable();
			return Object.freeze({ reference, generation: row.generation, binding: bound });
		} catch {
			throw unavailable();
		}
	}
	async #serialized<T>(reference: string, signal: AbortSignal, work: () => Promise<T>): Promise<T> {
		signal.throwIfAborted();
		let lock = this.#coordination.locks.get(reference);
		if (!lock) {
			lock = { waiters: new Set() };
			this.#coordination.locks.set(reference, lock);
		} else {
			const waitingOn = lock;
			await new Promise<void>((resolve, reject) => {
				const grant = () => {
					listener[Symbol.dispose]();
					resolve();
				};
				const listener = addAbortListener(signal, () => {
					waitingOn.waiters.delete(grant);
					reject(unavailable());
				});
				waitingOn.waiters.add(grant);
			});
		}
		try {
			signal.throwIfAborted();
			return await work();
		} finally {
			const next = lock.waiters.values().next().value;
			if (next) {
				lock.waiters.delete(next);
				next();
			} else this.#coordination.locks.delete(reference);
		}
	}
	// The exchange settles, is ended by a revoke, replacement or purge, or times out. A timed-out
	// exchange is aborted and no longer holds the credential's mutex; its late result is never
	// installed.
	async #exchange(
		refresh: CredentialRefresh,
		value: CredentialValue,
		context: CredentialUse,
		controller: AbortController,
	): Promise<CredentialValue> {
		const stop = new AbortController();
		void (async () => {
			try {
				const wall = this.#clock.wall(),
					monotonic = this.#clock.monotonic();
				for (;;) {
					const remaining = Math.min(
						wall + CREDENTIAL_REFRESH_TIMEOUT_MS - this.#clock.wall(),
						monotonic + CREDENTIAL_REFRESH_TIMEOUT_MS - this.#clock.monotonic(),
					);
					if (!Number.isFinite(remaining) || remaining <= 0) break;
					await this.#clock.after(Math.min(MAX_WAIT_MS, Math.ceil(remaining)), stop.signal);
				}
			} catch {
				// A failed clock ends the exchange as well.
			}
			if (!stop.signal.aborted) controller.abort();
		})();
		try {
			return await cancellable(
				new Promise<CredentialValue>((resolve) => resolve(refresh(value, context))),
				controller.signal,
			);
		} finally {
			stop.abort();
		}
	}
	async #prepare(
		reference: string,
		bound: CredentialBinding,
		request: RequestOptions,
		controller: AbortController,
	): Promise<{ value: CredentialValue; generation: number }> {
		controller.signal.throwIfAborted();
		let row = readStore.call(this.#store, (db: SqlReader) =>
			saved(db, reference, bound),
		) as SavedCredential;
		const value = this.#open(row, reference, bound);
		const refresh = request.requestClass === "read" ? request.refresh : undefined;
		const now = this.#now();
		if (!expiresWithin(value, now, refresh ? request.refreshAheadMs : 0))
			return { value, generation: row.generation };
		if (typeof refresh !== "function" || controller.signal.aborted) throw unavailable();
		const generation = nextGeneration(row.generation),
			kept = this.#seal(reference, bound, generation, value),
			expired = expiresWithin(value, now, 0);
		// The stale value moves to the next generation and stays sealed but unusable while the
		// exchange runs. Only a committed adapter-classified temporary failure restores it.
		// An interrupted or unknown result requires authorized replacement, even after reopening.
		// Uses already running on a value that has not expired go on; their own
		// generation check still applies.
		writeStore.call(this.#store, (tx: SqlTransaction) => {
			row = saved(tx, reference, bound);
			if (row.status !== "active" || row.generation + 1 !== generation) throw unavailable();
			if (
				tx.run(
					"UPDATE main.credentials SET generation=?,status='refreshing',value=? WHERE id=? AND generation=? AND status='active'",
					[generation, kept, reference, row.generation],
				).changes !== 1
			)
				throw unavailable();
			if (expired) this.#abortUses(reference);
			this.#auditChange(tx, reference, bound, "credential.refresh_started", HUB_ACTOR);
		});
		// The exchange has its own signal: a caller that stops waiting leaves the adapter to answer or
		// classify its failure, while the time limit, a revoke, a replacement or a purge ends it.
		const exchange = this.#track(reference);
		this.#exchanges.add(exchange);
		try {
			let returned: CredentialValue;
			try {
				returned = await this.#exchange(
					refresh,
					value,
					Object.freeze({ reference, binding: bound, generation, signal: exchange.signal }),
					exchange,
				);
			} catch (error) {
				const failure = refreshFailure(error);
				if (failure && !exchange.signal.aborted)
					this.#refreshFailed(reference, bound, generation, failure);
				throw unavailable();
			}
			const rotated = credential(returned, bound.kind);
			if (exchange.signal.aborted || expiresWithin(rotated, this.#now(), 0)) throw unavailable();
			const sealed = this.#seal(reference, bound, generation, rotated);
			const assertRefreshing = (tx: SqlTransaction): void => {
				const current = saved(tx, reference, bound);
				if (
					current.status !== "refreshing" ||
					current.generation !== generation ||
					exchange.signal.aborted
				)
					throw unavailable();
			};
			// A valid answer drops the kept value first, so a save that fails stays closed across a
			// restart too.
			writeStore.call(this.#store, (tx: SqlTransaction) => {
				assertRefreshing(tx);
				if (
					tx.run(
						"UPDATE main.credentials SET value=NULL WHERE id=? AND generation=? AND status='refreshing'",
						[reference, generation],
					).changes !== 1
				)
					throw unavailable();
			});
			writeStore.call(this.#store, (tx: SqlTransaction) => {
				assertRefreshing(tx);
				if (
					tx.run(
						"UPDATE main.credentials SET status='active',value=? WHERE id=? AND generation=? AND status='refreshing'",
						[sealed, reference, generation],
					).changes !== 1
				)
					throw unavailable();
				this.#auditChange(tx, reference, bound, "credential.refreshed", HUB_ACTOR);
			});
			return { value: rotated, generation };
		} finally {
			this.#exchanges.delete(exchange);
			this.#untrack(reference, exchange);
		}
	}
	/** Trusted hub callback only; propagate its signal to network I/O and return brokered results. */
	async withCredential<T>(
		reference: string,
		owner: CredentialBinding,
		request: CredentialRequest,
		use: (value: CredentialValue, context: CredentialUse) => T | Promise<T>,
	): Promise<T> {
		let controller: AbortController | undefined;
		let external: Disposable | undefined;
		try {
			this.#unlocked();
			const bound = binding(owner);
			const options = requestOptions(request);
			if (!Ulid.safeParse(reference).success || typeof use !== "function") throw unavailable();
			controller = this.#track(reference);
			const currentController = controller;
			if (options.signal) {
				if (signalAborted?.call(options.signal)) controller.abort();
				external = addAbortListener(options.signal, () => currentController.abort());
			}
			const prepared = await cancellable(
				this.#serialized(reference, controller.signal, () =>
					this.#prepare(reference, bound, options, currentController),
				),
				controller.signal,
			);
			const context = Object.freeze({
				reference,
				binding: bound,
				generation: prepared.generation,
				signal: controller.signal,
			});
			this.#coordination.using.add(controller);
			const assertCurrent = () => {
				if (
					context.signal.aborted ||
					this.describe(reference, bound).generation !== context.generation
				)
					throw unavailable();
			};
			assertCurrent();
			const result = await cancellable(
				Promise.resolve(use(prepared.value, context)),
				controller.signal,
			);
			assertCurrent();
			return result;
		} catch {
			throw unavailable();
		} finally {
			external?.[Symbol.dispose]();
			if (controller) this.#untrack(reference, controller);
		}
	}
	/**
	 * Drops this facade's master key and ends its running refresh exchanges. Kept values stay
	 * sealed and unavailable until authorized replacement; every later call refuses.
	 */
	destroy(): void {
		this.#masterKey = undefined;
		for (const exchange of this.#exchanges) exchange.abort();
	}
	toJSON(): string {
		return "[REDACTED]";
	}
}
