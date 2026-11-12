import { randomBytes } from "node:crypto";
import { existsSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Account } from "@draftyak/protocol/entities/account";
import { afterEach, describe, expect, it } from "vitest";
import { AccountError, NativeAccounts } from "../../src/accounts/records.ts";
import { AuditChain } from "../../src/audit/chain.ts";
import { EventLog } from "../../src/events/log.ts";
import { WorkDatabase } from "../../src/jobs/database.ts";
import { WorkError } from "../../src/jobs/values.ts";
import { newId } from "../../src/kernel/ids.ts";
import { MasterKey } from "../../src/kernel/master-key.ts";
import { HUB_NAMESPACES, migrateHubSchemas } from "../../src/kernel/namespaces.ts";
import { readStamp, sameReadStamp } from "../../src/store/read-stamp.ts";
import { HubStore, type SqlTransaction, type SqlValue } from "../../src/store/store.ts";
import { nativeBinding } from "../store/helpers.ts";

function account(): Account {
	return {
		channel: "email",
		id: newId(),
		userId: newId(),
		alias: "dytest-read-stamp",
		mode: "full",
		status: "active",
		deletionDeadline: null,
		historyLimitDays: 30,
		disclosureVersion: 1,
		createdAt: 1000,
		pluginInstanceId: newId(),
		address: "dytest-read-stamp@example.invalid",
	};
}

const fixtures: { cleanup(): void }[] = [];
async function fixture(value = account()) {
	const parent = realpathSync(os.tmpdir());
	const dir = realpathSync(mkdtempSync(path.join(parent, "draftyak-account-read-stamp-")));
	const bytes = randomBytes(32);
	const key = new MasterKey(bytes);
	bytes.fill(0);
	const store = new HubStore({
		filename: path.join(dir, "accounts.db"),
		nativeBinding,
		masterKey: key,
		create: true,
		migrations: HUB_NAMESPACES,
	});
	let audit: AuditChain | undefined;
	const cleanup = () => {
		store.close();
		audit?.destroy();
		key.destroy();
		if (
			path.dirname(dir) !== parent ||
			!path.basename(dir).startsWith("draftyak-account-read-stamp-") ||
			realpathSync(dir) !== dir
		)
			throw new Error("Fixture cleanup refused");
		rmSync(dir, { recursive: true, force: true });
		if (existsSync(dir)) throw new Error("Fixture cleanup incomplete");
	};
	fixtures.push({ cleanup });
	await migrateHubSchemas(store);
	const auditBytes = key.derive("audit");
	audit = new AuditChain(auditBytes);
	auditBytes.fill(0);
	const database = new WorkDatabase(store);
	const events = new EventLog(database, () => 2000);
	const accounts = new NativeAccounts(database, events, audit, () => 2000);
	const created = database.write((scope) => accounts.create(scope, value));
	return { store, database, accounts, created, value };
}

afterEach(() => {
	for (const owned of fixtures.splice(0).reverse()) owned.cleanup();
});

function totalChanges(sql: SqlTransaction): number {
	const row = sql.get<{ n: number }>("SELECT total_changes() AS n");
	if (!row || !Number.isSafeInteger(row.n)) throw new Error("Native change counter unavailable");
	return row.n;
}

describe("native account reads preserve the current transaction stamp", () => {
	it("reads the bound account without SQL writes, a new scope or a new read stamp", async () => {
		const f = await fixture();
		f.store.write((tx) => {
			const before = readStamp(tx);
			const changes = totalChanges(tx);
			expect(before).toBeDefined();
			f.database.assertReadTransaction(tx);
			expect(sameReadStamp(before, readStamp(tx))).toBe(true);
			const found = f.accounts.getInTransaction(tx, f.value.userId, f.value.id);
			expect(found).toEqual(f.created);
			expect(Object.isFrozen(found)).toBe(true);
			expect(Object.isFrozen(found?.account)).toBe(true);
			expect(totalChanges(tx)).toBe(changes);
			expect(sameReadStamp(before, readStamp(tx))).toBe(true);
			// Validating an existing store transaction must not mint a WorkScope.
			expect(() => f.database.sql({ sql: tx })).toThrow(WorkError);
			expect(sameReadStamp(before, readStamp(tx))).toBe(true);
		});
	});

	it("preserves the stamp for a missing account or another owner's account", async () => {
		const f = await fixture();
		f.store.write((tx) => {
			const before = readStamp(tx);
			const changes = totalChanges(tx);
			expect(f.accounts.getInTransaction(tx, f.value.userId, newId())).toBeUndefined();
			expect(f.accounts.getInTransaction(tx, newId(), f.value.id)).toBeUndefined();
			expect(totalChanges(tx)).toBe(changes);
			expect(sameReadStamp(before, readStamp(tx))).toBe(true);
		});
	});

	it("still invalidates an earlier stamp when the native account is actually replaced", async () => {
		const f = await fixture();
		f.database.write((scope) => {
			const tx = f.database.sql(scope);
			const before = readStamp(tx);
			const changes = totalChanges(tx);
			const next = f.accounts.replace(
				scope,
				{ ...f.value, status: "paused", mode: "read_only" },
				f.created.generation,
			);
			expect(totalChanges(tx)).toBeGreaterThan(changes);
			expect(sameReadStamp(before, readStamp(tx))).toBe(false);
			const afterWrite = readStamp(tx);
			expect(f.accounts.getInTransaction(tx, f.value.userId, f.value.id)).toEqual(next);
			expect(sameReadStamp(afterWrite, readStamp(tx))).toBe(true);
		});
	});

	it("keeps the existing write-transaction guard mutating and distinct", async () => {
		const f = await fixture();
		f.store.write((tx) => {
			const before = readStamp(tx);
			const changes = totalChanges(tx);
			f.database.assertTransaction(tx);
			expect(totalChanges(tx)).toBeGreaterThan(changes);
			expect(sameReadStamp(before, readStamp(tx))).toBe(false);
		});
	});
});

describe("account read admission requires the original live write facade", () => {
	it("rejects a structural facade before querying through its copied SQL methods", async () => {
		const f = await fixture();
		f.store.write((tx) => {
			let reads = 0;
			const facade: SqlTransaction = {
				get: <T>(query: string, bindings: readonly SqlValue[] = []) => {
					reads++;
					return tx.get<T>(query, bindings);
				},
				all: tx.all,
				run: tx.run,
			};
			expect(() => f.database.assertReadTransaction(facade)).toThrow(
				"Database transaction unavailable",
			);
			expect(() => f.accounts.getInTransaction(facade, f.value.userId, f.value.id)).toThrow(
				AccountError,
			);
			expect(reads).toBe(0);
		});
	});

	it("rejects another store's live facade even when it contains the same account DATA", async () => {
		const f = await fixture();
		const other = await fixture(f.value);
		other.store.write((foreign) => {
			expect(other.accounts.getInTransaction(foreign, f.value.userId, f.value.id)).toEqual(
				other.created,
			);
			expect(() => f.database.assertReadTransaction(foreign)).toThrow(
				"Database transaction unavailable",
			);
			expect(() => f.accounts.getInTransaction(foreign, f.value.userId, f.value.id)).toThrow(
				AccountError,
			);
		});
	});

	it("rejects a genuine read-only facade rather than adopting it as a native write", async () => {
		const f = await fixture();
		f.store.read((reader) => {
			const readOnly = reader as SqlTransaction;
			expect(() => f.database.assertReadTransaction(readOnly)).toThrow(
				"Database transaction unavailable",
			);
			expect(() => f.accounts.getInTransaction(readOnly, f.value.userId, f.value.id)).toThrow(
				AccountError,
			);
		});
	});

	it("rejects a retired facade after its original synchronous callback ends", async () => {
		const f = await fixture();
		let retired: SqlTransaction | undefined;
		f.store.write((tx) => {
			retired = tx;
			f.database.assertReadTransaction(tx);
		});
		const original = retired;
		if (!original) throw new Error("Original fixture transaction unavailable");
		expect(readStamp(original)).toBeUndefined();
		expect(() => f.database.assertReadTransaction(original)).toThrow(
			"Database transaction unavailable",
		);
		expect(() => f.accounts.getInTransaction(original, f.value.userId, f.value.id)).toThrow(
			AccountError,
		);
	});

	it("the getter ignores an instance validator replacement", async () => {
		const f = await fixture();
		let calls = 0;
		Object.defineProperty(f.database, "assertReadTransaction", {
			value: () => {
				calls++;
				throw new Error("DYTEST replaced validator must not run");
			},
		});
		f.store.write((tx) => {
			const before = readStamp(tx);
			expect(f.accounts.getInTransaction(tx, f.value.userId, f.value.id)).toEqual(f.created);
			expect(sameReadStamp(before, readStamp(tx))).toBe(true);
		});
		expect(calls).toBe(0);
	});
});
