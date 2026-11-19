import { EventEmitter } from "node:events";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	createSampler,
	type MemorySampler,
	parseProcStatus,
	parsePsOutput,
	parseReaderLine,
	parseTasklistCsv,
	Watchdog,
} from "../../src/plugins/supervisor/memory.ts";
import { FakeClock, settle } from "../kernel/fake-clock.ts";

const mocks = vi.hoisted(() => ({ spawn: vi.fn(), execFile: vi.fn() }));
vi.mock("node:child_process", () => ({
	default: { spawn: mocks.spawn, execFile: mocks.execFile },
	spawn: mocks.spawn,
	execFile: mocks.execFile,
}));

afterEach(() => {
	mocks.spawn.mockReset();
	mocks.execFile.mockReset();
});

describe("reading parsers", () => {
	it("sums VmRSS and VmSwap from /proc status and needs both", () => {
		const status = "Name:\tnode\nVmRSS:\t   2048 kB\nVmSwap:\t      16 kB\nThreads:\t7\n";
		expect(parseProcStatus(status)).toBe((2048 + 16) * 1024);
		expect(parseProcStatus("VmRSS:\t2048 kB\n")).toBeUndefined();
		expect(parseProcStatus("VmSwap:\t0 kB\n")).toBeUndefined();
		expect(parseProcStatus("VmRSS:\t-1 kB\nVmSwap:\t0 kB\n")).toBeUndefined();
		expect(parseProcStatus("VmRSS:\t12.5 kB\nVmSwap:\t0 kB\n")).toBeUndefined();
		expect(parseProcStatus(`VmRSS:\t${"9".repeat(16)} kB\nVmSwap:\t0 kB\n`)).toBeUndefined();
		expect(parseProcStatus("garbage")).toBeUndefined();
	});

	it("reads several pids from one ps answer and leaves missing ones unreadable", () => {
		const output = "  101  2048\n102 4096   \r\n   bad line\n";
		expect(parsePsOutput(output, [101, 102, 103])).toEqual(
			new Map([
				[101, 2048 * 1024],
				[102, 4096 * 1024],
				[103, undefined],
			]),
		);
		expect(parsePsOutput("101 1\n101 2\n", [101]).get(101)).toBeUndefined();
		expect(parsePsOutput("", [7]).get(7)).toBeUndefined();
	});

	it("reads digits or nothing from the Windows reader", () => {
		expect(parseReaderLine("123456")).toBe(123_456);
		for (const line of ["x", "", "12a", "-1", "1.5", "99999999999999999"])
			expect(parseReaderLine(line)).toBeUndefined();
	});

	it("reads the tasklist working set with any digit grouping", () => {
		const row = (memory: string, pid = 42) => `"node.exe","${pid}","Console","1","${memory}"\r\n`;
		expect(parseTasklistCsv(row("64,980 K"), 42)).toBe(64_980 * 1024);
		expect(parseTasklistCsv(row("12.345 K"), 42)).toBe(12_345 * 1024);
		expect(parseTasklistCsv(row("12\u00a0345 K"), 42)).toBe(12_345 * 1024);
		expect(parseTasklistCsv(row("12\u202f345 Ko"), 42)).toBe(12_345 * 1024);
		expect(parseTasklistCsv(row("64,980 K", 43), 42)).toBeUndefined();
		expect(parseTasklistCsv(row("n/a"), 42)).toBeUndefined();
		expect(parseTasklistCsv(row("99999999999999999 K"), 42)).toBeUndefined();
		expect(
			parseTasklistCsv("INFO: No tasks are running which match the specified criteria.\r\n", 42),
		).toBeUndefined();
		expect(parseTasklistCsv(row("1 K") + row("2 K"), 42)).toBeUndefined();
	});
});

class FakeReader extends EventEmitter {
	readonly written: string[] = [];
	readonly stdout: EventEmitter & { setEncoding(encoding: string): void };
	readonly stdin: { write(text: string): boolean; on(): void };
	readonly kill = vi.fn(() => {
		this.emit("exit", null, "SIGTERM");
		return true;
	});

	constructor(answer: (pid: number) => string | undefined) {
		super();
		this.stdout = Object.assign(new EventEmitter(), { setEncoding: () => {} });
		this.stdin = {
			write: (text: string) => {
				this.written.push(text);
				for (const line of text.split("\n").filter(Boolean)) {
					const reply = answer(Number(line));
					if (reply !== undefined) queueMicrotask(() => this.stdout.emit("data", `${reply}\r\n`));
				}
				return true;
			},
			on: () => {},
		};
	}
}

describe("Windows private-bytes reader", () => {
	const systemRoot = "C:\\Windows";

	function sampler(
		clock: FakeClock,
		onFallback = vi.fn(),
	): { sampler: MemorySampler; onFallback: () => void } {
		return { sampler: createSampler("win32", systemRoot, clock, onFallback), onFallback };
	}

	it("starts one plain-text PowerShell with only SystemRoot and checks it on the hub's own pid", async () => {
		const readers: FakeReader[] = [];
		mocks.spawn.mockImplementation(() => {
			const reader = new FakeReader((pid) => (pid === 77 ? "x" : String(pid * 10)));
			readers.push(reader);
			return reader;
		});
		const { sampler: reader } = sampler(new FakeClock());
		expect(await reader.sample([41, 77])).toEqual(
			new Map([
				[41, 410],
				[77, undefined],
			]),
		);
		expect(mocks.spawn).toHaveBeenCalledTimes(1);
		const [file, args, options] = mocks.spawn.mock.calls[0] as [
			string,
			string[],
			Record<string, unknown>,
		];
		expect(file).toBe(
			path.join(systemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe"),
		);
		expect(path.win32.isAbsolute(file)).toBe(true);
		expect(args.slice(0, 4)).toEqual(["-NoLogo", "-NoProfile", "-NonInteractive", "-Command"]);
		expect(args).toHaveLength(5);
		expect(args.join(" ")).not.toMatch(/-EncodedCommand|-enc\b|-e\b/i);
		expect(args[4]).toContain("PrivateMemorySize64");
		expect(options).toEqual({
			env: { SystemRoot: systemRoot },
			stdio: ["pipe", "pipe", "ignore"],
			windowsHide: true,
			shell: false,
		});
		expect(readers[0]?.written).toEqual([`${process.pid}\n`, "41\n", "77\n"]);
		reader.close();
		expect(readers[0]?.kill).toHaveBeenCalled();
	});

	it("restarts once when a reading fails, then reads again", async () => {
		const clock = new FakeClock();
		let starts = 0;
		mocks.spawn.mockImplementation(() => {
			starts++;
			const silentForTarget = starts === 1;
			return new FakeReader((pid) =>
				pid === process.pid ? "1000" : silentForTarget ? undefined : "2048",
			);
		});
		const { sampler: reader, onFallback } = sampler(clock);
		const reading = reader.sample([9]);
		await settle();
		clock.advance(2_000);
		expect(await reading).toEqual(new Map([[9, 2048]]));
		expect(mocks.spawn).toHaveBeenCalledTimes(2);
		expect(onFallback).not.toHaveBeenCalled();
		reader.close();
	});

	it("falls back to tasklist for good when the reader fails its self-check", async () => {
		mocks.spawn.mockImplementation(() => new FakeReader(() => "x"));
		mocks.execFile.mockImplementation(
			(
				file: string,
				args: string[],
				options: unknown,
				callback: (error: null, stdout: string) => void,
			) => {
				expect(file).toBe(path.join(systemRoot, "System32", "tasklist.exe"));
				expect(args).toEqual(["/fi", "PID eq 5", "/fo", "csv", "/nh"]);
				expect(options).toMatchObject({
					env: { SystemRoot: systemRoot },
					shell: false,
					timeout: 2_000,
				});
				callback(null, '"node.exe","5","Console","1","2,048 K"\r\n');
			},
		);
		const { sampler: reader, onFallback } = sampler(new FakeClock());
		expect(await reader.sample([5])).toEqual(new Map([[5, 2048 * 1024]]));
		expect(await reader.sample([5])).toEqual(new Map([[5, 2048 * 1024]]));
		expect(onFallback).toHaveBeenCalledTimes(1);
		expect(mocks.spawn).toHaveBeenCalledTimes(1);
		expect(mocks.execFile).toHaveBeenCalledTimes(2);
	});

	it("falls back when the reader cannot start", async () => {
		mocks.spawn.mockImplementation(() => {
			throw new Error("blocked");
		});
		mocks.execFile.mockImplementation((_file, _args, _options, callback: (error: Error) => void) =>
			callback(new Error("tasklist failed")),
		);
		const { sampler: reader, onFallback } = sampler(new FakeClock());
		expect(await reader.sample([5])).toEqual(new Map([[5, undefined]]));
		expect(onFallback).toHaveBeenCalledTimes(1);
	});

	it("closes a reader still in its self-check without starting a fallback", async () => {
		const child = new FakeReader(() => undefined);
		mocks.spawn.mockReturnValue(child);
		const { sampler: reader, onFallback } = sampler(new FakeClock());
		const pending = reader.sample([5]);
		await settle();
		expect(child.written).toEqual([`${process.pid}\n`]);
		reader.close();
		expect(await pending).toEqual(new Map([[5, undefined]]));
		expect(child.kill).toHaveBeenCalled();
		expect(mocks.spawn).toHaveBeenCalledTimes(1);
		expect(mocks.execFile).not.toHaveBeenCalled();
		expect(onFallback).not.toHaveBeenCalled();
	});

	it("does not restart or fall back when closed during a target reading", async () => {
		const child = new FakeReader((pid) => (pid === process.pid ? "1000" : undefined));
		mocks.spawn.mockReturnValue(child);
		const { sampler: reader } = sampler(new FakeClock());
		const pending = reader.sample([5]);
		await settle();
		expect(child.written).toEqual([`${process.pid}\n`, "5\n"]);
		reader.close();
		expect(await pending).toEqual(new Map([[5, undefined]]));
		expect(await reader.sample([6])).toEqual(new Map([[6, undefined]]));
		expect(child.kill).toHaveBeenCalled();
		expect(mocks.spawn).toHaveBeenCalledTimes(1);
		expect(mocks.execFile).not.toHaveBeenCalled();
	});
});

describe("other readers", () => {
	it("macOS runs one ps per tick for every pid, with an empty environment", async () => {
		mocks.execFile.mockImplementation(
			(
				file: string,
				args: string[],
				options: unknown,
				callback: (error: { code: number } | null, stdout: string) => void,
			) => {
				expect(file).toBe("/bin/ps");
				expect(args).toEqual(["-o", "pid=,rss=", "-p", "3,4"]);
				expect(options).toMatchObject({ env: {}, shell: false, timeout: 2_000, maxBuffer: 65_536 });
				callback({ code: 1 }, "3 100\n");
			},
		);
		const reader = createSampler("darwin", undefined, new FakeClock(), () => {});
		expect(await reader.sample([3, 4])).toEqual(
			new Map([
				[3, 100 * 1024],
				[4, undefined],
			]),
		);
		expect(mocks.execFile).toHaveBeenCalledTimes(1);
	});
});

describe("watchdog", () => {
	function watchdog(values: (pid: number) => unknown): {
		clock: FakeClock;
		dog: Watchdog;
		sampled: number[][];
		closed: { count: number };
	} {
		const clock = new FakeClock();
		const sampled: number[][] = [];
		const closed = { count: 0 };
		const dog = new Watchdog(clock, () => ({
			sample: async (pids) => {
				sampled.push([...pids]);
				return new Map(pids.map((pid) => [pid, values(pid)])) as Map<number, number | undefined>;
			},
			close: () => {
				closed.count++;
			},
		}));
		return { clock, dog, sampled, closed };
	}

	async function tick(clock: FakeClock, ms: number): Promise<void> {
		clock.advance(ms);
		await settle();
	}

	it("kills strictly above the limit, retries an unreadable pid once, then fails closed", async () => {
		const values = new Map<number, unknown>([
			[1, 536_870_912],
			[2, 536_870_913],
			[3, undefined],
			[4, -5],
		]);
		const { clock, dog, sampled } = watchdog((pid) => values.get(pid));
		const kills: [number, string][] = [];
		for (const pid of [1, 2, 3, 4]) dog.register(pid, (reason) => kills.push([pid, reason]));
		await tick(clock, 4_999);
		expect(sampled).toEqual([]);
		await tick(clock, 1);
		expect(sampled).toEqual([
			[1, 2, 3, 4],
			[3, 4],
		]);
		expect(kills).toEqual([
			[2, "memory-limit"],
			[3, "memory-unobservable"],
			[4, "memory-unobservable"],
		]);
		dog.close();
	});

	it("fails closed when the sampler throws or cannot be made", async () => {
		const clock = new FakeClock();
		const kills: string[] = [];
		const dog = new Watchdog(clock, () => {
			throw new Error("no reader");
		});
		dog.register(9, (reason) => kills.push(reason));
		await tick(clock, 5_000);
		expect(kills).toEqual(["memory-unobservable"]);
		dog.close();
	});

	it("ticks only while a pid is registered and closes the reader when none remains", async () => {
		const { clock, dog, sampled, closed } = watchdog(() => 1);
		const unregister = dog.register(5, () => {});
		await tick(clock, 5_000);
		expect(sampled).toHaveLength(1);
		unregister();
		expect(closed.count).toBe(1);
		expect(clock.pending()).toEqual([]);
		await tick(clock, 60_000);
		expect(sampled).toHaveLength(1);
		dog.register(6, () => {});
		await tick(clock, 5_000);
		expect(sampled).toEqual([[5], [6]]);
		dog.close();
		expect(clock.pending()).toEqual([]);
		expect(dog.register(7, () => {})).toBeTypeOf("function");
		await tick(clock, 5_000);
		expect(sampled).toHaveLength(2);
	});
});
