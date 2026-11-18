import { createHash, randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

async function verify() {
	const [nativeBinding, directory] = process.argv.slice(2);
	if (!nativeBinding || !directory) throw new Error("Compiled raw content refused");
	const hub = process.cwd();
	const dist = path.join(hub, "dist");
	const compiled = await import(pathToFileURL(path.join(dist, "index.mjs")).href);
	if (
		typeof compiled.MasterKey !== "function" ||
		typeof compiled.HubStore !== "function" ||
		typeof compiled.WorkDatabase !== "function" ||
		typeof compiled.NativeRawStore !== "function" ||
		typeof compiled.JOB_MIGRATIONS !== "string" ||
		typeof compiled.RAW_CONTENT_MIGRATIONS !== "string" ||
		compiled.RAW_CONTENT_CHUNK_BYTES !== 65_536 ||
		compiled.RAW_CONTENT_MAX_BYTES !== 33_554_432 ||
		path.resolve(compiled.RAW_CONTENT_MIGRATIONS) !== path.join(dist, "sync", "raw-migrations")
	)
		throw new Error("Compiled raw content refused");
	const source = readFileSync(path.join(hub, "src/sync/raw-migrations/0001_raw.sql"));
	const delivered = readFileSync(path.join(dist, "sync/raw-migrations/0001_raw.sql"));
	if (!source.equals(delivered)) throw new Error("Compiled raw content refused");
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
		const filename = path.join(directory, "raw-content.db");
		store = new compiled.HubStore({
			filename,
			nativeBinding,
			masterKey: key,
			create: true,
			migrations: {
				audit: path.join(dist, "store", "migrations", "audit"),
				core: path.join(dist, "store", "migrations", "core"),
				jobs: compiled.JOB_MIGRATIONS,
				rawcontent: compiled.RAW_CONTENT_MIGRATIONS,
			},
		});
		for (const namespace of ["audit", "core", "jobs", "rawcontent"]) await store.migrate(namespace);
		const payload = Buffer.from([0, 255, 13, 10, 70, 114, 111, 109, 32]);
		const digest = createHash("sha256").update(payload).digest("hex");
		const id = "01ARZ3NDEKTSV4RRFFQ69G5FAV";
		const work = new compiled.WorkDatabase(store);
		work.write((scope) => {
			const sql = work.sql(scope);
			if (
				sql.run(
					`INSERT INTO main.rawcontent_objects
					 (id,user_id,account_id,generation,plugin_instance_id,mode,owner_epoch,state,
					  created_at,expires_at,max_bytes,byte_count,chunk_count,sha256)
					 VALUES(?,?,?,1,?,'full',1,'committed',1,60001,33554432,?,1,?)`,
					[
						id,
						"01ARZ3NDEKTSV4RRFFQ69G5FAW",
						"01ARZ3NDEKTSV4RRFFQ69G5FAX",
						"01ARZ3NDEKTSV4RRFFQ69G5FAY",
						payload.length,
						digest,
					],
				).changes !== 1 ||
				sql.run("INSERT INTO main.rawcontent_chunks(object_id,seq,bytes,sha256) VALUES(?,0,?,?)", [
					id,
					payload,
					digest,
				]).changes !== 1
			)
				throw new Error("Compiled raw content refused");
		});
		store.close();
		store = undefined;
		// The delivered catalog alone must admit this already-applied namespace.
		store = new compiled.HubStore({ filename, nativeBinding, masterKey: key, create: false });
		const counts = store.read((sql) => ({
			objects: sql.get("SELECT count(*) AS count FROM main.rawcontent_objects")?.count,
			chunks: sql.get("SELECT count(*) AS count FROM main.rawcontent_chunks")?.count,
		}));
		const row = store.read((sql) =>
			sql.get(
				`SELECT c.bytes,c.sha256,o.byte_count,o.chunk_count,o.state,o.sha256 AS object_digest
				 FROM main.rawcontent_chunks AS c JOIN main.rawcontent_objects AS o ON o.id=c.object_id
				 WHERE c.object_id=? AND c.seq=0`,
				[id],
			),
		);
		if (
			counts.objects !== 1 ||
			counts.chunks !== 1 ||
			!row ||
			!(row.bytes instanceof Uint8Array) ||
			!Buffer.from(row.bytes).equals(payload) ||
			row.sha256 !== digest ||
			row.object_digest !== digest ||
			row.byte_count !== payload.length ||
			row.chunk_count !== 1 ||
			row.state !== "committed"
		)
			throw new Error("Compiled raw content refused");
		return {
			version: 1,
			ok: true,
			exported: true,
			bareReopen: true,
			assetBytes: delivered.length,
			assetSha256,
			objects: counts.objects,
			chunks: counts.chunks,
			rawBytes: payload.length,
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
