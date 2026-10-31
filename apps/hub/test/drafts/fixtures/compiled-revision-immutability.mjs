import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import path from "node:path";
import { HubStore, MasterKey } from "./index.mjs";

assert.equal(process.permission?.has("net"), false);
const key = new MasterKey(randomBytes(32));
const options = {
	filename: path.join(import.meta.dirname, "hub.db"), masterKey: key, nativeBinding: process.argv[2],
	migrations: {
		audit: path.join(import.meta.dirname, "store/migrations/audit"),
		revisions: path.join(import.meta.dirname, "drafts/migrations"),
	},
};
const id = "01ARZ3NDEKTSV4RRFFQ69G5FA0", mac = "0".repeat(64);
let store;
try {
	store = new HubStore({ ...options, create: true });
	await store.migrate("audit");
	assert.deepEqual(await store.migrate("revisions"), ["0001_native_revisions", "0002_immutable_revisions"]);
	store.write(tx => {
		tx.run("INSERT INTO native_drafts VALUES (?,'{}',1,?)", [id, mac]);
		for (const rev of [1, 2, 3]) tx.run("INSERT INTO native_draft_revisions VALUES (?,?,?,'',?)", [id, rev, `DYTEST ${rev}`, mac]);
	});
	const rows = () => store.read(tx => tx.all("SELECT * FROM native_draft_revisions ORDER BY draft_id,rev"));
	const before = rows();
	for (const sql of [
		"UPDATE native_draft_revisions SET payload='changed' WHERE draft_id=? AND rev=1",
		"INSERT OR REPLACE INTO native_draft_revisions VALUES (?,1,'changed','','0000000000000000000000000000000000000000000000000000000000000000')",
		"INSERT INTO native_draft_revisions VALUES (?,1,'changed','','0000000000000000000000000000000000000000000000000000000000000000') ON CONFLICT(draft_id,rev) DO UPDATE SET payload=excluded.payload",
	]) assert.throws(() => store.write(tx => tx.run(sql, [id])), /Draft revisions are immutable/);
	assert.throws(() => store.read(tx => tx.get("SELECT rowid FROM native_draft_revisions")), /no such column/);
	assert.deepEqual(rows(), before);
	store.close();
	store = new HubStore(options);
	assert.deepEqual(await store.migrate("revisions"), []);
	assert.deepEqual(rows(), before);
	store.write(tx => tx.run("DELETE FROM native_draft_revisions WHERE draft_id=?", [id]));
	assert.deepEqual(rows(), []);
	process.stdout.write(JSON.stringify({ immutable: true, withoutRowid: true, revisions: before.length, network: false }) + "\n");
} finally {
	store?.close(); key.destroy();
}
