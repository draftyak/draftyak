import { expect, it } from "vitest";
import { type LookupProvenance, LookupRunner } from "../src/index.ts";
import { host, now, plan } from "./helpers.ts";

it("gives hygiene a frozen fetch identity shared by the context and cache despite time spent cleaning", async () => {
	const base = host(),
		seen: LookupProvenance[] = [];
	let clock = now,
		calls = 0;
	const runner = new LookupRunner({
		...base,
		now: () => clock++,
		async call(...args) {
			calls++;
			return base.call(...args);
		},
		async hygiene(kind, value, signal, provenance, jobId) {
			expect(Object.isFrozen(provenance)).toBe(true);
			expect(Object.keys(provenance).sort()).toEqual(["fetchedAt", "hosts", "kind", "ref", "tool"]);
			expect(Object.isFrozen(provenance.hosts)).toBe(true);
			expect(Reflect.set(provenance, "fetchedAt", 0)).toBe(false);
			seen.push(provenance);
			clock += 100;
			await Promise.resolve();
			return base.hygiene(kind, value, signal, provenance, jobId);
		},
	});
	try {
		const first = await runner.run(plan("first-hygiene")),
			context = first.contexts[0];
		if (!context) throw new Error("Missing fixture context");
		const { data: _data, ...identity } = context,
			fetchedAt = context.fetchedAt;
		expect(seen[0]).toEqual(identity);
		// Raw receipt, rather than the later hygiene completion, starts the ten-minute TTL.
		clock = fetchedAt + 599_999;
		const cached = await runner.run(plan("cached-hygiene"));
		expect(cached.contexts).toEqual(first.contexts);
		expect(seen[1]).toEqual(seen[0]);
		expect(calls).toBe(1);
		clock = fetchedAt + 600_000;
		const expired = await runner.run(plan("expired-hygiene"));
		expect(calls).toBe(2);
		expect(expired.contexts[0]?.fetchedAt).toBeGreaterThan(fetchedAt);
		expect(seen[2]?.fetchedAt).toBe(expired.contexts[0]?.fetchedAt);
	} finally {
		runner.close();
	}
});
