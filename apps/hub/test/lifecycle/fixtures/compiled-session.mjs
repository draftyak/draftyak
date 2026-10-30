import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { mkdirSync, realpathSync } from "node:fs";
import path from "node:path";
import { MasterKey, openHubSession } from "./index.mjs";

assert.equal(process.permission?.has("net"), false);
const nativeBinding = process.argv[2];
assert.equal(typeof nativeBinding, "string");
mkdirSync(path.join(import.meta.dirname, "data"));
const folder = realpathSync.native(path.join(import.meta.dirname, "data"));
const bytes = randomBytes(32);
const open = () => openHubSession({ folder, nativeBinding, masterKey: new MasterKey(bytes) });
const first = await open();
let tables, reopened;
try {
	tables = first.store.read((db) => db.all(
		"SELECT name FROM main.sqlite_schema WHERE type='table' AND name IN ('audit_meta','hub_meta','users') ORDER BY name",
	)).map((row) => row.name);
	first.store.read((db) => first.audit.verify(db));
} finally {
	first.close();
}
const second = await open();
try {
	reopened = second.hubId === first.hubId;
} finally {
	second.close();
	bytes.fill(0);
}
process.stdout.write(JSON.stringify({ ok: true, tables, reopened, modules: second.extensions.modules.length }) + "\n");
