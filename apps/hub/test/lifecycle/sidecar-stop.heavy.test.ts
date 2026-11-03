import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const FIXTURE = fileURLToPath(new URL("./fixtures/sidecar-stop-child.ts", import.meta.url));
const MARKERS = new Set(["READY", "CLOSED", "CLOSE-PENDING"]);
const OUTPUT_LIMIT = 1_024;

function frame(payload: string): Buffer {
	const body = Buffer.from(payload, "utf8");
	const header = Buffer.alloc(4);
	header.writeUInt32BE(body.length);
	try {
		return Buffer.concat([header, body]);
	} finally {
		header.fill(0);
		body.fill(0);
	}
}

function initialFrame(): Buffer {
	const key = randomBytes(32);
	const bootstrap = randomBytes(16);
	try {
		return frame(
			JSON.stringify({
				masterKey: key.toString("hex"),
				bootstrapSecret: bootstrap.toString("hex"),
			}),
		);
	} finally {
		key.fill(0);
		bootstrap.fill(0);
	}
}

interface Exit {
	readonly code: number | null;
	readonly signal: NodeJS.Signals | null;
	readonly spawnFailed: boolean;
	readonly forced: boolean;
	readonly killFailed: boolean;
	readonly stderrBytes: number;
	readonly invalidOutput: boolean;
	readonly markers: readonly string[];
}

function launch(mode: "normal" | "hang-close") {
	const env: NodeJS.ProcessEnv = {};
	for (const name of ["SystemRoot", "WINDIR", "TEMP", "TMP"])
		if (process.env[name] !== undefined) env[name] = process.env[name];
	const child = spawn(
		process.execPath,
		["--disable-sigusr1", "--unhandled-rejections=strict", FIXTURE, mode],
		{ env, stdio: ["pipe", "pipe", "pipe"], windowsHide: true, shell: false },
	);
	let closed = false;
	let spawnFailed = false;
	let forced = false;
	let killFailed = false;
	let stderrBytes = 0;
	let outputBytes = 0;
	let invalidOutput = false;
	let partial = "";
	const markers: string[] = [];
	const watchers = new Set<() => void>();
	const exited = Promise.withResolvers<Exit>();
	const notify = (): void => {
		for (const watcher of [...watchers]) watcher();
	};
	const kill = (): void => {
		if (closed || child.killed || child.exitCode !== null || child.signalCode !== null) return;
		forced = true;
		try {
			if (!child.kill("SIGKILL") && child.pid !== undefined) killFailed = true;
		} catch {
			killFailed = true;
		}
	};
	const bounded = <T>(promise: Promise<T>, ms: number): Promise<T> =>
		new Promise((resolve, reject) => {
			const timer = setTimeout(() => {
				kill();
				reject(new Error("DYTEST-SIDECAR-CHILD-DEADLINE"));
			}, ms);
			promise.then(
				(value) => {
					clearTimeout(timer);
					resolve(value);
				},
				() => {
					clearTimeout(timer);
					reject(new Error("DYTEST-SIDECAR-CHILD-WAIT"));
				},
			);
		});
	const count = (bytes: number): boolean => {
		outputBytes += bytes;
		if (outputBytes <= OUTPUT_LIMIT) return true;
		invalidOutput = true;
		kill();
		return false;
	};
	child.once("error", () => {
		spawnFailed = true;
	});
	child.stdin.on("error", () => {});
	child.stdout.on("data", (chunk: Buffer) => {
		if (!count(chunk.length)) return;
		const lines = (partial + chunk.toString("latin1")).split("\n");
		partial = lines.pop() ?? "";
		for (const line of lines) {
			if (MARKERS.has(line)) markers.push(line);
			else {
				invalidOutput = true;
				kill();
			}
		}
		notify();
	});
	child.stderr.on("data", (chunk: Buffer) => {
		stderrBytes += chunk.length;
		count(chunk.length);
	});
	const watchdog = setTimeout(kill, 30_000);
	child.once("close", (code, signal) => {
		clearTimeout(watchdog);
		closed = true;
		invalidOutput ||= partial.length !== 0;
		notify();
		exited.resolve({
			code,
			signal,
			spawnFailed,
			forced,
			killFailed,
			stderrBytes,
			invalidOutput,
			markers: [...markers],
		});
	});
	return {
		write: (bytes: Buffer): Promise<void> =>
			new Promise((resolve, reject) => {
				child.stdin.write(bytes, (error) => {
					bytes.fill(0);
					if (error) reject(new Error("DYTEST-SIDECAR-CHILD-INPUT"));
					else resolve();
				});
			}),
		end: (): void => {
			child.stdin.end();
		},
		seen: (marker: "READY" | "CLOSE-PENDING"): Promise<void> =>
			bounded(
				new Promise<void>((resolve, reject) => {
					const check = (): void => {
						if (markers.includes(marker)) {
							watchers.delete(check);
							resolve();
						} else if (closed) {
							watchers.delete(check);
							reject(new Error("DYTEST-SIDECAR-CHILD-NOT-READY"));
						}
					};
					watchers.add(check);
					check();
				}),
				10_000,
			),
		exit: (): Promise<Exit> => bounded(exited.promise, 20_000),
		cleanup: async (): Promise<void> => {
			kill();
			const result = await bounded(exited.promise, 5_000);
			if (!closed || result.killFailed) throw new Error("DYTEST-SIDECAR-CHILD-NOT-REAPED");
		},
	};
}

function expectExit(result: Exit, code: 0 | 1, markers: readonly string[]): void {
	expect(result).toEqual({
		code,
		signal: null,
		spawnFailed: false,
		forced: false,
		killFailed: false,
		stderrBytes: 0,
		invalidOutput: false,
		markers,
	});
}

async function ready(child: ReturnType<typeof launch>): Promise<void> {
	const initial = initialFrame();
	try {
		await child.write(initial);
		await child.seen("READY");
	} finally {
		initial.fill(0);
	}
}

describe("compiled public sidecar shutdown over real stdin", () => {
	it.each(["eof", "shutdown", "fault"] as const)(
		"requests the default process exit for %s after owned cleanup",
		{ timeout: 40_000 },
		async (reason) => {
			const child = launch("normal");
			try {
				await ready(child);
				if (reason === "eof") child.end();
				else await child.write(frame(reason === "shutdown" ? '{"shutdown":true}' : '{"bad":true}'));
				expectExit(await child.exit(), reason === "fault" ? 1 : 0, ["READY", "CLOSED"]);
			} finally {
				await child.cleanup();
			}
		},
	);

	it("forces exit 1 after the real ten-second grace when asynchronous close never settles", {
		timeout: 40_000,
	}, async () => {
		const child = launch("hang-close");
		try {
			await ready(child);
			const started = performance.now();
			await child.write(frame('{"shutdown":true}'));
			const [, result] = await Promise.all([child.seen("CLOSE-PENDING"), child.exit()]);
			const elapsed = performance.now() - started;
			expectExit(result, 1, ["READY", "CLOSE-PENDING"]);
			expect(elapsed).toBeGreaterThanOrEqual(9_500);
			expect(elapsed).toBeLessThan(20_000);
		} finally {
			await child.cleanup();
		}
	});
});
