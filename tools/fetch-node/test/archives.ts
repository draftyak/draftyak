import { crc32, deflateRawSync } from "node:zlib";

export interface TarEntry {
	readonly name: string;
	readonly type?: "file" | "dir" | "symlink" | "hardlink" | "fifo";
	readonly data?: string;
	readonly link?: string;
	readonly mode?: number;
	/** Where the name goes: the header, a GNU ././@LongLink entry, a pax path or the ustar prefix. */
	readonly via?: "header" | "gnu" | "pax" | "prefix";
	/** GNU magic, whose prefix bytes are not a prefix: they get junk to prove it. */
	readonly gnu?: boolean;
	/** The size goes in a pax record, and the header says 0. */
	readonly paxSize?: boolean;
}

const flags = { file: "0", dir: "5", symlink: "2", hardlink: "1", fifo: "6" } as const;

function header(entry: TarEntry, name: string, flag: string, size: number, prefix = ""): Buffer {
	const block = Buffer.alloc(512);
	const octal = (value: number, width: number) => `${value.toString(8).padStart(width, "0")}\0`;
	block.write(name, 0, 100);
	block.write(`${octal(entry.mode ?? 0o644, 7)}${octal(0, 7)}${octal(0, 7)}`, 100);
	block.write(`${octal(size, 11)}${octal(0, 11)}        ${flag}`, 124);
	block.write(entry.link ?? "", 157, 100);
	block.write(entry.gnu ? "ustar  \0" : "ustar\u000000", 257);
	block.write(entry.gnu ? "junk/" : prefix, 345, 155);
	const sum = block.reduce((total, byte) => total + byte, 0);
	block.write(`${octal(sum, 6)} `, 148);
	return block;
}

const padded = (body: Buffer) => [body, Buffer.alloc((512 - (body.length % 512)) % 512)];

function paxRecord(key: string, value: string): Buffer {
	const text = ` ${key}=${value}\n`;
	const size = Buffer.byteLength(text);
	let length = size + String(size).length;
	if (String(length).length > String(size).length) length = size + String(length).length;
	return Buffer.from(`${length}${text}`);
}

/** An uncompressed tar archive laid out the way GNU tar and pax writers lay out headers. */
export function tar(entries: readonly TarEntry[]): Buffer {
	const blocks: Buffer[] = [];
	for (const entry of entries) {
		const { name, type = "file", via = "header" } = entry;
		const body = Buffer.from(type === "file" ? (entry.data ?? "") : "");
		const cut = name.lastIndexOf("/");
		const records = Buffer.concat([
			...(via === "pax" ? [paxRecord("path", name)] : []),
			...(entry.paxSize ? [paxRecord("size", String(body.length))] : []),
		]);
		if (via === "gnu") {
			const long = Buffer.from(`${name}\0`);
			blocks.push(header(entry, "././@LongLink", "L", long.length), ...padded(long));
		} else if (records.length > 0) {
			blocks.push(header(entry, "PaxHeaders/entry", "x", records.length), ...padded(records));
		}
		const [stored, prefix] = via === "prefix" ? [name.slice(cut + 1), name.slice(0, cut)] : [name];
		const size = entry.paxSize ? 0 : body.length;
		blocks.push(header(entry, stored.slice(0, 100), flags[type], size, prefix), ...padded(body));
	}
	return Buffer.concat([...blocks, Buffer.alloc(1024)]);
}

export interface ZipEntry {
	readonly name: string;
	readonly data?: string;
	/** 0 stores, 8 deflates (the default for files). */
	readonly method?: number;
	/** Made on Unix, with this mode in the external attributes. */
	readonly unixMode?: number;
	/** A different name in the local header than in the central directory. */
	readonly localName?: string;
	readonly flags?: number;
	readonly crc?: number;
}

/** Little-endian fields; each digit of the layout is a field width (2 or 4 bytes). */
function pack(layout: string, ...values: number[]): Buffer {
	const widths = [...layout].map(Number);
	const buffer = Buffer.alloc(widths.reduce((sum, width) => sum + width, 0));
	let at = 0;
	for (const [index, width] of widths.entries()) {
		const value = values[index] ?? 0;
		at = width === 2 ? buffer.writeUInt16LE(value, at) : buffer.writeUInt32LE(value, at);
	}
	return buffer;
}

/** A zip archive with a central directory and no zip64 records. */
export function zip(entries: readonly ZipEntry[]): Buffer {
	const parts: Buffer[] = [];
	const directory: Buffer[] = [];
	let offset = 0;
	for (const entry of entries) {
		const data = Buffer.from(entry.data ?? "");
		const method = entry.method ?? (entry.name.endsWith("/") ? 0 : 8);
		const packed = method === 8 ? deflateRawSync(data) : data;
		const name = Buffer.from(entry.name);
		const localName = Buffer.from(entry.localName ?? entry.name);
		const crc = entry.crc ?? crc32(data);
		// version needed, flags, method, DOS time and date (1980-01-01), CRC-32 and both sizes
		const common = [20, entry.flags ?? 0x800, method, 0x210000, crc, packed.length, data.length];
		const local = pack("4222444422", 0x04034b50, ...common, localName.length, 0);
		const unix = entry.unixMode;
		const dos = entry.name.endsWith("/") ? 0x10 : 0x20;
		const [madeBy, attributes] = unix === undefined ? [20, dos] : [0x0314, unix * 0x10000];
		const rest = [name.length, 0, 0, 0, 0, attributes, offset];
		directory.push(pack("4222244442222244", 0x02014b50, madeBy, ...common, ...rest), name);
		parts.push(local, localName, packed);
		offset += local.length + localName.length + packed.length;
	}
	const listing = Buffer.concat(directory);
	const end = [0, 0, entries.length, entries.length, listing.length, offset, 0];
	return Buffer.concat([...parts, listing, pack("42222442", 0x06054b50, ...end)]);
}
