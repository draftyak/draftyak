import { describe, expect, it } from "vitest";
import { stdioFixture } from "./stdio-fixture.ts";

const fixture = new URL("./fixtures/stdio-diagnostics.ts", import.meta.url);
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
describe("stdio fixture failure diagnosis", () => {
	it("reports the unchanged deadline while a real child has not finished startup", async () => {
		let now = 0,
			delay: number | undefined,
			fire: (() => void) | undefined;
		let cancelled = 0;
		const peer = stdioFixture(fixture, {
			args: ["delayed"],
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
			await expect.poll(() => peer.stderr()).toContain("waiting for startup");
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
		const peer = stdioFixture(fixture, { args: ["exit"] });
		try {
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
		} finally {
			await peer.close();
		}
	});
	it("reports a mismatched response with request identity and the actual last frame", async () => {
		const peer = stdioFixture(fixture, { args: ["wrong-id"] });
		try {
			const failure = await rejected(peer.ask("tools/list"));
			expect(details(failure)).toMatchObject({
				reason: "correlation",
				method: "tools/list",
				id: 1,
				stdout: { lastFrame: '{"id":99,"result":{}}' },
			});
		} finally {
			await peer.close();
		}
	});
	it("bounds stderr and frame diagnostics when a synthetic child emits invalid JSON", async () => {
		const peer = stdioFixture(fixture, { args: ["invalid"] });
		try {
			const failure = await rejected(peer.ask("server/discover"));
			const data = details(failure);
			expect(data.reason).toBe("invalid-json");
			expect(data.stdout.bytes).toBeGreaterThan(2048);
			expect(Buffer.byteLength(data.stderr)).toBeLessThanOrEqual(2048);
			expect(Buffer.byteLength(data.stdout.lastFrame)).toBeLessThanOrEqual(2048);
			expect(failure.message.length).toBeLessThan(5000);
		} finally {
			await peer.close();
		}
	});
	it("retains request and frame diagnostics for an incomplete but correlated result", async () => {
		const peer = stdioFixture(fixture, { args: ["incomplete"] });
		try {
			expect(await peer.ask("server/discover")).toEqual({ id: 1, result: {} });
			expect(JSON.parse(peer.diagnostics())).toMatchObject({
				method: "server/discover",
				id: 1,
				stdout: { lastFrame: '{"id":1,"result":{}}' },
			});
		} finally {
			await peer.close();
		}
	});
});
