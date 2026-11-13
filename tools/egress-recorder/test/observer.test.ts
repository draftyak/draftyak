import { randomUUID } from "node:crypto";
import { createServer } from "node:net";
import { describe, expect, it, vi } from "vitest";
import {
	activateTestOnly,
	assertDestinations,
	createRecorder,
	observeLocalTcp,
	readResult,
} from "../src/index.ts";
import { hub, plugin, required, target } from "./fixtures.ts";

describe("attempt observations", () => {
	it("keeps independently completed callers bound to attempt start order", async () => {
		const recorder = createRecorder({ profile: "test", observers: [hub, plugin] });
		const first = recorder.observer(hub.id);
		const second = recorder.observer(plugin.id);
		let release: (value: string) => void = () => {};
		const waiting = first.observe(target, {
			policy: () => true,
			resolve: () =>
				new Promise<string>((resolve) => {
					release = resolve;
				}),
			connect: () => "ready",
		});
		await Promise.resolve();
		await Promise.resolve();
		await second.observe(
			{ ...target, transport: "udp" },
			{ policy: () => false, resolve: () => 1, connect: () => {} },
		);
		release("resolved");
		await waiting;
		first.complete();
		second.complete();
		const result = readResult(recorder.finish(), { ...required, observers: [hub, plugin] });
		expect(result.attempts.map(({ observerId, sequence }) => [observerId, sequence])).toEqual([
			[hub.id, 0],
			[plugin.id, 1],
		]);
	});
	it("records refusal before fake dispatch and distinguishes DNS and connection failures", async () => {
		const recorder = createRecorder({ profile: "test", observers: [hub] });
		const observer = recorder.observer(hub.id);
		let dispatched = 0;
		const privateError = `DYTEST-${randomUUID()}`;
		const steps = {
			policy: () => true,
			resolve: () => "resolved",
			connect: () => {
				dispatched++;
				return "payload";
			},
		};
		expect(await observer.observe(target, steps)).toEqual({
			outcome: "succeeded",
			stage: "connect",
			value: "payload",
		});
		expect(await observer.observe(target, { ...steps, policy: () => false })).toEqual({
			outcome: "refused",
			stage: "policy",
		});
		expect(
			await observer.observe(target, {
				...steps,
				resolve: () => {
					throw new Error(privateError);
				},
			}),
		).toEqual({ outcome: "failed", stage: "dns" });
		expect(
			await observer.observe(target, {
				...steps,
				connect: () => {
					throw new Error(privateError);
				},
			}),
		).toEqual({ outcome: "failed", stage: "connect" });
		expect(dispatched).toBe(1);
		observer.complete();
		const raw = recorder.finish();
		expect(raw).not.toContain(privateError);
		expect(raw).not.toContain("payload");
		const result = readResult(raw, required);
		expect(result.attempts.map(({ outcome, stage }) => [outcome, stage])).toEqual([
			["succeeded", "connect"],
			["refused", "policy"],
			["failed", "dns"],
			["failed", "connect"],
		]);
		expect(result.attempts.map((attempt) => attempt.sequence)).toEqual([0, 1, 2, 3]);
	});

	it.each(["cdn.example", "pypi.example", "index.example"])(
		"fails an allowlist for the refused synthetic destination %s",
		async (host) => {
			const recorder = createRecorder({ profile: "test", observers: [plugin] });
			const observer = recorder.observer(plugin.id);
			let contacted = false;
			await observer.observe(
				{ ...target, host },
				{
					policy: () => false,
					resolve: () => {
						contacted = true;
						return null;
					},
					connect: () => {
						contacted = true;
					},
				},
			);
			observer.complete();
			const raw = recorder.finish();
			const coverage = { ...required, observers: [plugin] };
			expect(contacted).toBe(false);
			expect(readResult(raw, coverage).attempts).toHaveLength(1);
			expect(() => assertDestinations(raw, coverage, [target])).toThrow("COVERAGE_MISMATCH");
		},
	);

	it.each([hub, plugin])(
		"retains a real loopback positive control for $caller.kind",
		async (point) => {
			const server = createServer((socket) => socket.destroy());
			await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
			const address = server.address();
			if (!address || typeof address === "string") throw new Error("Expected local listener");
			const recorder = createRecorder({ profile: "test", observers: [point] });
			const observer = recorder.observer(point.id);
			try {
				expect(await observeLocalTcp(observer, address.port)).toMatchObject({
					outcome: "succeeded",
				});
				observer.complete();
				const raw = recorder.finish();
				expect(() => readResult(raw, { ...required, observers: [point] })).not.toThrow();
				const result = readResult(raw, { ...required, observers: [point] });
				expect(result.attempts).toEqual([
					{
						observerId: point.id,
						sequence: 0,
						destination: { host: "127.0.0.1", port: address.port, transport: "tcp" },
						outcome: "succeeded",
						stage: "connect",
					},
				]);
				expect(result.scope).toBe("component");
			} finally {
				await new Promise<void>((resolve, reject) =>
					server.close((error) => (error ? reject(error) : resolve())),
				);
			}
		},
	);

	it("records an actual local connection failure that never reaches a fake", async () => {
		const server = createServer();
		await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
		const address = server.address();
		if (!address || typeof address === "string") throw new Error("Expected local listener");
		await new Promise<void>((resolve) => server.close(() => resolve()));
		const recorder = createRecorder({ profile: "test", observers: [hub] });
		const observer = recorder.observer(hub.id);
		expect(await observeLocalTcp(observer, address.port)).toEqual({
			outcome: "failed",
			stage: "connect",
		});
		observer.complete();
		expect(readResult(recorder.finish(), required).attempts[0]).toMatchObject({
			outcome: "failed",
			stage: "connect",
		});
	});

	it("does not dispatch after a deadline, completion race or late DNS settlement", async () => {
		const pending: Promise<unknown>[] = [];
		const releases: (() => void)[] = [];
		const holdDns = () => {
			const recorder = createRecorder({ profile: "test", observers: [hub] });
			const observer = recorder.observer(hub.id);
			const entered = Promise.withResolvers<void>();
			const dns = Promise.withResolvers<string>();
			const release = () => dns.resolve("late");
			const connect = vi.fn();
			releases.push(release);
			const observing = observer.observe(
				target,
				{
					policy: () => true,
					resolve: () => {
						entered.resolve();
						return dns.promise;
					},
					connect,
				},
				5,
			);
			pending.push(observing);
			let settled = false;
			void observing.then(
				() => {
					settled = true;
				},
				() => {
					settled = true;
				},
			);
			const admitted = Promise.race([
				entered.promise,
				observing.then(() => {
					throw new Error("Expected DNS resolver entry");
				}),
			]);
			return {
				recorder,
				observer,
				admitted,
				observing,
				release,
				connect,
				get settled() {
					return settled;
				},
			};
		};
		vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "performance"] });
		try {
			const deadline = holdDns();
			await deadline.admitted;
			const started = performance.now();
			await vi.advanceTimersByTimeAsync(5);
			expect(performance.now() - started).toBe(5);
			expect(deadline.settled).toBe(true);
			expect(await deadline.observing).toEqual({ outcome: "failed", stage: "dns" });
			expect(deadline.connect).not.toHaveBeenCalled();
			deadline.observer.complete();
			deadline.release();
			await vi.advanceTimersByTimeAsync(0);
			expect(deadline.connect).not.toHaveBeenCalled();
			expect(readResult(deadline.recorder.finish(), required).attempts).toEqual([
				{
					observerId: hub.id,
					sequence: 0,
					destination: target,
					outcome: "failed",
					stage: "dns",
				},
			]);

			const completion = holdDns();
			await completion.admitted;
			expect(() => completion.observer.complete()).toThrow("LIFECYCLE");
			await vi.advanceTimersByTimeAsync(0);
			expect(completion.settled).toBe(true);
			expect(await completion.observing).toEqual({ outcome: "failed", stage: "dns" });
			completion.release();
			await vi.advanceTimersByTimeAsync(0);
			expect(completion.connect).not.toHaveBeenCalled();
			expect(() => readResult(completion.recorder.finish(), required)).toThrow(
				"OBSERVATION_FAILED",
			);
		} finally {
			for (const release of releases) release();
			try {
				await vi.runAllTimersAsync();
				await Promise.allSettled(pending);
			} finally {
				vi.useRealTimers();
			}
		}
	});

	it("marks observation incomplete when finished with work in flight", async () => {
		const recorder = createRecorder({ profile: "test", observers: [hub] });
		const observer = recorder.observer(hub.id);
		let policy = 0;
		const pending = observer.observe(target, {
			policy: () => {
				policy++;
				return true;
			},
			resolve: () => "ready",
			connect: () => {},
		});
		const raw = recorder.finish();
		expect(() => readResult(raw, required)).toThrow("OBSERVATION_FAILED");
		expect(await pending).toEqual({ outcome: "failed", stage: "policy" });
		expect(policy).toBe(0);
		expect(() => observer.complete()).toThrow("LIFECYCLE");
	});
});

describe("profile and observation coverage", () => {
	it.each(["production", "release", undefined, "", false])(
		"refuses activation and test overrides for profile %s",
		(profile) => {
			let activated = false;
			expect(() =>
				activateTestOnly(profile, () => {
					activated = true;
				}),
			).toThrow("PROFILE_FORBIDDEN");
			expect(() => createRecorder({ profile, observers: [hub] })).toThrow("PROFILE_FORBIDDEN");
			expect(activated).toBe(false);
		},
	);
	it("separates complete zero attempts from missing or failed observation", () => {
		const zero = createRecorder({ profile: "test", observers: [hub] });
		zero.observer(hub.id).complete();
		expect(readResult(zero.finish(), required).attempts).toEqual([]);
		const missing = createRecorder({ profile: "test", observers: [hub] });
		expect(() => readResult(missing.finish(), required)).toThrow("OBSERVATION_MISSING");
		const failed = createRecorder({ profile: "test", observers: [hub] });
		failed.observer(hub.id).fail();
		expect(() => readResult(failed.finish(), required)).toThrow("OBSERVATION_FAILED");
	});
	it("requires consumer-selected caller coverage rather than the report's own roster", () => {
		const recorder = createRecorder({ profile: "test", observers: [hub] });
		recorder.observer(hub.id).complete();
		const raw = recorder.finish();
		expect(() => readResult(raw, { ...required, observers: [hub, plugin] })).toThrow(
			"COVERAGE_MISMATCH",
		);
		expect(() =>
			readResult(raw, { ...required, observers: [{ ...hub, caller: plugin.caller }] }),
		).toThrow("COVERAGE_MISMATCH");
		expect(() => readResult(raw, { ...required, scope: "native" })).toThrow("COVERAGE_MISMATCH");
	});
});
