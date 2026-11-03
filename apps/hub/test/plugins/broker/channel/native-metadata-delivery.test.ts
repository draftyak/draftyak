import { HOST_MAX_STREAM_BYTES, type HostStreamChunk } from "@draftyak/protocol/host-channel";
import { MAX_INLINE_BYTES } from "@draftyak/protocol/normalized-change";
import { afterEach, describe, expect, it, vi } from "vitest";

const externalIo = vi.hoisted(() => {
	const refuse = vi.fn((): never => {
		throw new Error("External IO is unavailable in this test");
	});
	const block = (source: object, names: readonly string[]) => {
		const overrides = Object.fromEntries(names.map((name) => [name, refuse]));
		return { ...source, ...overrides, default: { ...source, ...overrides } };
	};
	vi.stubGlobal("fetch", refuse);
	return { refuse, block };
});

vi.mock("node:child_process", async (original) =>
	externalIo.block(await original<typeof import("node:child_process")>(), [
		"spawn",
		"spawnSync",
		"exec",
		"execFile",
		"execSync",
		"execFileSync",
		"fork",
	]),
);
vi.mock("node:http", async (original) =>
	externalIo.block(await original<typeof import("node:http")>(), [
		"request",
		"get",
		"createServer",
	]),
);
vi.mock("node:https", async (original) =>
	externalIo.block(await original<typeof import("node:https")>(), [
		"request",
		"get",
		"createServer",
	]),
);
vi.mock("node:net", async (original) =>
	externalIo.block(await original<typeof import("node:net")>(), [
		"connect",
		"createConnection",
		"createServer",
	]),
);
vi.mock("node:tls", async (original) =>
	externalIo.block(await original<typeof import("node:tls")>(), ["connect", "createServer"]),
);
vi.mock("node:dns", async (original) =>
	externalIo.block(await original<typeof import("node:dns")>(), [
		"lookup",
		"resolve",
		"resolve4",
		"resolve6",
		"reverse",
	]),
);
vi.mock("node:dns/promises", async (original) =>
	externalIo.block(await original<typeof import("node:dns/promises")>(), [
		"lookup",
		"resolve",
		"resolve4",
		"resolve6",
		"reverse",
	]),
);

import { NativeChannelHostError } from "../../../../src/plugins/broker/channel/native-connection.ts";
import {
	createNativeMetadataDelivery,
	type NativeMetadataDeliveryWriter,
} from "../../../../src/plugins/broker/channel/native-metadata-delivery.ts";

afterEach(() => {
	expect(externalIo.refuse).not.toHaveBeenCalled();
	externalIo.refuse.mockClear();
});

function fixture(length: number) {
	const response = { status: 200, headers: [], body: Buffer.alloc(length, 0x61) };
	const reply = Promise.withResolvers<void>();
	const write = vi.fn<(chunk: HostStreamChunk) => Promise<void>>().mockResolvedValue(undefined);
	const writer: NativeMetadataDeliveryWriter = { replyWritten: reply.promise, writeChunk: write };
	const cancel = new AbortController();
	return { response, reply, write, writer, cancel };
}

function observe(promise: Promise<void>) {
	const state = { value: "pending" as "pending" | "resolved" | "rejected" };
	void promise.then(
		() => {
			state.value = "resolved";
		},
		() => {
			state.value = "rejected";
		},
	);
	return state;
}
async function turns() {
	for (let i = 0; i < 5; i++) await Promise.resolve();
}
async function pending(state: ReturnType<typeof observe>) {
	await turns();
	expect(state.value).toBe("pending");
}
async function refuses(promise: Promise<void>) {
	await expect(promise).rejects.toBeInstanceOf(NativeChannelHostError);
	await expect(promise).rejects.toMatchObject({
		code: "NATIVE_CHANNEL_HOST_REFUSED",
		message: "Native channel request unavailable",
	});
}
function erased(body: Buffer) {
	expect(body.some((byte) => byte !== 0)).toBe(false);
}

describe("native metadata delivery resource sequencing", () => {
	it.each([0, MAX_INLINE_BYTES])(
		"joins an inline reply of %i bytes exactly once",
		async (length) => {
			const f = fixture(length);
			const expected = f.response.body.toString("base64url");
			const delivery = createNativeMetadataDelivery(f.response, f.writer, false, f.cancel.signal);
			expect(delivery.result).toMatchObject({
				status: 200,
				headers: [],
				body: { base64: expected },
			});
			erased(f.response.body);
			const completion = delivery.complete();
			await pending(observe(completion));
			expect(f.write).not.toHaveBeenCalled();
			// Acknowledging the final reply may normally end its own resource signal.
			f.cancel.abort();
			f.reply.resolve();
			await expect(completion).resolves.toBeUndefined();
			await refuses(delivery.complete());
			expect(f.write).not.toHaveBeenCalled();
		},
	);

	it("refuses a non-streamed body above the inline limit and erases it", () => {
		const f = fixture(MAX_INLINE_BYTES + 1);
		expect(() =>
			createNativeMetadataDelivery(f.response, f.writer, false, f.cancel.signal),
		).toThrow(NativeChannelHostError);
		erased(f.response.body);
		expect(f.write).not.toHaveBeenCalled();
	});

	it("refuses a body above the total stream limit and erases it", () => {
		const f = fixture(HOST_MAX_STREAM_BYTES + 1);
		expect(() => createNativeMetadataDelivery(f.response, f.writer, true, f.cancel.signal)).toThrow(
			NativeChannelHostError,
		);
		erased(f.response.body);
		expect(f.write).not.toHaveBeenCalled();
	});

	it("admits the exact stream limit while joining a failed reply without writing chunks", async () => {
		const f = fixture(HOST_MAX_STREAM_BYTES);
		const delivery = createNativeMetadataDelivery(f.response, f.writer, true, f.cancel.signal);
		expect(delivery.result).toMatchObject({ streamId: expect.any(String) });
		const completion = delivery.complete();
		f.reply.reject(new Error("DYTEST-reply-refused"));
		await refuses(completion);
		expect(f.write).not.toHaveBeenCalled();
		erased(f.response.body);
	});

	it("writes no chunk before reply ACK and joins each chunk ACK in sequence", async () => {
		const f = fixture(MAX_INLINE_BYTES * 2 + 1);
		const expected = Buffer.from(f.response.body);
		const first = Promise.withResolvers<void>();
		const second = Promise.withResolvers<void>();
		f.write.mockImplementation((chunk) => {
			if (chunk.sequence === 0) return first.promise;
			if (chunk.sequence === 1) return second.promise;
			return Promise.resolve();
		});
		const delivery = createNativeMetadataDelivery(f.response, f.writer, true, f.cancel.signal);
		const completion = delivery.complete();
		const state = observe(completion);
		await pending(state);
		expect(f.write).not.toHaveBeenCalled();
		f.reply.resolve();
		await pending(state);
		expect(f.write).toHaveBeenCalledTimes(1);
		expect(f.write.mock.calls[0]?.[0]).toMatchObject({ sequence: 0, done: false });
		expect(f.response.body[0]).toBe(0x61);
		first.resolve();
		await pending(state);
		expect(f.write).toHaveBeenCalledTimes(2);
		second.resolve();
		await expect(completion).resolves.toBeUndefined();
		const chunks = f.write.mock.calls.map(([chunk]) => chunk);
		expect(chunks.map((chunk) => chunk.sequence)).toEqual([0, 1, 2]);
		expect(chunks.map((chunk) => chunk.done)).toEqual([false, false, true]);
		expect(chunks.map((chunk) => Buffer.from(chunk.base64, "base64url").length)).toEqual([
			MAX_INLINE_BYTES,
			MAX_INLINE_BYTES,
			1,
		]);
		expect(chunks.every((chunk) => chunk.error === undefined)).toBe(true);
		expect(Buffer.concat(chunks.map((chunk) => Buffer.from(chunk.base64, "base64url")))).toEqual(
			expected,
		);
		erased(f.response.body);
	});

	it.each([false, true])(
		"propagates reply ACK rejection after result publication: streamed=%s",
		async (streamed) => {
			const f = fixture(streamed ? MAX_INLINE_BYTES + 1 : 8);
			const delivery = createNativeMetadataDelivery(
				f.response,
				f.writer,
				streamed,
				f.cancel.signal,
			);
			expect(delivery.result.status).toBe(200);
			const completion = delivery.complete();
			f.reply.reject(new Error("DYTEST-late-reply-rejection"));
			await refuses(completion);
			expect(f.write).not.toHaveBeenCalled();
			erased(f.response.body);
		},
	);

	it("propagates a non-final chunk ACK rejection despite an acknowledged terminal control", async () => {
		const f = fixture(MAX_INLINE_BYTES + 1);
		f.write.mockRejectedValueOnce(new Error("DYTEST-chunk-rejection"));
		const delivery = createNativeMetadataDelivery(f.response, f.writer, true, f.cancel.signal);
		f.reply.resolve();
		await refuses(delivery.complete());
		expect(f.write).toHaveBeenCalledTimes(2);
		expect(f.write.mock.calls[0]?.[0]).toMatchObject({ sequence: 0, done: false });
		expect(f.write.mock.calls[1]?.[0]).toMatchObject({
			sequence: 1,
			base64: "",
			done: true,
			error: "DENIED",
		});
		erased(f.response.body);
	});

	it("propagates final chunk ACK rejection after the streamed result was published", async () => {
		const f = fixture(MAX_INLINE_BYTES + 1);
		f.write.mockResolvedValueOnce(undefined).mockRejectedValueOnce(new Error("DYTEST-final-ACK"));
		const delivery = createNativeMetadataDelivery(f.response, f.writer, true, f.cancel.signal);
		expect(delivery.result).toMatchObject({ streamId: expect.any(String) });
		f.reply.resolve();
		await refuses(delivery.complete());
		expect(f.write).toHaveBeenCalledTimes(3);
		expect(f.write.mock.calls[1]?.[0]).toMatchObject({ sequence: 1, done: true });
		expect(f.write.mock.calls[2]?.[0]).toMatchObject({
			sequence: 2,
			base64: "",
			done: true,
			error: "DENIED",
		});
		erased(f.response.body);
	});

	it("accepts a successful final chunk that ends its own signal", async () => {
		const f = fixture(MAX_INLINE_BYTES + 1);
		f.write.mockImplementation(async (chunk) => {
			if (chunk.done) f.cancel.abort();
		});
		const delivery = createNativeMetadataDelivery(f.response, f.writer, true, f.cancel.signal);
		f.reply.resolve();
		await expect(delivery.complete()).resolves.toBeUndefined();
		expect(f.write).toHaveBeenCalledTimes(2);
		expect(f.write.mock.calls.every(([chunk]) => chunk.error === undefined)).toBe(true);
		erased(f.response.body);
	});

	it("refuses repeated complete without erasing the first pending stream early", async () => {
		const f = fixture(MAX_INLINE_BYTES + 1);
		const delivery = createNativeMetadataDelivery(f.response, f.writer, true, f.cancel.signal);
		const completion = delivery.complete();
		await refuses(delivery.complete());
		await pending(observe(completion));
		expect(f.response.body[0]).toBe(0x61);
		expect(f.write).not.toHaveBeenCalled();
		f.reply.resolve();
		await expect(completion).resolves.toBeUndefined();
		expect(f.write).toHaveBeenCalledTimes(2);
		erased(f.response.body);
	});

	it("joins a withheld chunk after abort before refusing further data", async () => {
		const f = fixture(MAX_INLINE_BYTES * 2 + 1);
		const acknowledged = Promise.withResolvers<void>();
		f.write.mockImplementation((chunk) => (chunk.error ? Promise.resolve() : acknowledged.promise));
		const delivery = createNativeMetadataDelivery(f.response, f.writer, true, f.cancel.signal);
		f.reply.resolve();
		const completion = delivery.complete();
		const state = observe(completion);
		await pending(state);
		expect(f.write).toHaveBeenCalledTimes(1);
		f.cancel.abort();
		await pending(state);
		expect(f.write).toHaveBeenCalledTimes(1);
		acknowledged.resolve();
		await refuses(completion);
		expect(f.write).toHaveBeenCalledTimes(2);
		expect(f.write.mock.calls[1]?.[0]).toMatchObject({ base64: "", done: true, error: "DENIED" });
		erased(f.response.body);
	});

	it("refuses an already aborted delivery before any writer operation", () => {
		const f = fixture(8);
		f.cancel.abort();
		expect(() => createNativeMetadataDelivery(f.response, f.writer, true, f.cancel.signal)).toThrow(
			NativeChannelHostError,
		);
		expect(f.write).not.toHaveBeenCalled();
		erased(f.response.body);
	});
});
