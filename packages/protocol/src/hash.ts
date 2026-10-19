import { createHash } from "node:crypto";
import { canonicalize, JcsError } from "./jcs.ts";

// SHA-256 as lower-case hex; a string is hashed as its UTF-8 bytes.
export function sha256Hex(data: string | Uint8Array): string {
	if (typeof data === "string" && !data.isWellFormed()) {
		throw new JcsError("JCS_LONE_SURROGATE", "a string with a lone surrogate has no UTF-8 form");
	}
	return createHash("sha256").update(data).digest("hex");
}

export const jcsSha256 = (value: unknown): string => sha256Hex(canonicalize(value));

export type HeadersErrorCode = "HEADERS_INVALID_NAME" | "HEADERS_INVALID_VALUE";

export class HeadersError extends Error {
	override name = "HeadersError";
	readonly code: HeadersErrorCode;

	constructor(code: HeadersErrorCode, message: string) {
		super(`${code}: ${message}`);
		this.code = code;
	}
}

export type HeaderList = ReadonlyArray<readonly [name: string, value: string]>;

// RFC 9110 tokens, and field values of visible ASCII with spaces or tabs only between characters,
// so lower-casing and sorting mean the same thing in every language.
const TOKEN = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/;
const FIELD_VALUE = /^(?:[!-~](?:[\t -~]*[!-~])?)?$/;
const compare = (a: string, b: string): number => (a < b ? -1 : Number(a > b));

function invalidHeader(code: HeadersErrorCode): never {
	throw new HeadersError(
		code,
		code === "HEADERS_INVALID_NAME"
			? "a header name is an ASCII token"
			: "a header value is visible ASCII",
	);
}

// The SHA-256 of the JCS of [[name, value], …], names lower-cased, sorted by name and then
// value (UTF-16 code units), so the order and case of the headers don't matter but every byte does.
export function headersSha256(headers: HeaderList): string {
	const pairs = headers.map((row: unknown): [string, string] => {
		if (!Array.isArray(row)) invalidHeader("HEADERS_INVALID_NAME");
		if (row.length !== 2)
			invalidHeader(row.length === 1 ? "HEADERS_INVALID_VALUE" : "HEADERS_INVALID_NAME");
		const [name, value] = row;
		if (typeof name !== "string" || !TOKEN.test(name)) {
			invalidHeader("HEADERS_INVALID_NAME");
		}
		if (typeof value !== "string" || !FIELD_VALUE.test(value)) {
			invalidHeader("HEADERS_INVALID_VALUE");
		}
		return [name.toLowerCase(), value];
	});
	pairs.sort(
		([nameA, valueA], [nameB, valueB]) => compare(nameA, nameB) || compare(valueA, valueB),
	);
	return jcsSha256(pairs);
}
