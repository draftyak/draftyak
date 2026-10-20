import { PassThrough } from "node:stream";
import {
	HOST_FRAME_TAG,
	type HostFetchParams,
	type HostFetchResult,
} from "@draftyak/protocol/host-channel";
import { describe, expect, it } from "vitest";
import { hostFetch } from "../src/fetch.ts";
import { type MemoryHost, memoryHost } from "../src/host.ts";
import { stdioHost } from "../src/stdio.ts";

function pendingFetches() {
	const replies = new Map<string, (value: HostFetchResult) => void>();
	const host = memoryHost(
		(_method, params) =>
			new Promise<HostFetchResult>((resolve) => {
				replies.set(new URL((params as HostFetchParams).url).pathname, resolve);
			}),
	);
	let subscriptions = 0;
	const subscribe = host.subscribe;
	host.subscribe = (...args) => {
		subscriptions++;
		const unsubscribe = subscribe(...args);
		return () => {
			subscriptions--;
			unsubscribe();
		};
	};
	return { host, replies, subscriptions: () => subscriptions };
}
function chunk(host: MemoryHost, streamId: string, sequence: number, text: string, done = false) {
	host.notify({
		jsonrpc: "2.0",
		method: "host/stream.chunk",
		params: { streamId, sequence, base64: Buffer.from(text).toString("base64url"), done },
	});
}
const nextTurn = () => new Promise<void>((resolve) => setImmediate(resolve));

describe("brokered fetch", () => {
	it.each(["inline", "stream"])(
		"shared router isolates seventeen established chunks from a pending %s fetch",
		async (kind) => {
			const { host, replies } = pendingFetches();
			try {
				const pendingA = hostFetch(host)("https://example.invalid/a", { stream: true });
				await nextTurn();
				replies.get("/a")?.({ status: 200, headers: [], streamId: "a" });
				const a = await pendingA;
				let aText = "pending";
				void a.text().then(
					(value) => {
						aText = value;
					},
					() => {
						aText = "refused";
					},
				);
				const pendingB = hostFetch(host)("https://example.invalid/b", { stream: true });
				await nextTurn();
				for (let index = 0; index < 17; index++) chunk(host, "a", index, "a", index === 16);
				replies.get("/b")?.({
					status: 200,
					headers: [],
					...(kind === "stream" ? { streamId: "b" } : { body: { base64: "Yg" } }),
				});
				if (kind === "stream") chunk(host, "b", 0, "b", true);
				const b = await pendingB.catch((error: { code: string }) => error.code);
				expect(b).toBeInstanceOf(Response);
				await nextTurn();
				expect(aText).toBe("a".repeat(17));
				expect(await (b as Response).text()).toBe("b");
			} finally {
				host.close();
			}
		},
	);
	it("shared router uses one subscription across wrappers and binds reverse replies to early mailboxes", async () => {
		const { host, replies, subscriptions } = pendingFetches();
		try {
			const a = hostFetch(host, new AbortController().signal)("https://example.invalid/a");
			const b = hostFetch(host, new AbortController().signal)("https://example.invalid/b");
			await nextTurn();
			expect(subscriptions()).toBe(1);
			chunk(host, "a", 0, "a", true);
			chunk(host, "b", 0, "b", true);
			replies.get("/b")?.({ status: 200, headers: [], streamId: "b" });
			replies.get("/a")?.({ status: 200, headers: [], streamId: "a" });
			const responses = await Promise.all([a, b]);
			const actual: string[] = [];
			const reads = responses.map((response, index) =>
				response.text().then(
					(value) => {
						actual[index] = value;
					},
					() => {
						actual[index] = "refused";
					},
				),
			);
			await nextTurn();
			expect(actual).toEqual(["a", "b"]);
			await Promise.all(reads);
			expect(subscriptions()).toBe(0);
		} finally {
			host.close();
		}
	});
	it("shared router binds replies and interleaved early chunks in the same stdio read", async () => {
		const input = new PassThrough();
		const output = new PassThrough();
		const host = stdioHost({ input, output });
		const requests: { id: string; params: HostFetchParams }[] = [];
		output.on("data", (data: Buffer) => requests.push(JSON.parse(data.toString().slice(1))));
		try {
			const a = hostFetch(host)("https://example.invalid/a");
			const b = hostFetch(host)("https://example.invalid/b");
			await nextTurn();
			expect(requests).toHaveLength(2);
			const messages = [
				{ id: requests[1]?.id, result: { status: 200, headers: [], streamId: "b" } },
				{
					method: "host/stream.chunk",
					params: { streamId: "a", sequence: 0, base64: "YQ", done: true },
				},
				{
					method: "host/stream.chunk",
					params: { streamId: "b", sequence: 0, base64: "Yg", done: true },
				},
				{ id: requests[0]?.id, result: { status: 200, headers: [], streamId: "a" } },
			];
			input.write(
				messages
					.map((message) => `${HOST_FRAME_TAG}${JSON.stringify({ jsonrpc: "2.0", ...message })}\n`)
					.join(""),
			);
			expect(await (await a).text()).toBe("a");
			expect(await (await b).text()).toBe("b");
		} finally {
			host.close();
			input.destroy();
			output.destroy();
		}
	});
	it("shared router retires a cancelled pending lease without disturbing an established stream", async () => {
		const { host, replies, subscriptions } = pendingFetches();
		try {
			const pendingA = hostFetch(host)("https://example.invalid/a");
			await nextTurn();
			replies.get("/a")?.({ status: 200, headers: [], streamId: "a" });
			const a = await pendingA;
			const abort = new AbortController();
			const b = hostFetch(host)("https://example.invalid/b", { signal: abort.signal });
			const refused = b.catch((error: { code: string }) => error.code);
			await nextTurn();
			chunk(host, "late-b", 0, "discarded");
			abort.abort();
			expect(await refused).toBe("DENIED");
			replies.get("/b")?.({ status: 200, headers: [], streamId: "late-b" });
			chunk(host, "late-b", 1, "discarded", true);
			chunk(host, "a", 0, "a", true);
			expect(await a.text()).toBe("a");
			expect(subscriptions()).toBe(0);
		} finally {
			host.close();
		}
	});
	it("shared router refuses duplicate active stream IDs without taking their owner's data", async () => {
		const { host, replies } = pendingFetches();
		try {
			const pendingA = hostFetch(host)("https://example.invalid/a");
			await nextTurn();
			replies.get("/a")?.({ status: 200, headers: [], streamId: "same" });
			const a = await pendingA;
			const pendingB = hostFetch(host)("https://example.invalid/b");
			await nextTurn();
			replies.get("/b")?.({ status: 200, headers: [], streamId: "same" });
			const outcome = await pendingB.then(
				() => "accepted",
				(error: { code: string }) => error.code,
			);
			expect(outcome).toBe("DENIED");
			chunk(host, "same", 0, "a", true);
			expect(await a.text()).toBe("a");
		} finally {
			host.close();
		}
	});
	it("shared router fails unresolved leases on unknown-ID exhaustion and preserves established streams", async () => {
		const { host, replies, subscriptions } = pendingFetches();
		try {
			const pendingA = hostFetch(host)("https://example.invalid/a");
			await nextTurn();
			replies.get("/a")?.({ status: 200, headers: [], streamId: "a" });
			const a = await pendingA;
			const aText = a.text().catch((error: { code: string }) => error.code);
			let outcome = "pending";
			const b = hostFetch(host)("https://example.invalid/b").then(
				() => {
					outcome = "accepted";
				},
				(error: { code: string }) => {
					outcome = error.code;
				},
			);
			await nextTurn();
			for (let index = 0; index < 17; index++) chunk(host, `unknown-${index}`, 0, "x");
			await nextTurn();
			expect(outcome).toBe("TOO_LARGE");
			chunk(host, "a", 0, "a", true);
			expect(await aText).toBe("a");
			expect(subscriptions()).toBe(0);
			await b;
		} finally {
			host.close();
		}
	});
	it.each(["chunks", "bytes"])(
		"shared router retains a bounded %s overflow refusal only for its matching early stream ID",
		async (limit) => {
			const { host, replies } = pendingFetches();
			try {
				const a = hostFetch(host)("https://example.invalid/a");
				const b = hostFetch(host)("https://example.invalid/b");
				await nextTurn();
				for (let index = 0; index < (limit === "chunks" ? 17 : 14); index++)
					chunk(
						host,
						"a",
						index,
						limit === "chunks" ? "a" : "a".repeat(index < 12 ? 64_512 : index === 12 ? 12_288 : 1),
					);
				chunk(host, "b", 0, "b", true);
				replies.get("/a")?.({ status: 200, headers: [], streamId: "a" });
				replies.get("/b")?.({ status: 200, headers: [], streamId: "b" });
				await expect(a).rejects.toMatchObject({ code: "TOO_LARGE" });
				expect(await (await b).text()).toBe("b");
			} finally {
				host.close();
			}
		},
	);
	it("shared router accepts the exact early encoded mailbox bound", async () => {
		const { host, replies } = pendingFetches();
		try {
			const pending = hostFetch(host)("https://example.invalid/a");
			await nextTurn();
			for (let index = 0; index < 13; index++)
				chunk(host, "a", index, "a".repeat(index < 12 ? 64_512 : 12_288), index === 12);
			replies.get("/a")?.({ status: 200, headers: [], streamId: "a" });
			expect((await (await pending).arrayBuffer()).byteLength).toBe(786_432);
		} finally {
			host.close();
		}
	});
	it("shared router bounds active stream leases and releases its subscription after cancellation", async () => {
		let streams = 0;
		const host = memoryHost(() => ({ status: 200, headers: [], streamId: `s${++streams}` }));
		try {
			const responses = await Promise.all(
				Array.from({ length: 16 }, () => hostFetch(host)("https://example.invalid/")),
			);
			await expect(hostFetch(host)("https://example.invalid/excess")).rejects.toMatchObject({
				code: "TOO_LARGE",
			});
			await Promise.all(responses.map((response) => response.body?.cancel()));
			const next = await hostFetch(host)("https://example.invalid/next");
			chunk(host, `s${streams}`, 0, "next", true);
			expect(await next.text()).toBe("next");
		} finally {
			host.close();
		}
	});
	it("shared router clears pending and bound leases on channel close", async () => {
		const { host, replies, subscriptions } = pendingFetches();
		try {
			const pendingA = hostFetch(host)("https://example.invalid/a");
			await nextTurn();
			replies.get("/a")?.({ status: 200, headers: [], streamId: "a" });
			const a = await pendingA;
			const b = hostFetch(host)("https://example.invalid/b");
			const refused = b.catch((error: { code: string }) => error.code);
			await nextTurn();
			chunk(host, "b", 0, "unclaimed");
			host.close();
			expect(await refused).toBe("DENIED");
			await expect(a.text()).rejects.toMatchObject({ code: "DENIED" });
			expect(subscriptions()).toBe(0);
		} finally {
			host.close();
		}
	});
	it("accepts WHATWG requests and inline responses without native network access", async () => {
		let received: HostFetchParams | undefined;
		const host = memoryHost((_method, params) => {
			received = params as HostFetchParams;
			return {
				status: 201,
				headers: [["content-type", "text/plain"]],
				body: { base64: "d29ybGQ" },
			};
		});
		const response = await hostFetch(host)(
			new Request("https://example.invalid/", { method: "POST", body: "hello" }),
		);
		expect(response).toBeInstanceOf(Response);
		expect(response.status).toBe(201);
		expect(await response.text()).toBe("world");
		expect(received?.body).toEqual({ base64: "aGVsbG8" });
		host.close();
	});
	it("passes tickets, refs, saveAs and opaque secret URLs through unchanged", async () => {
		const ref = { ref: "01ARZ3NDEKTSV4RRFFQ69G5FAV" };
		const ticket = { nonce: "test", fields: [1, 2] };
		let received: unknown;
		const host = memoryHost((_method, params) => {
			received = params;
			return { status: 200, headers: [], body: ref };
		});
		const response = await hostFetch(host)("secret://calendarUrl", {
			method: "POST",
			body: ref,
			sendTicket: ticket,
			saveAs: "blob",
		});
		expect(received).toMatchObject({
			url: "secret://calendarUrl",
			body: ref,
			sendTicket: ticket,
			saveAs: "blob",
		});
		expect(response.bodyRef).toEqual(ref);
		host.close();
	});
	it("assembles early and later chunks, checks ordering and aborts streams", async () => {
		let host: MemoryHost;
		host = memoryHost(() => {
			host.notify({
				jsonrpc: "2.0",
				method: "host/stream.chunk",
				params: { streamId: "s1", sequence: 0, base64: "aGVs", done: false },
			});
			return { status: 200, headers: [], streamId: "s1" };
		});
		const controller = new AbortController();
		const response = await hostFetch(host)("https://example.invalid/", {
			stream: true,
			signal: controller.signal,
		});
		host.notify({
			jsonrpc: "2.0",
			method: "host/stream.chunk",
			params: { streamId: "s1", sequence: 1, base64: "bG8", done: true },
		});
		expect(await response.text()).toBe("hello");
		const bad = await hostFetch(host)("https://example.invalid/", { stream: true });
		host.notify({
			jsonrpc: "2.0",
			method: "host/stream.chunk",
			params: { streamId: "s1", sequence: 3, base64: "", done: true },
		});
		await expect(bad.text()).rejects.toThrow();
		const aborted = await hostFetch(host)("https://example.invalid/", {
			stream: true,
			signal: controller.signal,
		});
		controller.abort();
		await expect(aborted.text()).rejects.toThrow();
		host.close();
	});
	it("refuses oversized request streams and invalid host response bodies", async () => {
		let calls = 0;
		const host = memoryHost(() => {
			calls++;
			return { status: 200, headers: [], body: { base64: "bad=" } };
		});
		await expect(
			hostFetch(host)("https://example.invalid/", { method: "POST", body: new Uint8Array(65_537) }),
		).rejects.toMatchObject({ code: "TOO_LARGE" });
		expect(calls).toBe(0);
		await expect(hostFetch(host)("https://example.invalid/")).rejects.toMatchObject({
			code: "BAD_REQUEST",
		});
		host.close();
	});
	it("rejects an incomplete stream when the host channel closes", async () => {
		const host = memoryHost(() => ({ status: 200, headers: [], streamId: "stream" }));
		const response = await hostFetch(host)("https://example.invalid/", { stream: true });
		host.close();
		await expect(response.text()).rejects.toThrow();
	});
	it("settles every pending fetch stream when a close listener throws", async () => {
		let streams = 0;
		const host = memoryHost(() => ({ status: 200, headers: [], streamId: `s${++streams}` }));
		host.subscribe(
			() => {},
			() => {
				throw new Error("Close listener failed");
			},
		);
		const responses = await Promise.all([
			hostFetch(host)("https://example.invalid/one", { stream: true }),
			hostFetch(host)("https://example.invalid/two", { stream: true }),
		]);
		const readers = responses.map((response) => response.body?.getReader());
		const outcomes: unknown[] = [];
		const pending = readers.map((reader, index) =>
			reader?.read().then(
				() => {
					outcomes[index] = "resolved";
				},
				(error: { code: string }) => {
					outcomes[index] = error.code;
				},
			),
		);
		let closeError: unknown;
		try {
			try {
				host.close();
			} catch (error) {
				closeError = error;
			}
			await new Promise<void>((resolve) => setImmediate(resolve));
			expect(outcomes).toEqual(["DENIED", "DENIED"]);
			expect(closeError).toBeUndefined();
		} finally {
			await Promise.all(readers.map((reader) => reader?.cancel().catch(() => {})));
			await Promise.all(pending);
			host.close();
		}
	});
	it("delivers stream control after a notification listener throws", async () => {
		const host = memoryHost(() => ({ status: 200, headers: [], streamId: "stream" }));
		host.subscribe(() => {
			throw new Error("Notification listener failed");
		});
		const response = await hostFetch(host)("https://example.invalid/", { stream: true });
		const reader = response.body?.getReader();
		let outcome: unknown = "pending";
		const pending = reader?.read().then(
			(value) => {
				outcome = { done: value.done, text: Buffer.from(value.value ?? []).toString() };
			},
			(error: { code: string }) => {
				outcome = { code: error.code };
			},
		);
		let notificationError: unknown;
		try {
			try {
				host.notify({
					jsonrpc: "2.0",
					method: "host/stream.chunk",
					params: { streamId: "stream", sequence: 0, base64: "aGk", done: true },
				});
			} catch (error) {
				notificationError = error;
			}
			await new Promise<void>((resolve) => setImmediate(resolve));
			expect(outcome).toEqual({ done: false, text: "hi" });
			expect(notificationError).toBeUndefined();
		} finally {
			host.close();
			await pending;
		}
	});
	it("aborts a hanging request-body reader before any host call", async () => {
		let calls = 0;
		let cancelled = false;
		const host = memoryHost(() => {
			calls++;
			return { status: 200, headers: [], body: { base64: "" } };
		});
		const controller = new AbortController();
		const body = new ReadableStream<Uint8Array>({
			cancel() {
				cancelled = true;
				return new Promise(() => {});
			},
		});
		const pending = hostFetch(host, controller.signal)("https://example.invalid/", {
			method: "POST",
			body,
		});
		const refused = pending.then(
			() => "resolved",
			(error: { code: string }) => error.code,
		);
		await Promise.resolve();
		controller.abort();
		let timer: ReturnType<typeof setTimeout> | undefined;
		const outcome = await Promise.race([
			refused,
			new Promise<string>((resolve) => {
				timer = setTimeout(() => resolve("timeout"), 500);
			}),
		]);
		clearTimeout(timer);
		expect(outcome).toBe("DENIED");
		expect(cancelled).toBe(true);
		expect(calls).toBe(0);
		host.close();
	});
});
