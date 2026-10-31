import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { newId } from "../../src/kernel/ids.ts";
import { HubStore, type SqlReader } from "../../src/store/store.ts";
import { expectErased, refusal, type SessionFixture, sessionFixture } from "./session-helpers.ts";

const EXPECTED = [
	["audit", ["0001_chain"]],
	["core", ["0001_identity"]],
	["jobs", ["0001_jobs"]],
	["events", ["0001_events"]],
	["revisions", ["0001_native_revisions", "0002_immutable_revisions"]],
	["credentials", ["0001_credentials"]],
	["tickets", ["0001_send_attempts"]],
] as const;
const DOMAIN_TABLES = [
	"approval_pins",
	"audit_events",
	"audit_meta",
	"credentials",
	"event_meta",
	"events",
	"hub_meta",
	"jobs",
	"jobs_meta",
	"native_draft_locks",
	"native_draft_revisions",
	"native_drafts",
	"native_send_attempts",
	"users",
];
const PENDING_IDENTITY =
	"SELECT identity_wrapped IS NULL AS transport, statement_wrapped IS NULL AS signing, identity_cert IS NULL AS certificate FROM main.hub_meta WHERE singleton=1";
const migrateStore = HubStore.prototype.migrate;
const closeStore = HubStore.prototype.close;
const readStore = HubStore.prototype.read;

function bookkeeping(db: SqlReader) {
	return EXPECTED.map(([namespace]) => ({
		namespace,
		rows: db.all<{ name: string; timestamp: string }>(
			`SELECT name, timestamp FROM main._migrations_${namespace} ORDER BY name`,
		),
	}));
}

function expectSchemas(store: HubStore): void {
	store.read((db) => {
		const tables = db
			.all<{ name: string }>("SELECT name FROM main.sqlite_schema WHERE type='table' ORDER BY name")
			.map(({ name }) => name);
		expect(
			tables.filter((name) => !name.startsWith("_migrations_") && !name.startsWith("sqlite_")),
		).toEqual(DOMAIN_TABLES);
		for (const [namespace, migrations] of EXPECTED) {
			expect(tables).toContain(`_migrations_${namespace}`);
			expect(tables).toContain(`_migrations_${namespace}_lock`);
			expect(db.all(`SELECT name FROM main._migrations_${namespace} ORDER BY name`)).toEqual(
				migrations.map((name) => ({ name })),
			);
		}
		expect(db.get("SELECT singleton FROM main.jobs_meta")).toEqual({ singleton: 1 });
		expect(db.get("SELECT singleton, last_seq, floor_seq FROM main.event_meta")).toEqual({
			singleton: 1,
			last_seq: 0,
			floor_seq: 0,
		});
		for (const table of [
			"credentials",
			"native_drafts",
			"native_draft_revisions",
			"native_draft_locks",
			"native_send_attempts",
		])
			expect(db.get(`SELECT COUNT(*) AS count FROM main.${table}`)).toEqual({ count: 0 });
	});
}

let f: SessionFixture;
beforeEach(() => {
	f = sessionFixture("draftyak-session-schemas-");
});
afterEach(() => f.remove());

describe("native component schemas in an unlocked session", () => {
	it("migrates real storage before creating identity and preserves schemas, audit and identity on reopen", async () => {
		let firstOpening = true;
		const order: string[] = [];
		const identityCheckpoints: { namespace: string; row: unknown }[] = [];
		const applied: string[][] = [];
		const spy = vi.spyOn(HubStore.prototype, "migrate").mockImplementation(async function (
			this: HubStore,
			namespace: string,
		) {
			const result = await migrateStore.call(this, namespace);
			order.push(namespace);
			applied.push(result);
			if (firstOpening && namespace !== "audit")
				identityCheckpoints.push({ namespace, row: this.read((db) => db.get(PENDING_IDENTITY)) });
			return result;
		});
		try {
			const firstKey = f.key();
			const first = await f.open({ masterKey: firstKey });
			expectSchemas(first.store);
			expect(order).toEqual(EXPECTED.map(([namespace]) => namespace));
			expect(applied).toEqual(EXPECTED.map(([, migrations]) => migrations));
			expect(identityCheckpoints).toEqual(
				EXPECTED.slice(1).map(([namespace]) => ({
					namespace,
					row: { transport: 1, signing: 1, certificate: 1 },
				})),
			);
			const identity = [first.hubId, first.hid, first.identity.certificate];
			const migrations = first.store.read(bookkeeping);
			const event = {
				id: newId(1),
				at: 1,
				action: "session.schema.ready",
				actor: { kind: "hub" as const, id: null },
				refs: {},
			};
			first.store.write((tx) => first.audit.append(tx, event));
			first.store.read((db) => first.audit.verify(db));
			const audit = first.store.read((db) => first.audit.exportVerifiedJsonl(db));
			expect(audit.count).toBe(1);
			expect(JSON.parse(audit.jsonl).action).toBe("session.schema.ready");
			first.close();
			expectErased(firstKey);

			firstOpening = false;
			const second = await f.open();
			expectSchemas(second.store);
			expect(order).toEqual([...EXPECTED, ...EXPECTED].map(([namespace]) => namespace));
			expect(applied.slice(EXPECTED.length)).toEqual(EXPECTED.map(() => []));
			expect(second.store.read(bookkeeping)).toEqual(migrations);
			expect([second.hubId, second.hid, second.identity.certificate]).toEqual(identity);
			second.store.read((db) => second.audit.verify(db));
			expect(second.store.read((db) => second.audit.exportVerifiedJsonl(db))).toEqual(audit);
		} finally {
			spy.mockRestore();
		}
	});

	it("closes the real failed store, erases the handed key and recovers the folder after a late migration fault", async () => {
		let failedStore: HubStore | undefined;
		let pendingIdentity: unknown;
		const order: string[] = [];
		const spy = vi.spyOn(HubStore.prototype, "migrate").mockImplementation(async function (
			this: HubStore,
			namespace: string,
		) {
			order.push(namespace);
			if (namespace === "tickets") {
				failedStore = this;
				pendingIdentity = this.read((db) => db.get(PENDING_IDENTITY));
				throw new Error("DYTEST-PRIVATE-TICKETS-MIGRATION");
			}
			return migrateStore.call(this, namespace);
		});
		try {
			const key = f.key();
			const error = await refusal(f.open({ masterKey: key }));
			expect(error).toMatchObject({ code: "STORE_UNAVAILABLE", message: "STORE_UNAVAILABLE" });
			expect(error.cause).toBeUndefined();
			expect(String(error)).not.toContain("DYTEST-PRIVATE-TICKETS-MIGRATION");
			expectErased(key);
			expect(order).toEqual(EXPECTED.map(([namespace]) => namespace));
			expect(pendingIdentity).toEqual({ transport: 1, signing: 1, certificate: 1 });
			expect(failedStore).toBeInstanceOf(HubStore);
			expect(() =>
				readStore.call(failedStore as HubStore, (db: SqlReader) => db.get("SELECT 1")),
			).toThrow("unavailable");
			spy.mockRestore();
			const recovered = await f.open();
			expectSchemas(recovered.store);
			recovered.store.read((db) => recovered.audit.verify(db));
			expect(recovered.hubId).toBe(recovered.identity.hubId);
		} finally {
			spy.mockRestore();
			if (failedStore) closeStore.call(failedStore);
		}
	});
});
