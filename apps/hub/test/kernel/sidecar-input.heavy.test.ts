import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { describe, expect, it } from "vitest";
import { MasterKey } from "../../src/kernel/master-key.ts";

const FIXTURE = path.join(import.meta.dirname, "fixtures", "sidecar-input-child.ts");
const RESUME = '{"power":"resumed"}';
const SHUTDOWN = '{"shutdown":true}';
const MIB = 1_048_576;
const OUTPUT_LIMIT = 16_384;

const lengthHeader = (length: number): Buffer =>
	Buffer.from([length >>> 24, (length >>> 16) & 0xff, (length >>> 8) & 0xff, length & 0xff]);

function frame(payload: string): Buffer {
	const body = Buffer.from(payload, "latin1");
	return Buffer.concat([lengthHeader(body.length), body]);
}

// A synthetic key with a bootstrap secret derived from it, so the child can check the exact
// transfer without any secret on its argv, environment or output.
function initialPayload(upperCase = false): string {
	const key = randomBytes(32);
	const masterKey = new MasterKey(key);
	const check = masterKey.derive("ext/sidecar-check");
	masterKey.destroy();
	const mk = key.toString("hex");
	const payload = `{"bootstrapSecret":"${check.subarray(0, 16).toString("hex")}","masterKey":"${upperCase ? mk.toUpperCase() : mk}"}`;
	key.fill(0);
	check.fill(0);
	return payload;
}

interface Exit {
	readonly code: number | null;
	readonly signal: NodeJS.Signals | null;
	readonly reason: string | undefined;
	readonly spawnFailed: boolean;
	readonly stderrBytes: number;
	readonly lines: readonly string[];
}

interface Child {
	write(bytes: Buffer): void;
	end(): void;
	seen(line: string, count?: number): Promise<void>;
	stop(): Promise<Exit>;
	readonly exit: Promise<Exit>;
}

function launch(mode: "receive" | "cancel" | "dispose" | "import"): Child {
	const env: NodeJS.ProcessEnv = {};
	for (const name of ["SystemRoot", "WINDIR", "TEMP", "TMP"])
		if (process.env[name] !== undefined) env[name] = process.env[name];
	const child = spawn(
		process.execPath,
		["--disable-sigusr1", "--unhandled-rejections=strict", FIXTURE, mode],
		{ env, stdio: ["pipe", "pipe", "pipe"], windowsHide: true, shell: false },
	);
	let reason: string | undefined;
	let spawnFailed = false;
	let closed = false;
	let outputBytes = 0;
	let stderrBytes = 0;
	let partial = "";
	const lines: string[] = [];
	const watchers = new Set<() => void>();
	const notify = (): void => {
		for (const watcher of [...watchers]) watcher();
	};
	const kill = (why: string): void => {
		reason ??= why;
		if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
	};
	const counted = (chunk: Buffer): boolean => {
		outputBytes += chunk.length;
		if (outputBytes <= OUTPUT_LIMIT) return true;
		kill("output-bound");
		return false;
	};
	child.once("error", () => {
		spawnFailed = true;
	});
	// The receiver destroys its end of the pipe, so later writes may fail with EPIPE.
	child.stdin.on("error", () => {});
	child.stdout.on("data", (chunk: Buffer) => {
		if (!counted(chunk)) return;
		const parts = (partial + chunk.toString("latin1")).split("\n");
		partial = parts.pop() ?? "";
		lines.push(...parts);
		notify();
	});
	child.stderr.on("data", (chunk: Buffer) => {
		stderrBytes += chunk.length;
		counted(chunk);
	});
	const deadline = setTimeout(() => kill("deadline"), 30_000);
	const exit = new Promise<Exit>((resolve) => {
		child.once("close", (code, signal) => {
			clearTimeout(deadline);
			closed = true;
			notify();
			resolve({ code, signal, reason, spawnFailed, stderrBytes, lines: [...lines] });
		});
	});
	return {
		write: (bytes) => {
			child.stdin.write(bytes);
		},
		end: () => {
			child.stdin.end();
		},
		seen: (line, count = 1) =>
			new Promise<void>((resolve, reject) => {
				const check = (): void => {
					if (lines.filter((seen) => seen === line).length >= count) {
						watchers.delete(check);
						resolve();
					} else if (closed) {
						watchers.delete(check);
						reject(new Error(`Child closed before line ${count} of ${line}`));
					}
				};
				watchers.add(check);
				check();
			}),
		stop: async () => {
			kill("parent-cleanup");
			return exit;
		},
		exit,
	};
}

interface Report {
	readonly mode: string;
	readonly ready: boolean;
	readonly refused: string;
	readonly exact: boolean;
	readonly resumes: number;
	readonly stop: string;
	readonly code: string;
	readonly closed: boolean;
	readonly closedCode: string;
	readonly inputDestroyed: boolean;
}

// The child exits on its own with code 0 and an empty stderr, so the receiver left no input handle.
function report(exit: Exit, markers: readonly string[]): Report {
	expect({
		code: exit.code,
		signal: exit.signal,
		reason: exit.reason,
		spawnFailed: exit.spawnFailed,
		stderrBytes: exit.stderrBytes,
	}).toEqual({ code: 0, signal: null, reason: undefined, spawnFailed: false, stderrBytes: 0 });
	expect(exit.lines.slice(0, -1)).toEqual(markers);
	return JSON.parse(exit.lines.at(-1) ?? "null") as Report;
}

const settled = {
	refused: "",
	exact: true,
	code: "",
	closed: true,
	closedCode: "",
	inputDestroyed: true,
};

function refusedWith(code: string): Partial<Report> {
	return {
		ready: false,
		refused: code,
		exact: false,
		resumes: 0,
		stop: "fault",
		code,
		closed: true,
		closedCode: "",
		inputDestroyed: true,
	};
}

describe("sidecar stdin receiver over real pipes", () => {
	it("is ready on the final initial byte, delivers resumes and stops at shutdown", async () => {
		const child = launch("receive");
		try {
			const initial = frame(initialPayload());
			child.write(initial.subarray(0, 2));
			await sleep(50);
			child.write(initial.subarray(2));
			await child.seen("ready");
			child.write(frame(RESUME));
			await child.seen("resumed", 1);
			child.write(frame(RESUME));
			await child.seen("resumed", 2);
			child.write(
				Buffer.concat([
					frame(RESUME),
					frame(RESUME),
					frame(RESUME),
					frame(SHUTDOWN),
					frame(RESUME),
				]),
			);
			const exit = await child.exit;
			const resumes = exit.lines.filter((line) => line === "resumed").length;
			const result = report(exit, ["ready", ...Array<string>(resumes).fill("resumed")]);
			expect(result).toEqual({
				...settled,
				mode: "receive",
				ready: true,
				resumes,
				stop: "shutdown",
			});
			expect(resumes).toBeGreaterThanOrEqual(3);
			expect(resumes).toBeLessThanOrEqual(5);
		} finally {
			await child.stop();
		}
	});

	it("accepts an exact 1 MiB initial frame split by the pipe", async () => {
		const child = launch("receive");
		try {
			const payload = initialPayload();
			child.write(frame(payload + " ".repeat(MIB - payload.length)));
			await child.seen("ready");
			child.write(frame(SHUTDOWN));
			const result = report(await child.exit, ["ready"]);
			expect(result).toEqual({
				...settled,
				mode: "receive",
				ready: true,
				resumes: 0,
				stop: "shutdown",
			});
		} finally {
			await child.stop();
		}
	});

	it("stops cleanly on EOF at a frame boundary after the initial frame", async () => {
		const child = launch("receive");
		try {
			child.write(frame(initialPayload()));
			await child.seen("ready");
			child.end();
			const result = report(await child.exit, ["ready"]);
			expect(result).toEqual({ ...settled, mode: "receive", ready: true, resumes: 0, stop: "eof" });
		} finally {
			await child.stop();
		}
	});

	it.each([
		["cancel", "cancelled"],
		["dispose", "disposed"],
	] as const)("releases the open pipe on %s", async (mode, reason) => {
		const child = launch(mode);
		try {
			child.write(frame(initialPayload()));
			await child.seen("ready");
			const result = report(await child.exit, ["ready"]);
			expect(result).toEqual({ ...settled, mode, ready: true, resumes: 0, stop: reason });
		} finally {
			child.end();
			await child.stop();
		}
	});

	it.each([
		["EOF before any byte", [] as Buffer[], true, "SIDECAR_INPUT_TRUNCATED"],
		[
			"EOF inside the initial frame",
			[frame(initialPayload()).subarray(0, 60)],
			true,
			"SIDECAR_INPUT_TRUNCATED",
		],
		["an upper-case key", [frame(initialPayload(true))], false, "SIDECAR_INPUT_FORMAT"],
		["an oversized header", [lengthHeader(MIB + 1)], false, "SIDECAR_INPUT_BOUNDS"],
		["a control before the initial frame", [frame(RESUME)], false, "SIDECAR_INPUT_ORDER"],
	] as const)("refuses %s and releases the pipe", async (_label, chunks, end, code) => {
		const child = launch("receive");
		try {
			for (const chunk of chunks) child.write(chunk);
			if (end) child.end();
			const result = report(await child.exit, []);
			expect(result).toEqual({ ...refusedWith(code), mode: "receive" });
		} finally {
			child.end();
			await child.stop();
		}
	});

	it("does not touch stdin when the receiver module is imported", async () => {
		const child = launch("import");
		try {
			const exit = await child.exit;
			report(exit, []);
			expect(JSON.parse(exit.lines.at(-1) ?? "null")).toEqual({
				mode: "import",
				stdinTouched: false,
			});
		} finally {
			child.end();
			await child.stop();
		}
	});
});
