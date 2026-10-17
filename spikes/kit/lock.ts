import { createHash } from "node:crypto";
import fs from "node:fs";
import { createServer } from "node:net";
import os from "node:os";
import path from "node:path";
import { concurrentBuilds, sampleCpu } from "./evidence.ts";
import { sleep } from "./exec.ts";

export class MachineBusyError extends Error {
	override name = "MachineBusyError";
	readonly code = "machine-busy";
}

// The lock wait and the idle wait share this budget, inside the heavy tier's 300 s test timeout.
// A benchmark with more work sets its test's timeout to benchTimeout(workMs).
export const BENCH_WAIT_MS = 240_000;
export const benchTimeout = (workMs: number): number => BENCH_WAIT_MS + 30_000 + workMs;

export interface IdleOptions {
	readonly maxCpuPercent?: number;
	readonly windowMs?: number;
	readonly sampleMs?: number;
	readonly timeoutMs?: number;
	readonly sample?: (ms: number) => Promise<number>;
	readonly signal?: AbortSignal;
}

export interface IdleResult {
	readonly samples: readonly number[];
	readonly maxCpuPercent: number;
	readonly thresholdPercent: number;
	readonly waitedMs: number;
	readonly concurrentBuilds: number | null;
}

// Waits until every CPU sample over windowMs is below the threshold, or fails as machine-busy.
export async function waitForIdle(options: IdleOptions = {}): Promise<IdleResult> {
	const { maxCpuPercent: threshold = 20, sampleMs = 1_000, timeoutMs = BENCH_WAIT_MS } = options;
	const size = Math.max(1, Math.ceil((options.windowMs ?? 5_000) / sampleMs));
	const begun = performance.now();
	const samples: number[] = [];
	for (;;) {
		options.signal?.throwIfAborted();
		samples.push(await (options.sample ?? sampleCpu)(sampleMs));
		options.signal?.throwIfAborted();
		if (samples.length > size) samples.shift();
		const max = Math.max(...samples);
		const waitedMs = Math.round(performance.now() - begun);
		if (samples.length === size && max < threshold) {
			const builds = await concurrentBuilds();
			return {
				samples,
				maxCpuPercent: max,
				thresholdPercent: threshold,
				waitedMs,
				concurrentBuilds: builds,
			};
		}
		if (waitedMs >= timeoutMs) {
			const window = `${size} samples within ${Math.round(timeoutMs / 1000)} s`;
			throw new MachineBusyError(
				`machine-busy: CPU not below ${threshold}% for ${window} (last max ${max}%)`,
			);
		}
	}
}

export interface LockHolder {
	readonly pid: number;
	readonly label: string;
	readonly since: string;
}

export interface BenchLockOptions {
	readonly path?: string;
	readonly label?: string;
	readonly timeoutMs?: number;
	readonly pollMs?: number;
	readonly idle?: IdleOptions | false;
	readonly signal?: AbortSignal;
	readonly onWait?: (holder: LockHolder | null, file: string) => void;
}

export interface BenchLock extends Disposable {
	readonly path: string;
	readonly waitedMs: number;
	readonly idle: IdleResult | null;
	release(): void;
}

export function benchLockPath(env: NodeJS.ProcessEnv = process.env): string {
	const local = env.LOCALAPPDATA ?? path.join(os.homedir(), "AppData", "Local");
	const state = env.XDG_STATE_HOME ?? path.join(os.homedir(), ".local", "state");
	return path.join(process.platform === "win32" ? local : state, "draftyak-dev", "bench.lock");
}

const ownerFile = (file: string): string => `${file}.owner`;

function readHolder(file: string): LockHolder | null {
	try {
		const holder = JSON.parse(fs.readFileSync(ownerFile(file), "utf8")) as Partial<LockHolder>;
		return typeof holder.pid === "number" && typeof holder.label === "string"
			? (holder as LockHolder)
			: null;
	} catch {
		return null;
	}
}

// The OS drops each lock with its holder, so a killed benchmark never leaves one behind: Windows
// and macOS open the file locked (libuv's UV_FS_O_EXLOCK; O_EXLOCK | O_NONBLOCK), Linux binds an
// abstract socket named after it.
async function tryLock(file: string): Promise<(() => void) | null> {
	if (process.platform === "linux") {
		const name = `\0draftyak-bench-${createHash("sha256").update(file).digest("hex").slice(0, 32)}`;
		const server = createServer();
		const bound = await new Promise<boolean>((resolve, reject) => {
			server.once("error", (error: NodeJS.ErrnoException) =>
				error.code === "EADDRINUSE" ? resolve(false) : reject(error),
			);
			server.listen({ path: name, exclusive: true }, () => resolve(true));
		});
		if (!bound) return null;
		server.unref();
		return () => server.close();
	}
	const exclusive = process.platform === "win32" ? 0x1000_0000 : 0x20 | fs.constants.O_NONBLOCK;
	try {
		const fd = fs.openSync(file, fs.constants.O_RDWR | fs.constants.O_CREAT | exclusive);
		return () => fs.closeSync(fd);
	} catch (error) {
		const code = (error as NodeJS.ErrnoException).code ?? "";
		if (/^(?:EBUSY|EPERM|EACCES|EAGAIN|EWOULDBLOCK)$/.test(code)) return null;
		throw error;
	}
}

function printWait(holder: LockHolder | null, file: string): void {
	const who = holder ? `${holder.label} (pid ${holder.pid}, since ${holder.since})` : "another run";
	process.stderr.write(`bench lock: waiting for ${who} to release ${file}\n`);
}

// Benchmarks, budgets and fixed-port tests hold this lock and pass the idle check, or fail as
// machine-busy. Pass the test's ctx.signal, so a test that times out stops waiting.
export async function acquireBenchLock(options: BenchLockOptions = {}): Promise<BenchLock> {
	const { path: file = benchLockPath(), timeoutMs = BENCH_WAIT_MS, pollMs = 500 } = options;
	const { signal } = options;
	fs.mkdirSync(path.dirname(file), { recursive: true });
	const begun = performance.now();
	const waited = (): number => Math.round(performance.now() - begun);
	let unlock = await tryLock(file);
	if (unlock === null) (options.onWait ?? printWait)(readHolder(file), file);
	while (unlock === null) {
		if (waited() >= timeoutMs) {
			throw new MachineBusyError(`machine-busy: ${file} still held after ${timeoutMs / 1000} s`);
		}
		await sleep(pollMs, signal);
		unlock = await tryLock(file);
	}
	const waitedMs = waited();
	const held = unlock;
	let released = false;
	const release = (): void => {
		if (released) return;
		released = true;
		fs.rmSync(ownerFile(file), { force: true });
		held();
	};
	try {
		signal?.throwIfAborted();
		const since = new Date().toISOString();
		const holder: LockHolder = { pid: process.pid, label: options.label ?? "benchmark", since };
		fs.writeFileSync(ownerFile(file), JSON.stringify(holder));
		const idle =
			options.idle === false
				? null
				: await waitForIdle({
						timeoutMs: Math.max(timeoutMs - waitedMs, 10_000),
						signal,
						...options.idle,
					});
		return { path: file, waitedMs, idle, release, [Symbol.dispose]: release };
	} catch (error) {
		release();
		throw error;
	}
}
