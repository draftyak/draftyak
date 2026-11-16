import { types } from "node:util";
import type { DraftContent } from "@draftyak/protocol/entities/draft";
import { ChatDraftContent } from "@draftyak/protocol/entities/draft/chat";
import { EmailDraftContent } from "@draftyak/protocol/entities/draft/email";
import { type Flag, Flags } from "@draftyak/protocol/flags";
import { linkMarker } from "./hygiene.ts";
import { ContentError } from "./limits.ts";

export type BodyLinkAndInvisibleFlags =
	| { status: "classified"; flags: readonly Flag[] }
	| { status: "refused"; code: "INVALID_INPUT" | "STRUCTURE_LIMIT" };

// Match incoming hygiene's invisible class without changing the stored draft body.
const INVISIBLE =
	// biome-ignore lint/suspicious/noControlCharactersInRegex: Detect the controls that require a warning.
	/[\p{Default_Ignorable_Code_Point}\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/gu;
// Consume outer dangerous URI tokens too, so their nested HTTP text is not a separate link.
const URI =
	/\b(?:https?:(?=[^\s<>"'])|(?:javascript|vbscript):(?=[^\s<>"'])|file:(?=\/)|data:(?=(?:[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+|,)))[^\s<>"']*/gi;

function object(value: unknown): object {
	if (!value || typeof value !== "object" || types.isProxy(value) || Array.isArray(value))
		throw new ContentError("INVALID_INPUT");
	const prototype = Object.getPrototypeOf(value);
	if (prototype !== null && prototype !== Object.prototype) throw new ContentError("INVALID_INPUT");
	return value;
}

function field(value: object, key: "channel" | "body"): unknown {
	const descriptor = Object.getOwnPropertyDescriptor(value, key);
	if (!descriptor || !("value" in descriptor)) throw new ContentError("INVALID_INPUT");
	return descriptor.value;
}

/** Classify only link and invisible-character DATA; other flags remain with the caller. */
export function classifyBodyLinkAndInvisibleFlags(
	draft: Pick<DraftContent, "channel" | "body">,
): BodyLinkAndInvisibleFlags {
	try {
		const input = object(draft);
		const channel = field(input, "channel");
		const body = field(input, "body");
		if (channel !== "email" && channel !== "chat")
			return { status: "refused", code: "INVALID_INPUT" };
		// Bound UTF-16 work before scalar counting and NFC validation in the shared schema.
		const maximum = channel === "email" ? 100_000 : 40_000;
		if (typeof body !== "string" || body.length > maximum * 2)
			return { status: "refused", code: "INVALID_INPUT" };
		const schema = channel === "email" ? EmailDraftContent.shape.body : ChatDraftContent.shape.body;
		if (!schema.safeParse(body).success) return { status: "refused", code: "INVALID_INPUT" };

		const scan = body.replace(INVISIBLE, "");
		const flags: Flag[] = [];
		if (scan.length !== body.length) flags.push({ code: "INVISIBLE_CHARS", severity: "ack" });
		const links: { index: number; host: string }[] = [];
		for (const match of scan.matchAll(URI)) {
			const value = match[0];
			if (!/^https?:/i.test(value)) continue;
			// Walk once instead of repeatedly searching a long near-matching suffix.
			let tailStart = value.length;
			while (tailStart > 0 && "),.;!?]}".includes(value.charAt(tailStart - 1))) tailStart--;
			let tail = value.slice(tailStart);
			// A bare IPv6 authority's first trailing bracket belongs to the hostname.
			const authority = value.slice(0, value.length - tail.length + 1);
			if (tail.startsWith("]") && /^https?:\/\/(?:[^/?#]*@)?\[[^\]]+\]$/i.test(authority))
				tail = tail.slice(1);
			linkMarker(value.slice(0, value.length - tail.length), links);
			const last = links[links.length - 1];
			// Canonical hostnames are ASCII, so this is also the shared scalar-detail limit.
			if (last && last.host.length > 1000) return { status: "refused", code: "STRUCTURE_LIMIT" };
		}
		for (const link of links)
			flags.push({ code: "EXTERNAL_LINK", severity: "ack", detail: link.host });
		return { status: "classified", flags: Flags.parse(flags) };
	} catch (error) {
		return {
			status: "refused",
			code:
				error instanceof ContentError && error.code === "STRUCTURE_LIMIT"
					? "STRUCTURE_LIMIT"
					: "INVALID_INPUT",
		};
	}
}
