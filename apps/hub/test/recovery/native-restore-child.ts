import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { expect } from "vitest";
import { nativeBinding } from "../lifecycle/session-helpers.ts";

export interface NativeRestoreChildInput {
	readonly script: string;
	readonly artifactFile: string;
	readonly destination: string;
	readonly root: string;
	readonly recoveryCode: Uint8Array;
	readonly expectedKind: string;
	readonly expectedKeys: string;
	readonly pending: Promise<unknown>[];
}

export async function runNativeRestoreChild({
	script,
	artifactFile,
	destination,
	root,
	recoveryCode,
	expectedKind,
	expectedKeys,
	pending,
}: NativeRestoreChildInput): Promise<Record<string, unknown>> {
	const callerCode = Buffer.from(recoveryCode);
	try {
		const child = spawn(process.execPath, ["--disable-sigusr1", script], {
			cwd: fileURLToPath(new URL("../..", import.meta.url)),
			env: {
				SystemRoot: process.env.SystemRoot,
				WINDIR: process.env.WINDIR,
				TEMP: root,
				TMP: root,
				NO_COLOR: "1",
			},
			stdio: ["ignore", "pipe", "pipe", "ipc"],
			serialization: "advanced",
			shell: false,
			windowsHide: true,
		});
		let didClose = false,
			failed = false,
			timedOut = false,
			sent = false;
		let outputBytes = 0,
			messages = 0;
		let report: Record<string, unknown> | undefined;
		const closed = new Promise<readonly [number | null, NodeJS.Signals | null]>((resolve) => {
			child.once("close", (exitCode, signal) => {
				didClose = true;
				resolve([exitCode, signal]);
			});
		});
		pending.push(closed);
		const stop = () => {
			if (!didClose)
				try {
					child.kill("SIGKILL");
				} catch {
					failed = true;
				}
		};
		const failAndStop = () => {
			failed = true;
			stop();
		};
		let timer: ReturnType<typeof setTimeout> | undefined;
		try {
			const forward = (chunk: Buffer, destination: NodeJS.WriteStream) => {
				outputBytes += chunk.byteLength;
				if (outputBytes > 65_536) return failAndStop();
				try {
					destination.write(chunk);
				} catch {
					failAndStop();
				}
			};
			child.stdout?.on("data", (chunk: Buffer) => forward(chunk, process.stdout));
			child.stderr?.on("data", (chunk: Buffer) => forward(chunk, process.stderr));
			child.stdout?.on("error", failAndStop);
			child.stderr?.on("error", failAndStop);
			child.on("error", () => {
				failed = true;
			});
			child.on("message", (message: unknown) => {
				messages++;
				if (messages > 2 || message === null || typeof message !== "object") return failAndStop();
				const record = message as Record<string, unknown>;
				const keys = Object.keys(record).sort().join(",");
				if (messages === 1 && keys === "kind" && record.kind === "ready" && !sent) {
					sent = true;
					try {
						child.send(
							{ artifactFile, destination, nativeBinding, recoveryCode: callerCode },
							(error) => {
								if (error) {
									failAndStop();
								}
							},
						);
					} catch {
						failAndStop();
					}
				} else if (messages === 2 && sent && record.kind === expectedKind && keys === expectedKeys)
					report = record;
				else {
					failAndStop();
				}
			});
			timer = setTimeout(() => {
				timedOut = true;
				stop();
			}, 60_000);
			const [exitCode, signal] = await closed;
			expect(failed || timedOut).toBe(false);
			expect(exitCode === 0 && signal === null && messages === 2 && sent).toBe(true);
			if (!report) throw new Error("DYTEST restore child result missing");
			return report;
		} finally {
			clearTimeout(timer);
			stop();
			await closed;
		}
	} finally {
		callerCode.fill(0);
	}
}
