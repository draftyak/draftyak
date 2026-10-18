// The stand-in hub for S2b's host-channel probes: `node --expose-gc hub-probes.ts <probe> <config>`
// spawns a plugin on its own Node the way the hub does (spawnPlugin, then attachHostChannel), prints
// one ##DYS2BHUB## line and exits 0. A probe that crashes this process prints nothing and exits
// non-zero, which is how runHubProbe judges survival. The control-* probes use Node's own stdio
// 'ipc' parent side instead, to show why the hub doesn't.
import { type ChildProcess, execFileSync, spawn } from "node:child_process";
import { once } from "node:events";
import fs from "node:fs";
import type net from "node:net";
import path from "node:path";
import type { Readable, Writable } from "node:stream";
import { type FifoStdio, openFifoStdio } from "../src/fifo-stdio.ts";
import { attachHostChannel, type HostChannel } from "../src/host-channel.ts";
import { PLUGIN_STDIO, spawnPlugin } from "../src/spawn.ts";
import {
	attachTaggedStdio,
	channelOver,
	type Fallback1RoundTripResult,
	type FifoResult,
	fifoMode,
	type StdioRoundTrip,
	type TaggedStdio,
} from "./fifo.ts";
import {
	type ChannelResult,
	type ControlResult,
	type Fallback1Result,
	type Fds,
	FETCH_TARGETS,
	type FuzzResult,
	type HubConfig,
	type LateReplyResult,
	type PluginEnd,
	type SendAfterExitResult,
	spawnFixture,
	tagged,
	type ViolationRecord,
	within,
} from "./s2b.ts";

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

function plugin(config: HubConfig, file: string, args: readonly string[]): ChildProcess {
	return spawnPlugin({
		nodeBin: process.execPath,
		pluginDir: config.pluginDir,
		dataDir: config.dataDir,
		grantData: true,
		pluginId: "s02-s2b-hub",
		instanceId: path.basename(file, ".mjs"),
		entry: path.join(config.pluginDir, file),
		entryArgs: args,
	});
}

// Waits for 'close' (every stdio stream ended), else SIGKILLs the plugin and settles on its exit.
function ended(child: ChildProcess, timeoutMs: number): Promise<PluginEnd> {
	return new Promise((resolve) => {
		const finish = (closed: boolean): void =>
			resolve({ code: child.exitCode, signal: child.signalCode, closed });
		const timer = setTimeout(() => {
			child.kill("SIGKILL");
			if (child.exitCode !== null || child.signalCode !== null) finish(false);
			else child.once("exit", () => finish(false));
		}, timeoutMs);
		child.once("close", () => {
			clearTimeout(timer);
			finish(true);
		});
	});
}

function stdoutOf(child: ChildProcess): () => string {
	let text = "";
	child.stdout?.setEncoding("utf8").on("data", (chunk: string) => {
		text += chunk;
	});
	child.stderr?.resume();
	return () => text;
}

// The plugin's last ##DYS2B## line on stderr (reinstate-send reports there, since fd 1 is its IPC
// channel). Returns the latest at call time.
function stderrReportOf(child: ChildProcess): () => Record<string, unknown> | null {
	let text = "";
	child.stderr?.setEncoding("utf8").on("data", (chunk: string) => {
		text += chunk;
	});
	return () => tagged(text).at(-1) ?? null;
}

export interface FdTable {
	// Entries in the listing, its own descriptor included: the count the evidence records.
	readonly count: number;
	// The descriptors still open once the listing has closed its own.
	readonly open: readonly number[];
}

const isOpen = (fd: number): boolean => {
	try {
		fs.fstatSync(fd);
		return true;
	} catch {
		return false;
	}
};

// Open descriptors on POSIX (null on Windows), after a first spawn has opened libuv's lazy ones.
async function fdTable(): Promise<FdTable | null> {
	const dir = process.platform === "linux" ? "/proc/self/fd" : "/dev/fd";
	if (process.platform === "win32" || !fs.existsSync(dir)) return null;
	(globalThis as { gc?: () => void }).gc?.();
	await sleep(100);
	const entries = fs.readdirSync(dir);
	return { count: entries.length, open: entries.map(Number).filter(isOpen) };
}

export const fdOf = (stream: unknown): number =>
	(stream as { _handle?: { fd?: number } } | null)?._handle?.fd ?? -1;

export interface LsofFile {
	readonly fd: number;
	readonly type?: string;
	readonly device?: string;
	readonly name?: string;
}

// `lsof -F ftdn` output: one field per line, each file's record opened by its f (descriptor) line.
export function parseLsof(output: string): LsofFile[] {
	const files: LsofFile[] = [];
	let current: { -readonly [K in keyof LsofFile]: LsofFile[K] } | null = null;
	for (const line of output.split(/\r?\n/)) {
		const value = line.slice(1);
		if (line.startsWith("f")) {
			current = /^\d+$/.test(value) ? { fd: Number(value) } : null;
			if (current) files.push(current);
		} else if (current && line.startsWith("t")) current.type = value;
		else if (current && line.startsWith("d")) current.device = value;
		else if (current && line.startsWith("n")) current.name = value;
	}
	return files;
}

// One line per new descriptor: lsof's type, address and name, and the listed descriptor that is its
// peer ("->0x…" names a UNIX socket's peer on macOS), so the plugin's end of one of the hub's pipes
// to it shows up as such.
export function explainFds(
	fds: readonly number[],
	files: readonly LsofFile[],
	labels: ReadonlyMap<number, string>,
): string[] {
	const named = (fd: number): string => {
		const label = labels.get(fd);
		return label === undefined ? `fd ${fd}` : `fd ${fd} (${label})`;
	};
	return fds.map((fd) => {
		const file = files.find((entry) => entry.fd === fd);
		if (file === undefined) return `${named(fd)}: not listed by lsof`;
		const self = [file.type, file.device, file.name].filter((part) => part).join(" ");
		const target = file.name?.startsWith("->") ? file.name.slice(2) : undefined;
		const peer = target && files.find((entry) => entry.device === target);
		return peer ? `${named(fd)}: ${self}, peer ${named(peer.fd)}` : `${named(fd)}: ${self}`;
	});
}

// What each descriptor is: its /proc link in Linux; elsewhere what lsof lists for it (macOS ships it).
export function describeFds(fds: readonly number[], labels: ReadonlyMap<number, string>): string[] {
	if (process.platform === "linux") {
		return fds.map((fd) => {
			let target = "?";
			try {
				target = fs.readlinkSync(`/proc/self/fd/${fd}`);
			} catch {}
			const label = labels.get(fd);
			return `fd ${fd}${label === undefined ? "" : ` (${label})`}: ${target}`;
		});
	}
	const listed = [...new Set([...fds, ...labels.keys()])].filter((fd) => fd >= 0);
	const args = ["-n", "-P", "-w", "-a", "-p", String(process.pid), "-d", listed.join(",")];
	let output = "";
	try {
		output = execFileSync("lsof", [...args, "-F", "ftdn"], {
			encoding: "utf8",
			stdio: ["ignore", "pipe", "ignore"],
			timeout: 10_000,
		});
	} catch (error) {
		output = String((error as { stdout?: unknown }).stdout ?? "");
	}
	const lines = explainFds(fds, parseLsof(output), labels);
	// Keep the raw lsof lines too, so a rerun can still read the descriptors if the field mapping is
	// wrong (this branch and parseLsof have no macOS coverage until the paid run exercises them).
	const raw = output.trim().replace(/\s*\r?\n\s*/g, " ");
	if (raw !== "") lines.push(`lsof -F ftdn: ${raw.slice(0, 200)}`);
	return lines;
}

// The counts before and after; when they differ, what each new descriptor is.
export function fdChange(
	before: FdTable,
	after: FdTable | null,
	labels: ReadonlyMap<number, string>,
): Fds {
	if (after === null || after.count === before.count) {
		return { before: before.count, after: after?.count ?? null };
	}
	const added = after.open.filter((fd) => !before.open.includes(fd));
	return { before: before.count, after: after.count, added: describeFds(added, labels) };
}

// The first spawn with pipes opens a lasting /dev/null in the hub (libuv); open it before counting.
async function warmUp(): Promise<void> {
	const stdio = [...PLUGIN_STDIO];
	const child = spawn(process.execPath, ["-e", "0"], { stdio, windowsHide: true });
	await new Promise((resolve) => child.once("close", resolve));
}

const violationsOf = (channel: HostChannel): ViolationRecord[] =>
	channel.violations.map(({ kind, detail }) => ({ kind, detail }));

async function channelProbe(config: HubConfig): Promise<ChannelResult> {
	const urls = FETCH_TARGETS.map((target) => target.url);
	const child = plugin(config, "ipc-plugin.mjs", ["serve", JSON.stringify(urls)]);
	stdoutOf(child);
	let outcomes: ChannelResult["outcomes"] = [];
	let fetchDone: () => void = () => {};
	const done = new Promise<void>((resolve) => {
		fetchDone = resolve;
	});
	const channel = attachHostChannel(child, {
		onNotification: (method, params) => {
			const report = params as { event?: string; outcomes?: ChannelResult["outcomes"] };
			if (method === "report" && report.event === "fetch-done") {
				outcomes = report.outcomes ?? [];
				fetchDone();
			}
		},
	});
	const echo = await channel
		.request("plugin/echo", { ping: 1 }, 10_000)
		.then((reply) => (reply.result as { echoed?: { ping?: number } })?.echoed?.ping === 1)
		.catch(() => false);
	await within(done, 10_000, undefined);
	const end = await ended(child, 10_000);
	return {
		roundTrip: echo,
		audit: channel.audit.map(({ reason, port, allow }) => ({ reason, port, allow })),
		outcomes,
		violations: violationsOf(channel),
		pluginEnded: end,
	};
}

async function fuzzProbe(config: HubConfig): Promise<FuzzResult> {
	const mode = config.mode ?? "";
	await warmUp();
	const before = await fdTable();
	const started = performance.now();
	const child = plugin(config, "hostile-channel.mjs", [mode]);
	const labels = new Map([
		[fdOf(child.stdout), "the hub's end of the plugin's stdout"],
		[fdOf(child.stderr), "the hub's end of the plugin's stderr"],
		[fdOf(child.stdio[3]), "the hub's end of fd 3"],
	]);
	const stdout = stdoutOf(child);
	const channel = attachHostChannel(child, {});
	const end = await ended(child, 10_000);
	const exitMs = Math.round(performance.now() - started);
	return {
		mode,
		violations: violationsOf(channel),
		killed: end.signal !== null,
		pluginEnded: end,
		exitMs,
		auditCount: channel.audit.length,
		fds: before === null ? null : fdChange(before, await fdTable(), labels),
		plugin: tagged(stdout()),
	};
}

// Fallback 1: spawn with three pipes and no NODE_CHANNEL_*, so the plugin has no IPC channel until
// it reinstates one over stdout (child_process._forkChild). Then it tries to pass a handle, which
// the hub reads off stdout as a plain stream. Records the hub's descriptor count across the attempt,
// with the same before/after listing and new-descriptor diagnostics the fuzz probe uses.
async function fallback1Probe(config: HubConfig): Promise<Fallback1Result> {
	await warmUp();
	const before = await fdTable();
	const started = performance.now();
	const child = spawnFixture({
		nodeBin: process.execPath,
		pluginDir: config.pluginDir,
		dataDir: config.dataDir,
		grantData: true,
		entry: path.join(config.pluginDir, "hostile-channel.mjs"),
		entryArgs: ["reinstate-send"],
		stdio: ["pipe", "pipe", "pipe"],
		channel: false,
	});
	const labels = new Map([
		[fdOf(child.stdout), "the hub's end of the plugin's stdout (its reinstated channel)"],
		[fdOf(child.stderr), "the hub's end of the plugin's stderr"],
	]);
	child.stdout?.resume();
	const report = stderrReportOf(child);
	const end = await ended(child, 10_000);
	const exitMs = Math.round(performance.now() - started);
	const last = report();
	return {
		reinstated: last?.reinstated === true,
		pluginReport: last,
		pluginEnded: end,
		exitMs,
		fds: before === null ? null : fdChange(before, await fdTable(), labels),
	};
}

// Collects a stream's text, for the plugin's ##DYS2B## reports.
function textOf(stream: NodeJS.ReadableStream): () => string {
	let text = "";
	stream.setEncoding("utf8").on("data", (chunk: string) => {
		text += chunk;
	});
	return () => text;
}

// Waits for the plugin's exit and for every FIFO it writes to close (end-of-file, or the hub's own
// close on a violation), else SIGKILLs it and settles on its exit with closed false.
function fifoEnded(
	child: ChildProcess,
	outputs: readonly net.Socket[],
	timeoutMs: number,
): Promise<PluginEnd> {
	const exited =
		child.exitCode !== null || child.signalCode !== null ? Promise.resolve() : once(child, "exit");
	const closed = Promise.all(
		outputs.map((socket) => (socket.closed ? Promise.resolve() : once(socket, "close"))),
	);
	return new Promise((resolve) => {
		const finish = (all: boolean): void =>
			resolve({ code: child.exitCode, signal: child.signalCode, closed: all });
		const timer = setTimeout(() => {
			child.kill("SIGKILL");
			exited.then(() => finish(false));
		}, timeoutMs);
		Promise.all([exited, closed]).then(() => {
			clearTimeout(timer);
			finish(true);
		});
	});
}

// Counts the bytes a stream delivers, whatever its encoding.
function bytesOf(stream: Readable): () => number {
	let bytes = 0;
	stream.on("data", (chunk: Buffer | string) => {
		bytes += typeof chunk === "string" ? Buffer.byteLength(chunk) : chunk.length;
	});
	return () => bytes;
}

interface TaggedHub {
	readonly io: TaggedStdio;
	// Settles with the outcomes of the plugin's fetch-done report.
	readonly fetched: Promise<unknown>;
	// Every other "report" notification's params, in order.
	readonly notes: readonly Record<string, unknown>[];
}

// Fallback 1's hub side, collecting the plugin's "report" notifications from the host lane.
function taggedHub(child: ChildProcess, input: Writable, output: Readable): TaggedHub {
	const notes: Record<string, unknown>[] = [];
	let settle: (outcomes: unknown) => void = () => {};
	const fetched = new Promise<unknown>((resolve) => {
		settle = resolve;
	});
	const io = attachTaggedStdio(child, input, output, {
		onNotification: (method, params) => {
			if (method !== "report") return;
			const body = params as { event?: string; outcomes?: unknown };
			if (body.event === "fetch-done") settle(body.outcomes ?? []);
			else notes.push(params as Record<string, unknown>);
		},
	});
	return { io, fetched, notes };
}

// The benign exchange on Fallback 1's stdio: an MCP ping on the untagged lane, the hub's
// plugin/echo and the plugin's host/fetch calls on the tagged one.
async function stdioRoundTrip(io: TaggedStdio, report: Promise<unknown>): Promise<StdioRoundTrip> {
	const mcp = (await io.request("ping")) !== null;
	const host = await io.host
		.request("plugin/echo", { ping: 1 }, 10_000)
		.then((reply) => (reply.result as { echoed?: { ping?: number } })?.echoed?.ping === 1)
		.catch(() => false);
	const outcomes = (await within(report, 10_000, [])) as StdioRoundTrip["outcomes"];
	return {
		mcp,
		host,
		audit: io.host.audit.map(({ reason, port, allow }) => ({ reason, port, allow })),
		outcomes,
	};
}

// Fallback 1's benign exchange on spawn's own pipes (socketpairs on POSIX, named pipes on
// Windows), with no fd 3 and no NODE_CHANNEL_*: the FIFO control's round trip, on every OS.
async function fallback1RoundTripProbe(config: HubConfig): Promise<Fallback1RoundTripResult> {
	const child = spawnFixture({
		nodeBin: process.execPath,
		pluginDir: config.pluginDir,
		dataDir: config.dataDir,
		grantData: true,
		entry: path.join(config.pluginDir, "ipc-plugin.mjs"),
		entryArgs: ["stdio-frames", JSON.stringify(FETCH_TARGETS.map((target) => target.url))],
		stdio: ["pipe", "pipe", "pipe"],
		channel: false,
	});
	child.stderr?.resume();
	const { io, fetched } = taggedHub(child, child.stdin as Writable, child.stdout as Readable);
	const roundTrip = await stdioRoundTrip(io, fetched);
	const end = await ended(child, 10_000);
	return {
		roundTrip,
		violations: io.violations.map(({ kind, detail }) => ({ kind, detail })),
		pluginEnded: end,
	};
}

// Before the spawn, every end the hub and the plugin hold must be a FIFO with no name left (nlink
// 0), and the folder the FIFOs were made in must be gone.
function unlinkedBeforeSpawn(fifo: FifoStdio): FifoResult["beforeSpawn"] {
	const ends = [...fifo.pluginFds, ...[fifo.input, ...fifo.outputs].map((socket) => fdOf(socket))];
	const unlinked = ends.filter((fd) => {
		try {
			const stats = fs.fstatSync(fd);
			return stats.isFIFO() && stats.nlink === 0;
		} catch {
			return false;
		}
	});
	return {
		ends: ends.length,
		unlinkedFifos: unlinked.length,
		folderGone: !fs.existsSync(fifo.dir),
	};
}

// Remedy (f): the plugin's stdio on FIFOs (src/fifo-stdio.ts), so no socket joins it to the hub.
// The "stdio" layout is Fallback 1 (no fd 3, no NODE_CHANNEL_*; tagged host frames and MCP on
// stdin/stdout, both lanes under the decoder); "fd3" adds a fourth FIFO as fd 3 with
// NODE_CHANNEL_*. Counts the hub's descriptors across the attempt, as the fuzz probe does, and the
// bytes it reads from each FIFO.
async function fifoProbe(config: HubConfig): Promise<FifoResult> {
	const mode = config.mode ?? "";
	const { layout } = fifoMode(mode);
	await warmUp();
	(await openFifoStdio(1)).destroy();
	const before = await fdTable();
	const started = performance.now();
	const fifo = await openFifoStdio(layout === "fd3" ? 3 : 2);
	const beforeSpawn = unlinkedBeforeSpawn(fifo);
	const benign = mode === "round-trip";
	let child: ChildProcess;
	try {
		child = spawnFixture({
			nodeBin: process.execPath,
			pluginDir: config.pluginDir,
			dataDir: config.dataDir,
			grantData: true,
			entry: path.join(config.pluginDir, benign ? "ipc-plugin.mjs" : "hostile-channel.mjs"),
			entryArgs: benign
				? ["stdio-frames", JSON.stringify(FETCH_TARGETS.map((target) => target.url))]
				: [mode],
			stdio: fifo.pluginFds,
			channel: layout === "fd3",
		});
	} catch (error) {
		fifo.destroy();
		throw error;
	}
	fifo.releasePluginEnds();
	const [stdout, stderr, fd3] = fifo.outputs as [net.Socket, net.Socket, net.Socket | undefined];
	const labels = new Map<number, string>([
		[fdOf(fifo.input), "the hub's end of the plugin's stdin FIFO"],
		[fdOf(stdout), "the hub's end of the plugin's stdout FIFO"],
		[fdOf(stderr), "the hub's end of the plugin's stderr FIFO"],
	]);
	if (fd3 !== undefined) labels.set(fdOf(fd3), "the hub's end of the fd-3 FIFO");
	const read = {
		stdout: bytesOf(stdout),
		stderr: bytesOf(stderr),
		fd3: fd3 === undefined ? () => null : bytesOf(fd3),
	};
	const reports = textOf(layout === "fd3" ? stdout : stderr);
	let violations: () => ViolationRecord[];
	let notes: readonly Record<string, unknown>[] = [];
	let roundTrip: StdioRoundTrip | null = null;
	if (fd3 !== undefined) {
		stderr.resume();
		const channel = channelOver(child, fd3);
		violations = () => violationsOf(channel);
	} else {
		const hub = taggedHub(child, fifo.input, stdout);
		notes = hub.notes;
		violations = () => hub.io.violations.map(({ kind, detail }) => ({ kind, detail }));
		if (benign) roundTrip = await stdioRoundTrip(hub.io, hub.fetched);
	}
	const end = await fifoEnded(child, fifo.outputs, 10_000);
	const exitMs = Math.round(performance.now() - started);
	const closing = [fifo.input, ...fifo.outputs].map((socket) =>
		socket.closed ? Promise.resolve() : once(socket, "close"),
	);
	fifo.destroy();
	await within(Promise.all(closing), 2_000, undefined);
	return {
		mode,
		layout,
		beforeSpawn,
		violations: violations(),
		pluginEnded: end,
		exitMs,
		fds: before === null ? null : fdChange(before, await fdTable(), labels),
		bytesRead: { stdout: read.stdout(), stderr: read.stderr(), fd3: read.fd3() },
		plugin: [...tagged(reports()), ...notes],
		roundTrip,
	};
}

async function lateReplyProbe(config: HubConfig): Promise<LateReplyResult> {
	const child = plugin(config, "ipc-plugin.mjs", ["late"]);
	stdoutOf(child);
	let asked = 0;
	const channel = attachHostChannel(child, {
		onRequest: async () => {
			asked += 1;
			await sleep(300);
			return { value: null };
		},
	});
	const end = await ended(child, 10_000);
	await sleep(700);
	return { asked, droppedWrites: channel.droppedWrites, violations: violationsOf(channel), end };
}

async function sendAfterExitProbe(config: HubConfig): Promise<SendAfterExitResult> {
	const child = plugin(config, "ipc-plugin.mjs", ["exit"]);
	stdoutOf(child);
	const channel = attachHostChannel(child, {});
	const end = await ended(child, 10_000);
	const notified = channel.notify("host/changed", {});
	const request = await channel.request("plugin/ping", {}, 2_000).then(
		() => "answered",
		() => "rejected",
	);
	await sleep(300);
	return { notified, request, droppedWrites: channel.droppedWrites, end };
}

// Node's own parent side: stdio 'ipc' with its internal listeners, no attachHostChannel.
async function controlProbe(config: HubConfig, mode: string): Promise<ControlResult> {
	await warmUp();
	const before = (await fdTable())?.count ?? null;
	const child = spawnFixture({
		nodeBin: process.execPath,
		pluginDir: config.pluginDir,
		dataDir: config.dataDir,
		grantData: true,
		entry: path.join(config.pluginDir, "hostile-channel.mjs"),
		entryArgs: [mode],
		stdio: ["pipe", "pipe", "pipe", "ipc"],
		channel: false,
	});
	const stdout = stdoutOf(child);
	let handlesReceived = 0;
	child.on("message", (_message, handle) => {
		if (handle != null) handlesReceived += 1;
	});
	await sleep(2_500);
	child.kill("SIGKILL");
	const end = await ended(child, 3_000);
	return {
		mode,
		handlesReceived,
		closeEmitted: end.closed,
		fds: before === null ? null : { before, after: (await fdTable())?.count ?? null },
		plugin: tagged(stdout()),
	};
}

const probes: Record<string, (config: HubConfig) => Promise<unknown>> = {
	channel: channelProbe,
	fuzz: fuzzProbe,
	fallback1: fallback1Probe,
	"fallback1-round-trip": fallback1RoundTripProbe,
	fifo: fifoProbe,
	"late-reply": lateReplyProbe,
	"send-after-exit": sendAfterExitProbe,
	"control-malformed": (config) => controlProbe(config, "raw-malformed"),
	"control-fake-ack": (config) => controlProbe(config, "node-ack"),
	"control-handle": (config) => controlProbe(config, "handle-send"),
};

if (import.meta.main) {
	const [name = "", raw = "{}"] = process.argv.slice(2);
	const probe = probes[name];
	if (probe === undefined) {
		process.stderr.write(`hub-probes: unknown probe ${name}\n`);
		process.exit(2);
	}
	const result = await probe(JSON.parse(raw) as HubConfig);
	fs.writeSync(1, `##DYS2BHUB##${JSON.stringify(result)}\n`);
	process.exit(0);
}
