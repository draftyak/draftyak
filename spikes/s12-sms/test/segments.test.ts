import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
	findNextUnicodePosition,
	type Segmentation,
	type SmsConfig,
	segment,
	translate7bit,
} from "../src/segments.ts";
import {
	buildVectors,
	CONFIGS,
	expectation,
	RECIPES,
	serialize,
	VECTORS_FILE,
} from "./make-vectors.ts";

interface Vector {
	readonly id: string;
	readonly body: string;
	readonly nfc: boolean;
	readonly expected: Readonly<Record<string, unknown>>;
	readonly alternatives?: Readonly<Record<string, Readonly<Record<string, unknown>>>>;
}

const committed = readFileSync(VECTORS_FILE, "utf8");
const vectors = (JSON.parse(committed) as { vectors: Vector[] }).vectors;
const byId = new Map(vectors.map((vector) => [vector.id, vector]));
const vector = (id: string): Vector => {
	const found = byId.get(id);
	if (!found) throw new Error(`no vector ${id}`);
	return found;
};

// What a config may give: the 7-bit per-part limit follows fragmentText's UDH arithmetic.
function check(result: Segmentation): void {
	const { parts, text, calculateLength } = result;
	const starts = parts.map((_, i) => (i === 0 ? 0 : (parts[i - 1]?.end ?? -1)));
	expect(parts.map(({ start }) => start)).toEqual(starts);
	expect(parts.at(-1)?.end ?? 0).toBe(text.length);
	const total = parts.reduce((sum, part) => sum + part.codeUnits, 0);
	if (result.encoding === "gsm7") {
		const tables = Number(result.languageTable !== 0) + Number(result.languageShiftTable !== 0);
		const udh = [0, 4, 7][tables] ?? 0;
		const multi = calculateLength[0] > 1;
		const limit = 160 - udh - (multi ? 6 : 0) - (udh !== 0 || multi ? 1 : 0);
		for (const part of parts) expect(part.codeUnits).toBeLessThanOrEqual(limit);
		expect(total).toBe(calculateLength[1]);
		expect(parts.length).toBeGreaterThanOrEqual(text.length === 0 ? 0 : calculateLength[0]);
		expect(calculateLength[3]).toBe(1);
	} else {
		const limit = calculateLength[0] > 1 ? 67 : 70;
		for (const part of parts) expect(part.codeUnits).toBeLessThanOrEqual(limit);
		for (const { end } of parts.slice(0, -1)) {
			const high = text.charCodeAt(end - 1);
			expect(high >= 0xd800 && high <= 0xdbff, `surrogate pair split at ${end}`).toBe(false);
		}
		expect([total, parts.length, calculateLength[3]]).toEqual([
			calculateLength[1],
			calculateLength[0],
			3,
		]);
	}
}

describe("segmentation reference", () => {
	it("matches every vector, in the default config and each alternative", () => {
		expect(vectors.length).toBe(RECIPES.length);
		for (const { id, body, expected, alternatives } of vectors) {
			expect(expectation(segment(body), body), id).toEqual(expected);
			for (const [name, config] of Object.entries(CONFIGS)) {
				const want = alternatives?.[name] ?? expected;
				expect(expectation(segment(body, config), body), `${id} (${name})`).toEqual(want);
			}
		}
	});

	it("keeps vectors/segments.v1.json equal to make-vectors.ts, whose hand-worked results hold", () => {
		expect(committed).toBe(serialize(buildVectors()));
		expect(new Set(vectors.map(({ id }) => id)).size).toBe(vectors.length);
		for (const { id, body, nfc } of vectors) expect(nfc, id).toBe(body === body.normalize("NFC"));
	});

	it("moves a GSM-7 escape pair whole to the next part at the 153-septet boundary", () => {
		const straddle = segment(vector("gsm7-ext-straddle").body);
		expect(straddle.parts.map((part) => part.codeUnits)).toEqual([152, 12]);
		expect(straddle.text.charAt(straddle.parts[1]?.start ?? 0)).toBe("{");
		const fits = segment(vector("gsm7-ext-fills-part").body);
		expect(fits.parts.map((part) => part.codeUnits)).toEqual([153, 10]);
		// calculateLength counts 2 parts where divideMessage returns 3.
		const extra = segment(vector("gsm7-ext-extra-part").body);
		expect([extra.calculateLength[0], extra.parts.length]).toEqual([2, 3]);
	});

	it("keeps flags, skin tones, keycaps, ZWJ sequences and combining marks whole across 67 units", () => {
		const cases: Record<string, [number, string]> = {
			"ucs2-flag-straddle": [65, "\u{1F1FA}\u{1F1F8}"],
			"ucs2-skin-tone-straddle": [64, "\u{1F44D}\u{1F3FD}"],
			"ucs2-keycap-straddle": [65, "1\ufe0f\u20e3"],
			"ucs2-zwj-straddle": [63, "\u{1F468}\u200d\u{1F469}\u200d\u{1F467}"],
			"ucs2-nfd-mark-straddle": [66, "e\u0301"],
			"ucs2-surrogate-straddle": [66, "\u{1F600}"],
		};
		for (const [id, [cut, cluster]] of Object.entries(cases)) {
			const result = segment(vector(id).body);
			expect(result.parts[0]?.end, id).toBe(cut);
			expect(result.text.slice(cut).startsWith(cluster), id).toBe(true);
		}
	});

	it("splits a cluster longer than a part, at least keeping surrogate pairs whole", () => {
		expect(segment(vector("ucs2-long-cluster").body).parts.map((p) => p.end)).toEqual([7, 74, 88]);
		const zwj = segment(vector("ucs2-long-zwj-surrogate").body);
		expect(zwj.parts.map((part) => part.end)).toEqual([7, 73, 84]);
	});

	it("steps over whole flag pairs when an older break iterator treats a flag run as one cluster", () => {
		const run = `\u0436${"\u{1F1FA}\u{1F1F8}".repeat(20)}`;
		const legacy = new Set([0, 1, run.length]);
		// From the run's start (1) the loop moves in 4-unit steps to 65, the last pair before 67.
		expect(findNextUnicodePosition(0, 134, run, legacy)).toBe(65);
		expect(findNextUnicodePosition(0, 134, run)).toBe(65);
	});

	it("sizes NFD input as UCS-2 where its NFC form is GSM-7", () => {
		const nfd = vector("nfd-cafe");
		expect([nfd.nfc, segment(nfd.body).encoding]).toEqual([false, "ucs2"]);
		expect(segment(nfd.body.normalize("NFC")).encoding).toBe("gsm7");
		expect(nfd.body.normalize("NFC")).toBe(vector("nfc-cafe").body);
	});

	it("sizes one-part texts the 3GPP2 way: printable ASCII as 7-bit, other GSM-7 text as UCS-2", () => {
		const cdma: SmsConfig = { format: "3gpp2" };
		const backtick = vector("ascii-backtick").body;
		expect([segment(backtick).encoding, segment(backtick, cdma).encoding]).toEqual([
			"ucs2",
			"gsm7",
		]);
		expect(segment(backtick, cdma).calculateLength).toEqual([1, 11, 149, 1]);
		// One septet a character, braces included, where GSM-7 counts an escape pair.
		expect(segment(vector("gsm7-ext-only-single").body, cdma).calculateLength).toEqual([
			1, 83, 77, 1,
		]);
		// No single-segment EMS: a one-part GSM-7 text that isn't ASCII goes UCS-2.
		expect(segment(vector("nfc-cafe").body, cdma).calculateLength).toEqual([1, 11, 59, 3]);
		expect(segment(vector("gsm7-ext-single-160").body, cdma).parts.length).toBe(3);
		// Multipart GSM-7, and 161 ASCII characters, take the 3GPP path.
		for (const id of ["gsm7-ext-straddle", "gsm7-multi-161", "ucs2-flag-straddle"]) {
			expect(segment(vector(id).body, cdma), id).toEqual(segment(vector(id).body));
		}
	});

	it("uses the national shift tables only where the device enables them", () => {
		const tr = segment(vector("national-tr").body, CONFIGS.tr);
		expect([tr.encoding, tr.languageTable, tr.languageShiftTable]).toEqual(["gsm7", 1, 0]);
		const es = segment(vector("national-es").body, CONFIGS.es);
		expect([es.encoding, es.languageTable, es.languageShiftTable]).toEqual(["gsm7", 0, 2]);
		const multi = segment(vector("national-tr-multi").body, CONFIGS.tr);
		expect(multi.parts.map((part) => part.codeUnits)).toEqual([149, 58]);
		expect(segment(vector("national-tr").body).encoding).toBe("ucs2");
		// The Turkish locking table holds the euro sign, so escape pairs become single septets.
		const euro = segment(vector("gsm7-ext-only-multi").body, CONFIGS.tr);
		expect(euro.calculateLength).toEqual([1, 107, 48, 1]);
	});

	it("forced 7-bit translation maps the candidates and turns every other non-GSM unit into a space", () => {
		expect(translate7bit("It\u2019s \u201cok\u201d \u2013 \u00e7\u00e3 \u{1F44D}")).toBe(
			'It\'s "ok" - \u00c7a   ',
		);
		expect(translate7bit("@\u00a3\u20ac{}\n")).toBe("@\u00a3\u20ac{}\n");
		const forced = segment(vector("force7bit-emoji").body, CONFIGS.force7bit);
		expect([forced.encoding, forced.text]).toEqual(["gsm7", "DYTEST-ok   "]);
	});

	it("holds its invariants over seeded random texts in every config", () => {
		const pieces = [
			..."AZaz09 .,?!\n@\u00e9\u00c7\u00e7\u015f\u011f\u0131\u00f3\u20ac{}[]^~|\\",
			"\u0436",
			"\u{1F600}",
			"\u{1F1FA}\u{1F1F8}",
			"\u{1F1EB}",
			"\u{1F44D}\u{1F3FD}",
			"1\ufe0f\u20e3",
			"e\u0301",
			"\u{1F468}\u200d\u{1F469}\u200d\u{1F467}",
			"\u2019",
		];
		let seed = 0x5eed;
		const random = (n: number): number => {
			seed = (seed * 1_103_515_245 + 12_345) % 2 ** 31;
			return seed % n;
		};
		const configs: SmsConfig[] = [{}, ...Object.values(CONFIGS)];
		for (let round = 0; round < 400; round++) {
			const length = random(5) === 0 ? random(20) : 60 + random(260);
			const text = Array.from({ length }, () => pieces[random(pieces.length)]).join("");
			for (const config of configs) check(segment(text, config));
		}
		for (const { body } of vectors) for (const config of configs) check(segment(body, config));
	});
});
