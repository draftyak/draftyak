import { describe, expect, it, vi } from "vitest";
import {
	decodeGmailSendCandidate,
	decodeGmailSendReceipt,
} from "../../src/outbox/gmail-send-data.ts";

const parseObservation = vi.hoisted(() => ({
	enabled: false,
	bodies: [] as Uint8Array[],
}));

vi.mock("@draftyak/protocol", async (importOriginal) => {
	const original = await importOriginal<typeof import("@draftyak/protocol")>();
	const parseOriginal = original.parseStrict;
	return {
		...original,
		parseStrict(input: string | Uint8Array): unknown {
			if (parseObservation.enabled && typeof input !== "string") {
				parseObservation.bodies.push(input);
			}
			return parseOriginal(input);
		},
	};
});

const encode = (text: string): Uint8Array => new TextEncoder().encode(text);
const json = (value: unknown): Uint8Array => encode(JSON.stringify(value));

describe("Gmail send candidate DATA", () => {
	it.each([200, 201, 202, 299])("copies a valid candidate from complete status %i", (status) => {
		const body = json({ id: "message-1", threadId: "thread-1" });
		const before = body.slice();
		expect(decodeGmailSendCandidate(status, body)).toBe("message-1");
		expect(body).toEqual(before);
	});

	it.each([0, 199, 300, 400, 404, 429, 500, 200.5, Number.NaN, Number.POSITIVE_INFINITY])(
		"keeps status %s indeterminate",
		(status) => {
			expect(decodeGmailSendCandidate(status, json({ id: "message-1" }))).toBeUndefined();
		},
	);

	it.each(
		[null, true, 7, "message-1", [], {}, { id: 1 }, { id: null }].map((value) => ({ value })),
	)("refuses malformed candidate %j", ({ value }) => {
		expect(decodeGmailSendCandidate(200, json(value))).toBeUndefined();
	});

	it.each(["", "x".repeat(257), "id with space", "id\n", "id\r", "id\t", "id\u007f", "id\u00e9"])(
		"refuses invalid provider id %j",
		(id) => {
			expect(decodeGmailSendCandidate(200, json({ id }))).toBeUndefined();
		},
	);

	it("accepts the exact provider-id and body bounds", () => {
		const id = "x".repeat(256);
		const source = JSON.stringify({ id });
		const body = encode(source + " ".repeat(65_536 - source.length));
		expect(body.byteLength).toBe(65_536);
		expect(decodeGmailSendCandidate(200, body)).toBe(id);
		expect(
			decodeGmailSendCandidate(200, encode(`${source}${" ".repeat(65_537 - source.length)}`)),
		).toBeUndefined();
	});

	it.each(["", "{", '{"id":"one","id":"two"}', '{"id":"one"}{}'])(
		"refuses incomplete or ambiguous JSON %j",
		(source) => {
			expect(decodeGmailSendCandidate(200, encode(source))).toBeUndefined();
		},
	);

	it("refuses invalid UTF-8 rather than decoding a replacement character", () => {
		const prefix = encode('{"id":"');
		const body = new Uint8Array([...prefix, 0xff, ...encode('"}')]);
		expect(decodeGmailSendCandidate(200, body)).toBeUndefined();
	});

	it("copies genuine byte views without invoking caller accessors or iterators", () => {
		const body = json({ id: "message-1" });
		Object.defineProperty(body, "byteLength", {
			get: () => {
				throw new Error("accessor");
			},
		});
		Object.defineProperty(body, Symbol.iterator, {
			value: () => {
				throw new Error("iterator");
			},
		});
		expect(decodeGmailSendCandidate(200, body)).toBe("message-1");
	});

	it("rejects proxy byte views without invoking their traps", () => {
		let calls = 0;
		const body = new Proxy(json({ id: "message-1" }), {
			get() {
				calls++;
				throw new Error("proxy");
			},
		});
		expect(decodeGmailSendCandidate(200, body)).toBeUndefined();
		expect(calls).toBe(0);
	});
});

function receipt(overrides: Record<string, unknown> = {}): Record<string, unknown> {
	return {
		id: "message-1",
		threadId: "thread-1",
		internalDate: "1770000000000",
		labelIds: ["SENT", "label-1"],
		sizeEstimate: 321,
		payload: { headers: [{ name: "Message-ID", value: "<receipt@example.test>" }] },
		...overrides,
	};
}

describe("Gmail send receipt DATA", () => {
	it("projects only the actual normalized metadata and owns frozen copies", () => {
		const body = json(receipt({ snippet: "untrusted", raw: "untrusted", extra: true }));
		const before = body.slice();
		const value = decodeGmailSendReceipt("message-1", body);
		expect(value).toEqual({
			message: {
				kind: "email.message",
				providerId: "message-1",
				threadId: "thread-1",
				internalDate: 1_770_000_000_000,
				labelIds: ["SENT", "label-1"],
				sizeBytes: 321,
			},
			messageIdHeader: "<receipt@example.test>",
			bytesRead: body.byteLength,
		});
		expect(Object.isFrozen(value)).toBe(true);
		expect(Object.isFrozen(value.message)).toBe(true);
		expect(Object.isFrozen(value.message.labelIds)).toBe(true);
		expect(Object.hasOwn(value.message, "raw")).toBe(false);
		expect(body).toEqual(before);
	});

	it.each(["literal non-RFC data", " <different@example.test>\r\n\tcontinued ", " "])(
		"preserves the exact differing Message-ID literal %j",
		(literal) => {
			const body = json(
				receipt({
					payload: { headers: [{ name: "mEsSaGe-Id", value: literal }] },
				}),
			);
			expect(decodeGmailSendReceipt("message-1", body).messageIdHeader).toBe(literal);
		},
	);

	it("counts UTF-8 bytes rather than the number of decoded characters", () => {
		const literal = "<\u00e9@example.test>";
		const text = JSON.stringify(
			receipt({
				payload: { headers: [{ name: "Message-ID", value: literal }] },
			}),
		);
		const body = encode(text);
		expect(body.byteLength).toBeGreaterThan(text.length);
		expect(decodeGmailSendReceipt("message-1", body).bytesRead).toBe(body.byteLength);
	});

	it("requires the requested provider id to match the actual metadata echo", () => {
		expect(() => decodeGmailSendReceipt("another-message", json(receipt()))).toThrow();
	});

	it.each(["", "id with space", "id\n", "id\r", "\u00e9", "x".repeat(257)])(
		"refuses malformed requested, echoed and thread ids %j",
		(id) => {
			expect(() => decodeGmailSendReceipt(id, json(receipt()))).toThrow();
			expect(() => decodeGmailSendReceipt("message-1", json(receipt({ id })))).toThrow();
			expect(() => decodeGmailSendReceipt("message-1", json(receipt({ threadId: id })))).toThrow();
		},
	);

	it.each([
		null,
		true,
		1770000000000,
		"",
		"00",
		"+1",
		"-1",
		"1.5",
		"1e3",
		" 1",
		"1 ",
		"1\n",
		"9999999999999999",
	])("refuses invalid required internalDate %j", (internalDate) => {
		expect(() => decodeGmailSendReceipt("message-1", json(receipt({ internalDate })))).toThrow();
	});

	it("refuses a missing internalDate", () => {
		const value = receipt();
		delete value.internalDate;
		expect(() => decodeGmailSendReceipt("message-1", json(value))).toThrow();
	});

	it.each([null, true, "321", -1, 1.5, Number.MAX_SAFE_INTEGER + 1])(
		"refuses invalid optional sizeEstimate %j",
		(sizeEstimate) => {
			expect(() => decodeGmailSendReceipt("message-1", json(receipt({ sizeEstimate })))).toThrow();
		},
	);

	it("omits absent sizeEstimate instead of adding an undefined property", () => {
		const value = receipt();
		delete value.sizeEstimate;
		const decoded = decodeGmailSendReceipt("message-1", json(value));
		expect(Object.hasOwn(decoded.message, "sizeBytes")).toBe(false);
	});

	it.each(
		[
			null,
			"SENT",
			[1],
			["label\n"],
			[""],
			["SENT", "SENT"],
			Array.from({ length: 257 }, (_, i) => `label-${i}`),
		].map((labelIds) => ({ labelIds })),
	)("refuses malformed label metadata %j", ({ labelIds }) => {
		expect(() => decodeGmailSendReceipt("message-1", json(receipt({ labelIds })))).toThrow();
	});

	it("requires labelIds but preserves a valid empty label list", () => {
		const value = receipt();
		delete value.labelIds;
		expect(() => decodeGmailSendReceipt("message-1", json(value))).toThrow();
		expect(
			decodeGmailSendReceipt("message-1", json(receipt({ labelIds: [] }))).message.labelIds,
		).toEqual([]);
	});

	it.each(["0", "1", "18446744073709551615"])(
		"validates and drops optional historyId %s",
		(historyId) => {
			const value = decodeGmailSendReceipt("message-1", json(receipt({ historyId })));
			expect(Object.hasOwn(value.message, "historyId")).toBe(false);
		},
	);

	it.each([
		null,
		1,
		true,
		"",
		"00",
		"+1",
		"-1",
		"1.5",
		"1e3",
		"1\n",
		"18446744073709551616",
		"100000000000000000000",
	])("refuses malformed optional historyId %j", (historyId) => {
		expect(() => decodeGmailSendReceipt("message-1", json(receipt({ historyId })))).toThrow();
	});

	it.each(
		[
			[],
			[{ name: "Message-ID", value: "" }],
			[{ name: "Message-ID\n", value: "literal" }],
			[
				{ name: "Message-ID", value: "one" },
				{ name: "message-id", value: "two" },
			],
			[
				{ name: "Message-ID", value: "one" },
				{ name: "MESSAGE-ID", value: "one" },
			],
		].map((headers) => ({ headers })),
	)("refuses missing, empty or duplicate Message-ID headers %j", ({ headers }) => {
		expect(() =>
			decodeGmailSendReceipt("message-1", json(receipt({ payload: { headers } }))),
		).toThrow();
	});

	it.each(
		[
			null,
			[],
			"header",
			{},
			{ name: "Subject" },
			{ name: 3, value: "subject" },
			{ name: "Subject", value: 3 },
		].map((header) => ({ header })),
	)("refuses malformed unrelated headers %j", ({ header }) => {
		const headers = [{ name: "Message-ID", value: "literal" }, header];
		expect(() =>
			decodeGmailSendReceipt("message-1", json(receipt({ payload: { headers } }))),
		).toThrow();
	});

	it.each(
		[null, [], "payload", {}, { headers: null }, { headers: {} }].map((payload) => ({ payload })),
	)("refuses malformed payload/header containers %j", ({ payload }) => {
		expect(() => decodeGmailSendReceipt("message-1", json(receipt({ payload })))).toThrow();
	});

	it("refuses duplicate JSON keys before projecting the metadata", () => {
		const text = JSON.stringify(receipt()).replace(
			'"id":"message-1"',
			'"id":"other","id":"message-1"',
		);
		expect(() => decodeGmailSendReceipt("message-1", encode(text))).toThrow();
	});

	it("refuses invalid UTF-8 metadata with a fixed data error", () => {
		const body = new Uint8Array([...encode('{"id":"'), 0xff, ...encode('"}')]);
		expect(() => decodeGmailSendReceipt("message-1", body)).toThrow(
			"Invalid Gmail send receipt data",
		);
	});

	it("accepts exactly the metadata byte bound and refuses one additional byte", () => {
		const text = JSON.stringify(receipt());
		const limit = 4 * 1_048_576;
		const body = encode(text + " ".repeat(limit - text.length));
		expect(decodeGmailSendReceipt("message-1", body).bytesRead).toBe(limit);
		expect(() =>
			decodeGmailSendReceipt("message-1", encode(text + " ".repeat(limit + 1 - text.length))),
		).toThrow();
	});
});

describe("owned Gmail response bytes", () => {
	it.each([
		{
			name: "candidate success",
			body: () => json({ id: "message-1", snippet: "unprojected provider data" }),
			run: (body: Uint8Array) => decodeGmailSendCandidate(200, body),
			throws: false,
		},
		{
			name: "candidate JSON refusal",
			body: () => encode("{"),
			run: (body: Uint8Array) => decodeGmailSendCandidate(200, body),
			throws: false,
		},
		{
			name: "candidate field refusal",
			body: () => json({ id: "bad id", snippet: "unprojected provider data" }),
			run: (body: Uint8Array) => decodeGmailSendCandidate(200, body),
			throws: false,
		},
		{
			name: "metadata success",
			body: () => json(receipt({ raw: "unprojected provider data" })),
			run: (body: Uint8Array) => decodeGmailSendReceipt("message-1", body),
			throws: false,
		},
		{
			name: "metadata JSON refusal",
			body: () => encode("{"),
			run: (body: Uint8Array) => decodeGmailSendReceipt("message-1", body),
			throws: true,
		},
		{
			name: "metadata projection refusal",
			body: () => json(receipt({ labelIds: ["SENT", "SENT"] })),
			run: (body: Uint8Array) => decodeGmailSendReceipt("message-1", body),
			throws: true,
		},
	])("zeroes the actual parser's copied bytes after $name", (test) => {
		const body = test.body();
		const before = body.slice();
		let result: unknown;
		let observed: Uint8Array[] = [];
		parseObservation.bodies.length = 0;
		parseObservation.enabled = true;
		try {
			if (test.throws) expect(() => test.run(body)).toThrow();
			else result = test.run(body);
		} finally {
			parseObservation.enabled = false;
			observed = parseObservation.bodies.splice(0);
		}
		expect(observed).toHaveLength(1);
		const owned = observed[0];
		expect(owned).not.toBe(body);
		expect(owned?.byteLength).toBe(body.byteLength);
		expect(owned?.every((byte) => byte === 0)).toBe(true);
		expect(body).toEqual(before);
		if (test.name === "candidate success") expect(result).toBe("message-1");
		if (test.name === "metadata success") {
			expect(result).toMatchObject({
				message: { providerId: "message-1", labelIds: ["SENT", "label-1"] },
				messageIdHeader: "<receipt@example.test>",
				bytesRead: body.byteLength,
			});
			expect(Object.isFrozen(result)).toBe(true);
		}
	});
});
