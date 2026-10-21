import { generateKeyPairSync } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SNAPSHOT_IDS } from "../scripts/vectors/snapshot.ts";
import { example as pairExample } from "../scripts/vectors/statements/pair-confirm.ts";
import { example as sendExample } from "../scripts/vectors/statements/send.ts";
import * as api from "../src/device-api.ts";
import { canonicalize } from "../src/jcs.ts";
import { exportSpki } from "../src/sign.ts";

const key = exportSpki(generateKeyPairSync("ec", { namedCurve: "prime256v1" }).publicKey);
const encode = (value: unknown): string => Buffer.from(canonicalize(value)).toString("base64url");
const sendText = encode(sendExample());
const pairText = encode(pairExample(key, key));
const envelope = (statement: string) => ({
	statement,
	signature: Buffer.alloc(64).toString("base64url"),
	pin: "123456",
});

afterEach(() => vi.restoreAllMocks());

describe("route bindings use the schema's checked projection", () => {
	it("keeps ordinary matching and mismatched response kinds distinct", () => {
		expect(
			api.checkRouteResponse("send-approval", {
				kind: "approval.send.v1",
				id: SNAPSHOT_IDS.outbox,
			}),
		).toBe(true);
		expect(
			api.checkRouteResponse("send-approval", {
				kind: "pair-confirm.v1",
				id: SNAPSHOT_IDS.outbox,
			}),
		).toBe(false);
	});

	it("does not replace a checked wrong response kind with a later getter value", () => {
		let parsed = false;
		let checkedKind: string | undefined;
		let postParseReads = 0;
		const parse = api.Accepted.safeParse;
		vi.spyOn(api.Accepted, "safeParse").mockImplementation((input, params) => {
			const result = parse(input, params);
			if (result.success) checkedKind = result.data.kind;
			parsed = true;
			return result;
		});
		const candidate = {
			id: SNAPSHOT_IDS.outbox,
			get kind() {
				if (parsed) {
					postParseReads++;
					return "approval.send.v1";
				}
				return "pair-confirm.v1";
			},
		};
		const accepted = api.checkRouteResponse("send-approval", candidate);
		expect({ accepted, checkedKind, postParseReads }).toEqual({
			accepted: false,
			checkedKind: "pair-confirm.v1",
			postParseReads: 0,
		});
	});

	it("accepts a checked matching response without touching a later throwing getter", () => {
		let parsed = false;
		const parse = api.Accepted.safeParse;
		vi.spyOn(api.Accepted, "safeParse").mockImplementation((input, params) => {
			const result = parse(input, params);
			parsed = true;
			return result;
		});
		const candidate = {
			id: SNAPSHOT_IDS.outbox,
			get kind() {
				if (parsed) throw new Error("original response was read after parsing");
				return "approval.send.v1";
			},
		};
		expect(api.checkRouteResponse("send-approval", candidate)).toBe(true);
	});

	it("keeps ordinary matching and mismatched typed statements distinct", () => {
		expect(api.checkRouteRequest("send-approval", envelope(sendText))).toBe(true);
		expect(api.checkRouteRequest("send-approval", envelope(pairText))).toBe(false);
	});

	it("does not replace the checked wrong statement type with a later getter value", () => {
		let parsed = false;
		let checkedStatement: string | undefined;
		let postParseReads = 0;
		const parse = api.SignedEnvelope.safeParse;
		vi.spyOn(api.SignedEnvelope, "safeParse").mockImplementation((input, params) => {
			const result = parse(input, params);
			if (result.success) checkedStatement = result.data.statement;
			parsed = true;
			return result;
		});
		const candidate = {
			...envelope(pairText),
			get statement() {
				if (parsed) {
					postParseReads++;
					return sendText;
				}
				return pairText;
			},
		};
		const accepted = api.checkRouteRequest("send-approval", candidate);
		expect({ accepted, checkedStatement, postParseReads }).toEqual({
			accepted: false,
			checkedStatement: pairText,
			postParseReads: 0,
		});
	});

	it("accepts the checked matching statement without rereading the original", () => {
		let parsed = false;
		const parse = api.SignedEnvelope.safeParse;
		vi.spyOn(api.SignedEnvelope, "safeParse").mockImplementation((input, params) => {
			const result = parse(input, params);
			parsed = true;
			return result;
		});
		const candidate = {
			...envelope(sendText),
			get statement() {
				if (parsed) throw new Error("original statement was read after parsing");
				return sendText;
			},
		};
		expect(api.checkRouteRequest("send-approval", candidate)).toBe(true);
	});
});

function padded(value: unknown, size: number): Uint8Array {
	const json = new TextEncoder().encode(JSON.stringify(value));
	expect(json.byteLength).toBeLessThanOrEqual(size);
	const bytes = new Uint8Array(size).fill(0x20);
	bytes.set(json);
	return bytes;
}

const byteCases = [
	{
		name: "bootstrap request",
		cap: 1024,
		value: { pin: "123456" },
		check: (bytes: Uint8Array) => api.checkRouteRequestBytes("bootstrap", bytes),
	},
	{
		name: "sync-pause request",
		cap: 1024,
		value: { paused: true },
		check: (bytes: Uint8Array) => api.checkRouteRequestBytes("sync-pause", bytes),
	},
	{
		name: "sync-pause response",
		cap: 1024,
		value: { paused: true },
		check: (bytes: Uint8Array) => api.checkRouteResponseBytes("sync-pause", bytes),
	},
	{
		name: "error response",
		cap: 1024,
		value: { code: "INVALID_REQUEST" },
		check: (bytes: Uint8Array) => api.checkApiErrorBytes(bytes, 400),
	},
	{
		name: "event response",
		cap: 65_536,
		value: { type: "ready", cursor: "" },
		check: (bytes: Uint8Array) => api.checkRouteResponseBytes("events", bytes),
	},
];

describe.each(byteCases)("received byte extent: $name", ({ cap, value, check }) => {
	it("accepts the exact cap and refuses actual cap plus one", () => {
		expect(check(padded(value, cap))).toBe(true);
		expect(check(padded(value, cap + 1))).toBe(false);
	});

	it("refuses actual over-cap bytes with shadowed shorter lengths", () => {
		const prefixLength = new TextEncoder().encode(JSON.stringify(value)).byteLength;
		for (const length of [0, prefixLength]) {
			const bytes = padded(value, cap + 1);
			Object.defineProperty(bytes, "byteLength", { value: length });
			expect(check(bytes), `reported length ${length}`).toBe(false);
		}
	});

	it("accepts an exact-cap view with a shadow oversized byteLength", () => {
		const bytes = padded(value, cap);
		Object.defineProperty(bytes, "byteLength", { value: cap + 1 });
		expect(check(bytes)).toBe(true);
	});

	it("uses only the subarray view, excluding its backing prefix and suffix", () => {
		const backing = new Uint8Array(cap + 14).fill(0xff);
		backing.set(padded(value, cap), 7);
		expect(check(backing.subarray(7, cap + 7))).toBe(true);
		expect(check(backing)).toBe(false);
	});

	it("accepts a Buffer view and ignores shadowed view metadata", () => {
		const backing = Buffer.alloc(cap + 20, 0xff);
		backing.set(padded(value, cap), 10);
		const bytes = backing.subarray(10, cap + 10);
		for (const name of ["buffer", "byteOffset", "byteLength"]) {
			Object.defineProperty(bytes, name, {
				get() {
					throw new Error("shadowed view metadata was read");
				},
			});
		}
		expect(check(bytes)).toBe(true);
	});

	it("does not consult a genuine view's caller-controlled iterator or length", () => {
		const bytes = padded(value, cap);
		for (const property of [Symbol.iterator, "length"]) {
			Object.defineProperty(bytes, property, {
				get() {
					throw new Error("caller-controlled iteration was requested");
				},
			});
		}
		expect(check(bytes)).toBe(true);
	});

	it("refuses non-byte views, proxies and fake byte objects without throwing", () => {
		const bytes = padded(value, 128);
		const invalid = [
			null,
			undefined,
			{ byteLength: 0 },
			new DataView(bytes.buffer),
			new Uint8ClampedArray(bytes),
			new Proxy(bytes, {}),
		];
		for (const candidate of invalid) {
			expect(() => check(candidate as Uint8Array)).not.toThrow();
			expect(check(candidate as Uint8Array)).toBe(false);
		}
	});
});

describe("statement-length byte-view boundary", () => {
	it("uses the actual view at the exact cap and cap plus one", () => {
		expect(api.checkStatementLength(new Uint8Array(api.MAX_STATEMENT_BYTES))).toBe(true);
		expect(api.checkStatementLength(new Uint8Array(api.MAX_STATEMENT_BYTES + 1))).toBe(false);
		const tooLarge = new Uint8Array(api.MAX_STATEMENT_BYTES + 1);
		Object.defineProperty(tooLarge, "byteLength", { value: 0 });
		expect(api.checkStatementLength(tooLarge)).toBe(false);
		const exact = new Uint8Array(api.MAX_STATEMENT_BYTES);
		Object.defineProperty(exact, "byteLength", { value: api.MAX_STATEMENT_BYTES + 1 });
		expect(api.checkStatementLength(exact)).toBe(true);
	});

	it("checks a Buffer subarray extent rather than the backing allocation", () => {
		const backing = Buffer.alloc(api.MAX_STATEMENT_BYTES + 20);
		expect(api.checkStatementLength(backing.subarray(10, api.MAX_STATEMENT_BYTES + 10))).toBe(true);
		expect(api.checkStatementLength(backing)).toBe(false);
	});

	it("accepts an exact-cap native extent without consulting a throwing byteLength", () => {
		const bytes = new Uint8Array(api.MAX_STATEMENT_BYTES);
		Object.defineProperty(bytes, "byteLength", {
			get() {
				throw new Error("shadowed statement length was read");
			},
		});
		expect(() => api.checkStatementLength(bytes)).not.toThrow();
		expect(api.checkStatementLength(bytes)).toBe(true);
	});

	it("refuses fake byte objects and proxies without throwing", () => {
		for (const candidate of [
			null,
			undefined,
			{ byteLength: 0 },
			new DataView(new ArrayBuffer(1)),
			new Uint8ClampedArray(1),
			new Proxy(new Uint8Array(1), {}),
		]) {
			expect(() => api.checkStatementLength(candidate as Uint8Array)).not.toThrow();
			expect(api.checkStatementLength(candidate as Uint8Array)).toBe(false);
		}
	});
});

it("retains strict parsing and absence-only request bodies", () => {
	expect(api.checkRouteRequestBytes("status", undefined)).toBe(true);
	expect(api.checkRouteRequestBytes("status", new Uint8Array())).toBe(false);
	for (const bytes of [
		new Uint8Array([0xff]),
		new TextEncoder().encode('{"paused":true,"paused":false}'),
		new TextEncoder().encode('{"paused":true'),
	]) {
		expect(api.checkRouteRequestBytes("sync-pause", bytes)).toBe(false);
		expect(api.checkRouteResponseBytes("sync-pause", bytes)).toBe(false);
	}
});

describe("event-stream input stability", () => {
	const ready = { type: "ready", cursor: "" };
	const event = { type: "event", cursor: "next", kind: "outbox.changed", ids: [] };
	const reset = { type: "reset", reason: "epoch_changed" };

	it("retains ready-first acceptance and event-first refusal", () => {
		expect(api.checkEventStream([ready, event])).toBe(true);
		expect(api.checkEventStream([event])).toBe(false);
	});

	it("does not skip a nonempty invalid stream when its live length changes", () => {
		let reads = 0;
		const frames = new Proxy([event], {
			get(target, property, receiver) {
				if (property === "length") return reads++ === 0 ? 1 : 0;
				return Reflect.get(target, property, receiver);
			},
		});
		expect(api.checkEventStream(frames)).toBe(false);
	});

	it("does not replace an event-first frame between size and position validation", () => {
		let reads = 0;
		const frames: unknown[] = [event];
		Object.defineProperty(frames, 0, {
			get: () => (reads++ === 0 ? event : ready),
		});
		expect(api.checkEventStream(frames)).toBe(false);
	});

	it("keeps reset terminal in ordinary streams", () => {
		expect(api.checkEventStream([ready, reset])).toBe(true);
		expect(api.checkEventStream([ready, reset, event])).toBe(false);
	});

	it("keeps reset terminal when the caller changes the reported tail length", () => {
		let nextLengthIsResetPosition = false;
		const frames = new Proxy([ready, reset, event], {
			get(target, property, receiver) {
				if (property === "1") nextLengthIsResetPosition = true;
				if (property === "length" && nextLengthIsResetPosition) {
					nextLengthIsResetPosition = false;
					return 2;
				}
				return Reflect.get(target, property, receiver);
			},
		});
		expect(api.checkEventStream(frames)).toBe(false);
	});
});

describe("error-value refusal boundary", () => {
	it("accepts a valid error with its matching status only", () => {
		expect(api.checkApiError({ code: "INVALID_REQUEST" }, 400)).toBe(true);
		expect(api.checkApiError({ code: "INVALID_REQUEST" }, 403)).toBe(false);
	});

	it("returns false without throwing when reading the caller's error code throws", () => {
		const value = {
			get code() {
				throw new Error("synthetic code getter failure");
			},
		};
		expect(() => api.checkApiError(value, 400)).not.toThrow();
		expect(api.checkApiError(value, 400)).toBe(false);
	});
});
