import { spawn } from "node:child_process";
import { createSocket } from "node:dgram";
import { existsSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:net";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	createPluginSupervisor,
	type PluginSupervisor,
	type SupervisedProcess,
	type SupervisorEvent,
} from "../../src/plugins/supervisor/index.ts";
import {
	canary,
	epoch,
	generation,
	isAlive,
	lineBundle,
	makeRoots,
	type Roots,
	recordingHost,
	ulid,
	until,
} from "./supervisor-helpers.ts";

let roots: Roots;
let supervisor: PluginSupervisor;
let events: SupervisorEvent[];
let handle: SupervisedProcess;
let pid: number;
let directory: string;

beforeEach(async () => {
	roots = makeRoots();
	events = [];
	supervisor = await createPluginSupervisor({
		dataRoot: roots.dataRoot,
		stdioRoot: roots.stdioRoot,
		host: recordingHost(),
		onEvent: (event) => events.push(event),
	});
	directory = path.join(roots.bundles, "hostile");
	const activation = await supervisor.activate(generation(lineBundle(directory)), {
		epoch: epoch(),
	});
	handle = activation.instance(ulid());
	pid = ((await handle.callTool("run", { do: "count" })) as { pid: number }).pid;
});

afterEach(async () => {
	await supervisor.close();
	expect(isAlive(pid)).toBe(false);
	roots.cleanup();
});

async function probe(what: string, args: Record<string, unknown> = {}): Promise<unknown> {
	return ((await handle.callTool("run", { do: "probe", what, ...args })) as { result: unknown })
		.result;
}

const denied = { code: "ERR_ACCESS_DENIED" };

/** The same request from a bare node process with no flags: proof that the probe itself works. */
function bare(source: string): Promise<string> {
	return new Promise((resolve) => {
		const child = spawn(process.execPath, ["--input-type=module", "-e", source], {
			stdio: ["ignore", "pipe", "ignore"],
			env: {},
			windowsHide: true,
		});
		let text = "";
		child.stdout.on("data", (chunk: Buffer) => {
			text += chunk.toString("utf8");
		});
		child.once("exit", () => resolve(text.trim()));
	});
}

async function listener(): Promise<{ server: Server; port: number; accepted: () => number }> {
	let accepted = 0;
	const server = createServer((socket) => {
		accepted++;
		socket.destroy();
	});
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	return { server, port: (server.address() as { port: number }).port, accepted: () => accepted };
}

describe("network", () => {
	it("refuses TCP to a loopback listener that a bare process reaches", async () => {
		const { server, port, accepted } = await listener();
		try {
			expect(await probe("tcp", { port })).toEqual(denied);
			expect(accepted()).toBe(0);
			expect(
				await bare(
					`import net from "node:net"; const s = net.connect(${port}, "127.0.0.1", () => { console.log("connected"); s.destroy(); });`,
				),
			).toBe("connected");
			await until(() => accepted() === 1);
		} finally {
			server.close();
		}
	});

	it("refuses local sockets and named pipes", async () => {
		const name =
			process.platform === "win32"
				? `\\\\.\\pipe\\draftyak-supervisor-${canary("pipe")}`
				: path.join(roots.base, "local.sock");
		const server = createServer((socket) => socket.destroy());
		await new Promise<void>((resolve) => server.listen(name, resolve));
		try {
			expect(await probe("pipe", { path: name })).toEqual(denied);
		} finally {
			server.close();
		}
	});

	it("refuses DNS, resolver queries and UDP, even to test-owned loopback ports", async () => {
		const udp = createSocket("udp4");
		let received = 0;
		udp.on("message", () => {
			received++;
		});
		await new Promise<void>((resolve) => udp.bind(0, "127.0.0.1", resolve));
		const port = udp.address().port;
		try {
			expect(await probe("dns-lookup")).toEqual(denied);
			expect(await probe("dns-resolve", { port })).toEqual(denied);
			expect(await probe("udp", { port })).toEqual(denied);
			expect(received).toBe(0);
		} finally {
			udp.close();
		}
	});
});

describe("files and keys", () => {
	it("cannot read a key canary outside its grants through any API", async () => {
		const secret = canary("key");
		const key = path.join(roots.base, "hub-key.mjs");
		writeFileSync(key, `export default ${JSON.stringify(secret)};\n`);
		const copy = path.join(roots.base, "copied.key");
		const result = (await probe("read", { path: key, copyTo: copy })) as Record<
			string,
			{ code?: string }
		>;
		for (const outcome of Object.values(result)) expect(outcome).toEqual(denied);
		expect(result.readFileSync).toEqual(denied);
		expect(result.readFile).toEqual(denied);
		expect(result.openSync).toEqual(denied);
		expect(result.createReadStream).toEqual(denied);
		expect(result.cpSync).toEqual(denied);
		expect(existsSync(copy)).toBe(false);
		expect(JSON.stringify([result, events])).not.toContain(secret);
	});

	it("writes no diagnostic report or heap snapshot outside its grants", async () => {
		const report = path.join(roots.base, "report.json");
		const heap = path.join(roots.base, "heap.heapsnapshot");
		expect(await probe("report", { path: report })).toEqual(denied);
		expect(await probe("heap", { path: heap })).toEqual(denied);
		expect(existsSync(report) || existsSync(heap)).toBe(false);
	});
});

describe("native code, processes and the runtime", () => {
	it("refuses addons, FFI, child processes, threads and SQLite", async () => {
		expect(await probe("dlopen", { path: path.join(directory, "line-plugin.mjs") })).toEqual({
			code: "ERR_DLOPEN_DISABLED",
		});
		// Node 26 loads node:ffi without a flag; the permission model must refuse every operation.
		const ffi = (await probe("ffi", { path: path.join(directory, "line-plugin.mjs") })) as Record<
			string,
			unknown
		>;
		if ("import" in ffi) expect(ffi.import).toMatchObject({ code: expect.stringMatching(/^ERR_/) });
		else
			expect(ffi).toEqual({
				dlopen: denied,
				library: denied,
				pointer: denied,
				read: denied,
				write: denied,
				view: denied,
			});
		expect(await probe("spawn")).toEqual(denied);
		expect(await probe("thread")).toEqual(denied);
		expect(await probe("sqlite")).toEqual({ code: "ERR_UNKNOWN_BUILTIN_MODULE" });
	});

	it("refuses to open an inspector", async () => {
		expect(await probe("inspector")).toEqual(denied);
	});

	it("aborts a plugin that changes V8 flags after start, as a crash", async () => {
		await expect(handle.callTool("run", { do: "probe", what: "v8-flags" })).rejects.toMatchObject({
			code: "PLUGIN_EXITED",
		});
		await until(() => !isAlive(pid));
		await until(() => events.some((event) => event.type === "crashed"));
		expect(
			events
				.filter((event) => event.type === "crashed")
				.map((event) => ("reason" in event ? event.reason : "")),
		).toEqual(["exit"]);
	});
});
