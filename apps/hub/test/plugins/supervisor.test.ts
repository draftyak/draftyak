import childProcess from "node:child_process";
import { getEventListeners } from "node:events";
import {
	chmodSync,
	existsSync,
	linkSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	realpathSync,
	rmSync,
	statSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import path from "node:path";
import { Stream } from "node:stream";
import { validateManifest } from "@draftyak/protocol/manifest";
import { PLUGIN_NEVER_FLAGS } from "@draftyak/protocol/plugin-argv";
import * as pluginStdio from "@draftyak/protocol/plugin-stdio";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as artifacts from "../../src/artifacts/index.ts";
import { Activation } from "../../src/plugins/supervisor/activation.ts";
import {
	createPluginSupervisor,
	isSupervisedProcess,
	type PluginActivation,
	PluginHostRefusal,
	type PluginHostRequestContext,
	type PluginSupervisor,
	PluginSupervisorError,
	type ReviewedGeneration,
	type SupervisedProcess,
	type SupervisorEvent,
} from "../../src/plugins/supervisor/index.ts";
import { Instance } from "../../src/plugins/supervisor/instance.ts";
import * as memory from "../../src/plugins/supervisor/memory.ts";
import * as runtime from "../../src/plugins/supervisor/runtime.ts";
import { FakeClock, settle } from "../kernel/fake-clock.ts";
import {
	canary,
	endEpoch,
	epoch,
	generation,
	type HostCall,
	isAlive,
	type LineOptions,
	lineBundle,
	makeRoots,
	type Roots,
	recordingHost,
	ulid,
	until,
} from "./supervisor-helpers.ts";

const windows = process.platform === "win32";
const PLUGIN = "dytest-plugin";
let roots: Roots;
let clock: FakeClock;
let supervisors: PluginSupervisor[];
let pids: Set<number>;
let reading: (pid: number) => number | undefined;
let samples: number;

beforeEach(() => {
	roots = makeRoots();
	clock = new FakeClock();
	supervisors = [];
	pids = new Set();
	samples = 0;
	reading = () => 64 << 20;
	// Unit tests drive the watchdog's decisions; the real per-OS readers have their own tests.
	vi.spyOn(memory, "createSampler").mockImplementation(() => ({
		sample: async (list) => {
			samples++;
			return new Map(list.map((pid) => [pid, reading(pid)]));
		},
		close() {},
	}));
});

afterEach(async () => {
	for (const supervisor of supervisors) await supervisor.close();
	vi.restoreAllMocks();
	for (const pid of pids) expect(isAlive(pid)).toBe(false);
	roots.cleanup();
});

type Host = ReturnType<typeof recordingHost>;

async function open(
	host: Host = recordingHost(),
	events: SupervisorEvent[] = [],
): Promise<PluginSupervisor> {
	const supervisor = await createPluginSupervisor({
		dataRoot: roots.dataRoot,
		stdioRoot: roots.stdioRoot,
		host,
		clock,
		onEvent: (event) => events.push(event),
	});
	supervisors.push(supervisor);
	return supervisor;
}

let bundleCount = 0;
function bundlePath(): string {
	return path.join(roots.bundles, `b${++bundleCount}`);
}

type GenerationOptions = NonNullable<Parameters<typeof generation>[1]>;

async function activate(
	supervisor: PluginSupervisor,
	options: GenerationOptions & { line?: LineOptions } = {},
	activationEpoch: { id: string; signal: AbortSignal } = epoch(),
): Promise<PluginActivation> {
	return supervisor.activate(generation(lineBundle(bundlePath(), options.line), options), {
		epoch: activationEpoch,
	});
}

interface Setup {
	readonly supervisor: PluginSupervisor;
	readonly activation: PluginActivation;
	readonly handle: SupervisedProcess;
	readonly events: SupervisorEvent[];
	readonly host: Host;
	readonly directory: string;
	readonly reviewed: ReviewedGeneration;
}

async function setup(
	options: { line?: LineOptions; host?: Host; generation?: GenerationOptions } = {},
): Promise<Setup> {
	const events: SupervisorEvent[] = [];
	const host = options.host ?? recordingHost();
	const supervisor = await open(host, events);
	const directory = bundlePath();
	const reviewed = generation(lineBundle(directory, options.line), options.generation);
	const activation = await supervisor.activate(reviewed, { epoch: epoch() });
	return {
		supervisor,
		activation,
		handle: activation.instance(ulid()),
		events,
		host,
		directory,
		reviewed,
	};
}

async function code(promise: Promise<unknown> | (() => unknown)): Promise<string | undefined> {
	try {
		await (typeof promise === "function" ? promise() : promise);
		return undefined;
	} catch (error) {
		return error instanceof PluginSupervisorError ? error.code : `other:${String(error)}`;
	}
}

function refusal(action: () => unknown): string | undefined {
	try {
		action();
		return undefined;
	} catch (error) {
		return error instanceof PluginSupervisorError ? error.code : `other:${String(error)}`;
	}
}

interface Counts {
	readonly pid: number;
	readonly requests: Record<string, number>;
	readonly calls: string[];
	readonly cancelled: unknown[];
	readonly notifications: string[];
	readonly answeredBefore: number[];
	readonly lastMeta: Record<string, unknown> | null;
}

async function counts(handle: SupervisedProcess): Promise<Counts> {
	const result = (await handle.callTool("run", { do: "count" })) as Counts;
	pids.add(result.pid);
	return result;
}

async function pidOf(handle: SupervisedProcess): Promise<number> {
	return (await counts(handle)).pid;
}

function reasons(events: readonly SupervisorEvent[], type: SupervisorEvent["type"]): unknown[] {
	return events
		.filter((event) => event.type === type)
		.map((event) => ("reason" in event ? event.reason : undefined));
}

async function tick(ms: number): Promise<void> {
	clock.advance(ms);
	await settle();
}

function lastPid(spawn: { mock: { results: { value: unknown }[] } }): number {
	return (spawn.mock.results.at(-1) as { value: { pid: number } }).value.pid;
}

function base64(text: string | Buffer): string {
	return Buffer.from(text).toString("base64");
}

const LOG = { level: "info", message: "DYTEST log" } as const;

describe("supervisor creation", () => {
	it("refuses invalid options, roots and hosts", async () => {
		const host = recordingHost();
		mkdirSync(path.join(roots.dataRoot, "inner"));
		const comma = path.join(roots.base, "a,b");
		mkdirSync(comma, { mode: 0o700 });
		const valid = { dataRoot: roots.dataRoot, stdioRoot: roots.stdioRoot, host };
		const cases: unknown[] = [
			{ ...valid, extra: true },
			{ dataRoot: roots.dataRoot, stdioRoot: roots.stdioRoot },
			{ ...valid, host: {} },
			{ ...valid, host: { request: "no" } },
			{ ...valid, host: new Proxy(host, {}) },
			{ ...valid, dataRoot: roots.stdioRoot },
			{ ...valid, stdioRoot: path.join(roots.dataRoot, "inner") },
			{ ...valid, dataRoot: path.join(roots.base, "missing") },
			{ ...valid, dataRoot: `${roots.dataRoot}${path.sep}.${path.sep}` },
			{ ...valid, dataRoot: "relative" },
			{ ...valid, dataRoot: comma },
			{ ...valid, clock: { after: 1 } },
			{ ...valid, onEvent: "no" },
			Object.defineProperty({ ...valid }, "dataRoot", {
				get: () => roots.dataRoot,
				enumerable: true,
			}),
			new Proxy(valid, {}),
		];
		for (const options of cases)
			expect(await code(createPluginSupervisor(options as never))).toBe("CONFIG_INVALID");
	});

	it("refuses an aliased root", { tags: ["requires:symlink-privilege"] }, async () => {
		const link = path.join(roots.base, "alias");
		symlinkSync(roots.dataRoot, link, "dir");
		expect(
			await code(
				createPluginSupervisor({
					dataRoot: link,
					stdioRoot: roots.stdioRoot,
					host: recordingHost(),
				}),
			),
		).toBe("CONFIG_INVALID");
	});

	it("refuses POSIX roots open to others", { tags: ["requires:posix"] }, async () => {
		const shared = path.join(roots.base, "shared");
		mkdirSync(shared, { mode: 0o700 });
		chmodSync(shared, 0o750);
		expect(
			await code(
				createPluginSupervisor({
					dataRoot: shared,
					stdioRoot: roots.stdioRoot,
					host: recordingHost(),
				}),
			),
		).toBe("CONFIG_INVALID");
	});

	it("checks the Node floor and refuses shim executables", async () => {
		const actual = runtime.currentRuntime();
		const spy = vi.spyOn(runtime, "currentRuntime");
		spy.mockReturnValue({ ...actual, version: "26.5.0" });
		expect(await code(open())).toBe("RUNTIME_UNSUPPORTED");
		spy.mockReturnValue({ ...actual, version: "26.5.1" });
		expect(await code(open())).toBeUndefined();
		const shim = path.join(roots.base, "node.cmd");
		writeFileSync(shim, "");
		spy.mockReturnValue({ ...actual, execPath: shim });
		expect(await code(open())).toBe("RUNTIME_UNSUPPORTED");
		spy.mockReturnValue({ ...actual, release: "io.js" });
		expect(await code(open())).toBe("RUNTIME_UNSUPPORTED");
		spy.mockReturnValue({ ...actual, platform: "freebsd" });
		expect(await code(open())).toBe("RUNTIME_UNSUPPORTED");
		if (windows) {
			spy.mockReturnValue({ ...actual, systemRoot: undefined });
			expect(await code(open())).toBe("RUNTIME_UNSUPPORTED");
			spy.mockReturnValue({ ...actual, systemRoot: "WINDOWS" });
			expect(await code(open())).toBe("RUNTIME_UNSUPPORTED");
		}
	});
});

describe("generation intake", () => {
	it("refuses anything but a node channel or AI-provider generation, before any process", async () => {
		const spawn = vi.spyOn(childProcess, "spawn");
		const supervisor = await open();
		const bundle = lineBundle(bundlePath());
		const good = generation(bundle);
		const inventory = (entry: string) => ({
			...good,
			bundle: { ...bundle, inventory: { ...bundle.inventory, entry } },
		});
		const variants: [unknown, string][] = [
			[{ ...good, manifest: { ...good.manifest, kind: "tool" } }, "GENERATION_INVALID"],
			[{ ...good, manifest: { ...good.manifest, runtime: "python" } }, "GENERATION_INVALID"],
			[{ ...good, pluginId: "other-plugin" }, "GENERATION_INVALID"],
			[{ ...good, generation: "g 1" }, "GENERATION_INVALID"],
			[{ ...good, generation: "g".repeat(129) }, "GENERATION_INVALID"],
			[{ ...good, acceptSurface: true }, "GENERATION_INVALID"],
			[{ ...good, extra: 1 }, "GENERATION_INVALID"],
			[
				{ ...good, pluginId: "con", manifest: { ...good.manifest, id: "con" } },
				"GENERATION_INVALID",
			],
			[inventory("main.cjs"), "GENERATION_INVALID"],
			[inventory("../main.mjs"), "BUNDLE_REFUSED"],
			[inventory("missing.mjs"), "BUNDLE_REFUSED"],
			[generation(lineBundle(path.join(roots.dataRoot, "inside"))), "BUNDLE_REFUSED"],
			[generation(lineBundle(path.join(roots.stdioRoot, "inside"))), "BUNDLE_REFUSED"],
			[generation(lineBundle(path.join(roots.base, "x=y"))), "BUNDLE_REFUSED"],
		];
		for (const [value, expected] of variants)
			expect(await code(supervisor.activate(value as never, { epoch: epoch() }))).toBe(expected);
		const ended = epoch();
		endEpoch(ended);
		const epochs: unknown[] = [
			{ id: "bad id", signal: new AbortController().signal },
			ended,
			{ id: "e", signal: {} },
			{ id: "e", signal: new AbortController().signal, extra: 1 },
		];
		for (const value of epochs)
			expect(await code(supervisor.activate(good, { epoch: value as never }))).toBe(
				"EPOCH_INVALID",
			);
		expect(await code(supervisor.activate(good, {} as never))).toBe("EPOCH_INVALID");
		expect(spawn).not.toHaveBeenCalled();
	});

	it("refuses a valid tool generation, whose instance rules are postponed", async () => {
		const spawn = vi.spyOn(childProcess, "spawn");
		const supervisor = await open();
		const tool = {
			id: PLUGIN,
			version: "1.0.0",
			sdk: "1.0.0",
			isolation: "standard",
			kind: "tool",
			contract: { extension: "io.github.draftyak/tool", version: 1 },
			auth: { kind: "none", scopes: [], requiredGrantedScopes: [] },
			credentials: { mode: "brokered", urlSecrets: [] },
			permissions: {},
			dataClasses: ["tool.kb.lookup"],
			license: "Apache-2.0",
			egress: { rules: [] },
			tool: {
				kinds: [
					{
						kind: "kb.lookup",
						inputs: ["topic"],
						output: { dataClass: "tool.kb.lookup", maxBytes: 1024 },
					},
				],
			},
		};
		// The manifest itself is valid: only the supervisor's own kind check stands in the way.
		expect(validateManifest(tool).ok).toBe(true);
		const reviewed = { ...generation(lineBundle(bundlePath())), manifest: tool };
		expect(await code(supervisor.activate(reviewed as never, { epoch: epoch() }))).toBe(
			"GENERATION_INVALID",
		);
		expect(spawn).not.toHaveBeenCalled();
	});

	it("admits one live or pending activation per plugin id", async () => {
		const supervisor = await open();
		const first = supervisor.activate(generation(lineBundle(bundlePath())), { epoch: epoch() });
		const second = supervisor.activate(generation(lineBundle(bundlePath())), { epoch: epoch() });
		expect(await code(second)).toBe("ACTIVATION_CONFLICT");
		const activation = await first;
		expect(await code(activate(supervisor))).toBe("ACTIVATION_CONFLICT");
		const revoked = activation.revoke("upgrade");
		const next = activate(supervisor, { generation: "g2" });
		expect(await code(next)).toBeUndefined();
		await revoked;
	});
});

describe("launch", () => {
	interface Facts {
		readonly pid: number;
		readonly execArgv: string[];
		readonly entry: string;
		readonly envNames: string[];
		readonly env: Record<string, string>;
		readonly channel: boolean;
		readonly send: string;
	}

	async function facts(handle: SupervisedProcess): Promise<Facts> {
		const result = (await handle.callTool("run", { do: "facts" })) as Facts;
		pids.add(result.pid);
		return result;
	}

	it("spawns the exact production argv, with the data grant only when declared", async () => {
		const spawn = vi.spyOn(childProcess, "spawn");
		for (const dataDir of [false, true]) {
			const pluginId = dataDir ? "dytest-data" : "dytest-plain";
			const { handle, directory } = await setup({ generation: { pluginId, dataDir } });
			const reported = await facts(handle);
			const [execPath, argv, options] = spawn.mock.calls.at(-1) as unknown as [
				string,
				string[],
				Record<string, unknown>,
			];
			const entry = path.join(directory, "main.mjs");
			const data = path.join(roots.dataRoot, pluginId, handle.instanceId);
			expect(execPath).toBe(realpathSync.native(process.execPath));
			expect(argv).toEqual([
				"--permission",
				`--allow-fs-read=${directory}`,
				...(dataDir ? [`--allow-fs-read=${data}`, `--allow-fs-write=${data}`] : []),
				"--no-experimental-sqlite",
				"--disable-sigusr1",
				"--disallow-code-generation-from-strings",
				"--freeze-flags-after-init",
				"--max-old-space-size=256",
				entry,
			]);
			expect(reported.execArgv).toEqual(argv.slice(0, -1));
			expect(reported.entry).toBe(entry);
			for (const flag of argv) {
				expect(PLUGIN_NEVER_FLAGS).not.toContain(flag.split("=")[0]);
				expect(flag).not.toMatch(/^--(?:inspect|debug)/);
			}
			expect(options).toMatchObject({
				cwd: directory,
				shell: false,
				detached: false,
				windowsHide: true,
			});
		}
	});

	it("passes exactly the scrubbed environment", async () => {
		const secret = canary("env");
		const injected: Record<string, string> = {
			NODE_OPTIONS: "--inspect",
			NODE_PATH: roots.base,
			LD_PRELOAD: "dytest.so",
			DYLD_INSERT_LIBRARIES: "dytest.dylib",
			DYTEST_CANARY: secret,
		};
		Object.assign(process.env, injected);
		try {
			const { handle } = await setup();
			const reported = await facts(handle);
			const data = path.join(roots.dataRoot, PLUGIN, handle.instanceId);
			const copied = ["LANG", "TZ"].filter((name) =>
				/^[\x20-\x7e]{1,256}$/.test(process.env[name] ?? ""),
			);
			const dataNames = windows
				? ["USERPROFILE", "APPDATA", "LOCALAPPDATA", "TEMP", "TMP"]
				: ["HOME", "TMPDIR"];
			const emptyNames = windows
				? [
						"HOMEDRIVE",
						"HOMEPATH",
						"LOGONSERVER",
						"PATH",
						"SYSTEMDRIVE",
						"USERDOMAIN",
						"USERNAME",
						"WINDIR",
					]
				: [];
			const names = reported.envNames.filter(
				(name) => !(process.platform === "darwin" && name === "__CF_USER_TEXT_ENCODING"),
			);
			expect(names).toEqual(
				[
					"DRAFTYAK_PLUGIN_ID",
					"DRAFTYAK_INSTANCE_ID",
					...copied,
					...dataNames,
					...emptyNames,
					...(windows ? ["SystemRoot"] : []),
				].sort(),
			);
			expect(reported.env.DRAFTYAK_PLUGIN_ID).toBe(PLUGIN);
			expect(reported.env.DRAFTYAK_INSTANCE_ID).toBe(handle.instanceId);
			for (const name of dataNames) expect(reported.env[name]).toBe(data);
			for (const name of emptyNames) expect(reported.env[name]).toBe("");
			if (windows) expect(reported.env.SystemRoot).toBe(process.env.SystemRoot);
			expect(JSON.stringify(reported)).not.toContain(secret);
		} finally {
			for (const name of Object.keys(injected)) delete process.env[name];
		}
	});

	it("gives the plugin exactly three stdio descriptors and no IPC channel", async () => {
		const spawn = vi.spyOn(childProcess, "spawn");
		const opened = vi.spyOn(pluginStdio, "openPluginStdio");
		const { handle } = await setup();
		const reported = await facts(handle);
		expect(opened).toHaveBeenCalledWith({ parentDir: roots.stdioRoot });
		const stdio = (
			spawn.mock.calls.at(-1) as unknown as [string, string[], { stdio: unknown[] }]
		)[2].stdio;
		expect(stdio).toHaveLength(3);
		if (windows) expect(stdio).toEqual(["pipe", "pipe", "pipe"]);
		else expect(stdio.every((entry) => Number.isInteger(entry))).toBe(true);
		expect(stdio).not.toContain("ipc");
		expect(reported.channel).toBe(true);
		expect(reported.send).toBe("undefined");
		expect(reported.envNames).not.toContain("NODE_CHANNEL_FD");
	});

	describe("re-hash before every spawn", () => {
		const tamper: Record<string, (directory: string) => void> = {
			"a same-size rewrite": (directory) => {
				const file = path.join(directory, "main.mjs");
				const bytes = readFileSync(file);
				bytes[bytes.length - 2] = bytes[bytes.length - 2] === 0x3b ? 0x20 : 0x3b;
				writeFileSync(file, bytes);
			},
			"an extra file": (directory) =>
				writeFileSync(path.join(directory, "extra.mjs"), "export {};"),
			"a missing file": (directory) => rmSync(path.join(directory, "line-plugin.mjs")),
			"a hard link to a member": (directory) =>
				linkSync(
					path.join(directory, "line-plugin.mjs"),
					path.join(roots.base, "outside-link.mjs"),
				),
		};
		for (const [name, change] of Object.entries(tamper))
			it(`refuses the next spawn after ${name}`, async () => {
				const { handle, activation, events, directory } = await setup();
				await pidOf(handle);
				await handle.stop();
				change(directory);
				const spawned = reasons(events, "spawned").length;
				expect(await code(handle.callTool("run", {}))).toBe("BUNDLE_REFUSED");
				expect(reasons(events, "spawned")).toHaveLength(spawned);
				expect(activation.revoked).toBe(true);
				expect(events).toContainEqual({
					type: "revoked",
					pluginId: PLUGIN,
					generation: "g1",
					reason: "bundle",
				});
			});

		it("refuses a symlinked member", { tags: ["requires:symlink-privilege"] }, async () => {
			const { handle, activation, directory } = await setup();
			await pidOf(handle);
			await handle.stop();
			const member = path.join(directory, "line-plugin.mjs");
			const outside = path.join(roots.base, "outside.mjs");
			writeFileSync(outside, readFileSync(member));
			rmSync(member);
			symlinkSync(outside, member, "file");
			expect(await code(handle.callTool("run", {}))).toBe("BUNDLE_REFUSED");
			expect(activation.revoked).toBe(true);
		});

		it("verifies again at every spawn, not only at activation", async () => {
			const verify = vi.spyOn(artifacts, "verifyBundle");
			const { handle } = await setup();
			expect(verify).toHaveBeenCalledTimes(1);
			await pidOf(handle);
			expect(verify).toHaveBeenCalledTimes(2);
			await handle.stop();
			await pidOf(handle);
			expect(verify).toHaveBeenCalledTimes(3);
		});
	});

	describe("data directories", () => {
		it("are made 0700 and kept", { tags: ["requires:posix"] }, async () => {
			const { handle } = await setup();
			await pidOf(handle);
			for (const level of [
				path.join(roots.dataRoot, PLUGIN),
				path.join(roots.dataRoot, PLUGIN, handle.instanceId),
			])
				expect(statSync(level).mode & 0o777).toBe(0o700);
		});

		it("refuse a linked component", async () => {
			const elsewhere = path.join(roots.base, "elsewhere");
			mkdirSync(elsewhere, { mode: 0o700 });
			// Junctions and POSIX symlinks need no privilege.
			symlinkSync(elsewhere, path.join(roots.dataRoot, PLUGIN), windows ? "junction" : "dir");
			const { handle, events } = await setup();
			expect(await code(handle.callTool("run", {}))).toBe("DATA_DIR_REFUSED");
			expect(reasons(events, "spawned")).toHaveLength(0);
		});

		it("refuse a non-canonical spelling", { tags: ["requires:windows"] }, async () => {
			mkdirSync(path.join(roots.dataRoot, PLUGIN.toUpperCase()));
			const { handle } = await setup();
			expect(await code(handle.callTool("run", {}))).toBe("DATA_DIR_REFUSED");
		});

		it("are readable and writable only with the declared permission", async () => {
			const plain = await setup();
			const plainDir = path.join(roots.dataRoot, PLUGIN, plain.handle.instanceId);
			await pidOf(plain.handle);
			expect(
				await plain.handle.callTool("run", { do: "read-file", path: path.join(plainDir, "x") }),
			).toEqual({ code: "ERR_ACCESS_DENIED" });
			expect(
				await plain.handle.callTool("run", { do: "write-file", path: path.join(plainDir, "x") }),
			).toEqual({ code: "ERR_ACCESS_DENIED" });
			const declared = await setup({ generation: { pluginId: "dytest-data", dataDir: true } });
			const declaredDir = path.join(roots.dataRoot, "dytest-data", declared.handle.instanceId);
			await pidOf(declared.handle);
			const file = path.join(declaredDir, "state.txt");
			expect(await declared.handle.callTool("run", { do: "write-file", path: file })).toEqual({
				ok: true,
			});
			expect(readFileSync(file, "utf8")).toBe("DYTEST data");
			expect(
				await declared.handle.callTool("run", {
					do: "read-file",
					path: path.join(roots.dataRoot, "x"),
				}),
			).toEqual({ code: "ERR_ACCESS_DENIED" });
		});
	});
});

describe("startup", () => {
	it("reaches ready after discover, tools/list and an exact true from acceptSurface", async () => {
		const seen: unknown[] = [];
		const { handle, events } = await setup({
			generation: {
				acceptSurface: (surface) => {
					seen.push(surface);
					return true;
				},
			},
		});
		const result = await counts(handle);
		expect(result.requests).toEqual({ "server/discover": 1, "tools/list": 1, "tools/call": 1 });
		expect(result.lastMeta).toEqual({
			"io.modelcontextprotocol/protocolVersion": "2026-07-28",
			"io.modelcontextprotocol/clientCapabilities": {},
			"io.modelcontextprotocol/clientInfo": { name: "draftyak-hub", version: "0.0.0" },
		});
		expect(seen).toHaveLength(1);
		expect(Object.isFrozen(seen[0])).toBe(true);
		const surface = seen[0] as { tools: { tools: { name: string }[] } };
		expect(surface.tools.tools.map((tool) => tool.name)).toEqual(["run", "channel_sync"]);
		expect(reasons(events, "spawned")).toHaveLength(1);
		expect(reasons(events, "ready")).toHaveLength(1);
	});

	const surfaceRefusals: [string, ReviewedGeneration["acceptSurface"], LineOptions?][] = [
		["false", () => false],
		[
			"a throw",
			() => {
				throw new Error(canary("surface"));
			},
		],
		["a truthy non-true value", () => 1 as never],
		["a paginated tools list", () => true, { nextCursor: true }],
		["an invalid tool name", () => true, { tools: ["bad name"] }],
	];
	for (const [name, acceptSurface, line] of surfaceRefusals)
		it(`refuses the surface on ${name}: kill, crash and revoke`, async () => {
			const spawn = vi.spyOn(childProcess, "spawn");
			const { handle, activation, events } = await setup({
				generation: { acceptSurface },
				...(line ? { line } : {}),
			});
			expect(await code(handle.callTool("run", {}))).toBe("ACTIVATION_REVOKED");
			const pid = lastPid(spawn);
			pids.add(pid);
			await until(() => !isAlive(pid));
			expect(activation.revoked).toBe(true);
			await vi.waitFor(() => expect(reasons(events, "crashed")).toEqual(["surface"]));
			expect(reasons(events, "revoked")).toEqual(["surface"]);
		});

	it("times out a silent plugin after ten seconds", async () => {
		const spawn = vi.spyOn(childProcess, "spawn");
		const { handle, events } = await setup({ line: { startup: "silent" } });
		const pending = code(handle.callTool("run", {}));
		await vi.waitFor(() => expect(reasons(events, "spawned")).toHaveLength(1));
		const pid = lastPid(spawn);
		pids.add(pid);
		await tick(9_999);
		expect(isAlive(pid)).toBe(true);
		await tick(1);
		expect(await pending).toBe("START_TIMEOUT");
		await vi.waitFor(() => expect(reasons(events, "crashed")).toEqual(["start-timeout"]));
	});

	it("fails waiters when the plugin exits during startup", async () => {
		const { handle, events } = await setup({ line: { startup: "crash" } });
		expect(await code(handle.callTool("run", {}))).toBe("START_FAILED");
		expect(reasons(events, "crashed")).toEqual(["exit"]);
	});
});

describe("calls", () => {
	it("starts lazily, answers a call and resolves a deep-frozen result", async () => {
		const { handle, events } = await setup();
		expect(events).toEqual([]);
		const result = (await handle.callTool("run", { do: "echo", value: { nested: [1] } })) as {
			echo: { nested: number[] };
		};
		expect(result).toEqual({ echo: { nested: [1] } });
		expect(Object.isFrozen(result)).toBe(true);
		expect(Object.isFrozen(result.echo) && Object.isFrozen(result.echo.nested)).toBe(true);
		expect(events.map((event) => event.type)).toEqual(["spawned", "ready"]);
		await pidOf(handle);
	});

	it("refuses unknown tools without writing, bad options, oversized arguments and error replies", async () => {
		const { handle } = await setup();
		await pidOf(handle);
		expect(await code(handle.callTool("missing_tool", {}))).toBe("TOOL_UNKNOWN");
		expect(await code(handle.callTool("bad name", {}))).toBe("TOOL_UNKNOWN");
		expect(await code(handle.callTool("run", { blob: "x".repeat(1_048_577) }))).toBe(
			"FRAME_TOO_LARGE",
		);
		expect(await code(handle.callTool("run", [] as never))).toBe("REQUEST_INVALID");
		expect(await code(handle.callTool("run", { value: 1n } as never))).toBe("REQUEST_INVALID");
		expect(await code(handle.callTool("run", {}, { timeoutMs: 0 }))).toBe("REQUEST_INVALID");
		expect(await code(handle.callTool("run", {}, { timeoutMs: 30_001 }))).toBe("REQUEST_INVALID");
		expect(await code(handle.callTool("channel_sync", {}, { timeoutMs: 120_001 }))).toBe(
			"REQUEST_INVALID",
		);
		expect(await code(handle.callTool("run", {}, { signal: {} as AbortSignal }))).toBe(
			"REQUEST_INVALID",
		);
		expect(await code(handle.callTool("run", {}, { extra: 1 } as never))).toBe("REQUEST_INVALID");
		expect(await code(handle.callTool("run", {}, { signal: AbortSignal.abort() }))).toBe(
			"CALL_CANCELLED",
		);
		const secret = canary("rpc");
		try {
			await handle.callTool("run", { do: "error", code: -32042, message: secret, data: secret });
			expect.unreachable();
		} catch (error) {
			expect(error).toBeInstanceOf(PluginSupervisorError);
			expect((error as PluginSupervisorError).code).toBe("PLUGIN_RPC_ERROR");
			expect((error as PluginSupervisorError).rpcCode).toBe(-32042);
			expect(JSON.stringify(error)).not.toContain(secret);
			expect(String(error)).not.toContain(secret);
		}
		expect((await counts(handle)).calls).toEqual(["run", "run", "run"]);
	});

	it("still resolves a reply written just before the plugin exits", async () => {
		const { handle, events } = await setup();
		await pidOf(handle);
		expect(await handle.callTool("run", { do: "exit-after-reply", code: 0 })).toEqual({
			last: true,
		});
		await vi.waitFor(() => expect(reasons(events, "crashed")).toEqual(["exit"]));
	});

	it("delivers progress for its own token, in order, during the call only", async () => {
		const { handle } = await setup();
		await pidOf(handle);
		const updates: unknown[] = [];
		const result = (await handle.callTool(
			"run",
			{ do: "progress", values: [1, 2, 3], total: 3 },
			{
				onProgress: (update) => {
					updates.push(update);
					if (update.progress === 2) throw new Error("listener failure");
				},
			},
		)) as { token: string };
		expect(typeof result.token).toBe("string");
		expect(updates).toEqual([
			{ progress: 1, total: 3 },
			{ progress: 2, total: 3 },
			{ progress: 3, total: 3 },
		]);
		const others: unknown[] = [];
		await handle.callTool(
			"run",
			{ do: "progress", values: [5], token: "foreign" },
			{ onProgress: (update) => others.push(update) },
		);
		expect(others).toEqual([]);
	});

	it("runs calls one at a time and attributes host requests to the call in flight", async () => {
		const host = recordingHost();
		const { handle } = await setup({ host });
		await pidOf(handle);
		const invocation = { tag: canary("invocation") };
		const first = handle.callTool("run", { do: "late", ms: 300 });
		const second = handle.callTool(
			"run",
			{ do: "host", method: "host/log", params: LOG },
			{ invocation },
		);
		const third = counts(handle);
		await first;
		expect(await second).toEqual({ answer: { result: null } });
		const answered = (await third).answeredBefore.slice(-3);
		// Each call reached the plugin only after the one before it was answered.
		expect(answered).toEqual([
			answered[0],
			(answered[0] as number) + 1,
			(answered[0] as number) + 2,
		]);
		expect(host.calls).toHaveLength(1);
		const call = host.calls[0] as HostCall;
		expect(call.method).toBe("host/log");
		expect(call.params).toEqual(LOG);
		expect(call.context.invocation).toBe(invocation);
		expect(call.context).toMatchObject({
			pluginId: PLUGIN,
			instanceId: handle.instanceId,
			generation: "g1",
			kind: "ai-provider",
		});
		expect(Object.isFrozen(call.context)).toBe(true);
		expect(call.context.signal.aborted).toBe(true);
	});

	it("admits at most sixteen calls per instance", async () => {
		const { handle } = await setup();
		await pidOf(handle);
		const stuck = Array.from({ length: 16 }, () => handle.callTool("run", { do: "never" }));
		for (const call of stuck) call.catch(() => {});
		expect(await code(handle.callTool("run", {}))).toBe("CALL_LIMIT");
	});

	it("times out, cancels and kills after the grace", async () => {
		const { handle, events } = await setup();
		const pid = await pidOf(handle);
		const pending = code(handle.callTool("run", { do: "never" }));
		await tick(29_999);
		await tick(1);
		expect(await pending).toBe("CALL_TIMEOUT");
		await tick(4_999);
		expect(isAlive(pid)).toBe(true);
		await tick(1);
		await until(() => !isAlive(pid));
		await vi.waitFor(() => expect(reasons(events, "crashed")).toEqual(["call-timeout"]));
	});

	it("discards a reply that arrives within the grace and keeps the process", async () => {
		const { handle, events } = await setup();
		const pid = await pidOf(handle);
		const pending = code(handle.callTool("run", { do: "late", ms: 400 }, { timeoutMs: 100 }));
		await tick(100);
		expect(await pending).toBe("CALL_TIMEOUT");
		const after = await counts(handle);
		expect(after.pid).toBe(pid);
		expect(after.cancelled).toHaveLength(1);
		expect(reasons(events, "crashed")).toEqual([]);
	});

	it("gives channel_sync two minutes", async () => {
		const { handle } = await setup();
		await pidOf(handle);
		let settled = false;
		const pending = code(handle.callTool("channel_sync", { do: "never" })).finally(() => {
			settled = true;
		});
		// One step, so the single catch-up liveness probe never meets its own timeout here.
		await tick(119_999);
		expect(settled).toBe(false);
		await tick(1);
		expect(await pending).toBe("CALL_TIMEOUT");
	});

	it("cancels on the caller's abort and stops the plugin when the grace runs out", async () => {
		const { handle, activation, events } = await setup();
		const pid = await pidOf(handle);
		const controller = new AbortController();
		const pending = code(handle.callTool("run", { do: "never" }, { signal: controller.signal }));
		controller.abort();
		expect(await pending).toBe("CALL_CANCELLED");
		await tick(4_999);
		expect(isAlive(pid)).toBe(true);
		await tick(1);
		await until(() => !isAlive(pid));
		// An MCP server leaves a cancelled request unanswered: the kill is the supervisor's own stop.
		await vi.waitFor(() => expect(reasons(events, "stopped")).toEqual(["cancel"]));
		expect(reasons(events, "crashed")).toEqual([]);
		expect(activation.revoked).toBe(false);
	});

	it("never counts caller cancels toward the crash budget and runs the calls queued behind them", async () => {
		const { handle, activation, events } = await setup();
		for (let cancel = 1; cancel <= 5; cancel++) {
			await pidOf(handle);
			const controller = new AbortController();
			const cancelled = code(
				handle.callTool("run", { do: "never" }, { signal: controller.signal }),
			);
			const queued = handle.callTool("run", { do: "echo", value: cancel });
			controller.abort();
			expect(await cancelled).toBe("CALL_CANCELLED");
			await tick(5_000);
			// Never sent to the stopped process, it runs on the next one.
			expect(await queued).toEqual({ echo: cancel });
		}
		expect(reasons(events, "stopped")).toEqual(Array.from({ length: 5 }, () => "cancel"));
		expect(reasons(events, "crashed")).toEqual([]);
		expect(reasons(events, "disabled")).toEqual([]);
		expect(activation.revoked).toBe(false);
	});
});

describe("decoding", () => {
	const valid = `\u001e${JSON.stringify({ jsonrpc: "2.0", id: "late", method: "host/log", params: LOG })}\n`;
	const cases: [string, string | Buffer, string][] = [
		["a NODE_HANDLE message", '{"cmd":"NODE_HANDLE","type":"net.Socket","msg":{}}\n', "handle"],
		["a tagged NODE_HANDLE message", '\u001e{"cmd":"NODE_HANDLE"}\n', "handle"],
		["a NODE_HANDLE_ACK message", '{"cmd":"NODE_HANDLE_ACK"}\n', "internal-message"],
		["a NODE_CLUSTER message", '{"cmd":"NODE_CLUSTER","act":"online"}\n', "internal-message"],
		["malformed JSON", '{"jsonrpc":\n', "parse-error"],
		["a duplicate key", '{"jsonrpc":"2.0","jsonrpc":"2.0","method":"x"}\n', "parse-error"],
		[
			"invalid UTF-8",
			Buffer.concat([
				Buffer.from('{"jsonrpc":"2.0","method":"'),
				Buffer.from([0xff]),
				Buffer.from('"}\n'),
			]),
			"parse-error",
		],
		["an empty line", "\n", "empty-line"],
		["a lone tag", "\u001e\n", "empty-line"],
		["a non-object", "[1]\n", "not-jsonrpc"],
		["an extra envelope key", '{"jsonrpc":"2.0","method":"x","extra":1}\n', "not-jsonrpc"],
		[
			"a host reply from the plugin",
			'\u001e{"jsonrpc":"2.0","id":"x","result":null}\n',
			"unexpected-frame",
		],
		[
			"a host notification from the plugin",
			'\u001e{"jsonrpc":"2.0","method":"host/stream.chunk","params":{"streamId":"s","sequence":0,"base64":"","done":true}}\n',
			"unexpected-frame",
		],
		[
			"invalid host params",
			'\u001e{"jsonrpc":"2.0","id":"x","method":"host/log","params":{"level":"loud","message":"m"}}\n',
			"bad-host-frame",
		],
	];
	for (const [name, line, kind] of cases)
		it(`kills on ${name} and dispatches nothing after it`, async () => {
			const host = recordingHost();
			const { handle, events } = await setup({ host });
			const pid = await pidOf(handle);
			const raw = Buffer.concat([Buffer.from(line), Buffer.from(valid)]);
			expect(
				await code(handle.callTool("run", { do: "raw", lines: [base64(raw)], reply: true })),
			).toBe("PLUGIN_VIOLATION");
			await until(() => !isAlive(pid));
			await vi.waitFor(() => expect(reasons(events, "crashed")).toEqual([`violation:${kind}`]));
			expect(host.calls).toEqual([]);
		});

	it("accepts exactly one frame's bytes on each channel", async () => {
		const host = recordingHost();
		const { handle } = await setup({ host });
		await pidOf(handle);
		const reply = (await handle.callTool("run", { do: "sized-reply", bytes: 1_048_576 })) as {
			pad: string;
		};
		expect(reply.pad.length).toBeGreaterThan(1_048_000);
		const hosted = await handle.callTool("run", { do: "sized-host", bytes: 1_048_576 });
		expect(hosted).toEqual({ answer: { result: null } });
		expect(host.calls.map((call) => call.method)).toEqual(["host/kv.set"]);
	});

	for (const tagged of [false, true])
		it(`refuses ${tagged ? "a tagged" : "an untagged"} line one byte over the limit before its LF`, async () => {
			const { handle, events } = await setup();
			const pid = await pidOf(handle);
			expect(
				await code(handle.callTool("run", { do: "unterminated", bytes: 1_048_577, tagged })),
			).toBe("PLUGIN_VIOLATION");
			await until(() => !isAlive(pid));
			await vi.waitFor(() => expect(reasons(events, "crashed")).toEqual(["violation:oversize"]));
		});
});

describe("host channel", () => {
	it("dispatches with a frozen context and returns tagged replies and refusals", async () => {
		const secret = canary("handler");
		let mode = "ok";
		const host = recordingHost(() => {
			if (mode === "refusal") throw new PluginHostRefusal("TOO_LARGE");
			if (mode === "throw") throw new Error(secret);
			if (mode === "invalid") return { not: "null" };
			return null;
		});
		const { handle } = await setup({ host });
		await pidOf(handle);
		const ask = () => handle.callTool("run", { do: "host", method: "host/log", params: LOG });
		expect(await ask()).toEqual({ answer: { result: null } });
		mode = "refusal";
		expect(await ask()).toEqual({ answer: { error: "TOO_LARGE" } });
		mode = "throw";
		const denied = await ask();
		expect(denied).toEqual({ answer: { error: "DENIED" } });
		expect(JSON.stringify(denied)).not.toContain(secret);
		mode = "invalid";
		expect(await ask()).toEqual({ answer: { error: "DENIED" } });
		expect(() => new PluginHostRefusal("NOPE" as never)).toThrow(TypeError);
	});

	it("accepts sixteen active host requests", async () => {
		const held: (() => void)[] = [];
		const host = recordingHost(
			() =>
				new Promise<null>((resolve) => {
					held.push(() => resolve(null));
					if (held.length === 16) for (const release of held) release();
				}),
		);
		const { handle } = await setup({ host });
		await pidOf(handle);
		const requests = Array.from({ length: 16 }, () => ({ method: "host/log", params: LOG }));
		const result = (await handle.callTool("run", { do: "host-many", requests })) as {
			answers: unknown[];
		};
		expect(result.answers).toEqual(Array.from({ length: 16 }, () => ({ result: null })));
	});

	for (const variant of ["a seventeenth active request", "a duplicate active id"])
		it(`kills on ${variant}`, async () => {
			const host = recordingHost(() => new Promise(() => {}));
			const { handle, events } = await setup({ host });
			const pid = await pidOf(handle);
			const frame = (id: string) =>
				`\u001e${JSON.stringify({ jsonrpc: "2.0", id, method: "host/log", params: LOG })}\n`;
			const seventeen = variant.includes("seventeenth");
			const lines = seventeen
				? [base64(Array.from({ length: 17 }, (_, index) => frame(`r${index}`)).join(""))]
				: [base64(frame("dup") + frame("dup"))];
			expect(await code(handle.callTool("run", { do: "raw", lines }))).toBe("PLUGIN_VIOLATION");
			await until(() => !isAlive(pid));
			await vi.waitFor(() => expect(reasons(events, "crashed")).toEqual(["violation:host-limit"]));
			await settle();
			expect(host.calls.length).toBeLessThanOrEqual(seventeen ? 16 : 1);
			for (const call of host.calls) expect(call.context.signal.aborted).toBe(true);
		});

	it("answers TIMEOUT after thirty seconds and aborts the context", async () => {
		const host = recordingHost(() => new Promise(() => {}));
		const { handle } = await setup({ host });
		await pidOf(handle);
		const pending = handle.callTool(
			"channel_sync",
			{ do: "host", method: "host/log", params: LOG },
			{ timeoutMs: 60_000 },
		);
		await vi.waitFor(() => expect(host.calls).toHaveLength(1));
		const context = (host.calls[0] as HostCall).context;
		await tick(29_999);
		expect(context.signal.aborted).toBe(false);
		await tick(1);
		expect(context.signal.aborted).toBe(true);
		expect(await pending).toEqual({ answer: { error: "TIMEOUT" } });
	});

	it("aborts host contexts when their call settles", async () => {
		const host = recordingHost(() => new Promise(() => {}));
		const { handle } = await setup({ host });
		await pidOf(handle);
		const pending = code(
			handle.callTool("run", { do: "host", method: "host/log", params: LOG }, { timeoutMs: 1_000 }),
		);
		await vi.waitFor(() => expect(host.calls).toHaveLength(1));
		await tick(1_000);
		expect(await pending).toBe("CALL_TIMEOUT");
		expect((host.calls[0] as HostCall).context.signal.aborted).toBe(true);
	});

	it("denies requests outside any call or scoped lease, and lookup permits, without dispatch", async () => {
		const host = recordingHost();
		const { handle } = await setup({
			host,
			line: { hostAtStartup: { method: "host/log", params: LOG } },
		});
		await pidOf(handle);
		const result = (await handle.callTool("run", { do: "answers" })) as { answers: unknown[] };
		expect(result.answers).toEqual([{ error: "DENIED" }]);
		// Written right after the plugin's own reply: the call is over, whatever the chunking.
		expect(
			await handle.callTool("run", { do: "reply-then-host", method: "host/log", params: LOG }),
		).toEqual({ sent: true });
		const later = (await handle.callTool("run", { do: "answers" })) as { answers: unknown[] };
		expect(later.answers).toEqual([{ error: "DENIED" }, { error: "DENIED" }]);
		const permit = Buffer.alloc(32, 7).toString("base64url");
		const fetch = {
			method: "GET",
			url: "https://dytest.invalid/",
			headers: [],
			lookupPermit: permit,
		};
		expect(
			await handle.callTool("run", { do: "host", method: "host/fetch", params: fetch }),
		).toEqual({
			answer: { error: "DENIED" },
		});
		expect(host.calls).toEqual([]);
	});

	it("keeps a stream open after its reply and ends it with its done chunk", async () => {
		let context: PluginHostRequestContext | undefined;
		let written: Promise<void> | undefined;
		let openAfterReply: boolean | undefined;
		const host = recordingHost((call) => {
			context = call.context;
			written = call.context.replyWritten;
			void call.context.replyWritten.then(() => {
				openAfterReply = !call.context.signal.aborted;
				return call.context.notify({
					jsonrpc: "2.0",
					method: "host/stream.chunk",
					params: { streamId: "s1", sequence: 0, base64: "", done: true },
				});
			});
			return { status: 200, headers: [], streamId: "s1" };
		});
		const { handle } = await setup({ host });
		await pidOf(handle);
		const result = await handle.callTool("run", {
			do: "notify-wait",
			method: "host/fetch",
			params: { method: "GET", url: "https://dytest.invalid/stream", headers: [], stream: true },
		});
		expect(result).toEqual({
			answer: { result: { status: 200, headers: [], streamId: "s1" } },
			notification: {
				jsonrpc: "2.0",
				method: "host/stream.chunk",
				params: { base64: "", done: true, sequence: 0, streamId: "s1" },
			},
		});
		await expect(written).resolves.toBeUndefined();
		expect(openAfterReply).toBe(true);
		const ended = context as PluginHostRequestContext;
		// The done chunk was the stream's last frame.
		await vi.waitFor(() => expect(ended.signal.aborted).toBe(true));
		const message = {
			jsonrpc: "2.0",
			method: "host/ws.message",
			params: { socketId: "s", data: "" },
		} as const;
		expect(await code(ended.notify(message))).toBe("HOST_CONTEXT_ENDED");
		await handle.stop();
		expect(await code(ended.notify(message))).toBe("HOST_CONTEXT_ENDED");
	});

	it("ends each answered request's context at its reply, so a lease keeps no finished work", async () => {
		const contexts: PluginHostRequestContext[] = [];
		const host = recordingHost((call) => {
			contexts.push(call.context);
			return null;
		});
		const { handle } = await setup({ host });
		await pidOf(handle);
		const lease = handle.lease(600_000, { scope: { tag: canary("listen") } });
		expect(
			await handle.callTool("run", {
				do: "host-series",
				count: 64,
				method: "host/kv.set",
				params: { key: "k", value: "v".repeat(16 << 10) },
			}),
		).toEqual({ scheduled: true });
		await vi.waitFor(() => expect(contexts).toHaveLength(64));
		await vi.waitFor(() => expect(contexts.every((context) => context.signal.aborted)).toBe(true));
		// No context of a finished request listens on the lease any more.
		expect(getEventListeners(lease.signal, "abort")).toHaveLength(0);
		expect(lease.signal.aborted).toBe(false);
		lease.release();
	});

	it("keeps sockets open until host/ws.close and refuses a seventeenth open stream", async () => {
		const sockets = new Map<string, PluginHostRequestContext>();
		const seen: Record<string, boolean>[] = [];
		const host = recordingHost((call) => {
			if (call.method !== "host/ws.open") return null;
			seen.push(
				Object.fromEntries(
					[...sockets].map(([socketId, context]) => [socketId, context.signal.aborted]),
				),
			);
			const socketId = `w${sockets.size + 1}`;
			sockets.set(socketId, call.context);
			return { socketId };
		});
		const { handle } = await setup({ host });
		await pidOf(handle);
		const open = {
			request: { method: "host/ws.open", params: { url: "wss://dytest.invalid/ws" } },
		};
		const close = { request: { method: "host/ws.close", params: { socketId: "w1" } } };
		const result = (await handle.callTool("run", {
			do: "host-steps",
			steps: [...Array.from({ length: 17 }, () => open), close, open],
		})) as { outcomes: unknown[] };
		expect(result.outcomes).toEqual([
			...Array.from({ length: 16 }, (_, index) => ({ result: { socketId: `w${index + 1}` } })),
			// The seventeenth open stream is refused before dispatch.
			{ error: "DENIED" },
			{ result: null },
			{ result: { socketId: "w17" } },
		]);
		expect(host.calls.map((call) => call.method)).toEqual([
			...Array.from({ length: 16 }, () => "host/ws.open"),
			"host/ws.close",
			"host/ws.open",
		]);
		// Answered sockets stayed open while their call ran; host/ws.close ended only its own.
		expect(Object.values(seen[15] as Record<string, boolean>)).toEqual(
			Array.from({ length: 15 }, () => false),
		);
		expect(seen[16]).toMatchObject({ w1: true, w2: false, w16: false });
		// Their call is over, and so is every socket it opened.
		for (const context of sockets.values()) expect(context.signal.aborted).toBe(true);
	});

	it("stops a plugin that keeps asking while it no longer reads its answers", async () => {
		const value = "v".repeat(512 << 10);
		const host = recordingHost(() => ({ value }));
		const { handle, events } = await setup({ host });
		const pid = await pidOf(handle);
		const flooding = code(
			handle.callTool("run", {
				do: "stall-flood",
				count: 40,
				everyMs: 2,
				method: "host/kv.get",
				params: { key: "k" },
			}),
		);
		await vi.waitFor(() => expect(reasons(events, "crashed")).toEqual(["violation:host-limit"]), {
			timeout: 2_000,
		});
		expect(await flooding).toBe("PLUGIN_VIOLATION");
		// Each answer still owed kept its slot: the seventeenth request was the violation.
		expect(host.calls).toHaveLength(16);
		await until(() => !isAlive(pid));
	});

	it("rejects replyWritten when the reply is refused", async () => {
		let written: Promise<void> | undefined;
		const host = recordingHost((call) => {
			written = call.context.replyWritten;
			return { not: "null" };
		});
		const { handle } = await setup({ host });
		await pidOf(handle);
		expect(await handle.callTool("run", { do: "host", method: "host/log", params: LOG })).toEqual({
			answer: { error: "DENIED" },
		});
		expect(await code(written as Promise<void>)).toBe("HOST_CONTEXT_ENDED");
	});

	it("caps outstanding stdin frames: later calls are busy and waiting notifications end with their signal", async () => {
		const notifications: Promise<void>[] = [];
		const chunk = Buffer.alloc(48 << 10, 1).toString("base64url");
		const host = recordingHost((call) => {
			for (let sequence = 0; sequence < 64; sequence++)
				notifications.push(
					call.context.notify({
						jsonrpc: "2.0",
						method: "host/stream.chunk",
						params: { streamId: "s1", sequence, base64: chunk, done: false },
					}),
				);
			for (const notification of notifications) notification.catch(() => {});
			return null;
		});
		const { handle } = await setup({ host });
		await pidOf(handle);
		const lease = handle.lease(60_000, { scope: { tag: "stream" } });
		await handle.callTool("run", { do: "stall-stdin", hostAfterMs: 50 });
		await vi.waitFor(() => expect(notifications).toHaveLength(64));
		await settle(10);
		const state = (notification: Promise<void>) =>
			Promise.race([
				notification.then(
					() => "written",
					() => "failed",
				),
				new Promise((resolve) => setImmediate(() => resolve("pending"))),
			]);
		const states = await Promise.all(notifications.map(state));
		expect(states.filter((value) => value === "pending").length).toBeGreaterThan(0);
		const waiting = states.filter((value) => value === "pending").length;
		expect(await code(handle.callTool("run", {}))).toBe("PLUGIN_BUSY");
		lease.release();
		await settle();
		// Frames already handed to the pipe end with the process; the ones waiting for room end now.
		const after = await Promise.all(notifications.map(state));
		expect(after.filter((value) => value === "pending").length).toBeLessThanOrEqual(32);
		expect(after.filter((value) => value === "failed").length).toBe(
			waiting - after.filter((value) => value === "pending").length,
		);
	});
});

describe("stderr", () => {
	it("never surfaces its text and kills above one MiB", async () => {
		const secret = canary("stderr");
		const { handle, events } = await setup();
		const pid = await pidOf(handle);
		await handle.callTool("run", { do: "stderr", text: secret });
		const outcome = await code(handle.callTool("run", { do: "stderr", bytes: 1_048_577 }));
		expect([undefined, "PLUGIN_EXITED"]).toContain(outcome);
		await until(() => !isAlive(pid));
		await vi.waitFor(() => expect(reasons(events, "crashed")).toEqual(["stderr-limit"]));
		expect(JSON.stringify(events)).not.toContain(secret);
	});
});

describe("ends", () => {
	it("counts supervisor stops as stops and an unrequested exit as a crash", async () => {
		const { handle, activation, supervisor, events } = await setup();
		await pidOf(handle);
		await tick(600_000);
		await vi.waitFor(() => expect(reasons(events, "stopped")).toEqual(["idle"]));
		await pidOf(handle);
		await handle.stop();
		expect(reasons(events, "stopped")).toEqual(["idle", "stop"]);
		expect(await code(handle.callTool("run", { do: "exit", code: 0 }))).toBe("PLUGIN_EXITED");
		await vi.waitFor(() => expect(reasons(events, "crashed")).toEqual(["exit"]));
		await pidOf(handle);
		await activation.revoke("disable");
		const second = await activate(supervisor, { generation: "g2" });
		await pidOf(second.instance(ulid()));
		await supervisor.close();
		expect(reasons(events, "stopped")).toEqual(["idle", "stop", "revoke", "close"]);
		expect(reasons(events, "crashed")).toEqual(["exit"]);
	});

	it("disables at the fifth crash within ten minutes", async () => {
		const { handle, activation, supervisor, events } = await setup();
		for (let crash = 1; crash <= 4; crash++) {
			await pidOf(handle);
			expect(await code(handle.callTool("run", { do: "exit", code: 1 }))).toBe("PLUGIN_EXITED");
			await tick(1_000);
		}
		expect(activation.revoked).toBe(false);
		await pidOf(handle);
		expect(await code(handle.callTool("run", { do: "exit", code: 1 }))).toBe("PLUGIN_EXITED");
		expect(activation.revoked).toBe(true);
		expect(await code(handle.callTool("run", {}))).toBe("PLUGIN_DISABLED");
		expect(reasons(events, "disabled")).toEqual(["crash-limit"]);
		expect(reasons(events, "revoked")).toEqual(["crash-limit"]);
		const next = (await activate(supervisor, { generation: "g2" })).instance(ulid());
		await pidOf(next);
		expect(await code(next.callTool("run", { do: "exit", code: 1 }))).toBe("PLUGIN_EXITED");
		expect(await pidOf(next)).toBeGreaterThan(0);
	});

	it("never disables crashes spaced more than ten minutes apart", async () => {
		const { handle, activation } = await setup();
		for (let crash = 0; crash < 6; crash++) {
			await pidOf(handle);
			expect(await code(handle.callTool("run", { do: "exit", code: 1 }))).toBe("PLUGIN_EXITED");
			await tick(600_001);
		}
		expect(activation.revoked).toBe(false);
	});

	it("stops after exactly ten idle minutes; liveness and host requests do not count", async () => {
		const verify = vi.spyOn(artifacts, "verifyBundle");
		const host = recordingHost();
		const { handle, events } = await setup({ host });
		const pid = await pidOf(handle);
		await handle.callTool("run", { do: "reply-then-host", method: "host/log", params: LOG });
		await tick(599_999);
		expect(isAlive(pid)).toBe(true);
		expect(reasons(events, "stopped")).toEqual([]);
		await tick(1);
		await until(() => !isAlive(pid));
		await vi.waitFor(() => expect(reasons(events, "stopped")).toEqual(["idle"]));
		const verified = verify.mock.calls.length;
		const next = await pidOf(handle);
		expect(next).not.toBe(pid);
		expect(verify.mock.calls.length).toBe(verified + 1);
		expect(host.calls).toEqual([]);
	});

	it("checks liveness every minute and kills a silent or changed plugin", async () => {
		let accept = true;
		const { handle, activation, events } = await setup({
			generation: { acceptSurface: () => accept },
		});
		const pid = await pidOf(handle);
		await tick(60_000);
		await vi.waitFor(async () =>
			expect((await counts(handle)).requests["server/discover"]).toBe(2),
		);
		await handle.callTool("run", { do: "set", ignoreDiscover: true });
		await tick(60_000);
		await tick(9_999);
		expect(isAlive(pid)).toBe(true);
		await tick(1);
		await until(() => !isAlive(pid));
		await vi.waitFor(() => expect(reasons(events, "crashed")).toEqual(["liveness"]));
		const next = await pidOf(handle);
		accept = false;
		await tick(60_000);
		await until(() => !isAlive(next));
		await vi.waitFor(() => expect(reasons(events, "crashed")).toEqual(["liveness", "surface"]));
		expect(activation.revoked).toBe(true);
		expect(reasons(events, "revoked")).toEqual(["surface"]);
	});
});

describe("leases", () => {
	it("keep the process past idle and resume idle accounting at expiry", async () => {
		let probes = 0;
		const { handle, events } = await setup({
			generation: {
				acceptSurface: () => {
					probes++;
					return true;
				},
			},
		});
		const pid = await pidOf(handle);
		const lease = handle.lease(60_000);
		// Each step waits for the liveness probe it triggers, so no probe meets its own timeout.
		await tick(60_000);
		await vi.waitFor(() => expect(probes).toBe(2));
		expect(lease.signal.aborted).toBe(true);
		await tick(540_000);
		await vi.waitFor(() => expect(probes).toBe(3));
		expect(isAlive(pid)).toBe(true);
		expect(reasons(events, "stopped")).toEqual([]);
		await tick(59_999);
		expect(reasons(events, "stopped")).toEqual([]);
		await tick(1);
		await vi.waitFor(() => expect(reasons(events, "stopped")).toEqual(["idle"]));
	});

	it("validate bounds, renew and scope", async () => {
		const host = recordingHost();
		const { handle } = await setup({ host });
		expect(refusal(() => handle.lease(1_000))).toBe("INSTANCE_NOT_RUNNING");
		await pidOf(handle);
		for (const ms of [999, 600_001, 1.5, Number.NaN])
			expect(refusal(() => handle.lease(ms))).toBe("LEASE_INVALID");
		expect(refusal(() => handle.lease(1_000, { extra: 1 } as never))).toBe("LEASE_INVALID");
		const lease = handle.lease(1_000);
		await tick(900);
		expect(lease.renew(1_000)).toBe(true);
		expect(refusal(() => lease.renew(999))).toBe("LEASE_INVALID");
		await tick(900);
		expect(lease.signal.aborted).toBe(false);
		await tick(100);
		expect(lease.signal.aborted).toBe(true);
		expect(lease.renew(1_000)).toBe(false);
		const scope = { tag: canary("scope") };
		const scoped = handle.lease(60_000, { scope });
		expect(refusal(() => handle.lease(60_000, { scope: {} }))).toBe("LEASE_ACTIVE");
		await handle.callTool("run", { do: "reply-then-host", method: "host/log", params: LOG });
		await vi.waitFor(() => expect(host.calls).toHaveLength(1));
		expect((host.calls[0] as HostCall).context.invocation).toBe(scope);
		scoped.release();
		expect(scoped.signal.aborted).toBe(true);
		expect((host.calls[0] as HostCall).context.signal.aborted).toBe(true);
		const unscoped = Array.from({ length: 16 }, () => handle.lease(60_000));
		expect(refusal(() => handle.lease(60_000))).toBe("LEASE_LIMIT");
		for (const item of unscoped) item.release();
	});

	it("end with the process, at revoke and at close", async () => {
		const { handle, activation, supervisor } = await setup();
		await pidOf(handle);
		const crashLease = handle.lease(60_000);
		expect(await code(handle.callTool("run", { do: "exit", code: 0 }))).toBe("PLUGIN_EXITED");
		expect(crashLease.signal.aborted).toBe(true);
		await pidOf(handle);
		const revokeLease = handle.lease(60_000);
		const revoking = activation.revoke("quarantine");
		expect(revokeLease.signal.aborted).toBe(true);
		await revoking;
		const other = (await activate(supervisor, { generation: "g2" })).instance(ulid());
		await pidOf(other);
		const closeLease = other.lease(60_000);
		const closing = supervisor.close();
		expect(closeLease.signal.aborted).toBe(true);
		await closing;
	});
});

describe("memory watchdog", () => {
	it("kills strictly above 512 MiB and when a reading stays unobservable", async () => {
		const { handle, events } = await setup();
		const pid = await pidOf(handle);
		reading = () => 536_870_912;
		await tick(5_000);
		await tick(5_000);
		expect(isAlive(pid)).toBe(true);
		reading = () => 536_870_913;
		await tick(5_000);
		await until(() => !isAlive(pid));
		await vi.waitFor(() => expect(reasons(events, "crashed")).toEqual(["memory-limit"]));
		const next = await pidOf(handle);
		let attempts = 0;
		reading = () => {
			attempts++;
			return undefined;
		};
		await tick(5_000);
		await until(() => !isAlive(next));
		await vi.waitFor(() =>
			expect(reasons(events, "crashed")).toEqual(["memory-limit", "memory-unobservable"]),
		);
		expect(attempts).toBe(2);
	});

	it("schedules no tick once no process remains", async () => {
		const { handle } = await setup();
		await pidOf(handle);
		await tick(5_000);
		const before = samples;
		expect(before).toBeGreaterThan(0);
		await handle.stop();
		await tick(60_000);
		expect(samples).toBe(before);
		expect(clock.pending()).toEqual([]);
	});
});

describe("revoke", () => {
	it("refuses IO in the same turn and resolves after the processes ended", async () => {
		const host = recordingHost(() => new Promise(() => {}));
		const { handle, activation } = await setup({ host });
		const pid = await pidOf(handle);
		const inFlight = code(handle.callTool("run", { do: "host", method: "host/log", params: LOG }));
		await vi.waitFor(() => expect(host.calls).toHaveLength(1));
		const revoking = activation.revoke("uninstall");
		expect(activation.revoked).toBe(true);
		expect(await code(handle.callTool("run", {}))).toBe("ACTIVATION_REVOKED");
		expect(refusal(() => activation.instance(ulid()))).toBe("ACTIVATION_REVOKED");
		expect((host.calls[0] as HostCall).context.signal.aborted).toBe(true);
		expect(activation.revoke("disable")).toBe(revoking);
		expect(await inFlight).toBe("ACTIVATION_REVOKED");
		expect(await revoking).toEqual({ processes: 1, cleanupFailures: 0 });
		expect(isAlive(pid)).toBe(false);
	});

	it("stops listening to its epoch once revoked another way", async () => {
		const any = vi.spyOn(AbortSignal, "any");
		const supervisor = await open();
		const activationEpoch = epoch("epoch-9");
		const activation = await activate(supervisor, {}, activationEpoch);
		const index = any.mock.calls.findIndex(
			([signals]) => [...signals][0] === activationEpoch.signal,
		);
		const follower = any.mock.results[index]?.value as AbortSignal;
		expect(getEventListeners(follower, "abort")).toHaveLength(1);
		await activation.revoke("upgrade");
		// A caller's long-lived epoch signal keeps no revoked activation alive.
		expect(getEventListeners(follower, "abort")).toHaveLength(0);
	});
});

describe("content-free surface", () => {
	it("keeps plugin output, host params and handler errors out of every event and error", async () => {
		const secrets = [canary("stdout"), canary("stderr"), canary("params"), canary("handler")];
		const errors: unknown[] = [];
		const host = recordingHost(() => {
			throw new Error(secrets[3]);
		});
		const { handle, events, supervisor } = await setup({ host });
		await pidOf(handle);
		await handle.callTool("run", { do: "stderr", text: secrets[1] });
		await handle.callTool("run", {
			do: "host",
			method: "host/log",
			params: { level: "info", message: secrets[2] },
		});
		try {
			await handle.callTool("run", { do: "raw", lines: [base64(`not json ${secrets[0]}\n`)] });
		} catch (error) {
			errors.push(error);
		}
		await vi.waitFor(() => expect(reasons(events, "crashed")).toEqual(["violation:parse-error"]));
		await supervisor.close();
		const text = JSON.stringify([
			events,
			errors.map((error) => [String(error), JSON.stringify(error), (error as Error).stack]),
		]);
		for (const secret of secrets) expect(text).not.toContain(secret);
	});
});

describe("capability seam", () => {
	it("mints handles only inside the supervisor and refuses forgeries", async () => {
		const supervisor = await open();
		const activation = await activate(supervisor);
		const id = ulid();
		const handle = activation.instance(id);
		expect(activation.instance(id)).toBe(handle);
		const expected = { pluginId: PLUGIN, generation: "g1" };
		expect(isSupervisedProcess(handle, expected)).toBe(true);
		const copy = {
			pluginId: handle.pluginId,
			generation: handle.generation,
			instanceId: handle.instanceId,
			kind: handle.kind,
			epoch: handle.epoch,
			revoked: false,
			signal: handle.signal,
			callTool: handle.callTool,
			lease: handle.lease,
			stop: handle.stop,
			retire: handle.retire,
		};
		expect(isSupervisedProcess(copy, expected)).toBe(false);
		expect(isSupervisedProcess(Object.create(Object.getPrototypeOf(handle)), expected)).toBe(false);
		expect(isSupervisedProcess(Object.create(handle), expected)).toBe(false);
		expect(isSupervisedProcess(new Proxy(handle, {}), expected)).toBe(false);
		const Constructor = handle.constructor as new (...args: unknown[]) => object;
		expect(() => new Constructor()).toThrow(TypeError);
		expect(() => new Constructor(Symbol("supervised-process"), {})).toThrow(TypeError);
		expect(() => {
			class Subclass extends Constructor {}
			return new Subclass(Symbol("supervised-process"), handle);
		}).toThrow(TypeError);
		expect(() => Reflect.construct(Constructor, [], class {})).toThrow(TypeError);
		const prototype = Object.getPrototypeOf(handle);
		expect(() => Reflect.apply(prototype.callTool, copy, ["run", {}])).toThrow(TypeError);
		expect(() => Reflect.apply(prototype.lease, copy, [1_000])).toThrow(TypeError);
	});

	it("refuses handles minted around an activation instead of by it", async () => {
		const spawn = vi.spyOn(childProcess, "spawn");
		const cores: Activation[] = [];
		const mint = Activation.prototype.instance;
		vi.spyOn(Activation.prototype, "instance").mockImplementation(function (
			this: Activation,
			instanceId: unknown,
		) {
			cores.push(this);
			return mint.call(this, instanceId);
		});
		const supervisor = await open();
		const activation = await activate(supervisor);
		const handle = activation.instance(ulid());
		const expected = { pluginId: PLUGIN, generation: "g1" };
		expect(isSupervisedProcess(handle, expected)).toBe(true);
		const core = cores[0] as Activation;
		// The real activation core, but an instance it never created: no recognition and no IO.
		const stray = new Instance(core, ulid());
		expect(isSupervisedProcess(stray.handle, expected)).toBe(false);
		expect(stray.handle.revoked).toBe(true);
		expect(await code(stray.handle.callTool("run", {}))).toBe("INSTANCE_INVALID");
		expect(refusal(() => stray.handle.lease(1_000))).toBe("INSTANCE_INVALID");
		// A core that only claims to be one, keeping every handle it makes.
		const fake = {
			snapshot: core.snapshot,
			entry: core.entry,
			epoch: core.epoch,
			context: core.context,
			refusal: () => undefined,
			holds: () => true,
			crashed() {},
			localRevoke() {},
			emit() {},
			released() {},
		};
		const forged = new Instance(fake, ulid());
		expect(forged.handle.revoked).toBe(false);
		expect(isSupervisedProcess(forged.handle, expected)).toBe(false);
		// A genuine instance with any token but the supervisor's own mints nothing.
		const Constructor = handle.constructor as new (token: unknown, instance: unknown) => object;
		expect(() => new Constructor(Symbol("supervised-process"), stray)).toThrow(TypeError);
		expect(() => new Constructor(Symbol("supervised-process"), forged)).toThrow(TypeError);
		await activation.revoke("disable");
		expect(spawn).not.toHaveBeenCalled();
	});

	it("carries its generation, instance and epoch read-only", async () => {
		const supervisor = await open();
		const activation = await activate(supervisor, { generation: "g7" }, epoch("epoch-1"));
		const id = ulid();
		const handle = activation.instance(id);
		expect([
			handle.pluginId,
			handle.generation,
			handle.instanceId,
			handle.kind,
			handle.epoch,
		]).toEqual([PLUGIN, "g7", id, "ai-provider", "epoch-1"]);
		expect(() => {
			(handle as { generation: string }).generation = "g8";
		}).toThrow(TypeError);
		expect(() => Object.defineProperty(handle, "generation", { value: "g8" })).toThrow(TypeError);
		expect(() =>
			Object.defineProperty(Object.getPrototypeOf(handle), "generation", { value: "g8" }),
		).toThrow(TypeError);
		expect(handle.generation).toBe("g7");
		const full = { pluginId: PLUGIN, generation: "g7", instanceId: id, epoch: "epoch-1" };
		expect(isSupervisedProcess(handle, full)).toBe(true);
		expect(isSupervisedProcess(handle, { ...full, generation: "g8" })).toBe(false);
		expect(isSupervisedProcess(handle, { ...full, pluginId: "other" })).toBe(false);
		expect(isSupervisedProcess(handle, { ...full, instanceId: ulid() })).toBe(false);
		expect(isSupervisedProcess(handle, { ...full, epoch: "epoch-2" })).toBe(false);
		expect(isSupervisedProcess(handle, null as never)).toBe(false);
		expect(isSupervisedProcess(handle, { pluginId: PLUGIN } as never)).toBe(false);
	});

	it("exposes no process, stream, descriptor or pid", async () => {
		const supervisor = await open();
		const activation = await activate(supervisor);
		const handle = activation.instance(ulid());
		const pid = await pidOf(handle);
		const seen = new Set<unknown>();
		const values: unknown[] = [];
		const walk = (value: unknown, depth: number): void => {
			values.push(value);
			if (depth > 4 || value === null || (typeof value !== "object" && typeof value !== "function"))
				return;
			if (seen.has(value)) return;
			seen.add(value);
			for (
				let target: object | null = value as object;
				target !== null && target !== Object.prototype && target !== Function.prototype;
				target = Object.getPrototypeOf(target)
			) {
				for (const key of Reflect.ownKeys(target)) {
					if (key === "constructor" || key === "prototype") continue;
					const descriptor = Object.getOwnPropertyDescriptor(target, key);
					let item: unknown;
					try {
						item = descriptor?.get ? Reflect.apply(descriptor.get, value, []) : descriptor?.value;
					} catch {
						continue;
					}
					walk(item, depth + 1);
				}
			}
		};
		walk(handle, 0);
		walk(activation, 0);
		walk(supervisor, 0);
		expect(values).not.toContain(pid);
		for (const value of values) {
			expect(value instanceof childProcess.ChildProcess).toBe(false);
			expect(value instanceof Stream).toBe(false);
		}
		expect(Object.keys(handle)).toEqual([]);
	});

	it("revokes handles when their instance or generation is retired or the epoch ends", async () => {
		const events: SupervisorEvent[] = [];
		const supervisor = await open(recordingHost(), events);
		const activationEpoch = epoch("epoch-1");
		const activation = await activate(supervisor, {}, activationEpoch);
		const expected = { pluginId: PLUGIN, generation: "g1" };
		const first = activation.instance(ulid());
		const second = activation.instance(ulid());
		const firstPid = await pidOf(first);
		const secondPid = await pidOf(second);

		const retiring = first.retire();
		expect(first.revoked).toBe(true);
		expect(first.signal.aborted).toBe(true);
		expect(isSupervisedProcess(first, expected)).toBe(false);
		expect(await code(first.callTool("run", {}))).toBe("INSTANCE_RETIRED");
		expect(refusal(() => first.lease(5_000))).toBe("INSTANCE_RETIRED");
		expect(refusal(() => activation.instance(first.instanceId))).toBe("INSTANCE_RETIRED");
		expect(await retiring).toEqual({ processes: 1, cleanupFailures: 0 });
		expect(isAlive(firstPid)).toBe(false);
		expect(isSupervisedProcess(second, expected)).toBe(true);
		const fresh = activation.instance(first.instanceId);
		expect(fresh).not.toBe(first);
		expect(isSupervisedProcess(fresh, expected)).toBe(true);

		endEpoch(activationEpoch);
		expect(second.revoked).toBe(true);
		expect(fresh.revoked).toBe(true);
		expect(activation.revoked).toBe(true);
		expect(second.signal.aborted).toBe(true);
		expect(isSupervisedProcess(second, expected)).toBe(false);
		expect(await code(second.callTool("run", {}))).toBe("ACTIVATION_REVOKED");
		await until(() => !isAlive(secondPid));
		expect(reasons(events, "revoked")).toEqual(["epoch"]);
		expect(refusal(() => activation.instance(ulid()))).toBe("ACTIVATION_REVOKED");
	});

	it("refuses handles of a closed supervisor", async () => {
		const supervisor = await open();
		const handle = (await activate(supervisor)).instance(ulid());
		await supervisor.close();
		expect(isSupervisedProcess(handle, { pluginId: PLUGIN, generation: "g1" })).toBe(false);
		expect(await code(handle.callTool("run", {}))).toBe("ACTIVATION_REVOKED");
	});
});

describe("supervisor close", () => {
	it("ends every process, keeps data dirs and refuses later activations", async () => {
		const supervisor = await open();
		const one = (await activate(supervisor)).instance(ulid());
		const two = (await activate(supervisor, { pluginId: "dytest-other" })).instance(ulid());
		const ids = [await pidOf(one), await pidOf(two)];
		const first = supervisor.close();
		expect(supervisor.closed).toBe(true);
		expect(supervisor.close()).toBe(first);
		expect(await code(activate(supervisor, { pluginId: "dytest-third" }))).toBe(
			"SUPERVISOR_CLOSED",
		);
		expect(await first).toEqual({ cleanupFailures: 0 });
		for (const pid of ids) expect(isAlive(pid)).toBe(false);
		expect(readdirSync(roots.stdioRoot)).toEqual([]);
		expect(existsSync(path.join(roots.dataRoot, PLUGIN, one.instanceId))).toBe(true);
		expect(clock.pending()).toEqual([]);
	});
});
