import { Hono } from "hono";
import { describe, expect, it } from "vitest";
import {
	createFake,
	createFaults,
	DroppedConnectionError,
	type Fault,
	httpDate,
	manualClock,
	wait,
} from "../src/index.ts";

const HOST = "faults.draftyak.example";
const START = Date.UTC(2026, 9, 19, 9, 30, 15, 250);

function counted(): { app: Hono; hits: () => number } {
	let hits = 0;
	const app = new Hono();
	app.all("*", (c) => {
		hits += 1;
		return c.text("ok");
	});
	return { app, hits: () => hits };
}

function setup(...faults: Fault[]) {
	const clock = manualClock(START);
	const { app, hits } = counted();
	const fake = createFake(app, { host: HOST, faults: createFaults({ clock }) });
	fake.faults.add(...faults);
	return { clock, fake, hits };
}

describe("faults", () => {
	it("answers a scripted 429 with Retry-After, in seconds or as a date, without the app", async () => {
		const { fake, hits } = setup(
			{ kind: "rate-limit", retryAfter: 30 },
			{ kind: "rate-limit", retryAfter: { at: START + 3_600_000 } },
		);
		const seconds = await fake.fetch("/send");
		expect(seconds.status).toBe(429);
		expect(seconds.headers.get("retry-after")).toBe("30");
		expect(await seconds.json()).toEqual({ error: "rate_limited" });
		const dated = await fake.fetch("/send");
		expect(dated.status).toBe(429);
		expect(dated.headers.get("retry-after")).toBe("Mon, 19 Oct 2026 10:30:15 GMT");
		expect(hits()).toBe(0);
		expect((await fake.fetch("/send")).status).toBe(200);
	});

	it("answers scripted 5xx, 503 by default", async () => {
		const { fake, hits } = setup({ kind: "server-error" }, { kind: "server-error", status: 500 });
		expect((await fake.fetch("/a")).status).toBe(503);
		const failed = await fake.fetch("/a");
		expect(failed.status).toBe(500);
		expect(await failed.json()).toEqual({ error: "server_error" });
		expect(hits()).toBe(0);
	});

	it("records every request a fault answers or drops", async () => {
		const { fake } = setup({ kind: "drop" }, { kind: "rate-limit", retryAfter: 1 });
		const send = { method: "POST", body: "DYTEST send" };
		await expect(fake.fetch("/send", send)).rejects.toThrow(TypeError);
		expect((await fake.fetch("/send", send)).status).toBe(429);
		const recorded = fake.recorder.takeRequests();
		expect(recorded.map((entry) => [entry.method, entry.path, entry.bodyLength])).toEqual([
			["POST", "/send", 11],
			["POST", "/send", 11],
		]);
	});

	it("refuses a fault it couldn't run as scripted, and adds none of the batch", () => {
		const faults = createFaults();
		const refused: Fault[] = [
			{ kind: "server-error", status: 429 },
			{ kind: "drop", times: 0 },
			{ kind: "drop", times: 1.5 },
			{ kind: "rate-limit", retryAfter: Number.NaN },
			{ kind: "rate-limit", retryAfter: -1 },
			{ kind: "rate-limit", retryAfter: Infinity },
			{ kind: "rate-limit", retryAfter: { at: Number.NaN } },
			{ kind: "rate-limit", retryAfter: { at: Date.UTC(10_000, 0, 1) } },
			{ kind: "latency", ms: -5 },
			{ kind: "latency", ms: 1.5 },
			{ kind: "latency", ms: 2 ** 31 },
		];
		for (const fault of refused) {
			expect(() => faults.add({ kind: "drop" }, fault), JSON.stringify(fault)).toThrow(RangeError);
		}
		expect(faults.pending()).toEqual([]);
	});

	it("adds latency before the app answers, and an abort ends the wait as fetch would", async () => {
		const { fake, hits } = setup({ kind: "latency", ms: 120 }, { kind: "latency", ms: 60_000 });
		const begun = performance.now();
		expect((await fake.fetch("/slow")).status).toBe(200);
		expect(performance.now() - begun).toBeGreaterThanOrEqual(100);
		const aborted = fake.fetch("/slow", { signal: AbortSignal.timeout(50) });
		await expect(aborted).rejects.toMatchObject({ name: "TimeoutError" });
		expect(hits()).toBe(1);
	});

	it("waits until aborted for Infinity, and refuses a wait a timer can't keep", async () => {
		const { fake, hits } = setup({ kind: "latency", ms: Infinity });
		const begun = performance.now();
		const aborted = fake.fetch("/hang", { signal: AbortSignal.timeout(200) });
		await expect(aborted).rejects.toMatchObject({ name: "TimeoutError" });
		expect(performance.now() - begun).toBeGreaterThanOrEqual(180);
		expect(hits()).toBe(0);
		await expect(wait(2 ** 31)).rejects.toThrow(RangeError);
		await expect(wait(Number.NaN)).rejects.toThrow(RangeError);
	});

	it("drops the connection: in memory, fetch's own TypeError", async () => {
		const { fake, hits } = setup({ kind: "drop" });
		const dropped = await fake.fetch("/send").catch((error: unknown) => error);
		expect(dropped).toBeInstanceOf(TypeError);
		expect((dropped as TypeError).cause).toBeInstanceOf(DroppedConnectionError);
		expect(hits()).toBe(0);
	});

	it("lets the app answer first with after, so the request takes effect", async () => {
		const { fake, hits } = setup(
			{ kind: "drop", after: true },
			{ kind: "server-error", status: 502, after: true },
			{ kind: "latency", ms: 1, after: true },
		);
		await expect(fake.fetch("/send")).rejects.toThrow(TypeError);
		expect(hits()).toBe(1);
		expect((await fake.fetch("/send")).status).toBe(502);
		expect(hits()).toBe(2);
		expect((await fake.fetch("/send")).status).toBe(200);
		expect(hits()).toBe(3);
	});

	it("matches method and raw path, counts uses and lists what is left", async () => {
		const { fake } = setup(
			{ kind: "server-error", method: "post", path: "/v1/send", times: 2 },
			{ kind: "server-error", status: 500, path: /%40/, times: Infinity },
			{ kind: "server-error", status: 502, path: "/v1/x/../send" },
		);
		expect((await fake.fetch("/v1/send")).status).toBe(200);
		expect((await fake.fetch("/v1/send", { method: "POST" })).status).toBe(503);
		expect((await fake.fetch("/a@b")).status).toBe(200);
		expect((await fake.fetch("/a%40b")).status).toBe(500);
		expect((await fake.fetch("/v1/x/../send")).status).toBe(502);
		expect(fake.faults.pending()).toEqual([
			{ kind: "server-error", method: "post", path: "/v1/send", times: 1 },
			{ kind: "server-error", status: 500, path: /%40/, times: Infinity },
		]);
		expect((await fake.fetch("/v1/send", { method: "POST" })).status).toBe(503);
		expect(fake.faults.pending()).toHaveLength(1);
		fake.faults.clear();
		expect((await fake.fetch("/a%40b")).status).toBe(200);
	});

	it("stamps Date from the injected clock on every answer, faults included", async () => {
		const { clock, fake } = setup({ kind: "rate-limit", retryAfter: 1 });
		expect((await fake.fetch("/a")).headers.get("date")).toBe("Mon, 19 Oct 2026 09:30:15 GMT");
		clock.advance(86_400_000);
		const ok = await fake.fetch("/a");
		expect(ok.headers.get("date")).toBe(httpDate(START + 86_400_000));
		clock.set(Date.UTC(2027, 0, 1));
		expect((await fake.fetch("/a")).headers.get("date")).toBe("Fri, 01 Jan 2027 00:00:00 GMT");
		expect(() => httpDate(Number.NaN)).toThrow(RangeError);
	});

	it("stamps the injected Date over loopback too", async () => {
		const { fake } = setup();
		const listening = await fake.listen();
		try {
			const response = await fetch(`${listening.origin}/a`);
			expect(response.headers.get("date")).toBe("Mon, 19 Oct 2026 09:30:15 GMT");
		} finally {
			await listening.close();
		}
	});
});
