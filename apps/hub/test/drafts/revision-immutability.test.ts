import { randomBytes } from "node:crypto";
import { copyFileSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, it } from "vitest";
import { AuditChain } from "../../src/audit/chain.ts";
import { NativeDraftRevisions } from "../../src/drafts/revisions.ts";
import { newId } from "../../src/kernel/ids.ts";
import { MasterKey } from "../../src/kernel/master-key.ts";
import { HubStore, type SqlValue } from "../../src/store/store.ts";
import { migrations, nativeBinding } from "../store/helpers.ts";

const revisionMigrations = path.resolve(import.meta.dirname, "../../src/drafts/migrations");
const original = "0001_native_revisions.sql";
const immutable = "0002_immutable_revisions.sql";
const first = "01ARZ3NDEKTSV4RRFFQ69G5FA0";
const second = "01ARZ3NDEKTSV4RRFFQ69G5FA1";
const mac = "0".repeat(64);
const refusal = "Draft revisions are immutable";
interface Row {
	draft_id: string;
	rev: number;
	payload: string;
	previous: string;
	mac: string;
}
interface Fixture {
	dir: string;
	key: MasterKey;
	store: HubStore;
	upgrade(): Promise<string[]>;
}
const fixtures: Fixture[] = [];

afterEach(() => {
	for (const { dir, key, store } of fixtures.splice(0)) {
		store.close();
		key.destroy();
		if (
			path.dirname(dir) !== os.tmpdir() ||
			!path.basename(dir).startsWith("draftyak-revision-sql-")
		)
			throw new Error("Revision fixture cleanup scope refused");
		rmSync(dir, { recursive: true, force: true });
	}
});

async function fixture(legacy = false): Promise<Fixture> {
	const dir = mkdtempSync(path.join(os.tmpdir(), "draftyak-revision-sql-"));
	let revisionDirectory = revisionMigrations;
	if (legacy) {
		revisionDirectory = path.join(dir, "legacy");
		mkdirSync(revisionDirectory);
		copyFileSync(path.join(revisionMigrations, original), path.join(revisionDirectory, original));
	}
	const key = new MasterKey(randomBytes(32));
	const options = {
		filename: path.join(dir, "hub.db"),
		nativeBinding,
		masterKey: key,
		migrations: { audit: path.join(migrations, "audit"), revisions: revisionDirectory },
	};
	const result: Fixture = {
		dir,
		key,
		store: new HubStore({ ...options, create: true }),
		async upgrade() {
			result.store.close();
			result.store = new HubStore({
				...options,
				migrations: { ...options.migrations, revisions: revisionMigrations },
			});
			return result.store.migrate("revisions");
		},
	};
	fixtures.push(result);
	await result.store.migrate("audit");
	expect(await result.store.migrate("revisions")).toEqual(
		(legacy ? [original] : [original, immutable]).map((name) => name.slice(0, -4)),
	);
	result.store.write((tx) => {
		for (const id of [first, second])
			tx.run("INSERT INTO native_drafts(id,payload,audit_seq,mac) VALUES (?,'{}',1,?)", [id, mac]);
		for (const rev of [1, 2])
			tx.run("INSERT INTO native_draft_revisions VALUES (?,?,?,?,?)", [
				first,
				rev,
				JSON.stringify({ body: `DYTEST revision ${rev}` }),
				rev === 1 ? "" : mac,
				mac,
			]);
	});
	return result;
}

const rows = (store: HubStore): Row[] =>
	store.read((tx) =>
		tx.all<Row>(
			"SELECT draft_id,rev,payload,previous,mac FROM native_draft_revisions ORDER BY draft_id,rev",
		),
	);

const updates: readonly [string, readonly SqlValue[]][] = [
	["UPDATE native_draft_revisions SET payload=? WHERE draft_id=? AND rev=1", ["changed", first]],
	["UPDATE native_draft_revisions SET mac=? WHERE draft_id=? AND rev=1", ["a".repeat(64), first]],
	["UPDATE native_draft_revisions SET previous=? WHERE draft_id=? AND rev=1", [mac, first]],
	["UPDATE native_draft_revisions SET rev=3 WHERE draft_id=? AND rev=1", [first]],
	["UPDATE native_draft_revisions SET draft_id=? WHERE draft_id=? AND rev=1", [second, first]],
	["UPDATE native_draft_revisions SET payload=payload WHERE draft_id=?", [first]],
	["UPDATE OR IGNORE native_draft_revisions SET payload=? WHERE draft_id=?", ["changed", first]],
	["UPDATE OR REPLACE native_draft_revisions SET rev=2 WHERE draft_id=? AND rev=1", [first]],
	[
		"WITH chosen AS (SELECT ?) UPDATE main.native_draft_revisions SET payload='changed' WHERE draft_id IN chosen",
		[first],
	],
];

it.each(updates)("refuses prior-revision mutation through %s", async (sql, bindings) => {
	const { store } = await fixture();
	const before = rows(store);
	expect(() => store.write((tx) => tx.run(sql, bindings))).toThrow(refusal);
	expect(rows(store)).toEqual(before);
});

it("aborts the enclosing write so changes made before a refused update do not commit", async () => {
	const { store } = await fixture();
	const before = rows(store);
	expect(() =>
		store.write((tx) => {
			tx.run("INSERT INTO native_draft_revisions VALUES (?,3,'new',?,?)", [first, mac, mac]);
			tx.run("UPDATE native_draft_revisions SET payload='changed' WHERE draft_id=? AND rev=1", [
				first,
			]);
		}),
	).toThrow(refusal);
	expect(rows(store)).toEqual(before);
});

it.each(["INSERT", "INSERT OR IGNORE", "INSERT OR REPLACE", "REPLACE"])(
	"refuses %s replacement before a conflicting primary key can erase a row",
	async (insert) => {
		const { store } = await fixture();
		const before = rows(store);
		expect(() =>
			store.write((tx) =>
				tx.run(`${insert} INTO native_draft_revisions VALUES (?,1,'changed','',?)`, [first, mac]),
			),
		).toThrow(refusal);
		expect(rows(store)).toEqual(before);
	},
);

it.each(["DO UPDATE SET payload=excluded.payload", "DO UPDATE SET rev=3", "DO NOTHING"])(
	"refuses a conflicting UPSERT %s without changing history",
	async (action) => {
		const { store } = await fixture();
		const before = rows(store);
		expect(() =>
			store.write((tx) =>
				tx.run(
					`INSERT INTO native_draft_revisions VALUES (?,1,'changed','',?) ON CONFLICT(draft_id,rev) ${action}`,
					[first, mac],
				),
			),
		).toThrow(refusal);
		expect(rows(store)).toEqual(before);
	},
);

it.each(["rowid", "oid", "_rowid_"])(
	"offers no hidden %s alias for replacing another revision",
	async (alias) => {
		const { store } = await fixture();
		const before = rows(store);
		expect(() =>
			store.write((tx) =>
				tx.run(
					`INSERT OR REPLACE INTO native_draft_revisions(${alias},draft_id,rev,payload,previous,mac) VALUES (1,?,1,'changed','',?)`,
					[second, mac],
				),
			),
		).toThrow(`has no column named ${alias}`);
		expect(() => store.read((tx) => tx.get(`SELECT ${alias} FROM native_draft_revisions`))).toThrow(
			`no such column: ${alias}`,
		);
		expect(rows(store)).toEqual(before);
	},
);

it("permits new revisions, a new draft's first revision and explicit purge deletes", async () => {
	const { store } = await fixture();
	store.write((tx) => {
		tx.run("INSERT INTO native_draft_revisions VALUES (?,3,'third',?,?)", [first, mac, mac]);
		tx.run("INSERT INTO native_draft_revisions VALUES (?,1,'other','',?)", [second, mac]);
	});
	expect(rows(store).map(({ draft_id, rev }) => [draft_id, rev])).toEqual([
		[first, 1],
		[first, 2],
		[first, 3],
		[second, 1],
	]);
	store.write((tx) => {
		tx.run("DELETE FROM native_draft_revisions WHERE draft_id=?", [first]);
		tx.run("DELETE FROM native_drafts WHERE id=?", [first]);
	});
	expect(rows(store).map(({ draft_id, rev }) => [draft_id, rev])).toEqual([[second, 1]]);
});

it("upgrades existing 0001 history without rewriting it and keeps guards after reopen", async () => {
	const f = await fixture(true);
	const before = rows(f.store);
	expect(await f.upgrade()).toEqual([immutable.slice(0, -4)]);
	expect(rows(f.store)).toEqual(before);
	expect(await f.upgrade()).toEqual([]);
	expect(() =>
		f.store.write((tx) => tx.run("UPDATE native_draft_revisions SET payload='changed'")),
	).toThrow(refusal);
	expect(rows(f.store)).toEqual(before);
});

it("preserves authenticated revision payloads, MACs and audit entries across the forward rebuild", async () => {
	const f = await fixture(true);
	const auditKey = f.key.derive("audit"),
		audit = new AuditChain(auditKey);
	auditKey.fill(0);
	let revisions = new NativeDraftRevisions(f.store, audit, f.key);
	try {
		const input = {
			draftId: newId(),
			accountId: newId(),
			conversationId: newId(),
			channel: "chat" as const,
			author: { kind: "owner" as const, id: newId() },
			content: {
				channel: "chat" as const,
				body: "DYTEST authenticated",
				threadTs: null,
				broadcast: false,
			},
			flags: [],
		};
		const { draftId, accountId, conversationId, channel } = input;
		const bound = { draftId, accountId, conversationId, channel };
		f.store.write((tx) => revisions.createInTransaction(tx, input));
		const current = f.store.write((tx) =>
			revisions.appendInTransaction(tx, {
				...input,
				expectedRev: 1,
				content: { ...input.content, body: "DYTEST second" },
			}),
		);
		const before = rows(f.store);
		const auditRows = () => f.store.read((tx) => tx.all("SELECT * FROM audit_events ORDER BY seq"));
		const events = auditRows();
		revisions.destroy();
		expect(await f.upgrade()).toEqual([immutable.slice(0, -4)]);
		revisions = new NativeDraftRevisions(f.store, audit, f.key);
		expect(rows(f.store)).toEqual(before);
		expect(auditRows()).toEqual(events);
		expect(revisions.current(bound)).toEqual(current);
		expect(revisions.history(bound)).toHaveLength(2);
	} finally {
		revisions.destroy();
		audit.destroy();
	}
});
