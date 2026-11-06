import childProcess, { execFile } from "node:child_process";
import { mkdirSync, realpathSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { aiProviderV1 } from "@draftyak/protocol/ai-provider-v1";
import { channelV1 } from "@draftyak/protocol/channel-v1";
import { checkPluginSurface, type ExtensionContract } from "@draftyak/protocol/extension";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	createPluginSupervisor,
	type PluginSupervisor,
	PluginSupervisorError,
	type ReviewedGeneration,
	type SupervisedProcess,
	type SupervisorEvent,
} from "../../src/plugins/supervisor/index.ts";
import { READING_TIMEOUT_MS, RSS_LIMIT_BYTES } from "../../src/plugins/supervisor/policy.ts";
import { PluginProcess } from "../../src/plugins/supervisor/process.ts";
import {
	validateWindowsPolicyRequest,
	WINDOWS_POLICY_EXPECTED_ENV,
	WINDOWS_POLICY_REQUEST_ENV,
} from "../../vitest.windows-policy.config.ts";
import { FakeClock, settle } from "../kernel/fake-clock.ts";
import { sdkBundle } from "./supervisor-bundles.ts";
import {
	epoch,
	generation,
	type HostCall,
	isAlive,
	lineBundle,
	makeRoots,
	manifest,
	type Roots,
	recordingHost,
	ulid,
	until,
} from "./supervisor-helpers.ts";
import {
	assertWindowsPolicyPrimaryReceipt,
	createWindowsSamplerObserver,
	tapOriginalPromise,
	type WindowsSamplerObserver,
	windowsSamplerBindings,
} from "./supervisor-windows-policy-observer.ts";

let roots: Roots;
let supervisor: PluginSupervisor | undefined;
let events: SupervisorEvent[];
let pids: Set<number>;
let windowsPrimary: WindowsPrimaryObservation | undefined;

beforeEach(() => {
	roots = makeRoots();
	supervisor = undefined;
	events = [];
	pids = new Set();
	windowsPrimary = undefined;
});

afterEach(async () => {
	await supervisor?.close();
	for (const pid of pids) expect(isAlive(pid)).toBe(false);
	roots.cleanup();
});

type Host = ReturnType<typeof recordingHost>;

async function open(host: Host = recordingHost(), clock?: FakeClock): Promise<PluginSupervisor> {
	supervisor = await createPluginSupervisor({
		dataRoot: roots.dataRoot,
		stdioRoot: roots.stdioRoot,
		host,
		clock,
		onEvent: (event) => {
			events.push(event);
			if (event.type === "memory-reader-fallback") windowsPrimary?.fallback();
		},
	});
	return supervisor;
}

const surface =
	(contract: ExtensionContract): ReviewedGeneration["acceptSurface"] =>
	({ discover, tools }) =>
		checkPluginSurface(discover, tools, contract).length === 0;

async function line(host?: Host): Promise<SupervisedProcess> {
	const opened = await open(host);
	const activation = await opened.activate(
		generation(lineBundle(path.join(roots.bundles, "line"))),
		{
			epoch: epoch(),
		},
	);
	const handle = activation.instance(ulid());
	const counts = (await handle.callTool("run", { do: "count" })) as { pid: number };
	pids.add(counts.pid);
	return handle;
}

async function pidOf(handle: SupervisedProcess): Promise<number> {
	const counts = (await handle.callTool("run", { do: "count" })) as { pid: number };
	pids.add(counts.pid);
	return counts.pid;
}

interface WindowsPrimaryObservation {
	fallback(): void;
	assertPid(reportedPid: number): void;
	finish(): Promise<void>;
}

/** Optional observation only; absent context leaves the ordinary cases unchanged. */
function observeWindowsPrimary(
	measurement: "growing" | "untouched",
): WindowsPrimaryObservation | undefined {
	const request = process.env[WINDOWS_POLICY_REQUEST_ENV];
	const expected = process.env[WINDOWS_POLICY_EXPECTED_ENV];
	if (request === undefined && expected === undefined) return undefined;
	const mode = (import.meta as ImportMeta & { readonly env?: { readonly MODE?: unknown } }).env
		?.MODE;
	const requestBinding = validateWindowsPolicyRequest(
		typeof mode === "string" ? mode : "",
		{ platform: process.platform, request, expected },
		"A",
	);
	let observer: WindowsSamplerObserver | undefined;
	let ownedPid: number | undefined;
	let failed = false;
	let finished = false;
	let targetOpens = 0;
	const original = PluginProcess.open;
	const spy = vi.spyOn(PluginProcess, "open").mockImplementation(function (
		this: unknown,
		...args: Parameters<typeof original>
	): ReturnType<typeof original> {
		const pending = Reflect.apply(original, this, args) as ReturnType<typeof original>;
		if (args[0].cwd !== path.join(roots.bundles, "line")) return pending;
		targetOpens++;
		if (targetOpens !== 1) failed = true;
		// This reaction precedes Instance's await/attach and watchdog registration.
		return tapOriginalPromise(
			pending,
			(owned) => {
				if (finished) return;
				if (
					observer !== undefined ||
					owned === undefined ||
					owned.ending ||
					typeof owned.pid !== "number" ||
					!Number.isSafeInteger(owned.pid) ||
					owned.pid <= 0 ||
					owned.pid === process.pid ||
					typeof args[0].env.SystemRoot !== "string"
				) {
					failed = true;
					return;
				}
				ownedPid = owned.pid;
				observer = createWindowsSamplerObserver(
					childProcess,
					windowsSamplerBindings(args[0].env.SystemRoot, process.pid, ownedPid),
				);
			},
			() => {
				failed = true;
			},
		);
	});
	const observation: WindowsPrimaryObservation = {
		fallback(): void {
			if (observer === undefined) failed = true;
			else observer.fallback();
		},
		assertPid(reportedPid: number): void {
			if (failed || observer === undefined || targetOpens !== 1 || reportedPid !== ownedPid)
				throw new TypeError("WINDOWS_PRIMARY_OBSERVATION_INVALID");
		},
		async finish(): Promise<void> {
			try {
				observer?.closeBoundary();
				await supervisor?.close();
				if (observer !== undefined)
					await until(() => observer?.unsettled().length === 0, READING_TIMEOUT_MS);
				const receipt = observer?.restore();
				if (failed || receipt === undefined || ownedPid === undefined || targetOpens !== 1)
					throw new TypeError("WINDOWS_PRIMARY_OBSERVATION_INVALID");
				assertWindowsPolicyPrimaryReceipt(receipt, process.pid, ownedPid, RSS_LIMIT_BYTES);
				const line = JSON.stringify({
					scope: "capture-only",
					case: "A",
					measurement,
					requestBinding,
					receipt,
				});
				if (Buffer.byteLength(line, "utf8") > 65_536)
					throw new TypeError("WINDOWS_POLICY_RECEIPT_LIMIT");
				console.info(line);
			} finally {
				finished = true;
				observer?.restore();
				spy.mockRestore();
				windowsPrimary = undefined;
			}
		},
	};
	windowsPrimary = observation;
	return observation;
}

const crashed = () =>
	events
		.filter((event) => event.type === "crashed")
		.map((event) => ("reason" in event ? event.reason : undefined));

const fetched = (call: HostCall) =>
	call.method === "host/fetch" ? { status: 200, headers: [], body: { base64: "" } } : null;

describe("real SDK servers under the supervisor", () => {
	it("does not disable the shipped SDK server after five caller cancellations", async () => {
		const staging = path.join(roots.base, "stage-cancel");
		mkdirSync(staging);
		const bundle = await sdkBundle("sdk-channel.ts", path.join(roots.bundles, "cancel"), staging);
		const host = recordingHost(fetched);
		const clock = new FakeClock();
		const activation = await (await open(host, clock)).activate(
			{
				pluginId: "dytest-channel",
				generation: "g1",
				bundle,
				manifest: manifest("dytest-channel", "channel"),
				acceptSurface: surface(channelV1),
			},
			{ epoch: epoch() },
		);
		const handle = activation.instance(ulid());
		for (let attempt = 1; attempt <= 5; attempt++) {
			const controller = new AbortController();
			const pending = handle
				.callTool(
					"channel_sync",
					{ mode: "delta", cursor: "dytest-hang" },
					{ signal: controller.signal },
				)
				.catch((error: unknown) => error);
			// This fetch proves the real SDK has dispatched the call before cancellation.
			await until(() => host.calls.length === attempt);
			controller.abort();
			expect(await pending).toMatchObject({ code: "CALL_CANCELLED" });
			clock.advance(5_000);
			await settle();
			await until(() => events.filter((event) => event.type === "stopped").length === attempt);
			expect(await handle.callTool("channel_describe", {})).toMatchObject({
				structuredContent: { channel: "chat" },
			});
		}
		expect(crashed()).toEqual([]);
		expect(events.filter((event) => event.type === "disabled")).toEqual([]);
		expect(activation.revoked).toBe(false);
	}, 120_000);

	it("serve the channel contract and attribute host fetches to the call in flight", async () => {
		const staging = path.join(roots.base, "stage-channel");
		mkdirSync(staging);
		const bundle = await sdkBundle("sdk-channel.ts", path.join(roots.bundles, "channel"), staging);
		const host = recordingHost(fetched);
		const activation = await (await open(host)).activate(
			{
				pluginId: "dytest-channel",
				generation: "g1",
				bundle,
				manifest: manifest("dytest-channel", "channel"),
				acceptSurface: surface(channelV1),
			},
			{ epoch: epoch() },
		);
		const handle = activation.instance(ulid());
		expect(await handle.callTool("channel_describe", {})).toMatchObject({
			structuredContent: { channel: "chat", mutations: [], attachments: false, listen: false },
		});
		const invocation = { tag: "probe" };
		expect(await handle.callTool("channel_probe", {}, { invocation })).toMatchObject({
			structuredContent: { status: "ok" },
		});
		expect(host.calls.map((call) => call.method)).toEqual(["host/fetch"]);
		const call = host.calls[0] as HostCall;
		expect(call.context.invocation).toBe(invocation);
		expect(call.params).toMatchObject({
			method: "GET",
			url: "https://slack.dytest.invalid/api/auth.test",
		});
		expect(events.map((event) => event.type)).toEqual(["spawned", "ready"]);
	}, 120_000);

	it("deliver provider progress in order during the call", async () => {
		const staging = path.join(roots.base, "stage-provider");
		mkdirSync(staging);
		const bundle = await sdkBundle(
			"sdk-provider.ts",
			path.join(roots.bundles, "provider"),
			staging,
		);
		const host = recordingHost(fetched);
		const activation = await (await open(host)).activate(
			{
				pluginId: "dytest-provider",
				generation: "g1",
				bundle,
				manifest: manifest("dytest-provider", "ai-provider"),
				acceptSurface: surface(aiProviderV1),
			},
			{ epoch: epoch() },
		);
		const handle = activation.instance(ulid());
		const updates: unknown[] = [];
		const invocation = { tag: "draft" };
		const result = await handle.callTool(
			"ai_draft_generate",
			{ model: "test-model", system: "Instructions", prompt: "Message", contextIds: [] },
			{ invocation, onProgress: (update) => updates.push(update) },
		);
		expect(result).toMatchObject({
			structuredContent: { kind: "unexpected", model: "test-model" },
		});
		expect(updates).toEqual([
			{ progress: 1, total: 3 },
			{ progress: 2, total: 3 },
		]);
		expect((host.calls[0] as HostCall).context.invocation).toBe(invocation);
	}, 120_000);
});

describe("plugin-side facts under the production flags", () => {
	it("holds no write, network, child-process, thread, addon or WASI permission, and no inspector", async () => {
		const previous = process.env.NODE_OPTIONS;
		process.env.NODE_OPTIONS = "--inspect=127.0.0.1:0";
		try {
			const handle = await line();
			expect(await handle.callTool("run", { do: "probe", what: "permissions" })).toEqual({
				result: {
					write: false,
					net: false,
					child: false,
					thread: false,
					addon: false,
					wasi: false,
					inspector: null,
				},
			});
			const outside = path.join(roots.base, "outside.txt");
			writeFileSync(outside, "DYTEST outside");
			expect(await handle.callTool("run", { do: "read-file", path: outside })).toEqual({
				code: "ERR_ACCESS_DENIED",
			});
		} finally {
			if (previous === undefined) delete process.env.NODE_OPTIONS;
			else process.env.NODE_OPTIONS = previous;
		}
	});
});

describe("memory watchdog with the real sampler", () => {
	it("kills a growing plugin above 512 MiB within two ticks", async () => {
		const observed = observeWindowsPrimary("growing");
		try {
			const handle = await line();
			const pid = await pidOf(handle);
			observed?.assertPid(pid);
			const started = Date.now();
			// Bounded well below the shared machine's memory: just past the limit, then held.
			await handle.callTool("run", {
				do: "grow",
				blockBytes: 64 << 20,
				everyMs: 60,
				ceilingBytes: 640 << 20,
			});
			await until(() => !isAlive(pid), 20_000);
			expect(Date.now() - started).toBeLessThan(15_000);
			await until(() => crashed().length > 0);
			expect(crashed()).toEqual(["memory-limit"]);
		} finally {
			if (observed !== undefined) await observed.finish();
		}
	}, 60_000);

	it("counts committed but untouched memory on Windows", {
		tags: ["requires:windows"],
		timeout: 60_000,
	}, async () => {
		const observed = observeWindowsPrimary("untouched");
		try {
			const handle = await line();
			const pid = await pidOf(handle);
			observed?.assertPid(pid);
			expect(await handle.callTool("run", { do: "allocate", bytes: 768 << 20 })).toEqual({
				allocated: 768 << 20,
			});
			await until(() => !isAlive(pid), 20_000);
			await until(() => crashed().length > 0);
			expect(crashed()).toEqual(["memory-limit"]);
		} finally {
			if (observed !== undefined) await observed.finish();
		}
	});
});

describe("real clock", () => {
	it("times out a silent call and kills after the grace", async () => {
		const handle = await line();
		const pid = await pidOf(handle);
		const started = Date.now();
		await expect(
			handle.callTool("run", { do: "never" }, { timeoutMs: 1_000 }),
		).rejects.toMatchObject({
			code: "CALL_TIMEOUT",
		});
		expect(Date.now() - started).toBeGreaterThanOrEqual(900);
		await until(() => !isAlive(pid), 15_000);
		expect(Date.now() - started).toBeLessThan(1_000 + 5_000 + 5_000);
		await until(() => crashed().length > 0);
		expect(crashed()).toEqual(["call-timeout"]);
	}, 60_000);
});

function run(
	file: string,
	args: readonly string[],
	env: NodeJS.ProcessEnv = process.env,
): Promise<string> {
	return new Promise((resolve, reject) =>
		execFile(
			file,
			args,
			{ env, timeout: 300_000, maxBuffer: 1 << 20, windowsHide: true },
			(error, stdout) =>
				error ? reject(new Error("Below-floor runtime setup failed")) : resolve(String(stdout)),
		),
	);
}

it("below-floor: refuses a Node below 26.5.1 before any plugin process", async () => {
	let executable = process.env.DRAFTYAK_TEST_NODE_BELOW_FLOOR;
	if (executable !== undefined && !path.isAbsolute(executable))
		throw new Error("Below-floor runtime setup failed");
	if (executable === undefined) {
		const cache = path.join(roots.base, "cache");
		const platform = process.platform === "win32" ? "win" : process.platform;
		const fetched = await run(
			process.execPath,
			[
				fileURLToPath(new URL("../../../../tools/fetch-node/fetch-node.mjs", import.meta.url)),
				"--version",
				"26.5.0",
				"--platform",
				platform,
				"--arch",
				process.arch,
				"--print-path",
			],
			{ ...process.env, DRAFTYAK_CACHE_DIR: cache },
		);
		executable = realpathSync(fetched.trim());
	}
	expect((await run(executable, ["--version"])).trim()).toBe("v26.5.0");
	const check = path.join(roots.base, "below-floor.mjs");
	const supervisorModule = pathToFileURL(
		fileURLToPath(new URL("../../src/plugins/supervisor/index.ts", import.meta.url)),
	).href;
	writeFileSync(
		check,
		[
			`import { createPluginSupervisor } from ${JSON.stringify(supervisorModule)};`,
			`let code = "UNEXPECTED_SUCCESS";`,
			`try { await createPluginSupervisor({ dataRoot: ${JSON.stringify(roots.dataRoot)}, stdioRoot: ${JSON.stringify(roots.stdioRoot)}, host: { request: async () => null } }); }`,
			`catch (error) { code = error?.code ?? "SETUP_FAILURE"; }`,
			`console.log(JSON.stringify({ node: process.versions.node, code }));`,
		].join("\n"),
	);
	const result = JSON.parse(await run(executable, [check])) as { node: string; code: string };
	expect(result).toEqual({ node: "26.5.0", code: "RUNTIME_UNSUPPORTED" });
	expect(new PluginSupervisorError("RUNTIME_UNSUPPORTED").code).toBe(result.code);
}, 600_000);
