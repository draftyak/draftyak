import { createHash } from "node:crypto";
import { types } from "node:util";
import {
	createFake,
	createFaults,
	createRecorder,
	type Fake,
	manualClock,
	rawTarget,
	targetOf,
	withTarget,
} from "@draftyak/fakes";
import { parseStrict } from "@draftyak/protocol/jcs";

export const SLACK_URL = "https://slack.com/api/chat.postMessage";
export const MAX_WIRE_BYTES = 131_072;
export const MAX_WIRE_CHUNKS = 16_384;
export const MAX_WIRE_MESSAGES = 32;
export const MAX_WIRE_REQUESTS = 128;
export const MAX_STORED_BYTES: number = 32 * MAX_WIRE_BYTES;
const BLOCK = 65_536;
const typed = Object.getPrototypeOf(Uint8Array.prototype);
const slot = (name: string): ((this: Uint8Array) => unknown) =>
	Object.getOwnPropertyDescriptor(typed, name)?.get as (this: Uint8Array) => unknown;
const lengthOf = slot("byteLength"),
	offsetOf = slot("byteOffset"),
	bufferOf = slot("buffer"),
	set = Uint8Array.prototype.set;

export type SendStep =
	| { readonly kind: "sent"; readonly channelId: string; readonly reply?: "body-lost" }
	| {
			readonly kind: "response";
			readonly channelId: string;
			readonly status: 200 | 400 | 408 | 429 | 500 | 503;
			readonly body: string;
			readonly retryAfter?: string;
	  };
export interface CapturedMessage {
	readonly channel: string;
	readonly thread_ts?: string;
	readonly text: string;
	readonly unfurl_links: false;
	readonly unfurl_media: false;
	readonly reply_broadcast: boolean;
	readonly ts: string;
	readonly bodySha256: string;
}
export interface SlackWireFake {
	readonly fetch: Fake["fetch"];
	readonly recorder: Fake["recorder"];
	readonly faults: Fake["faults"];
	remaining(): number;
	captured(): readonly CapturedMessage[];
}
function refused(): never {
	throw new Error("Slack fixture refused");
}
function object(raw: unknown, allowed: readonly string[]): Record<string, unknown> {
	if (
		!raw ||
		typeof raw !== "object" ||
		types.isProxy(raw) ||
		![Object.prototype, null].includes(Object.getPrototypeOf(raw))
	)
		refused();
	const names = Reflect.ownKeys(raw);
	if (names.length > allowed.length) refused();
	const result: Record<string, unknown> = Object.create(null);
	for (const key of names) {
		if (typeof key !== "string" || !allowed.includes(key)) refused();
		const descriptor = Object.getOwnPropertyDescriptor(raw, key);
		if (!descriptor || !("value" in descriptor) || !descriptor.enumerable) refused();
		result[key] = descriptor.value;
	}
	return result;
}
function array(raw: unknown, cap: number): unknown[] {
	if (
		!raw ||
		types.isProxy(raw) ||
		!Array.isArray(raw) ||
		Object.getPrototypeOf(raw) !== Array.prototype
	)
		refused();
	const length = Object.getOwnPropertyDescriptor(raw, "length")?.value;
	if (!Number.isSafeInteger(length) || length > cap || Reflect.ownKeys(raw).length !== length + 1)
		refused();
	const result: unknown[] = [];
	for (let i = 0; i < length; i++) {
		const item = Object.getOwnPropertyDescriptor(raw, String(i));
		if (!item || !("value" in item) || !item.enumerable) refused();
		result.push(item.value);
	}
	return result;
}
function string(raw: unknown, cap: number): string {
	if (typeof raw !== "string" || raw.length > cap || !raw.isWellFormed()) refused();
	return raw;
}
function channel(raw: unknown): string {
	const value = string(raw, 32);
	if (!/^[CDG][A-Z0-9]{2,31}$/.test(value)) refused();
	return value;
}
function step(raw: unknown, channels: ReadonlySet<string>): SendStep {
	const value = object(raw, ["kind", "channelId", "reply", "status", "body", "retryAfter"]);
	const channelId = channel(value.channelId);
	if (!channels.has(channelId)) refused();
	if (value.kind === "sent") {
		object(raw, ["kind", "channelId", "reply"]);
		if (value.reply !== undefined && value.reply !== "body-lost") refused();
		return Object.freeze({
			kind: "sent",
			channelId,
			...(value.reply === undefined ? {} : { reply: "body-lost" as const }),
		});
	}
	if (value.kind !== "response") refused();
	object(raw, ["kind", "channelId", "status", "body", "retryAfter"]);
	if (![200, 400, 408, 429, 500, 503].includes(value.status as number)) refused();
	const body = string(value.body, 4096);
	if (Buffer.byteLength(body) > 4096) refused();
	const retryAfter = value.retryAfter === undefined ? undefined : string(value.retryAfter, 512);
	if (retryAfter !== undefined && !/^[\x20-\x7e]*$/.test(retryAfter)) refused();
	return Object.freeze({
		kind: "response",
		channelId,
		status: value.status as 200 | 400 | 408 | 429 | 500 | 503,
		body,
		...(retryAfter === undefined ? {} : { retryAfter }),
	});
}
async function readBody(request: Request): Promise<Buffer> {
	const reader = request.body?.getReader();
	if (!reader) return Buffer.alloc(0);
	const blocks: Buffer[] = [];
	let size = 0,
		chunks = 0;
	const cancel = (): void => {
		void reader.cancel().catch(() => {});
	};
	request.signal.addEventListener("abort", cancel, { once: true });
	try {
		while (true) {
			request.signal.throwIfAborted();
			const next = await reader.read();
			request.signal.throwIfAborted();
			if (next.done) break;
			const chunk: unknown = next.value;
			if (
				++chunks > MAX_WIRE_CHUNKS ||
				!chunk ||
				types.isProxy(chunk) ||
				!types.isUint8Array(chunk) ||
				![Uint8Array.prototype, Buffer.prototype].includes(Object.getPrototypeOf(chunk))
			)
				refused();
			const length = Reflect.apply(lengthOf, chunk, []) as number;
			const buffer = Reflect.apply(bufferOf, chunk, []) as ArrayBuffer;
			const offset = Reflect.apply(offsetOf, chunk, []) as number;
			if (
				!types.isArrayBuffer(buffer) ||
				Object.getPrototypeOf(buffer) !== ArrayBuffer.prototype ||
				length > MAX_WIRE_BYTES - size
			)
				refused();
			let at = 0;
			while (at < length) {
				const index = Math.floor(size / BLOCK),
					within = size % BLOCK;
				if (!blocks[index]) blocks.push(Buffer.allocUnsafe(BLOCK));
				const amount = Math.min(length - at, BLOCK - within);
				Reflect.apply(set, blocks[index], [new Uint8Array(buffer, offset + at, amount), within]);
				at += amount;
				size += amount;
			}
		}
		return Buffer.concat(blocks, size);
	} catch {
		cancel();
		return refused();
	} finally {
		blocks.length = 0;
		request.signal.removeEventListener("abort", cancel);
		reader.releaseLock();
	}
}
function payload(
	bytes: Buffer,
	channels: ReadonlySet<string>,
): Omit<CapturedMessage, "ts" | "bodySha256"> {
	const value = object(parseStrict(bytes), [
		"channel",
		"thread_ts",
		"text",
		"unfurl_links",
		"unfurl_media",
		"reply_broadcast",
	]);
	const destination = channel(value.channel);
	if (
		!channels.has(destination) ||
		value.unfurl_links !== false ||
		value.unfurl_media !== false ||
		typeof value.reply_broadcast !== "boolean"
	)
		refused();
	const text = string(value.text, 80_000);
	if (!text.trim() || text.normalize("NFC") !== text || [...text].length > 40_000) refused();
	for (let i = 0; i < text.length; i++) {
		const unit = text.charCodeAt(i);
		if ((unit < 32 && unit !== 9 && unit !== 10) || unit === 127) refused();
	}
	const thread = value.thread_ts === undefined ? undefined : string(value.thread_ts, 22);
	if (thread !== undefined && !/^(?:0|[1-9][0-9]{0,11})\.[0-9]{1,9}$/.test(thread)) refused();
	if (value.reply_broadcast && thread === undefined) refused();
	return Object.freeze({
		channel: destination,
		text,
		unfurl_links: false,
		unfurl_media: false,
		reply_broadcast: value.reply_broadcast,
		...(thread === undefined ? {} : { thread_ts: thread }),
	});
}
const failure = (status: number): Response =>
	Response.json({ ok: false, error: "invalid_arguments" }, { status });

/** Closed in-memory scripted wire data. No Slack authentication, delivery or idempotency claims. */
export function createSlackWireFake(raw: {
	readonly channels: readonly string[];
	readonly steps: readonly SendStep[];
}): SlackWireFake {
	try {
		const options = object(raw, ["channels", "steps"]);
		const channelIds = array(options.channels, 32).map(channel);
		const channels = new Set(channelIds);
		if (!channels.size || channels.size !== channelIds.length) refused();
		const steps = array(options.steps, MAX_WIRE_MESSAGES).map((entry) => step(entry, channels));
		const messages: CapturedMessage[] = [];
		const recorder = createRecorder({ maxBodyBytes: 0 });
		const faults = createFaults({ clock: manualClock(1_760_000_000_000) });
		let used = 0,
			requests = 0,
			storedBytes = 0;
		const fake = createFake(
			{
				async fetch(request) {
					try {
						if (
							request.method !== "POST" ||
							request.url !== SLACK_URL ||
							rawTarget(request) !== "/api/chat.postMessage" ||
							request.headers.get("content-type") !== "application/json"
						)
							return failure(400);
						const body = Buffer.from(await request.arrayBuffer());
						const data = payload(body, channels);
						const next = steps[used];
						if (!next || next.channelId !== data.channel) return failure(409);
						request.signal.throwIfAborted();
						if (next.kind === "response") {
							used++;
							return new Response(next.body, {
								status: next.status,
								headers: {
									"content-type": "application/json",
									...(next.retryAfter === undefined ? {} : { "retry-after": next.retryAfter }),
								},
							});
						}
						if (
							messages.length === MAX_WIRE_MESSAGES ||
							body.length > MAX_STORED_BYTES - storedBytes
						)
							return failure(409);
						const ts = `1760000000.${String(messages.length + 1).padStart(6, "0")}`;
						messages.push(
							Object.freeze({
								...data,
								ts,
								bodySha256: createHash("sha256").update(body).digest("hex"),
							}),
						);
						storedBytes += body.length;
						used++;
						if (next.reply === "body-lost")
							return new Response(
								new ReadableStream({
									start(controller) {
										controller.error(new Error("Slack fixture response lost"));
									},
								}),
								{ status: 200, headers: { "content-type": "application/json" } },
							);
						return Response.json({ ok: true, channel: data.channel, ts });
					} catch {
						return failure(400);
					}
				},
			},
			{ host: "slack.com", recorder, faults },
		);
		return Object.freeze({
			recorder,
			faults,
			remaining: () => steps.length - used,
			captured: () => Object.freeze(messages.slice()),
			async fetch(input: Request | URL | string, init?: RequestInit): Promise<Response> {
				if (
					typeof input !== "string" &&
					(types.isProxy(input) ||
						![Request.prototype, URL.prototype].includes(Object.getPrototypeOf(input)) ||
						Reflect.ownKeys(input).some((key) => typeof key === "string"))
				)
					refused();
				const url =
					typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
				if (url !== SLACK_URL) return failure(400);
				if (requests === MAX_WIRE_REQUESTS) return failure(429);
				requests++;
				const request =
					input instanceof Request && init === undefined ? input : new Request(input, init);
				if ([...request.headers.keys()].some((key) => key !== "content-type")) return failure(400);
				const bytes = await readBody(request);
				return fake.fetch(
					withTarget(
						new Request(request, {
							body:
								request.method === "GET" || request.method === "HEAD"
									? undefined
									: new Uint8Array(bytes),
						}),
						targetOf(url),
					),
				);
			},
		});
	} catch {
		return refused();
	}
}
