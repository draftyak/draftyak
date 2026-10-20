import { jcsSha256 } from "@draftyak/protocol/hash";
import { canonicalize } from "@draftyak/protocol/jcs";
import { TOOL_ERROR_META_KEY } from "@draftyak/protocol/tool-v1";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	type LookupHost,
	type LookupHygieneResult,
	LookupRunner,
	planLookups,
} from "../src/index.ts";
import { config, deferred, host, item, meta, now, plan, raw, result, toolId } from "./helpers.ts";

const runners: LookupRunner[] = [];
const runnerFor = (adapter: LookupHost): LookupRunner => {
	const runner = new LookupRunner(adapter);
	runners.push(runner);
	return runner;
};
afterEach(() => {
	for (const runner of runners.splice(0)) runner.close();
	vi.restoreAllMocks();
	vi.useRealTimers();
});
const errorFrame = (code: "AUTH_REVOKED" | "RATE_LIMITED", retryAfterMs?: number): string =>
	raw({
		resultType: "complete",
		content: [],
		isError: true,
		_meta: {
			[TOOL_ERROR_META_KEY]: { code, retryAfterMs, detail: "PRIVATE_PLUGIN_DETAIL_CANARY" },
		},
	});

describe("content-free lookup outcomes", () => {
	it.each(["AUTH_REVOKED", "RATE_LIMITED"] as const)(
		"preserves %s and retry delay without admitting plugin detail",
		async (code) => {
			const runner = runnerFor({ ...host(), call: async () => errorFrame(code, 12_345) });
			const output = await runner.run(plan(`error-${code}`));
			expect(output.contexts).toEqual([]);
			expect(output.outcomes).toHaveLength(1);
			expect(output.outcomes[0]).toMatchObject({
				ref: "c1",
				instance: toolId,
				kind: "kb.lookup",
				status: "error",
				pluginError: { code, retryAfterMs: 12_345 },
				truncated: false,
			});
			expect(output.outcomes[0]?.refusalCode).toBeUndefined();
			expect(output.outcomes[0]?.hygieneFindings).toBeUndefined();
			expect(JSON.stringify(output)).not.toContain("PRIVATE_PLUGIN_DETAIL_CANARY");
		},
	);

	it("reports an oversize calendar refusal distinctly and never turns it into availability", async () => {
		const busy = Array.from({ length: 350 }, (_, index) => ({
			start: now + index * 120_000,
			end: now + index * 120_000 + 60_000,
			status: "tentative",
		}));
		const adapter = { ...host(), call: async () => result({ busy }) };
		const hygiene = vi.spyOn(adapter, "hygiene");
		const settings = config([item("calendar.freebusy")]);
		const planned = planLookups(
			meta,
			{
				...settings,
				instances: settings.instances.map((instance) => ({
					...instance,
					outputMaxBytes: { ...instance.outputMaxBytes, "calendar.freebusy": 1_000_000 },
				})),
			},
			{ kind: "on-demand", jobId: "oversize-calendar" },
			now,
		);
		expect(planned.calls).toHaveLength(1);
		const output = await runnerFor(adapter).run(planned);
		expect(output.contexts).toEqual([]);
		expect(output.outcomes[0]).toMatchObject({
			status: "error",
			refusalCode: "TOOL_RESULT_TOO_LARGE",
			rawBytes: Buffer.byteLength(canonicalize({ busy })),
			truncated: false,
		});
		expect(output.outcomes[0]?.cleanBytes).toBeUndefined();
		expect(hygiene).not.toHaveBeenCalled();
	});

	it("enforces the requested kind's explicit smaller output ceiling", async () => {
		const settings = config();
		const planned = planLookups(
			meta,
			{
				...settings,
				instances: settings.instances.map((instance) => ({
					...instance,
					outputMaxBytes: { ...instance.outputMaxBytes, "kb.lookup": 8 },
				})),
			},
			{ kind: "on-demand", jobId: "small-ceiling" },
			now,
		);
		expect(planned.calls).toHaveLength(1);
		const adapter = host(),
			hygiene = vi.spyOn(adapter, "hygiene");
		const output = await runnerFor(adapter).run(planned);
		expect(output.outcomes[0]).toMatchObject({
			status: "error",
			refusalCode: "TOOL_RESULT_TOO_LARGE",
		});
		expect(output.contexts).toEqual([]);
		expect(hygiene).not.toHaveBeenCalled();
	});

	it("rechecks a tightened ceiling before using a previously valid cached result", async () => {
		const adapter = host(),
			call = vi.spyOn(adapter, "call"),
			runner = runnerFor(adapter);
		expect((await runner.run(plan("before-tightening"))).outcomes[0]?.status).toBe("ok");
		const settings = config();
		const tightened = planLookups(
			meta,
			{
				...settings,
				instances: settings.instances.map((instance) => ({
					...instance,
					outputMaxBytes: { ...instance.outputMaxBytes, "kb.lookup": 8 },
				})),
			},
			{ kind: "on-demand", jobId: "after-tightening" },
			now,
		);
		expect(tightened.calls).toHaveLength(1);
		const output = await runner.run(tightened);
		expect(call).toHaveBeenCalledTimes(2);
		expect(output.contexts).toEqual([]);
		expect(output.outcomes[0]).toMatchObject({
			status: "error",
			refusalCode: "TOOL_RESULT_TOO_LARGE",
		});
		expect(output.outcomes[0]?.cachedAgeMs).toBeUndefined();
	});

	it("records canonical UTF-8 bytes, monotonic latency and cache age while rerunning job-bound hygiene", async () => {
		let elapsed = 0,
			clock = now;
		vi.spyOn(performance, "now").mockImplementation(() => elapsed);
		const original = { entries: [{ label: "Fixture", text: "Résumé café" }] };
		const cleaned = { entries: [{ label: "Fixture", text: "Café" }] };
		const base = host(),
			jobs: string[] = [];
		const adapter: LookupHost = {
			...base,
			now: () => clock,
			discover: async (...args) => {
				elapsed += 7;
				return base.discover(...args);
			},
			list: async (...args) => {
				elapsed += 3;
				return base.list(...args);
			},
			call: async () => {
				elapsed += 11;
				return result(original);
			},
			hygiene: async (_kind, _value, _signal, _provenance, jobId) => {
				jobs.push(jobId);
				elapsed += 5;
				return { data: cleaned, findings: { instructions: 2, delimiters: 1 } };
			},
		};
		const call = vi.spyOn(adapter, "call"),
			runner = runnerFor(adapter);
		const first = await runner.run(plan("first-outcome"));
		clock += 120_000;
		const cached = await runner.run(plan("cached-outcome"));
		expect(first.outcomes[0]).toMatchObject({
			status: "ok",
			rawBytes: Buffer.byteLength(canonicalize(original)),
			cleanBytes: Buffer.byteLength(canonicalize(cleaned)),
			latencyMs: 26,
			hygieneFindings: { instructions: 2, delimiters: 1 },
		});
		expect(cached.outcomes[0]).toMatchObject({
			status: "cached",
			cachedAgeMs: 120_000,
			rawBytes: first.outcomes[0]?.rawBytes,
			cleanBytes: first.outcomes[0]?.cleanBytes,
			latencyMs: 15,
			hygieneFindings: { instructions: 2, delimiters: 1 },
		});
		expect(first.outcomes[0]?.cachedAgeMs).toBeUndefined();
		expect(cached.contexts).toEqual(first.contexts);
		expect(call).toHaveBeenCalledTimes(1);
		expect(jobs).toEqual(["first-outcome", "cached-outcome"]);
		expect(JSON.stringify(first.outcomes)).not.toContain("Résumé");
	});

	it("keeps overlapping jobs' hygiene findings associated with the right draft", async () => {
		const entered = deferred<void>(),
			firstGate = deferred<void>(),
			secondGate = deferred<void>();
		const seen = new Set<string>();
		const runner = runnerFor({
			...host(),
			hygiene: async (_kind, value, _signal, _provenance, jobId) => {
				seen.add(jobId);
				if (seen.size === 2) entered.resolve();
				await (jobId === "overlap-first" ? firstGate.promise : secondGate.promise);
				return {
					data: value,
					findings:
						jobId === "overlap-first"
							? { instructions: 1, delimiters: 0 }
							: { instructions: 0, delimiters: 2 },
				};
			},
		});
		const first = runner.run(plan("overlap-first")),
			second = runner.run(plan("overlap-second"));
		try {
			await entered.promise;
			secondGate.resolve();
			expect((await second).outcomes[0]?.hygieneFindings).toEqual({
				instructions: 0,
				delimiters: 2,
			});
			firstGate.resolve();
			expect((await first).outcomes[0]?.hygieneFindings).toEqual({
				instructions: 1,
				delimiters: 0,
			});
			expect([...seen].sort()).toEqual(["overlap-first", "overlap-second"]);
		} finally {
			firstGate.resolve();
			secondGate.resolve();
		}
	});

	it.each([
		{ data: { entries: [] } },
		{ data: undefined, findings: { instructions: 0, delimiters: 0 } },
		{ data: { entries: [] }, findings: { instructions: -1, delimiters: 0 } },
		{ data: { entries: [] }, findings: { instructions: 1.5, delimiters: 0 } },
		{ data: { entries: [] }, findings: { instructions: 65_537, delimiters: 0 } },
		{
			data: { entries: [] },
			findings: { instructions: 0, delimiters: 0, detail: "PRIVATE_FINDING_CANARY" },
		},
		{
			data: { entries: [] },
			findings: { instructions: 0, delimiters: 0 },
			detail: "PRIVATE_FINDING_CANARY",
		},
	])(
		"refuses incomplete or unbounded hygiene metadata without echoing it: %#",
		async (returned) => {
			const runner = runnerFor({ ...host(), hygiene: async () => returned as LookupHygieneResult });
			const output = await runner.run(plan());
			expect(output.contexts).toEqual([]);
			expect(output.outcomes[0]).toMatchObject({ status: "error", refusalCode: "HYGIENE_REFUSED" });
			expect(JSON.stringify(output)).not.toContain("PRIVATE_FINDING_CANARY");
		},
	);

	it.each(["denied", "quarantined", "timeout", "skipped"] as const)(
		"records the actual %s outcome for an issued call",
		async (status) => {
			vi.useFakeTimers();
			const controller = new AbortController();
			const adapter: LookupHost = {
				...host(),
				...(status === "denied" ? { authorize: () => false } : {}),
				...(status === "quarantined"
					? { discover: async () => raw({ capabilities: { tools: {}, extensions: {} } }) }
					: {}),
				...(status === "timeout"
					? { discover: async (): Promise<string> => new Promise(() => {}) }
					: {}),
			};
			if (status === "skipped") controller.abort();
			const running = runnerFor(adapter).run(plan(`outcome-${status}`), controller.signal);
			if (status === "timeout") await vi.advanceTimersByTimeAsync(10_000);
			const output = await running;
			expect(output.contexts).toEqual([]);
			expect(output.outcomes).toHaveLength(1);
			expect(output.outcomes[0]).toMatchObject({
				ref: "c1",
				instance: toolId,
				kind: "kb.lookup",
				status,
				truncated: false,
			});
		},
	);

	it("exposes only pending confirmation metadata needed to confirm the exact later call", async () => {
		const settings = config([item("contact.notes")]);
		const cloud = {
			...settings,
			instances: settings.instances.map((instance) => ({
				...instance,
				destination: "cloud-tool" as const,
				posture: "no-train" as const,
			})),
		};
		const pending = planLookups(meta, cloud, { kind: "on-demand", jobId: "confirm-outcome" }, now);
		const digest = jcsSha256({
			instance: toolId,
			kind: "contact.notes",
			arguments: { participant: "synthetic@example.invalid" },
		});
		expect(pending.calls).toEqual([]);
		expect(pending.pendingConfirmations).toEqual([
			{
				index: 0,
				instance: toolId,
				kind: "contact.notes",
				boundFields: ["participant"],
				argumentDigest: digest,
			},
		]);
		expect(Object.isFrozen(pending.pendingConfirmations)).toBe(true);
		expect(Object.isFrozen(pending.pendingConfirmations[0]?.boundFields)).toBe(true);
		expect(JSON.stringify(pending.pendingConfirmations)).not.toContain("synthetic@example.invalid");
		const confirmed = planLookups(
			meta,
			cloud,
			{
				kind: "on-demand",
				jobId: "confirm-outcome",
				confirmation: {
					jobId: "confirm-outcome",
					account: meta.account,
					argumentDigests: [digest],
				},
			},
			now,
		);
		expect(confirmed.calls).toHaveLength(1);
		expect(confirmed.calls[0]?.argumentDigest).toBe(digest);
		expect(confirmed.pendingConfirmations).toEqual([]);
		expect((await runnerFor(host()).run(confirmed)).outcomes[0]?.status).toBe("ok");
	});
});
