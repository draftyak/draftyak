import { argon2, createHash, randomBytes, timingSafeEqual } from "node:crypto";
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

/** Trusted native wall clock; M2.7's eventual Clock can satisfy this structurally. */
export interface PinWallClock {
	wallMs(): number;
}
const systemWallClock: PinWallClock = Object.freeze({ wallMs: () => Date.now() });
const utcMs = (value: number): number => UtcMs.parse(value);
// Proof lifetimes and lockouts use this process's monotonic clock, never a caller-supplied one.
const monotonicMs = (): number => performance.now();

interface PinRow {
	salt: Buffer;
	hash: Buffer;
	version: number;
	failures: number;
	locked_until: number;
}
interface Authorization {
	user: string;
	scope: string;
	version: number;
	wall: number;
	mono: number;
	material: Buffer;
}
interface InitialPin {
	user: string;
	salt: Buffer;
	hash: Buffer;
	wall: number;
	mono: number;
}
interface LockClock {
	until: number;
	mono: number;
}
export interface PinInitialization {
	readonly __pinInitialization: never;
}
export interface PinProof {
	readonly __pinProof: never;
}
type PinErrorCode = "PIN_REQUIRED" | "PIN_LOCKED" | "PIN_INVALID" | "PIN_CHANGED" | "PIN_BUSY";
export class PinError extends Error {
	readonly code: PinErrorCode;
	constructor(code: PinErrorCode) {
		super(code);
		this.code = code;
	}
}
const pinFailure = (error: unknown): PinError =>
	error instanceof PinError ? error : new PinError("PIN_REQUIRED");
function readClocks(clock: PinWallClock): { wall: number; mono: number } {
	const wall = utcMs(clock.wallMs());
	const mono = monotonicMs();
	if (!Number.isFinite(mono) || mono < 0 || mono > Number.MAX_SAFE_INTEGER)
		throw new PinError("PIN_REQUIRED");
	return { wall, mono };
}
const validPin = (pin: unknown): pin is string =>
	typeof pin === "string" &&
	pin.length >= 6 &&
	pin.length <= 64 &&
	/^[0-9]+$/.exec(pin)?.[0] === pin;
const validUser = (user: unknown): user is string =>
	typeof user === "string" && Ulid.safeParse(user).success;
const validScope = (scope: unknown): scope is string =>
	typeof scope === "string" &&
	scope.length <= 160 &&
	/^[a-z][a-z0-9.:-]*$/.exec(scope)?.[0] === scope;
const readStore = HubStore.prototype.read;
const writeStore = HubStore.prototype.write;
const appendAudit = AuditChain.prototype.append;
const PIN_ROW = `SELECT
	CASE WHEN typeof(salt)='blob' AND length(salt)=16 AND typeof(hash)='blob' AND length(hash)=32 AND
		typeof(version)='integer' AND version BETWEEN 1 AND 9007199254740991 AND
		typeof(failures)='integer' AND failures BETWEEN 0 AND 5 AND
		typeof(locked_until)='integer' AND locked_until BETWEEN 0 AND 9007199254740991
	THEN 1 ELSE 0 END AS valid,
	CASE WHEN typeof(salt)='blob' AND length(salt)=16 THEN salt ELSE NULL END AS salt,
	CASE WHEN typeof(hash)='blob' AND length(hash)=32 THEN hash ELSE NULL END AS hash,
	CASE WHEN typeof(version)='integer' THEN version ELSE 0 END AS version,
	CASE WHEN typeof(failures)='integer' THEN failures ELSE 0 END AS failures,
	CASE WHEN typeof(locked_until)='integer' THEN locked_until ELSE 0 END AS locked_until
	FROM main.approval_pins WHERE user_id=?`;
function readPin(db: SqlReader, user: string): PinRow | undefined {
	const row = db.get<PinRow & { valid: number }>(PIN_ROW, [user]);
	if (row && row.valid !== 1) {
		if (Buffer.isBuffer(row.hash)) row.hash.fill(0);
		if (Buffer.isBuffer(row.salt)) row.salt.fill(0);
		throw new PinError("PIN_CHANGED");
	}
	return row;
}
const materialDigest = (row: Pick<PinRow, "salt" | "hash" | "version">): Buffer =>
	createHash("sha256")
		.update("draftyak/pin-proof/v1\n")
		.update(row.salt)
		.update(row.hash)
		.update(String(row.version), "ascii")
		.digest();
const MAX_PROOFS = 128;
const PROOF_TTL = 30_000;
const LOCK_MS = 15 * 60_000;

async function hashPin(pin: string, salt: Uint8Array): Promise<Buffer> {
	const input = Buffer.from(pin, "utf8");
	try {
		return await new Promise<Buffer>((resolve, reject) => {
			argon2(
				"argon2id",
				{ message: input, nonce: salt, parallelism: 4, tagLength: 32, memory: 65_536, passes: 3 },
				(error, result) => (error ? reject(error) : resolve(result)),
			);
		});
	} finally {
		input.fill(0);
	}
}

export class PinService {
	readonly #store: HubStore;
	readonly #audit: AuditChain;
	readonly #clock: PinWallClock;
	readonly #proofs = new Map<PinProof, Authorization>();
	readonly #initial = new Map<PinInitialization, InitialPin>();
	readonly #unrecorded = new Set<string>();
	readonly #locks = new Map<string, LockClock>();
	#inFlight = 0;
	#locked = false;
	constructor(store: HubStore, audit: AuditChain, clock: PinWallClock = systemWallClock) {
		// The captured native method requires the real HubStore private brand before any KDF.
		try {
			if (types.isProxy(store)) throw new PinError("PIN_REQUIRED");
			readStore.call(store, (db: SqlReader) =>
				db.get("SELECT singleton FROM main.hub_meta WHERE singleton=1"),
			);
		} catch (error) {
			throw pinFailure(error);
		}
		this.#store = store;
		this.#audit = audit;
		this.#clock = clock;
	}
	async initialize(user: string, pin: string): Promise<void> {
		const prepared = await this.prepareInitialization(user, pin);
		try {
			writeStore.call(this.#store, (tx: SqlTransaction) => this.install(tx, prepared, user));
		} finally {
			this.discard(prepared);
		}
	}
	async prepareInitialization(user: string, pin: string): Promise<PinInitialization> {
		if (this.#locked) throw new PinError("PIN_REQUIRED");
		if (!validUser(user)) throw new PinError("PIN_INVALID");
		if (!validPin(pin)) throw new PinError("PIN_INVALID");
		this.#sweep();
		if (this.#inFlight >= 4 || this.#initial.size >= 16) throw new PinError("PIN_BUSY");
		this.#inFlight++;
		let salt: Buffer | undefined;
		let hash: Buffer | undefined;
		try {
			salt = randomBytes(16);
			hash = await hashPin(pin, salt);
			if (this.#locked) throw new PinError("PIN_REQUIRED");
			readStore.call(this.#store, (db: SqlReader) =>
				db.get("SELECT singleton FROM main.hub_meta WHERE singleton=1"),
			);
			if (this.#initial.size >= 16) throw new PinError("PIN_BUSY");
			const prepared = Object.freeze(Object.create(null)) as PinInitialization;
			this.#initial.set(prepared, {
				user,
				salt,
				hash,
				...readClocks(this.#clock),
			});
			return prepared;
		} catch (error) {
			salt?.fill(0);
			hash?.fill(0);
			throw pinFailure(error);
		} finally {
			this.#inFlight--;
		}
	}
	// A trusted native owner composes this with its authorized operation in this store's transaction.
	install(tx: SqlTransaction, prepared: PinInitialization, user: string): void {
		assertStoreTransaction(this.#store, tx);
		const record = this.#initial.get(prepared);
		this.#initial.delete(prepared);
		if (!record) throw new PinError("PIN_REQUIRED");
		try {
			if (this.#locked || record.user !== user || !this.#fresh(record))
				throw new PinError("PIN_REQUIRED");
			if (tx.get("SELECT 1 FROM main.approval_pins WHERE user_id=?", [user]))
				throw new PinError("PIN_CHANGED");
			tx.run("INSERT INTO main.approval_pins(user_id,salt,hash) VALUES(?,?,?)", [
				user,
				record.salt,
				record.hash,
			]);
			appendAudit.call(this.#audit, tx, {
				id: newId(),
				at: utcMs(this.#clock.wallMs()),
				action: "pin.initialized",
				actor: { kind: "hub", id: null },
				refs: { user },
			});
		} catch (error) {
			throw pinFailure(error);
		} finally {
			record.hash.fill(0);
			record.salt.fill(0);
		}
	}
	async verify(user: string, pin: string, scope: string): Promise<PinProof> {
		if (this.#locked) throw new PinError("PIN_REQUIRED");
		if (!validUser(user)) throw new PinError("PIN_INVALID");
		if (!validScope(scope)) throw new PinError("PIN_INVALID");
		this.#sweep();
		if (this.#inFlight >= 4 || this.#proofs.size >= MAX_PROOFS) throw new PinError("PIN_BUSY");
		this.#inFlight++;
		let initial: PinRow | undefined;
		let derived: Buffer | undefined;
		try {
			initial = readStore.call(this.#store, (db: SqlReader) => readPin(db, user)) as
				| PinRow
				| undefined;
			if (!initial) throw new PinError("PIN_REQUIRED");
			const original = initial;
			if (this.#held(user, initial.locked_until, readClocks(this.#clock)))
				throw new PinError("PIN_LOCKED");
			derived = validPin(pin) ? await hashPin(pin, initial.salt) : undefined;
			if (this.#locked) throw new PinError("PIN_REQUIRED");
			if (this.#proofs.size >= MAX_PROOFS) throw new PinError("PIN_BUSY");
			const matches = derived !== undefined && timingSafeEqual(derived, initial.hash);
			const pending = this.#unrecorded.has(user);
			let recorded = false;
			let locked: LockClock | undefined;
			let outcome: "PIN_CHANGED" | "PIN_LOCKED" | "PIN_INVALID" | null;
			try {
				outcome = writeStore.call(this.#store, (tx: SqlTransaction) => {
					const now = readClocks(this.#clock);
					const row = readPin(tx, user);
					if (!row) return "PIN_CHANGED" as const;
					try {
						if (
							row.version !== original.version ||
							!timingSafeEqual(row.hash, original.hash) ||
							!timingSafeEqual(row.salt, original.salt)
						)
							return "PIN_CHANGED" as const;
						if (this.#held(user, row.locked_until, now)) return "PIN_LOCKED" as const;
						const failures = row.locked_until > 0 ? 0 : row.failures;
						// A match runs the same update and append, so it commits only where a failure would.
						const attempt = (prior: number, failed: boolean) => {
							const count = prior + 1;
							const lock = count >= 5 ? utcMs(now.wall + LOCK_MS) : 0;
							tx.run(
								"UPDATE main.approval_pins SET failures=?,locked_until=? WHERE user_id=? AND version=?",
								failed ? [count, lock, user, row.version] : [0, 0, user, row.version],
							);
							locked = failed && count >= 5 ? { until: lock, mono: now.mono + LOCK_MS } : undefined;
							appendAudit.call(this.#audit, tx, {
								id: newId(),
								at: now.wall,
								action: !failed ? "pin.verified" : count >= 5 ? "pin.locked" : "pin.failed",
								actor: { kind: "hub", id: null },
								refs: { user },
							});
							if (!failed) return null;
							return count >= 5 ? ("PIN_LOCKED" as const) : ("PIN_INVALID" as const);
						};
						if (!pending) return attempt(failures, !matches);
						// A failure this service could not record is written first, in the same transaction.
						const first = attempt(failures, true);
						recorded = true;
						return first === "PIN_LOCKED" ? first : attempt(failures + 1, !matches);
					} finally {
						row.hash.fill(0);
						row.salt.fill(0);
					}
				}) as "PIN_CHANGED" | "PIN_LOCKED" | "PIN_INVALID" | null;
			} catch (error) {
				// An unrecorded wrong PIN stays pending until a committed write records it.
				if (!matches) this.#unrecorded.add(user);
				throw error;
			}
			if (recorded) this.#unrecorded.delete(user);
			if (locked) this.#locks.set(user, locked);
			if (outcome !== null) throw new PinError(outcome);
			const proof = Object.freeze(Object.create(null)) as PinProof;
			this.#proofs.set(proof, {
				user,
				scope,
				version: initial.version,
				...readClocks(this.#clock),
				material: materialDigest(initial),
			});
			return proof;
		} catch (error) {
			throw pinFailure(error);
		} finally {
			this.#inFlight--;
			derived?.fill(0);
			initial?.hash.fill(0);
			initial?.salt.fill(0);
		}
	}
	consume(tx: SqlTransaction, proof: PinProof, user: string, scope: string): void {
		assertStoreTransaction(this.#store, tx);
		const record = this.#proofs.get(proof);
		this.#proofs.delete(proof);
		if (!record) throw new PinError("PIN_REQUIRED");
		try {
			if (this.#locked || record.user !== user || record.scope !== scope || !this.#fresh(record))
				throw new PinError("PIN_REQUIRED");
			const row = readPin(tx, user);
			if (!row) throw new PinError("PIN_CHANGED");
			let material: Buffer | undefined;
			try {
				material = materialDigest(row);
				// The proof's own verification cleared any lock, so a lock now was set after it.
				if (
					row.version !== record.version ||
					!timingSafeEqual(material, record.material) ||
					row.locked_until !== 0
				)
					throw new PinError("PIN_CHANGED");
			} finally {
				material?.fill(0);
				row.hash.fill(0);
				row.salt.fill(0);
			}
		} catch (error) {
			throw pinFailure(error);
		} finally {
			record.material.fill(0);
		}
	}
	discard(proof: PinProof | PinInitialization): void {
		this.#proofs.get(proof as PinProof)?.material.fill(0);
		this.#proofs.delete(proof as PinProof);
		const initial = this.#initial.get(proof as PinInitialization);
		if (initial) {
			initial.hash.fill(0);
			initial.salt.fill(0);
			this.#initial.delete(proof as PinInitialization);
		}
	}
	#fresh(record: Pick<Authorization, "wall" | "mono">): boolean {
		try {
			const now = readClocks(this.#clock);
			const wall = now.wall - record.wall;
			const mono = now.mono - record.mono;
			return wall >= 0 && wall <= PROOF_TTL && mono >= 0 && mono <= PROOF_TTL;
		} catch {
			return false;
		}
	}
	// A lock this service wrote lasts LOCK_MS of monotonic time. Any other lock (another connection,
	// or from before a restart) keeps its persisted deadline's remaining wall time, at most LOCK_MS.
	#held(user: string, until: number, now: { wall: number; mono: number }): boolean {
		let lock = this.#locks.get(user);
		if (lock?.until !== until) {
			lock = { until, mono: now.mono + Math.min(until - now.wall, LOCK_MS) };
			this.#locks.set(user, lock);
		}
		return now.mono < lock.mono;
	}
	#sweep(): void {
		for (const [proof, record] of this.#proofs)
			if (!this.#fresh(record)) {
				record.material.fill(0);
				this.#proofs.delete(proof);
			}
		for (const [proof, record] of this.#initial) {
			if (!this.#fresh(record)) {
				record.hash.fill(0);
				record.salt.fill(0);
				this.#initial.delete(proof);
			}
		}
	}
	lock(): void {
		this.#locked = true;
		for (const record of this.#proofs.values()) record.material.fill(0);
		this.#proofs.clear();
		for (const record of this.#initial.values()) {
			record.hash.fill(0);
			record.salt.fill(0);
		}
		this.#initial.clear();
	}
}
