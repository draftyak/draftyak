import { mkdtemp, open, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { PluginActivationError } from "../../../src/plugins/activation/errors.ts";
import { PluginActivationLifetime } from "../../../src/plugins/activation/lifetime.ts";

function gate(): { promise: Promise<void>; release: () => void } {
	const { promise, resolve } = Promise.withResolvers<void>();
	return { promise, release: () => resolve() };
}

async function refused(task: Promise<unknown>): Promise<void> {
	let error: unknown;
	let accepted = false;
	try {
		await task;
		accepted = true;
	} catch (failure) {
		error = failure;
	}
	expect(accepted).toBe(false);
	expect(error instanceof PluginActivationError).toBe(true);
}

describe("native activation lifetime tracking", () => {
	it("publishes a body before reentrant close and keeps one pending close identity", async () => {
		const lifetime = new PluginActivationLifetime();
		const entered = gate();
		const finish = gate();
		let nested: Promise<void> | undefined;
		let completed = false;
		const operation = lifetime.track(async () => {
			nested = lifetime.close();
			entered.release();
			await finish.promise;
			return 7;
		});
		const outcome = refused(operation);
		try {
			await entered.promise;
			const closing = lifetime.close();
			void closing.then(() => {
				completed = true;
			});
			expect(closing === nested).toBe(true);
			expect(lifetime.closing).toBe(true);
			expect(lifetime.closed).toBe(false);
			await Promise.resolve();
			expect(completed).toBe(false);
			finish.release();
			await outcome;
			await closing;
			expect(lifetime.closed).toBe(true);
			expect(lifetime.close() === closing).toBe(true);
		} finally {
			finish.release();
			await Promise.allSettled([outcome, lifetime.close()]);
		}
	});

	it("does not enter an admitted deferred body after beginClose fences it", async () => {
		const lifetime = new PluginActivationLifetime();
		let calls = 0;
		const operation = lifetime.track(async () => {
			calls++;
			return 3;
		});
		lifetime.beginClose();
		await refused(operation);
		await refused(
			lifetime.track(async () => {
				calls++;
				return 4;
			}),
		);
		expect(calls).toBe(0);
		expect(lifetime.closing).toBe(true);
		expect(lifetime.closed).toBe(false);
		await lifetime.close();
		expect(lifetime.closed).toBe(true);
	});

	it("joins a genuine owned file close in the whole operation finally", async () => {
		const lifetime = new PluginActivationLifetime();
		const root = await mkdtemp(path.join(os.tmpdir(), "draftyak-activation-life-test-"));
		const file = await open(path.join(root, "owned.txt"), "wx+", 0o600);
		const entered = gate();
		const finishBody = gate();
		const finallyEntered = gate();
		const finishFinally = gate();
		let drained = false;
		const operation = lifetime.track(async () => {
			try {
				entered.release();
				await finishBody.promise;
			} finally {
				finallyEntered.release();
				await finishFinally.promise;
				await file.close();
			}
		});
		const outcome = refused(operation);
		try {
			await entered.promise;
			const closing = lifetime.close();
			void closing.then(() => {
				drained = true;
			});
			finishBody.release();
			await finallyEntered.promise;
			expect(file.fd >= 0).toBe(true);
			expect(lifetime.closed).toBe(false);
			expect(drained).toBe(false);
			finishFinally.release();
			await outcome;
			await closing;
			expect(file.fd).toBe(-1);
			expect(drained).toBe(true);
			expect(lifetime.closed).toBe(true);
		} finally {
			finishBody.release();
			finishFinally.release();
			await Promise.allSettled([outcome, lifetime.close()]);
			await file.close();
			await rm(root, { recursive: true, force: true });
		}
	});

	it("drains every pending finally even when another operation already refused", async () => {
		const lifetime = new PluginActivationLifetime();
		const entered = gate();
		const finish = gate();
		const finallyEntered = gate();
		let finished = 0;
		const failure = lifetime.track(async () => {
			try {
				throw new PluginActivationError();
			} finally {
				finallyEntered.release();
			}
		});
		const failed = refused(failure);
		const pending = lifetime.track(async () => {
			try {
				entered.release();
				await finish.promise;
			} finally {
				finished++;
			}
		});
		const pendingOutcome = refused(pending);
		try {
			await Promise.all([entered.promise, finallyEntered.promise]);
			const closing = lifetime.close();
			await failed;
			expect(finished).toBe(0);
			expect(lifetime.closed).toBe(false);
			finish.release();
			await Promise.all([closing, pendingOutcome]);
			expect(finished).toBe(1);
			expect(lifetime.closed).toBe(true);
		} finally {
			finish.release();
			await Promise.allSettled([failed, pendingOutcome, lifetime.close()]);
		}
	});

	it("keeps ordinary successful results while open and makes an empty close terminal", async () => {
		const lifetime = new PluginActivationLifetime();
		expect(await lifetime.track(async () => 11)).toBe(11);
		expect(lifetime.closing).toBe(false);
		expect(lifetime.closed).toBe(false);
		const closing = lifetime.close();
		expect(lifetime.close() === closing).toBe(true);
		await closing;
		let entered = false;
		await refused(
			lifetime.track(async () => {
				entered = true;
				return 12;
			}),
		);
		expect(entered).toBe(false);
		expect(lifetime.closed).toBe(true);
	});

	it("retains an owned file cleanup after a failed attempt and retries it", async () => {
		const lifetime = new PluginActivationLifetime();
		const root = await mkdtemp(path.join(os.tmpdir(), "draftyak-activation-cleanup-test-"));
		const file = await open(path.join(root, "owned.txt"), "wx+", 0o600);
		let attempts = 0;
		let fail = true;
		// This is a cleanup-only view of an owned file, never a supervisor or authority fixture.
		lifetime.retainSupervisor({
			close: async () => {
				attempts++;
				if (fail) return { cleanupFailures: 1 };
				await file.close();
				return { cleanupFailures: 0 };
			},
		});
		try {
			await refused(lifetime.close());
			expect(lifetime.closing).toBe(true);
			expect(lifetime.closed).toBe(false);
			expect(file.fd >= 0).toBe(true);
			const failedAttempts = attempts;
			fail = false;
			await lifetime.close();
			expect(attempts > failedAttempts).toBe(true);
			expect(file.fd).toBe(-1);
			expect(lifetime.closed).toBe(true);
		} finally {
			fail = false;
			await Promise.allSettled([lifetime.close(), file.close()]);
			await rm(root, { recursive: true, force: true });
		}
	});

	it("joins a late owned cleanup after an earlier close already completed", async () => {
		const lifetime = new PluginActivationLifetime();
		const first = lifetime.close();
		await first;
		const root = await mkdtemp(path.join(os.tmpdir(), "draftyak-activation-late-test-"));
		const file = await open(path.join(root, "owned.txt"), "wx+", 0o600);
		const finish = gate();
		lifetime.retainSupervisor({
			close: async () => {
				await finish.promise;
				await file.close();
				return { cleanupFailures: 0 };
			},
		});
		try {
			const closing = lifetime.close();
			expect(closing === first).toBe(false);
			expect(lifetime.closed).toBe(false);
			expect(file.fd >= 0).toBe(true);
			finish.release();
			await closing;
			expect(file.fd).toBe(-1);
			expect(lifetime.closed).toBe(true);
		} finally {
			finish.release();
			await Promise.allSettled([lifetime.close(), file.close()]);
			await rm(root, { recursive: true, force: true });
		}
	});

	it("joins cleanup retained during close and preserves its failure until explicit retry", async () => {
		const lifetime = new PluginActivationLifetime();
		const root = await mkdtemp(path.join(os.tmpdir(), "draftyak-activation-live-drain-test-"));
		const finishFirst = gate();
		const firstDone = gate();
		const finishLate = gate();
		let firstFile: Awaited<ReturnType<typeof open>> | undefined;
		let lateFile: Awaited<ReturnType<typeof open>> | undefined;
		let lateCleanup: Promise<{ cleanupFailures: number }> | undefined;
		let closing: Promise<void> | undefined;
		let fail = true;
		let closeSettled = false;
		let closeAccepted = false;
		let fixedRefusal = false;
		try {
			const first = await open(path.join(root, "first.txt"), "wx+", 0o600);
			firstFile = first;
			const late = await open(path.join(root, "late.txt"), "wx+", 0o600);
			lateFile = late;
			// Cleanup-only views of owned files, never supervisor or authority fixtures.
			lifetime.retainSupervisor({
				close: async () => {
					await finishFirst.promise;
					await first.close();
					firstDone.release();
					return { cleanupFailures: 0 };
				},
			});
			closing = lifetime.close();
			const outcome = closing.then(
				() => {
					closeSettled = true;
					closeAccepted = true;
				},
				(error: unknown) => {
					closeSettled = true;
					fixedRefusal = error instanceof PluginActivationError;
				},
			);
			// Let the original close form its second snapshot while the first file is held.
			await Promise.resolve();
			lifetime.retainSupervisor({
				close: () => {
					lateCleanup = (async () => {
						await finishLate.promise;
						if (fail) return { cleanupFailures: 1 };
						await late.close();
						return { cleanupFailures: 0 };
					})();
					return lateCleanup;
				},
			});
			finishFirst.release();
			await firstDone.promise;
			await late.stat();
			expect(closeSettled).toBe(false);
			expect(late.fd >= 0).toBe(true);
			expect(lifetime.closed).toBe(false);
			finishLate.release();
			await lateCleanup;
			await outcome;
			expect(closeAccepted).toBe(false);
			expect(fixedRefusal).toBe(true);
			expect(lifetime.closed).toBe(false);
			expect(late.fd >= 0).toBe(true);
			fail = false;
			await lifetime.close();
			expect(late.fd).toBe(-1);
			expect(lifetime.closed).toBe(true);
		} finally {
			fail = false;
			finishFirst.release();
			finishLate.release();
			await Promise.allSettled([closing, lateCleanup, lifetime.close()]);
			await firstFile?.close();
			await lateFile?.close();
			await rm(root, { recursive: true, force: true });
		}
	});
});
