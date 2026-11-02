import { createHmac } from "node:crypto";
import { canonicalize } from "@draftyak/protocol/jcs";
import Database from "better-sqlite3-multiple-ciphers";
import { nativeBinding } from "../store/helpers.ts";
import type { RevisionFixture } from "./revision-fixture.ts";

/** Test-owned key access preserves authenticated corruption coverage without a service signer. */
export function signFixtureDraftRow(
	fixture: Pick<RevisionFixture, "key">,
	domain: "header" | "revision" | "freeze",
	value: unknown,
): string {
	const key = fixture.key.derive("drafts");
	try {
		return createHmac("sha256", key)
			.update(`draftyak/draft-${domain}/v1\n`)
			.update(canonicalize(value))
			.digest("hex");
	} finally {
		key.fill(0);
	}
}

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
		const connection = database;
		const catalog = () =>
			JSON.stringify(
				connection
					.prepare(
						"SELECT type,name,tbl_name,sql FROM main.sqlite_schema ORDER BY type,name,tbl_name,sql",
					)
					.all(),
			);
		database.exec("BEGIN IMMEDIATE");
		const before = catalog(),
			trigger = database
				.prepare(
					"SELECT sql FROM main.sqlite_schema WHERE type='trigger' AND name='native_draft_revisions_no_update'",
				)
				.get() as { sql: string } | undefined,
			replacement = database
				.prepare(
					"SELECT sql FROM main.sqlite_schema WHERE type='trigger' AND name='native_draft_revisions_no_replace'",
				)
				.get() as { sql: string } | undefined;
		if (typeof trigger?.sql !== "string" || typeof replacement?.sql !== "string")
			throw new Error("Revision corruption fixture requires the original fences");
		const changes = () =>
			(connection.prepare("SELECT total_changes() AS n").get() as { n: number }).n;
		const previous = changes();
		database.exec("DROP TRIGGER native_draft_revisions_no_update");
		if (work(database) !== undefined || changes() !== previous + 1)
			throw new Error("Revision corruption fixture requires one synchronous row change");
		database.exec(trigger.sql);
		if (catalog() !== before) throw new Error("Revision corruption fixture changed the schema");
		database.exec("COMMIT");
	} finally {
		key.fill(0);
		try {
			if (database?.inTransaction) database.exec("ROLLBACK");
		} finally {
			database?.close();
		}
	}
}
