import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import path from "node:path";
import { pathToFileURL } from "node:url";

let checkpoint = 1;
try {
	assert.equal(process.permission.has("net"), false);
	assert.equal(process.permission.has("child"), false);
	const hub = process.argv[2];
	const { HubStore, MasterKey, openPluginRegistry, PluginRegistryError, PLUGIN_REGISTRY_MIGRATIONS } =
		await import(pathToFileURL(path.join(hub, "dist/index.mjs")).href);
	checkpoint = 2;
	assert.equal(typeof openPluginRegistry, "function");
	assert.equal(typeof PluginRegistryError, "function");
	assert.equal(PLUGIN_REGISTRY_MIGRATIONS, path.join(hub, "dist/plugins/registry/migrations/"));
	const bytes = randomBytes(32), masterKey = new MasterKey(bytes);
	bytes.fill(0);
	const options = { filename: path.join(process.argv[4], "registry.db"), nativeBinding: process.argv[3], masterKey,
		migrations: { audit: path.join(hub, "dist/store/migrations/audit"), core: path.join(hub, "dist/store/migrations/core"),
			pluginregistry: PLUGIN_REGISTRY_MIGRATIONS } };
	let store;
	try {
		store = new HubStore({ ...options, create: true });
		await store.migrate("audit");
		await store.migrate("core");
		await store.migrate("pluginregistry");
		checkpoint = 3;
		const inspect = () => store.read((sql) => {
			assert.equal(sql.get("SELECT count(*) AS n FROM _migrations_pluginregistry").n, 1);
			for (const name of ["plugin_versions", "plugin_generations"])
				assert.equal(sql.get("SELECT count(*) AS n FROM sqlite_schema WHERE type='table' AND name=?", [name]).n, 1);
		});
		inspect();
		store.close();
		store = new HubStore(options);
		await store.migrate("pluginregistry");
		inspect();
		checkpoint = 4;
	} finally { store?.close(); masterKey.destroy(); }
	process.stdout.write(JSON.stringify({ ok: true, network: false, child: false, schemas: 2 }));
} catch {
	process.stdout.write(JSON.stringify({ ok: false, checkpoint }));
	process.exitCode = 1;
}
