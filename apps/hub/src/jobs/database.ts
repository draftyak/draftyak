import { types } from "node:util";
import { assertStoreTransaction, HubStore, type SqlTransaction } from "../store/store.ts";
import { WorkError } from "./values.ts";

export interface WorkScope {
	readonly sql: SqlTransaction;
}

const write = HubStore.prototype.write;
const scopes = new WeakMap<object, { owner: WorkDatabase; sql: SqlTransaction; failed: boolean }>();

function guard(store: HubStore, sql: SqlTransaction): void {
	assertStoreTransaction(store, sql);
	// get/all remain usable if SQLite rolls back a statement inside a caught callback.
	// run proves that this is still the native write transaction before issuing authority.
	if (sql.run("UPDATE main.jobs_meta SET singleton = singleton WHERE singleton = 1").changes !== 1)
		throw new WorkError("data");
}

/** One short, synchronous native write joins consumer state, jobs, invalidations and audit. */
export class WorkDatabase {
	readonly #store: HubStore;
	constructor(store: HubStore) {
		this.#store = store;
	}

	write<T>(work: (scope: WorkScope) => T): T {
		if (typeof work !== "function" || types.isProxy(work) || types.isAsyncFunction(work))
			throw new WorkError("input");
		return write.call(this.#store, (sql) => {
			guard(this.#store, sql);
			const scope: WorkScope = Object.freeze({ sql });
			const state = { owner: this, sql, failed: false };
			scopes.set(scope, state);
			try {
				const result = work(scope);
				if (state.failed) throw new WorkError("scope");
				guard(this.#store, sql);
				return result;
			} finally {
				scopes.delete(scope);
			}
		}) as T;
	}

	sql(scope: WorkScope): SqlTransaction {
		const state = scopes.get(scope);
		if (!state || state.owner !== this || state.failed) throw new WorkError("scope");
		guard(this.#store, state.sql);
		return state.sql;
	}

	/** A failed multi-statement module operation cannot be committed by catching its error. */
	abort(scope: WorkScope): void {
		const state = scopes.get(scope);
		if (!state || state.owner !== this) throw new WorkError("scope");
		state.failed = true;
	}
}
