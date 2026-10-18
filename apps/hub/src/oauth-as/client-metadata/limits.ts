import { type MetadataKind, refused } from "./policy.ts";

// oidc-provider's CIMD cap, retained by S4.
export const CIMD_MAX_BYTES: number = 5 * 1024;
export const CIMD_TIMEOUT_MS = 2500;
export const JWKS_TIMEOUT_MS = 5000;
export const METADATA_MAX_BYTES: number = 1024 * 1024;
export const METADATA_TIMEOUT_MS = 10000;

export function metadataMaxBytes(kind: MetadataKind, configured: number): number {
	if (
		(kind !== "cimd" && kind !== "jwks") ||
		!Number.isSafeInteger(configured) ||
		configured < 1 ||
		configured > METADATA_MAX_BYTES
	)
		throw refused();
	return Math.min(configured, kind === "cimd" ? CIMD_MAX_BYTES : METADATA_MAX_BYTES);
}

export function metadataTimeoutMs(kind: MetadataKind, configured: number): number {
	if (
		(kind !== "cimd" && kind !== "jwks") ||
		!Number.isSafeInteger(configured) ||
		configured < 1 ||
		configured > METADATA_TIMEOUT_MS
	)
		throw refused();
	return Math.min(configured, kind === "cimd" ? CIMD_TIMEOUT_MS : JWKS_TIMEOUT_MS);
}
