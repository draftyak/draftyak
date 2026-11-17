// @vitest-environment node
// Fetch and abort fixtures must share the same Node EventTarget realm.
import { type ApiTransport, createApiClient } from "@draftyak/client";
import { expect, it, vi } from "vitest";
import { createQueryApplicationClient } from "../../src/app/query-application-client.ts";

function settings(zone: string) {
	return { zone, workingHours: { days: ["mon"], start: "09:00", end: "17:00" } };
}

function json(value: unknown, status = 200): Response {
	return new Response(JSON.stringify(value), {
		status,
		headers: { "content-type": "application/json" },
	});
}

function client(transport: ApiTransport) {
	return createApiClient({ transport, baseUrl: new URL("https://dytest-hub.example.invalid/") });
}

it("gets fresh canonical settings for each explicit read intent", async () => {
	const requests: Request[] = [];
	const query = createQueryApplicationClient(
		client({
			async fetch(request) {
				requests.push(request);
				return json(settings(requests.length === 1 ? "UTC" : "Asia/Tokyo"));
			},
		}),
	);
	try {
		expect((await query.getOwnerSettings()).zone).toBe("UTC");
		expect((await query.getOwnerSettings()).zone).toBe("Asia/Tokyo");
		expect(requests.map((request) => [request.method, request.url])).toEqual([
			["GET", "https://dytest-hub.example.invalid/api/v1/settings"],
			["GET", "https://dytest-hub.example.invalid/api/v1/settings"],
		]);
	} finally {
		await query.close();
	}
});

it("submits a settings mutation once and preserves the actual client failure", async () => {
	const requests: Request[] = [];
	const query = createQueryApplicationClient(
		client({
			async fetch(request) {
				requests.push(request);
				return json({ code: "UNAVAILABLE" }, 503);
			},
		}),
	);
	try {
		await expect(query.putOwnerSettings(settings("UTC"))).rejects.toMatchObject({
			code: "UNAVAILABLE",
		});
		expect(requests).toHaveLength(1);
		expect(requests[0]?.method).toBe("PUT");
		expect(await requests[0]?.text()).toBe(
			'{"workingHours":{"days":["mon"],"end":"17:00","start":"09:00"},"zone":"UTC"}',
		);
	} finally {
		await query.close();
	}
});

it("keeps concurrent account-page intents distinct and forwards their cursor and signal", async () => {
	const responses = [Promise.withResolvers<Response>(), Promise.withResolvers<Response>()];
	const requests: Request[] = [];
	const owner = new AbortController();
	const cursor = String(100).padStart(26, "0");
	const query = createQueryApplicationClient(
		client({
			fetch(request) {
				requests.push(request);
				return (
					responses[requests.length - 1]?.promise ??
					Promise.reject(new Error("DYTEST unexpected request"))
				);
			},
		}),
	);
	const first = query.pageAccounts(cursor, { signal: owner.signal });
	const second = query.pageAccounts(cursor, { signal: owner.signal });
	void first.catch(() => {});
	void second.catch(() => {});
	try {
		await vi.waitFor(() => expect(requests).toHaveLength(2));
		expect(requests.map((request) => [request.method, request.url])).toEqual([
			["GET", `https://dytest-hub.example.invalid/api/v1/accounts?afterId=${cursor}`],
			["GET", `https://dytest-hub.example.invalid/api/v1/accounts?afterId=${cursor}`],
		]);
		for (const response of responses) response.resolve(json({ accounts: [], nextId: null }));
		await expect(first).resolves.toEqual({ accounts: [], nextId: null });
		await expect(second).resolves.toEqual({ accounts: [], nextId: null });
		owner.abort();
		await expect(query.pageAccounts(cursor, { signal: owner.signal })).rejects.toMatchObject({
			code: "CLIENT_ABORTED",
		});
		expect(requests).toHaveLength(2);
	} finally {
		owner.abort();
		for (const response of responses) response.resolve(json({ code: "UNAVAILABLE" }, 503));
		await Promise.allSettled([first, second, query.close()]);
	}
});

it("seals admissions and joins an aborted transport and its body cancellation before closing", async () => {
	const response = Promise.withResolvers<Response>();
	const cancellation = Promise.withResolvers<void>();
	const owner = new AbortController();
	let requests = 0;
	let cancellations = 0;
	const query = createQueryApplicationClient(
		client({
			fetch() {
				requests++;
				return response.promise;
			},
		}),
	);
	const request = query.getOwnerSettings({ signal: owner.signal });
	void request.catch(() => {});
	let closing: Promise<void> | undefined;
	let closed = false;
	try {
		await vi.waitFor(() => expect(requests).toBe(1));
		owner.abort();
		closing = query.close();
		expect(query.close()).toBe(closing);
		void closing.then(() => {
			closed = true;
		});
		await expect(query.getOwnerSettings()).rejects.toThrow();
		expect(requests).toBe(1);
		await Promise.resolve();
		expect(closed).toBe(false);
		response.resolve(
			new Response(
				new ReadableStream<Uint8Array>({
					cancel() {
						cancellations++;
						return cancellation.promise;
					},
				}),
				{ status: 200, headers: { "content-type": "application/json" } },
			),
		);
		await vi.waitFor(() => expect(cancellations).toBe(1));
		expect(closed).toBe(false);
		cancellation.resolve();
		await expect(request).rejects.toMatchObject({ code: "CLIENT_ABORTED" });
		await closing;
		expect(closed).toBe(true);
	} finally {
		owner.abort();
		response.resolve(json({ code: "UNAVAILABLE" }, 503));
		cancellation.resolve();
		await Promise.allSettled([request, closing ?? query.close()]);
	}
});
