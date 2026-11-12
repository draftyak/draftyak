import { spawn } from "node:child_process";
import { scheduler, setTimeout as sleep } from "node:timers/promises";
import { describe, expect, it } from "vitest";
import {
	checkWait,
	MAX_WAIT_MS,
	systemClock,
	timeoutSignal,
	withDeadline,
} from "../../src/kernel/clock.ts";

interface ArmedDelay {
	readonly promise: Promise<void>;
	readonly cancel: () => void;
}

const delayApis: readonly { readonly name: string; readonly arm: (ms: number) => ArmedDelay }[] = [
	{
		name: "setTimeout",
		arm(ms) {
			let timer: ReturnType<typeof setTimeout> | undefined;
			const promise = new Promise<void>((resolve) => {
				timer = setTimeout(resolve, ms);
			});
			return { promise, cancel: () => clearTimeout(timer) };
		},
	},
	{
		name: "setInterval",
		arm(ms) {
			let timer: ReturnType<typeof setInterval> | undefined;
			const promise = new Promise<void>((resolve) => {
				timer = setInterval(() => {
					clearInterval(timer);
					resolve();
				}, ms);
			});
			return { promise, cancel: () => clearInterval(timer) };
		},
	},
	{
		name: "timers/promises setTimeout",
		arm(ms) {
			const controller = new AbortController();
			return {
				promise: sleep(ms, undefined, { signal: controller.signal }),
				cancel: () => controller.abort(),
			};
		},
	},
	{
		name: "timers/promises scheduler.wait",
		arm(ms) {
			const controller = new AbortController();
			return {
				promise: scheduler.wait(ms, { signal: controller.signal }),
				cancel: () => controller.abort(),
			};
		},
	},
	{
		name: "AbortSignal.timeout",
		arm(ms) {
			const signal = AbortSignal.timeout(ms);
			let removeListener: (() => void) | undefined;
			const promise = new Promise<void>((resolve) => {
				const listener = (): void => resolve();
				signal.addEventListener("abort", listener, { once: true });
				removeListener = () => signal.removeEventListener("abort", listener);
			});
			return { promise, cancel: () => removeListener?.() };
		},
	},
];

describe("native timer overflow and bounded clock waits", () => {
	for (const { name, arm } of delayApis) {
		it(`${name} overflows at 2**31 with a warning rather than waiting until due`, {
			timeout: 10_000,
		}, async () => {
			let warnings = 0;
			const listener = (warning: Error): void => {
				if (warning.name === "TimeoutOverflowWarning") warnings++;
			};
			const fallback = new AbortController();
			let armed: ArmedDelay | undefined;
			process.on("warning", listener);
			try {
				const started = performance.now();
				armed = arm(2 ** 31);
				const fired = await Promise.race([
					armed.promise.then(
						() => true,
						() => false,
					),
					sleep(5_000, undefined, { signal: fallback.signal }).then(
						() => false,
						() => false,
					),
				]);
				expect(fired).toBe(true);
				expect(performance.now() - started).toBeLessThan(1_000);
				await sleep(10);
				expect(warnings).toBeGreaterThanOrEqual(1);
			} finally {
				armed?.cancel();
				fallback.abort();
				process.off("warning", listener);
			}
		});
	}

	it("keeps the 2**31 - 1 timer pending without an overflow warning", async () => {
		let fired = false;
		let warnings = 0;
		const listener = (warning: Error): void => {
			if (warning.name === "TimeoutOverflowWarning") warnings++;
		};
		process.on("warning", listener);
		const timer = setTimeout(
			() => {
				fired = true;
			},
			2 ** 31 - 1,
		);
		try {
			await sleep(200);
			expect(fired).toBe(false);
			expect(warnings).toBe(0);
		} finally {
			clearTimeout(timer);
			process.off("warning", listener);
		}
	});

	it("refuses invalid waits synchronously while accepting both bounded edges", () => {
		expect(MAX_WAIT_MS).toBe(15_000);
		for (const ms of [
			15_001,
			2 ** 31 - 2,
			2 ** 31 - 1,
			2 ** 31,
			30 * 86_400_000,
			-1,
			0.5,
			Number.NaN,
			Number.POSITIVE_INFINITY,
		]) {
			expect(() => systemClock.after(ms)).toThrow(RangeError);
		}
		expect([checkWait(0), checkWait(15_000)]).toEqual([0, 15_000]);
	});

	it("waits natively for 20ms and accepts an aborted 15000ms wait and zero", async () => {
		const started = performance.now();
		await expect(systemClock.after(20)).resolves.toBeUndefined();
		expect(performance.now() - started).toBeGreaterThanOrEqual(19);
		const controller = new AbortController();
		const longest = systemClock.after(15_000, controller.signal);
		const rejected = expect(longest).rejects.toMatchObject({ name: "AbortError" });
		controller.abort();
		await rejected;
		await expect(systemClock.after(0)).resolves.toBeUndefined();
	});

	it("rejects a pre-aborted signal instead of completing the native wait", async () => {
		const controller = new AbortController();
		controller.abort();
		await expect(systemClock.after(120, controller.signal)).rejects.toMatchObject({
			name: "AbortError",
		});
	});

	it("rejects an active wait when its own signal aborts", async () => {
		const controller = new AbortController();
		const pending = systemClock.after(120, controller.signal);
		const rejected = expect(pending).rejects.toMatchObject({ name: "AbortError" });
		try {
			await sleep(10);
			controller.abort();
			await rejected;
		} finally {
			controller.abort();
		}
	});

	it("keeps settled and independent waits successful after a late abort", async () => {
		const controller = new AbortController();
		const settled = systemClock.after(0, controller.signal);
		await expect(settled).resolves.toBeUndefined();
		const independent = systemClock.after(20);
		controller.abort();
		await expect(settled).resolves.toBeUndefined();
		await expect(independent).resolves.toBeUndefined();
	});

	it("keeps a standalone native wait referenced until completion", {
		timeout: 10_000,
	}, async () => {
		const marker = "DYTEST-CLOCK-REFERENCED\n";
		const clock = new URL("../../src/kernel/clock.ts", import.meta.url).href;
		const script = `import { systemClock } from ${JSON.stringify(clock)}; await systemClock.after(20); process.stdout.write(${JSON.stringify(marker)});`;
		const env: NodeJS.ProcessEnv = {};
		for (const key of ["SystemRoot", "WINDIR", "TEMP", "TMP"])
			if (process.env[key] !== undefined) env[key] = process.env[key];
		const child = spawn(
			process.execPath,
			[
				"--disable-sigusr1",
				"--unhandled-rejections=strict",
				"--input-type=module",
				"--eval",
				script,
			],
			{
				cwd: import.meta.dirname,
				env,
				stdio: ["ignore", "pipe", "pipe"],
				windowsHide: true,
				shell: false,
				timeout: 5_000,
				killSignal: "SIGKILL",
			},
		);
		let spawnFailed = false;
		let bytes = 0;
		let stderrBytes = 0;
		let overflow = false;
		const stdout: Buffer[] = [];
		const closed = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(
			(resolve) => {
				child.once("error", () => {
					spawnFailed = true;
				});
				child.once("close", (code, signal) => resolve({ code, signal }));
			},
		);
		const count = (chunk: Buffer): boolean => {
			bytes += chunk.length;
			if (bytes <= 4_096) return true;
			overflow = true;
			child.kill("SIGKILL");
			return false;
		};
		child.stdout?.on("data", (chunk: Buffer) => {
			if (count(chunk)) stdout.push(chunk);
		});
		child.stderr?.on("data", (chunk: Buffer) => {
			stderrBytes += chunk.length;
			count(chunk);
		});
		try {
			const result = await closed;
			expect(spawnFailed).toBe(false);
			expect(overflow).toBe(false);
			expect(result).toEqual({ code: 0, signal: null });
			expect(stderrBytes).toBe(0);
			expect(Buffer.concat(stdout).equals(Buffer.from(marker))).toBe(true);
		} finally {
			if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
			await closed;
		}
	});
});

describe("bounded deadline helpers on the native clock", () => {
	it("times out real work at its deadline and returns work that finishes first", async () => {
		const started = performance.now();
		const late = await withDeadline(
			systemClock,
			50,
			(signal) =>
				new Promise<never>((_resolve, reject) =>
					signal.addEventListener("abort", () => reject(signal.reason), { once: true }),
				),
		);
		expect(late).toEqual({ ok: false, reason: "timeout" });
		expect(performance.now() - started).toBeGreaterThanOrEqual(40);
		await expect(
			withDeadline(systemClock, MAX_WAIT_MS, () => sleep(10).then(() => "done")),
		).resolves.toEqual({ ok: true, value: "done" });
	});

	it("aborts a real timeout signal once, and never after cancel", async () => {
		const timeout = timeoutSignal(systemClock, 30);
		await new Promise((resolve) =>
			timeout.signal.addEventListener("abort", resolve, { once: true }),
		);
		expect(timeout.signal.reason).toMatchObject({ name: "TimeoutError" });
		const cancelled = timeoutSignal(systemClock, 30);
		cancelled.cancel();
		await sleep(80);
		expect(cancelled.signal.aborted).toBe(false);
	});
});
