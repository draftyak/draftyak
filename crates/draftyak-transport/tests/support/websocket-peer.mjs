import { createHash, X509Certificate } from "node:crypto";
import { createServer } from "node:tls";

const sockets = new Set();
let server;
let config;
let lines = "";
let requests = 0;
let applicationBytes = 0;
let frames = 0;
let connections = 0;
const emit = (value) => process.stdout.write(`${JSON.stringify(value)}\n`);
const digest = (value) => createHash("sha256").update(value).digest("hex");

function frame(spec) {
	const payload =
		spec.hex !== undefined
			? Buffer.from(spec.hex, "hex")
			: spec.text === undefined
				? Buffer.alloc(spec.length ?? 0, spec.byte ?? 255)
				: Buffer.from(spec.text);
	const length = spec.declared ?? payload.length;
	const extended = length < 126 ? 0 : length <= 65535 ? 2 : 8;
	const header = Buffer.alloc(2 + extended + (spec.masked ? 4 : 0));
	header[0] = (spec.fin === false ? 0 : 128) | (spec.rsv ?? 0) | spec.opcode;
	header[1] = (spec.masked ? 128 : 0) | (extended === 0 ? length : extended === 2 ? 126 : 127);
	if (extended === 2) header.writeUInt16BE(length, 2);
	if (extended === 8) header.writeBigUInt64BE(BigInt(length), 2);
	return spec.headerOnly ? header : Buffer.concat([header, payload]);
}

function serve(socket) {
	const timers = new Set();
	connections += 1;
	sockets.add(socket);
	socket.on("error", () => {});
	socket.on("close", () => {
		for (const timer of timers) clearTimeout(timer);
		sockets.delete(socket);
		emit({ event: "socket-closed" });
	});
	const cert = socket.getPeerCertificate();
	emit({
		event: "tls",
		version: socket.getProtocol(),
		clientPin: cert.raw
			? digest(new X509Certificate(cert.raw).publicKey.export({ type: "spki", format: "der" }))
			: null,
	});
	let header = Buffer.alloc(0);
	let incoming = Buffer.alloc(0);
	let upgraded = false;
	socket.on("data", (data) => {
		applicationBytes += data.length;
		if (!upgraded) {
			header = Buffer.concat([header, data]);
			if (header.length > 32768) return socket.destroy();
			const end = header.indexOf("\r\n\r\n");
			if (end === -1) return;
			requests += 1;
			const text = header.subarray(0, end).toString("ascii");
			const [first, ...rows] = text.split("\r\n");
			const fields = new Map(
				rows.map((row) => {
					const colon = row.indexOf(":");
					return [row.slice(0, colon).toLowerCase(), row.slice(colon + 1).trim()];
				}),
			);
			emit({
				event: "upgrade",
				target: first.split(" ")[1],
				host: fields.get("host"),
				protocol: fields.get("sec-websocket-protocol") ?? null,
			});
			if (config.mode === "silent-upgrade") return;
			const accept = createHash("sha1")
				.update(`${fields.get("sec-websocket-key")}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`)
				.digest("base64");
			let response;
			if (config.status) {
				response = `HTTP/1.1 ${config.status} Refused\r\nContent-Length: 1000000000\r\nLocation: https://elsewhere.invalid/\r\n\r\n`;
			} else {
				response = `HTTP/1.1 101 Switching Protocols\r\n${config.mode === "missing-upgrade" ? "" : "Upgrade: websocket\r\n"}Connection: Upgrade\r\nSec-WebSocket-Accept: ${config.mode === "bad-accept" ? "invalid" : accept}\r\n`;
				const protocol =
					config.selection === undefined ? fields.get("sec-websocket-protocol") : config.selection;
				if (protocol) response += `Sec-WebSocket-Protocol: ${protocol}\r\n`;
				if (config.duplicateProtocol) response += `Sec-WebSocket-Protocol: ${protocol}\r\n`;
				if (config.extension) response += `Sec-WebSocket-Extensions: ${config.extension}\r\n`;
				if (config.headerBytes) {
					const padding = config.headerBytes - Buffer.byteLength(response) - 11;
					if (padding < 0 || padding > 20000) throw new Error("invalid fixture header budget");
					response += `X-Pad: ${"x".repeat(padding)}\r\n`;
				}
				response += "\r\n";
			}
			upgraded = true;
			const firstFrames = (config.frames ?? []).map(frame);
			const responseBytes = Buffer.concat([Buffer.from(response), ...firstFrames]);
			if (config.headerSplit) {
				socket.write(responseBytes.subarray(0, config.headerSplit));
				const timer = setTimeout(
					() => socket.write(responseBytes.subarray(config.headerSplit)),
					30,
				);
				timers.add(timer);
			} else socket.write(responseBytes);
			header = Buffer.alloc(0);
			if (config.mode === "backpressure") socket.pause();
			return;
		}
		incoming = Buffer.concat([incoming, data]);
		if (incoming.length > 140000) return socket.destroy();
		while (incoming.length >= 2) {
			const opcode = incoming[0] & 15;
			const masked = (incoming[1] & 128) !== 0;
			let length = incoming[1] & 127;
			let offset = 2;
			if (length === 126) {
				if (incoming.length < 4) return;
				length = incoming.readUInt16BE(2);
				offset = 4;
			} else if (length === 127) {
				if (incoming.length < 10) return;
				const size = incoming.readBigUInt64BE(2);
				if (size > 140000n) return socket.destroy();
				length = Number(size);
				offset = 10;
			}
			const mask = masked ? 4 : 0;
			if (incoming.length < offset + mask + length) return;
			const payload = Buffer.from(incoming.subarray(offset + mask, offset + mask + length));
			if (masked) for (let i = 0; i < length; i++) payload[i] ^= incoming[offset + (i % 4)];
			incoming = incoming.subarray(offset + mask + length);
			frames += 1;
			emit({ event: "frame", opcode, length, masked, digest: digest(payload) });
			if (opcode === 8) {
				if (config.mode === "chatty-close") {
					for (let i = 1; i <= 20; i++) {
						const timer = setTimeout(() => {
							if (i === 20) socket.write(frame({ opcode: 8, length: 0 }), () => socket.end());
							else socket.write(frame({ opcode: 10, length: 1 }));
						}, i * 30);
						timers.add(timer);
					}
				} else if (config.mode !== "silent-close")
					socket.write(frame({ opcode: 8, length: 0 }), () => socket.end());
			} else if (opcode === 9) {
				socket.write(Buffer.concat([Buffer.from([138, length]), payload]));
			} else if (config.mode === "echo" && (opcode === 1 || opcode === 2)) {
				const echoed = frame({ opcode, length });
				payload.copy(echoed, echoed.length - length);
				socket.write(echoed);
			}
		}
	});
}

function start(value) {
	config = value;
	server = createServer(
		{
			cert: config.cert,
			key: config.key,
			requestCert: true,
			rejectUnauthorized: false,
			minVersion: "TLSv1.3",
			maxVersion: "TLSv1.3",
			ALPNProtocols: ["http/1.1"],
		},
		serve,
	);
	server.on("tlsClientError", () => {});
	server.on("error", () => process.exit(2));
	server.listen(0, "127.0.0.1", () => emit({ event: "ready", port: server.address().port }));
}

function stop() {
	for (const socket of sockets) socket.destroy();
	server.close(() => {
		emit({ event: "stopped", requests, applicationBytes, frames, connections });
		process.stdin.destroy();
	});
}
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
	lines += chunk;
	if (lines.length > 32768) return process.exit(2);
	let end = lines.indexOf("\n");
	while (end !== -1) {
		const line = lines.slice(0, end);
		lines = lines.slice(end + 1);
		if (!config) start(JSON.parse(line));
		else if (line === "stop") stop();
		else process.exit(2);
		end = lines.indexOf("\n");
	}
});
