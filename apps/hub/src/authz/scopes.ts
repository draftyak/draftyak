import { fromBase64Url, Ulid } from "@draftyak/protocol/scalars";
import { AuthzError } from "./errors.ts";

// PIN scopes allow only [a-z0-9.:-]: ULIDs are lower-cased and the base64url nonce hex-encoded.
const ulid = (value: unknown): string => {
	if (typeof value !== "string" || !Ulid.safeParse(value).success)
		throw new AuthzError("CANDIDATE_INVALID");
	return value.toLowerCase();
};

export function pairConfirmPinScope(nonce: string): string {
	const bytes = typeof nonce === "string" && nonce.length === 22 ? fromBase64Url(nonce) : undefined;
	if (bytes?.length !== 16) throw new AuthzError("CANDIDATE_INVALID");
	return `device.pair-confirm:${Buffer.from(bytes).toString("hex")}`;
}

export function cliConfirmPinScope(candidate: string): string {
	return `device.cli-confirm:${ulid(candidate)}`;
}

export function revokePinScope(target: string): string {
	return `device.revoke:${ulid(target)}`;
}
