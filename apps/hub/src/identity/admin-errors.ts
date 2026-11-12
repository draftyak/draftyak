export type NativeAdminErrorCode = "INVALID_REQUEST" | "NOT_FOUND" | "STALE" | "UNAVAILABLE";

/** Fixed refusals only; account identity and database diagnostics stay native. */
export class NativeAdminError extends Error {
	readonly code: NativeAdminErrorCode;
	constructor(code: NativeAdminErrorCode = "UNAVAILABLE") {
		super(code);
		this.name = "NativeAdminError";
		this.code = code;
	}
}

export function refuseAdminOperation(code: NativeAdminErrorCode = "UNAVAILABLE"): never {
	throw new NativeAdminError(code);
}
