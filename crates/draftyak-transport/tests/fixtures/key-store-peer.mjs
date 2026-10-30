import { createHash, X509Certificate } from "node:crypto";
import { createServer } from "node:tls";

const sockets = new Set();
let server;
let configured = false;
let pending = Buffer.alloc(0);
const counts = { connections: 0, rejected: 0, accepted: 0, http: 0, websocket: 0 };
const emit = (value) => process.stdout.write(`${JSON.stringify(value)}\n`);
const digest = (bytes) => createHash("sha256").update(bytes).digest("hex");

function start(config) {
	if (!config || Object.keys(config).sort().join(",") !== "allowed,cert,key" ||
		typeof config.cert !== "string" || typeof config.key !== "string" ||
		typeof config.allowed !== "string" || !/^[0-9a-f]{64}$/.test(config.allowed)) {
		throw new Error("invalid synthetic peer configuration");
	}
	server = createServer({ key: config.key, cert: config.cert, requestCert: true,
		rejectUnauthorized: false, minVersion: "TLSv1.3", maxVersion: "TLSv1.3" }, (socket) => {
		counts.connections++;
		sockets.add(socket);
		socket.on("error", () => {});
		socket.once("close", () => { sockets.delete(socket); emit({ event: "closed" }); });
		let actual;
		try {
			const raw = socket.getPeerCertificate().raw;
			actual = raw ? digest(new X509Certificate(raw).publicKey.export({ type: "spki", format: "der" })) : null;
		} catch { actual = null; }
		if (actual !== config.allowed) {
			counts.rejected++;
			emit({ event: "rejected" });
			socket.destroy();
			return;
		}
		counts.accepted++;
		emit({ event: "accepted", exactStoredSpki: true });
		let bytes = Buffer.alloc(0);
		let upgraded = false;
		let answered = false;
		socket.on("data", (chunk) => {
			if (bytes.length + chunk.length > 18000) return socket.destroy();
			bytes = Buffer.concat([bytes, chunk]);
			if (upgraded) {
				// These controls send only the client's bounded masked close frame.
				if (bytes.length < 2) return;
				const length = bytes[1] & 127;
				if ((bytes[0] & 15) !== 8 || length > 125 || !(bytes[1] & 128)) return socket.destroy();
				if (bytes.length < 6 + length) return;
				socket.end(Buffer.from([0x88, 0]));
				bytes = Buffer.alloc(0);
				return;
			}
			if (answered) return socket.destroy();
			const end = bytes.indexOf("\r\n\r\n");
			if (end < 0) return;
			const lines = bytes.subarray(0, end).toString("ascii").split("\r\n");
			const first = lines.shift();
			const headers = new Map();
			for (const line of lines) {
				const colon = line.indexOf(":");
				if (colon < 1) return socket.destroy();
				const name = line.slice(0, colon).toLowerCase();
				if (headers.has(name)) return socket.destroy();
				headers.set(name, line.slice(colon + 1).trim());
			}
			if (first === "GET /stored-ws HTTP/1.1") {
				const key = headers.get("sec-websocket-key");
				if (!key || Buffer.from(key, "base64").length !== 16 || headers.get("upgrade")?.toLowerCase() !== "websocket") return socket.destroy();
				const accept = createHash("sha1").update(`${key}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`).digest("base64");
				counts.websocket++;
				upgraded = true;
				bytes = bytes.subarray(end + 4);
				const response = Buffer.from(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);
				const message = Buffer.from("DYTEST-STORED-WS");
				socket.write(Buffer.concat([response, Buffer.from([0x81, message.length]), message]));
				emit({ event: "websocket" });
				return;
			}
			if (first !== "POST /stored-http HTTP/1.1") return socket.destroy();
			const length = headers.get("content-length");
			if (!length || !/^(?:0|[1-9][0-9]{0,3})$/.test(length) || Number(length) > 1024) return socket.destroy();
			if (bytes.length < end + 4 + Number(length)) return;
			counts.http++;
			answered = true;
			const response = Buffer.from("DYTEST-STORED-HTTP");
			socket.end(Buffer.concat([Buffer.from(`HTTP/1.1 200 OK\r\nContent-Length: ${response.length}\r\nConnection: close\r\n\r\n`), response]));
			emit({ event: "http" });
		});
	});
	server.on("tlsClientError", () => {});
	server.on("error", () => { process.stderr.write("synthetic key-store peer failed\n"); process.exit(1); });
	server.listen(0, "127.0.0.1", () => emit({ event: "ready", port: server.address().port }));
}
function line(value) {
	if (!configured) { configured = true; start(JSON.parse(value.toString("utf8"))); return; }
	if (value.toString("ascii") !== "stop" || !server) throw new Error("invalid synthetic peer command");
	for (const socket of sockets) socket.destroy();
	server.close(() => emit({ event: "stopped", ...counts }));
	process.stdin.destroy();
}
process.stdin.on("data", (chunk) => {
	try {
		if (pending.length + chunk.length > 32768) throw new Error("synthetic peer input bound");
		pending = Buffer.concat([pending, chunk]);
		let end;
		while ((end = pending.indexOf(10)) >= 0) {
			const next = pending.subarray(0, end);
			pending = pending.subarray(end + 1);
			line(next);
		}
	} catch { process.stderr.write("synthetic key-store peer failed\n"); process.exit(1); }
});
