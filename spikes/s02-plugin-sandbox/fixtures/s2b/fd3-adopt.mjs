// Tries to adopt an inherited fd as a raw socket: `new net.Socket({fd: 3})`. The host spawns this
// with fd 3 as a plain inherited pipe (NOT the ipc channel) under the production argv, so the
// result reports on stdout. Plan §4: since Node 26.11 this needs --allow-net under --permission,
// which is why the host channel uses the exempt IPC channel and never a raw fd socket. On the
// minimum Node (26.5.1, pre-26.11) the adoption is not gated — S2b records that difference.
import fs from "node:fs";
import net from "node:net";

function emit(object) {
	fs.writeSync(1, `##DYS2B##${JSON.stringify(object)}\n`);
}

let result;
try {
	const socket = new net.Socket({ fd: 3 });
	result = { outcome: "adopted", type: socket.constructor.name };
	try {
		socket.destroy();
	} catch {
		// ignore
	}
} catch (error) {
	result = { outcome: "denied", code: error.code ?? null, name: error.constructor.name };
}
emit({ probe: "fd3-adopt", node: process.versions.node, ...result });
setTimeout(() => process.exit(0), 50);
