import { afterEach, expect, it, vi } from "vitest";
import { LookupRunner } from "../src/index.ts";
import { host, plan } from "./helpers.ts";

afterEach(() => vi.restoreAllMocks());

for (const phase of ["discover", "list", "call", "hygiene", "final-authorization"] as const) {
	it(`refuses an elapsed ${phase} stage before timers run, without advancing or caching it`, async () => {
		let elapsed = 0,
			late = true,
			authorizations = 0;
		vi.spyOn(performance, "now").mockImplementation(() => elapsed);
		const base = host(),
			seenSignals: AbortSignal[] = [];
		const discover = vi.fn(async (...args: Parameters<typeof base.discover>) => {
			seenSignals.push(args[1]);
			const value = await base.discover(...args);
			if (late && phase === "discover") elapsed += 10_000;
			return value;
		});
		const list = vi.fn(async (...args: Parameters<typeof base.list>) => {
			seenSignals.push(args[1]);
			const value = await base.list(...args);
			if (late && phase === "list") elapsed += 10_000;
			return value;
		});
		const call = vi.fn(async (...args: Parameters<typeof base.call>) => {
			seenSignals.push(args[1].signal);
			const value = await base.call(...args);
			if (late && phase === "call") elapsed += 5_000;
			return value;
		});
		const hygiene = vi.fn(async (...args: Parameters<typeof base.hygiene>) => {
			seenSignals.push(args[2]);
			const value = await base.hygiene(...args);
			if (late && phase === "hygiene") elapsed += 5_000;
			return value;
		});
		const quarantine = vi.fn(),
			stop = vi.fn(),
			runner = new LookupRunner({
				...base,
				discover,
				list,
				call,
				hygiene,
				quarantine,
				stop,
				authorize(lookup) {
					// Third check is after presentation and before native cache/context admission.
					if (++authorizations === 3 && late && phase === "final-authorization") elapsed += 5_000;
					return base.authorize(lookup);
				},
			});
		try {
			const first = await runner.run(plan(`elapsed-${phase}`));
			expect(first.contexts).toEqual([]);
			expect(first.skipped).toEqual([{ ref: "c1", reason: "TIMED_OUT" }]);
			expect(stop).not.toHaveBeenCalled();
			expect(quarantine).not.toHaveBeenCalled();
			expect(seenSignals.at(-1)?.aborted).toBe(true);
			expect(list).toHaveBeenCalledTimes(phase === "discover" ? 0 : 1);
			const attempted = phase === "discover" || phase === "list" ? 0 : 1;
			expect(call).toHaveBeenCalledTimes(attempted);
			expect(hygiene).toHaveBeenCalledTimes(
				phase === "hygiene" || phase === "final-authorization" ? 1 : 0,
			);
			late = false;
			expect((await runner.run(plan(`retry-${phase}`))).contextIds).toEqual(["c1"]);
			expect(call).toHaveBeenCalledTimes(attempted + 1);
		} finally {
			runner.close();
		}
	});
}

it("preserves parent cancellation when it coincides with elapsed hygiene", async () => {
	let elapsed = 0;
	vi.spyOn(performance, "now").mockImplementation(() => elapsed);
	const base = host(),
		controller = new AbortController(),
		runner = new LookupRunner({
			...base,
			async hygiene(...args) {
				const value = await base.hygiene(...args);
				elapsed += 5_000;
				controller.abort();
				return value;
			},
		});
	try {
		expect(await runner.run(plan("cancel-at-deadline"), controller.signal)).toMatchObject({
			contexts: [],
			skipped: [{ ref: "c1", reason: "CANCELLED" }],
		});
	} finally {
		runner.close();
	}
});

it("starts a fresh call budget after readiness, accepting work just inside both limits", async () => {
	let elapsed = 0;
	vi.spyOn(performance, "now").mockImplementation(() => elapsed);
	const base = host(),
		runner = new LookupRunner({
			...base,
			async discover(...args) {
				const value = await base.discover(...args);
				elapsed += 9_999;
				return value;
			},
			async call(...args) {
				const value = await base.call(...args);
				elapsed += 4_999;
				return value;
			},
		});
	try {
		expect((await runner.run(plan("separate-elapsed-budgets"))).contextIds).toEqual(["c1"]);
	} finally {
		runner.close();
	}
});

it("removes a staged cache entry if time expires before the deadline race publishes it", async () => {
	let elapsed = 0,
		authorizations = 0,
		late = true;
	vi.spyOn(performance, "now").mockImplementation(() => elapsed);
	const base = host(),
		call = vi.fn(base.call),
		runner = new LookupRunner({
			...base,
			call,
			authorize(lookup) {
				if (++authorizations === 3 && late) queueMicrotask(() => (elapsed += 5_000));
				return base.authorize(lookup);
			},
		});
	try {
		expect((await runner.run(plan("elapsed-publication"))).skipped).toEqual([
			{ ref: "c1", reason: "TIMED_OUT" },
		]);
		late = false;
		expect((await runner.run(plan("retry-publication"))).contextIds).toEqual(["c1"]);
		expect(call).toHaveBeenCalledTimes(2);
	} finally {
		runner.close();
	}
});
