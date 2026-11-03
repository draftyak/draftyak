// The sidecar stdin payload grammar: one flat ASCII JSON object of an accepted shape, with
// ordinary JSON whitespace and either initial key order. Payload bytes are only compared and
// decoded as numbers.

export interface InitialFrame {
	readonly kind: "initial";
	/** Offset of the 64 lower-hex master key digits. */
	readonly masterKeyAt: number;
	/** Offset of the 32 lower-hex bootstrap secret digits. */
	readonly bootstrapSecretAt: number;
}
export interface ControlFrame {
	readonly kind: "resumed" | "shutdown";
}
export type SidecarFrame = InitialFrame | ControlFrame;

const QUOTE = 0x22;
const COMMA = 0x2c;
const COLON = 0x3a;
const OPEN = 0x7b;
const CLOSE = 0x7d;

const MASTER_KEY = 1;
const BOOTSTRAP_SECRET = 2;
const POWER = 4;
const SHUTDOWN = 8;
const FIELDS: readonly (readonly [name: string, field: number])[] = [
	['"masterKey"', MASTER_KEY],
	['"bootstrapSecret"', BOOTSTRAP_SECRET],
	['"power"', POWER],
	['"shutdown"', SHUTDOWN],
];
const RESUMED_FRAME: ControlFrame = Object.freeze({ kind: "resumed" });
const SHUTDOWN_FRAME: ControlFrame = Object.freeze({ kind: "shutdown" });

const isSpace = (byte: number | undefined): boolean =>
	byte === 0x20 || byte === 0x09 || byte === 0x0a || byte === 0x0d;

const isLowerHex = (byte: number | undefined): boolean =>
	byte !== undefined && ((byte >= 0x30 && byte <= 0x39) || (byte >= 0x61 && byte <= 0x66));

function skipSpace(bytes: Uint8Array, end: number, at: number): number {
	while (at < end && isSpace(bytes[at])) at++;
	return at;
}

// The offset after text when the bytes at the offset spell it exactly, or -1.
function match(bytes: Uint8Array, end: number, at: number, text: string): number {
	if (at + text.length > end) return -1;
	for (let i = 0; i < text.length; i++) if (bytes[at + i] !== text.charCodeAt(i)) return -1;
	return at + text.length;
}

// The offset after a quoted run of exactly that many lower-hex digits, or -1.
function quotedHex(bytes: Uint8Array, end: number, at: number, digits: number): number {
	if (at + digits + 2 > end || bytes[at] !== QUOTE) return -1;
	for (let i = 1; i <= digits; i++) if (!isLowerHex(bytes[at + i])) return -1;
	return bytes[at + digits + 1] === QUOTE ? at + digits + 2 : -1;
}

/** Classify the first length payload bytes, or return undefined for anything else. */
export function scanSidecarFrame(bytes: Uint8Array, length: number): SidecarFrame | undefined {
	if (!Number.isSafeInteger(length) || length < 1 || length > bytes.length) return undefined;
	let at = skipSpace(bytes, length, 0);
	if (at >= length || bytes[at] !== OPEN) return undefined;
	let seen = 0;
	let masterKeyAt = -1;
	let bootstrapSecretAt = -1;
	for (;;) {
		at = skipSpace(bytes, length, at + 1);
		let field = 0;
		for (const [name, candidate] of FIELDS) {
			const next = match(bytes, length, at, name);
			if (next !== -1) {
				field = candidate;
				at = next;
				break;
			}
		}
		if (field === 0 || (seen & field) !== 0) return undefined;
		seen |= field;
		at = skipSpace(bytes, length, at);
		if (at >= length || bytes[at] !== COLON) return undefined;
		at = skipSpace(bytes, length, at + 1);
		if (field === MASTER_KEY) {
			masterKeyAt = at + 1;
			at = quotedHex(bytes, length, at, 64);
		} else if (field === BOOTSTRAP_SECRET) {
			bootstrapSecretAt = at + 1;
			at = quotedHex(bytes, length, at, 32);
		} else {
			at = match(bytes, length, at, field === POWER ? '"resumed"' : "true");
		}
		if (at === -1) return undefined;
		at = skipSpace(bytes, length, at);
		if (at >= length) return undefined;
		if (bytes[at] === CLOSE) break;
		if (bytes[at] !== COMMA) return undefined;
	}
	if (skipSpace(bytes, length, at + 1) !== length) return undefined;
	if (seen === (MASTER_KEY | BOOTSTRAP_SECRET))
		return Object.freeze({ kind: "initial", masterKeyAt, bootstrapSecretAt });
	if (seen === POWER) return RESUMED_FRAME;
	if (seen === SHUTDOWN) return SHUTDOWN_FRAME;
	return undefined;
}

// '0'-'9' to 0-9 and 'a'-'f' to 10-15 without branching on the digit.
const nibble = (byte: number | undefined): number => {
	const value = byte ?? 0;
	return (value & 0x0f) + 9 * (value >> 6);
};

/** Decode scanned lower-hex digits at an offset into every byte of the target. */
export function decodeLowerHex(bytes: Uint8Array, at: number, into: Uint8Array): void {
	for (let i = 0; i < into.length; i++) {
		into[i] = (nibble(bytes[at + 2 * i]) << 4) | nibble(bytes[at + 2 * i + 1]);
	}
}
