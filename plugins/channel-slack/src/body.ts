import { isProxy } from "node:util/types";
import { MessageRef } from "@draftyak/protocol/channel-v1";
import { type MessageBody, ProviderId } from "@draftyak/protocol/normalized-change";
import type { PluginContext } from "@draftyak/sdk/context";
import { PluginError } from "@draftyak/sdk/errors";
import type { HostFetch } from "@draftyak/sdk/fetch";
import { MAX_SLACK_POLL_PAGES, pollMessages } from "./poll.ts";

type ChatBody = Extract<MessageBody, { kind: "chat.message" }>;

/** Previously observed routing DATA, not a public tool argument or a read grant. */
interface ObservedThread {
	readonly channelId: string;
	readonly ts: string;
	readonly threadTs: string;
}

function invalid(): never {
	throw new PluginError("INVALID_INPUT");
}

function transient(): never {
	throw new PluginError("TRANSIENT");
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

function capture(ctx: unknown, raw: unknown, observed: unknown) {
	const context = record(ctx, ["fetch", "signal"]);
	if (typeof context.fetch !== "function" || isProxy(context.fetch)) invalid();
	if (context.signal === null || typeof context.signal !== "object" || isProxy(context.signal))
		invalid();
	try {
		Reflect.get(AbortSignal.prototype, "aborted", context.signal);
	} catch {
		invalid();
	}
	const parsed = MessageRef.safeParse(record(raw, ["kind", "channelId", "ts", "providerId"]));
	if (!parsed.success) invalid();
	if (parsed.data.kind !== "chat") throw new PluginError("UNSUPPORTED");
	const target = Object.freeze(parsed.data);
	let threadTs: string | undefined;
	if (observed !== undefined) {
		const data = record(observed, ["channelId", "ts", "threadTs"]);
		if (data.channelId !== target.channelId || data.ts !== target.ts) invalid();
		const thread = ProviderId.safeParse(data.threadTs);
		if (!thread.success) invalid();
		threadTs = thread.data;
	}
	const fetch = context.fetch as HostFetch;
	const signal = context.signal as AbortSignal;
	let pages: ReturnType<typeof pollMessages>;
	try {
		// The lazy poller validates exact timestamps now, before any provider request.
		pages = pollMessages(
			{ fetch: (...args: Parameters<HostFetch>) => Reflect.apply(fetch, ctx, args), signal },
			{
				...(threadTs === undefined
					? { kind: "history" as const }
					: { kind: "replies" as const, threadTs }),
				channelId: target.channelId,
				oldest: target.ts,
				latest: target.ts,
				inclusive: true,
				maxPages: threadTs === undefined ? 1 : MAX_SLACK_POLL_PAGES,
			},
		);
	} catch {
		invalid();
	}
	return { target, threadTs, signal, pages };
}

function assertActive(signal: AbortSignal): void {
	if (Reflect.get(AbortSignal.prototype, "aborted", signal)) transient();
}

async function lookup(input: ReturnType<typeof capture>): Promise<ChatBody> {
	let complete = false;
	try {
		assertActive(input.signal);
		for await (const page of input.pages) {
			assertActive(input.signal);
			for (const change of page.changes) {
				if (change.channelId !== input.target.channelId || change.ts !== input.target.ts) continue;
				if (
					input.threadTs !== undefined &&
					(change.ts === input.threadTs
						? change.threadTs !== undefined && change.threadTs !== input.threadTs
						: change.threadTs !== input.threadTs)
				) {
					transient();
				}
				return change;
			}
			complete = !page.more;
		}
	} catch {
		return transient();
	}
	assertActive(input.signal);
	// A history miss may be a reply whose root is not known; it never proves absence.
	if (input.threadTs !== undefined && complete) throw new PluginError("NOT_FOUND");
	return transient();
}

/**
 * Fetch an exact ordinary message body. An optional observed thread tuple only
 * selects the provider route; access and read limits remain the parent's responsibility.
 */
export function fetchSlackMessageBody(
	ctx: Pick<PluginContext, "fetch" | "signal">,
	message: MessageRef,
	observedThread?: Readonly<ObservedThread>,
): Promise<ChatBody> {
	const input = capture(ctx, message, observedThread);
	return lookup(input).then((body) => {
		// The poller has settled body cleanup, including iterator return, before delivery.
		assertActive(input.signal);
		return body;
	});
}
