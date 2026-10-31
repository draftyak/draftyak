import { accessSync, constants } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { EVENT_MIGRATIONS } from "../events/log.ts";
import { JOB_MIGRATIONS } from "../jobs/queue.ts";
import type { HubStore } from "../store/store.ts";

// This module is src/kernel/namespaces.ts in source and part of dist/index.mjs in the build.
// Jobs and events supply their own paths because their built migration folders are flattened.
const root = new URL(import.meta.url.endsWith(".ts") ? "../" : "./", import.meta.url);
const bundled = (folder: string): string => fileURLToPath(new URL(folder, root));

type HubNamespace = "audit" | "core" | "jobs" | "events" | "revisions" | "credentials" | "tickets";

/** The current fixed native schema inventory; callers cannot substitute migration folders. */
export const HUB_NAMESPACES: Readonly<Record<HubNamespace, string>> = Object.freeze({
	audit: bundled("store/migrations/audit"),
	core: bundled("store/migrations/core"),
	jobs: JOB_MIGRATIONS,
	events: EVENT_MIGRATIONS,
	revisions: bundled("drafts/migrations"),
	credentials: bundled("credentials/migrations"),
	tickets: bundled("outbox/migrations"),
});

const SCHEMAS = Object.freeze([
	["audit", "0001_chain.sql"],
	["core", "0001_identity.sql"],
	["jobs", "0001_jobs.sql"],
	["events", "0001_events.sql"],
	["revisions", "0001_native_revisions.sql"],
	["revisions", "0002_immutable_revisions.sql"],
	["credentials", "0001_credentials.sql"],
	["tickets", "0001_send_attempts.sql"],
] as const);

/** Migrate the registered native schemas in order; the caller retains store and key cleanup. */
export async function migrateHubSchemas(store: HubStore): Promise<void> {
	for (const [namespace, file] of SCHEMAS) {
		// An empty directory must not silently omit a required current schema.
		accessSync(path.join(HUB_NAMESPACES[namespace], file), constants.R_OK);
		await store.migrate(namespace);
	}
}
