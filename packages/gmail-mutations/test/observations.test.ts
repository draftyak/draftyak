import { Buffer } from "node:buffer";
import { describe, expect, it } from "vitest";
import { GmailMutationError } from "../src/input.ts";
import { MAX_OBSERVATION_BYTES, observeGmailMutation } from "../src/observe.ts";

const first = "a1";
const second = "b2";
const encoder = new TextEncoder();
const request = (ids: readonly string[] = [first]) => ({
	op: "archive" as const,
	messages: ids.map((providerId) => ({ kind: "email" as const, providerId })),
});
const document = (id = first, extra: Record<string, unknown> = {}) => ({
	id,
	threadId: "cafe01",
	labelIds: ["STARRED"],
	...extra,
});
const bytes = (value: unknown = document()): Uint8Array => encoder.encode(JSON.stringify(value));
const row = (id = first, body: unknown = bytes(document(id)), status = 200) => ({
	providerId: id,
	status,
	body,
});
function unverified(body: unknown): void {
	const result = observeGmailMutation(request(), [row(first, body)]);
	expect(result.completeObservation).toBe(false);
	expect(result.observations).toEqual([{ requestedId: first, state: "unverified" }]);
}
function fixedRefusal(value: unknown): void {
	let caught: unknown;
	try {
		observeGmailMutation(request(), value);
	} catch (error) {
		caught = error;
	}
	expect(caught).toBeInstanceOf(GmailMutationError);
	expect((caught as Error).message).toBe("Gmail mutation data refused");
}

describe("bounded provider observations", () => {
	it("projects only matched provider DATA and freezes the detached result", () => {
		const payload = bytes(
			document(first, {
				snippet: "DYTEST-UNSELECTED-PROVIDER-TEXT",
				payload: { body: { data: "DYTEST-UNSELECTED-BODY" } },
			}),
		);
		const original = request();
		const result = observeGmailMutation(original, [row(first, payload)]);
		expect(result).toEqual({
			completeObservation: true,
			observations: [
				{
					requestedId: first,
					state: "observed",
					provider: { untrusted: true, id: first, threadId: "cafe01", labelIds: ["STARRED"] },
				},
			],
		});
		const observed = result.observations[0];
		if (!observed || !("provider" in observed) || !observed.provider)
			throw new Error("Expected provider DATA");
		for (const value of [
			result,
			result.observations,
			observed,
			observed.provider,
			observed.provider.labelIds,
		])
			expect(Object.isFrozen(value)).toBe(true);
		payload.fill(0);
		original.messages[0]!.providerId = second;
		expect(observed.requestedId).toBe(first);
		expect(observed.provider.labelIds).toEqual(["STARRED"]);
		expect(JSON.stringify(result)).not.toContain("DYTEST-UNSELECTED");
	});

	it("matches response rows by id while preserving requested order", () => {
		const result = observeGmailMutation(request([first, second]), [row(second), row(first)]);
		expect(result.completeObservation).toBe(true);
		expect(
			result.observations.map((value) => [
				value.requestedId,
				"provider" in value ? value.provider?.id : undefined,
			]),
		).toEqual([
			[first, first],
			[second, second],
		]);
	});

	it("uses a Buffer subarray extent rather than its larger backing allocation", () => {
		const encoded = bytes();
		const backing = Buffer.alloc(MAX_OBSERVATION_BYTES + 1_024, 0xff);
		backing.set(encoded, 64);
		const view = backing.subarray(64, 64 + encoded.byteLength);
		expect(view.buffer.byteLength).toBeGreaterThan(MAX_OBSERVATION_BYTES);
		expect(observeGmailMutation(request(), [row(first, view)]).completeObservation).toBe(true);
	});

	it.each([MAX_OBSERVATION_BYTES - 1, MAX_OBSERVATION_BYTES])(
		"accepts a complete valid JSON view of exactly %i bytes",
		(size) => {
			const source = JSON.stringify(document());
			const body = encoder.encode(source + " ".repeat(size - source.length));
			expect(body.byteLength).toBe(size);
			expect(observeGmailMutation(request(), [row(first, body)]).completeObservation).toBe(true);
		},
	);

	it("bounds an oversized native view before caller byte properties or iterators", () => {
		const source = JSON.stringify(document());
		const body = encoder.encode(source + " ".repeat(MAX_OBSERVATION_BYTES + 1 - source.length));
		const calls = { length: 0, offset: 0, buffer: 0, iterator: 0 };
		Object.defineProperties(body, {
			byteLength: {
				get() {
					calls.length++;
					return 0;
				},
			},
			byteOffset: {
				get() {
					calls.offset++;
					throw new Error("DYTEST-byte-offset-hook");
				},
			},
			buffer: {
				get() {
					calls.buffer++;
					throw new Error("DYTEST-byte-buffer-hook");
				},
			},
			[Symbol.iterator]: {
				get() {
					calls.iterator++;
					throw new Error("DYTEST-byte-iterator-hook");
				},
			},
		});
		unverified(body);
		expect(calls).toEqual({ length: 0, offset: 0, buffer: 0, iterator: 0 });
	});

	it.each([
		["ArrayBuffer", () => bytes().buffer],
		["DataView", () => new DataView(bytes().buffer)],
		["Uint16Array", () => new Uint16Array(8)],
		["typed array proxy", () => new Proxy(bytes(), {})],
		["shared backing", () => new Uint8Array(new SharedArrayBuffer(64))],
	] as const)("does not verify a %s as response bytes", (_name, make) => {
		unverified(make());
	});

	it("does not verify a detached response view", () => {
		const buffer = new ArrayBuffer(bytes().byteLength);
		const body = new Uint8Array(buffer);
		body.set(bytes());
		structuredClone(buffer, { transfer: [buffer] });
		unverified(body);
	});

	it.each([
		["invalid UTF8", () => new Uint8Array([0x7b, 0x22, 0xff, 0x22, 0x3a, 0x30, 0x7d])],
		[
			"duplicate id",
			() => encoder.encode('{"id":"a1","id":"a1","threadId":"cafe01","labelIds":[]}'),
		],
		["trailing JSON", () => encoder.encode(JSON.stringify(document()) + "{}")],
		[
			"excess nesting",
			() =>
				encoder.encode(
					`{"id":"a1","threadId":"cafe01","labelIds":[],"extra":${"[".repeat(65)}0${"]".repeat(65)}}`,
				),
		],
		["array root", () => bytes([document()])],
		["null root", () => bytes(null)],
		["missing thread", () => bytes({ id: first, labelIds: [] })],
		["missing labels", () => bytes({ id: first, threadId: "cafe01" })],
		["wrong label shape", () => bytes(document(first, { labelIds: "INBOX" }))],
	] as const)("keeps %s unverified rather than synthesizing provider DATA", (_name, make) => {
		unverified(make());
	});

	it("keeps parser error details and unselected text out of the result", () => {
		const result = observeGmailMutation(request(), [
			row(first, encoder.encode('{"DYTEST-PRIVATE-MEMBER":0,"DYTEST-PRIVATE-MEMBER":1}')),
		]);
		expect(result.completeObservation).toBe(false);
		expect(result.observations).toEqual([{ requestedId: first, state: "unverified" }]);
		expect(JSON.stringify(result)).not.toContain("DYTEST-PRIVATE");
	});
});

describe("partial answers and response identity", () => {
	it("retains missing rows explicitly without filling success from the request", () => {
		const result = observeGmailMutation(request([first, second]), [row(first)]);
		expect(result.completeObservation).toBe(false);
		expect(result.observations[0]?.state).toBe("observed");
		expect(result.observations[1]).toEqual({ requestedId: second, state: "missing" });
	});

	it("retains an entirely missing answer as incomplete", () => {
		const result = observeGmailMutation(request([first, second]), []);
		expect(result.completeObservation).toBe(false);
		expect(result.observations).toEqual([
			{ requestedId: first, state: "missing" },
			{ requestedId: second, state: "missing" },
		]);
	});

	it("keeps a row unverified when its body identifies another message", () => {
		const result = observeGmailMutation(request(), [row(first, bytes(document(second)))]);
		expect(result.completeObservation).toBe(false);
		expect(result.observations).toEqual([{ requestedId: first, state: "unverified" }]);
	});

	it("requires the observed archive transition instead of trusting status200", () => {
		unverified(bytes(document(first, { labelIds: ["INBOX", "STARRED"] })));
	});

	it.each([204, 400, 401, 403, 429, 503])(
		"keeps status%i refused even with a plausible body",
		(status) => {
			const result = observeGmailMutation(request(), [row(first, bytes(), status)]);
			expect(result.completeObservation).toBe(false);
			expect(result.observations).toEqual([{ requestedId: first, state: "refused" }]);
		},
	);

	it("does not complete when one of two bodies identifies the other requested message", () => {
		const result = observeGmailMutation(request([first, second]), [
			row(first),
			row(second, bytes(document(first))),
		]);
		expect(result.completeObservation).toBe(false);
		expect(result.observations.map((value) => value.state)).toEqual(["observed", "unverified"]);
	});
});

describe("inert observation input", () => {
	it("refuses duplicate outer ids even when both bodies are individually valid", () => {
		fixedRefusal([row(first), row(first)]);
	});
	it("refuses a foreign outer id instead of assigning it to a requested slot", () => {
		fixedRefusal([row(second)]);
	});
	it("does not accept an account assertion as observation authority", () => {
		fixedRefusal([{ ...row(), accountId: "DYTEST-other-account" }]);
	});
	it.each(["providerId", "status", "body"])("does not invoke a row %s accessor", (field) => {
		let calls = 0;
		const value = row();
		Object.defineProperty(value, field, {
			enumerable: true,
			get() {
				calls++;
				throw new Error("DYTEST-row-hook");
			},
		});
		fixedRefusal([value]);
		expect(calls).toBe(0);
	});
	it("does not invoke an indexed observation accessor", () => {
		let calls = 0;
		const values: unknown[] = [];
		Object.defineProperty(values, "0", {
			enumerable: true,
			get() {
				calls++;
				throw new Error("DYTEST-index-hook");
			},
		});
		fixedRefusal(values);
		expect(calls).toBe(0);
	});
	it("refuses sparse observations", () => {
		fixedRefusal(new Array(1));
	});
	it("refuses an observation array with extra symbol data", () => {
		const values = [row()];
		Object.defineProperty(values, Symbol("DYTEST-extra"), { value: 1, enumerable: true });
		fixedRefusal(values);
	});
	it("refuses a proxy row without invoking its traps", () => {
		let calls = 0;
		fixedRefusal([
			new Proxy(row(), {
				get() {
					calls++;
					throw new Error("DYTEST-proxy-hook");
				},
			}),
		]);
		expect(calls).toBe(0);
	});
});
