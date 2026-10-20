import { jcsSha256 } from "@draftyak/protocol/hash";
import { afterEach, describe, expect, it, vi } from "vitest";
import { type CallContext, LookupRunner, planLookups } from "../src/index.ts";
import { config, deferred, host, item, meta, now, plan, raw, result, toolId } from "./helpers.ts";

afterEach(() => {
	vi.useRealTimers();
	vi.restoreAllMocks();
});

describe("reviewed lookup provenance and lifecycle", () => {
	it("refuses a hand-built cloud contact plan with a correct digest before any host callback", async () => {
		const original = plan("forged-cloud"),
			first = original.calls[0];
		if (!first) throw new Error("missing call");
		const call = {
			...first,
			kind: "contact.notes" as const,
			arguments: { participant: "reply-to-target@attacker.example" },
			instance: { ...first.instance, destination: "cloud-tool" as const },
			messageDerived: true,
		};
		const forged = {
			...original,
			calls: [
				{
					...call,
					argumentDigest: jcsSha256({
						instance: call.instance.id,
						kind: call.kind,
						arguments: call.arguments,
					}),
				},
			],
		};
		const adapter = host(),
			authorize = vi.spyOn(adapter, "authorize"),
			discover = vi.spyOn(adapter, "discover"),
			callHost = vi.spyOn(adapter, "call");
		await expect(new LookupRunner(adapter).run(forged)).rejects.toMatchObject({
			code: "INVALID_JOB",
		});
		expect(authorize).not.toHaveBeenCalled();
		expect(discover).not.toHaveBeenCalled();
		expect(callHost).not.toHaveBeenCalled();
	});
	it("accepts the original issued object but refuses copies and proxies without reading their properties", async () => {
		const issued = plan(),
			read = vi.fn(() => {
				throw new Error("PRIVATE_PROXY_CANARY");
			}),
			runner = new LookupRunner(host());
		await expect(runner.run(structuredClone(issued))).rejects.toMatchObject({
			code: "INVALID_JOB",
		});
		await expect(runner.run(new Proxy(issued, { get: read }))).rejects.toMatchObject({
			code: "INVALID_JOB",
		});
		expect(read).not.toHaveBeenCalled();
		expect((await runner.run(issued)).contexts).toHaveLength(1);
	});
	it("closes request permits as soon as the call settles, before presentation ends", async () => {
		const presenting = deferred<void>(),
			finish = deferred<void>();
		let context: CallContext | undefined;
		const base = host(),
			runner = new LookupRunner({
				...base,
				call: async (call, current) => {
					context = current;
					return base.call(call, current);
				},
				hygiene: async (_kind, value) => {
					presenting.resolve();
					await finish.promise;
					return { data: value, findings: { instructions: 0, delimiters: 0 } };
				},
			});
		const running = runner.run(plan());
		await presenting.promise;
		if (!context) throw new Error("missing context");
		const captured = context;
		expect(() => captured.acquireRequest()).toThrow("REQUEST_CLOSED");
		expect(captured.signal.aborted).toBe(false);
		finish.resolve();
		expect((await running).contexts).toHaveLength(1);
		expect(captured.signal.aborted).toBe(true);
		expect(() => captured.acquireRequest()).toThrow("REQUEST_CLOSED");
	});
	it("closes permits and aborts the stage after a rejected call", async () => {
		let context: CallContext | undefined;
		const runner = new LookupRunner({
			...host(),
			call: async (_call, current) => {
				context = current;
				throw new Error("PRIVATE_CALL_CANARY");
			},
		});
		expect((await runner.run(plan())).skipped[0]?.reason).toBe("LOOKUP_FAILED");
		if (!context) throw new Error("missing context");
		const captured = context;
		expect(captured.signal.aborted).toBe(true);
		expect(() => captured.acquireRequest()).toThrow("REQUEST_CLOSED");
	});
	it("quarantines a single foreign discovery extension and does not rediscover it", async () => {
		const adapter = {
			...host(),
			discover: vi.fn(async () =>
				raw({ capabilities: { tools: {}, extensions: { "io.modelcontextprotocol/ui": {} } } }),
			),
			quarantine: vi.fn(),
		};
		const call = vi.spyOn(adapter, "call"),
			runner = new LookupRunner(adapter);
		expect((await runner.run(plan())).skipped[0]?.reason).toBe("SURFACE_CHANGED");
		expect((await runner.run(plan("again"))).skipped[0]?.reason).toBe("INSTANCE_UNAVAILABLE");
		expect(adapter.discover).toHaveBeenCalledTimes(1);
		expect(adapter.quarantine).toHaveBeenCalledExactlyOnceWith(toolId);
		expect(call).not.toHaveBeenCalled();
	});
	it("does not stop another job when a cancelled call answers within the grace period", async () => {
		vi.useFakeTimers();
		const first = deferred<string>(),
			second = deferred<string>(),
			started = deferred<void>(),
			controller = new AbortController(),
			stop = vi.fn();
		let calls = 0;
		const runner = new LookupRunner({
			...host(),
			stop,
			call: async (call) => {
				if (++calls === 2) started.resolve();
				return call.jobId === "cancelled" ? first.promise : second.promise;
			},
		});
		const a = runner.run(plan("cancelled", "one"), controller.signal),
			b = runner.run(plan("active", "two"));
		await started.promise;
		controller.abort();
		expect((await a).skipped[0]?.reason).toBe("CANCELLED");
		expect(stop).not.toHaveBeenCalled();
		await vi.advanceTimersByTimeAsync(4_999);
		expect(stop).not.toHaveBeenCalled();
		first.resolve(result({ entries: [] }));
		second.resolve(result({ entries: [] }));
		expect((await b).contexts).toHaveLength(1);
		await vi.advanceTimersByTimeAsync(1);
		expect(stop).not.toHaveBeenCalled();
	});
	it.each(["cancel", "timeout"] as const)(
		"requests a kill only after an actual %s call remains unanswered for five seconds",
		async (mode) => {
			vi.useFakeTimers();
			const started = deferred<void>(),
				answer = deferred<string>(),
				controller = new AbortController(),
				stop = vi.fn();
			let context: CallContext | undefined;
			const runner = new LookupRunner({
				...host(),
				stop,
				call: async (_call, current) => {
					context = current;
					started.resolve();
					return answer.promise;
				},
			});
			const running = runner.run(plan("unanswered"), controller.signal);
			await started.promise;
			if (mode === "cancel") controller.abort();
			else await vi.advanceTimersByTimeAsync(5_000);
			expect((await running).skipped[0]?.reason).toBe(
				mode === "cancel" ? "CANCELLED" : "TIMED_OUT",
			);
			if (!context) throw new Error("missing context");
			const captured = context;
			expect(captured.signal.aborted).toBe(true);
			expect(() => captured.acquireRequest()).toThrow("REQUEST_CLOSED");
			expect(stop).not.toHaveBeenCalled();
			await vi.advanceTimersByTimeAsync(4_999);
			expect(stop).not.toHaveBeenCalled();
			await vi.advanceTimersByTimeAsync(1);
			expect(stop).toHaveBeenCalledExactlyOnceWith(toolId, {
				reason: "unanswered-call",
				jobId: "unanswered",
				invocation: captured.invocation,
			});
			answer.resolve(result({ entries: [] }));
			await vi.advanceTimersByTimeAsync(0);
		},
	);
	it.each([false, true])(
		"correlates an old cancelled call separately from a reused job id (old answered: %s)",
		async (answered) => {
			vi.useFakeTimers();
			const oldAnswer = deferred<string>(),
				newAnswer = deferred<string>(),
				oldStarted = deferred<void>(),
				newStarted = deferred<void>(),
				controller = new AbortController(),
				stop = vi.fn();
			const contexts: CallContext[] = [];
			const runner = new LookupRunner({
				...host(),
				stop,
				call: async (_call, context) => {
					contexts.push(context);
					if (contexts.length === 1) {
						oldStarted.resolve();
						return oldAnswer.promise;
					}
					newStarted.resolve();
					return newAnswer.promise;
				},
			});
			const oldRun = runner.run(plan("reused", "old"), controller.signal);
			await oldStarted.promise;
			controller.abort();
			expect((await oldRun).contexts).toEqual([]);
			await vi.advanceTimersByTimeAsync(4_000);
			const newRun = runner.run(plan("reused", "new"));
			await newStarted.promise;
			const [oldCall, newCall] = contexts;
			if (!oldCall || !newCall) throw new Error("missing call contexts");
			expect(typeof oldCall.invocation).toBe("symbol");
			expect(newCall.invocation).not.toBe(oldCall.invocation);
			if (answered) oldAnswer.resolve(result({ entries: [] }));
			await vi.advanceTimersByTimeAsync(1_000);
			if (answered) expect(stop).not.toHaveBeenCalled();
			else
				expect(stop).toHaveBeenCalledExactlyOnceWith(toolId, {
					reason: "unanswered-call",
					jobId: "reused",
					invocation: oldCall.invocation,
				});
			expect(newCall.signal.aborted).toBe(false);
			newAnswer.resolve(result({ entries: [] }));
			expect((await newRun).contexts).toHaveLength(1);
			oldAnswer.resolve(result({ entries: [] }));
			await vi.advanceTimersByTimeAsync(0);
		},
	);
	it("distinguishes unanswered calls to the same instance within one job", async () => {
		vi.useFakeTimers();
		const first = deferred<string>(),
			second = deferred<string>(),
			started = deferred<void>(),
			controller = new AbortController(),
			stop = vi.fn();
		const contexts: CallContext[] = [];
		const runner = new LookupRunner({
			...host(),
			stop,
			call: async (_call, context) => {
				contexts.push(context);
				if (contexts.length === 2) started.resolve();
				return contexts.length === 1 ? first.promise : second.promise;
			},
		});
		const a = item(),
			b = item();
		a.bindings = { topic: { source: "const", value: "first" } };
		b.bindings = { topic: { source: "const", value: "second" } };
		const planned = planLookups(meta, config([a, b]), { kind: "on-demand", jobId: "shared" }, now);
		expect(planned.calls).toHaveLength(2);
		const running = runner.run(planned, controller.signal);
		await started.promise;
		const [firstCall, secondCall] = contexts;
		if (!firstCall || !secondCall) throw new Error("missing call contexts");
		expect(firstCall.invocation).not.toBe(secondCall.invocation);
		controller.abort();
		expect((await running).contexts).toEqual([]);
		first.resolve(result({ entries: [] }));
		await vi.advanceTimersByTimeAsync(5_000);
		expect(stop).toHaveBeenCalledExactlyOnceWith(toolId, {
			reason: "unanswered-call",
			jobId: "shared",
			invocation: secondCall.invocation,
		});
		second.resolve(result({ entries: [] }));
		await vi.advanceTimersByTimeAsync(0);
	});
	it("does not request a kill for a cancelled cache hit", async () => {
		vi.useFakeTimers();
		const presenting = deferred<void>(),
			finish = deferred<void>(),
			controller = new AbortController(),
			stop = vi.fn();
		let cached = false;
		const adapter = {
			...host(),
			stop,
			hygiene: async (_kind: unknown, value: unknown) => {
				if (cached) {
					presenting.resolve();
					await finish.promise;
				}
				return { data: value, findings: { instructions: 0, delimiters: 0 } };
			},
		};
		const call = vi.spyOn(adapter, "call"),
			runner = new LookupRunner(adapter);
		await runner.run(plan("prime"));
		cached = true;
		const running = runner.run(plan("cached"), controller.signal);
		await presenting.promise;
		controller.abort();
		expect((await running).skipped[0]?.reason).toBe("CANCELLED");
		await vi.advanceTimersByTimeAsync(5_000);
		expect(stop).not.toHaveBeenCalled();
		expect(call).toHaveBeenCalledTimes(1);
		finish.resolve();
		await vi.advanceTimersByTimeAsync(0);
	});
	it("requires the exact quarantined digest to release and invalidates that instance's cache", async () => {
		let drift = false;
		const base = host(),
			adapter = {
				...base,
				discover: async (...args: Parameters<typeof base.discover>) =>
					drift ? raw({ capabilities: { prompts: {} } }) : base.discover(...args),
			},
			call = vi.spyOn(adapter, "call"),
			runner = new LookupRunner(adapter);
		await runner.run(plan("prime"));
		drift = true;
		expect((await runner.run(plan("drift"))).skipped[0]?.reason).toBe("SURFACE_CHANGED");
		drift = false;
		runner.invalidateInstance(toolId);
		expect(() => runner.releaseQuarantine(toolId, "b".repeat(64))).toThrow(
			"INVALID_QUARANTINE_RELEASE",
		);
		expect((await runner.run(plan("blocked"))).skipped[0]?.reason).toBe("INSTANCE_UNAVAILABLE");
		const settings = config();
		const changedDigest = planLookups(
			meta,
			{
				...settings,
				instances: settings.instances.map((instance) => ({
					...instance,
					approvedDigest: "b".repeat(64),
					currentDigest: "b".repeat(64),
				})),
			},
			{ kind: "on-demand", jobId: "new-digest" },
			now,
		);
		expect((await runner.run(changedDigest)).skipped[0]?.reason).toBe("INSTANCE_UNAVAILABLE");
		runner.releaseQuarantine(toolId, "a".repeat(64));
		expect((await runner.run(plan("reviewed"))).contexts).toHaveLength(1);
		expect(call).toHaveBeenCalledTimes(2);
		expect(() => runner.releaseQuarantine(toolId, "a".repeat(64))).toThrow(
			"INVALID_QUARANTINE_RELEASE",
		);
	});
	it("keeps fresh native authorization mandatory after quarantine release", async () => {
		let allowed = true;
		const base = host(),
			adapter = {
				...base,
				authorize: () => allowed,
				discover: vi.fn(async () => raw({ capabilities: { prompts: {} } })),
			},
			call = vi.spyOn(adapter, "call"),
			runner = new LookupRunner(adapter);
		expect((await runner.run(plan())).skipped[0]?.reason).toBe("SURFACE_CHANGED");
		runner.releaseQuarantine(toolId, "a".repeat(64));
		allowed = false;
		expect((await runner.run(plan("revoked"))).skipped[0]?.reason).toBe("AUTHORIZATION_CHANGED");
		expect(adapter.discover).toHaveBeenCalledTimes(1);
		expect(call).not.toHaveBeenCalled();
	});
	it("retains the hourly budget across trusted quarantine release", async () => {
		let drift = false;
		const base = host(),
			runner = new LookupRunner({
				...base,
				discover: async (...args) =>
					drift ? raw({ capabilities: { prompts: {} } }) : base.discover(...args),
			});
		for (let n = 0; n < 60; n++)
			expect((await runner.run(plan(`before-${n}`, `topic-${n}`))).contexts).toHaveLength(1);
		drift = true;
		expect((await runner.run(plan("drift"))).skipped[0]?.reason).toBe("SURFACE_CHANGED");
		drift = false;
		runner.releaseQuarantine(toolId, "a".repeat(64));
		expect((await runner.run(plan("after", "new-topic"))).skipped[0]?.reason).toBe("RATE_LIMITED");
	});
});
