import { randomBytes } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { Account } from "@draftyak/protocol/entities/account";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AccountError, NativeAccounts } from "../../src/accounts/records.ts";
import { AuditChain } from "../../src/audit/chain.ts";
import { EventLog } from "../../src/events/log.ts";
import { WorkDatabase, type WorkScope } from "../../src/jobs/database.ts";
import { newId } from "../../src/kernel/ids.ts";
import { MasterKey } from "../../src/kernel/master-key.ts";
import { HUB_NAMESPACES, migrateHubSchemas } from "../../src/kernel/namespaces.ts";
import { HubStore, type SqlTransaction } from "../../src/store/store.ts";
import { nativeBinding } from "../store/helpers.ts";

const owner = newId();
const plugin = newId();
type EmailAccount = Extract<Account, { channel: "email" }>;
type ChatAccount = Extract<Account, { channel: "chat" }>;
function email(changes: Partial<EmailAccount> = {}): EmailAccount {
	return {
		channel: "email",
		id: newId(),
		userId: owner,
		alias: "dytest-mailbox",
		mode: "full",
		status: "active",
		deletionDeadline: null,
		historyLimitDays: 30,
		disclosureVersion: 1,
		createdAt: 1000,
		pluginInstanceId: plugin,
		address: "dytest@example.invalid",
		...changes,
	};
}
function chat(): ChatAccount {
	const value: ChatAccount = {
		...email(),
		channel: "chat",
		teamId: "DYTEST-team",
		selfUserId: "DYTEST-user",
	};
	Reflect.deleteProperty(value, "address");
	return value;
}
async function fixture() {
	const parent = realpathSync(os.tmpdir());
	const dir = realpathSync(mkdtempSync(path.join(parent, "draftyak-accounts-test-")));
	const filename = path.join(dir, "accounts.db");
	const key = new MasterKey(randomBytes(32));
	const options = { filename, nativeBinding, masterKey: key, migrations: HUB_NAMESPACES };
	const store = new HubStore({ ...options, create: true });
	await migrateHubSchemas(store);
	const bytes = key.derive("audit"),
		audit = new AuditChain(bytes);
	bytes.fill(0);
	const stores = [store];
	const database = new WorkDatabase(store);
	const events = new EventLog(database, () => 2000);
	const accounts = new NativeAccounts(database, events, audit, () => 2000);
	const count = () =>
		store.read((sql) => [
			sql.get<{ n: number }>("SELECT COUNT(*) AS n FROM accounts")?.n,
			sql.get<{ n: number }>("SELECT COUNT(*) AS n FROM audit_events")?.n,
			sql.get<{ n: number }>("SELECT COUNT(*) AS n FROM events")?.n,
		]);
	const reopen = () => {
		store.close();
		const next = new HubStore(options);
		stores.push(next);
		const db = new WorkDatabase(next);
		return {
			database: db,
			accounts: new NativeAccounts(db, new EventLog(db, () => 2000), audit, () => 2000),
		};
	};
	return {
		dir,
		filename,
		store,
		key,
		audit,
		database,
		events,
		accounts,
		count,
		reopen,
		cleanup: () => {
			for (const opened of stores) opened.close();
			audit.destroy();
			key.destroy();
			if (
				path.dirname(dir) !== parent ||
				!path.basename(dir).startsWith("draftyak-accounts-test-") ||
				realpathSync(dir) !== dir
			)
				throw new Error("Fixture cleanup refused");
			rmSync(dir, { recursive: true, force: true });
			if (existsSync(dir)) throw new Error("Fixture cleanup incomplete");
		},
	};
}
let f: Awaited<ReturnType<typeof fixture>>;
beforeEach(async () => {
	f = await fixture();
});
afterEach(() => f.cleanup());

describe("native encrypted account records and lifecycle notifications", () => {
	it("persists both retained account shapes, hides other owners and emits ID-only changes with audit", () => {
		const first = email();
		const chat: Account = {
			...email(),
			channel: "chat",
			teamId: "DYTEST-team",
			selfUserId: "DYTEST-user",
		};
		Reflect.deleteProperty(chat, "address");
		f.database.write((scope) => {
			f.accounts.create(scope, first);
			f.accounts.create(scope, chat);
		});
		expect(f.count()).toEqual([2, 2, 2]);
		f.database.write((scope) => {
			expect(f.accounts.get(scope, newId(), first.id)).toBeUndefined();
			expect(f.accounts.page(scope, newId()).accounts).toEqual([]);
			const events = f.events.page(scope, { userId: owner, afterSeq: 0 });
			expect(events.events.map((event) => [event.kind, event.ids, event.dataClass])).toEqual([
				["accounts.changed", [first.id], "gmail.metadata"],
				["accounts.changed", [chat.id], "slack.metadata"],
			]);
			expect(JSON.stringify(events)).not.toContain(first.alias);
		});
		const exported = f.store.read((sql) => f.audit.exportVerifiedJsonl(sql));
		expect(exported.count).toBe(2);
		expect(exported.jsonl).not.toContain(first.address);
		for (const suffix of ["", "-wal", "-shm"]) {
			if (existsSync(f.filename + suffix))
				expect(readFileSync(f.filename + suffix).includes(Buffer.from(first.alias))).toBe(false);
		}
		const opened = f.reopen();
		opened.database.write((scope) => {
			expect(opened.accounts.get(scope, owner, first.id)).toEqual({
				account: first,
				generation: 1,
			});
			expect(opened.accounts.get(scope, owner, chat.id)?.account).toEqual(chat);
		});
	});
	it("copies and freezes input, increments generations and refuses stale updates", () => {
		const value = email();
		const created = f.database.write((scope) => f.accounts.create(scope, value));
		expect(Object.isFrozen(created)).toBe(true);
		expect(Object.isFrozen(created.account)).toBe(true);
		value.alias = "dytest-changed-after-call";
		const replacement = { ...created.account, status: "paused" as const };
		f.database.write((scope) => {
			expect(f.accounts.replace(scope, replacement, 1).generation).toBe(2);
		});
		expect(() =>
			f.database.write((scope) => f.accounts.replace(scope, created.account, 1)),
		).toThrow(AccountError);
		f.database.write((scope) => {
			expect(f.accounts.get(scope, owner, value.id)?.account).toEqual(replacement);
		});
		expect(f.count()).toEqual([1, 2, 2]);
	});
	it.each(["userId", "pluginInstanceId", "createdAt", "address"])(
		"refuses rebinding %s",
		(field) => {
			const value = email();
			f.database.write((scope) => f.accounts.create(scope, value));
			const changed = {
				...value,
				[field]:
					field === "createdAt"
						? 1001
						: field === "address"
							? "dytest-other@example.invalid"
							: newId(),
			} as Account;
			expect(() => f.database.write((scope) => f.accounts.replace(scope, changed, 1))).toThrow(
				AccountError,
			);
			expect(f.count()).toEqual([1, 1, 1]);
		},
	);
	it.each(["channel", "teamId", "selfUserId"])("refuses schema-valid rebinding %s", (field) => {
		const original = chat();
		expect(Account.safeParse(original).success).toBe(true);
		expect(f.database.write((scope) => f.accounts.create(scope, original))).toEqual({
			account: original,
			generation: 1,
		});
		const harmless = { ...original, alias: "dytest-renamed-chat" };
		expect(Account.parse(harmless)).toEqual(harmless);
		expect(f.database.write((scope) => f.accounts.replace(scope, harmless, 1))).toEqual({
			account: harmless,
			generation: 2,
		});
		let previous: Account = harmless;
		let generation = 2;
		let changed: Account;
		if (field === "channel") {
			previous = email();
			expect(Account.parse(previous)).toEqual(previous);
			f.database.write((scope) => f.accounts.create(scope, previous));
			generation = 1;
			changed = {
				...previous,
				channel: "chat",
				teamId: "DYTEST-team",
				selfUserId: "DYTEST-user",
			};
			Reflect.deleteProperty(changed, "address");
		} else {
			changed = { ...harmless, [field]: "DYTEST-other-identity" };
		}
		expect(Account.safeParse(changed).success).toBe(true);
		expect(Account.parse(changed)).toEqual(changed);
		const counts = f.count();
		expect(counts).toEqual(field === "channel" ? [2, 3, 3] : [1, 2, 2]);
		expect(() =>
			f.database.write((scope) => f.accounts.replace(scope, changed, generation)),
		).toThrow(AccountError);
		expect(f.count()).toEqual(counts);
		f.database.write((scope) => {
			expect(f.accounts.get(scope, owner, previous.id)).toEqual({
				account: previous,
				generation,
			});
			expect(f.accounts.get(scope, owner, original.id)).toEqual({
				account: harmless,
				generation: 2,
			});
		});
	});
	it("enforces the merged credential-lost deadline rule without disclosing input errors", () => {
		const invalid = email({ status: "credential_lost", deletionDeadline: null });
		expect(() => f.database.write((scope) => f.accounts.create(scope, invalid))).toThrow(
			"Account unavailable",
		);
		expect(f.count()).toEqual([0, 0, 0]);
		f.database.write((scope) => f.accounts.create(scope, { ...invalid, deletionDeadline: 3000 }));
		expect(f.count()).toEqual([1, 1, 1]);
	});
	it("never invokes getters or Proxy traps and rejects undeclared fields", () => {
		let called = false;
		const getter = Object.defineProperty(email(), "alias", {
			enumerable: true,
			get() {
				called = true;
				throw new Error("DYTEST-private-input");
			},
		});
		const proxy = new Proxy(email(), {
			ownKeys() {
				called = true;
				throw new Error("DYTEST-private-proxy");
			},
		});
		for (const raw of [getter, proxy, { ...email(), secret: "DYTEST-undeclared" }])
			expect(() => f.database.write((scope) => f.accounts.create(scope, raw))).toThrow(
				"Account unavailable",
			);
		expect(called).toBe(false);
		expect(f.count()).toEqual([0, 0, 0]);
	});
	it("rolls back records, audit and events even when a caller catches a failed mutation", () => {
		const value = email();
		expect(() =>
			f.database.write((scope) => {
				f.accounts.create(scope, value);
				try {
					f.accounts.create(scope, value);
				} catch {
					/* Scope must remain failed. */
				}
			}),
		).toThrow();
		expect(f.count()).toEqual([0, 0, 0]);
	});
	it("rolls back earlier account and audit changes if notification delivery cannot join the same scope", () => {
		const foreignDatabase = new WorkDatabase(f.store);
		const accounts = new NativeAccounts(
			f.database,
			new EventLog(foreignDatabase, () => 2000),
			f.audit,
			() => 2000,
		);
		expect(() =>
			f.database.write((scope) => {
				try {
					accounts.create(scope, email());
				} catch {
					/* caught */
				}
			}),
		).toThrow();
		expect(f.count()).toEqual([0, 0, 0]);
	});
	it("refuses forged and expired scopes and a forged database facade", () => {
		let retired: WorkScope | undefined;
		f.database.write((scope) => {
			retired = scope;
		});
		for (const scope of [retired, { sql: {} }] as WorkScope[])
			expect(() => f.accounts.create(scope, email())).toThrow(AccountError);
		const fake = new NativeAccounts(
			{
				sql: () => {
					throw new Error("DYTEST facade");
				},
			} as unknown as WorkDatabase,
			f.events,
			f.audit,
			() => 2000,
		);
		f.database.write((scope) => {
			expect(() => fake.create(scope, email())).toThrow(AccountError);
		});
		expect(f.count()).toEqual([0, 0, 0]);
	});
	it("keeps disconnecting terminal and tombstones retired IDs across restart", () => {
		const value = email();
		f.database.write((scope) => f.accounts.create(scope, value));
		expect(() => f.database.write((scope) => f.accounts.retire(scope, owner, value.id, 1))).toThrow(
			AccountError,
		);
		const disconnecting = { ...value, status: "disconnecting" as const };
		f.database.write((scope) => f.accounts.replace(scope, disconnecting, 1));
		expect(() => f.database.write((scope) => f.accounts.replace(scope, value, 2))).toThrow(
			AccountError,
		);
		f.database.write((scope) => {
			f.accounts.retire(scope, owner, value.id, 2);
			expect(f.accounts.get(scope, owner, value.id)).toBeUndefined();
			expect(f.accounts.hasLiveAccounts(scope, plugin)).toBe(false);
		});
		const opened = f.reopen();
		expect(() => opened.database.write((scope) => opened.accounts.create(scope, value))).toThrow(
			AccountError,
		);
		opened.database.write((scope) => {
			expect(opened.accounts.page(scope, owner).accounts).toEqual([]);
		});
	});
	it("fails closed on corrupt JSON, identity disagreement and generation exhaustion", () => {
		const value = email();
		f.database.write((scope) => f.accounts.create(scope, value));
		for (const json of ["{!", JSON.stringify({ ...value, userId: newId() })]) {
			f.store.write((sql) =>
				sql.run("UPDATE accounts SET account_json=? WHERE id=?", [json, value.id]),
			);
			expect(() => f.database.write((scope) => f.accounts.get(scope, owner, value.id))).toThrow(
				AccountError,
			);
		}
		f.store.write((sql) =>
			sql.run("UPDATE accounts SET account_json=?,generation=? WHERE id=?", [
				JSON.stringify(value),
				Number.MAX_SAFE_INTEGER,
				value.id,
			]),
		);
		expect(() =>
			f.database.write((scope) => f.accounts.replace(scope, value, Number.MAX_SAFE_INTEGER)),
		).toThrow(AccountError);
		expect(f.count()).toEqual([1, 1, 1]);
	});
	it("refuses corrupt metadata in the page lookahead without returning a partial page", () => {
		const values = Array.from({ length: 101 }, () => email());
		const ids = values.map(({ id }) => id).toSorted();
		const lookaheadId = ids[100] ?? expect.unreachable("Missing fixture lookahead");
		f.database.write((scope) => {
			for (const value of values) f.accounts.create(scope, value);
		});
		f.database.write((scope) => {
			const first = f.accounts.page(scope, owner);
			expect(first.accounts.map(({ account }) => account.id)).toEqual(ids.slice(0, 100));
			expect(first.nextId).toBe(ids[99]);
			const last = f.accounts.page(scope, owner, first.nextId);
			expect(last.accounts.map(({ account }) => account.id)).toEqual([lookaheadId]);
			expect(last.nextId).toBeNull();
		});
		f.store.write((sql) => {
			expect(
				sql.run("UPDATE accounts SET account_json=? WHERE id=?", ["{}", lookaheadId]).changes,
			).toBe(1);
		});
		let returned: unknown;
		expect(() => {
			returned = f.database.write((scope) => f.accounts.page(scope, owner));
		}).toThrow(AccountError);
		expect(returned).toBeUndefined();
		expect(f.count()).toEqual([101, 101, 101]);
	});
	it("bounds owner pages without skipping or repeating accounts", () => {
		const values = Array.from({ length: 101 }, () => email());
		f.database.write((scope) => {
			for (const value of values) f.accounts.create(scope, value);
		});
		f.database.write((scope) => {
			const first = f.accounts.page(scope, owner);
			expect(first.accounts).toHaveLength(100);
			expect(first.nextId).not.toBeNull();
			const last = f.accounts.page(scope, owner, first.nextId);
			expect(last.accounts).toHaveLength(1);
			expect(last.nextId).toBeNull();
			expect(
				new Set([...first.accounts, ...last.accounts].map((record) => record.account.id)).size,
			).toBe(101);
			expect(f.accounts.hasLiveAccounts(scope, plugin)).toBe(true);
			expect(f.accounts.hasLiveAccounts(scope, newId())).toBe(false);
		});
	});
});

describe("original native account transaction projection", () => {
	it("reads a same-store writer without adopting its foreign WorkScope", () => {
		const value = email();
		f.database.write((scope) => f.accounts.create(scope, value));
		const before = f.count();
		const otherDatabase = new WorkDatabase(f.store);
		otherDatabase.write((scope) => {
			const sql = otherDatabase.sql(scope);
			expect(() => f.accounts.get(scope, owner, value.id)).toThrow(AccountError);
			expect(() => f.database.sql(scope)).toThrow();
			expect(f.database.assertTransaction(sql)).toBeUndefined();
			const current = f.accounts.getInTransaction(sql, owner, value.id);
			expect(current?.account.id === value.id && current.generation === 1).toBe(true);
			expect(Object.isFrozen(current) && Object.isFrozen(current?.account)).toBe(true);
			expect(f.accounts.getInTransaction(sql, newId(), value.id)).toBeUndefined();
			expect(() => f.database.sql(scope)).toThrow();
		});
		expect(f.count()).toEqual(before);
	});

	it("reads current uncommitted metadata while the original writer still owns rollback", () => {
		const value = email();
		f.database.write((scope) => f.accounts.create(scope, value));
		const before = f.count();
		expect(() => f.database.write((scope) => {
			const sql = f.database.sql(scope);
			f.accounts.replace(scope, { ...value, alias: "dytest-uncommitted" }, 1);
			const current = f.accounts.getInTransaction(sql, owner, value.id);
			expect(current?.generation === 2 && current.account.alias === "dytest-uncommitted").toBe(true);
			throw new Error("OWNED_ACCOUNT_ROLLBACK");
		})).toThrow("OWNED_ACCOUNT_ROLLBACK");
		f.database.write((scope) => {
			const current = f.accounts.get(scope, owner, value.id);
			expect(current?.generation === 1 && current.account.alias === value.alias).toBe(true);
		});
		expect(f.count()).toEqual(before);
	});

	it("refuses retired/read/foreign-store/fabricated SQL without invoking hostile hooks", async () => {
		const value = email();
		f.database.write((scope) => f.accounts.create(scope, value));
		let retired: SqlTransaction | undefined;
		f.database.write((scope) => { retired = f.database.sql(scope); });
		expect(() => f.accounts.getInTransaction(retired as SqlTransaction, owner, value.id)).toThrow(AccountError);
		f.store.read((sql) => {
			expect(() => f.accounts.getInTransaction(sql as SqlTransaction, owner, value.id)).toThrow(AccountError);
		});
		const other = await fixture();
		try {
			other.database.write((scope) => {
				expect(() => f.accounts.getInTransaction(other.database.sql(scope), owner, value.id)).toThrow(AccountError);
			});
		} finally { other.cleanup(); }
		let hooks = 0;
		f.database.write((scope) => {
			const sql = f.database.sql(scope);
			const proxy = new Proxy(sql, { get() { hooks++; throw new Error("OWNED_SQL_HOOK"); } });
			expect(() => f.accounts.getInTransaction(proxy, owner, value.id)).toThrow(AccountError);
			const fake = { get() { hooks++; }, all() { hooks++; }, run() { hooks++; } };
			expect(() => f.accounts.getInTransaction(fake as unknown as SqlTransaction, owner, value.id)).toThrow(AccountError);
		});
		expect(hooks === 0).toBe(true);
	});
});
