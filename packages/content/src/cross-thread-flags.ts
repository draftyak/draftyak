import { types } from "node:util";
import {
	DmarcResult,
	EmailAddress,
	MAX_EMAIL_LIST_ITEMS,
	MessageDirection,
} from "@draftyak/protocol/entities/common";
import { Draft, DraftContent } from "@draftyak/protocol/entities/draft";
import { type Flag, Flags } from "@draftyak/protocol/flags";
import { Ulid } from "@draftyak/protocol/scalars";
import type { HygieneResult } from "./hygiene.ts";
import { MAX_TEXT_BYTES, MAX_TEXT_CHARS } from "./limits.ts";
import { normalizeAddress } from "./mail-parser.ts";
import { MAX_THREAD_MESSAGES, type ThreadMessage } from "./prompt.ts";

/** Refusals contain no matched text, source identifiers or caller-selected diagnostics. */
export class CrossThreadFlagsError extends Error {
	readonly code = "CROSS_THREAD_FLAGS_REFUSED";
	constructor() {
		super("Cross-thread flags refused");
		this.name = "CrossThreadFlagsError";
	}
}

const refuse = (): never => {
	throw new CrossThreadFlagsError();
};
type DataRecord = Record<string, unknown>;

/** Copy data descriptors before schemas see them; never invoke input getters or iterators. */
class Capture {
	#bytes = 0;
	record(
		value: unknown,
		required: readonly string[],
		optional: readonly string[] = [],
	): DataRecord {
		if (!value || typeof value !== "object" || types.isProxy(value)) return refuse();
		const prototype = Object.getPrototypeOf(value);
		if (prototype !== Object.prototype && prototype !== null) return refuse();
		const keys = Reflect.ownKeys(value);
		if (keys.length > required.length + optional.length) return refuse();
		const result: DataRecord = Object.create(null);
		for (const key of keys) {
			if (typeof key !== "string" || (!required.includes(key) && !optional.includes(key)))
				return refuse();
			const descriptor = Object.getOwnPropertyDescriptor(value, key);
			if (!descriptor || !("value" in descriptor)) return refuse();
			result[key] = descriptor.value;
		}
		for (const key of required) if (!Object.hasOwn(result, key)) return refuse();
		return result;
	}
	list(value: unknown, maximum: number): unknown[] {
		if (!value || typeof value !== "object" || types.isProxy(value) || !Array.isArray(value))
			return refuse();
		if (Object.getPrototypeOf(value) !== Array.prototype) return refuse();
		const length = Object.getOwnPropertyDescriptor(value, "length")?.value;
		if (!Number.isSafeInteger(length) || length < 0 || length > maximum) return refuse();
		if (Reflect.ownKeys(value).length !== length + 1) return refuse();
		const result: unknown[] = [];
		for (let index = 0; index < length; index++) {
			const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
			if (!descriptor || !("value" in descriptor)) return refuse();
			result.push(descriptor.value);
		}
		return result;
	}
	scalar(value: unknown): string | number | boolean | null | undefined {
		if (typeof value === "string") {
			// UTF-8 cannot use fewer bytes than this well-formed string's UTF-16 units.
			if (value.length > MAX_TEXT_BYTES - this.#bytes || !value.isWellFormed()) return refuse();
			this.#bytes += Buffer.byteLength(value, "utf8");
			if (this.#bytes > MAX_TEXT_BYTES) return refuse();
			return value;
		}
		if (typeof value === "number" && Number.isFinite(value)) return value;
		if (value === null || value === undefined || typeof value === "boolean") return value;
		return refuse();
	}
	scalars(value: unknown, required: readonly string[]): DataRecord {
		const record = this.record(value, required);
		for (const key of required) record[key] = this.scalar(record[key]);
		return record;
	}
}

const DRAFT_FIELDS = [
	"id",
	"accountId",
	"conversationId",
	"rev",
	"state",
	"createdAt",
	"updatedAt",
];
const EMAIL_FIELDS = ["channel", "to", "cc", "bcc", "subject", "body", "attachments"];
const CHAT_FIELDS = ["channel", "threadTs", "broadcast", "body"];
const REMOVALS = ["hidden", "invisible", "quoted", "truncated", "uris"] as const;

function content(capture: Capture, value: unknown): DraftContent {
	const record = capture.record(
		value,
		["channel"],
		["to", "cc", "bcc", "subject", "body", "attachments", "threadTs", "broadcast"],
	);
	const channel = capture.scalar(record.channel);
	if (channel === "email") {
		for (const key of Object.keys(record)) if (!EMAIL_FIELDS.includes(key)) return refuse();
		return DraftContent.parse({
			channel,
			to: capture.list(record.to, MAX_EMAIL_LIST_ITEMS).map((item) => capture.scalar(item)),
			cc: capture.list(record.cc, MAX_EMAIL_LIST_ITEMS).map((item) => capture.scalar(item)),
			bcc: capture.list(record.bcc, MAX_EMAIL_LIST_ITEMS).map((item) => capture.scalar(item)),
			subject: capture.scalar(record.subject),
			body: capture.scalar(record.body),
			attachments: capture
				.list(record.attachments, MAX_EMAIL_LIST_ITEMS)
				.map((item) =>
					capture.scalars(item, ["blobId", "filename", "contentType", "size", "sha256"]),
				),
		});
	}
	if (channel !== "chat") return refuse();
	for (const key of Object.keys(record)) if (!CHAT_FIELDS.includes(key)) return refuse();
	return DraftContent.parse({
		channel,
		threadTs: capture.scalar(record.threadTs),
		broadcast: capture.scalar(record.broadcast),
		body: capture.scalar(record.body),
	});
}

function hygiene(capture: Capture, value: unknown): HygieneResult {
	const record = capture.record(value, ["text", "removals", "links", "suspectedInstructions"]);
	const text = capture.scalar(record.text);
	if (
		typeof text !== "string" ||
		text.length > MAX_TEXT_CHARS ||
		text.includes("\r") ||
		text.normalize("NFC") !== text
	)
		return refuse();
	const counts = capture.scalars(record.removals, REMOVALS);
	for (const key of REMOVALS) {
		const count = counts[key];
		if (
			typeof count !== "number" ||
			!Number.isSafeInteger(count) ||
			count < 0 ||
			count > MAX_TEXT_BYTES
		)
			return refuse();
	}
	if (counts.truncated !== 0) return refuse();
	const markers = new Map<number, string>(),
		hosts = new Set<string>();
	const links = capture.list(record.links, 512).map((value) => {
		const link = capture.scalars(value, ["index", "host"]),
			index = link.index,
			host = link.host;
		if (
			typeof index !== "number" ||
			!Number.isSafeInteger(index) ||
			index < 1 ||
			index > 512 ||
			markers.has(index) ||
			typeof host !== "string" ||
			!host ||
			host.length > MAX_TEXT_CHARS ||
			!/^[\x21-\x7e]+$/.test(host) ||
			hosts.has(host)
		)
			return refuse();
		const url = new URL(`https://${host}`);
		if (
			url.hostname !== host ||
			url.port ||
			url.username ||
			url.password ||
			url.pathname !== "/" ||
			url.search ||
			url.hash
		)
			return refuse();
		markers.set(index, `[link ${index}: ${host}]`);
		hosts.add(host);
		return { index, host };
	});
	const used = new Set<number>();
	for (const match of text.matchAll(/\[link (?=\d)/g)) {
		const index = Number(
			/^\[link ([1-9]\d{0,2}): /.exec(text.slice(match.index, match.index + 16))?.[1],
		);
		const marker = markers.get(index);
		if (!marker || !text.startsWith(marker, match.index)) return refuse();
		used.add(index);
	}
	if (used.size !== markers.size) return refuse();
	const suspectedInstructions = capture.scalar(record.suspectedInstructions);
	if (typeof suspectedInstructions !== "boolean") return refuse();
	return {
		text,
		removals: {
			hidden: counts.hidden as number,
			invisible: counts.invisible as number,
			quoted: counts.quoted as number,
			truncated: 0,
			uris: counts.uris as number,
		},
		links,
		suspectedInstructions,
	};
}

function message(capture: Capture, value: unknown): ThreadMessage {
	const record = capture.record(
		value,
		["id", "conversationId", "body", "direction", "dmarc"],
		["subject", "sender"],
	);
	const id = Ulid.parse(capture.scalar(record.id)),
		conversationId = Ulid.parse(capture.scalar(record.conversationId));
	const direction = MessageDirection.parse(capture.scalar(record.direction)),
		dmarc = DmarcResult.parse(capture.scalar(record.dmarc));
	const metadata: { subject?: string; sender?: string } = {};
	for (const key of ["subject", "sender"] as const) {
		if (!Object.hasOwn(record, key)) continue;
		const value = capture.scalar(record[key]);
		if (
			value !== undefined &&
			(typeof value !== "string" || Buffer.byteLength(value, "utf8") > 4096)
		)
			return refuse();
		if (typeof value === "string") metadata[key] = value;
	}
	return { id, conversationId, body: hygiene(capture, record.body), direction, dmarc, ...metadata };
}

function tokens(text: string): Set<string> {
	const result = new Set<string>();
	// Whole spans only: do not recover a valid suffix from a malformed larger mailbox-like span.
	for (const [candidate] of text.matchAll(/[^\s<>()",;:\[\]]+/gu)) {
		// One final period may be prose punctuation only when the entire preceding span is valid.
		const literal = candidate.endsWith(".") ? candidate.slice(0, -1) : candidate;
		if (!literal.includes("@") || literal.length > 254) continue;
		const normalized = normalizeAddress(literal);
		if (
			EmailAddress.safeParse(literal).success ||
			(normalized && EmailAddress.safeParse(normalized).success)
		)
			result.add(literal);
	}
	// Decimal_Number runs are maximal in their original script; NFC is not NFKC or digit folding.
	for (const [candidate] of text.matchAll(/\p{Decimal_Number}+/gu))
		if (Array.from(candidate).length >= 6) result.add(candidate);
	return result;
}

/**
 * Literal email/number overlap in supplied canonical DATA only. This does not establish a complete
 * search corpus, source-account/provenance/currentness, or full-URL equality from host-only hygiene.
 */
export function classifySuppliedCrossThreadEmailAndNumberFlags(
	draft: Draft,
	draftContent: DraftContent,
	messages: readonly ThreadMessage[],
): Flag[] {
	try {
		const capture = new Capture();
		const checkedDraft = Draft.parse(capture.scalars(draft, DRAFT_FIELDS));
		const checkedContent = content(capture, draftContent);
		if (checkedContent.channel === "chat" && checkedDraft.conversationId === null) return refuse();
		const seen = new Set<string>();
		const checkedMessages = capture.list(messages, MAX_THREAD_MESSAGES).map((value) => {
			const checked = message(capture, value);
			if (seen.has(checked.id)) return refuse();
			seen.add(checked.id);
			return checked;
		});
		const candidates = tokens(checkedContent.body);
		let matched = false;
		for (const source of checkedMessages) {
			if (source.conversationId === checkedDraft.conversationId) continue;
			for (const candidate of tokens(source.body.text))
				if (candidates.has(candidate)) matched = true;
		}
		return Flags.parse(matched ? [{ code: "CROSS_THREAD_DATA", severity: "ack" }] : []);
	} catch {
		throw new CrossThreadFlagsError();
	}
}
