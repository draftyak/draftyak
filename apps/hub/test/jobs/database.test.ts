import { afterEach, beforeEach, expect, it } from "vitest";
import { WorkDatabase, type WorkScope } from "../../src/jobs/database.ts";
import type { SqlTransaction } from "../../src/store/store.ts";
import { ACCOUNT, fixture, OWNER, REF, testId } from "./fixture.ts";

let f: Awaited<ReturnType<typeof fixture>>;
beforeEach(async () => {
	f = await fixture();
});
afterEach(() => f.cleanup());
const enqueue = (scope: WorkScope): void => {
	f.queue.enqueue(scope, {
		id: testId(10),
		accountId: ACCOUNT,
		ownerId: OWNER,
		kind: "sync",
		refId: REF,
	});
};

it("expires both its scope and native SQL handle at callback return", () => {
	let leaked: WorkScope | undefined, sql: SqlTransaction | undefined;
	f.database.write((scope) => {
		leaked = scope;
		sql = scope.sql;
		expect(Object.isFrozen(scope)).toBe(true);
	});
	expect(() => f.database.sql(leaked as WorkScope)).toThrow();
	expect(() => sql?.get("SELECT 1")).toThrow();
	expect(() => sql?.run("UPDATE main.consumer_state SET value=1")).toThrow();
});
it("rejects foreign, fabricated and proxied scopes without user hooks", () => {
	let hooks = 0;
	f.database.write((scope) => {
		const other = new WorkDatabase(f.store);
		expect(() => other.sql(scope)).toThrow();
		for (const fake of [
			{ sql: scope.sql },
			new Proxy(scope, {
				get: () => {
					hooks++;
					throw new Error("hook");
				},
			}),
			Object.create(scope),
		])
			expect(() => f.database.sql(fake)).toThrow();
	});
	expect(hooks).toBe(0);
});
it("refuses async callback before invoking it", () => {
	let calls = 0;
	expect(() =>
		f.database.write(async () => {
			calls++;
		}),
	).toThrow();
	expect(calls).toBe(0);
});
it("refuses Proxy callbacks without apply or get hooks", () => {
	let hooks = 0;
	const callback = new Proxy(() => undefined, {
		apply: () => {
			hooks++;
		},
		get: () => {
			hooks++;
		},
	});
	expect(() => f.database.write(callback)).toThrow();
	expect(hooks).toBe(0);
});
it("rolls back returned thenables without touching their then accessor", () => {
	let hooks = 0;
	// biome-ignore lint/suspicious/noThenProperty: exercise callback result admission without invoking the accessor.
	const result = Object.defineProperty({}, "then", {
		get: () => {
			hooks++;
			throw new Error("hook");
		},
	});
	expect(() =>
		f.database.write((scope) => {
			enqueue(scope);
			return result;
		}),
	).toThrow();
	expect(hooks).toBe(0);
	expect(f.store.read((sql) => sql.all("SELECT id FROM main.jobs"))).toHaveLength(0);
});
it("does not issue a new scope or commit after a caught SQLite OR ROLLBACK", () => {
	let issued = false;
	expect(() =>
		f.database.write((scope) => {
			try {
				scope.sql.run("INSERT OR ROLLBACK INTO main.consumer_state VALUES(1,1)");
			} catch {
				/* engine ended transaction */
			}
			expect(scope.sql.get("SELECT 1")).toBeDefined();
			try {
				f.database.sql(scope);
				issued = true;
			} catch {
				/* current-write check refuses */
			}
		}),
	).toThrow();
	expect(issued).toBe(false);
	expect(
		f.store.read(
			(sql) => sql.get<{ value: number }>("SELECT value FROM main.consumer_state")?.value,
		),
	).toBe(0);
});
it("keeps a genuine write live after a caught statement-only OR ABORT", () => {
	f.database.write((scope) => {
		try {
			scope.sql.run("INSERT OR ABORT INTO main.consumer_state VALUES(1,1)");
		} catch {
			/* transaction stays live */
		}
		enqueue(scope);
	});
	expect(f.store.read((sql) => sql.all("SELECT id FROM main.jobs"))).toHaveLength(1);
});
it("does not issue lease authority after a caught native rollback", () => {
	f.database.write(enqueue);
	let lease: unknown;
	expect(() =>
		f.database.write((scope) => {
			try {
				scope.sql.run("INSERT OR ROLLBACK INTO main.consumer_state VALUES(1,1)");
			} catch {
				/* engine ended transaction */
			}
			try {
				lease = f.queue.claim(scope, ACCOUNT);
			} catch {
				/* operation must refuse */
			}
		}),
	).toThrow();
	expect(lease).toBeUndefined();
	expect(
		f.store.read((sql) => sql.get<{ state: string }>("SELECT state FROM main.jobs")?.state),
	).toBe("PENDING");
});
it("rejects a scope in a nested foreign coordinator instead of accepting structural SQL", () => {
	const other = new WorkDatabase(f.store);
	f.database.write((scope) => {
		expect(() => other.abort(scope)).toThrow();
		enqueue(scope);
	});
	expect(f.store.read((sql) => sql.all("SELECT id FROM main.jobs"))).toHaveLength(1);
});
