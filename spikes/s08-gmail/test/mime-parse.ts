// A small RFC 5322 / MIME reader for the fake Gmail, written apart from src/ so the fake never
// agrees with the code under test by sharing its bugs.

export interface ParsedHeader {
	readonly name: string;
	readonly value: string;
}

export interface ParsedPart {
	readonly headers: readonly ParsedHeader[];
	readonly mimeType: string;
	readonly params: Readonly<Record<string, string>>;
	readonly filename: string;
	readonly body: Buffer;
	readonly parts: readonly ParsedPart[];
}

export function getHeader(
	part: { headers: readonly ParsedHeader[] },
	name: string,
): string | undefined {
	return part.headers.find((header) => header.name.toLowerCase() === name.toLowerCase())?.value;
}

function splitHead(raw: Buffer): { head: string; body: Buffer } {
	const at = raw.indexOf("\r\n\r\n");
	if (at === -1) return { head: raw.toString("latin1"), body: Buffer.alloc(0) };
	return { head: raw.subarray(0, at).toString("latin1"), body: raw.subarray(at + 4) };
}

export function parseHeaders(head: string): ParsedHeader[] {
	const unfolded = head.replace(/\r\n(?=[ \t])/g, "");
	return unfolded
		.split("\r\n")
		.filter((line) => line.includes(":"))
		.map((line) => {
			const at = line.indexOf(":");
			return { name: line.slice(0, at).trim(), value: line.slice(at + 1).trim() };
		});
}

function rfc2231(value: string): string {
	const match = /^([^']*)'[^']*'(.*)$/.exec(value);
	if (match === null) return value;
	const bytes = Buffer.from(
		(match[2] ?? "").replace(/%([0-9a-f]{2})/gi, (_, hex: string) =>
			String.fromCharCode(Number.parseInt(hex, 16)),
		),
		"latin1",
	);
	return new TextDecoder(match[1] || "utf-8").decode(bytes);
}

// type/subtype; name=value; name="quoted"; name*0*=charset''pct%20encoded; ...
export function parseParams(value: string): { type: string; params: Record<string, string> } {
	const [type = "", ...rest] = value.split(";");
	const params: Record<string, string> = {};
	const continued: Record<string, string[]> = {};
	for (const item of rest) {
		const at = item.indexOf("=");
		if (at === -1) continue;
		const key = item.slice(0, at).trim().toLowerCase();
		const text = item
			.slice(at + 1)
			.trim()
			.replace(/^"(.*)"$/s, "$1")
			.replace(/\\(.)/g, "$1");
		const section = /^(.+?)\*(\d+)\*?$/.exec(key);
		if (section) {
			const sections = continued[section[1] ?? ""] ?? [];
			sections[Number(section[2])] = text;
			continued[section[1] ?? ""] = sections;
		} else if (key.endsWith("*")) params[key.slice(0, -1)] = rfc2231(text);
		else params[key] = text;
	}
	for (const [key, sections] of Object.entries(continued)) params[key] = rfc2231(sections.join(""));
	return { type: type.trim().toLowerCase(), params };
}

function quotedPrintable(body: Buffer): Buffer {
	const text = body.toString("latin1").replace(/=\r\n/g, "");
	return Buffer.from(
		text.replace(/=([0-9A-F]{2})/gi, (_, hex: string) =>
			String.fromCharCode(Number.parseInt(hex, 16)),
		),
		"latin1",
	);
}

function decodeBody(body: Buffer, encoding: string): Buffer {
	if (encoding === "base64")
		return Buffer.from(body.toString("latin1").replace(/\s+/g, ""), "base64");
	if (encoding === "quoted-printable") return quotedPrintable(body);
	return body;
}

export function parseMessage(raw: Buffer): ParsedPart {
	const { head, body } = splitHead(raw);
	const headers = parseHeaders(head);
	const { type, params } = parseParams(getHeader({ headers }, "Content-Type") ?? "text/plain");
	const disposition = parseParams(getHeader({ headers }, "Content-Disposition") ?? "");
	const filename = disposition.params.filename ?? params.name ?? "";
	if (type.startsWith("multipart/") && params.boundary) {
		const delimiter = `--${params.boundary}`;
		const text = body.toString("latin1");
		const pieces = text.split(
			new RegExp(`(?:^|\\r\\n)${delimiter.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`),
		);
		const parts = pieces
			.slice(1)
			.filter((piece) => !piece.startsWith("--"))
			.map((piece) => parseMessage(Buffer.from(piece.replace(/^[ \t]*\r\n/, ""), "latin1")));
		return { headers, mimeType: type, params, filename, body: Buffer.alloc(0), parts };
	}
	const encoding = (getHeader({ headers }, "Content-Transfer-Encoding") ?? "7bit").toLowerCase();
	const decoded = decodeBody(body, encoding);
	return { headers, mimeType: type, params, filename, body: decoded, parts: [] };
}

// RFC 2047 encoded words, as Gmail shows header values (its own reading, not src/mime.ts's).
export function decodeHeader(value: string): string {
	const word = /=\?([^?]+)\?([bq])\?([^?]*)\?=/gi;
	const joined = value.replace(/(\?=)\s+(?==\?)/g, "$1");
	const chunks: { charset: string; bytes: Buffer }[] = [];
	let out = "";
	let last = 0;
	const flush = (): void => {
		let group: Buffer[] = [];
		let charset = "";
		for (const chunk of [...chunks, { charset: "", bytes: Buffer.alloc(0) }]) {
			if (chunk.charset !== charset && group.length > 0) {
				out += new TextDecoder(charset).decode(Buffer.concat(group));
				group = [];
			}
			charset = chunk.charset;
			group.push(chunk.bytes);
		}
		chunks.length = 0;
	};
	for (const match of joined.matchAll(word)) {
		if (match.index > last) {
			flush();
			out += joined.slice(last, match.index);
		}
		const [, charset = "utf-8", kind = "q", text = ""] = match;
		const bytes =
			kind.toLowerCase() === "b"
				? Buffer.from(text, "base64")
				: quotedPrintable(Buffer.from(text.replace(/_/g, " "), "latin1"));
		chunks.push({ charset: charset.toLowerCase(), bytes });
		last = match.index + match[0].length;
	}
	flush();
	return out + joined.slice(last);
}
