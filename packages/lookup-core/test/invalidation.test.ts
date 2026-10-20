import { describe, expect, it, vi } from "vitest";
import { LookupRunner, planLookups } from "../src/index.ts";
import {
	config,
	deferred,
	host,
	item,
	meta,
	now,
	plan,
	raw,
	result,
	secondId,
	toolId,
} from "./helpers.ts";

describe("in-flight lifecycle invalidation", () => {
	it.each(["account", "instance"] as const)(
		"fences a pending fetch after %s invalidation even when authorization is already restored",
		async (scope) => {
			const started = deferred<void>(),
				answer = deferred<string>(),
				base = host();
			const call = vi.fn(async (...args: Parameters<typeof base.call>) => {
				if (call.mock.calls.length === 1) {
					started.resolve();
					return answer.promise;
				}
				return base.call(...args);
			});
			const runner = new LookupRunner({ ...base, call });
			const running = runner.run(plan("invalidated-fetch"));
			await started.promise;
			if (scope === "account") runner.invalidateAccount(meta.account);
			else runner.invalidateInstance(toolId);
			answer.resolve(result({ entries: [{ label: "Old", text: "OLD_FETCH_CANARY" }] }));
			const output = await running;
			expect(output.contexts).toEqual([]);
			expect(output.skipped[0]?.reason).toBe("CANCELLED");
			const fresh = await runner.run(plan("after-invalidated-fetch"));
			expect(fresh.contexts).toHaveLength(1);
			expect(JSON.stringify(fresh)).not.toContain("OLD_FETCH_CANARY");
			expect(call).toHaveBeenCalledTimes(2);
		},
	);
	it.each(["account", "instance"] as const)(
		"fences cached data captured before %s invalidation during hygiene",
		async (scope) => {
			const started = deferred<void>(),
				finish = deferred<void>(),
				base = host();
			let hold = false;
			const call = vi.fn(base.call);
			const runner = new LookupRunner({
				...base,
				call,
				hygiene: async (_kind, data) => {
					if (hold) {
						started.resolve();
						await finish.promise;
					}
					return { data, findings: { instructions: 0, delimiters: 0 } };
				},
			});
			expect((await runner.run(plan("prime"))).contexts).toHaveLength(1);
			hold = true;
			const running = runner.run(plan("invalidated-hit"));
			await started.promise;
			if (scope === "account") runner.invalidateAccount(meta.account);
			else runner.invalidateInstance(toolId);
			finish.resolve();
			hold = false;
			const output = await running;
			expect(output.contexts).toEqual([]);
			expect(output.skipped[0]?.reason).toBe("CANCELLED");
			expect((await runner.run(plan("after-invalidated-hit"))).contexts).toHaveLength(1);
			expect(call).toHaveBeenCalledTimes(2);
		},
	);
	it("fences an already completed sibling while preserving another instance's pending work", async () => {
		const completed = deferred<void>(),
			held = deferred<string>(),
			base = host();
		const call = vi.fn(async (...args: Parameters<typeof base.call>) => {
			const [lookup, context] = args;
			if (lookup.instance.id === secondId) return held.promise;
			context.signal.addEventListener("abort", () => completed.resolve(), { once: true });
			return base.call(...args);
		});
		const runner = new LookupRunner({ ...base, call });
		const planned = planLookups(
			meta,
			config([item("kb.lookup", toolId), item("kb.lookup", secondId)]),
			{ kind: "on-demand", jobId: "parallel" },
			now,
		);
		const running = runner.run(planned);
		await completed.promise;
		runner.invalidateInstance(toolId);
		held.resolve(result({ entries: [] }));
		const output = await running;
		expect(output.contexts.map((entry) => entry.tool)).toEqual([secondId]);
		expect(output.skipped).toEqual([{ ref: "c1", reason: "CANCELLED" }]);
		expect((await runner.run(plan("fresh-sibling"))).contexts).toHaveLength(1);
		expect(call).toHaveBeenCalledTimes(3);
	});
	it("invalidates only the matching account's pending calls", async () => {
		const started = deferred<void>(),
			first = deferred<string>(),
			second = deferred<string>(),
			base = host();
		let calls = 0;
		const runner = new LookupRunner({
			...base,
			call: async (lookup) => {
				if (++calls === 2) started.resolve();
				return lookup.account === meta.account ? first.promise : second.promise;
			},
		});
		const settings = config(),
			otherMeta = { ...meta, account: "account-two" };
		const otherPlan = planLookups(
			otherMeta,
			{
				...settings,
				consents: settings.consents.map((consent) => ({ ...consent, account: otherMeta.account })),
			},
			{ kind: "on-demand", jobId: "other-account" },
			now,
		);
		const a = runner.run(plan("first-account")),
			b = runner.run(otherPlan);
		await started.promise;
		runner.invalidateAccount(meta.account);
		first.resolve(result({ entries: [] }));
		second.resolve(result({ entries: [] }));
		expect((await a).contexts).toEqual([]);
		expect((await b).contexts).toHaveLength(1);
	});
	it("keeps an old pending call fenced across matching quarantine release", async () => {
		const started = deferred<void>(),
			oldAnswer = deferred<string>(),
			base = host();
		let drift = false;
		const call = vi.fn(async (...args: Parameters<typeof base.call>) => {
			if (call.mock.calls.length === 1) {
				started.resolve();
				return oldAnswer.promise;
			}
			return base.call(...args);
		});
		const runner = new LookupRunner({
			...base,
			call,
			discover: async (...args) =>
				drift ? raw({ capabilities: { prompts: {} } }) : base.discover(...args),
		});
		const oldRun = runner.run(plan("before-quarantine", "old"));
		await started.promise;
		drift = true;
		const detection = await runner.run(plan("detect-quarantine", "changed"));
		expect(detection.skipped[0]?.reason).toBe("SURFACE_CHANGED");
		expect(detection.outcomes[0]?.status).toBe("quarantined");
		expect((await oldRun).contexts).toEqual([]);
		runner.releaseQuarantine(toolId, "a".repeat(64));
		drift = false;
		expect((await runner.run(plan("fresh-after-release", "new"))).contexts).toHaveLength(1);
		oldAnswer.resolve(result({ entries: [{ label: "Old", text: "PRE_QUARANTINE_CANARY" }] }));
		await new Promise((resolve) => setImmediate(resolve));
		const after = await runner.run(plan("old-arguments-after-release", "old"));
		expect(after.contexts).toHaveLength(1);
		expect(JSON.stringify(after)).not.toContain("PRE_QUARANTINE_CANARY");
		expect(call).toHaveBeenCalledTimes(3);
	});
	it.each(["deny-second", "invalidate-first"] as const)(
		"finishes every final authorization before admitting any sibling: %s",
		async (action) => {
			const counts = new Map<string, number>();
			const runner = new LookupRunner({
				...host(),
				authorize: (lookup) => {
					const count = (counts.get(lookup.instance.id) ?? 0) + 1;
					counts.set(lookup.instance.id, count);
					if (lookup.instance.id === secondId && count === 4) {
						if (action === "deny-second") return false;
						runner.invalidateInstance(toolId);
					}
					return true;
				},
			});
			const planned = planLookups(
				meta,
				config([item("kb.lookup", toolId), item("kb.lookup", secondId)]),
				{ kind: "on-demand", jobId: "final-siblings" },
				now,
			);
			const output = await runner.run(planned);
			expect(counts.get(toolId)).toBe(4);
			expect(counts.get(secondId)).toBe(4);
			expect(output.contexts.map((entry) => entry.tool)).toEqual(
				action === "deny-second" ? [] : [secondId],
			);
			expect(output.skipped[0]).toEqual({ ref: "c1", reason: "CANCELLED" });
			if (action === "deny-second")
				expect(output.outcomes[1]).toMatchObject({
					status: "denied",
					refusalCode: "AUTHORIZATION_CHANGED",
				});
		},
	);
	it.each(["account", "instance"] as const)(
		"checks cancellation after final authorization synchronously invalidates %s and returns true",
		async (scope) => {
			let checks = 0;
			const base = host(),
				call = vi.fn(base.call);
			const runner = new LookupRunner({
				...base,
				call,
				authorize: () => {
					if (++checks === 4) {
						if (scope === "account") runner.invalidateAccount(meta.account);
						else runner.invalidateInstance(toolId);
					}
					return true;
				},
			});
			const output = await runner.run(plan("final-invalidation"));
			expect(checks).toBe(4);
			expect(output.contexts).toEqual([]);
			expect(output.skipped).toEqual([{ ref: "c1", reason: "CANCELLED" }]);
			expect((await runner.run(plan("after-final-invalidation"))).contexts).toHaveLength(1);
			expect(call).toHaveBeenCalledTimes(2);
		},
	);
});
