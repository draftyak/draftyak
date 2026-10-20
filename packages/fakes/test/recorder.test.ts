import { randomUUID } from "node:crypto";
import { Hono } from "hono";
import { describe, expect, it, vi } from "vitest";
import { createFake, createRecorder } from "../src/index.ts";
import { rawGet, sha256 } from "./helpers.ts";

const HOST = "rec.draftyak.example";

function bodyApp(): { app: Hono; received: () => Uint8Array[] } {
	const received: Uint8Array[] = [];
	const app = new Hono();
	app.all("*", async (c) => {
		received.push(new Uint8Array(await c.req.arrayBuffer()));
		return c.body(null, 204);
	});
	return { app, received: () => received };
}

describe("recorder", () => {
	it("hashes the exact body bytes, keeps them up to the cap and leaves the body for the app", async () => {
		const recorder = createRecorder({ maxBodyBytes: 4 });
		const { app, received } = bodyApp();
		const fake = createFake(app, { host: HOST, recorder });
		// Not valid UTF-8, so nothing on the way may decode and re-encode it.
		const sent = new Uint8Array([0xff, 0xfe, 0x00, 0x41, 0xc3, 0x28, 0x0d, 0x0a, 0x80]);
		await fake.fetch("/upload", { method: "POST", body: sent });
		const [recorded] = recorder.takeRequests();
		expect(recorded?.bodySha256).toBe(sha256(sent));
		expect(recorded?.bodyLength).toBe(9);
		expect(recorded?.body).toEqual(sent.slice(0, 4));
		expect(received()).toEqual([sent]);
	});

	it("takes only a whole number of bytes as its cap", () => {
		for (const maxBodyBytes of [-1, 1.5, Number.NaN, Infinity]) {
			expect(() => createRecorder({ maxBodyBytes }), String(maxBodyBytes)).toThrow(RangeError);
		}
		expect(() => createRecorder({ maxBodyBytes: 0 })).not.toThrow();
	});

	it.each([1, 3, 4])("copies a %i-byte prefix before a Buffer chunk is reused", (cap) => {
		const recorder = createRecorder({ maxBodyBytes: cap });
		const recording = recorder.begin(new Request(`https://${HOST}/reused-buffer`));
		const chunk = Buffer.alloc(16, 0xee).subarray(5, 7);
		chunk.set([1, 2]);
		recording.write(chunk);
		chunk.set([3, 4]);
		recording.write(chunk);
		chunk.fill(0);
		recording.finish();
		const sent = new Uint8Array([1, 2, 3, 4]);
		expect(recorder.takeRequests()).toMatchObject([
			{ body: sent.slice(0, cap), bodyLength: sent.length, bodySha256: sha256(sent) },
		]);
	});

	it("reads its clone as a stream without whole-body buffering helpers", async () => {
		const recorder = createRecorder({ maxBodyBytes: 1 });
		const request = new Request(`https://${HOST}/stream`, { method: "POST", body: "12345" });
		const clone = request.clone();
		const cloneCall = vi.spyOn(request, "clone").mockReturnValue(clone);
		const helpers = ["arrayBuffer", "blob", "text"] as const;
		const spies = helpers.map((name) =>
			vi.spyOn(clone, name).mockImplementation(() => {
				throw new Error("Whole-body buffering is forbidden");
			}),
		);
		try {
			await recorder.record(request);
			expect(recorder.takeRequests()).toMatchObject([
				{ bodyLength: 5, bodySha256: sha256("12345"), body: new Uint8Array([49]) },
			]);
			for (const spy of spies) expect(spy).not.toHaveBeenCalled();
		} finally {
			cloneCall.mockRestore();
			for (const spy of spies) spy.mockRestore();
		}
	});

	it("reserves writer slots and rejects writes or settlement after completion", () => {
		const recorder = createRecorder();
		const first = recorder.begin(new Request(`https://${HOST}/first`));
		const second = recorder.begin(new Request(`https://${HOST}/second`));
		second.finish();
		expect(recorder.takeRequests()).toEqual([]);
		first.write(new Uint8Array([1, 2]));
		first.finish("request_body_too_large");
		expect(recorder.takeRequests().map(({ path, refused }) => [path, refused])).toEqual([
			["/first", "request_body_too_large"],
			["/second", undefined],
		]);
		expect(() => first.write(new Uint8Array())).toThrow("already settled");
		expect(() => first.finish()).toThrow("already settled");
		expect(() => first.discard()).toThrow("already settled");
	});

	it.each([0, 1, 4, 8, 100])(
		"keeps a %i-byte prefix across streamed binary chunks",
		async (cap) => {
			const recorder = createRecorder({ maxBodyBytes: cap });
			const chunks = [
				new Uint8Array([0xff, 0xfe]),
				new Uint8Array(),
				new Uint8Array([0x00, 0xc3, 0x28]),
				new Uint8Array([0x0d, 0x0a, 0x80]),
			];
			const sent = new Uint8Array(chunks.flatMap((chunk) => [...chunk]));
			const body = new ReadableStream<Uint8Array>({
				start(stream) {
					for (const chunk of chunks) stream.enqueue(chunk);
					stream.close();
				},
			});
			const request = new Request(`https://${HOST}/stream`, {
				method: "POST",
				body,
				duplex: "half",
			} as RequestInit);
			await Promise.all([recorder.record(request), request.arrayBuffer()]);
			const [recorded] = recorder.takeRequests();
			expect(recorded?.body).toEqual(sent.slice(0, cap));
			expect(recorded?.bodyLength).toBe(sent.byteLength);
			expect(recorded?.bodySha256).toBe(sha256(sent));
		},
	);

	it("drops a failed stream and releases later completed records in arrival order", async () => {
		const recorder = createRecorder({ maxBodyBytes: 1 });
		let fail = (): void => {};
		const body = new ReadableStream<Uint8Array>({
			start(stream) {
				stream.enqueue(new Uint8Array([1, 2, 3]));
				fail = () => stream.error(new Error("synthetic body failure"));
			},
		});
		const first = new Request(`https://${HOST}/failed`, {
			method: "POST",
			body,
			duplex: "half",
		} as RequestInit);
		const reading = recorder.record(first);
		const rejected = expect(reading).rejects.toThrow("synthetic body failure");
		await recorder.record(new Request(`https://${HOST}/second`));
		await recorder.record(new Request(`https://${HOST}/third`));
		expect(recorder.takeRequests()).toEqual([]);
		fail();
		await rejected;
		expect(recorder.takeRequests().map((entry) => entry.path)).toEqual(["/second", "/third"]);
		expect(recorder.takeRequests()).toEqual([]);
	});

	it("rejects non-byte stream chunks without leaving an invalid record", async () => {
		const recorder = createRecorder();
		const body = new ReadableStream<Uint8Array>({
			start(stream) {
				stream.enqueue("not bytes" as unknown as Uint8Array);
				stream.close();
			},
		});
		const request = new Request(`https://${HOST}/invalid`, {
			method: "POST",
			body,
			duplex: "half",
		} as RequestInit);
		await expect(recorder.record(request)).rejects.toThrow(TypeError);
		await recorder.record(new Request(`https://${HOST}/valid`));
		expect(recorder.takeRequests().map((entry) => entry.path)).toEqual(["/valid"]);
	});

	it("records an empty body for GET and HEAD", async () => {
		const recorder = createRecorder();
		const fake = createFake(bodyApp().app, { host: HOST, recorder });
		await fake.fetch("/a");
		await fake.fetch("/a", { method: "HEAD" });
		const recorded = recorder.takeRequests();
		expect(recorded.map((entry) => [entry.method, entry.bodyLength, entry.bodySha256])).toEqual([
			["GET", 0, sha256("")],
			["HEAD", 0, sha256("")],
		]);
	});

	it("keeps every header name but only the values a test selects", async () => {
		const token = `Bearer ${randomUUID()}`;
		const cookie = `session=${randomUUID()}`;
		const headers = {
			Authorization: token,
			Cookie: cookie,
			"Idempotency-Key": "out-1",
			Accept: "*/*",
		};
		const plain = createRecorder();
		const selecting = createRecorder({ headerValues: ["Idempotency-Key"] });
		await createFake(bodyApp().app, { host: HOST, recorder: plain }).fetch("/a", { headers });
		await createFake(bodyApp().app, { host: HOST, recorder: selecting }).fetch("/a", { headers });
		const [byDefault] = plain.takeRequests();
		const [selected] = selecting.takeRequests();
		expect(byDefault?.headerNames).toEqual([
			"accept",
			"authorization",
			"cookie",
			"idempotency-key",
		]);
		expect(byDefault?.headers).toEqual({});
		expect(selected?.headers).toEqual({ "idempotency-key": "out-1" });
		for (const entry of [byDefault, selected]) {
			const stored = JSON.stringify(entry);
			expect(stored).not.toContain(token.slice(7));
			expect(stored).not.toContain(cookie.slice(8));
		}
	});

	it("keeps the raw path and query, percent-encoding as it arrived", async () => {
		const recorder = createRecorder();
		const fake = createFake(bodyApp().app, { host: HOST, recorder });
		await fake.fetch("/feeds/owner%40rec.draftyak.example/a%2Fb?q=%40&x=1");
		await fake.fetch("/feeds/owner@rec.draftyak.example/x");
		expect(recorder.takeRequests().map(({ path, query }) => ({ path, query }))).toEqual([
			{ path: "/feeds/owner%40rec.draftyak.example/a%2Fb", query: "q=%40&x=1" },
			{ path: "/feeds/owner@rec.draftyak.example/x", query: "" },
		]);
	});

	// WHATWG URL parsing would resolve, drop or re-encode each of these.
	const ALTERED = ["/a/./b", "/a/x/../b", "/a/%2e%2e/b", "/a\\b", "/a?", "/a?q#f", "/a#f"];

	it("keeps the target of a URL string exactly as given", async () => {
		const recorder = createRecorder();
		const fake = createFake(bodyApp().app, { host: HOST, recorder });
		const given = [...ALTERED, "/a\tb", '/a b"é'];
		for (const target of given) await fake.fetch(`https://${HOST}${target}`);
		await fake.fetch(`https://${HOST}`);
		await fake.fetch(new Request(`https://${HOST}/a/x/../b`));
		const recorded = recorder.takeRequests();
		expect(recorded.map((entry) => entry.target)).toEqual([...given, "/", "/a/b"]);
		expect(recorded.slice(4, 7).map(({ path, query }) => [path, query])).toEqual([
			["/a", ""],
			["/a", "q"],
			["/a", ""],
		]);
	});

	it("keeps the request target exactly as it arrived over loopback", async () => {
		const recorder = createRecorder();
		const fake = createFake(bodyApp().app, { host: HOST, recorder });
		const listening = await fake.listen();
		try {
			for (const target of ALTERED) expect(await rawGet(listening, target, HOST), target).toBe(204);
			expect(await rawGet(listening, `http://${HOST}/a/x/../b`, HOST)).toBe(204);
			expect(recorder.takeRequests().map((entry) => entry.target)).toEqual([
				...ALTERED,
				"/a/x/../b",
			]);
		} finally {
			await listening.close();
		}
	});

	it("lists requests in arrival order, holding back one still sending its body", async () => {
		const recorder = createRecorder();
		const first = createFake(bodyApp().app, { host: "a.draftyak.example", recorder });
		const second = createFake(bodyApp().app, { host: "b.draftyak.example", recorder });
		let finish = (): void => {};
		const body = new ReadableStream<Uint8Array>({
			start(stream) {
				stream.enqueue(new Uint8Array(1024 * 1024));
				finish = () => stream.close();
			},
		});
		const slow = first.fetch("/first", { method: "POST", body, duplex: "half" } as RequestInit);
		await second.fetch("/second");
		expect(recorder.takeRequests()).toEqual([]);
		finish();
		await slow;
		const recorded = recorder.takeRequests();
		expect(recorded.map((entry) => `${entry.host}${entry.path}`)).toEqual([
			"a.draftyak.example/first",
			"b.draftyak.example/second",
		]);
		expect(recorded[0]?.bodyLength).toBe(1024 * 1024);
	});

	it("hands each request out once, oldest first", async () => {
		const recorder = createRecorder();
		const fake = createFake(bodyApp().app, { host: HOST, recorder });
		await fake.fetch("/1");
		await fake.fetch("/2");
		expect(recorder.takeRequests().map((entry) => entry.path)).toEqual(["/1", "/2"]);
		expect(recorder.takeRequests()).toEqual([]);
		await fake.fetch("/3");
		expect(recorder.takeRequests().map((entry) => entry.path)).toEqual(["/3"]);
	});
});
