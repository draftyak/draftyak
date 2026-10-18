// A hostile plugin on the fd-3 host channel, under the production argv. Each mode (argv[2]) attacks
// the hub's side of the channel once; the hub must survive and kill the plugin. A plugin always has
// raw byte access to fd 3: fs.writeSync isn't permission-gated, and the IPC fd is exempt from the
// fd-adoption gate. Windows frames each IPC message behind libuv's 16-byte header, so raw payloads
// are framed there unless a mode attacks the framing itself. The same modes run over socketpairs
// and over FIFOs (the hub picks the stdio). Reports facts on stdout (##DYS2B##), on stderr where
// stdout is the reinstated channel, and as a host frame on stdout where stderr is.
import cp from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import util from "node:util";

const mode = process.argv[2] ?? "";
const windows = process.platform === "win32";
// reinstate-stderr makes fd 2 its IPC channel and reports as a tagged JSON-RPC notification on
// stdout, which the hub decodes as Fallback 1's host lane; the other reinstate-* modes make fd 1 the
// channel and report on fd 2.
const emit = (object) => {
	const report = { mode, ...object };
	if (mode === "reinstate-stderr") {
		const frame = { jsonrpc: "2.0", method: "report", params: report };
		fs.writeSync(1, `\x1e${JSON.stringify(frame)}\n`);
	} else {
		fs.writeSync(mode.startsWith("reinstate-") ? 2 : 1, `##DYS2B##${JSON.stringify(report)}\n`);
	}
};
const sleep = new Int32Array(new SharedArrayBuffer(4));
const NODE_SHAPES = [
	{ cmd: "NODE_HANDLE", type: "net.Socket", msg: { fuzz: 1 } },
	{ cmd: "NODE_HANDLE", type: "net.Server", msg: { fuzz: 2 } },
	{ cmd: "NODE_HANDLE_ACK" },
	{ cmd: "NODE_HANDLE_NACK" },
	{ cmd: "NODE_CLUSTER", act: "queryServer" },
];

const errorName = (status) => {
	try {
		return util.getSystemErrorName(status);
	} catch {
		return String(status);
	}
};

// What the OS answered each write that carried a handle: "ok", or the error name. Node calls a
// process.send callback with null even when that write fails, so this wraps the channel's own
// write (process[kChannelHandle].writeUtf8String) and its completion. Observes only.
function watchHandleSends() {
	const statuses = [];
	const key = Object.getOwnPropertySymbols(process).find((s) => s.description === "kChannelHandle");
	const channel = key === undefined ? undefined : process[key];
	if (typeof channel?.writeUtf8String !== "function") return statuses;
	const write = channel.writeUtf8String;
	channel.writeUtf8String = function (req, string, handle) {
		const error = write.call(this, req, string, handle);
		if (handle && error !== 0) statuses.push(errorName(error));
		else if (handle) {
			process.nextTick(() => {
				const done = req.oncomplete;
				req.oncomplete = (status, ...rest) => {
					statuses.push(status === 0 ? "ok" : errorName(status));
					return done?.call(req, status, ...rest);
				};
			});
		}
		return error;
	};
	return statuses;
}

// Ten sends of `handle`; resetting _handleQueue skips Node's wait for each ACK.
function sendHandles(handle, failed) {
	for (let i = 0; i < 10; i++) {
		try {
			process._handleQueue = null;
			const message = { jsonrpc: "2.0", method: "host/log", params: { i } };
			process.send(message, handle, { keepOpen: true }, failed);
		} catch (error) {
			failed(error);
		}
	}
}

// Fallback 1 (no fd 3, no NODE_CHANNEL_*): process.send starts undefined, but child_process
// ._forkChild (internal, not gated by --permission) makes any inherited pipe, such as fd 1
// (stdout) or fd 2 (stderr), an IPC channel.
function reinstate(fd) {
	try {
		cp._forkChild(fd, "json");
	} catch (error) {
		emit({ reinstated: false, code: error.code ?? error.name });
		return false;
	}
	return typeof process.send === "function";
}

// Reinstates process.send over `fd`, then sends its own stdin ten times; the hub reads that fd as a
// plain stream.
function reinstateAndSend(fd) {
	const reinstated = reinstate(fd);
	const failures = [];
	const failed = (error) => error && failures.push(error.code ?? error.name);
	const sendStatus = reinstated ? watchHandleSends() : [];
	if (reinstated) sendHandles(process.stdin, failed);
	setTimeout(() => {
		const code = failures[0] ?? null;
		emit({ reinstated, attempted: 10, failed: failures.length, code, sendStatus });
	}, 300);
}

function header(flags, length) {
	const head = Buffer.alloc(16);
	head.writeUInt32LE(flags, 0);
	head.writeUInt32LE(length, 8);
	return head;
}
const frame = (payload) => (windows ? Buffer.concat([header(1, payload.length), payload]) : payload);

// fd 3 is non-blocking on POSIX (libuv), so a full pipe answers EAGAIN: wait and retry.
function writeRaw(bytes) {
	let offset = 0;
	while (offset < bytes.length) {
		try {
			offset += fs.writeSync(3, bytes, offset);
		} catch (error) {
			if (error.code !== "EAGAIN") throw error;
			Atomics.wait(sleep, 0, 0, 2);
		}
	}
}

const attacks = {
	"node-internal": () => {
		for (const shape of NODE_SHAPES) process.send(shape);
	},
	"node-ack": () => process.send({ cmd: "NODE_HANDLE_ACK" }),
	"raw-garbage": () => writeRaw(Buffer.from("this is not json\n")),
	"raw-malformed": () => writeRaw(frame(Buffer.from("this is not json\n"))),
	"raw-socket": () => {
		let socket;
		try {
			socket = new net.Socket({ fd: 3 });
		} catch (error) {
			emit({ adopted: false, code: error.code ?? error.name });
			return;
		}
		emit({ adopted: true });
		socket.on("error", () => {});
		socket.write(frame(Buffer.from("socket junk\n")));
	},
	oversize: () => {
		process.send({ jsonrpc: "2.0", method: "host/log", params: { text: "x".repeat(2 << 20) } });
	},
	unterminated: () => {
		const piece = Buffer.alloc(64 << 10, 0x78);
		for (let sent = 0; sent < 2 << 20; sent += piece.length) writeRaw(frame(piece));
	},
	"xfer-frame": () => writeRaw(Buffer.concat([header(0x3, 0), Buffer.alloc(632, 0x41)])),
	"bad-header": () => writeRaw(header(0x10, 8)),
	// Its own stdout pipe, ten times, over the fd-3 channel.
	"handle-send": () => {
		const failures = [];
		const failed = (error) => error && failures.push(error.code ?? error.name);
		const sendStatus = watchHandleSends();
		sendHandles(process.stdout, failed);
		setTimeout(
			() => emit({ attempted: 10, failed: failures.length, code: failures[0] ?? null, sendStatus }),
			300,
		);
	},
	// Fallback 1: the handle sends over a reinstated stdout, or over a reinstated stderr.
	"reinstate-send": () => reinstateAndSend(1),
	"reinstate-stderr": () => reinstateAndSend(2),
	// Fallback 1: reinstates process.send over stdout and sends Node's internal shapes there, with
	// no descriptor: what the hub's decoder on stdout must refuse.
	"reinstate-internal": () => {
		const reinstated = reinstate(1);
		emit({ reinstated });
		if (reinstated) for (const shape of NODE_SHAPES) process.send(shape);
	},
	"ignore-sigterm": () => {
		process.on("SIGTERM", () => emit({ ignoredSigterm: true }));
		process.send({ cmd: "NODE_HANDLE_ACK" });
		let id = 1;
		setInterval(() => {
			const params = { url: "https://example.com/" };
			process.send({ jsonrpc: "2.0", id: id++, method: "host/fetch", params }, () => {});
		}, 100);
	},
};

process.on("error", () => {});
const attack = attacks[mode];
if (attack === undefined) {
	emit({ unknownMode: true });
	process.exit(2);
}
try {
	attack();
	emit({ attacked: true });
} catch (error) {
	emit({ attacked: false, code: error.code ?? error.name });
}
setInterval(() => {}, 1000);
if (mode !== "ignore-sigterm") setTimeout(() => process.exit(0), 3000);
