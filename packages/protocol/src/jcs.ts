// RFC 8785 canonical JSON, and a strict parser that refuses exactly what the Rust crate's
// parse_strict refuses, so both languages accept the same documents.

// Containers may nest this deep and no deeper, in documents and in values alike.
export const JCS_MAX_DEPTH = 64;

export type JcsErrorCode =
	| "JCS_SYNTAX"
	| "JCS_INVALID_UTF8"
	| "JCS_LONE_SURROGATE"
	| "JCS_DUPLICATE_KEY"
	| "JCS_NUMBER_RANGE"
	| "JCS_TOO_DEEP"
	| "JCS_UNSUPPORTED_VALUE";

export class JcsError extends Error {
	override name = "JcsError";
	readonly code: JcsErrorCode;

	constructor(code: JcsErrorCode, message: string) {
		super(`${code}: ${message}`);
		this.code = code;
	}
}

const tooDeep = (): JcsError =>
	new JcsError("JCS_TOO_DEEP", `containers nest deeper than ${JCS_MAX_DEPTH}`);

function quote(text: string): string {
	if (!text.isWellFormed())
		throw new JcsError("JCS_LONE_SURROGATE", "a string holds a lone surrogate");
	// JSON.stringify escapes exactly what RFC 8785 §3.2.2.2 escapes, in the same forms.
	return JSON.stringify(text);
}

function serialize(value: unknown, depth: number): string {
	if (value === null) return "null";
	switch (typeof value) {
		case "boolean":
			return value ? "true" : "false";
		case "number":
			if (!Number.isFinite(value))
				throw new JcsError("JCS_NUMBER_RANGE", `${value} isn't a JSON number`);
			// ECMAScript's Number::toString, as RFC 8785 §3.2.2.3 requires; -0 becomes 0.
			return JSON.stringify(value);
		case "string":
			return quote(value);
		case "object":
			break;
		default:
			throw new JcsError("JCS_UNSUPPORTED_VALUE", `a ${typeof value} has no JSON form`);
	}
	if (depth >= JCS_MAX_DEPTH) throw tooDeep();
	if (Array.isArray(value)) {
		// A loop, not map(), so a hole reads as undefined and is refused.
		const items: string[] = [];
		for (let index = 0; index < value.length; index++) {
			items.push(serialize(value[index], depth + 1));
		}
		return `[${items.join(",")}]`;
	}
	const prototype: unknown = Object.getPrototypeOf(value);
	if (prototype !== Object.prototype && prototype !== null) {
		throw new JcsError("JCS_UNSUPPORTED_VALUE", "only plain objects and arrays have a JSON form");
	}
	const record = value as Record<string, unknown>;
	// Member names sort by UTF-16 code units (RFC 8785 §3.2.3), as JavaScript compares strings.
	const members = Object.keys(record)
		.sort()
		.map((key) => `${quote(key)}:${serialize(record[key], depth + 1)}`);
	return `{${members.join(",")}}`;
}

export function canonicalize(value: unknown): string {
	return serialize(value, 0);
}

const utf8 = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });

function decode(input: string | Uint8Array): string {
	let text: string;
	if (typeof input === "string") text = input;
	else {
		try {
			text = utf8.decode(input);
		} catch {
			throw new JcsError("JCS_INVALID_UTF8", "the bytes aren't valid UTF-8");
		}
	}
	if (!text.isWellFormed())
		throw new JcsError("JCS_LONE_SURROGATE", "the text holds a lone surrogate");
	return text;
}

const NUMBER = /-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/y;
const HEX4 = /^[0-9A-Fa-f]{4}$/;
// The short escapes: \" \\ \/ \b \f \n \r \t.
const escapes = new Map([...'"\\/bfnrt'].map((c, i) => [c, '"\\/\b\f\n\r\t'.charAt(i)]));
const literals: ReadonlyArray<readonly [string, unknown]> = [
	["true", true],
	["false", false],
	["null", null],
];
const isSpace = (c: number): boolean => c === 0x20 || c === 0x09 || c === 0x0a || c === 0x0d;

// RFC 8259 JSON, with duplicate member names, lone surrogates, numbers beyond the double range and
// nesting deeper than JCS_MAX_DEPTH refused. Numbers become doubles, as RFC 8785 reads them.
function parse(text: string): unknown {
	let at = 0;
	const error = (code: JcsErrorCode, message: string): JcsError =>
		new JcsError(code, `${message} at offset ${at}`);
	const space = (): void => {
		while (isSpace(text.charCodeAt(at))) at++;
	};

	const string = (): string => {
		let out = "";
		let start = ++at;
		for (;;) {
			const c = text.charCodeAt(at);
			if (c === 0x22) {
				out += text.slice(start, at++);
				if (!out.isWellFormed())
					throw error("JCS_LONE_SURROGATE", "a string holds a lone surrogate");
				return out;
			}
			if (c === 0x5c) {
				out += text.slice(start, at);
				const kind = text.charAt(at + 1);
				if (kind === "u") {
					const hex = text.slice(at + 2, at + 6);
					if (!HEX4.test(hex)) throw error("JCS_SYNTAX", "a \\u escape needs four hex digits");
					out += String.fromCharCode(Number.parseInt(hex, 16));
					at += 6;
				} else {
					const char = escapes.get(kind);
					if (char === undefined) throw error("JCS_SYNTAX", "an invalid escape");
					out += char;
					at += 2;
				}
				start = at;
			} else if (Number.isNaN(c)) throw error("JCS_SYNTAX", "an unterminated string");
			else if (c < 0x20) throw error("JCS_SYNTAX", "a control character must be escaped");
			else at++;
		}
	};

	const value = (depth: number): unknown => {
		space();
		const c = text.charAt(at);
		if (c === "{" || c === "[") {
			if (depth >= JCS_MAX_DEPTH) throw tooDeep();
			at++;
			return c === "{" ? object(depth + 1) : array(depth + 1);
		}
		if (c === '"') return string();
		for (const [word, literal] of literals) {
			if (text.startsWith(word, at)) {
				at += word.length;
				return literal;
			}
		}
		NUMBER.lastIndex = at;
		const match = NUMBER.exec(text)?.[0];
		if (match === undefined) throw error("JCS_SYNTAX", "expected a JSON value");
		const number = Number(match);
		if (!Number.isFinite(number))
			throw error("JCS_NUMBER_RANGE", "a number beyond the double range");
		at += match.length;
		return number;
	};

	// After an item: true at the closing bracket, false after a comma.
	const next = (close: string): boolean => {
		space();
		const c = text.charAt(at++);
		if (c === close) return true;
		if (c === ",") return false;
		at--;
		throw error("JCS_SYNTAX", `expected ',' or '${close}'`);
	};

	const array = (depth: number): unknown[] => {
		const items: unknown[] = [];
		space();
		if (text.charAt(at) === "]") {
			at++;
			return items;
		}
		do {
			items.push(value(depth));
		} while (!next("]"));
		return items;
	};

	const object = (depth: number): Record<string, unknown> => {
		const members: Record<string, unknown> = {};
		space();
		if (text.charAt(at) === "}") {
			at++;
			return members;
		}
		do {
			space();
			if (text.charAt(at) !== '"') throw error("JCS_SYNTAX", "expected a member name");
			const name = string();
			if (Object.hasOwn(members, name)) {
				throw error("JCS_DUPLICATE_KEY", `the member name ${JSON.stringify(name)} repeats`);
			}
			space();
			if (text.charAt(at) !== ":") throw error("JCS_SYNTAX", "expected ':'");
			at++;
			// defineProperty, so a "__proto__" member stays an ordinary member.
			Object.defineProperty(members, name, {
				value: value(depth),
				enumerable: true,
				writable: true,
				configurable: true,
			});
		} while (!next("}"));
		return members;
	};

	const document = value(0);
	space();
	if (at < text.length) throw error("JCS_SYNTAX", "text after the JSON value");
	return document;
}

export function parseStrict(input: string | Uint8Array): unknown {
	return parse(decode(input));
}

// True when the input is exactly the canonical form of what it holds.
export function isCanonical(input: string | Uint8Array): boolean {
	try {
		const text = decode(input);
		return canonicalize(parse(text)) === text;
	} catch (error) {
		if (error instanceof JcsError) return false;
		throw error;
	}
}
