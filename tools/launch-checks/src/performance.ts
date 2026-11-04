import { createHash } from "node:crypto";
import { types } from "node:util";

export const PERFORMANCE_CORPUS_VERSION = 1;
export const PERFORMANCE_CORPUS_SIZE = 50_000;
export const PERFORMANCE_CORPUS_SEED = "DYTEST-FTS-2026-V1";
export const PERFORMANCE_BUDGET_MS = 200;
export const MAX_PERFORMANCE_RECORD_BYTES = 16_384;
export const MAX_PERFORMANCE_SAMPLES = 1_000_000;

const MAX_CORPUS_CHUNKS = 1_000_000;
const MAX_CORPUS_BYTES = PERFORMANCE_CORPUS_SIZE * MAX_PERFORMANCE_RECORD_BYTES;
const CRLF = "\r\n";
const FIXTURE_DATE = "Wed, 04 Nov 2026 16:06:25 +0000";
const SEED_NUMBER = createHash("sha256")
	.update(PERFORMANCE_CORPUS_SEED, "ascii")
	.digest()
	.readUInt32BE(0);
const WORDS = [
	"amber",
	"birch",
	"cedar",
	"delta",
	"elm",
	"fern",
	"grove",
	"harbor",
	"iris",
	"juniper",
	"kite",
	"larch",
	"maple",
	"north",
	"olive",
	"pine",
] as const;

export type PerformanceFixtureErrorCode =
	| "PERFORMANCE_CORPUS_INVALID"
	| "PERFORMANCE_SAMPLES_INVALID";

export class PerformanceFixtureError extends Error {
	readonly code: PerformanceFixtureErrorCode;

	constructor(code: PerformanceFixtureErrorCode) {
		super(code);
		this.name = "PerformanceFixtureError";
		this.code = code;
	}
}

export interface PerformanceCorpusRecord {
	readonly version: 1;
	readonly fixtureId: string;
	readonly rfc822: string;
}

export interface PerformanceCorpusSummary {
	readonly version: 1;
	readonly messageCount: number;
	readonly utf8Bytes: number;
	readonly sha256: string;
}

export interface PerformanceQueryFixture {
	readonly fixtureId: string;
	readonly asciiTerm: string;
	readonly expectedCorpusMatches: number;
}

export interface PerformanceSampleSummary {
	readonly sampleCount: number;
	readonly p95Ms: number;
	readonly budgetMs: 200;
	readonly strictlyBelowBudget: boolean;
}

// These are literal corpus terms, not application search requests or FTS results.
export const PERFORMANCE_QUERY_FIXTURES: readonly PerformanceQueryFixture[] = Object.freeze([
	Object.freeze({
		fixtureId: "DYTEST-QUERY-ALL",
		asciiTerm: "dytestall",
		expectedCorpusMatches: 50_000,
	}),
	Object.freeze({
		fixtureId: "DYTEST-QUERY-BUCKET",
		asciiTerm: "dytestbucket07",
		expectedCorpusMatches: 500,
	}),
	Object.freeze({
		fixtureId: "DYTEST-QUERY-ONE",
		asciiTerm: "dytestunique12345",
		expectedCorpusMatches: 1,
	}),
	Object.freeze({
		fixtureId: "DYTEST-QUERY-NONE",
		asciiTerm: "dytestabsent",
		expectedCorpusMatches: 0,
	}),
]);

function corpusInvalid(): never {
	throw new PerformanceFixtureError("PERFORMANCE_CORPUS_INVALID");
}

function samplesInvalid(): never {
	throw new PerformanceFixtureError("PERFORMANCE_SAMPLES_INVALID");
}

function suffix(index: number): string {
	return String(index).padStart(5, "0");
}

function seededLine(index: number): string {
	let state = (SEED_NUMBER ^ index) >>> 0;
	const words: string[] = [];
	for (let position = 0; position < 8; position++) {
		state ^= state << 13;
		state ^= state >>> 17;
		state ^= state << 5;
		state >>>= 0;
		const word = WORDS[state & 15];
		if (word === undefined) corpusInvalid();
		words.push(word);
	}
	return `DYTEST seeded ${words.join(" ")}`;
}

function message(index: number): string {
	const id = suffix(index);
	const bucket = String(index % 100).padStart(2, "0");
	const lineCount = index % 10 < 6 ? 4 : index % 10 < 9 ? 16 : 64;
	const line = seededLine(index);
	const headers = [
		`Date: ${FIXTURE_DATE}`,
		"From: dytest-sender@addresses.invalid",
		"To: dytest-recipient@addresses.invalid",
		`Message-ID: <DYTEST-MESSAGE-${id}@messages.addresses.invalid>`,
		`Subject: DYTEST synthetic FTS message ${id}`,
		"MIME-Version: 1.0",
		"Content-Type: text/plain; charset=us-ascii",
		"Content-Transfer-Encoding: 7bit",
	];
	const body = [
		"DYTEST corpus dytestall",
		`DYTEST partition dytestbucket${bucket}`,
		`DYTEST identity dytestunique${id}`,
		...Array<string>(lineCount).fill(line),
	];
	return `${headers.join(CRLF)}${CRLF}${CRLF}${body.join(CRLF)}${CRLF}`;
}

function record(index: number): PerformanceCorpusRecord {
	return Object.freeze({
		version: PERFORMANCE_CORPUS_VERSION,
		fixtureId: `DYTEST-MESSAGE-${suffix(index)}`,
		rfc822: message(index),
	});
}

/** Fixed fixture DATA only. No count override, search adapter or measurement. */
export function* generatePerformanceCorpusJsonl(): Generator<string, void, unknown> {
	for (let index = 0; index < PERFORMANCE_CORPUS_SIZE; index++) {
		yield `${JSON.stringify(record(index))}\n`;
	}
}

function validateRecord(
	line: string,
	index: number,
): Readonly<{ fixtureId: string; messageId: string }> {
	if (
		index >= PERFORMANCE_CORPUS_SIZE ||
		line.length > MAX_PERFORMANCE_RECORD_BYTES ||
		/[^\x20-\x7e]/.test(line)
	)
		corpusInvalid();
	const value: unknown = JSON.parse(line);
	if (value === null || typeof value !== "object" || Array.isArray(value)) corpusInvalid();
	const keys = Object.keys(value);
	if (keys.join(",") !== "version,fixtureId,rfc822") corpusInvalid();
	const row = value as Record<string, unknown>;
	if (
		row.version !== PERFORMANCE_CORPUS_VERSION ||
		typeof row.fixtureId !== "string" ||
		typeof row.rfc822 !== "string"
	)
		corpusInvalid();
	const raw = row.rfc822;
	if (
		/[^\x20-\x7e\r\n]/.test(raw) ||
		!raw.endsWith(CRLF) ||
		/[\r\n]/.test(raw.replaceAll(CRLF, ""))
	)
		corpusInvalid();
	const divider = raw.indexOf(`${CRLF}${CRLF}`);
	if (divider < 0) corpusInvalid();
	const headers = raw.slice(0, divider).split(CRLF);
	if (headers.length !== 8 || headers.some((header) => header.length > 78)) corpusInvalid();
	const messageId = /^Message-ID: <(DYTEST-MESSAGE-\d{5}@messages\.addresses\.invalid)>$/.exec(
		headers[3] ?? "",
	)?.[1];
	if (messageId === undefined) corpusInvalid();
	const expected = record(index);
	if (
		row.fixtureId !== expected.fixtureId ||
		raw !== expected.rfc822 ||
		line !== JSON.stringify(expected)
	)
		corpusInvalid();
	return Object.freeze({ fixtureId: row.fixtureId, messageId });
}

/** Validates the complete canonical versioned fixture, including its fixed ordering. */
export function validatePerformanceCorpusJsonl(chunks: Iterable<string>): PerformanceCorpusSummary {
	try {
		const digest = createHash("sha256");
		const ids = new Set<string>();
		const messageIds = new Set<string>();
		let pending = "";
		let count = 0;
		let bytes = 0;
		let chunkCount = 0;
		const consume = (line: string): void => {
			const row = validateRecord(line, count);
			if (ids.has(row.fixtureId) || messageIds.has(row.messageId)) corpusInvalid();
			ids.add(row.fixtureId);
			messageIds.add(row.messageId);
			digest.update(`${line}\n`, "utf8");
			count++;
		};
		for (const chunk of chunks) {
			if (
				typeof chunk !== "string" ||
				++chunkCount > MAX_CORPUS_CHUNKS ||
				/[^\x20-\x7e\n]/.test(chunk)
			)
				corpusInvalid();
			bytes += Buffer.byteLength(chunk, "utf8");
			if (bytes > MAX_CORPUS_BYTES) corpusInvalid();
			let start = 0;
			for (;;) {
				const end = chunk.indexOf("\n", start);
				if (end < 0) {
					const tail = chunk.slice(start);
					if (pending.length + tail.length > MAX_PERFORMANCE_RECORD_BYTES) corpusInvalid();
					pending += tail;
					break;
				}
				const piece = chunk.slice(start, end);
				if (pending.length + piece.length > MAX_PERFORMANCE_RECORD_BYTES) corpusInvalid();
				consume(pending + piece);
				pending = "";
				start = end + 1;
			}
		}
		if (
			pending !== "" ||
			count !== PERFORMANCE_CORPUS_SIZE ||
			ids.size !== PERFORMANCE_CORPUS_SIZE ||
			messageIds.size !== PERFORMANCE_CORPUS_SIZE
		)
			corpusInvalid();
		return Object.freeze({
			version: PERFORMANCE_CORPUS_VERSION,
			messageCount: count,
			utf8Bytes: bytes,
			sha256: digest.digest("hex"),
		});
	} catch {
		throw new PerformanceFixtureError("PERFORMANCE_CORPUS_INVALID");
	}
}

function snapshotSamples(samples: readonly number[]): number[] {
	if (types.isProxy(samples) || !Array.isArray(samples)) samplesInvalid();
	const properties = Object.getOwnPropertyDescriptors(samples);
	const length: unknown = Object.getOwnPropertyDescriptor(samples, "length")?.value;
	if (
		typeof length !== "number" ||
		!Number.isSafeInteger(length) ||
		length < 1 ||
		length > MAX_PERFORMANCE_SAMPLES ||
		Reflect.ownKeys(properties).length !== length + 1
	)
		samplesInvalid();
	const copy: number[] = [];
	for (let index = 0; index < length; index++) {
		const property = properties[String(index)];
		if (
			property === undefined ||
			!Object.hasOwn(property, "value") ||
			typeof property.value !== "number" ||
			!Number.isFinite(property.value) ||
			property.value < 0
		)
			samplesInvalid();
		copy.push(property.value);
	}
	return copy;
}

/** Numeric comparison only; does not collect or authenticate measurement samples. */
export function summarizePerformanceSamples(samples: readonly number[]): PerformanceSampleSummary {
	const sorted = snapshotSamples(samples).sort((left, right) => left - right);
	const p95Ms = sorted[Math.ceil((sorted.length * 95) / 100) - 1];
	if (p95Ms === undefined) samplesInvalid();
	return Object.freeze({
		sampleCount: sorted.length,
		p95Ms,
		budgetMs: PERFORMANCE_BUDGET_MS,
		strictlyBelowBudget: p95Ms < PERFORMANCE_BUDGET_MS,
	});
}
