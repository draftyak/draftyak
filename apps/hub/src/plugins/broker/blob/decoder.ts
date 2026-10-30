import { createHash, type Hash } from "node:crypto";
import { isProxy } from "node:util/types";
import {
	HOST_JSON_MEMBER_MAX_DECODED_BYTES,
	HOST_JSON_MEMBER_MAX_DEPTH,
	HOST_JSON_MEMBER_MAX_ENTITY_BYTES,
	HOST_JSON_MEMBER_MAX_NODES,
} from "@draftyak/protocol/host-channel";
import { JsonMemberRefusal, type JsonMemberRefusalCode } from "./refusal.ts";

export type JsonMember = "raw" | "data";

/** Stricter route, account or storage limits. Each may only lower its contract maximum. */
export interface JsonMemberLimits {
	readonly compressedEntityBytes?: number;
	readonly decompressedEntityBytes?: number;
	readonly decodedBytes?: number;
}

export interface JsonMemberCounters {
	readonly compressedEntityBytes: number;
	readonly decompressedEntityBytes: number;
	readonly encodedCharacters: number;
	readonly decodedBytes: number;
	/** The deepest container level reached; the root object is level one. */
	readonly containerDepth: number;
	readonly valueNodes: number;
}

/**
 * Streams one HTTP entity: strict UTF-8, one JSON root object and the selected top-level member's
 * canonical base64url string, decoded as it arrives. Nothing is buffered beyond the current chunk
 * and the decoded bytes it yields; a decoded byte past the limit is refused before it is stored.
 */
export interface JsonMemberDecoder {
	/** Bytes as received, before any Content-Encoding is removed. */
	countCompressed(byteLength: number): void;
	/** The next entity bytes after Content-Encoding; returns the bytes decoded from them. */
	push(chunk: Uint8Array): Uint8Array;
	/** The entity ended. Refuses an incomplete document; decoded bytes are complete only now. */
	end(): void;
	counters(): JsonMemberCounters;
	/** The first refusal. Every later call throws it again. */
	readonly failure: JsonMemberRefusal | undefined;
}

const EMPTY = new Uint8Array(0);
const ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
const SEXTETS = new Int8Array(128).fill(-1);
for (let index = 0; index < ALPHABET.length; index++) SEXTETS[ALPHABET.charCodeAt(index)] = index;
// The two-character escapes \" \\ \/ \b \f \n \r \t, by the byte after the backslash.
const SHORT_ESCAPES = new Int16Array(128).fill(-1);
for (const [character, value] of [
	['"', 0x22],
	["\\", 0x5c],
	["/", 0x2f],
	["b", 0x08],
	["f", 0x0c],
	["n", 0x0a],
	["r", 0x0d],
	["t", 0x09],
] as const)
	SHORT_ESCAPES[character.charCodeAt(0)] = value;
const LITERALS = new Map(
	["true", "false", "null"].map((word) => [word.charCodeAt(0), Buffer.from(word, "ascii")]),
);
const MEMBERS: Readonly<Record<JsonMember, Uint8Array>> = Object.freeze({
	raw: Buffer.from("raw", "ascii"),
	data: Buffer.from("data", "ascii"),
});
// Names up to this many bytes are kept as they are; longer ones only as a SHA-256 digest.
const NAME_BYTES = 64;

// What the parser expects next.
const ROOT = 0;
const VALUE = 1;
const FIRST_ITEM = 2;
const FIRST_NAME = 3;
const NAME = 4;
const COLON = 5;
const NEXT = 6;
const DONE = 7;
const STRING = 8;
const NUMBER = 9;
const LITERAL = 10;
// What a string is.
const SKIP = 0;
const KEY = 1;
const MEMBER = 2;
// Escape progress inside a string.
const PLAIN = 0;
const BACKSLASH = 1;
const HEX = 2;
// Number progress: after "-", after a leading 0, in integer digits, after ".", in fraction digits,
// after "e", after the exponent sign, in exponent digits.
const N_SIGN = 0;
const N_ZERO = 1;
const N_INT = 2;
const N_DOT = 3;
const N_FRAC = 4;
const N_E = 5;
const N_E_SIGN = 6;
const N_EXP = 7;

const isDigit = (b: number): boolean => b >= 0x30 && b <= 0x39;
function hexValue(b: number): number {
	if (isDigit(b)) return b - 0x30;
	const lower = b | 0x20;
	return lower >= 0x61 && lower <= 0x66 ? lower - 0x57 : -1;
}

/** Whether a chunk's memory was transferred away: it then reads as empty instead of failing. */
export function isDetached(chunk: Uint8Array): boolean {
	const { buffer } = chunk;
	return "detached" in buffer && buffer.detached;
}

class Decoder implements JsonMemberDecoder {
	readonly #member: Uint8Array;
	readonly #maxCompressed: number;
	readonly #maxEntity: number;
	readonly #maxDecoded: number;
	#failure: JsonMemberRefusal | undefined;
	#finished = false;
	#compressed = 0;
	#entity = 0;
	#characters = 0;
	#decoded = 0;
	#nodes = 0;
	#deepest = 0;
	#mode = ROOT;
	/** One entry per open container: an object's member names, or null for an array. */
	readonly #frames: (Set<string> | null)[] = [];
	#memberNext = false;
	#memberSeen = false;
	#role = SKIP;
	#escape = PLAIN;
	#hex = 0;
	#hexDigits = 0;
	#high = 0;
	#need = 0;
	#low = 0x80;
	#upper = 0xbf;
	readonly #name = new Uint8Array(NAME_BYTES);
	#nameLength = 0;
	#nameTotal = 0;
	#nameHash: Hash | undefined;
	#number = N_SIGN;
	#literal: Uint8Array = EMPTY;
	#literalIndex = 0;
	#quad = 0;
	#count = 0;
	#pad = 0;
	#out: Uint8Array | undefined;
	#outLength = 0;
	#capacity = 0;

	constructor(member: Uint8Array, maxCompressed: number, maxEntity: number, maxDecoded: number) {
		this.#member = member;
		this.#maxCompressed = maxCompressed;
		this.#maxEntity = maxEntity;
		this.#maxDecoded = maxDecoded;
	}

	get failure(): JsonMemberRefusal | undefined {
		return this.#failure;
	}

	countCompressed(byteLength: number): void {
		this.#usable();
		if (!Number.isSafeInteger(byteLength) || byteLength < 0) this.#fail("ENTITY_FAILED");
		this.#compressed += byteLength;
		if (this.#compressed > this.#maxCompressed) this.#fail("COMPRESSED_TOO_LARGE");
	}

	push(chunk: Uint8Array): Uint8Array {
		this.#usable();
		if (!(chunk instanceof Uint8Array) || isProxy(chunk) || isDetached(chunk))
			this.#fail("ENTITY_FAILED");
		// Bytes past the entity limit are never read: the first one is the refusal.
		const allowed = Math.min(chunk.byteLength, this.#maxEntity - this.#entity);
		this.#out = undefined;
		this.#outLength = 0;
		// Three bytes per four characters, plus a carried partial group and a final group, and never
		// more than the decoded bytes still allowed.
		this.#capacity = Math.min(Math.ceil((allowed * 3) / 4) + 8, this.#maxDecoded - this.#decoded);
		try {
			this.#scan(chunk, allowed);
			this.#entity += allowed;
			if (allowed < chunk.byteLength) {
				this.#entity += 1;
				this.#fail("ENTITY_TOO_LARGE");
			}
			return this.#decodedNow();
		} finally {
			this.#out = undefined;
		}
	}

	/** The bytes the current push decoded. */
	#decodedNow(): Uint8Array {
		return this.#out === undefined ? EMPTY : this.#out.subarray(0, this.#outLength);
	}

	end(): void {
		this.#usable();
		if (this.#mode !== DONE) this.#fail("JSON_INVALID");
		this.#finished = true;
	}

	counters(): JsonMemberCounters {
		return Object.freeze({
			compressedEntityBytes: this.#compressed,
			decompressedEntityBytes: this.#entity,
			encodedCharacters: this.#characters,
			decodedBytes: this.#decoded,
			containerDepth: this.#deepest,
			valueNodes: this.#nodes,
		});
	}

	#usable(): void {
		if (this.#failure !== undefined) throw this.#failure;
		// Anything after the end of the entity is data after the document.
		if (this.#finished) this.#fail("JSON_INVALID");
	}

	#fail(code: JsonMemberRefusalCode): never {
		const failure = new JsonMemberRefusal(code);
		this.#failure = failure;
		throw failure;
	}

	#scan(chunk: Uint8Array, length: number): void {
		let index = 0;
		while (index < length) {
			if (this.#mode === STRING && this.#escape === PLAIN && this.#need === 0 && this.#high === 0) {
				if (this.#role === SKIP) {
					// Printable ASCII other than a quote or backslash needs no state.
					while (index < length) {
						const b = chunk[index] as number;
						if (b < 0x20 || b === 0x22 || b === 0x5c || b >= 0x80) break;
						index++;
					}
				} else if (this.#role === MEMBER && this.#pad === 0)
					index = this.#decodeRun(chunk, index, length);
				if (index >= length) return;
			}
			this.#byte(chunk[index] as number);
			index++;
		}
	}

	/** Plain alphabet characters of the member, up to the first byte that needs the full parser. */
	#decodeRun(chunk: Uint8Array, start: number, length: number): number {
		let index = start;
		for (; index < length; index++) {
			const b = chunk[index] as number;
			const sextet = b < 0x80 ? (SEXTETS[b] as number) : -1;
			if (sextet < 0) break;
			this.#characters++;
			this.#quad = (this.#quad << 6) | sextet;
			if (++this.#count === 4) this.#group();
		}
		return index;
	}

	#byte(b: number): void {
		for (;;) {
			switch (this.#mode) {
				case STRING:
					this.#stringByte(b);
					return;
				case NUMBER:
					if (this.#numberByte(b)) return;
					// This byte ends the number; read it as structure.
					this.#mode = NEXT;
					continue;
				case LITERAL:
					if (b !== this.#literal[this.#literalIndex]) this.#fail("JSON_INVALID");
					if (++this.#literalIndex === this.#literal.length) this.#mode = NEXT;
					return;
				default:
					this.#structure(b);
					return;
			}
		}
	}

	#structure(b: number): void {
		if (b === 0x20 || b === 0x0a || b === 0x0d || b === 0x09) return;
		switch (this.#mode) {
			case ROOT:
				if (b !== 0x7b) this.#fail("JSON_INVALID");
				this.#node();
				this.#open(true);
				return;
			case VALUE:
				this.#value(b);
				return;
			case FIRST_ITEM:
				if (b === 0x5d) this.#close();
				else this.#value(b);
				return;
			case FIRST_NAME:
				if (b === 0x7d) this.#close();
				else if (b === 0x22) this.#string(KEY);
				else this.#fail("JSON_INVALID");
				return;
			case NAME:
				if (b !== 0x22) this.#fail("JSON_INVALID");
				this.#string(KEY);
				return;
			case COLON:
				if (b !== 0x3a) this.#fail("JSON_INVALID");
				this.#mode = VALUE;
				return;
			case NEXT: {
				const object = this.#frames[this.#frames.length - 1] !== null;
				if (b === 0x2c) this.#mode = object ? NAME : VALUE;
				else if (b === (object ? 0x7d : 0x5d)) this.#close();
				else this.#fail("JSON_INVALID");
				return;
			}
			default:
				// After the root object only whitespace may follow.
				this.#fail("JSON_INVALID");
		}
	}

	#value(b: number): void {
		const member = this.#memberNext;
		this.#memberNext = false;
		if (b === 0x22) {
			this.#node();
			this.#string(member ? MEMBER : SKIP);
			return;
		}
		const literal = LITERALS.get(b);
		if (b !== 0x7b && b !== 0x5b && b !== 0x2d && !isDigit(b) && literal === undefined)
			this.#fail("JSON_INVALID");
		this.#node();
		if (member) this.#fail("MEMBER_NOT_STRING");
		if (b === 0x7b || b === 0x5b) this.#open(b === 0x7b);
		else if (literal !== undefined) {
			this.#mode = LITERAL;
			this.#literal = literal;
			this.#literalIndex = 1;
		} else {
			this.#mode = NUMBER;
			this.#number = b === 0x2d ? N_SIGN : b === 0x30 ? N_ZERO : N_INT;
		}
	}

	#node(): void {
		if (++this.#nodes > HOST_JSON_MEMBER_MAX_NODES) this.#fail("NODES_TOO_LARGE");
	}

	#open(object: boolean): void {
		if (this.#frames.length >= HOST_JSON_MEMBER_MAX_DEPTH) this.#fail("DEPTH_TOO_LARGE");
		this.#frames.push(object ? new Set() : null);
		this.#deepest = Math.max(this.#deepest, this.#frames.length);
		this.#mode = object ? FIRST_NAME : FIRST_ITEM;
	}

	#close(): void {
		this.#frames.pop();
		if (this.#frames.length > 0) this.#mode = NEXT;
		else if (!this.#memberSeen) this.#fail("MEMBER_MISSING");
		else this.#mode = DONE;
	}

	#numberByte(b: number): boolean {
		const digit = isDigit(b);
		const exponent = b === 0x65 || b === 0x45;
		switch (this.#number) {
			case N_SIGN:
				if (!digit) this.#fail("JSON_INVALID");
				this.#number = b === 0x30 ? N_ZERO : N_INT;
				return true;
			case N_ZERO:
			case N_INT:
				if (digit && this.#number === N_INT) return true;
				if (b === 0x2e) this.#number = N_DOT;
				else if (exponent) this.#number = N_E;
				else return false;
				return true;
			case N_DOT:
				if (!digit) this.#fail("JSON_INVALID");
				this.#number = N_FRAC;
				return true;
			case N_FRAC:
				if (digit) return true;
				if (!exponent) return false;
				this.#number = N_E;
				return true;
			case N_E:
				if (b === 0x2b || b === 0x2d) this.#number = N_E_SIGN;
				else if (digit) this.#number = N_EXP;
				else this.#fail("JSON_INVALID");
				return true;
			case N_E_SIGN:
				if (!digit) this.#fail("JSON_INVALID");
				this.#number = N_EXP;
				return true;
			default:
				return digit;
		}
	}

	#string(role: number): void {
		this.#mode = STRING;
		this.#role = role;
		if (role === KEY) {
			this.#nameLength = 0;
			this.#nameTotal = 0;
			this.#nameHash = undefined;
		} else if (role === MEMBER) {
			this.#memberSeen = true;
			this.#quad = 0;
			this.#count = 0;
			this.#pad = 0;
		}
	}

	#stringByte(b: number): void {
		if (this.#need > 0) {
			if (b < this.#low || b > this.#upper) this.#fail("UTF8_INVALID");
			this.#low = 0x80;
			this.#upper = 0xbf;
			if (this.#role === KEY) this.#nameByte(b);
			// Every complete non-ASCII character is outside the base64url alphabet.
			if (--this.#need === 0 && this.#role === MEMBER) this.#memberCharacter(0x80);
			return;
		}
		if (this.#escape !== PLAIN) {
			this.#escapeByte(b);
			return;
		}
		// A high surrogate escape must be followed at once by a low surrogate escape.
		if (this.#high !== 0 && b !== 0x5c) this.#fail("JSON_INVALID");
		if (b === 0x22) this.#endString();
		else if (b === 0x5c) this.#escape = BACKSLASH;
		else if (b < 0x20) this.#fail("JSON_INVALID");
		else if (b < 0x80) this.#codePoint(b);
		else this.#lead(b);
	}

	/** The first byte of a multi-byte UTF-8 character, and the range its next byte must be in. */
	#lead(b: number): void {
		if (b >= 0xc2 && b <= 0xdf) this.#need = 1;
		else if (b >= 0xe0 && b <= 0xef) {
			this.#need = 2;
			if (b === 0xe0) this.#low = 0xa0;
			else if (b === 0xed) this.#upper = 0x9f;
		} else if (b >= 0xf0 && b <= 0xf4) {
			this.#need = 3;
			if (b === 0xf0) this.#low = 0x90;
			else if (b === 0xf4) this.#upper = 0x8f;
		} else this.#fail("UTF8_INVALID");
		if (this.#role === KEY) this.#nameByte(b);
	}

	#escapeByte(b: number): void {
		if (this.#escape === BACKSLASH) {
			if (b === 0x75) {
				this.#escape = HEX;
				this.#hex = 0;
				this.#hexDigits = 0;
				return;
			}
			const value = b < 0x80 ? (SHORT_ESCAPES[b] as number) : -1;
			if (value < 0 || this.#high !== 0) this.#fail("JSON_INVALID");
			this.#escape = PLAIN;
			this.#codePoint(value);
			return;
		}
		const digit = hexValue(b);
		if (digit < 0) this.#fail("JSON_INVALID");
		this.#hex = (this.#hex << 4) | digit;
		if (++this.#hexDigits < 4) return;
		this.#escape = PLAIN;
		const unit = this.#hex;
		if (this.#high !== 0) {
			if (unit < 0xdc00 || unit > 0xdfff) this.#fail("JSON_INVALID");
			const point = 0x10000 + ((this.#high - 0xd800) << 10) + (unit - 0xdc00);
			this.#high = 0;
			this.#codePoint(point);
		} else if (unit >= 0xd800 && unit <= 0xdbff) this.#high = unit;
		else if (unit >= 0xdc00 && unit <= 0xdfff) this.#fail("JSON_INVALID");
		else this.#codePoint(unit);
	}

	#codePoint(point: number): void {
		if (this.#role === MEMBER) this.#memberCharacter(point);
		else if (this.#role === KEY) {
			if (point < 0x80) this.#nameByte(point);
			else if (point < 0x800) {
				this.#nameByte(0xc0 | (point >> 6));
				this.#nameByte(0x80 | (point & 0x3f));
			} else if (point < 0x10000) {
				this.#nameByte(0xe0 | (point >> 12));
				this.#nameByte(0x80 | ((point >> 6) & 0x3f));
				this.#nameByte(0x80 | (point & 0x3f));
			} else {
				this.#nameByte(0xf0 | (point >> 18));
				this.#nameByte(0x80 | ((point >> 12) & 0x3f));
				this.#nameByte(0x80 | ((point >> 6) & 0x3f));
				this.#nameByte(0x80 | (point & 0x3f));
			}
		}
	}

	#endString(): void {
		const role = this.#role;
		this.#role = SKIP;
		if (role === KEY) {
			this.#endName();
			return;
		}
		if (role === MEMBER) this.#endMember();
		this.#mode = NEXT;
	}

	/** Names compare after escapes are decoded, as UTF-8 bytes. */
	#nameByte(b: number): void {
		if (this.#nameLength === NAME_BYTES) {
			this.#nameHash ??= createHash("sha256");
			this.#nameHash.update(this.#name);
			this.#nameLength = 0;
		}
		this.#name[this.#nameLength++] = b;
		this.#nameTotal++;
	}

	#endName(): void {
		const bytes = this.#name.subarray(0, this.#nameLength);
		const id =
			this.#nameHash === undefined
				? `=${Buffer.from(bytes).toString("latin1")}`
				: `#${this.#nameHash.update(bytes).digest("latin1")}`;
		const names = this.#frames[this.#frames.length - 1];
		if (!names) this.#fail("JSON_INVALID");
		if (names.has(id)) this.#fail("DUPLICATE_KEY");
		names.add(id);
		this.#nameHash = undefined;
		const member = this.#member;
		this.#memberNext =
			this.#frames.length === 1 &&
			this.#nameTotal === member.length &&
			bytes.every((value, index) => value === member[index]);
		this.#mode = COLON;
	}

	#memberCharacter(point: number): void {
		this.#characters++;
		if (point === 0x3d) {
			// Exact terminal padding only: "==" after two characters of a group, "=" after three.
			const required = this.#count === 2 ? 2 : this.#count === 3 ? 1 : 0;
			if (this.#pad >= required) this.#fail("ENCODING_INVALID");
			this.#pad++;
			return;
		}
		const sextet = point < 0x80 ? (SEXTETS[point] as number) : -1;
		if (sextet < 0 || this.#pad !== 0) this.#fail("ENCODING_INVALID");
		this.#quad = (this.#quad << 6) | sextet;
		if (++this.#count === 4) this.#group();
	}

	#group(): void {
		this.#emit(3);
		const out = this.#out as Uint8Array;
		const quad = this.#quad;
		out[this.#outLength++] = quad >>> 16;
		out[this.#outLength++] = (quad >>> 8) & 0xff;
		out[this.#outLength++] = quad & 0xff;
		this.#quad = 0;
		this.#count = 0;
	}

	#endMember(): void {
		const count = this.#count;
		const quad = this.#quad;
		const required = count === 2 ? 2 : count === 3 ? 1 : 0;
		// One character cannot hold a byte; the unused low bits of the last character must be zero.
		if (
			count === 1 ||
			(this.#pad !== 0 && this.#pad !== required) ||
			(count === 2 && (quad & 0x0f) !== 0) ||
			(count === 3 && (quad & 0x03) !== 0)
		)
			this.#fail("ENCODING_INVALID");
		if (count === 2) {
			this.#emit(1);
			(this.#out as Uint8Array)[this.#outLength++] = quad >>> 4;
		} else if (count === 3) {
			this.#emit(2);
			const out = this.#out as Uint8Array;
			out[this.#outLength++] = quad >>> 10;
			out[this.#outLength++] = (quad >>> 2) & 0xff;
		}
	}

	/** Refuses before storing: the decoded total never passes the limit. */
	#emit(bytes: number): void {
		if (this.#decoded + bytes > this.#maxDecoded) this.#fail("DECODED_TOO_LARGE");
		this.#out ??= new Uint8Array(this.#capacity);
		if (this.#outLength + bytes > this.#out.length) this.#fail("ENTITY_FAILED");
		this.#decoded += bytes;
	}
}

const LIMIT_NAMES: ReadonlySet<PropertyKey> = new Set<keyof JsonMemberLimits>([
	"compressedEntityBytes",
	"decompressedEntityBytes",
	"decodedBytes",
]);

/**
 * An own data property of a plain object of known limits, which may only lower `maximum`; absent
 * or undefined keeps it. An inherited, accessor or unknown limit is refused, never ignored.
 */
export function jsonMemberLimit(
	limits: unknown,
	name: keyof JsonMemberLimits,
	maximum: number,
): number {
	if (
		limits === null ||
		typeof limits !== "object" ||
		isProxy(limits) ||
		![Object.prototype, null].includes(Object.getPrototypeOf(limits)) ||
		Reflect.ownKeys(limits).some((key) => !LIMIT_NAMES.has(key))
	)
		throw new RangeError("JSON member limits must be a plain object of known limits");
	const field = Object.getOwnPropertyDescriptor(limits, name);
	if (field === undefined || (Object.hasOwn(field, "value") && field.value === undefined))
		return maximum;
	const value: unknown = field.value;
	if (
		!Object.hasOwn(field, "value") ||
		typeof value !== "number" ||
		!Number.isSafeInteger(value) ||
		value < 0 ||
		value > maximum
	)
		throw new RangeError("A JSON member limit may only lower its contract maximum");
	return value;
}

export function createJsonMemberDecoder(
	member: JsonMember,
	limits: JsonMemberLimits = {},
): JsonMemberDecoder {
	if (member !== "raw" && member !== "data") throw new JsonMemberRefusal("REQUEST_INVALID");
	return Object.freeze(
		new Decoder(
			MEMBERS[member],
			jsonMemberLimit(limits, "compressedEntityBytes", HOST_JSON_MEMBER_MAX_ENTITY_BYTES),
			jsonMemberLimit(limits, "decompressedEntityBytes", HOST_JSON_MEMBER_MAX_ENTITY_BYTES),
			jsonMemberLimit(limits, "decodedBytes", HOST_JSON_MEMBER_MAX_DECODED_BYTES),
		),
	);
}
