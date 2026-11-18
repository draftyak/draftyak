import { setImmediate } from "node:timers/promises";
import { describe, expect, it } from "vitest";
import { NativeCallerWork } from "../../src/runtime/native-caller-work.js";

function deferred<T>() {
	let resolve!: (value: T | PromiseLike<T>) => void;
	let reject!: (reason: unknown) => void;
	const promise = new Promise<T>((yes, no) => {
		resolve = yes;
		reject = no;
	});
	return { promise, resolve, reject };
}

async function expectPending(promise: Promise<void>) {
	let settled = false;
	void promise.then(
		() => {
			settled = true;
		},
		() => {
			settled = true;
		},
	);
	await setImmediate();
	expect(settled).toBe(false);
}

describe("NativeCallerWork", () => {
	it("returns the original operation promise and joins it before retirement", async () => {
		const caller = new NativeCallerWork();
		const original = deferred<number>();
		let starts = 0;
		const returned = caller.run(() => {
			starts += 1;
			return original.promise;
		});
		expect(returned).toBe(original.promise);
		expect(starts).toBe(1);

		const stopped = caller.stop();
		await expectPending(stopped);
		original.resolve(42);
		await expect(returned).resolves.toBe(42);
		await expect(stopped).resolves.toBeUndefined();
	});

	it("fences admission synchronously and keeps one stable stop promise", async () => {
		const caller = new NativeCallerWork();
		const stopped = caller.stop();
		let started = false;
		expect(() =>
			caller.run(() => {
				started = true;
				return Promise.resolve();
			}),
		).toThrow("NATIVE_CALLER_STOPPED");
		expect(started).toBe(false);
		expect(caller.stop()).toBe(stopped);
		await stopped;
		expect(caller.stop()).toBe(stopped);
	});

	it("reserves work before a starter can reenter stop", async () => {
		const caller = new NativeCallerWork();
		const original = deferred<void>();
		let reentrantStop: Promise<void> | undefined;
		const returned = caller.run(() => {
			reentrantStop = caller.stop();
			return original.promise;
		});
		const stopped = caller.stop();
		expect(stopped).toBe(reentrantStop);
		expect(returned).toBe(original.promise);
		await expectPending(stopped);
		original.resolve();
		await stopped;
	});

	it("joins every admitted operation even when one rejects", async () => {
		const caller = new NativeCallerWork();
		const failed = deferred<void>();
		const remaining = deferred<void>();
		const failure = new Error("operation failed");
		const failedWork = caller.run(() => failed.promise);
		caller.run(() => remaining.promise);
		const stopped = caller.stop();

		failed.reject(failure);
		await expect(failedWork).rejects.toBe(failure);
		await expectPending(stopped);
		remaining.resolve();
		await expect(stopped).resolves.toBeUndefined();
	});

	it("releases a reservation after a synchronous starter failure", async () => {
		const caller = new NativeCallerWork();
		const failure = Object.freeze({ reason: "synchronous startup failure" });
		let reentrantStop: Promise<void> | undefined;
		let observed: unknown;
		try {
			caller.run(() => {
				reentrantStop = caller.stop();
				throw failure;
			});
		} catch (error) {
			observed = error;
		}
		expect(observed).toBe(failure);
		const stopped = caller.stop();
		expect(stopped).toBe(reentrantStop);
		await expect(stopped).resolves.toBeUndefined();
	});

	it("keeps admitted work pending when a genuine promise cannot attach its observer", async () => {
		const caller = new NativeCallerWork();
		const failure = new Error("settlement observer unavailable");
		let speciesReads = 0;
		class UnobservablePromise<T> extends Promise<T> {
			static override get [Symbol.species](): PromiseConstructor {
				speciesReads += 1;
				throw failure;
			}
		}
		let release!: () => void;
		let released = false;
		const original = new UnobservablePromise<void>((resolve) => {
			release = () => {
				released = true;
				resolve();
			};
		});
		let starts = 0;
		let reentrantStop: Promise<void> | undefined;
		let observed: unknown;
		try {
			expect(original).toBeInstanceOf(Promise);
			expect(original.then).toBe(Promise.prototype.then);
			expect(Object.hasOwn(original, "then")).toBe(false);
			try {
				caller.run(() => {
					starts += 1;
					reentrantStop = caller.stop();
					return original;
				});
			} catch (error) {
				observed = error;
			}
			expect(starts).toBe(1);
			expect(observed).toBe(failure);
			expect(speciesReads).toBe(1);
			const stopped = caller.stop();
			expect(stopped).toBe(reentrantStop);
			expect(released).toBe(false);
			await expectPending(stopped);
			expect(released).toBe(false);
			expect(caller.stop()).toBe(stopped);
		} finally {
			// Fulfil the original work without claiming that its failed observer joined it.
			release();
			await setImmediate();
		}
	});

	it("joins nested work admitted before the fence and refuses later starts", async () => {
		const caller = new NativeCallerWork();
		const outer = deferred<void>();
		const inner = deferred<void>();
		caller.run(() => {
			expect(caller.run(() => inner.promise)).toBe(inner.promise);
			caller.stop();
			return outer.promise;
		});
		const stopped = caller.stop();
		outer.resolve();
		await expectPending(stopped);
		expect(() => caller.run(() => Promise.resolve())).toThrow("NATIVE_CALLER_STOPPED");
		inner.resolve();
		await stopped;
	});
});
