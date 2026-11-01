import { readFileSync } from "node:fs";
import { Readable } from "node:stream";
import { setImmediate as tick } from "node:timers/promises";
import {
	HOST_JSON_MEMBER_MAX_ENTITY_BYTES,
	HOST_JSON_MEMBER_MAX_ERROR_BYTES,
} from "@draftyak/protocol/host-channel";
import type { BlobRef } from "@draftyak/protocol/normalized-change";
import { describe, expect, it } from "vitest";
import { newId } from "../../../../src/kernel/ids.ts";
import {
	admitJsonMemberFetch,
	createJsonMemberDecoder,
	createJsonMemberErrorBody,
	JsonMemberRefusal,
	type JsonMemberRefusalCode,
	type JsonMemberRequest,
	type JsonMemberWriter,
	writeJsonMember,
} from "../../../../src/plugins/broker/blob/index.ts";

const vectors = JSON.parse(
	readFileSync(
		new URL("../../../../../../spec/vectors/host-channel/decoded-member.json", import.meta.url),
		"utf8",
	),
) as { requests: { id: string; params: Record<string, unknown>; valid: boolean }[] };

const text = (value: string): Uint8Array => new TextEncoder().encode(value);
const hex = (bytes: Uint8Array): string => Buffer.from(bytes).toString("hex");
const live = (): AbortSignal => new AbortController().signal;

/** A view of `length` alphabet bytes whose memory was then transferred away. */
function detached(length: number): Uint8Array {
	const memory = new ArrayBuffer(length + 2);
	const chunk = new Uint8Array(memory, 1, length).fill(0x41);
	memory.transfer();
	return chunk;
}

function refusal(run: () => unknown): JsonMemberRefusal | undefined {
	try {
		run();
	} catch (error) {
		if (error instanceof JsonMemberRefusal) return error;
		throw error;
	}
	return undefined;
}

async function settled(work: Promise<unknown>): Promise<JsonMemberRefusal | undefined> {
	try {
		await work;
	} catch (error) {
		if (error instanceof JsonMemberRefusal) return error;
		throw error;
	}
	return undefined;
}

interface Source extends AsyncIterable<Uint8Array> {
	readonly opened: number;
	readonly returned: number;
}

/** An entity that hands out `chunks`, logging each read; `before` may hold a read back. */
function source(
	chunks: readonly unknown[],
	options: { readonly log?: string[]; readonly before?: () => Promise<void> } = {},
): Source {
	let opened = 0;
	let returned = 0;
	return {
		get opened() {
			return opened;
		},
		get returned() {
			return returned;
		},
		[Symbol.asyncIterator]() {
			opened++;
			let index = 0;
			return {
				async next(): Promise<IteratorResult<Uint8Array>> {
					await options.before?.();
					options.log?.push("read");
					if (index >= chunks.length) return { done: true, value: undefined };
					return { done: false, value: chunks[index++] as Uint8Array };
				},
				async return(): Promise<IteratorResult<Uint8Array>> {
					returned++;
					return { done: true, value: undefined };
				},
			};
		},
	};
}

interface Overrides {
	readonly write?: JsonMemberWriter["write"];
	readonly commit?: JsonMemberWriter["commit"];
	readonly abort?: JsonMemberWriter["abort"];
}

/** A writer that logs every call into `log`; overrides decide each call's outcome. */
function recorder(
	overrides: Overrides = {},
	log: string[] = [],
	ref: string = newId(),
): { writer: JsonMemberWriter; log: string[]; signals: AbortSignal[] } {
	const signals: AbortSignal[] = [];
	const writer: JsonMemberWriter = {
		write: (bytes, signal) => {
			log.push(`write:${hex(bytes)}`);
			signals.push(signal);
			return overrides.write ? overrides.write(bytes, signal) : Promise.resolve();
		},
		commit: (signal) => {
			log.push("commit");
			signals.push(signal);
			return overrides.commit ? overrides.commit(signal) : Promise.resolve({ ref });
		},
		abort: () => {
			log.push("abort");
			return overrides.abort ? overrides.abort() : Promise.resolve();
		},
	};
	return { writer, log, signals };
}

const channelRead = (params: unknown): JsonMemberRequest => ({
	pluginKind: "channel",
	requestClass: "read",
	params,
});
const DECODED_GET = {
	method: "GET",
	url: "https://mail.example.invalid/message",
	headers: [],
	saveAs: { kind: "base64url-json-member", member: "data" },
};

describe("admitting a decoded-member fetch", () => {
	it.each(vectors.requests)("$id: admits only a valid decoded-member GET", ({ params, valid }) => {
		const { saveAs } = params;
		if (valid && typeof saveAs === "object" && saveAs !== null)
			expect(admitJsonMemberFetch(channelRead(params))).toBe((saveAs as { member: string }).member);
		else
			expect(refusal(() => admitJsonMemberFetch(channelRead(params)))).toMatchObject({
				code: "REQUEST_INVALID",
				hostError: "BAD_REQUEST",
			});
	});

	it("refuses every other method, stream mode and plain request as BAD_REQUEST", () => {
		expect(admitJsonMemberFetch(channelRead(DECODED_GET))).toBe("data");
		expect(admitJsonMemberFetch(channelRead({ ...DECODED_GET, stream: false }))).toBe("data");
		const { saveAs: _saveAs, ...plain } = DECODED_GET;
		for (const params of [
			...["HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"].map((method) => ({
				...DECODED_GET,
				method,
			})),
			{ ...DECODED_GET, stream: true },
			{ ...DECODED_GET, saveAs: "blob" },
			plain,
			{ ...DECODED_GET, extra: 1 },
			null,
			"GET",
		])
			expect(refusal(() => admitJsonMemberFetch(channelRead(params)))?.code).toBe(
				"REQUEST_INVALID",
			);
	});

	it("denies tool and provider plugins, other request classes and lookup permits", () => {
		const denied = (request: object): void => {
			expect(refusal(() => admitJsonMemberFetch(request as JsonMemberRequest))).toMatchObject({
				code: "REQUEST_DENIED",
				hostError: "DENIED",
			});
		};
		for (const pluginKind of ["tool", "ai-provider", "CHANNEL", undefined])
			denied({ pluginKind, requestClass: "read", params: DECODED_GET });
		for (const requestClass of ["organize", "send", "hub-only", "READ", undefined])
			denied({ pluginKind: "channel", requestClass, params: DECODED_GET });
		denied({ requestClass: "read", params: DECODED_GET });
		denied(
			channelRead({ ...DECODED_GET, lookupPermit: Buffer.alloc(32, 7).toString("base64url") }),
		);
		denied(
			Object.assign(Object.create({ pluginKind: "channel" }) as object, {
				requestClass: "read",
				params: DECODED_GET,
			}),
		);
	});

	it("reads only own enumerable data fields of a plain request", () => {
		const facts = { pluginKind: "channel", requestClass: "read" };
		for (const request of [
			null,
			"request",
			Object.defineProperty({ ...facts }, "params", { get: () => DECODED_GET, enumerable: true }),
			Object.defineProperty({ ...facts }, "params", { value: DECODED_GET, enumerable: false }),
			Object.defineProperty({ requestClass: "read", params: DECODED_GET }, "pluginKind", {
				get: () => "channel",
				enumerable: true,
			}),
			new Proxy(channelRead(DECODED_GET), {}),
		])
			expect(refusal(() => admitJsonMemberFetch(request as JsonMemberRequest))?.code).toBe(
				"REQUEST_INVALID",
			);
	});
});

describe("writing a decoded member", () => {
	it("stages decoded bytes as they arrive and commits only after the whole document validated", async () => {
		const ref = newId();
		const { writer, log, signals } = recorder({}, [], ref);
		const signal = live();
		const entity = text('{"raw":"Zm9vYmFy","after":[1,{"k":"v"}]}');
		const chunks = [entity.subarray(0, 12), entity.subarray(12, 20), entity.subarray(20)];
		const result = await writeJsonMember(
			createJsonMemberDecoder("raw"),
			source(chunks, { log }),
			writer,
			signal,
		);
		expect(result).toEqual({ ref });
		expect(Object.isFrozen(result)).toBe(true);
		expect(log).toEqual(["read", "write:666f6f", "read", "write:626172", "read", "read", "commit"]);
		expect(signals.every((seen) => seen === signal)).toBe(true);
	});

	it("commits an empty member and accepts a Node stream as the entity", async () => {
		const { writer, log } = recorder();
		const entity = Readable.from([Buffer.from('{"data":'), Buffer.from('""}')]);
		const result = await writeJsonMember(createJsonMemberDecoder("data"), entity, writer, live());
		expect(result.ref).toMatch(/^[0-7][0-9A-HJKMNP-TV-Z]{25}$/);
		expect(log).toEqual(["commit"]);
	});

	it("aborts staged bytes and never commits when the document fails after the member", async () => {
		for (const [tail, code] of [
			[',"raw":"Zg"}', "DUPLICATE_KEY"],
			[',"x":tru}', "JSON_INVALID"],
			[',"x":1', "JSON_INVALID"],
			["]", "JSON_INVALID"],
			[',"x":"\\ud800"}', "JSON_INVALID"],
		] as const) {
			const { writer, log } = recorder();
			const entity = source([text('{"raw":"Zm9v"'), text(tail)]);
			const error = await settled(
				writeJsonMember(createJsonMemberDecoder("raw"), entity, writer, live()),
			);
			expect(error).toMatchObject({ code, hostError: "BAD_REQUEST" });
			expect(log).toEqual(["write:666f6f", "abort"]);
			await tick();
			expect(entity.returned).toBe(1);
		}
	});

	it("refuses a decoded byte past its bound before staging it", async () => {
		const { writer, log } = recorder();
		const error = await settled(
			writeJsonMember(
				createJsonMemberDecoder("raw", { decodedBytes: 2 }),
				source([text('{"raw":"Zm9v"}')]),
				writer,
				live(),
			),
		);
		expect(error).toMatchObject({ code: "DECODED_TOO_LARGE", hostError: "TOO_LARGE" });
		expect(log).toEqual(["abort"]);
	});

	it("reports the decoder's own refusal when the transport stopped because of it", async () => {
		const decoder = createJsonMemberDecoder("raw", { compressedEntityBytes: 4 });
		const { writer, log } = recorder();
		const entity: AsyncIterable<Uint8Array> = {
			[Symbol.asyncIterator]: () => ({
				next: async () => {
					decoder.countCompressed(5);
					return { done: false, value: text("{") };
				},
			}),
		};
		const error = await settled(writeJsonMember(decoder, entity, writer, live()));
		expect(error).toMatchObject({ code: "COMPRESSED_TOO_LARGE", hostError: "TOO_LARGE" });
		expect(log).toEqual(["abort"]);
	});

	it("refuses a failing or malformed entity as ENTITY_FAILED, without its details", async () => {
		const failing = (next: () => unknown): AsyncIterable<Uint8Array> =>
			({ [Symbol.asyncIterator]: () => ({ next }) }) as unknown as AsyncIterable<Uint8Array>;
		for (const entity of [
			{
				[Symbol.asyncIterator]: () => {
					throw new Error("DYTEST open failed");
				},
			},
			failing(() => Promise.reject(new Error("DYTEST reset"))),
			failing(() => {
				throw new Error("DYTEST sync");
			}),
			failing(async () => null),
			source(['{"raw":"Zg"}']),
			source([new ArrayBuffer(1)]),
			null,
			{},
		]) {
			const { writer, log } = recorder();
			const error = await settled(
				writeJsonMember(
					createJsonMemberDecoder("raw"),
					entity as AsyncIterable<Uint8Array>,
					writer,
					live(),
				),
			);
			expect(error).toMatchObject({ code: "ENTITY_FAILED", hostError: "DENIED" });
			expect(`${String(error)} ${error?.stack ?? ""}`).not.toContain("DYTEST");
			expect(log).toEqual(["abort"]);
		}
	});

	it("refuses a detached chunk inside the member instead of committing without it", async () => {
		const { writer, log } = recorder();
		const error = await settled(
			writeJsonMember(
				createJsonMemberDecoder("raw"),
				source([text('{"raw":"Zm9v'), detached(4), text('Zm9v"}')]),
				writer,
				live(),
			),
		);
		expect(error).toMatchObject({ code: "ENTITY_FAILED", hostError: "DENIED" });
		expect(log).toEqual(["write:666f6f", "abort"]);
	});

	it("refuses a storage failure or a malformed reference as STORAGE_FAILED and aborts", async () => {
		for (const overrides of [
			{ write: () => Promise.reject(new Error("DYTEST disk full")) },
			{
				write: () => {
					throw new Error("DYTEST sync");
				},
			},
			{ commit: () => Promise.reject(new Error("DYTEST quota")) },
			{ commit: async () => ({ ref: "not-a-ulid" }) },
			{ commit: async () => ({ ref: newId(), extra: 1 }) as BlobRef },
			{ commit: async () => newId() as unknown as BlobRef },
			{ commit: async () => undefined as unknown as BlobRef },
		] satisfies Overrides[]) {
			const { writer, log } = recorder(overrides);
			const error = await settled(
				writeJsonMember(
					createJsonMemberDecoder("raw"),
					source([text('{"raw":"Zg"}')]),
					writer,
					live(),
				),
			);
			expect(error).toMatchObject({ code: "STORAGE_FAILED", hostError: "DENIED" });
			expect(`${String(error)} ${error?.stack ?? ""}`).not.toContain("DYTEST");
			expect(log.at(-1)).toBe("abort");
			expect(log.filter((entry) => entry === "abort")).toHaveLength(1);
		}
	});

	it("refuses a writer without callable methods before opening the entity", async () => {
		const { writer } = recorder();
		for (const candidate of [
			null,
			undefined,
			"writer",
			{},
			{ ...writer, abort: undefined },
			{ ...writer, commit: "commit" },
			new Proxy(writer, {}),
		]) {
			const entity = source([text('{"raw":"Zg"}')]);
			const error = await settled(
				writeJsonMember(
					createJsonMemberDecoder("raw"),
					entity,
					candidate as JsonMemberWriter,
					live(),
				),
			);
			expect(error?.code).toBe("STORAGE_FAILED");
			expect(entity.opened).toBe(0);
		}
	});

	it("calls the writer methods it captured at the start", async () => {
		const { writer, log } = recorder();
		let release = (): void => {};
		const gate = new Promise<void>((resolve) => {
			release = resolve;
		});
		const pending = writeJsonMember(
			createJsonMemberDecoder("raw"),
			source([text('{"raw":"Zg"}')], { before: () => gate }),
			writer,
			live(),
		);
		Object.assign(writer, {
			write: () => Promise.reject(new Error("replaced")),
			commit: () => Promise.reject(new Error("replaced")),
		});
		release();
		await expect(pending).resolves.toEqual({ ref: expect.any(String) });
		expect(log).toEqual(["write:66", "commit"]);
	});

	it("refuses at once when the signal already fired, before opening the entity", async () => {
		const controller = new AbortController();
		controller.abort();
		const { writer, log } = recorder();
		const entity = source([text('{"raw":"Zg"}')]);
		const error = await settled(
			writeJsonMember(createJsonMemberDecoder("raw"), entity, writer, controller.signal),
		);
		expect(error).toMatchObject({ code: "ABORTED", hostError: "DENIED" });
		expect(entity.opened).toBe(0);
		expect(log).toEqual(["abort"]);
	});

	it("stops waiting on the entity when the signal fires, and closes it", async () => {
		const controller = new AbortController();
		const { writer, log } = recorder();
		const entity = source([text('{"raw":"Zg"}')], { before: () => new Promise<void>(() => {}) });
		const pending = writeJsonMember(
			createJsonMemberDecoder("raw"),
			entity,
			writer,
			controller.signal,
		);
		await tick();
		controller.abort();
		expect((await settled(pending))?.code).toBe("ABORTED");
		expect(log).toEqual(["abort"]);
		await tick();
		expect(entity.returned).toBe(1);
	});

	it("stops waiting on storage when the signal fires", async () => {
		const controller = new AbortController();
		const { writer, log } = recorder({ write: () => new Promise<void>(() => {}) });
		const pending = writeJsonMember(
			createJsonMemberDecoder("raw"),
			source([text('{"raw":"Zg"}')]),
			writer,
			controller.signal,
		);
		await tick();
		controller.abort();
		expect((await settled(pending))?.code).toBe("ABORTED");
		expect(log).toEqual(["write:66", "abort"]);
	});

	it("discards a commit that finished after the signal fired", async () => {
		const controller = new AbortController();
		const { writer, log } = recorder({
			commit: async () => {
				controller.abort();
				return { ref: newId() };
			},
		});
		const error = await settled(
			writeJsonMember(
				createJsonMemberDecoder("raw"),
				source([text('{"raw":"Zg"}')]),
				writer,
				controller.signal,
			),
		);
		expect(error?.code).toBe("ABORTED");
		expect(log).toEqual(["write:66", "commit", "abort"]);
	});

	it("reports the refusal even when cleanup itself fails", async () => {
		const { writer, log } = recorder({ abort: () => Promise.reject(new Error("DYTEST cleanup")) });
		let sent = false;
		const entity = {
			[Symbol.asyncIterator]: () => ({
				next: async () => {
					if (sent) return { done: true, value: undefined };
					sent = true;
					return { done: false, value: text('{"raw":"Zg",') };
				},
				get return(): never {
					throw new Error("DYTEST return");
				},
			}),
		} as unknown as AsyncIterable<Uint8Array>;
		const error = await settled(
			writeJsonMember(createJsonMemberDecoder("raw"), entity, writer, live()),
		);
		expect(error?.code).toBe("JSON_INVALID");
		expect(log).toEqual(["write:66", "abort"]);
		const throwing = recorder({
			abort: () => {
				throw new Error("DYTEST sync cleanup");
			},
		});
		const second = await settled(
			writeJsonMember(
				createJsonMemberDecoder("raw"),
				source([text("[]")]),
				throwing.writer,
				live(),
			),
		);
		expect(second?.code).toBe("JSON_INVALID");
	});
});

describe("non-2xx error bodies", () => {
	const bytes = Uint8Array.from({ length: HOST_JSON_MEMBER_MAX_ERROR_BYTES }, (_, index) => index);

	it("returns up to 65,536 bytes inline and refuses one more instead of cutting it", () => {
		const body = createJsonMemberErrorBody();
		body.push(bytes.subarray(0, 1000));
		body.push(new Uint8Array(0));
		body.push(Buffer.from(bytes.subarray(1000)));
		expect(hex(body.end())).toBe(hex(bytes));
		const over = createJsonMemberErrorBody();
		over.push(bytes);
		const refused = refusal(() => over.push(new Uint8Array(1)));
		expect(refused).toMatchObject({ code: "ERROR_BODY_TOO_LARGE", hostError: "TOO_LARGE" });
		expect(refusal(() => over.end())).toBe(refused);
		const single = createJsonMemberErrorBody();
		expect(
			refusal(() => single.push(new Uint8Array(HOST_JSON_MEMBER_MAX_ERROR_BYTES + 1)))?.code,
		).toBe("ERROR_BODY_TOO_LARGE");
		expect(createJsonMemberErrorBody().end()).toEqual(new Uint8Array(0));
	});

	it("copies each chunk as it arrives", () => {
		const body = createJsonMemberErrorBody();
		const chunk = text('{"error":"DYTEST"}');
		body.push(chunk);
		chunk.fill(0x20);
		expect(Buffer.from(body.end()).toString()).toBe('{"error":"DYTEST"}');
	});

	it("copies a Buffer or a view instead of keeping memory the transport reuses", () => {
		const body = createJsonMemberErrorBody();
		const read = Buffer.from('{"error":"DYTEST buffer"}');
		const larger = text('xx,"part":"DYTEST view"}yy');
		body.push(read);
		body.push(larger.subarray(2, larger.byteLength - 2));
		read.fill(0x2a);
		larger.fill(0x2a);
		expect(Buffer.from(body.end()).toString()).toBe(
			'{"error":"DYTEST buffer"},"part":"DYTEST view"}',
		);
	});

	it("counts compressed bytes independently, up to its limit", () => {
		const body = createJsonMemberErrorBody();
		body.countCompressed(HOST_JSON_MEMBER_MAX_ENTITY_BYTES);
		body.push(bytes);
		expect(refusal(() => body.countCompressed(1))).toMatchObject({
			code: "COMPRESSED_TOO_LARGE",
			hostError: "TOO_LARGE",
		});
		const lowered = createJsonMemberErrorBody({ compressedEntityBytes: 10 });
		lowered.countCompressed(10);
		expect(refusal(() => lowered.countCompressed(1))?.code).toBe("COMPRESSED_TOO_LARGE");
		for (const count of [-1, 0.5, Number.NaN, "1"])
			expect(
				refusal(() => createJsonMemberErrorBody().countCompressed(count as number))?.code,
			).toBe("ENTITY_FAILED");
		expect(() =>
			createJsonMemberErrorBody({ compressedEntityBytes: HOST_JSON_MEMBER_MAX_ENTITY_BYTES + 1 }),
		).toThrow(RangeError);
		const routeLimits = { compressedEntityBytes: 10, decodedBytes: 5 };
		const shared = createJsonMemberErrorBody(routeLimits);
		shared.countCompressed(10);
		expect(refusal(() => shared.countCompressed(1))?.code).toBe("COMPRESSED_TOO_LARGE");
		class Getter {
			get compressedEntityBytes(): number {
				return 10;
			}
		}
		for (const limits of [
			Object.create({ compressedEntityBytes: 10 }),
			new Getter(),
			{ compressedBytes: 10 },
		] as unknown[])
			expect(() => createJsonMemberErrorBody(limits as { compressedEntityBytes?: number })).toThrow(
				RangeError,
			);
	});

	it("lowers its bound to a stricter entity limit in the limits it shares with the decoder", () => {
		const routeLimits = {
			compressedEntityBytes: 1000,
			decompressedEntityBytes: 10,
			decodedBytes: 5,
		};
		const entity = text('{"raw":"Zg"}');
		expect(refusal(() => createJsonMemberDecoder("raw", routeLimits).push(entity))?.code).toBe(
			"ENTITY_TOO_LARGE",
		);
		const exact = createJsonMemberErrorBody(routeLimits);
		exact.push(entity.subarray(0, 4));
		exact.push(entity.subarray(4, 10));
		expect(hex(exact.end())).toBe(hex(entity.subarray(0, 10)));
		const whole = createJsonMemberErrorBody(routeLimits);
		expect(refusal(() => whole.push(entity))).toMatchObject({
			code: "ERROR_BODY_TOO_LARGE",
			hostError: "TOO_LARGE",
		});
		const split = createJsonMemberErrorBody(routeLimits);
		split.push(entity.subarray(0, 10));
		expect(refusal(() => split.push(entity.subarray(10, 11)))?.code).toBe("ERROR_BODY_TOO_LARGE");
		const none = createJsonMemberErrorBody({ decompressedEntityBytes: 0 });
		none.push(new Uint8Array(0));
		expect(refusal(() => none.push(new Uint8Array(1)))?.code).toBe("ERROR_BODY_TOO_LARGE");
		// A looser entity limit keeps the inline maximum.
		const looser = createJsonMemberErrorBody({
			decompressedEntityBytes: HOST_JSON_MEMBER_MAX_ERROR_BYTES + 1,
		});
		looser.push(bytes);
		expect(refusal(() => looser.push(new Uint8Array(1)))?.code).toBe("ERROR_BODY_TOO_LARGE");
		expect(() =>
			createJsonMemberErrorBody({ decompressedEntityBytes: HOST_JSON_MEMBER_MAX_ENTITY_BYTES + 1 }),
		).toThrow(RangeError);
	});

	it("refuses a chunk that is not a byte array or is detached, and any use after the end", () => {
		for (const chunk of [
			"error",
			[1],
			new ArrayBuffer(1),
			new Proxy(new Uint8Array(1), {}),
			detached(4),
			null,
		])
			expect(refusal(() => createJsonMemberErrorBody().push(chunk as Uint8Array))?.code).toBe(
				"ENTITY_FAILED",
			);
		const partial = createJsonMemberErrorBody();
		partial.push(text("x"));
		const refused = refusal(() => partial.push(detached(4)));
		expect(refused).toMatchObject({ code: "ENTITY_FAILED", hostError: "DENIED" });
		expect(refusal(() => partial.end())).toBe(refused);
		const body = createJsonMemberErrorBody();
		body.push(text("x"));
		body.end();
		expect(refusal(() => body.push(text("y")))?.code).toBe("ENTITY_FAILED");
		expect(refusal(() => body.end())?.code).toBe("ENTITY_FAILED");
	});
});

describe("refusal codes", () => {
	it("returns no reference and the same fixed refusal for every malformed document", async () => {
		const codes = new Set<JsonMemberRefusalCode>();
		for (const json of ['{"raw":1}', "{}", '{"raw":"Z"}', '{"raw":"Zg","raw":"Zg"}', "[]"]) {
			const { writer, log } = recorder();
			const error = await settled(
				writeJsonMember(createJsonMemberDecoder("raw"), source([text(json)]), writer, live()),
			);
			expect(error?.hostError).toBe("BAD_REQUEST");
			expect(log).not.toContain("commit");
			codes.add(error?.code as JsonMemberRefusalCode);
		}
		expect([...codes].sort()).toEqual([
			"DUPLICATE_KEY",
			"ENCODING_INVALID",
			"JSON_INVALID",
			"MEMBER_MISSING",
			"MEMBER_NOT_STRING",
		]);
	});
});
