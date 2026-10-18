import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
	acquireBenchLock,
	assertContentFree,
	type Fingerprint,
	MachineBusyError,
	writeEvidence,
} from "@draftyak/spike-kit";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
	BUDGETS,
	judge,
	percentile,
	ROW_KIND,
	strictBudgets,
	unloaded,
	verdict,
} from "./budget-rules.ts";
import { benchLock, busiestOf, busyReport, lockFailsFast, lockMessage } from "./budgets.ts";

describe("budget verdicts", () => {
	it("passes up to the budget, misses up to twice it, and fails beyond", () => {
		expect(verdict(1_500, BUDGETS.coldStartP50Ms)).toBe("PASS");
		expect(verdict(1_501, BUDGETS.coldStartP50Ms)).toBe("MISS");
		expect(verdict(3_000, BUDGETS.coldStartP50Ms)).toBe("MISS");
		expect(verdict(3_001, BUDGETS.coldStartP50Ms)).toBe("FAIL");
		expect(verdict(0, BUDGETS.roundTripP50Ms)).toBe("PASS");
	});

	it("pins the plan's budgets, and which of them load can only make worse", () => {
		expect(BUDGETS).toEqual({
			coldStartP50Ms: 1_500,
			coldStartP95Ms: 3_000,
			idleRssMiB: 200,
			roundTripP50Ms: 50,
		});
		expect(ROW_KIND).toEqual({
			coldStartP50Ms: "timing",
			coldStartP95Ms: "timing",
			idleRssMiB: "memory",
			roundTripP50Ms: "timing",
		});
	});
});

describe("which rows count", () => {
	it("keeps a timing PASS from a held run, even when a sample between plugins was busy", () => {
		expect(judge(1_400, 1_500, "timing", "held", false)).toEqual({
			verdict: "PASS",
			provisional: null,
		});
		expect(judge(1_400, 1_500, "timing", "held", true)).toEqual({
			verdict: "PASS",
			provisional: null,
		});
	});

	it("counts a memory reading only from an unloaded leg, a PASS included", () => {
		expect(judge(150, 200, "memory", "held", true)).toEqual({ verdict: "PASS", provisional: null });
		expect(judge(150, 200, "memory", "held", false)).toEqual({
			verdict: "not counted: machine-busy",
			provisional: "PASS",
		});
	});

	it("counts a miss or a fail only from an unloaded leg", () => {
		expect(judge(1_600, 1_500, "timing", "held", true)).toEqual({
			verdict: "MISS",
			provisional: null,
		});
		expect(judge(3_100, 1_500, "timing", "held", true)).toEqual({
			verdict: "FAIL",
			provisional: null,
		});
		expect(judge(1_600, 1_500, "timing", "held", false)).toEqual({
			verdict: "not counted: machine-busy",
			provisional: "MISS",
		});
		expect(judge(3_100, 1_500, "timing", "held", false)).toEqual({
			verdict: "not counted: machine-busy",
			provisional: "FAIL",
		});
	});

	it("runs nothing that counts when the idle check before failed or the lock wasn't taken", () => {
		expect(judge(1_400, 1_500, "timing", "machine-busy", true)).toEqual({
			verdict: "not run: machine-busy",
			provisional: "PASS",
		});
		expect(judge(null, 1_500, "timing", "machine-busy", false)).toEqual({
			verdict: "not run: machine-busy",
			provisional: null,
		});
		expect(judge(null, 1_500, "timing", "failed", false)).toEqual({
			verdict: "not run: bench lock failed",
			provisional: null,
		});
	});

	it("calls a held run's row without a number not measured, never a FAIL", () => {
		for (const value of [null, Number.NaN, Number.POSITIVE_INFINITY, -1]) {
			expect(judge(value, 50, "timing", "held", true)).toEqual({
				verdict: "not measured",
				provisional: null,
			});
		}
	});

	it("calls a leg unloaded only when every sample stayed under the threshold", () => {
		expect(unloaded([3, 19.9, 12], 20)).toBe(true);
		expect(unloaded([3, 20, 12], 20)).toBe(false);
		expect(unloaded([], 20)).toBe(false);
	});

	it("fails a counted MISS only under DRAFTYAK_STRICT_BUDGETS=1", () => {
		expect(strictBudgets({ DRAFTYAK_STRICT_BUDGETS: "1" })).toBe(true);
		expect(strictBudgets({ DRAFTYAK_STRICT_BUDGETS: "0" })).toBe(false);
		expect(strictBudgets({})).toBe(false);
		expect(() => strictBudgets({ DRAFTYAK_STRICT_BUDGETS: "true" })).toThrow();
	});
});

describe("nearest-rank percentiles", () => {
	const twenty = Array.from({ length: 20 }, (_, i) => 20 - i);

	it("takes the 10th and 19th of 20 sorted values for p50 and p95", () => {
		expect(percentile(twenty, 50)).toBe(10);
		expect(percentile(twenty, 95)).toBe(19);
		expect(percentile(twenty, 100)).toBe(20);
		expect(percentile([3, 1, 2], 50)).toBe(2);
		expect(percentile([7], 95)).toBe(7);
	});

	it("refuses an empty list and a percentile outside (0, 100]", () => {
		expect(() => percentile([], 50)).toThrow();
		expect(() => percentile([1], 0)).toThrow();
		expect(() => percentile([1], 101)).toThrow();
	});
});

const STUB_PRINT: Fingerprint = {
	os: { platform: "linux", arch: "x64", osName: "stub", osVersion: "1" },
	node: { nodeVersion: "26.12.0", v8Version: "1" },
	commit: null,
	dirty: null,
	load: { cpuPercent: 0, cpuCount: 1, cpuModel: "stub", memoryUsedPercent: 0, concurrentBuilds: 0 },
};

describe("the budget test's bench lock", () => {
	let dir = "";
	beforeAll(() => {
		dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "dy-s11-lock-")));
	});
	afterAll(() => {
		if (dir !== "") fs.rmSync(dir, { recursive: true, force: true });
	});
	const spikesRun = { CI: "true", DRAFTYAK_STRICT_SKIPS: "1" };

	it("fails fast only in spikes-run, CI with strict skips", () => {
		expect(lockFailsFast(spikesRun)).toBe(true);
		expect(lockFailsFast({ CI: "true" })).toBe(false);
		expect(lockFailsFast({ DRAFTYAK_STRICT_SKIPS: "1" })).toBe(false);
		expect(lockFailsFast({})).toBe(false);
	});

	it("fails at once in spikes-run, naming the lock file, which the evidence leaves out", async () => {
		const file = path.join(dir, "ci.lock");
		const held = await acquireBenchLock({ path: file, idle: false });
		try {
			const begun = performance.now();
			const taking = benchLock(AbortSignal.timeout(20_000), { path: file, idle: false }, spikesRun);
			const error = await taking.then(
				() => null,
				(reason: unknown) => reason,
			);
			expect(error).toBeInstanceOf(Error);
			expect(String(error)).toContain(`is held on this ${process.platform} runner`);
			expect(String(error)).toContain(file);
			expect(performance.now() - begun).toBeLessThan(10_000);
			const message = lockMessage(error);
			expect(message).toContain(`is held on this ${process.platform} runner`);
			expect(message).not.toContain(path.basename(dir));
			const lock = { status: "failed", waitedMs: null, idleBefore: null, message, busy: null };
			const evidence = path.join(dir, "evidence", "budgets-stub.json");
			await expect(writeEvidence(evidence, { lock }, { fingerprint: STUB_PRINT })).resolves.toBe(
				evidence,
			);
		} finally {
			held.release();
		}
	});

	it("waits for the holder in CI's full job and outside CI", async () => {
		for (const env of [{ CI: "true" }, {}]) {
			const file = path.join(dir, `wait-${Object.keys(env).length}.lock`);
			const held = await acquireBenchLock({ path: file, idle: false });
			setTimeout(() => held.release(), 300);
			const options = { path: file, idle: false, pollMs: 50 } as const;
			const lock = await benchLock(AbortSignal.timeout(20_000), options, env);
			expect(lock.waitedMs).toBeGreaterThan(0);
			lock.release();
		}
	});

	it("keeps a machine-busy record content-free, the lock's path under home included", async () => {
		const file = path.join(os.homedir(), "AppData", "Local", "draftyak-dev", "bench.lock");
		const message = lockMessage(
			new MachineBusyError(`machine-busy: ${file} still held after 240 s`),
		);
		expect(message).toBe("machine-busy: <path> still held after 240 s");
		const busy = await busyReport([25.5, 31]);
		const lock = { status: "machine-busy", waitedMs: 240_000, idleBefore: null, message, busy };
		const evidence = path.join(dir, "evidence", "budgets-busy.json");
		await expect(writeEvidence(evidence, { lock }, { fingerprint: STUB_PRINT })).resolves.toBe(
			evidence,
		);
	});
});

describe("the busy report", () => {
	it("sums the busiest processes by generic name, busiest first, and the rest as other", () => {
		const listing = [
			" 50.5 /usr/bin/cargo",
			" 20.0 cargo",
			"  7,5 rustc.exe",
			"  0.0 node",
			" 12.0 /Users/someone/Applications/Some App.app/Contents/MacOS/Some App",
			" 3.1 /System/Library/Support/mds_stores",
			"garbage",
		].join("\n");
		expect(busiestOf(listing)).toEqual([
			{ name: "cargo", cpuPercent: 70.5 },
			{ name: "<other>", cpuPercent: 12 },
			{ name: "rustc", cpuPercent: 7.5 },
			{ name: "mds_stores", cpuPercent: 3.1 },
		]);
		expect(busiestOf(listing, 1)).toEqual([{ name: "cargo", cpuPercent: 70.5 }]);
	});

	it("records the samples, the load and the busiest processes, all content-free", async () => {
		const samples = Array.from({ length: 70 }, (_, i) => i);
		const report = await busyReport(samples);
		expect(report.samples).toEqual(samples.slice(-60));
		expect(report.cpuCount).toBeGreaterThan(0);
		expect(report.loadAverage).toHaveLength(3);
		expect(report.busiest === null || Array.isArray(report.busiest)).toBe(true);
		expect(() => assertContentFree(report)).not.toThrow();
	});
});
