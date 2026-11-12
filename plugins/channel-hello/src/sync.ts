import type { SyncPage, SyncRequest } from "@draftyak/protocol/channel-v1";
import { Cursor } from "@draftyak/protocol/channel-v1";
import { type PluginChange, ProviderId } from "@draftyak/protocol/normalized-change";
import { type PluginContext, PluginError } from "@draftyak/sdk";
import * as z from "zod";
import { listConversations, listMessages, normalized } from "./provider.ts";

const position = z.strictObject({
	index: z.int().min(0).max(9),
	cursors: z.array(z.tuple([ProviderId, Cursor])).max(10),
});
function decode(cursor?: string): z.output<typeof position> {
	if (!cursor) return { index: 0, cursors: [] };
	try {
		return position.parse(JSON.parse(Buffer.from(cursor, "base64url").toString("utf8")));
	} catch {
		throw new PluginError("CURSOR_EXPIRED");
	}
}
export async function sync(args: SyncRequest, context: PluginContext): Promise<SyncPage> {
	const state = decode(args.cursor);
	const { conversations } = await listConversations(context);
	const conversation = conversations[state.index];
	if (!conversation && state.index !== 0) throw new PluginError("CURSOR_EXPIRED");
	const cursors = new Map(state.cursors);
	const changes: PluginChange[] = [];
	let more = false;
	if (conversation) {
		const page = await listMessages(context, conversation.id, cursors.get(conversation.id));
		cursors.set(conversation.id, page.cursor);
		changes.push(
			...page.messages
				.filter((item) => args.mode === "delta" || item.createdAt >= args.since)
				.map(normalized),
		);
		more = page.more || state.index + 1 < conversations.length;
		state.index = page.more ? state.index : more ? state.index + 1 : 0;
	}
	const cursor = Buffer.from(
		JSON.stringify({ index: state.index, cursors: [...cursors] }),
	).toString("base64url");
	if (cursor.length > 4096) throw new PluginError("TRANSIENT");
	return { changes, cursor, more };
}
