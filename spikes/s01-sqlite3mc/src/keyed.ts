import { randomBytes } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { canaryTail, leaks, needles, newCanary, scanDatabase } from "./canary.ts";
import { deriveHexKey, openEncrypted, truncateWal } from "./db.ts";
import { spikeDir } from "./prebuilds.ts";

export type KeyedResult = { readonly ok: true } | { readonly ok: false; readonly failure: string };

class CheckFailed extends Error {}

const codeOf = (error: unknown): string => {
	const { code, name } = error as { code?: unknown; name?: unknown };
	return String(typeof code === "string" ? code : name);
};

function check(passed: boolean, failure: string): void {
	if (!passed) throw new CheckFailed(failure);
}

// The probe's keyed round trip, so every target and Node in the load matrix runs §3's open (chacha20,
// hexkey, the settings read back), the core migration run whole, an FTS5 secure delete, a scan of
// the files and a wrong key. A failure names its check, or the error code, never content.
export function keyedCheck(nativeBinding: string): KeyedResult {
	const dir = mkdtempSync(path.join(os.tmpdir(), "s01-keyed-"));
	const file = path.join(dir, "draftyak.db");
	const key = deriveHexKey(randomBytes(32));
	const [kept, deleted] = [newCanary(), newCanary()];
	try {
		const db = openEncrypted(file, key, nativeBinding, { create: true });
		try {
			const core = path.join(spikeDir, "migrations", "core", "0001_init.sql");
			db.transaction(() => db.exec(readFileSync(core, "utf8")))();
			db.exec("INSERT INTO conversations (id, account_id) VALUES ('c', 'a')");
			const insert = db.prepare(
				"INSERT INTO messages (id, conversation_id, sender, body, sent_at) VALUES (?, 'c', 's', ?, 0)",
			);
			insert.run("kept", `kept ${kept}`);
			insert.run("deleted", `deleted ${deleted}`);
			db.exec("DELETE FROM messages WHERE id = 'deleted'");
			truncateWal(db);
			db.exec("INSERT INTO fts_messages (fts_messages, rank) VALUES ('integrity-check', 1)");
			const search = db.prepare("SELECT rowid FROM fts_messages WHERE fts_messages MATCH ?");
			check(search.all(kept).length === 1, "search");
			const pages = db.serialize();
			check(pages.includes(canaryTail(kept)), "kept text missing from the pages");
			check(!pages.includes(canaryTail(deleted)), "deleted text in the pages");
		} finally {
			db.close();
		}
		const look = needles({ kept: canaryTail(kept), deleted: canaryTail(deleted) });
		check(leaks(scanDatabase(file, look)).length === 0, "plaintext in the files");
		let wrongKey: string | null = null;
		try {
			openEncrypted(file, deriveHexKey(randomBytes(32)), nativeBinding).close();
		} catch (error) {
			wrongKey = codeOf(error);
		}
		check(wrongKey === "SQLITE_NOTADB", `wrong key: ${wrongKey ?? "opened"}`);
		return { ok: true };
	} catch (error) {
		const failure = error instanceof CheckFailed ? error.message : codeOf(error);
		process.stderr.write(`keyed: ${failure}: ${String((error as Error).message)}\n`);
		return { ok: false, failure };
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
}
