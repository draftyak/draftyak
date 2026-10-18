// The FIFO-stdio control (remedy (f), ADR 0003): the hub's side of Fallback 1 on stdin/stdout
// (tagged host frames beside untagged MCP lines, every line under the fd-3 decoder's rules), the
// FIFO modes with their verdicts, Fallback 1's round trip on spawn's own pipes, and the spawn cost
// next to libuv's socketpairs. The stand-in hub, the host tests and, staged, docker-runner-s2b.ts
// use it, so it imports only node: built-ins, the spike's src and ./s2b.ts.
import type { ChildProcess } from "node:child_process";
import { EventEmitter, once } from "node:events";
import path from "node:path";
import { Duplex, type Readable, type Writable } from "node:stream";
import { openFifoStdio } from "../src/fifo-stdio.ts";
import {
	attachHostChannel,
	createChannelDecoder,
	type HostChannel,
	type HostChannelOptions,
	type HostViolation,
	type ViolationKind,
} from "../src/host-channel.ts";
import {
	died,
	type Fds,
	FETCH_TARGETS,
	type HubRun,
	type PluginEnd,
	spawnFixture,
	type ViolationRecord,
	within,
} from "./s2b.ts";

// The spike's stand-in for M1.12's host-frame tag (spec/host-channel-v1.md fixes the real one): RS,
// RFC 7464's record separator, in front of a host frame's JSON on its line. An MCP line starts
// with "{", and a raw RS inside a JSON line is invalid JSON, so the two lanes never mix.
export const HOST_FRAME_TAG = 0x1e;
const NEWLINE = 0x0a;

// attachHostChannel over any stream (it reads child.stdio[3]); the FIFO layouts hand it a FIFO's
// hub end, or the host lane of stdout. Kills the real plugin on a violation.
export function channelOver(
	child: ChildProcess,
	stream: Duplex,
	options: HostChannelOptions = {},
): HostChannel {
	const view = Object.assign(new EventEmitter(), { stdio: [null, null, null, stream] });
	child.once("exit", (code, signal) => view.emit("exit", code, signal));
	return attachHostChannel(view as unknown as ChildProcess, {
		kill: () => void child.kill("SIGKILL"),
		...options,
	});
}

export interface TaggedStdio {
	readonly host: HostChannel;
	// Both lanes' violations, in the order they happened; the first one killed the plugin.
	readonly violations: readonly HostViolation[];
	// An MCP request on the untagged lane; null if no reply came in time.
	request(
		method: string,
		params?: unknown,
		timeoutMs?: number,
	): Promise<Record<string, unknown> | null>;
}

// Fallback 1's hub side: each line the plugin writes to stdout is a host frame (tag first) or an MCP
// message. Bytes go to their lane as they arrive, so the splitter buffers nothing; each lane's
// decoder applies the fd-3 rules (JSON-RPC only, 1 MiB, any NODE_* message), and a violation on
// either lane kills the plugin. The hub's host frames go out tagged on stdin.
export function attachTaggedStdio(
	child: ChildProcess,
	input: Writable,
	output: Readable,
	options: HostChannelOptions = {},
): TaggedStdio {
	const violations: HostViolation[] = [];
	const tag = Buffer.from([HOST_FRAME_TAG]);
	const lane = new Duplex({
		read() {},
		write(chunk: Buffer, _encoding, done) {
			input.write(Buffer.concat([tag, chunk]), (error) => done(error ?? null));
		},
	});
	const host = channelOver(child, lane, {
		...options,
		framed: false,
		onViolation: (violation) => {
			violations.push(violation);
			options.onViolation?.(violation);
		},
	});
	const replies = new Map<string, (message: Record<string, unknown>) => void>();
	const mcp = createChannelDecoder({
		framed: false,
		maxMessageBytes: options.maxMessageBytes,
		onMessage: (message) => {
			const id = String(message.id);
			replies.get(id)?.(message);
			replies.delete(id);
		},
		onViolation: (violation) => {
			violations.push(violation);
			child.kill("SIGKILL");
			lane.destroy();
		},
	});
	let route: "host" | "mcp" | null = null;
	output.on("data", (chunk: Buffer) => {
		let rest = chunk;
		while (rest.length > 0 && violations.length === 0) {
			if (route === null) {
				route = rest[0] === HOST_FRAME_TAG ? "host" : "mcp";
				if (route === "host") rest = rest.subarray(1);
				continue;
			}
			const newline = rest.indexOf(NEWLINE);
			const part = newline === -1 ? rest : rest.subarray(0, newline + 1);
			if (route === "host") lane.push(part);
			else mcp.push(part);
			if (newline !== -1) route = null;
			rest = rest.subarray(part.length);
		}
	});
	let nextId = 0;
	return {
		host,
		violations,
		request(method, params = {}, timeoutMs = 10_000) {
			const id = `mcp-${++nextId}`;
			const reply = new Promise<Record<string, unknown> | null>((resolve) =>
				replies.set(id, resolve),
			);
			input.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
			return within(reply, timeoutMs, null).finally(() => replies.delete(id));
		},
	};
}

export type FifoLayout = "stdio" | "fd3";
export type FifoLane = "stdout" | "stderr" | "fd3";

export interface FifoModeSpec {
	readonly layout: FifoLayout;
	readonly violation: ViolationKind | null;
	// The FIFO the plugin's ten handle-bearing writes go over; null where it sends no handle.
	readonly handlesOver: FifoLane | null;
}

// Each mode's layout, the violation the hub must raise (null where nothing the plugin sends can
// reach the hub, or the exchange is benign) and the FIFO its handle sends use. "stdio" is Fallback 1
// on FIFOs, where a plugin can make stdout or stderr an IPC channel (_forkChild); "fd3" adds a
// fourth FIFO as fd 3 with NODE_CHANNEL_*, a channel the plugin can only write, to show that the
// fd-3 channel drops a handle on a FIFO too.
export const FIFO_MODES: Readonly<Record<string, FifoModeSpec>> = {
	"round-trip": { layout: "stdio", violation: null, handlesOver: null },
	"handle-send": { layout: "fd3", violation: null, handlesOver: "fd3" },
	"node-internal": { layout: "fd3", violation: "handle", handlesOver: null },
	"reinstate-send": { layout: "stdio", violation: null, handlesOver: "stdout" },
	"reinstate-stderr": { layout: "stdio", violation: null, handlesOver: "stderr" },
	"reinstate-internal": { layout: "stdio", violation: "handle", handlesOver: null },
};

export function fifoMode(mode: string): FifoModeSpec {
	const entry = FIFO_MODES[mode];
	if (entry === undefined) throw new Error(`unknown FIFO mode ${mode}`);
	return entry;
}

// Fallback 1's benign exchange: an MCP ping answered on the untagged lane, the hub's plugin/echo on
// the host lane, and the broker's verdicts on the plugin's host/fetch calls.
export interface StdioRoundTrip {
	readonly mcp: boolean;
	readonly host: boolean;
	readonly audit: readonly {
		readonly reason: string;
		readonly port: number | null;
		readonly allow: boolean;
	}[];
	readonly outcomes: readonly { readonly denied: boolean; readonly reason?: string | null }[];
}

export interface FifoResult {
	readonly mode: string;
	readonly layout: FifoLayout;
	// Checked just before the spawn: of the hub's and the plugin's ends, how many are FIFOs with no
	// name left (fstat nlink 0), and whether the folder they were made in is gone.
	readonly beforeSpawn: {
		readonly ends: number;
		readonly unlinkedFifos: number;
		readonly folderGone: boolean;
	};
	readonly violations: readonly ViolationRecord[];
	// closed: every FIFO the plugin writes reached end-of-file, or the hub closed it on a violation.
	readonly pluginEnded: PluginEnd;
	readonly exitMs: number;
	readonly fds: Fds | null;
	// Bytes the hub read from each FIFO the plugin writes (fd3 is null in the stdio layout).
	readonly bytesRead: {
		readonly stdout: number;
		readonly stderr: number;
		readonly fd3: number | null;
	};
	// The plugin's reports: ##DYS2B## lines on stdout (fd3 layout) or stderr (reinstate-send and
	// reinstate-internal), or "report" host frames on stdout (reinstate-stderr).
	readonly plugin: readonly Record<string, unknown>[];
	readonly roundTrip: StdioRoundTrip | null;
}

export function roundTripProblem(trip: StdioRoundTrip | null): string | null {
	if (trip === null || !trip.mcp) return "no MCP round trip on stdin/stdout";
	if (!trip.host) return "no host-frame round trip on stdin/stdout";
	const verdicts = trip.audit.map((entry) => entry.reason).join(",");
	const expected = FETCH_TARGETS.map((target) => target.expect).join(",");
	if (verdicts !== expected) return `broker verdicts ${verdicts}, expected ${expected}`;
	const denials = FETCH_TARGETS.filter((target) => target.expect !== "allowed").length;
	const seen = trip.outcomes.filter((outcome) => outcome.denied).length;
	if (seen !== denials) return `the plugin saw ${seen} denials, not ${denials}`;
	return null;
}

// What every handle-bearing write must end with on a FIFO: sendmsg() on a descriptor that isn't a
// socket fails, so neither the descriptor nor the message's bytes leave the plugin.
const NOT_A_SOCKET = "ENOTSOCK";

// FIFO stdio holds for a mode when the hub survives, its descriptor count does not move, the plugin
// ends (by SIGKILL or on its own) with every FIFO closed, the hub raises exactly the expected
// violation, each of the ten handle-bearing writes failed in the plugin with ENOTSOCK while the hub
// read nothing from the FIFO they went over, and every FIFO was unlinked (with its folder) before
// the spawn. The unlink check runs last, so a run that fails only there still shows the rest held.
export function fifoProblem(mode: string, run: HubRun<FifoResult>): string | null {
	const r = run.result;
	if (!run.survived || r === null) return died(run);
	const { violation: expected, handlesOver } = fifoMode(mode);
	const first = r.violations[0]?.kind ?? null;
	const end = r.pluginEnded;
	const how = end.signal ?? `exit ${end.code}`;
	if (r.fds === null) return "the hub's descriptors could not be counted";
	if (r.fds.after !== r.fds.before) {
		const added = r.fds.added?.length ? `; new: ${r.fds.added.join("; ")}` : "";
		return `the hub's open fds went from ${r.fds.before} to ${r.fds.after} on FIFO stdio (violation ${first ?? "none"}, ended by ${how}, ${r.exitMs} ms)${added}`;
	}
	if (end.signal === null && end.code === null) return "the plugin never ended";
	if (!end.closed) return "a FIFO the plugin writes never closed";
	if (first !== expected) return `violation ${first ?? "none"}, expected ${expected ?? "none"}`;
	if (expected !== null && end.signal !== "SIGKILL") return `the plugin ended by ${how}`;
	if (mode.startsWith("reinstate-") && !r.plugin.some((line) => line.reinstated === true)) {
		return `process.send did not come back over ${handlesOver ?? "stdout"}`;
	}
	if (handlesOver !== null) {
		const sends = r.plugin.find((line) => Array.isArray(line.sendStatus))?.sendStatus;
		if (!Array.isArray(sends) || sends.length !== 10) return "the plugin did not report ten sends";
		if (sends.includes("ok")) return "a handle-bearing write succeeded";
		if (sends.some((status) => status !== NOT_A_SOCKET)) {
			const seen = [...new Set(sends.map(String))].join(", ");
			return `the handle-bearing writes ended ${seen}, not ${NOT_A_SOCKET} alone`;
		}
		const read = r.bytesRead[handlesOver];
		if (read !== 0) {
			return `the hub read ${read ?? "an unknown number of"} bytes from the ${handlesOver} FIFO the handles went over`;
		}
	}
	const trip = mode === "round-trip" ? roundTripProblem(r.roundTrip) : null;
	if (trip !== null) return trip;
	const { ends, unlinkedFifos, folderGone } = r.beforeSpawn;
	if (unlinkedFifos !== ends) {
		return `${ends - unlinkedFifos} of ${ends} ends weren't unlinked FIFOs at the spawn`;
	}
	return folderGone ? null : "the FIFOs' folder was still there at the spawn";
}

// Fallback 1 on spawn's own pipes (socketpairs on POSIX, named pipes on Windows), with no fd 3 and
// no NODE_CHANNEL_*: the FIFO control's benign exchange, on the pipes Windows keeps.
export interface Fallback1RoundTripResult {
	readonly roundTrip: StdioRoundTrip;
	readonly violations: readonly ViolationRecord[];
	readonly pluginEnded: PluginEnd;
}

export function fallback1RoundTripProblem(run: HubRun<Fallback1RoundTripResult>): string | null {
	const r = run.result;
	if (!run.survived || r === null) return died(run);
	const first = r.violations[0]?.kind;
	if (first !== undefined) return `a benign plugin raised the violation ${first}`;
	const trip = roundTripProblem(r.roundTrip);
	if (trip !== null) return trip;
	return r.pluginEnded.closed ? null : "the plugin's pipes never closed";
}

export interface Timing {
	readonly medianMs: number;
	readonly minMs: number;
	readonly maxMs: number;
}

export interface SpawnCost {
	readonly runs: number;
	readonly node: string;
	// From the spawn decision to the plugin's first byte on stdout, under the production argv.
	readonly socketpair: { readonly readyMs: Timing };
	// The same with FIFO stdio, and within it the FIFOs' own setup (mkfifo, the opens, the unlinks).
	readonly fifo: { readonly setupMs: Timing; readonly readyMs: Timing };
}

// What the benchmark records: the cost, or the code the measurement failed with.
export type SpawnCostOutcome = SpawnCost | { readonly error: string };

const round2 = (value: number): number => Math.round(value * 100) / 100;

function timing(values: readonly number[]): Timing {
	const sorted = [...values].sort((a, b) => a - b);
	const mid = Math.floor(sorted.length / 2);
	const median =
		sorted.length % 2
			? (sorted[mid] as number)
			: ((sorted[mid - 1] as number) + (sorted[mid] as number)) / 2;
	return {
		medianMs: round2(median),
		minMs: round2(sorted[0] ?? 0),
		maxMs: round2(sorted.at(-1) ?? 0),
	};
}

interface SpawnDirs {
	readonly nodeBin: string;
	readonly pluginDir: string;
	readonly dataDir: string;
}

async function spawnUntilReady(dirs: SpawnDirs, fifo: boolean): Promise<[number, number]> {
	const started = performance.now();
	const stdio = fifo ? await openFifoStdio(2) : null;
	const setupMs = performance.now() - started;
	let child: ChildProcess | undefined;
	try {
		child = spawnFixture({
			...dirs,
			grantData: true,
			entry: path.join(dirs.pluginDir, "ipc-plugin.mjs"),
			entryArgs: ["ready"],
			stdio: stdio === null ? ["pipe", "pipe", "pipe"] : stdio.pluginFds,
			channel: false,
		});
		stdio?.releasePluginEnds();
		const stdout = (stdio === null ? child.stdout : stdio.outputs[0]) as Readable;
		(stdio === null ? child.stderr : stdio.outputs[1])?.resume();
		const exited = once(child, "exit");
		const first = await within(
			once(stdout, "data").then(() => true),
			15_000,
			false,
		);
		if (!first) {
			const layout = fifo ? "FIFO" : "socketpair";
			throw Object.assign(new Error(`no output from the ${layout} spawn`), { code: "NO_OUTPUT" });
		}
		const readyMs = performance.now() - started;
		stdout.resume();
		await within(exited, 15_000, undefined);
		return [setupMs, readyMs];
	} finally {
		child?.kill("SIGKILL");
		stdio?.destroy();
	}
}

// Alternates which layout spawns first, so drift on a shared machine doesn't favour either.
export async function measureSpawnCost(
	dirs: SpawnDirs,
	node: string,
	runs = 9,
): Promise<SpawnCost> {
	const pipe: number[] = [];
	const setup: number[] = [];
	const ready: number[] = [];
	for (let i = 0; i < runs; i++) {
		for (const fifo of i % 2 === 0 ? [false, true] : [true, false]) {
			const [setupMs, readyMs] = await spawnUntilReady(dirs, fifo);
			if (!fifo) pipe.push(readyMs);
			else {
				setup.push(setupMs);
				ready.push(readyMs);
			}
		}
	}
	return {
		runs,
		node,
		socketpair: { readyMs: timing(pipe) },
		fifo: { setupMs: timing(setup), readyMs: timing(ready) },
	};
}

// A content-free label for a failure: an errno-style code, a child's exit code, or "failed".
export function errorLabel(error: unknown): string {
	const code = (error as { code?: unknown } | null)?.code;
	if (typeof code === "string" && /^[A-Z][A-Z0-9_]{1,40}$/.test(code)) return code;
	if (typeof code === "number" && Number.isInteger(code)) return `exit ${code}`;
	return "failed";
}

// The spawn cost, best-effort: a failure is logged and recorded as its label, so the benchmark's
// sampler costs and findings never depend on FIFO stdio working on the target.
export async function spawnCostOrError(dirs: SpawnDirs, node: string): Promise<SpawnCostOutcome> {
	try {
		return await measureSpawnCost(dirs, node);
	} catch (error) {
		console.error(`spawn cost not measured: ${error instanceof Error ? error.message : error}`);
		return { error: errorLabel(error) };
	}
}
