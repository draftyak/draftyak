import { EventEmitter, once } from "node:events";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import {
	assertSpawnable,
	type ChildLifecycleEvent,
	capture,
	run,
	SpawnRefusedError,
} from "./spawn.ts";

const childProcesses = vi.hoisted(() => ({ spawn: vi.fn(), restore: (): void => {} }));
vi.mock("node:child_process", async (importOriginal) => {
	const original = await importOriginal<typeof import("node:child_process")>();
	childProcesses.restore = () => {
		childProcesses.spawn.mockReset();
		childProcesses.spawn.mockImplementation(original.spawn);
	};
	childProcesses.restore();
	return { ...original, spawn: childProcesses.spawn };
});
afterEach(() => childProcesses.restore());

describe("spawn guard", () => {
	const dir = mkdtempSync(path.join(tmpdir(), "draftyak-verify-"));
	afterAll(() => rmSync(dir, { recursive: true, force: true }));

	it.each(["pnpm.cmd", "VITEST.CMD", "turbo.bat", "pnpm.ps1", "pnpm.cmd.", "pnpm.cmd "])(
		"refuses the shell shim %j",
		(name) => {
			expect(() => assertSpawnable(path.join(dir, name))).toThrow(SpawnRefusedError);
		},
	);

	it("refuses an existing .cmd target without spawning it", async () => {
		const shim = path.join(dir, "tool.cmd");
		writeFileSync(shim, "@exit /b 0\r\n");
		await expect(run({ command: shim, args: [] })).rejects.toThrow(SpawnRefusedError);
		await expect(capture({ command: shim, args: [] })).rejects.toThrow(SpawnRefusedError);
	});

	it("spawns process.execPath without a shell and returns its exit code", async () => {
		expect(await run({ command: process.execPath, args: ["-e", "process.exit(3)"] })).toBe(3);
	});

	it("passes arguments verbatim, with nothing for a shell to interpret", async () => {
		const text = 'a & b | c > d "e" %PATH% $HOME';
		const result = await capture({
			command: process.execPath,
			args: ["-e", "process.stdout.write(process.argv[1])", text],
		});
		expect(result).toMatchObject({ code: 0, stdout: text });
	});

	it("qualifies a real synchronous no-start refusal without lifecycle events", async () => {
		const events: ChildLifecycleEvent[] = [];
		await expect(
			run({ command: "DYTEST\0native", args: [] }, { onLifecycle: observe(events) }),
		).rejects.toMatchObject({ code: "ERR_INVALID_ARG_VALUE" });
		expect(events).toEqual([]);
	});

	it("observes Node spawn-error then close for a missing executable", async () => {
		const events: ChildLifecycleEvent[] = [];
		await expect(
			run(
				{ command: path.join(dir, "missing-native.exe"), args: [] },
				{ onLifecycle: observe(events) },
			),
		).rejects.toMatchObject({ code: "ENOENT" });
		expect(events.map((event) => event.type)).toEqual(["start", "error", "close"]);
		expect(events).toContainEqual(expect.objectContaining({ type: "error", errorCode: "ENOENT" }));
		expect(events).toContainEqual(expect.objectContaining({ type: "close", signal: null }));
	});
});

// The real helper is the SUT; only the native spawn boundary is replaced in these cases.
class FakeChild extends EventEmitter {
	readonly pid: number | undefined;
	readonly stdout: PassThrough | null;
	readonly stderr: PassThrough | null;
	#closed = false;
	constructor(pid: number | undefined, piped = false) {
		super();
		this.pid = pid;
		this.stdout = piped ? new PassThrough() : null;
		this.stderr = piped ? new PassThrough() : null;
	}
	close(code: number | null, signal: NodeJS.Signals | null): void {
		if (this.#closed) return;
		this.#closed = true;
		this.stdout?.end();
		this.stderr?.end();
		this.emit("close", code, signal);
	}
}

function watch<T>(promise: Promise<T>): {
	readonly settled: () => boolean;
	readonly result: Promise<{ ok: true; value: T } | { ok: false; error: unknown }>;
} {
	let settled = false;
	return {
		settled: () => settled,
		result: promise.then(
			(value) => {
				settled = true;
				return { ok: true as const, value };
			},
			(error: unknown) => {
				settled = true;
				return { ok: false as const, error };
			},
		),
	};
}

function observe(events: ChildLifecycleEvent[]): (event: ChildLifecycleEvent) => void {
	return (event) => {
		expect(Object.isFrozen(event)).toBe(true);
		events.push(event);
	};
}

const nextTurn = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

describe("direct-child lifecycle", () => {
	it("preserves synchronous no-handle throws without inventing lifecycle events", async () => {
		const failure = new Error("DYTEST synchronous native spawn failure");
		for (const invoke of [run, capture]) {
			childProcesses.spawn.mockImplementationOnce(() => {
				throw failure;
			});
			const events: ChildLifecycleEvent[] = [];
			await expect(
				invoke({ command: process.execPath, args: [] }, { onLifecycle: observe(events) }),
			).rejects.toBe(failure);
			expect(events).toEqual([]);
		}
	});

	it.each([0, 7])("keeps exit %i pending until the original close", async (code) => {
		const child = new FakeChild(17);
		childProcesses.spawn.mockReturnValueOnce(child);
		const events: ChildLifecycleEvent[] = [];
		const running = watch(
			run({ command: process.execPath, args: [] }, { onLifecycle: observe(events) }),
		);
		try {
			child.emit("spawn");
			child.emit("exit", code, null);
			await nextTurn();
			expect(running.settled()).toBe(false);
			expect(events.map((event) => event.type)).toEqual(["start", "spawn", "exit"]);
			child.close(code, null);
			expect(await running.result).toEqual({ ok: true, value: code });
			expect(events.map((event) => event.type)).toEqual(["start", "spawn", "exit", "close"]);
			expect(new Set(events.map((event) => event.invocationId)).size).toBe(1);
			expect(events.every((event) => event.pid === 17)).toBe(true);
			expect(events[0]?.invocationId).toMatch(/^[0-9a-f-]{36}$/);
			expect(childProcesses.spawn).toHaveBeenCalledWith(
				process.execPath,
				[],
				expect.objectContaining({ stdio: "inherit", shell: false, windowsHide: true }),
			);
		} finally {
			child.close(1, null);
			await running.result;
		}
	});

	it("retains late captured output between exit and genuine pipe-close completion", async () => {
		const child = new FakeChild(23, true);
		childProcesses.spawn.mockReturnValueOnce(child);
		const events: ChildLifecycleEvent[] = [];
		const running = watch(
			capture({ command: process.execPath, args: [] }, { onLifecycle: observe(events) }),
		);
		try {
			if (!child.stdout || !child.stderr) throw new Error("Missing fake capture pipes");
			child.emit("spawn");
			child.stdout.write("before");
			child.emit("exit", 0, null);
			await nextTurn();
			expect(running.settled()).toBe(false);
			const ends = Promise.all([once(child.stdout, "end"), once(child.stderr, "end")]);
			child.stdout.end("-after");
			child.stderr.end("stderr-tail");
			await ends;
			expect(running.settled()).toBe(false);
			child.close(0, null);
			expect(await running.result).toEqual({
				ok: true,
				value: { code: 0, stdout: "before-after", stderr: "stderr-tail" },
			});
			expect(events.map((event) => event.type)).toEqual(["start", "spawn", "exit", "close"]);
			expect(childProcesses.spawn).toHaveBeenCalledWith(
				process.execPath,
				[],
				expect.objectContaining({ stdio: ["ignore", "pipe", "pipe"] }),
			);
		} finally {
			child.close(1, null);
			await running.result;
		}
	});

	it("retains raw signal termination while preserving the legacy nonzero result", async () => {
		const child = new FakeChild(29);
		childProcesses.spawn.mockReturnValueOnce(child);
		const events: ChildLifecycleEvent[] = [];
		const running = watch(
			run({ command: process.execPath, args: [] }, { onLifecycle: observe(events) }),
		);
		try {
			child.emit("spawn");
			child.emit("exit", null, "SIGTERM");
			await nextTurn();
			expect(running.settled()).toBe(false);
			child.close(null, "SIGTERM");
			expect(await running.result).toEqual({ ok: true, value: 1 });
			expect(events.filter((event) => event.type === "exit" || event.type === "close")).toEqual([
				expect.objectContaining({ type: "exit", code: null, signal: "SIGTERM" }),
				expect.objectContaining({ type: "close", code: null, signal: "SIGTERM" }),
			]);
		} finally {
			child.close(1, null);
			await running.result;
		}
	});

	it("rejects the original spawn error only after close, ahead of observer failures", async () => {
		const child = new FakeChild(undefined);
		childProcesses.spawn.mockReturnValueOnce(child);
		const failure = Object.assign(new Error("DYTEST private native message"), { code: "ENOENT" });
		const events: ChildLifecycleEvent[] = [];
		const running = watch(
			run(
				{ command: process.execPath, args: ["DYTEST private argument"] },
				{
					onLifecycle: (event) => {
						events.push(event);
						if (event.type === "error") throw new Error("DYTEST private observer message");
					},
				},
			),
		);
		try {
			child.emit("error", failure);
			await nextTurn();
			expect(running.settled()).toBe(false);
			expect(events.map((event) => event.type)).toEqual(["start", "error"]);
			child.close(-2, null);
			const outcome = await running.result;
			expect(outcome.ok).toBe(false);
			if (outcome.ok) throw new Error("Native spawn failure unexpectedly passed");
			expect(outcome.error).toBe(failure);
			expect(events).toContainEqual(
				expect.objectContaining({ type: "error", errorCode: "ENOENT", pid: null }),
			);
			expect(events).toContainEqual(
				expect.objectContaining({ type: "close", code: -2, signal: null, pid: null }),
			);
			expect(events.some((event) => event.type === "exit")).toBe(false);
			expect(JSON.stringify(events)).not.toContain("DYTEST");
		} finally {
			child.close(-2, null);
			await running.result;
		}
	});

	it("never projects arbitrary error codes, messages, arguments, environment or cwd", async () => {
		const child = new FakeChild(undefined);
		childProcesses.spawn.mockReturnValueOnce(child);
		const events: ChildLifecycleEvent[] = [];
		const failure = Object.assign(new Error("DYTEST private message"), { code: "DYTEST_PRIVATE" });
		const running = watch(
			run(
				{ command: process.execPath, args: ["DYTEST argument"] },
				{
					cwd: "DYTEST cwd",
					env: { DYTEST_ENV: "DYTEST value" },
					onLifecycle: observe(events),
				},
			),
		);
		try {
			child.emit("error", failure);
			child.close(-2, null);
			expect(await running.result).toEqual({ ok: false, error: failure });
			expect(events).toContainEqual(expect.objectContaining({ type: "error", errorCode: null }));
			expect(JSON.stringify(events)).not.toContain("DYTEST");
			for (const event of events) {
				const base = ["invocationId", "pid", "type"];
				let extra: string[] = [];
				if (event.type === "error") extra = ["errorCode"];
				else if (event.type === "close") extra = ["code", "signal"];
				expect(Object.keys(event).sort()).toEqual([...base, ...extra].sort());
			}
		} finally {
			child.close(-2, null);
			await running.result;
		}
	});

	it.each(["start", "exit", "close"] as const)(
		"contains an observer throw at %s and rejects with a fixed error only after close",
		async (stage) => {
			const child = new FakeChild(31);
			childProcesses.spawn.mockReturnValueOnce(child);
			const events: ChildLifecycleEvent[] = [];
			const running = watch(
				run(
					{ command: process.execPath, args: [] },
					{
						onLifecycle: (event) => {
							events.push(event);
							if (event.type === stage) throw new Error("DYTEST private observer failure");
						},
					},
				),
			);
			try {
				child.emit("spawn");
				child.emit("exit", 0, null);
				await nextTurn();
				expect(running.settled()).toBe(false);
				child.close(0, null);
				const outcome = await running.result;
				expect(outcome.ok).toBe(false);
				if (outcome.ok) throw new Error("Observer failure unexpectedly passed");
				expect(outcome.error).toBeInstanceOf(Error);
				expect((outcome.error as Error).message).toBe("Child lifecycle observer failed");
				expect(events.map((event) => event.type)).toEqual(["start", "spawn", "exit", "close"]);
			} finally {
				child.close(1, null);
				await running.result;
			}
		},
	);

	it("generates a distinct identity for each direct invocation", async () => {
		const events: ChildLifecycleEvent[] = [];
		for (const pid of [37, 41]) {
			const child = new FakeChild(pid);
			childProcesses.spawn.mockReturnValueOnce(child);
			const running = watch(
				run({ command: process.execPath, args: [] }, { onLifecycle: observe(events) }),
			);
			child.emit("spawn");
			child.emit("exit", 0, null);
			child.close(0, null);
			expect(await running.result).toEqual({ ok: true, value: 0 });
		}
		const starts = events.filter((event) => event.type === "start");
		expect(starts.map((event) => event.pid)).toEqual([37, 41]);
		expect(new Set(starts.map((event) => event.invocationId)).size).toBe(2);
	});
});
