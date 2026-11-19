import childProcess, { type ChildProcess } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import type { TimerClock } from "../../kernel/clock.ts";
import { READING_TIMEOUT_MS, RSS_INTERVAL_MS, RSS_LIMIT_BYTES } from "./policy.ts";
import type { SupervisedPlatform } from "./runtime.ts";
import { sleep } from "./timers.ts";

/** Bytes per pid; undefined where the reading failed. Readers never signal a process. */
export interface MemorySampler {
	sample(pids: readonly number[]): Promise<ReadonlyMap<number, number | undefined>>;
	close(): void;
}

function bytesFromKib(digits: string | undefined): number | undefined {
	if (digits === undefined || !/^[0-9]{1,15}$/.test(digits)) return undefined;
	const value = Number(digits) * 1024;
	return Number.isSafeInteger(value) ? value : undefined;
}

/** Linux /proc/<pid>/status: VmRSS plus VmSwap, both required. */
export function parseProcStatus(text: string): number | undefined {
	if (typeof text !== "string") return undefined;
	const rss = bytesFromKib(/^VmRSS:[ \t]+([0-9]+) kB$/m.exec(text)?.[1]);
	const swap = bytesFromKib(/^VmSwap:[ \t]+([0-9]+) kB$/m.exec(text)?.[1]);
	if (rss === undefined || swap === undefined) return undefined;
	const total = rss + swap;
	return Number.isSafeInteger(total) ? total : undefined;
}

/** macOS `ps -o pid=,rss=` for several pids at once; a pid missing from the output is unreadable. */
export function parsePsOutput(
	text: string,
	pids: readonly number[],
): Map<number, number | undefined> {
	const found = new Map<number, number | undefined>();
	for (const line of typeof text === "string" ? text.split("\n") : []) {
		const match = /^[ \t]*([0-9]{1,10})[ \t]+([0-9]+)[ \t]*$/.exec(line.replace(/\r$/, ""));
		if (match === null) continue;
		const pid = Number(match[1]);
		if (found.has(pid)) found.set(pid, undefined);
		else found.set(pid, bytesFromKib(match[2]));
	}
	return new Map(pids.map((pid) => [pid, found.get(pid)]));
}

/** One line of the Windows reader: private bytes as digits, or "x" when unreadable. */
export function parseReaderLine(text: string): number | undefined {
	if (typeof text !== "string" || !/^[0-9]{1,16}$/.test(text)) return undefined;
	const value = Number(text);
	return Number.isSafeInteger(value) ? value : undefined;
}

/** tasklist /fo csv /nh: the working set column in KiB, with any locale's digit grouping. */
export function parseTasklistCsv(text: string, pid: number): number | undefined {
	if (typeof text !== "string") return undefined;
	const lines = text.split(/\r?\n/).filter((line) => line !== "");
	if (lines.length !== 1) return undefined;
	const fields = /^"([^"]*)","([0-9]+)","[^"]*","[0-9]+","([^"]*)"$/.exec(lines[0] as string);
	if (fields === null || Number(fields[2]) !== pid) return undefined;
	const memory = /^([0-9][0-9.,   ]*) ?[A-Za-z]{1,3}$/.exec(fields[3] as string)?.[1];
	return bytesFromKib(memory?.replace(/[^0-9]/g, ""));
}

const READER_SCRIPT =
	"$ErrorActionPreference='Stop';while($true){$l=[Console]::In.ReadLine();if($null -eq $l){break};$v='x';try{$v=[string](Get-Process -Id ([int]$l)).PrivateMemorySize64}catch{$v='x'};[Console]::Out.WriteLine($v);[Console]::Out.Flush()}";

const FAILED = Symbol("failed");
type Reading = number | undefined | typeof FAILED;

function windowsTool(systemRoot: string, ...parts: string[]): string {
	return path.join(systemRoot, "System32", ...parts);
}

/** A long-lived Windows PowerShell answering one private-bytes value per pid line. */
class PowerShellReader {
	readonly #child: ChildProcess;
	readonly #clock: TimerClock;
	#buffer = "";
	#waiting: ((reading: Reading) => void)[] = [];
	#dead = false;

	constructor(systemRoot: string, clock: TimerClock) {
		this.#clock = clock;
		this.#child = childProcess.spawn(
			windowsTool(systemRoot, "WindowsPowerShell", "v1.0", "powershell.exe"),
			["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", READER_SCRIPT],
			{
				env: { SystemRoot: systemRoot },
				stdio: ["pipe", "pipe", "ignore"],
				windowsHide: true,
				shell: false,
			},
		);
		this.#child.on("error", () => this.close());
		this.#child.once("exit", () => this.close());
		this.#child.stdin?.on("error", () => this.close());
		this.#child.stdout?.on("error", () => this.close());
		this.#child.stdout?.setEncoding("latin1");
		this.#child.stdout?.on("data", (chunk: string) => this.#data(chunk));
	}

	#data(chunk: string): void {
		this.#buffer += chunk;
		for (;;) {
			const end = this.#buffer.indexOf("\n");
			if (end === -1) break;
			const line = this.#buffer.slice(0, end).replace(/\r$/, "");
			this.#buffer = this.#buffer.slice(end + 1);
			const next = this.#waiting.shift();
			if (next === undefined) {
				this.close();
				return;
			}
			next(line === "x" ? undefined : (parseReaderLine(line) ?? FAILED));
		}
		if (this.#buffer.length > 4096) this.close();
	}

	read(pid: number): Promise<Reading> {
		if (this.#dead || !Number.isSafeInteger(pid) || pid <= 0) return Promise.resolve(FAILED);
		const { promise, resolve } = Promise.withResolvers<Reading>();
		const timer = new AbortController();
		this.#waiting.push((reading) => {
			timer.abort();
			resolve(reading);
		});
		void sleep(this.#clock, READING_TIMEOUT_MS, timer.signal).then((elapsed) => {
			if (!elapsed) return;
			this.close();
			resolve(FAILED);
		});
		try {
			this.#child.stdin?.write(`${pid}\n`);
		} catch {
			this.close();
		}
		return promise;
	}

	close(): void {
		if (this.#dead) return;
		this.#dead = true;
		try {
			this.#child.kill();
		} catch {
			/* Already gone. */
		}
		for (const next of this.#waiting.splice(0)) next(FAILED);
	}
}

function tasklist(systemRoot: string, pid: number): Promise<number | undefined> {
	return new Promise((resolve) => {
		try {
			childProcess.execFile(
				windowsTool(systemRoot, "tasklist.exe"),
				["/fi", `PID eq ${pid}`, "/fo", "csv", "/nh"],
				{
					env: { SystemRoot: systemRoot },
					timeout: READING_TIMEOUT_MS,
					maxBuffer: 65_536,
					shell: false,
					windowsHide: true,
				},
				(error, stdout) => resolve(error ? undefined : parseTasklistCsv(String(stdout), pid)),
			);
		} catch {
			resolve(undefined);
		}
	});
}

class WindowsSampler implements MemorySampler {
	readonly #systemRoot: string;
	readonly #clock: TimerClock;
	readonly #onFallback: () => void;
	#reader: PowerShellReader | undefined;
	/** A reader still in its self-check, so close() can end it too. */
	#starting: PowerShellReader | undefined;
	#fallback = false;
	#closed = false;

	constructor(systemRoot: string, clock: TimerClock, onFallback: () => void) {
		this.#systemRoot = systemRoot;
		this.#clock = clock;
		this.#onFallback = onFallback;
	}

	async #started(): Promise<PowerShellReader | undefined> {
		if (this.#closed || this.#fallback) return undefined;
		if (this.#reader !== undefined) return this.#reader;
		let reader: PowerShellReader;
		try {
			reader = new PowerShellReader(this.#systemRoot, this.#clock);
		} catch {
			return this.#fallBack();
		}
		this.#starting = reader;
		// Self-check on the hub's own pid before trusting any reading.
		const checked = typeof (await reader.read(process.pid)) === "number";
		if (this.#starting === reader) this.#starting = undefined;
		// A sampler closed meanwhile never keeps a reader.
		if (this.#closed) {
			reader.close();
			return undefined;
		}
		if (!checked) {
			reader.close();
			return this.#fallBack();
		}
		this.#reader = reader;
		return reader;
	}

	#fallBack(): undefined {
		if (!this.#fallback) {
			this.#fallback = true;
			this.#onFallback();
		}
		return undefined;
	}

	async #read(pid: number): Promise<number | undefined> {
		for (let attempt = 0; attempt < 2; attempt++) {
			const reader = await this.#started();
			// Once closed, nothing is started or run again: no reader, no restart, no tasklist.
			if (this.#closed) return undefined;
			if (reader === undefined) return tasklist(this.#systemRoot, pid);
			const reading = await reader.read(pid);
			if (reading !== FAILED) return reading;
			reader.close();
			if (this.#reader === reader) this.#reader = undefined;
		}
		return undefined;
	}

	async sample(pids: readonly number[]): Promise<ReadonlyMap<number, number | undefined>> {
		const result = new Map<number, number | undefined>();
		for (const pid of pids) result.set(pid, await this.#read(pid));
		return result;
	}

	close(): void {
		this.#closed = true;
		this.#starting?.close();
		this.#starting = undefined;
		this.#reader?.close();
		this.#reader = undefined;
	}
}

const linuxSampler: MemorySampler = Object.freeze({
	sample(pids: readonly number[]): Promise<ReadonlyMap<number, number | undefined>> {
		const result = new Map<number, number | undefined>();
		for (const pid of pids) {
			try {
				result.set(pid, parseProcStatus(readFileSync(`/proc/${pid}/status`, "latin1")));
			} catch {
				result.set(pid, undefined);
			}
		}
		return Promise.resolve(result);
	},
	close(): void {},
});

const macSampler: MemorySampler = Object.freeze({
	sample(pids: readonly number[]): Promise<ReadonlyMap<number, number | undefined>> {
		return new Promise((resolve) => {
			try {
				childProcess.execFile(
					"/bin/ps",
					["-o", "pid=,rss=", "-p", pids.join(",")],
					{
						env: {},
						timeout: READING_TIMEOUT_MS,
						maxBuffer: 65_536,
						shell: false,
						windowsHide: true,
					},
					// ps exits 1 when a pid is missing; the rest of its output still counts.
					(error, stdout) =>
						resolve(
							error && error.code !== 1
								? new Map(pids.map((pid) => [pid, undefined]))
								: parsePsOutput(String(stdout), pids),
						),
				);
			} catch {
				resolve(new Map(pids.map((pid) => [pid, undefined])));
			}
		});
	},
	close(): void {},
});

/** The per-OS reader: /proc on Linux, one ps per tick on macOS, PowerShell or tasklist on Windows. */
export function createSampler(
	platform: SupervisedPlatform,
	systemRoot: string | undefined,
	clock: TimerClock,
	onFallback: () => void,
): MemorySampler {
	if (platform === "linux") return linuxSampler;
	if (platform === "darwin") return macSampler;
	if (systemRoot === undefined) throw new TypeError("SystemRoot is required on Windows");
	return new WindowsSampler(systemRoot, clock, onFallback);
}

export type MemoryKill = "memory-limit" | "memory-unobservable";

const UNREADABLE: MemorySampler = Object.freeze({
	sample: (): Promise<ReadonlyMap<number, number | undefined>> => Promise.resolve(new Map()),
	close(): void {},
});

/** Samples every registered plugin every RSS_INTERVAL_MS while any is registered; fails closed. */
export class Watchdog {
	readonly #clock: TimerClock;
	readonly #factory: () => MemorySampler;
	readonly #closed = new AbortController();
	readonly #targets = new Map<number, (reason: MemoryKill) => void>();
	#sampler: MemorySampler | undefined;
	#wake: AbortController | undefined;

	/** `factory` makes the sampler lazily, at the first tick after an idle period. */
	constructor(clock: TimerClock, factory: () => MemorySampler) {
		this.#clock = clock;
		this.#factory = factory;
	}

	/** Watches one pid until the returned function runs. */
	register(pid: number, kill: (reason: MemoryKill) => void): () => void {
		if (this.#closed.signal.aborted || !Number.isSafeInteger(pid) || pid <= 0) return () => {};
		const entry = (reason: MemoryKill): void => kill(reason);
		this.#targets.set(pid, entry);
		if (this.#wake === undefined) void this.#loop();
		return () => {
			if (this.#targets.get(pid) !== entry) return;
			this.#targets.delete(pid);
			if (this.#targets.size === 0) this.#idle();
		};
	}

	close(): void {
		this.#closed.abort();
		this.#targets.clear();
		this.#idle();
	}

	#idle(): void {
		this.#wake?.abort();
		this.#wake = undefined;
		this.#sampler?.close();
		this.#sampler = undefined;
	}

	async #loop(): Promise<void> {
		const wake = new AbortController();
		this.#wake = wake;
		const signal = AbortSignal.any([wake.signal, this.#closed.signal]);
		while (this.#targets.size > 0 && !signal.aborted) {
			if (!(await sleep(this.#clock, RSS_INTERVAL_MS, signal))) break;
			await this.#tick(signal);
		}
		if (this.#wake === wake) this.#wake = undefined;
	}

	async #read(
		sampler: MemorySampler,
		pids: readonly number[],
	): Promise<Map<number, number | undefined>> {
		const result = new Map<number, number | undefined>();
		let readings: ReadonlyMap<number, number | undefined> | undefined;
		try {
			readings = await sampler.sample(pids);
		} catch {
			readings = undefined;
		}
		for (const pid of pids) {
			const value = readings?.get(pid);
			result.set(
				pid,
				typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : undefined,
			);
		}
		return result;
	}

	async #tick(signal: AbortSignal): Promise<void> {
		const pids = [...this.#targets.keys()];
		if (pids.length === 0) return;
		let sampler = this.#sampler;
		if (sampler === undefined) {
			try {
				sampler = this.#factory();
			} catch {
				sampler = UNREADABLE;
			}
			this.#sampler = sampler;
		}
		const readings = await this.#read(sampler, pids);
		const missing = pids.filter((pid) => readings.get(pid) === undefined);
		if (missing.length > 0 && !signal.aborted) {
			const retry = await this.#read(sampler, missing);
			for (const pid of missing) readings.set(pid, retry.get(pid));
		}
		if (signal.aborted) return;
		for (const pid of pids) {
			const kill = this.#targets.get(pid);
			if (kill === undefined) continue;
			const value = readings.get(pid);
			if (value === undefined) kill("memory-unobservable");
			else if (value > RSS_LIMIT_BYTES) kill("memory-limit");
		}
	}
}
