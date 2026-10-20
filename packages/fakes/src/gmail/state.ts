import { randomBytes } from "node:crypto";
import type { Clock } from "../faults.ts";
import {
	check,
	decimal,
	headers,
	id,
	labels,
	MAX_GMAIL_CURSORS,
	MAX_GMAIL_HISTORY,
	MAX_GMAIL_MESSAGES,
	MAX_GMAIL_RAW_BYTES,
	MAX_GMAIL_STATE_BYTES,
} from "./wire.ts";

export interface GmailMessageSeed {
	readonly id: string;
	readonly threadId?: string;
	readonly raw: Uint8Array;
	readonly labelIds?: readonly string[];
	readonly internalDate?: number;
}
export interface GmailMessage {
	readonly id: string;
	readonly threadId: string;
	readonly raw: Uint8Array;
	readonly labelIds: readonly string[];
	readonly internalDate: number;
	readonly historyId: string;
}
interface History {
	id: string;
	messages: unknown[];
	[key: string]: unknown;
}
interface Cursor {
	key: string;
	rows: readonly unknown[];
	offset: number;
	expiresAt: number;
	bytes: number;
	revision: string;
	nextPageToken?: string;
}
export interface GmailBudget {
	readonly units: number;
	readonly windowMs: number;
}
export class GmailState {
	readonly messages: Map<string, GmailMessage> = new Map();
	readonly history: History[] = [];
	readonly cursors: Map<string, Cursor> = new Map();
	sequence: bigint = 1000n;
	floor: bigint = 1000n;
	private bytes = 0;
	private cursorBytes = 0;
	private last = 0;
	private readonly usage = new Map<string, { start: number; used: number }>();
	readonly clock: Clock;
	constructor(clock: Clock) {
		this.clock = clock;
	}
	now(): number {
		const now = this.clock.now();
		check(Number.isSafeInteger(now) && now >= 0 && now < 253_402_300_800_000);
		if (now < this.last) {
			this.cursors.clear();
			this.cursorBytes = 0;
			this.usage.clear();
		}
		this.last = now;
		return now;
	}
	charge(kind: string, amount: number, budget?: GmailBudget): boolean {
		if (!budget) return true;
		const now = this.now();
		let entry = this.usage.get(kind);
		if (!entry || now - entry.start >= budget.windowMs) {
			entry = { start: now, used: 0 };
			this.usage.set(kind, entry);
		}
		if (amount > budget.units - entry.used) return false;
		entry.used += amount;
		return true;
	}
	private prepare(seed: GmailMessageSeed): Omit<GmailMessage, "historyId"> {
		id(seed.id);
		id(seed.threadId ?? seed.id);
		check(
			seed.raw instanceof Uint8Array &&
				seed.raw.byteLength > 0 &&
				seed.raw.byteLength <= MAX_GMAIL_RAW_BYTES,
		);
		headers(seed.raw);
		const internalDate = seed.internalDate ?? this.now();
		check(Number.isSafeInteger(internalDate) && internalDate >= 0);
		return {
			id: seed.id,
			threadId: seed.threadId ?? seed.id,
			raw: new Uint8Array(seed.raw),
			labelIds: labels(seed.labelIds ?? ["INBOX"]),
			internalDate,
		};
	}
	private event(message: GmailMessage, type: string, labelIds?: readonly string[]): void {
		const ref = { id: message.id, threadId: message.threadId, labelIds: [...message.labelIds] };
		this.history.push({
			id: message.historyId,
			messages: [ref],
			[type]: [{ message: ref, ...(labelIds ? { labelIds: [...labelIds] } : {}) }],
		});
		while (this.history.length > MAX_GMAIL_HISTORY)
			this.floor = BigInt((this.history.shift() as History).id);
	}
	add(seed: GmailMessageSeed): void {
		const prepared = this.prepare(seed);
		check(
			!this.messages.has(seed.id) &&
				this.messages.size < MAX_GMAIL_MESSAGES &&
				prepared.raw.byteLength <= MAX_GMAIL_STATE_BYTES - this.bytes,
		);
		check(this.sequence < 18_446_744_073_709_551_615n);
		const value = { ...prepared, historyId: String(++this.sequence) };
		this.messages.set(value.id, value);
		this.bytes += value.raw.byteLength;
		this.event(value, "messagesAdded");
	}
	get(key: string): GmailMessage {
		const value = this.messages.get(key);
		check(value);
		return value;
	}
	remove(key: string): void {
		const value = this.get(key);
		check(this.sequence < 18_446_744_073_709_551_615n);
		const removed = { ...value, historyId: String(++this.sequence) };
		this.messages.delete(key);
		this.bytes -= value.raw.byteLength;
		this.event(removed, "messagesDeleted");
	}
	setLabels(key: string, proposed: readonly string[]): void {
		const next = labels(proposed),
			old = this.get(key);
		const added = next.filter((x) => !old.labelIds.includes(x)),
			removed = old.labelIds.filter((x) => !next.includes(x));
		if (!added.length && !removed.length) return;
		check(this.sequence < 18_446_744_073_709_551_615n - 1n);
		if (added.length) {
			const value = { ...old, labelIds: next, historyId: String(++this.sequence) };
			this.messages.set(key, value);
			this.event(value, "labelsAdded", added);
		}
		if (removed.length) {
			const value = { ...old, labelIds: next, historyId: String(++this.sequence) };
			this.messages.set(key, value);
			this.event(value, "labelsRemoved", removed);
		}
	}
	expire(before: string): void {
		const value = decimal(before);
		check(value >= this.floor && value <= this.sequence);
		this.floor = value;
		while (this.history.length && BigInt((this.history[0] as History).id) <= value)
			this.history.shift();
	}
	page(
		key: string,
		token: string | null,
		rows: readonly unknown[],
		limit: number,
	): { rows: readonly unknown[]; total: number; revision: string; nextPageToken?: string } {
		const now = this.now();
		for (const [id, cursor] of this.cursors)
			if (cursor.expiresAt <= now) {
				this.cursors.delete(id);
				this.cursorBytes -= cursor.bytes;
			}
		let offset = 0,
			snapshot = rows,
			revision = String(this.sequence);
		let current: Cursor | undefined;
		if (token) {
			const cursor = this.cursors.get(token);
			check(cursor && cursor.key === key);
			current = cursor;
			offset = cursor.offset;
			snapshot = cursor.rows;
			revision = cursor.revision;
		}
		const result: {
			rows: readonly unknown[];
			total: number;
			revision: string;
			nextPageToken?: string;
		} = {
			rows: snapshot.slice(offset, offset + limit),
			total: snapshot.length,
			revision,
		};
		if (offset + limit < snapshot.length) {
			if (current?.nextPageToken) {
				result.nextPageToken = current.nextPageToken;
				return result;
			}
			const bytes = Buffer.byteLength(JSON.stringify(snapshot));
			check(this.cursors.size < MAX_GMAIL_CURSORS && bytes <= 4 * 1024 * 1024 - this.cursorBytes);
			const next = randomBytes(18).toString("base64url");
			this.cursors.set(next, {
				key,
				rows: structuredClone(snapshot),
				offset: offset + limit,
				expiresAt: now + 60_000,
				bytes,
				revision,
			});
			this.cursorBytes += bytes;
			if (current) current.nextPageToken = next;
			result.nextPageToken = next;
		}
		return result;
	}
}

export function messageView(
	message: GmailMessage,
	format: string,
	selected: readonly string[],
): Record<string, unknown> {
	const base: Record<string, unknown> = {
		id: message.id,
		threadId: message.threadId,
		labelIds: [...message.labelIds],
		historyId: message.historyId,
		internalDate: String(message.internalDate),
		sizeEstimate: message.raw.byteLength,
	};
	if (format === "raw") base.raw = Buffer.from(message.raw).toString("base64url");
	else if (format !== "minimal") {
		const parsed = headers(message.raw),
			wanted = selected.map((x) => x.toLowerCase());
		const values = parsed.entries.filter(
			(h) => !wanted.length || wanted.includes(h.name.toLowerCase()),
		);
		base.payload =
			format === "metadata"
				? { headers: values }
				: {
						mimeType:
							parsed.entries
								.find((h) => h.name.toLowerCase() === "content-type")
								?.value.split(";")[0]
								?.trim() ?? "text/plain",
						headers: parsed.entries,
						body: {
							size: parsed.body.byteLength,
							data: Buffer.from(parsed.body).toString("base64url"),
						},
					};
		if (format === "full")
			check(
				!String((base.payload as Record<string, unknown>).mimeType)
					.toLowerCase()
					.startsWith("multipart/"),
			);
	}
	return base;
}
export function matches(message: GmailMessage, params: URLSearchParams): boolean {
	if (params.getAll("labelIds").some((label) => !message.labelIds.includes(label))) return false;
	if (
		params.get("includeSpamTrash") !== "true" &&
		message.labelIds.some((x) => x === "SPAM" || x === "TRASH")
	)
		return false;
	const terms = (params.get("q") ?? "").trim().split(/\s+/).filter(Boolean);
	for (const term of terms) {
		const colon = term.indexOf(":"),
			name = term.slice(0, colon),
			value = term.slice(colon + 1);
		check(colon > 0 && value.length);
		if (name === "in") {
			check(["sent", "inbox", "scheduled"].includes(value));
			if (!message.labelIds.includes(value.toUpperCase())) return false;
		} else if (name === "is") {
			check(value === "unread");
			if (!message.labelIds.includes("UNREAD")) return false;
		} else if (name === "after") {
			check(/^[0-9]{1,12}$/.test(value));
			if (message.internalDate <= Number(value) * 1000) return false;
		} else if (name === "rfc822msgid") {
			const actual = headers(message.raw).entries.find(
				(h) => h.name.toLowerCase() === "message-id",
			)?.value;
			if (actual?.replace(/^<|>$/g, "") !== value.replace(/^<|>$/g, "")) return false;
		} else check(false);
	}
	return true;
}
export function validateSearch(params: URLSearchParams): void {
	for (const term of (params.get("q") ?? "").trim().split(/\s+/).filter(Boolean)) {
		const colon = term.indexOf(":"),
			name = term.slice(0, colon),
			value = term.slice(colon + 1);
		check(colon > 0 && value.length);
		check(
			(name === "in" && ["sent", "inbox", "scheduled"].includes(value)) ||
				(name === "is" && value === "unread") ||
				(name === "after" && /^[0-9]{1,12}$/.test(value)) ||
				(name === "rfc822msgid" && /^[^\s<>]+@[^\s<>]+$/.test(value.replace(/^<|>$/g, ""))),
		);
	}
}
