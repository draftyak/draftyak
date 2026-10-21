import { CHANNEL_V1, channelV1 } from "@draftyak/protocol/channel-v1";
import { extensionDeclaration } from "@draftyak/protocol/extension";
import { SEND_TICKET_META } from "@draftyak/protocol/send-ticket";
import type { HostFetchInit, PluginTool } from "@draftyak/sdk";
import * as z from "zod";
import type { MockPlugin } from "../../../src/index.ts";

export function channelFixture(handler?: PluginTool["handler"], account?: string): MockPlugin {
	return {
		manifest: {
			id: "@example/mock-channel", version: "1.0.0", kind: "channel", sdk: "1.0.0", runtime: "node", isolation: "standard",
			contract: { extension: CHANNEL_V1, version: 1 }, auth: { kind: "none", scopes: [], requiredGrantedScopes: [] }, credentials: { mode: "brokered", urlSecrets: [] }, permissions: {}, dataClasses: ["example.content"], license: "Apache-2.0",
			egress: { rules: [
				{ class: "read", method: "GET", host: "hello.draftyak.example", pathTemplate: "/v1/conversations", query: ["cursor"], maxBytes: 32768, timeoutMs: 1000 },
				{ class: "organize", method: "PATCH", host: "hello.draftyak.example", pathTemplate: "/v1/conversations/{id}", maxBytes: 32768, timeoutMs: 1000 },
				{ class: "send", method: "POST", host: "hello.draftyak.example", pathTemplate: "/v1/conversations/{chat.channelId}/messages", query: { idempotency_key: "outbox.id" }, maxBytes: 32768, timeoutMs: 1000 },
			] },
			send: { render: "json-template", constants: {}, template: { rule: 2, path: ["v1", "conversations", { bind: "chat.channelId" }, "messages"], query: { idempotency_key: { bind: "outbox.id" } }, headers: { "content-type": "application/json" }, body: { text: { bind: "body.textWithFooter" } } } },
		},
		entry: { name: "mock-channel", version: "1.0.0", plugin: "@example/mock-channel", ...(account ? { account } : {}), extensions: { [CHANNEL_V1]: extensionDeclaration(channelV1) }, tools: [{
			name: "channel_fetch",
			inputSchema: z.strictObject({ url: z.string(), method: z.enum(["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"]).optional(), headers: z.record(z.string(), z.string()).optional(), body: z.unknown().optional(), saveAs: z.literal("blob").optional() }),
			handler: handler ?? (async (input, context, metadata) => {
				const args = input as { url: string; method?: string; headers?: Record<string, string>; body?: HostFetchInit["body"]; saveAs?: "blob" };
				const response = await context.fetch(args.url, { method: args.method ?? "GET", ...(args.headers ? { headers: args.headers } : {}), ...(args.body === undefined ? {} : { body: args.body }), ...(args.saveAs ? { saveAs: args.saveAs } : {}), ...(metadata[SEND_TICKET_META] === undefined ? {} : { sendTicket: metadata[SEND_TICKET_META] }) });
				return { status: response.status, headers: Object.fromEntries(response.headers), ...(response.bodyRef ? { ref: response.bodyRef.ref } : { text: await response.text() }) };
			}),
		}] },
	};
}
export const plugin: MockPlugin = channelFixture();
