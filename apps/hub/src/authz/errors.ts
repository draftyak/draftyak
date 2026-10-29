import { types } from "node:util";
import type { DEVICE_API_ERRORS } from "@draftyak/protocol/device-api";
import { PinError } from "../identity/pin.ts";

const codes = [
	"UNAVAILABLE",
	"DEVICE_UNKNOWN",
	"DEVICE_REVOKED",
	"DEVICE_PENDING",
	"ROLE_REFUSED",
	"CAPABILITY_MISSING",
	"PRESET_REFUSED",
	"PRINCIPAL_REFUSED",
	"PRINCIPAL_UNAVAILABLE",
	"KIND_UNKNOWN",
	"KIND_UNAVAILABLE",
	"ROUTE_UNKNOWN",
	"ROUTE_UNAVAILABLE",
	"BOOTSTRAP_DONE",
	"BOOTSTRAP_REFUSED",
	"NOT_BOOTSTRAPPED",
	"CANDIDATE_INVALID",
	"CANDIDATE_CONFLICT",
	"CANDIDATE_NOT_PENDING",
	"SIGNATURE_INVALID",
	"STATEMENT_MISMATCH",
	"STATEMENT_STALE",
	"LAST_APPROVER",
	"APPROVER_EXISTS",
	"PEER_REFUSED",
] as const;
export type AuthzErrorCode = (typeof codes)[number];
export const AUTHZ_ERROR_CODES: readonly AuthzErrorCode[] = Object.freeze([...codes]);

export class AuthzError extends Error {
	readonly code: AuthzErrorCode;
	constructor(code: AuthzErrorCode) {
		super(code);
		this.code = code;
	}
}

const AUTHZ_STATUS: Readonly<Record<AuthzErrorCode, keyof typeof DEVICE_API_ERRORS>> =
	Object.freeze({
		UNAVAILABLE: "UNAVAILABLE",
		DEVICE_UNKNOWN: "FORBIDDEN",
		DEVICE_REVOKED: "FORBIDDEN",
		DEVICE_PENDING: "FORBIDDEN",
		ROLE_REFUSED: "FORBIDDEN",
		CAPABILITY_MISSING: "FORBIDDEN",
		PRESET_REFUSED: "FORBIDDEN",
		PRINCIPAL_REFUSED: "FORBIDDEN",
		PRINCIPAL_UNAVAILABLE: "FORBIDDEN",
		KIND_UNKNOWN: "INVALID_REQUEST",
		KIND_UNAVAILABLE: "INVALID_REQUEST",
		ROUTE_UNKNOWN: "NOT_FOUND",
		ROUTE_UNAVAILABLE: "NOT_FOUND",
		BOOTSTRAP_DONE: "STALE",
		BOOTSTRAP_REFUSED: "FORBIDDEN",
		NOT_BOOTSTRAPPED: "FORBIDDEN",
		CANDIDATE_INVALID: "INVALID_REQUEST",
		CANDIDATE_CONFLICT: "INVALID_REQUEST",
		CANDIDATE_NOT_PENDING: "STALE",
		SIGNATURE_INVALID: "SIGNATURE_INVALID",
		STATEMENT_MISMATCH: "CHALLENGE_INVALID",
		STATEMENT_STALE: "STALE",
		LAST_APPROVER: "FORBIDDEN",
		APPROVER_EXISTS: "FORBIDDEN",
		PEER_REFUSED: "FORBIDDEN",
	});
const PIN_STATUS: Readonly<Record<string, keyof typeof DEVICE_API_ERRORS>> = Object.freeze({
	PIN_INVALID: "PIN_INVALID",
	// Includes a right PIN the hub could not record, which PIN_INVALID would call wrong.
	PIN_REQUIRED: "UNAVAILABLE",
	PIN_CHANGED: "PIN_INVALID",
	PIN_LOCKED: "PIN_LOCKED",
	PIN_BUSY: "UNAVAILABLE",
});

/** The device API error for a refusal; anything else is UNAVAILABLE and no input is echoed. */
export function deviceApiError(error: unknown): keyof typeof DEVICE_API_ERRORS {
	try {
		if (types.isProxy(error) || !(error instanceof AuthzError || error instanceof PinError))
			return "UNAVAILABLE";
		const code = Object.getOwnPropertyDescriptor(error, "code")?.value;
		const table: Readonly<Record<string, keyof typeof DEVICE_API_ERRORS>> =
			error instanceof AuthzError ? AUTHZ_STATUS : PIN_STATUS;
		return typeof code === "string" && Object.hasOwn(table, code)
			? (table[code] ?? "UNAVAILABLE")
			: "UNAVAILABLE";
	} catch {
		return "UNAVAILABLE";
	}
}
