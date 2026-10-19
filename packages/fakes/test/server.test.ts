import { randomBytes } from "node:crypto";
import { Server } from "node:net";
import { networkInterfaces } from "node:os";
import { Hono } from "hono";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	createFake,
	createFaults,
	createRecorder,
	manualClock,
	RESERVED_PORTS,
} from "../src/index.ts";
import { rawTarget } from "../src/target.ts";
import { getWithHost, listeners, sha256, tryConnect } from "./helpers.ts";

const HOST = "echo.draftyak.example";

function echoApp(): { app: Hono; hits: () => number } {
	let hits = 0;
	const app = new Hono();
	app.get("/ping", (c) => {
		hits += 1;
		return c.json({ pong: true });
	});
	app.post("/echo", async (c) => {
		hits += 1;
		return c.body(await c.req.arrayBuffer());
	});
	return { app, hits: () => hits };
}

const open = listeners();
afterEach(async () => {
	vi.restoreAllMocks();
	await open.closeAll();
});

describe("optional bounded request intake", () => {
	it("validates the intake cap", () => {
		for (const maxRequestBodyBytes of [0, -1, 1.5, NaN, Infinity, 64 * 1024 * 1024 + 1]) {
			expect(() => createFake(echoApp().app, { host: HOST, maxRequestBodyBytes })).toThrow(
				RangeError,
			);
		}
	});

	it("keeps exact-cap bytes and raw targets through bounded intake", async () => {
		const recorder = createRecorder();
		let target = "";
		const fake = createFake(
			{
				async fetch(request) {
					target = rawTarget(request);
					expect(request.redirect).toBe("manual");
					return new Response(await request.arrayBuffer());
				},
			},
			{ host: HOST, recorder, maxRequestBodyBytes: 4 },
		);
		const bytes = new Uint8Array([0xff, 0, 0x80, 0x41]);
		const response = await fake.fetch("/a/../echo?", {
			method: "POST",
			body: bytes,
			redirect: "manual",
		});
		expect(new Uint8Array(await response.arrayBuffer())).toEqual(bytes);
		expect(target).toBe("/a/../echo?");
		expect(recorder.takeRequests()[0]).toMatchObject({
			target,
			body: bytes,
			bodyLength: bytes.length,
			bodySha256: sha256(bytes),
		});
	});

	it("cancels an oversized upload before any app, recorder or fault reads it", async () => {
		const { app, hits } = echoApp();
		const fake = createFake(app, { host: HOST, maxRequestBodyBytes: 4 });
		fake.faults.add({ kind: "server-error" });
		let cancelled = false;
		const body = new ReadableStream<Uint8Array>({
			pull(controller) {
				controller.enqueue(new Uint8Array([1, 2, 3]));
			},
			cancel() {
				cancelled = true;
			},
		});
		const response = await fake.fetch("/echo", {
			method: "POST",
			body,
			duplex: "half",
		} as RequestInit);
		expect(response.status).toBe(413);
		expect(cancelled).toBe(true);
		expect(hits()).toBe(0);
		expect(fake.recorder.takeRequests()).toEqual([]);
		expect(fake.faults.pending()).toHaveLength(1);
		expect((await fake.fetch("/echo", { method: "POST", body: "ok" })).status).toBe(503);
		expect(fake.faults.pending()).toEqual([]);
	});

	it("aborts and cancels an unfinished upload before cloning or recording it", async () => {
		const fake = createFake(echoApp().app, { host: HOST, maxRequestBodyBytes: 4 });
		const abort = new AbortController();
		const reason = new Error("DYTEST upload cancelled");
		let started = (): void => {};
		const reading = new Promise<void>((resolve) => {
			started = resolve;
		});
		let cancelled: unknown;
		const body = new ReadableStream<Uint8Array>({
			pull() {
				started();
			},
			cancel(value) {
				cancelled = value;
			},
		});
		const pending = fake.fetch("/echo", {
			method: "POST",
			body,
			signal: abort.signal,
			duplex: "half",
		} as RequestInit);
		const assertion = expect(pending).rejects.toBe(reason);
		await reading;
		abort.abort(reason);
		await assertion;
		expect(cancelled).toBe(reason);
		expect(fake.recorder.takeRequests()).toEqual([]);
	});

	it("applies the same cap over the loopback listener", async () => {
		const { app, hits } = echoApp();
		const fake = createFake(app, { host: HOST, maxRequestBodyBytes: 4 });
		const listener = await fake.listen();
		try {
			expect(
				(await fetch(`${listener.origin}/echo`, { method: "POST", body: "12345" })).status,
			).toBe(413);
			expect(hits()).toBe(0);
			expect(fake.recorder.takeRequests()).toEqual([]);
			expect(
				await (await fetch(`${listener.origin}/echo`, { method: "POST", body: "1234" })).text(),
			).toBe("1234");
		} finally {
			await listener.close();
		}
	});
});

describe("createFake in memory", () => {
	it("serves a request with no socket; a bare path goes to https://<host>", async () => {
		const fake = createFake(echoApp().app, { host: HOST });
		const response = await fake.fetch("/ping");
		expect(response.status).toBe(200);
		expect(await response.json()).toEqual({ pong: true });
		const [recorded] = fake.recorder.takeRequests();
		expect(recorded).toMatchObject({ method: "GET", host: HOST, path: "/ping" });
		expect((await fake.fetch(`https://${HOST}/ping`)).status).toBe(200);
	});

	it("answers 421 for any host but its own, with no fault and no app", async () => {
		const { app, hits } = echoApp();
		const clock = manualClock(Date.UTC(2026, 9, 19, 9));
		const fake = createFake(app, { host: HOST, faults: createFaults({ clock }) });
		fake.faults.add({ kind: "rate-limit", retryAfter: 5 });
		const response = await fake.fetch("https://echo.draftyak.com/ping");
		expect(response.status).toBe(421);
		expect(response.headers.get("date")).toBe("Mon, 19 Oct 2026 09:00:00 GMT");
		expect(await response.json()).toEqual({
			error: "misdirected_request",
			host: "echo.draftyak.com",
		});
		expect(hits()).toBe(0);
		expect(fake.faults.pending()).toHaveLength(1);
		expect((await fake.fetch("/ping")).status).toBe(429);
		expect(fake.recorder.takeRequests().map((entry) => entry.host)).toEqual([
			"echo.draftyak.com",
			HOST,
		]);
	});

	it("takes only a bare host name", () => {
		for (const host of ["https://echo.draftyak.example", "echo.draftyak.example:443", "a/b", ""]) {
			expect(() => createFake(echoApp().app, { host })).toThrow(TypeError);
		}
	});
});

describe("fake.fetch aborts as fetch does", () => {
	it("sends nothing for a signal that is already aborted", async () => {
		const { app, hits } = echoApp();
		const fake = createFake(app, { host: HOST });
		const reason = new Error("cancelled before send");
		const init = { method: "POST", body: "DYTEST", signal: AbortSignal.abort(reason) };
		await expect(fake.fetch("/echo", init)).rejects.toBe(reason);
		expect(hits()).toBe(0);
		expect(fake.recorder.takeRequests()).toEqual([]);
	});

	it("rejects with the signal's reason while the app works, even if the app ignores it", async () => {
		const app = new Hono();
		app.get("/stuck", () => new Promise<Response>(() => {}));
		const fake = createFake(app, { host: HOST });
		const controller = new AbortController();
		const pending = fake.fetch("/stuck", { signal: controller.signal });
		await expect.poll(() => fake.recorder.takeRequests()).toHaveLength(1);
		controller.abort(new Error("gave up"));
		await expect(pending).rejects.toThrow("gave up");
	});

	it("errors a body that is still streaming", async () => {
		const app = new Hono();
		app.get("/trickle", (c) =>
			c.body(new ReadableStream({ start: (stream) => stream.enqueue(new Uint8Array([1])) })),
		);
		const fake = createFake(app, { host: HOST });
		const controller = new AbortController();
		const response = await fake.fetch("/trickle", { signal: controller.signal });
		const reader = response.body?.getReader();
		expect((await reader?.read())?.value).toEqual(new Uint8Array([1]));
		controller.abort(new Error("stop reading"));
		await expect(reader?.read()).rejects.toThrow("stop reading");
	});
});

describe("fake.fetch redirect modes", () => {
	function movingApp(): Hono {
		const app = echoApp().app;
		app.get("/old", (c) => c.redirect("/ping", 302));
		app.get("/loop", (c) => c.redirect("/loop", 302));
		app.get("/away", (c) => c.redirect("https://elsewhere.draftyak.example/ping", 301));
		app.post("/form", (c) => c.redirect("/ping", 303));
		app.post("/moved", (c) => c.redirect("/echo", 307));
		return app;
	}

	it("follows by default, as fetch does, and records each hop", async () => {
		const fake = createFake(movingApp(), { host: HOST });
		const moved = await fake.fetch("/old", { headers: { Authorization: "Bearer DYTEST" } });
		expect([moved.status, await moved.json()]).toEqual([200, { pong: true }]);
		const posted = await fake.fetch("/form", post("DYTEST form"));
		expect(await posted.json()).toEqual({ pong: true });
		const kept = await fake.fetch("/moved", post("DYTEST kept"));
		expect(await kept.text()).toBe("DYTEST kept");
		const away = await fake.fetch("/away", { headers: { Authorization: "Bearer DYTEST" } });
		expect(away.status).toBe(421);
		const hops = fake.recorder.takeRequests();
		expect(hops.map(({ method, host, path }) => `${method} ${host}${path}`)).toEqual([
			`GET ${HOST}/old`,
			`GET ${HOST}/ping`,
			`POST ${HOST}/form`,
			`GET ${HOST}/ping`,
			`POST ${HOST}/moved`,
			`POST ${HOST}/echo`,
			`GET ${HOST}/away`,
			"GET elsewhere.draftyak.example/ping",
		]);
		expect(hops[3]?.headerNames).not.toContain("content-type");
		expect(hops[3]?.bodyLength).toBe(0);
		expect(hops[5]?.bodySha256).toBe(sha256("DYTEST kept"));
		expect(hops[1]?.headerNames).toContain("authorization");
		expect(hops[7]?.headerNames).not.toContain("authorization");
	});

	it("returns the 3xx with manual, and fails with error or after 20 hops", async () => {
		const fake = createFake(movingApp(), { host: HOST });
		const manual = await fake.fetch("/old", { redirect: "manual" });
		expect([manual.status, manual.headers.get("location")]).toEqual([302, "/ping"]);
		const refused = fake.fetch("/old", { redirect: "error" });
		await expect(refused).rejects.toMatchObject({ name: "TypeError", message: "fetch failed" });
		fake.recorder.takeRequests();
		await expect(fake.fetch("/loop")).rejects.toThrow("fetch failed");
		expect(fake.recorder.takeRequests()).toHaveLength(21);
	});
});

describe("listen", () => {
	it("serves on 127.0.0.1 at a random port until closed", async () => {
		const fake = createFake(echoApp().app, { host: HOST });
		const listening = open.keep(await fake.listen());
		expect(listening.origin).toBe(`http://127.0.0.1:${listening.port}`);
		expect(listening.port).toBeGreaterThan(0);
		const response = await fetch(`${listening.origin}/ping`);
		expect(await response.json()).toEqual({ pong: true });
		await listening.close();
		await listening.close();
		await expect(tryConnect("127.0.0.1", listening.port)).rejects.toThrow();
	});

	it("answers for its own name, with or without its port, its loopback address, and nothing else", async () => {
		const fake = createFake(echoApp().app, { host: HOST });
		const listening = open.keep(await fake.listen());
		const { port } = listening;
		for (const host of [HOST, `${HOST}:${port}`, `127.0.0.1:${port}`, `localhost:${port}`]) {
			expect((await getWithHost(listening, "/ping", host)).status, host).toBe(200);
		}
		for (const host of ["echo.draftyak.com", `${HOST}:${port + 1}`, "127.0.0.1"]) {
			expect((await getWithHost(listening, "/ping", host)).status, host).toBe(421);
		}
	});

	it("never takes the hub's ports 47613-47615 or the inspector's 9229", async () => {
		expect([...RESERVED_PORTS].toSorted((a, b) => a - b)).toEqual([9229, 47613, 47614, 47615]);
		// Pretend the OS offered each reserved port in turn: listen closes those and asks again.
		const address = vi.spyOn(Server.prototype, "address");
		for (const port of RESERVED_PORTS) {
			address.mockReturnValueOnce({ address: "127.0.0.1", family: "IPv4", port });
		}
		const bound = vi.spyOn(Server.prototype, "listen");
		const fake = createFake(echoApp().app, { host: HOST });
		const listening = open.keep(await fake.listen());
		const offered = address.mock.results.map((result) => (result.value as { port: number }).port);
		expect(offered.slice(0, 4)).toEqual([...RESERVED_PORTS]);
		expect(offered).toContain(listening.port);
		expect(RESERVED_PORTS.has(listening.port)).toBe(false);
		const servers = bound.mock.contexts as Server[];
		expect(servers.map((server) => server.listening)).toEqual([false, false, false, false, true]);
		expect((await fetch(`${listening.origin}/ping`)).status).toBe(200);
	});

	it("accepts no connection on any other interface", async () => {
		const fake = createFake(echoApp().app, { host: HOST });
		const listening = open.keep(await fake.listen());
		const external = Object.values(networkInterfaces())
			.flat()
			.flatMap((nic) => (nic && !nic.internal && nic.family === "IPv4" ? [nic.address] : []));
		await Promise.all(
			external.map((address) =>
				expect(tryConnect(address, listening.port), address).rejects.toThrow(),
			),
		);
	});

	it("records the exact bytes sent, which still reach the app", async () => {
		const recorder = createRecorder();
		const fake = createFake(echoApp().app, { host: HOST, recorder });
		const listening = open.keep(await fake.listen());
		const sent = new Uint8Array(randomBytes(100_000));
		const response = await fetch(`${listening.origin}/echo`, { method: "POST", body: sent });
		expect(new Uint8Array(await response.arrayBuffer())).toEqual(sent);
		const [recorded] = recorder.takeRequests();
		expect(recorded?.bodySha256).toBe(sha256(sent));
		expect(recorded?.bodyLength).toBe(sent.byteLength);
		expect(recorded?.host).toBe(`127.0.0.1:${listening.port}`);
	});

	it("drops the connection for a scripted drop, after the app ran when asked", async () => {
		const { app, hits } = echoApp();
		const fake = createFake(app, { host: HOST });
		const listening = open.keep(await fake.listen());
		fake.faults.add({ kind: "drop" }, { kind: "drop", after: true });
		await expect(fetch(`${listening.origin}/ping`)).rejects.toThrow(TypeError);
		expect(hits()).toBe(0);
		await expect(fetch(`${listening.origin}/ping`)).rejects.toThrow(TypeError);
		expect(hits()).toBe(1);
		expect((await fetch(`${listening.origin}/ping`)).status).toBe(200);
		expect(fake.recorder.takeRequests()).toHaveLength(3);
	});
});

function post(body: string): RequestInit {
	return { method: "POST", headers: { "Content-Type": "text/plain" }, body };
}
