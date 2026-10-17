// The hub's reference for how Android sizes and splits an SMS (AOSP frameworks/opt/telephony):
// GsmAlphabet.countGsmSeptets and findGsmSeptetLimitIndex, SmsMessageBase.calcUnicodeEncodingDetails
// and findNextUnicodePosition, SmsMessage.fragmentText (SmsManager.divideMessage), and
// Sms7BitEncodingTranslator, plus BearerData.calcTextEncodingDetails for the 3GPP2 format. A draft:
// M0.38 compares it with calculateLength and divideMessage.

// gsm7 is calculateLength's 7-bit code unit, which on 3GPP2 includes one-part 7-bit ASCII.
export type Encoding = "gsm7" | "ucs2";

// SmsMessage.calculateLength: [msgCount, codeUnitCount, codeUnitsRemaining, codeUnitSize], where
// codeUnitSize is 1 for 7-bit and 3 for 16-bit.
export type LengthDetails = readonly [number, number, number, number];

export interface Part {
	// UTF-16 offsets into Segmentation.text, end exclusive.
	readonly start: number;
	readonly end: number;
	// Septets for GSM-7, UTF-16 units for UCS-2.
	readonly codeUnits: number;
}

// Device resources: config_sms_enabled_single_shift_tables and _locking_shift_tables (ascending)
// and config_sms_force_7bit_encoding. National tables here: 1 Turkish, 2 Spanish (single shift).
// format 3gpp2: SmsMessage.useCdmaFormatForMoSms() holds, as with an IMS SMS format of 3GPP2.
export interface SmsConfig {
	readonly singleShift?: readonly number[];
	readonly lockingShift?: readonly number[];
	readonly force7bit?: boolean;
	readonly format?: "3gpp" | "3gpp2";
}

export interface Segmentation {
	readonly encoding: Encoding;
	readonly calculateLength: LengthDetails;
	// divideMessage's parts.
	readonly parts: readonly Part[];
	readonly languageTable: number;
	readonly languageShiftTable: number;
	// What Android splits and sends: the body, or its forced 7-bit translation.
	readonly text: string;
}

const MAX_SEPTETS = 160;
const MAX_BYTES = 140;
const MAX_BYTES_WITH_HEADER = 134;
// User data header costs in septets (GsmAlphabet.UDH_SEPTET_COST_*).
const UDH_LENGTH = 1;
const UDH_ONE_TABLE = 4;
const UDH_TWO_TABLES = 7;
const UDH_CONCATENATED = 6;
const ESCAPE = "\u001b";

// 3GPP TS 23.038 locking shift tables as Android stores them: 0 is the default alphabet, 1 Turkish.
// 0x1B holds \uffff for the escape, so U+FFFF counts as one septet there, as on Android.
const LOCKING: Readonly<Record<number, string>> = {
	0:
		"@\u00a3$\u00a5\u00e8\u00e9\u00f9\u00ec\u00f2\u00c7\n\u00d8\u00f8\r\u00c5\u00e5" +
		"\u0394_\u03a6\u0393\u039b\u03a9\u03a0\u03a8\u03a3\u0398\u039e\uffff\u00c6\u00e6\u00df\u00c9" +
		" !\"#\u00a4%&'()*+,-./0123456789:;<=>?" +
		"\u00a1ABCDEFGHIJKLMNOPQRSTUVWXYZ\u00c4\u00d6\u00d1\u00dc\u00a7" +
		"\u00bfabcdefghijklmnopqrstuvwxyz\u00e4\u00f6\u00f1\u00fc\u00e0",
	1:
		"@\u00a3$\u00a5\u20ac\u00e9\u00f9\u0131\u00f2\u00c7\n\u011e\u011f\r\u00c5\u00e5" +
		"\u0394_\u03a6\u0393\u039b\u03a9\u03a0\u03a8\u03a3\u0398\u039e\uffff\u015e\u015f\u00df\u00c9" +
		" !\"#\u00a4%&'()*+,-./0123456789:;<=>?" +
		"\u0130ABCDEFGHIJKLMNOPQRSTUVWXYZ\u00c4\u00d6\u00d1\u00dc\u00a7" +
		"\u00e7abcdefghijklmnopqrstuvwxyz\u00e4\u00f6\u00f1\u00fc\u00e0",
};

// Single shift tables, reached through the escape at two septets a character; only membership
// matters for lengths. 0 is the default extension table.
const EXTENSION = "\f^{}\\[~]|\u20ac";
const SINGLE: Readonly<Record<number, string>> = {
	0: EXTENSION,
	1: `${EXTENSION}\u011e\u0130\u015e\u00e7\u011f\u0131\u015f`,
	2: `${EXTENSION}\u00e7\u00c1\u00cd\u00d3\u00da\u00e1\u00ed\u00f3\u00fa`,
};

const basicOf = (table: number): string => LOCKING[table] ?? "";
const shiftOf = (table: number): string => SINGLE[table] ?? "";

// Septets for the whole text with one table pair, or -1 if a unit fits neither (UTF-16 units, so
// a surrogate half never fits). countGsmSeptets skips the escape character itself.
function countSeptets(text: string, locking: number, shift: number): number {
	const [basic, extension] = [basicOf(locking), shiftOf(shift)];
	let count = 0;
	for (let i = 0; i < text.length; i++) {
		const unit = text.charAt(i);
		if (unit === ESCAPE) continue;
		if (basic.includes(unit)) count += 1;
		else if (extension.includes(unit)) count += 2;
		else return -1;
	}
	return count;
}

interface Gsm {
	readonly msgCount: number;
	readonly septets: number;
	readonly remaining: number;
	readonly locking: number;
	readonly shift: number;
}

const tableCost = (locking: number, shift: number): number =>
	locking !== 0 && shift !== 0 ? UDH_TWO_TABLES : locking !== 0 || shift !== 0 ? UDH_ONE_TABLE : 0;

// countGsmSeptets: the least-cost table pair (fewest parts, then most septets left), in Android's
// order, skipping the pairs Android never tries (Turkish + Turkish, Portuguese + Spanish).
function gsmDetails(text: string, config: SmsConfig): Gsm | null {
	const single = config.singleShift ?? [];
	const maxShift = single.at(-1) ?? 0;
	const lockings = [0, ...(config.lockingShift ?? []).filter((t) => t !== 0 && basicOf(t) !== "")];
	let best: Gsm | null = null;
	for (const locking of lockings) {
		for (let shift = 0; shift <= maxShift; shift++) {
			if (shift !== 0 && !single.includes(shift)) continue;
			if ((locking === 1 && shift === 1) || (locking === 3 && shift === 2)) continue;
			const septets = countSeptets(text, locking, shift);
			if (septets < 0) continue;
			let udh = tableCost(locking, shift);
			if (udh !== 0) udh += UDH_LENGTH;
			let msgCount = 1;
			let remaining = MAX_SEPTETS - udh - septets;
			if (septets + udh > MAX_SEPTETS) {
				udh = (udh === 0 ? UDH_LENGTH : udh) + UDH_CONCATENATED;
				const perPart = MAX_SEPTETS - udh;
				msgCount = Math.ceil(septets / perPart);
				remaining = msgCount * perPart - septets;
			}
			const better =
				best === null ||
				msgCount < best.msgCount ||
				(msgCount === best.msgCount && remaining > best.remaining);
			if (better) best = { msgCount, septets, remaining, locking, shift };
		}
	}
	return best;
}

// fragmentText's 7-bit limit, then findGsmSeptetLimitIndex: an escape pair that would cross the
// limit moves whole to the next part. Units in neither table count one septet there (a space).
function gsmParts(text: string, gsm: Gsm): Part[] {
	let udh = tableCost(gsm.locking, gsm.shift) + (gsm.msgCount > 1 ? UDH_CONCATENATED : 0);
	if (udh !== 0) udh += UDH_LENGTH;
	const limit = MAX_SEPTETS - udh;
	const [basic, extension] = [basicOf(gsm.locking), shiftOf(gsm.shift)];
	const parts: Part[] = [];
	for (let start = 0; start < text.length; ) {
		let end = start;
		let septets = 0;
		for (; end < text.length; end++) {
			const unit = text.charAt(end);
			const cost = !basic.includes(unit) && extension.includes(unit) ? 2 : 1;
			if (septets + cost > limit) break;
			septets += cost;
		}
		parts.push({ start, end, codeUnits: septets });
		start = end;
	}
	return parts;
}

// Extended grapheme cluster starts, as java.text.BreakIterator.getCharacterInstance() finds them.
function clusterStarts(text: string): Set<number> {
	const starts = new Set([text.length]);
	for (const { index } of new Intl.Segmenter([], { granularity: "grapheme" }).segment(text)) {
		starts.add(index);
	}
	return starts;
}

const isRegionalIndicator = (codePoint: number | undefined): boolean =>
	codePoint !== undefined && codePoint >= 0x1f1e6 && codePoint <= 0x1f1ff;

// SmsMessageBase.findNextUnicodePosition: end the part on a cluster boundary, step over whole flag
// pairs, and inside a cluster longer than a part at least avoid splitting a surrogate pair.
export function findNextUnicodePosition(
	position: number,
	byteLimit: number,
	text: string,
	starts: ReadonlySet<number> = clusterStarts(text),
): number {
	let next = Math.min(position + byteLimit / 2, text.length);
	if (next < text.length && !starts.has(next)) {
		let boundary = next - 1;
		while (boundary > 0 && !starts.has(boundary)) boundary--;
		while (
			boundary + 4 <= next &&
			isRegionalIndicator(text.codePointAt(boundary)) &&
			isRegionalIndicator(text.codePointAt(boundary + 2))
		) {
			boundary += 4;
		}
		if (boundary > position) {
			next = boundary;
		} else {
			const before = text.charCodeAt(next - 1);
			if (before >= 0xd800 && before <= 0xdbff) next -= 1;
		}
	}
	return next;
}

// calcUnicodeEncodingDetails counts parts the way fragmentText cuts them.
function ucs2(text: string): Pick<Segmentation, "calculateLength" | "parts"> {
	const length = text.length;
	if (length * 2 <= MAX_BYTES) {
		const parts = length === 0 ? [] : [{ start: 0, end: length, codeUnits: length }];
		return { calculateLength: [1, length, (MAX_BYTES - length * 2) / 2, 3], parts };
	}
	const starts = clusterStarts(text);
	const parts: Part[] = [];
	let remaining = 0;
	for (let start = 0; start < length; ) {
		const end = findNextUnicodePosition(start, MAX_BYTES_WITH_HEADER, text, starts);
		if (end === length) remaining = start + MAX_BYTES_WITH_HEADER / 2 - length;
		parts.push({ start, end, codeUnits: end - start });
		start = end;
	}
	return { calculateLength: [parts.length, length, remaining, 3], parts };
}

// Candidate entries of Android's sms_7bit_translation_table.xml (common and GSM). Every other unit
// outside the default alphabet and its extension becomes a space, so the result is always GSM-7.
const TRANSLATIONS: Readonly<Record<string, string>> = {
	"\u2018": "'",
	"\u2019": "'",
	"\u201c": '"',
	"\u201d": '"',
	"\u2013": "-",
	"\u2014": "-",
	"\u00e1": "a",
	"\u00e3": "a",
	"\u00e7": "\u00c7",
};

export function translate7bit(text: string): string {
	let out = "";
	for (let i = 0; i < text.length; i++) {
		const unit = text.charAt(i);
		const gsm = basicOf(0).includes(unit) || shiftOf(0).includes(unit);
		out += gsm ? unit : (TRANSLATIONS[unit] ?? " ");
	}
	return out;
}

export function segment(body: string, config: SmsConfig = {}): Segmentation {
	const text = config.force7bit ? translate7bit(body) || body : body;
	const cdma = config.format === "3gpp2";
	// 3GPP2: one part of printable ASCII, CR and LF is 7-bit ASCII, one septet a character, and any
	// other one-part 7-bit text goes UCS-2 (no single-segment EMS); multipart texts are GSM-7.
	if (cdma && /^[\n\r\x20-\x7e]{0,160}$/.test(text)) {
		const parts = text === "" ? [] : [{ start: 0, end: text.length, codeUnits: text.length }];
		const calculateLength = [1, text.length, MAX_SEPTETS - text.length, 1] as const;
		return {
			encoding: "gsm7",
			calculateLength,
			parts,
			languageTable: 0,
			languageShiftTable: 0,
			text,
		};
	}
	const gsm = gsmDetails(text, config);
	if (gsm !== null && !(cdma && gsm.msgCount === 1)) {
		return {
			encoding: "gsm7",
			calculateLength: [gsm.msgCount, gsm.septets, gsm.remaining, 1],
			parts: gsmParts(text, gsm),
			languageTable: gsm.locking,
			languageShiftTable: gsm.shift,
			text,
		};
	}
	return { encoding: "ucs2", ...ucs2(text), languageTable: 0, languageShiftTable: 0, text };
}
