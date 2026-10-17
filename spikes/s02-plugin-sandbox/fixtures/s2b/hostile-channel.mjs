// A hostile plugin on the fd-3 host channel, under the production argv. Each mode (argv[2]) attacks
// the hub's side of the channel once; the hub must survive and kill the plugin. A plugin always has
// raw byte access to fd 3: fs.writeSync isn't permission-gated, and the IPC fd is exempt from the
// fd-adoption gate. Windows frames each IPC message behind libuv's 16-byte header, so raw payloads
// are framed there unless a mode attacks the framing itself. Reports facts on stdout (##DYS2B##).
import fs from "node:fs";
import net from "node:net";

const mode = process.argv[2] ?? "";
const windows = process.platform === "win32";
const emit = (object) => fs.writeSync(1, `##DYS2B##${JSON.stringify({ mode, ...object })}\n`);
const sleep = new Int32Array(new SharedArrayBuffer(4));

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
		for (const shape of [
			{ cmd: "NODE_HANDLE", type: "net.Socket", msg: { fuzz: 1 } },
			{ cmd: "NODE_HANDLE", type: "net.Server", msg: { fuzz: 2 } },
			{ cmd: "NODE_HANDLE_ACK" },
			{ cmd: "NODE_HANDLE_NACK" },
			{ cmd: "NODE_CLUSTER", act: "queryServer" },
		]) {
			process.send(shape);
		}
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
	// Its own stdout pipe, ten times: resetting _handleQueue skips Node's wait for each ACK.
	"handle-send": () => {
		const failures = [];
		const failed = (error) => error && failures.push(error.code ?? error.name);
		for (let i = 0; i < 10; i++) {
			try {
				process._handleQueue = null;
				const message = { jsonrpc: "2.0", method: "host/log", params: { i } };
				process.send(message, process.stdout, { keepOpen: true }, failed);
			} catch (error) {
				failed(error);
			}
		}
		setTimeout(() => emit({ attempted: 10, failed: failures.length, code: failures[0] ?? null }), 300);
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
