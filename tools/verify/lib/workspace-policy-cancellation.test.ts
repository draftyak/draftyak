import path from "node:path";
import { setImmediate as nextTurn } from "node:timers/promises";
import { describe, expect, it, vi } from "vitest";
import {
	namedFiles,
	namedWorktreeFiles,
	type ReadDirectory,
	type StatPath,
} from "./workspace-policy.ts";
import { createInventoryHost, inventoryWorktrees } from "./worktree-inventory.ts";

const timerProbe = vi.hoisted(() => ({
	observe: undefined as
		| ((args: readonly unknown[], original: Promise<unknown>) => void)
		| undefined,
	invalid: false,
}));
vi.mock("node:timers/promises", async (importOriginal) => {
	const actual = await importOriginal<typeof import("node:timers/promises")>();
	function observedTimeout(
		this: unknown,
		...args: Parameters<typeof actual.setTimeout>
	): ReturnType<typeof actual.setTimeout> {
		const original = Reflect.apply(actual.setTimeout, this, args) as ReturnType<
			typeof actual.setTimeout
		>;
		try {
			timerProbe.observe?.(args, original);
		} catch {
			timerProbe.invalid = true;
		}
		return original;
	}
	return { ...actual, setTimeout: observedTimeout as typeof actual.setTimeout };
});

type Entry = Awaited<ReturnType<ReadDirectory>>[number];
type Kind = Awaited<ReturnType<StatPath>>;
type Outcome<T> =
	| { readonly kind: "fulfilled"; readonly value: T }
	| { readonly kind: "rejected"; readonly error: unknown };
function deferred<T>() {
	let resolve!: (value: T) => void, reject!: (error: unknown) => void;
	const promise = new Promise<T>((yes, no) => {
		resolve = yes;
		reject = no;
	});
	void promise.then(
		() => undefined,
		() => undefined,
	);
	return { promise, resolve, reject };
}
function observe<T>(original: Promise<T>) {
	let state: "pending" | "fulfilled" | "rejected" = "pending";
	const done: Promise<Outcome<T>> = original.then(
		(value) => {
			state = "fulfilled";
			return { kind: "fulfilled", value };
		},
		(error: unknown) => {
			state = "rejected";
			return { kind: "rejected", error };
		},
	);
	return { done, state: () => state };
}
function ownedPromises() {
	const originals: Promise<unknown>[] = [];
	return {
		retain<T>(original: Promise<T>): Promise<T> {
			originals.push(original);
			void original.then(
				() => undefined,
				() => undefined,
			);
			return original;
		},
		turn(): Promise<void> {
			const original = nextTurn();
			originals.push(original);
			return original;
		},
		async reached(gate: Promise<unknown>, walk: ReturnType<typeof observe>): Promise<boolean> {
			// Immediate fixture responses finish their microtasks before this actual event-loop
			// turn. Missing enrollment fails without a naked wait or elapsed-time threshold.
			return Promise.race([
				gate.then(() => true),
				walk.done.then(() => false),
				this.turn().then(() => false),
			]);
		},
		async join(): Promise<void> {
			await Promise.allSettled(originals);
		},
	};
}
const directoryKind: Kind = { isDirectory: () => true, isSymbolicLink: () => false };
const entry = (name: string, directory = true): Entry => ({
	name,
	isDirectory: () => directory,
	isSymbolicLink: () => false,
});
const root = path.resolve("synthetic-inventory-cancellation-root");
const child = (name: string): string => path.join(root, name);
function expectRefusal(result: Outcome<unknown>): void {
	expect(result.kind).toBe("rejected");
	if (result.kind !== "rejected") return;
	expect(result.error).toBeInstanceOf(Error);
	expect(result.error).toMatchObject({ name: "Error", message: "file-name inventory failed" });
}

describe("injected inventory cancellation", () => {
	it.each(["files", "worktrees"] as const)(
		"refuses pre-aborted %s without admitting work",
		async (kind) => {
			const controller = new AbortController();
			controller.abort();
			const readDirectory = vi.fn<ReadDirectory>(() => Promise.resolve([]));
			const statPath = vi.fn<StatPath>(() => Promise.resolve(directoryKind));
			const refresh = vi.fn(() => Promise.resolve([{ directory: root, prunable: false }]));
			const capacity = vi.fn(() => 2);
			const original =
				kind === "files"
					? namedFiles(
							"needle.txt",
							root,
							false,
							readDirectory,
							statPath,
							capacity,
							controller.signal,
						)
					: namedWorktreeFiles(
							"needle.txt",
							root,
							refresh,
							false,
							readDirectory,
							statPath,
							capacity,
							controller.signal,
						);
			expectRefusal(await observe(original).done);
			expect(readDirectory).not.toHaveBeenCalled();
			expect(statPath).not.toHaveBeenCalled();
			expect(refresh).not.toHaveBeenCalled();
		},
	);

	it.each(["files", "worktrees"] as const)(
		"clears queued names and joins the original %s read after abort",
		async (kind) => {
			const owned = ownedPromises(),
				controller = new AbortController();
			const held = deferred<readonly Entry[]>(),
				entered = deferred<void>();
			const reads: string[] = [];
			const statPath = vi.fn<StatPath>(() => Promise.resolve(directoryKind));
			const refresh = vi.fn(() => Promise.resolve([{ directory: root, prunable: false }]));
			const readDirectory: ReadDirectory = (target) => {
				reads.push(target);
				if (target === root) return owned.retain(Promise.resolve([entry("held"), entry("queued")]));
				if (target === child("held")) {
					entered.resolve();
					return owned.retain(held.promise);
				}
				return owned.retain(Promise.resolve([]));
			};
			const original =
				kind === "files"
					? namedFiles(
							"needle.txt",
							root,
							false,
							readDirectory,
							statPath,
							() => 1,
							controller.signal,
						)
					: namedWorktreeFiles(
							"needle.txt",
							root,
							refresh,
							false,
							readDirectory,
							statPath,
							() => 1,
							controller.signal,
						);
			const walk = observe(original);
			let admitted = false,
				pendingBeforeRelease = false;
			try {
				admitted = await owned.reached(entered.promise, walk);
				controller.abort();
				await owned.turn();
				pendingBeforeRelease = walk.state() === "pending";
			} finally {
				controller.abort();
				held.resolve([entry("late"), entry("needle.txt", false)]);
				await walk.done;
				await owned.join();
			}
			expect(admitted).toBe(true);
			expect(pendingBeforeRelease).toBe(true);
			expectRefusal(await walk.done);
			expect(reads).toEqual([root, child("held")]);
			expect(statPath).not.toHaveBeenCalled();
			expect(refresh).not.toHaveBeenCalled();
		},
	);

	it("does not admit stat or retry after an admitted read rejects following abort", async () => {
		const owned = ownedPromises(),
			controller = new AbortController();
		const held = deferred<readonly Entry[]>(),
			failed = deferred<readonly Entry[]>();
		const heldEntered = deferred<void>(),
			failedEntered = deferred<void>();
		const reads: string[] = [];
		const statPath = vi.fn<StatPath>(() => Promise.resolve(directoryKind));
		const readDirectory: ReadDirectory = (target) => {
			reads.push(target);
			if (target === root) return owned.retain(Promise.resolve([entry("held"), entry("failed")]));
			if (target === child("held")) {
				heldEntered.resolve();
				return owned.retain(held.promise);
			}
			if (target === child("failed")) {
				failedEntered.resolve();
				return owned.retain(failed.promise);
			}
			return owned.retain(Promise.resolve([]));
		};
		const original = namedFiles(
			"needle.txt",
			root,
			false,
			readDirectory,
			statPath,
			() => 2,
			controller.signal,
		);
		const walk = observe(original);
		let admitted = false,
			pendingBeforeRelease = false;
		try {
			admitted = await owned.reached(
				Promise.all([heldEntered.promise, failedEntered.promise]),
				walk,
			);
			controller.abort();
			failed.reject(new Error("synthetic read refusal"));
			await owned.turn();
			pendingBeforeRelease = walk.state() === "pending";
		} finally {
			controller.abort();
			failed.reject(new Error("synthetic read refusal"));
			held.resolve([]);
			await walk.done;
			await owned.join();
		}
		expect(admitted).toBe(true);
		expect(pendingBeforeRelease).toBe(true);
		expectRefusal(await walk.done);
		expect(reads).toEqual([root, child("held"), child("failed")]);
		expect(statPath).not.toHaveBeenCalled();
	});

	it("joins an original stat and refuses later retry work after abort", async () => {
		const owned = ownedPromises(),
			controller = new AbortController();
		const heldStat = deferred<Kind>(),
			entered = deferred<void>();
		const reads: string[] = [],
			stats: string[] = [];
		const readDirectory: ReadDirectory = (target) => {
			reads.push(target);
			return owned.retain(
				target === root
					? Promise.resolve([entry("failed")])
					: Promise.reject(new Error("synthetic read refusal")),
			);
		};
		const statPath: StatPath = (target) => {
			stats.push(target);
			entered.resolve();
			return owned.retain(heldStat.promise);
		};
		const original = namedFiles(
			"needle.txt",
			root,
			false,
			readDirectory,
			statPath,
			() => 1,
			controller.signal,
		);
		const walk = observe(original);
		let admitted = false,
			pendingBeforeRelease = false;
		try {
			admitted = await owned.reached(entered.promise, walk);
			controller.abort();
			await owned.turn();
			pendingBeforeRelease = walk.state() === "pending";
		} finally {
			controller.abort();
			heldStat.resolve(directoryKind);
			await walk.done;
			await owned.join();
		}
		expect(admitted).toBe(true);
		expect(pendingBeforeRelease).toBe(true);
		expectRefusal(await walk.done);
		expect(reads).toEqual([root, child("failed")]);
		expect(stats).toEqual([child("failed")]);
	});

	it.each(["policy", "inventory host"] as const)(
		"cancels the original backoff through %s while retaining another admitted read",
		async (entryPoint) => {
			const owned = ownedPromises(),
				controller = new AbortController();
			const held = deferred<readonly Entry[]>(),
				failed = deferred<readonly Entry[]>();
			const heldEntered = deferred<void>(),
				failedEntered = deferred<void>(),
				delayEntered = deferred<void>();
			const reads: string[] = [],
				stats: string[] = [];
			const delays: {
				signal: unknown;
				original: Promise<unknown>;
				observed: ReturnType<typeof observe>;
			}[] = [];
			const previous = timerProbe.observe,
				previousInvalid = timerProbe.invalid;
			timerProbe.invalid = false;
			timerProbe.observe = (args, original) => {
				if (args[0] !== 100) return;
				const options = args[2] as { signal?: unknown } | undefined;
				delays.push({
					signal: options?.signal,
					original,
					observed: observe(owned.retain(original)),
				});
				delayEntered.resolve();
			};
			const readDirectory: ReadDirectory = (target) => {
				reads.push(target);
				if (target === root) return owned.retain(Promise.resolve([entry("held"), entry("failed")]));
				if (target === child("held")) {
					heldEntered.resolve();
					return owned.retain(held.promise);
				}
				if (target === child("failed") && reads.filter((value) => value === target).length === 1) {
					failedEntered.resolve();
					return owned.retain(failed.promise);
				}
				return owned.retain(Promise.resolve([]));
			};
			const statPath: StatPath = (target) => {
				stats.push(target);
				return owned.retain(Promise.resolve(directoryKind));
			};
			const main = path.resolve("synthetic-inventory-cancellation-main");
			const gitCalls: (readonly string[])[] = [];
			const host =
				entryPoint === "inventory host"
					? createInventoryHost(root, {
							readDirectory,
							statPath,
							spawnGit: () => {
								throw new Error("Git uses synthetic listing metadata");
							},
							write: () => {
								throw new Error("No successful completion is expected");
							},
						})
					: undefined;
			const signal = host?.signal ?? controller.signal;
			const stop = host?.stop ?? (() => controller.abort());
			const original: Promise<unknown> = host
				? inventoryWorktrees(root, {
						...host,
						async git(args) {
							gitCalls.push(args);
							if (args[0] === "rev-parse")
								return { code: 0, stdout: `${path.join(main, ".git")}\n` };
							if (args[0] === "worktree")
								return { code: 0, stdout: `worktree ${main}\0\0worktree ${root}\0\0` };
							throw new Error("Unexpected Git metadata request");
						},
					})
				: namedFiles("needle.txt", root, false, readDirectory, statPath, () => 2, signal);
			const walk = observe(original);
			let initialReadsAdmitted = false,
				delayAdmitted = false,
				pendingBeforeRelease = false;
			let timerResult: Outcome<unknown> | undefined,
				observedSignal: unknown,
				observerInvalid = false;
			try {
				initialReadsAdmitted = await owned.reached(
					Promise.all([heldEntered.promise, failedEntered.promise]),
					walk,
				);
				failed.reject(new Error("synthetic read refusal"));
				delayAdmitted = await owned.reached(delayEntered.promise, walk);
				stop();
				const delay = delays[0];
				if (delay) {
					observedSignal = delay.signal;
					timerResult = await delay.observed.done;
				}
				await owned.turn();
				pendingBeforeRelease =
					walk.state() === "pending" && (host?.snapshot().pendingFs ?? 1) === 1;
				observerInvalid = timerProbe.invalid;
			} finally {
				stop();
				failed.reject(new Error("synthetic read refusal"));
				held.resolve([]);
				await walk.done;
				await owned.join();
				timerProbe.observe = previous;
				timerProbe.invalid = previousInvalid;
			}
			// Omitting the signal eventually gives the same walk refusal, but its ORIGINAL
			// 100 ms timer fulfills. Compare the actual outcome, never an elapsed-time threshold.
			expect(timerResult?.kind).toBe("rejected");
			if (timerResult?.kind === "rejected")
				expect(timerResult.error).toMatchObject({ name: "AbortError", code: "ABORT_ERR" });
			expect(observedSignal).toBe(signal);
			expect(initialReadsAdmitted).toBe(true);
			expect(delayAdmitted).toBe(true);
			expect(observerInvalid).toBe(false);
			expect(delays).toHaveLength(1);
			expect(pendingBeforeRelease).toBe(true);
			expectRefusal(await walk.done);
			expect(reads).toEqual([root, child("held"), child("failed")]);
			expect(stats).toEqual([child("failed")]);
			if (host) {
				expect(host.drained()).toBe(true);
				expect(gitCalls).toEqual([
					["rev-parse", "--path-format=absolute", "--git-common-dir"],
					["worktree", "list", "--porcelain", "-z"],
				]);
			}
		},
	);

	it("joins the admitted worktree root stat without starting absence or refresh after abort", async () => {
		const owned = ownedPromises(),
			controller = new AbortController();
		const heldStat = deferred<Kind>(),
			entered = deferred<void>();
		const reads: string[] = [],
			stats: string[] = [];
		const readDirectory: ReadDirectory = (target) => {
			reads.push(target);
			return owned.retain(Promise.resolve([]));
		};
		const statPath: StatPath = (target) => {
			stats.push(target);
			entered.resolve();
			return owned.retain(heldStat.promise);
		};
		const refresh = vi.fn(() => Promise.resolve([{ directory: root, prunable: false }]));
		const original = namedWorktreeFiles(
			"needle.txt",
			root,
			refresh,
			false,
			readDirectory,
			statPath,
			() => 1,
			controller.signal,
		);
		const walk = observe(original);
		let admitted = false,
			pendingBeforeRelease = false;
		try {
			admitted = await owned.reached(entered.promise, walk);
			controller.abort();
			await owned.turn();
			pendingBeforeRelease = walk.state() === "pending";
		} finally {
			controller.abort();
			heldStat.resolve(directoryKind);
			await walk.done;
			await owned.join();
		}
		expect(admitted).toBe(true);
		expect(pendingBeforeRelease).toBe(true);
		expectRefusal(await walk.done);
		expect(reads).toEqual([root]);
		expect(stats).toEqual([root]);
		expect(refresh).not.toHaveBeenCalled();
	});

	it.each(["files", "worktrees"] as const)("retains absent-signal %s behavior", async (kind) => {
		const owned = ownedPromises();
		const reads: string[] = [],
			stats: string[] = [];
		const readDirectory: ReadDirectory = (target) => {
			reads.push(target);
			return owned.retain(
				Promise.resolve(target === root ? [entry("branch")] : [entry("needle.txt", false)]),
			);
		};
		const statPath: StatPath = (target) => {
			stats.push(target);
			return owned.retain(Promise.resolve(directoryKind));
		};
		const refresh = vi.fn(() => Promise.resolve([{ directory: root, prunable: false }]));
		const original =
			kind === "files"
				? namedFiles("needle.txt", root, false, readDirectory, statPath, () => 2)
				: namedWorktreeFiles("needle.txt", root, refresh, false, readDirectory, statPath, () => 2);
		const walk = observe(original),
			result = await walk.done;
		await owned.join();
		expect(result).toEqual({ kind: "fulfilled", value: ["branch/needle.txt"] });
		expect(reads).toEqual([root, child("branch")]);
		expect(stats).toEqual(kind === "files" ? [] : [root]);
		expect(refresh).not.toHaveBeenCalled();
	});
});
