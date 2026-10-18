// The stand-in hub for S2b's host-channel probes: `node --expose-gc hub-probes.ts <probe> <config>`
// spawns a plugin on its own Node the way the hub does (spawnPlugin, then attachHostChannel), prints
// one ##DYS2BHUB## line and exits 0. A probe that crashes this process prints nothing and exits
// non-zero, which is how runHubProbe judges survival. The control-* probes use Node's own stdio
// 'ipc' parent side instead, to show why the hub doesn't.
import { type ChildProcess, spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { attachHostChannel, type HostChannel } from "../src/host-channel.ts";
import { PLUGIN_STDIO, spawnPlugin } from "../src/spawn.ts";
import {
	type ChannelResult,
	type ControlResult,
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

// Open descriptors on POSIX (null on Windows), after a first spawn has opened libuv's lazy ones.
async function fdCount(): Promise<number | null> {
	const dir = process.platform === "linux" ? "/proc/self/fd" : "/dev/fd";
	if (process.platform === "win32" || !fs.existsSync(dir)) return null;
	(globalThis as { gc?: () => void }).gc?.();
	await sleep(100);
	return fs.readdirSync(dir).length;
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
	const before = await fdCount();
	const started = performance.now();
	const child = plugin(config, "hostile-channel.mjs", [mode]);
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
		fds: before === null ? null : { before, after: await fdCount() },
		plugin: tagged(stdout()),
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
	const before = await fdCount();
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
		fds: before === null ? null : { before, after: await fdCount() },
		plugin: tagged(stdout()),
	};
}

const probes: Record<string, (config: HubConfig) => Promise<unknown>> = {
	channel: channelProbe,
	fuzz: fuzzProbe,
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
