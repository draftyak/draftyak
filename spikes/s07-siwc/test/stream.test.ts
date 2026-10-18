import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { SiwcError } from "../src/errors.ts";
import { type DraftOutcome, runDraft, type Structure } from "../src/responses.ts";
import { fromFrames, type HostFrame, MAX_FRAME_BYTES, toFrames } from "../src/stream.ts";
import { type Reply, type SseEvent, sse, textEvents, toolEvents } from "./fake-responses.ts";
import {
	drafter,
	failure,
	type Harness,
	job,
	MODEL,
	rescript,
	SAMPLE_DRAFT,
	signedIn,
} from "./harness.ts";

// One fixed event list per structure, so every run gets the same bytes, ids included.
const ARGS = JSON.stringify(SAMPLE_DRAFT);
const STREAMS: Readonly<Record<string, readonly SseEvent[]>> = {
	"text-format": textEvents(MODEL, ARGS),
	"tool-namespace": toolEvents(MODEL, ARGS, "draftyak"),
};

interface Run {
	readonly events: unknown[];
	readonly outcome: DraftOutcome;
	readonly frames: number;
}

// One sign-in for every run; each run gets its own ctx.fetch with its own frame size.
let shared: Harness;
beforeAll(async () => {
	shared = await signedIn();
});
afterAll(async () => {
	await shared.close();
});

async function run(structure: Structure, frameBytes: number, crlf = false): Promise<Run> {
	const events = STREAMS[structure] ?? [];
	rescript(shared, () => ({ kind: "events", events, crlf }));
	const { broker, client } = drafter(shared, frameBytes);
	const seen: unknown[] = [];
	const outcome = await runDraft(client, job(structure), { onEvent: (event) => seen.push(event) });
	return { events: seen, outcome, frames: broker.requests[0]?.frames ?? 0 };
}

describe("SSE through host frames into the SDK", () => {
	it.each([1, 7, 4_096])("frames of %i bytes parse exactly like the whole body", async (size) => {
		for (const structure of ["text-format", "tool-namespace"] as const) {
			const whole = await run(structure, MAX_FRAME_BYTES);
			const split = await run(structure, size);
			const bytes = Buffer.byteLength(sse(STREAMS[structure] ?? []));
			expect(whole.frames).toBe(2);
			expect(split.frames).toBe(Math.ceil(bytes / size) + 1);
			expect(split.events).toEqual(whole.events);
			expect(split.events).toHaveLength(STREAMS[structure]?.length ?? -1);
			expect(split.outcome).toEqual(whole.outcome);
			expect(split.outcome).toEqual({
				kind: "draft",
				draft: SAMPLE_DRAFT,
				via: structure === "text-format" ? "text" : "tool",
			});
		}
	});

	it("splits multi-byte characters across frames in the 1- and 7-byte runs", () => {
		const bytes = Buffer.from(sse(STREAMS["text-format"] ?? []));
		const starts = (size: number): number =>
			Array.from(
				{ length: Math.ceil(bytes.length / size) },
				(_, index) => bytes[index * size] ?? 0,
			).filter((byte) => (byte & 0xc0) === 0x80).length;
		expect(starts(1)).toBeGreaterThan(0);
		expect(starts(7)).toBeGreaterThan(0);
	});

	it.each([1, 7, 4_096])("CRLF line endings in %i-byte frames parse like LF ones", async (size) => {
		const lf = await run("text-format", size);
		const crlf = await run("text-format", size, true);
		expect(crlf.events).toEqual(lf.events);
		expect(crlf.outcome).toEqual(lf.outcome);
	});

	it("a stream the upstream drops gives STREAM_INTERRUPTED, never a draft", async () => {
		const events = STREAMS["text-format"] ?? [];
		const cutAfter = Math.floor(Buffer.byteLength(sse(events)) / 2);
		const reply: Reply = { kind: "events", events, cutAfter };
		rescript(shared, () => reply);
		const { client } = drafter(shared, 7);
		const error = (await failure(runDraft(client, job("text-format")))) as SiwcError;
		expect([error.code, error.recovery, error.facts.status]).toEqual([
			"STREAM_INTERRUPTED",
			"backoff",
			200,
		]);
		expect(error.facts.requestId).toMatch(/^req_[0-9a-f]{24}$/);
	});
});

async function* list(frames: readonly HostFrame[]): AsyncGenerator<HostFrame> {
	yield* frames;
}

const body = (frames: readonly HostFrame[]): Promise<string> =>
	fromFrames({ status: 200, headers: [] }, list(frames)).text();
const data = (seq: number, text: string): HostFrame => ({
	seq,
	data: Buffer.from(text).toString("base64"),
});

describe("host frames", () => {
	it("cut the body into frames of exactly the asked size, whatever the upstream chunks", async () => {
		const upstream = new ReadableStream<Uint8Array>({
			start(controller) {
				for (const chunk of ["abc", "defghijklm", "n"]) controller.enqueue(Buffer.from(chunk));
				controller.close();
			},
		});
		const frames: HostFrame[] = [];
		for await (const frame of toFrames(upstream, 4)) frames.push(frame);
		expect(frames).toEqual([
			data(0, "abcd"),
			data(1, "efgh"),
			data(2, "ijkl"),
			data(3, "mn"),
			{ seq: 4, end: true },
		]);
		expect(await body(frames)).toBe("abcdefghijklmn");
		await expect(toFrames(null, 0).next()).rejects.toThrow(RangeError);
	});

	it.each([
		["a gap", [data(0, "a"), data(2, "b"), { seq: 3, end: true }], /out of order/],
		["a repeat", [data(0, "a"), data(0, "a"), { seq: 1, end: true }], /out of order/],
		[
			"non-canonical base64",
			[
				{ seq: 0, data: "QQ" },
				{ seq: 1, end: true },
			],
			/not valid base64/,
		],
		[
			"an empty frame",
			[
				{ seq: 0, data: "" },
				{ seq: 1, end: true },
			],
			/not valid base64/,
		],
		[
			"an oversized frame",
			[data(0, "x".repeat(MAX_FRAME_BYTES + 1)), { seq: 1, end: true }],
			/not valid base64/,
		],
		["an error frame", [data(0, "a"), { seq: 1, error: "TypeError" }], /host stream failed/],
		["no end frame", [data(0, "a")], /without its end frame/],
	] as [string, HostFrame[], RegExp][])("refuse %s", async (_name, frames, message) => {
		await expect(body(frames)).rejects.toThrow(message);
	});

	it("tell the host when the plugin stops reading", async () => {
		let cancelled = false;
		let returned = false;
		const frames = (async function* () {
			try {
				yield data(0, "a");
				yield data(1, "b");
			} finally {
				returned = true;
			}
		})();
		const response = fromFrames({ status: 200, headers: [] }, frames, () => {
			cancelled = true;
		});
		const reader = response.body?.getReader();
		await reader?.read();
		await reader?.cancel();
		expect([cancelled, returned]).toEqual([true, true]);
	});
});
