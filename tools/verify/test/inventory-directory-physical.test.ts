import { createHook } from "node:async_hooks";
import { type BigIntStats, lstatSync, renameSync, symlinkSync } from "node:fs";
import {
	lstat,
	mkdir,
	mkdtemp,
	readdir,
	readFile,
	realpath,
	rmdir,
	unlink,
	writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
	type InventoryDirectory,
	type InventoryDirectoryEntry,
	type InventoryEntryKind,
	openInventoryDirectory,
} from "../lib/inventory-directory.ts";
import { namedFiles } from "../lib/workspace-policy.ts";

const marker = ".gate-sentinel";
const payload = "DYTEST inventory marker\n";

interface ReadObservation {
	readonly components: readonly string[];
	entries?: readonly InventoryDirectoryEntry[];
	settled: boolean;
}

/** Records genuine operations without replacing their results or their ownership. */
class ObservedDirectory implements InventoryDirectory {
	private readonly actual: InventoryDirectory;
	readonly reads: ReadObservation[] = [];
	readonly currents: boolean[] = [];
	readonly operations: Promise<void>[] = [];
	readonly closes: Promise<void>[] = [];
	readonly originalCloses: Promise<void>[] = [];
	readonly closeErrors: unknown[] = [];
	readonly observerErrors: unknown[] = [];
	readonly directReads: {
		readonly original: Promise<readonly InventoryDirectoryEntry[]>;
		readonly row: ReadObservation;
		observed: boolean;
	}[] = [];
	private readonly watchedCloses = new Set<Promise<void>>();
	closeUncertain = false;
	closeCalls = 0;
	closeFulfilled = false;
	operationsSettledAtClose = false;
	private admitted = 0;
	private settled = 0;

	constructor(actual: InventoryDirectory) {
		this.actual = actual;
	}

	private observe<T>(operation: Promise<T>): Promise<T> {
		this.admitted += 1;
		const observed = operation.then(
			(value) => {
				this.settled += 1;
				return value;
			},
			(error: unknown) => {
				this.settled += 1;
				throw error;
			},
		);
		// Keep a settlement join while returning the original success or failure to the caller.
		this.operations.push(
			observed.then(
				() => undefined,
				() => undefined,
			),
		);
		return observed;
	}

	read(components: readonly string[]): Promise<readonly InventoryDirectoryEntry[]> {
		const row: ReadObservation = { components: [...components], settled: false };
		this.reads.push(row);
		return this.observe(this.actual.read(components)).then(
			(entries) => {
				row.entries = entries;
				row.settled = true;
				return entries;
			},
			(error: unknown) => {
				row.settled = true;
				throw error;
			},
		);
	}

	stat(components: readonly string[]): Promise<InventoryEntryKind> {
		return this.observe(this.actual.stat(components));
	}

	current(): Promise<boolean> {
		return this.observe(this.actual.current()).then((current) => {
			this.currents.push(current);
			return current;
		});
	}

	stop(): void {
		this.actual.stop();
	}

	/** No Promise reactions are installed inside the callback-capable synchronous call. */
	readDirect(components: readonly string[]): Promise<readonly InventoryDirectoryEntry[]> {
		const row: ReadObservation = { components: [...components], settled: false };
		this.reads.push(row);
		this.admitted += 1;
		try {
			const original = this.actual.read(components);
			this.directReads.push({ original, row, observed: false });
			return original;
		} catch (error) {
			this.settled += 1;
			row.settled = true;
			throw error;
		}
	}

	observeDirectReads(): void {
		const failures: unknown[] = [];
		for (const read of this.directReads) {
			if (read.observed) continue;
			read.observed = true;
			try {
				const observation = read.original.then(
					(entries) => {
						this.settled += 1;
						read.row.entries = entries;
						read.row.settled = true;
					},
					() => {
						this.settled += 1;
						read.row.settled = true;
					},
				);
				this.operations.push(
					observation.then(
						() => undefined,
						(error: unknown) => {
							this.observerErrors.push(error);
						},
					),
				);
			} catch (error) {
				this.observerErrors.push(error);
				failures.push(error);
			}
		}
		if (failures.length !== 0) throw new AggregateError(failures, "DYTEST read observer failed");
	}

	/** Return the genuine close Promise; hooks must be disabled before observing it. */
	closeDirect(): Promise<void> {
		// A synchronous close failure is still an attempt and must never be retried by cleanup.
		this.closeCalls += 1;
		try {
			const original = this.actual.close();
			if (this.originalCloses.some((known) => known !== original)) this.closeUncertain = true;
			this.originalCloses.push(original);
			return original;
		} catch (error) {
			this.closeUncertain = true;
			this.closeErrors.push(error);
			throw error;
		}
	}

	observeCloses(): void {
		const failures: unknown[] = [];
		for (const original of this.originalCloses) {
			if (this.watchedCloses.has(original)) continue;
			this.watchedCloses.add(original);
			try {
				const observation = original.then(
					() => {
						this.operationsSettledAtClose = this.admitted === this.settled;
						this.closeFulfilled = true;
					},
					(error: unknown) => {
						this.closeUncertain = true;
						this.closeErrors.push(error);
					},
				);
				this.closes.push(
					observation.then(
						() => undefined,
						(error: unknown) => {
							this.observerErrors.push(error);
						},
					),
				);
			} catch (error) {
				this.observerErrors.push(error);
				failures.push(error);
			}
		}
		if (failures.length !== 0) throw new AggregateError(failures, "DYTEST close observer failed");
	}

	close(): Promise<void> {
		const original = this.closeDirect();
		this.observeCloses();
		return original;
	}
}

const sameObject = (a: BigIntStats, b: BigIntStats): boolean =>
	a.dev === b.dev && a.ino === b.ino && a.birthtimeNs === b.birthtimeNs;

class Fixture {
	readonly base: string;
	private readonly parent: string;
	private readonly identity: BigIntStats;
	readonly root: string;
	readonly outside: string;
	readonly parked: string;
	readonly directories: ObservedDirectory[] = [];
	private readonly name: string;
	private openUncertain = false;

	private constructor(base: string, parent: string, identity: BigIntStats) {
		this.base = base;
		this.parent = parent;
		this.identity = identity;
		this.name = path.basename(base);
		this.root = path.join(base, "DYTEST-root");
		this.outside = path.join(base, "DYTEST-outside");
		this.parked = path.join(base, "DYTEST-parked");
	}

	static async create(): Promise<Fixture> {
		const parent = await realpath(tmpdir());
		const base = await mkdtemp(path.join(parent, "DYTEST-inventory-physical-"));
		const fixture = new Fixture(base, parent, await lstat(base, { bigint: true }));
		try {
			await mkdir(fixture.root);
			await mkdir(fixture.outside);
		} catch (error) {
			await fixture.dispose();
			throw error;
		}
		return fixture;
	}

	async open(root = this.root): Promise<ObservedDirectory> {
		try {
			const directory = new ObservedDirectory(await openInventoryDirectory(root));
			this.directories.push(directory);
			return directory;
		} catch (error) {
			// A failed open exposes no partial owner through this interface.
			this.openUncertain = true;
			throw error;
		}
	}

	link(target: string, name: string): void {
		this.inside(target);
		this.inside(name);
		symlinkSync(target, name, process.platform === "win32" ? "junction" : "dir");
		expect(lstatSync(name).isSymbolicLink()).toBe(true);
	}

	private inside(target: string): string {
		const absolute = path.resolve(target);
		const relative = path.relative(this.base, absolute);
		if (
			!path.isAbsolute(absolute) ||
			relative === "" ||
			path.isAbsolute(relative) ||
			relative === ".." ||
			relative.startsWith(`..${path.sep}`)
		)
			throw new Error("DYTEST cleanup containment failed");
		return absolute;
	}

	private async verifyBase(): Promise<void> {
		const named = await lstat(this.base, { bigint: true });
		if (
			!path.isAbsolute(this.base) ||
			path.dirname(this.base) !== this.parent ||
			path.basename(this.base) !== this.name ||
			!this.name.startsWith("DYTEST-inventory-physical-") ||
			named.isSymbolicLink() ||
			!named.isDirectory() ||
			!sameObject(named, this.identity) ||
			(await realpath(this.parent)) !== this.parent ||
			(await realpath(this.base)) !== this.base
		)
			throw new Error("DYTEST cleanup base changed");
	}

	private async removeOwned(target: string): Promise<void> {
		await this.verifyBase();
		const absolute = this.inside(target);
		const named = await lstat(absolute);
		if (named.isSymbolicLink()) {
			// Remove the owned link itself; never resolve or traverse its target for deletion.
			await unlink(absolute);
			return;
		}
		const resolved = await realpath(absolute);
		if (this.inside(resolved) !== absolute) throw new Error("DYTEST cleanup child changed");
		if (named.isDirectory()) {
			for (const name of await readdir(absolute)) await this.removeOwned(path.join(absolute, name));
			await rmdir(absolute);
		} else {
			await unlink(absolute);
		}
	}

	/** Settle genuine resources without removing any fixture paths. Safe to repeat after failure. */
	async settleDirectories(): Promise<PromiseSettledResult<void>[]> {
		return Promise.allSettled(
			this.directories.map(async (directory) => {
				try {
					directory.observeDirectReads();
				} catch (error) {
					directory.observerErrors.push(error);
				}
				try {
					if (directory.closeCalls === 0) directory.closeDirect();
				} catch (error) {
					directory.observerErrors.push(error);
				}
				try {
					directory.observeCloses();
				} catch (error) {
					directory.observerErrors.push(error);
				}
				await Promise.allSettled([
					...directory.directReads.map(({ original }) => original),
					...new Set(directory.originalCloses),
				]);
				await Promise.all([...directory.operations, ...directory.closes]);
				if (
					directory.closeUncertain ||
					directory.closeCalls !== directory.originalCloses.length ||
					new Set(directory.originalCloses).size !== 1 ||
					directory.closes.length !== 1 ||
					!directory.closeFulfilled ||
					directory.closeErrors.length !== 0 ||
					directory.observerErrors.length !== 0
				)
					throw new AggregateError(
						[...directory.closeErrors, ...directory.observerErrors],
						"DYTEST directory close unqualified",
					);
			}),
		);
	}

	async dispose(): Promise<void> {
		// Attempt every original close, but keep the entire fixture if any close is uncertain.
		const closed = await this.settleDirectories();
		const failures = closed.flatMap((result) =>
			result.status === "rejected" ? [result.reason] : [],
		);
		if (this.openUncertain || failures.length !== 0)
			throw new AggregateError(failures, "DYTEST fixture retained after close failure");
		await this.verifyBase();
		for (const name of await readdir(this.base)) await this.removeOwned(path.join(this.base, name));
		await this.verifyBase();
		await rmdir(this.base);
	}
}

async function withFixture(run: (fixture: Fixture) => Promise<void>): Promise<void> {
	const fixture = await Fixture.create();
	try {
		await run(fixture);
	} finally {
		await fixture.dispose();
	}
}

const names = (entries: readonly InventoryDirectoryEntry[]): string[] =>
	entries.map(({ name }) => name).toSorted();

describe("physical inventory directory", () => {
	it("lists complete nested names while recording a static directory link without descending it", async () => {
		await withFixture(async (fixture) => {
			await mkdir(path.join(fixture.root, "DYTEST-nested"));
			await mkdir(path.join(fixture.root, "DYTEST-nested", "DYTEST-deep"));
			for (const directory of [
				fixture.root,
				path.join(fixture.root, "DYTEST-nested", "DYTEST-deep"),
			])
				await writeFile(path.join(directory, marker), payload);
			await writeFile(path.join(fixture.outside, marker), payload);
			fixture.link(fixture.outside, path.join(fixture.root, "DYTEST-link"));
			const directory = await fixture.open();
			const found = await namedFiles(
				marker,
				fixture.root,
				false,
				undefined,
				undefined,
				() => 1,
				async () => directory,
			);
			expect(found).toEqual([marker, `DYTEST-nested/DYTEST-deep/${marker}`].toSorted());
			expect(directory.reads[0]?.entries).toContainEqual({ name: "DYTEST-link", kind: "link" });
			expect(directory.reads.map(({ components }) => components)).toEqual([
				[],
				["DYTEST-nested"],
				["DYTEST-nested", "DYTEST-deep"],
			]);
			expect(directory.currents).toEqual([true]);
			expect(directory.closeFulfilled).toBe(true);
			expect(await readFile(path.join(fixture.outside, marker), "utf8")).toBe(payload);
		});
	});

	it("includes a matching link name without treating its target as a descendant", async () => {
		await withFixture(async (fixture) => {
			await writeFile(path.join(fixture.outside, marker), payload);
			fixture.link(fixture.outside, path.join(fixture.root, marker));
			const directory = await fixture.open();
			expect(
				await namedFiles(
					marker,
					fixture.root,
					false,
					undefined,
					undefined,
					() => 1,
					async () => directory,
				),
			).toEqual([marker]);
			expect(directory.reads[0]?.entries).toContainEqual({ name: marker, kind: "link" });
			expect(directory.reads.map(({ components }) => components)).toEqual([[]]);
			expect(directory.closeFulfilled).toBe(true);
		});
	});

	it("refuses a real queued-directory substitution after listing and before child admission", async () => {
		await withFixture(async (fixture) => {
			const queued = path.join(fixture.root, "DYTEST-queued");
			await mkdir(queued);
			await writeFile(path.join(queued, "DYTEST-original-only"), payload);
			await writeFile(path.join(fixture.outside, marker), payload);
			await writeFile(path.join(fixture.outside, "DYTEST-outside-only"), payload);
			const directory = await fixture.open();
			let capacityCalls = 0;
			let substituted = false;
			const capacity = (): number => {
				capacityCalls += 1;
				if (capacityCalls === 2) {
					expect(directory.reads).toHaveLength(1);
					expect(directory.reads[0]?.settled).toBe(true);
					expect(directory.reads[0]?.components).toEqual([]);
					expect(directory.reads[0]?.entries).toContainEqual({
						name: "DYTEST-queued",
						kind: "directory",
					});
					renameSync(queued, fixture.parked);
					fixture.link(fixture.outside, queued);
					substituted = true;
				}
				return 1;
			};
			await expect(
				namedFiles(
					marker,
					fixture.root,
					false,
					undefined,
					undefined,
					capacity,
					async () => directory,
				),
			).rejects.toThrow("file-name inventory failed");
			expect(capacityCalls).toBeGreaterThanOrEqual(2);
			expect(substituted).toBe(true);
			expect(
				directory.reads
					.flatMap(({ entries }) => entries ?? [])
					.some(({ name }) => name === "DYTEST-outside-only"),
			).toBe(false);
			expect(directory.closeFulfilled).toBe(true);
			expect(await readFile(path.join(fixture.parked, "DYTEST-original-only"), "utf8")).toBe(
				payload,
			);
			expect(await readFile(path.join(fixture.outside, marker), "utf8")).toBe(payload);
		});
	});

	it("binds successful reads to the original root and reports its replaced pathname as noncurrent", async () => {
		await withFixture(async (fixture) => {
			await writeFile(path.join(fixture.root, "DYTEST-original-only"), payload);
			await writeFile(path.join(fixture.outside, "DYTEST-replacement-only"), payload);
			const directory = await fixture.open();
			expect(names(await directory.read([]))).toEqual(["DYTEST-original-only"]);
			renameSync(fixture.root, fixture.parked);
			fixture.link(fixture.outside, fixture.root);
			expect(await directory.current()).toBe(false);
			// Replacement may cause a refusal; any successful read must still name the original object.
			const after = await Promise.resolve()
				.then(() => directory.read([]))
				.then(
					(entries) => ({ kind: "read" as const, entries }),
					(error: unknown) => ({ kind: "refused" as const, error }),
				);
			if (after.kind === "read") expect(names(after.entries)).toEqual(["DYTEST-original-only"]);
			else expect(after.error).toBeInstanceOf(Error);
			await directory.close();
			expect(directory.closeFulfilled).toBe(true);
		});
	});

	it("refuses namedFiles results when the actual root currentness check sees replacement", async () => {
		await withFixture(async (fixture) => {
			await writeFile(path.join(fixture.root, marker), payload);
			await writeFile(path.join(fixture.outside, "DYTEST-replacement-only"), payload);
			const directory = await fixture.open();
			let calls = 0;
			let replaced = false;
			const capacity = (): number => {
				calls += 1;
				if (calls === 2) {
					expect(directory.reads).toHaveLength(1);
					expect(names(directory.reads[0]?.entries ?? [])).toEqual([marker]);
					renameSync(fixture.root, fixture.parked);
					fixture.link(fixture.outside, fixture.root);
					replaced = true;
				}
				return 1;
			};
			await expect(
				namedFiles(
					marker,
					fixture.root,
					false,
					undefined,
					undefined,
					capacity,
					async () => directory,
				),
			).rejects.toThrow("file-name inventory failed");
			expect(replaced).toBe(true);
			expect(directory.currents).toEqual([false]);
			expect(directory.closeFulfilled).toBe(true);
		});
	});

	it("stops read and stat admission, settles an admitted operation, and fulfills its actual close", async () => {
		await withFixture(async (fixture) => {
			await writeFile(path.join(fixture.root, marker), payload);
			const directory = await fixture.open();
			const admitted = directory.read([]).then(
				(entries) => ({ kind: "read" as const, entries }),
				(error: unknown) => ({ kind: "refused" as const, error }),
			);
			directory.stop();
			await expect(Promise.resolve().then(() => directory.read([]))).rejects.toBeInstanceOf(Error);
			await expect(Promise.resolve().then(() => directory.stat([marker]))).rejects.toBeInstanceOf(
				Error,
			);
			const [beforeStop] = await Promise.all([admitted, directory.close()]);
			if (beforeStop.kind === "read") expect(names(beforeStop.entries)).toEqual([marker]);
			else expect(beforeStop.error).toBeInstanceOf(Error);
			expect(directory.operationsSettledAtClose).toBe(true);
			expect(directory.closeFulfilled).toBe(true);
			// Promise admission does not assert that kernel I/O was still in flight at stop().
		});
	});

	it("refuses callback-reentrant admission without dispatching its captured native resource", async () => {
		await withFixture(async (fixture) => {
			await writeFile(path.join(fixture.root, marker), payload);
			const control = await fixture.open();
			let controlId: number | undefined;
			let trapId: number | undefined;
			let controlBefore = 0;
			let trapBefore = 0;
			let controlInit = 0;
			let trapInit = 0;
			let controlArmed = false;
			let trapArmed = false;
			const hookErrors: unknown[] = [];
			const passive = createHook({
				before(asyncId) {
					if (asyncId === controlId) controlBefore += 1;
					if (asyncId === trapId) trapBefore += 1;
				},
			});
			const controlHook = createHook({
				init(asyncId, type) {
					if (!controlArmed || type !== "DirectoryInventory" || controlInit !== 0) return;
					controlArmed = false;
					controlInit += 1;
					controlId = asyncId;
					try {
						controlHook.disable();
					} catch (error) {
						hookErrors.push(error);
					}
				},
			});
			let trapHook: ReturnType<typeof createHook> | undefined;
			let primaryFailed = false;
			let primaryFailure: unknown;
			const cleanupFailures: unknown[] = [];
			try {
				passive.enable();
				let controlRead: Promise<readonly InventoryDirectoryEntry[]> | undefined;
				let controlError: unknown;
				try {
					controlHook.enable();
					controlArmed = true;
					try {
						controlRead = control.readDirect([]);
					} catch (error) {
						controlError = error;
					}
				} finally {
					controlArmed = false;
					try {
						controlHook.disable();
					} catch (error) {
						hookErrors.push(error);
					}
				}
				control.observeDirectReads();
				const controlResults = await Promise.allSettled(controlRead ? [controlRead] : []);
				await control.close();
				await Promise.all([...control.operations, ...control.closes]);
				expect(hookErrors).toEqual([]);
				expect(controlError).toBeUndefined();
				expect(controlInit).toBe(1);
				expect(controlBefore).toBeGreaterThan(0);
				expect(controlResults[0]?.status).toBe("fulfilled");
				const result = controlResults[0];
				if (result?.status === "fulfilled") expect(names(result.value)).toEqual([marker]);
				expect(control.closeFulfilled).toBe(true);

				const directory = await fixture.open();
				let operation: Promise<readonly InventoryDirectoryEntry[]> | undefined;
				let operationError: unknown;
				let hookClose: Promise<void> | undefined;
				trapHook = createHook({
					init(asyncId, type) {
						if (!trapArmed || type !== "DirectoryInventory" || trapInit !== 0) return;
						trapArmed = false;
						trapInit += 1;
						trapId = asyncId;
						try {
							trapHook?.disable();
						} catch (error) {
							hookErrors.push(error);
						}
						try {
							directory.stop();
						} catch (error) {
							hookErrors.push(error);
						}
						try {
							hookClose = directory.closeDirect();
						} catch (error) {
							hookErrors.push(error);
						}
					},
				});
				try {
					trapHook.enable();
					trapArmed = true;
					try {
						operation = directory.readDirect([]);
					} catch (error) {
						operationError = error;
					}
				} finally {
					trapArmed = false;
					try {
						trapHook.disable();
					} catch (error) {
						hookErrors.push(error);
					}
				}
				// Promise observers are installed only after the synchronous init-hook scope ends.
				directory.observeDirectReads();
				if (directory.closeCalls === 0) {
					try {
						directory.closeDirect();
					} catch (error) {
						hookErrors.push(error);
					}
				}
				directory.observeCloses();
				const outcomes = await Promise.allSettled([
					...(operation ? [operation] : []),
					...new Set(directory.originalCloses),
					...directory.operations,
					...directory.closes,
				]);
				expect(hookErrors).toEqual([]);
				expect(trapInit).toBe(1);
				expect(trapId).not.toBe(controlId);
				expect(trapBefore).toBe(0);
				if (operation) {
					expect(outcomes[0]?.status).toBe("rejected");
					const outcome = outcomes[0];
					if (outcome?.status === "rejected") expect(outcome.reason).toBeInstanceOf(Error);
				} else expect(operationError).toBeInstanceOf(Error);
				expect(hookClose).toBe(directory.originalCloses[0]);
				expect(directory.originalCloses).toHaveLength(1);
				expect(directory.closeFulfilled).toBe(true);
				await expect(Promise.resolve().then(() => directory.read([]))).rejects.toBeInstanceOf(
					Error,
				);
				await expect(Promise.resolve().then(() => directory.stat([marker]))).rejects.toBeInstanceOf(
					Error,
				);
				// These counters observe own-ID Node callback dispatch, not kernel I/O absence.
			} catch (error) {
				primaryFailed = true;
				primaryFailure = error;
			} finally {
				controlArmed = false;
				trapArmed = false;
				const cleanupHookStart = hookErrors.length;
				let settlements: PromiseSettledResult<void>[] = [];
				try {
					settlements = await fixture.settleDirectories();
				} catch (error) {
					cleanupFailures.push(error);
				} finally {
					try {
						controlHook.disable();
					} catch (error) {
						hookErrors.push(error);
					}
					try {
						trapHook?.disable();
					} catch (error) {
						hookErrors.push(error);
					}
					try {
						passive.disable();
					} catch (error) {
						hookErrors.push(error);
					}
				}
				cleanupFailures.push(
					...settlements.flatMap((result) => (result.status === "rejected" ? [result.reason] : [])),
					...hookErrors.slice(cleanupHookStart),
				);
			}
			if (primaryFailed && cleanupFailures.length !== 0)
				throw new AggregateError(
					[primaryFailure, ...cleanupFailures],
					"DYTEST callback case and resource settlement failed",
				);
			if (primaryFailed) throw primaryFailure;
			if (cleanupFailures.length !== 0)
				throw new AggregateError(cleanupFailures, "DYTEST callback resource settlement failed");
			expect(hookErrors).toEqual([]);
			expect(trapBefore).toBe(0);
		});
	});

	it("allocates no close-time Promise and returns the same original close Promise", async () => {
		await withFixture(async (fixture) => {
			await writeFile(path.join(fixture.root, marker), payload);
			const directory = await fixture.open();
			expect(names(await directory.read([]))).toEqual([marker]);
			let promiseInit = 0;
			let promiseArmed = false;
			const hookErrors: unknown[] = [];
			let original: Promise<void> | undefined;
			let repeated: Promise<void> | undefined;
			const callErrors: unknown[] = [];
			const hook = createHook({
				init(_asyncId, type) {
					if (!promiseArmed || type !== "PROMISE" || promiseInit !== 0) return;
					promiseArmed = false;
					promiseInit += 1;
					try {
						hook.disable();
					} catch (error) {
						hookErrors.push(error);
					}
				},
			});
			try {
				hook.enable();
				promiseArmed = true;
				try {
					original = directory.closeDirect();
				} catch (error) {
					callErrors.push(error);
				}
			} finally {
				promiseArmed = false;
				try {
					hook.disable();
				} catch (error) {
					hookErrors.push(error);
				}
			}
			// Repeated genuine calls are outside the hook; no reentrant close is manufactured.
			if (original) {
				try {
					repeated = directory.closeDirect();
				} catch (error) {
					callErrors.push(error);
				}
			}
			directory.observeCloses();
			await Promise.allSettled([
				...new Set(directory.originalCloses),
				...directory.operations,
				...directory.closes,
			]);
			expect(hookErrors).toEqual([]);
			expect(callErrors).toEqual([]);
			expect(promiseInit).toBe(0);
			expect(original).toBeDefined();
			expect(repeated).toBe(original);
			expect(new Set(directory.originalCloses).size).toBe(1);
			expect(directory.closeFulfilled).toBe(true);
			await expect(Promise.resolve().then(() => directory.read([]))).rejects.toBeInstanceOf(Error);
			await expect(Promise.resolve().then(() => directory.stat([marker]))).rejects.toBeInstanceOf(
				Error,
			);
			// This proves allocation absence/Promise identity, not positive S4 reentry execution.
		});
	});
});
