import { execFile } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";

// Remedy (f) for ADR 0003's macOS descriptor leak: a plugin's stdio on named FIFOs instead of the
// socketpairs libuv makes for every 'pipe' (uv__process_init_stdio). macOS installs a descriptor
// sent over a UNIX socket in the reader's table even when the reader uses plain read(2), as the
// hub does; a FIFO is not a socket, so the plugin's sendmsg() with SCM_RIGHTS fails (ENOTSOCK) and
// nothing the hub reads can carry a descriptor. POSIX only: Windows has no FIFOs, and its pipes
// carry no descriptors to a reader that never asks for them.

const MKFIFO = ["/usr/bin/mkfifo", "/bin/mkfifo"];
const { O_RDONLY, O_WRONLY, O_NONBLOCK } = fs.constants;

export interface FifoStdio {
	// The 0700 folder the FIFOs were made in; it is gone, with their names, once this is returned.
	readonly dir: string;
	// The plugin's ends, for spawn's stdio: fd 0 (it reads), then fd 1 and up (it writes).
	readonly pluginFds: readonly number[];
	// The hub's ends: it writes the plugin's stdin and reads every other FIFO.
	readonly input: net.Socket;
	readonly outputs: readonly net.Socket[];
	// Closes the hub's copies of the plugin's ends, so a FIFO reaches end-of-file once the plugin
	// is gone; call it as soon as spawn has returned.
	releasePluginEnds(): void;
	destroy(): void;
}

function mkfifo(paths: readonly string[]): Promise<void> {
	const bin = MKFIFO.find((candidate) => fs.existsSync(candidate));
	if (bin === undefined) return Promise.reject(new Error("FIFO stdio needs /usr/bin/mkfifo"));
	return new Promise((resolve, reject) => {
		execFile(bin, ["-m", "600", "--", ...paths], { env: {}, timeout: 10_000 }, (error) =>
			error ? reject(error) : resolve(),
		);
	});
}

// Makes `outputs + 1` FIFOs in a fresh 0700 folder (mkdtemp) under `parent`, opens both ends of
// each without ever blocking, and unlinks them, so only descriptors remain. A FIFO's writer can
// open non-blocking only once a reader has it open, so each reader opens first: the hub reads
// stdout and the rest, and a short-lived reader lets the hub open the plugin's stdin non-blocking.
// The plugin's ends are blocking descriptors, as a socketpair's are; the hub's are non-blocking.
// `parent` must be writable at every spawn: the hub passes a folder of its own rather than the
// system temp dir, which a read-only service setup may not have.
export async function openFifoStdio(outputs = 2, parent: string = os.tmpdir()): Promise<FifoStdio> {
	if (process.platform === "win32") throw new Error("FIFO stdio needs Linux or macOS");
	const dir = fs.mkdtempSync(path.join(parent, "dy-fifo-"));
	const [stdin = "", ...rest] = [
		"in",
		...Array.from({ length: outputs }, (_, i) => `out${i + 1}`),
	].map((name) => path.join(dir, name));
	const owned: number[] = [];
	const sockets: net.Socket[] = [];
	const open = (file: string, flags: number): number => {
		const fd = fs.openSync(file, flags);
		owned.push(fd);
		return fd;
	};
	// A broken FIFO only ends its stream; it never surfaces as an unhandled 'error' in the hub.
	const wrap = (fd: number, readable: boolean): net.Socket => {
		const socket = new net.Socket({ fd, readable, writable: !readable }).on("error", () => {});
		owned.splice(owned.indexOf(fd), 1);
		sockets.push(socket);
		return socket;
	};
	let pluginFds: number[];
	try {
		await mkfifo([stdin, ...rest]);
		const probe = open(stdin, O_RDONLY | O_NONBLOCK);
		const hubIn = open(stdin, O_WRONLY | O_NONBLOCK);
		pluginFds = [open(stdin, O_RDONLY)];
		fs.closeSync(probe);
		owned.splice(owned.indexOf(probe), 1);
		const hubOuts = rest.map((name) => {
			const hub = open(name, O_RDONLY | O_NONBLOCK);
			pluginFds.push(open(name, O_WRONLY));
			return hub;
		});
		wrap(hubIn, false);
		for (const fd of hubOuts) wrap(fd, true);
	} catch (error) {
		for (const socket of sockets) socket.destroy();
		for (const fd of owned) fs.closeSync(fd);
		throw error;
	} finally {
		fs.rmSync(dir, { recursive: true, force: true });
	}
	const [input, ...outputSockets] = sockets as [net.Socket, ...net.Socket[]];
	let released = false;
	const releasePluginEnds = (): void => {
		if (released) return;
		released = true;
		for (const fd of pluginFds) fs.closeSync(fd);
	};
	return {
		dir,
		pluginFds,
		input,
		outputs: outputSockets,
		releasePluginEnds,
		destroy() {
			releasePluginEnds();
			for (const socket of sockets) socket.destroy();
		},
	};
}
