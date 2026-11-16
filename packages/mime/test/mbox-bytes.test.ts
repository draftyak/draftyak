import { describe, expect, it } from "vitest";
import { MboxError, writeMbox } from "../src/index.ts";

const ascii = (value: string): Uint8Array => new TextEncoder().encode(value);
const LF = 0x0a;
const FROM = [0x46, 0x72, 0x6f, 0x6d, 0x20] as const;
const envelope = "From sender@example.invalid Thu Jan  1 00:00:00 1970\n";

type Message = {
	raw: Uint8Array;
	envelopeFrom: string;
	receivedAtMs: number;
};

function concat(parts: readonly Uint8Array[]): Uint8Array {
	const result = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
	let offset = 0;
	for (const part of parts) {
		result.set(part, offset);
		offset += part.length;
	}
	return result;
}

function matchesFrom(bytes: Uint8Array, offset: number): boolean {
	return FROM.every((byte, index) => bytes[offset + index] === byte);
}

// Parse physical LF boundaries as octets; CR and non-text bytes remain payload.
// One final LF is framing, so raw messages with and without a terminal LF differ.
function parseBack(parts: readonly Uint8Array[]): {
	envelope: Uint8Array;
	raw: Uint8Array;
}[] {
	const archive = concat(parts);
	const starts: number[] = [];
	for (let offset = 0; offset < archive.length; offset++) {
		if ((offset === 0 || archive[offset - 1] === LF) && matchesFrom(archive, offset)) {
			starts.push(offset);
		}
	}
	if (archive.length === 0) return [];
	if (starts[0] !== 0) throw new Error("Missing initial mbox envelope");
	return starts.map((start, index) => {
		const end = starts[index + 1] ?? archive.length;
		const headerEnd = archive.indexOf(LF, start);
		if (headerEnd < start || headerEnd >= end || archive[end - 1] !== LF) {
			throw new Error("Missing mbox framing LF");
		}
		const raw: number[] = [];
		let lineStart = true;
		for (let offset = headerEnd + 1; offset < end - 1; offset++) {
			if (lineStart && archive[offset] === 0x3e) {
				let afterQuotes = offset;
				while (archive[afterQuotes] === 0x3e) afterQuotes++;
				if (matchesFrom(archive, afterQuotes)) offset++;
			}
			const byte = archive[offset];
			if (byte === undefined) throw new Error("Unexpected mbox boundary");
			raw.push(byte);
			lineStart = byte === LF;
		}
		return {
			envelope: archive.slice(start, headerEnd + 1),
			raw: Uint8Array.from(raw),
		};
	});
}

function message(raw: Uint8Array): Message {
	return { raw, envelopeFrom: "sender@example.invalid", receivedAtMs: 0 };
}

async function collect(messages: Iterable<Message> | AsyncIterable<Message>) {
	const chunks: Uint8Array[] = [];
	const snapshots: Uint8Array[] = [];
	for await (const chunk of writeMbox(messages)) {
		expect(chunk).toBeInstanceOf(Uint8Array);
		expect(chunk.length).toBeGreaterThan(0);
		expect(chunk.length).toBeLessThanOrEqual(65_536);
		chunks.push(chunk);
		snapshots.push(chunk.slice());
	}
	// Later yields must not overwrite a buffer already returned to the consumer.
	for (let index = 0; index < chunks.length; index++) {
		expect(chunks[index]).toEqual(snapshots[index]);
	}
	return { chunks, bytes: concat(chunks) };
}

describe("portable mbox byte preservation", () => {
	it("writes exact UTC framing and escapes every mboxrd quote depth", async () => {
		const raw = ascii(
			"From first\n>From second\n>>From third\n>>>From fourth\n From near\nFrom\nfrom lower\n> From gap\n",
		);
		const result = await collect([message(raw)]);
		expect(result.bytes).toEqual(
			ascii(
				`${envelope}>From first\n>>From second\n>>>From third\n>>>>From fourth\n From near\nFrom\nfrom lower\n> From gap\n\n`,
			),
		);
		expect(parseBack(result.chunks)).toEqual([{ envelope: ascii(envelope), raw }]);
	});

	it("preserves binary octets and treats only LF as a line boundary", async () => {
		const raw = concat([
			Uint8Array.from([0, 0xff, 0x80, 0xc3, 0x28]),
			ascii("\rFrom bare-cr\r\nFrom crlf\n>From lf\r\n>>From last\r"),
			Uint8Array.from([0xfe, 0, 0x81]),
		]);
		const result = await collect([message(raw)]);
		expect(result.bytes).toEqual(
			concat([
				ascii(envelope),
				Uint8Array.from([0, 0xff, 0x80, 0xc3, 0x28]),
				ascii("\rFrom bare-cr\r\n>From crlf\n>>From lf\r\n>>>From last\r"),
				Uint8Array.from([0xfe, 0, 0x81, LF]),
			]),
		);
		expect(parseBack(result.chunks)[0]?.raw).toEqual(raw);
	});

	it("counts inserted mboxrd quote bytes in the exact output budget before emitting", async () => {
		const raw = ascii("From first\n>From second");
		const expected = ascii(`${envelope}>From first\n>>From second\n`);
		const chunks: Uint8Array[] = [];
		for await (const chunk of writeMbox([message(raw)], { maxOutputBytes: expected.length })) {
			chunks.push(chunk);
		}
		expect(concat(chunks)).toEqual(expected);
		expect(parseBack(chunks)[0]?.raw).toEqual(raw);
		let emittedBytes = 0;
		let failure: unknown;
		try {
			for await (const chunk of writeMbox([message(raw)], {
				maxOutputBytes: expected.length - 1,
			})) {
				emittedBytes += chunk.length;
			}
		} catch (error) {
			failure = error;
		}
		expect(failure).toBeInstanceOf(MboxError);
		expect(failure).toMatchObject({ code: "OUTPUT_TOO_LARGE" });
		expect(emittedBytes).toBe(0);
	});

	it("distinguishes empty, missing, CR, LF and repeated terminal newlines", async () => {
		const raws = ["", "X", "X\r", "X\n", "X\r\n", "X\n\n", "\n", "\r"].map(ascii);
		const result = await collect(raws.map(message));
		expect(parseBack(result.chunks).map((record) => record.raw)).toEqual(raws);
		expect(result.bytes).toEqual(
			concat(raws.flatMap((raw) => [ascii(envelope), raw, Uint8Array.of(LF)])),
		);
	});

	it("does not emit a phantom record for an empty export", async () => {
		const result = await collect([]);
		expect(result.chunks).toEqual([]);
		expect(result.bytes).toEqual(new Uint8Array());
		expect(parseBack(result.chunks)).toEqual([]);
	});

	it("uses only the selected Uint8Array view, without surrounding backing bytes", async () => {
		const raw = concat([ascii("From offset\n"), Uint8Array.from([0, 0xff, 0x80])]);
		const backing = concat([ascii("outside-prefix"), raw, ascii("outside-suffix")]);
		const view = backing.subarray(14, 14 + raw.length);
		expect(view.byteOffset).toBeGreaterThan(0);
		const result = await collect([message(view)]);
		expect(parseBack(result.chunks)[0]?.raw).toEqual(raw);
		expect(result.bytes).toEqual(
			concat([ascii(`${envelope}>From offset\n`), Uint8Array.from([0, 0xff, 0x80, LF])]),
		);
	});

	it("produces identical archives from synchronous and asynchronous messages", async () => {
		const messages = [message(ascii("From first")), message(ascii(">From second\r\n"))];
		async function* asyncMessages() {
			for (const value of messages) {
				await Promise.resolve();
				yield value;
			}
		}
		const sync = await collect(messages);
		const asyncResult = await collect(asyncMessages());
		expect(asyncResult.bytes).toEqual(sync.bytes);
		expect(parseBack(asyncResult.chunks).map((record) => record.raw)).toEqual(
			messages.map((value) => value.raw),
		);
	});

	it.each([-2, -1, 0, 1, 2])(
		"preserves quote markers and record framing near a 64 KiB boundary (%i)",
		async (delta) => {
			const padding = new Uint8Array(65_536 - ascii(envelope).length - 1 + delta).fill(0x61);
			const raw = concat([
				padding,
				ascii("\n>>From boundary\r\n"),
				new Uint8Array(65_540).fill(0x80),
				ascii("\nFrom final"),
			]);
			const result = await collect([message(raw), message(ascii("From next record"))]);
			expect(result.chunks.length).toBeGreaterThanOrEqual(3);
			expect(parseBack(result.chunks).map((record) => record.raw)).toEqual([
				raw,
				ascii("From next record"),
			]);
			const fragmented: Uint8Array[] = [];
			for (let start = 0; start < result.bytes.length; ) {
				const size = [1, 2, 7, 65_535][fragmented.length % 4] ?? 1;
				fragmented.push(result.bytes.subarray(start, start + size));
				start += size;
			}
			expect(parseBack(fragmented)).toEqual(parseBack(result.chunks));
		},
	);

	it("snapshots each raw message before its first output and keeps yielded chunks stable", async () => {
		const raw = concat([
			ascii("From snapshot\n"),
			new Uint8Array(160_000).fill(0x83),
			ascii("\n>From tail"),
		]);
		const before = raw.slice();
		const iterator = writeMbox([message(raw)]);
		const first = await iterator.next();
		expect(first.done).toBe(false);
		if (first.done) throw new Error("Expected a first output chunk");
		const firstSnapshot = first.value.slice();
		raw.fill(0x44);
		const chunks = [first.value];
		for await (const chunk of iterator) chunks.push(chunk);
		expect(first.value).toEqual(firstSnapshot);
		expect(chunks.every((chunk) => chunk.length > 0 && chunk.length <= 65_536)).toBe(true);
		expect(parseBack(chunks)[0]?.raw).toEqual(before);
	});

	it.each([
		["sender@EXAMPLE.INVALID", "sender@example.invalid"],
		["sender@b\u00fccher.example", "sender@xn--bcher-kva.example"],
	])("canonicalizes the explicit envelope sender %s", async (input, expected) => {
		const result = await collect([
			{
				raw: ascii("From: other@example.invalid\r\n\r\nbody"),
				envelopeFrom: input,
				receivedAtMs: 0,
			},
		]);
		expect(parseBack(result.chunks)[0]?.envelope).toEqual(
			ascii(`From ${expected} Thu Jan  1 00:00:00 1970\n`),
		);
	});

	it("uses UTC leap-day fields with fixed English ctime spacing", async () => {
		const result = await collect([
			{ ...message(new Uint8Array()), receivedAtMs: Date.UTC(2000, 1, 29, 23, 59, 58) },
		]);
		expect(result.bytes).toEqual(ascii("From sender@example.invalid Tue Feb 29 23:59:58 2000\n\n"));
	});

	it.each([
		"sender@example.invalid\nFrom injected@example.invalid",
		"sender@example.invalid\rInjected: value",
		"not-an-address",
		"sender name@example.invalid",
		"",
	])("rejects an invalid envelope without emitting bytes (%s)", async (envelopeFrom) => {
		let emittedBytes = 0;
		let failure: unknown;
		try {
			for await (const chunk of writeMbox([{ ...message(ascii("body")), envelopeFrom }])) {
				emittedBytes += chunk.length;
			}
		} catch (error) {
			failure = error;
		}
		expect(failure).toBeInstanceOf(MboxError);
		expect(failure).toMatchObject({ code: "BAD_ENVELOPE" });
		expect(emittedBytes).toBe(0);
	});

	it.each([
		Number.NaN,
		Number.POSITIVE_INFINITY,
		Number.NEGATIVE_INFINITY,
		-1,
		Date.UTC(10_000, 0, 1),
	])("rejects an invalid UTC date without emitting bytes (%s)", async (receivedAtMs) => {
		let emittedBytes = 0;
		let failure: unknown;
		try {
			for await (const chunk of writeMbox([{ ...message(ascii("body")), receivedAtMs }])) {
				emittedBytes += chunk.length;
			}
		} catch (error) {
			failure = error;
		}
		expect(failure).toBeInstanceOf(MboxError);
		expect(failure).toMatchObject({ code: "BAD_DATE" });
		expect(emittedBytes).toBe(0);
	});
});
