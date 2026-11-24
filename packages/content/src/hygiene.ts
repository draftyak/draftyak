import { boundedText, ContentError, MAX_TEXT_CHARS } from "./limits.ts";

export interface HygieneOptions {
	maxChars?: number;
	quotedHistoryChars?: number;
}

export interface HygieneResult {
	text: string;
	removals: { hidden: number; invisible: number; quoted: number; truncated: number; uris: number };
	links: readonly { index: number; host: string }[];
	suspectedInstructions: boolean;
}

// Preserve ordinary tabs/newlines, but remove formatting, direction and invisible payloads.
const INVISIBLE =
	// biome-ignore lint/suspicious/noControlCharactersInRegex: Removing controls is the security boundary.
	/[\p{Default_Ignorable_Code_Point}\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/gu;
const INSTRUCTIONS =
	/(?:ignore|disregard|override)\s+(?:(?:all|any|the)\s+)?(?:(?:previous|prior|above|system|developer)\s+)?instructions|system\s+prompt|(?:reveal|print|exfiltrate)\s+(?:the\s+)?(?:secret|token|password)|<\/?(?:system|developer)>/i;

export function instructionLike(text: string): boolean {
	return INSTRUCTIONS.test(text.replace(INVISIBLE, "").normalize("NFC"));
}

export function sourceText(text: string): string {
	// Reserve internal placeholders before decoding/normalizing source into annotations.
	return text.replace(/[\uE000\uE001]/g, "�");
}

export function hygieneLimits(options: HygieneOptions): {
	maxChars: number;
	quotedHistoryChars: number;
} {
	if (!options || typeof options !== "object" || Array.isArray(options))
		throw new ContentError("INVALID_INPUT");
	const maxChars = options.maxChars ?? MAX_TEXT_CHARS;
	const quotedHistoryChars = options.quotedHistoryChars ?? 4_000;
	if (
		!Number.isInteger(maxChars) ||
		maxChars < 1 ||
		maxChars > MAX_TEXT_CHARS ||
		!Number.isInteger(quotedHistoryChars) ||
		quotedHistoryChars < 0 ||
		quotedHistoryChars > MAX_TEXT_CHARS
	)
		throw new ContentError("INVALID_INPUT");
	return { maxChars, quotedHistoryChars };
}

/** A fitting prefix never splits a scalar or a generated link annotation. */
export function hygienePrefix(
	text: string,
	maximum: number,
	links: HygieneResult["links"],
): string {
	let length = Math.min(maximum, text.length);
	if (length === text.length) return text;
	if (length > 0 && /[\uD800-\uDBFF]/.test(text[length - 1] ?? "")) length--;
	const start = text.lastIndexOf("[link ", length - 1);
	if (start >= 0) {
		const index = /^\[link ([1-9]\d{0,2}): /.exec(text.slice(start, start + 16))?.[1];
		const link = links.find((item) => item.index === Number(index));
		if (link) {
			const marker = `[link ${link.index}: ${link.host}]`;
			if (text.startsWith(marker, start) && start + marker.length > length) length = start;
		}
	}
	return text.slice(0, length);
}

export function linkMarker(value: string, links: { index: number; host: string }[]): string {
	try {
		const url = new URL(value.replace(INVISIBLE, "").trim());
		if (url.protocol !== "http:" && url.protocol !== "https:") return "";
		const host = url.hostname;
		if (!host || !/^[\x21-\x7e]+$/.test(host)) return "";
		const prior = links.find((link) => link.host === host);
		const index = prior?.index ?? links.length + 1;
		if (!prior && links.length >= 512) throw new ContentError("STRUCTURE_LIMIT");
		if (!prior) links.push({ index, host });
		return `\uE000${index}\uE001`;
	} catch (error) {
		if (error instanceof ContentError) throw error;
		return "";
	}
}

/** Removal counts use UTF-16 units, as does the output bound; surrogate pairs stay intact. */
export function finishHygiene(
	input: string,
	options: HygieneOptions,
	initial: {
		hidden: number;
		suspectedInstructions: boolean;
		links: { index: number; host: string }[];
	},
): HygieneResult {
	const { maxChars, quotedHistoryChars } = hygieneLimits(options);
	const removals = { hidden: initial.hidden, invisible: 0, quoted: 0, truncated: 0, uris: 0 };
	let text = input
		.replace(INVISIBLE, (match) => {
			removals.invisible += match.length;
			return "";
		})
		.normalize("NFC")
		.replace(/\r\n?|\u2028|\u2029/g, "\n");
	const suspectedInstructions = initial.suspectedInstructions || instructionLike(text);
	text = text
		.replace(/\[link (?=\d)/g, "[source link ")
		.replace(
			/\b(?:https?:(?=[^\s<>"'])|(?:javascript|vbscript):(?=[^\s<>"'])|file:(?=\/)|data:(?=(?:[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+|,)))[^\s<>"']*/gi,
			(value) => {
				// Match the outer token once so nested HTTP text cannot shrink a removed URI's count.
				if (!/^https?:/i.test(value)) {
					removals.uris += value.length;
					return "";
				}
				let tail = value.match(/[),.;!?\]}]+$/)?.[0] ?? "";
				// The first trailing ] may close a bare IPv6 authority, rather than prose.
				const authority = value.slice(0, value.length - tail.length + 1);
				if (tail.startsWith("]") && /^https?:\/\/(?:[^/?#]*@)?\[[^\]]+\]$/i.test(authority))
					tail = tail.slice(1);
				return linkMarker(value.slice(0, value.length - tail.length), initial.links) + tail;
			},
		)
		.replace(/\uE000(\d+)\uE001/g, (_token, index: string) => {
			const link = initial.links[Number(index) - 1];
			return link ? `[link ${link.index}: ${link.host}]` : "";
		});
	let remaining = quotedHistoryChars;
	let quotedTail = false;
	text = text
		.split("\n")
		.flatMap((line) => {
			let trimmed = line.replace(/[^\S\n]+/g, " ").trim();
			if (/^(?:On .{1,200}wrote:\s*$|-{2,}\s*Original Message\s*-*)/i.test(trimmed))
				quotedTail = true;
			if (quotedTail && !trimmed.startsWith(">")) trimmed = `> ${trimmed}`;
			if (!/^>/.test(trimmed)) return [trimmed];
			const kept = hygienePrefix(trimmed, remaining, initial.links);
			remaining -= kept.length;
			removals.quoted += trimmed.length - kept.length;
			return kept ? [kept] : [];
		})
		.join("\n")
		.replace(/\n{3,}/g, "\n\n")
		.trim();
	const kept = hygienePrefix(text, maxChars, initial.links);
	removals.truncated = text.length - kept.length;
	text = kept.trimEnd();
	// A reference table must never reveal links from discarded history or truncated output.
	const visible = new Set(
		Array.from(text.matchAll(/\[link (\d+): [^\]\n]+\]/g), (match) => Number(match[1])),
	);
	return {
		text,
		removals,
		links: initial.links.filter((link) => visible.has(link.index)),
		suspectedInstructions,
	};
}

export function cleanText(input: string, options: HygieneOptions = {}): HygieneResult {
	boundedText(input);
	return finishHygiene(sourceText(input), options, {
		hidden: 0,
		suspectedInstructions: false,
		links: [],
	});
}
