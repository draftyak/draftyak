import type { HostErrorCode } from "@draftyak/protocol/host-channel";

/**
 * Each refusal and the host error a plugin receives for it. ABORTED means the caller's signal
 * fired: a caller whose own deadline fired replies TIMEOUT instead.
 */
export const JSON_MEMBER_REFUSALS = {
	REQUEST_INVALID: "BAD_REQUEST",
	REQUEST_DENIED: "DENIED",
	COMPRESSED_TOO_LARGE: "TOO_LARGE",
	ENTITY_TOO_LARGE: "TOO_LARGE",
	DECODED_TOO_LARGE: "TOO_LARGE",
	DEPTH_TOO_LARGE: "TOO_LARGE",
	NODES_TOO_LARGE: "TOO_LARGE",
	ERROR_BODY_TOO_LARGE: "TOO_LARGE",
	UTF8_INVALID: "BAD_REQUEST",
	JSON_INVALID: "BAD_REQUEST",
	DUPLICATE_KEY: "BAD_REQUEST",
	MEMBER_MISSING: "BAD_REQUEST",
	MEMBER_NOT_STRING: "BAD_REQUEST",
	ENCODING_INVALID: "BAD_REQUEST",
	ENTITY_FAILED: "DENIED",
	STORAGE_FAILED: "DENIED",
	ABORTED: "DENIED",
} as const;
export type JsonMemberRefusalCode = keyof typeof JSON_MEMBER_REFUSALS;

/** Fixed and content-free: never carries entity bytes, member text, keys or offsets. */
export class JsonMemberRefusal extends Error {
	readonly code: JsonMemberRefusalCode;
	readonly hostError: HostErrorCode;
	constructor(code: JsonMemberRefusalCode) {
		super("Decoded JSON member refused");
		this.name = "JsonMemberRefusal";
		this.code = code;
		this.hostError = JSON_MEMBER_REFUSALS[code];
	}
}
