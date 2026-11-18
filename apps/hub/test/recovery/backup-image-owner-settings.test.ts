import { randomBytes } from "node:crypto";
import { lstatSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { OwnerSettings } from "@draftyak/protocol/entities/settings";
import { afterEach, expect, it } from "vitest";
import { MasterKey } from "../../src/kernel/master-key.ts";
import { HUB_NAMESPACES } from "../../src/kernel/namespaces.ts";
import { openNativeStorage } from "../../src/native-storage.ts";
import { BackupImageCopyError, copyBackupImageRows } from "../../src/recovery/backup-image-copy.ts";
import { openEncrypted, type SqliteDatabase } from "../../src/store/open.ts";
import { HubStore } from "../../src/store/store.ts";
import { nativeBinding } from "../store/helpers.ts";

const PREFIX = "draftyak-owner-settings-image-";
const CLEANUP = "Owner settings image fixture cleanup failed";
const DATA_USER_ID = "019a0000-0000-7000-8000-000000000001";
const CREATED_AT = 1_700_000_000_000;
const SETTINGS = OwnerSettings.parse({
	zone: "Europe/Paris",
	workingHours: { days: ["tue", "thu"], start: "08:30", end: "16:45" },
});
const SETTINGS_JSON = JSON.stringify(SETTINGS);

type Handle = HubStore | SqliteDatabase;
interface DataFixture {
	readonly directory: string;
	readonly parent: string;
	identity?: { readonly dev: bigint; readonly ino: bigint };
	key: MasterKey | undefined;
	readonly handles: Map<Handle, "owned" | "indeterminate">;
}
const fixtures = new Set<DataFixture>();

function dataFixture(): DataFixture {
	const parent = realpathSync.native(path.resolve(os.tmpdir()));
	const f: DataFixture = {
		parent,
		directory: mkdtempSync(path.join(parent, PREFIX)),
		key: undefined,
		handles: new Map(),
	};
	fixtures.add(f);
	const physical = lstatSync(f.directory, { bigint: true });
	if (!physical.isDirectory() || physical.isSymbolicLink()) throw new Error(CLEANUP);
	f.identity = { dev: physical.dev, ino: physical.ino };
	const bytes = randomBytes(32);
	try {
		f.key = new MasterKey(bytes);
	} finally {
		bytes.fill(0);
	}
	return f;
}

function options(f: DataFixture, name: string) {
	if (!f.key) throw new Error("Owner settings image fixture key unavailable");
	return { filename: path.join(f.directory, name), nativeBinding, masterKey: f.key };
}

function retain<T extends Handle>(f: DataFixture, handle: T): T {
	f.handles.set(handle, "owned");
	return handle;
}

function close(f: DataFixture, handle: Handle): void {
	if (f.handles.get(handle) !== "owned") throw new Error(CLEANUP);
	f.handles.set(handle, "indeterminate");
	handle.close();
	f.handles.delete(handle);
}

async function store(f: DataFixture, name: string): Promise<HubStore> {
	return retain(f, await openNativeStorage({ ...options(f, name), create: true }));
}

function image(f: DataFixture): SqliteDatabase {
	const input = options(f, "image.db");
	return retain(
		f,
		openEncrypted({ filename: input.filename, nativeBinding, create: true }, input.masterKey, "db"),
	);
}

afterEach(() => {
	let failed = false;
	for (const f of fixtures) {
		for (const [handle, state] of f.handles) {
			if (state !== "owned") {
				failed = true;
				continue;
			}
			try {
				close(f, handle);
			} catch {
				failed = true;
			}
		}
		try {
			f.key?.destroy();
			f.key = undefined;
		} catch {
			failed = true;
		}
		if (f.handles.size !== 0 || f.key !== undefined) continue;
		try {
			const resolved = realpathSync.native(f.directory);
			const physical = lstatSync(f.directory, { bigint: true });
			if (
				!path.isAbsolute(f.directory) ||
				resolved !== f.directory ||
				path.dirname(resolved) !== f.parent ||
				!path.basename(resolved).startsWith(PREFIX) ||
				!physical.isDirectory() ||
				physical.isSymbolicLink() ||
				physical.dev !== f.identity?.dev ||
				physical.ino !== f.identity?.ino
			)
				throw new Error(CLEANUP);
			rmSync(resolved, { recursive: true, force: false });
			fixtures.delete(f);
		} catch {
			failed = true;
		}
	}
	if (failed) throw new Error(CLEANUP);
});

function populateSettingsData(source: HubStore): void {
	source.write((tx) => {
		tx.run("INSERT INTO users(id,created_at) VALUES(?,?)", [DATA_USER_ID, CREATED_AT]);
		tx.run("INSERT INTO owner_settings(user_id,settings_json) VALUES(?,?)", [
			DATA_USER_ID,
			SETTINGS_JSON,
		]);
	});
}

function settingsData(source: HubStore) {
	return source.read((db) => ({
		users: db.all("SELECT id,created_at FROM main.users ORDER BY id"),
		settings: db.all("SELECT user_id,settings_json FROM main.owner_settings ORDER BY user_id"),
		ledger: db.all("SELECT name,timestamp FROM main._migrations_ownersettings ORDER BY name"),
		lock: db.all("SELECT id,is_locked FROM main._migrations_ownersettings_lock ORDER BY id"),
	}));
}

function copy(source: HubStore, destination: SqliteDatabase, template: HubStore): void {
	source.read((reader) =>
		template.read((canonical) => copyBackupImageRows(reader, destination, canonical)),
	);
}

it("copies populated owner settings into an encrypted image without changing the source", async () => {
	const f = dataFixture();
	const source = await store(f, "source.db");
	const template = await store(f, "template.db");
	populateSettingsData(source);
	const before = settingsData(source);
	expect(before.users).toEqual([{ id: DATA_USER_ID, created_at: CREATED_AT }]);
	expect(before.settings).toEqual([{ user_id: DATA_USER_ID, settings_json: SETTINGS_JSON }]);
	expect(before.ledger).toHaveLength(1);
	expect(before.ledger[0]).toMatchObject({ name: "0001_owner_settings" });
	expect(before.lock).toHaveLength(1);
	expect(before.lock[0]).toMatchObject({ is_locked: 0 });
	expect(settingsData(template).settings).toEqual([]);
	const destination = image(f);
	copy(source, destination, template);
	expect(settingsData(source)).toEqual(before);
	close(f, destination);
	const copied = retain(f, new HubStore(options(f, "image.db")));
	expect(settingsData(copied)).toEqual(before);
});

it("refuses a registered extra data schema before writing the image", async () => {
	const f = dataFixture();
	const initial = await store(f, "source.db");
	const template = await store(f, "template.db");
	populateSettingsData(initial);
	const before = settingsData(initial);
	close(f, initial);
	const folder = path.join(f.directory, "future-data");
	mkdirSync(folder);
	writeFileSync(
		path.join(folder, "0001_future_data.sql"),
		"CREATE TABLE future_settings_data(id TEXT PRIMARY KEY, value TEXT NOT NULL) STRICT;\n",
	);
	const source = retain(
		f,
		new HubStore({
			...options(f, "source.db"),
			migrations: { ...HUB_NAMESPACES, futuredata: folder },
		}),
	);
	await expect(source.migrate("futuredata")).resolves.toEqual(["0001_future_data"]);
	source.write((tx) =>
		tx.run("INSERT INTO future_settings_data(id,value) VALUES(?,?)", ["f1", "DATA"]),
	);
	expect(source.read((db) => db.all("SELECT id,value FROM main.future_settings_data"))).toEqual([
		{ id: "f1", value: "DATA" },
	]);
	expect(settingsData(source)).toEqual(before);
	const destination = image(f);
	let failure: unknown;
	try {
		copy(source, destination, template);
	} catch (error) {
		failure = error;
	}
	expect(failure).toBeInstanceOf(BackupImageCopyError);
	expect((failure as Error).message).toBe("Backup image copy unavailable");
	expect(destination.prepare("SELECT name FROM main.sqlite_schema").all()).toEqual([]);
	expect(settingsData(source)).toEqual(before);
	expect(source.read((db) => db.all("SELECT id,value FROM main.future_settings_data"))).toEqual([
		{ id: "f1", value: "DATA" },
	]);
});
