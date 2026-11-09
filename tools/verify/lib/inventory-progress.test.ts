import path from "node:path";
import { describe, expect, it } from "vitest";
import type { InventoryPipe, OwnedProcess } from "./inventory-process.ts";
import {
	createInventoryProgress,
	type InventoryProgress,
	type InventoryProgressCounters,
	type InventoryProgressPorts,
} from "./inventory-progress.ts";
import {
	createInventoryHost,
	type InventoryIo,
	runWorktreeInventory,
} from "./worktree-inventory.ts";

const turn = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));
const counters = (): InventoryProgressCounters => ({
	pendingGit: 0,
	pendingFs: 0,
	directoryVisits: 0,
	entries: 0,
});
const ROOT = path.resolve("DYTEST-inventory-main");

class Clock {
	now = 0;
	readonly timers = new Map<object, { at: number; callback: () => void }>();
	readonly created: object[] = [];
	readonly unrefed = new Set<object>();
	set(callback: () => void, delay: number): object {
		const token = {};
		this.created.push(token);
		this.timers.set(token, { at: this.now + delay, callback });
		return token;
	}
	clear(token: unknown): void {
		if (typeof token === "object" && token !== null) this.timers.delete(token);
	}
	unref(token: unknown): void {
		if (typeof token !== "object" || token === null || !this.timers.has(token))
			throw new Error("DYTEST unknown timer");
		this.unrefed.add(token);
	}
	advance(to: number): void {
		for (;;) {
			const next = [...this.timers]
				.filter(([, row]) => row.at <= to)
				.sort((a, b) => a[1].at - b[1].at)[0];
			if (!next) break;
			this.now = next[1].at;
			this.timers.delete(next[0]);
			next[1].callback();
		}
		this.now = to;
	}
}

type WriteAck = (error?: Error | null) => void;
function progressHarness(
	readCounters: () => InventoryProgressCounters = counters,
	onFault?: () => void,
) {
	const clock = new Clock();
	const frames: string[] = [],
		acks: WriteAck[] = [];
	let autoAck = true,
		throwWrite = false,
		faults = 0;
	const ports: InventoryProgressPorts = {
		now: () => clock.now,
		setTimer: (callback, delay) => clock.set(callback, delay),
		unrefTimer: (token) => clock.unref(token),
		clearTimer: (token) => clock.clear(token),
		write: (frame, ack) => {
			frames.push(frame);
			if (throwWrite) throw new Error("DYTEST write threw without acknowledgement");
			if (autoAck) ack();
			else acks.push(ack);
		},
	};
	const progress = createInventoryProgress(
		readCounters,
		() => {
			faults++;
			onFault?.();
		},
		ports,
	);
	return {
		progress,
		clock,
		frames,
		acks,
		faults: () => faults,
		manualAcks: () => {
			autoAck = false;
		},
		failWrite: () => {
			throwWrite = true;
		},
	};
}
function rows(frames: readonly string[]): number[][] {
	return frames.map((frame) => {
		expect(frame).toMatch(/^I1 [012] [0-5] (?:-1|[0-9]+)(?: [0-9]+){5}\n$/);
		expect(Buffer.byteLength(frame, "utf8")).toBeLessThanOrEqual(128);
		return frame.trimEnd().split(" ").slice(1).map(Number);
	});
}
function outcome(promise: Promise<unknown>): () => "pending" | "passed" | "refused" {
	let value: "pending" | "passed" | "refused" = "pending";
	void promise.then(
		() => {
			value = "passed";
		},
		() => {
			value = "refused";
		},
	);
	return () => value;
}

class Pipe implements InventoryPipe {
	readonly data: ((chunk: Buffer) => void)[] = [];
	readonly errors: ((error: unknown) => void)[] = [];
	onData(listener: (chunk: Buffer) => void): void {
		this.data.push(listener);
	}
	onError(listener: (error: unknown) => void): void {
		this.errors.push(listener);
	}
	send(value: string): void {
		for (const listener of this.data) listener(Buffer.from(value));
	}
}
class Original implements OwnedProcess {
	readonly stdout = new Pipe();
	readonly stderr = new Pipe();
	readonly errors: ((error: unknown) => void)[] = [];
	readonly closes: ((code: number | null) => void)[] = [];
	killCalls = 0;
	closed = false;
	onError(listener: (error: unknown) => void): void {
		this.errors.push(listener);
	}
	onClose(listener: (code: number | null) => void): void {
		this.closes.push(listener);
	}
	kill(): void {
		this.killCalls++;
	}
	fail(): void {
		for (const listener of this.errors) listener(new Error("DYTEST original failed"));
	}
	close(code: number | null): void {
		if (this.closed) return;
		this.closed = true;
		for (const listener of this.closes) listener(code);
	}
}
const file = (name: string) => ({ name, isDirectory: () => false, isSymbolicLink: () => false });
const directory = { isDirectory: () => true, isSymbolicLink: () => false };
function fakeIo(overrides: Partial<InventoryIo> = {}) {
	const children: Original[] = [],
		stdout: string[] = [],
		acks: WriteAck[] = [];
	const ports: InventoryIo = {
		readDirectory: async () => [],
		statPath: async () => directory,
		spawnGit: () => {
			const child = new Original();
			children.push(child);
			return child;
		},
		write: (bytes, ack) => {
			stdout.push(bytes);
			acks.push(ack);
		},
		...overrides,
	};
	return { ports, children, stdout, acks };
}

describe("bounded numeric inventory progress", () => {
	it("starts with unknown roots and only fixed numeric ASCII data", async () => {
		const h = progressHarness();
		h.progress.phase(0);
		expect(rows(h.frames)[0]).toEqual([0, 0, -1, 0, 0, 0, 0, 0]);
		expect(await h.progress.finish()).toBe(true);
		expect(rows(h.frames).at(-1)?.[0]).toBe(2);
	});

	it("uses the actual root count and successive actual counter snapshots", async () => {
		let current = counters();
		const h = progressHarness(() => current);
		h.progress.phase(0);
		h.progress.phase(1);
		h.progress.roots(3);
		current = { pendingGit: 2, pendingFs: 4, directoryVisits: 5, entries: 7 };
		h.clock.now = 23;
		h.progress.phase(2);
		expect(rows(h.frames).at(-1)).toEqual([0, 2, 3, 2, 4, 5, 7, 23]);
		expect(await h.progress.finish()).toBe(true);
	});

	it("does not serialize unrelated names or error prose from the counter object", async () => {
		const h = progressHarness(() => ({
			...counters(),
			pathname: "DYTEST_PRIVATE_PATH",
			name: "DYTEST_PRIVATE_NAME",
			error: "DYTEST_PRIVATE_PROSE",
		}));
		h.progress.phase(0);
		h.progress.phase(3);
		expect(await h.progress.finish()).toBe(true);
		rows(h.frames);
		expect(h.frames.join("")).not.toContain("DYTEST_PRIVATE");
	});

	it("ignores duplicate and backward valid phases including after stop", async () => {
		const h = progressHarness();
		h.progress.phase(0);
		h.progress.phase(0);
		h.progress.phase(3);
		h.progress.phase(1);
		h.progress.phase(5);
		h.progress.phase(5);
		h.progress.phase(4);
		expect(rows(h.frames).map((row) => row[1])).toEqual([0, 3, 5]);
		expect(await h.progress.finish()).toBe(true);
		expect(h.faults()).toBe(0);
	});

	it("reserves output, drain and final frames after all seventeen periodic writes", async () => {
		const h = progressHarness();
		for (const phase of [0, 1, 2, 3] as const) h.progress.phase(phase);
		h.progress.roots(2);
		h.clock.advance(17 * 15_000);
		expect(rows(h.frames).filter((row) => row[0] === 1)).toHaveLength(17);
		expect(h.clock.timers.size).toBe(0);
		h.clock.advance(18 * 15_000);
		h.progress.phase(4);
		h.progress.phase(5);
		expect(await h.progress.finish()).toBe(true);
		const observed = rows(h.frames);
		expect(observed.filter((row) => row[0] === 0).map((row) => row[1])).toEqual([0, 1, 2, 3, 4, 5]);
		expect(observed.filter((row) => row[0] === 1)).toHaveLength(17);
		expect(observed.filter((row) => row[0] === 2)).toHaveLength(1);
		expect(h.frames).toHaveLength(24);
		expect(Buffer.byteLength(h.frames.join(""), "utf8")).toBeLessThanOrEqual(3072);
	});

	it("unrefs every periodic timer and ignores its callback after finish", async () => {
		const h = progressHarness();
		h.progress.phase(0);
		const callbacks = [...h.clock.timers.values()].map((timer) => timer.callback);
		h.clock.advance(15_000);
		expect(h.clock.created.every((token) => h.clock.unrefed.has(token))).toBe(true);
		expect(await h.progress.finish()).toBe(true);
		expect(h.clock.timers.size).toBe(0);
		const count = h.frames.length;
		for (const callback of callbacks) callback();
		h.progress.phase(5);
		h.progress.roots(4);
		expect(h.frames).toHaveLength(count);
	});

	it("waits for every original acknowledgement and returns the same finish promise", async () => {
		const h = progressHarness();
		h.manualAcks();
		h.progress.phase(0);
		h.progress.phase(1);
		const finished = h.progress.finish(),
			state = outcome(finished);
		expect(h.progress.finish()).toBe(finished);
		expect(h.clock.timers.size).toBe(0);
		await turn();
		expect(state()).toBe("pending");
		const first = h.acks.shift();
		expect(first).toBeTypeOf("function");
		while (h.acks.length > 0) h.acks.shift()?.();
		await turn();
		expect(state()).toBe("pending");
		first?.();
		expect(await finished).toBe(true);
	});

	it("retains the other write receipts when an actual acknowledgement fails", async () => {
		const h = progressHarness();
		h.manualAcks();
		h.progress.phase(0);
		h.progress.phase(1);
		const finished = h.progress.finish(),
			state = outcome(finished);
		const failed = h.acks.shift();
		expect(failed).toBeTypeOf("function");
		failed?.(new Error("DYTEST arbitrary acknowledgement detail"));
		await turn();
		expect(state()).toBe("pending");
		while (h.acks.length > 0) h.acks.shift()?.();
		expect(await finished).toBe(false);
		expect(h.faults()).toBe(1);
		expect(h.frames.join("")).not.toContain("acknowledgement detail");
	});

	it("does not invent an acknowledgement for a synchronous write throw", async () => {
		const h = progressHarness();
		h.failWrite();
		h.progress.phase(0);
		const finished = h.progress.finish(),
			state = outcome(finished);
		await turn();
		expect(state()).toBe("pending");
		expect(h.faults()).toBe(1);
		expect(h.clock.timers.size).toBe(0);
		// This synthetic pending receipt owns no actual stream, timer or OS child.
	});

	it.each(["pendingGit", "pendingFs", "directoryVisits", "entries"] as const)(
		"refuses a negative %s without serializing it",
		async (key) => {
			const h = progressHarness(() => ({ ...counters(), [key]: -1 }));
			h.progress.phase(0);
			expect(await h.progress.finish()).toBe(false);
			expect(h.faults()).toBe(1);
			expect(h.frames).toHaveLength(0);
		},
	);

	it.each([Number.NaN, Number.POSITIVE_INFINITY, Number.MAX_SAFE_INTEGER + 1])(
		"refuses non-safe numeric counter %s",
		async (bad) => {
			const h = progressHarness(() => ({ ...counters(), entries: bad }));
			h.progress.phase(0);
			expect(await h.progress.finish()).toBe(false);
			expect(h.faults()).toBe(1);
			expect(h.frames).toHaveLength(0);
		},
	);

	it("refuses a caller-supplied unknown root count while retaining internal unknown roots", async () => {
		const h = progressHarness();
		h.progress.phase(0);
		h.progress.roots(-1);
		expect(await h.progress.finish()).toBe(false);
		expect(h.faults()).toBe(1);
		expect(rows(h.frames)[0]?.[2]).toBe(-1);
	});

	it("refuses an invalid phase enum without emitting its value", async () => {
		const h = progressHarness();
		h.progress.phase(0);
		Reflect.apply(h.progress.phase, h.progress, [6]);
		expect(await h.progress.finish()).toBe(false);
		expect(h.faults()).toBe(1);
		expect(rows(h.frames).every((row) => row[1] !== undefined && row[1] <= 5)).toBe(true);
	});

	it("keeps safe maximum counters within the fixed frame and lifetime byte bounds", async () => {
		const max = Number.MAX_SAFE_INTEGER;
		const h = progressHarness(() => ({
			pendingGit: max,
			pendingFs: max,
			directoryVisits: max,
			entries: max,
		}));
		h.progress.phase(0);
		h.progress.roots(max);
		h.clock.now = max;
		h.progress.phase(4);
		expect(await h.progress.finish()).toBe(true);
		rows(h.frames);
		expect(Buffer.byteLength(h.frames.join(""), "utf8")).toBeLessThanOrEqual(3072);
	});
});

describe("actual inventory host observations under synthetic IO", () => {
	it("counts admitted filesystem visits and successful entries through actual settlement", async () => {
		const read = Promise.withResolvers<readonly ReturnType<typeof file>[]>(),
			stat = Promise.withResolvers<typeof directory>();
		const io = fakeIo({ readDirectory: () => read.promise, statPath: () => stat.promise });
		const host = createInventoryHost(ROOT, io.ports);
		const reading = host.readDirectory("DYTEST_PRIVATE_DIRECTORY"),
			stating = host.statPath("DYTEST_PRIVATE_ENTRY");
		expect(host.snapshot()).toEqual({
			pendingGit: 0,
			pendingFs: 2,
			directoryVisits: 1,
			entries: 0,
		});
		read.resolve([file("DYTEST_ONE"), file("DYTEST_TWO")]);
		await reading;
		expect(host.snapshot()).toEqual({
			pendingGit: 0,
			pendingFs: 1,
			directoryVisits: 1,
			entries: 2,
		});
		stat.resolve(directory);
		await stating;
		expect(host.snapshot()).toEqual({
			pendingGit: 0,
			pendingFs: 0,
			directoryVisits: 1,
			entries: 2,
		});
		host.stop();
		await expect(host.readDirectory("DYTEST_REFUSED")).rejects.toThrow(
			"file-name inventory failed",
		);
		expect(host.snapshot().directoryVisits).toBe(1);
		await host.drain();
	});

	it("retires rejected filesystem operations without inventing successful entries", async () => {
		const read = Promise.withResolvers<readonly ReturnType<typeof file>[]>();
		const io = fakeIo({ readDirectory: () => read.promise }),
			host = createInventoryHost(ROOT, io.ports);
		const reading = host.readDirectory("DYTEST_PRIVATE_DIRECTORY");
		const rejected = expect(reading).rejects.toThrow("DYTEST read refusal");
		read.reject(new Error("DYTEST read refusal"));
		await rejected;
		expect(host.snapshot()).toEqual({
			pendingGit: 0,
			pendingFs: 0,
			directoryVisits: 1,
			entries: 0,
		});
		host.stop();
		await host.drain();
	});

	it("keeps original Git pending through stop and kill until its actual close callback", async () => {
		const io = fakeIo(),
			host = createInventoryHost(ROOT, io.ports);
		const git = host.git(["DYTEST_ONLY"]),
			gitState = outcome(git);
		expect(host.snapshot().pendingGit).toBe(1);
		const original = io.children[0];
		expect(original).toBeDefined();
		if (!original) throw new Error("DYTEST missing original");
		original.fail();
		expect(original.killCalls).toBe(1);
		expect(host.snapshot().pendingGit).toBe(1);
		const drained = host.drain(),
			drainState = outcome(drained);
		await turn();
		expect(drainState()).toBe("pending");
		expect(gitState()).toBe("pending");
		original.close(1);
		await drained;
		await expect(git).rejects.toThrow("file-name inventory failed");
		expect(host.snapshot().pendingGit).toBe(0);
	});

	it("faults the same real host and preserves its original close fence", async () => {
		const io = fakeIo();
		let progress: InventoryProgress | undefined;
		const stopFacts: { stopped: boolean; pendingGit: number; killCalls: number }[] = [];
		const host = createInventoryHost(ROOT, io.ports, () => {
			stopFacts.push({
				stopped: host.stopped(),
				pendingGit: host.snapshot().pendingGit,
				killCalls: io.children[0]?.killCalls ?? -1,
			});
			progress?.phase(5);
		});
		const h = progressHarness(
			() => host.snapshot(),
			() => host.stop(),
		);
		progress = h.progress;
		h.manualAcks();
		progress.phase(1);
		const git = host.git(["DYTEST_ONLY"]);
		void git.catch(() => {});
		const original = io.children[0];
		if (!original) throw new Error("DYTEST missing original");
		h.acks.shift()?.(new Error("DYTEST write refusal"));
		expect(host.stopped()).toBe(true);
		expect(original.killCalls).toBe(1);
		expect(host.snapshot().pendingGit).toBe(1);
		const drained = host.drain(),
			state = outcome(drained);
		await turn();
		expect(state()).toBe("pending");
		original.close(1);
		await drained;
		const finished = progress.finish();
		while (h.acks.length > 0) h.acks.shift()?.();
		expect(await finished).toBe(false);
		expect(h.faults()).toBe(1);
		expect(stopFacts).toEqual([{ stopped: true, pendingGit: 1, killCalls: 0 }]);
	});

	it("uses genuine discovery and waits for the original stdout acknowledgement in output phase", async () => {
		const io = fakeIo();
		let progress: InventoryProgress | undefined;
		const host = createInventoryHost(ROOT, io.ports, () => progress?.phase(5));
		const h = progressHarness(
			() => host.snapshot(),
			() => host.stop(),
		);
		progress = h.progress;
		const running = runWorktreeInventory(ROOT, host, progress),
			state = outcome(running);
		try {
			const discovery = io.children[0];
			if (!discovery) throw new Error("DYTEST missing discovery");
			discovery.stdout.send(path.join(ROOT, ".git") + "\n");
			discovery.close(0);
			await turn();
			const listing = io.children[1];
			if (!listing) throw new Error("DYTEST missing listing");
			listing.stdout.send(
				"worktree " + ROOT + "\0HEAD " + "a".repeat(40) + "\0branch refs/heads/DYTEST\0\0",
			);
			listing.close(0);
			await turn();
			expect(host.snapshot()).toEqual({
				pendingGit: 0,
				pendingFs: 0,
				directoryVisits: 0,
				entries: 0,
			});
			expect(rows(h.frames).find((row) => row[1] === 2)?.[2]).toBe(0);
			expect(rows(h.frames).at(-1)?.[1]).toBe(4);
			expect(io.stdout).toEqual(["WORKTREE_INVENTORY_COMPLETE\n"]);
			expect(state()).toBe("pending");
			io.acks.shift()?.();
			await running;
			expect(state()).toBe("passed");
			expect(await progress.finish()).toBe(true);
		} finally {
			host.stop();
			for (const child of io.children) child.close(1);
			for (const ack of io.acks) ack();
			await host.drain();
			await running.catch(() => {});
			await progress.finish();
		}
	});
});

describe("same-host cancellation after original filesystem settlement", () => {
	it("drains a stopped pending read without consuming its returned listing", async () => {
		const originalRead = Promise.withResolvers<readonly ReturnType<typeof file>[]>();
		let reads = 0,
			examined = 0;
		const returned = Array.from({ length: 4000 }, (_, index) => ({
			get name() {
				examined++;
				return `DYTEST_ENTRY_${index}`;
			},
			isDirectory: () => false,
			isSymbolicLink: () => false,
		}));
		const io = fakeIo({
			readDirectory: async () => {
				reads++;
				return originalRead.promise;
			},
		});
		const host = createInventoryHost(ROOT, io.ports);
		const running = runWorktreeInventory(ROOT, host),
			state = outcome(running);
		void running.catch(() => {});
		try {
			const discovery = io.children[0];
			if (!discovery) throw new Error("DYTEST missing discovery");
			discovery.stdout.send(path.join(ROOT, ".git") + "\n");
			discovery.close(0);
			await turn();
			const listing = io.children[1];
			if (!listing) throw new Error("DYTEST missing listing");
			const other = path.resolve("DYTEST-inventory-cancelled-root");
			listing.stdout.send(
				`worktree ${ROOT}\0HEAD ${"a".repeat(40)}\0\0worktree ${other}\0HEAD ${"b".repeat(40)}\0\0`,
			);
			listing.close(0);
			await turn();
			expect(reads).toBe(1);
			expect(host.snapshot().pendingFs).toBe(1);
			host.stop();
			const drained = host.drain(),
				drainState = outcome(drained);
			await turn();
			expect([state(), drainState()]).toEqual(["pending", "pending"]);
			expect(examined).toBe(0);
			originalRead.resolve(returned);
			await expect(running).rejects.toThrow("file-name inventory failed");
			await drained;
			expect(examined).toBe(0);
			expect(host.snapshot().pendingFs).toBe(0);
			expect(io.stdout).toEqual([]);
		} finally {
			host.stop();
			originalRead.resolve([]);
			for (const child of io.children) child.close(1);
			for (const ack of io.acks) ack();
			await host.drain();
			await running.catch(() => {});
		}
	});

	it("keeps original stat ownership until settlement and refuses its late result after stop", async () => {
		const originalStat = Promise.withResolvers<typeof directory>();
		const io = fakeIo({ statPath: () => originalStat.promise });
		const host = createInventoryHost(ROOT, io.ports);
		let consumed = 0;
		const stated = host.statPath("DYTEST-stat-target").then((value) => {
			consumed++;
			return value;
		});
		const state = outcome(stated);
		host.stop();
		const drained = host.drain(),
			drainState = outcome(drained);
		try {
			await turn();
			expect([state(), drainState()]).toEqual(["pending", "pending"]);
			expect(host.snapshot().pendingFs).toBe(1);
			originalStat.resolve(directory);
			await expect(stated).rejects.toThrow("file-name inventory failed");
			await drained;
			expect(consumed).toBe(0);
			expect(host.snapshot().pendingFs).toBe(0);
			expect(io.stdout).toEqual([]);
		} finally {
			originalStat.resolve(directory);
			await host.drain();
			await stated.catch(() => {});
		}
	});
});
