import { fileURLToPath } from "node:url";
import Database from "better-sqlite3-multiple-ciphers";
import { HUB_NAMESPACES } from "../kernel/namespaces.ts";
import { captureMigrationPlan, type MigrationPlan, migrationTables } from "./migrator.ts";
import type { SqliteDatabase } from "./open.ts";

/** Fixed and content-free: no SQL, path or row is carried. */
export const SCHEMA_REFUSED = "Database schema is not recognized";

// From source this module is src/store/schema.ts; built, it is part of dist/index.mjs.
const fromSource = import.meta.url.endsWith(".ts");
const root = new URL(fromSource ? "../" : "./", import.meta.url);
const delivered = (source: string, built: string): string =>
	fileURLToPath(new URL(fromSource ? source : built, root));

// The first-party folders retained compositions migrate. A file that applied one of them reopens
// without registering it; any other applied namespace needs its registered folder.
const DELIVERED: ReadonlyMap<string, string> = new Map([
	...Object.entries(HUB_NAMESPACES),
	["devices", delivered("identity/devices-migrations", "devices-migrations")],
]);

const CATALOG = "SELECT type, name, tbl_name, sql FROM main.sqlite_schema";
const PRISTINE =
	"SELECT (SELECT count(*) FROM main.sqlite_schema) + (SELECT count(*) FROM temp.sqlite_schema)";
const LEDGER = /^_migrations_([a-z][a-z0-9]*)(_lock)?$/;

interface CatalogRow {
	readonly type: unknown;
	readonly name: unknown;
	readonly tbl_name: unknown;
	readonly sql: unknown;
}
interface Ledger {
	readonly lock: boolean;
	/** Sorted applied names: they only select a prefix of a captured plan. */
	readonly applied: readonly unknown[];
}
interface Observed {
	/** Every object outside the migration bookkeeping, sorted. */
	readonly objects: readonly string[];
	readonly ledgers: ReadonlyMap<string, Ledger>;
}

function refuse(): never {
	throw new Error(SCHEMA_REFUSED);
}
const entry = ({ type, name, tbl_name, sql }: CatalogRow): string =>
	JSON.stringify([type, name, tbl_name, sql]);
const same = (a: readonly unknown[], b: readonly unknown[]): boolean =>
	a.length === b.length && a.every((value, index) => value === b[index]);
const sameLedger = (a: Ledger | undefined, b: Ledger | undefined): boolean =>
	a === undefined || b === undefined ? a === b : a.lock === b.lock && same(a.applied, b.applied);

// The migrator's bookkeeping tables as SQLite stores Kysely's DDL for them.
function bookkeeping(namespace: string, lock: boolean): string[] {
	const tables = migrationTables(namespace);
	const table = (name: string, columns: string): string[] => [
		entry({ type: "table", name, tbl_name: name, sql: `CREATE TABLE "${name}" (${columns})` }),
		entry({ type: "index", name: `sqlite_autoindex_${name}_1`, tbl_name: name, sql: null }),
	];
	return [
		...table(
			tables.table,
			`"name" varchar(255) not null primary key, "timestamp" varchar(255) not null`,
		),
		...(lock
			? table(
					tables.lock,
					`"id" varchar(255) not null primary key, "is_locked" integer default 0 not null`,
				)
			: []),
	];
}

function observe(db: SqliteDatabase): Observed {
	const objects: string[] = [];
	const kept: string[] = [];
	const locks = new Map<string, boolean>();
	for (const row of db.prepare(CATALOG).all() as CatalogRow[]) {
		const match = typeof row.tbl_name === "string" ? LEDGER.exec(row.tbl_name) : null;
		if (match === null) {
			objects.push(entry(row));
			continue;
		}
		kept.push(entry(row));
		const namespace = match[1] as string;
		const lock = match[2] !== undefined && row.type === "table";
		locks.set(namespace, lock || locks.get(namespace) === true);
	}
	// Bookkeeping must have its exact shape before any of its rows is read.
	const expected = [...locks].flatMap(([namespace, lock]) => bookkeeping(namespace, lock));
	if (!same(kept.toSorted(), expected.toSorted())) refuse();
	const ledgers = new Map<string, Ledger>();
	for (const [namespace, lock] of locks) {
		const { table } = migrationTables(namespace);
		// Read the table itself: an index over it is not yet checked.
		const applied = db.prepare(`SELECT name FROM main."${table}" NOT INDEXED`).pluck().all();
		ledgers.set(namespace, { lock, applied: applied.toSorted() });
	}
	return { objects: objects.toSorted(), ledgers };
}

const references = new Map<string, SqliteDatabase>();
const closeDatabase = Database.prototype.close;

// An in-memory connection of the same native build, holding no key or user row.
function reference(binding: string): SqliteDatabase {
	const cached = references.get(binding);
	if (cached !== undefined) return cached;
	const db = new Database(":memory:", { nativeBinding: binding });
	// The settings that shape what migrate() creates: foreign keys stay off for its run.
	db.exec(
		"PRAGMA foreign_keys = OFF; PRAGMA recursive_triggers = ON; PRAGMA trusted_schema = OFF; PRAGMA temp_store = MEMORY;",
	);
	references.set(binding, db);
	return db;
}

// Each replay runs in one transaction that is always rolled back, so no replay sees another's.
function replay(binding: string, steps: readonly string[]): string[] {
	const db = reference(binding);
	try {
		db.exec("BEGIN");
		for (const sql of steps) db.exec(sql);
		return (db.prepare(CATALOG).all() as CatalogRow[]).map(entry).toSorted();
	} finally {
		let pristine = false;
		try {
			if (db.inTransaction) db.exec("ROLLBACK");
			pristine = !db.inTransaction && db.prepare(PRISTINE).pluck().get() === 0;
		} catch {
			/* Discarded below. */
		}
		if (!pristine) {
			references.delete(binding);
			try {
				closeDatabase.call(db);
			} catch {
				/* It holds no key or row; it is never reused. */
			}
		}
	}
}

/**
 * A hub file's accepted schema: every object must be what replaying the applied prefix of each
 * captured migration plan creates. It does not authenticate any row.
 */
export class StoreSchema {
	readonly #binding: string;
	readonly #registered: ReadonlyMap<string, string>;
	#observed: Observed;
	#plans: ReadonlyMap<string, MigrationPlan>;

	private constructor(
		binding: string,
		registered: ReadonlyMap<string, string>,
		observed: Observed,
		plans: ReadonlyMap<string, MigrationPlan>,
	) {
		this.#binding = binding;
		this.#registered = registered;
		this.#observed = observed;
		this.#plans = plans;
	}

	/** Checks a newly opened file, including SQLite's index and table consistency, before any use. */
	static accept(
		db: SqliteDatabase,
		binding: string,
		registered: ReadonlyMap<string, string>,
	): StoreSchema {
		try {
			const observed = observe(db);
			const plans = new Map<string, MigrationPlan>();
			for (const [namespace, { applied }] of observed.ledgers) {
				const dir = registered.get(namespace) ?? DELIVERED.get(namespace);
				if (dir === undefined) refuse();
				if (applied.length > 0) plans.set(namespace, captureMigrationPlan(dir));
			}
			const schema = new StoreSchema(binding, registered, observed, plans);
			if (!same(observed.objects, schema.#expected(observed.ledgers, plans))) refuse();
			const integrity = db.prepare("PRAGMA main.integrity_check(1)").pluck().all();
			if (!same(integrity, ["ok"])) refuse();
			return schema;
		} catch {
			throw new Error(SCHEMA_REFUSED);
		}
	}

	/** Before a migration runs: the file is still what was accepted, and so are its applied files. */
	beforeMigration(db: SqliteDatabase, namespace: string, plan: MigrationPlan): void {
		try {
			const observed = observe(db);
			if (!same(observed.objects, this.#observed.objects)) refuse();
			for (const name of new Set([...observed.ledgers.keys(), ...this.#observed.ledgers.keys()]))
				if (!sameLedger(observed.ledgers.get(name), this.#observed.ledgers.get(name))) refuse();
			const applied = this.#observed.ledgers.get(namespace)?.applied.length ?? 0;
			const accepted = this.#plans.get(namespace) ?? [];
			for (let index = 0; index < applied; index++)
				if (
					plan[index]?.name !== accepted[index]?.name ||
					plan[index]?.sql !== accepted[index]?.sql
				)
					refuse();
		} catch {
			throw new Error(SCHEMA_REFUSED);
		}
	}

	/** After a migration attempt: only that namespace may have advanced, as its captured plan says. */
	afterMigration(db: SqliteDatabase, namespace: string, plan: MigrationPlan): void {
		try {
			if (db.inTransaction) refuse();
			const observed = observe(db);
			for (const name of new Set([...observed.ledgers.keys(), ...this.#observed.ledgers.keys()]))
				if (
					name !== namespace &&
					!sameLedger(observed.ledgers.get(name), this.#observed.ledgers.get(name))
				)
					refuse();
			const before = this.#observed.ledgers.get(namespace);
			const after = observed.ledgers.get(namespace);
			const count = before?.applied.length ?? 0;
			if (
				before !== undefined &&
				(after === undefined ||
					(before.lock && !after.lock) ||
					!same(before.applied, after.applied.slice(0, count)))
			)
				refuse();
			const plans = new Map(this.#plans);
			if ((after?.applied.length ?? 0) > 0) plans.set(namespace, plan);
			const expected =
				(after?.applied.length ?? 0) === count
					? this.#observed.objects
					: this.#expected(observed.ledgers, plans);
			if (!same(observed.objects, expected)) refuse();
			this.#observed = observed;
			this.#plans = plans;
		} catch {
			throw new Error(SCHEMA_REFUSED);
		}
	}

	// Delivered namespaces first, which other namespaces may build on, then the registered order.
	#expected(
		ledgers: ReadonlyMap<string, Ledger>,
		plans: ReadonlyMap<string, MigrationPlan>,
	): string[] {
		const steps: string[] = [];
		for (const namespace of new Set([...DELIVERED.keys(), ...this.#registered.keys()])) {
			const applied = ledgers.get(namespace)?.applied ?? [];
			if (applied.length === 0) continue;
			const plan = plans.get(namespace);
			if (
				plan === undefined ||
				applied.length > plan.length ||
				applied.some((name, index) => name !== plan[index]?.name)
			)
				refuse();
			for (const file of plan.slice(0, applied.length)) steps.push(file.sql);
		}
		return steps.length === 0 ? [] : replay(this.#binding, steps);
	}
}
