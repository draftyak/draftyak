import { type ChildProcess, spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { afterAll, afterEach, describe, expect, it } from "vitest";
import {
	acquireBenchLock,
	BENCH_WAIT_MS,
	benchLockPath,
	benchTimeout,
	type LockHolder,
	waitForIdle,
} from "../lock.ts";
import { kitDir } from "../repo.ts";

const dir = mkdtempSync(path.join(tmpdir(), "draftyak-kit-lock-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));
const lock = path.join(dir, "bench.lock");
const holding: ChildProcess[] = [];
afterEach(async () => {
	for (const child of holding
		.splice(0)
		.filter((each) => each.exitCode === null && !each.signalCode)) {
		child.kill();
		await once(child, "exit");
	}
});

// Another process holding the lock, as a benchmark in a second worktree would.
async function holder(): Promise<ChildProcess> {
	const code = `import { acquireBenchLock } from ${JSON.stringify(pathToFileURL(path.join(kitDir, "lock.ts")).href)};
const lock = await acquireBenchLock({ path: process.argv[1], label: "first benchmark", idle: false });
console.log("held");
process.stdin.once("data", () => { lock.release(); process.exit(0); });`;
	const child = spawn(process.execPath, ["--input-type=module", "-e", code, lock]);
	holding.push(child);
	expect(String((await once(child.stdout, "data"))[0]).trim()).toBe("held");
	return child;
}

const quiet = { path: lock, idle: false, pollMs: 50, onWait: () => {} } as const;
const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe("bench lock", () => {
	it("makes a second benchmark wait while the first holds the lock", async () => {
		const first = await holder();
		const waits: (LockHolder | null)[] = [];
		const second = acquireBenchLock({ ...quiet, onWait: (current) => waits.push(current) });
		await pause(600);
		expect(waits).toEqual([expect.objectContaining({ label: "first benchmark", pid: first.pid })]);
		first.stdin?.write("release\n");
		const acquired = await second;
		expect(acquired.waitedMs).toBeGreaterThanOrEqual(500);
		acquired.release();
	});

	it("is free once a holder dies, whatever it left behind, and fails as machine-busy while held", async () => {
		const first = await holder();
		await expect(acquireBenchLock({ ...quiet, timeoutMs: 300 })).rejects.toMatchObject({
			code: "machine-busy",
		});
		first.kill("SIGKILL");
		await once(first, "exit");
		writeFileSync(`${lock}.owner`, JSON.stringify({ pid: first.pid, label: "dead", since: "" }));
		const next = await acquireBenchLock({ ...quiet, timeoutMs: 5_000 });
		expect(next.waitedMs).toBeLessThan(2_000);
		next.release();
	});

	it("stops waiting when the test's signal aborts, and never takes the lock afterwards", async () => {
		const first = await holder();
		const controller = new AbortController();
		const waiting = acquireBenchLock({ ...quiet, signal: controller.signal });
		await pause(200);
		controller.abort(new Error("test timed out"));
		await expect(waiting).rejects.toThrow("test timed out");
		first.stdin?.write("release\n");
		await once(first, "exit");
		await pause(200);
		(await acquireBenchLock({ ...quiet, timeoutMs: 100 })).release();
	});

	it("is not re-entrant and releases once", async () => {
		const held = await acquireBenchLock(quiet);
		await expect(acquireBenchLock({ ...quiet, timeoutMs: 200 })).rejects.toThrow("machine-busy");
		held.release();
		held.release();
		(await acquireBenchLock(quiet)).release();
	});

	it("lives in %LOCALAPPDATA%/draftyak-dev on Windows; one budget fits the heavy tier", () => {
		const local =
			process.platform === "win32" ? path.join(homedir(), "AppData", "Local") : undefined;
		const expected = local ?? path.join(homedir(), ".local", "state");
		expect(benchLockPath({})).toBe(path.join(expected, "draftyak-dev", "bench.lock"));
		expect(BENCH_WAIT_MS).toBeLessThan(300_000);
		expect(benchTimeout(60_000)).toBe(BENCH_WAIT_MS + 90_000);
	});
});

describe("idle check", () => {
	const fake = (values: number[]) => async (ms: number) => {
		await pause(ms);
		return values.shift() ?? 100;
	};

	it("passes once every sample in the window is below the threshold", async () => {
		const idle = await waitForIdle({
			sample: fake([90, 5, 50, 4, 3, 2]),
			sampleMs: 10,
			windowMs: 30,
		});
		expect(idle).toMatchObject({ samples: [4, 3, 2], maxCpuPercent: 4, thresholdPercent: 20 });
	});

	it("fails as machine-busy, or stops on abort, releasing the lock it took", async () => {
		const idle = { sample: fake([]), sampleMs: 10, timeoutMs: 100 };
		await expect(waitForIdle(idle)).rejects.toThrow("machine-busy: CPU not below 20%");
		await expect(acquireBenchLock({ ...quiet, idle })).rejects.toMatchObject({
			code: "machine-busy",
		});
		const aborted = AbortSignal.timeout(100);
		const busy = { sample: fake([]), sampleMs: 10, timeoutMs: 60_000 };
		await expect(acquireBenchLock({ ...quiet, idle: busy, signal: aborted })).rejects.toThrow(
			"timeout",
		);
		(await acquireBenchLock({ ...quiet, timeoutMs: 1_000 })).release();
	});
});
