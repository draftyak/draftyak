import { execFile } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";

// Remedy (f) for ADR 0003's macOS descriptor leak: a plugin's stdio on named FIFOs instead of the
// socketpairs libuv makes for every 'pipe' (uv__process_init_stdio). macOS installs a descriptor
// sent over a UNIX socket in the reader's table even when the reader uses plain read(2), as the
// hub does; a FIFO is not a socket, so the plugin's sendmsg() with SCM_RIGHTS fails (ENOTSOCK) and
// nothing the hub reads can carry a descriptor. POSIX only: Windows has no FIFOs, and its pipes
// carry no descriptors to a reader that never asks for them.
//
// libuv reads a stream only when the kernel says it is readable. Linux's epoll reports a FIFO's
// last writer closing, so the stream ends. Read from XNU's source, its kqueue filter for a FIFO
// (filt_vnode_common) reports only the unread byte count, and nothing wakes it when the last writer
// closes, so on macOS a FIFO would never end through libuv. The hub therefore ends the outputs at
// the plugin's exit: drain() reads what is left straight from each descriptor, without blocking,
// until read(2) returns 0, which a FIFO returns only once no writer is left.

const MKFIFO = ["/usr/bin/mkfifo", "/bin/mkfifo"];
const { O_RDONLY, O_WRONLY, O_NONBLOCK } = fs.constants;
// Far more than a FIFO holds: a drain that reads this much has a writer still feeding it.
const DRAIN_LIMIT = 4 << 20;

export interface FifoDrain {
	// Bytes the drain read and delivered to the output.
	readonly bytes: number;
	// "eof": read(2) returned 0, so no writer is left, and the output ended. "closed": it had
	// already ended or been closed, or a consumer closed it during the drain. "EAGAIN": a writer is
	// still open, and it stays open. "limit": a writer kept it full, and it stays open. Any other
	// errno code closes it.
	readonly result: string;
}

export interface FifoStdio {
	// The 0700 folder the FIFOs were made in; it is gone, with their names, once this is returned.
	readonly dir: string;
	// The plugin's ends, for spawn's stdio: fd 0 (it reads), then fd 1 and up (it writes).
	readonly pluginFds: readonly number[];
	// The hub's ends: its write end of the plugin's stdin, then the read end of each output.
	readonly hubFds: readonly number[];
	readonly input: net.Socket;
	// What the plugin writes on fd 1 and up, with backpressure: a consumer that stops reading stops
	// libuv's reads, and then the plugin's writes. Each ends at its FIFO's end-of-file, when libuv
	// sees it (Linux) or through drain().
	readonly outputs: readonly Readable[];
	// Closes the hub's copies of the plugin's ends, so that once the plugin is gone no writer is
	// left; call it as soon as spawn has returned.
	releasePluginEnds(): void;
	// Call once the plugin has exited: delivers what is left in each output's FIFO, in order, and
	// ends the output at end-of-file. Never blocks.
	drain(): FifoDrain[];
	// How each output has ended: "eof" at libuv's end-of-file, "drain" at drain()'s, "closed" when
	// the hub closed it first (destroy(), or a consumer such as the decoder at a violation), or the
	// errno code its descriptor failed with; null while it is open.
	endings(): (string | null)[];
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

const errnoCode = (error: unknown): string => {
	const code = (error as NodeJS.ErrnoException | null)?.code;
	return typeof code === "string" ? code : "failed";
};

interface ReadEnd {
	readonly output: Readable;
	drain(): FifoDrain;
	ending(): string | null;
}

// The hub's end of a FIFO the plugin writes: libuv reads it while the plugin runs, paused while the
// output is full, and drain() reads the rest straight from the descriptor. Only an end-of-file
// ends the output; a failure or the hub's close destroys it. Destroying the output closes the
// descriptor.
function readEnd(fd: number, socket: net.Socket): ReadEnd {
	let ending: string | null = null;
	let failure: string | null = null;
	const output = new Readable({
		read() {
			socket.resume();
		},
		destroy(error, callback) {
			ending ??= failure ?? "closed";
			socket.destroy();
			callback(error);
		},
	});
	const end = (how: string): void => {
		if (ending !== null) return;
		ending = how;
		output.push(null);
	};
	socket.on("error", (error) => {
		failure ??= errnoCode(error);
	});
	socket.on("data", (chunk: Buffer) => {
		if (!output.destroyed && !output.push(chunk)) socket.pause();
	});
	socket.once("end", () => end("eof"));
	socket.once("close", () => {
		if (ending === null) output.destroy();
	});
	const drain = (): FifoDrain => {
		let bytes = 0;
		// What libuv read before a pause goes first, so the output stays in order.
		while (socket.readableLength > 0 && !output.destroyed) {
			if (socket.read() === null) break;
		}
		const buffer = Buffer.allocUnsafe(64 << 10);
		while (bytes < DRAIN_LIMIT) {
			// Each push reaches the consumers at once, and one may close the output and its descriptor.
			if (ending !== null || socket.destroyed) return { bytes, result: "closed" };
			let read: number;
			try {
				read = fs.readSync(fd, buffer, 0, buffer.length, null);
			} catch (error) {
				const code = errnoCode(error);
				if (code !== "EAGAIN") {
					failure = code;
					output.destroy();
				}
				return { bytes, result: code };
			}
			if (read === 0) {
				end("drain");
				socket.destroy();
				return { bytes, result: "eof" };
			}
			bytes += read;
			output.push(Buffer.from(buffer.subarray(0, read)));
		}
		return { bytes, result: "limit" };
	};
	return { output, drain, ending: () => ending };
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
	const hubFds: number[] = [];
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
		hubFds.push(open(stdin, O_WRONLY | O_NONBLOCK));
		pluginFds = [open(stdin, O_RDONLY)];
		fs.closeSync(probe);
		owned.splice(owned.indexOf(probe), 1);
		for (const name of rest) {
			hubFds.push(open(name, O_RDONLY | O_NONBLOCK));
			pluginFds.push(open(name, O_WRONLY));
		}
		for (const [i, fd] of hubFds.entries()) wrap(fd, i > 0);
	} catch (error) {
		for (const socket of sockets) socket.destroy();
		for (const fd of owned) fs.closeSync(fd);
		throw error;
	} finally {
		fs.rmSync(dir, { recursive: true, force: true });
	}
	const [input, ...readers] = sockets as [net.Socket, ...net.Socket[]];
	const ends = readers.map((socket, i) => readEnd(hubFds[i + 1] as number, socket));
	let released = false;
	const releasePluginEnds = (): void => {
		if (released) return;
		released = true;
		for (const fd of pluginFds) fs.closeSync(fd);
	};
	return {
		dir,
		pluginFds,
		hubFds,
		input,
		outputs: ends.map((end) => end.output),
		releasePluginEnds,
		drain: () => ends.map((end) => end.drain()),
		endings: () => ends.map((end) => end.ending()),
		destroy() {
			releasePluginEnds();
			for (const end of ends) end.output.destroy();
			for (const socket of sockets) socket.destroy();
		},
	};
}
