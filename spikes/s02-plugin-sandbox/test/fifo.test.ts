import { type ChildProcess, spawn } from "node:child_process";
import { EventEmitter, once } from "node:events";
import fs from "node:fs";
import type net from "node:net";
import os from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import { describe, expect, it } from "vitest";
import { openFifoStdio } from "../src/fifo-stdio.ts";
import {
	attachTaggedStdio,
	errorLabel,
	type Fallback1RoundTripResult,
	type FifoResult,
	fallback1RoundTripProblem,
	fifoProblem,
	HOST_FRAME_TAG,
	type StdioRoundTrip,
} from "./fifo.ts";
import { fdOf } from "./hub-probes.ts";
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
		const open = fifoRun({ pluginEnded: { code: 0, signal: null, closed: false } });
		expect(fifoProblem("reinstate-send", open)).toBe("a FIFO the plugin writes never closed");
		expect(fifoProblem("reinstate-send", fifoRun({ fds: null }))).toBe(
			"the hub's descriptors could not be counted",
		);
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

describe("openFifoStdio", () => {
	it("joins a child to the hub through FIFOs alone, unlinked before it starts", {
		tags: ["requires:posix"],
	}, async () => {
		const fifo = await openFifoStdio(2);
		let child: ChildProcess | undefined;
		try {
			const [stdout, stderr] = fifo.outputs as readonly [net.Socket, net.Socket];
			const ends = [...fifo.pluginFds, ...[fifo.input, stdout, stderr].map((s) => fdOf(s))];
			expect(fifo.pluginFds).toHaveLength(3);
			expect(fs.existsSync(fifo.dir), "the FIFOs' folder").toBe(false);
			for (const fd of ends) {
				const stats = fs.fstatSync(fd);
				expect([stats.isFIFO(), stats.nlink], `fd ${fd}`).toEqual([true, 0]);
			}
			const echo =
				"process.stdin.pipe(process.stdout); process.stdin.on('end', () => console.error('done'))";
			child = spawn(process.execPath, ["-e", echo], { stdio: [...fifo.pluginFds] });
			fifo.releasePluginEnds();
			const exited = once(child, "exit");
			const closed = once(stdout, "close");
			let text = "";
			stdout.setEncoding("utf8").on("data", (chunk: string) => {
				text += chunk;
			});
			stderr.resume();
			fifo.input.end("through a FIFO\n");
			await exited;
			await closed;
			expect(text).toBe("through a FIFO\n");
		} finally {
			child?.kill("SIGKILL");
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
