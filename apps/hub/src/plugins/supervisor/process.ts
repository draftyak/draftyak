import childProcess, { type ChildProcess } from "node:child_process";
import {
	openPluginStdio,
	type PluginProcessIo,
	type PluginStdio,
	type PluginStdioResult,
} from "@draftyak/protocol/plugin-stdio";
import type { TimerClock } from "../../kernel/clock.ts";
import { PluginSupervisorError } from "./errors.ts";
import { type Frame, FrameDecoder } from "./frames.ts";
import {
	COMPLETION_MS,
	type CrashReason,
	KILL_CONFIRM_MS,
	MAX_STDIN_FRAMES,
	STDERR_LIMIT_BYTES,
	type StopReason,
	type ViolationKind,
} from "./policy.ts";
import { schedule, within } from "./timers.ts";

/** Everything one spawn uses, built and checked before any process exists. */
export interface LaunchPlan {
	readonly execPath: string;
	readonly argv: readonly string[];
	readonly cwd: string;
	readonly env: Readonly<Record<string, string>>;
	readonly stdioRoot: string;
}

export type ProcessEnd =
	| { readonly outcome: "stopped"; readonly reason: StopReason; readonly cleanupFailed: boolean }
	| { readonly outcome: "crashed"; readonly reason: CrashReason; readonly cleanupFailed: boolean };

type EndReason =
	| { readonly outcome: "stopped"; readonly reason: StopReason }
	| { readonly outcome: "crashed"; readonly reason: CrashReason };

export interface ProcessHooks {
	/** Each decoded frame, in order; false stops decoding. */
	frame(frame: Frame): boolean;
	heldWriter(): void;
	cleanupFailed(): void;
	killUnconfirmed(): void;
}

/** A write that never reached the plugin: the process ended, the wait for room was aborted or it failed. */
export class WriteRefused extends Error {
	constructor() {
		super("Plugin write refused.");
		this.name = "WriteRefused";
	}
}

interface Waiter {
	go(): void;
	fail(): void;
}

/**
 * One spawned plugin. All IO stays inside: the child, its stdio and its pid never leave the
 * supervisor. The end is the child's exit and a bounded completion, never an EOF wait.
 */
export class PluginProcess {
	readonly pid: number | undefined;
	readonly ended: Promise<ProcessEnd>;
	readonly #child: ChildProcess;
	readonly #stdio: PluginStdio;
	readonly #io: PluginProcessIo;
	readonly #hooks: ProcessHooks;
	readonly #clock: TimerClock;
	readonly #lifetime = new AbortController();
	readonly #decoder = new FrameDecoder();
	readonly #onStdout = (chunk: Buffer): void => this.#data(chunk);
	readonly #pendingWrites = new Set<(error?: unknown) => void>();
	readonly #waiters: Waiter[] = [];
	#reason: EndReason | undefined;
	#ending = false;
	#exited = false;
	#killSent = false;
	#outstanding = 0;
	#stderrBytes = 0;
	#dropped = 0;

	/** Opens stdio, spawns and attaches in one turn; undefined when `live` turned false meanwhile. */
	static async open(
		plan: LaunchPlan,
		hooks: ProcessHooks,
		clock: TimerClock,
		live: () => boolean,
	): Promise<PluginProcess | undefined> {
		let stdio: PluginStdio;
		try {
			stdio = await openPluginStdio({ parentDir: plan.stdioRoot });
		} catch {
			throw new PluginSupervisorError("SPAWN_FAILED");
		}
		if (!live()) {
			await within(clock, COMPLETION_MS, stdio.destroy());
			return undefined;
		}
		let child: ChildProcess;
		try {
			child = childProcess.spawn(plan.execPath, [...plan.argv], {
				cwd: plan.cwd,
				env: plan.env,
				stdio: [...stdio.stdio],
				windowsHide: true,
				shell: false,
				detached: false,
			});
		} catch {
			await within(clock, COMPLETION_MS, stdio.destroy());
			throw new PluginSupervisorError("SPAWN_FAILED");
		}
		let io: PluginProcessIo;
		try {
			io = stdio.attach(child);
		} catch {
			child.on("error", () => {});
			try {
				child.kill("SIGKILL");
			} catch {
				/* The failed spawn is still reported below. */
			}
			await within(clock, COMPLETION_MS, stdio.destroy());
			throw new PluginSupervisorError("SPAWN_FAILED");
		}
		return new PluginProcess(child, stdio, io, hooks, clock);
	}

	private constructor(
		child: ChildProcess,
		stdio: PluginStdio,
		io: PluginProcessIo,
		hooks: ProcessHooks,
		clock: TimerClock,
	) {
		this.#child = child;
		this.#stdio = stdio;
		this.#io = io;
		this.#hooks = hooks;
		this.#clock = clock;
		this.pid = child.pid;
		// Later child errors (a failed kill) must never surface as an unhandled 'error' in the hub.
		child.on("error", () => {});
		io.input.on("error", () => {});
		const [stdout, stderr] = io.outputs;
		stdout.on("error", () => {});
		stderr.on("error", () => {});
		const exited = new Promise<undefined>((resolve) =>
			child.once("exit", () => {
				this.#exited = true;
				resolve(undefined);
			}),
		);
		stdout.on("data", this.#onStdout);
		// Discarded unread: only its size is kept.
		stderr.on("data", (chunk: Buffer) => this.#stderr(chunk));
		this.ended = this.#watch(exited, io.completion);
	}

	/** True once a stop, kill or violation was requested, or the child exited. */
	get ending(): boolean {
		return this.#ending || this.#exited;
	}

	get dropped(): number {
		return this.#dropped;
	}

	/** Ends the process as a supervisor stop: never counted as a crash. */
	stop(reason: StopReason): void {
		this.#mark({ outcome: "stopped", reason });
		this.#terminate();
	}

	/** Ends the process as a crash; the first recorded reason wins. */
	kill(reason: CrashReason): void {
		this.#mark({ outcome: "crashed", reason });
		this.#terminate();
	}

	/** Stops decoding at once, closes the hub's read end of stdout and kills. */
	violate(kind: ViolationKind): void {
		this.#decoder.stop();
		this.#mark({ outcome: "crashed", reason: `violation:${kind}` });
		this.#io.outputs[0].destroy();
		this.#terminate();
	}

	/** A hub-initiated request: written now, or undefined at the frame cap with nothing written. */
	tryWrite(line: string): Promise<void> | undefined {
		if (this.ending) {
			this.#dropped++;
			return Promise.reject(new WriteRefused());
		}
		if (this.#outstanding >= MAX_STDIN_FRAMES) return undefined;
		return this.#send(line);
	}

	/** Replies and notifications wait for room under the frame cap, bounded by `signal`. */
	writeWhenFree(line: string, signal: AbortSignal): Promise<void> {
		if (this.ending || signal.aborted) {
			this.#dropped++;
			return Promise.reject(new WriteRefused());
		}
		if (this.#outstanding < MAX_STDIN_FRAMES && this.#waiters.length === 0) return this.#send(line);
		return new Promise<void>((resolve, reject) => {
			const onAbort = (): void => {
				const index = this.#waiters.indexOf(waiter);
				if (index !== -1) this.#waiters.splice(index, 1);
				waiter.fail();
			};
			const waiter: Waiter = {
				go: () => {
					signal.removeEventListener("abort", onAbort);
					this.#send(line).then(resolve, reject);
				},
				fail: () => {
					signal.removeEventListener("abort", onAbort);
					this.#dropped++;
					reject(new WriteRefused());
				},
			};
			signal.addEventListener("abort", onAbort, { once: true });
			this.#waiters.push(waiter);
		});
	}

	#send(line: string): Promise<void> {
		this.#outstanding++;
		return new Promise<void>((resolve, reject) => {
			let done = false;
			const settle = (error?: unknown): void => {
				if (done) return;
				done = true;
				this.#pendingWrites.delete(settle);
				this.#outstanding--;
				if (error) reject(new WriteRefused());
				else resolve();
				this.#release();
			};
			this.#pendingWrites.add(settle);
			try {
				this.#io.input.write(line, (error) => settle(error ?? undefined));
			} catch {
				settle(new WriteRefused());
			}
		});
	}

	#release(): void {
		while (this.#outstanding < MAX_STDIN_FRAMES && this.#waiters.length > 0 && !this.ending)
			this.#waiters.shift()?.go();
	}

	#mark(reason: EndReason): void {
		this.#reason ??= reason;
		this.#ending = true;
	}

	#terminate(): void {
		if (this.#killSent || this.#exited) return;
		this.#killSent = true;
		try {
			// SIGKILL on POSIX, TerminateProcess on Windows; only this child, never a group.
			this.#child.kill("SIGKILL");
		} catch {
			/* Confirmation below decides; a failed signal is reported as unconfirmed. */
		}
		schedule(this.#clock, KILL_CONFIRM_MS, this.#lifetime.signal, () => {
			if (!this.#exited) this.#hooks.killUnconfirmed();
		});
	}

	#data(chunk: Buffer): void {
		if (this.#decoder.stopped) return;
		const violation = this.#decoder.push(
			chunk,
			(frame) => !this.#ending && this.#hooks.frame(frame) && !this.#ending,
		);
		if (violation !== undefined && !this.#ending) this.violate(violation);
	}

	#stderr(chunk: Buffer): void {
		this.#stderrBytes += chunk.length;
		if (this.#stderrBytes > STDERR_LIMIT_BYTES) this.kill("stderr-limit");
	}

	/** Delivers what the exit drain left buffered, so a reply written just before exit still counts. */
	#flush(): void {
		const output = this.#io.outputs[0];
		if (output.destroyed) return;
		// read() would also emit each chunk to the 'data' listener: detached, it is decoded once.
		output.off("data", this.#onStdout);
		for (let chunk = output.read() as Buffer | null; chunk !== null; chunk = output.read())
			this.#data(chunk);
	}

	async #watch(
		exited: Promise<undefined>,
		completion: Promise<PluginStdioResult>,
	): Promise<ProcessEnd> {
		let cleanupFailed = false;
		let result: PluginStdioResult | undefined;
		const first = await Promise.race([exited, completion]);
		// A child that ended before the exit listener existed never emits it again.
		if (this.#child.exitCode !== null || this.#child.signalCode !== null) this.#exited = true;
		if (first !== undefined && !this.#exited) {
			result = first;
			if (first.error === "spawn" || this.pid === undefined) this.#mark(crashed("spawn"));
			else {
				// The streams failed under a running child: it ends here.
				this.kill("exit");
				await exited;
			}
		} else if (await within(this.#clock, COMPLETION_MS, completion)) {
			result = await completion;
		} else cleanupFailed = true;
		this.#flush();
		if (
			result?.error === "streams" &&
			result.drains.some(({ result: drain }) => drain === "EAGAIN" || drain === "limit")
		)
			this.#hooks.heldWriter();
		const tail = this.#decoder.finish();
		if (tail !== undefined) this.#mark(crashed(`violation:${tail}`));
		if (!(await within(this.#clock, COMPLETION_MS, this.#io.destroy()))) cleanupFailed = true;
		if (!(await within(this.#clock, COMPLETION_MS, this.#stdio.destroy()))) cleanupFailed = true;
		this.#ending = true;
		for (const settle of [...this.#pendingWrites]) settle(new WriteRefused());
		for (const waiter of this.#waiters.splice(0)) waiter.fail();
		this.#lifetime.abort();
		if (cleanupFailed) this.#hooks.cleanupFailed();
		const reason = this.#reason ?? crashed("exit");
		return Object.freeze({ ...reason, cleanupFailed }) as ProcessEnd;
	}
}

function crashed(reason: CrashReason): EndReason {
	return { outcome: "crashed", reason };
}
