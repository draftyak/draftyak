import { EventEmitter } from "node:events";
import type { ClientRequest, IncomingMessage } from "node:http";
import { performance } from "node:perf_hooks";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BOUNDED_TUPLES } from "../src/decision.ts";
import { C2Error } from "../src/release-c2-data.ts";
import { createNativeC2Collector, createTestC2Collector } from "../src/release-c2-source.ts";
import {
	apiVersion,
	dependencyUrl,
	encode,
	fixture,
	indexVersion,
	scope,
} from "./fixtures/release-c2.ts";

const network = vi.hoisted(() => ({ request: vi.fn() }));
vi.mock("node:https", () => ({ request: network.request }));
interface ResponseMode {
	status?: number;
	encoding?: string;
	length?: string;
	complete?: boolean;
	neverEnd?: boolean;
	tooLarge?: boolean;
	aborted?: boolean;
	beforeEnd?: () => void;
	headers?: (url: string, occurrence: number) => Record<string, string | string[] | undefined>;
}
let resources: Map<string, Uint8Array>, destroys: number, bodySubscriptions: number[];
function mockHttps(mode: ResponseMode = {}) {
	const occurrences = new Map<string, number>();
	network.request.mockImplementation(
		(url: string, _options: unknown, callback: (r: IncomingMessage) => void) => {
			const occurrence = (occurrences.get(url) ?? 0) + 1;
			occurrences.set(url, occurrence);
			const operation = new EventEmitter() as EventEmitter & {
				end: () => void;
				destroy: () => void;
			};
			operation.destroy = () => {
				destroys++;
			};
			operation.end = () =>
				queueMicrotask(() => {
					const response = new EventEmitter() as EventEmitter & {
						statusCode: number;
						headers: Record<string, string | string[] | undefined>;
						complete: boolean;
						destroy: () => void;
					};
					response.statusCode = mode.status ?? 200;
					response.headers = { ...mode.headers?.(url, occurrence) };
					response.complete = mode.complete ?? true;
					response.destroy = () => {
						destroys++;
					};
					if (mode.encoding !== undefined) response.headers["content-encoding"] = mode.encoding;
					if (mode.length !== undefined) response.headers["content-length"] = mode.length;
					callback(response as unknown as IncomingMessage);
					bodySubscriptions.push(response.listenerCount("data"));
					if (mode.neverEnd) return;
					if (mode.aborted) {
						response.emit("aborted");
						return;
					}
					const bytes = resources.get(url);
					if (!bytes) throw new Error("unexpected offline fixture URL");
					response.emit(
						"data",
						mode.tooLarge ? Buffer.alloc(8 * 1024 * 1024 + 1) : Buffer.from(bytes),
					);
					mode.beforeEnd?.();
					response.emit("end");
				});
			return operation as unknown as ClientRequest;
		},
	);
}
beforeEach(() => {
	resources = fixture();
	destroys = 0;
	bodySubscriptions = [];
	network.request.mockReset();
	mockHttps();
});
afterEach(() => {
	vi.restoreAllMocks();
	vi.useRealTimers();
	vi.unstubAllEnvs();
});

describe("complete fixed-source C2 collection", () => {
	it("keeps the header-free native completeness positive", async () => {
		const r = await createNativeC2Collector().collect(scope);
		expect(r.basis.observations).toHaveLength(15);
		expect(network.request).toHaveBeenCalledTimes(30);
		expect(bodySubscriptions).toEqual(new Array(30).fill(1));
		expect(destroys).toBe(0);
	});
	it.each([
		["crate-api", "initial", "https://crates.io/api/v1/crates/glib", 1, 1],
		["sparse-index", "initial", "https://index.crates.io/gl/ib/glib", 1, 2],
		["dependencies", "initial", dependencyUrl(), 1, 3],
		["crate-api", "recheck", "https://crates.io/api/v1/crates/glib", 2, 16],
		["sparse-index", "recheck", "https://index.crates.io/gl/ib/glib", 2, 17],
		["dependencies", "recheck", dependencyUrl(), 2, 18],
	] as const)(
		"refuses unsupported Link pagination for %s %s before body acceptance",
		async (_resource, _phase, target, occurrence, count) => {
			mockHttps({
				headers: (url, n) =>
					url === target && n === occurrence
						? { link: '<https://example.invalid/next>; rel="next"' }
						: {},
			});
			await expect(createNativeC2Collector().collect(scope)).rejects.toMatchObject({
				code: "C2_UNAVAILABLE",
			});
			expect(network.request).toHaveBeenCalledTimes(count);
			expect(bodySubscriptions.at(-1)).toBe(0);
			expect(destroys).toBe(2);
		},
	);
	it.each([
		{ link: "" },
		{ link: '<https://example.invalid/self>; rel="self"' },
		{
			link: [
				'<https://example.invalid/next>; rel="next"',
				'<https://example.invalid/last>; rel="last"',
			],
		},
	])("refuses unsupported Link header state %j", async ({ link }) => {
		mockHttps({ headers: () => ({ link }) });
		await expect(createNativeC2Collector().collect(scope)).rejects.toMatchObject({
			code: "C2_UNAVAILABLE",
		});
		expect(network.request).toHaveBeenCalledTimes(1);
		expect(bodySubscriptions).toEqual([0]);
	});
	it.each([9999, 10000])(
		"checks monotonic body completion at %ims even before the timeout callback runs",
		async (elapsed) => {
			vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
			let monotonic = 1000;
			vi.spyOn(performance, "now").mockImplementation(() => monotonic);
			mockHttps({
				beforeEnd: () => {
					monotonic += elapsed;
				},
			});
			const c = createNativeC2Collector();
			if (elapsed < 10000) {
				expect((await c.collect(scope)).basis.observations).toHaveLength(15);
				expect(network.request).toHaveBeenCalledTimes(30);
				expect(destroys).toBe(0);
			} else {
				await expect(c.collect(scope)).rejects.toMatchObject({ code: "C2_UNAVAILABLE" });
				expect(network.request).toHaveBeenCalledTimes(1);
				expect(destroys).toBe(2);
			}
			expect(vi.getTimerCount()).toBe(0);
		},
	);
	it("gets and rechecks every resource, retains yanked/prerelease inventory, then revalidates without extending the window", async () => {
		const versions = BOUNDED_TUPLES.find(([n]) => n === "glib")?.[1];
		if (!versions) throw new Error("fixture version missing");
		const av = apiVersion("glib", "99.0.0-alpha.1+test"),
			iv = indexVersion("glib", "99.0.0-alpha.1+test");
		av.yanked = true;
		iv.yanked = true;
		resources.set(
			"https://crates.io/api/v1/crates/glib",
			encode({ crate: { id: "glib", name: "glib" }, versions: [apiVersion("glib", versions), av] }),
		);
		resources.set(
			"https://index.crates.io/gl/ib/glib",
			new TextEncoder().encode(
				[indexVersion("glib", versions), iv].map((v) => JSON.stringify(v)).join("\n"),
			),
		);
		resources.set(
			"https://crates.io/api/v1/crates/glib/99.0.0-alpha.1%2Btest/dependencies",
			resources.get(dependencyUrl()) as Uint8Array,
		);
		const calls: string[] = [];
		let clock = 100;
		const c = createTestC2Collector({
			fetch: async (url) => {
				calls.push(url);
				const b = resources.get(url);
				if (!b) throw new Error("fixture unavailable");
				return b;
			},
			clock: () => clock++,
		});
		const r = await c.collect(scope);
		expect(r.basis.crates.find((c) => c.name === "glib")?.versions).toHaveLength(2);
		expect(calls).toHaveLength(32);
		expect(new Set(calls).size).toBe(16);
		for (const url of resources.keys()) expect(calls.filter((x) => x === url)).toHaveLength(2);
		const before = r.basis.completedAtMs;
		await c.revalidate(r);
		expect(calls).toHaveLength(48);
		expect(r.basis.completedAtMs).toBe(before);
		const first = r.basis.observations[0];
		if (!first) throw new Error("fixture observation missing");
		clock = first.initial.observedAtMs + 3_600_000;
		await expect(c.revalidate(r)).rejects.toMatchObject({ code: "C2_EXPIRED" });
	});
	it("uses direct fixed native HTTPS options without caller transport/configuration", async () => {
		vi.stubEnv("HTTPS_PROXY", "https://example.invalid/proxy");
		const c = createNativeC2Collector(),
			r = await c.collect(scope);
		expect(r.basis.observations).toHaveLength(15);
		expect(network.request).toHaveBeenCalledTimes(30);
		for (const [url, options] of network.request.mock.calls) {
			expect(resources.has(url)).toBe(true);
			expect(options).toEqual({
				method: "GET",
				rejectUnauthorized: true,
				agent: false,
				maxHeaderSize: 16384,
				headers: {
					accept: "application/json, text/plain",
					"accept-encoding": "identity",
					"user-agent": "draftyak-native-dependency-policy",
				},
			});
		}
	});
	it.each([
		{ status: 301 },
		{ status: 302 },
		{ status: 401 },
		{ status: 429 },
		{ encoding: "gzip" },
		{ encoding: "br" },
		{ length: "8388609" },
		{ length: "1" },
		{ complete: false },
		{ tooLarge: true },
		{ aborted: true },
	])("refuses unsupported native response %j", async (mode) => {
		mockHttps(mode);
		await expect(createNativeC2Collector().collect(scope)).rejects.toMatchObject({
			code: "C2_UNAVAILABLE",
		});
		expect(network.request).toHaveBeenCalledTimes(1);
		expect(destroys).toBeGreaterThan(0);
	});
	it("covers the entire body with the ten-second deadline, destroys both handles and issues no follow-up", async () => {
		vi.useFakeTimers();
		mockHttps({ neverEnd: true });
		const p = createNativeC2Collector().collect(scope);
		const assertion = expect(p).rejects.toMatchObject({ code: "C2_UNAVAILABLE" });
		await vi.advanceTimersByTimeAsync(9999);
		expect(destroys).toBe(0);
		await vi.advanceTimersByTimeAsync(1);
		await assertion;
		expect(destroys).toBe(2);
		expect(network.request).toHaveBeenCalledTimes(1);
	});
	it("does not accept DTO or synthetic receipts as native source evidence", async () => {
		let clock = 1;
		const test = createTestC2Collector({
			fetch: async (url) => resources.get(url) as Uint8Array,
			clock: () => clock++,
		});
		const r = await test.collect(scope),
			native = createNativeC2Collector();
		await expect(native.revalidate(r)).rejects.toThrow(C2Error);
		await expect(test.revalidate({ ...r })).rejects.toThrow(C2Error);
		expect(network.request).not.toHaveBeenCalled();
	});
	it("refuses changed actual resources during later revalidation", async () => {
		let clock = 1;
		const c = createTestC2Collector({
			fetch: async (url) => resources.get(url) as Uint8Array,
			clock: () => clock++,
		});
		const r = await c.collect(scope);
		resources.set(dependencyUrl(), encode({ dependencies: [] }));
		await expect(c.revalidate(r)).rejects.toMatchObject({ code: "SOURCE_CHANGED" });
	});
	it("rechecks complete technical projections and refuses a changed dependency/inventory", async () => {
		for (const kind of ["dependency", "inventory"]) {
			const data = fixture();
			let count = 0,
				clock = 1;
			const c = createTestC2Collector({
				fetch: async (url) => {
					count++;
					if (count === 16) {
						if (kind === "dependency") data.set(dependencyUrl(), encode({ dependencies: [] }));
						else
							data.set(
								"https://crates.io/api/v1/crates/glib",
								encode({
									crate: { id: "glib", name: "glib" },
									versions: [apiVersion("glib", "99.0.0")],
								}),
							);
					}
					return data.get(url) as Uint8Array;
				},
				clock: () => clock++,
			});
			await expect(c.collect(scope)).rejects.toMatchObject({ code: "SOURCE_CHANGED" });
		}
	});
	it("refuses incomplete inventory or an unavailable per-version resource instead of collecting an installed-only prefix", async () => {
		for (const mode of ["missing-dependencies", "inventory-mismatch"]) {
			const data = fixture(),
				calls: string[] = [];
			let clock = 1;
			if (mode === "missing-dependencies") data.delete(dependencyUrl());
			else
				data.set(
					"https://crates.io/api/v1/crates/glib",
					encode({ crate: { id: "glib", name: "glib" }, versions: [apiVersion("glib", "99.0.0")] }),
				);
			const c = createTestC2Collector({
				fetch: async (url) => {
					calls.push(url);
					const b = data.get(url);
					if (!b) throw new Error("missing fixture");
					return b;
				},
				clock: () => clock++,
			});
			await expect(c.collect(scope)).rejects.toThrow(C2Error);
			expect(calls).toHaveLength(mode === "missing-dependencies" ? 3 : 2);
		}
	});
	it("refuses a future or backward revalidation clock after awaited observations", async () => {
		for (const invalid of ["future", "backward"]) {
			let clock = 100,
				rechecking = false,
				count = 0;
			const c = createTestC2Collector({
				fetch: async (url) => {
					if (rechecking) {
						count++;
						if (count === 1) clock = invalid === "future" ? 10000 : 1;
						else clock = 200;
					}
					return resources.get(url) as Uint8Array;
				},
				clock: () => clock++,
			});
			const r = await c.collect(scope);
			clock = 200;
			rechecking = true;
			await expect(c.revalidate(r)).rejects.toMatchObject({ code: "C2_EXPIRED" });
		}
	});
	it("allows ignored technical response metadata to alter body receipts without relabelling semantic facts", async () => {
		let count = 0,
			clock = 1;
		const c = createTestC2Collector({
			fetch: async (url) => {
				count++;
				const b = resources.get(url) as Uint8Array;
				return count > 15 ? new Uint8Array([32, ...b]) : b;
			},
			clock: () => clock++,
		});
		const r = await c.collect(scope);
		expect(r.basis.observations.every((o) => o.initial.bodySha256 !== o.recheck.bodySha256)).toBe(
			true,
		);
	});
});
