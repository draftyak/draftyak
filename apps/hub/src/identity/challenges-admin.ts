import { fileURLToPath } from "node:url";
import { fromBase64Url, Ulid } from "@draftyak/protocol/scalars";
import type { AdminStatement } from "@draftyak/protocol/statements/admin";
import type { NativeDevicePeer } from "../authz/native-peer.ts";
import type { ClockSample } from "./challenges-support.ts";
import { refuse } from "./challenges-support.ts";

export const ADMIN_CHALLENGE_MIGRATIONS: string = fileURLToPath(
	new URL(
		import.meta.url.endsWith(".ts")
			? "./admin-challenge-migrations/"
			: "./identity/admin-challenge-migrations/",
		import.meta.url,
	),
);

/** Internal type only. Only the challenge coordinator can issue its runtime authority. */
export interface AdminAcceptContext {
	readonly __nativeAdminAccept: never;
}
export interface AdminAcceptedFacts {
	readonly statement: AdminStatement;
	readonly peer: NativeDevicePeer;
	readonly operationVersion: number;
	readonly owner: string;
	readonly epoch: number;
	readonly deviceId: string;
	readonly approvalKey: string;
	readonly now: ClockSample;
	readonly challengeId: string;
}

/** Domain separation only; a scope string is never proof of a PIN or approval. */
export function adminOperationPinScope(operation: string, nonce: string): string {
	const bytes = typeof nonce === "string" && nonce.length === 22 ? fromBase64Url(nonce) : undefined;
	if (!Ulid.safeParse(operation).success || bytes?.length !== 16) refuse("CHALLENGE_INVALID");
	return `admin.account-mode-full:${operation.toLowerCase()}:${Buffer.from(bytes).toString("hex")}`;
}

export const ADMIN_CHALLENGE_SQL: string = `SELECT CASE WHEN typeof(id)='text' AND length(CAST(id AS BLOB))=26 THEN id END AS id,
 CASE WHEN typeof(nonce)='text' AND length(CAST(nonce AS BLOB))=22 THEN nonce END AS nonce,
 CASE WHEN kind='admin.v1' THEN kind END AS kind,
 CASE WHEN typeof(target_id)='text' AND length(CAST(target_id AS BLOB))=26 THEN target_id END AS target,
 CASE WHEN typeof(device_id)='text' AND length(CAST(device_id AS BLOB))=26 THEN device_id END AS device,
 CASE WHEN typeof(user_id)='text' AND length(CAST(user_id AS BLOB))=26 THEN user_id END AS user,
 CASE WHEN typeof(data_class)='text' AND length(CAST(data_class AS BLOB)) BETWEEN 1 AND 64 THEN data_class END AS dataClass,
 CASE WHEN typeof(epoch)='integer' THEN epoch END AS epoch,
 CASE WHEN typeof(statement)='blob' AND length(statement) BETWEEN 1 AND 16384 THEN statement END AS bytes,
 CASE WHEN typeof(issued_at)='integer' THEN issued_at END AS wall,
 CASE WHEN typeof(expires_at)='integer' THEN expires_at END AS expires,
 target_version AS targetVersion,consumed_at,burned_at,signature FROM main.native_admin_challenges WHERE id=?`;
