import { EventEmitter } from "node:events";
import path from "node:path";
import { PassThrough } from "node:stream";
import type {
	PluginProcessIo,
	PluginStdio,
	PluginStdioResult,
} from "@draftyak/protocol/plugin-stdio";
import * as pluginStdio from "@draftyak/protocol/plugin-stdio";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as artifacts from "../../src/artifacts/index.ts";
import {
	createPluginSupervisor,
	END_BOUND_MS,
	type PluginSupervisor,
	PluginSupervisorError,
	type SupervisorEvent,
} from "../../src/plugins/supervisor/index.ts";
import * as memory from "../../src/plugins/supervisor/memory.ts";
import { FakeClock, settle } from "../kernel/fake-clock.ts";
import {
	epoch,
	generation,
	lineBundle,
	makeRoots,
	type Roots,
	recordingHost,
	ulid,
} from "./supervisor-helpers.ts";

const mocks = vi.hoisted(() => ({ spawn: vi.fn(), execFile: vi.fn() }));
vi.mock("node:child_process", () => ({
	default: { spawn: mocks.spawn, execFile: mocks.execFile },
	spawn: mocks.spawn,
	execFile: mocks.execFile,
}));

/** A child the test controls: it exits only when told to, or on kill when `obeys` is set. */
class FakeChild extends EventEmitter {
	pid: number | undefined;
	exitCode: number | null = null;
	signalCode: NodeJS.Signals | null = null;
	readonly signals: unknown[] = [];
	obeys = true;

	constructor(pid: number | undefined) {
		super();
		this.pid = pid;
	}

	kill(signal?: NodeJS.Signals): boolean {
		this.signals.push(signal);
		if (this.obeys) queueMicrotask(() => this.exit(null, "SIGKILL"));
		return true;
	}

	exit(code: number | null, signal: NodeJS.Signals | null): void {
		if (this.exitCode !== null || this.signalCode !== null) return;
		this.exitCode = code;
		this.signalCode = signal;
		this.emit("exit", code, signal);
	}
}

interface Controlled {
	readonly stdio: PluginStdio & {
		destroy: ReturnType<typeof vi.fn>;
		attach: ReturnType<typeof vi.fn>;
	};
	readonly io: PluginProcessIo & { destroy: ReturnType<typeof vi.fn> };
	readonly finish: (result?: Partial<PluginStdioResult>) => void;
	readonly answering: { on: boolean };
	/** Ids of tools/call requests left unanswered by `holdCalls`. */
	readonly calls: unknown[];
}

const RESULT: PluginStdioResult = {
	code: null,
	signal: "SIGKILL",
	error: null,
	drains: [
		{ bytes: 0, result: "eof" },
		{ bytes: 0, result: "eof" },
	],
};

/** Fake stdio whose plugin side answers discover and tools/list while `answering.on` is set. */
function controlled(
	options: { completesOnExit?: boolean; destroy?: () => Promise<void>; holdCalls?: boolean } = {},
): Controlled {
	const input = new PassThrough();
	const stdout = new PassThrough();
	const stderr = new PassThrough();
	const { promise: completion, resolve } = Promise.withResolvers<PluginStdioResult>();
	const finish = (result: Partial<PluginStdioResult> = {}) => resolve({ ...RESULT, ...result });
	const answering = { on: true };
	const calls: unknown[] = [];
	let buffer = "";
	input.on("data", (chunk: Buffer) => {
		buffer += chunk.toString("utf8");
		for (let end = buffer.indexOf("\n"); end !== -1; end = buffer.indexOf("\n")) {
			const message = JSON.parse(buffer.slice(0, end));
			buffer = buffer.slice(end + 1);
			if (!answering.on || message.id === undefined) continue;
			if (options.holdCalls && message.method === "tools/call") {
				calls.push(message.id);
				continue;
			}
			const result =
				message.method === "tools/list"
					? { tools: [{ name: "run", inputSchema: { type: "object" } }] }
					: message.method === "server/discover"
						? { supportedVersions: ["2026-07-28"] }
						: { ok: true };
			stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id: message.id, result })}\n`);
		}
	});
	const io = {
		input,
		outputs: [stdout, stderr] as const,
		completion,
		destroy: vi.fn(options.destroy ?? (async () => finish({ error: "destroyed" }))),
	};
	const stdio = {
		kind: "pipe" as const,
		stdio: ["pipe", "pipe", "pipe"] as const,
		attach: vi.fn((child: FakeChild) => {
			if (options.completesOnExit !== false)
				child.once("exit", (code, signal) => finish({ code, signal }));
			return io;
		}),
		destroy: vi.fn(async () => {}),
	};
	return { stdio: stdio as never, io: io as never, finish, answering, calls };
}

let roots: Roots;
let clock: FakeClock;
let supervisor: PluginSupervisor;
let events: SupervisorEvent[];
let children: FakeChild[];

beforeEach(async () => {
	roots = makeRoots();
	clock = new FakeClock();
	events = [];
	children = [];
	vi.spyOn(memory, "createSampler").mockImplementation(() => ({
		sample: async (pids) => new Map(pids.map((pid) => [pid, 1])),
		close() {},
	}));
	mocks.spawn.mockImplementation(() => {
		const child = new FakeChild(40_000 + children.length);
		children.push(child);
		return child;
	});
	supervisor = await createPluginSupervisor({
		dataRoot: roots.dataRoot,
		stdioRoot: roots.stdioRoot,
		host: recordingHost(),
		clock,
		onEvent: (event) => events.push(event),
	});
});

afterEach(async () => {
	for (const child of children) child.exit(null, "SIGKILL");
	const closing = supervisor.close();
	for (let step = 0; step < 4; step++) {
		await settle();
		clock.advance(5_000);
	}
	await closing;
	vi.restoreAllMocks();
	mocks.spawn.mockReset();
	roots.cleanup();
});

let count = 0;
async function instance() {
	const activation = await supervisor.activate(
		generation(lineBundle(path.join(roots.bundles, `b${++count}`))),
		{
			epoch: epoch(),
		},
	);
	return { activation, handle: activation.instance(ulid()) };
}

async function code(promise: Promise<unknown>): Promise<string | undefined> {
	try {
		await promise;
		return undefined;
	} catch (error) {
		return error instanceof PluginSupervisorError ? error.code : `other:${String(error)}`;
	}
}

const types = (type: SupervisorEvent["type"]) =>
	events
		.filter((event) => event.type === type)
		.map((event) => ("reason" in event ? event.reason : undefined));

async function tick(ms: number): Promise<void> {
	clock.advance(ms);
	await settle();
}

describe("controlled children", () => {
	it("destroys stdio after a synchronous spawn throw and counts a spawn crash", async () => {
		const fake = controlled();
		vi.spyOn(pluginStdio, "openPluginStdio").mockResolvedValue(fake.stdio);
		mocks.spawn.mockImplementation(() => {
			throw new Error("spawn refused");
		});
		const { handle } = await instance();
		expect(await code(handle.callTool("run", {}))).toBe("SPAWN_FAILED");
		expect(fake.stdio.destroy).toHaveBeenCalledTimes(1);
		expect(fake.stdio.attach).not.toHaveBeenCalled();
		expect(types("crashed")).toEqual(["spawn"]);
	});

	it("counts a spawn error after attach as a spawn crash", async () => {
		const fake = controlled({ completesOnExit: false });
		fake.answering.on = false;
		vi.spyOn(pluginStdio, "openPluginStdio").mockResolvedValue(fake.stdio);
		mocks.spawn.mockImplementation(() => {
			const child = new FakeChild(undefined);
			children.push(child);
			queueMicrotask(() => fake.finish({ code: null, signal: null, error: "spawn" }));
			return child;
		});
		const { handle } = await instance();
		expect(await code(handle.callTool("run", {}))).toBe("SPAWN_FAILED");
		await vi.waitFor(() => expect(types("crashed")).toEqual(["spawn"]));
	});

	it("bounds a completion that never settles and stays respawnable", async () => {
		const fake = controlled({ completesOnExit: false });
		vi.spyOn(pluginStdio, "openPluginStdio").mockResolvedValue(fake.stdio);
		const { handle } = await instance();
		expect(await handle.callTool("run", {})).toEqual({ ok: true });
		children[0]?.exit(0, null);
		await settle();
		await tick(1_999);
		expect(types("cleanup-failed")).toEqual([]);
		await tick(1);
		await vi.waitFor(() => expect(types("cleanup-failed")).toHaveLength(1));
		await vi.waitFor(() => expect(types("crashed")).toEqual(["exit"]));
		const next = controlled();
		vi.spyOn(pluginStdio, "openPluginStdio").mockResolvedValue(next.stdio);
		expect(await handle.callTool("run", {})).toEqual({ ok: true });
		expect(mocks.spawn).toHaveBeenCalledTimes(2);
	});

	it("bounds a destroy that hangs", async () => {
		const fake = controlled({ destroy: () => new Promise(() => {}) });
		vi.spyOn(pluginStdio, "openPluginStdio").mockResolvedValue(fake.stdio);
		const { handle } = await instance();
		await handle.callTool("run", {});
		const stopping = handle.stop();
		await settle();
		await tick(2_000);
		await stopping;
		expect(types("cleanup-failed")).toHaveLength(1);
		expect(types("stopped")).toEqual(["stop"]);
		expect(types("crashed")).toEqual(["cleanup"]);
	});

	it("reports a kill without exit, bounds the stop and refuses calls until the child is gone", async () => {
		const fake = controlled();
		vi.spyOn(pluginStdio, "openPluginStdio").mockResolvedValue(fake.stdio);
		const { handle } = await instance();
		await handle.callTool("run", {});
		const child = children[0] as FakeChild;
		child.obeys = false;
		let stopped = false;
		void handle.stop().then(() => {
			stopped = true;
		});
		await settle();
		expect(child.signals).toEqual(["SIGKILL"]);
		await tick(4_999);
		expect(types("kill-unconfirmed")).toEqual([]);
		await tick(1);
		expect(types("kill-unconfirmed")).toHaveLength(1);
		expect(await code(handle.callTool("run", {}))).toBe("INSTANCE_FAILED");
		await tick(END_BOUND_MS - 5_001);
		expect(stopped).toBe(false);
		await tick(1);
		expect(stopped).toBe(true);
		const closing = supervisor.close();
		for (let step = 0; step < 3; step++) await tick(5_000);
		expect(await closing).toEqual({ cleanupFailures: 1 });
		child.exit(null, "SIGKILL");
	});

	it("bounds a retire whose kill is never confirmed and keeps the id retired until the child is gone", async () => {
		const fake = controlled();
		vi.spyOn(pluginStdio, "openPluginStdio").mockResolvedValue(fake.stdio);
		const { activation, handle } = await instance();
		await handle.callTool("run", {});
		const child = children[0] as FakeChild;
		child.obeys = false;
		let result: unknown;
		void handle.retire().then((value) => {
			result = value;
		});
		await settle();
		await tick(END_BOUND_MS - 1);
		expect(result).toBeUndefined();
		await tick(1);
		expect(result).toEqual({ processes: 1, cleanupFailures: 1 });
		const reuse = () => code(Promise.resolve().then(() => activation.instance(handle.instanceId)));
		// A second process for the same instance and data folder waits for the first to be gone.
		expect(await reuse()).toBe("INSTANCE_RETIRED");
		child.exit(null, "SIGKILL");
		await vi.waitFor(async () => expect(await reuse()).toBeUndefined());
	});

	it("decodes a reply that only the exit drain hands over before failing the call", async () => {
		const fake = controlled({ completesOnExit: false, holdCalls: true });
		vi.spyOn(pluginStdio, "openPluginStdio").mockResolvedValue(fake.stdio);
		const { handle } = await instance();
		const pending = handle.callTool("run", {});
		await vi.waitFor(() => expect(fake.calls).toHaveLength(1));
		const stdout = fake.io.outputs[0] as PassThrough;
		// Buffered and unread when the child exits: only the drain's flush can deliver it.
		stdout.pause();
		const reply = { jsonrpc: "2.0", id: fake.calls[0], result: { last: true } };
		stdout.write(`${JSON.stringify(reply)}\n`);
		(children[0] as FakeChild).exit(0, null);
		fake.finish({ code: 0, signal: null });
		expect(await pending).toEqual({ last: true });
		await vi.waitFor(() => expect(types("crashed")).toEqual(["exit"]));
	});

	it("handles a child that ended before its exit listener once", async () => {
		const fake = controlled({ completesOnExit: false });
		fake.answering.on = false;
		vi.spyOn(pluginStdio, "openPluginStdio").mockResolvedValue(fake.stdio);
		mocks.spawn.mockImplementation(() => {
			const child = new FakeChild(41_000);
			child.exitCode = 0;
			children.push(child);
			queueMicrotask(() => fake.finish({ code: 0, signal: null }));
			return child;
		});
		const { handle } = await instance();
		expect(await code(handle.callTool("run", {}))).toBe("START_FAILED");
		await vi.waitFor(() => expect(types("crashed")).toEqual(["exit"]));
		expect((children[0] as FakeChild).signals).toEqual([]);
	});
});

describe("revoke races", () => {
	it("refuses an activation completed after the supervisor closes", async () => {
		await instance();
		const real = artifacts.verifyBundle;
		const entered = Promise.withResolvers<void>();
		const held = Promise.withResolvers<void>();
		vi.spyOn(artifacts, "verifyBundle").mockImplementation(async (bundle) => {
			entered.resolve();
			await held.promise;
			return real(bundle);
		});
		const pending = code(
			supervisor.activate(
				generation(lineBundle(path.join(roots.bundles, "pending")), { pluginId: "dytest-pending" }),
				{ epoch: epoch() },
			),
		);
		await entered.promise;
		await supervisor.close();
		held.resolve();
		expect(await pending).toBe("SUPERVISOR_CLOSED");
		expect(mocks.spawn).not.toHaveBeenCalled();
	});

	it("spawns nothing when revoked while the bundle is being verified", async () => {
		const opened = vi.spyOn(pluginStdio, "openPluginStdio");
		const { activation, handle } = await instance();
		const real = artifacts.verifyBundle;
		const held = Promise.withResolvers<void>();
		vi.spyOn(artifacts, "verifyBundle").mockImplementation(async (bundle) => {
			await held.promise;
			return real(bundle);
		});
		const pending = code(handle.callTool("run", {}));
		await settle();
		const revoking = activation.revoke("disable");
		held.resolve();
		expect(await pending).toBe("ACTIVATION_REVOKED");
		expect(await revoking).toEqual({ processes: 0, cleanupFailures: 0 });
		expect(opened).not.toHaveBeenCalled();
		expect(mocks.spawn).not.toHaveBeenCalled();
	});

	it("destroys opened stdio and spawns nothing when revoked before spawn", async () => {
		const fake = controlled();
		const held = Promise.withResolvers<PluginStdio>();
		vi.spyOn(pluginStdio, "openPluginStdio").mockReturnValue(held.promise);
		const { activation, handle } = await instance();
		const pending = code(handle.callTool("run", {}));
		await vi.waitFor(() => expect(pluginStdio.openPluginStdio).toHaveBeenCalled());
		const revoking = activation.revoke("disable");
		held.resolve(fake.stdio);
		expect(await pending).toBe("ACTIVATION_REVOKED");
		await revoking;
		expect(fake.stdio.destroy).toHaveBeenCalledTimes(1);
		expect(mocks.spawn).not.toHaveBeenCalled();
	});

	it("stops a process spawned while the revoke was in progress", async () => {
		const fake = controlled();
		fake.answering.on = false;
		vi.spyOn(pluginStdio, "openPluginStdio").mockResolvedValue(fake.stdio);
		const { activation, handle } = await instance();
		const pending = code(handle.callTool("run", {}));
		await vi.waitFor(() => expect(mocks.spawn).toHaveBeenCalledTimes(1));
		expect(await code(activation.revoke("upgrade"))).toBeUndefined();
		expect(await pending).toBe("ACTIVATION_REVOKED");
		expect((children[0] as FakeChild).signals).toEqual(["SIGKILL"]);
		expect(types("stopped")).toEqual(["revoke"]);
	});
});
