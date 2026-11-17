import path from "node:path";
import { setImmediate, setTimeout as sleep } from "node:timers/promises";
import { describe, expect, it } from "vitest";
import type { InventoryDirectory, OpenInventoryDirectory } from "../lib/inventory-directory.ts";
import { type ListedWorktree, namedFiles, namedWorktreeFiles } from "../lib/workspace-policy.ts";

type Kind = "directory" | "link" | "other";
type ObjectNode =
	| {
			readonly id: string;
			readonly kind: "directory";
			readonly children: Map<string, ObjectNode>;
			readonly accessible: boolean;
	  }
	| { readonly id: string; readonly kind: "link"; readonly target: DirectoryNode }
	| { readonly id: string; readonly kind: "other" };
type DirectoryNode = Extract<ObjectNode, { kind: "directory" }>;
type NamedKind = { readonly name: string; readonly kind: Kind };

const marker = ".gate-sentinel";
const fsError = (code: string): Error =>
	Object.assign(new Error("synthetic directory operation failed"), { code });
const relativeKey = (components: readonly string[]): string => components.join("/");
const rootName = (name: string): string =>
	path.resolve("inventory-directory-binding-synthetic", name);

class Gate {
	readonly entered = { value: false };
	private readonly release = Promise.withResolvers<void>();
	wait(): Promise<void> {
		this.entered.value = true;
		return this.release.promise;
	}
	open(): void {
		this.release.resolve();
	}
}

async function reached(condition: () => boolean): Promise<void> {
	for (let attempt = 0; attempt < 100; attempt += 1) {
		if (condition()) return;
		await sleep(5);
	}
	throw new Error("synthetic directory checkpoint was not reached");
}

function observe<T>(work: Promise<T>) {
	let settled = false;
	const outcome = work.then(
		(value) => {
			settled = true;
			return { ok: true as const, value };
		},
		(error: unknown) => {
			settled = true;
			return { ok: false as const, error };
		},
	);
	return {
		outcome,
		get settled() {
			return settled;
		},
	};
}

// Names map to mutable objects; acquired directory objects have stable identity.
// Links point at a separate object but acquisition below never follows them.
// These ports create no files, processes, OS handles, or physical-close receipts.
class DirectoryWorld {
	private nextIdentity = 0;
	readonly roots = new Map<string, ObjectNode>();
	readonly opened: string[] = [];
	readonly scopes: BoundDirectory[] = [];
	readonly enumerated: string[] = [];
	readonly outside = new Set<DirectoryNode>();
	readonly beforeAcquire = new Map<string, Gate>();
	readonly afterAcquire = new Map<string, Gate>();
	readonly gates: Gate[] = [];
	closeGate: Gate | undefined;
	onListed: ((components: readonly string[], object: DirectoryNode) => void) | undefined;

	directory(children: Readonly<Record<string, ObjectNode>> = {}, accessible = true): DirectoryNode {
		return {
			id: "directory-" + this.nextIdentity++,
			kind: "directory",
			children: new Map(Object.entries(children)),
			accessible,
		};
	}

	file(): ObjectNode {
		return { id: "other-" + this.nextIdentity++, kind: "other" };
	}

	link(target: DirectoryNode): ObjectNode {
		return { id: "link-" + this.nextIdentity++, kind: "link", target };
	}

	gate(): Gate {
		const gate = new Gate();
		this.gates.push(gate);
		return gate;
	}

	get outsideEnumerations(): number {
		return this.enumerated.filter((id) => [...this.outside].some((node) => node.id === id)).length;
	}

	// A counterfactual pathname lookup, used only to prove the mutation points
	// at the outside object. It does not enumerate anything or serve the port.
	followingTarget(absolute: string, components: readonly string[]): ObjectNode | undefined {
		let node = this.roots.get(absolute);
		for (const name of components) {
			if (node?.kind === "link") node = node.target;
			if (node?.kind !== "directory") return undefined;
			node = node.children.get(name);
		}
		return node?.kind === "link" ? node.target : node;
	}

	readonly open: OpenInventoryDirectory = async (absolute) => {
		this.opened.push(absolute);
		const object = this.roots.get(absolute);
		if (object === undefined) throw fsError("ENOENT");
		if (object.kind === "link") throw fsError("ELOOP");
		if (object.kind !== "directory") throw fsError("ENOTDIR");
		if (!object.accessible) throw fsError("EACCES");
		const scope = new BoundDirectory(this, absolute, object);
		this.scopes.push(scope);
		return scope;
	};

	releaseAll(): void {
		for (const gate of this.gates) gate.open();
	}
}

class BoundDirectory implements InventoryDirectory {
	private readonly world: DirectoryWorld;
	readonly absolute: string;
	readonly original: DirectoryNode;
	readonly attempts: string[] = [];
	readonly acquisitions: { readonly key: string; readonly id: string }[] = [];
	private readonly operations = new Set<Promise<unknown>>();
	private closeResult: Promise<void> | undefined;
	private closing = false;
	stopped = false;
	closed = false;
	stopCalls = 0;
	closeCalls = 0;
	currentCalls = 0;

	constructor(world: DirectoryWorld, absolute: string, original: DirectoryNode) {
		this.world = world;
		this.absolute = absolute;
		this.original = original;
	}

	get active(): number {
		return this.operations.size;
	}

	private track<T>(operation: () => Promise<T>): Promise<T> {
		if (this.stopped || this.closing || this.closed) return Promise.reject(fsError("ECANCELED"));
		const result = operation();
		this.operations.add(result);
		void result.then(
			() => this.operations.delete(result),
			() => this.operations.delete(result),
		);
		return result;
	}

	private acquire(components: readonly string[]): DirectoryNode {
		let directory = this.original;
		for (const name of components) {
			if (name === "" || name === "." || name === ".." || /[/\\\0]/.test(name))
				throw fsError("EINVAL");
			const child = directory.children.get(name);
			if (child === undefined) throw fsError("ENOENT");
			if (child.kind === "link") throw fsError("ELOOP");
			if (child.kind !== "directory") throw fsError("ENOTDIR");
			if (!child.accessible) throw fsError("EACCES");
			directory = child;
		}
		return directory;
	}

	readonly read = (components: readonly string[]): Promise<readonly NamedKind[]> => {
		const copied = [...components];
		const key = relativeKey(copied);
		this.attempts.push(key);
		return this.track(async () => {
			const before = this.world.beforeAcquire.get(key);
			if (before !== undefined) await before.wait();
			if (this.stopped) throw fsError("ECANCELED");
			const object = this.acquire(copied);
			this.acquisitions.push({ key, id: object.id });
			const after = this.world.afterAcquire.get(key);
			if (after !== undefined) await after.wait();
			if (this.stopped) throw fsError("ECANCELED");
			const entries = Object.freeze(
				[...object.children].map(([name, child]) => Object.freeze({ name, kind: child.kind })),
			);
			this.world.enumerated.push(object.id);
			this.world.onListed?.(copied, object);
			return entries;
		});
	};

	readonly stat = (components: readonly string[]): Promise<Kind> =>
		this.track(async () => {
			if (components.length === 0) return this.original.kind;
			const parent = this.acquire(components.slice(0, -1));
			const leaf = components[components.length - 1];
			if (leaf === undefined) throw fsError("EINVAL");
			const object = parent.children.get(leaf);
			if (object === undefined) throw fsError("ENOENT");
			return object.kind;
		});

	readonly current = (): Promise<boolean> =>
		this.track(async () => {
			this.currentCalls += 1;
			return this.world.roots.get(this.absolute) === this.original;
		});

	readonly stop = (): void => {
		this.stopCalls += 1;
		this.stopped = true;
	};

	readonly close = (): Promise<void> => {
		if (this.closeResult !== undefined) return this.closeResult;
		this.closeCalls += 1;
		this.closing = true;
		this.stop();
		this.closeResult = (async () => {
			await Promise.allSettled([...this.operations]);
			await this.world.closeGate?.wait();
			this.closed = true;
		})();
		return this.closeResult;
	};
}

function fixture(name: string) {
	const world = new DirectoryWorld();
	const root = rootName(name);
	const directory = world.directory();
	world.roots.set(root, directory);
	const outside = world.directory({ [marker]: world.file() });
	world.outside.add(outside);
	return { world, root, directory, outside };
}

function walk(world: DirectoryWorld, root: string, capacity = 1): Promise<string[]> {
	return namedFiles(marker, root, false, undefined, undefined, () => capacity, world.open);
}

function worktreeWalk(
	world: DirectoryWorld,
	root: string,
	refresh: () => Promise<readonly ListedWorktree[]>,
): Promise<string[]> {
	return namedWorktreeFiles(
		marker,
		root,
		refresh,
		false,
		undefined,
		undefined,
		() => 1,
		world.open,
	);
}

function closed(world: DirectoryWorld): void {
	expect(world.scopes.length).toBeGreaterThan(0);
	for (const scope of world.scopes) {
		expect(scope.closed).toBe(true);
		expect(scope.active).toBe(0);
		expect(scope.closeCalls).toBe(1);
	}
	expect(world.outsideEnumerations).toBe(0);
}

describe("workspace directory binding", () => {
	it("returns the complete stable marker set through the supplied bound scope", async () => {
		const { world, root, directory } = fixture("stable");
		directory.children.set(marker, world.file());
		directory.children.set(".ignored", world.directory({ [marker]: world.file() }));
		directory.children.set(
			"nested",
			world.directory({
				".git": world.directory(),
				deeper: world.directory({ [marker]: world.file() }),
			}),
		);
		expect(await walk(world, root, 2)).toEqual([
			".gate-sentinel",
			".ignored/.gate-sentinel",
			"nested/deeper/.gate-sentinel",
		]);
		expect(world.opened).toEqual([root]);
		expect(world.enumerated).toHaveLength(5);
		closed(world);
	});

	it("names a static marker link without descending into its outside target", async () => {
		const { world, root, directory, outside } = fixture("static-link");
		directory.children.set(marker, world.link(outside));
		directory.children.set("linked", world.link(outside));
		directory.children.set("inside", world.directory({ [marker]: world.file() }));
		expect(await walk(world, root)).toEqual([".gate-sentinel", "inside/.gate-sentinel"]);
		expect(world.scopes[0]?.attempts).toEqual(["", "inside"]);
		closed(world);
	});

	it("refuses an ordinary captured entry replaced by a link before its acquisition", async () => {
		const { world, root, directory, outside } = fixture("captured-replacement");
		const original = world.directory({ [marker]: world.file() });
		directory.children.set("child", original);
		world.onListed = (components) => {
			if (components.length === 0) directory.children.set("child", world.link(outside));
		};
		const result = await observe(walk(world, root)).outcome;
		expect(result.ok).toBe(false);
		expect(world.followingTarget(root, ["child"])).toBe(outside);
		expect(world.scopes[0]?.attempts).toContain("child");
		expect(world.enumerated).not.toContain(original.id);
		closed(world);
	});

	it("refuses a truly queued directory changed to a link while the first sibling is held", async () => {
		const { world, root, directory, outside } = fixture("queued-replacement");
		directory.children.set("held", world.directory());
		directory.children.set("queued", world.directory({ [marker]: world.file() }));
		const gate = world.gate();
		world.afterAcquire.set("held", gate);
		const result = observe(walk(world, root, 1));
		try {
			await reached(() => gate.entered.value);
			expect(world.scopes[0]?.attempts).toEqual(["", "held"]);
			directory.children.set("queued", world.link(outside));
			expect(world.followingTarget(root, ["queued"])).toBe(outside);
			gate.open();
			expect((await result.outcome).ok).toBe(false);
			expect(world.scopes[0]?.attempts).toContain("queued");
			closed(world);
		} finally {
			world.releaseAll();
			await result.outcome;
		}
	});

	it("keeps A bound through A-link-A schedules before and after acquisition", async () => {
		for (const phase of ["before", "after"] as const) {
			const { world, root, directory, outside } = fixture("aba-" + phase);
			const original = world.directory({ [marker]: world.file() });
			directory.children.set("child", original);
			const gate = world.gate();
			(phase === "before" ? world.beforeAcquire : world.afterAcquire).set("child", gate);
			let enumeratedDuringLink = false;
			world.onListed = (components, object) => {
				if (phase === "after" && relativeKey(components) === "child") {
					expect(world.followingTarget(root, components)).toBe(outside);
					expect(object).toBe(original);
					enumeratedDuringLink = true;
					directory.children.set("child", original);
				}
			};
			const result = observe(walk(world, root));
			try {
				await reached(() => gate.entered.value);
				directory.children.set("child", world.link(outside));
				expect(world.followingTarget(root, ["child"])).toBe(outside);
				if (phase === "before") directory.children.set("child", original);
				gate.open();
				expect(await result.outcome).toEqual({ ok: true, value: ["child/.gate-sentinel"] });
				expect(world.scopes[0]?.acquisitions).toContainEqual({ key: "child", id: original.id });
				expect(enumeratedDuringLink).toBe(phase === "after");
				closed(world);
			} finally {
				world.releaseAll();
				await result.outcome;
			}
		}
	});

	it("refuses a root whose fresh name resolves to a different directory identity", async () => {
		const { world, root, directory } = fixture("root-current");
		directory.children.set(marker, world.file());
		const replacement = world.directory();
		world.onListed = (components) => {
			if (components.length === 0) world.roots.set(root, replacement);
		};
		const result = await observe(
			worktreeWalk(world, root, async () => [{ directory: root, prunable: false }]),
		).outcome;
		expect(result.ok).toBe(false);
		expect(world.scopes[0]?.original).toBe(directory);
		expect(world.scopes[0]?.currentCalls).toBeGreaterThan(0);
		expect(world.enumerated).not.toContain(replacement.id);
		closed(world);
	});

	it("requires bound parent absence/currentness and fresh Git before accepting a missing root", async () => {
		for (const disposition of ["absent", "prunable", "registered", "empty"] as const) {
			const { world, root } = fixture("missing-" + disposition);
			const parent = path.dirname(root);
			const parentObject = world.directory({ unrelated: world.file() });
			world.roots.delete(root);
			world.roots.set(parent, parentObject);
			const refreshGate = world.gate();
			let refreshes = 0;
			const result = observe(
				worktreeWalk(world, root, async () => {
					refreshes += 1;
					await refreshGate.wait();
					if (disposition === "empty") return [];
					if (disposition === "absent")
						return [{ directory: rootName("other-" + disposition), prunable: false }];
					return [{ directory: root, prunable: disposition === "prunable" }];
				}),
			);
			try {
				await reached(() => refreshGate.entered.value);
				expect(world.opened).toContain(root);
				expect(world.opened.filter((absolute) => absolute === parent)).toHaveLength(1);
				expect(parentObject.children.has(path.basename(root))).toBe(false);
				expect(world.enumerated).toEqual([parentObject.id]);
				expect(world.scopes).toHaveLength(1);
				const parentScope = world.scopes[0];
				expect(parentScope?.original).toBe(parentObject);
				expect(parentScope?.attempts).toEqual([""]);
				expect(parentScope?.currentCalls).toBeGreaterThan(0);
				expect(parentScope?.closed).toBe(true);
				expect(parentScope?.closeCalls).toBe(1);
				expect(refreshes).toBe(1);
				expect(result.settled).toBe(false);
				refreshGate.open();
				const outcome = await result.outcome;
				if (disposition === "absent" || disposition === "prunable")
					expect(outcome).toEqual({ ok: true, value: [] });
				else expect(outcome.ok).toBe(false);
				closed(world);
			} finally {
				world.releaseAll();
				await result.outcome;
			}
		}

		for (const state of ["missing", "unreadable", "linked", "replaced"] as const) {
			const { world, root, outside } = fixture("parent-" + state);
			const parent = path.dirname(root);
			const parentObject = world.directory({}, state !== "unreadable");
			world.roots.delete(root);
			if (state === "linked") world.roots.set(parent, world.link(outside));
			else if (state !== "missing") world.roots.set(parent, parentObject);
			if (state === "replaced") {
				world.onListed = (components, object) => {
					if (components.length !== 0 || object !== parentObject) return;
					const recreatedRoot = world.directory({ [marker]: world.file() });
					world.roots.set(
						parent,
						world.directory({
							[path.basename(root)]: recreatedRoot,
						}),
					);
					world.roots.set(root, recreatedRoot);
				};
			}
			let refreshes = 0;
			const result = await observe(
				worktreeWalk(world, root, async () => {
					refreshes += 1;
					return [{ directory: rootName("unrelated-registration"), prunable: false }];
				}),
			).outcome;
			expect(result.ok).toBe(false);
			expect(refreshes).toBe(0);
			expect(world.opened).toContain(parent);
			expect(world.outsideEnumerations).toBe(0);
			if (state === "replaced") {
				expect(world.enumerated).toEqual([parentObject.id]);
				expect(world.scopes).toHaveLength(1);
				expect(world.scopes[0]?.currentCalls).toBeGreaterThan(0);
				closed(world);
			} else {
				expect(world.enumerated).toEqual([]);
				expect(world.scopes).toEqual([]);
			}
		}
	});

	it("awaits the held original close after stop on both success and refusal", async () => {
		for (const failure of [false, true]) {
			const { world, root, directory, outside } = fixture("close-" + failure);
			directory.children.set(marker, world.file());
			if (failure) {
				directory.children.set("child", world.directory());
				world.onListed = (components) => {
					if (components.length === 0) directory.children.set("child", world.link(outside));
				};
			}
			const gate = world.gate();
			world.closeGate = gate;
			const result = observe(walk(world, root));
			try {
				await reached(() => gate.entered.value);
				const scope = world.scopes[0];
				expect(scope).toBeDefined();
				if (scope === undefined) throw new Error("missing synthetic bound scope");
				scope.stop();
				await setImmediate();
				await setImmediate();
				expect(scope.stopped).toBe(true);
				expect(scope.closed).toBe(false);
				expect(result.settled).toBe(false);
				expect(scope.closeCalls).toBe(1);
				gate.open();
				const outcome = await result.outcome;
				expect(outcome.ok).toBe(!failure);
				if (outcome.ok) expect(outcome.value).toEqual([".gate-sentinel"]);
				closed(world);
			} finally {
				world.releaseAll();
				await result.outcome;
			}
		}
	});
});
