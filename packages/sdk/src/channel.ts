import { type ChannelV1Tools, channelV1 } from "@draftyak/protocol/channel-v1";
import { SEND_TICKET_META, SendTicket } from "@draftyak/protocol/send-ticket";
import type { PluginContext } from "./context.ts";
import { capture, checkedTool, entry, type Handler, manifest } from "./definitions.ts";
import { PluginError } from "./errors.ts";
import type { PluginEntry } from "./serve.ts";

export interface ChannelSendContext extends PluginContext {
	readonly sendTicket: SendTicket;
}
export interface ChannelPluginDefinition {
	readonly manifest: unknown;
	readonly describe: Handler<ChannelV1Tools["channel_describe"]>;
	readonly probe: Handler<ChannelV1Tools["channel_probe"]>;
	readonly sync: Handler<ChannelV1Tools["channel_sync"]>;
	readonly fetchBody: Handler<ChannelV1Tools["channel_body_fetch"]>;
	readonly fetchAttachment?: Handler<ChannelV1Tools["channel_attachment_fetch"]>;
	readonly mutate?: Handler<ChannelV1Tools["channel_mutate"]>;
	readonly send: Handler<ChannelV1Tools["channel_send"], ChannelSendContext>;
	readonly reconcileSend: Handler<ChannelV1Tools["channel_send_reconcile"]>;
	readonly listen?: Handler<ChannelV1Tools["channel_listen"]>;
}
const names = {
	describe: "channel_describe",
	probe: "channel_probe",
	sync: "channel_sync",
	fetchBody: "channel_body_fetch",
	fetchAttachment: "channel_attachment_fetch",
	mutate: "channel_mutate",
	send: "channel_send",
	reconcileSend: "channel_send_reconcile",
	listen: "channel_listen",
} as const;
export function defineChannelPlugin(options: ChannelPluginDefinition): PluginEntry {
	const captured = capture(
		options,
		["manifest", "describe", "probe", "sync", "fetchBody", "send", "reconcileSend"],
		["fetchAttachment", "mutate", "listen"],
	);
	const declared = manifest(captured.manifest, "channel");
	const tools = Object.entries(names).flatMap(([key, name]) => {
		const handler = captured[key];
		if (handler === undefined) return [];
		const tool = checkedTool(name, channelV1.tools[name], async (args, context, metadata) => {
			let invocationContext: PluginContext | ChannelSendContext = context;
			if (name === "channel_send") {
				const ticket = SendTicket.safeParse(metadata[SEND_TICKET_META]);
				if (!ticket.success) throw new PluginError("INVALID_INPUT");
				invocationContext = Object.freeze({ ...context, sendTicket: Object.freeze(ticket.data) });
			}
			return Reflect.apply(handler as (...args: never[]) => unknown, undefined, [
				args,
				invocationContext,
			]);
		});
		return [name === "channel_sync" ? Object.freeze({ ...tool, timeoutMs: 120000 }) : tool];
	});
	return entry(declared, channelV1, tools);
}
