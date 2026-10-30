import { Cursor } from "@draftyak/protocol/channel-v1";
import { type ChatMessageChange, ProviderId } from "@draftyak/protocol/normalized-change";
import { UtcMs } from "@draftyak/protocol/scalars";
import { type HostFetchInit, type PluginContext, PluginError } from "@draftyak/sdk";
import * as z from "zod";

const origin = "https://hello.draftyak.example";
interface HelloMessage {
	id: string;
	conversationId: string;
	author: string;
	text: string;
	createdAt: number;
}
interface HelloPage {
	messages: HelloMessage[];
	cursor: string;
	more: boolean;
}
interface HelloConversations {
	conversations: { id: string; name: string }[];
}
const message: z.ZodType<HelloMessage> = z.strictObject({
	id: ProviderId,
	conversationId: ProviderId,
	author: ProviderId,
	text: z.string().max(40_000),
	createdAt: UtcMs,
});
const page: z.ZodType<HelloPage> = z.strictObject({
	messages: z.array(message).max(50),
	cursor: Cursor,
	more: z.boolean(),
});
const conversations: z.ZodType<HelloConversations> = z.strictObject({
	conversations: z.array(z.strictObject({ id: ProviderId, name: z.string().max(256) })).max(10),
});
export const self: z.ZodType<{ id: string }> = z.strictObject({ id: ProviderId });
export const sent: z.ZodType<{ id: string; conversationId: string; createdAt: number }> =
	z.strictObject({ id: ProviderId, conversationId: ProviderId, createdAt: UtcMs });

export async function request<T>(
	context: PluginContext,
	url: string,
	schema: z.ZodType<T>,
	init?: HostFetchInit,
): Promise<T> {
	const response = await context.fetch(url.startsWith("/") ? origin + url : url, init);
	if (!response.ok) {
		const code =
			response.status === 410
				? "CURSOR_EXPIRED"
				: response.status === 404
					? "NOT_FOUND"
					: response.status === 401
						? "AUTH_EXPIRED"
						: response.status === 403
							? "PERMISSION_DENIED"
							: response.status === 429
								? "RATE_LIMITED"
								: response.status === 400
									? "INVALID_INPUT"
									: "TRANSIENT";
		throw new PluginError(code);
	}
	let value: unknown;
	try {
		value = await response.json();
	} catch {
		throw new PluginError("TRANSIENT");
	}
	const parsed = schema.safeParse(value);
	if (!parsed.success) throw new PluginError("TRANSIENT");
	return parsed.data;
}
export const listConversations = (
	context: PluginContext,
): Promise<z.output<typeof conversations>> => request(context, "/v1/conversations", conversations);
export const listMessages = (
	context: PluginContext,
	id: string,
	cursor?: string,
): Promise<z.output<typeof page>> =>
	request(
		context,
		`/v1/conversations/${encodeURIComponent(id)}/messages?limit=50${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`,
		page,
	);
export function normalized(value: z.output<typeof message>): ChatMessageChange {
	return {
		kind: "chat.message",
		channelId: value.conversationId,
		ts: value.id,
		sentAt: value.createdAt,
		author: { kind: "user", id: value.author },
		text: value.text,
	};
}

/** A bounded scan for body fetch and reconciliation; unfinished scans never claim completeness. */
export async function scan(
	context: PluginContext,
	id: string,
): Promise<{ messages: z.output<typeof message>[]; complete: boolean }> {
	const messages: z.output<typeof message>[] = [];
	let cursor: string | undefined;
	for (let count = 0; count < 20; count++) {
		const next = await listMessages(context, id, cursor);
		messages.push(...next.messages);
		if (!next.more) return { messages, complete: true };
		cursor = next.cursor;
	}
	return { messages, complete: false };
}
