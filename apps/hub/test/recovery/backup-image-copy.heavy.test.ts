import { createHash, generateKeyPairSync, randomBytes } from "node:crypto";
import {
	lstatSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	realpathSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, it } from "vitest";
import { AuditChain } from "../../src/audit/chain.ts";
import { newId } from "../../src/kernel/ids.ts";
import { MasterKey } from "../../src/kernel/master-key.ts";
import { HUB_NAMESPACES, migrateHubSchemas } from "../../src/kernel/namespaces.ts";
import { BackupImageCopyError, copyBackupImageRows } from "../../src/recovery/backup-image-copy.ts";
import { openEncrypted, type SqliteDatabase } from "../../src/store/open.ts";
import { HubStore, type SqlTransaction } from "../../src/store/store.ts";
import { nativeBinding } from "../store/helpers.ts";

let root: string;
let born: { readonly dev: number; readonly ino: number };
let key: MasterKey;
let audit: AuditChain;
let source: HubStore;
let template: HubStore;
const stores: HubStore[] = [];
const images: SqliteDatabase[] = [];
const temporary = realpathSync.native(os.tmpdir());
beforeEach(async () => {
	root = realpathSync.native(mkdtempSync(path.join(temporary, "draftyak-image-copy-")));
	born = lstatSync(root);
	const bytes = randomBytes(32);
	key = new MasterKey(bytes);
	bytes.fill(0);
	const derived = key.derive("audit");
	try {
		audit = new AuditChain(derived);
	} finally {
		derived.fill(0);
	}
	source = await store("source.db");
	template = await store("template.db");
});
afterEach(() => {
	try {
		for (const image of images.splice(0)) if (image.open) image.close();
		for (const store of stores.splice(0)) store.close();
	} finally {
		audit.destroy();
		key.destroy();
	}
	const current = lstatSync(root);
	if (
		path.dirname(root) !== temporary ||
		realpathSync.native(root) !== root ||
		current.isSymbolicLink() ||
		current.dev !== born.dev ||
		current.ino !== born.ino
	)
		throw new Error("Unowned image fixture folder");
	rmSync(root, { recursive: true, force: false });
});
async function store(name: string, extra: Readonly<Record<string, string>> = {}) {
	const created = new HubStore({
		filename: path.join(root, name),
		nativeBinding,
		masterKey: key,
		create: true,
		migrations: { ...HUB_NAMESPACES, ...extra },
	});
	stores.push(created);
	await migrateHubSchemas(created);
	return created;
}
function image(name = "image.db"): SqliteDatabase {
	const opened = openEncrypted(
		{ filename: path.join(root, name), nativeBinding, create: true },
		key,
		"db",
	);
	images.push(opened);
	return opened;
}
function copy(source: HubStore, destination: SqliteDatabase, template: HubStore): void {
	source.write((reader) =>
		template.read((canonical) => copyBackupImageRows(reader, destination, canonical)),
	);
}
function reopen(filename = "image.db", masterKey = key): HubStore {
	const opened = new HubStore({
		filename: path.join(root, filename),
		nativeBinding,
		masterKey,
	});
	stores.push(opened);
	return opened;
}
function roundTrip(source: HubStore, template: HubStore) {
	const expected = snapshot(source);
	const destination = image();
	copy(source, destination, template);
	expect(destination.pragma("foreign_key_check")).toEqual([]);
	expect(destination.pragma("foreign_keys", { simple: true })).toBe(1);
	expect(destination.pragma("recursive_triggers", { simple: true })).toBe(1);
	destination.pragma("wal_checkpoint(TRUNCATE)");
	destination.close();
	const restored = reopen();
	const actual = snapshot(restored);
	expect(actual).toEqual(expected);
	return { expected, restored, actual };
}
function auditRow(refs: Record<string, string> = {}, action = "backup.fixture") {
	return { id: newId(), at: 1000, action, actor: { kind: "hub" as const, id: null }, refs };
}
function append(source: HubStore, action = "backup.fixture"): void {
	source.write((sql) => audit.append(sql, auditRow({}, action)));
}
function insertJob(sql: SqlTransaction, seq: bigint | null): void {
	sql.run(
		"INSERT INTO jobs(seq,id,account_id,owner_id,kind,ref_id,state,attempts,max_attempts,created_at,next_at) VALUES(?, ?, ?, ?, 'sync', ?, 'PENDING',0,3,1000,1000)",
		[seq, newId(), newId(), newId(), newId()],
	);
}
function expectRefusal(source: HubStore, destination: SqliteDatabase, template: HubStore): void {
	let error: unknown;
	try {
		copy(source, destination, template);
	} catch (caught) {
		error = caught;
	}
	expect(error).toBeInstanceOf(BackupImageCopyError);
	expect(error).toMatchObject({
		code: "BACKUP_IMAGE_COPY_UNAVAILABLE",
		message: "Backup image copy unavailable",
	});
	expect(Object.hasOwn(error as object, "cause")).toBe(false);
	expect(destination.prepare("SELECT name FROM sqlite_schema").all()).toEqual([]);
}
function snapshot(source: HubStore) {
	return source.read((sql) => ({
		authority: sql.get("SELECT * FROM device_authority"),
		devices: sql.all("SELECT * FROM devices ORDER BY id"),
		users: sql.all("SELECT * FROM users ORDER BY id"),
		registryIdentities: sql.all("SELECT * FROM plugin_registry_identities ORDER BY id"),
		candidates: sql.all("SELECT * FROM plugin_candidates ORDER BY id"),
		head: sql.get("SELECT * FROM audit_meta"),
		events: sql.all("SELECT * FROM audit_events ORDER BY seq"),
		sequences: sql.all("SELECT name,CAST(seq AS TEXT) AS seq FROM sqlite_sequence ORDER BY rowid"),
		wrapped: sql.get<{ value: Uint8Array }>("SELECT identity_wrapped AS value FROM hub_meta")
			?.value,
		job: sql.get<{ seq: string }>("SELECT CAST(seq AS TEXT) AS seq FROM jobs")?.seq,
	}));
}
function seedDeviceCycle(source: HubStore): readonly string[] {
	const [user, first, second] = [newId(), newId(), newId()] as const;
	source.write((sql) => {
		sql.run("INSERT INTO users(id,created_at) VALUES(?,?)", [user, 1000]);
		const [registry, version] = [newId(), newId()] as const;
		const put = (name: string, values: (string | number | null)[]) =>
			sql.run(`INSERT INTO ${name} VALUES(${values.map(() => "?").join(",")})`, values);
		put("plugin_versions", [version, "DYTEST-copy", "1.0.0", "{}", 1000]);
		put("plugin_registry_identities", [registry, "DYTEST-copy", user, 3]);
		put("plugin_candidates", [newId(), registry, version, 0, null, null, 1000]);
		for (let epoch = 1; epoch <= 3; epoch++)
			sql.run("UPDATE device_authority SET epoch=? WHERE singleton=1", [epoch]);
		sql.run("UPDATE device_authority SET bootstrap_done=1,owner_user_id=? WHERE singleton=1", [
			user,
		]);
		for (const id of [first, second]) {
			const publicKey = generateKeyPairSync("ec", { namedCurve: "prime256v1" }).publicKey;
			const spki = publicKey.export({ type: "spki", format: "der" });
			const fingerprint = createHash("sha256").update(spki).digest("hex");
			sql.run(
				"INSERT INTO devices(id,user_id,role,name,spki_sha256,approval_key,key_class,claim_window,paired_epoch,paired_at) VALUES(?,?,'device','DYTEST image row',?,?,'dev','sidecar',3,1000)",
				[id, user, fingerprint, spki.toString("base64url")],
			);
		}
		// SQL DATA fixture, not device admission: a valid self-FK cycle cannot use paged insert ordering.
		for (const [id, by] of [
			[first, second],
			[second, first],
		])
			sql.run(
				"UPDATE devices SET capabilities=3,confirmed_epoch=3,confirmed_via='approver',confirmed_preset='cli',confirmed_by=?,confirmed_at=1000 WHERE id=?",
				[by ?? null, id ?? null],
			);
	});
	append(source);
	return [first, second];
}
it("copies epoch above one and a real FK cycle before installing all canonical guards", async () => {
	const ids = seedDeviceCycle(source);
	const { expected, restored, actual } = roundTrip(source, template);
	expect(actual.devices).toHaveLength(2);
	for (const id of ids)
		expect(expected.devices).toContainEqual(expect.objectContaining({ confirmed_by: id }));
	restored.read((sql) => audit.verify(sql));
	for (const [statement, message] of [
		["DELETE FROM device_authority", "permanent"],
		["UPDATE device_authority SET epoch=5", "forward"],
		["UPDATE audit_events SET action='backup.changed'", "append only"],
		["DELETE FROM audit_events", "append only"],
	] as const)
		expect(() => restored.write((sql) => sql.run(statement))).toThrow(message);
	append(restored, "backup.restored");
	restored.read((sql) => audit.verify(sql));
	expect(
		restored.read((sql) => sql.get<{ n: number }>("SELECT count(*) AS n FROM audit_events")?.n),
	).toBe(2);
});
it("preserves nondefault durable native pause state in the copied image", () => {
	expect(
		template.read((sql) => sql.get("SELECT singleton,sync_paused FROM native_runtime_settings")),
	).toEqual({ singleton: 1, sync_paused: 0 });
	source.write((sql) =>
		sql.run("UPDATE native_runtime_settings SET sync_paused=1 WHERE singleton=1"),
	);
	const { restored } = roundTrip(source, template);
	for (const store of [source, restored])
		expect(
			store.read((sql) => sql.get("SELECT singleton,sync_paused FROM native_runtime_settings")),
		).toEqual({ singleton: 1, sync_paused: 1 });
});
it("pages literal rows and preserves BLOBs, full audit history and exact INT64 sequence state", async () => {
	const bytes = randomBytes(1024),
		userIds = Array.from({ length: 25 }, () => newId());
	const high = 9_007_199_254_741_029n;
	source.write((sql) => {
		for (const id of userIds) {
			sql.run("INSERT INTO users(id,created_at) VALUES(?,1000)", [id]);
			audit.append(sql, auditRow({ user: id }));
		}
		sql.run("UPDATE hub_meta SET identity_wrapped=? WHERE singleton=1", [bytes]);
		for (const seq of [high - 2n, high]) insertJob(sql, seq);
		sql.run("DELETE FROM jobs WHERE seq=?", [high]);
	});
	const { restored, actual } = roundTrip(source, template);
	expect(actual.wrapped).toEqual(bytes);
	expect(actual.sequences).toEqual([{ name: "jobs", seq: high.toString() }]);
	expect(actual.job).toBe((high - 2n).toString());
	restored.write((sql) => insertJob(sql, null));
	const sequences = restored.read((sql) =>
		sql.all<{ seq: string }>("SELECT CAST(seq AS TEXT) AS seq FROM jobs ORDER BY seq"),
	);
	const sequenceValues = sequences.map((row) => row.seq);
	expect(sequenceValues).toEqual([(high - 2n).toString(), (high + 1n).toString()]);
	restored.read((sql) => audit.verify(sql));
	expect(readFileSync(path.join(root, "image.db")).subarray(0, 16).toString()).not.toBe(
		"SQLite format 3\0",
	);
	const wrongBytes = randomBytes(32),
		wrong = new MasterKey(wrongBytes);
	wrongBytes.fill(0);
	try {
		expect(() => reopen("image.db", wrong)).toThrow();
	} finally {
		wrong.destroy();
		bytes.fill(0);
	}
});
it("refuses a nonempty destination without changing its original data", async () => {
	const destination = image();
	destination.exec(
		"CREATE TABLE own_marker(value TEXT) STRICT; INSERT INTO own_marker VALUES('DYTEST retained');",
	);
	expect(() => copy(source, destination, template)).toThrow(BackupImageCopyError);
	const marker = destination.prepare("SELECT value FROM own_marker").all();
	expect(marker).toEqual([{ value: "DYTEST retained" }]);
	expect(
		destination.prepare("SELECT name FROM sqlite_schema WHERE name='audit_events'").get(),
	).toBeUndefined();
});
it.each(["source", "template"] as const)(
	"rejects an unsupported %s namespace without changing the source or empty image",
	async (side) => {
		const migrations = path.join(root, "extra");
		mkdirSync(migrations, { mode: 0o700 });
		writeFileSync(
			path.join(migrations, "0001_extra.sql"),
			"CREATE TABLE private_extra(id TEXT PRIMARY KEY) STRICT;",
			{ mode: 0o600 },
		);
		const extra = { extra: migrations };
		const changed = await store(`${side}-extra.db`, extra);
		if (side === "source") source = changed;
		else template = changed;
		await changed.migrate("extra");
		append(source);
		const head = source.read((sql) => sql.get("SELECT * FROM audit_meta"));
		const destination = image();
		expectRefusal(source, destination, template);
		expect(source.read((sql) => sql.get("SELECT * FROM audit_meta"))).toEqual(head);
		expect(
			changed.read((sql) => sql.get("SELECT name FROM sqlite_schema WHERE name='private_extra'")),
		).toBeDefined();
		source.read((sql) => audit.verify(sql));
	},
);
it("refuses duplicate native sequence names without losing rows or creating an image schema", async () => {
	source.write((sql) => {
		insertJob(sql, null);
		for (let seq = 2; seq <= 9; seq++)
			sql.run("INSERT INTO sqlite_sequence(name,seq) VALUES('jobs',?)", [seq]);
	});
	const before = snapshot(source);
	expect(before.sequences).toHaveLength(9);
	const destination = image();
	expectRefusal(source, destination, template);
	expect(snapshot(source)).toEqual(before);
	source.read((sql) => audit.verify(sql));
});
