import { randomBytes } from "node:crypto";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { MasterKey } from "../../src/kernel/master-key.ts";
import { HubStore } from "../../src/store/store.ts";

const require = createRequire(import.meta.url);
const header = (
	process.report.getReport() as unknown as { header: { glibcVersionRuntime?: string } }
).header;
const platform =
	process.platform === "linux" && !header.glibcVersionRuntime ? "linuxmusl" : process.platform;
export const nativeBinding: string = path.join(
	path.dirname(require.resolve("better-sqlite3-multiple-ciphers/package.json")),
	"prebuilds",
	`${platform}-${process.arch}.node`,
);
export const migrations: string = path.resolve(import.meta.dirname, "../../src/store/migrations");

export async function fixture(masterBytes?: Uint8Array): Promise<{
	dir: string;
	filename: string;
	key: MasterKey;
	store: HubStore;
}> {
	const dir = mkdtempSync(path.join(os.tmpdir(), "draftyak-store-"));
	const filename = path.join(dir, "draftyak.db");
	const key = new MasterKey(masterBytes ?? randomBytes(32));
	const store = new HubStore({
		filename,
		nativeBinding,
		masterKey: key,
		create: true,
		migrations: {
			audit: path.join(migrations, "audit"),
			fixture: path.join(dir, "rows"),
			...Object.fromEntries(
				["demo", "unsafe", "forbidden", "rebuild", "linked"].map((name) => [
					name,
					path.join(dir, "sql"),
				]),
			),
			bom: path.join(dir, "bom"),
			shadows: path.join(dir, "shadows"),
		},
	});
	await store.migrate("audit");
	mkdirSync(path.join(dir, "sql"));
	const rows = path.join(dir, "rows");
	mkdirSync(rows);
	writeFileSync(
		path.join(rows, "0001_rows.sql"),
		"CREATE TABLE test_rows(id TEXT PRIMARY KEY, created_at INTEGER NOT NULL) STRICT;",
	);
	await store.migrate("fixture");
	return { dir, filename, key, store };
}
