import { types } from "node:util";
import Database from "better-sqlite3-multiple-ciphers";
import { auditHeadTag } from "../audit/head.ts";
import { MasterKey } from "../kernel/master-key.ts";
import {
	MigrationError,
	migrate,
	namesPragmaFunction,
	REFUSED_STATEMENTS,
	statementStarts,
} from "./migrator.ts";
import {
	assertEncryptedKeyIdentity,
	consumeCreatedEncryptedFile,
	createEncryptedKeyIdentity,
	destroyEncryptedKeyIdentity,
	type OpenOptions,
	openEncrypted,
	type SqliteDatabase,
} from "./open.ts";
import { bindReadStamp, releaseReadStamp } from "./read-stamp.ts";
import {
	expirePreMigrationSnapshots,
	removePreMigrationSnapshots,
	SnapshotError,
	type SnapshotOptions,
	type SnapshotSettings,
	snapshotSettings,
	takePreMigrationSnapshot,
} from "./snapshots.ts";

export type SqlValue = string | number | bigint | Uint8Array | null;
export interface SqlReader {
	get<T>(sql: string, bindings?: readonly SqlValue[]): T | undefined;
	all<T>(sql: string, bindings?: readonly SqlValue[]): T[];
}
export interface SqlTransaction extends SqlReader {
	run(
		sql: string,
		bindings?: readonly SqlValue[],
	): { changes: number; lastInsertRowid: number | bigint };
}
export interface StoreOptions extends OpenOptions {
	readonly masterKey: MasterKey;
	readonly migrations?: Readonly<Record<string, string>>;
	/** migrate() copies the file here before a namespace's pending files run on an existing schema. */
	readonly snapshots?: SnapshotOptions;
}
const promiseThen = Promise.prototype.then;
const isThenable = (value: unknown): boolean => {
	if (value === null || (typeof value !== "object" && typeof value !== "function")) return false;
	if (types.isProxy(value)) return true;
	if (types.isPromise(value)) {
		// Observe ordinary native rejection without reading a caller's own then property.
		// Modified Promise constructor/species hooks remain trusted in-process behavior.
		promiseThen.call(
			value,
			() => undefined,
			() => undefined,
		);
		return true;
	}
	let current: object | null = value;
	for (let depth = 0; current !== null && depth < 16; depth++) {
		if (types.isProxy(current) || Object.hasOwn(current, "then")) return true;
		current = Object.getPrototypeOf(current);
	}
	return current !== null;
};
const noAsync = (work: unknown): void => {
	if (typeof work !== "function" || types.isProxy(work) || types.isAsyncFunction(work))
		throw new Error("Database callbacks must be synchronous");
};
const closeDatabase = Database.prototype.close;
const derive = MasterKey.prototype.derive;
const SCHEMA_STATEMENTS = new Set(["CREATE", "DROP", "ALTER", "ANALYZE", "REINDEX"]);
const transactionOwners = new WeakMap<SqlTransaction, { store: HubStore; live: () => boolean }>();

/** Internal native composition only; structural or retired facades are not authority. */
export function assertStoreTransaction(store: HubStore, transaction: SqlTransaction): void {
	const owner = transactionOwners.get(transaction);
	if (!owner || owner.store !== store || !owner.live())
		throw new Error("Database transaction unavailable");
}

export class HubStore {
	readonly #keyIdentity = createEncryptedKeyIdentity();
	readonly #db: SqliteDatabase;
	readonly #genesisTag: string;
	readonly #readOwner: object = Object.freeze(Object.create(null));
	readonly #migrations: ReadonlyMap<string, string>;
	readonly #snapshots: SnapshotSettings | undefined;
	#revision = 0;
	#newAuditStorage = false;
	#busy = false;
	#closed = false;
	#nativeClosed = false;
	constructor(options: StoreOptions) {
		this.#migrations = new Map(Object.entries(options.migrations ?? {}));
		const snapshots = options.snapshots;
		this.#snapshots = snapshots === undefined ? undefined : snapshotSettings(snapshots);
		const masterKey = options.masterKey;
		let auditKey: Buffer | undefined;
		try {
			auditKey = derive.call(masterKey, "audit");
			this.#genesisTag = auditHeadTag(auditKey, 0, "");
			this.#db = openEncrypted(options, masterKey, "db", this.#keyIdentity);
			this.#newAuditStorage = consumeCreatedEncryptedFile(this.#keyIdentity);
		} catch (error) {
			destroyEncryptedKeyIdentity(this.#keyIdentity);
			throw error;
		} finally {
			auditKey?.fill(0);
		}
	}
	#scope<T>(write: boolean, work: (db: SqlTransaction) => T): T {
		if (this.#closed || this.#busy) throw new Error("Database is unavailable or already in use");
		noAsync(work);
		let active = true;
		const statement = (sql: string, mutation = false) => {
			if (!active) throw new Error("Database callback has ended");
			const starts = statementStarts(sql);
			if (
				starts.length !== 1 ||
				REFUSED_STATEMENTS.has(starts[0] ?? "") ||
				SCHEMA_STATEMENTS.has(starts[0] ?? "") ||
				namesPragmaFunction(sql)
			)
				throw new Error("Transaction control is reserved to the store");
			const stmt = this.#db.prepare(sql);
			if (!mutation && !stmt.readonly) throw new Error("Read operation cannot change the database");
			return stmt;
		};
		const handle: SqlTransaction = {
			get: <R>(sql: string, bindings: readonly SqlValue[] = []) =>
				statement(sql).get(...bindings) as R | undefined,
			all: <R>(sql: string, bindings: readonly SqlValue[] = []) =>
				statement(sql).all(...bindings) as R[],
			run: (sql, bindings = []) => {
				if (!active) throw new Error("Database callback has ended");
				if (!write || !this.#db.inTransaction)
					throw new Error("Write requires the current transaction");
				return statement(sql, true).run(...bindings);
			},
		};
		Object.freeze(handle);
		if (write) this.#revision++;
		bindReadStamp(handle, () => ({
			owner: this.#readOwner,
			revision: this.#revision,
			dataVersion: this.#db.pragma("data_version", { simple: true }) as number,
			totalChanges: (this.#db.prepare("SELECT total_changes() AS n").get() as { n: number }).n,
			schemaVersion: this.#db.pragma("schema_version", { simple: true }) as number,
		}));
		this.#busy = true;
		if (write)
			transactionOwners.set(handle, {
				store: this,
				live: () => active && !this.#closed && this.#db.inTransaction,
			});
		try {
			if (!write) this.#db.pragma("query_only = ON");
			const invoke = () => {
				const result = work(handle);
				if (isThenable(result)) throw new Error("Database callbacks must be synchronous");
				return result;
			};
			return write ? this.#db.transaction(invoke).immediate() : invoke();
		} finally {
			try {
				if (!write) this.#db.pragma("query_only = OFF");
			} finally {
				transactionOwners.delete(handle);
				releaseReadStamp(handle);
				active = false;
				this.#busy = false;
			}
		}
	}
	read<T>(work: (db: SqlReader) => T): T {
		return this.#scope(false, work);
	}
	/** Native key identity comparison; never exports its fingerprint or derived key. */
	assertMasterKey(key: MasterKey): void {
		if (this.#closed) throw new Error("Database key unavailable");
		assertEncryptedKeyIdentity(this.#keyIdentity, key);
	}
	write<T>(work: (tx: SqlTransaction) => T): T {
		return this.#scope(true, work);
	}
	async migrate(namespace: string): Promise<string[]> {
		if (this.#closed || this.#busy) throw new Error("Database is unavailable or already in use");
		const dir = this.#migrations.get(namespace);
		if (dir === undefined) throw new Error("Migration namespace is not registered");
		const snapshots = this.#snapshots;
		const snapshot =
			snapshots === undefined
				? undefined
				: () => takePreMigrationSnapshot(this.#db, namespace, snapshots);
		this.#busy = true;
		this.#revision++;
		let initializing = false;
		try {
			return await migrate(this.#db, namespace, dir, snapshot, (name) => {
				if (namespace !== "audit" || name !== "0001_chain.sql") return;
				if (
					!this.#newAuditStorage ||
					this.#db.prepare("SELECT 1 FROM main._migrations_audit LIMIT 1").get()
				)
					throw new Error(
						"Audit storage is missing or incomplete. Restore a valid backup; remove and recreate the database only if it was never used.",
					);
				this.#newAuditStorage = false;
				initializing = true;
				if (
					this.#db
						.prepare(
							"UPDATE main.audit_meta SET audit_tag=? WHERE singleton=1 AND audit_seq=0 AND audit_head='' AND audit_tag=''",
						)
						.run(this.#genesisTag).changes !== 1
				)
					throw new Error("Audit genesis initialization failed");
			});
		} catch (error) {
			// Only the migrator's failed transaction can restore this open's creation authority.
			// A post-commit failure must never allow a later reset to mint another genesis.
			if (initializing && error instanceof MigrationError) {
				try {
					const schema = this.#db
						.prepare(
							"SELECT 1 FROM main.sqlite_schema WHERE name IN ('audit_meta','audit_events') LIMIT 1",
						)
						.get();
					const applied = this.#db.prepare("SELECT 1 FROM main._migrations_audit LIMIT 1").get();
					if (!schema && !applied && !this.#db.inTransaction) this.#newAuditStorage = true;
				} catch {
					/* An unprovable rollback consumes the authority. */
				}
			}
			throw error;
		} finally {
			this.#busy = false;
		}
	}
	checkpoint(): void {
		if (this.#closed || this.#busy) throw new Error("Database is unavailable or already in use");
		const [result] = this.#db.pragma("wal_checkpoint(TRUNCATE)") as { busy: number }[];
		if (result?.busy !== 0) throw new Error("Database checkpoint is busy");
	}
	/** Removes pre-migration snapshots older than the retention period; returns the count. */
	expireSnapshots(): number {
		return this.#snapshotFiles(expirePreMigrationSnapshots);
	}
	/** Removes every pre-migration snapshot, for purges; returns the count. */
	removeSnapshots(): number {
		return this.#snapshotFiles(removePreMigrationSnapshots);
	}
	#snapshotFiles(remove: (settings: SnapshotSettings) => number): number {
		if (this.#closed || this.#busy) throw new Error("Database is unavailable or already in use");
		const snapshots = this.#snapshots;
		if (snapshots === undefined) throw new SnapshotError("options");
		this.#busy = true;
		try {
			return remove(snapshots);
		} finally {
			this.#busy = false;
		}
	}
	close(): void {
		if (this.#busy) throw new Error("Database is in use");
		this.#closed = true;
		destroyEncryptedKeyIdentity(this.#keyIdentity);
		if (this.#nativeClosed) return;
		try {
			if (this.#db.open !== false) closeDatabase.call(this.#db);
		} catch {
			// Native close can throw before or after effect; retain the actual object until proved closed.
		}
		if (this.#db.open !== false) throw new Error("Database cleanup unavailable");
		this.#nativeClosed = true;
	}
}
