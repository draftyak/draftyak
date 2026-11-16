import { types } from "node:util";
import { DmarcResult } from "@draftyak/protocol/entities/common";
import { type Flag, Flags } from "@draftyak/protocol/flags";
import type { MailAuth } from "./auth-results.ts";

export type MailAuthenticationFlags =
	| { status: "classified"; flags: readonly Flag[] }
	| { status: "refused"; code: "INVALID_INPUT" };

/** Classify supplied authentication DATA only; this does not verify a message or its source. */
export function classifyMailAuthenticationFlags(
	auth: Pick<MailAuth, "dmarc">,
): MailAuthenticationFlags {
	try {
		if (!auth || typeof auth !== "object" || types.isProxy(auth) || Array.isArray(auth))
			return { status: "refused", code: "INVALID_INPUT" };
		const prototype = Object.getPrototypeOf(auth);
		if (prototype !== null && prototype !== Object.prototype)
			return { status: "refused", code: "INVALID_INPUT" };
		const descriptor = Object.getOwnPropertyDescriptor(auth, "dmarc");
		if (!descriptor || !("value" in descriptor))
			return { status: "refused", code: "INVALID_INPUT" };
		const value: unknown = descriptor.value;
		if (typeof value !== "string" || (value !== "fail" && value !== "pass" && value !== "none"))
			return { status: "refused", code: "INVALID_INPUT" };
		const dmarc = DmarcResult.parse(value);
		const flags: Flag[] = dmarc === "fail" ? [{ code: "DMARC_FAIL", severity: "ack" }] : [];
		return { status: "classified", flags: Flags.parse(flags) };
	} catch {
		return { status: "refused", code: "INVALID_INPUT" };
	}
}
