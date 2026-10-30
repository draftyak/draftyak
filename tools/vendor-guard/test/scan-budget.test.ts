import { gzipSync } from "node:zlib";
import { afterAll, describe, expect, it, vi } from "vitest";
import { type Budget, LINE_COST, lineHits } from "../src/rules.ts";
import { type Content, fileHits, type Reading, scanFiles } from "../src/scan.ts";
import { CAPS } from "../src/unpack.ts";
import { zip } from "./archives.ts";
import { removeTemp, sample, tempRepo } from "./helpers.ts";

// Each part the scan decodes, by its label, in order.
const partsRead = vi.hoisted((): string[] => []);

vi.mock(import("../src/rules.ts"), async (importOriginal) => {
	const actual = await importOriginal();
	return { ...actual, lineHits: vi.fn(actual.lineHits) };
});

vi.mock(import("../src/unpack.ts"), async (importOriginal) => {
	const actual = await importOriginal();
	return {
		...actual,
		unpack: (...args: Parameters<typeof actual.unpack>) => {
			const unpacked = actual.unpack(...args);
			const parts = unpacked.parts.map(({ bytes, label }) => ({
				label,
				get bytes() {
					partsRead.push(label);
					return bytes;
				},
			}));
			return { ...unpacked, parts };
		},
	};
});

afterAll(removeTemp);

// Twice what a file of `size` bytes may decompress to, as its refusal names it.
function over(size: number): string {
	const budget = 2 * Math.min(CAPS.max, Math.max(CAPS.min, CAPS.ratio * size));
	const mib = Number((budget / 2 ** 20).toFixed(1));
	return `its readings and decoded lines come to over ${mib} Mi characters (each line counting 32 more), too large to scan; keep it out of the repository`;
}

describe("the scan budget", () => {
	it("reads lines, in every reading, only as far as it pays for them, and decodes no reading after that", () => {
		const secret = sample("secret-anthropic");
		const text = `${secret}\n`.repeat(4);
		const cost = secret.length + LINE_COST;
		const lines = (budget: Budget, content: Content): string[] =>
			fileHits("notes/a.txt", content, budget).map(({ line, where }) =>
				where === undefined ? `${line}` : `${line} ${where}`,
			);
		// Two more readings, each named in `decoded` when the scan takes it, as parts are decoded then.
		const more = (decoded: string[]): Iterable<Reading> => ({
			*[Symbol.iterator]() {
				for (const where of ["in zip entry 1", "in zip entry 2"]) {
					decoded.push(where);
					yield { text, where };
				}
			},
		});
		const none: string[] = [];
		const three = { left: 3 * cost };
		expect(lines(three, { text, plain: true, more: more(none) })).toEqual(["1", "2", "3"]);
		expect(three.left).toBeLessThan(0);
		expect(none).toEqual([]);
		// Four lines, the empty one after them, then one line of the next reading.
		const first: string[] = [];
		const six = { left: 6 * cost };
		expect(lines(six, { text, plain: true, more: more(first) })).toEqual([
			"1",
			"1 in zip entry 1",
			"2",
			"3",
			"4",
		]);
		expect(six.left).toBeLessThan(0);
		expect(first).toEqual(["in zip entry 1"]);
	});

	it("refuses a file whose lines cost more than twice its cap at the first line it can't pay for, keeping earlier hits and decoding no later entry", () => {
		const repo = tempRepo();
		const token = `${sample("secret-anthropic")}\n`;
		// A token, then empty lines that cost 8 or 16 times what a zip this small may read, then
		// another token in the next entry.
		for (const lines of [2 ** 19, 2 ** 20 - 2 ** 10]) {
			const archive = zip([
				{ name: "a.txt", data: `${token}${"\n".repeat(lines)}` },
				{ name: "b.txt", data: token },
			]);
			repo.write("flood.zip", archive);
			vi.mocked(lineHits).mockClear();
			partsRead.length = 0;
			const { findings } = scanFiles(repo.dir, ["flood.zip"]);
			expect(findings).toEqual([
				{ file: "flood.zip", line: 1, column: 1, rule: "too-large", reason: over(archive.length) },
				expect.objectContaining({
					file: "flood.zip",
					line: 1,
					rule: "secret-anthropic",
					reason: expect.stringMatching(/ \(in zip entry 1\)$/),
				}),
			]);
			// The budget the scan read lines with ends at most one empty line below 0, however many
			// lines follow: nothing after the first line it couldn't pay for was read, and the next
			// entry wasn't decoded.
			const budget = vi.mocked(lineHits).mock.calls.at(-1)?.[2];
			expect(budget?.left).toBeGreaterThanOrEqual(-LINE_COST);
			expect(partsRead).toEqual(["zip entry 1"]);
		}
	});

	it("counts each decoding of a line, but no pass that can't change it", () => {
		const repo = tempRepo();
		// A backslash written as an escape, which each decoding writes again: five readings a line.
		const escaped = `\\${"x5c".repeat(333)}\n`;
		const many = gzipSync(escaped.repeat(1000));
		repo.write("escaped.gz", many);
		repo.write("fewer.gz", gzipSync(escaped.repeat(300)));
		// Nearly all a small file may decompress to, in lines no decoding can change.
		repo.write("plain.gz", gzipSync(`${"a".repeat(99)}\n`.repeat(10_400)));
		const { findings } = scanFiles(repo.dir, ["escaped.gz", "fewer.gz", "plain.gz"]);
		expect(findings).toEqual([
			{ file: "escaped.gz", line: 1, column: 1, rule: "too-large", reason: over(many.length) },
		]);
	});

	it("counts both readings of a \\0 before an octal digit, failing a flood of them just over twice the cap but not just under", () => {
		const repo = tempRepo();
		// Each line costs its length plus LINE_COST three times: as written, read as an octal escape,
		// and read as NUL and a digit.
		const cost = 3 * ("\\01".length + LINE_COST);
		// What a file this small may read; its own bytes' readings take less than 4 Ki of it.
		const budget = 2 * CAPS.min;
		const under = Math.floor((budget - 2 ** 12) / cost);
		const past = Math.floor(budget / cost) + 1;
		const flood = (line: string, count: number): Buffer => gzipSync(`${line}\n`.repeat(count));
		const refused = flood("\\01", past);
		repo.write("past.gz", refused);
		repo.write("under.gz", flood("\\01", under));
		// As many lines of the same length, which only the octal reading changes.
		repo.write("octal.gz", flood("\\11", past));
		const { findings } = scanFiles(repo.dir, ["octal.gz", "past.gz", "under.gz"]);
		expect(findings).toEqual([
			{ file: "past.gz", line: 1, column: 1, rule: "too-large", reason: over(refused.length) },
		]);
	});
});
