import { accessSync, constants } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { EVENT_MIGRATIONS } from "./events/log.ts";
import { JOB_MIGRATIONS } from "./jobs/queue.ts";
import { HubStore, type StoreOptions } from "./store/store.ts";

export type NativeStorageOptions = Omit<StoreOptions, "migrations">;

/** Opens the current native component schemas; it does not activate an account or controller. */
export async function openNativeStorage(options: NativeStorageOptions): Promise<HubStore> {
	const migrations = {
		audit: fileURLToPath(new URL("./store/migrations/audit/", import.meta.url)),
		core: fileURLToPath(new URL("./store/migrations/core/", import.meta.url)),
		jobs: JOB_MIGRATIONS,
		events: EVENT_MIGRATIONS,
		revisions: fileURLToPath(new URL("./drafts/migrations/", import.meta.url)),
		credentials: fileURLToPath(new URL("./credentials/migrations/", import.meta.url)),
		tickets: fileURLToPath(new URL("./outbox/migrations/", import.meta.url)),
	};
	const store = new HubStore({
		filename: options.filename,
		nativeBinding: options.nativeBinding,
		masterKey: options.masterKey,
		create: options.create === true,
		migrations,
	});
	try {
		for (const [namespace, file] of [
			["audit", "0001_chain.sql"],
			["core", "0001_identity.sql"],
			["jobs", "0001_jobs.sql"],
			["events", "0001_events.sql"],
			["revisions", "0001_native_revisions.sql"],
			["credentials", "0001_credentials.sql"],
			["tickets", "0001_send_attempts.sql"],
		] as const) {
			// An empty migration directory must not silently omit a required current schema.
			accessSync(path.join(migrations[namespace], file), constants.R_OK);
			await store.migrate(namespace);
		}
		return store;
	} catch (error) {
		store.close();
		throw error;
	}
}
