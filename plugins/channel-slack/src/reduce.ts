import { isProxy } from "node:util/types";
import { ChatMessageChange, MAX_CHANGES } from "@draftyak/protocol/normalized-change";

export interface SlackReadPage {
	readonly changes: readonly ChatMessageChange[];
	readonly nextCursor: string | undefined;
	readonly more: boolean;
	readonly replyCounts: readonly { readonly ts: string; readonly count: number }[];
}

interface WireMessage {
	readonly type: "message";
	readonly ts: string;
	readonly user: string;
	readonly text: string;
	readonly thread_ts?: string;
	readonly reply_count?: number;
}

const MAX_TEXT_UNITS = 80_000;
const PAGE_KEYS = ["ok", "messages", "has_more", "response_metadata"];
const MESSAGE_KEYS = ["type", "ts", "user", "text", "thread_ts", "reply_count"];
const UNSUPPORTED_MESSAGE_KEYS = [
	"subtype",
	"bot_id",
	"files",
	"edited",
	"message",
	"deleted_ts",
	"attachments",
];

function invalid(): never {
	throw new Error("SLACK_READ_INVALID");
}

// Fixed descriptor reads leave unrelated provider branches unread, including getters.
function record(
	raw: unknown,
	selected: readonly string[],
	unsupported: readonly string[] = [],
): Record<string, unknown> {
	if (raw === null || typeof raw !== "object" || isProxy(raw)) invalid();
	const prototype = Object.getPrototypeOf(raw);
	if (prototype !== null && prototype !== Object.prototype) invalid();
	for (const key of unsupported) {
		if (Object.getOwnPropertyDescriptor(raw, key) !== undefined) invalid();
	}
	const result: Record<string, unknown> = Object.create(null);
	for (const key of selected) {
		const descriptor = Object.getOwnPropertyDescriptor(raw, key);
		if (descriptor === undefined) continue;
		if (!descriptor.enumerable || !("value" in descriptor)) invalid();
		result[key] = descriptor.value;
	}
	return result;
}

function messages(raw: unknown): readonly unknown[] {
	if (raw === null || typeof raw !== "object" || isProxy(raw) || !Array.isArray(raw)) {
		invalid();
	}
	if (Object.getPrototypeOf(raw) !== Array.prototype) invalid();
	const size = Object.getOwnPropertyDescriptor(raw, "length")?.value;
	if (!Number.isSafeInteger(size) || size < 0 || size > MAX_CHANGES) invalid();
	if (Reflect.ownKeys(raw).length !== size + 1) invalid();
	const result: unknown[] = [];
	for (let index = 0; index < size; index++) {
		const descriptor = Object.getOwnPropertyDescriptor(raw, String(index));
		if (!descriptor?.enumerable || !("value" in descriptor)) invalid();
		result.push(descriptor.value);
	}
	return result;
}

function ascii(raw: unknown, maxLength: number, empty = false): string {
	if (typeof raw !== "string" || raw.length > maxLength || (!empty && raw.length === 0)) {
		invalid();
	}
	for (let at = 0; at < raw.length; at++) {
		const code = raw.charCodeAt(at);
		if (code < 33 || code > 126) invalid();
	}
	return raw;
}

function timestamp(raw: unknown): string {
	const value = ascii(raw, 256);
	if (!/^(?:0|[1-9][0-9]*)\.[0-9]{1,9}$/.test(value)) invalid();
	milliseconds(value);
	return value;
}

function milliseconds(ts: string): number {
	const dot = ts.indexOf(".");
	const nanoseconds =
		BigInt(ts.slice(0, dot)) * 1_000_000_000n + BigInt(ts.slice(dot + 1).padEnd(9, "0"));
	const value = nanoseconds / 1_000_000n;
	if (value > BigInt(Number.MAX_SAFE_INTEGER)) invalid();
	return Number(value);
}

function message(raw: unknown): WireMessage {
	const data = record(raw, MESSAGE_KEYS, UNSUPPORTED_MESSAGE_KEYS);
	if (data.type !== "message") invalid();
	const ts = timestamp(data.ts);
	const user = ascii(data.user, 256);
	if (
		typeof data.text !== "string" ||
		data.text.length > MAX_TEXT_UNITS ||
		!data.text.isWellFormed()
	) {
		invalid();
	}
	const threadTs = Object.hasOwn(data, "thread_ts") ? timestamp(data.thread_ts) : undefined;
	let replyCount: number | undefined;
	if (Object.hasOwn(data, "reply_count")) {
		if (
			typeof data.reply_count !== "number" ||
			!Number.isSafeInteger(data.reply_count) ||
			data.reply_count < 0
		) {
			invalid();
		}
		replyCount = data.reply_count;
	}
	return Object.assign(Object.create(null), {
		type: "message",
		ts,
		user,
		text: data.text,
		...(threadTs === undefined ? {} : { thread_ts: threadTs }),
		...(replyCount === undefined ? {} : { reply_count: replyCount }),
	}) as WireMessage;
}

function cursor(raw: unknown): string | undefined {
	const value = ascii(raw, 4_096, true);
	return value === "" ? undefined : value;
}

/**
 * Decode one ordinary history/replies page, without performing or authorizing a read.
 * Unsupported semantic records refuse the whole page; callers must not advance a cursor on error.
 */
export function reduceMessagesPage(channelId: unknown, input: unknown): SlackReadPage {
	try {
		const channelIdValue = ascii(channelId, 256);
		const page = record(input, PAGE_KEYS, ["error"]);
		if (page.ok !== true || typeof page.has_more !== "boolean") invalid();
		let nextCursor: string | undefined;
		if (Object.hasOwn(page, "response_metadata")) {
			const metadata = record(page.response_metadata, ["next_cursor"]);
			if (Object.hasOwn(metadata, "next_cursor")) nextCursor = cursor(metadata.next_cursor);
		}
		const rows: WireMessage[] = [];
		const ids = new Set<string>();
		for (const raw of messages(page.messages)) {
			const wire = message(raw);
			if (ids.has(wire.ts)) invalid();
			ids.add(wire.ts);
			rows.push(wire);
		}

		const changes: ChatMessageChange[] = [];
		const replyCounts: { readonly ts: string; readonly count: number }[] = [];
		for (const wire of rows) {
			const parsed = ChatMessageChange.safeParse({
				kind: "chat.message",
				channelId: channelIdValue,
				ts: wire.ts,
				sentAt: milliseconds(wire.ts),
				author: { kind: "user", id: wire.user },
				text: wire.text,
				...(wire.thread_ts === undefined ? {} : { threadTs: wire.thread_ts }),
			});
			if (!parsed.success) invalid();
			Object.freeze(parsed.data.author);
			changes.push(Object.freeze(parsed.data));
			if (wire.reply_count !== undefined) {
				replyCounts.push(Object.freeze({ ts: wire.ts, count: wire.reply_count }));
			}
		}
		return Object.freeze({
			changes: Object.freeze(changes),
			nextCursor,
			more: page.has_more || nextCursor !== undefined,
			replyCounts: Object.freeze(replyCounts),
		});
	} catch {
		invalid();
	}
}
