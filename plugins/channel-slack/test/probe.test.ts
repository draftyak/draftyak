import type { HostMethod } from "@draftyak/protocol/host-channel";
import { MAX_INLINE_BYTES } from "@draftyak/protocol/normalized-change";
import { createPluginContext, type PluginContext } from "@draftyak/sdk/context";
import type { HostFetch } from "@draftyak/sdk/fetch";
import { memoryHost } from "@draftyak/sdk/host";
import { afterEach, describe, expect, it } from "vitest";
import { probeSlack } from "../src/probe.ts";

const DEGRADED = { status: "degraded", detail: "Slack probe unavailable" };
interface Gate {
	readonly promise: Promise<void>;
	release(): void;
}
function gate(): Gate {
	let release = (): void => {};
	const promise = new Promise<void>((resolve) => {
		release = resolve;
	});
	return { promise, release };
}
interface Plan {
	readonly bytes: Uint8Array;
	readonly status?: number;
	readonly media?: string;
	readonly reference?: string;
	readonly stream?: boolean;
	readonly chunkSize?: number;
	readonly hostFailure?: boolean;
	readonly headersSeen?: Gate;
	readonly headerGate?: Gate;
	readonly cleanupSeen?: Gate;
	readonly cleanupGate?: Gate;
}
function json(value: unknown, options: Omit<Plan, "bytes"> = {}): Plan {
	return { bytes: Buffer.from(JSON.stringify(value)), ...options };
}
interface Fixture {
	readonly ctx: Pick<PluginContext, "fetch" | "signal">;
	readonly controller: AbortController;
	readonly requests: Record<string, unknown>[];
	readonly methods: HostMethod[];
	readonly fetchCalls: { method?: string; stream?: boolean; signal: AbortSignal | undefined }[];
	dispose(): Promise<void>;
}
const fixtures: Fixture[] = [];
function fixture(plan: Plan): Fixture {
	const controller = new AbortController();
	const requests: Record<string, unknown>[] = [];
	const methods: HostMethod[] = [];
	const fetchCalls: Fixture["fetchCalls"] = [];
	let disposed = false;
	let work: Promise<void> | undefined;
	let pumpError: unknown;
	const parent = memoryHost(async (method, raw) => {
		methods.push(method);
		if (method !== "host/fetch") throw new Error("DYTEST unexpected host method");
		requests.push(raw as Record<string, unknown>);
		if (plan.hostFailure) throw new Error("DYTEST private host failure");
		const response = {
			status: plan.status ?? 200,
			headers: [["content-type", plan.media ?? "application/json"]],
		};
		if (plan.stream) return { ...response, streamId: "probe-stream" };
		return {
			...response,
			body:
				plan.reference === undefined
					? { base64: Buffer.from(plan.bytes).toString("base64url") }
					: { ref: plan.reference },
		};
	});
	const original = createPluginContext({ plugin: "slack-dytest" }, parent, controller.signal);
	const fetch: HostFetch = async (input, init) => {
		const signal = init?.signal instanceof AbortSignal ? init.signal : undefined;
		fetchCalls.push({ method: init?.method, stream: init?.stream, signal });
		const response = await original.fetch(input, init);
		if ((plan.cleanupSeen || plan.cleanupGate) && response.body !== null) {
			const body = response.body;
			const getReader = body.getReader.bind(body);
			Object.defineProperty(body, "getReader", {
				configurable: true,
				value: () => {
					const reader = getReader();
					const cancel = reader.cancel.bind(reader);
					Object.defineProperty(reader, "cancel", {
						configurable: true,
						value: async (reason?: unknown) => {
							plan.cleanupSeen?.release();
							if (plan.cleanupGate) await plan.cleanupGate.promise;
							return cancel(reason);
						},
					});
					return reader;
				},
			});
		}
		if (plan.stream) {
			work = (async () => {
				const size = plan.chunkSize ?? 65_536;
				for (
					let offset = 0, sequence = 0;
					offset < plan.bytes.length || sequence === 0;
					sequence++
				) {
					if (disposed || signal?.aborted || controller.signal.aborted) return;
					const end = Math.min(offset + size, plan.bytes.length);
					parent.notify({
						jsonrpc: "2.0",
						method: "host/stream.chunk",
						params: {
							streamId: "probe-stream",
							sequence,
							done: end === plan.bytes.length,
							base64: Buffer.from(plan.bytes.subarray(offset, end)).toString("base64url"),
						},
					});
					if (end === plan.bytes.length) return;
					offset = end;
					await new Promise<void>((resolve) => setImmediate(resolve));
				}
			})();
			void work.catch((error: unknown) => {
				if (!disposed && !signal?.aborted) pumpError = error;
			});
		}
		plan.headersSeen?.release();
		if (plan.headerGate) await plan.headerGate.promise;
		return response;
	};
	const owned: Fixture = {
		ctx: Object.freeze({ fetch, signal: original.signal }),
		controller,
		requests,
		methods,
		fetchCalls,
		async dispose() {
			disposed = true;
			plan.headerGate?.release();
			plan.cleanupGate?.release();
			controller.abort();
			parent.close();
			await work?.catch(() => {});
			expect(pumpError).toBeUndefined();
		},
	};
	fixtures.push(owned);
	return owned;
}
afterEach(async () => {
	try {
		for (const owned of fixtures) await owned.dispose();
	} finally {
		fixtures.length = 0;
	}
});

describe("Slack advisory probe", () => {
	it("uses one fixed credential-free auth.test POST and returns no provider identity", async () => {
		const owned = fixture(
			json({
				ok: true,
				user_id: "DYTEST user",
				team_id: "DYTEST team",
				url: "https://DYTEST.invalid/",
				extra: { ignored: true },
			}),
		);
		const result = await probeSlack(owned.ctx);
		expect(result).toEqual({ status: "ok" });
		expect(Object.isFrozen(result)).toBe(true);
		expect(owned.requests).toHaveLength(1);
		expect(owned.methods).toEqual(["host/fetch"]);
		expect(owned.requests[0]).toMatchObject({
			method: "POST",
			url: "https://slack.com/api/auth.test",
			headers: [],
		});
		for (const key of ["body", "sendTicket", "saveAs", "lookupPermit"])
			expect(owned.requests[0]).not.toHaveProperty(key);
		expect(owned.fetchCalls[0]).toMatchObject({ method: "POST", stream: false });
		expect(JSON.stringify(result)).not.toContain("DYTEST");
		expect(owned.fetchCalls[0]?.signal?.aborted).toBe(true);
		expect(owned.controller.signal.aborted).toBe(false);
	});

	it.each([
		json({ ok: false, error: "DYTEST private provider detail" }),
		json({ ok: true }, { status: 503 }),
		json({ ok: true }, { media: "text/plain" }),
		json({ ok: "true" }),
		json({}),
		json(null),
		json([{ ok: true }]),
		json({ ok: false }, { hostFailure: true }),
		{ bytes: Buffer.from("{") },
		{ bytes: Buffer.from([0xc3, 0x28]) },
		{ bytes: Buffer.alloc(0), reference: "01ARZ3NDEKTSV4RRFFQ69G5FAV" },
	])(
		"degrades provider, host, malformed, and opaque responses with a fixed private result",
		async (plan) => {
			const owned = fixture(plan);
			const result = await probeSlack(owned.ctx);
			expect(result).toEqual(DEGRADED);
			expect(Object.isFrozen(result)).toBe(true);
			expect(result).not.toHaveProperty("cause");
			expect(JSON.stringify(result)).not.toContain("DYTEST");
			expect(owned.requests).toHaveLength(1);
			expect(owned.methods).toEqual(["host/fetch"]);
			expect(owned.fetchCalls[0]?.signal?.aborted).toBe(true);
			expect(owned.controller.signal.aborted).toBe(false);
		},
	);

	it("accepts an exact 64 KiB streamed JSON response without projecting its extra fields", async () => {
		const value = Buffer.from(JSON.stringify({ ok: true, ignored: "DYTEST" }));
		const bytes = Buffer.concat([Buffer.alloc(MAX_INLINE_BYTES - value.length, 0x20), value]);
		expect(bytes).toHaveLength(MAX_INLINE_BYTES);
		const owned = fixture({ bytes, stream: true });
		expect(await probeSlack(owned.ctx)).toEqual({ status: "ok" });
		expect(owned.requests).toHaveLength(1);
	});

	it("degrades a valid JSON stream one byte over the probe ceiling", async () => {
		const value = Buffer.from(JSON.stringify({ ok: true }));
		const bytes = Buffer.concat([Buffer.alloc(MAX_INLINE_BYTES + 1 - value.length, 0x20), value]);
		const owned = fixture({ bytes, stream: true });
		expect(await probeSlack(owned.ctx)).toEqual(DEGRADED);
		expect(owned.requests).toHaveLength(1);
		expect(owned.fetchCalls[0]?.signal?.aborted).toBe(true);
	});

	it("decodes a split UTF-8 stream and still emits only the advisory status", async () => {
		const owned = fixture(
			json({ ok: true, user: "DYTEST \u{1f642}" }, { stream: true, chunkSize: 1 }),
		);
		expect(await probeSlack(owned.ctx)).toEqual({ status: "ok" });
	});

	it("does not relabel an already aborted caller as degraded or perform host work", async () => {
		const owned = fixture(json({ ok: true }));
		owned.controller.abort(new Error("DYTEST private abort reason"));
		await expect(probeSlack(owned.ctx)).rejects.toThrow(/^SLACK_PROBE_ABORTED$/);
		expect(owned.requests).toEqual([]);
		expect(owned.methods).toEqual([]);
	});

	it("rejects cancellation after genuine inline SDK headers instead of reporting success", async () => {
		const headersSeen = gate();
		const headerGate = gate();
		const owned = fixture(json({ ok: true }, { headersSeen, headerGate }));
		const pending = probeSlack(owned.ctx);
		const refused = expect(pending).rejects.toThrow(/^SLACK_PROBE_ABORTED$/);
		await headersSeen.promise;
		owned.controller.abort();
		headerGate.release();
		await refused;
		expect(owned.requests).toHaveLength(1);
		expect(owned.fetchCalls[0]?.signal?.aborted).toBe(true);
	});

	it("rejects probe cancellation while the genuine SDK reader cleanup is pending", async () => {
		const cleanupSeen = gate();
		const cleanupGate = gate();
		const owned = fixture(json({ ok: true }, { cleanupSeen, cleanupGate }));
		const pending = probeSlack(owned.ctx);
		const refused = expect(pending).rejects.toThrow(/^SLACK_PROBE_ABORTED$/);
		await cleanupSeen.promise;
		expect(owned.fetchCalls[0]?.signal?.aborted).toBe(true);
		expect(owned.controller.signal.aborted).toBe(false);
		owned.controller.abort();
		cleanupGate.release();
		await refused;
		expect(owned.requests).toHaveLength(1);
	});

	it("captures known context data without invoking proxies or accessors", async () => {
		let calls = 0;
		const owned = fixture(json({ ok: true }));
		const proxy = new Proxy(
			{},
			{
				get() {
					calls++;
					throw new Error("DYTEST unused");
				},
				ownKeys() {
					calls++;
					return [];
				},
				getPrototypeOf() {
					calls++;
					return null;
				},
			},
		);
		expect(await probeSlack(proxy as Pick<PluginContext, "fetch" | "signal">)).toEqual(DEGRADED);
		for (const key of ["fetch", "signal"]) {
			const input = { fetch: owned.ctx.fetch, signal: owned.ctx.signal };
			Object.defineProperty(input, key, {
				enumerable: true,
				get() {
					calls++;
					return proxy;
				},
			});
			expect(await probeSlack(input)).toEqual(DEGRADED);
		}
		expect(calls).toBe(0);
		expect(owned.requests).toEqual([]);
	});
});
