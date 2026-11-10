import { createHash, randomBytes } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { Account } from "@draftyak/protocol/entities/account";
import { canonicalize } from "@draftyak/protocol/jcs";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	AccountError,
	NativeAccounts,
	restrictNativeAccountsForRestoreInTransaction,
} from "../../src/accounts/records.ts";
import { AuditChain } from "../../src/audit/chain.ts";
import { appendAccountRestoreChangedInTransaction, EventLog } from "../../src/events/log.ts";
import { WorkDatabase, type WorkScope } from "../../src/jobs/database.ts";
import { WorkError } from "../../src/jobs/values.ts";
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
		expect(() =>
			f.database.write((scope) => {
				const sql = f.database.sql(scope);
				f.accounts.replace(scope, { ...value, alias: "dytest-uncommitted" }, 1);
				const current = f.accounts.getInTransaction(sql, owner, value.id);
				expect(current?.generation === 2 && current.account.alias === "dytest-uncommitted").toBe(
					true,
				);
				throw new Error("OWNED_ACCOUNT_ROLLBACK");
			}),
		).toThrow("OWNED_ACCOUNT_ROLLBACK");
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
		f.database.write((scope) => {
			retired = f.database.sql(scope);
		});
		expect(() => f.accounts.getInTransaction(retired as SqlTransaction, owner, value.id)).toThrow(
			AccountError,
		);
		f.store.read((sql) => {
			expect(() => f.accounts.getInTransaction(sql as SqlTransaction, owner, value.id)).toThrow(
				AccountError,
			);
		});
		const other = await fixture();
		try {
			other.database.write((scope) => {
				expect(() =>
					f.accounts.getInTransaction(other.database.sql(scope), owner, value.id),
				).toThrow(AccountError);
			});
		} finally {
			other.cleanup();
		}
		let hooks = 0;
		f.database.write((scope) => {
			const sql = f.database.sql(scope);
			const proxy = new Proxy(sql, {
				get() {
					hooks++;
					throw new Error("OWNED_SQL_HOOK");
				},
			});
			expect(() => f.accounts.getInTransaction(proxy, owner, value.id)).toThrow(AccountError);
			const fake = {
				get() {
					hooks++;
				},
				all() {
					hooks++;
				},
				run() {
					hooks++;
				},
			};
			expect(() =>
				f.accounts.getInTransaction(fake as unknown as SqlTransaction, owner, value.id),
			).toThrow(AccountError);
		});
		expect(hooks === 0).toBe(true);
	});
});

// These existing metadata fixtures supply DATA, not native enrollment or send authority.
describe("account restore restriction and fixed metadata invalidation", () => {
	function state(): string {
		return createHash("sha256")
			.update(
				JSON.stringify(
					f.store.read((db) => ({
						accounts: db.all("SELECT * FROM main.accounts ORDER BY id"),
						audit: db.all("SELECT * FROM main.audit_events ORDER BY seq"),
						auditHead: db.all("SELECT * FROM main.audit_meta ORDER BY singleton"),
						events: db.all("SELECT * FROM main.events ORDER BY seq"),
						eventHead: db.all("SELECT * FROM main.event_meta ORDER BY singleton"),
					})),
				),
			)
			.digest("hex");
	}
	function head(): { audit: number; events: number } {
		return f.store.read((db) => ({
			audit:
				db.get<{ n: number }>("SELECT audit_seq AS n FROM main.audit_meta WHERE singleton=1")?.n ??
				-1,
			events:
				db.get<{ n: number }>("SELECT last_seq AS n FROM main.event_meta WHERE singleton=1")?.n ??
				-1,
		}));
	}
	function snapshot(value: Account) {
		return f.database.write((scope) => f.accounts.get(scope, value.userId, value.id));
	}
	function reset(): number {
		return f.store.write((tx) => restrictNativeAccountsForRestoreInTransaction(f.accounts, tx));
	}
	it("tightens both account shapes through another original same-store database and emits one fixed change per account", () => {
		const full = [email(), chat()].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
		const readOnly = email({ mode: "read_only" }),
			retired = email({ status: "disconnecting" });
		f.database.write((scope) => {
			for (const value of [...full, readOnly, retired]) f.accounts.create(scope, value);
			f.accounts.retire(scope, owner, retired.id, 1);
		});
		const unaffected = f.store.read((db) =>
			JSON.stringify(
				db.all("SELECT * FROM main.accounts WHERE id IN (?,?) ORDER BY id", [
					readOnly.id,
					retired.id,
				]),
			),
		);
		const before = head();
		const otherDatabase = new WorkDatabase(f.store);
		expect(
			otherDatabase.write((scope) =>
				restrictNativeAccountsForRestoreInTransaction(f.accounts, otherDatabase.sql(scope)),
			),
		).toBe(2);
		for (const value of full) {
			const current = snapshot(value);
			expect(
				current?.generation === 2 &&
					canonicalize(current.account) === canonicalize({ ...value, mode: "read_only" }),
			).toBe(true);
		}
		expect(
			f.store.read((db) =>
				JSON.stringify(
					db.all("SELECT * FROM main.accounts WHERE id IN (?,?) ORDER BY id", [
						readOnly.id,
						retired.id,
					]),
				),
			) === unaffected,
		).toBe(true);
		f.store.read((db) => {
			const audit = db.all<{ action: string; refs: string }>(
				"SELECT action,refs FROM main.audit_events WHERE seq>? ORDER BY seq",
				[before.audit],
			);
			const events = db.all<{
				user_id: string;
				account_id: string;
				data_class: string;
				kind: string;
				ids: string;
			}>(
				"SELECT user_id,account_id,data_class,kind,ids FROM main.events WHERE seq>? ORDER BY seq",
				[before.events],
			);
			expect(audit.length === 2 && events.length === 2).toBe(true);
			for (let i = 0; i < full.length; i++) {
				const value = full[i],
					action = audit[i],
					event = events[i];
				if (!value || !action || !event)
					throw new Error("DYTEST restore notice inventory unavailable");
				expect(
					action.action === "account.changed" &&
						canonicalize(JSON.parse(action.refs)) ===
							canonicalize({
								account: value.id,
								pluginInstance: value.pluginInstanceId,
								user: value.userId,
							}),
				).toBe(true);
				expect(
					event.user_id === value.userId &&
						event.account_id === value.id &&
						event.kind === "accounts.changed" &&
						event.ids === JSON.stringify([value.id]) &&
						event.data_class === (value.channel === "email" ? "gmail.metadata" : "slack.metadata"),
				).toBe(true);
			}
			f.audit.verify(db);
		});
		const settled = state();
		expect(reset()).toBe(0);
		expect(state()).toBe(settled);
	});
	it("refuses original foreign and retired transactions and proxy receivers before clock or DATA hooks", async () => {
		const other = await fixture();
		let clocks = 0,
			reads = 0;
		const now = () => {
			clocks++;
			return 2000;
		};
		const events = new EventLog(f.database, now);
		const accounts = new NativeAccounts(f.database, events, f.audit, now);
		const value = email();
		f.database.write((scope) => f.accounts.create(scope, value));
		const raw = {
			userId: owner,
			accountId: value.id,
			get channel() {
				reads++;
				return "email" as const;
			},
		};
		const ended = f.store.write((tx) => tx);
		const before = state();
		try {
			expect(() => restrictNativeAccountsForRestoreInTransaction(accounts, ended)).toThrow(
				AccountError,
			);
			expect(() => appendAccountRestoreChangedInTransaction(events, ended, raw)).toThrow(WorkError);
			other.store.write((tx) => {
				expect(() => restrictNativeAccountsForRestoreInTransaction(accounts, tx)).toThrow(
					AccountError,
				);
				expect(() => appendAccountRestoreChangedInTransaction(events, tx, raw)).toThrow(WorkError);
			});
			const effect = () => {
				reads++;
				throw new Error("DYTEST restore receiver hook");
			};
			f.store.write((tx) => {
				expect(() =>
					restrictNativeAccountsForRestoreInTransaction(new Proxy(accounts, { get: effect }), tx),
				).toThrow(AccountError);
				expect(() =>
					appendAccountRestoreChangedInTransaction(new Proxy(events, { get: effect }), tx, raw),
				).toThrow(WorkError);
			});
			expect(clocks === 0 && reads === 0).toBe(true);
			expect(state()).toBe(before);
			expect(
				f.store.write((tx) => restrictNativeAccountsForRestoreInTransaction(accounts, tx)),
			).toBe(1);
			expect(clocks > 0).toBe(true);
		} finally {
			other.cleanup();
		}
	});
	it("rolls an earlier restriction, audit and event back when a later metadata record is corrupt", () => {
		const values = [email(), chat()].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
		f.database.write((scope) => {
			for (const value of values) f.accounts.create(scope, value);
		});
		const first = values[0],
			last = values[1];
		if (!first || !last) throw new Error("DYTEST restore ordering unavailable");
		f.store.write((tx) => {
			expect(
				tx.run("UPDATE main.accounts SET account_json=? WHERE id=?", ["{{", last.id]).changes,
			).toBe(1);
		});
		const before = state();
		const beforeHead = head();
		let currentTx: SqlTransaction | undefined;
		let firstChanged = false,
			firstAudited = false;
		const events = new EventLog(f.database, () => {
			if (!currentTx) throw new Error("DYTEST original restore transaction unavailable");
			const row = currentTx.get<{ generation: number; account_json: string }>(
				"SELECT generation,account_json FROM main.accounts WHERE id=?",
				[first.id],
			);
			firstChanged = row?.generation === 2 && JSON.parse(row.account_json).mode === "read_only";
			firstAudited =
				currentTx.get<{ n: number }>(
					"SELECT count(*) AS n FROM main.audit_events WHERE seq>? AND action='account.changed' AND json_extract(refs,'$.account')=?",
					[beforeHead.audit, first.id],
				)?.n === 1;
			return 2000;
		});
		const accounts = new NativeAccounts(f.database, events, f.audit, () => 2000);
		// The original refusal escapes the real native write; no caught-error poison is claimed.
		expect(() =>
			f.store.write((tx) => {
				currentTx = tx;
				try {
					return restrictNativeAccountsForRestoreInTransaction(accounts, tx);
				} finally {
					currentTx = undefined;
				}
			}),
		).toThrow(AccountError);
		expect(firstChanged && firstAudited).toBe(true);
		expect(state()).toBe(before);
		const current = snapshot(first);
		expect(current?.generation === 1 && current.account.mode === "full").toBe(true);
		f.store.read((db) => f.audit.verify(db));
	});
	it("rolls both restrictions and earlier original audit/event writes back when the second event clock fails", () => {
		const values = [email(), chat()].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
		f.database.write((scope) => {
			for (const value of values) f.accounts.create(scope, value);
		});
		const first = values[0],
			last = values[1];
		if (!first || !last) throw new Error("DYTEST event rollback inventory unavailable");
		const before = state(),
			beforeHead = head();
		let tx: SqlTransaction | undefined;
		let clocks = 0,
			firstEventWritten = false,
			bothChanged = false,
			bothAudited = false;
		const events = new EventLog(f.database, () => {
			clocks++;
			if (clocks === 2) {
				if (!tx) throw new Error("DYTEST event rollback transaction unavailable");
				const prior = tx.get<{ account_id: string; kind: string; ids: string }>(
					"SELECT account_id,kind,ids FROM main.events WHERE seq=?",
					[beforeHead.events + 1],
				);
				firstEventWritten =
					prior?.account_id === first.id &&
					prior.kind === "accounts.changed" &&
					prior.ids === JSON.stringify([first.id]);
				const rows = tx.all<{ generation: number; account_json: string }>(
					"SELECT generation,account_json FROM main.accounts WHERE id IN (?,?) ORDER BY id",
					[first.id, last.id],
				);
				bothChanged =
					rows.length === 2 &&
					rows.every(
						(row) => row.generation === 2 && JSON.parse(row.account_json).mode === "read_only",
					);
				bothAudited =
					tx.get<{ n: number }>(
						"SELECT count(*) AS n FROM main.audit_events WHERE seq>? AND action='account.changed' AND json_extract(refs,'$.account') IN (?,?)",
						[beforeHead.audit, first.id, last.id],
					)?.n === 2;
				throw new Error("DYTEST second original event clock refusal");
			}
			return 2000;
		});
		const accounts = new NativeAccounts(f.database, events, f.audit, () => 2000);
		expect(() =>
			f.store.write((original) => {
				tx = original;
				try {
					return restrictNativeAccountsForRestoreInTransaction(accounts, original);
				} finally {
					tx = undefined;
				}
			}),
		).toThrow(AccountError);
		expect(clocks === 2 && firstEventWritten && bothChanged && bothAudited).toBe(true);
		expect(state()).toBe(before);
		for (const value of values) {
			const current = snapshot(value);
			expect(current?.generation === 1 && current.account.mode === "full").toBe(true);
		}
		f.store.read((db) => f.audit.verify(db));
	});
	it.each([100, 101])(
		"restricts exactly %i metadata accounts across the original page boundary",
		(count) => {
			const values = Array.from({ length: count }, () => email());
			f.database.write((scope) => {
				for (const value of values) f.accounts.create(scope, value);
			});
			const before = head();
			expect(reset()).toBe(count);
			for (const value of values) {
				const current = snapshot(value);
				expect(
					current?.generation === 2 &&
						canonicalize(current.account) === canonicalize({ ...value, mode: "read_only" }),
				).toBe(true);
			}
			const after = head();
			expect(after.audit === before.audit + count && after.events === before.events + count).toBe(
				true,
			);
			const settled = state();
			expect(reset()).toBe(0);
			expect(state()).toBe(settled);
		},
	);
	it("refuses exhausted account generation without an account, audit or event effect", () => {
		const value = email();
		f.database.write((scope) => f.accounts.create(scope, value));
		// Existing metadata-storage fixture setup, never an enrollment or authorization row.
		f.store.write((tx) => {
			expect(
				tx.run("UPDATE main.accounts SET generation=? WHERE id=?", [
					Number.MAX_SAFE_INTEGER,
					value.id,
				]).changes,
			).toBe(1);
		});
		const before = state();
		expect(() => reset()).toThrow(AccountError);
		expect(state()).toBe(before);
	});
	it("refuses caller event kind, ids and data-class overrides before clock or value hooks", () => {
		let clocks = 0,
			reads = 0;
		const events = new EventLog(f.database, () => {
			clocks++;
			return 2000;
		});
		const raw = { userId: owner, accountId: newId(), channel: "email" as const };
		const before = state();
		for (const name of ["kind", "ids", "dataClass"]) {
			const changed = { ...raw };
			Object.defineProperty(changed, name, {
				enumerable: true,
				get() {
					reads++;
					throw new Error("DYTEST restore event override");
				},
			});
			f.store.write((tx) => {
				expect(() => appendAccountRestoreChangedInTransaction(events, tx, changed)).toThrow(
					WorkError,
				);
			});
		}
		expect(clocks === 0 && reads === 0).toBe(true);
		expect(state()).toBe(before);
		const actual = f.store.write((tx) => appendAccountRestoreChangedInTransaction(events, tx, raw));
		expect(
			actual.kind === "accounts.changed" &&
				actual.dataClass === "gmail.metadata" &&
				JSON.stringify(actual.ids) === JSON.stringify([raw.accountId]) &&
				clocks === 1,
		).toBe(true);
	});
	it("preserves original scoped event ordering around the fixed same-transaction emitter", () => {
		f.database.write((scope) => {
			const first = f.events.append(scope, {
				userId: owner,
				accountId: null,
				dataClass: "gmail.metadata",
				kind: "settings.changed",
				ids: [],
			});
			const middle = appendAccountRestoreChangedInTransaction(f.events, f.database.sql(scope), {
				userId: owner,
				accountId: newId(),
				channel: "chat",
			});
			const last = f.events.append(scope, {
				userId: owner,
				accountId: null,
				dataClass: "gmail.metadata",
				kind: "settings.changed",
				ids: [],
			});
			expect(
				middle.seq === first.seq + 1 &&
					last.seq === middle.seq + 1 &&
					middle.kind === "accounts.changed" &&
					middle.dataClass === "slack.metadata",
			).toBe(true);
		});
	});
});
