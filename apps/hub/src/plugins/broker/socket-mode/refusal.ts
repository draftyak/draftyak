import type { HostErrorCode } from "@draftyak/protocol/host-channel";

/** Each refusal and the host error a plugin receives for it. */
export const SOCKET_MODE_REFUSALS = {
	PARAMS_INVALID: "BAD_REQUEST",
	RETIRED: "DENIED",
	CLOCK_INVALID: "DENIED",
	URL_RESPONSE: "DENIED",
	URL_TARGET: "DENIED",
	URL_DUPLICATE: "DENIED",
	URL_LIMIT: "DENIED",
	URL_UNBOUND: "DENIED",
	SOCKET_LIMIT: "DENIED",
	SOCKET_UNKNOWN: "DENIED",
	UPGRADE_REFUSED: "DENIED",
	ENVELOPE_UNKNOWN: "DENIED",
	ENVELOPE_REPEATED: "DENIED",
} as const;
export type SocketModeRefusalCode = keyof typeof SOCKET_MODE_REFUSALS;

/** Fixed and content-free: never carries a URL, ticket, envelope or message. */
export class SocketModeRefusal extends Error {
	readonly code: SocketModeRefusalCode;
	readonly hostError: HostErrorCode;
	constructor(code: SocketModeRefusalCode) {
		super("Socket Mode request refused");
		this.name = "SocketModeRefusal";
		this.code = code;
		this.hostError = SOCKET_MODE_REFUSALS[code];
	}
}

export function refuseSocketMode(code: SocketModeRefusalCode): never {
	throw new SocketModeRefusal(code);
}
