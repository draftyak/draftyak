import { describe, expect, it } from "vitest";
import {
	type InventoryChild,
	type InventoryPipe,
	type InventoryProcessRuntime,
	inventoryEnvironment,
	runInventoryAfter,
} from "./inventory-process.ts";

const complete = Buffer.from("WORKTREE_INVENTORY_COMPLETE\n");
const turn = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

class Pipe implements InventoryPipe {
	readonly dataListeners: ((chunk: Buffer) => void)[] = [];
	readonly errorListeners: ((error: unknown) => void)[] = [];
	onData(listener: (chunk: Buffer) => void): void {
		this.dataListeners.push(listener);
	}
	onError(listener: (error: unknown) => void): void {
		this.errorListeners.push(listener);
	}
	data(bytes: Buffer): void {
		for (const listener of this.dataListeners) listener(bytes);
	}
	error(): void {
		for (const listener of this.errorListeners) listener(new Error("DYTEST pipe failure"));
	}
}

class Child implements InventoryChild {
	readonly stdout = new Pipe();
	readonly stderr = new Pipe();
	readonly errors: ((error: unknown) => void)[] = [];
	readonly closes: ((code: number | null) => void)[] = [];
	stopCalls = 0;
	killCalls = 0;
	failStop = false;
	failKill = false;
	closed = false;
	onError(listener: (error: unknown) => void): void {
		this.errors.push(listener);
	}
	onClose(listener: (code: number | null) => void): void {
		this.closes.push(listener);
	}
	stop(): void {
		this.stopCalls++;
		if (this.failStop) throw new Error("DYTEST stop send failure");
	}
	kill(): void {
		this.killCalls++;
		if (this.failKill) throw new Error("DYTEST owned kill failure");
	}
	error(): void {
		for (const listener of this.errors) listener(new Error("DYTEST child failure"));
	}
	close(code: number | null): void {
		if (this.closed) return;
		this.closed = true;
		for (const listener of this.closes) listener(code);
	}
}

class Clock {
	now = 0;
	readonly timers = new Map<object, { at: number; callback: () => void }>();
	set(callback: () => void, delay: number): object {
		const token = {};
		this.timers.set(token, { at: this.now + delay, callback });
		return token;
	}
	clear(token: unknown): void {
		if (typeof token === "object" && token !== null) this.timers.delete(token);
	}
	advance(to: number): void {
		for (;;) {
			const next = [...this.timers]
				.filter(([, timer]) => timer.at <= to)
				.sort((a, b) => a[1].at - b[1].at)[0];
			if (!next) break;
			this.now = next[1].at;
			this.timers.delete(next[0]);
			next[1].callback();
		}
		this.now = to;
	}
}

function harness() {
	const child = new Child();
	const clock = new Clock();
	const spawned = Promise.withResolvers<void>();
	let spawns = 0;
	let nodeCommand = false;
	let args: readonly string[] = [];
	const runtime: InventoryProcessRuntime = {
		now: () => clock.now,
		setTimer: (callback, delay) => clock.set(callback, delay),
		clearTimer: (token) => clock.clear(token),
		spawn: (options) => {
			spawns++;
			nodeCommand = options.command === process.execPath;
			args = [...options.args];
			spawned.resolve();
			return child;
		},
	};
	return {
		child,
		clock,
		spawned,
		runtime,
		spawns: () => spawns,
		nodeCommand: () => nodeCommand,
		args: () => args,
	};
}

async function started(h: ReturnType<typeof harness>, result: Promise<void>): Promise<void> {
	expect(
		await Promise.race([
			h.spawned.promise.then(() => true),
			result.then(
				() => false,
				() => false,
			),
		]),
	).toBe(true);
}

describe("owned inventory process", () => {
	it("ignores caller threadpool and framework authority while preserving the isolated child environment", () => {
		const os = {
			PATH: "DYTEST_PATH",
			Path: "DYTEST_PATH_CASE",
			SystemRoot: "DYTEST_SYSTEM_ROOT",
			WINDIR: "DYTEST_WINDOWS",
			TEMP: "DYTEST_TEMP",
			TMP: "DYTEST_TMP",
		};
		for (const callerPool of [undefined, "4", "1024"]) {
			const supplied: NodeJS.ProcessEnv = {
				...os,
				UV_THREADPOOL_SIZE: callerPool,
				uv_threadpool_size: "1024",
				NODE_OPTIONS: "--require DYTEST_LOADER",
				NODE_PATH: "DYTEST_MODULES",
				VITEST: "1",
				VITEST_POOL_ID: "DYTEST_POOL",
				VITE_NODE_OPTIONS: "DYTEST_VITE_OPTIONS",
				NODE_V8_COVERAGE: "DYTEST_COVERAGE",
				C8_COVERAGE: "DYTEST_COVERAGE",
				GIT_CONFIG_GLOBAL: "DYTEST_CALLER_CONFIG",
				GIT_CONFIG_NOSYSTEM: "0",
				GIT_CONFIG_COUNT: "1",
				GIT_ASKPASS: "DYTEST_CALLER_PROMPT",
			};
			const before = { ...supplied };
			const child = inventoryEnvironment(supplied);
			const expected: NodeJS.ProcessEnv = {
				...os,
				UV_THREADPOOL_SIZE: "64",
				GIT_CONFIG_NOSYSTEM: "1",
				GIT_CONFIG_GLOBAL: process.platform === "win32" ? "NUL" : "/dev/null",
				GIT_OPTIONAL_LOCKS: "0",
				GIT_TERMINAL_PROMPT: "0",
				LC_ALL: "C",
			};
			// Boolean oracles never disclose an accidentally inherited environment value.
			expect(
				Object.keys(child).length === Object.keys(expected).length &&
					Object.entries(expected).every(([key, value]) => child[key] === value),
			).toBe(true);
			expect(
				Object.keys(supplied).length === Object.keys(before).length &&
					Object.entries(before).every(([key, value]) => supplied[key] === value),
			).toBe(true);
		}
	});

	it("waits for precheck and actual close, uses one fixed plain Node entry, and clears late timers", async () => {
		const h = harness(),
			precheck = Promise.withResolvers<void>();
		let settled = false;
		const result = runInventoryAfter(() => precheck.promise, h.runtime).finally(() => {
			settled = true;
		});
		void result.catch(() => {});
		try {
			await turn();
			expect(h.spawns()).toBe(0);
			h.clock.advance(10_000);
			precheck.resolve();
			await started(h, result);
			expect(h.nodeCommand()).toBe(true);
			expect(h.args()).toHaveLength(1);
			expect(h.args()[0]?.endsWith("worktree-inventory.ts")).toBe(true);
			h.child.stdout.data(complete.subarray(0, 8));
			h.child.stdout.data(complete.subarray(8));
			await turn();
			expect(settled).toBe(false);
			h.child.close(0);
			await expect(result).resolves.toBeUndefined();
			h.clock.advance(300_001);
			expect(h.child.stopCalls).toBe(0);
			expect(h.child.killCalls).toBe(0);
		} finally {
			precheck.resolve();
			h.child.close(1);
			h.clock.advance(600_000);
			await result.catch(() => {});
		}
	});

	it("counts precheck time in the original 300000 deadline and reserves only the final 250ms", async () => {
		const h = harness(),
			precheck = Promise.withResolvers<void>();
		const result = runInventoryAfter(() => precheck.promise, h.runtime);
		void result.catch(() => {});
		h.clock.advance(10_000);
		precheck.resolve();
		await started(h, result);
		h.clock.advance(299_749);
		expect(h.child.stopCalls).toBe(0);
		h.clock.advance(299_750);
		expect(h.child.stopCalls).toBeGreaterThan(0);
		h.clock.advance(300_000);
		expect(h.child.killCalls).toBeGreaterThan(0);
		await expect(result).rejects.toThrow("file-name inventory failed");
		expect(() => {
			h.child.stdout.data(complete);
			h.child.close(0);
		}).not.toThrow();
	});

	it.each(["resolve", "reject"] as const)(
		"never spawns after a hanging precheck settles late by %s",
		async (late) => {
			const h = harness(),
				precheck = Promise.withResolvers<void>();
			let settled = false,
				entered = false;
			const result = runInventoryAfter(() => {
				entered = true;
				return precheck.promise;
			}, h.runtime).finally(() => {
				settled = true;
			});
			void result.catch(() => {});
			try {
				await turn();
				expect(entered).toBe(true);
				h.clock.advance(300_000);
				await turn();
				expect(settled).toBe(true);
				await expect(result).rejects.toThrow("file-name inventory failed");
				if (late === "resolve") precheck.resolve();
				else precheck.reject(new Error("DYTEST late precheck failure"));
				await turn();
				expect(h.spawns()).toBe(0);
			} finally {
				precheck.resolve();
				await turn();
				h.child.close(1);
				h.clock.advance(600_000);
				await result.catch(() => {});
			}
		},
	);

	it("refuses a failed precheck without spawning a child", async () => {
		const h = harness();
		await expect(
			runInventoryAfter(async () => {
				throw new Error("DYTEST precheck failure");
			}, h.runtime),
		).rejects.toThrow("file-name inventory failed");
		expect(h.spawns()).toBe(0);
	});

	it.each(["empty", "partial", "duplicate", "extra"] as const)(
		"does not accept %s stdout with code zero",
		async (kind) => {
			const h = harness(),
				result = runInventoryAfter(async () => {}, h.runtime);
			void result.catch(() => {});
			await started(h, result);
			const bytes =
				kind === "empty"
					? Buffer.alloc(0)
					: kind === "partial"
						? complete.subarray(0, -1)
						: kind === "duplicate"
							? Buffer.concat([complete, complete])
							: Buffer.concat([complete, Buffer.from("extra")]);
			h.child.stdout.data(bytes);
			h.child.close(0);
			await expect(result).rejects.toThrow("file-name inventory failed");
		},
	);

	it.each([1, 17, null])("does not accept a sentinel with non-success close %s", async (code) => {
		const h = harness(),
			result = runInventoryAfter(async () => {}, h.runtime);
		void result.catch(() => {});
		await started(h, result);
		h.child.stdout.data(complete);
		h.child.close(code);
		await expect(result).rejects.toThrow("file-name inventory failed");
	});

	it.each(["stdout", "stderr"] as const)(
		"latches a %s cap failure immediately but waits for owned close",
		async (pipe) => {
			const h = harness();
			let settled = false;
			const result = runInventoryAfter(async () => {}, h.runtime).finally(() => {
				settled = true;
			});
			void result.catch(() => {});
			await started(h, result);
			h.child[pipe].data(Buffer.alloc(pipe === "stdout" ? 129 : 4097, 65));
			await turn();
			expect(h.child.stopCalls + h.child.killCalls).toBeGreaterThan(0);
			expect(settled).toBe(false);
			h.child.stdout.data(complete);
			h.child.close(0);
			await expect(result).rejects.toThrow("file-name inventory failed");
		},
	);

	it.each(["stdout", "stderr", "child"] as const)(
		"latches a %s error through a later valid-looking close",
		async (source) => {
			const h = harness();
			let settled = false;
			const result = runInventoryAfter(async () => {}, h.runtime).finally(() => {
				settled = true;
			});
			void result.catch(() => {});
			await started(h, result);
			if (source === "child") h.child.error();
			else h.child[source].error();
			await turn();
			expect(settled).toBe(false);
			h.child.stdout.data(complete);
			h.child.close(0);
			await expect(result).rejects.toThrow("file-name inventory failed");
		},
	);

	it("keeps a stop-send exception fixed and fatal", async () => {
		const h = harness(),
			result = runInventoryAfter(async () => {}, h.runtime);
		void result.catch(() => {});
		await started(h, result);
		h.child.failStop = true;
		expect(() => h.clock.advance(299_750)).not.toThrow();
		h.child.stdout.data(complete);
		h.child.close(0);
		await expect(result).rejects.toThrow("file-name inventory failed");
	});

	it("keeps an owned-kill exception and late zero close fatal without claiming drain", async () => {
		const h = harness(),
			result = runInventoryAfter(async () => {}, h.runtime);
		void result.catch(() => {});
		await started(h, result);
		h.child.failKill = true;
		expect(() => h.clock.advance(300_000)).not.toThrow();
		await expect(result).rejects.toThrow("file-name inventory failed");
		expect(h.child.closed).toBe(false);
		expect(() => {
			h.child.stdout.data(complete);
			h.child.close(0);
		}).not.toThrow();
	});

	it("checks the deadline again at close even before a due timer callback runs", async () => {
		const h = harness(),
			result = runInventoryAfter(async () => {}, h.runtime);
		void result.catch(() => {});
		await started(h, result);
		h.child.stdout.data(complete);
		h.clock.now = 300_000;
		h.child.close(0);
		await expect(result).rejects.toThrow("file-name inventory failed");
	});
});
