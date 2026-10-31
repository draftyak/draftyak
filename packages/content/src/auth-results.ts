import type { DmarcResult } from "@draftyak/protocol/entities/common";

export interface MailHeader {
	readonly key: string;
	readonly value: string;
}

export type MailAuthReason =
	| "verified"
	| "unsupported-provider"
	| "ambiguous-from"
	| "missing-results"
	| "untrusted-authserv"
	| "invalid-results"
	| "dmarc-fail"
	| "no-dmarc-pass"
	| "unaligned-from";

export interface MailAuth {
	readonly dmarc: DmarcResult;
	readonly verifiedSender?: string;
	readonly reason: MailAuthReason;
}

// Comments and quoted text can contain forged method names and separators. Keep neither as
// syntax; quoted property values are retained only for the strict property reader below.
function withoutComments(value: string): string | undefined {
	let depth = 0;
	let quoted = false;
	let escaped = false;
	let result = "";
	for (const character of value) {
		if (escaped) {
			if (!depth) result += character;
			escaped = false;
			continue;
		}
		if (character === "\\" && (depth || quoted)) {
			if (!depth) result += character;
			escaped = true;
			continue;
		}
		if (character === '"' && !depth) quoted = !quoted;
		if (!quoted && character === "(") {
			if (++depth > 8) return undefined;
			if (depth === 1) result += " ";
		} else if (!quoted && character === ")") {
			if (!depth) return undefined;
			depth--;
		} else if (!depth) result += character;
	}
	return depth || quoted || escaped ? undefined : result;
}

function methods(value: string): string[] | undefined {
	let quoted = false;
	let escaped = false;
	let part = "";
	const parts: string[] = [];
	for (const character of value) {
		if (escaped) escaped = false;
		else if (character === "\\" && quoted) escaped = true;
		else if (character === '"') quoted = !quoted;
		else if (character === ";" && !quoted) {
			parts.push(part.trim());
			part = "";
			continue;
		}
		part += character;
	}
	parts.push(part.trim());
	return quoted || escaped ? undefined : parts;
}

// RFC 8601 section 2.2 permits leading CFWS and a quoted authserv-id. Read only
// that prefix: malformed result text must not hide an already selected provider.
function authserv(value: string): { id: string; end: number } | undefined {
	let position = 0;
	while (position < value.length) {
		if (/[ \t\r\n]/.test(value[position] ?? "")) {
			position++;
			continue;
		}
		if (value[position] !== "(") break;
		let depth = 1;
		position++;
		while (position < value.length && depth) {
			const character = value[position++];
			if (character === "\\") {
				if (position === value.length) return undefined;
				position++;
			} else if (character === "(") {
				if (++depth > 8) return undefined;
			} else if (character === ")") depth--;
		}
		if (depth) return undefined;
	}
	if (value[position] === '"') {
		let id = "";
		position++;
		while (position < value.length) {
			const character = value[position++];
			if (character === '"') return { id, end: position };
			if (character === "\\") {
				if (position === value.length) return undefined;
				id += value[position++];
			} else id += character;
		}
		return undefined;
	}
	const token = /^[!#$%&'*+\-.0-9A-Z^_`a-z{|}~]+/.exec(value.slice(position))?.[0];
	return token ? { id: token, end: position + token.length } : undefined;
}

/** Headers are in wire order. Never search below the topmost matching provider result. */
export function verifyMailAuth(
	headers: readonly MailHeader[],
	provider: "gmail" | "generic",
	singleFrom: string | undefined,
): MailAuth {
	const unknown = (reason: MailAuthReason): MailAuth => ({ dmarc: "none", reason });
	if (provider !== "gmail") return unknown("unsupported-provider");
	if (!singleFrom) return unknown("ambiguous-from");
	const candidates = headers.filter(({ key }) => key === "authentication-results");
	if (!candidates.length) return unknown("missing-results");
	let selected: { header: MailHeader; service: { id: string; end: number } } | undefined;
	for (const header of candidates) {
		const service = authserv(header.value);
		// An unreadable prefix may conceal the provider; it cannot justify a lower pass.
		if (!service) return unknown("invalid-results");
		if (service.id.toLowerCase() === "mx.google.com") {
			selected = { header, service };
			break;
		}
	}
	if (!selected?.service) return unknown("untrusted-authserv");
	const suffix = selected.header.value.slice(selected.service.end);
	if (suffix && !/^[ \t\r\n(;]/.test(suffix)) return unknown("invalid-results");
	const uncommented = withoutComments(suffix);
	const parts = uncommented === undefined ? undefined : methods(uncommented);
	if (!parts || parts.length < 2) return unknown("invalid-results");
	if (!/^(?:[0-9]+)?$/.test(parts[0] ?? "")) return unknown("invalid-results");
	const dmarc = parts.slice(1).filter((part) => /^dmarc(?:\/[0-9]+)?\s*=/i.test(part));
	if (dmarc.length !== 1) return unknown("invalid-results");
	const part = dmarc[0] ?? "";
	const result = /^dmarc(?:\/[0-9]+)?\s*=\s*([a-z]+)(?=\s|$)/i.exec(part);
	if (!result) return unknown("invalid-results");
	const domains: string[] = [];
	const property = /\s+([a-z0-9_.-]+)\s*=\s*("(?:[^"\\]|\\.)*"|[^\s"]+)(?=\s|$)/giy;
	let position = result[0].length;
	while (position < part.length) {
		property.lastIndex = position;
		const match = property.exec(part);
		if (!match) return unknown("invalid-results");
		position = property.lastIndex;
		if (match[1]?.toLowerCase() === "header.from") {
			const value = match[2] ?? "";
			domains.push(value.startsWith('"') ? value.slice(1, -1) : value);
		}
	}
	if (result[1]?.toLowerCase() === "fail") return { dmarc: "fail", reason: "dmarc-fail" };
	if (result[1]?.toLowerCase() !== "pass") return unknown("no-dmarc-pass");
	if (domains.length !== 1) return unknown("invalid-results");
	const domain = domains[0]?.toLowerCase();
	if (domain !== singleFrom.slice(singleFrom.lastIndexOf("@") + 1)) {
		return unknown("unaligned-from");
	}
	return { dmarc: "pass", verifiedSender: singleFrom, reason: "verified" };
}
