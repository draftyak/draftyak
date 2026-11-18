import { setImmediate as yieldEventLoop } from "node:timers/promises";
import type { ApiClient } from "@draftyak/client";
import { Account } from "@draftyak/protocol/entities/account";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createAccountsController } from "../../src/inbox/accounts-controller.ts";

type Page = Awaited<ReturnType<ApiClient["pageAccounts"]>>;
type RecordRow = Page["accounts"][number];
type Controller = ReturnType<typeof createAccountsController>;
type Snapshot = ReturnType<Controller["getSnapshot"]>;
type Ready = Extract<Snapshot, { status: "ready" }>;
type Failed = Extract<Snapshot, { status: "error" }>;

const id = (value: number): string => String(value).padStart(26, "0");
const CURSOR = id(900);
function record(value: number, generation = 1): RecordRow {
	const account = Account.parse({
		channel: "email",
		id: id(value),
		userId: id(800),
		alias: `mailbox-${value}`,
		mode: "full",
		status: "active",
		deletionDeadline: null,
		historyLimitDays: 30,
		disclosureVersion: 1,
		createdAt: 0,
		pluginInstanceId: id(801),
		address: `mailbox${value}@example.test`,
	});
	if (
		account.channel !== "email" ||
		account.status !== "active" ||
		account.deletionDeadline !== null
	)
		throw new Error("Expected active synthetic email account");
	return {
		account: { ...account, status: account.status, deletionDeadline: account.deletionDeadline },
		generation,
	};
}
function page(accounts: RecordRow[] = [], nextId: string | null = null): Page {
	return { accounts, nextId };
}
function deferred<T>() {
	let resolveValue: ((value: T) => void) | undefined;
	let rejectValue: ((reason: unknown) => void) | undefined;
	const promise = new Promise<T>((resolve, reject) => {
		resolveValue = resolve;
		rejectValue = reject;
	});
	let settled = false;
	return {
		promise,
		get settled() {
			return settled;
		},
		resolve(value: T): void {
			if (resolveValue === undefined) throw new Error("Missing promise resolver");
			settled = true;
			resolveValue(value);
		},
		reject(reason: unknown): void {
			if (rejectValue === undefined) throw new Error("Missing promise rejecter");
			settled = true;
			rejectValue(reason);
		},
	};
}
function harness() {
	const requests: Array<
		ReturnType<typeof deferred<Page>> & {
			afterId: string | null;
			signal: AbortSignal | undefined;
		}
	> = [];
	let callHook: (() => void) | undefined;
	const pageAccounts = vi.fn<ApiClient["pageAccounts"]>((afterId = null, options) => {
		callHook?.();
		const pending = deferred<Page>();
		const request = {
			promise: pending.promise,
			resolve: pending.resolve,
			reject: pending.reject,
			get settled() {
				return pending.settled;
			},
			afterId,
			signal: options?.signal,
		};
		requests.push(request);
		return request.promise;
	});
	const controller = createAccountsController({ pageAccounts });
	const value = {
		controller,
		pageAccounts,
		requests,
		setCallHook(hook: () => void): void {
			callHook = hook;
		},
	};
	fixtures.push(value);
	return value;
}
type Harness = ReturnType<typeof harness>;
const fixtures: {
	readonly controller: Controller;
	readonly requests: readonly ReturnType<typeof deferred<Page>>[];
}[] = [];
function request(h: Harness, index = h.requests.length - 1) {
	const result = h.requests[index];
	if (result === undefined) throw new Error("Missing actual client request");
	return result;
}
function ready(h: Harness): Ready {
	const snapshot = h.controller.getSnapshot();
	expect(snapshot.status).toBe("ready");
	if (snapshot.status !== "ready") throw new Error("Expected ready snapshot");
	return snapshot;
}
function failed(h: Harness): Failed {
	const snapshot = h.controller.getSnapshot();
	expect(snapshot.status).toBe("error");
	if (snapshot.status !== "error") throw new Error("Expected failed snapshot");
	return snapshot;
}
function waitForStatus(h: Harness, status: Snapshot["status"]): Promise<void> {
	if (h.controller.getSnapshot().status === status) return Promise.resolve();
	return new Promise<void>((resolve) => {
		const unsubscribe = h.controller.subscribe(() => {
			if (h.controller.getSnapshot().status === status) {
				unsubscribe();
				resolve();
			}
		});
	});
}
async function complete(h: Harness, value: Page, index = h.requests.length - 1): Promise<Ready> {
	const published = waitForStatus(h, "ready");
	request(h, index).resolve(value);
	await published;
	return ready(h);
}
async function reject(h: Harness, value: unknown, index = h.requests.length - 1): Promise<Failed> {
	const published = waitForStatus(h, "error");
	request(h, index).reject(value);
	await published;
	return failed(h);
}
function signalOf(h: Harness): AbortSignal {
	const signal = request(h).signal;
	expect(signal).toBeInstanceOf(AbortSignal);
	if (signal === undefined) throw new Error("Missing original request signal");
	return signal;
}
function noReadyData(snapshot: Snapshot): void {
	for (const key of ["accounts", "nextId", "canPrevious", "canNext", "historyLimit"]) {
		expect(Object.hasOwn(snapshot, key)).toBe(false);
	}
}
afterEach(async () => {
	for (const h of fixtures.splice(0)) {
		const closing = h.controller.close();
		for (const pending of h.requests) if (!pending.settled) pending.resolve(page());
		await closing;
	}
});

describe("account directory controller", () => {
	it("constructs and subscribes without IO, with stable reads and controller commands", () => {
		const h = harness();
		const initial = h.controller.getSnapshot();
		const notify = vi.fn();
		const unsubscribe = h.controller.subscribe(notify);
		expect(initial.status).toBe("idle");
		expect(initial.afterId).toBeNull();
		expect(h.controller.getSnapshot()).toBe(initial);
		expect(h.pageAccounts).not.toHaveBeenCalled();
		const commands = [h.controller.getSnapshot, h.controller.subscribe, h.controller.close];
		unsubscribe();
		initial.loadFirst();
		expect(h.pageAccounts).toHaveBeenCalledTimes(1);
		expect(notify).not.toHaveBeenCalled();
		expect([h.controller.getSnapshot, h.controller.subscribe, h.controller.close]).toEqual(
			commands,
		);
	});

	it("preserves all 100 canonical rows and generations in a deeply frozen actual page", async () => {
		const h = harness();
		h.controller.getSnapshot().loadFirst();
		expect(request(h).afterId).toBeNull();
		expect(signalOf(h).aborted).toBe(false);
		const rows = Array.from({ length: 100 }, (_, index) =>
			record(index + 1, index === 99 ? Number.MAX_SAFE_INTEGER : index + 1),
		);
		const originalAccountFrozen = rows.map((row) => Object.isFrozen(row.account));
		const snapshot = await complete(h, page(rows, CURSOR));
		expect(snapshot.accounts).toEqual(rows);
		expect(snapshot.accounts).toHaveLength(100);
		expect(snapshot.accounts[0]?.generation).toBe(1);
		expect(snapshot.accounts[99]?.generation).toBe(Number.MAX_SAFE_INTEGER);
		expect(snapshot.nextId).toBe(CURSOR);
		expect(snapshot.canNext).toBe(true);
		expect(snapshot.canPrevious).toBe(false);
		expect(snapshot.historyLimit).toBe(false);
		expect(Object.isFrozen(snapshot.accounts)).toBe(true);
		expect(snapshot.accounts).not.toBe(rows);
		expect(Object.isFrozen(rows)).toBe(false);
		for (const [index, row] of snapshot.accounts.entries()) {
			const original = rows[index];
			if (original === undefined) throw new Error("Missing client-owned row");
			expect(row).not.toBe(original);
			expect(row.account).not.toBe(original.account);
			expect(Object.isFrozen(original)).toBe(false);
			expect(Object.isFrozen(original.account)).toBe(originalAccountFrozen[index]);
			expect(Object.isFrozen(row)).toBe(true);
			expect(Object.isFrozen(row.account)).toBe(true);
		}
		expect(h.controller.getSnapshot()).toBe(snapshot);
	});

	it("reaches row 101 using the returned non-last cursor, and previous reissues the original cursor", async () => {
		const h = harness();
		h.controller.getSnapshot().loadFirst();
		const first = await complete(
			h,
			page(
				Array.from({ length: 100 }, (_, index) => record(index + 1)),
				CURSOR,
			),
		);
		expect(first.accounts[99]?.account.id).not.toBe(CURSOR);
		first.loadNext();
		expect(request(h).afterId).toBe(CURSOR);
		const second = await complete(h, page([record(101, 17)]));
		expect(second.accounts.map((row) => row.account.id)).toEqual([id(101)]);
		expect(second.afterId).toBe(CURSOR);
		expect(second.canNext).toBe(false);
		expect(second.canPrevious).toBe(true);
		second.loadPrevious();
		expect(request(h).afterId).toBeNull();
		const back = await complete(h, page([record(3, 9)], id(700)));
		expect(back.afterId).toBeNull();
		expect(back.accounts).toEqual([record(3, 9)]);
		expect(back.canPrevious).toBe(false);
	});

	it("follows repeated cursors and an empty page with a next cursor without inventing order or an end", async () => {
		const h = harness();
		h.controller.getSnapshot().loadFirst();
		const first = await complete(h, page([record(9)], CURSOR));
		first.loadNext();
		const empty = await complete(h, page([], CURSOR));
		expect(empty.accounts).toEqual([]);
		expect(empty.nextId).toBe(CURSOR);
		expect(empty.canNext).toBe(true);
		empty.loadNext();
		expect(h.requests.map((entry) => entry.afterId)).toEqual([null, CURSOR, CURSOR]);
		const repeated = await complete(h, page([record(2)], null));
		expect(repeated.accounts[0]?.account.id).toBe(id(2));
		expect(repeated.canPrevious).toBe(true);
	});

	it("does not request nonexistent previous or next pages", async () => {
		const h = harness();
		const idle = h.controller.getSnapshot();
		idle.loadNext();
		idle.loadPrevious();
		idle.retry();
		expect(h.pageAccounts).not.toHaveBeenCalled();
		idle.loadFirst();
		const snapshot = await complete(h, page());
		snapshot.loadPrevious();
		snapshot.loadNext();
		snapshot.retry();
		expect(h.pageAccounts).toHaveBeenCalledTimes(1);
		expect(h.controller.getSnapshot()).toBe(snapshot);
	});

	it("owns one request and exposes neither optimistic rows nor usable busy actions", async () => {
		const h = harness();
		h.controller.getSnapshot().loadFirst();
		const first = await complete(h, page([record(1)], CURSOR));
		first.loadNext();
		const loading = h.controller.getSnapshot();
		expect(loading.status).toBe("loading");
		expect(loading.afterId).toBe(CURSOR);
		noReadyData(loading);
		loading.loadFirst();
		loading.loadNext();
		loading.loadPrevious();
		loading.retry();
		first.loadNext();
		expect(h.pageAccounts).toHaveBeenCalledTimes(2);
		const next = await complete(h, page([record(2)], null));
		expect(next.accounts).toEqual([record(2)]);
	});

	it.each([
		["Error", (): unknown => new Error("SECRET_ACCOUNT_FAILURE_CANARY")],
		["text", (): unknown => "<img src=x onerror=SECRET_ACCOUNT_FAILURE_CANARY>"],
		[
			"hostile coercion",
			(): unknown => ({
				toString() {
					throw new Error("SECRET_ACCOUNT_FAILURE_CANARY");
				},
			}),
		],
	] as const)(
		"uses a fixed retryable failure for %s without publishing the reason",
		async (_label, reason) => {
			const h = harness();
			h.controller.getSnapshot().loadFirst();
			await complete(h, page([record(1)], CURSOR));
			h.controller.getSnapshot().loadNext();
			const snapshot = await reject(h, reason());
			expect(snapshot.error).toBe("Accounts unavailable");
			expect(snapshot.afterId).toBe(CURSOR);
			noReadyData(snapshot);
			expect(JSON.stringify(snapshot)).not.toContain("SECRET_ACCOUNT_FAILURE_CANARY");
			snapshot.loadFirst();
			snapshot.loadNext();
			snapshot.loadPrevious();
			expect(h.pageAccounts).toHaveBeenCalledTimes(2);
		},
	);

	it("retries the exact failed next cursor and commits its history only with actual success", async () => {
		const h = harness();
		h.controller.getSnapshot().loadFirst();
		const first = await complete(h, page([record(1)], CURSOR));
		first.loadNext();
		const oldSignal = signalOf(h);
		const error = await reject(h, new Error("offline"));
		error.retry();
		expect(request(h).afterId).toBe(CURSOR);
		expect(signalOf(h)).not.toBe(oldSignal);
		const restored = await complete(h, page([record(2)], id(901)));
		expect(restored.canPrevious).toBe(true);
		restored.loadPrevious();
		expect(request(h).afterId).toBeNull();
		await complete(h, page([record(1)], CURSOR));
	});

	it("retries a failed previous cursor without losing or duplicating the proposed backward history", async () => {
		const h = harness();
		h.controller.getSnapshot().loadFirst();
		const first = await complete(h, page([record(1)], CURSOR));
		first.loadNext();
		const second = await complete(h, page([record(2)], id(901)));
		second.loadPrevious();
		expect(request(h).afterId).toBeNull();
		const error = await reject(h, new Error("offline"));
		expect(error.afterId).toBeNull();
		error.retry();
		expect(request(h).afterId).toBeNull();
		const back = await complete(h, page([record(3)], id(902)));
		expect(back.canPrevious).toBe(false);
		back.loadNext();
		expect(request(h).afterId).toBe(id(902));
		await complete(h, page([record(4)]));
	});

	it("makes old ready and error actions inert after newer snapshots, including another failure", async () => {
		const h = harness();
		const idle = h.controller.getSnapshot();
		idle.loadFirst();
		const first = await complete(h, page([record(1)], CURSOR));
		first.loadNext();
		const firstError = await reject(h, new Error("first"));
		firstError.retry();
		const secondError = await reject(h, new Error("second"));
		const count = h.requests.length;
		for (const stale of [idle, first, firstError]) {
			stale.loadFirst();
			stale.loadNext();
			stale.loadPrevious();
			stale.retry();
		}
		expect(h.requests).toHaveLength(count);
		expect(h.controller.getSnapshot()).toBe(secondError);
		secondError.retry();
		const current = await complete(h, page([record(2)]));
		firstError.retry();
		secondError.retry();
		expect(h.controller.getSnapshot()).toBe(current);
		expect(h.requests).toHaveLength(count + 1);
	});

	it("shows the 100-entry history limit without hiding the real next cursor or dropping older pages", async () => {
		const h = harness();
		h.controller.getSnapshot().loadFirst();
		let current = await complete(h, page([record(1)], CURSOR));
		for (let count = 2; count <= 100; count++) {
			current.loadNext();
			expect(request(h).afterId).toBe(CURSOR);
			current = await complete(h, page([record(count)], CURSOR));
		}
		expect(h.requests).toHaveLength(100);
		expect(current.accounts[0]?.account.id).toBe(id(100));
		expect(current.nextId).toBe(CURSOR);
		expect(current.historyLimit).toBe(true);
		expect(current.canNext).toBe(false);
		current.loadNext();
		expect(h.requests).toHaveLength(100);
		for (let count = 99; count >= 1; count--) {
			current.loadPrevious();
			expect(request(h).afterId).toBe(count === 1 ? null : CURSOR);
			current = await complete(h, page([record(count)], CURSOR));
			expect(current.historyLimit).toBe(false);
			expect(current.canNext).toBe(true);
		}
		expect(h.requests).toHaveLength(199);
		expect(current.canPrevious).toBe(false);
		current.loadPrevious();
		expect(h.requests).toHaveLength(199);
	});

	it("loads first explicitly and resets previous history only after its successful response", async () => {
		const h = harness();
		h.controller.getSnapshot().loadFirst();
		const first = await complete(h, page([record(1)], CURSOR));
		first.loadNext();
		const second = await complete(h, page([record(2)]));
		second.loadFirst();
		expect(request(h).afterId).toBeNull();
		noReadyData(h.controller.getSnapshot());
		const reset = await complete(h, page([record(7)], id(905)));
		expect(reset.afterId).toBeNull();
		expect(reset.canPrevious).toBe(false);
		expect(reset.nextId).toBe(id(905));
	});

	it("turns a synchronous client throw into the same fixed error and retry cursor", async () => {
		const h = harness();
		h.setCallHook(() => {
			throw new Error("SYNC_CLIENT_FAILURE_CANARY");
		});
		h.controller.getSnapshot().loadFirst();
		await waitForStatus(h, "error");
		const snapshot = failed(h);
		expect(snapshot.afterId).toBeNull();
		expect(snapshot.error).toBe("Accounts unavailable");
		expect(JSON.stringify(snapshot)).not.toContain("SYNC_CLIENT_FAILURE_CANARY");
	});

	it("reserves close before synchronous client reentry and still joins the returned original promise", async () => {
		const h = harness();
		let reentrant: Promise<void> | undefined;
		h.setCallHook(() => {
			reentrant = h.controller.close();
		});
		h.controller.getSnapshot().loadFirst();
		const closing = h.controller.close();
		expect(reentrant).toBe(closing);
		expect(h.controller.getSnapshot().status).toBe("closed");
		expect(signalOf(h).aborted).toBe(true);
		let settled = false;
		void closing.then(() => {
			settled = true;
		});
		await Promise.resolve();
		expect(settled).toBe(false);
		request(h).resolve(page([record(1)]));
		await closing;
		expect(settled).toBe(true);
		expect(h.controller.getSnapshot().status).toBe("closed");
	});

	it.each(["resolve", "reject"] as const)(
		"joins %s after close, including notification and abort reentry, without late publication",
		async (outcome) => {
			const h = harness();
			h.controller.getSnapshot().loadFirst();
			const loading = h.controller.getSnapshot();
			let fromNotification: Promise<void> | undefined;
			let fromAbort: Promise<void> | undefined;
			const published: Snapshot[] = [];
			h.controller.subscribe(() => {
				const snapshot = h.controller.getSnapshot();
				published.push(snapshot);
				if (snapshot.status === "closed") fromNotification = h.controller.close();
			});
			signalOf(h).addEventListener(
				"abort",
				() => {
					fromAbort = h.controller.close();
				},
				{ once: true },
			);
			const closing = h.controller.close();
			const closed = h.controller.getSnapshot();
			expect(fromNotification).toBe(closing);
			expect(fromAbort).toBe(closing);
			expect(h.controller.close()).toBe(closing);
			expect(closed.status).toBe("closed");
			noReadyData(closed);
			for (const snapshot of [loading, closed]) {
				snapshot.loadFirst();
				snapshot.loadNext();
				snapshot.loadPrevious();
				snapshot.retry();
			}
			expect(h.pageAccounts).toHaveBeenCalledTimes(1);
			let settled = false;
			void closing.then(() => {
				settled = true;
			});
			await Promise.resolve();
			expect(settled).toBe(false);
			const beforeSettlement = [...published];
			if (outcome === "resolve") request(h).resolve(page([record(1)], CURSOR));
			else request(h).reject(new Error("LATE_CLIENT_FAILURE_CANARY"));
			await closing;
			expect(settled).toBe(true);
			expect(h.controller.getSnapshot()).toBe(closed);
			expect(published).toEqual(beforeSettlement);
			expect(JSON.stringify(closed)).not.toContain("LATE_CLIENT_FAILURE_CANARY");
		},
	);

	it("closes from a loading notification before client IO without leaving an unjoined request", async () => {
		const h = harness();
		let fromLoading: Promise<void> | undefined;
		h.controller.subscribe(() => {
			if (h.controller.getSnapshot().status === "loading") fromLoading = h.controller.close();
		});
		h.controller.getSnapshot().loadFirst();
		expect(h.pageAccounts).not.toHaveBeenCalled();
		expect(h.controller.getSnapshot().status).toBe("closed");
		const closing = h.controller.close();
		expect(fromLoading).toBe(closing);
		await closing;
		expect(h.controller.getSnapshot().status).toBe("closed");
	});

	it("contains async subscriber rejections through loading, ready and closed publication", async () => {
		const h = harness();
		const rejection = new Error("ACCOUNT_SUBSCRIBER_REJECTION");
		const delivered: Snapshot["status"][] = [];
		let leaked = 0;
		const observeUnhandled = (reason: unknown): void => {
			if (reason === rejection) leaked += 1;
		};
		const unsubscribe = h.controller.subscribe(async (): Promise<void> => {
			delivered.push(h.controller.getSnapshot().status);
			throw rejection;
		});
		process.on("unhandledRejection", observeUnhandled);
		try {
			h.controller.getSnapshot().loadFirst();
			await yieldEventLoop();
			await complete(h, page([record(1)], CURSOR));
			await yieldEventLoop();
			await h.controller.close();
			await yieldEventLoop();
			expect(delivered).toEqual(["loading", "ready", "closed"]);
			expect(leaked).toBe(0);
		} finally {
			unsubscribe();
			try {
				const closing = h.controller.close();
				for (const pending of h.requests) if (!pending.settled) pending.resolve(page());
				await closing;
				await yieldEventLoop();
			} finally {
				process.removeListener("unhandledRejection", observeUnhandled);
			}
		}
	});

	it("closes an idle controller once and fences every retained action without IO", async () => {
		const h = harness();
		const idle = h.controller.getSnapshot();
		const closing = h.controller.close();
		expect(h.controller.close()).toBe(closing);
		await closing;
		const closed = h.controller.getSnapshot();
		idle.loadFirst();
		idle.loadNext();
		idle.loadPrevious();
		idle.retry();
		closed.loadFirst();
		closed.loadNext();
		closed.loadPrevious();
		closed.retry();
		expect(closed.status).toBe("closed");
		expect(h.pageAccounts).not.toHaveBeenCalled();
	});
});

function observeRefetch(h: Harness, signal: AbortSignal) {
	let state: "pending" | "fulfilled" | "rejected" = "pending";
	let error: unknown;
	const promise = h.controller.refetch(signal);
	const settled = promise.then(
		() => {
			state = "fulfilled";
		},
		(reason: unknown) => {
			error = reason;
			state = "rejected";
		},
	);
	return {
		promise,
		settled,
		get state() {
			return state;
		},
		get error() {
			return error;
		},
	};
}
type RefetchResult = ReturnType<typeof observeRefetch>;
async function expectRefetchFailure(result: RefetchResult): Promise<void> {
	await result.settled;
	expect(result.state).toBe("rejected");
	expect(result.error).toBeInstanceOf(Error);
	if (!(result.error instanceof Error)) throw new Error("Expected opaque refetch error");
	expect(result.error.name).toBe("Error");
	expect(result.error.message).toBe("Accounts unavailable");
}
async function completeRefetch(h: Harness, result: RefetchResult, value: Page): Promise<Ready> {
	request(h).resolve(value);
	await result.settled;
	expect(result.state).toBe("fulfilled");
	return ready(h);
}

describe("account directory event refetch", () => {
	it.each(["user", "refetch"] as const)(
		"keeps the %s read closed when the page cursor getter closes its controller",
		async (mode) => {
			const h = harness();
			const initial = h.controller.getSnapshot();
			const close = h.controller.close;
			let result: RefetchResult | undefined;
			if (mode === "user") initial.loadFirst();
			else result = observeRefetch(h, new AbortController().signal);
			await yieldEventLoop();
			const loading = h.controller.getSnapshot();
			const signal = signalOf(h);
			let reads = 0;
			let fromGetter: Promise<void> | undefined;
			request(h).resolve({
				accounts: [record(1)],
				get nextId() {
					reads += 1;
					fromGetter = close();
					return CURSOR;
				},
			});
			await yieldEventLoop();
			const closing = fromGetter;
			expect(closing).toBeDefined();
			if (closing === undefined) throw new Error("Expected the page cursor getter to close");
			await closing;
			if (result !== undefined) await result.settled;
			const closed = h.controller.getSnapshot();
			expect(closed.status).toBe("closed");
			expect(close()).toBe(closing);
			expect(signal.aborted).toBe(true);
			expect(reads).toBe(1);
			if (result !== undefined) await expectRefetchFailure(result);
			for (const snapshot of [initial, loading, closed]) {
				snapshot.loadFirst();
				snapshot.loadNext();
				snapshot.loadPrevious();
				snapshot.retry();
			}
			await yieldEventLoop();
			expect(h.pageAccounts).toHaveBeenCalledTimes(1);
			expect(h.controller.getSnapshot()).toBe(closed);
		},
	);

	it("uses one coherent cursor value when the page getter changes on a second read", async () => {
		const h = harness();
		h.controller.getSnapshot().loadFirst();
		let reads = 0;
		const first = await complete(h, {
			accounts: [record(1)],
			get nextId() {
				reads += 1;
				return reads === 1 ? CURSOR : null;
			},
		});
		expect(first.nextId).toBe(CURSOR);
		expect(first.canNext).toBe(true);
		expect(reads).toBe(1);
		first.loadNext();
		expect(h.requests).toHaveLength(2);
		expect(request(h).afterId).toBe(CURSOR);
		await complete(h, page([record(2)]));
	});

	it("rejects a refetch closed by its caller signal getter before admitting IO", async () => {
		const h = harness();
		const caller = new AbortController();
		const close = h.controller.close;
		let fromGetter: Promise<void> | undefined;
		Object.defineProperty(caller.signal, "aborted", {
			configurable: true,
			get() {
				fromGetter = close();
				return false;
			},
		});
		try {
			const result = observeRefetch(h, caller.signal);
			await yieldEventLoop();
			const closing = fromGetter;
			expect(closing).toBeDefined();
			if (closing === undefined) throw new Error("Expected the caller signal getter to close");
			await closing;
			expect(result.state).toBe("rejected");
			await expectRefetchFailure(result);
			expect(h.pageAccounts).not.toHaveBeenCalled();
			expect(h.controller.getSnapshot().status).toBe("closed");
			expect(close()).toBe(closing);
		} finally {
			Reflect.deleteProperty(caller.signal, "aborted");
		}
	});

	it("keeps refetch closed when its caller signal getter closes during failure publication", async () => {
		const h = harness();
		const caller = new AbortController();
		const close = h.controller.close;
		let closeOnRead = false;
		let fromGetter: Promise<void> | undefined;
		Object.defineProperty(caller.signal, "aborted", {
			configurable: true,
			get() {
				if (closeOnRead) fromGetter = close();
				return false;
			},
		});
		try {
			const result = observeRefetch(h, caller.signal);
			await yieldEventLoop();
			expect(h.pageAccounts).toHaveBeenCalledTimes(1);
			closeOnRead = true;
			request(h).reject(new Error("REFETCH_FAILURE_CANARY"));
			await yieldEventLoop();
			const closing = fromGetter;
			expect(closing).toBeDefined();
			if (closing === undefined) throw new Error("Expected the caller signal getter to close");
			await closing;
			await expectRefetchFailure(result);
			expect(h.controller.getSnapshot().status).toBe("closed");
			expect(close()).toBe(closing);
			expect(h.pageAccounts).toHaveBeenCalledTimes(1);
		} finally {
			closeOnRead = false;
			Reflect.deleteProperty(caller.signal, "aborted");
		}
	});

	it("reads the current cursor again without advancing or resetting its history", async () => {
		const h = harness();
		h.controller.getSnapshot().loadFirst();
		const first = await complete(h, page([record(1)], CURSOR));
		first.loadNext();
		await complete(h, page([record(2)], id(901)));
		const result = observeRefetch(h, new AbortController().signal);
		await yieldEventLoop();
		expect(request(h).afterId).toBe(CURSOR);
		expect(result.state).toBe("pending");
		const fresh = await completeRefetch(h, result, page([record(3, 17)], id(902)));
		expect(fresh.afterId).toBe(CURSOR);
		expect(fresh.accounts).toEqual([record(3, 17)]);
		expect(fresh.canPrevious).toBe(true);
		fresh.loadPrevious();
		expect(request(h).afterId).toBeNull();
		await complete(h, page([record(4)]));
	});

	it.each([
		["next", "after failure"],
		["previous", "after failure"],
		["next", "while active"],
		["previous", "while active"],
	] as const)(
		"refreshes the exact failed %s proposal %s and preserves that history",
		async (direction, timing) => {
			const h = harness();
			h.controller.getSnapshot().loadFirst();
			const first = await complete(h, page([record(1)], CURSOR));
			first.loadNext();
			if (direction === "previous") {
				const second = await complete(h, page([record(2)], id(901)));
				second.loadPrevious();
			}
			const failedCursor = direction === "next" ? CURSOR : null;
			let result: RefetchResult;
			if (timing === "while active") {
				const failedRequest = h.requests.length - 1;
				const expectedCount = h.requests.length + 1;
				result = observeRefetch(h, new AbortController().signal);
				const actionCounts: [number, number][] = [];
				const unsubscribe = h.controller.subscribe(() => {
					const snapshot = h.controller.getSnapshot();
					if (snapshot.status !== "error") return;
					const before = h.requests.length;
					snapshot.retry();
					snapshot.loadFirst();
					snapshot.loadNext();
					snapshot.loadPrevious();
					actionCounts.push([before, h.requests.length]);
				});
				try {
					request(h, failedRequest).reject(new Error("USER_READ_FAILURE_CANARY"));
					await yieldEventLoop();
				} finally {
					unsubscribe();
				}
				expect(actionCounts).toHaveLength(1);
				for (const [before, after] of actionCounts) expect(after).toBe(before);
				expect(h.requests).toHaveLength(expectedCount);
				expect(result.state).toBe("pending");
			} else {
				await reject(h, new Error("USER_READ_FAILURE_CANARY"));
				result = observeRefetch(h, new AbortController().signal);
			}
			await yieldEventLoop();
			expect(request(h).afterId).toBe(failedCursor);
			const fresh = await completeRefetch(h, result, page([record(3)], id(903)));
			expect(fresh.afterId).toBe(failedCursor);
			expect(fresh.canPrevious).toBe(direction === "next");
			if (direction === "next") {
				fresh.loadPrevious();
				expect(request(h).afterId).toBeNull();
			} else {
				fresh.loadNext();
				expect(request(h).afterId).toBe(id(903));
			}
			await complete(h, page([record(4)]));
		},
	);

	it("queues a fresh read after an older user request and fences ready-subscriber page actions", async () => {
		const h = harness();
		h.controller.getSnapshot().loadFirst();
		const userSignal = signalOf(h);
		const result = observeRefetch(h, new AbortController().signal);
		expect(h.requests).toHaveLength(1);
		expect(userSignal.aborted).toBe(false);
		const oldReady: { snapshot: Ready | undefined } = { snapshot: undefined };
		const unsubscribe = h.controller.subscribe(() => {
			const snapshot = h.controller.getSnapshot();
			if (snapshot.status === "ready" && oldReady.snapshot === undefined) {
				oldReady.snapshot = snapshot;
				snapshot.loadNext();
				snapshot.loadFirst();
				snapshot.loadPrevious();
				snapshot.retry();
			}
		});
		try {
			request(h, 0).resolve(page([record(1)], CURSOR));
			await yieldEventLoop();
			const retained = oldReady.snapshot;
			expect(retained).toBeDefined();
			if (retained === undefined) throw new Error("Expected actual old-user ready notification");
			expect(h.requests).toHaveLength(2);
			expect(request(h).afterId).toBeNull();
			expect(result.state).toBe("pending");
			const fresh = await completeRefetch(h, result, page([record(2)], id(901)));
			expect(fresh.accounts).toEqual([record(2)]);
			expect(fresh.canPrevious).toBe(false);
			retained.loadNext();
			expect(h.requests).toHaveLength(2);
		} finally {
			unsubscribe();
		}
	});

	it("keeps one later freshness intent queued and rejects an additional caller instead of coalescing", async () => {
		const h = harness();
		const first = observeRefetch(h, new AbortController().signal);
		await yieldEventLoop();
		const second = observeRefetch(h, new AbortController().signal);
		const overflow = observeRefetch(h, new AbortController().signal);
		expect(first.promise).not.toBe(second.promise);
		await expectRefetchFailure(overflow);
		expect(h.requests).toHaveLength(1);
		request(h, 0).resolve(page([record(1)], CURSOR));
		await first.settled;
		await yieldEventLoop();
		expect(first.state).toBe("fulfilled");
		expect(second.state).toBe("pending");
		expect(h.requests).toHaveLength(2);
		expect(request(h).afterId).toBeNull();
		const fresh = await completeRefetch(h, second, page([record(2)], id(901)));
		expect(fresh.accounts).toEqual([record(2)]);
		expect(fresh.canPrevious).toBe(false);
	});

	it("does not fulfill a failed refresh or discard the distinct queued fresh read", async () => {
		const h = harness();
		const first = observeRefetch(h, new AbortController().signal);
		await yieldEventLoop();
		const second = observeRefetch(h, new AbortController().signal);
		const rawFailure = new Error("REFRESH_FAILURE_CANARY");
		request(h, 0).reject(rawFailure);
		await expectRefetchFailure(first);
		await yieldEventLoop();
		expect(first.error).not.toBe(rawFailure);
		expect(second.state).toBe("pending");
		expect(h.requests).toHaveLength(2);
		expect(request(h).afterId).toBeNull();
		await completeRefetch(h, second, page([record(2)]));
		expect(first.state).toBe("rejected");
	});

	it.each(["pre-aborted", "canceled queued"] as const)(
		"makes a %s refresh inert without aborting unrelated user IO",
		async (kind) => {
			const h = harness();
			h.controller.getSnapshot().loadFirst();
			const userSignal = signalOf(h);
			const caller = new AbortController();
			if (kind === "pre-aborted") caller.abort();
			const result = observeRefetch(h, caller.signal);
			if (kind === "canceled queued") caller.abort();
			await expectRefetchFailure(result);
			expect(h.requests).toHaveLength(1);
			expect(userSignal.aborted).toBe(false);
			request(h, 0).resolve(page([record(1)], CURSOR));
			await yieldEventLoop();
			expect(h.requests).toHaveLength(1);
			expect(ready(h).accounts).toEqual([record(1)]);
		},
	);

	it.each(["resolve", "reject"] as const)(
		"joins actual %s cleanup after inflight abort and refuses a late canceled page",
		async (outcome) => {
			const h = harness();
			const caller = new AbortController();
			const publishedReady: string[][] = [];
			const unsubscribe = h.controller.subscribe(() => {
				const snapshot = h.controller.getSnapshot();
				if (snapshot.status === "ready")
					publishedReady.push(snapshot.accounts.map((row) => row.account.id));
			});
			try {
				const result = observeRefetch(h, caller.signal);
				await yieldEventLoop();
				const ownSignal = signalOf(h);
				caller.abort();
				await yieldEventLoop();
				expect(ownSignal.aborted).toBe(true);
				expect(result.state).toBe("pending");
				expect(publishedReady).toEqual([]);
				if (outcome === "resolve") request(h).resolve(page([record(91)], CURSOR));
				else request(h).reject(new Error("ABORTED_READ_CANARY"));
				await expectRefetchFailure(result);
				expect(publishedReady).toEqual([]);
				expect(failed(h).error).toBe("Accounts unavailable");
			} finally {
				unsubscribe();
			}
		},
	);

	it("cancels a promoted refresh before client invocation without aborting the earlier user request", async () => {
		const h = harness();
		h.controller.getSnapshot().loadFirst();
		const userSignal = signalOf(h);
		const caller = new AbortController();
		const result = observeRefetch(h, caller.signal);
		const unsubscribe = h.controller.subscribe(() => {
			if (h.controller.getSnapshot().status === "loading" && h.requests.length === 1)
				caller.abort();
		});
		try {
			request(h, 0).resolve(page([record(1)], CURSOR));
			await expectRefetchFailure(result);
			expect(h.requests).toHaveLength(1);
			expect(userSignal.aborted).toBe(false);
			expect(failed(h).error).toBe("Accounts unavailable");
		} finally {
			unsubscribe();
		}
	});

	it.each(["abort", "close"] as const)(
		"handles %s from loading publication before invoking the client",
		async (action) => {
			const h = harness();
			const caller = new AbortController();
			let closing: Promise<void> | undefined;
			const unsubscribe = h.controller.subscribe(() => {
				if (h.controller.getSnapshot().status !== "loading") return;
				if (action === "abort") caller.abort();
				else closing = h.controller.close();
			});
			try {
				const result = observeRefetch(h, caller.signal);
				await expectRefetchFailure(result);
				expect(h.pageAccounts).not.toHaveBeenCalled();
				if (action === "close") {
					expect(h.controller.close()).toBe(closing);
					await closing;
					expect(h.controller.getSnapshot().status).toBe("closed");
				} else expect(failed(h).error).toBe("Accounts unavailable");
			} finally {
				unsubscribe();
			}
		},
	);

	it.each(["abort", "close"] as const)(
		"rejects refresh when %s occurs in ready publication before public fulfillment",
		async (action) => {
			const h = harness();
			const caller = new AbortController();
			let closing: Promise<void> | undefined;
			let notifications = 0;
			const unsubscribe = h.controller.subscribe(() => {
				if (h.controller.getSnapshot().status !== "ready") return;
				notifications += 1;
				if (action === "abort") caller.abort();
				else closing = h.controller.close();
			});
			try {
				const result = observeRefetch(h, caller.signal);
				await yieldEventLoop();
				request(h).resolve(page([record(1)], CURSOR));
				await expectRefetchFailure(result);
				expect(notifications).toBe(1);
				if (action === "close") {
					expect(h.controller.close()).toBe(closing);
					await closing;
					expect(h.controller.getSnapshot().status).toBe("closed");
				} else expect(failed(h).error).toBe("Accounts unavailable");
			} finally {
				unsubscribe();
			}
		},
	);

	it("queues a client-reentrant refetch for a read begun after that newer intent", async () => {
		const h = harness();
		const reentry: { result?: RefetchResult } = {};
		h.setCallHook(() => {
			if (h.requests.length === 0) reentry.result = observeRefetch(h, new AbortController().signal);
		});
		const first = observeRefetch(h, new AbortController().signal);
		await yieldEventLoop();
		const nested = reentry.result;
		if (nested === undefined) throw new Error("Expected synchronous client reentry");
		request(h, 0).resolve(page([record(1)], CURSOR));
		await first.settled;
		await yieldEventLoop();
		expect(first.state).toBe("fulfilled");
		expect(nested.state).toBe("pending");
		expect(h.requests).toHaveLength(2);
		await completeRefetch(h, nested, page([record(2)]));
	});

	it("fences queued work on close while joining user IO and cached notification/abort reentrant closes", async () => {
		const h = harness();
		h.controller.getSnapshot().loadFirst();
		const userSignal = signalOf(h);
		const queued = observeRefetch(h, new AbortController().signal);
		let fromNotification: Promise<void> | undefined;
		let fromAbort: Promise<void> | undefined;
		const unsubscribe = h.controller.subscribe(() => {
			if (h.controller.getSnapshot().status === "closed") fromNotification = h.controller.close();
		});
		userSignal.addEventListener(
			"abort",
			() => {
				fromAbort = h.controller.close();
			},
			{ once: true },
		);
		try {
			const closing = h.controller.close();
			expect(fromNotification).toBe(closing);
			expect(fromAbort).toBe(closing);
			await expectRefetchFailure(queued);
			let closed = false;
			void closing.then(() => {
				closed = true;
			});
			await yieldEventLoop();
			expect(closed).toBe(false);
			expect(h.requests).toHaveLength(1);
			request(h, 0).resolve(page([record(1)], CURSOR));
			await closing;
			expect(closed).toBe(true);
			expect(h.controller.getSnapshot().status).toBe("closed");
			await expectRefetchFailure(observeRefetch(h, new AbortController().signal));
		} finally {
			unsubscribe();
		}
	});

	it("does not let queued rejection short-circuit close's join of an active fresh read", async () => {
		const h = harness();
		const active = observeRefetch(h, new AbortController().signal);
		await yieldEventLoop();
		const queued = observeRefetch(h, new AbortController().signal);
		const closing = h.controller.close();
		await expectRefetchFailure(queued);
		let closed = false;
		void closing.then(() => {
			closed = true;
		});
		await yieldEventLoop();
		expect(closed).toBe(false);
		expect(active.state).toBe("pending");
		request(h).reject(new Error("CLOSE_ABORT_CANARY"));
		await expectRefetchFailure(active);
		await closing;
		expect(closed).toBe(true);
		expect(h.controller.getSnapshot().status).toBe("closed");
		expect(h.requests).toHaveLength(1);
	});

	it("joins original refetch IO after synchronous client close instead of reporting early cancellation", async () => {
		const h = harness();
		let fromClient: Promise<void> | undefined;
		h.setCallHook(() => {
			fromClient = h.controller.close();
		});
		const result = observeRefetch(h, new AbortController().signal);
		await yieldEventLoop();
		const closing = h.controller.close();
		expect(fromClient).toBe(closing);
		expect(signalOf(h).aborted).toBe(true);
		await yieldEventLoop();
		expect(result.state).toBe("pending");
		request(h).resolve(page([record(1)], CURSOR));
		await expectRefetchFailure(result);
		await closing;
		expect(h.controller.getSnapshot().status).toBe("closed");
	});

	it("refreshes the page at the visible history limit without adding or dropping a cursor", async () => {
		const h = harness();
		h.controller.getSnapshot().loadFirst();
		let current = await complete(h, page([record(1)], CURSOR));
		for (let count = 2; count <= 100; count++) {
			current.loadNext();
			current = await complete(h, page([record(count)], CURSOR));
		}
		const result = observeRefetch(h, new AbortController().signal);
		await yieldEventLoop();
		expect(request(h).afterId).toBe(CURSOR);
		const fresh = await completeRefetch(h, result, page([record(101)], CURSOR));
		expect(h.requests).toHaveLength(101);
		expect(fresh.historyLimit).toBe(true);
		expect(fresh.nextId).toBe(CURSOR);
		expect(fresh.canNext).toBe(false);
		fresh.loadNext();
		expect(h.requests).toHaveLength(101);
		fresh.loadPrevious();
		expect(request(h).afterId).toBe(CURSOR);
		const back = await complete(h, page([record(99)], CURSOR));
		expect(back.historyLimit).toBe(false);
		expect(back.canNext).toBe(true);
	});
});
