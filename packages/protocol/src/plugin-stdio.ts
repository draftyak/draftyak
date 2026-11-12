import type { ChildProcess } from "node:child_process";
import { Readable, type Writable } from "node:stream";
import { type FifoDrain, type FifoStdio, openFifoStdio } from "./plugin-stdio/fifo.ts";
import { DRAIN_LIMIT, PIPE_DRAIN_MS } from "./plugin-stdio/limits.ts";

export {
	DRAIN_LIMIT as PLUGIN_STDIO_DRAIN_LIMIT,
	PIPE_DRAIN_MS as PLUGIN_STDIO_PIPE_DRAIN_MS,
} from "./plugin-stdio/limits.ts";

export interface PluginStdioResult {
	readonly code: number | null;
	readonly signal: NodeJS.Signals | null;
	/** A fixed failure label, never an executable, argument, path or child output. */
	readonly error: "spawn" | "destroyed" | "streams" | null;
	/** `closed` means consumer cancellation; every outcome except EOF sets error=streams. */
	readonly drains: readonly [FifoDrain, FifoDrain];
}

export interface PluginProcessIo {
	readonly input: Writable;
	readonly outputs: readonly [Readable, Readable];
	/** Child exit, then bounded drain and closure of parent-owned descriptors. Never waits for EOF. */
	readonly completion: Promise<PluginStdioResult>;
	/** Idempotent. The caller owns terminating and reaping its child process. */
	destroy(): Promise<void>;
}

export interface PluginStdio {
	readonly kind: "fifo" | "pipe";
	/** Exactly fd 0, 1 and 2; never an IPC descriptor. Pass a copy to spawn. */
	readonly stdio: readonly [number, number, number] | readonly ["pipe", "pipe", "pipe"];
	/** Call synchronously after spawn returns, including when it will emit a spawn error. */
	attach(child: ChildProcess): PluginProcessIo;
	destroy(): Promise<void>;
}

interface OutputPipe {
	readonly output: Readable;
	readonly closed: Promise<void>;
	drain(): Promise<FifoDrain>;
	finish(): void;
}

function pipeOutput(raw: Readable): OutputPipe {
	let ending = false;
	let afterExit = false;
	let bytes = 0;
	let result: string | null = null;
	let resolveDrain: ((value: FifoDrain) => void) | undefined;
	let timer: NodeJS.Timeout | undefined;
	const closed = raw.closed
		? Promise.resolve()
		: new Promise<void>((resolve) => raw.once("close", () => resolve()));
	const output = new Readable({
		highWaterMark: 64 << 10,
		read() {
			raw.resume();
		},
		destroy(error, callback) {
			if (!output.readableEnded || error) result = "closed";
			raw.destroy();
			callback(error);
		},
	});
	const end = (status: string): void => {
		result ??= status;
		if (!ending) {
			ending = true;
			output.push(null);
		}
		if (timer) clearTimeout(timer);
		raw.destroy();
		resolveDrain?.({ bytes, result });
	};
	raw.on("data", (chunk: Buffer) => {
		if (ending || output.destroyed) return;
		if (afterExit) {
			const remaining = DRAIN_LIMIT - bytes;
			const kept = chunk.subarray(0, remaining);
			bytes += kept.length;
			if (kept.length) output.push(Buffer.from(kept));
			if (bytes >= DRAIN_LIMIT) end("limit");
		} else if (!output.push(chunk)) raw.pause();
	});
	raw.once("end", () => end("eof"));
	raw.once("error", () => end("read-error"));
	raw.once("close", () => {
		if (!ending) end(output.destroyed ? "closed" : "read-error");
	});
	return {
		output,
		closed,
		drain() {
			if (ending || output.destroyed)
				return Promise.resolve({ bytes: 0, result: result ?? "closed" });
			afterExit = true;
			return new Promise((resolve) => {
				resolveDrain = resolve;
				// A surviving inherited writer must not keep the parent waiting for pipe EOF.
				timer = setTimeout(() => end("deadline"), PIPE_DRAIN_MS);
				raw.resume();
			});
		},
		finish: () => end(result ?? "closed"),
	};
}

/** Parent stdio only. Callers supply their own validated executable, argv, environment and policy. */
export async function openPluginStdio(
	options: { readonly parentDir?: string } = {},
): Promise<PluginStdio> {
	if (!["win32", "linux", "darwin"].includes(process.platform))
		throw new Error("Plugin stdio target unsupported");
	const fifo: FifoStdio | undefined =
		process.platform === "win32" ? undefined : await openFifoStdio(options.parentDir);
	let attached: PluginProcessIo | undefined;
	let disposed = false;
	const disposeUnattached = async (): Promise<void> => {
		disposed = true;
		fifo?.destroy();
		await fifo?.closed;
	};
	return {
		kind: fifo ? "fifo" : "pipe",
		stdio: fifo ? (fifo.pluginFds as [number, number, number]) : ["pipe", "pipe", "pipe"],
		attach(child) {
			if (attached || disposed) throw new Error("Plugin stdio is already attached or destroyed");
			const input = fifo?.input ?? child.stdin;
			const raws = fifo ? undefined : [child.stdout, child.stderr];
			if (!input || raws?.some((stream) => !stream)) {
				for (const stream of [child.stdin, child.stdout, child.stderr]) stream?.destroy();
				void disposeUnattached();
				throw new Error("Plugin stdio requires three byte streams");
			}
			const pipes = raws?.map((raw) => pipeOutput(raw as Readable));
			const outputs = (fifo?.outputs ?? pipes?.map((pipe) => pipe.output)) as [Readable, Readable];
			const inputClosed = input.closed
				? Promise.resolve()
				: new Promise<void>((resolve) => input.once("close", () => resolve()));
			let settled = false;
			const { promise: completion, resolve: resolveCompletion } =
				Promise.withResolvers<PluginStdioResult>();
			const finish = async (
				code: number | null,
				signal: NodeJS.Signals | null,
				error: PluginStdioResult["error"],
			): Promise<void> => {
				if (settled) return;
				settled = true;
				disposed = true;
				child.removeListener("exit", onExit);
				const drains = fifo
					? fifo.drain()
					: await Promise.all((pipes as OutputPipe[]).map((pipe) => pipe.drain()));
				fifo?.finish();
				for (const pipe of pipes ?? []) pipe.finish();
				input.destroy();
				await (fifo?.closed ?? Promise.all((pipes as OutputPipe[]).map((pipe) => pipe.closed)));
				await inputClosed;
				const finalDrains = drains.map((entry, index) =>
					entry.result === "eof" && outputs[index]?.destroyed && !outputs[index]?.readableEnded
						? { ...entry, result: "closed" }
						: entry,
				);
				resolveCompletion({
					code,
					signal,
					error: error ?? (finalDrains.some(({ result }) => result !== "eof") ? "streams" : null),
					drains: finalDrains as [FifoDrain, FifoDrain],
				});
			};
			const onExit = (code: number | null, signal: NodeJS.Signals | null): void => {
				void finish(code, signal, null);
			};
			// Retain the once-error listener during early disposal: spawn errors arrive asynchronously.
			child.once("error", () => {
				void finish(null, null, "spawn");
			});
			child.once("exit", onExit);
			input.on("error", () => {
				void finish(null, null, "streams");
			});
			fifo?.releasePluginEnds();
			attached = {
				input,
				outputs,
				completion,
				async destroy() {
					void finish(child.exitCode, child.signalCode, "destroyed");
					await completion;
					for (const output of outputs) output.destroy();
				},
			};
			if (child.exitCode !== null || child.signalCode !== null)
				void finish(child.exitCode, child.signalCode, null);
			return attached;
		},
		async destroy() {
			if (attached) await attached.destroy();
			else await disposeUnattached();
		},
	};
}
