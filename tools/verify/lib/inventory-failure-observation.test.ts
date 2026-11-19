import { describe, expect, it } from "vitest";
import {
	type InventoryChild,
	type InventoryExecution,
	type InventoryPipe,
	type InventoryProcessRuntime,
	joinInventoryExecution,
	observeInventoryFailure,
	startInventoryAfter,
} from "./inventory-process.ts";

const turn = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));
const unknownWorker =
	"workerPhase=-1,workerRoots=-1,workerPendingGit=-1,workerPendingFs=-1," +
	"workerDirectories=-1,workerEntries=-1,workerElapsedMs=-1";
const pendingFailure = (elapsedMs: number): string =>
	"file-name inventory failed [phase=precheck,cleanup=pending,pending=1,gitOwned=1," +
	"gitClosed=0,workerOwned=0,workerClosed=0,stopRequests=1,killRequests=1," +
	`elapsedMs=${elapsedMs},${unknownWorker}]`;
const emptyFailure = (elapsedMs: number): string =>
	"file-name inventory failed [phase=precheck,cleanup=none,pending=0,gitOwned=0," +
	"gitClosed=0,workerOwned=0,workerClosed=0,stopRequests=0,killRequests=0," +
	`elapsedMs=${elapsedMs},${unknownWorker}]`;

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
}

class Child implements InventoryChild {
	readonly stdout = new Pipe();
	readonly stderr = new Pipe();
	readonly errors: ((error: unknown) => void)[] = [];
	readonly closes: ((code: number | null) => void)[] = [];
	stopCalls = 0;
	killCalls = 0;
	closed = false;
	onError(listener: (error: unknown) => void): void {
		this.errors.push(listener);
	}
	onClose(listener: (code: number | null) => void): void {
		this.closes.push(listener);
	}
	stop(): void {
		this.stopCalls++;
	}
	kill(): void {
		this.killCalls++;
	}
	error(reason: unknown): void {
		for (const listener of this.errors) listener(reason);
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
			if (next === undefined) break;
			this.now = next[1].at;
			this.timers.delete(next[0]);
			next[1].callback();
		}
		this.now = to;
	}
}

function harness() {
	const clock = new Clock();
	const children: Child[] = [];
	const runtime: InventoryProcessRuntime = {
		now: () => clock.now,
		setTimer: (callback, delay) => clock.set(callback, delay),
		clearTimer: (timer) => clock.clear(timer),
		spawn: () => {
			const child = new Child();
			children.push(child);
			return child;
		},
	};
	return { clock, children, runtime };
}

function original(h: ReturnType<typeof harness>): Child {
	const child = h.children[0];
	if (child === undefined) throw new Error("DYTEST original child was not created");
	return child;
}

function state(promise: Promise<unknown>): () => string {
	let result = "pending";
	void promise.then(
		() => {
			result = "passed";
		},
		() => {
			result = "refused";
		},
	);
	return () => result;
}

async function retire(
	h: ReturnType<typeof harness>,
	execution: InventoryExecution,
	joined: Promise<void>,
): Promise<void> {
	h.clock.advance(Math.max(h.clock.now, 300_001));
	for (const child of h.children) child.close(null);
	await turn();
	await Promise.allSettled([execution.reported, execution.closed, execution.prechecked, joined]);
}

describe("passive inventory failure observation", () => {
	it.each(["recording", "throwing"] as const)(
		"reports at 299875 while the original child and precheck remain pending with a %s observer",
		async (mode) => {
			const h = harness();
			const execution = startInventoryAfter(async (git) => {
				await git("status", "--porcelain");
			}, h.runtime);
			const reported = execution.reported;
			const notices: { at: number; diagnostic: string }[] = [];
			const timersBefore = h.clock.timers.size;
			expect(
				observeInventoryFailure(execution, (diagnostic) => {
					notices.push({ at: h.clock.now, diagnostic });
					if (mode === "throwing") throw new Error("DYTEST observer unavailable");
				}),
			).toBeUndefined();
			expect(h.clock.timers.size).toBe(timersBefore);
			const joined = joinInventoryExecution(execution);
			const reportState = state(reported),
				closeState = state(execution.closed),
				precheckState = state(execution.prechecked),
				joinState = state(joined);
			try {
				await turn();
				const child = original(h);
				expect(execution.deadline).toBe(300_000);
				h.clock.advance(299_874);
				await turn();
				expect(notices).toEqual([]);
				h.clock.advance(299_875);
				await turn();
				expect(notices).toEqual([{ at: 299_875, diagnostic: pendingFailure(299_875) }]);
				expect([reportState(), closeState(), precheckState(), joinState()]).toEqual([
					"refused",
					"pending",
					"pending",
					"pending",
				]);
				expect([child.stopCalls, child.killCalls, child.closed]).toEqual([1, 1, false]);
				expect(execution.reported === reported).toBe(true);
				await expect(reported).rejects.toThrow(pendingFailure(299_875));
				h.clock.advance(299_999);
				await turn();
				expect(joinState()).toBe("pending");
				h.clock.advance(300_000);
				await turn();
				expect([joinState(), closeState(), precheckState(), child.closed]).toEqual([
					"refused",
					"pending",
					"pending",
					false,
				]);
				await expect(joined).rejects.toThrow(pendingFailure(300_000));
				expect(joinInventoryExecution(execution) === joined).toBe(true);
				h.clock.advance(450_000);
				child.close(0);
				await turn();
				expect(await execution.closed).toEqual({ kind: "closed", originals: 1, closedAt: 450_000 });
				expect(await execution.prechecked).toBe("settled");
				expect(joinState()).toBe("refused");
				expect(notices).toEqual([{ at: 299_875, diagnostic: pendingFailure(299_875) }]);
				expect(h.children).toHaveLength(1);
				expect(h.clock.timers.size).toBe(0);
			} finally {
				await retire(h, execution, joined);
			}
		},
	);

	it("does not notify or change successful reporting and physical completion", async () => {
		const h = harness();
		const execution = startInventoryAfter(async () => {}, h.runtime);
		const notices: string[] = [];
		observeInventoryFailure(execution, (diagnostic) => notices.push(diagnostic));
		const joined = joinInventoryExecution(execution);
		try {
			await turn();
			h.clock.advance(25);
			original(h).stdout.data(Buffer.from("WORKTREE_INVENTORY_COMPLETE\n"));
			original(h).close(0);
			await joined;
			await expect(execution.reported).resolves.toBeUndefined();
			expect(await execution.closed).toEqual({ kind: "closed", originals: 1, closedAt: 25 });
			expect(await execution.prechecked).toBe("settled");
			h.clock.advance(600_000);
			await turn();
			expect(notices).toEqual([]);
			expect([original(h).stopCalls, original(h).killCalls, h.clock.timers.size]).toEqual([
				0, 0, 0,
			]);
		} finally {
			await retire(h, execution, joined);
		}
	});

	it("reports only validated numeric worker diagnostics and ignores a child error's private fields", async () => {
		const h = harness();
		let privateReads = 0;
		const reason = Object.defineProperty({}, "privateMarker", {
			get: () => {
				privateReads++;
				throw new Error("DYTEST private child marker must stay unread");
			},
		});
		const execution = startInventoryAfter(async () => {}, h.runtime);
		const notices: string[] = [];
		observeInventoryFailure(execution, (diagnostic) => notices.push(diagnostic));
		const joined = joinInventoryExecution(execution);
		void execution.reported.catch(() => {});
		void joined.catch(() => {});
		try {
			await turn();
			h.clock.advance(42);
			original(h).stderr.data(Buffer.from("I1 0 3 17 2 4 11 99 42\n"));
			original(h).error(reason);
			h.clock.advance(50);
			original(h).close(1);
			await turn();
			expect(notices).toEqual([
				"file-name inventory failed [phase=worker,cleanup=closed,pending=0,gitOwned=0," +
					"gitClosed=0,workerOwned=1,workerClosed=1,stopRequests=1,killRequests=0," +
					"elapsedMs=50,workerPhase=3,workerRoots=17,workerPendingGit=2,workerPendingFs=4," +
					"workerDirectories=11,workerEntries=99,workerElapsedMs=42]",
			]);
			expect(privateReads).toBe(0);
			await expect(joined).rejects.toThrow("file-name inventory failed");
			expect(await execution.closed).toEqual({ kind: "closed", originals: 1, closedAt: 50 });
		} finally {
			await retire(h, execution, joined);
		}
	});

	it("does not inspect the genuine rejected Error or replace the original join outcome", async () => {
		const h = harness();
		const execution = startInventoryAfter(async () => {
			throw new Error("DYTEST precheck refusal");
		}, h.runtime);
		let originalReason: unknown;
		let joinedReason: unknown;
		let privateReads = 0;
		const unread = (): never => {
			privateReads++;
			throw new Error("DYTEST private rejection field must stay unread");
		};
		// Poison the actual rejection before the observer's reaction, without forging an execution.
		void execution.reported.catch((reason: unknown) => {
			originalReason = reason;
			Object.defineProperties(reason as object, {
				stack: { get: unread, configurable: true },
				message: { get: unread, configurable: true },
				privateMarker: { get: unread, configurable: true },
			});
		});
		const notices: string[] = [];
		observeInventoryFailure(execution, (diagnostic) => notices.push(diagnostic));
		const joined = joinInventoryExecution(execution);
		void joined.catch((reason: unknown) => {
			joinedReason = reason;
		});
		try {
			await turn();
			expect(notices).toEqual([emptyFailure(0)]);
			expect(privateReads).toBe(0);
			// Never pass the poisoned Error to an assertion formatter or Error matcher.
			expect(originalReason !== undefined && joinedReason === originalReason).toBe(true);
			expect(await execution.closed).toEqual({ kind: "no-child", originals: 0, closedAt: null });
			expect(await execution.prechecked).toBe("settled");
			expect(h.children).toHaveLength(0);
			expect(h.clock.timers.size).toBe(0);
		} finally {
			await retire(h, execution, joined);
		}
	});

	it("observes the registered fallback when the initial clock fails without reading that error", async () => {
		const h = harness();
		let privateReads = 0;
		const reason = Object.defineProperty({}, "message", {
			get: () => {
				privateReads++;
				throw new Error("DYTEST private clock error must stay unread");
			},
		});
		const execution = startInventoryAfter(async () => {}, {
			...h.runtime,
			now: () => {
				throw reason;
			},
		});
		const notices: string[] = [];
		observeInventoryFailure(execution, (diagnostic) => notices.push(diagnostic));
		const joined = joinInventoryExecution(execution);
		void joined.catch(() => {});
		try {
			await turn();
			expect(notices).toEqual([emptyFailure(-1)]);
			expect(privateReads).toBe(0);
			expect(Number.isNaN(execution.deadline)).toBe(true);
			await expect(joined).rejects.toThrow(emptyFailure(-1));
			expect(await execution.closed).toEqual({ kind: "no-child", originals: 0, closedAt: null });
			expect(await execution.prechecked).toBe("not-started");
			expect([h.children.length, h.clock.timers.size]).toEqual([0, 0]);
		} finally {
			await retire(h, execution, joined);
		}
	});

	it("refuses forged executions before reading properties or notifying an observer", () => {
		let privateReads = 0;
		let notices = 0;
		const unread = (): never => {
			privateReads++;
			throw new Error("DYTEST forged execution property must stay unread");
		};
		const forged = Object.defineProperties(Object.create(null), {
			reported: { get: unread },
			closed: { get: unread },
			prechecked: { get: unread },
			deadline: { get: unread },
			privateMarker: { get: unread },
		});
		const proxy = new Proxy(forged, { get: unread, getPrototypeOf: unread, ownKeys: unread });
		const revoked = Proxy.revocable(forged, {});
		revoked.revoke();
		for (const candidate of [forged, proxy, revoked.proxy]) {
			expect(() =>
				observeInventoryFailure(candidate as InventoryExecution, () => {
					notices++;
				}),
			).toThrow(/^file-name inventory failed$/);
		}
		expect([privateReads, notices]).toEqual([0, 0]);
	});
});
