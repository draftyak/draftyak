import Database from "better-sqlite3-multiple-ciphers";
import { nativeBinding } from "../store/helpers.ts";
import type { RevisionFixture } from "./revision-fixture.ts";

/** Deliberately bypass the SQL fence to exercise independent authenticated-read defenses. */
export function corruptRevisionStorage(
	fixture: Pick<RevisionFixture, "filename" | "store" | "key">,
	work: (database: InstanceType<typeof Database>) => void,
): void {
	fixture.store.checkpoint();
	const key = fixture.key.derive("db");
	let database: InstanceType<typeof Database> | undefined;
	try {
		database = new Database(fixture.filename, { nativeBinding });
		database.pragma("cipher='chacha20'");
		database.key(key);
		key.fill(0);
		database.exec(
			"DROP TRIGGER IF EXISTS native_draft_revisions_no_update; DROP TRIGGER IF EXISTS native_draft_revisions_no_replace",
		);
		work(database);
	} finally {
		key.fill(0);
		database?.close();
	}
}
