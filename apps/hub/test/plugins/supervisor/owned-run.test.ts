import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	createPluginSupervisor,
	isCurrentSupervisedHostRequest,
	isCurrentSupervisedRun,
	type PluginHostRequestContext,
	type PluginSupervisor,
} from "../../../src/plugins/supervisor/index.ts";
import * as memory from "../../../src/plugins/supervisor/memory.ts";
import { FakeClock } from "../../kernel/fake-clock.ts";
import {
	epoch,
	generation,
	lineBundle,
	makeRoots,
	type Roots,
	recordingHost,
	ulid,
	until,
} from "../supervisor-helpers.ts";

const LOG = { level: "info", message: "DYTEST owned request" } as const;
const HOST_CALL = { do: "host", method: "host/log", params: LOG };
let roots: Roots;
let clock: FakeClock;
let supervisors: PluginSupervisor[];

beforeEach(() => {
	roots = makeRoots();
	clock = new FakeClock();
	supervisors = [];
	// These controls exercise real plugin IO, not the per-OS memory reader.
	vi.spyOn(memory, "createSampler").mockImplementation(() => ({
		sample: async (pids) => new Map(pids.map((pid) => [pid, 64 << 20])),
		close() {},
	}));
});

afterEach(async () => {
	try {
		for (const supervisor of supervisors) {
			const result = await supervisor.close();
			expect(result.cleanupFailures).toBe(0);
		}
		roots.cleanup();
	} finally {
		vi.restoreAllMocks();
	}
});

async function setup(host = recordingHost()) {
	const supervisor = await createPluginSupervisor({
		dataRoot: roots.dataRoot,
		stdioRoot: roots.stdioRoot,
		host,
		clock,
	});
	supervisors.push(supervisor);
	const activation = await supervisor.activate(
		generation(lineBundle(path.join(roots.bundles, ulid()))),
		{ epoch: epoch() },
	);
	return { supervisor, activation, handle: activation.instance(ulid()), host };
}

function hostContext(host: ReturnType<typeof recordingHost>, index = 0): PluginHostRequestContext {
	const call = host.calls[index];
	if (call === undefined) throw new Error("Expected a dispatched host request");
	return call.context;
}

describe("owned process runs and live host requests", () => {
	it("correlates a successful call with its real host request and preserves callTool results", async () => {
		const answer = Promise.withResolvers<unknown>();
		const { handle, host } = await setup(recordingHost(() => answer.promise));
		const invocation = Object.freeze({ tag: "original invocation" });
		expect(isCurrentSupervisedRun(Object.freeze({}), handle)).toBe(false);
		expect(isCurrentSupervisedHostRequest(Object.freeze({}), handle, invocation)).toBe(false);
		const pending = handle.callToolWithRun("run", HOST_CALL, { invocation });
		await until(() => host.calls.length === 1);
		const context = hostContext(host);
		expect(context.invocation).toBe(invocation);
		expect(isCurrentSupervisedRun(context.run, handle)).toBe(true);
		expect(isCurrentSupervisedHostRequest(context, handle, invocation)).toBe(true);
		answer.resolve(null);
		const receipt = await pending;
		await context.replyWritten;
		expect(receipt.result).toEqual({ answer: { result: null } });
		expect(receipt.run).toBe(context.run);
		expect(context.signal.aborted).toBe(true);
		expect(isCurrentSupervisedHostRequest(context, handle, invocation)).toBe(false);
		expect(isCurrentSupervisedRun(receipt.run, handle)).toBe(true);
		expect(await handle.callTool("run", { do: "echo", value: 7 })).toEqual({ echo: 7 });
		const next = await handle.callToolWithRun("run", { do: "echo", value: 8 });
		expect(next.result).toEqual({ echo: 8 });
		expect(next.run).toBe(receipt.run);
	});

	it("rejects cloned, proxied and foreign identities without evaluating them", async () => {
		const answer = Promise.withResolvers<unknown>();
		const { activation, handle, host } = await setup(recordingHost(() => answer.promise));
		const invocation = Object.freeze({ tag: "original invocation" });
		const pending = handle.callToolWithRun("run", HOST_CALL, { invocation });
		await until(() => host.calls.length === 1);
		const context = hostContext(host);
		const other = activation.instance(ulid());
		let traps = 0;
		const trap = (): never => {
			traps++;
			throw new Error("Identity trap");
		};
		const handler = { get: trap, ownKeys: trap, getPrototypeOf: trap };
		for (const candidate of [null, {}, { ...context.run }, new Proxy(context.run, handler)])
			expect(isCurrentSupervisedRun(candidate, handle)).toBe(false);
		expect(isCurrentSupervisedRun(context.run, other)).toBe(false);
		expect(isCurrentSupervisedRun(context.run, new Proxy(handle, handler))).toBe(false);
		for (const candidate of [null, {}, { ...context }, new Proxy(context, handler)])
			expect(isCurrentSupervisedHostRequest(candidate, handle, invocation)).toBe(false);
		expect(isCurrentSupervisedHostRequest(context, other, invocation)).toBe(false);
		expect(isCurrentSupervisedHostRequest(context, handle, { ...invocation })).toBe(false);
		expect(isCurrentSupervisedHostRequest(context, handle, new Proxy(invocation, handler))).toBe(
			false,
		);
		expect(traps).toBe(0);
		expect(isCurrentSupervisedHostRequest(context, handle, invocation)).toBe(true);
		answer.resolve(null);
		await pending;
	});

	it("ends a cancelled host request without issuing a successful call receipt or retiring the run", async () => {
		const { handle, host } = await setup(recordingHost(() => new Promise(() => {})));
		const controller = new AbortController();
		const invocation = Object.freeze({ tag: "cancelled invocation" });
		let receipt: unknown;
		const pending = handle.callToolWithRun("run", HOST_CALL, {
			invocation,
			signal: controller.signal,
		});
		const outcome = pending.then(
			(value) => {
				receipt = value;
				return undefined;
			},
			(error: unknown) => error,
		);
		await until(() => host.calls.length === 1);
		const context = hostContext(host);
		expect(isCurrentSupervisedHostRequest(context, handle, invocation)).toBe(true);
		controller.abort();
		expect(await outcome).toMatchObject({ code: "CALL_CANCELLED" });
		expect(receipt).toBeUndefined();
		await expect(context.replyWritten).rejects.toMatchObject({ code: "HOST_CONTEXT_ENDED" });
		expect(context.signal.aborted).toBe(true);
		expect(isCurrentSupervisedHostRequest(context, handle, invocation)).toBe(false);
		// The cancellation grace has not elapsed and the actual process still owns this run.
		expect(isCurrentSupervisedRun(context.run, handle)).toBe(true);
	});

	it("keeps an answered fetch current until its real terminal stream notification", async () => {
		const { handle, host } = await setup(
			recordingHost(() => ({ status: 200, headers: [], streamId: "owned-stream" })),
		);
		const invocation = Object.freeze({ tag: "stream invocation" });
		const pending = handle.callToolWithRun(
			"run",
			{
				do: "notify-wait",
				method: "host/fetch",
				params: { method: "GET", url: "https://dytest.invalid/stream", headers: [], stream: true },
			},
			{ invocation },
		);
		await until(() => host.calls.length === 1);
		const context = hostContext(host);
		await context.replyWritten;
		expect(context.signal.aborted).toBe(false);
		expect(isCurrentSupervisedHostRequest(context, handle, invocation)).toBe(true);
		await context.notify({
			jsonrpc: "2.0",
			method: "host/stream.chunk",
			params: { streamId: "owned-stream", sequence: 0, base64: "", done: true },
		});
		const receipt = await pending;
		expect(receipt.run).toBe(context.run);
		expect(context.signal.aborted).toBe(true);
		expect(isCurrentSupervisedHostRequest(context, handle, invocation)).toBe(false);
		expect(isCurrentSupervisedRun(receipt.run, handle)).toBe(true);
	});

	it("replaces a run after stopping and restarting the same supervised handle", async () => {
		const { handle } = await setup();
		const first = await handle.callToolWithRun("run", { do: "echo", value: 1 });
		expect(isCurrentSupervisedRun(first.run, handle)).toBe(true);
		await handle.stop();
		expect(isCurrentSupervisedRun(first.run, handle)).toBe(false);
		const second = await handle.callToolWithRun("run", { do: "echo", value: 2 });
		expect(second.result).toEqual({ echo: 2 });
		expect(second.run).not.toBe(first.run);
		expect(isCurrentSupervisedRun(second.run, handle)).toBe(true);
		expect(isCurrentSupervisedRun(first.run, handle)).toBe(false);
	});

	it("retires a socket-open request at its reply while its socket resource is still live", async () => {
		const { handle, host } = await setup(recordingHost(() => ({ socketId: "owned-socket" })));
		const invocation = Object.freeze({ tag: "socket invocation" });
		const pending = handle.callToolWithRun(
			"run",
			{
				do: "notify-wait",
				method: "host/ws.open",
				params: { url: "wss://dytest.invalid/ws" },
			},
			{ invocation },
		);
		await until(() => host.calls.length === 1);
		const context = hostContext(host);
		await context.replyWritten;
		expect(context.signal.aborted).toBe(false);
		expect(isCurrentSupervisedRun(context.run, handle)).toBe(true);
		expect(isCurrentSupervisedHostRequest(context, handle, invocation)).toBe(false);
		await context.notify({
			jsonrpc: "2.0",
			method: "host/ws.message",
			params: { socketId: "owned-socket", data: "" },
		});
		const receipt = await pending;
		expect(receipt.run).toBe(context.run);
		expect(context.signal.aborted).toBe(true);
	});

	it.each(["revoke", "close"] as const)("invalidates owned runs on %s", async (ending) => {
		const { supervisor, activation, handle } = await setup();
		const receipt = await handle.callToolWithRun("run", { do: "echo", value: 1 });
		expect(isCurrentSupervisedRun(receipt.run, handle)).toBe(true);
		const stopped = ending === "revoke" ? activation.revoke("disable") : supervisor.close();
		expect(isCurrentSupervisedRun(receipt.run, handle)).toBe(false);
		await stopped;
		expect(isCurrentSupervisedRun(receipt.run, handle)).toBe(false);
	});

	it("returns no successful receipt for rejected RPCs, pre-aborted calls or process failure", async () => {
		const { handle } = await setup();
		await expect(
			handle.callToolWithRun("run", { do: "echo" }, { signal: AbortSignal.abort() }),
		).rejects.toMatchObject({ code: "CALL_CANCELLED" });
		const first = await handle.callToolWithRun("run", { do: "echo", value: 1 });
		await expect(
			handle.callToolWithRun("run", { do: "error", code: -32042 }),
		).rejects.toMatchObject({ code: "PLUGIN_RPC_ERROR", rpcCode: -32042 });
		expect(isCurrentSupervisedRun(first.run, handle)).toBe(true);
		await expect(handle.callToolWithRun("run", { do: "exit", code: 7 })).rejects.toMatchObject({
			code: "PLUGIN_EXITED",
		});
		expect(isCurrentSupervisedRun(first.run, handle)).toBe(false);
		const next = await handle.callToolWithRun("run", { do: "echo", value: 2 });
		expect(next.result).toEqual({ echo: 2 });
		expect(next.run).not.toBe(first.run);
		expect(isCurrentSupervisedRun(next.run, handle)).toBe(true);
	});
});
