import { deflateRawSync, gzipSync, zstdCompressSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import { CAPS, type Caps, unpack } from "../src/unpack.ts";
import {
	noise,
	paxData,
	pdf,
	pdfPage,
	tarEntry,
	tarHeader,
	textPdf,
	zeroBlocks,
	zip,
} from "./archives.ts";

const MARK = "hidden-marker";
const text = `ok\n${MARK}\n`;

const refused = (label: string, detail: string): string =>
	`can't decompress ${label} (${detail}) to scan it; keep it out of the repository`;

// The parts that the marker turns up in, and why the rest wasn't read.
function read(bytes: Buffer, caps: Caps = CAPS): { found: string[]; problem?: string } {
	const { parts, problem } = unpack(bytes, caps);
	const found = parts.filter((part) => part.bytes.includes(MARK)).map((part) => part.label);
	return problem === undefined ? { found } : { found, problem };
}

const endOf = (archive: Buffer): number => archive.length - 22;
const centralOf = (archive: Buffer): number => archive.readUInt32LE(endOf(archive) + 16);

function edited(archive: Buffer, change: (copy: Buffer) => void): Buffer {
	const copy = Buffer.from(archive);
	change(copy);
	return copy;
}

// A zip of one deflated entry whose data, as given, may not be a whole deflate stream.
function deflated(data: Uint8Array): Buffer {
	return edited(zip([{ name: "a.txt", data, method: 0 }]), (copy) => {
		copy.writeUInt16LE(8, 8);
		copy.writeUInt16LE(8, centralOf(copy) + 10);
	});
}

describe("a zip archive", () => {
	const good = zip([{ name: "a.txt", data: text }]);
	const end = endOf(good);
	const central = centralOf(good);

	it("fails as zip64, with a damaged central directory or entry, cut off, or read past its end", () => {
		const long = edited(
			zip([
				{ name: "a.txt", data: text },
				{ name: "b.txt", data: text },
			]),
			(copy) => copy.writeUInt16LE(0xfff0, centralOf(copy) + 28),
		);
		const cases: [string, Buffer, string][] = [
			["a count of 0xFFFF", edited(good, (copy) => copy.writeUInt16LE(0xffff, end + 10)), "zip64"],
			[
				"an offset of 0xFFFFFFFF",
				edited(good, (copy) => copy.writeUInt32LE(0xffffffff, end + 16)),
				"zip64",
			],
			[
				"a central directory at offset 3, of size 1",
				edited(good, (copy) => {
					copy.writeUInt32LE(3, end + 16);
					copy.writeUInt32LE(1, end + 12);
				}),
				"damaged central directory",
			],
			[
				"a count one higher than it lists",
				edited(good, (copy) => {
					copy.writeUInt16LE(2, end + 8);
					copy.writeUInt16LE(2, end + 10);
				}),
				"damaged central directory",
			],
			[
				"a local header at offset 5",
				edited(good, (copy) => copy.writeUInt32LE(5, central + 42)),
				"damaged entry 1",
			],
			[
				"a compressed size of the whole file",
				edited(good, (copy) => {
					copy.writeUInt32LE(copy.length, 18);
					copy.writeUInt32LE(copy.length, central + 20);
				}),
				"entry 1 is cut off",
			],
			["a name that runs past the end", long, "damaged"],
			[
				"a name that runs past its end record",
				edited(good, (copy) => copy.writeUInt16LE(0xfff0, central + 28)),
				"damaged central directory",
			],
		];
		for (const [name, bytes, detail] of cases) {
			expect(read(bytes), name).toEqual({ found: [], problem: refused("the zip archive", detail) });
		}
	});

	it("fails where its local headers and listing differ, as streaming readers would read it otherwise", () => {
		const two = zip([
			{ name: "a.txt", data: "ok\n" },
			{ name: "b.txt", data: text },
		]);
		const listing = 46 + "a.txt".length;
		// The second entry's listing dropped, its local header left in place.
		const unlisted = edited(
			Buffer.concat([two.subarray(0, centralOf(two) + listing), two.subarray(endOf(two))]),
			(copy) => {
				copy.writeUInt16LE(1, endOf(copy) + 8);
				copy.writeUInt16LE(1, endOf(copy) + 10);
				copy.writeUInt32LE(listing, endOf(copy) + 12);
			},
		);
		const counted = edited(two, (copy) => {
			copy.writeUInt16LE(1, endOf(copy) + 8);
			copy.writeUInt16LE(1, endOf(copy) + 10);
		});
		const differs = "entry 1's local header doesn't match its listing";
		const cases: [string, Buffer, string][] = [
			[
				"a listed method 0 over a local 8",
				edited(good, (copy) => copy.writeUInt16LE(0, central + 10)),
				differs,
			],
			["other local flags", edited(good, (copy) => copy.writeUInt16LE(0x0800, 6)), differs],
			[
				"another local size",
				edited(good, (copy) => copy.writeUInt32LE(copy.readUInt32LE(22) + 1, 22)),
				differs,
			],
			[
				"another local compressed size",
				edited(good, (copy) => copy.writeUInt32LE(copy.readUInt32LE(18) - 1, 18)),
				differs,
			],
			["a local entry it doesn't list", unlisted, "an entry it doesn't list"],
			[
				"a local entry before the first it lists",
				Buffer.concat([zip([{ name: "x.txt", data: text }]).subarray(0, 30 + 5), good]),
				"an entry it doesn't list",
			],
			["two listings under a count of 1", counted, "more entries than its end record counts"],
		];
		for (const [name, bytes, detail] of cases) {
			expect(read(bytes), name).toEqual({ found: [], problem: refused("the zip archive", detail) });
		}
	});

	it("inflates each entry to the end of its data, and no further", () => {
		const packed = deflateRawSync(text);
		expect(read(deflated(packed))).toEqual({ found: ["zip entry 1"] });
		const more = deflated(Buffer.concat([packed, Buffer.from("PK\u0003\u0004 more")]));
		const problem = refused("zip entry 1", "data after its deflate stream");
		expect(read(more)).toEqual({ found: [], problem });
		// Sizes short of the deflate stream: a lenient read would take what they hold.
		const cut = deflated(packed.subarray(0, -3));
		expect(read(cut)).toEqual({
			found: [],
			problem: refused("zip entry 1", "unexpected end of file"),
		});
	});

	it("is read by a second end record in its comment, and after a count-0 end record at its start", () => {
		// The inner zip's end record ends a byte early, so the outer one ends the file.
		const comment = Buffer.concat([zip([{ name: "b.txt", data: text }]), Buffer.from("x")]);
		expect(read(zip([{ name: "a.txt", data: "ok\n" }], comment))).toEqual({
			found: ["zip entry 2"],
		});
		expect(read(zip([], comment))).toEqual({ found: ["zip entry 1"] });
	});

	it("is read with its sizes after each entry's data, as streaming writers put them", () => {
		const entries = [
			{ name: "a.xml", data: "<a/>", descriptor: true },
			{ name: "b.xml", data: text, descriptor: true },
		];
		expect(read(zip(entries))).toEqual({ found: ["zip entry 2"] });
	});

	it("has an entry named .pdf read as one, though all text", () => {
		const archive = zip([{ name: "docs/report.pdf", data: textPdf(MARK) }]);
		expect(read(archive)).toEqual({ found: ["PDF stream 1 in zip entry 1"] });
	});

	it("fails where listings that overlap add up past what the content may expand to", () => {
		const entries = Array.from({ length: 200 }, (_, index) => ({
			name: `${index}`,
			data: "",
			method: 0,
		}));
		const archive = zip(entries);
		const start = centralOf(archive);
		// End records in the comment, each naming the listing from a later entry on.
		const records: Buffer[] = [];
		let at = start;
		for (let index = 0; index < entries.length; index++) {
			const record = Buffer.alloc(22);
			record.writeUInt32LE(0x06054b50, 0);
			record.writeUInt16LE(entries.length - index, 8);
			record.writeUInt16LE(entries.length - index, 10);
			record.writeUInt32LE(endOf(archive) - at, 12);
			record.writeUInt32LE(at, 16);
			records.push(record);
			at += 46 + archive.readUInt16LE(at + 28);
		}
		// A byte after them, so that the archive's own end record ends the file.
		const commented = (count: number): Buffer =>
			zip(entries, Buffer.concat([...records.slice(-count), Buffer.from("x")]));
		const caps: Caps = { ...CAPS, ratio: 4, min: 0 };
		expect(read(commented(199), caps).problem).toMatch(
			/^takes over 0\.1 MiB of archive listings and PDF data to unpack, too much to scan;/,
		);
		expect(read(commented(20), caps)).toEqual({ found: [] });
	});
});

describe("gzip and zstd streams", () => {
	it("are read member by member and frame by frame, NUL padding and skippable frames included", () => {
		const skippable = Buffer.from([0x5f, 0x2a, 0x4d, 0x18, 4, 0, 0, 0, 1, 2, 3, 4]);
		const cases: [string, Buffer, string][] = [
			["two gzip members", Buffer.concat([gzipSync("ok\n"), gzipSync(text)]), "the gzip stream"],
			[
				"gzip members after NUL padding",
				Buffer.concat([gzipSync("ok\n"), Buffer.alloc(512), gzipSync(text)]),
				"the gzip stream",
			],
			[
				"NUL padding at the end",
				Buffer.concat([gzipSync(text), Buffer.alloc(512)]),
				"the gzip stream",
			],
			[
				"a skippable frame first",
				Buffer.concat([skippable, zstdCompressSync(text)]),
				"the zstd stream",
			],
			[
				"zstd frames around a skippable one",
				Buffer.concat([zstdCompressSync("ok\n"), skippable, zstdCompressSync(text)]),
				"the zstd stream",
			],
		];
		for (const [name, bytes, label] of cases) expect(read(bytes), name).toEqual({ found: [label] });
	});

	it("fail with other data after them, or cut off", () => {
		const cases: [string, Buffer, string, string][] = [
			[
				"gzip, NUL padding and more",
				Buffer.concat([gzipSync(text), Buffer.alloc(8), Buffer.from("more")]),
				"the gzip stream",
				"other data after it",
			],
			[
				"zstd, junk and another frame",
				Buffer.concat([zstdCompressSync("ok\n"), Buffer.from("junk"), zstdCompressSync(text)]),
				"the zstd stream",
				"other data after it",
			],
			["gzip cut off", gzipSync(text).subarray(0, -6), "the gzip stream", "unexpected end of file"],
			[
				"a deflated zip entry cut off",
				deflated(deflateRawSync(text).subarray(0, -2)),
				"zip entry 1",
				"unexpected end of file",
			],
		];
		for (const [name, bytes, label, detail] of cases) {
			expect(read(bytes), name).toEqual({ found: [], problem: refused(label, detail) });
		}
	});

	it("are read with a zip appended, as a PDF is", () => {
		const appended = zip([{ name: "a.txt", data: text }]);
		const cases: [string, Buffer][] = [
			["gzip", gzipSync("ok\n")],
			["gzip with NUL padding", Buffer.concat([gzipSync("ok\n"), Buffer.alloc(4)])],
			["zstd", zstdCompressSync("ok\n")],
			["a PDF", pdf("ok")],
		];
		for (const [name, first] of cases) {
			expect(read(Buffer.concat([first, appended])), name).toEqual({ found: ["zip entry 1"] });
		}
		const between = Buffer.concat([
			gzipSync("ok\n"),
			Buffer.alloc(4),
			Buffer.from("more"),
			appended,
		]);
		expect(read(between)).toEqual({
			found: [],
			problem: refused("the gzip stream", "other data after it"),
		});
	});
});

describe("a tar archive", () => {
	const packed = gzipSync(text);
	const close = Buffer.alloc(1024);
	const entry = tarEntry("a.gz", packed);
	const inGzip = (index: number): string[] => [`the gzip stream in tar entry ${index}`];

	it("has every entry with data opened: pax sizes and paths, GNU long names, base-256 sizes, V7 headers, any type", () => {
		// A PDF in UTF-8, which only its name makes one.
		const report = textPdf(MARK);
		const base256 = Buffer.alloc(12);
		base256[0] = 0x80;
		base256.writeUInt32BE(packed.length, 8);
		const padding = Buffer.alloc(512 - packed.length);
		const cases: [string, Buffer, string[]][] = [
			[
				"a pax size",
				Buffer.concat([
					tarEntry("PaxHeaders/a.gz", paxData({ size: `${packed.length}` }), { type: "x" }),
					tarHeader("a.gz", 0),
					packed,
					padding,
					close,
				]),
				inGzip(1),
			],
			[
				"a pax path",
				Buffer.concat([
					tarEntry("PaxHeaders/report", paxData({ path: "docs/report.pdf" }), { type: "x" }),
					tarEntry("docs/report.txt", report),
					close,
				]),
				["PDF stream 1 in tar entry 1"],
			],
			[
				"a GNU long name",
				Buffer.concat([
					tarEntry("././@LongLink", "docs/report.pdf\0", { type: "L" }),
					tarEntry("docs/report.txt", report),
					close,
				]),
				["PDF stream 1 in tar entry 1"],
			],
			[
				"a base-256 size",
				Buffer.concat([tarHeader("a.gz", 0, { sizeField: base256 }), packed, padding, close]),
				inGzip(1),
			],
			[
				"a V7 header",
				Buffer.concat([tarEntry("a.gz", packed, { ustar: false }), close]),
				inGzip(1),
			],
			[
				"a checksum of signed bytes",
				Buffer.concat([tarEntry("café.gz", packed, { ustar: false, signed: true }), close]),
				inGzip(1),
			],
			["type Z", Buffer.concat([tarEntry("a.gz", packed, { type: "Z" }), close]), inGzip(1)],
			["type NUL", Buffer.concat([tarEntry("a.gz", packed, { type: "\0" }), close]), inGzip(1)],
			["type 7", Buffer.concat([tarEntry("a.gz", packed, { type: "7" }), close]), inGzip(1)],
			[
				"after directories, links, devices, a FIFO and metadata",
				Buffer.concat([
					tarEntry("pax_global_header", paxData({ comment: "0123abcd" }), { type: "g" }),
					tarEntry("dir/", "", { type: "5" }),
					tarEntry("hard", "", { type: "1" }),
					tarEntry("soft", "", { type: "2" }),
					tarEntry("char", "", { type: "3" }),
					tarEntry("block", "", { type: "4" }),
					tarEntry("fifo", "", { type: "6" }),
					tarEntry("././@LongLink", "target\0", { type: "K" }),
					entry,
					close,
				]),
				inGzip(1),
			],
			[
				"after zero blocks",
				Buffer.concat([tarEntry("a.txt", "ok\n"), close, entry, close]),
				inGzip(2),
			],
		];
		for (const [name, bytes, found] of cases) expect(read(bytes), name).toEqual({ found });
	});

	it("fails on a block that isn't a header, data cut off, laid out otherwise, or in a type that holds none", () => {
		const first = tarEntry("a.txt", "ok\n");
		const cases: [string, Buffer, string][] = [
			[
				"a garbage block before an entry",
				Buffer.concat([first, noise(512), entry, close]),
				"a damaged header at byte 1024",
			],
			[
				"a garbage block after the end",
				Buffer.concat([entry, close, noise(512)]),
				`a damaged header at byte ${entry.length + 1024}`,
			],
			[
				"an entry cut off",
				Buffer.concat([first, entry]).subarray(0, first.length + 512 + 10),
				`an entry cut off at byte ${first.length}`,
			],
			["a partial block", Buffer.concat([entry, close, noise(100)]), "a partial block at its end"],
			[
				"a GNU sparse entry",
				Buffer.concat([tarEntry("a.gz", packed, { type: "S" }), close]),
				"a sparse entry",
			],
			[
				"a multi-volume entry",
				Buffer.concat([tarEntry("a.gz", packed, { type: "M" }), close]),
				"an entry from another volume",
			],
			[
				"a pax sparse entry",
				Buffer.concat([
					tarEntry(
						"PaxHeaders/a.gz",
						paxData({ "GNU.sparse.major": "1", "GNU.sparse.minor": "0" }),
						{
							type: "x",
						},
					),
					entry,
					close,
				]),
				"a sparse entry",
			],
			[
				"a symbolic link with data",
				Buffer.concat([tarEntry("soft", packed, { type: "2" }), close]),
				"a type 2 entry that holds data",
			],
			[
				"a pax record longer than its header",
				Buffer.concat([tarEntry("PaxHeaders/a.gz", "99 size=1\n", { type: "x" }), entry, close]),
				"a damaged pax header",
			],
			[
				"a pax record that doesn't end its line",
				Buffer.concat([tarEntry("PaxHeaders/a.gz", "8 a=b\nxx", { type: "x" }), entry, close]),
				"a damaged pax header",
			],
			[
				"a pax record without a value",
				Buffer.concat([tarEntry("PaxHeaders/a.gz", "6 abc\n", { type: "x" }), entry, close]),
				"a damaged pax header",
			],
			[
				"a pax size for every entry",
				Buffer.concat([
					tarEntry("pax_global_header", paxData({ size: "0" }), { type: "g" }),
					entry,
					close,
				]),
				"a damaged pax header",
			],
			[
				"a size that isn't a number",
				Buffer.concat([tarHeader("a.gz", 0, { sizeField: Buffer.from("12x45678901\0") }), close]),
				"a damaged size at byte 0",
			],
		];
		for (const [name, bytes, detail] of cases) {
			expect(read(bytes), name).toEqual({ found: [], problem: refused("the tar archive", detail) });
		}
	});
});

describe("the caps", () => {
	it("count stored zip entries toward the limit, also in a gzip stream", () => {
		const caps: Caps = { ratio: 1, min: 10_000, max: 10_000, depth: 4, parts: 10 };
		const stored = (size: number): Buffer => zip([{ name: "a.bin", data: noise(size), method: 0 }]);
		expect(read(stored(6000), caps)).toEqual({ found: [] });
		expect(read(gzipSync(stored(3000)), caps)).toEqual({ found: [] });
		expect(read(gzipSync(stored(6000)), caps).problem).toMatch(/^decompresses to over 0 MiB /);
	});

	it("stop a bomb as too large before it is inflated, within a time bound", () => {
		const caps: Caps = { ratio: 1, min: 4096, max: 4096, depth: 4, parts: 10 };
		// 256 MiB of zeros, cut off: inflated in full, each would fail as cut off instead.
		const blocks = zeroBlocks(256);
		const frame = zstdCompressSync(Buffer.alloc(2 ** 20));
		const bombs: [string, Buffer][] = [
			["gzip", Buffer.concat([Buffer.from([0x1f, 0x8b, 8, 0, 0, 0, 0, 0, 0, 0xff]), blocks])],
			["zstd", Buffer.concat(Array.from({ length: 256 }, () => frame)).subarray(0, -2)],
			["zip", deflated(blocks)],
			["PDF", pdfPage("/Filter /FlateDecode", Buffer.concat([Buffer.from([0x78, 0x01]), blocks]))],
		];
		for (const [name, bomb] of bombs) {
			const started = process.cpuUsage();
			const { problem } = read(bomb, caps);
			const used = process.cpuUsage(started);
			expect(problem, name).toMatch(/^decompresses to over 0 MiB /);
			expect((used.user + used.system) / 1000, name).toBeLessThan(100);
		}
	});
});
