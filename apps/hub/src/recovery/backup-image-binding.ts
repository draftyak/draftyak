import type { SqlReader } from "../store/store.ts";
import { BackupArtifactError } from "./backup-artifact.ts";
import { captureRecoveryBinding } from "./backup-bindings.ts";

const SNAPSHOT_BINDING =
	"SELECT CASE WHEN typeof(singleton)='integer' AND singleton=1 " +
	"AND typeof(binding)='blob' AND length(binding)=69 THEN binding ELSE NULL END AS binding " +
	"FROM main.native_backup_recovery LIMIT 2";

/**
 * Captures bounded binding DATA from this SQL snapshot. Neither the row nor its grammar
 * authenticates a recovery capsule or grants permission to create or read an image.
 */
export function captureBackupImageBinding(sql: SqlReader): Buffer | null {
	try {
		const rows = sql.all<{ binding: unknown }>(SNAPSHOT_BINDING);
		if (rows.length === 0) return null;
		if (rows.length !== 1) throw new BackupArtifactError();
		return captureRecoveryBinding(rows[0]?.binding);
	} catch {
		throw new BackupArtifactError();
	}
}
