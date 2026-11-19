import { describe, expect, it } from "vitest";
import {
	beforeRemove,
	createInstanceLifecycleRegistry,
	destinationData,
	InstanceLifecycleError,
	type InstanceLifecycleRegistry,
	registerBeforeRemove,
	registerInstanceHosts,
} from "../../src/ai/instances/lifecycle.ts";

type Instance = { readonly id: string; readonly host: string };
type NoticeHandler = (instance: Instance) => string | undefined | PromiseLike<string | undefined>;
type HostsFor = (instance: Instance) => readonly string[] | PromiseLike<readonly string[]>;
type Outcome<T> =
	| { readonly ok: true; readonly value: T }
	| { readonly ok: false; readonly error: unknown };

const instance: Instance = Object.freeze({ id: "first", host: "first.example" });

function deferred<T>() {
	let resolve!: (value: T | PromiseLike<T>) => void;
	let reject!: (reason: unknown) => void;
	const promise = new Promise<T>((accept, refuse) => {
		resolve = accept;
		reject = refuse;
	});
	return { promise, resolve, reject };
}

function nextTurn(): Promise<void> {
	return new Promise((resolve) => {
		setImmediate(resolve);
	});
}

function observe<T>(promise: Promise<T>): Promise<Outcome<T>> {
	return promise.then(
		(value): Outcome<T> => ({ ok: true, value }),
		(error: unknown): Outcome<T> => ({ ok: false, error }),
	);
}

function success<T>(result: Outcome<T>): T {
	expect(result.ok).toBe(true);
	if (!result.ok) throw new Error("Expected successful lifecycle dispatch");
	return result.value;
}

function failure<T>(result: Outcome<T>): InstanceLifecycleError {
	expect(result.ok).toBe(false);
	if (result.ok) throw new Error("Expected failed lifecycle dispatch");
	expect(result.error).toBeInstanceOf(InstanceLifecycleError);
	if (!(result.error instanceof InstanceLifecycleError)) {
		throw new Error("Expected InstanceLifecycleError");
	}
	expect(result.error.name).toBe("InstanceLifecycleError");
	expect(result.error.message).toBe("Instance lifecycle hooks failed");
	expect(Object.hasOwn(result.error, "cause")).toBe(false);
	expect(Object.hasOwn(result.error, "reason")).toBe(false);
	expect(Object.isFrozen(result.error.failures)).toBe(true);
	for (const item of result.error.failures) {
		expect(Object.isFrozen(item)).toBe(true);
	}
	expect(Object.isFrozen(result.error.notices)).toBe(true);
	return result.error;
}

describe("instance lifecycle registry", () => {
	it("returns frozen empty results and copies plugin egress data", async () => {
		const registry = createInstanceLifecycleRegistry<Instance>();
		const notices = await registry.beforeRemove(instance);
		expect(notices).toEqual([]);
		expect(Object.isFrozen(notices)).toBe(true);

		const pluginEgress = ["plugin.example", "plugin.example"];
		const result = await registry.destinationData(instance, pluginEgress);
		expect(result).toEqual({
			pluginEgress: ["plugin.example", "plugin.example"],
			instanceHosts: [],
		});
		expect(result.pluginEgress).not.toBe(pluginEgress);
		expect(Object.isFrozen(result)).toBe(true);
		expect(Object.isFrozen(result.pluginEgress)).toBe(true);
		expect(Object.isFrozen(result.instanceHosts)).toBe(true);
		pluginEgress.push("later.example");
		expect(result.pluginEgress).toEqual(["plugin.example", "plugin.example"]);
	});

	it("dispatches every kind in global order and preserves duplicate registrations and notices", async () => {
		const registry = createInstanceLifecycleRegistry<Instance>();
		const calls: string[] = [];
		const repeated: NoticeHandler = (received) => {
			expect(received).toBe(instance);
			calls.push("repeated");
			return "same-notice";
		};
		registry.registerBeforeRemove("kind-a", repeated);
		registry.registerBeforeRemove("kind-b", (received) => {
			expect(received).toBe(instance);
			calls.push("middle");
			return undefined;
		});
		registry.registerBeforeRemove("kind-a", repeated);
		registry.registerBeforeRemove("kind-c", () => Promise.resolve(" "));

		expect(await registry.beforeRemove(instance)).toEqual(["same-notice", "same-notice", " "]);
		expect(calls).toEqual(["repeated", "middle", "repeated"]);
	});

	it("starts every removal callback and waits for the last settlement, preserving registration order", async () => {
		const registry = createInstanceLifecycleRegistry<Instance>();
		const first = deferred<string>();
		const last = deferred<string>();
		const calls: string[] = [];
		registry.registerBeforeRemove("first", () => {
			calls.push("first");
			return first.promise;
		});
		registry.registerBeforeRemove("middle", () => {
			calls.push("middle");
			return "middle-notice";
		});
		registry.registerBeforeRemove("last", () => {
			calls.push("last");
			return last.promise;
		});
		let settled = false;
		const task = observe(registry.beforeRemove(instance));
		void task.then(() => {
			settled = true;
		});
		try {
			expect(calls).toEqual(["first", "middle", "last"]);
			last.resolve("last-notice");
			await nextTurn();
			expect(settled).toBe(false);
			first.resolve("first-notice");
			expect(success(await task)).toEqual(["first-notice", "middle-notice", "last-notice"]);
		} finally {
			first.resolve("first-notice");
			last.resolve("last-notice");
			await task;
		}
	});

	it("settles every removal callback after throws and rejections, retaining only sanitized failures", async () => {
		const registry = createInstanceLifecycleRegistry<Instance>();
		const gate = deferred<string>();
		const calls: string[] = [];
		const secretReason = { detail: "callback-private-detail" };
		registry.registerBeforeRemove("throws", () => {
			calls.push("throws");
			throw secretReason;
		});
		registry.registerBeforeRemove("rejects", () => {
			calls.push("rejects");
			return Promise.reject(secretReason);
		});
		registry.registerBeforeRemove("pending", () => {
			calls.push("pending");
			return gate.promise;
		});
		registry.registerBeforeRemove("last", () => {
			calls.push("last");
			return "last-notice";
		});
		let settled = false;
		const task = observe(registry.beforeRemove(instance));
		void task.then(() => {
			settled = true;
		});
		try {
			expect(calls).toEqual(["throws", "rejects", "pending", "last"]);
			await nextTurn();
			expect(settled).toBe(false);
			gate.resolve("pending-notice");
			const error = failure(await task);
			expect(error.failures).toEqual([
				{ kind: "throws", code: "callback-rejected" },
				{ kind: "rejects", code: "callback-rejected" },
			]);
			expect(error.notices).toEqual(["pending-notice", "last-notice"]);
			expect(JSON.stringify(error)).not.toContain(secretReason.detail);
		} finally {
			gate.resolve("pending-notice");
			await task;
		}
	});

	it("rejects malformed notice results while preserving valid void and whitespace results", async () => {
		const registry = createInstanceLifecycleRegistry<Instance>();
		const malformed: unknown[] = ["", null, 7, false, [], {}];
		for (const [ordinal, value] of malformed.entries()) {
			registry.registerBeforeRemove(
				`invalid-${ordinal}`,
				(() => value) as unknown as NoticeHandler,
			);
		}
		registry.registerBeforeRemove("void", () => undefined);
		registry.registerBeforeRemove("valid", () => " ");
		const error = failure(await observe(registry.beforeRemove(instance)));
		expect(error.failures).toEqual(
			malformed.map((_, ordinal) => ({
				kind: `invalid-${ordinal}`,
				code: "invalid-result",
			})),
		);
		expect(error.notices).toEqual([" "]);
	});

	it("unregisters the exact registration idempotently, including repeated callbacks", async () => {
		const registry = createInstanceLifecycleRegistry<Instance>();
		const notice: NoticeHandler = () => "duplicate";
		const hosts: HostsFor = () => ["duplicate.example"];
		const removeNotice = registry.registerBeforeRemove("same", notice);
		registry.registerBeforeRemove("same", notice);
		const removeHosts = registry.registerInstanceHosts("same", hosts);
		registry.registerInstanceHosts("same", hosts);
		removeNotice();
		removeNotice();
		removeHosts();
		removeHosts();
		expect(await registry.beforeRemove(instance)).toEqual(["duplicate"]);
		expect(await registry.destinationData(instance, [])).toEqual({
			pluginEgress: [],
			instanceHosts: ["duplicate.example"],
		});
		registry.registerBeforeRemove("same", notice);
		registry.registerInstanceHosts("same", hosts);
		removeNotice();
		removeHosts();
		expect(await registry.beforeRemove(instance)).toEqual(["duplicate", "duplicate"]);
		expect((await registry.destinationData(instance, [])).instanceHosts).toEqual([
			"duplicate.example",
			"duplicate.example",
		]);
	});

	it("keeps the removal snapshot but refuses any same-family registration changes, even if undone", async () => {
		const registry = createInstanceLifecycleRegistry<Instance>();
		const gate = deferred<string>();
		const calls: string[] = [];
		registry.registerBeforeRemove("waiting", () => gate.promise);
		const removeLast = registry.registerBeforeRemove("last", () => {
			calls.push("last");
			return "last-notice";
		});
		const task = observe(registry.beforeRemove(instance));
		try {
			removeLast();
			const removeAdded = registry.registerBeforeRemove("added", () => {
				calls.push("added");
				return "added-notice";
			});
			removeAdded();
			gate.resolve("waiting-notice");
			const error = failure(await task);
			expect(calls).toEqual(["last"]);
			expect(error.notices).toEqual(["waiting-notice", "last-notice"]);
			expect(error.failures).toEqual([{ kind: null, code: "registrations-changed" }]);
		} finally {
			gate.resolve("waiting-notice");
			await task;
		}
	});

	it("detects registration changes made synchronously by a snapshot callback", async () => {
		const registry = createInstanceLifecycleRegistry<Instance>();
		const calls: string[] = [];
		registry.registerBeforeRemove("first", () => {
			calls.push("first");
			registry.registerBeforeRemove("new", () => {
				calls.push("new");
			});
			return "first-notice";
		});
		registry.registerBeforeRemove("last", () => {
			calls.push("last");
		});
		const error = failure(await observe(registry.beforeRemove(instance)));
		expect(calls).toEqual(["first", "last"]);
		expect(error.notices).toEqual(["first-notice"]);
		expect(error.failures).toEqual([{ kind: null, code: "registrations-changed" }]);
	});

	it("ignores host-only registration changes during removal dispatch", async () => {
		const registry = createInstanceLifecycleRegistry<Instance>();
		const gate = deferred<string>();
		registry.registerBeforeRemove("waiting", () => gate.promise);
		const task = observe(registry.beforeRemove(instance));
		try {
			const unregister = registry.registerInstanceHosts("hosts", () => []);
			unregister();
			gate.resolve("notice");
			expect(success(await task)).toEqual(["notice"]);
		} finally {
			gate.resolve("notice");
			await task;
		}
	});

	it("does not change either family revision when an already-disposed registration is disposed again", async () => {
		const registry = createInstanceLifecycleRegistry<Instance>();
		const removeNotice = registry.registerBeforeRemove("old", () => "old");
		const removeHosts = registry.registerInstanceHosts("old", () => ["old.example"]);
		removeNotice();
		removeHosts();
		const noticeGate = deferred<string>();
		const hostsGate = deferred<readonly string[]>();
		registry.registerBeforeRemove("waiting", () => noticeGate.promise);
		registry.registerInstanceHosts("waiting", () => hostsGate.promise);
		const noticeTask = observe(registry.beforeRemove(instance));
		const hostsTask = observe(registry.destinationData(instance, []));
		try {
			removeNotice();
			removeHosts();
			noticeGate.resolve("notice");
			hostsGate.resolve(["host.example"]);
			expect(success(await noticeTask)).toEqual(["notice"]);
			expect(success(await hostsTask).instanceHosts).toEqual(["host.example"]);
		} finally {
			noticeGate.resolve("notice");
			hostsGate.resolve(["host.example"]);
			await noticeTask;
			await hostsTask;
		}
	});

	it("evaluates all host kinds against the original instance freshly and copies the ordered results", async () => {
		const registry = createInstanceLifecycleRegistry<Instance>();
		const seen: Instance[] = [];
		const returned = ["duplicate.example", "duplicate.example"];
		registry.registerInstanceHosts("kind-a", (received) => {
			seen.push(received);
			return returned;
		});
		registry.registerInstanceHosts("kind-b", (received) => {
			seen.push(received);
			return Promise.resolve([received.host, " "]);
		});
		const plugin = ["plugin.example", "plugin.example"];
		const first = await registry.destinationData(instance, plugin);
		expect(first).toEqual({
			pluginEgress: ["plugin.example", "plugin.example"],
			instanceHosts: ["duplicate.example", "duplicate.example", "first.example", " "],
		});
		expect(seen).toEqual([instance, instance]);
		expect(seen[0]).toBe(instance);
		expect(seen[1]).toBe(instance);
		expect(Object.isFrozen(first)).toBe(true);
		expect(Object.isFrozen(first.pluginEgress)).toBe(true);
		expect(Object.isFrozen(first.instanceHosts)).toBe(true);
		expect(first.pluginEgress).not.toBe(plugin);
		expect(first.instanceHosts).not.toBe(returned);
		returned.push("later.example");
		plugin.push("later-plugin.example");
		expect(first.instanceHosts).not.toContain("later.example");
		expect(first.pluginEgress).not.toContain("later-plugin.example");
		const next: Instance = { id: "second", host: "second.example" };
		const second = await registry.destinationData(next, []);
		expect(seen[2]).toBe(next);
		expect(seen[3]).toBe(next);
		expect(second.instanceHosts).toEqual([
			"duplicate.example",
			"duplicate.example",
			"later.example",
			"second.example",
			" ",
		]);
	});

	it("snapshots plugin data immediately and each provider result before slower providers settle", async () => {
		const registry = createInstanceLifecycleRegistry<Instance>();
		const fast = ["fast.example"];
		const slow = deferred<readonly string[]>();
		registry.registerInstanceHosts("fast", () => fast);
		registry.registerInstanceHosts("slow", () => slow.promise);
		const plugin = ["plugin.example"];
		const task = observe(registry.destinationData(instance, plugin));
		try {
			plugin.push("late-plugin.example");
			await nextTurn();
			fast.push("late-provider.example");
			slow.resolve(["slow.example"]);
			expect(success(await task)).toEqual({
				pluginEgress: ["plugin.example"],
				instanceHosts: ["fast.example", "slow.example"],
			});
		} finally {
			slow.resolve([]);
			await task;
		}
	});

	it("copies a synchronous provider result before invoking the next provider", async () => {
		const registry = createInstanceLifecycleRegistry<Instance>();
		const first = ["first.example"];
		registry.registerInstanceHosts("first", () => first);
		registry.registerInstanceHosts("second", () => {
			first[0] = "changed.example";
			return ["second.example"];
		});
		expect((await registry.destinationData(instance, [])).instanceHosts).toEqual([
			"first.example",
			"second.example",
		]);
	});

	it("copies an async provider result on settlement while another provider remains pending", async () => {
		const registry = createInstanceLifecycleRegistry<Instance>();
		const first = deferred<readonly string[]>();
		const last = deferred<readonly string[]>();
		registry.registerInstanceHosts("first", () => first.promise);
		registry.registerInstanceHosts("last", () => last.promise);
		const hosts = ["settled.example"];
		const task = observe(registry.destinationData(instance, []));
		try {
			first.resolve(hosts);
			await nextTurn();
			hosts[0] = "mutated.example";
			last.resolve(["last.example"]);
			expect(success(await task).instanceHosts).toEqual(["settled.example", "last.example"]);
		} finally {
			first.resolve(hosts);
			last.resolve([]);
			await task;
		}
	});

	it("rejects impossible array lengths reported by proxies", async () => {
		for (const length of [NaN, -1, 0.5, Infinity, "1", undefined, 2 ** 32, 1n]) {
			const hosts = new Proxy(["first.example"], {
				get(target, key, receiver) {
					return key === "length" ? length : Reflect.get(target, key, receiver);
				},
			});
			const registry = createInstanceLifecycleRegistry<Instance>();
			registry.registerInstanceHosts("proxy", () => hosts);
			expect(failure(await observe(registry.destinationData(instance, []))).failures).toEqual([
				{ kind: "proxy", code: "invalid-result" },
			]);
			await expect(registry.destinationData(instance, hosts)).rejects.toThrowError(
				new TypeError("Plugin egress hosts must be nonempty strings"),
			);
		}
	});

	it("refuses sparse host lists in provider results and plugin data", async () => {
		const sparse = new Array<string>(2);
		sparse[1] = "second.example";
		const registry = createInstanceLifecycleRegistry<Instance>();
		registry.registerInstanceHosts("sparse", () => sparse);
		const error = failure(await observe(registry.destinationData(instance, [])));
		expect(error.failures).toEqual([{ kind: "sparse", code: "invalid-result" }]);
		await expect(registry.destinationData(instance, sparse)).rejects.toThrowError(
			new TypeError("Plugin egress hosts must be nonempty strings"),
		);
	});

	it("checks host registrations after copying results even when a getter changes them", async () => {
		const registry = createInstanceLifecycleRegistry<Instance>();
		const hosts = ["first.example"];
		Object.defineProperty(hosts, "0", {
			get() {
				const dispose = registry.registerInstanceHosts("temporary", () => []);
				dispose();
				return "first.example";
			},
		});
		registry.registerInstanceHosts("getter", () => hosts);
		const error = failure(await observe(registry.destinationData(instance, [])));
		expect(error.failures).toEqual([{ kind: null, code: "registrations-changed" }]);
	});

	it("forwards mutable instances without freezing or cloning caller-owned data", async () => {
		const registry = createInstanceLifecycleRegistry<Instance>();
		const mutable = { id: "mutable", host: "before.example" };
		registry.registerBeforeRemove("notice", (received) => {
			expect(received).toBe(mutable);
		});
		registry.registerInstanceHosts("hosts", (received) => {
			expect(received).toBe(mutable);
			return [received.host];
		});
		await registry.beforeRemove(mutable);
		await registry.destinationData(mutable, []);
		expect(Object.isFrozen(mutable)).toBe(false);
		mutable.host = "after.example";
		expect((await registry.destinationData(mutable, [])).instanceHosts).toEqual(["after.example"]);
	});

	it("starts all host callbacks and preserves registration order after out-of-order settlements", async () => {
		const registry = createInstanceLifecycleRegistry<Instance>();
		const first = deferred<readonly string[]>();
		const last = deferred<readonly string[]>();
		const calls: string[] = [];
		registry.registerInstanceHosts("first", () => {
			calls.push("first");
			return first.promise;
		});
		registry.registerInstanceHosts("middle", () => {
			calls.push("middle");
			return ["middle.example"];
		});
		registry.registerInstanceHosts("last", () => {
			calls.push("last");
			return last.promise;
		});
		let settled = false;
		const task = observe(registry.destinationData(instance, ["plugin.example"]));
		void task.then(() => {
			settled = true;
		});
		try {
			expect(calls).toEqual(["first", "middle", "last"]);
			last.resolve(["last.example"]);
			await nextTurn();
			expect(settled).toBe(false);
			first.resolve(["first.example"]);
			expect(success(await task).instanceHosts).toEqual([
				"first.example",
				"middle.example",
				"last.example",
			]);
		} finally {
			first.resolve(["first.example"]);
			last.resolve(["last.example"]);
			await task;
		}
	});

	it("awaits host callbacks after throws and rejections and sanitizes their reasons", async () => {
		const registry = createInstanceLifecycleRegistry<Instance>();
		const gate = deferred<readonly string[]>();
		const calls: string[] = [];
		const secretReason = "host-callback-private-detail";
		registry.registerInstanceHosts("throws", () => {
			calls.push("throws");
			throw new Error(secretReason);
		});
		registry.registerInstanceHosts("rejects", () => {
			calls.push("rejects");
			return Promise.reject(secretReason);
		});
		registry.registerInstanceHosts("waiting", () => {
			calls.push("waiting");
			return gate.promise;
		});
		let settled = false;
		const task = observe(registry.destinationData(instance, []));
		void task.then(() => {
			settled = true;
		});
		try {
			expect(calls).toEqual(["throws", "rejects", "waiting"]);
			await nextTurn();
			expect(settled).toBe(false);
			gate.resolve(["waiting.example"]);
			const error = failure(await task);
			expect(error.failures).toEqual([
				{ kind: "throws", code: "callback-rejected" },
				{ kind: "rejects", code: "callback-rejected" },
			]);
			expect(error.notices).toEqual([]);
			expect(JSON.stringify(error)).not.toContain(secretReason);
		} finally {
			gate.resolve(["waiting.example"]);
			await task;
		}
	});

	it("rejects malformed host results and throwing array accessors without suppressing later callbacks", async () => {
		const registry = createInstanceLifecycleRegistry<Instance>();
		const badAccessor = ["unused.example"];
		Object.defineProperty(badAccessor, "0", {
			get() {
				throw new Error("array-accessor-private-detail");
			},
		});
		const malformed: unknown[] = [undefined, null, "host.example", [""], [1], badAccessor];
		for (const [ordinal, value] of malformed.entries()) {
			registry.registerInstanceHosts(`invalid-${ordinal}`, (() => value) as unknown as HostsFor);
		}
		let laterCalled = false;
		registry.registerInstanceHosts("valid-empty", () => {
			laterCalled = true;
			return [];
		});
		const error = failure(await observe(registry.destinationData(instance, [])));
		expect(laterCalled).toBe(true);
		expect(error.failures).toEqual(
			malformed.map((_, ordinal) => ({
				kind: `invalid-${ordinal}`,
				code: "invalid-result",
			})),
		);
		expect(error.notices).toEqual([]);
		expect(JSON.stringify(error)).not.toContain("array-accessor-private-detail");
	});

	it("appends one host-registration change failure after callback failures and retains the dispatch snapshot", async () => {
		const registry = createInstanceLifecycleRegistry<Instance>();
		const gate = deferred<readonly string[]>();
		let removedCalls = 0;
		let addedCalls = 0;
		registry.registerInstanceHosts("rejects", () => Promise.reject("hidden"));
		registry.registerInstanceHosts("waiting", () => gate.promise);
		const unregister = registry.registerInstanceHosts("removed", () => {
			removedCalls++;
			return ["removed.example"];
		});
		const task = observe(registry.destinationData(instance, []));
		try {
			unregister();
			const removeAdded = registry.registerInstanceHosts("added", () => {
				addedCalls++;
				return ["added.example"];
			});
			removeAdded();
			gate.resolve(["waiting.example"]);
			const error = failure(await task);
			expect(removedCalls).toBe(1);
			expect(addedCalls).toBe(0);
			expect(error.failures).toEqual([
				{ kind: "rejects", code: "callback-rejected" },
				{ kind: null, code: "registrations-changed" },
			]);
		} finally {
			gate.resolve(["waiting.example"]);
			await task;
		}
	});

	it("ignores removal-only registration changes during host dispatch", async () => {
		const registry = createInstanceLifecycleRegistry<Instance>();
		const gate = deferred<readonly string[]>();
		registry.registerInstanceHosts("waiting", () => gate.promise);
		const task = observe(registry.destinationData(instance, []));
		try {
			const unregister = registry.registerBeforeRemove("notice", () => "notice");
			unregister();
			gate.resolve(["host.example"]);
			expect(success(await task).instanceHosts).toEqual(["host.example"]);
		} finally {
			gate.resolve(["host.example"]);
			await task;
		}
	});

	it("validates registration arguments with fixed TypeErrors and accepts nonempty untrimmed kinds", async () => {
		const registry = createInstanceLifecycleRegistry<Instance>();
		for (const kind of ["", null, undefined, 1, {}]) {
			expect(() =>
				registry.registerBeforeRemove(kind as unknown as string, () => undefined),
			).toThrowError(new TypeError("Credential kind must be a nonempty string"));
			expect(() =>
				registry.registerInstanceHosts(kind as unknown as string, () => []),
			).toThrowError(new TypeError("Credential kind must be a nonempty string"));
		}
		for (const callback of [null, undefined, 1, "callback", {}]) {
			expect(() =>
				registry.registerBeforeRemove("kind", callback as unknown as NoticeHandler),
			).toThrowError(new TypeError("Lifecycle callback must be a function"));
			expect(() =>
				registry.registerInstanceHosts("kind", callback as unknown as HostsFor),
			).toThrowError(new TypeError("Lifecycle callback must be a function"));
		}
		registry.registerBeforeRemove(" ", () => " ");
		registry.registerInstanceHosts(" ", () => [" "]);
		expect(await registry.beforeRemove(instance)).toEqual([" "]);
		expect((await registry.destinationData(instance, [])).instanceHosts).toEqual([" "]);
	});

	it("rejects malformed plugin egress explicitly instead of treating it as an empty list", async () => {
		const registry = createInstanceLifecycleRegistry<Instance>();
		for (const invalid of [undefined, null, "host.example", [""], [1]]) {
			await expect(
				registry.destinationData(instance, invalid as unknown as readonly string[]),
			).rejects.toThrowError(new TypeError("Plugin egress hosts must be nonempty strings"));
		}
	});

	it("keeps factory registries independent", async () => {
		const first = createInstanceLifecycleRegistry<Instance>();
		const second = createInstanceLifecycleRegistry<Instance>();
		first.registerBeforeRemove("same-kind", () => "first-only");
		first.registerInstanceHosts("same-kind", () => ["first-only.example"]);
		expect(await second.beforeRemove(instance)).toEqual([]);
		expect(await second.destinationData(instance, [])).toEqual({
			pluginEgress: [],
			instanceHosts: [],
		});
	});

	it("keeps the bound instance type invariant across a registry's operations", () => {
		const registry = createInstanceLifecycleRegistry<Instance>();
		// @ts-expect-error A bound handler scope cannot become an unknown-instance scope.
		const widened: InstanceLifecycleRegistry<unknown> = registry;
		expect(widened).toBe(registry);
	});

	it("binds all four default operations to the same registry and disposes every registration", async () => {
		const disposers: (() => void)[] = [];
		try {
			disposers.push(
				registerBeforeRemove("default-test", (received) => {
					expect(received).toBe(instance);
					return "default-notice";
				}),
			);
			disposers.push(
				registerInstanceHosts("default-test", (received) => {
					expect(received).toBe(instance);
					return ["default.example"];
				}),
			);
			expect(await beforeRemove(instance)).toEqual(["default-notice"]);
			expect(await destinationData(instance, ["plugin.example"])).toEqual({
				pluginEgress: ["plugin.example"],
				instanceHosts: ["default.example"],
			});
		} finally {
			for (const dispose of disposers) dispose();
		}
		expect(await beforeRemove(instance)).toEqual([]);
		expect((await destinationData(instance, [])).instanceHosts).toEqual([]);
	});
});
