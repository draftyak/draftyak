import { createHash } from "node:crypto";
import { constants, crc32, deflateRawSync, deflateSync } from "node:zlib";

export interface Entry {
	readonly name: string;
	readonly data: string | Uint8Array;
	// 8 (deflate) by default; 0 stores it.
	readonly method?: number;
	readonly flags?: number;
	// Sizes and CRC in a data descriptor after the data (flag bit 3), as streaming writers put them.
	readonly descriptor?: boolean;
	// A tar entry's type flag, "0" by default.
	readonly type?: string;
}

// A zip archive as zip tools write one: each local header and its data, then the central directory,
// the end record and the archive's comment.
export function zip(entries: readonly Entry[], comment: Uint8Array = Buffer.alloc(0)): Buffer {
	const locals: Buffer[] = [];
	const central: Buffer[] = [];
	let offset = 0;
	for (const { name, data, method = 8, flags: given = 0, descriptor = false } of entries) {
		const flags = given | (descriptor ? 8 : 0);
		const raw = Buffer.from(data);
		const stored = method === 8 ? deflateRawSync(raw) : raw;
		const path = Buffer.from(name);
		const local = Buffer.alloc(30);
		local.writeUInt32LE(0x04034b50, 0);
		local.writeUInt16LE(20, 4);
		local.writeUInt16LE(flags, 6);
		local.writeUInt16LE(method, 8);
		if (!descriptor) {
			local.writeUInt32LE(crc32(raw), 14);
			local.writeUInt32LE(stored.length, 18);
			local.writeUInt32LE(raw.length, 22);
		}
		local.writeUInt16LE(path.length, 26);
		const header = Buffer.alloc(46);
		header.writeUInt32LE(0x02014b50, 0);
		header.writeUInt16LE(20, 4);
		header.writeUInt16LE(20, 6);
		header.writeUInt16LE(flags, 8);
		header.writeUInt16LE(method, 10);
		header.writeUInt32LE(crc32(raw), 16);
		header.writeUInt32LE(stored.length, 20);
		header.writeUInt32LE(raw.length, 24);
		header.writeUInt16LE(path.length, 28);
		header.writeUInt32LE(offset, 42);
		const after = Buffer.alloc(descriptor ? 16 : 0);
		if (descriptor) {
			after.writeUInt32LE(0x08074b50, 0);
			after.writeUInt32LE(crc32(raw), 4);
			after.writeUInt32LE(stored.length, 8);
			after.writeUInt32LE(raw.length, 12);
		}
		locals.push(local, path, stored, after);
		central.push(header, path);
		offset += local.length + path.length + stored.length + after.length;
	}
	const directory = Buffer.concat(central);
	const end = Buffer.alloc(22);
	end.writeUInt32LE(0x06054b50, 0);
	end.writeUInt16LE(entries.length, 8);
	end.writeUInt16LE(entries.length, 10);
	end.writeUInt32LE(directory.length, 12);
	end.writeUInt32LE(offset, 16);
	end.writeUInt16LE(comment.length, 20);
	return Buffer.concat([...locals, directory, end, comment]);
}

// A zip that lists its one entry `count` times, each listing pointing at the same data.
export function repeated(entry: Entry, count: number): Buffer {
	const single = zip([entry]);
	const end = single.length - 22;
	const listing = single.subarray(single.readUInt32LE(end + 16), end);
	const tail = Buffer.from(single.subarray(end));
	tail.writeUInt16LE(count, 8);
	tail.writeUInt16LE(count, 10);
	tail.writeUInt32LE(listing.length * count, 12);
	const more = Array.from({ length: count - 1 }, () => listing);
	return Buffer.concat([single.subarray(0, end), ...more, tail]);
}

// A zip after other data, such as a self-extractor's, with offsets that count that data, as
// `zip -A` leaves them, or that don't.
export function afterData(data: Buffer, archive: Buffer, counted: boolean): Buffer {
	const whole = Buffer.concat([data, archive]);
	if (!counted) return whole;
	const end = whole.length - 22;
	let at = whole.readUInt32LE(end + 16) + data.length;
	whole.writeUInt32LE(at, end + 16);
	for (let index = 0; index < whole.readUInt16LE(end + 10); index++) {
		whole.writeUInt32LE(whole.readUInt32LE(at + 42) + data.length, at + 42);
		at +=
			46 + whole.readUInt16LE(at + 28) + whole.readUInt16LE(at + 30) + whole.readUInt16LE(at + 32);
	}
	return whole;
}

export interface TarHeader {
	// "0" by default.
	readonly type?: string;
	// false: a pre-POSIX (V7) header, without the ustar magic.
	readonly ustar?: boolean;
	// The size field's 12 bytes, if not the size in octal.
	readonly sizeField?: Uint8Array;
	// A checksum of signed bytes, as some old tars summed them.
	readonly signed?: boolean;
}

// One tar header block, its checksum filled in.
export function tarHeader(
	name: string,
	size: number,
	{ type = "0", ustar = true, sizeField, signed = false }: TarHeader = {},
): Buffer {
	const header = Buffer.alloc(512);
	header.write(name, 0);
	header.write("0000644", 100);
	header.write("0000000", 108);
	header.write("0000000", 116);
	if (sizeField === undefined) header.write(size.toString(8).padStart(11, "0"), 124);
	else Buffer.from(sizeField).copy(header, 124);
	header.write("00000000000", 136);
	header.write("        ", 148);
	header.write(type, 156);
	if (ustar) header.write("ustar\u000000", 257);
	const sum = header.reduce((total, byte) => total + (signed && byte > 127 ? byte - 256 : byte), 0);
	header.write(`${sum.toString(8).padStart(6, "0")}\u0000 `, 148);
	return header;
}

// A tar entry: its header, then its data padded to whole blocks.
export function tarEntry(name: string, data: string | Uint8Array, header: TarHeader = {}): Buffer {
	const body = Buffer.from(data);
	const padding = Buffer.alloc((512 - (body.length % 512)) % 512);
	return Buffer.concat([tarHeader(name, body.length, header), body, padding]);
}

// A pax extended header's data: "<length> <key>=<value>\n" for each record.
export function paxData(records: Readonly<Record<string, string>>): string {
	return Object.entries(records)
		.map(([key, value]) => {
			const record = ` ${key}=${value}\n`;
			let length = record.length;
			while (`${length}${record}`.length !== length) length = `${length}${record}`.length;
			return `${length}${record}`;
		})
		.join("");
}

// A ustar archive of regular files.
export function tar(entries: readonly Entry[]): Buffer {
	const blocks = entries.map(({ name, data, type }) => tarEntry(name, data, { type: type ?? "0" }));
	return Buffer.concat([...blocks, Buffer.alloc(1024)]);
}

// A one-page PDF whose content stream, which draws `text`, is FlateDecode-compressed.
export function pdf(text: string): Buffer {
	const content = deflateSync(Buffer.from(`BT /F1 12 Tf 72 712 Td (${text}) Tj ET\n`));
	return Buffer.concat([
		Buffer.from(
			[
				"%PDF-1.7",
				"1 0 obj << /Type /Catalog /Pages 2 0 R >> endobj",
				"2 0 obj << /Type /Pages /Kids [3 0 R] /Count 1 >> endobj",
				"3 0 obj << /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R >> endobj",
				`4 0 obj << /Length ${content.length} /Filter /FlateDecode >>`,
				"stream\r\n",
			].join("\n"),
		),
		content,
		Buffer.from("\r\nendstream\nendobj\ntrailer << /Root 1 0 R >>\n%%EOF\n"),
	]);
}

// The content stream that draws `text`.
export const drawn = (text: string): Buffer =>
	Buffer.from(`BT /F1 12 Tf 72 712 Td (${text}) Tj ET\n`);

// A PDF of plain text: its one stream, which draws `text`, ASCIIHex-encoded.
export const textPdf = (text: string): string =>
	`%PDF-1.4\n1 0 obj << /Filter /AHx >>\nstream\n${asciiHex(drawn(text))}\nendstream endobj\n`;

export interface Page {
	// The header line, if any.
	readonly header?: string;
	// What follows the dictionary: the stream keyword and its end of line.
	readonly keyword?: string;
	// What follows the data, and then the rest of the file.
	readonly end?: string;
	readonly tail?: string;
}

// A one-page PDF whose content stream holds `data`, with `entries` in its dictionary after its
// /Length, and binary bytes in a comment after the header, as writers add them.
export function pdfPage(entries: string, data: Uint8Array, page: Page = {}): Buffer {
	const { header = "%PDF-1.7\n", keyword = "\nstream\r\n", end = "\r\nendstream" } = page;
	const { tail = "\nendobj\ntrailer << /Root 1 0 R >>\n%%EOF\n" } = page;
	return Buffer.concat([
		Buffer.from(header),
		Buffer.from([0x25, 0xe2, 0xe3, 0xcf, 0xd3, 0x0a]),
		Buffer.from(
			[
				"1 0 obj << /Type /Catalog /Pages 2 0 R >> endobj",
				"2 0 obj << /Type /Pages /Kids [3 0 R] /Count 1 >> endobj",
				"3 0 obj << /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R >> endobj",
				`4 0 obj << /Length ${data.length} ${entries} >>${keyword}`,
			].join("\n"),
		),
		data,
		Buffer.from(`${end}${tail}`),
	]);
}

// ASCII85, as PDF's ASCII85Decode reads it: "z" for four zeros, "~>" at the end.
export function ascii85(data: Uint8Array): string {
	let text = "";
	for (let at = 0; at < data.length; at += 4) {
		const group = data.subarray(at, at + 4);
		let value = 0;
		for (let index = 0; index < 4; index++) value = value * 256 + (group[index] ?? 0);
		if (value === 0 && group.length === 4) {
			text += "z";
			continue;
		}
		let digits = "";
		for (let index = 0; index < 5; index++) {
			digits = String.fromCharCode(0x21 + (value % 85)) + digits;
			value = Math.floor(value / 85);
		}
		text += digits.slice(0, group.length + 1);
	}
	return `${text}~>`;
}

// ASCIIHex, as PDF's ASCIIHexDecode reads it: spaced pairs, ">" at the end.
export const asciiHex = (data: Uint8Array): string =>
	`${(
		Buffer.from(data)
			.toString("hex")
			.match(/.{1,2}/g) ?? []
	).join(" ")}>`;

function adler32(data: Uint8Array): number {
	let a = 1;
	let b = 0;
	for (const byte of data) {
		a = (a + byte) % 65521;
		b = (b + a) % 65521;
	}
	return ((b << 16) | a) >>> 0;
}

// A zlib stream that holds `stored` in a stored block, as it is, then `packed` compressed.
export function zlibStored(stored: Uint8Array, packed: Uint8Array): Buffer {
	const block = Buffer.alloc(5);
	block.writeUInt16LE(stored.length, 1);
	block.writeUInt16LE(~stored.length & 0xffff, 3);
	const check = Buffer.alloc(4);
	check.writeUInt32BE(adler32(Buffer.concat([stored, packed])));
	return Buffer.concat([Buffer.from([0x78, 0x01]), block, stored, deflateRawSync(packed), check]);
}

function paeth(left: number, up: number, corner: number): number {
	const estimate = left + up - corner;
	const [a, b, c] = [left, up, corner].map((byte) => Math.abs(estimate - byte)) as [
		number,
		number,
		number,
	];
	if (a <= b && a <= c) return left;
	return b <= c ? up : corner;
}

// Rows of `row` bytes, each filtered with the next of the PNG filter `types` and led by it.
export function pngRows(data: Uint8Array, row: number, pixel: number, types: number[]): Buffer {
	const out: number[] = [];
	for (let start = 0; start < data.length; start += row) {
		const type = types[(start / row) % types.length] ?? 0;
		out.push(type);
		for (let at = start; at < Math.min(start + row, data.length); at++) {
			const left = at - start >= pixel ? (data[at - pixel] ?? 0) : 0;
			const up = start > 0 ? (data[at - row] ?? 0) : 0;
			const corner = start > 0 && at - start >= pixel ? (data[at - row - pixel] ?? 0) : 0;
			const guess = [0, left, up, (left + up) >> 1, paeth(left, up, corner)][type] ?? 0;
			out.push(((data[at] ?? 0) - guess) & 0xff);
		}
	}
	return Buffer.from(out);
}

// TIFF predictor 2 at 8 bits per component: each byte less the one `colors` back, row by row.
export function tiffRows(data: Uint8Array, colors: number, row: number): Buffer {
	const out = Buffer.from(data);
	for (let at = 0; at < data.length; at++) {
		if (at % row >= colors) out[at] = ((data[at] ?? 0) - (data[at - colors] ?? 0)) & 0xff;
	}
	return out;
}

// A page as ReportLab's canvas writes it by default: its content stream FlateDecode-compressed,
// then ASCII85-encoded.
export function reportlab(text: string): Buffer {
	const content = `BT /F1 12 Tf 14.4 TL ET\nBT 1 0 0 1 72 720 Tm (${text}) Tj T* ET\n`;
	const data = ascii85(deflateSync(content));
	return Buffer.concat([
		Buffer.from("%PDF-1.3\n"),
		Buffer.from([0x25, 0x93, 0x8c, 0x8b, 0x9e]),
		Buffer.from(
			[
				" ReportLab Generated PDF document",
				"1 0 obj\n<<\n/F1 2 0 R\n>>\nendobj",
				"2 0 obj\n<<\n/BaseFont /Helvetica /Encoding /WinAnsiEncoding /Name /F1 /Subtype /Type1 /Type /Font\n>>\nendobj",
				"3 0 obj\n<<\n/Contents 7 0 R /MediaBox [ 0 0 612 792 ] /Parent 6 0 R /Resources <<\n/Font 1 0 R /ProcSet [ /PDF /Text /ImageB /ImageC /ImageI ]\n>> /Rotate 0 /Trans <<\n\n>> \n  /Type /Page\n>>\nendobj",
				"4 0 obj\n<<\n/PageMode /UseNone /Pages 6 0 R /Type /Catalog\n>>\nendobj",
				"5 0 obj\n<<\n/Author (anonymous) /Producer (ReportLab PDF Library) /Title (untitled) /Trapped /False\n>>\nendobj",
				"6 0 obj\n<<\n/Count 1 /Kids [ 3 0 R ] /Type /Pages\n>>\nendobj",
				`7 0 obj\n<<\n/Filter [ /ASCII85Decode /FlateDecode ] /Length ${data.length}\n>>\nstream\n${data}endstream\nendobj`,
				"trailer\n<<\n/ID \n[<a8f715b6a217e853d5f22e27de36e75c><a8f715b6a217e853d5f22e27de36e75c>]\n% ReportLab generated PDF document -- digest\n\n/Info 5 0 R\n/Root 4 0 R\n/Size 8\n>>\nstartxref\n1028\n%%EOF\n",
			].join("\n"),
		),
	]);
}

// Raw deflate blocks of `mib` MiB of zeros, with no final block: cut off, as a bomb may be.
export function zeroBlocks(mib: number): Buffer {
	const block = deflateRawSync(Buffer.alloc(2 ** 20), { finishFlush: constants.Z_FULL_FLUSH });
	return Buffer.concat(Array.from({ length: mib }, () => block));
}

// Bytes that look random but are the same on every run.
export function noise(length: number): Buffer {
	const blocks: Buffer[] = [];
	for (let index = 0; index * 32 < length; index++) {
		blocks.push(createHash("sha256").update(`block ${index}`).digest());
	}
	return Buffer.concat(blocks).subarray(0, length);
}
