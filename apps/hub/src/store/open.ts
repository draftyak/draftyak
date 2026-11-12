import { createHash, timingSafeEqual } from "node:crypto";
import { closeSync, fstatSync, lstatSync, openSync } from "node:fs";
import path from "node:path";
import { types } from "node:util";
import Database from "better-sqlite3-multiple-ciphers";
import { MasterKey } from "../kernel/master-key.ts";

export type SqliteDatabase = Database.Database;
type DatabasePurpose = "db" | "backup" | `ext/${string}`;
export interface EncryptedKeyIdentity {
	readonly __encryptedKeyIdentity: never;
}
const identities = new WeakMap<
	EncryptedKeyIdentity,
	{ fingerprint?: Buffer; purpose?: DatabasePurpose; created?: boolean }
>();
const derive = MasterKey.prototype.derive;
const closeDatabase = Database.prototype.close;
// Failed initialization retains only its original native connection, never caller key authority.
let initialization: SqliteDatabase | undefined;
const initializationFailure = (): Error => new Error("Database initialization cleanup unavailable");
const isDatabaseClosed = (database: SqliteDatabase): boolean => database.open === false;
function closeInitialization(): void {
	const current = initialization;
	if (!current) return;
	try {
		if (isDatabaseClosed(current)) {
			initialization = undefined;
			return;
		}
	} catch {
		throw initializationFailure();
	}
	try {
		closeDatabase.call(current);
	} catch {
		/* Native close may fail before or after effect. The original object's state decides. */
	}
	try {
		if (!isDatabaseClosed(current)) throw initializationFailure();
	} catch {
		throw initializationFailure();
	}
	initialization = undefined;
}
interface Reservation {
	readonly descriptor: number;
	identity?: { readonly dev: bigint; readonly ino: bigint };
	attempted: boolean;
}
// At most one failed native reservation is held. It contains no key, filename or caller callback.
let reservation: Reservation | undefined;
interface CreationReservation {
	readonly filename: string;
	readonly dev: bigint;
	readonly ino: bigint;
}
// At most one failed exclusive creation can authorize an untouched retry in this process.
let creationReservation: CreationReservation | undefined;
const reservationFailure = (): Error => new Error("Database file reservation unavailable");
function closeReservation(): void {
	const current = reservation;
	if (!current) return;
	if (current.attempted) {
		try {
			const info = fstatSync(current.descriptor, { bigint: true });
			if (info.ino <= 0n || !current.identity || current.identity.ino <= 0n)
				throw reservationFailure();
			if (info.ino !== current.identity.ino || info.dev !== current.identity.dev) {
				reservation = undefined;
				return;
			}
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "EBADF") throw reservationFailure();
			reservation = undefined;
			return;
		}
	}
	current.attempted = true;
	try {
		closeSync(current.descriptor);
		reservation = undefined;
	} catch {
		throw reservationFailure();
	}
}
function reserveNewFile(filename: string): CreationReservation {
	if (reservation) throw reservationFailure();
	const descriptor = openSync(filename, "wx", 0o600);
	// Retain ownership before the first fstat or native close can fail.
	reservation = { descriptor, attempted: false };
	try {
		const info = fstatSync(descriptor, { bigint: true });
		if (info.ino > 0n) reservation.identity = { dev: info.dev, ino: info.ino };
		if (
			!info.isFile() ||
			info.isSymbolicLink() ||
			info.nlink !== 1n ||
			info.size !== 0n ||
			info.ino <= 0n
		)
			throw reservationFailure();
		closeReservation();
		return Object.freeze({ filename, dev: info.dev, ino: info.ino });
	} catch {
		try {
			closeReservation();
		} catch {
			/* Keep the bounded reservation quarantined for a later native open. */
		}
		throw reservationFailure();
	}
}
export function createEncryptedKeyIdentity(): EncryptedKeyIdentity {
	const identity = Object.freeze(Object.create(null)) as EncryptedKeyIdentity;
	identities.set(identity, {});
	return identity;
}
/** Consumes the successful native open's creation provenance; callers cannot set it. */
export function consumeCreatedEncryptedFile(identity: EncryptedKeyIdentity): boolean {
	const state = identities.get(identity);
	const created = state?.created === true;
	if (state) delete state.created;
	return created;
}
export function destroyEncryptedKeyIdentity(identity: EncryptedKeyIdentity): void {
	identities.get(identity)?.fingerprint?.fill(0);
	identities.delete(identity);
}
/** Native identity comparison only; no derived bytes or fingerprint leave this function. */
export function assertEncryptedKeyIdentity(identity: EncryptedKeyIdentity, key: MasterKey): void {
	let bytes: Buffer | undefined, fingerprint: Buffer | undefined;
	try {
		const state = identities.get(identity);
		if (!state?.fingerprint || !state.purpose || types.isProxy(key)) throw new Error();
		bytes = derive.call(key, state.purpose);
		fingerprint = createHash("sha256").update(bytes).digest();
		if (!timingSafeEqual(fingerprint, state.fingerprint)) throw new Error();
	} catch {
		throw new Error("Database key unavailable");
	} finally {
		bytes?.fill(0);
		fingerprint?.fill(0);
	}
}
export interface OpenOptions {
	readonly filename: string;
	readonly nativeBinding: string;
	readonly create?: boolean;
}
const SETTINGS = {
	cipher: "chacha20",
	journal_mode: "wal",
	synchronous: 2,
	fullfsync: 1,
	checkpoint_fullfsync: 1,
	busy_timeout: 5000,
	foreign_keys: 1,
	recursive_triggers: 1,
	secure_delete: 1,
	trusted_schema: 0,
	temp_store: 2,
	auto_vacuum: 2,
} as const;

export function assertSettings(db: SqliteDatabase): void {
	for (const [name, expected] of Object.entries(SETTINGS)) {
		if (db.pragma(name, { simple: true }) !== expected)
			throw new Error("Database settings were not confirmed");
	}
}

export function openEncrypted(
	options: OpenOptions,
	masterKey: MasterKey,
	purpose: DatabasePurpose = "db",
	identity?: EncryptedKeyIdentity,
): SqliteDatabase {
	const filename = options.filename,
		nativeBinding = options.nativeBinding,
		create = options.create === true;
	let created = false;
	if (
		!path.isAbsolute(filename) ||
		!path.isAbsolute(nativeBinding) ||
		path.extname(nativeBinding) !== ".node"
	)
		throw new Error("Absolute database and native binding paths are required");
	if (
		purpose !== "db" &&
		purpose !== "backup" &&
		(typeof purpose !== "string" ||
			purpose.length > 68 ||
			/^ext\/[a-z][a-z0-9-]{0,63}$/.exec(purpose)?.[0] !== purpose)
	)
		throw new Error("Unknown database key purpose");
	if (types.isProxy(masterKey)) throw new Error("Database key unavailable");
	const key = derive.call(masterKey, purpose);
	let db: SqliteDatabase | undefined;
	try {
		// Retry only the retained native resource before any requested-file lookup or allocation.
		closeInitialization();
		closeReservation();
		const state = identity === undefined ? undefined : identities.get(identity);
		if (identity !== undefined && (!state || state.fingerprint))
			throw new Error("Database key unavailable");
		if (state) {
			state.fingerprint = createHash("sha256").update(key).digest();
			state.purpose = purpose;
		}
		try {
			const stat = lstatSync(filename, { bigint: true });
			const owned = creationReservation?.filename === filename ? creationReservation : undefined;
			if (
				owned &&
				(!stat.isFile() ||
					stat.isSymbolicLink() ||
					stat.nlink !== 1n ||
					stat.size !== 0n ||
					stat.dev !== owned.dev ||
					stat.ino !== owned.ino)
			)
				creationReservation = undefined;
			if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1n)
				throw new Error("Existing database is invalid");
			if (stat.size === 0n) {
				if (!create)
					throw new Error(
						"Database was never initialized; remove this unused empty database before creating it again",
					);
				for (const suffix of ["-wal", "-shm"]) {
					try {
						lstatSync(`${filename}${suffix}`);
						throw new Error("Empty database has existing sidecars");
					} catch (error) {
						if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
					}
				}
				created =
					creationReservation?.filename === filename &&
					stat.dev === creationReservation.dev &&
					stat.ino === creationReservation.ino;
				if (!created)
					throw new Error(
						"Database was never initialized; remove this unused empty database before creating it again",
					);
			} else if (create) throw new Error("Database already exists");
		} catch (error) {
			if (
				(error as NodeJS.ErrnoException).code === "ENOENT" &&
				creationReservation?.filename === filename
			)
				creationReservation = undefined;
			if ((error as NodeJS.ErrnoException).code !== "ENOENT" || !create) throw error;
			// Exclusive creation also prevents initialization from overwriting another hub's file.
			creationReservation = reserveNewFile(filename);
			created = true;
		}
		db = new Database(filename, {
			nativeBinding: nativeBinding,
			fileMustExist: true,
		});
		db.pragma("cipher = 'chacha20'");
		db.key(key);
		// Applying the key does not verify it. This read must succeed before any schema write.
		db.prepare("SELECT count(*) FROM sqlite_master").get();
		// Request full-sync behavior before any opening-time configuration can write the file.
		db.pragma("fullfsync = ON");
		db.pragma("checkpoint_fullfsync = ON");
		db.pragma("temp_store = MEMORY");
		db.pragma("auto_vacuum = INCREMENTAL");
		db.pragma("journal_mode = WAL");
		db.pragma("synchronous = FULL");
		db.pragma("busy_timeout = 5000");
		db.pragma("foreign_keys = ON");
		db.pragma("recursive_triggers = ON");
		db.pragma("secure_delete = ON");
		db.pragma("trusted_schema = OFF");
		assertSettings(db);
		const reserved = (): never => {
			throw new Error("Connection configuration is reserved to the store");
		};
		// SQLite resolves overloads by arity. Disable every configuration form after open.
		db.function("sqlite3mc_config", (_name: unknown) => reserved());
		db.function("sqlite3mc_config", (_name: unknown, _value: unknown) => reserved());
		db.function("sqlite3mc_config", (_cipher: unknown, _name: unknown, _value: unknown) =>
			reserved(),
		);
		if (creationReservation?.filename === filename) {
			const current = lstatSync(filename, { bigint: true });
			created =
				created &&
				current.isFile() &&
				!current.isSymbolicLink() &&
				current.nlink === 1n &&
				current.dev === creationReservation.dev &&
				current.ino === creationReservation.ino;
			creationReservation = undefined;
		}
		if (state) state.created = created;
		return db;
	} catch (error) {
		if (identity !== undefined) destroyEncryptedKeyIdentity(identity);
		if (db) {
			initialization = db;
			closeInitialization();
		}
		throw error;
	} finally {
		if (creationReservation?.filename === filename) {
			try {
				const current = lstatSync(filename, { bigint: true });
				if (
					!current.isFile() ||
					current.isSymbolicLink() ||
					current.nlink !== 1n ||
					current.size !== 0n ||
					current.dev !== creationReservation.dev ||
					current.ino !== creationReservation.ino
				)
					creationReservation = undefined;
			} catch {
				creationReservation = undefined;
			}
		}
		key.fill(0);
	}
}
