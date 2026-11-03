import { spawn } from "node:child_process";
import { statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

type SignalEvent = "SIGINT" | "SIGTERM";
interface Exit {
	readonly code: number | null;
	readonly signal: NodeJS.Signals | null;
}
export interface MainProcess {
	signal(event: SignalEvent): Promise<number>;
	waitForExit(timeoutMs: number): Promise<Exit>;
	endInput(): void;
	readonly inputEnded: boolean;
	stdinOpen(): boolean;
	readonly errors: readonly string[];
	close(): Promise<void>;
}

const root = fileURLToPath(new URL("../../", import.meta.url));
const entry = path.join(root, "dist/runtime/main.mjs");
const maximumBytes = 1_048_576;
let building: Promise<string> | undefined;

/** Run the actual installed build CLI with the package's default production config once. */
export function buildSlackMain(): Promise<string> {
	building ??= new Promise<void>((resolve, reject) => {
		const cli = path.join(root, "node_modules/tsdown/dist/run.mjs");
		const child = spawn(process.execPath, [cli], {
			cwd: root,
			stdio: ["ignore", "pipe", "pipe"],
			windowsHide: true,
			shell: false,
		});
		let bytes = 0;
		let failure = false;
		const timeout = setTimeout(() => {
			failure = true;
			child.kill("SIGKILL");
		}, 45_000);
		for (const stream of [child.stdout, child.stderr])
			stream.on("data", (chunk: Buffer) => {
				bytes += chunk.length;
				if (bytes > maximumBytes) {
					failure = true;
					child.kill("SIGKILL");
				}
			});
		child.once("error", () => {
			failure = true;
		});
		child.once("close", (code, signal) => {
			clearTimeout(timeout);
			if (failure || code !== 0 || signal !== null) reject(new Error("SLACK_MAIN_BUILD_FAILED"));
			else resolve();
		});
	}).then(() => {
		if (!statSync(entry).isFile()) throw new Error("SLACK_MAIN_BUILD_MISSING");
		return entry;
	});
	return building;
}

// The bridge neither adds signal handlers nor changes the imported entry. Its IPC channel
// cannot keep the child alive; a signal event is emitted only after that channel disconnects.
const bridge = `
import { pathToFileURL } from 'node:url';
process.once('message', (message) => {
  const event = message?.event;
  if (event !== 'SIGINT' && event !== 'SIGTERM') throw new Error('SLACK_MAIN_BRIDGE_INVALID');
  const count = process.listenerCount(event);
  process.send({ event, count });
  process.once('disconnect', () => { process.emit(event); });
  process.disconnect();
});
process.channel.unref();
await import(pathToFileURL(process.argv[1]).href);
`;

function within<T>(promise: Promise<T>, timeoutMs: number, code: string): Promise<T> {
	return new Promise((resolve, reject) => {
		const timeout = setTimeout(() => reject(new Error(code)), timeoutMs);
		promise.then(
			(value) => {
				clearTimeout(timeout);
				resolve(value);
			},
			(error) => {
				clearTimeout(timeout);
				reject(error);
			},
		);
	});
}

/** Plain Node-event coverage: not an OS signal, production permission or FIFO proof. */
export async function startMain(
	builtEntry: string,
	options: { signalBridge?: boolean } = {},
): Promise<MainProcess> {
	if (path.resolve(builtEntry) !== path.resolve(entry)) throw new Error("SLACK_MAIN_ENTRY_INVALID");
	const child =
		options.signalBridge === false
			? spawn(process.execPath, [builtEntry], {
					cwd: root,
					stdio: ["pipe", "pipe", "pipe"],
					windowsHide: true,
					shell: false,
				})
			: spawn(process.execPath, ["--input-type=module", "--eval", bridge, builtEntry], {
					cwd: root,
					stdio: ["pipe", "pipe", "pipe", "ipc"],
					windowsHide: true,
					shell: false,
				});
	const { stdin, stdout, stderr: errorOutput } = child;
	if (!stdin || !stdout || !errorOutput) throw new Error("SLACK_MAIN_PIPES_MISSING");
	const errors: string[] = [];
	let inputEnded = false;
	let exit: Exit | undefined;
	let bytes = 0;
	let pending = "";
	let readyResolve: () => void = () => undefined;
	let readyReject: (error: Error) => void = () => undefined;
	const ready = new Promise<void>((resolve, reject) => {
		readyResolve = resolve;
		readyReject = reject;
	});
	const exited = new Promise<Exit>((resolve) =>
		child.once("close", (code, signal) => {
			exit = Object.freeze({ code, signal });
			readyReject(new Error("SLACK_MAIN_EXIT_BEFORE_READY"));
			resolve(exit);
		}),
	);
	function fault(code: string): void {
		errors.push(code);
		readyReject(new Error(code));
	}
	const output = (chunk: Buffer): void => {
		bytes += chunk.length;
		if (bytes > maximumBytes) {
			fault("SLACK_MAIN_OUTPUT_LIMIT");
			child.kill("SIGKILL");
			return;
		}
		pending += chunk.toString("utf8");
		for (;;) {
			const at = pending.indexOf("\n");
			if (at < 0) break;
			const line = pending.slice(0, at);
			pending = pending.slice(at + 1);
			try {
				if (line.charCodeAt(0) === 0x1e) throw new Error("host request");
				const response = JSON.parse(line);
				const value = response.result?.structuredContent;
				if (
					response.jsonrpc !== "2.0" ||
					response.id !== 1 ||
					response.error ||
					response.result?.isError ||
					value?.channel !== "chat" ||
					value.listen !== true ||
					value.attachments !== false ||
					!Array.isArray(value.mutations) ||
					value.mutations.length !== 0
				)
					throw new Error("description");
				readyResolve();
			} catch {
				fault("SLACK_MAIN_REPLY_INVALID");
			}
		}
	};
	const stderr = (chunk: Buffer): void => {
		bytes += chunk.length;
		fault("SLACK_MAIN_STDERR");
		if (bytes > maximumBytes) child.kill("SIGKILL");
	};
	const childError = (): void => fault("SLACK_MAIN_CHILD_ERROR");
	const inputError = (): void => fault("SLACK_MAIN_INPUT_ERROR");
	stdout.on("data", output);
	errorOutput.on("data", stderr);
	child.on("error", childError);
	stdin.on("error", inputError);
	const result: MainProcess = Object.freeze({
		async signal(event: SignalEvent): Promise<number> {
			if (!child.connected || exit || inputEnded) throw new Error("SLACK_MAIN_SIGNAL_UNAVAILABLE");
			const count = new Promise<number>((resolve, reject) => {
				child.once("message", (raw: unknown) => {
					const message = raw as { event?: unknown; count?: unknown };
					if (
						message?.event !== event ||
						!Number.isInteger(message.count) ||
						(message.count as number) < 1
					)
						reject(new Error("SLACK_MAIN_HANDLER_MISSING"));
					else resolve(message.count as number);
				});
			});
			const disconnected = new Promise<void>((resolve) => child.once("disconnect", resolve));
			child.send({ event }, (error) => {
				if (error) fault("SLACK_MAIN_SIGNAL_FAILED");
			});
			const received = await within(
				Promise.all([count, disconnected]),
				2_000,
				"SLACK_MAIN_SIGNAL_TIMEOUT",
			);
			return received[0];
		},
		waitForExit(timeoutMs: number): Promise<Exit> {
			// Timeout is an observation only. The assertion runs before close() may EOF or kill.
			return within(exited, timeoutMs, "SLACK_MAIN_EXIT_TIMEOUT");
		},
		endInput(): void {
			if (inputEnded) return;
			inputEnded = true;
			if (child.connected) child.disconnect();
			stdin.end();
		},
		get inputEnded(): boolean {
			return inputEnded;
		},
		stdinOpen(): boolean {
			return !inputEnded && !stdin.destroyed && stdin.writable;
		},
		get errors(): readonly string[] {
			return Object.freeze([...errors]);
		},
		async close(): Promise<void> {
			if (!exit) {
				result.endInput();
				try {
					await within(exited, 1_000, "SLACK_MAIN_CLEANUP_TIMEOUT");
				} catch {
					child.kill("SIGKILL");
					await within(exited, 2_000, "SLACK_MAIN_KILL_TIMEOUT");
				}
			}
			stdout.off("data", output);
			errorOutput.off("data", stderr);
			child.off("error", childError);
			stdin.off("error", inputError);
		},
	});
	stdin.write(
		`${JSON.stringify({
			jsonrpc: "2.0",
			id: 1,
			method: "tools/call",
			params: {
				name: "channel_describe",
				arguments: {},
				_meta: {
					"io.modelcontextprotocol/protocolVersion": "2026-07-28",
					"io.modelcontextprotocol/clientCapabilities": {},
				},
			},
		})}\n`,
	);
	try {
		await within(ready, 5_000, "SLACK_MAIN_READY_TIMEOUT");
	} catch (error) {
		await result.close();
		throw error;
	}
	return result;
}
