import { afterEach, describe, expect, it } from "vitest";
import { PluginActivationError, refuseActivation } from "../../src/kernel/plugin-runtime-errors.ts";
import { PluginActivationLifetime } from "../../src/kernel/plugin-runtime-lifetime.ts";
import {
	assertHubSessionAdmission,
	assertNativePluginRuntimeLifetimeOwner,
	type HubSession,
	HubSessionError,
	nativePluginRuntimeLifetime,
} from "../../src/lifecycle/session.ts";
import {
	PluginActivationError as ActivationError,
	refuseActivation as refuseFromActivation,
} from "../../src/plugins/activation/errors.ts";
import { PluginActivationLifetime as ActivationLifetime } from "../../src/plugins/activation/lifetime.ts";
import { refusal, refusalNow, type SessionFixture, sessionFixture } from "./session-helpers.ts";

interface FixtureOwner {
	value?: SessionFixture;
	remove?: () => Promise<void>;
	removal?: Promise<void>;
	originalRemoval?: Promise<void>;
	failure?: unknown;
}

class TestLifetime {
	readonly #fixtures = new Set<FixtureOwner>();
	readonly #opens = new Set<Promise<HubSession>>();
	readonly #operations = new Set<Promise<unknown>>();
	readonly #barriers: Array<() => void> = [];
	readonly #barrierFailures: unknown[] = [];
	readonly #cancel = Promise.withResolvers<never>();
	readonly #cancelReason = new Error("DYTEST-LIFETIME-ENDED");
	#body: Promise<void> | undefined;
	#teardown: Promise<void> | undefined;
	#closing = false;
	#complete = false;

	constructor() {
		void this.#cancel.promise.catch(() => {});
	}

	get complete(): boolean {
		return this.#complete;
	}

	run(body: (lifetime: TestLifetime) => void | Promise<void>): Promise<void> {
		const original = Promise.resolve().then(() => body(this));
		this.#body = original;
		void original.catch(() => {});
		return original;
	}

	fixture(): SessionFixture {
		if (this.#closing) throw this.#cancelReason;
		const owner: FixtureOwner = {};
		this.#fixtures.add(owner);
		try {
			const value = sessionFixture("draftyak-runtime-lifetime-");
			owner.value = value;
			owner.remove = value.remove.bind(value);
			return value;
		} catch (error) {
			owner.failure = error;
			throw error;
		}
	}

	open(value: SessionFixture): Promise<HubSession> {
		if (this.#closing) return Promise.reject(this.#cancelReason);
		if (![...this.#fixtures].some((owner) => owner.value === value))
			throw new Error("DYTEST-UNOWNED-FIXTURE");
		const open = value.open;
		const original = Promise.resolve().then(() => Reflect.apply(open, value, []));
		this.#opens.add(original);
		void original.catch(() => {});
		return this.wait(original);
	}

	wait<T>(original: Promise<T>): Promise<T> {
		if (this.#closing) return Promise.reject(this.#cancelReason);
		return Promise.race([original, this.#cancel.promise]);
	}

	own<T>(original: Promise<T>): Promise<T> {
		this.#operations.add(original);
		void original.catch(() => {});
		return original;
	}

	onTeardown(release: () => void): void {
		if (this.#closing) throw this.#cancelReason;
		this.#barriers.push(release);
	}

	teardown(): Promise<void> {
		if (this.#teardown) return this.#teardown;
		const { promise, resolve, reject } = Promise.withResolvers<void>();
		this.#teardown = promise;
		void promise.catch(() => {});
		this.#closing = true;
		// Cancellation rejects waits; it never impersonates a producer or a retirement signal.
		this.#cancel.reject(this.#cancelReason);
		for (const release of this.#barriers) {
			try {
				release();
			} catch (error) {
				this.#barrierFailures.push(error);
			}
		}
		void this.#finish().then(resolve, reject);
		return promise;
	}

	async #finish(): Promise<void> {
		if (!this.#body) throw new Error("DYTEST-UNOWNED-TEST-BODY");
		await Promise.allSettled([this.#body]);
		const opened = await Promise.allSettled([...this.#opens]);
		await Promise.allSettled([...this.#operations]);
		const owners = [...this.#fixtures];
		for (const owner of owners) {
			if (!owner.remove || owner.removal) continue;
			const { promise, resolve, reject } = Promise.withResolvers<void>();
			owner.removal = promise;
			void promise.catch(() => {});
			// Publish ownership before invoking the ONE original removal operation.
			void Promise.resolve().then(() => {
				try {
					const original = owner.remove?.();
					if (!original) throw new Error("DYTEST-MISSING-FIXTURE-REMOVAL");
					owner.originalRemoval = original;
					void original.then(resolve, reject);
				} catch (error) {
					reject(error);
				}
			});
		}
		const removed = await Promise.allSettled(
			owners.map((owner) => owner.removal ?? Promise.reject(owner.failure)),
		);
		const failures = [
			...this.#barrierFailures,
			...[...opened, ...removed].flatMap((result) =>
				result.status === "rejected" ? [result.reason] : [],
			),
		];
		if (failures.length > 0) throw new AggregateError(failures, "Test lifetime remains incomplete");
		for (const owner of owners) this.#fixtures.delete(owner);
		this.#complete = true;
	}
}

let lifetime: TestLifetime | undefined;
const ownedTest = (body: (scope: TestLifetime) => void | Promise<void>) => (): Promise<void> => {
	if (lifetime && !lifetime.complete) throw new Error("DYTEST-PREVIOUS-LIFETIME-INCOMPLETE");
	const next = new TestLifetime();
	lifetime = next;
	return next.run(body);
};
const settle = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

afterEach(() => lifetime?.teardown());

describe("original session plugin runtime cleanup", () => {
	it(
		"preserves the existing activation constructor and error identities",
		ownedTest(() => {
			expect(ActivationLifetime).toBe(PluginActivationLifetime);
			expect(ActivationError).toBe(PluginActivationError);
			expect(refuseFromActivation).toBe(refuseActivation);
		}),
	);

	it(
		"binds one cached ledger to the original session and rejects foreign ownership",
		ownedTest(async (scope) => {
			const first = await scope.open(scope.fixture());
			const second = await scope.open(scope.fixture());
			const lifetime = nativePluginRuntimeLifetime(first);
			expect(nativePluginRuntimeLifetime(first)).toBe(lifetime);
			expect(() => assertNativePluginRuntimeLifetimeOwner(first, lifetime)).not.toThrow();
			refusalNow(() => assertNativePluginRuntimeLifetimeOwner(second, undefined as never));
			refusalNow(() => assertNativePluginRuntimeLifetimeOwner(second, undefined as never, "held"));
			const other = nativePluginRuntimeLifetime(second);
			expect(other).not.toBe(lifetime);
			refusalNow(() => assertNativePluginRuntimeLifetimeOwner(second, lifetime));
			refusalNow(() => assertNativePluginRuntimeLifetimeOwner(first, other));
			refusalNow(() => assertNativePluginRuntimeLifetimeOwner(second, lifetime, "held"));
			refusalNow(() => assertNativePluginRuntimeLifetimeOwner(first, other, "held"));
			refusalNow(() =>
				assertNativePluginRuntimeLifetimeOwner(first, new PluginActivationLifetime()),
			);
			for (const unowned of [{ ...first }, Object.create(first), new Proxy(first, {}), null]) {
				refusalNow(() => nativePluginRuntimeLifetime(unowned));
				refusalNow(() => assertNativePluginRuntimeLifetimeOwner(unowned, lifetime, "held"));
			}
			for (const phase of ["closing", "closed", null, 1, {}]) {
				refusalNow(() =>
					Reflect.apply(assertNativePluginRuntimeLifetimeOwner, undefined, [
						first,
						lifetime,
						phase,
					]),
				);
			}
			refusalNow(() => Reflect.apply(nativePluginRuntimeLifetime, undefined, []));
			refusalNow(() => Reflect.apply(nativePluginRuntimeLifetime, undefined, [first, other]));
			refusalNow(() => Reflect.apply(assertNativePluginRuntimeLifetimeOwner, undefined, [first]));
			refusalNow(() =>
				Reflect.apply(assertNativePluginRuntimeLifetimeOwner, undefined, [
					first,
					lifetime,
					"open",
					1,
				]),
			);
		}),
	);

	it(
		"fences synchronously and joins an admitted allocator and its late cleanup before store release",
		ownedTest(async (scope) => {
			const data = scope.fixture();
			const session = await scope.open(data);
			const lifetime = nativePluginRuntimeLifetime(session);
			const entered = Promise.withResolvers<void>();
			const allocated = Promise.withResolvers<{
				retire: () => Promise<{ cleanupFailures: number }>;
			}>();
			const retiring = Promise.withResolvers<void>();
			const cleanup = Promise.withResolvers<{ cleanupFailures: number }>();
			let retireCalls = 0;
			let reentrantOpenRefused = false;
			const retainedProcess = {
				retire() {
					retireCalls++;
					try {
						nativePluginRuntimeLifetime(session);
					} catch (error) {
						reentrantOpenRefused = error instanceof HubSessionError;
					}
					retiring.resolve();
					return cleanup.promise;
				},
			};
			scope.onTeardown(() => {
				allocated.resolve(retainedProcess);
				cleanup.resolve({ cleanupFailures: 0 });
			});
			const task = lifetime.track(async () => {
				entered.resolve();
				const resource = await allocated.promise;
				lifetime.retainProcess(resource);
				return resource;
			});
			const refused = expect(task).rejects.toBeInstanceOf(PluginActivationError);
			void refused.catch(() => {});
			let closing: Promise<void> | undefined;
			let closed = false;
			try {
				await scope.wait(Promise.race([entered.promise, task]));
				closing = scope.own(session.close());
				void closing.then(
					() => {
						closed = true;
					},
					() => {
						closed = true;
					},
				);
				expect(lifetime.closing).toBe(true);
				refusalNow(() => nativePluginRuntimeLifetime(session));
				refusalNow(() => assertNativePluginRuntimeLifetimeOwner(session, lifetime));
				expect(() =>
					assertNativePluginRuntimeLifetimeOwner(session, lifetime, "held"),
				).not.toThrow();
				expect(session.close()).toBe(closing);
				await scope.wait(settle());
				expect(closed).toBe(false);
				expect(() => session.store.read((db) => db.get("SELECT 1"))).not.toThrow();
				allocated.resolve(retainedProcess);
				await scope.wait(retiring.promise);
				expect(reentrantOpenRefused).toBe(true);
				await scope.wait(settle());
				expect(closed).toBe(false);
				expect(retireCalls).toBe(1);
				cleanup.resolve({ cleanupFailures: 0 });
				await scope.wait(refused);
				await scope.wait(closing);
				expect(lifetime.closed).toBe(true);
				expect(() => session.store.read((db) => db.get("SELECT 1"))).toThrow();
				refusalNow(() => assertNativePluginRuntimeLifetimeOwner(session, lifetime, "held"));
				const reopened = await scope.open(data);
				expect(nativePluginRuntimeLifetime(reopened)).not.toBe(lifetime);
			} finally {
				allocated.resolve(retainedProcess);
				cleanup.resolve({ cleanupFailures: 0 });
				await Promise.allSettled([task, refused, ...(closing ? [closing] : [])]);
			}
		}),
	);

	it(
		"keeps failed cleanup closing and admitted until an explicit failed-resource retry",
		ownedTest(async (scope) => {
			const data = scope.fixture();
			const session = await scope.open(data);
			const lifetime = nativePluginRuntimeLifetime(session);
			let completedCalls = 0;
			let failedCalls = 0;
			lifetime.retainSupervisor({
				async close() {
					completedCalls++;
					return { cleanupFailures: 0 };
				},
			});
			lifetime.retainProcess({
				async retire() {
					failedCalls++;
					return { cleanupFailures: failedCalls === 1 ? 1 : 0 };
				},
			});
			expect((await scope.wait(refusal(scope.own(session.close())))).code).toBe("CLOSE_INCOMPLETE");
			expect(lifetime.closed).toBe(false);
			expect(lifetime.closing).toBe(true);
			refusalNow(() => nativePluginRuntimeLifetime(session));
			refusalNow(() => assertNativePluginRuntimeLifetimeOwner(session, lifetime));
			expect(() => assertNativePluginRuntimeLifetimeOwner(session, lifetime, "held")).not.toThrow();
			expect(() => session.store.read((db) => db.get("SELECT 1"))).not.toThrow();
			expect(completedCalls).toBe(1);
			expect(failedCalls).toBe(1);
			await scope.wait(scope.own(session.close()));
			expect(completedCalls).toBe(1);
			expect(failedCalls).toBe(2);
			expect(lifetime.closed).toBe(true);
			expect(() => session.store.read((db) => db.get("SELECT 1"))).toThrow();
			const reopened = await scope.open(data);
			expect(nativePluginRuntimeLifetime(reopened)).not.toBe(lifetime);
		}),
	);

	it(
		"never replaces an independently closed ledger while its original session is open",
		ownedTest(async (scope) => {
			const session = await scope.open(scope.fixture());
			const lifetime = nativePluginRuntimeLifetime(session);
			await scope.wait(scope.own(lifetime.close()));
			expect(() => assertHubSessionAdmission(session)).not.toThrow();
			refusalNow(() => nativePluginRuntimeLifetime(session));
			refusalNow(() => assertNativePluginRuntimeLifetimeOwner(session, lifetime));
			expect(() => assertNativePluginRuntimeLifetimeOwner(session, lifetime, "held")).not.toThrow();
			await scope.wait(scope.own(session.close()));
			refusalNow(() => assertNativePluginRuntimeLifetimeOwner(session, lifetime, "held"));
		}),
	);
});
