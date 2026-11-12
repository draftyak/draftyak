import { types } from "node:util";
import {
	ChatDraftContent,
	type DraftContent,
	EmailDraftContent,
} from "@draftyak/protocol/entities/draft";
import { type Flag, Flags } from "@draftyak/protocol/flags";

export type SecretPatternFlagsResult =
	| { status: "classified"; flags: readonly Flag[] }
	| { status: "refused"; code: "INVALID_INPUT" | "STRUCTURE_LIMIT" };

const WORD = /[\p{Letter}\p{Mark}\p{Number}_]/u;
const OTP_LABELS = [
	["otp"],
	["one-time", "code"],
	["one", "time", "code"],
	["one-time", "password"],
	["one", "time", "password"],
	["verification", "code"],
	["security", "code"],
	["authentication", "code"],
	["login", "code"],
	["sign-in", "code"],
	["sign", "in", "code"],
	["2fa", "code"],
] as const;
const PRIVATE_HEADERS = [
	"PRIVATE KEY",
	"ENCRYPTED PRIVATE KEY",
	"RSA PRIVATE KEY",
	"EC PRIVATE KEY",
	"DSA PRIVATE KEY",
	"OPENSSH PRIVATE KEY",
] as const;

const digit = (c: number): boolean => c >= 48 && c <= 57;
const letter = (c: number): boolean => (c >= 65 && c <= 90) || (c >= 97 && c <= 122);
const alnum = (c: number): boolean => letter(c) || digit(c);
const asciiWord = (c: number): boolean => alnum(c) || c === 95;
const wordHyphen = (c: number): boolean => asciiWord(c) || c === 45;
const wordSlash = (c: number): boolean => asciiWord(c) || c === 47;
const horizontal = (c: number): boolean => c === 32 || c === 9;

function wordAt(text: string, index: number): boolean {
	const value = text.codePointAt(index);
	return value !== undefined && WORD.test(String.fromCodePoint(value));
}

function wordBefore(text: string, index: number): boolean {
	if (index === 0) return false;
	const last = text.charCodeAt(index - 1);
	return wordAt(text, last >= 0xdc00 && last <= 0xdfff ? index - 2 : index - 1);
}

function asciiLabelAt(text: string, start: number, label: string): boolean {
	for (let offset = 0; offset < label.length; offset++) {
		let code = text.charCodeAt(start + offset);
		if (code >= 65 && code <= 90) code += 32;
		if (code !== label.charCodeAt(offset)) return false;
	}
	return true;
}

function spaces(text: string, start: number, maximum: number): number {
	let end = start;
	while (end - start < maximum && horizontal(text.charCodeAt(end))) end++;
	return end;
}

function otp(text: string): boolean {
	for (let start = 0; start < text.length; start++) {
		if (wordBefore(text, start)) continue;
		for (const words of OTP_LABELS) {
			let end = start;
			let matched = true;
			for (const [part, label] of words.entries()) {
				if (!asciiLabelAt(text, end, label)) {
					matched = false;
					break;
				}
				end += label.length;
				if (part + 1 < words.length) {
					const next = spaces(text, end, 3);
					if (next === end) {
						matched = false;
						break;
					}
					end = next;
				}
			}
			if (!matched || wordAt(text, end)) continue;
			end = spaces(text, end, 8);
			if (asciiLabelAt(text, end, "is")) {
				const next = spaces(text, end + 2, 8);
				if (next === end + 2) continue;
				end = next;
			}
			if (text[end] === ":" || text[end] === "=" || text[end] === "#" || text[end] === "-")
				end = spaces(text, end + 1, 8);
			if (wordBefore(text, end)) continue;
			let count = 0;
			while (count <= 10 && digit(text.charCodeAt(end + count))) count++;
			if (count >= 4 && count <= 10 && !wordAt(text, end + count)) return true;
		}
	}
	return false;
}

function minimumRun(
	text: string,
	start: number,
	minimum: number,
	accept: (code: number) => boolean,
): boolean {
	for (let offset = 0; offset < minimum; offset++)
		if (!accept(text.charCodeAt(start + offset))) return false;
	return true;
}

/** ASCII lexical shapes from the public guard; these do not verify a credential. */
function keyShape(text: string): boolean {
	for (let start = 0; start < text.length; start++) {
		if (text[start] === "-" && text[start - 1] !== "-") {
			for (const name of PRIVATE_HEADERS) {
				const header = `${"-".repeat(5)}BEGIN ${name}${"-".repeat(5)}`;
				if (text.startsWith(header, start) && text[start + header.length] !== "-") return true;
			}
		}
		if (asciiWord(text.charCodeAt(start - 1))) continue;
		if (text.startsWith("xox", start)) {
			let end = start + 3;
			if (text.charCodeAt(end) >= 97 && text.charCodeAt(end) <= 122) {
				end++;
				if (
					text.startsWith(".xox", end) &&
					text.charCodeAt(end + 4) >= 97 &&
					text.charCodeAt(end + 4) <= 122
				)
					end += 5;
				if (
					text[end] === "-" &&
					digit(text.charCodeAt(end + 1)) &&
					minimumRun(text, end + 2, 8, wordHyphen)
				)
					return true;
			}
		}
		if (
			text.startsWith("xapp-", start) &&
			digit(text.charCodeAt(start + 5)) &&
			text[start + 6] === "-" &&
			minimumRun(text, start + 7, 8, wordHyphen)
		)
			return true;
		if (text.startsWith("hooks.slack.com/", start)) {
			for (const route of ["services", "workflows", "triggers"]) {
				const prefix = `hooks.slack.com/${route}/T`;
				if (!text.startsWith(prefix, start)) continue;
				let end = start + prefix.length;
				const first = end;
				while (asciiWord(text.charCodeAt(end))) end++;
				if (end > first && text[end] === "/" && minimumRun(text, end + 1, 16, wordSlash))
					return true;
			}
		}
		if (text.startsWith("sk-ant-", start)) {
			let end = start + 7;
			const first = end;
			while (text.charCodeAt(end) >= 97 && text.charCodeAt(end) <= 122) end++;
			if (end > first) {
				while (digit(text.charCodeAt(end))) end++;
				if (text[end] === "-" && minimumRun(text, end + 1, 20, wordHyphen)) return true;
			}
		}
		for (const kind of ["proj", "svcacct", "admin"]) {
			const prefix = `sk-${kind}-`;
			if (text.startsWith(prefix, start) && minimumRun(text, start + prefix.length, 20, wordHyphen))
				return true;
		}
		if (
			text.startsWith("sk-", start) &&
			minimumRun(text, start + 3, 20, alnum) &&
			text.startsWith("T3BlbkFJ", start + 23) &&
			minimumRun(text, start + 31, 20, alnum) &&
			!asciiWord(text.charCodeAt(start + 51))
		)
			return true;
		if (
			text.startsWith("AIza", start) &&
			minimumRun(text, start + 4, 35, wordHyphen) &&
			!wordHyphen(text.charCodeAt(start + 39))
		)
			return true;
		if (text.startsWith("ya29.", start) && minimumRun(text, start + 5, 20, wordHyphen)) return true;
		if (text.startsWith("1//0", start) && minimumRun(text, start + 4, 20, wordHyphen)) return true;
	}
	return false;
}

function luhn(text: string): boolean {
	for (let start = 0; start < text.length; ) {
		if (!digit(text.charCodeAt(start))) {
			start++;
			continue;
		}
		let end = start;
		let count = 0;
		let even = 0;
		let odd = 0;
		for (;;) {
			while (digit(text.charCodeAt(end))) {
				const value = text.charCodeAt(end) - 48;
				const doubled = value > 4 ? value * 2 - 9 : value * 2;
				even = (even + (count % 2 === 0 ? doubled : value)) % 10;
				odd = (odd + (count % 2 === 1 ? doubled : value)) % 10;
				count++;
				end++;
			}
			if ((text[end] === " " || text[end] === "-") && digit(text.charCodeAt(end + 1))) end++;
			else break;
		}
		if (
			count >= 13 &&
			count <= 19 &&
			!wordBefore(text, start) &&
			!wordAt(text, end) &&
			(count % 2 === 0 ? even : odd) === 0
		)
			return true;
		// Consume the entire maximal token, including overlong runs: no valid prefix/suffix salvage.
		start = end;
	}
	return false;
}

function append97(remainder: number, code: number): number {
	if (digit(code)) return (remainder * 10 + code - 48) % 97;
	const upper = code >= 97 && code <= 122 ? code - 32 : code;
	return (remainder * 100 + upper - 55) % 97;
}

function rotatedRemainder(text: string, start: number, tail: number): number {
	let remainder = tail;
	for (let index = start; index < start + 4; index++)
		remainder = append97(remainder, text.charCodeAt(index));
	return remainder;
}

function groupedIban(text: string, start: number): boolean {
	let end = start + 5;
	let count = 4;
	let remainder = 0;
	while (count < 34) {
		let group = 0;
		while (group < 4 && alnum(text.charCodeAt(end))) {
			if (count === 34) return false;
			remainder = append97(remainder, text.charCodeAt(end));
			count++;
			group++;
			end++;
		}
		if (group === 0 || wordAt(text, end)) return false;
		if (count >= 15 && rotatedRemainder(text, start, remainder) === 1) return true;
		if (group !== 4 || text[end] !== " ") return false;
		end++;
	}
	return false;
}

function iban(text: string): boolean {
	for (let start = 0; start < text.length; ) {
		if (!letter(text.charCodeAt(start)) || wordBefore(text, start)) {
			start++;
			continue;
		}
		let end = start;
		while (end - start < 34 && alnum(text.charCodeAt(end))) end++;
		if (alnum(text.charCodeAt(end))) {
			// The next pass skips the rest by its word left neighbor, not a prefix match.
			start = end;
			continue;
		}
		const check = (text.charCodeAt(start + 2) - 48) * 10 + text.charCodeAt(start + 3) - 48;
		if (
			letter(text.charCodeAt(start + 1)) &&
			digit(text.charCodeAt(start + 2)) &&
			digit(text.charCodeAt(start + 3)) &&
			check >= 2 &&
			check <= 98
		) {
			const length = end - start;
			if (length >= 15 && length <= 34 && !wordAt(text, end)) {
				let remainder = 0;
				for (let index = start + 4; index < end; index++)
					remainder = append97(remainder, text.charCodeAt(index));
				if (rotatedRemainder(text, start, remainder) === 1) return true;
			}
			if (length === 4 && text[end] === " " && groupedIban(text, start)) return true;
		}
		start = end;
	}
	return false;
}

/** Supported warning shapes in supplied canonical body DATA; empty flags are not secret-free clearance. */
export function classifySecretPatternFlags(
	draft: Pick<DraftContent, "channel" | "body">,
): SecretPatternFlagsResult {
	try {
		if (!draft || typeof draft !== "object" || types.isProxy(draft) || Array.isArray(draft))
			return { status: "refused", code: "INVALID_INPUT" };
		const prototype = Object.getPrototypeOf(draft);
		if (prototype !== Object.prototype && prototype !== null)
			return { status: "refused", code: "INVALID_INPUT" };
		const channel = Object.getOwnPropertyDescriptor(draft, "channel");
		const body = Object.getOwnPropertyDescriptor(draft, "body");
		if (!channel || !body || !Object.hasOwn(channel, "value") || !Object.hasOwn(body, "value"))
			return { status: "refused", code: "INVALID_INPUT" };
		if ((channel.value !== "email" && channel.value !== "chat") || typeof body.value !== "string")
			return { status: "refused", code: "INVALID_INPUT" };
		const text: string = body.value;
		const maximum = channel.value === "email" ? 100_000 : 40_000;
		if (text.length > 2 * maximum) return { status: "refused", code: "STRUCTURE_LIMIT" };
		if (!text.isWellFormed()) return { status: "refused", code: "INVALID_INPUT" };
		let count = 0;
		for (let index = 0; index < text.length; ) {
			if (++count > maximum) return { status: "refused", code: "STRUCTURE_LIMIT" };
			const point = text.codePointAt(index);
			index += point !== undefined && point > 0xffff ? 2 : 1;
		}
		const schema =
			channel.value === "email" ? EmailDraftContent.shape.body : ChatDraftContent.shape.body;
		if (!schema.safeParse(text).success) return { status: "refused", code: "INVALID_INPUT" };
		const matched = otp(text) || keyShape(text) || luhn(text) || iban(text);
		return {
			status: "classified",
			flags: Flags.parse(matched ? [{ code: "SECRET_PATTERN", severity: "ack" }] : []),
		};
	} catch {
		return { status: "refused", code: "INVALID_INPUT" };
	}
}
