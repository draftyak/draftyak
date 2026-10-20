import { afterEach, expect, it, vi } from "vitest";
import { LookupRunner, type RawFrame } from "../src/index.ts";
import { deferred, host, meta, plan, raw, toolId } from "./helpers.ts";

afterEach(() => vi.useRealTimers());

for (const stop of ["timeout", "cancel", "invalidate-instance", "invalidate-account"] as const) {
	for (const late of ["valid-discovery", "changed-discovery", "changed-list"] as const) {
		it(`ignores ${late} after ${stop}, without starting another stage or quarantining`, async () => {
			vi.useFakeTimers();
			const base = host(),
				held = deferred<RawFrame>(),
				started = deferred<void>(),
				controller = new AbortController();
			let listCalls = 0,
				toolCalls = 0,
				quarantines = 0;
			const runner = new LookupRunner({
				...base,
				async discover(...args) {
					if (late !== "changed-list") {
						started.resolve(undefined);
						return held.promise;
					}
					return base.discover(...args);
				},
				async list() {
					listCalls++;
					started.resolve(undefined);
					return held.promise;
				},
				async call(...args) {
					toolCalls++;
					return base.call(...args);
				},
				quarantine() {
					quarantines++;
				},
			});
			try {
				const pending = runner.run(plan(`late-${late}-${stop}`), controller.signal);
				await started.promise;
				if (stop === "timeout") await vi.advanceTimersByTimeAsync(10_000);
				else if (stop === "cancel") controller.abort();
				else if (stop === "invalidate-instance") runner.invalidateInstance(toolId);
				else runner.invalidateAccount(meta.account);
				const result = await pending;
				expect(result.contexts).toEqual([]);
				expect(result.skipped).toEqual([
					{ ref: "c1", reason: stop === "timeout" ? "TIMED_OUT" : "CANCELLED" },
				]);
				expect(listCalls).toBe(late === "changed-list" ? 1 : 0);
				// The adapter ignores abort and resolves after the caller already received a result.
				held.resolve(
					late === "valid-discovery"
						? await base.discover("fixture", new AbortController().signal)
						: late === "changed-discovery"
							? raw({ capabilities: { tools: {}, prompts: {} } })
							: raw({ resultType: "complete", tools: [] }),
				);
				await vi.advanceTimersByTimeAsync(0);
				expect(listCalls).toBe(late === "changed-list" ? 1 : 0);
				expect(toolCalls).toBe(0);
				expect(quarantines).toBe(0);
			} finally {
				runner.close();
			}
		});
	}
}
