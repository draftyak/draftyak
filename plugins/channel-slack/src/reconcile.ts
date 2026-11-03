import { isProxy } from "node:util/types";
import {
	channelV1,
	type ReconcileResult,
	type ReconcileTarget,
} from "@draftyak/protocol/channel-v1";
import { HOST_MAX_STREAM_BYTES } from "@draftyak/protocol/host-channel";
import { type MessageBody, ProviderId } from "@draftyak/protocol/normalized-change";
import type { PluginContext } from "@draftyak/sdk/context";
import { PluginError } from "@draftyak/sdk/errors";
import type { HostFetch, HostResponse } from "@draftyak/sdk/fetch";
import { MAX_SLACK_POLL_PAGES, pollMessages } from "./poll.ts";

function invalid(): never {
	throw new PluginError("INVALID_INPUT");
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

function capture(ctx: unknown, raw: unknown) {
	const context = record(ctx, ["fetch", "signal"]);
	if (typeof context.fetch !== "function" || isProxy(context.fetch)) invalid();
	if (context.signal === null || typeof context.signal !== "object" || isProxy(context.signal))
		invalid();
	try {
		Reflect.get(AbortSignal.prototype, "aborted", context.signal);
	} catch {
		invalid();
	}
	const request = record(raw, ["attemptAt", "target"]);
	request.target = record(request.target, [
		"kind",
		"channelId",
		"threadTs",
		"threadId",
		"rfc822MessageId",
	]);
	const parsed = channelV1.tools.channel_send_reconcile.input.safeParse(request);
	if (!parsed.success) invalid();
	if (parsed.data.target.kind !== "chat") throw new PluginError("UNSUPPORTED");
	const input = {
		fetch: context.fetch as HostFetch,
		signal: context.signal as AbortSignal,
		receiver: ctx,
	};
	const attemptAt = parsed.data.attemptAt;
	const milliseconds = BigInt(attemptAt);
	const oldest = `${milliseconds / 1_000n}.${String(milliseconds % 1_000n).padStart(3, "0")}`;
	const target = Object.freeze(parsed.data.target);
	// Constructing this lazy iterator validates the provider timestamp before any HTTP request.
	let pages: ReturnType<typeof pollMessages>;
	try {
		pages = pollMessages(
			{
				fetch: (...args: Parameters<HostFetch>) => Reflect.apply(input.fetch, input.receiver, args),
				signal: input.signal,
			},
			{
				...(target.threadTs === undefined
					? { kind: "history" as const }
					: { kind: "replies" as const, threadTs: target.threadTs }),
				channelId: target.channelId,
				oldest,
				inclusive: true,
				maxPages: MAX_SLACK_POLL_PAGES,
			},
		);
	} catch {
		invalid();
	}
	return { ...input, attemptAt, target, pages };
}

function assertActive(signal: AbortSignal): void {
	if (Reflect.get(AbortSignal.prototype, "aborted", signal)) throw new PluginError("TRANSIENT");
}

async function selfIdentity(input: ReturnType<typeof capture>): Promise<string | undefined> {
	const owned = new AbortController();
	let response: HostResponse | undefined;
	let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
	try {
		assertActive(input.signal);
		response = await Reflect.apply(input.fetch, input.receiver, [
			"https://slack.com/api/auth.test",
			{ method: "POST", stream: true, signal: AbortSignal.any([input.signal, owned.signal]) },
		]);
		assertActive(input.signal);
		if (
			!response.ok ||
			response.bodyRef !== undefined ||
			response.body === null ||
			response.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase() !==
				"application/json"
		) {
			return undefined;
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
			if (bytes > HOST_MAX_STREAM_BYTES) return undefined;
			text.push(decoder.decode(part.value, { stream: true }));
		}
		text.push(decoder.decode());
		const data = record(JSON.parse(text.join("")), ["ok", "user_id"]);
		if (data.ok !== true) return undefined;
		const id = ProviderId.safeParse(data.user_id);
		return id.success ? id.data : undefined;
	} finally {
		// The account-bound request remains owned until its body cleanup has completed.
		owned.abort();
		try {
			if (reader !== undefined) await reader.cancel();
			else if (response?.body !== undefined && response.body !== null) await response.body.cancel();
		} finally {
			reader?.releaseLock();
		}
	}
}

function result(candidates: MessageBody[], complete: boolean): ReconcileResult {
	return Object.freeze({ candidates: Object.freeze(candidates), complete });
}

async function scan(input: ReturnType<typeof capture>): Promise<ReconcileResult> {
	let self: string | undefined;
	try {
		self = await selfIdentity(input);
	} catch {
		assertActive(input.signal);
		return result([], false);
	}
	assertActive(input.signal);
	if (self === undefined) return result([], false);
	const candidates: MessageBody[] = [];
	const seen = new Set<string>();
	let complete = false;
	try {
		for await (const page of input.pages) {
			assertActive(input.signal);
			for (const change of page.changes) {
				if (
					change.author.kind !== "user" ||
					change.author.id !== self ||
					change.sentAt < input.attemptAt ||
					(input.target.threadTs !== undefined &&
						change.ts !== input.target.threadTs &&
						change.threadTs !== input.target.threadTs) ||
					seen.has(change.ts)
				) {
					continue;
				}
				if (candidates.length === 50) return result(candidates, false);
				seen.add(change.ts);
				candidates.push(change);
			}
			complete = !page.more;
		}
	} catch {
		assertActive(input.signal);
		complete = false;
	}
	assertActive(input.signal);
	return result(candidates, complete);
}

/**
 * Collect observed self-authored candidates, without deciding whether a send took
 * effect. Completeness covers only the queried provider interval and never grants a retry.
 */
export function reconcileSlackSend(
	ctx: PluginContext,
	args: { readonly attemptAt: number; readonly target: ReconcileTarget },
): Promise<ReconcileResult> {
	const input = capture(ctx, args);
	return scan(input).then((value) => {
		assertActive(input.signal);
		return value;
	});
}
