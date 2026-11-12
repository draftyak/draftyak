import { CHANNEL_V1 } from "@draftyak/protocol/channel-v1";
import { defineChannelPlugin, PluginError } from "@draftyak/sdk";
import type { MockPlugin } from "../../../src/types.ts";

export const SOCKET_URL = "wss://wss-primary.slack.com/DYTEST-process";
export const EARLY_MESSAGE = "DYTEST-before-open-result";
export const ACK_ID = "DYTEST-early-ack";
const manifest = {
	id: "@example/dytest-socket-process", version: "1.0.0", kind: "channel",
	sdk: "1.0.0", runtime: "node", isolation: "standard",
	contract: { extension: CHANNEL_V1, version: 1 },
	auth: { kind: "none", scopes: [], requiredGrantedScopes: [] },
	credentials: { mode: "brokered", urlSecrets: [] }, permissions: {},
	dataClasses: ["slack.content"], license: "Apache-2.0",
	egress: { profile: "slack-v1" }, send: { render: "slack-postmessage" },
};

export function socketProcessPlugin(onSync?: () => void): MockPlugin {
	const entry = defineChannelPlugin({
		manifest,
		describe: () => ({ channel: "chat", mutations: [], attachments: false, listen: false }),
		probe: () => ({ status: "ok" }),
		async sync(_args, context) {
			onSync?.();
			const socket = await context.ws.open(SOCKET_URL);
			const received: string[] = [];
			const unsubscribe = socket.subscribe((data) => received.push(data));
			try {
				// The first subscription drains frames received before the open result.
				const text = received[0];
				if (received.length !== 1 || text !== EARLY_MESSAGE) throw new PluginError("TRANSIENT");
				await socket.sendAck(ACK_ID);
				return {
					changes: [{ kind: "chat.message" as const, channelId: "DYTEST-channel",
						ts: "1700000000.000001", sentAt: 1_700_000_000_000,
						author: { kind: "user" as const, id: "DYTEST-user" }, text }],
					cursor: ACK_ID, more: false,
				};
			} finally { unsubscribe(); }
		},
		fetchBody() { throw new PluginError("NOT_FOUND"); },
		send() { throw new PluginError("UNSUPPORTED"); },
		reconcileSend: () => ({ candidates: [], complete: true }),
	});
	return { manifest, entry };
}
