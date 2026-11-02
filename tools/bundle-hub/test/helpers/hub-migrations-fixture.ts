import { HUB_MIGRATION_FILES } from "../../src/hub-migrations.ts";

// Structural unit payloads only. The producer oracle separately builds and pins real SQL.
export function hubMigrationFixture(): Record<string, string> {
	return Object.fromEntries(
		HUB_MIGRATION_FILES.map((file) => [file, "-- DYTEST structural SQL fixture\nSELECT 1;\n"]),
	);
}
