import { createHash, randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

async function verify() {
	const [nativeBinding, directory] = process.argv.slice(2);
	if (!nativeBinding || !directory) throw new Error("Compiled content refused");
	const hub = process.cwd();
	const dist = path.join(hub, "dist");
	const compiled = await import(pathToFileURL(path.join(dist, "index.mjs")).href);
	if (
		typeof compiled.MasterKey !== "function" ||
		typeof compiled.HubStore !== "function" ||
		typeof compiled.WorkDatabase !== "function" ||
		typeof compiled.NativeMetadataStore !== "function" ||
		typeof compiled.JOB_MIGRATIONS !== "string" ||
		typeof compiled.CONTENT_MIGRATIONS !== "string" ||
		path.resolve(compiled.CONTENT_MIGRATIONS) !== path.join(dist, "sync", "migrations")
	)
		throw new Error("Compiled content refused");
	const source = readFileSync(path.join(hub, "src/sync/migrations/0001_content.sql"));
	const delivered = readFileSync(path.join(dist, "sync/migrations/0001_content.sql"));
	if (!source.equals(delivered)) throw new Error("Compiled content refused");
	const assetSha256 = createHash("sha256").update(delivered).digest("hex");
	const bytes = randomBytes(32);
	let key;
	try {
		key = new compiled.MasterKey(bytes);
	} finally {
		bytes.fill(0);
	}
	let store;
	try {
		const filename = path.join(directory, "content.db");
		store = new compiled.HubStore({
			filename,
			nativeBinding,
			masterKey: key,
			create: true,
			migrations: {
				audit: path.join(dist, "store", "migrations", "audit"),
				core: path.join(dist, "store", "migrations", "core"),
				jobs: compiled.JOB_MIGRATIONS,
				content: compiled.CONTENT_MIGRATIONS,
			},
		});
		for (const namespace of ["audit", "core", "jobs", "content"]) await store.migrate(namespace);
		const work = new compiled.WorkDatabase(store);
		const inserted = work.write(
			(scope) =>
				work.sql(scope).run(
					`INSERT INTO main.content_checkpoints
				 (account_id,generation,user_id,plugin_instance_id,mode,cursor,revision)
				 VALUES(?,1,?,?,'full','compiled-cursor',1)`,
					[
						"01ARZ3NDEKTSV4RRFFQ69G5FAV",
						"01ARZ3NDEKTSV4RRFFQ69G5FAW",
						"01ARZ3NDEKTSV4RRFFQ69G5FAX",
					],
				).changes,
		);
		if (inserted !== 1) throw new Error("Compiled content refused");
		store.close();
		store = undefined;
		// Applied namespaces must now be recognized by the delivered catalog alone.
		store = new compiled.HubStore({ filename, nativeBinding, masterKey: key, create: false });
		const row = store.read((sql) =>
			sql.get(
				`SELECT count(*) AS count FROM main.content_checkpoints
				 WHERE account_id=? AND generation=1 AND cursor='compiled-cursor' AND revision=1`,
				["01ARZ3NDEKTSV4RRFFQ69G5FAV"],
			),
		);
		if (row?.count !== 1) throw new Error("Compiled content refused");
		return {
			version: 1,
			ok: true,
			exported: true,
			bareReopen: true,
			assetBytes: delivered.length,
			assetSha256,
			inserted,
			reopened: row.count,
		};
	} finally {
		try {
			store?.close();
		} finally {
			key.destroy();
		}
	}
}

try {
	process.stdout.write(`${JSON.stringify(await verify())}\n`);
} catch {
	process.stdout.write(`${JSON.stringify({ version: 1, ok: false })}\n`);
	process.exitCode = 1;
}
