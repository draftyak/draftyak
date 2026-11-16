import {
	type ChannelSyncRequest,
	type ChannelV1Tools,
	channelV1,
	SelectedCatalogSyncPage,
	SelectedCatalogSyncRequest,
	SelectedSyncPage,
	SelectedSyncRequest,
	SyncPage,
	type SyncRequest,
	selectedSlackCatalogPageMatches,
	selectedSlackCatalogWorkEqual,
	selectedSlackReplyCountsMatch,
	selectedSlackWorkEqual,
} from "@draftyak/protocol/channel-v1";
import { SEND_TICKET_META, SendTicket } from "@draftyak/protocol/send-ticket";
import type { PluginContext } from "./context.ts";
import { capture, checkedTool, dataCopy, entry, type Handler, manifest } from "./definitions.ts";
import { PluginError } from "./errors.ts";
import type { PluginEntry } from "./serve.ts";

export interface ChannelSendContext extends PluginContext {
	readonly sendTicket: SendTicket;
}
export interface ChannelPluginDefinition {
	readonly manifest: unknown;
	readonly describe: Handler<ChannelV1Tools["channel_describe"]>;
	readonly probe: Handler<ChannelV1Tools["channel_probe"]>;
	readonly sync: (args: SyncRequest, context: PluginContext) => SyncPage | Promise<SyncPage>;
	readonly syncSelected?: (
		args: SelectedSyncRequest,
		context: PluginContext,
	) => SelectedSyncPage | Promise<SelectedSyncPage>;
	readonly syncSelectedCatalog?: (
		args: SelectedCatalogSyncRequest,
		context: PluginContext,
	) => SelectedCatalogSyncPage | Promise<SelectedCatalogSyncPage>;
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
		["fetchAttachment", "mutate", "listen", "syncSelected", "syncSelectedCatalog"],
	);
	const declared = manifest(captured.manifest, "channel");
	const tools = Object.entries(names).flatMap(([key, name]) => {
		const handler = captured[key];
		if (handler === undefined) return [];
		const tool = checkedTool(name, channelV1.tools[name], async (args, context, metadata) => {
			if (name === "channel_sync") {
				const request = args as ChannelSyncRequest;
				if (request.mode === "selected") {
					if (request.work.kind === "slack.catalog" || request.work.kind === "slack.info") {
						const catalog = captured.syncSelectedCatalog;
						if (catalog === undefined) throw new PluginError("UNSUPPORTED");
						const expected = SelectedCatalogSyncRequest.parse(dataCopy(request)).work;
						const value = dataCopy(
							await Reflect.apply(catalog as (...args: never[]) => unknown, undefined, [
								request,
								context,
							]),
						);
						const result = SelectedCatalogSyncPage.safeParse(value);
						if (
							!result.success ||
							!selectedSlackCatalogWorkEqual(expected, result.data.work) ||
							!selectedSlackCatalogPageMatches(result.data)
						)
							throw new PluginError("TRANSIENT");
						return result.data;
					}
					const selected = captured.syncSelected;
					if (selected === undefined) throw new PluginError("UNSUPPORTED");
					// Keep the checked request separate from handler-owned mutable arguments.
					const expected = SelectedSyncRequest.parse(dataCopy(request)).work;
					const value = dataCopy(
						await Reflect.apply(selected as (...args: never[]) => unknown, undefined, [
							request,
							context,
						]),
					);
					const result = SelectedSyncPage.safeParse(value);
					if (
						!result.success ||
						!selectedSlackWorkEqual(expected, result.data.work) ||
						!selectedSlackReplyCountsMatch(result.data)
					)
						throw new PluginError("TRANSIENT");
					return result.data;
				}
				const value = dataCopy(
					await Reflect.apply(handler as (...args: never[]) => unknown, undefined, [
						request,
						context,
					]),
				);
				const result = SyncPage.safeParse(value);
				if (!result.success) throw new PluginError("TRANSIENT");
				return result.data;
			}
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
