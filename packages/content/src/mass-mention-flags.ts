import { types } from "node:util";
import { ChatDraftContent } from "@draftyak/protocol/entities/draft/chat";
import { type Flag, Flags } from "@draftyak/protocol/flags";

export type SlackMassMentionTokenFlags =
	| { status: "classified"; flags: readonly Flag[] }
	| { status: "refused"; code: "INVALID_INPUT" | "STRUCTURE_LIMIT" };

const mentions = [
	["<!channel>", "@channel"],
	["<!everyone>", "@everyone"],
	["<!here>", "@here"],
] as const;

/**
 * Warn on supplied literal token DATA, including quoted/code text; this does not prove a
 * notification occurred or cover the renderer's other ways to mention a group.
 */
export function classifySlackMassMentionTokenFlags(
	draft: Pick<ChatDraftContent, "channel" | "body">,
): SlackMassMentionTokenFlags {
	try {
		if (!draft || typeof draft !== "object" || types.isProxy(draft) || Array.isArray(draft))
			return { status: "refused", code: "INVALID_INPUT" };
		const prototype = Object.getPrototypeOf(draft);
		if (prototype !== null && prototype !== Object.prototype)
			return { status: "refused", code: "INVALID_INPUT" };
		const channel = Object.getOwnPropertyDescriptor(draft, "channel");
		const body = Object.getOwnPropertyDescriptor(draft, "body");
		if (!channel || !("value" in channel) || channel.value !== "chat")
			return { status: "refused", code: "INVALID_INPUT" };
		if (!body || !("value" in body) || typeof body.value !== "string")
			return { status: "refused", code: "INVALID_INPUT" };
		const text: string = body.value;
		// Bound UTF-16 work before counting scalars and invoking canonical body validation.
		if (text.length > 80_000) return { status: "refused", code: "STRUCTURE_LIMIT" };
		let scalars = 0;
		for (const _scalar of text) {
			if (++scalars > 40_000) return { status: "refused", code: "STRUCTURE_LIMIT" };
		}
		if (!ChatDraftContent.shape.body.safeParse(text).success)
			return { status: "refused", code: "INVALID_INPUT" };

		const flags: Flag[] = [];
		for (const [token, detail] of mentions) {
			if (text.includes(token)) flags.push({ code: "MASS_MENTION", severity: "ack", detail });
		}
		return { status: "classified", flags: Flags.parse(flags) };
	} catch {
		return { status: "refused", code: "INVALID_INPUT" };
	}
}
