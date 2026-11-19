import { ChildProcess, type ChildProcessByStdio, spawn } from "node:child_process";
import path from "node:path";
import { performance } from "node:perf_hooks";
import type { Readable } from "node:stream";
import { types } from "node:util";

export type PluginRssErrorCode = "RSS_LIMIT" | "RSS_UNAVAILABLE";

export class PluginRssError extends Error {
	readonly code: PluginRssErrorCode;
	constructor(code: PluginRssErrorCode) {
		super("Plugin RSS watch failed");
		this.name = "PluginRssError";
		this.code = code;
	}
}

export interface PluginRssWatch {
	readonly firstSample: Promise<number | undefined>;
	readonly signal: AbortSignal;
	readonly stopped: Promise<void>;
	stop(): Promise<void>;
}

const POLL_MS = 1000;
const PROBE_MS = 5000;
const OUTPUT_BYTES = 256;

/** Observes a caller-owned original child; neither sampling nor stopping retires that child. */
export function watchPluginRss(originalChild: ChildProcess, maxRssBytes: number): PluginRssWatch {
	if (
		types.isProxy(originalChild) ||
		!(originalChild instanceof ChildProcess) ||
		!Number.isSafeInteger(originalChild.pid) ||
		(originalChild.pid ?? 0) <= 0 ||
		!Number.isSafeInteger(maxRssBytes) ||
		maxRssBytes <= 0
	)
		throw new PluginRssError("RSS_UNAVAILABLE");
	const pid = originalChild.pid;
	if (pid === undefined) throw new PluginRssError("RSS_UNAVAILABLE");
	const root = process.platform === "win32" ? process.env.SystemRoot : undefined;
	const first = Promise.withResolvers<number | undefined>();
	const retirement = Promise.withResolvers<void>();
	const controller = new AbortController();
	let firstPublished = false;
	let fenced = false;
	let queued = false;
	let poll: ReturnType<typeof setTimeout> | undefined;
	let active: { cancel(): void } | undefined;
	const publishFirst = (rss: number | undefined): void => {
		if (firstPublished) return;
		firstPublished = true;
		first.resolve(rss);
	};
	const finish = (): void => {
		if (!fenced || active || queued) return;
		originalChild.removeListener("exit", onWatchedExit);
		originalChild.removeListener("close", onWatchedExit);
		originalChild.removeListener("error", onWatchedError);
		retirement.resolve();
	};
	const stop = (): Promise<void> => {
		fenced = true;
		if (poll !== undefined) clearTimeout(poll);
		poll = undefined;
		publishFirst(undefined);
		active?.cancel();
		finish();
		return retirement.promise;
	};
	const fail = (code: PluginRssErrorCode): void => {
		const publish = !fenced;
		stop();
		if (publish && !controller.signal.aborted) controller.abort(new PluginRssError(code));
	};
	function onWatchedExit(): void {
		stop();
	}
	function onWatchedError(): void {
		fail("RSS_UNAVAILABLE");
	}
	const begin = (): void => {
		if (fenced || active) return;
		let executable = "/bin/ps";
		let args = ["-o", "rss=", "-p", String(pid)];
		let env: NodeJS.ProcessEnv = { LANG: "C", LC_ALL: "C" };
		if (process.platform === "win32") {
			if (!root || !path.isAbsolute(root) || root.includes("\0")) {
				fail("RSS_UNAVAILABLE");
				return;
			}
			executable = path.join(root, "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
			args = [
				"-NoLogo",
				"-NoProfile",
				"-NonInteractive",
				"-Command",
				`$p=Get-Process -Id ${pid} -ErrorAction Stop;[Console]::Out.Write($p.WorkingSet64.ToString([Globalization.CultureInfo]::InvariantCulture))`,
			];
			env = { SystemRoot: root, WINDIR: root, PATH: "" };
		}
		let probe: ChildProcessByStdio<null, Readable, Readable> | undefined;
		let attached = false;
		let cancelled = false;
		let killRequested = false;
		let closed = false;
		let stdoutClosed = false;
		let stderrClosed = false;
		let stdoutEnded = false;
		let stderrEnded = false;
		let bad = false;
		let completed = false;
		let stdoutBytes = 0;
		let stderrBytes = 0;
		let probeStart = Number.NaN;
		let probeDeadline = Number.NaN;
		let deadline: ReturnType<typeof setTimeout> | undefined;
		const bytes = Buffer.alloc(OUTPUT_BYTES);
		const cancel = (): void => {
			cancelled = true;
			if (deadline !== undefined) clearTimeout(deadline);
			deadline = undefined;
			if (!probe || !attached || closed || killRequested) return;
			killRequested = true;
			if (probe.exitCode !== null || probe.signalCode !== null) return;
			try {
				probe.kill("SIGKILL");
			} catch {
				bad = true;
			}
		};
		const failed = (): void => {
			bad = true;
			if (!fenced) fail("RSS_UNAVAILABLE");
		};
		const complete = (): void => {
			if (completed || !closed || !stdoutClosed || !stderrClosed || !probe) return;
			completed = true;
			if (deadline !== undefined) clearTimeout(deadline);
			probe.removeListener("error", failed);
			probe.stdout.removeListener("data", onStdout);
			probe.stderr.removeListener("data", onStderr);
			probe.stdout.removeListener("error", failed);
			probe.stderr.removeListener("error", failed);
			active = undefined;
			if (!fenced && !cancelled) {
				let observedAt = Number.NaN;
				try {
					observedAt = performance.now();
				} catch {
					bad = true;
				}
				if (!Number.isFinite(observedAt) || observedAt < probeStart || observedAt >= probeDeadline)
					bad = true;
				const text = bytes.subarray(0, stdoutBytes).toString("utf8");
				const numeric = /^[\t\r\n ]*[0-9]+[\t\r\n ]*$/.test(text) ? Number(text) : Number.NaN;
				const rss = process.platform === "win32" ? numeric : numeric * 1024;
				if (
					bad ||
					!stdoutEnded ||
					!stderrEnded ||
					stderrBytes !== 0 ||
					!Number.isSafeInteger(rss) ||
					rss < 0
				) {
					fail("RSS_UNAVAILABLE");
				} else {
					publishFirst(rss);
					if (rss > maxRssBytes) fail("RSS_LIMIT");
					else
						poll = setTimeout(() => {
							poll = undefined;
							begin();
						}, POLL_MS);
				}
			}
			finish();
		};
		const onStdout = (chunk: unknown): void => {
			if (bad || cancelled) return;
			if (!Buffer.isBuffer(chunk) || chunk.byteLength > OUTPUT_BYTES - stdoutBytes) {
				failed();
				return;
			}
			chunk.copy(bytes, stdoutBytes);
			stdoutBytes += chunk.byteLength;
		};
		const onStderr = (chunk: unknown): void => {
			if (bad || cancelled) return;
			if (!Buffer.isBuffer(chunk) || chunk.byteLength > OUTPUT_BYTES - stderrBytes) {
				failed();
				return;
			}
			stderrBytes += chunk.byteLength;
		};
		active = { cancel };
		try {
			probeStart = performance.now();
			probeDeadline = probeStart + PROBE_MS;
			if (!Number.isFinite(probeStart) || probeStart < 0 || !Number.isFinite(probeDeadline))
				throw new PluginRssError("RSS_UNAVAILABLE");
			deadline = setTimeout(failed, PROBE_MS);
			probe = spawn(executable, args, {
				shell: false,
				windowsHide: true,
				env,
				stdio: ["ignore", "pipe", "pipe"],
			});
		} catch {
			clearTimeout(deadline);
			active = undefined;
			fail("RSS_UNAVAILABLE");
			return;
		}
		probe.on("error", failed);
		probe.once("close", (code, signal) => {
			closed = true;
			if (code !== 0 || signal !== null) failed();
			complete();
		});
		probe.stdout.on("error", failed);
		probe.stderr.on("error", failed);
		probe.stdout.once("end", () => {
			stdoutEnded = true;
		});
		probe.stderr.once("end", () => {
			stderrEnded = true;
		});
		probe.stdout.once("close", () => {
			stdoutClosed = true;
			if (!stdoutEnded) failed();
			complete();
		});
		probe.stderr.once("close", () => {
			stderrClosed = true;
			if (!stderrEnded) failed();
			complete();
		});
		probe.stdout.on("data", onStdout);
		probe.stderr.on("data", onStderr);
		attached = true;
		if (cancelled || fenced) cancel();
	};
	originalChild.once("exit", onWatchedExit);
	originalChild.once("close", onWatchedExit);
	originalChild.on("error", onWatchedError);
	if (originalChild.exitCode !== null || originalChild.signalCode !== null) stop();
	else {
		queued = true;
		queueMicrotask(() => {
			queued = false;
			if (!fenced) begin();
			finish();
		});
	}
	return Object.freeze({
		firstSample: first.promise,
		signal: controller.signal,
		stopped: retirement.promise,
		stop,
	});
}
