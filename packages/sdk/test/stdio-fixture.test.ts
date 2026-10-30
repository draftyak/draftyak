import { describe, expect, it } from "vitest";
import { stdioFixture } from "./stdio-fixture.ts";

const fixture = new URL("./fixtures/stdio-diagnostics.ts", import.meta.url);
// Requests sent before the child is up get no real-time deadline: a cold start can outlast 3 s.
const untimed = { now: () => performance.now(), schedule: () => () => {} };
// Half the 30 s test timeout, leaving time for cleanup; above the 10 s fixture startup allowance.
const WATCHDOG_MS = 15_000;
function details(error: Error) {
	expect(error.message).toMatch(/^Stdio fixture request failed: /);
	return JSON.parse(error.message.slice("Stdio fixture request failed: ".length));
}
async function rejected(response: Promise<unknown>): Promise<Error> {
	try {
		await response;
	} catch (error) {
		expect(error).toBeInstanceOf(Error);
		return error as Error;
	}
	expect.fail("Expected an explicit fixture failure");
}
/** Runs an untimed case, then closes its fixture. A case still running at the bound has its fixture
 * closed early, so the pending request settles, and fails naming that request. */
async function watched(
	peer: ReturnType<typeof stdioFixture>,
	run: () => Promise<unknown>,
	bound = WATCHDOG_MS,
): Promise<void> {
	let stalled: string | undefined;
	const watchdog = setTimeout(() => {
		const state = peer.diagnostics("watchdog");
		stalled = `${JSON.parse(state).method} did not complete within ${bound} ms; fixture closed: ${state}`;
		void peer.close();
	}, bound);
	try {
		await run();
	} catch (error) {
		if (stalled === undefined) throw error;
	} finally {
		clearTimeout(watchdog);
		await peer.close();
	}
	if (stalled !== undefined) expect.fail(stalled);
}
describe("stdio fixture failure diagnosis", () => {
	it("reports the unchanged deadline while a real child has not finished startup", async () => {
		let now = 0,
			delay: number | undefined,
			fire: (() => void) | undefined;
		let cancelled = 0;
		const peer = stdioFixture(fixture, {
			args: ["delayed"],
			ready: true,
			clock: {
				now: () => now,
				schedule(callback, ms) {
					fire = callback;
					delay = ms;
					return () => {
						cancelled++;
					};
				},
			},
		});
		try {
			const response = peer.ask("server/discover");
			const failure = rejected(response);
			await peer.ready();
			expect(delay).toBe(3000);
			now = 3000;
			fire?.();
			expect(details(await failure)).toEqual({
				reason: "timeout",
				method: "server/discover",
				id: 1,
				elapsedMs: 3000,
				exit: null,
				eof: false,
				stderr: "waiting for startup\n",
				stdout: { bytes: 0, lastFrame: null },
			});
			expect(cancelled).toBe(1);
		} finally {
			await peer.close();
		}
	});
	it("reports early exit code and stderr instead of an absent discovery result", async () => {
		const peer = stdioFixture(fixture, { args: ["exit"], clock: untimed });
		await watched(peer, async () => {
			const failure = await rejected(peer.ask("server/discover"));
			expect(details(failure)).toMatchObject({
				reason: "eof",
				method: "server/discover",
				id: 1,
				exit: { code: 19, signal: null },
				eof: true,
				stderr: "synthetic startup failure\n",
				stdout: { bytes: 0, lastFrame: null },
			});
			expect(details(failure).elapsedMs).toBeGreaterThanOrEqual(0);
		});
	});
	it("reports a mismatched response with request identity and the actual last frame", async () => {
		const peer = stdioFixture(fixture, { args: ["wrong-id"], clock: untimed });
		await watched(peer, async () => {
			const failure = await rejected(peer.ask("tools/list"));
			expect(details(failure)).toMatchObject({
				reason: "correlation",
				method: "tools/list",
				id: 1,
				stdout: { lastFrame: '{"id":99,"result":{}}' },
			});
		});
	});
	it("bounds stderr and frame diagnostics when a synthetic child emits invalid JSON", async () => {
		const peer = stdioFixture(fixture, { args: ["invalid"], clock: untimed });
		await watched(peer, async () => {
			const failure = await rejected(peer.ask("server/discover"));
			const data = details(failure);
			expect(data.reason).toBe("invalid-json");
			expect(data.stdout.bytes).toBeGreaterThan(2048);
			expect(Buffer.byteLength(data.stderr)).toBeLessThanOrEqual(2048);
			expect(Buffer.byteLength(data.stdout.lastFrame)).toBeLessThanOrEqual(2048);
			expect(failure.message.length).toBeLessThan(5000);
		});
	});
	it("retains request and frame diagnostics for an incomplete but correlated result", async () => {
		const peer = stdioFixture(fixture, { args: ["incomplete"], clock: untimed });
		await watched(peer, async () => {
			expect(await peer.ask("server/discover")).toEqual({ id: 1, result: {} });
			expect(JSON.parse(peer.diagnostics())).toMatchObject({
				method: "server/discover",
				id: 1,
				stdout: { lastFrame: '{"id":1,"result":{}}' },
			});
		});
	});
	it("closes the fixture and names the request when an untimed request never completes", async () => {
		const peer = stdioFixture(fixture, { args: ["delayed"], clock: untimed });
		const { message } = await rejected(watched(peer, () => peer.ask("server/discover"), 100));
		expect(message).toMatch(
			/^server\/discover did not complete within 100 ms; fixture closed: \{"reason":"watchdog"/,
		);
		const snapshot = JSON.parse(message.slice(message.indexOf("{")));
		// Fired at its own 100 ms bound, nowhere near the 15 s default.
		expect(snapshot.elapsedMs).toBeLessThan(WATCHDOG_MS / 2);
		expect(JSON.parse(peer.diagnostics())).toMatchObject({ exit: expect.anything() });
	});
	it("clears the watchdog and closes the fixture when a case completes within its bound", async () => {
		const peer = stdioFixture(fixture, { args: ["delayed"], clock: untimed });
		const snapshots: (string | undefined)[] = [];
		const observed = {
			...peer,
			diagnostics(reason?: string) {
				snapshots.push(reason);
				return peer.diagnostics(reason);
			},
		};
		await watched(observed, async () => {}, 20);
		// A watchdog left running would fire before this wait ends.
		await new Promise((resolve) => setTimeout(resolve, 20));
		expect(snapshots).toEqual([]);
		expect(JSON.parse(peer.diagnostics())).toMatchObject({ exit: expect.anything() });
	});
	it("rethrows a case's own failure and still closes the fixture", async () => {
		const peer = stdioFixture(fixture, { args: ["delayed"], clock: untimed });
		const own = new Error("DYTEST-case-failure");
		await expect(
			watched(peer, async () => {
				throw own;
			}),
		).rejects.toBe(own);
		expect(JSON.parse(peer.diagnostics())).toMatchObject({ exit: expect.anything() });
	});
});
