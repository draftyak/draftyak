import * as childProcess from "node:child_process";
import { EventEmitter } from "node:events";
import { existsSync, lstatSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { PassThrough, Writable } from "node:stream";
import * as pluginStdio from "@draftyak/protocol/plugin-stdio";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { bindProcessPlugin, createProcess } from "../src/process.ts";
import type { MockHost } from "../src/types.ts";
import { channelFixture } from "./fixtures/channel/plugin.ts";

vi.mock("node:child_process", async (original) => ({
	...(await original<typeof import("node:child_process")>()),
	spawn: vi.fn(),
}));

type TerminationOutcome = "false" | "throw" | "error";
type ControlledChild = EventEmitter & {
	pid: number;
	exitCode: number | null;
	signalCode: NodeJS.Signals | null;
	kill: ReturnType<typeof vi.fn>;
};
const owned = new Set<string>();
const temporary = realpathSync(tmpdir());

function removeOwned(root: string): void {
	if (!existsSync(root)) return;
	if (
		path.dirname(root) !== temporary ||
		!/^draftyak-(?:lifecycle-proof|plugin)-/.test(path.basename(root)) ||
		lstatSync(root).isSymbolicLink() ||
		realpathSync(root) !== root
	)
		throw new Error("Lifecycle fixture cleanup root changed");
	rmSync(root, { recursive: true, force: true });
}

beforeEach(() => vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] }));
afterEach(() => {
	vi.useRealTimers();
	vi.restoreAllMocks();
	vi.mocked(childProcess.spawn).mockReset();
	for (const root of owned) removeOwned(root);
	owned.clear();
});

/** A controlled child lifecycle tests the real driver; no OS child is spawned here. */
async function fixture(outcome: TerminationOutcome) {
	const source = realpathSync(mkdtempSync(path.join(temporary, "draftyak-lifecycle-proof-")));
	owned.add(source);
	writeFileSync(path.join(source, "entry.mjs"), "export {};\n", { flag: "wx" });
	const child = Object.assign(new EventEmitter(), {
		pid: 1,
		exitCode: null as number | null,
		signalCode: null as NodeJS.Signals | null,
		kill: vi.fn(),
	}) satisfies ControlledChild;
	child.kill.mockImplementation(() => {
		if (outcome === "throw") throw new Error("Controlled termination failure");
		if (outcome === "error") child.emit("error", new Error("Controlled signal error"));
		return false;
	});
	let stage = "";
	vi.mocked(childProcess.spawn).mockImplementation((...args) => {
		const options = args[2] as { cwd: string };
		stage = path.dirname(options.cwd);
		owned.add(stage);
		return child as unknown as childProcess.ChildProcess;
	});
	const sent = Promise.withResolvers<void>();
	const input = new Writable({
		write(_chunk, _encoding, callback) {
			sent.resolve();
			callback();
		},
	});
	const outputs = [new PassThrough(), new PassThrough()] as const;
	const destroyIo = vi.fn(async () => {
		input.destroy();
		for (const stream of outputs) stream.destroy();
	});
	const destroyStdio = vi.fn(async () => {});
	const attached = vi.fn(() => ({
		input,
		outputs,
		completion: new Promise<pluginStdio.PluginStdioResult>(() => {}),
		destroy: destroyIo,
	}));
	vi.spyOn(pluginStdio, "openPluginStdio").mockResolvedValue({
		kind: "pipe",
		stdio: ["pipe", "pipe", "pipe"],
		attach: attached,
		destroy: destroyStdio,
	});
	const unsubscribe = vi.fn();
	const host = { subscribe: vi.fn(() => unsubscribe) } as unknown as MockHost;
	const plugin = bindProcessPlugin(channelFixture(), {
		directory: source,
		entry: "entry.mjs",
		files: ["entry.mjs"],
	});
	const adapter = createProcess(plugin, host, { plugin: "lifecycle-fixture", instance: "one" });
	// The actual MCP client has installed its lifecycle handlers and sent initialization.
	const request = adapter.request("server/discover").catch((error: unknown) => error);
	await sent.promise;
	expect(childProcess.spawn).toHaveBeenCalledTimes(1);
	expect(attached).toHaveBeenCalledWith(child);
	expect(existsSync(stage)).toBe(true);
	return { adapter, child, stage, request, destroyIo, destroyStdio, unsubscribe };
}

describe.each(["false", "throw", "error"] as const)("unconfirmed %s termination", (outcome) => {
	it("retains the child and stage until the unchanged deadline, then refuses cleanup", async () => {
		const state = await fixture(outcome);
		let settled = false;
		let failure: unknown;
		const closing = state.adapter.close().then(
			() => {
				settled = true;
			},
			(error: unknown) => {
				settled = true;
				failure = error;
			},
		);
		await vi.advanceTimersByTimeAsync(4_999);
		expect(settled).toBe(false);
		expect(state.child.kill.mock.calls).toEqual([[undefined]]);
		expect(state.child.exitCode).toBeNull();
		expect(state.child.signalCode).toBeNull();
		expect(state.destroyIo).not.toHaveBeenCalled();
		expect(state.destroyStdio).not.toHaveBeenCalled();
		expect(existsSync(state.stage)).toBe(true);
		await vi.advanceTimersByTimeAsync(1);
		expect(state.child.kill.mock.calls).toEqual([[undefined], ["SIGKILL"]]);
		await vi.advanceTimersByTimeAsync(4_999);
		expect(settled).toBe(false);
		expect(state.destroyIo).not.toHaveBeenCalled();
		expect(existsSync(state.stage)).toBe(true);
		await vi.advanceTimersByTimeAsync(1);
		await closing;
		expect(settled).toBe(true);
		expect(failure).toMatchObject({ code: "PROCESS_CLEANUP_FAILED" });
		expect(state.child.exitCode).toBeNull();
		expect(state.child.signalCode).toBeNull();
		expect(existsSync(state.stage)).toBe(true);
		expect(state.destroyIo).toHaveBeenCalledTimes(1);
		expect(state.destroyStdio).toHaveBeenCalledTimes(1);
		await expect(state.adapter.close()).rejects.toMatchObject({ code: "PROCESS_CLEANUP_FAILED" });
		expect(state.child.kill).toHaveBeenCalledTimes(2);
		await state.request;
		expect(state.child.listenerCount("exit")).toBe(0);
		expect(state.child.listenerCount("error")).toBe(0);
		expect(vi.getTimerCount()).toBe(0);
	});

	it.each([1_000, 7_000])("accepts a confirmed exit at %ims and removes the stage", async (at) => {
		const state = await fixture(outcome);
		let settled = false;
		const closing = state.adapter.close().then(() => {
			settled = true;
		});
		await vi.advanceTimersByTimeAsync(at);
		expect(settled).toBe(false);
		expect(state.child.kill).toHaveBeenCalledTimes(at < 5_000 ? 1 : 2);
		expect(state.destroyIo).not.toHaveBeenCalled();
		expect(existsSync(state.stage)).toBe(true);
		state.child.exitCode = 0;
		state.child.emit("exit", 0, null);
		await closing;
		expect(settled).toBe(true);
		expect(existsSync(state.stage)).toBe(false);
		expect(state.destroyIo).toHaveBeenCalledTimes(1);
		expect(state.destroyStdio).toHaveBeenCalledTimes(1);
		expect(state.unsubscribe).toHaveBeenCalledTimes(1);
		const kills = state.child.kill.mock.calls.length;
		await vi.advanceTimersByTimeAsync(20_000);
		await state.adapter.close();
		expect(state.child.kill).toHaveBeenCalledTimes(kills);
		expect(state.destroyIo).toHaveBeenCalledTimes(1);
		expect(state.child.listenerCount("exit")).toBe(0);
		expect(state.child.listenerCount("error")).toBe(0);
		await state.request;
		expect(vi.getTimerCount()).toBe(0);
	});
});
