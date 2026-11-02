import { defineChannelPlugin, type PluginEntry, PluginError } from "@draftyak/sdk";
import manifest from "../draftyak.plugin.json" with { type: "json" };
import { normalized, request, scan, self, sent } from "./provider.ts";
import { sync } from "./sync.ts";

export { manifest };
export const plugin: PluginEntry = defineChannelPlugin({
	manifest,
	describe: () => ({ channel: "chat", mutations: [], attachments: false, listen: false }),
	async probe(_args, context) {
		await request(context, "/v1/me", self);
		return { status: "ok" };
	},
	sync,
	async fetchBody({ message }, context) {
		if (message.kind !== "chat") throw new PluginError("UNSUPPORTED");
		const found = await scan(context, message.channelId);
		const body = found.messages.find((item) => item.id === message.ts);
		if (!body) throw new PluginError(found.complete ? "NOT_FOUND" : "TRANSIENT");
		return { message: normalized(body) };
	},
	async send(args, context) {
		const value = await request(context, args.url, sent, {
			method: args.method,
			headers: { "content-type": args.contentType },
			body: args.body,
			sendTicket: context.sendTicket,
		});
		return { message: { kind: "chat", channelId: value.conversationId, ts: value.id } };
	},
	async reconcileSend({ attemptAt, target }, context) {
		if (target.kind !== "chat" || target.threadTs) throw new PluginError("UNSUPPORTED");
		const owner = await request(context, "/v1/me", self);
		const found = await scan(context, target.channelId);
		const candidates = found.messages.filter(
			(item) => item.author === owner.id && item.createdAt >= attemptAt,
		);
		return {
			candidates: candidates.slice(0, 50).map(normalized),
			complete: found.complete && candidates.length <= 50,
		};
	},
});
