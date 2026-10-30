import { isUtf8 } from "node:buffer";
import { gunzipSync, inflateRawSync, zstdDecompressSync } from "node:zlib";

// Compressed content, decompressed for the scan: gzip and zstd streams, zip entries (stored or
// deflated, so .docx and .xlsx too) and PDF streams (FlateDecode, ASCIIHexDecode and
// ASCII85Decode), nested ones included; tar archives are walked for nested ones. All of one file's
// content may expand to `ratio` times the file's size, at least `min` and at most `max` bytes,
// `depth` levels deep, in at most `parts` parts. What can't be read in full fails as compressed.
export interface Caps {
	readonly ratio: number;
	readonly min: number;
	readonly max: number;
	readonly depth: number;
	readonly parts: number;
}

export const CAPS: Caps = { ratio: 100, min: 2 ** 20, max: 64 * 2 ** 20, depth: 8, parts: 50_000 };

export interface Part {
	readonly bytes: Buffer;
	// Where it sits, such as "zip entry 2 in the gzip stream".
	readonly label: string;
}

export interface Unpacked {
	readonly parts: Part[];
	// Why the rest wasn't read: past the caps, or not decompressible.
	readonly problem?: string;
}

class Refusal extends Error {}

interface State {
	readonly caps: Caps;
	readonly limit: number;
	left: number;
	// Bytes of zip listings, PDF objects and encoded PDF data still to go through: as many as the
	// content may expand to, so that ones that overlap can't make the reading slow.
	work: number;
	readonly parts: Part[];
}

const mib = (bytes: number): string => `${Number((bytes / 2 ** 20).toFixed(1))} MiB`;

function tooLarge({ caps, limit }: State): Refusal {
	const terms = `${caps.ratio} times the file's size, at least ${mib(caps.min)}, at most ${mib(caps.max)}`;
	return new Refusal(
		`decompresses to over ${mib(limit)} (${terms}), too large to scan; keep it out of the repository`,
	);
}

function take(state: State, bytes: number): void {
	if (bytes > state.left) throw tooLarge(state);
	state.left -= bytes;
}

function spend(state: State, bytes: number): void {
	state.work -= bytes;
	if (state.work < 0) {
		throw new Refusal(
			`takes over ${mib(state.limit)} of archive listings and PDF data to unpack, too much to scan; keep it out of the repository`,
		);
	}
}

const unreadable = (label: string, detail: string): Refusal =>
	new Refusal(`can't decompress ${label} (${detail}) to scan it; keep it out of the repository`);

// Each returns its output and how many input bytes it read, where its stream ends. Cut-off input
// fails, as damaged input does.
type Run = (data: Buffer, maxOutputLength: number) => unknown;
const gunzip: Run = (data, max) => gunzipSync(data, { info: true, maxOutputLength: max });
const unzstd: Run = (data, max) => zstdDecompressSync(data, { info: true, maxOutputLength: max });
const inflateRaw: Run = (data, max) => inflateRawSync(data, { info: true, maxOutputLength: max });

interface Info {
	readonly buffer: Buffer;
	readonly engine: { readonly bytesWritten: number };
}

interface Decoded {
	readonly out: Buffer;
	// The input bytes it took.
	readonly used: number;
}

function decompress(run: Run, data: Buffer, label: string, state: State): Decoded {
	let info: Info;
	try {
		info = run(data, Math.max(1, state.left)) as Info;
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ERR_BUFFER_TOO_LARGE") throw tooLarge(state);
		throw unreadable(label, error instanceof Error ? error.message : String(error));
	}
	take(state, info.buffer.length);
	return { out: info.buffer, used: info.engine.bytesWritten };
}

const startsWith = (bytes: Buffer, magic: readonly number[], at = 0): boolean =>
	magic.every((byte, index) => bytes[at + index] === byte);

const GZIP = [0x1f, 0x8b, 0x08];
// A zstd frame, or a skippable frame (magic 0x184D2A50 to 0x184D2A5F), which pzstd writes first.
const isZstd = (bytes: Buffer): boolean =>
	startsWith(bytes, [0x28, 0xb5, 0x2f, 0xfd]) ||
	(((bytes[0] ?? 0) & 0xf0) === 0x50 && startsWith(bytes, [0x2a, 0x4d, 0x18], 1));

// gzip members up to `end`, one after another or after NUL padding, as gzip reads them.
function gunzipAll(bytes: Buffer, end: number, label: string, state: State): Buffer {
	const members: Buffer[] = [];
	let at = 0;
	do {
		const { out, used } = decompress(gunzip, bytes.subarray(at, end), label, state);
		members.push(out);
		at += used;
		while (at < end && bytes[at] === 0) at++;
	} while (at < end && startsWith(bytes, GZIP, at));
	if (at < end) throw unreadable(label, "other data after it");
	return members.length === 1 ? (members[0] as Buffer) : Buffer.concat(members);
}

// zstd frames up to `end`, skippable ones included; zstd fails on anything after them.
function unzstdAll(bytes: Buffer, end: number, label: string, state: State): Buffer {
	const { out, used } = decompress(unzstd, bytes.subarray(0, end), label, state);
	if (used !== end) throw unreadable(label, "other data after it");
	return out;
}

interface ZipEntry {
	readonly name: string;
	readonly flags: number;
	readonly method: number;
	readonly data: Buffer;
}

interface Zip {
	readonly entries: ZipEntry[];
	// Where it starts: its first entry, or its end record if it lists none.
	readonly start: number;
}

const LOCAL = 0x04034b50;
const CENTRAL = 0x02014b50;
const LOCATOR = 0x07064b50;
const LOCAL_MAGIC = [0x50, 0x4b, 0x03, 0x04];
const END_MAGIC = [0x50, 0x4b, 0x05, 0x06];
const ZIP_LOCAL = Buffer.from(LOCAL_MAGIC);
const ZIP_END = Buffer.from(END_MAGIC);

// Where the central directory that a zip's end record at `end` names starts, and how far the
// archive's offsets are off: data before it, such as a self-extractor's, that they may not count.
function directory(bytes: Buffer, end: number): readonly [number, number] | undefined {
	if (end < 0 || end + 22 > bytes.length) return undefined;
	const at = bytes.readUInt32LE(end + 16);
	for (const shift of [0, end - bytes.readUInt32LE(end + 12) - at]) {
		const start = at + shift;
		if (shift >= 0 && start + 4 <= end && bytes.readUInt32LE(start) === CENTRAL) {
			return [start, shift];
		}
	}
	return undefined;
}

// Each end-record signature, last first, in the last 64 KiB, where an end record and comment fit.
function endSignatures(bytes: Buffer): number[] {
	const from = Math.max(0, bytes.length - 0xffff - 22);
	const tail = bytes.subarray(from);
	const found: number[] = [];
	let at = tail.lastIndexOf(ZIP_END);
	while (at >= 0) {
		found.push(from + at);
		at = at > 0 ? tail.lastIndexOf(ZIP_END, at - 1) : -1;
	}
	return found;
}

// Whether a zip64 locator sits just before the end record at `end`, where zip64 readers look for
// one: it leads them to another central directory.
const zip64 = (bytes: Buffer, end: number): boolean =>
	end >= 20 && bytes.readUInt32LE(end - 20) === LOCATOR;

// A zip after other data: an end record in the last 64 KiB naming a central directory, or with a
// zip64 locator before it.
function zipAfterData(bytes: Buffer): boolean {
	return endSignatures(bytes).some(
		(end) => zip64(bytes, end) || directory(bytes, end) !== undefined,
	);
}

// A zip's end record where the format puts it: the last one whose comment reaches the file's end.
function zipEnd(bytes: Buffer): number | undefined {
	return endSignatures(bytes).find(
		(end) => end + 22 <= bytes.length && end + 22 + bytes.readUInt16LE(end + 20) === bytes.length,
	);
}

// The entries that the central directory of the end record at `end` lists, each checked against
// its local header as a streaming reader sees it. Zip64 archives aren't read, nor entries that hold
// more data in all than the archive: they share it, and the scan would inflate it over and over.
// `main`: the end record that ends the file. Its central directory must end where it starts, as
// only zip64 records go between them; and in a file that starts with a local header, local headers
// no entry covers are looked for from the file's start, not its first entry.
function archive(bytes: Buffer, end: number, label: string, state: State, main: boolean): Zip {
	const count = bytes.readUInt16LE(end + 10);
	if (count === 0xffff || bytes.readUInt32LE(end + 16) === 0xffffffff) {
		throw unreadable(label, "zip64");
	}
	// A zip is empty only when it is nothing but its end record: one listing nothing after other
	// data, such as an entry's local header, would hide that data.
	if (count === 0 && end > 0) throw unreadable(label, "lists no entries but holds data");
	if (count === 0) return { entries: [], start: end };
	const found = directory(bytes, end);
	if (found === undefined) throw unreadable(label, "damaged central directory");
	const [first, shift] = found;
	const entries: ZipEntry[] = [];
	const spans: [number, number][] = [];
	let at = first;
	let total = 0;
	for (let number = 1; number <= count; number++) {
		if (bytes.readUInt32LE(at) !== CENTRAL) {
			throw unreadable(label, "damaged central directory");
		}
		const flags = bytes.readUInt16LE(at + 8);
		const method = bytes.readUInt16LE(at + 10);
		const size = bytes.readUInt32LE(at + 20);
		const length = bytes.readUInt32LE(at + 24);
		const local = bytes.readUInt32LE(at + 42) + shift;
		const names = at + 46 + bytes.readUInt16LE(at + 28);
		const name = bytes.toString("latin1", at + 46, names);
		const next = names + bytes.readUInt16LE(at + 30) + bytes.readUInt16LE(at + 32);
		spend(state, next - at);
		at = next;
		if (bytes.readUInt32LE(local) !== LOCAL) {
			throw unreadable(label, `damaged entry ${number}`);
		}
		const start = local + 30 + bytes.readUInt16LE(local + 26) + bytes.readUInt16LE(local + 28);
		if (start + size > bytes.length) throw unreadable(label, `entry ${number} is cut off`);
		// With flag bit 3, the sizes follow the data instead.
		const sizes =
			(flags & 8) !== 0 ||
			(bytes.readUInt32LE(local + 18) === size && bytes.readUInt32LE(local + 22) === length);
		if (
			bytes.readUInt16LE(local + 6) !== flags ||
			bytes.readUInt16LE(local + 8) !== method ||
			!sizes
		) {
			throw unreadable(label, `entry ${number}'s local header doesn't match its listing`);
		}
		total += size;
		if (total > bytes.length) throw unreadable(label, "entries that share data");
		entries.push({ name, flags, method, data: bytes.subarray(start, start + size) });
		spans.push([local, start + size]);
	}
	if (at > end) throw unreadable(label, "damaged central directory");
	if (at + 4 <= end && bytes.readUInt32LE(at) === CENTRAL) {
		throw unreadable(label, "more entries than its end record counts");
	}
	if (main && at < end) {
		throw unreadable(label, "data between its central directory and end record");
	}
	// A local header that no listed entry's data covers: a streaming reader would extract it.
	spans.sort(([a], [b]) => a - b);
	const begins = Math.min(first, spans[0]?.[0] ?? first);
	let covered = main && startsWith(bytes, LOCAL_MAGIC) ? 0 : begins;
	spans.push([first, first]);
	for (const [from, to] of spans) {
		if (from > covered && bytes.subarray(covered, from).includes(ZIP_LOCAL)) {
			throw unreadable(label, "an entry it doesn't list");
		}
		covered = Math.max(covered, to);
	}
	return { entries, start: begins };
}

// A zip's entries: by the end record that ends it, and by any other end record in the last 64 KiB
// that names a central directory, such as one in the comment, which other zip readers may take.
function zipArchives(bytes: Buffer, label: string, state: State): Zip {
	try {
		const ends = endSignatures(bytes);
		if (ends.some((end) => zip64(bytes, end))) throw unreadable(label, "zip64");
		const main = zipEnd(bytes);
		if (main === undefined) throw unreadable(label, "no end record at its end");
		const zip = archive(bytes, main, label, state, true);
		let entries = zip.entries;
		const seen = new Set([directory(bytes, main)?.[0]]);
		for (const end of ends) {
			const found = directory(bytes, end);
			if (found === undefined || seen.has(found[0])) continue;
			seen.add(found[0]);
			entries = entries.concat(archive(bytes, end, label, state, false).entries);
		}
		return { entries, start: zip.start };
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ERR_OUT_OF_RANGE") throw error;
		throw unreadable(label, "damaged");
	}
}

interface TarEntry {
	readonly name: string;
	readonly data: Buffer;
}

// A tar number: octal digits after optional spaces, ending in a NUL or space, or base-256 as GNU
// tar writes large ones.
function tarNumber(bytes: Buffer, from: number, to: number): number | undefined {
	const first = bytes[from] ?? 0;
	if (first === 0x80) {
		let value = 0;
		for (let at = from + 1; at < to; at++) value = value * 256 + (bytes[at] ?? 0);
		return value;
	}
	const digits = /^ *([0-7]+)(?:[ \0]|$)/.exec(bytes.toString("latin1", from, to))?.[1];
	return digits === undefined ? undefined : Number.parseInt(digits, 8);
}

// Whether a tar header starts at `at`: its checksum, the sum of its bytes with the checksum field
// counted as spaces, matches, signed as some old tars summed it, so pre-POSIX headers count too.
function tarHeader(bytes: Buffer, at: number): boolean {
	const stored = at + 512 <= bytes.length ? tarNumber(bytes, at + 148, at + 156) : undefined;
	if (stored === undefined) return false;
	let unsigned = 0;
	let signed = 0;
	for (let index = 0; index < 512; index++) {
		const byte = index >= 148 && index < 156 ? 0x20 : (bytes[at + index] as number);
		unsigned += byte;
		signed += byte < 0x80 ? byte : byte - 256;
	}
	return stored === unsigned || stored === signed;
}

// Whether any block holds a tar header: GNU tar skips blocks that don't, a damaged first one too,
// and extracts from the first that does.
function hasTarHeader(bytes: Buffer): boolean {
	for (let at = 0; at + 512 <= bytes.length; at += 512) {
		if (tarHeader(bytes, at)) return true;
	}
	return false;
}

const BLOCK = Buffer.alloc(512);
// Whether a block, or less, holds only zeros.
const zeros = (bytes: Buffer, from: number, to: number): boolean =>
	from >= to || bytes.compare(BLOCK, 0, to - from, from, to) === 0;

// A pax header's records, "<length> <key>=<value>\n" each.
function paxRecords(data: Buffer, label: string): Map<string, string> {
	const records = new Map<string, string>();
	let at = 0;
	while (at < data.length && data[at] !== 0) {
		const gap = data.indexOf(0x20, at);
		const length = gap < 0 ? "" : data.toString("latin1", at, gap);
		const end = at + Number(length);
		if (!/^[1-9]\d*$/.test(length) || end > data.length || data[end - 1] !== 0x0a) {
			throw unreadable(label, "a damaged pax header");
		}
		const equals = data.indexOf(0x3d, gap);
		if (equals < 0 || equals >= end) throw unreadable(label, "a damaged pax header");
		records.set(data.toString("utf8", gap + 1, equals), data.toString("utf8", equals + 1, end - 1));
		at = end;
	}
	return records;
}

// Links, devices, directories and FIFOs, which hold no data.
const DATALESS = new Set(["1", "2", "3", "4", "5", "6"]);

// The entries of a tar archive up to `end` that hold data, with their names: pax sizes and paths
// and GNU long names applied, zero blocks passed over as tar --ignore-zeros does. A block that
// isn't a header, data that runs past the end, or data that isn't laid out plainly fails it.
function tarEntries(bytes: Buffer, end: number, label: string): TarEntry[] {
	const entries: TarEntry[] = [];
	let next: { size?: number | undefined; name?: string | undefined } = {};
	let at = 0;
	while (at + 512 <= end) {
		if (zeros(bytes, at, at + 512)) {
			at += 512;
			continue;
		}
		if (!tarHeader(bytes, at)) throw unreadable(label, `a damaged header at byte ${at}`);
		const type = String.fromCharCode(bytes[at + 156] as number);
		const meta = type === "x" || type === "g" || type === "L" || type === "K";
		const size = (meta ? undefined : next.size) ?? tarNumber(bytes, at + 124, at + 136);
		if (size === undefined) throw unreadable(label, `a damaged size at byte ${at}`);
		const start = at + 512;
		if (start + size > end) throw unreadable(label, `an entry cut off at byte ${at}`);
		const data = bytes.subarray(start, start + size);
		const name = next.name ?? bytes.toString("latin1", at, at + 100).replace(/\0.*$/s, "");
		if (!meta) next = {};
		at = start + Math.ceil(size / 512) * 512;
		if (type === "x" || type === "g") {
			const records = paxRecords(data, label);
			const paxSize = records.get("size");
			if ([...records.keys()].some((key) => key.startsWith("GNU.sparse."))) {
				throw unreadable(label, "a sparse entry");
			}
			if (paxSize !== undefined && (type === "g" || !/^\d+$/.test(paxSize))) {
				throw unreadable(label, "a damaged pax header");
			}
			if (type === "x") {
				next = {
					size: paxSize === undefined ? undefined : Number(paxSize),
					name: records.get("path"),
				};
			}
		} else if (type === "L") {
			next.name = data.toString("latin1").replace(/\0.*$/s, "");
		} else if (type === "S" || type === "M") {
			throw unreadable(label, type === "S" ? "a sparse entry" : "an entry from another volume");
		} else if (DATALESS.has(type)) {
			if (size !== 0) throw unreadable(label, `a type ${type} entry that holds data`);
		} else if (type !== "K") {
			entries.push({ name, data });
		}
	}
	if (!zeros(bytes, at, end)) throw unreadable(label, "a partial block at its end");
	return entries;
}

const SPACE = 1;
const DELIMITER = 2;
// PDF white space and delimiters; any other byte goes on a name, number or keyword.
const KIND = new Uint8Array(256);
for (const byte of [0x00, 0x09, 0x0a, 0x0c, 0x0d, 0x20]) KIND[byte] = SPACE;
for (const char of "()<>[]{}/%") KIND[char.charCodeAt(0)] = DELIMITER;
const regular = (byte: number | undefined): boolean => byte !== undefined && KIND[byte] === 0;
const space = (byte: number | undefined): boolean => byte !== undefined && KIND[byte] === SPACE;
const digit = (byte: number | undefined): boolean =>
	byte !== undefined && byte >= 0x30 && byte <= 0x39;

function hexDigit(byte: number | undefined): number {
	if (digit(byte)) return (byte as number) - 0x30;
	const lower = (byte ?? 0) | 0x20;
	return lower >= 0x61 && lower <= 0x66 ? lower - 0x57 : -1;
}

interface PdfName {
	readonly name: string;
}
interface PdfKeyword {
	readonly keyword: string;
}
// Indirect references, which point at another object, and strings, which the scan reads as text.
const REF = Symbol("reference");
const STRING = Symbol("string");
type PdfValue =
	| number
	| PdfName
	| PdfKeyword
	| PdfValue[]
	| Map<string, PdfValue>
	| typeof REF
	| typeof STRING;
type PdfDictionary = Map<string, PdfValue>;
const DICTIONARY_END = Symbol(">>");
const ARRAY_END = Symbol("]");
type Token = PdfValue | typeof DICTIONARY_END | typeof ARRAY_END | undefined;

const isName = (value: unknown): value is PdfName =>
	typeof value === "object" && value !== null && "name" in value;
const isKeyword = (value: unknown, keyword: string): boolean =>
	typeof value === "object" && value !== null && "keyword" in value && value.keyword === keyword;

interface Cursor {
	readonly bytes: Buffer;
	at: number;
}

const NESTING = 64;
const NUMBER = /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)$/;

// Past white space and comments.
function skip(cursor: Cursor): void {
	const { bytes } = cursor;
	while (cursor.at < bytes.length) {
		const byte = bytes[cursor.at];
		if (space(byte)) cursor.at++;
		else if (byte !== 0x25) return;
		else {
			while (cursor.at < bytes.length && bytes[cursor.at] !== 0x0a && bytes[cursor.at] !== 0x0d) {
				cursor.at++;
			}
		}
	}
}

function word(cursor: Cursor): string {
	const from = cursor.at;
	while (regular(cursor.bytes[cursor.at])) cursor.at++;
	return cursor.bytes.toString("latin1", from, cursor.at);
}

// A name at its "/", with #xx escapes decoded as readers decode them.
function name(cursor: Cursor): PdfName {
	const { bytes } = cursor;
	let text = "";
	for (cursor.at++; regular(bytes[cursor.at]); cursor.at++) {
		const high = bytes[cursor.at] === 0x23 ? hexDigit(bytes[cursor.at + 1]) : -1;
		const low = high < 0 ? -1 : hexDigit(bytes[cursor.at + 2]);
		if (low < 0) {
			text += String.fromCharCode(bytes[cursor.at] as number);
		} else {
			text += String.fromCharCode(high * 16 + low);
			cursor.at += 2;
		}
	}
	return { name: text };
}

// A literal string at its "(", nested parentheses and escapes included.
function literal(cursor: Cursor): boolean {
	const { bytes } = cursor;
	let depth = 0;
	for (; cursor.at < bytes.length; cursor.at++) {
		const byte = bytes[cursor.at];
		if (byte === 0x5c) cursor.at++;
		else if (byte === 0x28) depth++;
		else if (byte === 0x29 && --depth === 0) {
			cursor.at++;
			return true;
		}
	}
	cursor.at = bytes.length;
	return false;
}

// The next object, leniently as readers parse one; undefined at the end of the data.
function value(cursor: Cursor, depth: number): Token {
	skip(cursor);
	const { bytes } = cursor;
	const byte = bytes[cursor.at];
	if (byte === undefined || depth > NESTING) return undefined;
	const pair = bytes[cursor.at + 1] === byte;
	if (byte === 0x2f) return name(cursor);
	if (byte === 0x28) return literal(cursor) ? STRING : undefined;
	if (byte === 0x5b || byte === 0x5d || (pair && (byte === 0x3c || byte === 0x3e))) {
		cursor.at += byte === 0x5b || byte === 0x5d ? 1 : 2;
		if (byte === 0x5b) return array(cursor, depth + 1);
		if (byte === 0x3c) return dictionary(cursor, depth + 1);
		return byte === 0x5d ? ARRAY_END : DICTIONARY_END;
	}
	if (byte === 0x3c) {
		const end = bytes.indexOf(0x3e, cursor.at);
		cursor.at = end < 0 ? bytes.length : end + 1;
		return end < 0 ? undefined : STRING;
	}
	if (!regular(byte)) {
		cursor.at++;
		return STRING;
	}
	const token = word(cursor);
	return NUMBER.test(token) ? Number(token) : { keyword: token };
}

function array(cursor: Cursor, depth: number): PdfValue[] | undefined {
	const items: PdfValue[] = [];
	for (;;) {
		const item = value(cursor, depth);
		if (item === undefined) return undefined;
		if (item === ARRAY_END) return items;
		const [number, generation] = items.slice(-2);
		if (isKeyword(item, "R") && typeof number === "number" && typeof generation === "number") {
			items.splice(-2, 2, REF);
		} else {
			items.push(item === DICTIONARY_END ? STRING : item);
		}
	}
}

function dictionary(cursor: Cursor, depth: number): PdfDictionary | undefined {
	const entries: PdfDictionary = new Map();
	for (;;) {
		const key = value(cursor, depth);
		if (key === undefined) return undefined;
		if (key === DICTIONARY_END) return entries;
		if (!isName(key)) continue;
		let item = value(cursor, depth);
		if (item === undefined) return undefined;
		if (item === DICTIONARY_END) return entries;
		if (typeof item === "number") {
			// "5 0 R" points at object 5.
			const after = cursor.at;
			skip(cursor);
			if (NUMBER.test(word(cursor))) {
				skip(cursor);
				if (word(cursor) === "R") item = REF;
			}
			if (item !== REF) cursor.at = after;
		}
		entries.set(key.name, item === ARRAY_END ? STRING : item);
	}
}

// Whether "obj" at `at` ends an object's header, "<number> <generation> obj"; readers split
// "0obj" into a number and a keyword too.
function isHeader(bytes: Buffer, at: number): boolean {
	if (regular(bytes[at + 3])) return false;
	let before = at - 1;
	while (space(bytes[before])) before--;
	for (let field = 0; field < 2; field++) {
		if (!digit(bytes[before])) return false;
		while (digit(bytes[before])) before--;
		if (field === 0 && !space(bytes[before])) return false;
		while (field === 0 && space(bytes[before])) before--;
	}
	return !regular(bytes[before]);
}

interface StreamObject {
	readonly dict: PdfDictionary;
	// Where its stream keyword starts.
	readonly keyword: number;
}

// The dictionary of the object whose header ends with "obj" at `obj`, if a stream keyword follows.
function streamObject(bytes: Buffer, obj: number, state: State): StreamObject | undefined {
	const cursor = { bytes, at: obj + 3 };
	const dict = value(cursor, 0);
	skip(cursor);
	spend(state, cursor.at - obj);
	const { at } = cursor;
	const keyword = bytes.toString("latin1", at, at + 6) === "stream" && !regular(bytes[at + 6]);
	return dict instanceof Map && keyword ? { dict, keyword: at } : undefined;
}

// Whether a stream keyword that ends no object's dictionary still sits where one would, white
// space aside: right after ">>", or, in a PDF, after a comment, which may follow a dictionary.
function looksLikeStream(bytes: Buffer, keyword: number, pdf: boolean, state: State): boolean {
	let at = keyword - 1;
	while (space(bytes[at])) at--;
	if (bytes[at] === 0x3e && bytes[at - 1] === 0x3e) return true;
	if (!pdf) return false;
	let line = at;
	while (line >= 0 && bytes[line] !== 0x0a && bytes[line] !== 0x0d) line--;
	spend(state, at - line);
	return bytes.subarray(line + 1, at + 1).includes(0x25);
}

// Where a stream's data starts: after the end of line that ends its keyword's line, spaces or
// tabs before it allowed.
function dataStart(bytes: Buffer, keyword: number): number | undefined {
	let at = keyword + 6;
	while (bytes[at] === 0x20 || bytes[at] === 0x09) at++;
	if (bytes[at] === 0x0a) return at + 1;
	if (bytes[at] === 0x0d) return bytes[at + 1] === 0x0a ? at + 2 : at + 1;
	return undefined;
}

// Whether a PDF names /Encrypt, its #xx escapes decoded as readers decode them.
function namesEncrypt(bytes: Buffer): boolean {
	const cursor = { bytes, at: 0 };
	for (let at = bytes.indexOf(0x2f); at >= 0; at = bytes.indexOf(0x2f, cursor.at)) {
		cursor.at = at;
		if (name(cursor).name === "Encrypt") return true;
	}
	return false;
}

// ASCIIHexDecode: hex digits and white space, up to ">" or the data's end.
function asciiHex(data: Buffer, label: string, state: State): Decoded {
	let end = 0;
	let digits = 0;
	for (; end < data.length && data[end] !== 0x3e; end++) {
		if (hexDigit(data[end]) >= 0) digits++;
		else if (!space(data[end])) throw unreadable(label, "ASCIIHexDecode data that isn't hex");
	}
	take(state, Math.ceil(digits / 2));
	const out = Buffer.alloc(Math.ceil(digits / 2));
	let count = 0;
	for (let at = 0; at < end; at++) {
		const nibble = hexDigit(data[at]);
		if (nibble < 0) continue;
		const index = count >> 1;
		out[index] = count % 2 === 0 ? nibble << 4 : (out[index] as number) | nibble;
		count++;
	}
	return { out, used: Math.min(end + 1, data.length) };
}

// ASCII85Decode: five characters from "!" to "u" for each four bytes, "z" for four zeros, white
// space between, after an optional "<~", up to "~>" or the data's end.
function ascii85(data: Buffer, label: string, state: State): Decoded {
	let begin = 0;
	while (space(data[begin])) begin++;
	if (data[begin] === 0x3c && data[begin + 1] === 0x7e) begin += 2;
	let end = begin;
	let length = 0;
	let group = 0;
	for (; end < data.length && data[end] !== 0x7e; end++) {
		const byte = data[end] as number;
		if (space(byte)) continue;
		if (byte === 0x7a && group === 0) {
			length += 4;
		} else if (byte >= 0x21 && byte <= 0x75) {
			group = (group + 1) % 5;
			if (group === 0) length += 4;
		} else {
			throw unreadable(label, "ASCII85Decode data that isn't ASCII85");
		}
	}
	if (group > 1) length += group - 1;
	take(state, length);
	const out = Buffer.alloc(length);
	let at = 0;
	let tuple = 0;
	let count = 0;
	for (let index = begin; index < end; index++) {
		const byte = data[index] as number;
		if (space(byte)) continue;
		if (byte === 0x7a && count === 0) {
			at += 4;
			continue;
		}
		tuple = tuple * 85 + byte - 0x21;
		count++;
		if (count === 5) {
			out.writeUInt32BE(tuple >>> 0, at);
			at += 4;
			tuple = 0;
			count = 0;
		}
	}
	if (count > 1) {
		for (let pad = count; pad < 5; pad++) tuple = tuple * 85 + 84;
		const last = Buffer.alloc(4);
		last.writeUInt32BE(tuple >>> 0);
		last.copy(out, at, 0, count - 1);
	}
	const used = end < data.length ? end + (data[end + 1] === 0x3e ? 2 : 1) : data.length;
	return { out, used };
}

// A zlib header (RFC 1950): deflate, a window of at most 32 KiB, no preset dictionary.
function isZlib(data: Buffer): boolean {
	const [cmf = 0, flg = 0] = data;
	return (cmf & 0x0f) === 8 && cmf >> 4 <= 7 && (flg & 0x20) === 0 && ((cmf << 8) | flg) % 31 === 0;
}

function paeth(left: number, up: number, corner: number): number {
	const estimate = left + up - corner;
	const a = Math.abs(estimate - left);
	const b = Math.abs(estimate - up);
	const c = Math.abs(estimate - corner);
	if (a <= b && a <= c) return left;
	return b <= c ? up : corner;
}

// Undoes a PNG predictor in place: each row of `row` bytes starts with its filter type.
function png(data: Buffer, pixel: number, row: number, label: string): Buffer {
	let out = 0;
	for (let at = 0; at < data.length; at += row + 1) {
		const type = data[at] as number;
		if (type > 4) throw unreadable(label, `PNG predictor row type ${type}`);
		const begin = out;
		const stop = Math.min(at + 1 + row, data.length);
		for (let index = at + 1; index < stop; index++) {
			const inner = out - begin >= pixel;
			const left = inner ? (data[out - pixel] as number) : 0;
			const up = begin > 0 ? (data[out - row] as number) : 0;
			let guess = 0;
			if (type === 1) guess = left;
			else if (type === 2) guess = up;
			else if (type === 3) guess = (left + up) >> 1;
			else if (type === 4) {
				guess = paeth(left, up, begin > 0 && inner ? (data[out - row - pixel] as number) : 0);
			}
			data[out] = ((data[index] as number) + guess) & 0xff;
			out++;
		}
	}
	return data.subarray(0, out);
}

// Undoes TIFF predictor 2 at 8 bits per component in place: each byte adds the one a pixel back.
function tiff(data: Buffer, colors: number, row: number): Buffer {
	for (let start = 0; start < data.length; start += row) {
		const stop = Math.min(start + row, data.length);
		for (let at = start + colors; at < stop; at++) {
			data[at] = ((data[at] as number) + (data[at - colors] as number)) & 0xff;
		}
	}
	return data;
}

function parameter(
	parms: PdfDictionary | undefined,
	key: string,
	fallback: number,
	label: string,
): number {
	const given = parms?.get(key);
	if (given === undefined || isKeyword(given, "null")) return fallback;
	if (typeof given !== "number" || !Number.isInteger(given)) {
		throw unreadable(label, `a /${key} that isn't a whole number`);
	}
	return given;
}

// Undoes a FlateDecode predictor: TIFF predictor 2 at 8 bits per component, or PNG predictors.
function unpredict(data: Buffer, parms: PdfDictionary | undefined, label: string): Buffer {
	const predictor = parameter(parms, "Predictor", 1, label);
	if (predictor <= 1) return data;
	const colors = parameter(parms, "Colors", 1, label);
	const bits = parameter(parms, "BitsPerComponent", 8, label);
	const columns = parameter(parms, "Columns", 1, label);
	if (colors < 1 || columns < 1 || ![1, 2, 4, 8, 16].includes(bits)) {
		const terms = `${colors} colors, ${bits} bits and ${columns} columns`;
		throw unreadable(label, `predictor ${predictor} with ${terms}`);
	}
	if (predictor === 2 && bits === 8) return tiff(data, colors, columns * colors);
	if (predictor >= 10 && predictor <= 15) {
		return png(
			data,
			Math.ceil((colors * bits) / 8),
			Math.ceil((columns * colors * bits) / 8),
			label,
		);
	}
	throw unreadable(
		label,
		predictor === 2 ? `TIFF predictor at ${bits} bits` : `predictor ${predictor}`,
	);
}

// FlateDecode: a zlib stream, read to its end. Like readers, it doesn't check the stream's
// checksum, which some writers leave out.
function flate(
	data: Buffer,
	parms: PdfDictionary | undefined,
	label: string,
	state: State,
): Decoded {
	if (!isZlib(data)) throw unreadable(label, "FlateDecode data that isn't zlib");
	const { out, used } = decompress(inflateRaw, data.subarray(2), label, state);
	const end = 2 + used;
	return { out: unpredict(out, parms, label), used: end + Math.min(4, data.length - end) };
}

type Decoder = (
	data: Buffer,
	parms: PdfDictionary | undefined,
	label: string,
	state: State,
) => Decoded;
const DECODERS: ReadonlyMap<string, Decoder> = new Map<string, Decoder>([
	["FlateDecode", flate],
	["Fl", flate],
	["ASCIIHexDecode", (data, _, label, state) => asciiHex(data, label, state)],
	["AHx", (data, _, label, state) => asciiHex(data, label, state)],
	["ASCII85Decode", (data, _, label, state) => ascii85(data, label, state)],
	["A85", (data, _, label, state) => ascii85(data, label, state)],
]);
// Image data, which the scan leaves unread.
const IMAGES = new Set(["DCTDecode", "DCT", "JPXDecode", "JBIG2Decode", "CCITTFaxDecode", "CCF"]);

interface Filter {
	readonly name: string;
	readonly parms: PdfDictionary | undefined;
}

// A stream's filters in order, each with its parameters: one decoded here or image-only, or the
// stream fails.
function filters(dict: PdfDictionary, label: string): Filter[] {
	// Some readers take /F and /DP as the filters too; others read the data from another file.
	if (dict.has("F") || dict.has("DP")) throw unreadable(label, "an /F or /DP entry");
	const filter = dict.get("Filter");
	const parms = dict.get("DecodeParms");
	const list = isName(filter) || filter === REF ? [filter] : Array.isArray(filter) ? filter : [];
	return list.map((item, index) => {
		const given = Array.isArray(filter) ? (Array.isArray(parms) ? parms[index] : undefined) : parms;
		if (item === REF || given === REF) throw unreadable(label, "filters in another object");
		if (!isName(item)) throw unreadable(label, "a filter that isn't a name");
		if (!DECODERS.has(item.name) && !IMAGES.has(item.name)) {
			throw unreadable(label, `filter ${item.name}`);
		}
		return { name: item.name, parms: given instanceof Map ? given : undefined };
	});
}

// A stream's data decoded through its filters, up to any image-only one: each decoder's own end,
// not /Length or an "endstream", marks where its data ends. Undefined if none applies.
function readStream(
	bytes: Buffer,
	dict: PdfDictionary,
	keyword: number,
	label: string,
	state: State,
): Buffer | undefined {
	const chain = filters(dict, label);
	if (chain.length === 0 || IMAGES.has(chain[0]?.name ?? "")) return undefined;
	const start = dataStart(bytes, keyword);
	if (start === undefined) throw unreadable(label, "no end of line after its stream keyword");
	let data = bytes.subarray(start);
	for (const [index, { name: filter, parms }] of chain.entries()) {
		if (IMAGES.has(filter)) break;
		const { out, used } = (DECODERS.get(filter) as Decoder)(data, parms, label, state);
		spend(state, used);
		// What a decoder leaves of the previous one's output would be read by no one.
		if (index > 0 && !data.subarray(used).every(space)) {
			throw unreadable(label, `data after the end of its ${filter} data`);
		}
		data = out;
	}
	return data;
}

// The streams of a PDF, wherever its header is, if it has one. Every object is parsed, as a reader
// may reach any of them through the cross-reference table, and each stream keyword that ends an
// object's dictionary is read. One that ends no dictionary it can parse, or two, fails the file.
function readPdf(
	bytes: Buffer,
	named: boolean,
	label: (name: string) => string,
	add: (data: Buffer, name: string) => void,
	state: State,
): void {
	const headed = named || bytes.includes("%PDF-");
	const encrypted = namesEncrypt(bytes);
	if (encrypted && headed) throw unreadable(label("the PDF"), "encrypted");
	// Each stream keyword that ends an object's dictionary, with it; null where two objects' do.
	const dictionaries = new Map<number, PdfDictionary | null>();
	let obj = bytes.indexOf("obj");
	let count = 0;
	for (let at = bytes.indexOf("stream"); at >= 0; at = bytes.indexOf("stream", at + 6)) {
		if (regular(bytes[at - 1]) || regular(bytes[at + 6])) continue;
		for (; obj >= 0 && obj < at; obj = bytes.indexOf("obj", obj + 3)) {
			const object = isHeader(bytes, obj) ? streamObject(bytes, obj, state) : undefined;
			if (object === undefined) continue;
			dictionaries.set(object.keyword, dictionaries.has(object.keyword) ? null : object.dict);
		}
		const dict = dictionaries.get(at);
		if (dict === undefined && !looksLikeStream(bytes, at, headed || count > 0, state)) continue;
		if (!dict) throw unreadable(label("the PDF"), "a stream it can't parse");
		count++;
		if (encrypted) throw unreadable(label("the PDF"), "encrypted");
		const stream = `PDF stream ${count}`;
		const output = readStream(bytes, dict, at, label(stream), state);
		if (output !== undefined) add(output, stream);
	}
}

const pdfName = (name: string): boolean => /\.pdf$/i.test(name);

// `named`: the file's name says it is a PDF.
function open(
	bytes: Buffer,
	label: string | undefined,
	depth: number,
	state: State,
	named = false,
): void {
	const gzip = startsWith(bytes, GZIP);
	const zstd = isZstd(bytes);
	const zip = startsWith(bytes, LOCAL_MAGIC) || startsWith(bytes, END_MAGIC);
	// GNU tar reads what it doesn't decompress, a zip too, as a tar; the walk fails at the first
	// block that is neither zeros nor a header.
	const tar = !gzip && !zstd && hasTarHeader(bytes);
	// Readers take a PDF's header anywhere, or do without one, so any file named one and any binary
	// file is looked through for streams. A PDF holds binary data, so text that only quotes PDF
	// syntax, as code may, is one only by its name.
	const pdf = !gzip && !zstd && !zip && !tar && (named || !isUtf8(bytes));
	// A zip after other data: after a gzip, zstd or tar stream, one whose end record ends the file,
	// which zip readers find there; after anything else, one an end record in the last 64 KiB names.
	const appended =
		!zip && (gzip || zstd || tar ? zipEnd(bytes) !== undefined : zipAfterData(bytes));
	if (!gzip && !zstd && !zip && !tar && !pdf && !appended) return;
	if (depth > state.caps.depth) {
		throw new Refusal(
			`nested over ${state.caps.depth} levels deep, too deep to scan; keep it out of the repository`,
		);
	}
	const at = (name: string): string => (label === undefined ? name : `${name} in ${label}`);
	const add = (data: Buffer, name: string, file = ""): void => {
		if (state.parts.length >= state.caps.parts) {
			throw new Refusal(
				`holds over ${state.caps.parts} compressed streams and archive entries, too many to scan; keep it out of the repository`,
			);
		}
		state.parts.push({ bytes: data, label: at(name) });
		open(data, at(name), depth + 1, state, pdfName(file));
	};
	const archive = zip || appended ? zipArchives(bytes, at("the zip archive"), state) : undefined;
	const end = archive === undefined || zip ? bytes.length : archive.start;
	if (gzip) {
		add(gunzipAll(bytes, end, at("the gzip stream"), state), "the gzip stream");
	} else if (zstd) {
		add(unzstdAll(bytes, end, at("the zstd stream"), state), "the zstd stream");
	} else if (tar) {
		// The archive's own text is read as it is; only compressed files in it need opening.
		for (const [index, entry] of tarEntries(bytes, end, at("the tar archive")).entries()) {
			open(entry.data, at(`tar entry ${index + 1}`), depth + 1, state, pdfName(entry.name));
		}
	} else if (pdf) {
		readPdf(bytes, named, at, add, state);
	}
	for (const [index, { name: file, flags, method, data }] of (archive?.entries ?? []).entries()) {
		const name = `zip entry ${index + 1}`;
		if (flags & 1) throw unreadable(at(name), "encrypted");
		if (method !== 0 && method !== 8) throw unreadable(at(name), `compression method ${method}`);
		if (data.length === 0) continue;
		if (method === 0) {
			take(state, data.length);
			add(data, name, file);
			continue;
		}
		// Each entry inflates to the end of its data and no further.
		const { out, used } = decompress(inflateRaw, data, at(name), state);
		if (used !== data.length) throw unreadable(at(name), "data after its deflate stream");
		add(out, name, file);
	}
}

// The decompressed parts of a file, outermost first, and why any more couldn't be read. A `file`
// path ending in .pdf makes even text a PDF.
export function unpack(bytes: Buffer, caps: Caps = CAPS, file = ""): Unpacked {
	const limit = Math.min(caps.max, Math.max(caps.min, caps.ratio * bytes.length));
	const state: State = { caps, limit, left: limit, work: limit, parts: [] };
	try {
		open(bytes, undefined, 1, state, pdfName(file));
	} catch (error) {
		if (!(error instanceof Refusal)) throw error;
		return { parts: state.parts, problem: error.message };
	}
	return { parts: state.parts };
}
