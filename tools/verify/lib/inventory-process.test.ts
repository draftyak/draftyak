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

// Separate originals for every precheck and inventory invocation. No actual process is spawned.
type PrecheckGit = Parameters<Parameters<typeof runInventoryAfter>[0]>[0];
interface SpawnFact {
	readonly command: string;
	readonly args: readonly string[];
	readonly ipc: boolean | undefined;
	readonly inheritedEnvironment: boolean;
}
const ignoredCheck = ["check-ignore", "--quiet", "--", "DYTEST_IGNORED"] as const;
const ordinaryCheck = ["check-ignore", "--quiet", "--", "DYTEST_ORDINARY"] as const;
function precheckHarness() {
	const clock = new Clock();
	const children: Child[] = [];
	const commands: SpawnFact[] = [];
	const runtime: InventoryProcessRuntime = {
		now: () => clock.now,
		setTimer: (callback, delay) => clock.set(callback, delay),
		clearTimer: (token) => clock.clear(token),
		spawn: (options) => {
			const child = new Child();
			children.push(child);
			commands.push({
				command: options.command,
				args: [...options.args],
				ipc: options.ipc,
				inheritedEnvironment: options.env === process.env,
			});
			return child;
		},
	};
	return { clock, children, commands, runtime };
}
function outcome(promise: Promise<unknown>): () => "pending" | "passed" | "refused" {
	let state: "pending" | "passed" | "refused" = "pending";
	void promise.then(
		() => {
			state = "passed";
		},
		() => {
			state = "refused";
		},
	);
	return () => state;
}
function originalChild(h: ReturnType<typeof precheckHarness>, index: number): Child {
	expect(h.children.length > index).toBe(true);
	const child = h.children[index];
	if (!child) throw new Error("DYTEST original child unavailable");
	return child;
}
async function retireSynthetic(h: ReturnType<typeof precheckHarness>): Promise<void> {
	// Every wait is a single event-loop turn; a broken implementation cannot hang a new case.
	h.clock.advance(600_000);
	for (const child of h.children) child.close(1);
	await turn();
	for (const child of h.children) child.close(1);
	await turn();
}
async function originalChecks(git: PrecheckGit): Promise<void> {
	const ignored = await git(...ignoredCheck);
	expect(ignored.code).toBe(0);
	const ordinary = await git(...ordinaryCheck);
	expect(ordinary.code).toBe(1);
}

describe("original deadline-owned inventory prechecks", () => {
	it.each([
		[0, 1],
		[1, 0],
	] as const)(
		"needs both actual Git closes for codes %s/%s before the plain Node phase",
		async (firstCode, secondCode) => {
			const h = precheckHarness();
			let seenFirst: number | undefined, seenSecond: number | undefined;
			const state = outcome(
				runInventoryAfter(async (git) => {
					seenFirst = (await git(...ignoredCheck)).code;
					seenSecond = (await git(...ordinaryCheck)).code;
				}, h.runtime),
			);
			try {
				await turn();
				expect(h.commands).toHaveLength(1);
				expect(h.commands[0]?.command).toBe("git");
				expect(h.commands[0]?.args).toEqual(ignoredCheck);
				expect(h.commands[0]?.ipc).toBe(false);
				expect(h.commands[0]?.inheritedEnvironment).toBe(true);
				expect(seenFirst).toBeUndefined();
				expect(state()).toBe("pending");
				originalChild(h, 0).close(firstCode);
				await turn();
				expect(seenFirst).toBe(firstCode);
				expect(h.commands).toHaveLength(2);
				expect(h.commands[1]?.command).toBe("git");
				expect(h.commands[1]?.args).toEqual(ordinaryCheck);
				expect(h.commands[1]?.ipc).toBe(false);
				expect(h.commands[1]?.inheritedEnvironment).toBe(true);
				expect(seenSecond).toBeUndefined();
				originalChild(h, 1).close(secondCode);
				await turn();
				expect(seenSecond).toBe(secondCode);
				expect(h.commands).toHaveLength(3);
				expect(new Set(h.children).size).toBe(3);
				expect(h.commands[2]?.command).toBe(process.execPath);
				expect(h.commands[2]?.args).toHaveLength(1);
				expect(h.commands[2]?.args[0]?.endsWith("worktree-inventory.ts")).toBe(true);
				expect(h.commands[2]?.ipc).not.toBe(false);
				const inventory = originalChild(h, 2);
				inventory.stdout.data(complete);
				await turn();
				expect(state()).toBe("pending");
				inventory.close(0);
				await turn();
				expect(state()).toBe("passed");
				h.clock.advance(600_000);
				expect(h.children.every((child) => child.stopCalls === 0 && child.killCalls === 0)).toBe(
					true,
				);
			} finally {
				await retireSynthetic(h);
			}
		},
	);

	it.each([0, 1] as const)(
		"stops and kills only original active Git %s under the shared deadline",
		async (index) => {
			const h = precheckHarness();
			const state = outcome(runInventoryAfter(originalChecks, h.runtime));
			try {
				await turn();
				if (index === 1) {
					originalChild(h, 0).close(0);
					await turn();
				}
				const active = originalChild(h, index);
				expect(h.commands).toHaveLength(index + 1);
				h.clock.advance(299_749);
				expect(active.stopCalls + active.killCalls).toBe(0);
				h.clock.advance(299_750);
				expect(active.stopCalls).toBeGreaterThan(0);
				expect(active.closed).toBe(false);
				expect(state()).toBe("pending");
				h.clock.advance(300_000);
				await turn();
				expect(active.killCalls).toBeGreaterThan(0);
				expect(active.closed).toBe(false);
				expect(state()).toBe("refused");
				if (index === 1) {
					expect(originalChild(h, 0).stopCalls + originalChild(h, 0).killCalls).toBe(0);
				}
				expect(active.closes.length > 0 && active.errors.length > 0).toBe(true);
				expect(() => {
					active.stdout.data(Buffer.from("late"));
					active.error();
					active.close(index === 0 ? 0 : 1);
				}).not.toThrow();
				await turn();
				expect(state()).toBe("refused");
				expect(h.commands).toHaveLength(index + 1);
			} finally {
				await retireSynthetic(h);
			}
		},
	);

	it("does not launch a next phase after a Git zero close during the stop reserve", async () => {
		const h = precheckHarness();
		const state = outcome(runInventoryAfter(originalChecks, h.runtime));
		try {
			await turn();
			h.clock.advance(299_750);
			originalChild(h, 0).close(0);
			await turn();
			expect(state()).toBe("refused");
			expect(h.commands).toHaveLength(1);
		} finally {
			await retireSynthetic(h);
		}
	});

	it("accepts the existing exact Git stdout/stderr ceilings without exposing their contents", async () => {
		const h = precheckHarness();
		const state = outcome(runInventoryAfter(originalChecks, h.runtime));
		try {
			await turn();
			const first = originalChild(h, 0);
			first.stdout.data(Buffer.alloc(128, 65));
			first.stderr.data(Buffer.alloc(4096, 66));
			first.close(0);
			await turn();
			originalChild(h, 1).close(1);
			await turn();
			const inventory = originalChild(h, 2);
			inventory.stdout.data(complete);
			inventory.close(0);
			await turn();
			expect(state()).toBe("passed");
		} finally {
			await retireSynthetic(h);
		}
	});

	it.each([
		"stdout-cap",
		"stderr-cap",
		"stdout-type",
		"stderr-type",
		"stdout-error",
		"stderr-error",
		"child-error",
	] as const)(
		"latches original Git %s until actual close and never enters another phase",
		async (fault) => {
			const h = precheckHarness();
			const state = outcome(runInventoryAfter(originalChecks, h.runtime));
			try {
				await turn();
				const first = originalChild(h, 0);
				if (fault === "stdout-cap") {
					first.stdout.data(Buffer.alloc(64, 65));
					first.stdout.data(Buffer.alloc(65, 65));
				} else if (fault === "stderr-cap") {
					first.stderr.data(Buffer.alloc(2048, 65));
					first.stderr.data(Buffer.alloc(2049, 65));
				} else if (fault === "stdout-type" || fault === "stderr-type") {
					first[fault === "stdout-type" ? "stdout" : "stderr"].data(
						new Uint8Array(1) as unknown as Buffer,
					);
				} else if (fault === "child-error") first.error();
				else first[fault === "stdout-error" ? "stdout" : "stderr"].error();
				await turn();
				expect(first.stopCalls + first.killCalls).toBeGreaterThan(0);
				expect(first.closed).toBe(false);
				expect(state()).toBe("pending");
				expect(h.commands).toHaveLength(1);
				first.close(0);
				await turn();
				expect(state()).toBe("refused");
				expect(h.commands).toHaveLength(1);
			} finally {
				await retireSynthetic(h);
			}
		},
	);

	it.each([null, Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY])(
		"refuses original Git close %s instead of inventing a return code",
		async (code) => {
			const h = precheckHarness();
			const state = outcome(
				runInventoryAfter(async (git) => {
					await git(...ignoredCheck);
				}, h.runtime),
			);
			try {
				await turn();
				originalChild(h, 0).close(code);
				await turn();
				expect(state()).toBe("refused");
				expect(h.commands).toHaveLength(1);
			} finally {
				await retireSynthetic(h);
			}
		},
	);

	it("preserves the owning precheck's exit-code assertions rather than blessing any Git close", async () => {
		const h = precheckHarness();
		const state = outcome(
			runInventoryAfter(async (git) => {
				const checked = await git(...ordinaryCheck);
				expect(checked.code).toBe(1);
			}, h.runtime),
		);
		try {
			await turn();
			originalChild(h, 0).close(2);
			await turn();
			expect(state()).toBe("refused");
			expect(h.commands).toHaveLength(1);
		} finally {
			await retireSynthetic(h);
		}
	});

	it("refuses a captured precheck callback that tries to start Git after the hard deadline", async () => {
		const h = precheckHarness(),
			released = Promise.withResolvers<void>();
		const state = outcome(
			runInventoryAfter(async (git) => {
				await released.promise;
				await git(...ignoredCheck);
			}, h.runtime),
		);
		try {
			await turn();
			h.clock.advance(300_000);
			await turn();
			expect(state()).toBe("refused");
			released.resolve();
			await turn();
			expect(h.commands).toHaveLength(0);
		} finally {
			released.resolve();
			await retireSynthetic(h);
		}
	});

	it.each(["inventory", "completed"] as const)(
		"rejects a retained Git function during %s without spawning",
		async (phase) => {
			const h = precheckHarness();
			let retained: PrecheckGit | undefined;
			const state = outcome(
				runInventoryAfter(async (git) => {
					retained = git;
				}, h.runtime),
			);
			try {
				await turn();
				const inventory = originalChild(h, 0);
				expect(h.commands[0]?.command).toBe(process.execPath);
				if (phase === "completed") {
					inventory.stdout.data(complete);
					inventory.close(0);
					await turn();
					expect(state()).toBe("passed");
				}
				expect(typeof retained).toBe("function");
				if (!retained) throw new Error("DYTEST retained function unavailable");
				const late = outcome(retained(...ignoredCheck));
				await turn();
				expect(late()).toBe("refused");
				expect(h.commands).toHaveLength(1);
			} finally {
				await retireSynthetic(h);
			}
		},
	);

	it.each(["close", "deadline"] as const)(
		"retains the original Git after precheck throws until %s",
		async (finish) => {
			const h = precheckHarness();
			const state = outcome(
				runInventoryAfter(async (git) => {
					void git(...ignoredCheck).catch(() => {});
					throw new Error("DYTEST precheck failure with original child");
				}, h.runtime),
			);
			try {
				await turn();
				const first = originalChild(h, 0);
				expect(first.stopCalls + first.killCalls).toBeGreaterThan(0);
				expect(first.closed).toBe(false);
				expect(state()).toBe("pending");
				if (finish === "close") first.close(0);
				else h.clock.advance(300_000);
				await turn();
				expect(state()).toBe("refused");
				if (finish === "deadline") {
					expect(first.closed).toBe(false);
					expect(first.killCalls).toBeGreaterThan(0);
				}
				expect(h.commands).toHaveLength(1);
			} finally {
				await retireSynthetic(h);
			}
		},
	);
	it("keeps an unawaited issued Git owned after precheck returns instead of starting Node", async () => {
		const h = precheckHarness();
		const state = outcome(
			runInventoryAfter(async (git) => {
				void git(...ignoredCheck).catch(() => {});
			}, h.runtime),
		);
		try {
			await turn();
			const first = originalChild(h, 0);
			expect(h.commands).toHaveLength(1);
			expect(h.commands[0]?.command).toBe("git");
			expect(first.stopCalls + first.killCalls).toBeGreaterThan(0);
			expect(first.closed).toBe(false);
			expect(state()).toBe("pending");
			first.close(0);
			await turn();
			expect(state()).toBe("refused");
			expect(h.commands).toHaveLength(1);
		} finally {
			await retireSynthetic(h);
		}
	});
});

describe("initial precheck callback admission", () => {
	it("does not invoke precheck after the original deadline expires before its first microtask", async () => {
		const h = precheckHarness();
		let entered = false;
		const result = runInventoryAfter(async (git) => {
			entered = true;
			await git(...ignoredCheck);
		}, h.runtime);
		void result.catch(() => {});
		const state = outcome(result);
		try {
			// No event-loop turn occurs before the original deadline is consumed.
			h.clock.advance(300_000);
			await turn();
			expect(entered).toBe(false);
			expect(h.commands).toHaveLength(0);
			expect(state()).toBe("refused");
			expect(h.clock.timers.size).toBe(0);
		} finally {
			await retireSynthetic(h);
		}
	});
});
