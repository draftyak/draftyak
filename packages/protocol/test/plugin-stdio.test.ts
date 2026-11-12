import { type ChildProcess, spawn } from "node:child_process";
import { EventEmitter, once } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { PassThrough, type Readable } from "node:stream";
import { describe, expect, it, vi } from "vitest";
import { openFifoStdio } from "../src/plugin-stdio/fifo.ts";
import {
	openPluginStdio,
	PLUGIN_STDIO_DRAIN_LIMIT,
	PLUGIN_STDIO_PIPE_DRAIN_MS,
} from "../src/plugin-stdio.ts";

const tick = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));
const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));
const collect = async (stream: Readable): Promise<Buffer> => {
	const chunks: Buffer[] = [];
	for await (const chunk of stream) chunks.push(Buffer.from(chunk));
	return Buffer.concat(chunks);
};
async function stop(child: ChildProcess): Promise<void> {
	if (child.pid && child.exitCode === null && child.signalCode === null) {
		const exited = once(child, "exit");
		child.kill("SIGKILL");
		await exited;
	}
}

describe("parent plugin stdio", () => {
	it("uses exactly three byte streams and preserves final output before completion", async () => {
		const parent = fs.mkdtempSync(path.join(os.tmpdir(), "dy-stdio-test-"));
		const arrangement = await openPluginStdio({ parentDir: parent });
		let child: ChildProcess | undefined;
		try {
			expect(arrangement.kind).toBe(process.platform === "win32" ? "pipe" : "fifo");
			expect(arrangement.stdio).toHaveLength(3);
			expect(fs.readdirSync(parent)).toEqual([]);
			if (arrangement.kind === "pipe") expect(arrangement.stdio).toEqual(["pipe", "pipe", "pipe"]);
			else
				for (const fd of arrangement.stdio as readonly number[]) {
					const stat = fs.fstatSync(fd);
					expect([stat.isFIFO(), stat.isSocket(), stat.nlink]).toEqual([true, false, 0]);
				}
			child = spawn(
				process.execPath,
				[
					"-e",
					"process.stdin.once('data', b => { process.stderr.write('log-tail'); process.stdout.write(b, () => process.exit(0)); });",
				],
				{ cwd: parent, env: {}, stdio: [...arrangement.stdio] },
			);
			const io = arrangement.attach(child);
			const output = collect(io.outputs[0]);
			const logs = collect(io.outputs[1]);
			io.input.write("approved-bytes\n");
			const result = await io.completion;
			expect(result).toMatchObject({ code: 0, signal: null, error: null });
			expect(result.drains.every(({ result }) => ["eof", "closed"].includes(result))).toBe(true);
			expect((await output).toString()).toBe("approved-bytes\n");
			expect((await logs).toString()).toBe("log-tail");
			await Promise.all([io.destroy(), io.destroy(), arrangement.destroy()]);
		} finally {
			if (child) await stop(child);
			await arrangement.destroy();
			expect(fs.readdirSync(parent)).toEqual([]);
			fs.rmdirSync(parent);
		}
	});

	it("bounds buffered output under backpressure and retains byte order", async () => {
		const arrangement = await openPluginStdio();
		const size = 2 << 20;
		const child = spawn(
			process.execPath,
			[
				"-e",
				`const b = Buffer.alloc(${size}); for(let i=0;i<b.length/4;i++) b.writeUInt32BE(i,i*4); process.stdout.write(b, () => process.exit(0));`,
			],
			{ env: {}, stdio: [...arrangement.stdio] },
		);
		const io = arrangement.attach(child);
		try {
			io.outputs[1].resume();
			await sleep(100);
			expect(io.outputs[0].readableLength).toBeLessThanOrEqual(256 << 10);
			const data = collect(io.outputs[0]);
			await io.completion;
			const bytes = await data;
			expect(bytes.length).toBe(size);
			for (let i = 0; i < size / 4; i++)
				if (bytes.readUInt32BE(i * 4) !== i) throw new Error("Stdio byte order changed");
		} finally {
			await stop(child);
			await arrangement.destroy();
		}
	});

	it("cleans up a spawn error without waiting for exit or close", async () => {
		const arrangement = await openPluginStdio();
		const missing = path.join(os.tmpdir(), `dy-missing-${process.pid}-${Date.now()}`, "node");
		const child = spawn(missing, [], { env: {}, stdio: [...arrangement.stdio] });
		const io = arrangement.attach(child);
		try {
			const result = await io.completion;
			expect(result.error).toBe("spawn");
			await arrangement.destroy();
			await arrangement.destroy();
		} finally {
			await stop(child);
			await arrangement.destroy();
		}
	});

	it("can dispose before spawn and refuses attachment after disposal", async () => {
		const arrangement = await openPluginStdio();
		const fds = arrangement.kind === "fifo" ? ([...arrangement.stdio] as number[]) : [];
		await arrangement.destroy();
		await arrangement.destroy();
		for (const fd of fds) expect(() => fs.fstatSync(fd)).toThrow();
		expect(() => arrangement.attach(new EventEmitter() as ChildProcess)).toThrow(/destroyed/);
	});

	it("disposes live streams without taking ownership of child termination", async () => {
		const arrangement = await openPluginStdio();
		const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
			env: {},
			stdio: [...arrangement.stdio],
		});
		const io = arrangement.attach(child);
		try {
			expect(() => arrangement.attach(child)).toThrow(/already attached/);
			await io.destroy();
			expect((await io.completion).error).toBe("destroyed");
			expect(io.input.destroyed).toBe(true);
			expect(io.outputs.every((output) => output.destroyed)).toBe(true);
		} finally {
			await stop(child);
			await arrangement.destroy();
		}
	});
	it("reports consumer cancellation as a stream failure on a zero exit", async () => {
		const arrangement = await openPluginStdio();
		const raw = [new PassThrough(), new PassThrough()];
		const child = Object.assign(new EventEmitter(), {
			stdin: new PassThrough(),
			stdout: raw[0],
			stderr: raw[1],
			exitCode: null,
			signalCode: null,
		}) as unknown as ChildProcess;
		const io = arrangement.attach(child);
		try {
			io.outputs[0].destroy();
			raw[1]?.end();
			await tick();
			child.emit("exit", 0, null);
			const result = await io.completion;
			expect(result.drains[0].result).toBe("closed");
			expect(result.error).toBe("streams");
		} finally {
			await arrangement.destroy();
		}
	});
	it("preserves Windows EOF observed before the child exit event", {
		tags: ["requires:windows"],
	}, async () => {
		const arrangement = await openPluginStdio();
		const raw = [new PassThrough(), new PassThrough()];
		const child = Object.assign(new EventEmitter(), {
			stdin: new PassThrough(),
			stdout: raw[0],
			stderr: raw[1],
			exitCode: null,
			signalCode: null,
		}) as unknown as ChildProcess;
		const io = arrangement.attach(child);
		try {
			const outputs = io.outputs.map(collect);
			for (const output of raw) output.end("tail");
			await Promise.all(outputs);
			child.emit("exit", 0, null);
			const result = await io.completion;
			expect(result.drains.map(({ result }) => result)).toEqual(["eof", "eof"]);
			expect(result.error).toBeNull();
		} finally {
			await arrangement.destroy();
		}
	});
	it("reports unread output discarded after raw EOF as cancellation", {
		tags: ["requires:windows"],
	}, async () => {
		const arrangement = await openPluginStdio();
		const raw = [new PassThrough(), new PassThrough()];
		const child = Object.assign(new EventEmitter(), {
			stdin: new PassThrough(),
			stdout: raw[0],
			stderr: raw[1],
			exitCode: null,
			signalCode: null,
		}) as unknown as ChildProcess;
		const io = arrangement.attach(child);
		try {
			raw[0]?.end("unread");
			raw[1]?.end();
			await tick();
			expect(raw[0]?.readableEnded).toBe(true);
			expect(io.outputs[0].readableLength).toBe(6);
			expect(io.outputs[0].readableEnded).toBe(false);
			io.outputs[0].destroy();
			child.emit("exit", 0, null);
			const result = await io.completion;
			expect(result.drains[0].result).toBe("closed");
			expect(result.error).toBe("streams");
		} finally {
			await arrangement.destroy();
		}
	});

	it("finishes Windows pipes with a bounded deadline when writers never reach EOF", {
		tags: ["requires:windows"],
	}, async () => {
		const arrangement = await openPluginStdio();
		const raw = [new PassThrough(), new PassThrough()];
		const child = Object.assign(new EventEmitter(), {
			stdin: new PassThrough(),
			stdout: raw[0],
			stderr: raw[1],
			exitCode: null,
			signalCode: null,
		}) as unknown as ChildProcess;
		const io = arrangement.attach(child);
		const text = collect(io.outputs[0]);
		const started = performance.now();
		child.emit("exit", 0, null);
		raw[0]?.write("last");
		const result = await io.completion;
		expect(result.drains.map(({ result }) => result)).toEqual(["deadline", "deadline"]);
		expect(result.error).toBe("streams");
		expect(performance.now() - started).toBeLessThan(PLUGIN_STDIO_PIPE_DRAIN_MS + 2000);
		expect((await text).toString()).toBe("last");
		await arrangement.destroy();
	});

	it("bounds the Windows final drain even with a writer feeding it", {
		tags: ["requires:windows"],
	}, async () => {
		const arrangement = await openPluginStdio();
		const raw = [new PassThrough(), new PassThrough()];
		const child = Object.assign(new EventEmitter(), {
			stdin: new PassThrough(),
			stdout: raw[0],
			stderr: raw[1],
			exitCode: null,
			signalCode: null,
		}) as unknown as ChildProcess;
		const io = arrangement.attach(child);
		child.emit("exit", 0, null);
		raw[0]?.write(Buffer.alloc(PLUGIN_STDIO_DRAIN_LIMIT + 1));
		const result = await io.completion;
		expect(result.drains[0]).toEqual({ bytes: PLUGIN_STDIO_DRAIN_LIMIT, result: "limit" });
		expect(result.error).toBe("streams");
		expect(io.outputs[0].readableLength).toBeLessThanOrEqual(PLUGIN_STDIO_DRAIN_LIMIT);
		await arrangement.destroy();
	});
	it("reports an input write error as a stream failure", {
		tags: ["requires:windows"],
	}, async () => {
		const arrangement = await openPluginStdio();
		const raw = [new PassThrough(), new PassThrough()];
		const child = Object.assign(new EventEmitter(), {
			stdin: new PassThrough(),
			stdout: raw[0],
			stderr: raw[1],
			exitCode: null,
			signalCode: null,
		}) as unknown as ChildProcess;
		const io = arrangement.attach(child);
		for (const output of raw) output.end();
		await tick();
		child.stdin?.emit("error", new Error("synthetic write failure"));
		expect((await io.completion).error).toBe("streams");
		await arrangement.destroy();
	});
});

describe("unlinked FIFO stdio", { tags: ["requires:posix"] }, () => {
	it("reports unread bytes cancelled after the exit drain reached EOF", async () => {
		const fifo = await openFifoStdio();
		try {
			fs.writeSync(fifo.pluginFds[1] as number, "unread");
			fifo.releasePluginEnds();
			expect(fifo.drain()[0]).toEqual({ bytes: 6, result: "eof" });
			expect(fifo.outputs[0]?.readableEnded).toBe(false);
			fifo.outputs[0]?.destroy();
			expect(fifo.drain()[0]?.result).toBe("closed");
		} finally {
			fifo.destroy();
			await fifo.closed;
		}
	});
	it("reports unread bytes cancelled after Linux observed raw EOF", {
		tags: ["requires:linux"],
	}, async () => {
		const fifo = await openFifoStdio();
		try {
			fs.writeSync(fifo.pluginFds[1] as number, "unread");
			fifo.releasePluginEnds();
			const deadline = performance.now() + 2000;
			while (fifo.endings()[0] !== "eof" && performance.now() < deadline) await sleep(5);
			expect(fifo.endings()[0]).toBe("eof");
			expect(fifo.outputs[0]?.readableLength).toBe(6);
			expect(fifo.outputs[0]?.readableEnded).toBe(false);
			fifo.outputs[0]?.destroy();
			expect(fifo.drain()[0]?.result).toBe("closed");
		} finally {
			fifo.destroy();
			await fifo.closed;
		}
	});
	it("preserves Linux EOF observed before the child exit event", {
		tags: ["requires:linux"],
	}, async () => {
		const arrangement = await openPluginStdio();
		const child = Object.assign(new EventEmitter(), {
			exitCode: null,
			signalCode: null,
		}) as unknown as ChildProcess;
		const io = arrangement.attach(child);
		try {
			await Promise.all(io.outputs.map(collect));
			child.emit("exit", 0, null);
			const result = await io.completion;
			expect(result.drains.map(({ result }) => result)).toEqual(["eof", "eof"]);
			expect(result.error).toBeNull();
		} finally {
			await arrangement.destroy();
		}
	});
	it("marks an inherited writer as a stream failure even when the child exits zero", async () => {
		const arrangement = await openPluginStdio();
		const fdRoot = process.platform === "linux" ? "/proc/self/fd" : "/dev/fd";
		const writer = fs.openSync(
			`${fdRoot}/${arrangement.stdio[1]}`,
			fs.constants.O_WRONLY | fs.constants.O_NONBLOCK,
		);
		try {
			const child = Object.assign(new EventEmitter(), {
				exitCode: null,
				signalCode: null,
			}) as unknown as ChildProcess;
			const io = arrangement.attach(child);
			child.emit("exit", 0, null);
			const result = await io.completion;
			expect(result.code).toBe(0);
			expect(result.drains[0].result).toBe("EAGAIN");
			expect(result.error).toBe("streams");
		} finally {
			fs.closeSync(writer);
			await arrangement.destroy();
		}
	});
	it("drains before libuv polls, with no EOF event dependency", async () => {
		const fifo = await openFifoStdio();
		try {
			fs.writeSync(fifo.pluginFds[1] as number, "tail");
			fs.writeSync(fifo.pluginFds[2] as number, "log");
			fifo.releasePluginEnds();
			expect(fifo.drain()).toEqual([
				{ bytes: 4, result: "eof" },
				{ bytes: 3, result: "eof" },
			]);
			fifo.finish();
			await fifo.closed;
			expect(fifo.drain().map(({ result }) => result)).toEqual(["eof", "eof"]);
			expect((await collect(fifo.outputs[0] as Readable)).toString()).toBe("tail");
			expect((await collect(fifo.outputs[1] as Readable)).toString()).toBe("log");
		} finally {
			fifo.destroy();
			await fifo.closed;
		}
	});

	it("reports a held writer without blocking and closes it after the exit drain", async () => {
		const fifo = await openFifoStdio();
		try {
			const started = performance.now();
			expect(fifo.drain().map(({ result }) => result)).toEqual(["EAGAIN", "EAGAIN"]);
			expect(performance.now() - started).toBeLessThan(1000);
			fifo.releasePluginEnds();
			fifo.finish();
			await fifo.closed;
			for (const fd of [...fifo.pluginFds, ...fifo.hubFds])
				expect(() => fs.fstatSync(fd)).toThrow();
		} finally {
			fifo.destroy();
			await fifo.closed;
		}
	});

	it("stops the drain immediately when a consumer destroys its stream", async () => {
		const fifo = await openFifoStdio();
		const read = vi.spyOn(fs, "readSync");
		try {
			(fifo.outputs[0] as Readable).on("data", () => fifo.outputs[0]?.destroy());
			await tick();
			fs.writeSync(fifo.pluginFds[1] as number, "hostile");
			fifo.releasePluginEnds();
			read.mockClear();
			expect(fifo.drain()[0]).toEqual({ bytes: 7, result: "closed" });
			expect(read.mock.calls.filter(([fd]) => fd === fifo.hubFds[1])).toHaveLength(1);
		} finally {
			read.mockRestore();
			fifo.destroy();
			await fifo.closed;
		}
	});

	it("bounds a continuously fed final FIFO drain", async () => {
		const fifo = await openFifoStdio();
		const read = vi.spyOn(fs, "readSync").mockImplementation((_fd, buffer) => {
			(buffer as Uint8Array).fill(0);
			return (buffer as Uint8Array).byteLength;
		});
		try {
			expect(fifo.drain()[0]).toEqual({ bytes: PLUGIN_STDIO_DRAIN_LIMIT, result: "limit" });
			expect(fifo.outputs[0]?.readableLength).toBe(PLUGIN_STDIO_DRAIN_LIMIT);
		} finally {
			read.mockRestore();
			fifo.destroy();
			await fifo.closed;
		}
	});

	it("cleans up descriptors and names when opening fails partway", async () => {
		const parent = fs.mkdtempSync(path.join(os.tmpdir(), "dy-stdio-failure-"));
		const open = fs.openSync;
		const fds: number[] = [];
		const spy = vi.spyOn(fs, "openSync").mockImplementation((file, flags, mode) => {
			if (fds.length === 2) throw new Error("synthetic open failure");
			const fd = open(file, flags, mode);
			fds.push(fd);
			return fd;
		});
		try {
			await expect(openPluginStdio({ parentDir: parent })).rejects.toThrow(
				"synthetic open failure",
			);
			for (const fd of fds) expect(() => fs.fstatSync(fd)).toThrow();
			expect(fs.readdirSync(parent)).toEqual([]);
		} finally {
			spy.mockRestore();
			fs.rmdirSync(parent);
		}
	});

	it.each([1, 2])("refuses a handle-bearing write over FIFO fd %i", async (fd) => {
		const arrangement = await openPluginStdio();
		const reportFd = fd === 1 ? 2 : 1;
		const source = `const cp=require('node:child_process'),fs=require('node:fs'),util=require('node:util'); cp._forkChild(${fd},'json'); const key=Object.getOwnPropertySymbols(process).find(s=>s.description==='kChannelHandle'); const channel=process[key],write=channel.writeUtf8String,status=[]; channel.writeUtf8String=function(req,text,handle){ const code=write.call(this,req,text,handle); if(handle&&code) status.push(util.getSystemErrorName(code)); else if(handle) process.nextTick(()=>{const done=req.oncomplete;req.oncomplete=(code,...args)=>{status.push(code===0?'ok':util.getSystemErrorName(code));return done?.call(req,code,...args)}}); return code; }; process.send({test:true},process.stdin,{keepOpen:true},()=>{}); setTimeout(()=>{fs.writeSync(${reportFd},JSON.stringify(status));process.exit(0)},100);`;
		const child = spawn(process.execPath, ["-e", source], {
			env: {},
			stdio: [...arrangement.stdio],
		});
		const io = arrangement.attach(child);
		try {
			const all = io.outputs.map(collect);
			expect((await io.completion).code).toBe(0);
			const data = await Promise.all(all);
			expect(data[fd - 1]?.length).toBe(0);
			expect(JSON.parse((data[reportFd - 1] as Buffer).toString())).toEqual(["ENOTSOCK"]);
		} finally {
			await stop(child);
			await arrangement.destroy();
		}
	});
});
