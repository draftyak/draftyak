import { canonicalToolsList } from "@draftyak/protocol/tool-v1";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	LookupError,
	type LookupHost,
	LookupRunner,
	planLookups,
	type VerifiedThreadMeta,
} from "../src/index.ts";
import {
	canary,
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

afterEach(() => {
	vi.useRealTimers();
	vi.restoreAllMocks();
});

describe("injected lookup execution", () => {
	it("checks raw discovery/list before every call and cache hit; outputs provenance and actual context ids", async () => {
		const adapter = host();
		const discover = vi.spyOn(adapter, "discover"),
			list = vi.spyOn(adapter, "list"),
			call = vi.spyOn(adapter, "call");
		const runner = new LookupRunner(adapter);
		const first = await runner.run(plan());
		expect(first.contextIds).toEqual(["c1"]);
		expect(first.contexts[0]).toMatchObject({
			tool: toolId,
			kind: "kb.lookup",
			hosts: ["tools.example.invalid"],
			fetchedAt: now,
		});
		await runner.run(plan("second"));
		expect(discover).toHaveBeenCalledTimes(2);
		expect(list).toHaveBeenCalledTimes(2);
		expect(call).toHaveBeenCalledTimes(1);
	});
	it("clones cached values and re-runs hygiene without sharing mutable consumer state", async () => {
		const adapter = host(),
			call = vi.spyOn(adapter, "call");
		const runner = new LookupRunner(adapter);
		const first = await runner.run(plan());
		const returned = first.contexts[0];
		if (!returned) throw new Error("missing context");
		const mutable = (returned.data as { entries: { text: string }[] }).entries[0];
		if (!mutable) throw new Error("missing entry");
		mutable.text = canary;
		const second = await runner.run(plan("second"));
		expect(JSON.stringify(second)).not.toContain(canary);
		expect(call).toHaveBeenCalledTimes(1);
	});
	it("expires after ten minutes and invalidates on account or instance lifecycle events", async () => {
		let clock = now;
		const adapter = { ...host(), now: () => clock },
			call = vi.spyOn(adapter, "call");
		const runner = new LookupRunner(adapter);
		await runner.run(plan());
		clock += 599_999;
		await runner.run(plan("second"));
		expect(call).toHaveBeenCalledTimes(1);
		clock++;
		await runner.run(plan("third"));
		expect(call).toHaveBeenCalledTimes(2);
		runner.invalidateAccount(meta.account);
		await runner.run(plan("fourth"));
		expect(call).toHaveBeenCalledTimes(3);
		runner.invalidateInstance(toolId);
		await runner.run(plan("fifth"));
		expect(call).toHaveBeenCalledTimes(4);
	});
	it("fresh authorization gates cached results after revocation", async () => {
		let allowed = true;
		const adapter = { ...host(), authorize: () => allowed },
			call = vi.spyOn(adapter, "call");
		const runner = new LookupRunner(adapter);
		await runner.run(plan());
		allowed = false;
		expect((await runner.run(plan("revoked"))).skipped).toEqual([
			{ ref: "c1", reason: "AUTHORIZATION_CHANGED" },
		]);
		expect(call).toHaveBeenCalledTimes(1);
	});
	it("quarantines canonical-list or declaration drift, even if the quarantine callback throws", async () => {
		const settings = config();
		const entries = canonicalToolsList(settings.instances[0]?.kinds ?? []);
		const altered = entries.map((entry) => ({ ...entry, description: canary }));
		const adapter: LookupHost = {
			...host(),
			list: async () => raw({ resultType: "complete", tools: altered }),
			quarantine: () => {
				throw new Error(canary);
			},
		};
		const call = vi.spyOn(adapter, "call"),
			runner = new LookupRunner(adapter);
		const first = await runner.run(plan());
		expect(first.skipped[0]?.reason).toBe("SURFACE_CHANGED");
		expect((await runner.run(plan("again"))).skipped[0]?.reason).toBe("INSTANCE_UNAVAILABLE");
		expect(call).not.toHaveBeenCalled();
		expect(JSON.stringify(first)).not.toContain(canary);
		const extraCaps = new LookupRunner({
			...host(),
			discover: async () => raw({ capabilities: { tools: {}, prompts: {} } }),
		});
		expect((await extraCaps.run(plan())).skipped[0]?.reason).toBe("SURFACE_CHANGED");
	});
	it("rejects raw oversize, duplicate JSON keys, resource links and off-schema data without exposing values", async () => {
		for (const response of [
			"x".repeat(65_537),
			'{"resultType":"complete","resultType":"complete"}',
			raw({
				resultType: "complete",
				content: [{ type: "resource_link", uri: canary }],
				structuredContent: {},
			}),
			result({ entries: [], [canary]: canary }),
		]) {
			const run = await new LookupRunner({ ...host(), call: async () => response }).run(plan());
			expect(run.contexts).toHaveLength(0);
			expect(JSON.stringify(run)).not.toContain(canary);
		}
	});
	it("refuses a fifth request permit even if the adapter catches the refusal", async () => {
		const runner = new LookupRunner({
			...host(),
			call: async (_lookup, context) => {
				for (let i = 0; i < 5; i++) {
					try {
						context.acquireRequest();
					} catch {}
				}
				return result({ entries: [] });
			},
		});
		expect((await runner.run(plan())).skipped[0]?.reason).toBe("REQUEST_LIMIT");
	});
	it("reserves sixty calls in a rolling hour while cache hits consume no calls", async () => {
		let clock = now;
		const adapter = { ...host(), now: () => clock },
			call = vi.spyOn(adapter, "call");
		const runner = new LookupRunner(adapter);
		for (let i = 0; i < 60; i++)
			expect((await runner.run(plan(`job-${i}`, `topic-${i}`))).contexts).toHaveLength(1);
		expect((await runner.run(plan("limited", "new-topic"))).skipped[0]?.reason).toBe(
			"RATE_LIMITED",
		);
		expect((await runner.run(plan("cached", "topic-0"))).contexts).toHaveLength(1);
		expect(call).toHaveBeenCalledTimes(60);
		clock += 3_600_000;
		expect((await runner.run(plan("later", "new-topic"))).contexts).toHaveLength(1);
		expect(call).toHaveBeenCalledTimes(61);
	});
	it("separates the ten-second ready deadline from the five-second call deadline", async () => {
		vi.useFakeTimers();
		const base = host();
		const adapter: LookupHost = {
			...base,
			discover: (id, signal) =>
				new Promise((resolve) =>
					setTimeout(() => {
						void base.discover(id, signal).then(resolve);
					}, 9000),
				),
			call: () =>
				new Promise((resolve) => setTimeout(() => resolve(result({ entries: [] })), 4000)),
		};
		const running = new LookupRunner(adapter).run(plan());
		await vi.advanceTimersByTimeAsync(9000);
		await vi.advanceTimersByTimeAsync(4000);
		expect((await running).contexts).toHaveLength(1);
	});
	it("times out spawn, call and hygiene without poisoning the cache, and settles throwing cleanup", async () => {
		vi.useFakeTimers();
		for (const phase of ["discover", "call", "hygiene"] as const) {
			let stuck = true;
			const base = host(),
				stop = vi.fn(() => {
					throw new Error(canary);
				});
			const original = base[phase];
			const adapter = {
				...base,
				stop,
				[phase]: (...args: unknown[]) =>
					stuck
						? new Promise<never>(() => {})
						: (original as (...values: unknown[]) => Promise<unknown>)(...args),
			} as LookupHost;
			const call = vi.spyOn(adapter, "call"),
				runner = new LookupRunner(adapter);
			const running = runner.run(plan());
			await vi.advanceTimersByTimeAsync(phase === "discover" ? 10_000 : 5_000);
			expect((await running).skipped[0]?.reason).toBe("TIMED_OUT");
			expect(stop).not.toHaveBeenCalled();
			await vi.advanceTimersByTimeAsync(5_000);
			if (phase === "call")
				expect(stop).toHaveBeenCalledExactlyOnceWith(toolId, {
					reason: "unanswered-call",
					jobId: "job-one",
					invocation: expect.any(Symbol),
				});
			else expect(stop).not.toHaveBeenCalled();
			stuck = false;
			expect((await runner.run(plan("retry"))).contexts).toHaveLength(1);
			expect(call.mock.calls.length).toBe(phase === "discover" ? 1 : 2);
		}
	});
	it("gives calendar calls fifteen seconds after readiness", async () => {
		vi.useFakeTimers();
		const calendar = planLookups(
			meta,
			config([item("calendar.freebusy")]),
			{ kind: "on-demand", jobId: "calendar" },
			now,
		);
		const runner = new LookupRunner({ ...host(), call: async () => new Promise(() => {}) });
		const running = runner.run(calendar);
		let settled = false;
		void running.then(() => {
			settled = true;
		});
		await vi.advanceTimersByTimeAsync(14_999);
		expect(settled).toBe(false);
		await vi.advanceTimersByTimeAsync(1);
		expect((await running).skipped[0]?.reason).toBe("TIMED_OUT");
	});
	it("aborts a job without caching late results", async () => {
		const pending = deferred<string>(),
			controller = new AbortController();
		let calls = 0;
		const runner = new LookupRunner({
			...host(),
			call: async () => (++calls === 1 ? pending.promise : result({ entries: [] })),
		});
		const running = runner.run(plan(), controller.signal);
		await vi.waitFor(() => expect(calls).toBe(1));
		controller.abort();
		expect((await running).skipped[0]?.reason).toBe("CANCELLED");
		pending.resolve(result({ entries: [] }));
		expect((await runner.run(plan("next"))).contexts).toHaveLength(1);
		expect(calls).toBe(2);
	});
	it("runs three calls in parallel and applies byte admission in planned order", async () => {
		const items = [item(), item("kb.lookup", secondId), item()];
		const last = items[2];
		if (!last) throw new Error("missing item");
		last.bindings = { topic: { source: "const", value: "other" } };
		const planned = planLookups(meta, config(items), { kind: "on-demand", jobId: "parallel" }, now);
		const gate = deferred<string>();
		let started = 0;
		const runner = new LookupRunner({
			...host(),
			call: async () => {
				started++;
				return gate.promise;
			},
		});
		const running = runner.run(planned);
		await vi.waitFor(() => expect(started).toBe(3));
		gate.resolve(
			result({
				entries: [
					{ label: "Synthetic", text: "x".repeat(1750) },
					{ label: "Synthetic", text: "x".repeat(1750) },
				],
			}),
		);
		const output = await running;
		expect(output.contextIds).toEqual(["c1", "c2"]);
		expect(output.skipped).toEqual([{ ref: "c3", reason: "CONTEXT_TOO_LARGE" }]);
		expect(output.outcomes.map(({ status }) => status)).toEqual(["ok", "ok", "error"]);
		expect(output.outcomes[2]?.refusalCode).toBe("CONTEXT_TOO_LARGE");
	});
	it("rejects expanded hygiene and prevents calendar hygiene from injecting fields", async () => {
		const run = await new LookupRunner({
			...host(),
			hygiene: async () => ({
				data: { entries: [{ label: "Synthetic", text: "x".repeat(4096) }] },
				findings: { instructions: 0, delimiters: 0 },
			}),
		}).run(plan());
		expect(run.contexts).toHaveLength(0);
		const calendar = planLookups(
			meta,
			config([item("calendar.freebusy")]),
			{ kind: "on-demand", jobId: "calendar" },
			now,
		);
		const injected = await new LookupRunner({
			...host(),
			hygiene: async (_kind, data) => ({
				data: Object.assign(data as object, { [canary]: canary }),
				findings: { instructions: 0, delimiters: 0 },
			}),
		}).run(calendar);
		expect(injected.contexts).toHaveLength(0);
		expect(JSON.stringify(injected)).not.toContain(canary);
	});
	it("isolates overlapping Slack-derived jobs and stops instances after each job", async () => {
		const slack: VerifiedThreadMeta = {
			...meta,
			channel: "slack",
			sender: { kind: "slack", userId: "U12345", isBot: false },
		};
		const first = planLookups(
			slack,
			config([item("contact.notes"), item("kb.lookup", secondId)]),
			{ kind: "on-demand", jobId: "slack-one" },
			now,
		);
		const second = planLookups(
			slack,
			config([item("contact.notes")]),
			{ kind: "on-demand", jobId: "slack-two" },
			now,
		);
		const cached = deferred<void>(),
			waiting = deferred<string>();
		let checks = 0,
			contactCalls = 0;
		const stop = vi.fn();
		const runner = new LookupRunner({
			...host(),
			stop,
			authorize: (call) => {
				if (call.kind === "contact.notes" && ++checks === 3) cached.resolve();
				return true;
			},
			call: async (call) => {
				if (call.kind === "contact.notes") {
					contactCalls++;
					return result({ notes: [] });
				}
				return waiting.promise;
			},
		});
		const active = runner.run(first);
		await cached.promise;
		expect((await runner.run(second)).contexts).toHaveLength(1);
		expect(contactCalls).toBe(2);
		waiting.resolve(result({ entries: [] }));
		await active;
		expect(stop).toHaveBeenCalledWith(toolId, { reason: "slack-job-ended", jobId: "slack-one" });
		expect(stop).toHaveBeenCalledWith(toolId, { reason: "slack-job-ended", jobId: "slack-two" });
	});
	it("rejects forged derivation flags and channel values before any authority or host call", async () => {
		const slack: VerifiedThreadMeta = {
			...meta,
			channel: "slack",
			sender: { kind: "slack", userId: "U12345", isBot: false },
		};
		const original = planLookups(
			slack,
			config([item("contact.notes")]),
			{ kind: "on-demand", jobId: "forged" },
			now,
		);
		const adapter = host(),
			authorize = vi.spyOn(adapter, "authorize"),
			discover = vi.spyOn(adapter, "discover"),
			call = vi.spyOn(adapter, "call");
		const runner = new LookupRunner(adapter);
		for (const mutation of [
			{ messageDerived: false },
			{ slackDerived: false },
			{ messageDerived: false, slackDerived: false },
			{ channel: "sms", slackDerived: false },
			{ channel: "unknown" },
		]) {
			const forged = {
				...original,
				calls: original.calls.map((lookup) => ({ ...lookup, ...mutation })),
			} as unknown as typeof original;
			await expect(runner.run(forged)).rejects.toMatchObject({ code: "INVALID_JOB" });
		}
		expect(authorize).not.toHaveBeenCalled();
		expect(discover).not.toHaveBeenCalled();
		expect(call).not.toHaveBeenCalled();
	});
	it("settles asynchronous stop and quarantine failures without unhandled rejections", async () => {
		const cleanup = async (): Promise<void> => {
			throw new Error(canary);
		};
		const drift = new LookupRunner({
			...host(),
			quarantine: cleanup,
			discover: async () => raw({ capabilities: { prompts: {} } }),
		});
		expect((await drift.run(plan())).skipped[0]?.reason).toBe("SURFACE_CHANGED");
		const slack: VerifiedThreadMeta = {
			...meta,
			channel: "slack",
			sender: { kind: "slack", userId: "U12345", isBot: false },
		};
		const planned = planLookups(
			slack,
			config([item("contact.notes")]),
			{ kind: "on-demand", jobId: "cleanup" },
			now,
		);
		expect(
			(await new LookupRunner({ ...host(), stop: cleanup }).run(planned)).contexts,
		).toHaveLength(1);
	});
	it("rejects duplicate plans, refuses closed runners, and sanitizes adapter failures", async () => {
		const planned = plan(),
			runner = new LookupRunner(host());
		const first = planned.calls[0];
		if (!first) throw new Error("missing call");
		await expect(
			runner.run({ ...planned, calls: [first, { ...first, ref: "c2" }] }),
		).rejects.toBeInstanceOf(LookupError);
		runner.close();
		await expect(runner.run(plan())).rejects.toBeInstanceOf(LookupError);
		const logs = [vi.spyOn(console, "log"), vi.spyOn(console, "error"), vi.spyOn(console, "warn")];
		const output = await new LookupRunner({
			...host(),
			call: async () => {
				throw new Error(canary);
			},
		}).run(plan());
		expect(output.skipped[0]?.reason).toBe("LOOKUP_FAILED");
		expect(JSON.stringify(output)).not.toContain(canary);
		for (const log of logs) expect(log).not.toHaveBeenCalled();
	});
});
