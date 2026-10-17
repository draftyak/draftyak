// Writes vectors/segments.v1.json: `node test/make-vectors.ts` from spikes/s12-sms. Every recipe
// carries its default-config result worked out by hand from Android's algorithms; the script refuses
// to write when the reference disagrees with one. Alternatives come from the reference.
import { writeFileSync } from "node:fs";
import { isDeepStrictEqual } from "node:util";
import { type Segmentation, type SmsConfig, segment } from "../src/segments.ts";

export const VECTORS_FILE: URL = new URL("../vectors/segments.v1.json", import.meta.url);

export const CONFIGS: Readonly<Record<string, SmsConfig>> = {
	tr: { singleShift: [1], lockingShift: [1] },
	es: { singleShift: [2] },
	force7bit: { force7bit: true },
	"3gpp2": { format: "3gpp2" },
};

interface Recipe {
	readonly id: string;
	readonly category: string;
	readonly note: string;
	readonly body: string;
	readonly send?: boolean;
	// Hand-worked default result: calculateLength and divideMessage's part sizes.
	readonly length: readonly [number, number, number, number];
	readonly parts: readonly number[];
}

const P = "DYTEST-";
const a = (n: number): string => "A".repeat(n);
const zh = (n: number): string => "\u0436".repeat(n);
const flags = [
	"\u{1F1FA}\u{1F1F8}",
	"\u{1F1EB}\u{1F1F7}",
	"\u{1F1E9}\u{1F1EA}",
	"\u{1F1EF}\u{1F1F5}",
];
const repeat = (n: number, part: number): number[] => Array.from({ length: n }, () => part);

export const RECIPES: readonly Recipe[] = [
	{
		id: "gsm7-single-160",
		category: "gsm7",
		note: "160 septets fit one part",
		body: P + a(153),
		length: [1, 160, 0, 1],
		parts: [160],
	},
	{
		id: "gsm7-multi-161",
		category: "gsm7",
		note: "161 septets need two parts of at most 153",
		body: P + a(154),
		length: [2, 161, 145, 1],
		parts: [153, 8],
	},
	{
		id: "gsm7-multi-306",
		category: "gsm7",
		note: "exactly two full parts",
		body: P + a(299),
		length: [2, 306, 0, 1],
		parts: [153, 153],
	},
	{
		id: "gsm7-newline",
		category: "gsm7",
		note: "LF is one septet of the default alphabet",
		body: `${P}line one\nline two`,
		length: [1, 24, 136, 1],
		parts: [24],
	},
	{
		id: "gsm7-ext-single-160",
		category: "gsm7-extension",
		note: "an escape pair ends exactly at septet 160",
		body: `${P + a(151)}\u20ac`,
		length: [1, 160, 0, 1],
		parts: [160],
	},
	{
		id: "gsm7-ext-overflow-161",
		category: "gsm7-extension",
		note: "the escape pair pushes the text to 161 septets",
		body: `${P + a(152)}\u20ac`,
		length: [2, 161, 145, 1],
		parts: [153, 8],
	},
	{
		id: "gsm7-ext-straddle",
		category: "gsm7-extension",
		note: "an escape pair at septets 153-154 moves whole to part 2, which leaves part 1 at 152",
		body: `${P + a(145)}{${a(10)}`,
		send: true,
		length: [2, 164, 142, 1],
		parts: [152, 12],
	},
	{
		id: "gsm7-ext-fills-part",
		category: "gsm7-extension",
		note: "an escape pair at septets 152-153 stays in part 1",
		body: `${P + a(144)}{${a(10)}`,
		length: [2, 163, 143, 1],
		parts: [153, 10],
	},
	{
		id: "gsm7-ext-extra-part",
		category: "gsm7-extension",
		note: "306 septets count as 2 parts, but the moved escape pair makes divideMessage return 3",
		body: `${P + a(145)}\u20ac${a(152)}`,
		send: true,
		length: [2, 306, 0, 1],
		parts: [152, 153, 1],
	},
	{
		id: "gsm7-ext-only-single",
		category: "gsm7-extension",
		note: "76 escape pairs after the prefix fit one part",
		body: P + "{".repeat(76),
		length: [1, 159, 1, 1],
		parts: [159],
	},
	{
		id: "gsm7-ext-only-multi",
		category: "gsm7-extension",
		note: "escape pairs only: part 1 takes 73 of them",
		body: P + "\u20ac".repeat(100),
		length: [2, 207, 99, 1],
		parts: [153, 54],
	},
	{
		id: "gsm7-ten-parts",
		category: "hub-cap",
		note: "10 parts, the hub's sms-text-v1 maximum",
		body: P + a(1523),
		length: [10, 1530, 0, 1],
		parts: repeat(10, 153),
	},
	{
		id: "gsm7-eleven-parts",
		category: "hub-cap",
		note: "11 parts: Android splits it, the hub refuses it",
		body: P + a(1524),
		length: [11, 1531, 152, 1],
		parts: [...repeat(10, 153), 1],
	},
	{
		id: "ucs2-single-70",
		category: "ucs2",
		note: "70 UTF-16 units fit one part",
		body: P + zh(63),
		length: [1, 70, 0, 3],
		parts: [70],
	},
	{
		id: "ucs2-multi-71",
		category: "ucs2",
		note: "71 units need two parts of at most 67",
		body: P + zh(64),
		length: [2, 71, 63, 3],
		parts: [67, 4],
	},
	{
		id: "ucs2-surrogate-straddle",
		category: "ucs2-cluster",
		note: "an emoji at units 66-67 moves to part 2",
		body: `${P + zh(59)}\u{1F600}${zh(10)}`,
		length: [2, 78, 55, 3],
		parts: [66, 12],
	},
	{
		id: "ucs2-flag-straddle",
		category: "ucs2-cluster",
		note: "a flag (two regional indicators) at units 65-68 moves whole to part 2",
		body: `${P + zh(58)}${flags[0]}${zh(10)}`,
		send: true,
		length: [2, 79, 53, 3],
		parts: [65, 14],
	},
	{
		id: "ucs2-flag-run",
		category: "ucs2-cluster",
		note: "a run of 20 flags: part 1 ends at the flag pair that unit 67 falls in",
		body: `${P}\u0436${Array.from({ length: 20 }, (_, i) => flags[i % 4]).join("")}`,
		length: [2, 88, 43, 3],
		parts: [64, 24],
	},
	{
		id: "ucs2-skin-tone-straddle",
		category: "ucs2-cluster",
		note: "thumbs up with a skin tone at units 64-67 stays one cluster",
		body: `${P + zh(57)}\u{1F44D}\u{1F3FD}${zh(10)}`,
		send: true,
		length: [2, 78, 53, 3],
		parts: [64, 14],
	},
	{
		id: "ucs2-keycap-straddle",
		category: "ucs2-cluster",
		note: "the keycap 1 + U+FE0F + U+20E3 at units 65-67 stays one cluster",
		body: `${P + zh(58)}1\ufe0f\u20e3${zh(10)}`,
		send: true,
		length: [2, 78, 54, 3],
		parts: [65, 13],
	},
	{
		id: "ucs2-zwj-straddle",
		category: "ucs2-cluster",
		note: "a ZWJ family at units 63-70 stays one cluster",
		body: `${P + zh(56)}\u{1F468}\u200d\u{1F469}\u200d\u{1F467}${zh(10)}`,
		send: true,
		length: [2, 81, 49, 3],
		parts: [63, 18],
	},
	{
		id: "ucs2-nfd-mark-straddle",
		category: "nfd",
		note: "e + U+0301 at units 66-67 stays one cluster",
		body: `${P + zh(59)}e\u0301${zh(10)}`,
		length: [2, 78, 55, 3],
		parts: [66, 12],
	},
	{
		id: "ucs2-long-cluster",
		category: "ucs2-cluster",
		note: "a cluster longer than a part: the prefix becomes part 1 and the cluster splits at 67",
		body: `${P}e${"\u0301".repeat(80)}`,
		length: [3, 88, 53, 3],
		parts: [7, 67, 14],
	},
	{
		id: "ucs2-long-zwj-surrogate",
		category: "ucs2-cluster",
		note: "inside a long ZWJ chain the split moves back one unit to keep a surrogate pair",
		body: `${P}\u{1F468}${"\u200d\u{1F469}".repeat(25)}`,
		length: [3, 84, 56, 3],
		parts: [7, 66, 11],
	},
	{
		id: "ucs2-emoji-run",
		category: "ucs2-cluster",
		note: "an emoji run whose pair at units 66-67 moves to part 2",
		body: `${P}\u0436${"\u{1F600}".repeat(40)}`,
		send: true,
		length: [2, 88, 45, 3],
		parts: [66, 22],
	},
	{
		id: "nfc-cafe",
		category: "nfd",
		note: "NFC e-acute is in the default alphabet",
		body: `${P}caf\u00e9`,
		length: [1, 11, 149, 1],
		parts: [11],
	},
	{
		id: "nfd-cafe",
		category: "nfd",
		note: "NFD e + U+0301 is not GSM-7, so the text goes UCS-2; the hub renders NFC first",
		body: `${P}cafe\u0301`,
		length: [1, 12, 58, 3],
		parts: [12],
	},
	{
		id: "national-tr",
		category: "national",
		note: "Turkish letters: UCS-2 by default, GSM-7 with the Turkish locking shift table",
		body: `${P}I\u011fd\u0131r'da \u0131l\u0131k s\u00fct i\u00e7ti\u011fimiz g\u00fcn\u00fc hat\u0131rla`,
		length: [1, 47, 23, 3],
		parts: [47],
	},
	{
		id: "national-es",
		category: "national",
		note: "o-acute: UCS-2 by default, GSM-7 with the Spanish single shift table",
		body: `${P}\u00bfQu\u00e9 tal? Ma\u00f1ana ir\u00e9 a la canci\u00f3n`,
		length: [1, 40, 30, 3],
		parts: [40],
	},
	{
		id: "national-tr-multi",
		category: "national",
		note: "multipart Turkish: 67-unit parts by default, 149-septet parts with one national table",
		body: P + "\u0131l\u0131k ".repeat(40),
		length: [4, 207, 61, 3],
		parts: [67, 67, 67, 6],
	},
	{
		id: "force7bit-quotes",
		category: "force7bit",
		note: "curly quotes and an en dash: UCS-2, unless the device forces 7-bit translation",
		body: `${P}It\u2019s \u201cfine\u201d \u2013 ok`,
		length: [1, 23, 47, 3],
		parts: [23],
	},
	{
		id: "force7bit-emoji",
		category: "force7bit",
		note: "forced translation turns each emoji unit into a space",
		body: `${P}ok \u{1F44D}`,
		length: [1, 12, 58, 3],
		parts: [12],
	},
	{
		id: "force7bit-accents",
		category: "force7bit",
		note: "c-cedilla and a-tilde: UCS-2, unless the device forces 7-bit translation",
		body: `${P}a\u00e7\u00e3o`,
		length: [1, 11, 59, 3],
		parts: [11],
	},
	{
		id: "ascii-backtick",
		category: "3gpp2",
		note: "a backtick is ASCII but not GSM-7: UCS-2 on 3GPP, one 7-bit ASCII part on 3GPP2",
		body: `${P}\`ok\``,
		length: [1, 11, 59, 3],
		parts: [11],
	},
];

type Expected = Readonly<Record<string, unknown>>;

export function expectation(result: Segmentation, body: string): Expected {
	return {
		encoding: result.encoding,
		calculateLength: result.calculateLength,
		parts: result.parts.map(({ start, end, codeUnits }) => [start, end, codeUnits]),
		...(result.text === body ? {} : { text: result.text }),
		...(result.languageTable || result.languageShiftTable
			? { languageTable: result.languageTable, languageShiftTable: result.languageShiftTable }
			: {}),
	};
}

export function buildVectors(): Readonly<Record<string, unknown>> {
	const vectors = RECIPES.map((recipe) => {
		const result = segment(recipe.body);
		const worked = [result.calculateLength, result.parts.map((part) => part.codeUnits)];
		if (!isDeepStrictEqual(worked, [recipe.length, recipe.parts])) {
			throw new Error(`${recipe.id}: the reference gives ${JSON.stringify(worked)}`);
		}
		const expected = expectation(result, recipe.body);
		const alternatives = Object.fromEntries(
			Object.entries(CONFIGS)
				.map(([name, config]) => [name, expectation(segment(recipe.body, config), recipe.body)])
				.filter(([, alternative]) => !isDeepStrictEqual(alternative, expected)),
		);
		return {
			id: recipe.id,
			category: recipe.category,
			note: recipe.note,
			...(recipe.send ? { send: true } : {}),
			nfc: recipe.body === recipe.body.normalize("NFC"),
			body: recipe.body,
			expected,
			...(Object.keys(alternatives).length > 0 ? { alternatives } : {}),
		};
	});
	return {
		format: "draftyak.s12.sms-segments.v1",
		status: "draft",
		reference: "spikes/s12-sms/src/segments.ts",
		notes: [
			"expected is Android's calculateLength(body, false) and divideMessage(body) with no national tables and no forced 7-bit translation; parts are [start, end, code units] in UTF-16 offsets, code units being septets (GSM-7) or UTF-16 units (UCS-2).",
			"alternatives come from the reference for other device configs: tr enables the Turkish single and locking shift tables, es the Spanish single shift table, force7bit config_sms_force_7bit_encoding with candidate translations (any other non-GSM unit becomes a space). Offsets then refer to text when present.",
			"3gpp2 is the path calculateLength and divideMessage take when the subscription sends in the 3GPP2 format (useCdmaFormatForMoSms, e.g. an IMS SMS format of 3GPP2): one part of printable ASCII, CR and LF is 7-bit ASCII at one septet a character, any other one-part GSM-7 text goes UCS-2, and multipart GSM-7 is unchanged. The report's device.smsFormat says which path the phone took.",
			"The hub renders NFC with LF and caps a text at 10 parts; vectors marked send are multipart DYTEST- texts for the send probe.",
		],
		configs: CONFIGS,
		vectors,
	};
}

// JSON with every non-ASCII character escaped, so NFC and NFD bodies stay distinguishable, and
// number arrays on one line.
export function serialize(value: unknown): string {
	const json = JSON.stringify(value, null, 2)
		.replace(/[\u007f-\uffff]/g, (char) => `\\u${char.charCodeAt(0).toString(16).padStart(4, "0")}`)
		.replace(
			/\[\s+(-?\d+(?:,\s+-?\d+)*)\s+\]/g,
			(_, list: string) => `[${list.split(/,\s+/).join(", ")}]`,
		);
	return `${json}\n`;
}

if (import.meta.main) {
	writeFileSync(VECTORS_FILE, serialize(buildVectors()));
	console.log(`make-vectors: wrote ${RECIPES.length} vectors`);
}
