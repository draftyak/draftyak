import { expect, it } from "vitest";
import { assertHubMigrations } from "../src/hub-migrations.ts";

const validInventory = [
	"credentials/migrations/0001_credentials.sql",
	"credentials/migrations/0002_sealed_credentials.sql",
	"devices-migrations/0001_devices.sql",
	"drafts/migrations/0001_native_revisions.sql",
	"drafts/migrations/0002_immutable_revisions.sql",
	"events-migrations/0001_events.sql",
	"jobs-migrations/0001_jobs.sql",
	"outbox/migrations/0001_send_attempts.sql",
	"plugins/registry/migrations/0001_registry.sql",
	"store/migrations/audit/0001_chain.sql",
	"store/migrations/core/0001_identity.sql",
].map((path) => ({ path, bytes: 1 }));

it("admits the current migration catalogue with unrelated non-SQL bundle assets", () => {
	expect(() =>
		assertHubMigrations([
			...validInventory,
			{ path: "hub.mjs", bytes: 1 },
			{ path: "spa/index.html", bytes: 1 },
			{ path: "plugins/fixture.mjs", bytes: 1 },
		]),
	).not.toThrow();
});

it.each([
	"unexpected.sql",
	"future/migrations/9999_unexpected.sql",
	"future-migrations/9999_unexpected.sql",
	"store/migrations/core/9999_unexpected.sql",
])("refuses an undeclared SQL asset: %s", (path) => {
	expect(() => assertHubMigrations([...validInventory, { path, bytes: 1 }])).toThrow(
		"hub migration inventory",
	);
});

it("keeps refusing flattened migration assets without relying on their extension", () => {
	expect(() =>
		assertHubMigrations([...validInventory, { path: "migrations/catalogue.json", bytes: 1 }]),
	).toThrow("hub migration inventory");
});
