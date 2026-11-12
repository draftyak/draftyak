import type {
	HostFetchParams,
	HostMethods,
	HostNotification,
} from "@draftyak/protocol/host-channel";
import { describe, expect, it, vi } from "vitest";
import { createPluginContext, type PluginContext } from "../src/context.ts";
import { type HostFetchInit, hostFetch } from "../src/fetch.ts";
import { type HostChannel, memoryHost } from "../src/host.ts";
import type { ToolContext } from "../src/tool.ts";
import { permitA, permitB, turn } from "./lookup-fixtures.ts";

const ok = { status: 200, headers: [], body: { base64: "b2s" } };
function controlledHost() {
	const requests: HostFetchParams[] = [];
	const replies = new Map<string, (result: HostMethods["host/fetch"]["result"]) => void>();
	const listeners = new Set<(value: HostNotification) => void>();
	let subscriptions = 0;
	const host: HostChannel = {
		request(_method, params) {
			const value = params as HostFetchParams;
			requests.push(value);
			return new Promise((resolve) => replies.set(value.url, resolve as never));
		},
		subscribe(listener) {
			subscriptions++;
			listeners.add(listener);
			return () => {
				listeners.delete(listener);
			};
		},
		close() {
			listeners.clear();
		},
	};
	return {
		host,
		requests,
		replies,
		subscriptions: () => subscriptions,
		chunk(streamId: string, sequence: number, text: string, done = false) {
			for (const listener of [...listeners])
				listener({
					jsonrpc: "2.0",
					method: "host/stream.chunk",
					params: { streamId, sequence, base64: Buffer.from(text).toString("base64url"), done },
				});
		},
	};
}
describe("lookup fetch scope", () => {
	it("captures the scalar once and ignores forged fetch init or identity fields", async () => {
		const requests: unknown[] = [];
		const host = memoryHost((_method, params) => {
			requests.push(params);
			return ok;
		});
		const scope = { lookupPermit: permitA };
		const context = createPluginContext(
			{ plugin: "fixture" },
			host,
			new AbortController().signal,
			scope,
		);
		scope.lookupPermit = permitB;
		try {
			await context.fetch("https://example.invalid/a", { lookupPermit: permitB } as HostFetchInit);
			const identity = { plugin: "fixture", lookupPermit: permitB };
			await createPluginContext(identity, host).fetch("https://example.invalid/plain", {
				lookupPermit: permitB,
			} as HostFetchInit);
			expect(requests).toEqual([
				{ method: "GET", url: "https://example.invalid/a", headers: [], lookupPermit: permitA },
				{ method: "GET", url: "https://example.invalid/plain", headers: [] },
			]);
			expect(Object.keys(context)).not.toContain("lookupPermit");
		} finally {
			host.close();
		}
	});
	it("missing or retired scoped fetch refuses before touching input or host", async () => {
		const requests: unknown[] = [];
		const host = memoryHost((_method, params) => {
			requests.push(params);
			return ok;
		});
		let reads = 0;
		const input = {
			toString() {
				reads++;
				return "https://example.invalid/";
			},
		} as URL;
		const controller = new AbortController();
		controller.abort();
		try {
			await expect(hostFetch(host, undefined, {})(input)).rejects.toMatchObject({ code: "DENIED" });
			await expect(
				hostFetch(host, controller.signal, { lookupPermit: permitA })(input),
			).rejects.toMatchObject({ code: "DENIED" });
			expect(reads).toBe(0);
			expect(requests).toEqual([]);
		} finally {
			host.close();
		}
	});
	it("retirement during request body await refuses before subscription or dispatch", async () => {
		const requests: unknown[] = [];
		const host = memoryHost((_method, params) => {
			requests.push(params);
			return ok;
		});
		const subscribe = vi.spyOn(host, "subscribe");
		const controller = new AbortController();
		let cancelled = false;
		const body = new ReadableStream<Uint8Array>({
			cancel() {
				cancelled = true;
			},
		});
		const pending = hostFetch(host, controller.signal, { lookupPermit: permitA })(
			"https://example.invalid/",
			{ method: "POST", body },
		);
		const outcome = pending.then(
			() => "accepted",
			(error: { code: string }) => error.code,
		);
		await turn();
		controller.abort();
		expect(await outcome).toBe("DENIED");
		expect(cancelled).toBe(true);
		expect(subscribe).not.toHaveBeenCalled();
		expect(requests).toEqual([]);
		host.close();
	});
	it("checks cancellation after a completed body await before acquiring a stream lease", async () => {
		const { host, requests } = controlledHost();
		const subscribe = vi.spyOn(host, "subscribe");
		const controller = new AbortController();
		const body = new ReadableStream<Uint8Array>({
			start(value) {
				value.close();
			},
		});
		const original = ReadableStreamDefaultReader.prototype.releaseLock;
		const release = vi
			.spyOn(ReadableStreamDefaultReader.prototype, "releaseLock")
			.mockImplementation(function (this: ReadableStreamDefaultReader) {
				original.call(this);
				controller.abort();
			});
		const pending = hostFetch(host, controller.signal, { lookupPermit: permitA })(
			"https://example.invalid/",
			{ method: "POST", body },
		);
		try {
			const outcome = await pending.then(
				() => "accepted",
				(error: { code: string }) => error.code,
			);
			expect(outcome).toBe("DENIED");
			expect(subscribe).not.toHaveBeenCalled();
			expect(requests).toEqual([]);
		} finally {
			release.mockRestore();
			host.close();
		}
	});
	it.each(["inline", "stream"])(
		"refuses a late positive %s reply from an uncooperative host after cancellation",
		async (mode) => {
			const { host, requests, replies } = controlledHost();
			const controller = new AbortController();
			const response = hostFetch(host, controller.signal, { lookupPermit: permitA })(
				"https://example.invalid/a",
			);
			const outcome = response.then(
				() => "accepted",
				(error: { code: string }) => error.code,
			);
			await turn();
			controller.abort();
			replies.get("https://example.invalid/a")?.(
				mode === "inline" ? ok : { status: 200, headers: [], streamId: "a" },
			);
			expect(await outcome).toBe("DENIED");
			expect(requests).toHaveLength(1);
			host.close();
		},
	);
	it("retains the shared router across different scopes while seventeen established chunks bypass a pending call", async () => {
		const { host, requests, replies, chunk, subscriptions } = controlledHost();
		const pendingA = hostFetch(host, new AbortController().signal, { lookupPermit: permitA })(
			"https://example.invalid/a",
		);
		await turn();
		replies.get("https://example.invalid/a")?.({ status: 200, headers: [], streamId: "a" });
		const a = await pendingA;
		const aText = a.text();
		const pendingB = hostFetch(host, new AbortController().signal, { lookupPermit: permitB })(
			"https://example.invalid/b",
		);
		await turn();
		for (let index = 0; index < 17; index++) chunk("a", index, "a", index === 16);
		replies.get("https://example.invalid/b")?.({ status: 200, headers: [], streamId: "b" });
		chunk("b", 0, "b", true);
		try {
			expect(await aText).toBe("a".repeat(17));
			expect(await (await pendingB).text()).toBe("b");
			expect(subscriptions()).toBe(1);
			expect(requests.map((value) => value.lookupPermit)).toEqual([permitA, permitB]);
		} finally {
			host.close();
		}
	});
	it("aborts outstanding stream reads on cooperative scope retirement and ignores late chunks", async () => {
		const { host, replies, chunk } = controlledHost();
		const controller = new AbortController();
		const pending = hostFetch(host, controller.signal, { lookupPermit: permitA })(
			"https://example.invalid/a",
		);
		await turn();
		replies.get("https://example.invalid/a")?.({ status: 200, headers: [], streamId: "a" });
		const response = await pending;
		const body = response.text().then(
			() => "accepted",
			(error: { code: string }) => error.code,
		);
		controller.abort();
		chunk("a", 0, "late", true);
		expect(await body).toBe("DENIED");
		host.close();
	});
	it("does not retry a parent refusal after stripping the captured permit", async () => {
		const calls: unknown[] = [];
		const host = memoryHost((_method, params) => {
			calls.push(params);
			throw new Error("refused");
		});
		try {
			await expect(
				hostFetch(host, undefined, { lookupPermit: permitA })("https://example.invalid/"),
			).rejects.toThrow("refused");
			expect(calls).toEqual([
				{ method: "GET", url: "https://example.invalid/", headers: [], lookupPermit: permitA },
			]);
		} finally {
			host.close();
		}
	});
	it("keeps the reserved value out of public context and fetch option types", () => {
		const compileOnly = (context: PluginContext, tool: ToolContext): void => {
			// @ts-expect-error Membership is not a public context field.
			context.lookupPermit;
			// @ts-expect-error Membership is not a public tool field.
			tool.lookupPermit;
			// @ts-expect-error Fetch options cannot choose membership.
			context.fetch("https://example.invalid/", { lookupPermit: permitA });
			// @ts-expect-error Restricted tool options cannot choose membership.
			tool.fetch("https://example.invalid/", { lookupPermit: permitA });
		};
		expect(compileOnly).toBeTypeOf("function");
	});
});
