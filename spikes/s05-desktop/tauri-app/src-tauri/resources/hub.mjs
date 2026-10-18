// The stub hub (plan §7 Bundled sidecar), started by the supervisor as
// `draftyak-node --disable-sigusr1 hub.mjs`, with its store folder in DRAFTYAK_DATA_DIR. stdout
// carries only frames (a big-endian u32 length, then UTF-8 JSON): every other writer to it,
// console.* included, goes to stderr. stdin EOF stops the hub. The first frame,
// {masterKey, bootstrapSecret}, opens the SQLite3MC store through nativeBinding with the bundled
// prebuild; the hub then listens on a loopback L2 port, which echoes the supervisor's health
// probe, starts the plugin whose argv DRAFTYAK_SPIKE_PLUGIN_ARGV gives (M0.11's flags) and sends
// {ready, l2Port, hubId}. With DRAFTYAK_SPIKE_IGNORE_EOF=1 it ignores stdin EOF and broken stdout
// and stderr pipes, so that only the Job Object ends it when the app dies. With
// DRAFTYAK_SPIKE_KEEP_AWAKE=1, a "keep-awake <untilMs|null>" line on the L2 port stands in for the
// scheduler: the hub sends {keepAwake: untilMs|null} and answers "ok".
import { spawn } from "node:child_process";
import { createHash, hkdfSync, randomBytes } from "node:crypto";
import { closeSync, openSync, readSync, realpathSync } from "node:fs";
import inspector from "node:inspector";
import { createRequire } from "node:module";
import net from "node:net";
import path from "node:path";

const MAX_FRAME = 1 << 20;
const PLUGIN_REPORT_MS = 10_000;
const PROBE_IDLE_MS = 5_000;
const ignoreEof = process.env.DRAFTYAK_SPIKE_IGNORE_EOF === "1";
const keepAwakeHook = process.env.DRAFTYAK_SPIKE_KEEP_AWAKE === "1";
const state = { db: null, l2: null, plugin: null, started: false, stopping: false };

const writeFrame = process.stdout.write.bind(process.stdout);
process.stdout.write = process.stderr.write.bind(process.stderr);
const log = (message) => process.stderr.write(`hub: ${message}\n`);

function send(frame) {
	const body = Buffer.from(JSON.stringify(frame), "utf8");
	const head = Buffer.alloc(4);
	head.writeUInt32BE(body.length);
	writeFrame(Buffer.concat([head, body]));
}

let pending = Buffer.alloc(0);
process.stdin.on("data", (chunk) => {
	pending = Buffer.concat([pending, chunk]);
	while (pending.length >= 4) {
		const length = pending.readUInt32BE(0);
		if (length > MAX_FRAME) return stop(`a ${length}-byte frame is over the limit`, 2);
		if (pending.length < 4 + length) return;
		const body = pending.subarray(4, 4 + length).toString("utf8");
		pending = pending.subarray(4 + length);
		let frame;
		try {
			frame = JSON.parse(body);
		} catch {
			return stop("a frame isn't JSON", 2);
		}
		receive(frame);
	}
});
if (ignoreEof) {
	process.stdout.on("error", () => {});
	process.stderr.on("error", () => {});
}
process.stdin.on("end", () => {
	if (!ignoreEof) stop("stdin closed", 0);
});

const hex = (value, bytes) => new RegExp(`^(?:[0-9a-f]{2}){${bytes}}$`, "i").test(String(value));

function receive(frame) {
	if (frame === null || typeof frame !== "object") return stop("a frame isn't an object", 2);
	if ("masterKey" in frame) {
		if (state.started) return log("ignoring a second unlock frame");
		state.started = true;
		if (!hex(frame.masterKey, "32") || !hex(frame.bootstrapSecret, "16,64")) {
			return stop("the unlock frame needs a 32-byte masterKey and a 16-64-byte bootstrapSecret", 1);
		}
		start(frame.masterKey).catch((error) => stop(`start failed: ${error.message}`, 1));
	} else if (frame.power === "resumed") {
		log("resumed");
	} else if (frame.shutdown === true) {
		stop("shutdown frame", 0);
	} else {
		log(`ignoring a frame with keys ${Object.keys(frame).join(",")}`);
	}
}

async function start(masterKey) {
	const store = openStore(Buffer.from(masterKey, "hex"));
	state.l2 = net.createServer((socket) => {
		socket.on("error", () => {});
		socket.setTimeout(PROBE_IDLE_MS, () => socket.destroy());
		socket.once("data", (probe) => socket.end((keepAwakeHook && keepAwake(probe)) || probe));
	});
	await new Promise((resolve, reject) => {
		state.l2.once("error", reject).listen(0, "127.0.0.1", resolve);
	});
	const plugin = await startPlugin();
	const report = {
		temporal: typeof globalThis.Temporal,
		temporalNow: typeof globalThis.Temporal?.Now?.instant,
		execArgv: process.execArgv,
		nodeOptions: process.env.NODE_OPTIONS ?? null,
		inspector: inspector.url() ?? null,
		env: Object.keys(process.env).sort(),
		ignoresStdinEof: ignoreEof,
		addon: store.addon,
		plugin,
	};
	log(`report ${JSON.stringify(report)}`);
	send({ ready: true, l2Port: state.l2.address().port, hubId: store.hubId });
}

function openStore(masterKey) {
	const dir = process.env.DRAFTYAK_DATA_DIR;
	if (!dir || !path.isAbsolute(dir)) throw new Error("DRAFTYAK_DATA_DIR names no absolute folder");
	const target = `${process.platform}-${process.arch}`;
	const nativeBinding = path.join(import.meta.dirname, "prebuilds", `${target}.node`);
	const Database = createRequire(import.meta.url)("./sqlite3mc/lib/index.js");
	const file = path.join(dir, "hub.db");
	const db = new Database(file, { nativeBinding });
	state.db = db;
	const key = Buffer.from(hkdfSync("sha256", masterKey, Buffer.alloc(0), "draftyak/v1/db", 32));
	masterKey.fill(0);
	db.pragma("cipher = 'chacha20'");
	db.pragma(`hexkey = '${key.toString("hex")}'`);
	key.fill(0);
	db.prepare("select count(*) from sqlite_master").get();
	db.exec("create table if not exists hub_meta (k text primary key, v blob not null) strict");
	let identity = db.prepare("select v from hub_meta where k = 'identity'").pluck().get();
	if (!identity) {
		identity = randomBytes(32);
		db.prepare("insert into hub_meta (k, v) values ('identity', ?)").run(identity);
	}
	const digest = createHash("sha256").update(identity).digest("hex").slice(0, 16).toUpperCase();
	const versions = db.prepare("select sqlite_version() as lib, sqlite3mc_version() as mc").get();
	return {
		hubId: `DYK-${digest.match(/.{4}/g).join("-")}`,
		addon: {
			target,
			fromResources: loaded(nativeBinding),
			napiVersion: Number(process.versions.napi),
			sqliteVersion: versions.lib,
			sqlite3mcVersion: versions.mc,
			encrypted: !header(file).startsWith("SQLite format 3"),
		},
	};
}

// Windows lists loaded modules as \\?\C:\…, in any letter case.
const fold = (file) => {
	const resolved = path.resolve(file.replace(/^\\\\\?\\/, ""));
	return process.platform === "win32" ? resolved.toLowerCase() : resolved;
};
const loaded = (file) =>
	process.report
		.getReport()
		.sharedObjects.map(fold)
		.includes(fold(realpathSync(file)));

function header(file) {
	const fd = openSync(file, "r");
	try {
		const bytes = Buffer.alloc(16);
		readSync(fd, bytes, 0, bytes.length, 0);
		return bytes.toString("latin1");
	} finally {
		closeSync(fd);
	}
}

function keepAwake(line) {
	const until = /^keep-awake (\d{1,15}|null)\n$/.exec(String(line))?.[1];
	if (until === undefined) return null;
	send({ keepAwake: until === "null" ? null : Number(until) });
	return "ok\n";
}

function startPlugin() {
	const raw = process.env.DRAFTYAK_SPIKE_PLUGIN_ARGV;
	if (!raw) return Promise.resolve(null);
	const argv = JSON.parse(raw);
	if (
		!Array.isArray(argv) ||
		argv[0] !== "--permission" ||
		argv.some((arg) => typeof arg !== "string")
	) {
		throw new Error(
			"DRAFTYAK_SPIKE_PLUGIN_ARGV is a JSON array of strings starting with --permission",
		);
	}
	const env =
		process.platform === "win32" ? { SystemRoot: process.env.SystemRoot ?? "C:\\Windows" } : {};
	const child = spawn(process.execPath, argv, {
		env,
		stdio: ["pipe", "ignore", "pipe", "ipc"],
		windowsHide: true,
	});
	state.plugin = child;
	child.stderr.on("data", (chunk) => log(`plugin: ${String(chunk).trimEnd()}`));
	child.on("exit", (code, signal) => log(`plugin exited (${code ?? signal})`));
	return new Promise((resolve, reject) => {
		const timer = setTimeout(
			() => reject(new Error(`the plugin didn't report within ${PLUGIN_REPORT_MS} ms`)),
			PLUGIN_REPORT_MS,
		);
		child.once("message", (message) => {
			clearTimeout(timer);
			resolve({ pid: child.pid, execArgv: message?.execArgv ?? null });
		});
		child.once("error", reject);
		child.once("exit", (code) => reject(new Error(`the plugin exited with ${code}`)));
	});
}

function stop(reason, code) {
	if (state.stopping) return;
	state.stopping = true;
	log(`stopping (${reason})`);
	state.plugin?.kill();
	state.l2?.close();
	state.db?.close();
	process.exitCode = code;
	writeFrame("", () => process.exit(code));
}
