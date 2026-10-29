import { addAbortListener } from "node:events";
import { types } from "node:util";
import { Ulid, UtcMs } from "@draftyak/protocol/scalars";
import { AuditChain } from "../audit/chain.ts";
import { newId } from "../kernel/ids.ts";
import {
	assertStoreTransaction,
	HubStore,
	type SqlReader,
	type SqlTransaction,
} from "../store/store.ts";

export type CredentialKind = "gmail-oauth" | "slack-token" | "provider-key";
export type CredentialBinding =
	| {
			readonly ownerKind: "account";
			readonly ownerId: string;
			readonly kind: "gmail-oauth" | "slack-token";
	  }
	| { readonly ownerKind: "provider"; readonly ownerId: string; readonly kind: "provider-key" };
export type CredentialValue =
	| { readonly kind: "provider-key"; readonly key: string }
	| {
			readonly kind: "slack-token";
			readonly accessToken: string;
			readonly expiresAt: number | null;
	  }
	| {
			readonly kind: "gmail-oauth";
			readonly accessToken: string;
			readonly refreshToken: string;
			readonly expiresAt: number;
	  };
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
}
export class CredentialError extends Error {
	readonly code = "CREDENTIAL_UNAVAILABLE";
	constructor() {
		super("Credential unavailable");
	}
}
const unavailable = (): CredentialError => new CredentialError();
const readStore = HubStore.prototype.read;
const writeStore = HubStore.prototype.write;
const appendAudit = AuditChain.prototype.append;
const verifyAudit = AuditChain.prototype.verify;
const MAX_VALUE_BYTES = 24576;
interface SavedCredential {
	valid: number;
	owner_kind: string;
	owner_id: string;
	kind: CredentialKind;
	generation: number;
	status: string;
	value: string | null;
}
const SELECT = `SELECT
	CASE WHEN typeof(owner_kind)='text' AND owner_kind IN ('account','provider') AND
		typeof(owner_id)='text' AND length(CAST(owner_id AS BLOB))=26 AND
		typeof(kind)='text' AND kind IN ('gmail-oauth','slack-token','provider-key') AND
		typeof(generation)='integer' AND generation BETWEEN 1 AND 9007199254740991 AND
		((status='active' AND typeof(value)='text' AND length(CAST(value AS BLOB)) BETWEEN 1 AND 24576) OR
		(status IN ('refreshing','revoked','disconnected','deleted') AND value IS NULL))
	THEN 1 ELSE 0 END AS valid,
	CASE WHEN owner_kind IN ('account','provider') THEN owner_kind ELSE NULL END AS owner_kind,
	CASE WHEN length(CAST(owner_id AS BLOB))=26 THEN owner_id ELSE NULL END AS owner_id,
	CASE WHEN kind IN ('gmail-oauth','slack-token','provider-key') THEN kind ELSE NULL END AS kind,
	generation, status,
	CASE WHEN typeof(value)='text' AND length(CAST(value AS BLOB)) BETWEEN 1 AND 24576 THEN value ELSE NULL END AS value
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
			: (value.kind === "gmail-oauth" || value.kind === "slack-token") &&
				value.ownerKind === "account")
	)
		throw unavailable();
	return Object.freeze({
		ownerKind: value.ownerKind,
		ownerId: value.ownerId,
		kind: value.kind,
	}) as CredentialBinding;
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
			: expected === "slack-token"
				? ["kind", "accessToken", "expiresAt"]
				: ["kind", "accessToken", "refreshToken", "expiresAt"];
	const value = record(input, keys);
	if (value.kind !== expected) throw unavailable();
	if (expected === "provider-key") return Object.freeze({ kind: expected, key: secret(value.key) });
	const accessToken = secret(value.accessToken);
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
function requestOptions(input: CredentialRequest): CredentialRequest {
	if (!input || typeof input !== "object" || types.isProxy(input)) throw unavailable();
	const keys = [
		"requestClass",
		...["refresh", "signal"].filter((key) => Object.hasOwn(input, key)),
	];
	const value = record(input, keys);
	if (
		(value.requestClass !== "read" && value.requestClass !== "send") ||
		(value.refresh !== undefined && typeof value.refresh !== "function")
	)
		throw unavailable();
	return Object.freeze({
		requestClass: value.requestClass,
		refresh: value.refresh,
		signal: value.signal === undefined ? undefined : captureSignal(value.signal),
	}) as CredentialRequest;
}
function encoded(value: CredentialValue): string {
	const text = JSON.stringify(value);
	if (Buffer.byteLength(text) > MAX_VALUE_BYTES) throw unavailable();
	return text;
}
const expired = (value: CredentialValue): boolean =>
	value.kind !== "provider-key" && value.expiresAt !== null && value.expiresAt <= Date.now();
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
function active(row: SavedCredential): CredentialValue {
	if (row.status !== "active" || row.value === null) throw unavailable();
	return credential(JSON.parse(row.value), row.kind);
}
const nextGeneration = (generation: number): number => {
	if (!Number.isSafeInteger(generation + 1)) throw unavailable();
	return generation + 1;
};

/** Native persistence only. The account/admin owner must authorize lifecycle changes before these calls. */
export class CredentialVault {
	readonly #store: HubStore;
	readonly #audit: AuditChain;
	readonly #coordination: Coordination;
	constructor(store: HubStore, audit: AuditChain) {
		try {
			if (types.isProxy(store) || types.isProxy(audit)) throw unavailable();
			readStore.call(store, (db: SqlReader) => {
				db.get("SELECT id FROM main.credentials LIMIT 1");
				verifyAudit.call(audit, db);
			});
		} catch {
			throw unavailable();
		}
		this.#store = store;
		this.#audit = audit;
		let coordination = coordinators.get(store);
		if (!coordination) {
			coordination = { locks: new Map(), pending: new Map(), using: new WeakSet() };
			coordinators.set(store, coordination);
		}
		this.#coordination = coordination;
	}
	#auditChange(
		tx: SqlTransaction,
		reference: string,
		owner: CredentialBinding,
		action: string,
	): void {
		appendAudit.call(this.#audit, tx, {
			id: newId(),
			at: Date.now(),
			action,
			actor: { kind: "hub", id: null },
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
	createInTransaction(
		tx: SqlTransaction,
		owner: CredentialBinding,
		value: CredentialValue,
	): string {
		try {
			assertStoreTransaction(this.#store, tx);
			const bound = binding(owner),
				payload = encoded(credential(value, bound.kind)),
				reference = newId();
			tx.run(
				"INSERT INTO main.credentials(id,owner_kind,owner_id,kind,generation,status,value) VALUES(?,?,?,?,1,'active',?)",
				[reference, bound.ownerKind, bound.ownerId, bound.kind, payload],
			);
			this.#auditChange(tx, reference, bound, "credential.created");
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
	): void {
		try {
			assertStoreTransaction(this.#store, tx);
			const bound = binding(owner),
				payload = encoded(credential(value, bound.kind)),
				row = saved(tx, reference, bound);
			if (row.status === "deleted") throw unavailable();
			this.#abort(reference);
			tx.run("UPDATE main.credentials SET generation=?,status='active',value=? WHERE id=?", [
				nextGeneration(row.generation),
				payload,
				reference,
			]);
			this.#auditChange(tx, reference, bound, "credential.replaced");
		} catch {
			throw unavailable();
		}
	}
	invalidateInTransaction(
		tx: SqlTransaction,
		reference: string,
		owner: CredentialBinding,
		reason: "revoke" | "disconnect" | "delete",
	): void {
		try {
			assertStoreTransaction(this.#store, tx);
			const status = { revoke: "revoked", disconnect: "disconnected", delete: "deleted" }[reason];
			if (!status) throw unavailable();
			const bound = binding(owner),
				row = saved(tx, reference, bound);
			if (row.status === "deleted") throw unavailable();
			this.#abort(reference);
			tx.run("UPDATE main.credentials SET generation=?,status=?,value=NULL WHERE id=?", [
				nextGeneration(row.generation),
				status,
				reference,
			]);
			this.#auditChange(tx, reference, bound, `credential.${status}`);
		} catch {
			throw unavailable();
		}
	}
	describe(reference: string, owner: CredentialBinding): CredentialDescriptor {
		try {
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
	async #prepare(
		reference: string,
		bound: CredentialBinding,
		request: CredentialRequest,
		controller: AbortController,
	): Promise<{ value: CredentialValue; generation: number }> {
		controller.signal.throwIfAborted();
		let row = readStore.call(this.#store, (db: SqlReader) =>
			saved(db, reference, bound),
		) as SavedCredential;
		let value = active(row);
		if (!expired(value)) return { value, generation: row.generation };
		if (
			request.requestClass === "send" ||
			typeof request.refresh !== "function" ||
			controller.signal.aborted
		)
			throw unavailable();
		const generation = nextGeneration(row.generation);
		// Consume stale authority durably before calling an exchange adapter. An interrupted or
		// failed rotation stays unavailable after restart until an authorized replacement.
		writeStore.call(this.#store, (tx: SqlTransaction) => {
			row = saved(tx, reference, bound);
			if (row.status !== "active" || row.generation + 1 !== generation) throw unavailable();
			tx.run("UPDATE main.credentials SET generation=?,status='refreshing',value=NULL WHERE id=?", [
				generation,
				reference,
			]);
			this.#abortUses(reference);
			this.#auditChange(tx, reference, bound, "credential.refresh_started");
		});
		value = credential(
			await request.refresh(
				value,
				Object.freeze({ reference, binding: bound, generation, signal: controller.signal }),
			),
			bound.kind,
		);
		if (controller.signal.aborted || expired(value)) throw unavailable();
		const payload = encoded(value);
		writeStore.call(this.#store, (tx: SqlTransaction) => {
			const current = saved(tx, reference, bound);
			if (
				current.status !== "refreshing" ||
				current.generation !== generation ||
				controller.signal.aborted
			)
				throw unavailable();
			tx.run(
				"UPDATE main.credentials SET status='active',value=? WHERE id=? AND generation=? AND status='refreshing'",
				[payload, reference, generation],
			);
			this.#auditChange(tx, reference, bound, "credential.refreshed");
		});
		return { value, generation };
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
	toJSON(): string {
		return "[REDACTED]";
	}
}
