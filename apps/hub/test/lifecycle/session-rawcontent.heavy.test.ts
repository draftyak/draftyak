import path from "node:path";
import { afterEach, expect, it } from "vitest";
import { HUB_NAMESPACES, migrateHubSchemas } from "../../src/kernel/namespaces.ts";
import { HubStore } from "../../src/store/store.ts";
import { nativeBinding, type SessionFixture, sessionFixture } from "./session-helpers.ts";

const fixtures: SessionFixture[] = [];

function fixture(): SessionFixture {
	const value = sessionFixture("draftyak-raw-registration-");
	fixtures.push(value);
	return value;
}

afterEach(async () => {
	let failures = 0;
	for (const value of fixtures.splice(0).reverse()) {
		try {
			await value.remove();
		} catch {
			failures++;
		}
	}
	expect(failures).toBe(0);
});

function rawTables(store: HubStore): string[] {
	return store.read((db) =>
		db
			.all<{ name: string }>(
				"SELECT name FROM main.sqlite_schema WHERE type='table' AND name IN (?, ?, ?) ORDER BY name",
				["_migrations_rawcontent", "rawcontent_chunks", "rawcontent_objects"],
			)
			.map((row) => String(row.name)),
	);
}

it("registers rawcontent on the original Session without applying it until explicitly requested", async () => {
	const files = fixture();
	const session = await files.open();
	expect(rawTables(session.store)).toEqual([]);
	expect(Object.hasOwn(HUB_NAMESPACES, "rawcontent")).toBe(false);
	await expect(session.store.migrate("rawcontent")).resolves.toEqual(["0001_raw"]);
	expect(rawTables(session.store)).toEqual([
		"_migrations_rawcontent",
		"rawcontent_chunks",
		"rawcontent_objects",
	]);
	const actual = session.store.read((db) =>
		db.all<{ name: string; sql: string }>(
			"SELECT name, sql FROM main.sqlite_schema WHERE type='table' AND name IN (?, ?) ORDER BY name",
			["rawcontent_chunks", "rawcontent_objects"],
		),
	);
	expect(actual).toHaveLength(2);
	for (const row of actual) expect(String(row.sql)).toMatch(/\bSTRICT\b/);
	expect(
		Number(
			session.store.read((db) =>
				db.get<{ count: number }>("SELECT count(*) AS count FROM rawcontent_objects"),
			)?.count,
		),
	).toBe(0);
	expect(
		Number(
			session.store.read((db) =>
				db.get<{ count: number }>("SELECT count(*) AS count FROM rawcontent_chunks"),
			)?.count,
		),
	).toBe(0);
	await expect(session.store.migrate("rawcontent")).resolves.toEqual([]);
	await session.close();
	const reopened = await files.open();
	expect(rawTables(reopened.store)).toEqual(rawTablesForAppliedMigration);
	await expect(reopened.store.migrate("rawcontent")).resolves.toEqual([]);
});

const rawTablesForAppliedMigration = [
	"_migrations_rawcontent",
	"rawcontent_chunks",
	"rawcontent_objects",
];

it("keeps rawcontent unregistered in a genuine Store constructed with kernel defaults only", async () => {
	const files = fixture();
	const key = files.key();
	let store: HubStore | undefined;
	try {
		store = new HubStore({
			filename: path.join(files.scratch(), "kernel.db"),
			nativeBinding,
			masterKey: key,
			create: true,
			migrations: HUB_NAMESPACES,
		});
		await migrateHubSchemas(store);
		expect(Object.hasOwn(HUB_NAMESPACES, "rawcontent")).toBe(false);
		expect(rawTables(store)).toEqual([]);
		await expect(store.migrate("rawcontent")).rejects.toThrow(
			"Migration namespace is not registered",
		);
		expect(rawTables(store)).toEqual([]);
	} finally {
		try {
			store?.close();
		} finally {
			key.destroy();
		}
	}
});
