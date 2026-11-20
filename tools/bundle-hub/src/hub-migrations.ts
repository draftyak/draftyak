import type { FileRecord } from "./inventory.ts";

// Runtime-relative paths emitted by the reviewed Hub producer. The producer oracle
// fails on new or moved SQL so this contract must advance with that actual input.
export const HUB_MIGRATION_FILES: readonly string[] = Object.freeze([
	"accounts/migrations/0001_accounts.sql",
	"credentials/migrations/0001_credentials.sql",
	"credentials/migrations/0002_sealed_credentials.sql",
	"devices-migrations/0001_devices.sql",
	"drafts/migrations/0001_native_revisions.sql",
	"drafts/migrations/0002_immutable_revisions.sql",
	"events-migrations/0001_events.sql",
	"identity/admin-challenge-migrations/0001_admin_challenges.sql",
	"identity/admin-migrations/0001_operations.sql",
	"identity/backup-challenge-migrations/0001_backup_challenges.sql",
	"identity/backup-migrations/0001_backup_operations.sql",
	"identity/challenges-migrations/0001_challenges.sql",
	"jobs-migrations/0001_jobs.sql",
	"outbox/migrations/0001_send_attempts.sql",
	"outbox/propose-migrations/0001_proposals.sql",
	"outbox/verifier-migrations/0001_approvals.sql",
	"plugins/registry/migrations/0001_registry.sql",
	"plugins/registry/migrations/0002_candidates.sql",
	"recovery/backup-migrations/0001_backup_recovery.sql",
	"store/migrations/audit/0001_chain.sql",
	"store/migrations/core/0001_identity.sql",
	"sync/raw-migrations/0001_raw.sql",
]);

const expected = new Set(HUB_MIGRATION_FILES);

export function assertHubMigrations(files: readonly Pick<FileRecord, "path" | "bytes">[]): void {
	const present = new Map(files.map((file) => [file.path, file.bytes]));
	if (
		HUB_MIGRATION_FILES.some((file) => !present.get(file)) ||
		files.some(
			(file) =>
				file.path.startsWith("migrations/") ||
				(file.path.endsWith(".sql") && !expected.has(file.path)),
		)
	)
		throw new Error("hub migration inventory is incomplete or misplaced");
}
