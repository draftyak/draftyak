import {
	type HeaderList,
	HeadersError,
	type HeadersErrorCode,
	headersSha256,
	sha256Hex,
} from "../../src/hash.ts";
import { canonicalize } from "../../src/jcs.ts";
import type { VectorFile } from "../vectors.ts";

const ulid = "01JAZ3W3B6Q8M2V0G5T9K4X7RC";

// Headers written as "Name: value" lines; a name never holds a colon.
const list = (lines: readonly string[]): [string, string][] =>
	lines.map((line) => [line.slice(0, line.indexOf(":")), line.slice(line.indexOf(":") + 2)]);

// `sorted` is written out by hand: the lower-cased, sorted list whose JCS is hashed.
function hashed(id: string, lines: readonly string[], sorted: readonly string[]): object {
	const headers = list(lines);
	const sha256 = headersSha256(headers);
	const canonical = canonicalize(list(sorted));
	if (sha256Hex(canonical) !== sha256)
		throw new Error(`headers ${id}: ${canonical} isn't what's hashed`);
	return { id, headers, canonical, sha256 };
}

function refused(id: string, headers: HeaderList, error: HeadersErrorCode): object {
	try {
		headersSha256(headers);
	} catch (thrown) {
		if (thrown instanceof HeadersError && thrown.code === error) return { id, headers, error };
		throw thrown;
	}
	throw new Error(`headers ${id}: accepted`);
}

export function generate(): VectorFile[] {
	const json = "content-type: application/json";
	const key = `idempotency-key: ${ulid}`;
	const accept = ["accept: application/json", "accept: text/plain", json];
	const cases = [
		hashed("empty", [], []),
		hashed(
			"json-post",
			["Content-Type: application/json", `Idempotency-Key: ${ulid}`],
			[json, key],
		),
		hashed(
			"json-post-other-order-and-case",
			[`IDEMPOTENCY-KEY: ${ulid}`, "content-TYPE: application/json"],
			[json, key],
		),
		hashed(
			"json-post-one-value-byte-changed",
			["Content-Type: application/jsom", `Idempotency-Key: ${ulid}`],
			["content-type: application/jsom", key],
		),
		hashed(
			"repeated-name",
			["Accept: text/plain", "Content-Type: application/json", "accept: application/json"],
			accept,
		),
		hashed(
			"repeated-name-other-order",
			["ACCEPT: application/json", "Accept: text/plain", "content-type: application/json"],
			accept,
		),
		// Code units, not a collation or a case-insensitive order: "B" < "a", "-" < "_" < "a" < "~".
		hashed("values-by-code-units", ["Accept: a", "Accept: B"], ["accept: B", "accept: a"]),
		hashed(
			"names-by-code-units",
			["X~a: 1", "XA: 2", "X_a: 3", "X-Ab: 4"],
			["x-ab: 4", "x_a: 3", "xa: 2", "x~a: 1"],
		),
		hashed(
			"inner-space-and-empty-value",
			["X-Note: a b\tc", "X-Empty: "],
			["x-empty: ", "x-note: a b\tc"],
		),
		refused("name-with-space", [["Content Type", "application/json"]], "HEADERS_INVALID_NAME"),
		refused("empty-name", [["", "x"]], "HEADERS_INVALID_NAME"),
		refused("name-not-ascii", [["X-\u{c9}", "x"]], "HEADERS_INVALID_NAME"),
		refused("value-with-crlf", [["X-Note", "a\r\nb"]], "HEADERS_INVALID_VALUE"),
		refused("value-not-ascii", [["X-Note", "caf\u{e9}"]], "HEADERS_INVALID_VALUE"),
		refused("value-leading-space", [["X-Note", " a"]], "HEADERS_INVALID_VALUE"),
		refused("value-trailing-tab", [["X-Note", "a\t"]], "HEADERS_INVALID_VALUE"),
	];
	const description =
		"headersSha256: the SHA-256 of the JCS of [[name, value], ...] with names lower-cased and the " +
		"pairs sorted by name, then value, comparing UTF-16 code units as JCS sorts member names " +
		'(never a collation or a case-insensitive order). "canonical" is that JCS for "headers"; a ' +
		'case with "error" is refused with that code: names are RFC 9110 tokens, values visible ' +
		"ASCII with spaces or tabs only between characters.";
	return [
		{
			path: "hash/headers.json",
			content: { format: "draftyak.vectors.hash.v1", description, cases },
		},
	];
}
