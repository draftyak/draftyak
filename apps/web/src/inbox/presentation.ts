import { Conversation } from "@draftyak/protocol/entities/conversation";

export interface ConversationTitle {
	readonly text: string;
	readonly truncated: boolean;
}

export interface DisplayTime {
	readonly text: string;
	readonly dateTime: string | null;
}

/** Schema validation supplies display DATA, never caller authority. */
export function readConversation(value: unknown): Conversation | undefined {
	try {
		const parsed = Conversation.safeParse(value);
		return parsed.success ? parsed.data : undefined;
	} catch {
		return undefined;
	}
}

export function readConversations(
	values: readonly Conversation[],
): readonly Conversation[] | undefined {
	try {
		if (!Array.isArray(values)) return undefined;
		const result: Conversation[] = [];
		const seen = new Set<string>();
		for (const value of values) {
			const conversation = readConversation(value);
			if (!conversation || seen.has(conversation.id)) return undefined;
			seen.add(conversation.id);
			result.push(conversation);
		}
		return Object.freeze(result);
	} catch {
		return undefined;
	}
}

export function conversationTitle(conversation: Conversation): ConversationTitle {
	const value = conversation.channel === "email" ? conversation.subject : conversation.name;
	return Object.freeze({
		text: value?.text.trim()
			? value.text
			: conversation.channel === "email"
				? "(No subject)"
				: "Unnamed chat",
		truncated: value?.truncated === true,
	});
}

export function displayTime(value: number | null): DisplayTime {
	if (value === null) return Object.freeze({ text: "Time unavailable", dateTime: null });
	const date = new Date(value);
	if (Number.isNaN(date.getTime()))
		return Object.freeze({ text: "Time unavailable", dateTime: null });
	const dateTime = date.toISOString();
	return Object.freeze({ text: dateTime, dateTime });
}
