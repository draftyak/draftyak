import { type ChildProcess, spawn } from "node:child_process";
import { EventEmitter, once } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { PassThrough, type Readable } from "node:stream";
import { describe, expect, it, vi } from "vitest";
import { openFifoStdio } from "../src/fifo-stdio.ts";
import {
	attachTaggedStdio,
	errorLabel,
	type Fallback1RoundTripResult,
	type FifoHeldResult,
	type FifoLane,
	type FifoOutputEnd,
	type FifoResult,
	fallback1RoundTripProblem,
	fifoHeldProblem,
	fifoHeldSummary,
	fifoProblem,
	fifoProblems,
	fifoSummary,
	HOST_FRAME_TAG,
	type StdioRoundTrip,
} from "./fifo.ts";
import { fifoHolders } from "./hub-probes.ts";
import { FETCH_TARGETS, type HubRun } from "./s2b.ts";

const TAG = String.fromCharCode(HOST_FRAME_TAG);
const tick = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

function harness(maxMessageBytes?: number) {
	const kills: string[] = [];
	const child = Object.assign(new EventEmitter(), {
		kill: (signal: string) => kills.push(signal),
	}) as unknown as ChildProcess;
	const input = new PassThrough();
	const output = new PassThrough();
	const sent: string[] = [];
	input.setEncoding("utf8").on("data", (chunk: string) => sent.push(chunk));
	const notes: unknown[] = [];
	const io = attachTaggedStdio(child, input, output, {
		maxMessageBytes,
		onNotification: (method, params) => notes.push({ method, params }),
	});
	return { io, kills, output, sent, notes };
}

describe("Fallback 1's tagged stdio (the hub's side)", () => {
	it("routes tagged lines to the host lane and untagged ones to MCP, in either direction", async () => {
		const { io, kills, output, sent, notes } = harness();
		const reply = io.request("ping");
		output.write(`${TAG}{"jsonrpc":"2.0","method":"report","params":{"n":1}}\n{"jsonrpc":`);
		output.write('"2.0","id":"mcp-1","result":{}}\n');
		expect(await reply).toEqual({ jsonrpc: "2.0", id: "mcp-1", result: {} });
		await tick();
		expect(notes).toEqual([{ method: "report", params: { n: 1 } }]);
		expect(io.host.notify("host/changed", {})).toBe(true);
		await tick();
		expect(sent).toEqual([
			'{"jsonrpc":"2.0","id":"mcp-1","method":"ping","params":{}}\n',
			`${TAG}{"jsonrpc":"2.0","method":"host/changed","params":{}}\n`,
		]);
		expect(io.violations).toEqual([]);
		expect(kills).toEqual([]);
	});

	it("kills the plugin on a NODE_* line, tagged or not, and on any line that isn't JSON-RPC", async () => {
		const cases: [string, string][] = [
			['{"cmd":"NODE_HANDLE","type":"net.Socket","msg":{}}\n', "handle"],
			[`${TAG}{"cmd":"NODE_HANDLE_ACK"}\n`, "internal-message"],
			["##DYS2B##{}\n", "parse-error"],
			[`{"jsonrpc":"2.0"${TAG}}\n`, "parse-error"],
			[`${TAG}[1,2]\n`, "not-jsonrpc"],
			["\n", "parse-error"],
		];
		for (const [line, kind] of cases) {
			const { io, kills, output } = harness();
			output.write(line);
			output.write('{"jsonrpc":"2.0","method":"after"}\n');
			await tick();
			expect(
				io.violations.map((v) => v.kind),
				JSON.stringify(line),
			).toEqual([kind]);
			expect(kills).toEqual(["SIGKILL"]);
		}
	});

	it("bounds an unterminated line on either lane by the message limit", async () => {
		for (const prefix of ["", TAG]) {
			const { io, kills, output } = harness(64);
			output.write(prefix);
			for (let i = 0; i < 4; i++) output.write("x".repeat(30));
			await tick();
			expect(io.violations.map((v) => v.kind)).toEqual(["oversize"]);
			expect(kills).toEqual(["SIGKILL"]);
		}
	});
});

const ENOTSOCK_TEN = Array(10).fill("ENOTSOCK");

const ended = (fifo: FifoLane, endedBy: FifoOutputEnd["endedBy"] = "eof"): FifoOutputEnd => ({
	fifo,
	endedBy,
	error: null,
	afterExitMs: 0,
	holders: null,
	drain: { bytes: 0, result: "closed" },
});

const fifoRun = (overrides: Partial<FifoResult>): HubRun<FifoResult> => ({
	survived: true,
	exitCode: 0,
	signal: null,
	timedOut: false,
	crash: null,
	result: {
		mode: "reinstate-send",
		layout: "stdio",
		beforeSpawn: { ends: 6, unlinkedFifos: 6, folderGone: true },
		violations: [],
		pluginEnded: { code: 0, signal: null, closed: true },
		exitMs: 3100,
		killedAtTimeout: false,
		outputs: [ended("stdout"), ended("stderr")],
		fds: { before: 19, after: 19 },
		bytesRead: { stdout: 0, stderr: 240, fd3: null },
		plugin: [{ reinstated: true, sendStatus: ENOTSOCK_TEN }],
		roundTrip: null,
		...overrides,
	},
});

describe("the FIFO-stdio verdicts", () => {
	it("passes when every handle-bearing write failed with ENOTSOCK and nothing reached the hub", () => {
		expect(fifoProblem("reinstate-send", fifoRun({}))).toBeNull();
		// The stderr variant reports on stdout (host frames), so only its stderr must stay empty.
		const stderr = fifoRun({
			mode: "reinstate-stderr",
			bytesRead: { stdout: 300, stderr: 0, fd3: null },
		});
		expect(fifoProblem("reinstate-stderr", stderr)).toBeNull();
		const fd3 = fifoRun({
			mode: "handle-send",
			layout: "fd3",
			beforeSpawn: { ends: 8, unlinkedFifos: 8, folderGone: true },
			bytesRead: { stdout: 400, stderr: 0, fd3: 0 },
			plugin: [{ attacked: true }, { attempted: 10, sendStatus: ENOTSOCK_TEN }],
		});
		expect(fifoProblem("handle-send", fd3)).toBeNull();
		// macOS, as read from its source: libuv never sees a FIFO's end-of-file, so the exit drain
		// ends each one.
		const drained = fifoRun({
			outputs: ["stdout", "stderr"].map((fifo) => ({
				...ended(fifo as FifoLane, "drain"),
				afterExitMs: 1004,
				drain: { bytes: 0, result: "eof" },
			})),
		});
		expect(fifoProblem("reinstate-send", drained)).toBeNull();
		// node-internal: the hub closes the fd-3 FIFO at the violation.
		const closed = fifoRun({
			mode: "node-internal",
			layout: "fd3",
			violations: [{ kind: "handle", detail: "NODE_HANDLE" }],
			pluginEnded: { code: null, signal: "SIGKILL", closed: true },
			beforeSpawn: { ends: 8, unlinkedFifos: 8, folderGone: true },
			outputs: [ended("stdout"), ended("stderr"), { ...ended("fd3", "hub"), afterExitMs: -2 }],
			bytesRead: { stdout: 300, stderr: 0, fd3: 120 },
			plugin: [{ attacked: true }],
		});
		expect(fifoProblem("node-internal", closed)).toBeNull();
	});

	it("wants each FIFO ended at end-of-file or closed at a violation, with no writer at the drain", () => {
		const failed = fifoRun({
			outputs: [
				{ ...ended("stdout", "error"), error: "EIO", drain: { bytes: 7, result: "EIO" } },
				ended("stderr"),
			],
		});
		expect(fifoProblems("reinstate-send", failed)).toEqual([
			"the stdout FIFO failed with EIO (drain EIO after 7 bytes)",
		]);
		const closed = fifoRun({ outputs: [ended("stdout", "hub"), ended("stderr")] });
		expect(fifoProblems("reinstate-send", closed)).toEqual([
			"the hub closed the stdout FIFO with no violation",
		]);
		// A writer outlived the plugin, and libuv saw the FIFO end only after the drain.
		const late = fifoRun({
			outputs: [
				ended("stdout"),
				{
					...ended("stderr"),
					holders: ["hub fd 16 r", "pid 812 (node) fd 2 w"],
					drain: { bytes: 0, result: "EAGAIN" },
				},
			],
		});
		expect(fifoProblems("reinstate-send", late)).toEqual([
			"a writer still held the stderr FIFO at the drain (drain EAGAIN after 0 bytes; holders: hub fd 16 r, pid 812 (node) fd 2 w)",
		]);
		const full = fifoRun({
			outputs: [
				{ ...ended("stdout"), drain: { bytes: 4 << 20, result: "limit" } },
				ended("stderr"),
			],
		});
		expect(fifoProblems("reinstate-send", full)).toEqual([
			"a writer still held the stdout FIFO at the drain (drain limit after 4194304 bytes)",
		]);
	});

	it("fails on a grown count, a send that went through, a missing report or a lasting FIFO", () => {
		const grown = fifoRun({ fds: { before: 13, after: 14, added: ["fd 13: unix 0x1 ->(none)"] } });
		expect(fifoProblem("reinstate-send", grown)).toBe(
			"the hub's open fds went from 13 to 14 on FIFO stdio (violation none, ended by exit 0, 3100 ms); new: fd 13: unix 0x1 ->(none)",
		);
		const sent = fifoRun({
			plugin: [{ reinstated: true, sendStatus: ["ok", ...Array(9).fill("x")] }],
		});
		expect(fifoProblem("reinstate-send", sent)).toBe("a handle-bearing write succeeded");
		expect(fifoProblem("reinstate-send", fifoRun({ plugin: [{ reinstated: true }] }))).toBe(
			"the plugin did not report ten sends",
		);
		expect(fifoProblem("reinstate-send", fifoRun({ plugin: [] }))).toBe(
			"process.send did not come back over stdout",
		);
		expect(fifoProblem("reinstate-stderr", fifoRun({ mode: "reinstate-stderr", plugin: [] }))).toBe(
			"process.send did not come back over stderr",
		);
		const open = fifoRun({
			pluginEnded: { code: 0, signal: null, closed: false },
			outputs: [
				{
					...ended("stdout", "open"),
					afterExitMs: null,
					holders: ["hub fd 15 r", "pid 812 (node) fd 4 w"],
					drain: { bytes: 7, result: "EAGAIN" },
				},
				ended("stderr"),
			],
		});
		expect(fifoProblem("reinstate-send", open)).toBe(
			"the stdout FIFO never reached end-of-file (drain EAGAIN after 7 bytes; holders: hub fd 15 r, pid 812 (node) fd 4 w)",
		);
		expect(fifoProblem("reinstate-send", fifoRun({ fds: null }))).toBe(
			"the hub's descriptors could not be counted",
		);
		expect(fifoProblem("reinstate-send", fifoRun({ killedAtTimeout: true }))).toBe(
			"the plugin was still running after 10 s and was killed",
		);
	});

	it("lists every failing check, so an open FIFO can't hide the sends and bytes read", () => {
		const run = fifoRun({
			outputs: [{ ...ended("stdout", "open"), afterExitMs: null }, ended("stderr")],
			plugin: [{ reinstated: true, sendStatus: [...Array(9).fill("ENOTSOCK"), "EPIPE"] }],
			bytesRead: { stdout: 3, stderr: 240, fd3: null },
			beforeSpawn: { ends: 6, unlinkedFifos: 6, folderGone: false },
		});
		expect(fifoProblems("reinstate-send", run)).toEqual([
			"the stdout FIFO never reached end-of-file (drain closed after 0 bytes)",
			"the handle-bearing writes ended ENOTSOCK, EPIPE, not ENOTSOCK alone",
			"the hub read 3 bytes from the stdout FIFO the handles went over",
			"the FIFOs' folder was still there at the spawn",
		]);
		expect(fifoProblems("reinstate-send", fifoRun({}))).toEqual([]);
		const dead = { ...fifoRun({}), survived: false, exitCode: 1, result: null };
		expect(fifoProblems("reinstate-send", dead)).toEqual(["the hub died (unknown, exit 1)"]);
	});

	it("wants ENOTSOCK from every handle-bearing write, not just any failure", () => {
		for (const other of ["EPIPE", "EBADF", "EINVAL", "x"]) {
			const sends = [...Array(9).fill("ENOTSOCK"), other];
			const run = fifoRun({ plugin: [{ reinstated: true, sendStatus: sends }] });
			expect(fifoProblem("reinstate-send", run)).toBe(
				`the handle-bearing writes ended ENOTSOCK, ${other}, not ENOTSOCK alone`,
			);
		}
	});

	it("fails when the hub read anything from the FIFO the handles went over", () => {
		const stdout = fifoRun({ bytesRead: { stdout: 120, stderr: 240, fd3: null } });
		expect(fifoProblem("reinstate-send", stdout)).toBe(
			"the hub read 120 bytes from the stdout FIFO the handles went over",
		);
		const stderr = fifoRun({
			mode: "reinstate-stderr",
			bytesRead: { stdout: 0, stderr: 1, fd3: null },
		});
		expect(fifoProblem("reinstate-stderr", stderr)).toBe(
			"the hub read 1 bytes from the stderr FIFO the handles went over",
		);
		const uncounted = fifoRun({
			mode: "handle-send",
			layout: "fd3",
			plugin: [{ attempted: 10, sendStatus: ENOTSOCK_TEN }],
		});
		expect(fifoProblem("handle-send", uncounted)).toBe(
			"the hub read an unknown number of bytes from the fd3 FIFO the handles went over",
		);
	});

	it("fails when a FIFO still had a name, or its folder was left, at the spawn", () => {
		const named = fifoRun({ beforeSpawn: { ends: 6, unlinkedFifos: 5, folderGone: true } });
		expect(fifoProblem("reinstate-send", named)).toBe(
			"1 of 6 ends weren't unlinked FIFOs at the spawn",
		);
		const folder = fifoRun({ beforeSpawn: { ends: 6, unlinkedFifos: 6, folderGone: false } });
		expect(fifoProblem("reinstate-send", folder)).toBe(
			"the FIFOs' folder was still there at the spawn",
		);
	});

	it("wants the decoder's kill on NODE_* lines and nothing else", () => {
		const killed = { code: null, signal: "SIGKILL", closed: true };
		const internal = fifoRun({
			mode: "reinstate-internal",
			violations: [{ kind: "handle", detail: "NODE_HANDLE" }],
			pluginEnded: killed,
			plugin: [{ reinstated: true }],
		});
		expect(fifoProblem("reinstate-internal", internal)).toBeNull();
		expect(fifoProblem("reinstate-internal", fifoRun({ plugin: [{ reinstated: true }] }))).toBe(
			"violation none, expected handle",
		);
		const unexpected = fifoRun({ violations: [{ kind: "parse-error", detail: "json" }] });
		expect(fifoProblem("reinstate-send", unexpected)).toBe("violation parse-error, expected none");
		expect(() => fifoProblem("raw-garbage", fifoRun({}))).toThrow(/unknown FIFO mode/);
	});

	it("sums up how a Node's FIFOs ended in one content-free line", () => {
		const drained = fifoRun({
			outputs: [
				{ ...ended("stdout", "drain"), drain: { bytes: 40, result: "eof" } },
				{ ...ended("stderr", "drain"), drain: { bytes: 0, result: "eof" } },
			],
		});
		const runs = new Map([
			["round-trip", drained],
			["reinstate-send", fifoRun({ killedAtTimeout: true })],
			["reinstate-stderr", { ...fifoRun({}), survived: false, result: null }],
		]);
		expect(fifoSummary("26.12.0", runs)).toBe(
			"FIFO stdio, 26.12.0: ended eof 2, drain 2, hub 0, error 0, open 0; drains eof 2 (40 bytes), closed 2 (0 bytes); killed at 10 s: reinstate-send; no result: reinstate-stderr",
		);
	});
});

describe("the held-writer control's verdict", () => {
	const held: FifoHeldResult = {
		reader: 18,
		writer: 21,
		exitMs: 60,
		killedAtTimeout: false,
		held: { bytes: 0, result: "EAGAIN" },
		holders: ["hub fd 21 w", "hub fd 18 r"],
		released: { bytes: 0, result: "eof" },
		endedBy: "drain",
		bytesRead: 6,
	};
	const run = (overrides: Partial<FifoHeldResult>): HubRun<FifoHeldResult> => ({
		survived: true,
		exitCode: 0,
		signal: null,
		timedOut: false,
		crash: null,
		result: { ...held, ...overrides },
	});

	it("passes only when the drain finds the writer, the holders name it and the next drain ends the FIFO", () => {
		expect(fifoHeldProblem(run({}))).toBeNull();
		expect(fifoHeldProblem(run({ held: { bytes: 0, result: "eof" } }))).toBe(
			"the drain gave eof while the hub held a second writer, not EAGAIN",
		);
		expect(fifoHeldProblem(run({ holders: ["hub fd 18 r"] }))).toBe(
			"holders hub fd 18 r, expected hub fd 18 r, hub fd 21 w",
		);
		expect(fifoHeldProblem(run({ holders: ["hub fd 18 r", "hub fd 21 w (device differs)"] }))).toBe(
			"holders hub fd 18 r, hub fd 21 w (device differs), expected hub fd 18 r, hub fd 21 w",
		);
		expect(fifoHeldProblem(run({ holders: null }))).toBe(
			"holders not listed, expected hub fd 18 r, hub fd 21 w",
		);
		expect(fifoHeldProblem(run({ endedBy: "eof" }))).toBe(
			"after the hub closed its writer the drain gave eof and the FIFO ended by eof, not eof and drain",
		);
		expect(fifoHeldProblem(run({ bytesRead: 0 }))).toBe("the hub read 0 bytes, not 6");
		expect(fifoHeldProblem(run({ killedAtTimeout: true }))).toBe(
			"the plugin was still running after 10 s",
		);
		expect(fifoHeldSummary("26.5.1", run({}))).toBe(
			"FIFO held-writer control, 26.5.1: drain EAGAIN (holders hub fd 21 w, hub fd 18 r), then eof; ended by drain; 6 bytes read",
		);
	});
});

describe("Fallback 1 on spawn's pipes (the round-trip verdict)", () => {
	const trip: StdioRoundTrip = {
		mcp: true,
		host: true,
		audit: FETCH_TARGETS.map((target) => ({
			reason: target.expect,
			port: null,
			allow: target.expect === "allowed",
		})),
		outcomes: FETCH_TARGETS.map((target) => ({ denied: target.expect !== "allowed" })),
	};
	const run = (overrides: Partial<Fallback1RoundTripResult>): HubRun<Fallback1RoundTripResult> => ({
		survived: true,
		exitCode: 0,
		signal: null,
		timedOut: false,
		crash: null,
		result: {
			roundTrip: trip,
			violations: [],
			pluginEnded: { code: 0, signal: null, closed: true },
			...overrides,
		},
	});

	it("passes a full round trip with the broker's verdicts and fails anything less", () => {
		expect(fallback1RoundTripProblem(run({}))).toBeNull();
		expect(fallback1RoundTripProblem(run({ roundTrip: { ...trip, mcp: false } }))).toBe(
			"no MCP round trip on stdin/stdout",
		);
		expect(fallback1RoundTripProblem(run({ roundTrip: { ...trip, host: false } }))).toBe(
			"no host-frame round trip on stdin/stdout",
		);
		const violation = run({ violations: [{ kind: "parse-error", detail: "json" }] });
		expect(fallback1RoundTripProblem(violation)).toBe(
			"a benign plugin raised the violation parse-error",
		);
		const lasting = run({ pluginEnded: { code: null, signal: "SIGKILL", closed: false } });
		expect(fallback1RoundTripProblem(lasting)).toBe("the plugin's pipes never closed");
		const died: HubRun<Fallback1RoundTripResult> = { ...run({}), survived: false, result: null };
		expect(fallback1RoundTripProblem(died)).toMatch(/^the hub died/);
	});
});

describe("the spawn cost's failure label", () => {
	it("keeps an errno-style code or an exit code and nothing else", () => {
		expect(errorLabel(Object.assign(new Error("x"), { code: "NO_OUTPUT" }))).toBe("NO_OUTPUT");
		expect(errorLabel(Object.assign(new Error("x"), { code: "ENOENT" }))).toBe("ENOENT");
		expect(errorLabel(Object.assign(new Error("x"), { code: 1 }))).toBe("exit 1");
		expect(errorLabel(Object.assign(new Error("x"), { code: "not a code" }))).toBe("failed");
		expect(errorLabel(new Error("FIFO stdio needs /usr/bin/mkfifo"))).toBe("failed");
		expect(errorLabel("text")).toBe("failed");
	});
});

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));
const SEQUENCE_BYTES = 4 << 20;

// A child that writes `bytes` of big-endian uint32 counters to stdout and exits once they are written.
const counting = (bytes: number): string =>
	`const b = Buffer.alloc(${bytes}); for (let i = 0; i < ${bytes / 4}; i++) b.writeUInt32BE(i, i * 4); process.stdout.write(b, () => process.exit(0));`;

// Returns once the stream's buffer has stopped growing, or the writer is done.
async function settled(stream: Readable, done: () => boolean): Promise<void> {
	let last = -1;
	for (let i = 0; i < 100 && !done(); i++) {
		await sleep(100);
		const length = stream.readableLength;
		if (length > 0 && length === last) return;
		last = length;
	}
}

function collect(stream: Readable): Promise<Buffer> {
	const chunks: Buffer[] = [];
	stream.on("data", (chunk: Buffer) => chunks.push(chunk));
	return new Promise((resolve) => stream.once("close", () => resolve(Buffer.concat(chunks))));
}

// The bytes of counters that arrived, if all arrived in order; else where the first one is wrong.
function inOrder(data: Buffer): number {
	let i = 0;
	while (i * 4 + 4 <= data.length && data.readUInt32BE(i * 4) === i) i++;
	return i * 4 === data.length ? data.length : i * 4;
}

describe("openFifoStdio", () => {
	it("joins a child to the hub through FIFOs alone, unlinked before it starts", {
		tags: ["requires:posix"],
	}, async () => {
		const fifo = await openFifoStdio(2);
		let child: ChildProcess | undefined;
		try {
			const [stdout, stderr] = fifo.outputs as readonly [Readable, Readable];
			expect(fifo.pluginFds).toHaveLength(3);
			expect(fifo.hubFds).toHaveLength(3);
			expect(fs.existsSync(fifo.dir), "the FIFOs' folder").toBe(false);
			for (const fd of [...fifo.pluginFds, ...fifo.hubFds]) {
				const stats = fs.fstatSync(fd);
				expect([stats.isFIFO(), stats.nlink], `fd ${fd}`).toEqual([true, 0]);
			}
			// It echoes one line and exits: a child on macOS never sees its FIFO stdin end.
			const echo =
				"process.stdin.once('data', (line) => process.stdout.write(line, () => process.exit(0)))";
			child = spawn(process.execPath, ["-e", echo], { stdio: [...fifo.pluginFds] });
			fifo.releasePluginEnds();
			const exited = once(child, "exit");
			const closed = once(stdout, "close");
			let text = "";
			stdout.setEncoding("utf8").on("data", (chunk: string) => {
				text += chunk;
			});
			stderr.resume();
			fifo.input.write("through a FIFO\n");
			await exited;
			for (const { result } of fifo.drain()) expect(["eof", "closed"]).toContain(result);
			await closed;
			expect(text).toBe("through a FIFO\n");
		} finally {
			child?.kill("SIGKILL");
			fifo.destroy();
		}
	});

	it("drains what a writer left behind and ends each output, without libuv's end-of-file", {
		tags: ["requires:posix"],
	}, async () => {
		const fifo = await openFifoStdio(2);
		try {
			const [stdout, stderr] = fifo.outputs as readonly [Readable, Readable];
			let text = "";
			stdout.setEncoding("utf8").on("data", (chunk: string) => {
				text += chunk;
			});
			stderr.resume();
			const ends = Promise.all([once(stdout, "close"), once(stderr, "close")]);
			fs.writeSync(fifo.pluginFds[1] as number, "left behind\n");
			fifo.releasePluginEnds();
			// In this same tick libuv hasn't polled the FIFOs, so only the drain can read them.
			expect(fifo.drain()).toEqual([
				{ bytes: 12, result: "eof" },
				{ bytes: 0, result: "eof" },
			]);
			expect(fifo.endings()).toEqual(["drain", "drain"]);
			await ends;
			expect(text).toBe("left behind\n");
			expect(fifo.drain().map(({ result }) => result)).toEqual(["closed", "closed"]);
		} finally {
			fifo.destroy();
		}
	});

	it("leaves an output open while a writer remains", { tags: ["requires:posix"] }, async () => {
		const fifo = await openFifoStdio(1);
		try {
			const [stdout] = fifo.outputs as readonly [Readable];
			stdout.resume();
			expect(fifo.drain()).toEqual([{ bytes: 0, result: "EAGAIN" }]);
			expect(fifo.endings()).toEqual([null]);
			expect(stdout.readableEnded || stdout.destroyed).toBe(false);
			const closed = once(stdout, "close");
			fifo.releasePluginEnds();
			expect(fifo.drain()).toEqual([{ bytes: 0, result: "eof" }]);
			await closed;
		} finally {
			fifo.destroy();
		}
	});

	it("stops reading once a consumer closes the output during the drain", {
		tags: ["requires:posix"],
	}, async () => {
		const fifo = await openFifoStdio(1);
		const reads = vi.spyOn(fs, "readSync");
		try {
			const [stdout] = fifo.outputs as readonly [Readable];
			const closed = once(stdout, "close");
			// As the decoder does at a violation: it destroys its stream on the chunk that broke a rule.
			stdout.on("data", () => stdout.destroy());
			await tick();
			fs.writeSync(fifo.pluginFds[1] as number, "a hostile line\n");
			fifo.releasePluginEnds();
			reads.mockClear();
			expect(fifo.drain()).toEqual([{ bytes: 15, result: "closed" }]);
			expect(reads, "reads after the close").toHaveBeenCalledTimes(1);
			expect(fifo.endings()).toEqual(["closed"]);
			await closed;
		} finally {
			reads.mockRestore();
			fifo.destroy();
		}
	});

	it("stops the writer while nothing reads an output, and keeps its bytes in order", {
		tags: ["requires:posix"],
		timeout: 30_000,
	}, async () => {
		const fifo = await openFifoStdio(2);
		let child: ChildProcess | undefined;
		try {
			const [stdout, stderr] = fifo.outputs as readonly [Readable, Readable];
			stderr.resume();
			child = spawn(process.execPath, ["-e", counting(SEQUENCE_BYTES)], {
				stdio: [...fifo.pluginFds],
			});
			fifo.releasePluginEnds();
			let exited = false;
			const exit = once(child, "exit").then(() => {
				exited = true;
			});
			// Nothing reads stdout: the output fills, libuv stops, the FIFO fills and the child blocks.
			await settled(stdout, () => exited);
			expect(exited, "the child wrote everything with nothing reading").toBe(false);
			expect(stdout.readableLength).toBeLessThanOrEqual(1 << 20);
			const received = collect(stdout);
			await exit;
			fifo.drain();
			expect(inOrder(await received)).toBe(SEQUENCE_BYTES);
		} finally {
			child?.kill("SIGKILL");
			fifo.destroy();
		}
	});

	it("delivers what libuv read before a pause ahead of the drain's reads", {
		tags: ["requires:posix"],
		timeout: 30_000,
	}, async () => {
		const fifo = await openFifoStdio(2);
		let child: ChildProcess | undefined;
		try {
			const [stdout, stderr] = fifo.outputs as readonly [Readable, Readable];
			stderr.resume();
			// Small enough to fit in the FIFO and both paused buffers, so the child exits while
			// nothing reads, with bytes left in libuv's paused stream and in the FIFO.
			const bytes = 160 << 10;
			child = spawn(process.execPath, ["-e", counting(bytes)], { stdio: [...fifo.pluginFds] });
			fifo.releasePluginEnds();
			const exit = once(child, "exit");
			const ran = await Promise.race([exit.then(() => true), sleep(10_000).then(() => false)]);
			const received = collect(stdout);
			if (!ran) await exit;
			fifo.drain();
			expect(inOrder(await received)).toBe(bytes);
		} finally {
			child?.kill("SIGKILL");
			fifo.destroy();
		}
	});

	it("names every holder of a FIFO among the hub's user's processes", {
		tags: ["requires:posix"],
	}, async () => {
		const fifo = await openFifoStdio(1);
		try {
			const reader = fifo.hubFds[1] as number;
			const writer = fifo.pluginFds[1] as number;
			const { dev, ino } = fs.fstatSync(reader, { bigint: true });
			const before = fifoHolders([{ dev, ino }], [reader, writer]);
			expect(before.holders.map((found) => found?.toSorted())).toEqual([
				[`hub fd ${reader} r`, `hub fd ${writer} w`].toSorted(),
			]);
			fifo.releasePluginEnds();
			expect(fifoHolders([{ dev, ino }]).holders).toEqual([[`hub fd ${reader} r`]]);
		} finally {
			fifo.destroy();
		}
	});

	it("makes its folder under the parent it is given and leaves nothing there", {
		tags: ["requires:posix"],
	}, async () => {
		const parent = fs.mkdtempSync(path.join(os.tmpdir(), "dy-s02-fifo-parent-"));
		try {
			const fifo = await openFifoStdio(1, parent);
			try {
				expect(path.dirname(fifo.dir)).toBe(parent);
				expect(fs.readdirSync(parent)).toEqual([]);
			} finally {
				fifo.destroy();
			}
		} finally {
			fs.rmSync(parent, { recursive: true, force: true });
		}
	});
});
