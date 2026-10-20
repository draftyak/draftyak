import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { afterEach, expect, it, vi } from "vitest";
import {
	observeStdioFixture,
	STDIO_FIXTURE_READY,
	STDIO_FIXTURE_REQUEST_MS,
	STDIO_FIXTURE_STARTUP_MS,
} from "./stdio-readiness.ts";

function probe() {
	const events = Object.assign(new EventEmitter(), {
		stdin: new PassThrough(),
		stdout: new PassThrough(),
		stderr: new PassThrough(),
		exitCode: null as number | null,
		signalCode: null as NodeJS.Signals | null,
	});
	const fixture = observeStdioFixture(events as unknown as ChildProcessWithoutNullStreams);
	return { events, fixture };
}
afterEach(() => vi.useRealTimers());

it("separates a delayed fixture bootstrap from the unchanged three-second response deadline", async () => {
	vi.useFakeTimers();
	const { events, fixture } = probe();
	const ready = fixture.ready();
	let started = false;
	const result = (async () => {
		await ready;
		started = true;
		return fixture.nextLine(
			{ next: () => Promise.resolve({ done: false, value: "reply" }) },
			"server/discover",
			1,
		);
	})();
	await vi.advanceTimersByTimeAsync(3_500);
	expect(started).toBe(false);
	events.stderr.write(`${STDIO_FIXTURE_READY}\n`);
	await expect(result).resolves.toBe("reply");
	expect(started).toBe(true);
	expect(STDIO_FIXTURE_REQUEST_MS).toBe(3_000);
	expect(STDIO_FIXTURE_STARTUP_MS).toBe(10_000);
	expect(vi.getTimerCount()).toBe(0);
});

it("bounds a missing startup marker and reports child/frame/stderr state", async () => {
	vi.useFakeTimers();
	const { events, fixture } = probe();
	events.stderr.write("synthetic bootstrap diagnostic");
	let failure: Error | undefined;
	const result = fixture.ready().catch((error: Error) => {
		failure = error;
	});
	await vi.advanceTimersByTimeAsync(9_999);
	expect(vi.getTimerCount()).toBe(1);
	await vi.advanceTimersByTimeAsync(1);
	expect(failure).toBeInstanceOf(Error);
	expect(failure?.message).toMatch(
		/startup timeout; method=startup; id=none; elapsedMs=10000; ready=false; frames=0; stdoutEOF=false; closed=false; exit=null; signal=null; stderr=synthetic bootstrap diagnostic/,
	);
	await result;
	expect(vi.getTimerCount()).toBe(0);
});

it("rejects a late response at exactly 3000ms instead of accepting it after timeout", async () => {
	vi.useFakeTimers();
	const { events, fixture } = probe();
	events.stderr.write(`${STDIO_FIXTURE_READY}\n`);
	await fixture.ready();
	let reply: ((value: IteratorResult<string>) => void) | undefined;
	let failure: Error | undefined;
	const result = fixture
		.nextLine(
			{
				next: () =>
					new Promise((resolve) => {
						reply = resolve;
					}),
			},
			"tools/list",
			7,
		)
		.catch((error: Error) => {
			failure = error;
		});
	await vi.advanceTimersByTimeAsync(2_999);
	expect(vi.getTimerCount()).toBe(1);
	await vi.advanceTimersByTimeAsync(1);
	expect(failure).toBeInstanceOf(Error);
	expect(failure?.message).toMatch(/response timeout; method=tools\/list; id=7/);
	await result;
	reply?.({ done: false, value: "late" });
	expect(vi.getTimerCount()).toBe(0);
});

it("distinguishes EOF from a known child exit and rejects a closed startup promptly", async () => {
	vi.useFakeTimers();
	const { events, fixture } = probe();
	events.exitCode = 19;
	events.emit("close", 19, null);
	await expect(fixture.ready()).rejects.toThrow(/startup closed;.*closed=true; exit=19/);
	await expect(
		fixture.nextLine(
			{ next: async () => ({ done: true, value: undefined }) },
			"server/discover",
			2,
		),
	).rejects.toThrow(/stdout EOF; method=server\/discover; id=2;.*closed=true; exit=19/);
	expect(vi.getTimerCount()).toBe(0);
});

it("retains reply correlation and removes only the exact split readiness marker from bounded diagnostics", async () => {
	const { events, fixture } = probe();
	events.stderr.write(STDIO_FIXTURE_READY.slice(0, 10));
	events.stderr.write(`${STDIO_FIXTURE_READY.slice(10)}\nnot-ready\n`);
	await fixture.ready();
	expect(fixture.stderrText()).toBe("not-ready\n");
	expect(() => fixture.checkId(8, 7, "tools/list")).toThrow(
		/reply correlation mismatch; method=tools\/list; id=7/,
	);
	expect(() => fixture.checkId(7, 7, "tools/list")).not.toThrow();
	const utf8 = Buffer.from("🙂");
	events.stderr.write(utf8.subarray(0, 2));
	events.stderr.write(utf8.subarray(2));
	expect(fixture.stderrText()).toBe("not-ready\n🙂");
	events.stderr.write("x".repeat(100_000));
	expect(fixture.stderrText().length).toBe(65_536);
});

it("rejects a ready child that closed before the caller observed readiness", async () => {
	const { events, fixture } = probe();
	events.stderr.write(`${STDIO_FIXTURE_READY}\n`);
	events.exitCode = 19;
	events.emit("close", 19, null);
	await expect(fixture.ready()).rejects.toThrow(/startup closed;.*ready=true;.*exit=19/);
});

it("does not accept an inexact readiness marker or swallow its diagnostic text", async () => {
	vi.useFakeTimers();
	const { events, fixture } = probe();
	let started = false;
	const ready = fixture.ready().then(() => {
		started = true;
	});
	events.stderr.write(`${STDIO_FIXTURE_READY}-extra\n`);
	await vi.advanceTimersByTimeAsync(0);
	expect(started).toBe(false);
	expect(fixture.stderrText()).toBe(`${STDIO_FIXTURE_READY}-extra\n`);
	events.stderr.write(`${STDIO_FIXTURE_READY}\n`);
	await ready;
	expect(started).toBe(true);
	expect(vi.getTimerCount()).toBe(0);
});

it("does not reset a request deadline when an intermediate host frame arrives", async () => {
	vi.useFakeTimers();
	const { fixture } = probe();
	const deadline = Date.now() + 3_000;
	const delayed = (value: string): AsyncIterator<string> => ({
		next: () => new Promise((resolve) => setTimeout(() => resolve({ done: false, value }), 2_000)),
	});
	const first = fixture.nextLine(delayed("host frame"), "tools/call", 4, deadline);
	await vi.advanceTimersByTimeAsync(2_000);
	await expect(first).resolves.toBe("host frame");
	let failure: Error | undefined;
	const result = fixture
		.nextLine(delayed("late result"), "tools/call", 4, deadline)
		.catch((error: Error) => {
			failure = error;
		});
	await vi.advanceTimersByTimeAsync(999);
	expect(failure).toBeUndefined();
	await vi.advanceTimersByTimeAsync(1);
	expect(failure).toBeInstanceOf(Error);
	expect(failure?.message).toMatch(/response timeout; method=tools\/call; id=4/);
	await result;
});

it("checks elapsed time even when a response resolves before a due timeout callback", async () => {
	vi.useFakeTimers();
	const { fixture } = probe();
	const deadline = Date.now() + 3_000;
	await expect(
		fixture.nextLine(
			{
				next: async () => {
					vi.setSystemTime(deadline);
					return { done: false, value: "late" };
				},
			},
			"server/discover",
			8,
			deadline,
		),
	).rejects.toThrow(/response timeout; method=server\/discover; id=8/);
});

it("refuses a late startup marker before an overdue timer callback runs", async () => {
	vi.useFakeTimers();
	const { events, fixture } = probe();
	const ready = fixture.ready();
	const failure = expect(ready).rejects.toThrow(/startup timeout/);
	vi.setSystemTime(Date.now() + 10_000);
	events.stderr.write(`${STDIO_FIXTURE_READY}\n`);
	await failure;
	expect(vi.getTimerCount()).toBe(0);
	await expect(fixture.ready()).rejects.toThrow(/startup timeout/);
});

it("preserves an on-time startup marker when its caller observes it later", async () => {
	vi.useFakeTimers();
	const { events, fixture } = probe();
	await vi.advanceTimersByTimeAsync(9_999);
	events.stderr.write(`${STDIO_FIXTURE_READY}\n`);
	await vi.advanceTimersByTimeAsync(2_000);
	await expect(fixture.ready()).resolves.toBeUndefined();
});

it.each(["exit", "signal"])(
	"refuses known %s after readiness while stdout remains open",
	async (mode) => {
		const { events, fixture } = probe();
		events.stderr.write(`${STDIO_FIXTURE_READY}\n`);
		if (mode === "exit") {
			events.exitCode = 19;
			events.emit("exit", 19, null);
		} else events.signalCode = "SIGTERM";
		await expect(fixture.ready()).rejects.toThrow(/startup closed;.*stdoutEOF=false; closed=false/);
	},
);

it.each(["exit", "close", "EOF"])(
	"rejects %s between marker receipt and the readiness continuation",
	async (mode) => {
		const { events, fixture } = probe();
		const ready = fixture.ready();
		events.stderr.write(`${STDIO_FIXTURE_READY}\n`);
		if (mode === "exit") {
			events.exitCode = 19;
			events.emit("exit", 19, null);
		} else if (mode === "close") events.emit("close", 19, null);
		else events.stdout.emit("end");
		await expect(ready).rejects.toThrow(/startup closed/);
	},
);

it.each(["child", "stdin"])(
	"observes a %s error during a read without rejecting the stop promise",
	async (mode) => {
		vi.useFakeTimers();
		const { events, fixture } = probe();
		let stopResult = "pending";
		const stopped = fixture.stopped.then(
			() => {
				stopResult = "closed";
			},
			() => {
				stopResult = "rejected";
			},
		);
		let failure: Error | undefined;
		const response = fixture
			.nextLine({ next: () => new Promise(() => {}) }, "tools/call", 9)
			.catch((error: Error) => {
				failure = error;
			});
		if (mode === "child") events.emit("error", new Error("synthetic stream failure"));
		else events.stdin.emit("error", new Error("synthetic stream failure"));
		await vi.advanceTimersByTimeAsync(0);
		expect(failure).toBeInstanceOf(Error);
		expect(failure?.message).toMatch(
			/child error; method=tools\/call; id=9;.*childError=synthetic stream failure/,
		);
		expect(stopResult).toBe("pending");
		events.emit("close", 19, null);
		await stopped;
		await response;
		expect(stopResult).toBe("closed");
		expect(vi.getTimerCount()).toBe(0);
	},
);
