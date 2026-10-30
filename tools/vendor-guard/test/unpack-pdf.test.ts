import { isUtf8 } from "node:buffer";
import { deflateRawSync, deflateSync, gzipSync } from "node:zlib";
import { afterAll, describe, expect, it } from "vitest";
import { rules } from "../rules/index.ts";
import { scanFiles } from "../src/scan.ts";
import { CAPS, type Caps, unpack } from "../src/unpack.ts";
import {
	ascii85,
	asciiHex,
	drawn,
	noise,
	pdf,
	pdfPage,
	pngRows,
	reportlab,
	tar,
	tiffRows,
	zip,
	zlibStored,
} from "./archives.ts";
import { removeTemp, sample, tempDir, write } from "./helpers.ts";

afterAll(removeTemp);

const MARK = "hidden-marker";
const content = drawn(MARK);
const packed = deflateSync(content);

const refused = (label: string, detail: string): string =>
	`can't decompress ${label} (${detail}) to scan it; keep it out of the repository`;

// The parts that the marker turns up in, and why the rest wasn't read.
function read(
	bytes: Buffer,
	file = "x.pdf",
	caps: Caps = CAPS,
): { found: string[]; problem?: string } {
	const { parts, problem } = unpack(bytes, caps, file);
	const found = parts.filter((part) => part.bytes.includes(MARK)).map((part) => part.label);
	return problem === undefined ? { found } : { found, problem };
}

const inStream = { found: ["PDF stream 1"] };

describe("PDF streams", () => {
	it("are decoded through FlateDecode, ASCIIHexDecode and ASCII85Decode in any order, as ReportLab writes them", () => {
		// Zeros, written "z", and lines of 16 characters.
		const wrapped = ascii85(Buffer.concat([Buffer.alloc(8), content]))
			.slice(0, -2)
			.replace(/(.{16})/g, "$1\r\n");
		const chains: [string, Uint8Array][] = [
			["/Filter /FlateDecode", packed],
			["/Filter /Fl", packed],
			["/Filter /Fl#61te#44ecode", packed],
			["/Filter [/FlateDecode] /DecodeParms [null]", packed],
			["/Filter /ASCIIHexDecode", Buffer.from(asciiHex(content))],
			["/Filter /AHx", Buffer.from(asciiHex(content).replaceAll(" ", "\n"))],
			["/Filter /ASCII85Decode", Buffer.from(ascii85(content))],
			["/Filter /A85", Buffer.from(`<~${wrapped}~>`)],
			["/Filter [/ASCII85Decode /FlateDecode]", Buffer.from(ascii85(packed))],
			["/Filter [/AHx /Fl] /DecodeParms null", Buffer.from(asciiHex(packed))],
			["/Filter [/AHx /A85 /Fl]", Buffer.from(asciiHex(Buffer.from(ascii85(packed))))],
			["/Filter [/A85 /AHx]", Buffer.from(ascii85(Buffer.from(asciiHex(content))))],
			// The marker's last byte in a group of its own.
			["/Filter /A85", Buffer.from(ascii85(Buffer.from(MARK)))],
		];
		for (const [entries, data] of chains) {
			expect(read(pdfPage(entries, data)), entries).toEqual(inStream);
		}
		expect(read(reportlab(MARK), "report.pdf")).toEqual(inStream);
		expect(read(reportlab(MARK), "report.bin")).toEqual(inStream);
	});

	it("have PNG predictors undone, whatever each row's type, and TIFF predictor 2", () => {
		const flate = (rows: Uint8Array, parms: string): Buffer =>
			pdfPage(`/Filter /FlateDecode /DecodeParms << ${parms} >>`, deflateSync(rows));
		const cases: [string, Buffer][] = [];
		for (const type of [0, 1, 2, 3, 4]) {
			const one = flate(pngRows(content, 7, 1, [type]), "/Predictor 12 /Columns 7");
			const three = flate(pngRows(content, 9, 3, [type]), "/Predictor 15 /Colors 3 /Columns 3");
			const wide = flate(
				pngRows(content, 8, 2, [type]),
				"/Predictor 10 /BitsPerComponent 16 /Columns 4",
			);
			cases.push([`row type ${type}`, one], [`row type ${type}, 3 colors`, three]);
			cases.push([`row type ${type}, 16 bits`, wide]);
		}
		cases.push(
			[
				"rows of each type",
				flate(pngRows(content, 6, 1, [4, 3, 2, 1, 0]), "/Predictor 11 /Columns 6"),
			],
			[
				"4 bits",
				flate(pngRows(content, 3, 1, [1, 2, 3, 4]), "/Predictor 13 /BitsPerComponent 4 /Columns 6"),
			],
			["TIFF", flate(tiffRows(content, 3, 15), "/Predictor 2 /Colors 3 /Columns 5")],
			["TIFF, one color", flate(tiffRows(content, 1, 10), "/Predictor 2 /Columns 10")],
			["no predictor", flate(content, "/Predictor 1 /Columns 7")],
		);
		const rows = Buffer.from(ascii85(deflateSync(pngRows(content, 7, 1, [2]))));
		const parallel = "/Filter [/A85 /Fl] /DecodeParms [null << /Predictor 12 /Columns 7 >>]";
		cases.push(["parameters for the second filter", pdfPage(parallel, rows)]);
		for (const [name, bytes] of cases) expect(read(bytes), name).toEqual(inStream);
	});

	it("fail with LZWDecode, RunLengthDecode, Crypt or any other filter, and leave image data unread", () => {
		const filters: [string, string][] = [
			["/Filter /LZWDecode", "filter LZWDecode"],
			["/Filter /LZW", "filter LZW"],
			["/Filter /RunLengthDecode", "filter RunLengthDecode"],
			["/Filter /RL", "filter RL"],
			["/Filter [/FlateDecode /Crypt]", "filter Crypt"],
			["/Filter /BrotliDecode", "filter BrotliDecode"],
			["/Filter [/DCTDecode /LZWDecode]", "filter LZWDecode"],
			["/Filter 5 0 R", "filters in another object"],
			["/Filter [/FlateDecode 5 0 R]", "filters in another object"],
			["/Filter /FlateDecode /DecodeParms 6 0 R", "filters in another object"],
			["/Filter [/FlateDecode] /DecodeParms [6 0 R]", "filters in another object"],
			["/Filter [/FlateDecode (Crypt)]", "a filter that isn't a name"],
			["/F /FlateDecode", "an /F or /DP entry"],
			["/Filter /FlateDecode /DP << /Predictor 12 >>", "an /F or /DP entry"],
		];
		for (const [entries, detail] of filters) {
			const problem = refused("PDF stream 1", detail);
			expect(read(pdfPage(entries, packed)), entries).toEqual({ found: [], problem });
		}
		const images = [
			"/DCTDecode",
			"/DCT",
			"/JPXDecode",
			"/JBIG2Decode",
			"[/CCITTFaxDecode]",
			"/CCF",
		];
		for (const filter of [...images, "[/DCTDecode /FlateDecode]"]) {
			expect(read(pdfPage(`/Filter ${filter}`, noise(64))), filter).toEqual({ found: [] });
		}
		// The filters before image data are decoded.
		expect(read(pdfPage("/Filter [/FlateDecode /DCTDecode]", packed))).toEqual(inStream);
	});

	it("fail with predictor settings and encoded data they can't read", () => {
		const flate = (parms: string): string => `/Filter /FlateDecode /DecodeParms << ${parms} >>`;
		const typed = deflateSync(Buffer.from([5, 1, 2, 3, 4, 5, 6, 7]));
		const cases: [string, Uint8Array, string][] = [
			[flate("/Predictor 3"), packed, "predictor 3"],
			[flate("/Predictor 16"), packed, "predictor 16"],
			[flate("/Predictor 2 /BitsPerComponent 4"), packed, "TIFF predictor at 4 bits"],
			[
				flate("/Predictor 12 /BitsPerComponent 3"),
				packed,
				"predictor 12 with 1 colors, 3 bits and 1 columns",
			],
			[
				flate("/Predictor 12 /Columns 0"),
				packed,
				"predictor 12 with 1 colors, 8 bits and 0 columns",
			],
			[
				flate("/Predictor 12 /Colors 0"),
				packed,
				"predictor 12 with 0 colors, 8 bits and 1 columns",
			],
			[flate("/Predictor 12.5"), packed, "a /Predictor that isn't a whole number"],
			[flate("/Predictor 12 /Columns 7 0 R"), packed, "a /Columns that isn't a whole number"],
			[flate("/Predictor 12 /Columns 7"), typed, "PNG predictor row type 5"],
			["/Filter /FlateDecode", deflateRawSync(content), "FlateDecode data that isn't zlib"],
			["/Filter /ASCIIHexDecode", Buffer.from("48 65 6g>"), "ASCIIHexDecode data that isn't hex"],
			["/Filter /ASCII85Decode", Buffer.from("87cURvw~>"), "ASCII85Decode data that isn't ASCII85"],
			[
				"/Filter /ASCII85Decode",
				Buffer.from("87czURD]~>"),
				"ASCII85Decode data that isn't ASCII85",
			],
			[
				"/Filter [/ASCII85Decode /FlateDecode]",
				Buffer.from(ascii85(Buffer.concat([packed, Buffer.from(" more")]))),
				"data after the end of its FlateDecode data",
			],
			[
				"/Filter [/AHx /ASCII85Decode]",
				Buffer.from(asciiHex(Buffer.from(`${ascii85(content)} more`))),
				"data after the end of its ASCII85Decode data",
			],
			[
				"/Filter [/A85 /ASCIIHexDecode]",
				Buffer.from(ascii85(Buffer.from(`${asciiHex(content)} more`))),
				"data after the end of its ASCIIHexDecode data",
			],
		];
		for (const [entries, data, detail] of cases) {
			const problem = refused("PDF stream 1", detail);
			expect(read(pdfPage(entries, data)), detail).toEqual({ found: [], problem });
		}
	});

	it("count each decoder's output toward the caps", () => {
		const caps: Caps = { ...CAPS, min: 4096, max: 4096 };
		const large = Buffer.alloc(5000, "a");
		const cases: [string, Uint8Array][] = [
			["/Filter /AHx", Buffer.from(asciiHex(large))],
			["/Filter /A85", Buffer.from(ascii85(large))],
			["/Filter /A85", Buffer.from(ascii85(Buffer.alloc(5000)))],
			["/Filter /Fl", deflateSync(large)],
			["/Filter [/A85 /Fl]", Buffer.from(ascii85(deflateSync(large)))],
		];
		for (const [entries, data] of cases) {
			expect(read(pdfPage(entries, data), "x.pdf", caps).problem, entries).toMatch(
				/^decompresses to over 0 MiB \(100 times the file's size, at least 0 MiB, at most 0 MiB\)/,
			);
		}
	});

	it("run to the end of their own data, whatever endstream says", () => {
		const inside = zlibStored(Buffer.from("BT (first) Tj ET\n% endstream\n"), content);
		const cases: [string, Buffer][] = [
			// Searching for "endstream" would end it inside its compressed data.
			["endstream in the data", pdfPage("/Filter /FlateDecode", inside)],
			["no endstream", pdfPage("/Filter /FlateDecode", packed, { end: "" })],
			[
				"spaces before the end of line",
				pdfPage("/Filter /FlateDecode", packed, { keyword: "\nstream \t \n" }),
			],
			["a CR alone", pdfPage("/Filter /FlateDecode", packed, { keyword: "\nstream\r" })],
			[
				"a comment first",
				pdfPage("/Filter /FlateDecode", packed, { keyword: "\n% the page\nstream\r\n" }),
			],
			[
				"no space after the dictionary",
				pdfPage("/Filter /FlateDecode", packed, { keyword: "stream\n" }),
			],
		];
		for (const [name, bytes] of cases) expect(read(bytes), name).toEqual(inStream);
		// Other text on the keyword's line leaves the start open; for data that isn't decoded, that
		// doesn't matter.
		const junk = { keyword: "\nstream junk\n" };
		const problem = refused("PDF stream 1", "no end of line after its stream keyword");
		expect(read(pdfPage("/Filter /FlateDecode", packed, junk))).toEqual({ found: [], problem });
		expect(read(pdfPage("/Subtype /XML", content, junk))).toEqual({ found: [] });
	});

	it("are found by every object's header, as readers write and reach them", () => {
		const header = (from: string, to: string, keyword = "\nstream\r\n"): Buffer =>
			Buffer.from(
				pdfPage("/Filter /FlateDecode", packed, { keyword }).toString("latin1").replace(from, to),
				"latin1",
			);
		// What looks like another header, in a comment between the dictionary and its keyword.
		const comment = { keyword: "\n%1 0 obj\nstream\r\n" };
		expect(read(pdfPage("/Filter /FlateDecode", packed, comment))).toEqual(inStream);
		expect(read(header("4 0 obj", "4 0obj", "\n% the page\nstream\r\n"))).toEqual(inStream);
		const problem = refused("the PDF", "a stream it can't parse");
		// A dictionary that doesn't parse, for an unbalanced string, before a stream keyword.
		expect(read(header("/Length", "/Title (unbalanced /Length"))).toEqual({ found: [], problem });
		// A header the scan doesn't take as one, and a comment before the keyword.
		const hidden = header("4 0 obj", "4 0 % the page\nobj", "\n% the data\nstream\r\n");
		expect(read(hidden)).toEqual({ found: [], problem });
		// Two objects whose dictionaries end at one keyword: the second is in the first's string.
		expect(read(header("/Length", "/Title (1 0 obj << ) /Length"))).toEqual({ found: [], problem });
	});

	it("fail where a dictionary nests over 64 levels deep, however deep", () => {
		// The stream's dictionary, with `levels - 1` more nested in it.
		const nested = (levels: number): Buffer =>
			pdfPage(
				`/Filter /FlateDecode /A ${"<< /A ".repeat(levels - 1)}${">> ".repeat(levels - 1)}`,
				packed,
			);
		expect(read(nested(64))).toEqual(inStream);
		const problem = refused("the PDF", "a stream it can't parse");
		expect(read(nested(65))).toEqual({ found: [], problem });
		expect(read(nested(100_000))).toEqual({ found: [], problem });
	});

	it("are found wherever the header is, or without one, in any binary file", () => {
		expect(read(Buffer.concat([noise(3000), pdf(MARK)]), "scan.bin")).toEqual(inStream);
		expect(read(pdfPage("/Filter /FlateDecode", packed, { header: "" }), "scan.bin")).toEqual(
			inStream,
		);
	});

	it("are read without their checksum, but fail cut off", () => {
		expect(read(pdfPage("/Filter /FlateDecode", packed.subarray(0, -4)))).toEqual(inStream);
		const cut = pdfPage("/Filter /FlateDecode", packed.subarray(0, -8), { end: "", tail: "" });
		const problem = refused("PDF stream 1", "unexpected end of file");
		expect(read(cut)).toEqual({ found: [], problem });
	});

	it("fail encrypted, however /Encrypt is written, but not in a binary that only names it", () => {
		const locked = (key: string): Buffer =>
			Buffer.from(pdf(MARK).toString("latin1").replace("/Root 1 0 R", `$& ${key} 5 0 R`), "latin1");
		const problem = refused("the PDF", "encrypted");
		expect(read(locked("/Encrypt"))).toEqual({ found: [], problem });
		const plain = Buffer.from("%PDF-1.4\ntrailer << /Root 1 0 R /Encrypt 2 0 R >>\n%%EOF\n");
		expect(read(plain, "plain.pdf")).toEqual({ found: [], problem });
		// A binary file, not named a PDF, with a PDF header and no stream.
		const marked = plain.toString("latin1").replace("\n", "\n%\xe2\xe3\xcf\xd3\n");
		expect(read(Buffer.from(marked, "latin1"), "scan.bin")).toEqual({ found: [], problem });
		expect(read(locked("/Encr#79pt"))).toEqual({ found: [], problem });
		expect(read(locked("/#45#6e#63rypt"), "scan.bin")).toEqual({ found: [], problem });
		const tail = "\nendobj\ntrailer << /Root 1 0 R /Encrypt 5 0 R >>\n%%EOF\n";
		const headless = pdfPage("/Filter /FlateDecode", packed, { header: "", tail });
		expect(read(headless, "scan.bin")).toEqual({ found: [], problem });
		expect(read(Buffer.concat([noise(64), Buffer.from(" /Encrypt 5 0 R")]), "scan.bin")).toEqual({
			found: [],
		});
	});

	it("that overlap fail once reading them would take more than the content may expand to", () => {
		const head = Buffer.from([
			0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x37, 0x0a, 0x25, 0xe2, 0x0a,
		]);
		const file = (body: string): Buffer => Buffer.concat([head, Buffer.from(body)]);
		const caps: Caps = { ...CAPS, ratio: 4, min: 0 };
		const over = (megabytes: string): RegExp =>
			new RegExp(`^takes over ${megabytes} MiB of archive listings and PDF data to unpack`);
		// Each stream's ASCII85 data runs on through the streams after it, to one end marker.
		const unit = `1 0 obj << /Filter /A85 >>\nstream\n${" ".repeat(1000)}\n`;
		expect(read(file(`${unit.repeat(100)}~>\n`), "x.pdf", caps).problem).toMatch(over("0.4"));
		// Each stream's data on its own is read.
		expect(read(file(`${unit}~>\n`.repeat(100)), "x.pdf", caps).problem).toBeUndefined();
		// Each object's dictionary runs on through the objects after it, in a string never closed.
		const objects = file(`${"1 0 obj << /A (".repeat(2000)}\nstream\n`);
		expect(read(objects, "x.pdf", caps).problem).toMatch(over("0.1"));
		// Each stream keyword's line, without a dictionary's end or a comment, runs back a long way.
		const keywords = file(`x${" stream".repeat(4000)}\n`);
		expect(read(keywords, "x.pdf", caps).problem).toMatch(over("0.1"));
	});
});

describe("a PDF that isn't named one", () => {
	it("is read as a .bin file, in a zip entry, in a gzip stream and in a tar entry", () => {
		const line = sample("secret-anthropic");
		const doc = pdf(line.slice(line.indexOf('"') + 1, line.lastIndexOf('"')));
		// Its bytes that aren't UTF-8 make it one.
		expect(isUtf8(doc)).toBe(false);
		const dir = tempDir();
		write(dir, "report.bin", doc);
		write(dir, "bundle.zip", zip([{ name: "report.bin", data: doc }]));
		write(dir, "report.bin.gz", gzipSync(doc));
		write(dir, "bundle.tar", tar([{ name: "report.bin", data: doc }]));
		const files = ["bundle.tar", "bundle.zip", "report.bin", "report.bin.gz"];
		const reasons = new Map(rules.map((rule) => [rule.id, rule.reason]));
		const found = scanFiles(dir, files).findings.map(({ file, line: at, rule, reason }) => {
			return `${file}:${at} ${rule}${reason.slice(reasons.get(rule)?.length ?? 0)}`;
		});
		expect(found).toEqual([
			"bundle.tar:1 secret-anthropic (in PDF stream 1 in tar entry 1)",
			"bundle.zip:1 secret-anthropic (in PDF stream 1 in zip entry 1)",
			"report.bin:1 secret-anthropic (in PDF stream 1)",
			"report.bin.gz:1 secret-anthropic (in PDF stream 1 in the gzip stream)",
		]);
	});
});
