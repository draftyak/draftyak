import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
	generatePerformanceCorpusJsonl,
	MAX_PERFORMANCE_RECORD_BYTES,
	MAX_PERFORMANCE_SAMPLES,
	PERFORMANCE_CORPUS_SEED,
	PERFORMANCE_CORPUS_SIZE,
	PERFORMANCE_CORPUS_VERSION,
	PERFORMANCE_QUERY_FIXTURES,
	PerformanceFixtureError,
	type PerformanceFixtureErrorCode,
	summarizePerformanceSamples,
	validatePerformanceCorpusJsonl,
} from "../src/performance.ts";

function refuses(action: () => unknown, code: PerformanceFixtureErrorCode): boolean {
	try {
		action();
		return false;
	} catch (error) {
		return (
			error instanceof PerformanceFixtureError &&
			error.code === code &&
			error.message === code &&
			!Object.hasOwn(error, "cause")
		);
	}
}

function firstTwo(): readonly [string, string] {
	const rows = generatePerformanceCorpusJsonl();
	const first = rows.next();
	const second = rows.next();
	rows.return();
	if (first.done || second.done) throw new Error("DYTEST_FIXTURE_SETUP");
	return [first.value, second.value];
}

function replaceAt(index: number, change: (line: string) => string): Iterable<string> {
	return {
		*[Symbol.iterator](): Generator<string, void, unknown> {
			let position = 0;
			for (const line of generatePerformanceCorpusJsonl()) {
				yield position++ === index ? change(line) : line;
			}
		},
	};
}

function changedRaw(line: string, change: (raw: string) => string): string {
	const row = JSON.parse(line) as { version: number; fixtureId: string; rfc822: string };
	return `${JSON.stringify({ ...row, rfc822: change(row.rfc822) })}\n`;
}

function groupedChunks(): Iterable<string> {
	return {
		*[Symbol.iterator](): Generator<string, void, unknown> {
			let group = "";
			let count = 0;
			for (const line of generatePerformanceCorpusJsonl()) {
				group += line;
				if (++count % 3 === 0) {
					const middle = Math.floor(group.length / 2);
					yield group.slice(0, middle);
					yield group.slice(middle);
					group = "";
				}
			}
			if (group !== "") yield group;
		},
	};
}

describe("fixed synthetic performance corpus DATA", () => {
	it("generates and validates all 50,000 reproducible messages and corpus-only query fixtures", () => {
		const independentDigest = createHash("sha256");
		const ids = new Set<string>();
		const messageIds = new Set<string>();
		const matches = [0, 0, 0, 0];
		let observed = 0;
		let bytes = 0;
		let wireValid = true;
		let firstId = "";
		let lastId = "";
		function* witnessed(): Generator<string, void, unknown> {
			for (const line of generatePerformanceCorpusJsonl()) {
				independentDigest.update(line, "utf8");
				bytes += Buffer.byteLength(line, "utf8");
				const row = JSON.parse(line) as { version: number; fixtureId: string; rfc822: string };
				const parts = row.rfc822.split("\r\n\r\n");
				const headers = parts[0] ?? "";
				const body = parts[1] ?? "";
				const messageId = /^Message-ID: <([^>]+)>\r?$/m.exec(headers)?.[1] ?? "";
				wireValid &&=
					row.version === 1 &&
					/^[\x20-\x7e\r\n]+$/.test(row.rfc822) &&
					row.rfc822.endsWith("\r\n") &&
					!/[\r\n]/.test(row.rfc822.replaceAll("\r\n", "")) &&
					row.rfc822.split("\r\n").every((value) => value.length <= 78) &&
					headers.startsWith("Date: Wed, 04 Nov 2026 16:06:25 +0000\r\n") &&
					headers.includes("From: dytest-sender@addresses.invalid\r\n") &&
					headers.includes("To: dytest-recipient@addresses.invalid\r\n") &&
					headers.includes("Content-Type: text/plain; charset=us-ascii\r\n") &&
					parts.length === 2 &&
					messageId !== "";
				ids.add(row.fixtureId);
				messageIds.add(messageId);
				if (observed === 0) firstId = row.fixtureId;
				lastId = row.fixtureId;
				observed++;
				for (let index = 0; index < PERFORMANCE_QUERY_FIXTURES.length; index++) {
					const fixture = PERFORMANCE_QUERY_FIXTURES[index];
					if (fixture && new RegExp(`\\b${fixture.asciiTerm}\\b`).test(body))
						matches[index] = (matches[index] ?? 0) + 1;
				}
				yield line;
			}
		}
		const summary = validatePerformanceCorpusJsonl(witnessed());
		const second = validatePerformanceCorpusJsonl(groupedChunks());
		expect(observed).toBe(50_000);
		expect(ids.size).toBe(50_000);
		expect(messageIds.size).toBe(50_000);
		expect(wireValid).toBe(true);
		expect(firstId === "DYTEST-MESSAGE-00000" && lastId === "DYTEST-MESSAGE-49999").toBe(true);
		expect(matches).toEqual([50_000, 500, 1, 0]);
		expect(summary.messageCount).toBe(50_000);
		expect(summary.utf8Bytes).toBe(bytes);
		expect(
			summary.sha256 === independentDigest.digest("hex") && /^[a-f0-9]{64}$/.test(summary.sha256),
		).toBe(true);
		expect(summary.sha256 === second.sha256 && summary.utf8Bytes === second.utf8Bytes).toBe(true);
		expect(Object.isFrozen(summary)).toBe(true);
	}, 30_000);

	it("matches the small versioned fixture descriptor without a smaller corpus option", () => {
		const descriptor = JSON.parse(
			readFileSync(new URL("./fixtures/performance/corpus-v1.json", import.meta.url), "utf8"),
		);
		expect(descriptor.messageCount).toBe(PERFORMANCE_CORPUS_SIZE);
		expect(descriptor.version).toBe(PERFORMANCE_CORPUS_VERSION);
		expect(descriptor.seed === PERFORMANCE_CORPUS_SEED).toBe(true);
		expect(
			JSON.stringify(descriptor.queryFixtures) === JSON.stringify(PERFORMANCE_QUERY_FIXTURES),
		).toBe(true);
		expect(
			PERFORMANCE_QUERY_FIXTURES.every((fixture) => Object.isFrozen(fixture)) &&
				Object.isFrozen(PERFORMANCE_QUERY_FIXTURES),
		).toBe(true);
	});

	it("refuses a 49,999-message truncation", () => {
		function* truncated(): Generator<string, void, unknown> {
			let count = 0;
			for (const line of generatePerformanceCorpusJsonl()) if (++count < 50_000) yield line;
		}
		expect(
			refuses(() => validatePerformanceCorpusJsonl(truncated()), "PERFORMANCE_CORPUS_INVALID"),
		).toBe(true);
	}, 30_000);

	it("refuses a 50,001st record", () => {
		function* extra(): Generator<string, void, unknown> {
			yield* generatePerformanceCorpusJsonl();
			yield firstTwo()[0];
		}
		expect(
			refuses(() => validatePerformanceCorpusJsonl(extra()), "PERFORMANCE_CORPUS_INVALID"),
		).toBe(true);
	}, 30_000);

	it("refuses a count-preserving duplicate fixture identity", () => {
		const first = firstTwo()[0];
		expect(
			refuses(
				() => validatePerformanceCorpusJsonl(replaceAt(1, () => first)),
				"PERFORMANCE_CORPUS_INVALID",
			),
		).toBe(true);
	});

	it("refuses a count-preserving duplicate Message-ID", () => {
		const duplicate = replaceAt(1, (line) =>
			changedRaw(line, (raw) => raw.replace("DYTEST-MESSAGE-00001@", "DYTEST-MESSAGE-00000@")),
		);
		expect(
			refuses(() => validatePerformanceCorpusJsonl(duplicate), "PERFORMANCE_CORPUS_INVALID"),
		).toBe(true);
	});

	it("refuses a count-preserving reorder", () => {
		const [first, second] = firstTwo();
		function* reordered(): Generator<string, void, unknown> {
			let index = 0;
			for (const line of generatePerformanceCorpusJsonl())
				yield index++ === 0 ? second : index === 2 ? first : line;
		}
		expect(
			refuses(() => validatePerformanceCorpusJsonl(reordered()), "PERFORMANCE_CORPUS_INVALID"),
		).toBe(true);
	});

	it("refuses count-preserving canonical content changes", () => {
		const changed = replaceAt(0, (line) =>
			changedRaw(line, (raw) => raw.replace("dytestall", "dytestalt")),
		);
		expect(
			refuses(() => validatePerformanceCorpusJsonl(changed), "PERFORMANCE_CORPUS_INVALID"),
		).toBe(true);
	});

	const malformed: [string, (line: string) => string][] = [
		["malformed JSON", () => "not json\n"],
		["an unknown field", (line) => `${JSON.stringify({ ...JSON.parse(line), extra: true })}\n`],
		["a duplicate JSON key", (line) => line.replace('{"version":1,', '{"version":1,"version":1,')],
		["noncanonical wrapper whitespace", (line) => ` ${line}`],
		["a non-ASCII raw message", (line) => changedRaw(line, (raw) => `${raw}é`)],
		["bare LF mail lines", (line) => changedRaw(line, (raw) => raw.replaceAll("\r\n", "\n"))],
		[
			"a changed required header",
			(line) => changedRaw(line, (raw) => raw.replace("From:", "Sender:")),
		],
		["an overlong record", () => `${"x".repeat(MAX_PERFORMANCE_RECORD_BYTES + 1)}\n`],
	];
	it.each(malformed)("refuses %s in a complete-length corpus stream", (_label, change) => {
		expect(
			refuses(
				() => validatePerformanceCorpusJsonl(replaceAt(0, change)),
				"PERFORMANCE_CORPUS_INVALID",
			),
		).toBe(true);
	});

	it("requires the final JSONL record terminator", () => {
		const missing = replaceAt(49_999, (line) => line.slice(0, -1));
		expect(
			refuses(() => validatePerformanceCorpusJsonl(missing), "PERFORMANCE_CORPUS_INVALID"),
		).toBe(true);
	}, 30_000);

	it("maps an upstream iterator failure to a fixed cause-free error", () => {
		const broken = {
			[Symbol.iterator](): Iterator<string> {
				return {
					next(): IteratorResult<string, void> {
						throw new Error("DYTEST_SYNTHETIC_ITERATOR_FAILURE");
					},
				};
			},
		};
		expect(
			refuses(() => validatePerformanceCorpusJsonl(broken), "PERFORMANCE_CORPUS_INVALID"),
		).toBe(true);
	});

	it("bounds empty-frame progress before an otherwise valid full corpus", () => {
		function* stalled(): Generator<string, void, unknown> {
			for (let index = 0; index < 1_000_001; index++) yield "";
			yield* generatePerformanceCorpusJsonl();
		}
		expect(
			refuses(() => validatePerformanceCorpusJsonl(stalled()), "PERFORMANCE_CORPUS_INVALID"),
		).toBe(true);
	});
});

describe("pure nearest-rank latency arithmetic", () => {
	const ranks: [string, readonly number[], number][] = [
		["one sample", [12], 12],
		["nineteen samples", Array.from({ length: 19 }, (_, index) => index + 1), 19],
		["twenty samples", Array.from({ length: 20 }, (_, index) => index + 1), 19],
		["twenty-one samples", Array.from({ length: 21 }, (_, index) => index + 1), 20],
		["one hundred samples", Array.from({ length: 100 }, (_, index) => 100 - index), 95],
		["ties", [4, 1, 4, 2], 4],
	];
	it.each(ranks)("uses nearest rank for %s", (_label, values, expected) => {
		expect(summarizePerformanceSamples(values).p95Ms).toBe(expected);
	});

	it("does not accept the 200 ms equality boundary", () => {
		expect(summarizePerformanceSamples([200]).strictlyBelowBudget).toBe(false);
	});

	it("compares 199.999 ms without rounding it to the boundary", () => {
		const result = summarizePerformanceSamples([199.999]);
		expect(result.p95Ms).toBe(199.999);
		expect(result.strictlyBelowBudget).toBe(true);
	});

	it("keeps values above 200 ms outside the numeric budget", () => {
		expect(summarizePerformanceSamples([200.001]).strictlyBelowBudget).toBe(false);
	});

	it("does not interpolate the five-percent boundary", () => {
		const below = [...Array<number>(95).fill(199), ...Array<number>(5).fill(200)];
		const equal = [...Array<number>(94).fill(199), ...Array<number>(6).fill(200)];
		expect(summarizePerformanceSamples(below).strictlyBelowBudget).toBe(true);
		expect(summarizePerformanceSamples(equal).strictlyBelowBudget).toBe(false);
	});

	it("preserves frozen input order and returns frozen numeric DATA", () => {
		const input = Object.freeze([8, 3, 1, 5]);
		const result = summarizePerformanceSamples(input);
		expect(JSON.stringify(input) === "[8,3,1,5]").toBe(true);
		expect(result.sampleCount).toBe(4);
		expect(result.budgetMs).toBe(200);
		expect(Object.isFrozen(result)).toBe(true);
		expect(
			Object.keys(result).sort().join(",") === "budgetMs,p95Ms,sampleCount,strictlyBelowBudget",
		).toBe(true);
	});

	const invalid: [string, unknown][] = [
		["empty", []],
		["NaN", [Number.NaN]],
		["infinite", [Number.POSITIVE_INFINITY]],
		["negative", [-1]],
		["nonnumeric", ["1"]],
		["missing", [undefined]],
		["sparse", Array(2)],
		["nonarray", { 0: 1, length: 1 }],
		["oversized", Array(MAX_PERFORMANCE_SAMPLES + 1)],
	];
	it.each(invalid)("refuses %s samples with a fixed error", (_label, values) => {
		expect(
			refuses(
				() => summarizePerformanceSamples(values as readonly number[]),
				"PERFORMANCE_SAMPLES_INVALID",
			),
		).toBe(true);
	});

	it("refuses accessor samples without invoking them", () => {
		let calls = 0;
		const values = [1];
		Object.defineProperty(values, "0", {
			get: () => {
				calls++;
				return 1;
			},
		});
		expect(refuses(() => summarizePerformanceSamples(values), "PERFORMANCE_SAMPLES_INVALID")).toBe(
			true,
		);
		expect(calls).toBe(0);
	});

	it("refuses proxy samples without invoking their traps", () => {
		let calls = 0;
		const values = new Proxy([1], {
			get: () => {
				calls++;
				return 1;
			},
			ownKeys: () => {
				calls++;
				return [];
			},
		});
		expect(refuses(() => summarizePerformanceSamples(values), "PERFORMANCE_SAMPLES_INVALID")).toBe(
			true,
		);
		expect(calls).toBe(0);
	});

	it("accepts zero and preserves a finite large sample", () => {
		expect(summarizePerformanceSamples([0]).strictlyBelowBudget).toBe(true);
		expect(summarizePerformanceSamples([Number.MAX_VALUE]).p95Ms).toBe(Number.MAX_VALUE);
	});
});
