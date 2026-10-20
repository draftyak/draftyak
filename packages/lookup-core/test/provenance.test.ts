import { expect, it } from "vitest";
import { type LookupPlan, type LookupProvenance, LookupRunner, planLookups } from "../src/index.ts";
import { config, host, meta, now, plan, result, toolId } from "./helpers.ts";

it("retains one fetch identity on a cache hit while rerunning current authorization and presentation", async () => {
	const base = host();
	let clock = now,
		calls = 0,
		discoveries = 0,
		lists = 0,
		hygienePasses = 0,
		authorizations = 0;
	const runner = new LookupRunner({
		...base,
		now: () => clock++,
		authorize(call) {
			authorizations++;
			return base.authorize(call);
		},
		async discover(...args) {
			discoveries++;
			return base.discover(...args);
		},
		async list(...args) {
			lists++;
			return base.list(...args);
		},
		async call(...args) {
			calls++;
			return base.call(...args);
		},
		async hygiene(...args) {
			hygienePasses++;
			return base.hygiene(...args);
		},
	});
	try {
		const first = await runner.run(plan("first-fetch")),
			checksAfterFirst = authorizations,
			cached = await runner.run(plan("cached-fetch"));
		expect(first.skipped).toEqual([]);
		expect(first.contexts).toHaveLength(1);
		expect(cached.contexts).toEqual(first.contexts);
		expect(calls).toBe(1);
		expect(discoveries).toBe(2);
		expect(lists).toBe(2);
		expect(hygienePasses).toBe(2);
		expect(authorizations).toBeGreaterThan(checksAfterFirst);
		const fetchedAt = first.contexts[0]?.fetchedAt;
		if (fetchedAt === undefined) throw new Error("Missing fixture provenance");
		// The same timestamp remains the TTL origin; a hit cannot renew it.
		clock = fetchedAt + 600_000;
		const refreshed = await runner.run(plan("expired-fetch"));
		expect(calls).toBe(2);
		expect(refreshed.contexts).toHaveLength(1);
		expect(refreshed.contexts[0]?.fetchedAt).toBeGreaterThan(fetchedAt);
		expect(refreshed.contexts[0]?.data).toEqual(first.contexts[0]?.data);
	} finally {
		runner.close();
	}
});

it("refetches changed-host bytes instead of relabeling a prior host's cached data", async () => {
	const firstHost = "tools.example.invalid",
		secondHost = "replacement.example.invalid",
		base = host(),
		wires: { hosts: readonly string[]; bytes: Buffer }[] = [],
		identities: LookupProvenance[] = [];
	let clock = now;
	const planned = (jobId: string, sourceHost: string): LookupPlan => {
		const settings = config();
		return planLookups(
			meta,
			{
				...settings,
				instances: settings.instances.map((instance) =>
					instance.id === toolId ? { ...instance, hosts: [sourceHost] } : instance,
				),
			},
			{ kind: "on-demand", jobId },
			now,
		);
	};
	const firstPlan = planned("host-first", firstHost),
		secondPlan = planned("host-second", secondHost),
		runner = new LookupRunner({
			...base,
			now: () => clock++,
			async call(lookup, context) {
				context.acquireRequest();
				const bytes = Buffer.from(
					result({
						entries: [{ label: "Source", text: `SOURCE_HOST=${lookup.instance.hosts.join(",")}` }],
					}),
				);
				wires.push({ hosts: lookup.instance.hosts, bytes });
				return bytes;
			},
			async hygiene(kind, value, signal, provenance, jobId) {
				identities.push(provenance);
				return base.hygiene(kind, value, signal, provenance, jobId);
			},
		});
	try {
		expect(firstPlan.calls).toHaveLength(1);
		expect(secondPlan.calls).toHaveLength(1);
		expect(secondPlan.calls[0]?.instance.id).toBe(firstPlan.calls[0]?.instance.id);
		expect(secondPlan.calls[0]?.instance.currentDigest).toBe(
			firstPlan.calls[0]?.instance.currentDigest,
		);
		expect(secondPlan.calls[0]?.argumentDigest).toBe(firstPlan.calls[0]?.argumentDigest);
		const first = await runner.run(firstPlan),
			cachedFirst = await runner.run(planned("host-first-cached", firstHost));
		expect(first.contextIds).toEqual(["c1"]);
		expect(cachedFirst.contexts).toEqual(first.contexts);
		expect(wires).toHaveLength(1);
		const second = await runner.run(secondPlan),
			cachedSecond = await runner.run(planned("host-second-cached", secondHost));
		expect(second.contextIds).toEqual(["c1"]);
		expect(cachedSecond.contexts).toEqual(second.contexts);
		expect(wires.map(({ hosts }) => hosts)).toEqual([[firstHost], [secondHost]]);
		for (const [index, sourceHost] of [firstHost, secondHost].entries()) {
			const context = (index === 0 ? first : second).contexts[0];
			expect(context?.hosts).toEqual([sourceHost]);
			expect(context?.data).toEqual({
				entries: [{ label: "Source", text: `SOURCE_HOST=${sourceHost}` }],
			});
			expect(wires[index]?.bytes.toString("utf8")).toContain(`SOURCE_HOST=${sourceHost}`);
			expect(identities[index * 2]?.hosts).toEqual([sourceHost]);
			expect(identities[index * 2 + 1]).toEqual(identities[index * 2]);
		}
		expect(second.contexts[0]?.fetchedAt).toBeGreaterThan(first.contexts[0]?.fetchedAt ?? 0);
	} finally {
		runner.close();
	}
});
