import { createFake, createHelloFake, createRecorder, manualClock } from "@draftyak/fakes";
import { CHANNEL_V1, type ChannelDescription, channelV1 } from "@draftyak/protocol/channel-v1";
import { ChatChannelType, type ChatConversationChange, type ChatMessageChange, ProviderId } from "@draftyak/protocol/normalized-change";
import {
	defineChannelPlugin,
	type PluginContext,
	PluginError,
	type PluginTool,
} from "@draftyak/sdk";
import * as z from "zod";
import type { ChannelContractFixture } from "../../../src/contracts/channel.ts";
import type { MockPlugin } from "../../../src/types.ts";

const origin = "https://hello.draftyak.example";
const now = 1_800_000_000_000;
const outboxId = "00000000000000000000000300";
const conversation: ChatConversationChange = {
	kind: "chat.conversation" as const,
	channelId: "conv-1",
	name: "DYTEST contract",
	type: "public" as const,
	external: false,
	shared: false,
	memberCount: 1,
	archived: false,
	member: true,
};
const providerConversation = {
	id: "conv-1",
	name: "DYTEST contract",
	type: "public",
	external: false,
	shared: false,
	memberCount: 1,
	archived: false,
	member: true,
};
const conversationMetadata = z.strictObject({
	id: ProviderId,
	name: z.string().max(256),
	type: ChatChannelType,
	external: z.boolean(),
	shared: z.boolean(),
	memberCount: z.int().min(0),
	archived: z.boolean(),
	member: z.boolean(),
});
interface ProviderMessage {
	readonly id: string;
	readonly author: string;
	readonly text: string;
	readonly createdAt: number;
}
const message = (value: ProviderMessage): ChatMessageChange => ({
	kind: "chat.message",
	channelId: "conv-1",
	ts: value.id,
	sentAt: value.createdAt,
	author: { kind: "user", id: value.author },
	text: value.text,
});
const first = message({ id: "msg_000001", author: "user-1", text: "DYTEST first", createdAt: now });
const sent = message({ id: "msg_000002", author: "me", text: "DYTEST approved", createdAt: now });
const rendered = {
	outboxId,
	method: "POST" as const,
	url: `${origin}/v1/conversations/conv-1/messages?idempotency_key=${outboxId}`,
	headers: [["content-type", "application/json"]] as const,
	body: new TextEncoder().encode('{"text":"DYTEST approved"}'),
};

const manifest = {
	id: "@example/contract-channel",
	version: "1.0.0",
	kind: "channel",
	sdk: "1.0.0",
	runtime: "node",
	isolation: "standard",
	contract: { extension: CHANNEL_V1, version: 1 },
	auth: { kind: "none", scopes: [], requiredGrantedScopes: [] },
	credentials: { mode: "brokered", urlSecrets: [] },
	permissions: {},
	dataClasses: ["example.content"],
	license: "Apache-2.0",
	egress: { rules: [
		{ class: "read", method: "GET", host: "hello.draftyak.example", pathTemplate: "/v1/conversations/{id}/messages", query: ["cursor"], maxBytes: 32768, timeoutMs: 1000 },
		{ class: "send", method: "POST", host: "hello.draftyak.example", pathTemplate: "/v1/conversations/{chat.channelId}/messages", query: { idempotency_key: "outbox.id" }, maxBytes: 32768, timeoutMs: 1000 },
		{ class: "read", method: "GET", host: "hello.draftyak.example", pathTemplate: "/v1/conversations/{id}", query: [], maxBytes: 32768, timeoutMs: 1000 },
	] },
	send: { render: "json-template", constants: {}, template: { rule: 1, path: ["v1", "conversations", { bind: "chat.channelId" }, "messages"], query: { idempotency_key: { bind: "outbox.id" } }, headers: { "content-type": "application/json" }, body: { text: { bind: "body.textWithFooter" } } } },
};

async function read(context: PluginContext, cursor?: string): Promise<{ messages: ProviderMessage[]; cursor: string; more: boolean }> {
	const response = await context.fetch(`${origin}/v1/conversations/conv-1/messages${cursor ? `?cursor=${cursor}` : ""}`);
	if (response.status === 410) throw new PluginError("CURSOR_EXPIRED");
	if (response.status === 429) throw new PluginError("RATE_LIMITED", { retryAfterMs: 1000 });
	if (!response.ok) throw new PluginError("TRANSIENT");
	return response.json() as Promise<{ messages: ProviderMessage[]; cursor: string; more: boolean }>;
}

async function readConversation(context: PluginContext): Promise<ChatConversationChange> {
	const response = await context.fetch(`${origin}/v1/conversations/conv-1`);
	if (!response.ok) throw new PluginError("TRANSIENT");
	const parsed = conversationMetadata.safeParse(await response.json());
	if (!parsed.success) throw new PluginError("TRANSIENT");
	const metadata = parsed.data;
	return {
		kind: "chat.conversation",
		channelId: metadata.id,
		name: metadata.name,
		type: metadata.type,
		external: metadata.external,
		shared: metadata.shared,
		memberCount: metadata.memberCount,
		archived: metadata.archived,
		member: metadata.member,
	};
}

export interface ChannelVariant {
	readonly description?: ChannelDescription;
	readonly listen?: PluginTool["handler"];
	readonly mutate?: PluginTool["handler"];
	readonly replace?: Readonly<Record<string, PluginTool["handler"]>>;
	readonly extension?: Readonly<Record<string, unknown>>;
}

export function contractChannel(variant: ChannelVariant = {}): MockPlugin {
	const entry = defineChannelPlugin({
		manifest,
		describe: async () => variant.description ?? { channel: "chat", mutations: [], attachments: false, listen: false },
		probe: async (_args, context) => { await read(context); return { status: "ok" }; },
		sync: async (args, context) => {
			const page = await read(context, args.cursor);
			const conversations = args.mode === "delta" || args.cursor ? [] : [await readConversation(context)];
			return {
				changes: [...conversations, ...page.messages.map(message)],
				cursor: page.cursor,
				more: page.more,
			};
		},
		fetchBody: async ({ message: ref }, context) => {
			const page = await read(context);
			const found = ref.kind === "chat" && ref.channelId === "conv-1" && page.messages.find((item) => item.id === ref.ts);
			if (!found) throw new PluginError("NOT_FOUND");
			return { message: message(found) };
		},
		send: async (args, context) => {
			const response = await context.fetch(args.url, { method: args.method, headers: { "content-type": args.contentType }, body: args.body, sendTicket: context.sendTicket });
			if (!response.ok) throw new PluginError("SEND_REJECTED");
			const value = await response.json() as { id: string; conversationId: string };
			return { message: { kind: "chat", channelId: value.conversationId, ts: value.id } };
		},
		reconcileSend: async ({ attemptAt }, context) => ({
			candidates: (await read(context)).messages.filter((item) => item.author === "me" && item.createdAt >= attemptAt).map(message),
			complete: true,
		}),
	});
	const tools = entry.tools.map((tool) => variant.replace?.[tool.name] ? { ...tool, handler: variant.replace[tool.name] as PluginTool["handler"] } : tool);
	if (variant.listen) tools.push({ name: "channel_listen", inputSchema: channelV1.tools.channel_listen.input, outputSchema: channelV1.tools.channel_listen.output, handler: variant.listen });
	if (variant.mutate) tools.push({ name: "channel_mutate", inputSchema: channelV1.tools.channel_mutate.input, outputSchema: channelV1.tools.channel_mutate.output, handler: variant.mutate });
	return { manifest, entry: { ...entry, ...(variant.extension ? { extensions: variant.extension } : {}), tools } };
}

export function contractFixtures(
	onClose?: () => void,
	facts: { readonly shared: boolean; readonly omitShared?: boolean } = { shared: false },
): ChannelContractFixture {
	const clock = manualClock(now);
	const fake = createHelloFake({ clock, cursorTtlMs: 1000, conversations: [{ id: "conv-1", name: "DYTEST contract", messages: [{ author: "user-1", text: "DYTEST first" }] }] });
	const metadata: Record<string, unknown> = { ...providerConversation, shared: facts.shared };
	if (facts.omitShared) delete metadata.shared;
	const provider = createFake({
		fetch: (request) => request.method === "GET" && new URL(request.url).pathname === "/v1/conversations/conv-1"
			? Response.json(metadata)
			: fake.fetch(request),
	}, { host: fake.host, recorder: createRecorder({ headerValues: ["content-type"] }) });
	return {
		upstreams: [provider],
		sync: {
			since: 0,
			initial: [{ ...conversation, shared: facts.shared }, first],
			addDelta: () => [message(fake.addMessage("conv-1", { author: "user-2", text: "DYTEST delta" }))],
			expireCursor: () => { clock.advance(1001); },
		},
		body: { message: { kind: "chat", channelId: "conv-1", ts: "msg_000001" }, expected: first },
		send: {
			rendered,
			expectedMessage: { kind: "chat", channelId: "conv-1", ts: sent.ts },
			reconcile: { arguments: { attemptAt: now, target: { kind: "chat", channelId: "conv-1" } }, expected: { candidates: [sent], complete: true } },
		},
		errors: [
			{ name: "channel_body_fetch", arguments: { message: { kind: "chat", channelId: "conv-1", ts: "DYTEST-missing" } }, code: "NOT_FOUND" },
			{ name: "channel_probe", arguments: {}, code: "RATE_LIMITED", retryAfterMs: 1000, prepare: () => { fake.faults.add({ kind: "rate-limit", retryAfter: 1 }); } },
		],
		close: onClose,
	};
}
