import type { Clock } from "../faults.ts";

export interface HelloConversation {
	readonly id: string;
	readonly name: string;
}

export interface HelloMessage {
	/** The provider id. */
	readonly id: string;
	readonly conversationId: string;
	/** A user id; messages sent through the API come from `me`. */
	readonly author: string;
	readonly text: string;
	/** UTC milliseconds from the fake's clock. */
	readonly createdAt: number;
}

export interface HelloSeed extends HelloConversation {
	readonly messages?: readonly { readonly author: string; readonly text: string }[];
}

export interface HelloPage {
	readonly messages: readonly HelloMessage[];
	/** Where the next page starts; holding it and calling later fetches only what arrived since. */
	readonly cursor: string;
	readonly more: boolean;
}

export type PageRefusal = "unknown_conversation" | "invalid_cursor" | "cursor_expired";

export interface HelloState {
	conversations(): HelloConversation[];
	has(conversationId: string): boolean;
	messages(conversationId: string): HelloMessage[];
	addMessage(conversationId: string, message: { author: string; text: string }): HelloMessage;
	page(conversationId: string, cursor: string | undefined, limit: number): HelloPage | PageRefusal;
	/** Creates a message once per idempotency key; a repeat with the same body gets the first. */
	send(
		conversationId: string,
		text: string,
		idempotency?: { key: string; bodySha256: string },
	): { message: HelloMessage; replayed: boolean } | "idempotency_key_reused";
}

export const SELF = "me";

export function createHelloState(options: {
	clock: Clock;
	seed: readonly HelloSeed[];
	cursorTtlMs: number;
}): HelloState {
	const { clock, cursorTtlMs } = options;
	const conversations = new Map<string, { name: string; messages: HelloMessage[] }>();
	const cursors = new Map<string, { conversationId: string; position: number; issuedAt: number }>();
	const sent = new Map<
		string,
		{ conversationId: string; bodySha256: string; message: HelloMessage }
	>();
	let lastId = 0;
	let lastCursor = 0;

	const thread = (conversationId: string) => {
		const conversation = conversations.get(conversationId);
		if (conversation === undefined) throw new RangeError(`no conversation ${conversationId}`);
		return conversation.messages;
	};
	const addMessage = (
		conversationId: string,
		{ author, text }: { author: string; text: string },
	) => {
		const messages = thread(conversationId);
		lastId += 1;
		const id = `msg_${String(lastId).padStart(6, "0")}`;
		const message = { id, conversationId, author, text, createdAt: clock.now() };
		messages.push(message);
		return message;
	};

	for (const { id, name, messages = [] } of options.seed) {
		conversations.set(id, { name, messages: [] });
		for (const message of messages) addMessage(id, message);
	}

	return {
		conversations: () => [...conversations].map(([id, { name }]) => ({ id, name })),
		has: (conversationId) => conversations.has(conversationId),
		messages: (conversationId) => [...thread(conversationId)],
		addMessage,
		page(conversationId, cursor, limit) {
			const messages = conversations.get(conversationId)?.messages;
			if (messages === undefined) return "unknown_conversation";
			let start = 0;
			if (cursor !== undefined) {
				const held = cursors.get(cursor);
				if (held?.conversationId !== conversationId) return "invalid_cursor";
				if (clock.now() >= held.issuedAt + cursorTtlMs) return "cursor_expired";
				start = held.position;
			}
			const page = messages.slice(start, start + limit);
			const position = start + page.length;
			lastCursor += 1;
			const next = `cur_${String(lastCursor).padStart(6, "0")}`;
			cursors.set(next, { conversationId, position, issuedAt: clock.now() });
			return { messages: page, cursor: next, more: position < messages.length };
		},
		send(conversationId, text, idempotency) {
			const first = idempotency && sent.get(idempotency.key);
			if (first !== undefined) {
				const same =
					first.conversationId === conversationId && first.bodySha256 === idempotency?.bodySha256;
				return same ? { message: first.message, replayed: true } : "idempotency_key_reused";
			}
			const message = addMessage(conversationId, { author: SELF, text });
			if (idempotency) {
				sent.set(idempotency.key, { conversationId, bodySha256: idempotency.bodySha256, message });
			}
			return { message, replayed: false };
		},
	};
}
