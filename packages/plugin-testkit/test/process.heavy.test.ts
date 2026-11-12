import {
	copyFile,
	link,
	lstat,
	mkdir,
	mkdtemp,
	readdir,
	realpath,
	rm,
	symlink,
	writeFile,
} from "node:fs/promises";
import { connect, createServer } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createFake, createHelloFake } from "@draftyak/fakes";
import { buildPluginArgv, checkPluginArgv } from "@draftyak/protocol/plugin-argv";
import * as pluginStdio from "@draftyak/protocol/plugin-stdio";
import { defineAiProviderPlugin } from "@draftyak/sdk";
import { build } from "tsdown";
import { afterAll, afterEach, beforeAll, expect, it, vi } from "vitest";
import { aiManifest } from "../../sdk/test/definitions-fixtures.ts";
import { createMockHub, type MockHub, type MockPlugin } from "../src/index.ts";
import { bindProcessPlugin, createProcess } from "../src/process.ts";
import { channelFixture } from "./fixtures/channel/plugin.ts";
import { probeFixture } from "./fixtures/process-probe/plugin.ts";
import { type PackedFixture, type ProcessBundles, processBundles } from "./process-bundles.ts";

let fixtures: ProcessBundles;
let temporary: string;
const roots: string[] = [];
const hubs: MockHub[] = [];
const processes: ReturnType<typeof createProcess>[] = [];

beforeAll(async () => {
	temporary = await realpath(tmpdir());
	fixtures = await processBundles();
});
afterEach(async () => {
	await Promise.all(processes.splice(0).map((process) => process.close()));
	await Promise.all(hubs.splice(0).map((hub) => hub.close()));
	vi.restoreAllMocks();
	for (const root of roots.splice(0)) {
		if (
			path.dirname(root) !== temporary ||
			!path.basename(root).startsWith("draftyak-process-acceptance-") ||
			(await lstat(root)).isSymbolicLink() ||
			(await realpath(root)) !== root
		)
			throw new Error("Process test cleanup root changed");
		await rm(root, { recursive: true, force: true });
	}
});
afterAll(async () => {
	await fixtures?.cleanup();
});

async function ownedDirectory(): Promise<string> {
	const root = await realpath(await mkdtemp(path.join(temporary, "draftyak-process-acceptance-")));
	roots.push(root);
	return root;
}
function hubFor(
	plugin: MockPlugin,
	packed: PackedFixture,
	upstreams: Parameters<typeof createMockHub>[0]["upstreams"] = [],
	args: readonly string[] = [],
): MockHub {
	const hub = createMockHub({
		mode: "process",
		plugin: bindProcessPlugin(plugin, { ...packed, args }),
		upstreams,
	});
	hubs.push(hub);
	return hub;
}
function parentMustNotRun(plugin: MockPlugin): MockPlugin {
	return {
		...plugin,
		entry: {
			...plugin.entry,
			tools: plugin.entry.tools.map((tool) => ({
				...tool,
				handler() {
					throw new Error("Parent handler executed");
				},
			})),
		},
	};
}
interface ProcessFacts {
	readonly argv: string[];
	readonly cwd: string;
	readonly envKeys: string[];
	readonly node: string;
}
async function facts(hub: MockHub): Promise<ProcessFacts> {
	const result = await hub.call("process_probe", { check: "facts" });
	expect(result.isError).not.toBe(true);
	expect(result.structuredContent).toMatchObject({
		argv: expect.any(Array),
		cwd: expect.any(String),
		envKeys: expect.any(Array),
		node: expect.any(String),
	});
	return result.structuredContent as ProcessFacts;
}

async function runtimeCommand(
	executable: string,
	args: readonly string[],
	diagnostics: string,
	env: NodeJS.ProcessEnv = process.env,
): Promise<string> {
	const stderr = openSync(diagnostics, "wx");
	try {
		return await new Promise<string>((resolve, reject) => {
			const child = spawn(executable, [...args], {
				windowsHide: true,
				env,
				stdio: ["ignore", "pipe", stderr],
				timeout: 600_000,
			});
			if (child.stdout === null) {
				child.kill();
				reject(new Error("Below-floor runtime setup failed"));
				return;
			}
			let output = "";
			let oversized = false;
			child.stdout.on("data", (chunk: Buffer) => {
				if (Buffer.byteLength(output) + chunk.length > 65_536) {
					oversized = true;
					child.kill();
				} else output += chunk.toString("utf8");
			});
			child.once("error", () => reject(new Error("Below-floor runtime setup failed")));
			child.once("close", (code) => {
				if (code !== 0 || oversized) reject(new Error("Below-floor runtime setup failed"));
				else resolve(output);
			});
		});
	} finally {
		closeSync(stderr);
	}
}

it("refuses the actual below-floor executable before launching an otherwise valid plugin", async () => {
	const root = await ownedDirectory();
	let executable = process.env.DRAFTYAK_TEST_NODE_BELOW_FLOOR;
	if (executable !== undefined && !path.isAbsolute(executable))
		throw new Error("Below-floor runtime setup failed");
	if (executable === undefined) {
		const cache = path.join(root, "cache");
		const platform = process.platform === "win32" ? "win" : process.platform;
		if (!["win", "linux", "darwin"].includes(platform) || !["x64", "arm64"].includes(process.arch))
			throw new Error("Below-floor runtime setup failed");
		const fetched = await runtimeCommand(
			process.execPath,
			[
				fileURLToPath(new URL("../../../tools/fetch-node/fetch-node.mjs", import.meta.url)),
				"--version",
				"26.5.0",
				"--platform",
				platform,
				"--arch",
				process.arch,
				"--print-path",
			],
			path.join(root, "fetch.stderr"),
			{ ...process.env, DRAFTYAK_CACHE_DIR: cache },
		);
		executable = await realpath(fetched.trim());
		const relative = path.relative(cache, executable);
		if (
			!relative ||
			relative === ".." ||
			relative.startsWith(`..${path.sep}`) ||
			path.isAbsolute(relative)
		)
			throw new Error("Below-floor runtime setup failed");
	}
	expect(
		(await runtimeCommand(executable, ["--version"], path.join(root, "version.stderr"))).trim(),
	).toBe("v26.5.0");
	const check = path.join(root, "check.mjs");
	await writeFile(
		check,
		[
			`import { createMockHub } from ${JSON.stringify(new URL("../src/index.ts", import.meta.url).href)};`,
			`import { bindProcessPlugin } from ${JSON.stringify(new URL("../src/process.ts", import.meta.url).href)};`,
			`import { probeFixture } from ${JSON.stringify(new URL("./fixtures/process-probe/plugin.ts", import.meta.url).href)};`,
			`const hub = createMockHub({ mode: "process", plugin: bindProcessPlugin(probeFixture(), ${JSON.stringify(fixtures.probe)}), upstreams: [] });`,
			`let code = "UNEXPECTED_SUCCESS";`,
			`try { await hub.discover(); } catch (error) { code = error !== null && typeof error === "object" && "code" in error ? String(error.code) : "SETUP_FAILURE"; } finally { await hub.close(); }`,
			`console.log(JSON.stringify({ node: process.versions.node, pid: process.pid, code }));`,
			`if (process.versions.node !== "26.5.0" || code !== "PROCESS_NODE_UNSUPPORTED") process.exitCode = 1;`,
		].join("\n"),
	);
	const result = JSON.parse(
		await runtimeCommand(executable, [check], path.join(root, "check.stderr")),
	) as { node: string; pid: number; code: string };
	expect(result).toMatchObject({
		node: "26.5.0",
		pid: expect.any(Number),
		code: "PROCESS_NODE_UNSUPPORTED",
	});
	expect(result.pid).not.toBe(process.pid);
	console.info(JSON.stringify(result));
}, 600_000);

it("discovers and calls the real bundled channel while leaving parent handlers unused", async () => {
	const fake = createHelloFake();
	const hub = hubFor(parentMustNotRun(channelFixture()), fixtures.channel, [fake]);
	expect((await hub.discover()).supportedVersions).toContain("2026-07-28");
	expect((await hub.listTools()).tools).toEqual(
		expect.arrayContaining([expect.objectContaining({ name: "channel_fetch" })]),
	);
	expect(await hub.listTools()).toEqual(await hub.listTools());
	expect(
		(await hub.call("channel_fetch", { url: `https://${fake.host}/v1/conversations` }))
			.structuredContent,
	).toMatchObject({ status: 200 });
	expect(fake.recorder.takeRequests()).toHaveLength(1);
	expect(hub.host.denials).toEqual([]);
	await hub.close();
	await hub.close();
	await expect(hub.discover()).rejects.toMatchObject({ code: "HOST_CLOSED" });
});

it("keeps channel policy refusals on actual tagged host frames between admitted reads", async () => {
	const fake = createHelloFake();
	const hub = hubFor(channelFixture(), fixtures.channel, [fake]);
	const good = { url: `https://${fake.host}/v1/conversations` };
	expect((await hub.call("channel_fetch", good)).structuredContent).toMatchObject({ status: 200 });
	expect(fake.recorder.takeRequests()).toHaveLength(1);
	const result = await hub.call("channel_fetch", { url: `https://${fake.host}/unlisted` });
	expect(result.isError).toBe(true);
	expect(result.structuredContent).toEqual({ code: "TRANSIENT" });
	expect(hub.host.denials.at(-1)).toMatchObject({ method: "host/fetch", reason: "OFF_RULE" });
	expect(fake.recorder.takeRequests()).toEqual([]);
	expect((await hub.call("channel_fetch", good)).structuredContent).toMatchObject({ status: 200 });
	expect(fake.recorder.takeRequests()).toHaveLength(1);
});

it("accepts overlapping channel calls and serves their replies in FIFO order", async () => {
	const entered = Promise.withResolvers<void>();
	const release = Promise.withResolvers<void>();
	const requests: string[] = [];
	const fake = createFake(
		{
			async fetch(request) {
				const cursor = new URL(request.url).searchParams.get("cursor") ?? "";
				requests.push(cursor);
				if (cursor === "first") {
					entered.resolve();
					await release.promise;
				}
				return new Response(cursor);
			},
		},
		{ host: "hello.draftyak.example" },
	);
	const hub = hubFor(channelFixture(), fixtures.channel, [fake]);
	const first = hub.call("channel_fetch", {
		url: "https://hello.draftyak.example/v1/conversations?cursor=first",
	});
	try {
		await Promise.race([
			entered.promise,
			first.then(() => {
				throw new Error("First request did not reach its gate");
			}),
		]);
		const second = hub.call("channel_fetch", {
			url: "https://hello.draftyak.example/v1/conversations?cursor=second",
		});
		const replies = Promise.all([first, second]);
		release.resolve();
		expect((await replies).map((reply) => reply.structuredContent)).toEqual([
			{ status: 200, headers: expect.any(Object), text: "first" },
			{ status: 200, headers: expect.any(Object), text: "second" },
		]);
		expect(requests).toEqual(["first", "second"]);
	} finally {
		release.resolve();
	}
});

it("cancels a queued request through the actual process adapter signal without dispatching it", async () => {
	const entered = Promise.withResolvers<void>();
	const release = Promise.withResolvers<void>();
	const requests: string[] = [];
	const fake = createFake(
		{
			async fetch(request) {
				const cursor = new URL(request.url).searchParams.get("cursor") ?? "";
				requests.push(cursor);
				if (cursor === "first") {
					entered.resolve();
					await release.promise;
				}
				return new Response(cursor);
			},
		},
		{ host: "hello.draftyak.example" },
	);
	const plugin = channelFixture();
	const parent = createMockHub({ mode: "in-memory", plugin, upstreams: [fake] });
	hubs.push(parent);
	const adapter = createProcess(bindProcessPlugin(plugin, fixtures.channel), parent.host, {
		plugin: "@example/mock-channel",
		instance: "00000000000000000000000001",
	});
	processes.push(adapter);
	const first = adapter.request("tools/call", {
		name: "channel_fetch",
		arguments: { url: "https://hello.draftyak.example/v1/conversations?cursor=first" },
	});
	try {
		await Promise.race([
			entered.promise,
			first.then(() => {
				throw new Error("First adapter request did not enter");
			}),
		]);
		const controller = new AbortController();
		const queued = adapter.request(
			"tools/call",
			{
				name: "channel_fetch",
				arguments: { url: "https://hello.draftyak.example/v1/conversations?cursor=cancelled" },
			},
			controller.signal,
		);
		const refused = expect(queued).rejects.toMatchObject({ code: "DENIED" });
		controller.abort();
		await refused;
		expect(requests).toEqual(["first"]);
		release.resolve();
		expect((await first).structuredContent).toMatchObject({ status: 200, text: "first" });
		expect((await adapter.request("tools/list")).tools).toEqual(
			expect.arrayContaining([expect.objectContaining({ name: "channel_fetch" })]),
		);
		expect(
			(
				await adapter.request("tools/call", {
					name: "channel_fetch",
					arguments: { url: "https://hello.draftyak.example/v1/conversations?cursor=after" },
				})
			).structuredContent,
		).toMatchObject({ status: 200, text: "after" });
		expect(requests).toEqual(["first", "after"]);
	} finally {
		release.resolve();
	}
});

it("launches the staged child with the canonical production argv and a scrubbed environment", async () => {
	const marker = process.env.DRAFTYAK_PROCESS_SENTINEL;
	process.env.DRAFTYAK_PROCESS_SENTINEL = "synthetic-parent-value";
	try {
		const hub = hubFor(parentMustNotRun(probeFixture()), fixtures.probe);
		const actual = await facts(hub);
		const entry = path.join(actual.cwd, "server.mjs");
		const spec = { pluginDir: actual.cwd, entry };
		expect(actual.cwd).not.toBe(fixtures.probe.directory);
		expect(await realpath(actual.cwd)).toBe(actual.cwd);
		expect(await readdir(actual.cwd)).toEqual(["server.mjs"]);
		expect(actual.argv).toEqual(buildPluginArgv(spec).slice(0, -1));
		expect(checkPluginArgv([...actual.argv, entry], spec)).toEqual([]);
		expect(actual.node).toBe(process.versions.node);
		expect(actual.envKeys).not.toContain("DRAFTYAK_PROCESS_SENTINEL");
		expect(actual.envKeys).not.toContain("NODE_OPTIONS");
		expect(actual.envKeys).not.toContain("NODE_PATH");
		await hub.close();
		await expect(lstat(actual.cwd)).rejects.toMatchObject({ code: "ENOENT" });
	} finally {
		if (marker === undefined) delete process.env.DRAFTYAK_PROCESS_SENTINEL;
		else process.env.DRAFTYAK_PROCESS_SENTINEL = marker;
	}
});

it.each(["eval", "child", "sqlite"])(
	"enforces the native %s restriction in a running child",
	async (check) => {
		const hub = hubFor(parentMustNotRun(probeFixture()), fixtures.probe);
		await facts(hub);
		expect((await hub.call("process_probe", { check })).structuredContent).toEqual({
			blocked: true,
		});
		await facts(hub);
	},
);

it("launches the native child with exactly three descriptors and no IPC channel", async () => {
	const open = pluginStdio.openPluginStdio;
	const prepared: unknown[][] = [];
	const spawned: number[] = [];
	vi.spyOn(pluginStdio, "openPluginStdio").mockImplementation(async (options) => {
		const opened = await open(options);
		prepared.push([...opened.stdio]);
		return {
			...opened,
			attach(child) {
				spawned.push(child.stdio.length);
				return opened.attach(child);
			},
		};
	});
	const hub = hubFor(parentMustNotRun(probeFixture()), fixtures.probe);
	await facts(hub);
	const actual = await hub.call("process_probe", { check: "ipc" });
	expect(actual.isError).not.toBe(true);
	expect(actual.structuredContent).toEqual({ channel: false, send: false, connected: false });
	expect(prepared).toHaveLength(1);
	expect(prepared[0]).toHaveLength(3);
	expect(prepared[0]).not.toContain("ipc");
	expect(spawned).toEqual([3]);
	await facts(hub);
});

it("allows the staged entry read and refuses an existing file outside the granted root", async () => {
	const root = await ownedDirectory();
	const outside = path.join(root, "synthetic.txt");
	await writeFile(outside, "synthetic bytes");
	const hub = hubFor(probeFixture(), fixtures.probe);
	const actual = await facts(hub);
	expect((await lstat(outside)).isFile()).toBe(true);
	expect(
		(await hub.call("process_probe", { check: "fs", path: path.join(actual.cwd, "server.mjs") }))
			.structuredContent,
	).toEqual({ blocked: false });
	expect(
		(await hub.call("process_probe", { check: "fs", path: outside })).structuredContent,
	).toEqual({ blocked: true });
	expect(
		(await hub.call("process_probe", { check: "fs", path: path.join(actual.cwd, "server.mjs") }))
			.structuredContent,
	).toEqual({ blocked: false });
});

it("requires the manifest data permission and grants only the declared data directory", async () => {
	const data = await ownedDirectory();
	const file = path.join(data, "synthetic.txt");
	await writeFile(file, "synthetic data");
	expect(() =>
		createMockHub({
			mode: "process",
			plugin: bindProcessPlugin(probeFixture(), { ...fixtures.probe, data }),
			upstreams: [],
		}),
	).toThrow("PROCESS_DATA_UNDECLARED");
	const probe = probeFixture();
	const manifest = structuredClone(probe.manifest) as Record<string, unknown>;
	manifest.permissions = { dataDir: true };
	const hub = createMockHub({
		mode: "process",
		plugin: bindProcessPlugin({ ...probe, manifest }, { ...fixtures.probe, data }),
		upstreams: [],
	});
	hubs.push(hub);
	const actual = await facts(hub);
	const entry = path.join(actual.cwd, "server.mjs");
	const spec = { pluginDir: actual.cwd, dataDir: data, entry };
	expect(actual.argv).toEqual(buildPluginArgv(spec).slice(0, -1));
	expect(checkPluginArgv([...actual.argv, entry], spec)).toEqual([]);
	expect((await hub.call("process_probe", { check: "fs", path: file })).structuredContent).toEqual({
		blocked: false,
	});
	const outside = await ownedDirectory();
	const other = path.join(outside, "other.txt");
	await writeFile(other, "outside data grant");
	expect((await hub.call("process_probe", { check: "fs", path: other })).structuredContent).toEqual(
		{ blocked: true },
	);
	expect((await hub.call("process_probe", { check: "fs", path: file })).structuredContent).toEqual({
		blocked: false,
	});
});

it("refuses a child socket while the same synthetic listener accepts parent connections", async () => {
	let accepted = 0;
	const server = createServer((socket) => {
		accepted++;
		socket.end();
	});
	await new Promise<void>((resolve, reject) => {
		server.once("error", reject);
		server.listen(0, "127.0.0.1", resolve);
	});
	try {
		const address = server.address();
		if (address === null || typeof address === "string")
			throw new Error("Synthetic listener missing");
		const parentConnect = (): Promise<void> =>
			new Promise((resolve, reject) => {
				const socket = connect({ host: "127.0.0.1", port: address.port });
				socket.once("error", reject);
				socket.once("connect", () => {
					socket.destroy();
					resolve();
				});
			});
		await parentConnect();
		expect(accepted).toBe(1);
		const hub = hubFor(probeFixture(), fixtures.probe);
		expect(
			(await hub.call("process_probe", { check: "network", port: address.port })).structuredContent,
		).toEqual({ blocked: true });
		expect(accepted).toBe(1);
		await parentConnect();
		expect(accepted).toBe(2);
	} finally {
		await new Promise<void>((resolve, reject) =>
			server.close((error) => (error ? reject(error) : resolve())),
		);
	}
});

it("refuses a hard-linked packed entry before spawning", async () => {
	const root = await ownedDirectory();
	await link(path.join(fixtures.channel.directory, "server.mjs"), path.join(root, "server.mjs"));
	expect(() =>
		bindProcessPlugin(channelFixture(), {
			directory: root,
			entry: "server.mjs",
			files: ["server.mjs"],
		}),
	).toThrow("PROCESS_FILES_INVALID");
});

it("refuses a symbolic packed entry before spawning", {
	tags: ["requires:symlink-privilege"],
}, async () => {
	const root = await ownedDirectory();
	await symlink(
		path.join(fixtures.channel.directory, "server.mjs"),
		path.join(root, "server.mjs"),
		"file",
	);
	expect(() =>
		bindProcessPlugin(channelFixture(), {
			directory: root,
			entry: "server.mjs",
			files: ["server.mjs"],
		}),
	).toThrow("PROCESS_FILES_INVALID");
});

it("refuses a junction source directory before spawning", {
	tags: ["requires:windows"],
}, async () => {
	const root = await ownedDirectory();
	const junction = path.join(root, "packed");
	await symlink(fixtures.channel.directory, junction, "junction");
	expect(() =>
		bindProcessPlugin(channelFixture(), {
			directory: junction,
			entry: "server.mjs",
			files: ["server.mjs"],
		}),
	).toThrow("PROCESS_FILES_INVALID");
});

it("refuses packed bytes changed after binding before the lazy spawn", async () => {
	const root = await ownedDirectory();
	const entry = path.join(root, "server.mjs");
	await copyFile(path.join(fixtures.channel.directory, "server.mjs"), entry);
	const plugin = bindProcessPlugin(channelFixture(), {
		directory: root,
		entry: "server.mjs",
		files: ["server.mjs"],
	});
	await writeFile(entry, "changed synthetic source");
	const hub = createMockHub({ mode: "process", plugin, upstreams: [] });
	hubs.push(hub);
	await expect(hub.discover()).rejects.toMatchObject({ code: "PROCESS_FILES_CHANGED" });
});

it.each([
	["malformed", "PROCESS_FRAME_INVALID"],
	["oversized", "PROCESS_FRAME_TOO_LARGE"],
	["stderr", "PROCESS_STDERR_LIMIT"],
	["exit", "PROCESS_EXITED"],
	["hang", "PROCESS_START_TIMEOUT"],
] as const)("bounds the real %s child failure and closes idempotently", async (mode, code) => {
	const hub = hubFor(channelFixture(), fixtures.tool, [], [mode]);
	const started = performance.now();
	await expect(hub.discover()).rejects.toMatchObject({ code });
	if (mode === "hang") expect(performance.now() - started).toBeGreaterThanOrEqual(10_000);
	const closing = performance.now();
	await hub.close();
	await hub.close();
	expect(performance.now() - closing).toBeLessThan(5_000);
});

for (const phase of ["startup", "tools/list"] as const) {
	it.each([-1, 0, 1])(
		`fences the ${phase} valid response at deadline offset %i before its timer runs`,
		async (offset) => {
			const wallNow = performance.now.bind(performance);
			const wallStarted = wallNow();
			let monotonic = wallStarted;
			let armed = false;
			let observed = 0;
			const budget = phase === "startup" ? 10_000 : 30_000;
			const open = pluginStdio.openPluginStdio;
			vi.spyOn(performance, "now").mockImplementation(() => monotonic);
			vi.spyOn(pluginStdio, "openPluginStdio").mockImplementation(async (options) => {
				const opened = await open(options);
				return {
					...opened,
					attach(child) {
						const io = opened.attach(child);
						io.outputs[0].prependListener("data", () => {
							if (armed) {
								monotonic += budget + offset;
								armed = false;
								observed++;
							}
						});
						return io;
					},
				};
			});
			const hub = hubFor(channelFixture(), fixtures.channel);
			if (phase === "tools/list") await hub.discover();
			armed = true;
			const result = phase === "startup" ? hub.discover() : hub.listTools();
			if (offset < 0) {
				if (phase === "startup") expect((await result).supportedVersions).toContain("2026-07-28");
				else
					expect((await result).tools).toEqual(
						expect.arrayContaining([expect.objectContaining({ name: "channel_fetch" })]),
					);
			} else
				await expect(result).rejects.toMatchObject({
					code: phase === "startup" ? "PROCESS_START_TIMEOUT" : "PROCESS_REQUEST_TIMEOUT",
				});
			expect(observed).toBe(1);
			expect(wallNow() - wallStarted).toBeLessThan(budget);
		},
	);
}

it("cancels active and pending channel calls when the hub closes", async () => {
	const entered = Promise.withResolvers<AbortSignal>();
	let dispatched = 0;
	const fake = createFake(
		{
			fetch: (request) => {
				dispatched++;
				entered.resolve(request.signal);
				return new Promise<Response>((_resolve, reject) =>
					request.signal.addEventListener("abort", () => reject(request.signal.reason), {
						once: true,
					}),
				);
			},
		},
		{ host: "hello.draftyak.example" },
	);
	const hub = hubFor(channelFixture(), fixtures.channel, [fake]);
	await hub.discover();
	const pending = hub.call("channel_fetch", {
		url: "https://hello.draftyak.example/v1/conversations",
	});
	const outcome = pending.then(
		() => ({ fulfilled: true }),
		(error: unknown) => ({ fulfilled: false, error }),
	);
	const signal = await Promise.race([
		entered.promise,
		pending.then(() => {
			throw new Error("Pending request unexpectedly completed");
		}),
	]);
	const second = hub.call("channel_fetch", {
		url: "https://hello.draftyak.example/v1/conversations?cursor=second",
	});
	const secondOutcome = second.then(
		() => ({ fulfilled: true }),
		(error: unknown) => ({ fulfilled: false, error }),
	);
	await hub.close();
	expect(signal.aborted).toBe(true);
	expect(await outcome).toMatchObject({ fulfilled: false, error: { code: "DENIED" } });
	expect(await secondOutcome).toMatchObject({ fulfilled: false, error: { code: "DENIED" } });
	expect(dispatched).toBe(1);
	await expect(hub.call("channel_fetch", {})).rejects.toMatchObject({ code: "HOST_CLOSED" });
});

it("bounds an active request and its pending queue at the original request deadline", async () => {
	const entered = Promise.withResolvers<void>();
	const requests: string[] = [];
	const fake = createFake(
		{
			fetch(request) {
				const label = new URL(request.url).searchParams.get("cursor") ?? "";
				requests.push(label);
				if (label === "retired") entered.resolve();
				return new Response("synthetic gate");
			},
		},
		{ host: "hello.draftyak.example" },
	);
	const hub = hubFor(probeFixture(), fixtures.probe, [fake]);
	await hub.discover();
	const started = performance.now();
	const first = hub.call("process_probe", { check: "wait", label: "retired" });
	const firstOutcome = first.then(
		() => ({ fulfilled: true }),
		(error: unknown) => ({ fulfilled: false, error }),
	);
	await Promise.race([
		entered.promise,
		first.then(() => {
			throw new Error("Wait fixture did not enter");
		}),
	]);
	const queuedAt = performance.now();
	const queued = hub.call("process_probe", { check: "wait", label: "queued" });
	const queuedOutcome = queued.then(
		() => ({ fulfilled: true }),
		(error: unknown) => ({ fulfilled: false, error }),
	);
	const outcomes = await Promise.all([firstOutcome, queuedOutcome]);
	const finished = performance.now();
	expect(outcomes).toEqual([
		expect.objectContaining({
			fulfilled: false,
			error: expect.objectContaining({ code: "TIMEOUT" }),
		}),
		expect.objectContaining({
			fulfilled: false,
			error: expect.objectContaining({ code: "PROCESS_CLOSED" }),
		}),
	]);
	expect(finished - started).toBeGreaterThanOrEqual(30_000);
	expect(finished - queuedAt).toBeLessThan(45_000);
	console.info(
		JSON.stringify({ activeElapsedMs: finished - started, queuedElapsedMs: finished - queuedAt }),
	);
	expect(requests[0]).toBe("retired");
	expect(requests.filter((label) => label === "queued").length).toBeLessThanOrEqual(1);
	await expect(hub.call("process_probe", { check: "facts" })).rejects.toMatchObject({
		code: "PROCESS_CLOSED",
	});
});

it("ignores an exact retired reply ID while a new process call receives its own reply", async () => {
	const hub = hubFor(probeFixture(), fixtures.probe);
	const retired = await hub.call("process_probe", { check: "late", label: "retired" });
	expect(retired.isError).not.toBe(true);
	expect(retired.structuredContent).toMatchObject({ marker: "retired", oldId: expect.anything() });
	const fresh = await hub.call("process_probe", { check: "flush", label: "fresh" });
	expect(fresh.isError).not.toBe(true);
	expect(fresh.structuredContent).toMatchObject({
		marker: "fresh",
		aborted: true,
		oldId: expect.anything(),
		currentId: expect.anything(),
	});
	const ids = fresh.structuredContent as { oldId: string | number; currentId: string | number };
	expect(ids.oldId).toBe((retired.structuredContent as { oldId: string | number }).oldId);
	expect(ids.oldId).not.toBe(ids.currentId);
	await facts(hub);
});

it("drives the preserved provider fixture and its host progress through the production process", async () => {
	const root = await ownedDirectory();
	const packed = path.join(root, "provider");
	await mkdir(packed, { mode: 0o700 });
	await build({
		config: false,
		entry: {
			server: fileURLToPath(
				new URL("../../sdk/test/fixtures/provider-progress-stdio.ts", import.meta.url),
			),
		},
		outDir: packed,
		platform: "node",
		format: "esm",
		target: "node26",
		fixedExtension: true,
		deps: { alwaysBundle: [/.*/] },
		dts: false,
		sourcemap: false,
		clean: false,
		exports: false,
		report: false,
		logLevel: "warn",
		failOnWarn: true,
	});
	expect(await readdir(packed)).toEqual(["server.mjs"]);
	const entry = defineAiProviderPlugin({
		manifest: aiManifest,
		describe() {
			throw new Error("Parent handler executed");
		},
		listModels() {
			throw new Error("Parent handler executed");
		},
		probe() {
			throw new Error("Parent handler executed");
		},
		generateDraft() {
			throw new Error("Parent handler executed");
		},
	});
	const hub = hubFor(
		{ manifest: aiManifest, entry },
		{ directory: packed, entry: "server.mjs", files: ["server.mjs"] },
	);
	expect((await hub.discover()).supportedVersions).toContain("2026-07-28");
	expect((await hub.call("ai_probe", {})).structuredContent).toEqual({ status: "ok" });
	expect(hub.host.progress).toEqual([{ token: "legacy-host-label", progress: 1, total: 2 }]);
	expect((await hub.call("ai_models_list", {})).structuredContent).toEqual({ models: [] });
	expect(
		(
			await hub.call("ai_draft_generate", {
				model: "test-model",
				system: "Instructions",
				prompt: "Message",
				contextIds: [],
			})
		).structuredContent,
	).toMatchObject({ kind: "unexpected", model: "test-model" });
});

import { spawn } from "node:child_process";
import { closeSync, openSync } from "node:fs";
