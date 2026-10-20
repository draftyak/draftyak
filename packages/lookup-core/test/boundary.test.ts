import { describe, expect, it, vi } from "vitest";
import { LookupError, LookupRunner, planLookups } from "../src/index.ts";
import { config, deferred, host, meta, now, plan, result, toolId } from "./helpers.ts";

describe("trusted lookup data and issued-plan provenance", () => {
	it("normalizes arbitrary route error codes to a fixed planner refusal", () => {
		expect(() =>
			planLookups(
				meta,
				{
					...config(),
					route: () => {
						throw new LookupError("PRIVATE_ROUTE_CANARY");
					},
				},
				{ kind: "on-demand", jobId: "native-job" },
				now,
			),
		).toThrow(new LookupError("INVALID_INPUT"));
	});
	it("refuses a forged plan getter before authorization, clock or host callbacks", async () => {
		const original = plan(),
			candidate = { ...original };
		let hooks = 0;
		Object.defineProperty(candidate, "jobId", {
			enumerable: true,
			get() {
				hooks++;
				return original.jobId;
			},
		});
		const adapter = host(),
			authorize = vi.spyOn(adapter, "authorize"),
			clock = vi.spyOn(adapter, "now"),
			discover = vi.spyOn(adapter, "discover");
		await expect(new LookupRunner(adapter).run(candidate)).rejects.toMatchObject({
			code: "INVALID_JOB",
		});
		expect(hooks).toBe(0);
		expect(authorize).not.toHaveBeenCalled();
		expect(clock).not.toHaveBeenCalled();
		expect(discover).not.toHaveBeenCalled();
	});
	it("keeps unrelated message contents and display fields unread", () => {
		let hooks = 0;
		const thread = { ...meta };
		for (const name of ["body", "subject", "displayName", "replyTo", "authenticationResults"])
			Object.defineProperty(thread, name, {
				enumerable: true,
				get() {
					hooks++;
					throw new Error("PRIVATE_UNUSED_CANARY");
				},
			});
		expect(planLookups(thread, config(), { kind: "on-demand", jobId: "job-one" }, now)).toEqual(
			plan(),
		);
		expect(hooks).toBe(0);
	});
	it("captures native configuration before a route callback changes the original", () => {
		const settings = config(),
			first = settings.instances[0];
		if (!first) throw new Error("Expected instance");
		const route = vi.fn(() => {
			Object.assign(first, { hosts: ["changed.example.invalid"], currentDigest: "b".repeat(64) });
			return true;
		});
		const planned = planLookups(
			meta,
			{ ...settings, route },
			{ kind: "on-demand", jobId: "native-job" },
			now,
		);
		expect(route).toHaveBeenCalledTimes(2);
		expect(planned.calls[0]?.instance.hosts).toEqual(["tools.example.invalid"]);
		expect(planned.calls[0]?.instance.currentDigest).toBe("a".repeat(64));
		expect(Object.isFrozen(planned.calls[0]?.arguments)).toBe(true);
	});
	it("keeps the issued plan detached from caller mutation during readiness", async () => {
		const settings = config(),
			issued = planLookups(meta, settings, { kind: "on-demand", jobId: "native-job" }, now),
			gate = deferred<void>(),
			base = host(),
			seen: string[] = [];
		const adapter = {
			...base,
			discover: async (id: string, signal: AbortSignal) => {
				await gate.promise;
				return base.discover(id, signal);
			},
			call: async (call: Parameters<typeof base.call>[0]) => {
				seen.push(JSON.stringify(call));
				return result({ entries: [] });
			},
		};
		const running = new LookupRunner(adapter).run(issued);
		const first = settings.presets[0]?.items[0],
			instance = settings.instances[0];
		if (!first || !instance) throw new Error("Expected configuration");
		Object.assign(first.bindings, { topic: { source: "const", value: "changed" } });
		Object.assign(instance, { hosts: ["changed.example.invalid"], currentDigest: "b".repeat(64) });
		gate.resolve();
		const output = await running;
		expect(output.contextIds).toEqual(["c1"]);
		expect(seen).toHaveLength(1);
		expect(seen[0]).toContain('"topic":"company"');
		expect(seen[0]).not.toContain("changed");
	});
	it("accepts ordinary Uint8Array, Buffer, subclass and shared-backed JSON frames", async () => {
		const base = host(),
			raw = await base.discover(toolId, new AbortController().signal);
		if (typeof raw !== "string") throw new Error("Expected synthetic string frame");
		const bytes = new TextEncoder().encode(raw);
		class Bytes extends Uint8Array {}
		const shared = new Uint8Array(new SharedArrayBuffer(bytes.length));
		shared.set(bytes);
		for (const frame of [bytes, Buffer.from(bytes), new Bytes(bytes), shared])
			expect(
				(await new LookupRunner({ ...base, discover: async () => frame }).run(plan())).contextIds,
			).toEqual(["c1"]);
	});
});
