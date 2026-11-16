import { randomBytes } from "node:crypto";
import {
	lstatSync,
	mkdirSync,
	mkdtempSync,
	realpathSync,
	rmSync,
	type Stats,
	writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { expect, it } from "vitest";
import { MasterKey } from "../../src/kernel/master-key.ts";
import { HubStore } from "../../src/store/store.ts";
import { nativeBinding } from "./helpers.ts";

function removeFixture(dir: string, parent: string, born: Stats): void {
	const current = lstatSync(dir);
	if (
		path.dirname(dir) !== parent ||
		!path.basename(dir).startsWith("draftyak-replay-settings-") ||
		!current.isDirectory() ||
		current.isSymbolicLink() ||
		current.dev !== born.dev ||
		current.ino !== born.ino ||
		realpathSync(dir) !== dir
	)
		throw new Error("Replay settings fixture cleanup refused");
	rmSync(dir, { recursive: true, force: false });
}

it("replays a secure-delete-dependent migration and reopens its accepted schema", async () => {
	const parent = realpathSync(os.tmpdir());
	const dir = realpathSync(mkdtempSync(path.join(parent, "draftyak-replay-settings-")));
	const born = lstatSync(dir);
	const migrations = path.join(dir, "app");
	mkdirSync(migrations);
	writeFileSync(
		path.join(migrations, "0001_replay_settings.sql"),
		`CREATE TEMP TABLE replay_settings_refusal(value INTEGER) STRICT;
CREATE TEMP TRIGGER replay_settings_refuse BEFORE INSERT ON replay_settings_refusal
BEGIN SELECT RAISE(ABORT, 'DYTEST_REPLAY_SECURE_DELETE_REQUIRED'); END;
INSERT INTO replay_settings_refusal
SELECT 1 WHERE (SELECT secure_delete FROM pragma_secure_delete) IS NOT 1;
DROP TRIGGER temp.replay_settings_refuse;
DROP TABLE temp.replay_settings_refusal;
CREATE TABLE replay_settings_value(value INTEGER PRIMARY KEY) STRICT;
`,
	);
	const filename = path.join(dir, "hub.db");
	const bytes = randomBytes(32);
	const key = new MasterKey(bytes);
	bytes.fill(0);
	let store: HubStore | undefined;
	try {
		store = new HubStore({
			filename,
			nativeBinding,
			masterKey: key,
			create: true,
			migrations: { app: migrations },
		});
		await expect(store.migrate("app")).resolves.toEqual(["0001_replay_settings"]);
		store.write((tx) => tx.run("INSERT INTO replay_settings_value(value) VALUES(7)"));
		store.close();
		store = undefined;
		store = new HubStore({
			filename,
			nativeBinding,
			masterKey: key,
			migrations: { app: migrations },
		});
		expect(store.read((db) => db.get("SELECT value FROM replay_settings_value"))).toEqual({
			value: 7,
		});
		await expect(store.migrate("app")).resolves.toEqual([]);
	} finally {
		let closed = false;
		try {
			store?.close();
			closed = true;
		} finally {
			key.destroy();
			if (closed) removeFixture(dir, parent, born);
		}
	}
});
