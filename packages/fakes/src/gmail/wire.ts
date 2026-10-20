import { rawTarget, splitTarget } from "../target.ts";

export const MAX_GMAIL_RAW_BYTES = 36_700_160;
export const MAX_GMAIL_WIRE_BYTES: number = 50 * 1024 * 1024;
export const MAX_GMAIL_STATE_BYTES: number = 64 * 1024 * 1024;
export const MAX_GMAIL_MESSAGES = 1024;
export const MAX_GMAIL_HISTORY = 2048;
export const MAX_GMAIL_CURSORS = 128;
export const MAX_GMAIL_SEND_STEPS = 1024;
export const MAX_GMAIL_BODY_CHUNKS = 65_536;
export class GmailInputError extends Error {}
export function check(value: unknown): asserts value {
	if (!value) throw new GmailInputError("Gmail fixture input refused");
}
export function id(value: unknown): asserts value is string {
	check(typeof value === "string" && /^[A-Za-z0-9_-]{1,128}$/.test(value));
}
export function labels(value: readonly string[]): string[] {
	check(Array.isArray(value) && value.length <= 100);
	for (const entry of value) id(entry);
	check(new Set(value).size === value.length);
	return [...value];
}
export function decimal(value: string): bigint {
	check(/^(?:0|[1-9][0-9]{0,19})$/.test(value));
	const n = BigInt(value);
	check(n <= 18_446_744_073_709_551_615n);
	return n;
}
export function json(value: unknown, status = 200, extra: Record<string, string> = {}): Response {
	const wire = JSON.stringify(value);
	check(Buffer.byteLength(wire) <= MAX_GMAIL_WIRE_BYTES);
	return new Response(wire, { status, headers: { "content-type": "application/json", ...extra } });
}
export function failure(code: number, reason: string, message: string, extra = {}): Response {
	return json(
		{ error: { code, message, errors: [{ domain: "global", reason, message }] } },
		code,
		extra,
	);
}
export interface Header {
	name: string;
	value: string;
}
export function headers(raw: Uint8Array): { entries: Header[]; body: Uint8Array } {
	const bytes = Buffer.from(raw.buffer, raw.byteOffset, raw.byteLength);
	const end = bytes.indexOf("\r\n\r\n");
	check(end >= 0 && end <= 65_536);
	const entries: Header[] = [];
	for (const line of bytes.subarray(0, end).toString("utf8").split("\r\n")) {
		check(!/[\0\r\n]/.test(line));
		if (/^[ \t]/.test(line)) {
			check(entries.length);
			(entries[entries.length - 1] as Header).value += ` ${line.trim()}`;
		} else {
			const colon = line.indexOf(":");
			check(colon > 0 && /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(line.slice(0, colon)));
			entries.push({ name: line.slice(0, colon), value: line.slice(colon + 1).trim() });
		}
		check(entries.length <= 128);
	}
	return { entries, body: bytes.subarray(end + 4) };
}
export function rewrite(
	raw: Uint8Array,
	changes: { date?: string; messageId?: string },
): Uint8Array {
	if (changes.date === undefined && changes.messageId === undefined) return new Uint8Array(raw);
	const parsed = headers(raw),
		replace = new Map<string, string>();
	if (changes.date !== undefined) replace.set("date", changes.date);
	if (changes.messageId !== undefined) replace.set("message-id", changes.messageId);
	const bytes = Buffer.from(raw),
		head = bytes.subarray(0, bytes.indexOf("\r\n\r\n")).toString("latin1");
	const groups = head.split(/\r\n(?=[^ \t])/),
		seen = new Set<string>();
	const kept: Buffer[] = [];
	for (const group of groups) {
		const name = group.slice(0, group.indexOf(":")).toLowerCase(),
			value = replace.get(name);
		if (value === undefined) kept.push(Buffer.from(group, "latin1"));
		else if (!seen.has(name)) {
			kept.push(Buffer.from(`${name === "date" ? "Date" : "Message-ID"}: ${value}`));
			seen.add(name);
		}
	}
	for (const [name, value] of replace)
		if (!seen.has(name))
			kept.push(Buffer.from(`${name === "date" ? "Date" : "Message-ID"}: ${value}`));
	return Buffer.concat([
		Buffer.concat(kept.flatMap((p, i) => (i ? [Buffer.from("\r\n"), p] : [p]))),
		Buffer.from("\r\n\r\n"),
		parsed.body,
	]);
}
export async function body(request: Request): Promise<Buffer> {
	const reader = request.body?.getReader();
	if (!reader) return Buffer.alloc(0);
	let bytes = Buffer.alloc(0),
		size = 0,
		chunks = 0;
	const abort = () => {
		void reader.cancel(request.signal.reason).catch(() => {});
	};
	request.signal.addEventListener("abort", abort, { once: true });
	try {
		request.signal.throwIfAborted();
		for (;;) {
			const next = await reader.read();
			request.signal.throwIfAborted();
			if (next.done) return bytes.subarray(0, size);
			check(next.value instanceof Uint8Array);
			if (++chunks > MAX_GMAIL_BODY_CHUNKS || next.value.byteLength > MAX_GMAIL_WIRE_BYTES - size) {
				abort();
				throw new GmailInputError("Gmail fixture body limit");
			}
			const end = size + next.value.byteLength;
			if (end > bytes.length) {
				const grown = Buffer.alloc(
					Math.min(MAX_GMAIL_WIRE_BYTES, Math.max(end, bytes.length * 2, 1024)),
				);
				bytes.copy(grown, 0, 0, size);
				bytes = grown;
			}
			bytes.set(next.value, size);
			size += next.value.byteLength;
		}
	} finally {
		request.signal.removeEventListener("abort", abort);
		reader.releaseLock();
	}
}
export function rawBytes(value: unknown): Buffer {
	check(typeof value === "string" && /^[A-Za-z0-9_-]*$/.test(value));
	const bytes = Buffer.from(value, "base64url");
	check(
		bytes.toString("base64url") === value &&
			bytes.length > 0 &&
			bytes.length <= MAX_GMAIL_RAW_BYTES,
	);
	headers(bytes);
	return bytes;
}
export function record(value: unknown, allowed: readonly string[]): Record<string, unknown> {
	check(value !== null && typeof value === "object" && !Array.isArray(value));
	check(Object.keys(value).every((k) => allowed.includes(k)));
	return value as Record<string, unknown>;
}
export function upload(bytes: Buffer, contentType: string): { raw: Buffer; threadId?: string } {
	if (/^application\/json(?:\s*;\s*charset=utf-8)?$/i.test(contentType)) {
		const data = record(JSON.parse(bytes.toString("utf8")), ["raw", "threadId"]);
		if (data.threadId !== undefined) id(data.threadId);
		return {
			raw: rawBytes(data.raw),
			...(data.threadId === undefined ? {} : { threadId: data.threadId as string }),
		};
	}
	const match =
		/^multipart\/related\s*;\s*boundary=(?:"([A-Za-z0-9'()+_,./:=?-]{1,70})"|([A-Za-z0-9'()+_,./:=?-]{1,70}))$/i.exec(
			contentType,
		);
	check(match);
	const boundary = Buffer.from(`--${match[1] ?? match[2]}`);
	check(bytes.subarray(0, boundary.length).equals(boundary));
	const split = Buffer.concat([Buffer.from("\r\n"), boundary]);
	let cursor = boundary.length;
	const parts: { type: string; bytes: Buffer }[] = [];
	while (!bytes.subarray(cursor, cursor + 2).equals(Buffer.from("--"))) {
		check(parts.length < 2 && bytes.subarray(cursor, cursor + 2).toString() === "\r\n");
		cursor += 2;
		const headEnd = bytes.indexOf("\r\n\r\n", cursor),
			end = bytes.indexOf(split, headEnd + 4);
		check(headEnd >= cursor && headEnd - cursor <= 1024 && end >= headEnd + 4);
		const head = bytes.subarray(cursor, headEnd).toString("ascii");
		check(/^Content-Type: [^\r\n]+$/i.test(head));
		parts.push({
			type: head.slice(14).trim().toLowerCase(),
			bytes: bytes.subarray(headEnd + 4, end),
		});
		cursor = end + split.length;
	}
	check(parts.length === 2 && /^(?:--\r\n|--)$/.test(bytes.subarray(cursor).toString("ascii")));
	check(parts[0]?.type.split(";")[0]?.trim() === "application/json");
	check(/^message\/[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(parts[1]?.type.split(";")[0]?.trim() ?? ""));
	check((parts[0] as { bytes: Buffer }).bytes.length <= 4096);
	const data = record(JSON.parse((parts[0] as { bytes: Buffer }).bytes.toString("utf8")), [
		"threadId",
	]);
	if (data.threadId !== undefined) id(data.threadId);
	const raw = (parts[1] as { bytes: Buffer }).bytes;
	check(raw.length > 0 && raw.length <= MAX_GMAIL_RAW_BYTES);
	headers(raw);
	return { raw, ...(data.threadId === undefined ? {} : { threadId: data.threadId as string }) };
}
const repeated = new Set(["labelIds", "metadataHeaders", "historyTypes"]);
export function target(request: Request): { path: string; query: URLSearchParams } {
	const raw = rawTarget(request);
	check(Buffer.byteLength(raw) <= 8192 && !/[#\\\s]/.test(raw));
	const { path, query } = splitTarget(raw),
		params = new URLSearchParams(query);
	check([...params].length <= 64);
	for (const name of new Set(params.keys()))
		check(repeated.has(name) || params.getAll(name).length === 1);
	return { path, query: params };
}
export function query(params: URLSearchParams, allowed: readonly string[]): void {
	for (const [name, value] of params) {
		check([...allowed, "fields"].includes(name) && value.length <= 2048);
		if (name === "maxResults") check(/^[1-9][0-9]{0,2}$/.test(value) && Number(value) <= 500);
		if (name === "includeSpamTrash") check(value === "true" || value === "false");
		if (name === "historyTypes")
			check(["messageAdded", "messageDeleted", "labelAdded", "labelRemoved"].includes(value));
		if (name === "startHistoryId") decimal(value);
	}
}
type Selection = { [key: string]: Selection | null };
export function project(value: unknown, fields: string | null): unknown {
	if (!fields) return value;
	let at = 0,
		count = 0;
	function parse(depth: number): Selection {
		check(depth < 8);
		const result: Selection = Object.create(null);
		for (;;) {
			const start = at;
			while (/[A-Za-z0-9_*/]/.test(fields?.[at] ?? "") && at < (fields?.length ?? 0)) at++;
			const names = fields?.slice(start, at).split("/") ?? [];
			check(
				names.length &&
					names.every((n) => /^(?:[A-Za-z_][A-Za-z0-9_]*|\*)$/.test(n)) &&
					++count <= 64,
			);
			check(names.every((n) => !["__proto__", "constructor", "prototype"].includes(n)));
			let child: Selection | null = null;
			if (fields?.[at] === "(") {
				at++;
				child = parse(depth + 1);
				check(fields?.[at++] === ")");
			}
			let parent = result;
			for (const name of names.slice(0, -1)) {
				const node = parent[name] ?? Object.create(null);
				parent[name] = node;
				parent = node;
			}
			parent[names[names.length - 1] as string] = child;
			if (fields?.[at] !== ",") return result;
			at++;
		}
	}
	const selection = parse(0);
	check(at === fields.length);
	function select(data: unknown, wanted: Selection): unknown {
		if (Array.isArray(data)) return data.map((x) => select(x, wanted));
		if (!data || typeof data !== "object") return data;
		const output: Record<string, unknown> = Object.create(null);
		for (const [name, v] of Object.entries(data))
			if (Object.hasOwn(wanted, name) || Object.hasOwn(wanted, "*")) {
				const child = Object.hasOwn(wanted, name) ? wanted[name] : wanted["*"];
				output[name] = child === null ? v : select(v, child as Selection);
			}
		return output;
	}
	return select(value, selection);
}
