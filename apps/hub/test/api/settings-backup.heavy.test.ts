import path from "node:path";
import { OwnerSettings } from "@draftyak/protocol/entities/settings";
import { canonicalize } from "@draftyak/protocol/jcs";
import { afterEach, expect, it } from "vitest";
import type { SqliteDatabase } from "../../src/store/open.ts";
import type { HubStore } from "../../src/store/store.ts";
import { requireLoopbackNetworkGuard } from "../helpers/loopback-network.ts";
import type { SessionFixture } from "../lifecycle/session-helpers.ts";

requireLoopbackNetworkGuard();
const [{ copyBackupImageRows }, { openEncrypted }, { HubStore: Store }, fixture] =
	await Promise.all([
		import("../../src/recovery/backup-image-copy.ts"),
		import("../../src/store/open.ts"),
		import("../../src/store/store.ts"),
		import("../lifecycle/session-helpers.ts"),
	]);

const fixtures: SessionFixture[] = [];
function temporary(): SessionFixture {
	const created = fixture.sessionFixture("draftyak-settings-backup-");
	fixtures.push(created);
	return created;
}

afterEach(async () => {
	let failed = false;
	for (const created of fixtures.splice(0)) {
		try {
			await created.remove();
		} catch {
			failed = true;
		}
	}
	if (failed) throw new Error("Settings backup fixture cleanup unavailable");
});

interface SettingsRow {
	readonly user_id: string;
	readonly settings_json: string;
}
interface MigrationRow {
	readonly name: string;
	readonly timestamp: string;
}
interface LockRow {
	readonly id: string;
	readonly is_locked: number;
}
const settingsSql = "SELECT user_id,settings_json FROM owner_settings ORDER BY user_id";
const migrationSql = "SELECT name,timestamp FROM _migrations_ownersettings ORDER BY name";
const lockSql = "SELECT id,is_locked FROM _migrations_ownersettings_lock ORDER BY id";
const catalogSql = "SELECT type,name,tbl_name,sql FROM main.sqlite_schema ORDER BY type,name";

it("copies owner settings and both migration tables into an empty native backup image", async () => {
	const sourceFixture = temporary();
	const templateFixture = temporary();
	// Both catalogues come from the genuine current session migration inventory.
	const source = await sourceFixture.open();
	const template = await templateFixture.open();
	const expected: SettingsRow[] = Array.from({ length: 9 }, (_, index) => ({
		user_id: `01${"0".repeat(22)}${String(index + 1).padStart(2, "0")}`,
		settings_json: canonicalize(
			OwnerSettings.parse({
				zone: "America/Chicago",
				workingHours: { days: ["mon", "wed"], start: `09:0${index}`, end: "17:00" },
			}),
		),
	}));
	// Synthetic business DATA exercises the copy, without claiming native owner authority.
	source.store.write((tx) => {
		for (const [index, row] of expected.entries()) {
			expect(
				tx.run("INSERT INTO users(id,created_at) VALUES(?,?)", [
					row.user_id,
					1_700_000_000_000 + index,
				]).changes,
			).toBe(1);
			expect(
				tx.run("INSERT INTO owner_settings(user_id,settings_json) VALUES(?,?)", [
					row.user_id,
					row.settings_json,
				]).changes,
			).toBe(1);
		}
	});
	const original = source.store.read((db) => ({
		settings: db.all<SettingsRow>(settingsSql),
		migrations: db.all<MigrationRow>(migrationSql),
		locks: db.all<LockRow>(lockSql),
		catalog: db.all(catalogSql),
		linked: db.get<{ n: number }>(
			"SELECT count(*) AS n FROM owner_settings s JOIN users u ON u.id=s.user_id",
		)?.n,
	}));
	expect(original.settings).toEqual(expected);
	expect(original.linked).toBe(9);
	expect(original.migrations.map((row) => row.name)).toEqual(["0001_owner_settings"]);
	expect(original.locks).toHaveLength(1);
	expect(original.locks[0]?.is_locked).toBe(0);
	const first = expected[0];
	if (!first) throw new Error("Settings backup DATA fixture unavailable");

	const filename = path.join(sourceFixture.scratch(), "settings-image.db");
	let image: SqliteDatabase | undefined;
	let reopened: HubStore | undefined;
	try {
		image = openEncrypted(
			{ filename, nativeBinding: fixture.nativeBinding, create: true },
			sourceFixture.key(),
		);
		const destination = image;
		expect(destination.prepare(catalogSql).all()).toEqual([]);
		expect(destination.pragma("foreign_keys", { simple: true })).toBe(1);
		expect(destination.pragma("recursive_triggers", { simple: true })).toBe(1);
		expect(() =>
			source.store.read((reader) =>
				template.store.read((canonical) => {
					copyBackupImageRows(reader, destination, canonical);
				}),
			),
		).not.toThrow();
		expect(destination.prepare(settingsSql).all()).toEqual(expected);
		expect(
			destination
				.prepare(
					"SELECT user_id,hex(CAST(settings_json AS BLOB)) AS bytes FROM owner_settings ORDER BY user_id",
				)
				.all(),
		).toEqual(
			expected.map((row) => ({
				user_id: row.user_id,
				bytes: Buffer.from(row.settings_json, "utf8").toString("hex").toUpperCase(),
			})),
		);
		expect(destination.prepare(migrationSql).all()).toEqual(original.migrations);
		expect(destination.prepare(lockSql).all()).toEqual(original.locks);
		expect(destination.prepare(catalogSql).all()).toEqual(original.catalog);
		expect(destination.pragma("foreign_key_check")).toEqual([]);
		expect(destination.pragma("integrity_check", { simple: true })).toBe("ok");
		expect(() =>
			destination
				.prepare("INSERT INTO owner_settings(user_id,settings_json) VALUES(?,?)")
				.run(`01${"0".repeat(22)}99`, first.settings_json),
		).toThrow(/FOREIGN KEY/);
		expect(destination.prepare(settingsSql).all()).toEqual(expected);
		destination.close();
		image = undefined;
		// No supplied migration map: the delivered catalogue must accept the copied namespace.
		reopened = new Store({
			filename,
			nativeBinding: fixture.nativeBinding,
			masterKey: sourceFixture.key(),
		});
		expect(reopened.read((db) => db.all<SettingsRow>(settingsSql))).toEqual(expected);
		expect(reopened.read((db) => db.all<MigrationRow>(migrationSql))).toEqual(original.migrations);
		expect(reopened.read((db) => db.all<LockRow>(lockSql))).toEqual(original.locks);
	} finally {
		try {
			reopened?.close();
		} finally {
			image?.close();
		}
	}
}, 60_000);
