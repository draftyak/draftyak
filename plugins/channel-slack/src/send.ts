import { isProxy } from "node:util/types";
import { channelV1, MessageRef, type SendRequest } from "@draftyak/protocol/channel-v1";
import { HOST_MAX_STREAM_BYTES } from "@draftyak/protocol/host-channel";
import { SendTicket } from "@draftyak/protocol/send-ticket";
import type { ChannelSendContext } from "@draftyak/sdk/channel";
import { PluginError } from "@draftyak/sdk/errors";
import type { HostFetch, HostResponse } from "@draftyak/sdk/fetch";

type ChatMessageRef = Extract<MessageRef, { kind: "chat" }>;
type SendResult = Readonly<{ message: ChatMessageRef }>;

function invalid(): never {
	throw new PluginError("INVALID_INPUT");
}

function uncertain(): never {
	throw new PluginError("SEND_UNCERTAIN");
}

function record(raw: unknown, keys: readonly string[]): Record<string, unknown> {
	if (raw === null || typeof raw !== "object" || isProxy(raw)) invalid();
	const prototype = Object.getPrototypeOf(raw);
	if (prototype !== null && prototype !== Object.prototype) invalid();
	const result: Record<string, unknown> = Object.create(null);
	for (const key of keys) {
		const descriptor = Object.getOwnPropertyDescriptor(raw, key);
		if (descriptor === undefined) continue;
		if (!descriptor.enumerable || !("value" in descriptor)) invalid();
		result[key] = descriptor.value;
	}
	return result;
}

function capture(ctx: unknown, args: unknown) {
	const context = record(ctx, ["fetch", "signal", "sendTicket"]);
	if (typeof context.fetch !== "function" || isProxy(context.fetch)) invalid();
	if (context.signal === null || typeof context.signal !== "object" || isProxy(context.signal))
		invalid();
	try {
		Reflect.get(AbortSignal.prototype, "aborted", context.signal);
	} catch {
		invalid();
	}
	const request = record(args, ["method", "url", "contentType", "body"]);
	request.body = record(request.body, ["ref"]);
	const checked = channelV1.tools.channel_send.input.safeParse(request);
	const ticket = SendTicket.safeParse(
		record(context.sendTicket, [
			"id",
			"outboxId",
			"instanceId",
			"method",
			"url",
			"headersSha256",
			"contentType",
			"bodySha256",
			"exp",
		]),
	);
	if (!checked.success || !ticket.success) invalid();
	return {
		fetch: context.fetch as HostFetch,
		signal: context.signal as AbortSignal,
		receiver: ctx,
		request: Object.freeze({ ...checked.data, body: Object.freeze(checked.data.body) }),
		ticket: Object.freeze(ticket.data),
	};
}

function assertActive(signal: AbortSignal): void {
	if (Reflect.get(AbortSignal.prototype, "aborted", signal)) uncertain();
}

async function dispatch(input: ReturnType<typeof capture>): Promise<SendResult> {
	const owned = new AbortController();
	let response: HostResponse | undefined;
	let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
	try {
		try {
			assertActive(input.signal);
			response = await Reflect.apply(input.fetch, input.receiver, [
				input.request.url,
				{
					method: input.request.method,
					headers: [["Content-Type", input.request.contentType]],
					body: input.request.body,
					sendTicket: input.ticket,
					stream: true,
					signal: AbortSignal.any([input.signal, owned.signal]),
				},
			]);
			assertActive(input.signal);
			if (
				!response.ok ||
				response.bodyRef !== undefined ||
				response.body === null ||
				response.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase() !==
					"application/json"
			) {
				uncertain();
			}
			reader = response.body.getReader();
			const decoder = new TextDecoder("utf-8", { fatal: true });
			const text: string[] = [];
			let bytes = 0;
			for (;;) {
				const part = await reader.read();
				assertActive(input.signal);
				if (part.done) break;
				bytes += part.value.byteLength;
				if (bytes > HOST_MAX_STREAM_BYTES) uncertain();
				text.push(decoder.decode(part.value, { stream: true }));
			}
			text.push(decoder.decode());
			const data = record(JSON.parse(text.join("")), ["ok", "channel", "ts"]);
			if (data.ok !== true) uncertain();
			const message = MessageRef.safeParse({ kind: "chat", channelId: data.channel, ts: data.ts });
			if (!message.success || message.data.kind !== "chat") uncertain();
			return Object.freeze({ message: Object.freeze(message.data) });
		} finally {
			// Abort before SDK body cancellation removes the request's abort listener.
			owned.abort();
			try {
				if (reader !== undefined) await reader.cancel();
				else if (response?.body !== undefined && response.body !== null)
					await response.body.cancel();
			} finally {
				reader?.releaseLock();
			}
		}
	} catch {
		return uncertain();
	}
}

/**
 * Forward one rendered request. A returned provider reference is untrusted DATA;
 * the parent owns ticket enforcement and the authoritative delivery outcome.
 */
export function sendSlack(ctx: ChannelSendContext, args: SendRequest): Promise<SendResult> {
	const input = capture(ctx, args);
	return dispatch(input).then((result) => {
		// Cleanup can await after the final body byte; cancellation still makes delivery uncertain.
		assertActive(input.signal);
		return result;
	});
}
