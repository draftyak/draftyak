import { execFile, spawn } from "node:child_process";
import {
	chmodSync,
	closeSync,
	fstatSync,
	mkdirSync,
	openSync,
	readdirSync,
	readFileSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import * as pluginStdio from "@draftyak/protocol/plugin-stdio";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { systemClock } from "../../src/kernel/clock.ts";
import {
	createPluginSupervisor,
	type PluginSupervisor,
	PluginSupervisorError,
	type SupervisedProcess,
	type SupervisorEvent,
} from "../../src/plugins/supervisor/index.ts";
import { createSampler, parseProcStatus } from "../../src/plugins/supervisor/memory.ts";
import {
	epoch,
	generation,
	isAlive,
	lineBundle,
	makeRoots,
	manifest,
	type Roots,
	recordingHost,
	ulid,
	until,
} from "./supervisor-helpers.ts";

let roots: Roots;
let supervisor: PluginSupervisor | undefined;
let events: SupervisorEvent[];
let pids: Set<number>;

beforeEach(() => {
	roots = makeRoots();
	supervisor = undefined;
	events = [];
	pids = new Set();
});

afterEach(async () => {
	await supervisor?.close();
	vi.restoreAllMocks();
	for (const pid of pids) {
		if (isAlive(pid)) process.kill(pid, "SIGKILL");
		await until(() => !isAlive(pid));
	}
	roots.cleanup();
});

async function open(): Promise<PluginSupervisor> {
	supervisor = await createPluginSupervisor({
		dataRoot: roots.dataRoot,
		stdioRoot: roots.stdioRoot,
		host: recordingHost(),
		onEvent: (event) => events.push(event),
	});
	return supervisor;
}

let count = 0;
async function instance(
	directory = path.join(roots.bundles, `b${++count}`),
): Promise<SupervisedProcess> {
	const opened = supervisor ?? (await open());
	const activation = await opened.activate(
		generation(lineBundle(directory), { pluginId: `dytest-p${count}` }),
		{
			epoch: epoch(),
		},
	);
	return activation.instance(ulid());
}

async function pidOf(handle: SupervisedProcess): Promise<number> {
	const counts = (await handle.callTool("run", { do: "count" })) as { pid: number };
	pids.add(counts.pid);
	return counts.pid;
}

async function code(promise: Promise<unknown>): Promise<string | undefined> {
	try {
		await promise;
		return undefined;
	} catch (error) {
		return error instanceof PluginSupervisorError ? error.code : `other:${String(error)}`;
	}
}

const crashed = () =>
	events
		.filter((event) => event.type === "crashed")
		.map((event) => ("reason" in event ? event.reason : undefined));

function descriptorCount(): number {
	return readdirSync(process.platform === "linux" ? "/proc/self/fd" : "/dev/fd").length;
}

describe("Windows", () => {
	it("a _forkChild(1) handle send aborts the plugin before sending", {
		tags: ["requires:windows"],
	}, async () => {
		const handle = await instance();
		const pid = await pidOf(handle);
		expect(await code(handle.callTool("run", { do: "probe", what: "fork-child", sends: 1 }))).toBe(
			"PLUGIN_EXITED",
		);
		await until(() => !isAlive(pid));
		await until(() => crashed().length > 0);
		expect(crashed()).toEqual(["exit"]);
		expect(await pidOf(handle)).not.toBe(pid);
	});

	it("close() ends every plugin, and a killed hub takes its plugins with it", {
		tags: ["requires:windows"],
	}, async () => {
		const handles = [await instance(), await instance()];
		const running = [
			await pidOf(handles[0] as SupervisedProcess),
			await pidOf(handles[1] as SupervisedProcess),
		];
		await (supervisor as PluginSupervisor).close();
		for (const pid of running) expect(isAlive(pid)).toBe(false);
		const { hub, plugin } = await standInHub(false);
		expect(isAlive(plugin)).toBe(true);
		hub.kill("SIGKILL");
		// A non-detached child shares the spawning process's kill-on-close job object.
		await until(() => !isAlive(plugin), 10_000);
	});
});

describe("Linux and macOS", () => {
	it("gives the plugin only unlinked FIFOs and leaves nothing in the stdio root", {
		tags: ["requires:posix"],
	}, async () => {
		const real = pluginStdio.openPluginStdio;
		const facts: { fifo: boolean; nlink: number }[][] = [];
		vi.spyOn(pluginStdio, "openPluginStdio").mockImplementation(async (options) => {
			const stdio = await real(options);
			facts.push(
				(stdio.stdio as readonly number[]).map((fd) => {
					const stat = fstatSync(fd);
					return { fifo: stat.isFIFO(), nlink: stat.nlink };
				}),
			);
			expect(readdirSync(roots.stdioRoot)).toEqual([]);
			return stdio;
		});
		const handle = await instance();
		await pidOf(handle);
		expect(facts).toEqual([
			[
				{ fifo: true, nlink: 0 },
				{ fifo: true, nlink: 0 },
				{ fifo: true, nlink: 0 },
			],
		]);
		await handle.stop();
		expect(readdirSync(roots.stdioRoot)).toEqual([]);
		await pidOf(handle);
		expect(
			await code(
				handle.callTool("run", { do: "raw", lines: [Buffer.from("[1]\n").toString("base64")] }),
			),
		).toBe("PLUGIN_VIOLATION");
		await until(() => crashed().length > 0);
		expect(readdirSync(roots.stdioRoot)).toEqual([]);
	});

	it("refuses handle sends on both reinstated FIFO descriptors with ENOTSOCK", {
		tags: ["requires:posix"],
	}, async () => {
		const before = descriptorCount();
		const handle = await instance();
		await pidOf(handle);
		for (const fd of [1, 2]) {
			const outcome = await handle.callTool("run", {
				do: "probe",
				what: "fork-child",
				fd,
				sends: 10,
			});
			expect(outcome).toEqual({ result: { hooked: true, statuses: Array(10).fill("ENOTSOCK") } });
		}
		await handle.stop();
		expect(descriptorCount()).toBeLessThanOrEqual(before);
		expect(await pidOf(await instance())).toBeGreaterThan(0);
	});

	it("bounds the exit drain when another writer holds the stdout FIFO", {
		tags: ["requires:posix"],
	}, async () => {
		const real = pluginStdio.openPluginStdio;
		let extra: number | undefined;
		vi.spyOn(pluginStdio, "openPluginStdio").mockImplementation(async (options) => {
			const stdio = await real(options);
			const fd = (stdio.stdio as readonly number[])[1] as number;
			extra = openSync(process.platform === "linux" ? `/proc/self/fd/${fd}` : `/dev/fd/${fd}`, "w");
			return stdio;
		});
		const handle = await instance();
		const pid = await pidOf(handle);
		const started = Date.now();
		await handle.stop();
		expect(Date.now() - started).toBeLessThan(5_000);
		expect(isAlive(pid)).toBe(false);
		expect(events.some((event) => event.type === "held-writer")).toBe(true);
		closeSync(extra as number);
	});

	it("keeps the plugin in the hub's process group", { tags: ["requires:posix"] }, async () => {
		const handle = await instance();
		const pid = await pidOf(handle);
		const group = async (target: number) =>
			(
				await new Promise<string>((resolve, reject) =>
					execFile(
						"/bin/ps",
						["-o", "pgid=", "-p", String(target)],
						{ env: {} },
						(error, stdout) => (error ? reject(error) : resolve(String(stdout))),
					),
				)
			).trim();
		expect(await group(pid)).toBe(await group(process.pid));
		const { hub, plugin } = await standInHub(true);
		process.kill(-(hub.pid as number), "SIGKILL");
		await until(() => !isAlive(plugin));
	});

	it("does not promise parent-death cleanup when only its POSIX parent is killed", {
		tags: ["requires:posix"],
	}, async () => {
		const { hub, plugin } = await standInHub(true);
		const exited = new Promise<void>((resolve) => hub.once("exit", () => resolve()));
		hub.kill("SIGKILL");
		await exited;
		// POSIX has no Windows job-object equivalent here: the launcher owns process-group cleanup.
		expect(isAlive(plugin)).toBe(true);
		process.kill(plugin, "SIGKILL");
		await until(() => !isAlive(plugin));
	});
});

describe("Linux", () => {
	it("samples real VmRSS and VmSwap and drains exited FIFOs to EOF", {
		tags: ["requires:linux"],
	}, async () => {
		const completions: Promise<pluginStdio.PluginStdioResult>[] = [];
		const real = pluginStdio.openPluginStdio;
		vi.spyOn(pluginStdio, "openPluginStdio").mockImplementation(async (options) => {
			const stdio = await real(options);
			return {
				...stdio,
				attach(child) {
					const io = stdio.attach(child);
					completions.push(io.completion);
					return io;
				},
			};
		});
		const handle = await instance();
		const pid = await pidOf(handle);
		const status = readFileSync(`/proc/${pid}/status`, "latin1");
		expect(status).toMatch(/^VmRSS:\s+\d+ kB$/m);
		expect(status).toMatch(/^VmSwap:\s+\d+ kB$/m);
		expect(parseProcStatus(status)).toBeGreaterThan(0);
		const sampler = createSampler("linux", undefined, systemClock, () => {});
		expect((await sampler.sample([pid])).get(pid)).toBeGreaterThan(0);
		sampler.close();
		await handle.stop();
		expect((await completions[0])?.drains.map((drain) => drain.result)).toEqual(["eof", "eof"]);
	});
});

describe("macOS", () => {
	it("refuses the /var alias and grants only the canonical /private/var bundle", {
		tags: ["requires:macos"],
	}, async () => {
		const opened = await open();
		const directory = path.join(roots.bundles, "canonical");
		const bundle = lineBundle(directory);
		expect(directory.startsWith("/private/var/")).toBe(true);
		const alias = directory.replace(/^\/private\/var\//, "/var/");
		expect(
			await code(opened.activate(generation({ ...bundle, directory: alias }), { epoch: epoch() })),
		).toBe("BUNDLE_REFUSED");
		const activation = await opened.activate(generation(bundle), { epoch: epoch() });
		const handle = activation.instance(ulid());
		const facts = (await handle.callTool("run", { do: "facts" })) as {
			pid: number;
			entry: string;
			envNames: string[];
		};
		pids.add(facts.pid);
		expect(facts.entry).toBe(path.join(directory, "main.mjs"));
		expect(facts.envNames.filter((name) => name.startsWith("__CF_"))).toEqual([
			"__CF_USER_TEXT_ENCODING",
		]);
	});
});

describe("all platforms", () => {
	it("starts a verified plugin staged from a read-only application bundle", async () => {
		const opened = await open();
		const bundle = lineBundle(path.join(roots.bundles, "readonly"));
		for (const file of bundle.inventory.files)
			chmodSync(path.join(bundle.directory, file.path), 0o444);
		chmodSync(bundle.directory, 0o555);
		const activation = await opened.activate(generation(bundle), { epoch: epoch() });
		const handle = activation.instance(ulid());
		expect(await pidOf(handle)).toBeGreaterThan(0);
		await handle.stop();
	});

	it("refuses a bundle reached through a linked parent and runs it at its real path", async () => {
		const real = path.join(roots.base, "real-parent");
		mkdirSync(real, { mode: 0o700 });
		const directory = path.join(real, "bundle");
		const bundle = lineBundle(directory, {}, [{ path: "data.txt", content: "DYTEST second file" }]);
		const alias = path.join(roots.base, "alias-parent");
		symlinkSync(real, alias, process.platform === "win32" ? "junction" : "dir");
		const opened = await open();
		const aliased = { ...bundle, directory: path.join(alias, "bundle") };
		expect(
			await code(
				opened.activate(generation(aliased, { pluginId: "dytest-alias" }), { epoch: epoch() }),
			),
		).toBe("BUNDLE_REFUSED");
		const activation = await opened.activate(generation(bundle, { pluginId: "dytest-real" }), {
			epoch: epoch(),
		});
		const handle = activation.instance(ulid());
		await pidOf(handle);
		expect(
			await handle.callTool("run", { do: "read-file", path: path.join(directory, "data.txt") }),
		).toEqual({ ok: true });
	});

	it("processes a flood of small notifications with bounded hub memory", async () => {
		const handle = await instance();
		await pidOf(handle);
		const before = process.memoryUsage().heapUsed;
		expect(await handle.callTool("run", { do: "flood", count: 50_000 })).toEqual({
			flooded: 50_000,
		});
		expect(process.memoryUsage().heapUsed - before).toBeLessThan(64 << 20);
		expect(await pidOf(handle)).toBeGreaterThan(0);
	});
});

/** A separate process running the supervisor, so the test can kill it without its plugin. */
async function standInHub(
	detached: boolean,
): Promise<{ hub: ReturnType<typeof spawn>; plugin: number }> {
	const directory = path.join(roots.bundles, "stand-in");
	const bundle = lineBundle(directory);
	const script = path.join(roots.base, "stand-in-hub.mjs");
	const supervisorModule = pathToFileURL(
		fileURLToPath(new URL("../../src/plugins/supervisor/index.ts", import.meta.url)),
	).href;
	const data = path.join(roots.base, "stand-in-data");
	const run = path.join(roots.base, "stand-in-run");
	mkdirSync(data, { mode: 0o700 });
	mkdirSync(run, { mode: 0o700 });
	writeFileSync(
		script,
		[
			`import { createPluginSupervisor } from ${JSON.stringify(supervisorModule)};`,
			`const supervisor = await createPluginSupervisor({ dataRoot: ${JSON.stringify(data)}, stdioRoot: ${JSON.stringify(run)}, host: { request: async () => null } });`,
			`const activation = await supervisor.activate({ pluginId: "dytest-stand-in", generation: "g1", bundle: ${JSON.stringify(bundle)}, manifest: ${JSON.stringify(manifest("dytest-stand-in"))}, acceptSurface: () => true }, { epoch: { id: "e1", signal: new AbortController().signal } });`,
			`const counts = await activation.instance(${JSON.stringify(ulid())}).callTool("run", { do: "count" });`,
			`process.stdout.write(JSON.stringify({ plugin: counts.pid }) + "\\n");`,
			`setInterval(() => {}, 1 << 30);`,
		].join("\n"),
	);
	const hub = spawn(process.execPath, [script], {
		stdio: ["ignore", "pipe", "ignore"],
		detached,
		windowsHide: true,
	});
	const plugin = await new Promise<number>((resolve, reject) => {
		let text = "";
		hub.stdout?.on("data", (chunk: Buffer) => {
			text += chunk.toString("utf8");
			if (text.includes("\n"))
				resolve((JSON.parse(text.slice(0, text.indexOf("\n"))) as { plugin: number }).plugin);
		});
		hub.once("exit", () => reject(new Error("Stand-in hub ended early")));
	});
	pids.add(plugin);
	return { hub, plugin };
}
