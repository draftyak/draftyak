import {
	HOST_MAX_STREAM_BYTES,
	HOST_REQUEST_TIMEOUT_MS,
	type HostFetchResult,
	type HostNotification,
} from "@draftyak/protocol/host-channel";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	openBoundedProviderStream,
	type ProviderStreamArguments,
	ProviderStreamBoundaryError,
} from "../../src/ai/providers/streaming.ts";
import type {
	ProviderHttpBroker,
	ProviderHttpStream,
	ProviderStreamSink,
} from "../../src/plugins/broker/provider-http.ts";

const STREAM = "00000000000000000000000003";
const OTHER_STREAM = "00000000000000000000000004";
const transports: { finish(): void }[] = [];
const opened: ProviderHttpStream[] = [];

function args(signal = new AbortController().signal): ProviderStreamArguments {
	return [
		"responses-api-v1",
		{ method: "POST", url: "https://api.openai.com/v1/responses" },
		{ endpoint: "https://api.openai.com/v1/responses" },
		"00000000000000000000000001",
		{ ownerKind: "provider", ownerId: "00000000000000000000000002", kind: "provider-key" },
		signal,
	];
}

function chunk(
	sequence: number,
	data: readonly number[],
	done = false,
	streamId = STREAM,
): HostNotification {
	return {
		jsonrpc: "2.0",
		method: "host/stream.chunk",
		params: { streamId, sequence, base64: Buffer.from(data).toString("base64url"), done },
	};
}

function denied(sequence: number): HostNotification {
	return {
		jsonrpc: "2.0",
		method: "host/stream.chunk",
		params: { streamId: STREAM, sequence, base64: "", done: true, error: "DENIED" },
	};
}

// This is a controlled unit transport using the real broker contract, not a native broker or grant.
function transport(settleOnCancel = true) {
	const response = Promise.withResolvers<HostFetchResult>();
	const completion = Promise.withResolvers<void>();
	void response.promise.catch(() => {});
	void completion.promise.catch(() => {});
	let captured: Parameters<ProviderHttpBroker["stream"]> | undefined;
	const start = vi.fn();
	const cancel = vi.fn(() => {
		if (settleOnCancel) {
			response.reject(new Error("Controlled transport cancelled"));
			completion.reject(new Error("Controlled transport cancelled"));
		}
	});
	const stream = vi.fn<ProviderHttpBroker["stream"]>((...values) => {
		captured = values;
		return { response: response.promise, completion: completion.promise, start, cancel };
	});
	const broker: ProviderHttpBroker = {
		execute: async () => {
			throw new Error("Unit fixture only supplies stream");
		},
		stream,
		close: vi.fn(),
	};
	const value = {
		broker,
		stream,
		start,
		cancel,
		captured: () => captured,
		reply(result: HostFetchResult = { status: 200, headers: [], streamId: STREAM }) {
			response.resolve(result);
		},
		finish() {
			completion.resolve();
		},
		fail() {
			completion.reject(new Error("Controlled transport failed"));
		},
		emit(notification: HostNotification, transportSignal?: AbortSignal): Promise<void> {
			if (!captured) throw new Error("Unit transport has not been opened");
			return captured[6](notification, transportSignal ?? captured[5]);
		},
	};
	transports.push(value);
	return value;
}

function open(
	f: ReturnType<typeof transport>,
	sink: ProviderStreamSink = async () => {},
	options?: Parameters<typeof openBoundedProviderStream>[3],
	invocation = args(),
): ProviderHttpStream {
	const result = openBoundedProviderStream(f.broker, invocation, sink, options);
	void result.response.catch(() => {});
	void result.completion.catch(() => {});
	opened.push(result);
	return result;
}

async function ready(f: ReturnType<typeof transport>, result: ProviderHttpStream): Promise<void> {
	f.reply();
	await result.response;
	result.start();
}

afterEach(async () => {
	for (const result of opened) result.cancel();
	for (const f of transports) f.finish();
	await Promise.allSettled(opened.splice(0).map((result) => result.completion));
	transports.length = 0;
	vi.useRealTimers();
});

describe("bounded provider stream component", () => {
	it("forwards all six supplied broker arguments and starts only after explicit header delivery", async () => {
		const f = transport(),
			invocation = args();
		const result = open(f, undefined, undefined, invocation);
		expect(f.stream).toHaveBeenCalledTimes(1);
		for (let index = 0; index < invocation.length; index++)
			expect(f.captured()?.[index]).toBe(invocation[index]);
		expect(f.start).not.toHaveBeenCalled();
		f.reply();
		expect(await result.response).toEqual({ status: 200, headers: [], streamId: STREAM });
		expect(f.start).not.toHaveBeenCalled();
		result.start();
		result.start();
		expect(f.start).toHaveBeenCalledTimes(1);
		await f.emit(chunk(0, [], true));
		f.finish();
		await expect(result.completion).resolves.toBeUndefined();
	});

	it("accepts exact byte and event limits and reports counts only after sink acknowledgments", async () => {
		const f = transport(),
			progress = vi.fn(),
			sink = vi.fn<ProviderStreamSink>(async () => {});
		const result = open(f, sink, { maxBytes: 4, maxEvents: 2, onProgress: progress });
		await ready(f, result);
		const first = chunk(0, [1, 2, 3]),
			terminal = chunk(1, [4], true);
		await f.emit(first);
		await f.emit(terminal);
		f.finish();
		await result.completion;
		expect(sink.mock.calls.map(([notification]) => notification)).toEqual([first, terminal]);
		expect(progress.mock.calls.map(([counts]) => counts)).toEqual([
			{ bytes: 3, events: 1 },
			{ bytes: 4, events: 2 },
		]);
		for (const [counts] of progress.mock.calls)
			expect(Object.keys(counts).sort()).toEqual(["bytes", "events"]);
	});

	it("refuses a chunk that exceeds the remaining byte budget before forwarding it", async () => {
		const f = transport(),
			sink = vi.fn<ProviderStreamSink>(async () => {}),
			progress = vi.fn();
		const result = open(f, sink, { maxBytes: 4, onProgress: progress });
		await ready(f, result);
		const first = chunk(0, [1, 2, 3]);
		await f.emit(first);
		await expect(f.emit(chunk(1, [4, 5], true))).rejects.toBeInstanceOf(
			ProviderStreamBoundaryError,
		);
		await expect(result.completion).rejects.toBeInstanceOf(ProviderStreamBoundaryError);
		expect(sink.mock.calls.map(([notification]) => notification)).toEqual([first, denied(1)]);
		expect(progress.mock.calls.map(([counts]) => counts)).toEqual([{ bytes: 3, events: 1 }]);
		expect(f.cancel).toHaveBeenCalledTimes(1);
	});

	it("reserves the last event slot for one empty refusal terminal", async () => {
		const f = transport(),
			sink = vi.fn<ProviderStreamSink>(async () => {});
		const result = open(f, sink, { maxBytes: 0, maxEvents: 1 });
		await ready(f, result);
		await expect(f.emit(chunk(0, []))).rejects.toBeInstanceOf(ProviderStreamBoundaryError);
		await expect(result.completion).rejects.toBeInstanceOf(ProviderStreamBoundaryError);
		expect(sink.mock.calls.map(([notification]) => notification)).toEqual([denied(0)]);
	});

	it("accepts one empty successful terminal at the exact zero-byte and one-event limits", async () => {
		const f = transport(),
			sink = vi.fn<ProviderStreamSink>(async () => {}),
			onProgress = vi.fn();
		const result = open(f, sink, { maxBytes: 0, maxEvents: 1, onProgress });
		await ready(f, result);
		const terminal = chunk(0, [], true);
		await f.emit(terminal);
		f.finish();
		await result.completion;
		expect(sink.mock.calls.map(([notification]) => notification)).toEqual([terminal]);
		expect(onProgress).toHaveBeenCalledExactlyOnceWith({ bytes: 0, events: 1 });
	});

	it.each([
		["first sequence", [], 1],
		["duplicate sequence", [0], 0],
		["skipped sequence", [0], 2],
	] as const)(
		"refuses a %s before forwarding the offending notification",
		async (_name, prefix, invalid) => {
			const f = transport(),
				sink = vi.fn<ProviderStreamSink>(async () => {});
			const result = open(f, sink);
			await ready(f, result);
			for (const sequence of prefix) await f.emit(chunk(sequence, [1]));
			await expect(f.emit(chunk(invalid, [2], true))).rejects.toBeInstanceOf(
				ProviderStreamBoundaryError,
			);
			await expect(result.completion).rejects.toBeInstanceOf(ProviderStreamBoundaryError);
			expect(sink.mock.calls.map(([notification]) => notification)).toEqual([
				...prefix.map((sequence) => chunk(sequence, [1])),
				denied(prefix.length),
			]);
		},
	);

	it("binds every notification to the response stream id", async () => {
		const f = transport(),
			sink = vi.fn<ProviderStreamSink>(async () => {});
		const result = open(f, sink);
		await ready(f, result);
		await expect(f.emit(chunk(0, [1], true, OTHER_STREAM))).rejects.toBeInstanceOf(
			ProviderStreamBoundaryError,
		);
		await expect(result.completion).rejects.toBeInstanceOf(ProviderStreamBoundaryError);
		expect(sink.mock.calls.map(([notification]) => notification)).toEqual([denied(0)]);
	});

	it("refuses an inline response instead of accepting it as a stream header", async () => {
		const f = transport(),
			result = open(f);
		f.reply({ status: 200, headers: [], body: { base64: "" } });
		await expect(result.response).rejects.toBeInstanceOf(ProviderStreamBoundaryError);
		await expect(result.completion).rejects.toBeInstanceOf(ProviderStreamBoundaryError);
		expect(f.start).not.toHaveBeenCalled();
	});

	it.each(["YQ==", "AB"])(
		"refuses noncanonical base64 %s without forwarding its bytes or recording progress",
		async (base64) => {
			const f = transport(),
				sink = vi.fn<ProviderStreamSink>(async () => {}),
				onProgress = vi.fn();
			const result = open(f, sink, { onProgress });
			await ready(f, result);
			const notification: HostNotification = {
				jsonrpc: "2.0",
				method: "host/stream.chunk",
				params: { streamId: STREAM, sequence: 0, base64, done: true },
			};
			await expect(f.emit(notification)).rejects.toBeInstanceOf(ProviderStreamBoundaryError);
			await expect(result.completion).rejects.toBeInstanceOf(ProviderStreamBoundaryError);
			expect(sink.mock.calls.map(([notification]) => notification)).toEqual([denied(0)]);
			expect(onProgress).not.toHaveBeenCalled();
		},
	);

	it.each([
		["negative byte budget", { maxBytes: -1 }],
		["oversized byte budget", { maxBytes: HOST_MAX_STREAM_BYTES + 1 }],
		["zero event budget", { maxEvents: 0 }],
		["oversized event budget", { maxEvents: 8_193 }],
		["zero deadline", { timeoutMs: 0 }],
		["oversized deadline", { timeoutMs: HOST_REQUEST_TIMEOUT_MS + 1 }],
		["infinite deadline", { timeoutMs: Number.POSITIVE_INFINITY }],
		["not-a-number deadline", { timeoutMs: Number.NaN }],
		["non-numeric deadline", { timeoutMs: "20" }],
	] as const)("refuses a %s synchronously before dispatch", (_name, raw) => {
		const f = transport();
		// JavaScript callers can cross the TypeScript options contract.
		const options = raw as unknown as NonNullable<Parameters<typeof openBoundedProviderStream>[3]>;
		expect(() => open(f, undefined, options)).toThrow(ProviderStreamBoundaryError);
		expect(f.stream).not.toHaveBeenCalled();
	});

	it("does not dispatch when the genuine caller signal is already aborted", async () => {
		const f = transport(),
			controller = new AbortController();
		controller.abort();
		const result = open(f, undefined, undefined, args(controller.signal));
		await expect(result.response).rejects.toBeInstanceOf(ProviderStreamBoundaryError);
		await expect(result.completion).rejects.toBeInstanceOf(ProviderStreamBoundaryError);
		expect(f.stream).not.toHaveBeenCalled();
	});

	it("cancels pending headers and never revives on a late header", async () => {
		const f = transport(false),
			result = open(f);
		result.cancel();
		await expect(result.response).rejects.toBeInstanceOf(ProviderStreamBoundaryError);
		f.reply();
		await Promise.resolve();
		result.start();
		expect(f.start).not.toHaveBeenCalled();
		expect(f.cancel).toHaveBeenCalledTimes(1);
		f.fail();
		await expect(result.completion).rejects.toBeInstanceOf(ProviderStreamBoundaryError);
	});

	it("waits for the real sink acknowledgment before recording progress", async () => {
		const f = transport(),
			ack = Promise.withResolvers<void>(),
			onProgress = vi.fn();
		const entered = Promise.withResolvers<void>();
		const result = open(
			f,
			async () => {
				entered.resolve();
				await ack.promise;
			},
			{ onProgress },
		);
		await ready(f, result);
		const pending = f.emit(chunk(0, [1], true));
		try {
			await entered.promise;
			expect(onProgress).not.toHaveBeenCalled();
			ack.resolve();
			await pending;
			f.finish();
			await result.completion;
			expect(onProgress).toHaveBeenCalledExactlyOnceWith({ bytes: 1, events: 1 });
		} finally {
			ack.resolve();
		}
	});

	it("does not record a late acknowledgment after caller cancellation", async () => {
		const f = transport(),
			ack = Promise.withResolvers<void>(),
			entered = Promise.withResolvers<void>();
		const controller = new AbortController(),
			onProgress = vi.fn();
		const result = open(
			f,
			async () => {
				entered.resolve();
				await ack.promise;
			},
			{ onProgress },
			args(controller.signal),
		);
		await ready(f, result);
		const pending = f.emit(chunk(0, [1], true));
		void pending.catch(() => {});
		try {
			await entered.promise;
			controller.abort();
			ack.resolve();
			await expect(pending).rejects.toBeInstanceOf(ProviderStreamBoundaryError);
			await expect(result.completion).rejects.toBeInstanceOf(ProviderStreamBoundaryError);
			expect(onProgress).not.toHaveBeenCalled();
			expect(f.cancel).toHaveBeenCalledTimes(1);
		} finally {
			ack.resolve();
		}
	});

	it("refuses a concurrent notification without forwarding another frame while the sink is busy", async () => {
		const f = transport(),
			ack = Promise.withResolvers<void>(),
			entered = Promise.withResolvers<void>();
		const onProgress = vi.fn(),
			sink = vi.fn<ProviderStreamSink>(async () => {
				entered.resolve();
				await ack.promise;
			});
		const result = open(f, sink, { onProgress });
		await ready(f, result);
		const pending = f.emit(chunk(0, [1]));
		void pending.catch(() => {});
		try {
			await entered.promise;
			await expect(f.emit(chunk(1, [2], true))).rejects.toBeInstanceOf(ProviderStreamBoundaryError);
			expect(sink).toHaveBeenCalledTimes(1);
			ack.resolve();
			await expect(pending).rejects.toBeInstanceOf(ProviderStreamBoundaryError);
			await expect(result.completion).rejects.toBeInstanceOf(ProviderStreamBoundaryError);
			expect(onProgress).not.toHaveBeenCalled();
		} finally {
			ack.resolve();
		}
	});

	it("expires a stalled stream at its deadline without waiting for a new chunk", async () => {
		vi.useFakeTimers();
		const f = transport(),
			result = open(f, undefined, { timeoutMs: 20 });
		await ready(f, result);
		await vi.advanceTimersByTimeAsync(20);
		expect(f.cancel).toHaveBeenCalledTimes(1);
		await expect(result.completion).rejects.toBeInstanceOf(ProviderStreamBoundaryError);
	});

	it("does not settle completion before the original transport settles after refusal", async () => {
		const f = transport(false),
			result = open(f);
		await ready(f, result);
		let settled = false;
		void result.completion.then(
			() => {
				settled = true;
			},
			() => {
				settled = true;
			},
		);
		await expect(f.emit(chunk(1, [1], true))).rejects.toBeInstanceOf(ProviderStreamBoundaryError);
		await Promise.resolve();
		expect(settled).toBe(false);
		f.fail();
		await expect(result.completion).rejects.toBeInstanceOf(ProviderStreamBoundaryError);
		expect(settled).toBe(true);
	});

	it("requires a terminal notification before successful transport completion", async () => {
		const f = transport(),
			result = open(f);
		await ready(f, result);
		await f.emit(chunk(0, [1]));
		f.finish();
		await expect(result.completion).rejects.toBeInstanceOf(ProviderStreamBoundaryError);
	});

	it("rejects a notification after the terminal frame before forwarding it", async () => {
		const f = transport(),
			sink = vi.fn<ProviderStreamSink>(async () => {}),
			result = open(f, sink);
		await ready(f, result);
		await f.emit(chunk(0, [1], true));
		await expect(f.emit(chunk(1, []))).rejects.toBeInstanceOf(ProviderStreamBoundaryError);
		await expect(result.completion).rejects.toBeInstanceOf(ProviderStreamBoundaryError);
		expect(sink).toHaveBeenCalledTimes(1);
	});

	it("turns sink rejection into a fixed refusal and cancels the owned transport", async () => {
		const f = transport(),
			result = open(f, async () => {
				throw new Error("DYTEST private sink error");
			});
		await ready(f, result);
		await expect(f.emit(chunk(0, [1], true))).rejects.toBeInstanceOf(ProviderStreamBoundaryError);
		await expect(result.completion).rejects.toMatchObject({ code: "PROVIDER_STREAM_REFUSED" });
		expect(f.cancel).toHaveBeenCalledTimes(1);
	});

	it("delivers an empty denial terminal when only the separate transport signal is aborted", async () => {
		const f = transport(),
			sink = vi.fn<ProviderStreamSink>(async () => {}),
			onProgress = vi.fn();
		const result = open(f, sink, { onProgress });
		await ready(f, result);
		const transportSignal = new AbortController();
		transportSignal.abort();
		const terminal = denied(0);
		await expect(f.emit(terminal, transportSignal.signal)).rejects.toBeInstanceOf(
			ProviderStreamBoundaryError,
		);
		await expect(result.completion).rejects.toBeInstanceOf(ProviderStreamBoundaryError);
		expect(sink.mock.calls.map(([notification]) => notification)).toEqual([terminal]);
		expect(onProgress).not.toHaveBeenCalled();
		expect(f.captured()?.[5].aborted).toBe(false);
		expect(f.cancel).toHaveBeenCalledTimes(1);
	});

	it("does not send a concurrent terminal when the separate transport signal aborts a pending sink acknowledgment", async () => {
		const f = transport(),
			ack = Promise.withResolvers<void>(),
			entered = Promise.withResolvers<void>();
		const original = new AbortController(),
			transportSignal = new AbortController(),
			onProgress = vi.fn();
		const sink = vi.fn<ProviderStreamSink>(async () => {
			entered.resolve();
			await ack.promise;
		});
		const result = open(f, sink, { onProgress }, args(original.signal));
		await ready(f, result);
		const first = chunk(0, [1]);
		const pending = f.emit(first, transportSignal.signal);
		void pending.catch(() => {});
		try {
			await entered.promise;
			transportSignal.abort();
			await expect(pending).rejects.toBeInstanceOf(ProviderStreamBoundaryError);
			await expect(result.completion).rejects.toBeInstanceOf(ProviderStreamBoundaryError);
			expect(original.signal.aborted).toBe(false);
			expect(sink.mock.calls.map(([notification]) => notification)).toEqual([first]);
			expect(onProgress).not.toHaveBeenCalled();
			expect(f.cancel).toHaveBeenCalledTimes(1);
			ack.resolve();
			await Promise.resolve();
			expect(sink).toHaveBeenCalledTimes(1);
			expect(onProgress).not.toHaveBeenCalled();
		} finally {
			ack.resolve();
		}
	});
});
