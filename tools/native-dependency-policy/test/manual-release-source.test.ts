import { createHash } from "node:crypto";
import { EventEmitter } from "node:events";
import type { ClientRequest, IncomingMessage } from "node:http";
import { performance } from "node:perf_hooks";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	createNativeManualReleaseObserver,
	createTestManualReleaseObserver,
	ManualSourceError,
	type ManualTestResponse,
} from "../src/manual-release-source.ts";
import {
	BODY_CANARY,
	body,
	fixture,
	GITLAB_PAGE,
	GITLAB_PROJECT,
	GTK_PAGE,
	GTK_PROJECT,
	githubLink,
	githubRelease,
	gitlabHeaders,
	type JsonRecord,
	putZbusPages,
	response,
	zbusPage,
} from "./fixtures/manual-release-source.ts";

const http = vi.hoisted(() => ({ request: vi.fn() }));
vi.mock("node:https", () => ({ request: http.request }));
function testSource(
	map: Map<string, ManualTestResponse>,
	hooks?: {
		fetch?: (url: string, n: number) => void;
		wall?: () => number;
		monotonic?: () => number;
	},
) {
	const urls: string[] = [];
	const observer = createTestManualReleaseObserver({
		fetch: async (url) => {
			urls.push(url);
			hooks?.fetch?.(url, urls.length);
			const r = map.get(url);
			if (!r) throw new Error("fixture unavailable");
			return r;
		},
		wall: hooks?.wall ?? (() => 1000),
		monotonic: hooks?.monotonic ?? (() => 0),
	});
	return { observer, urls };
}
interface HttpMode {
	status?: number;
	encoding?: string;
	length?: string;
	complete?: boolean;
	neverEnd?: boolean;
	tooLarge?: boolean;
	beforeEnd?: () => void;
}
let map: Map<string, ManualTestResponse>, destroys: number;
function nativeHttp(mode: HttpMode = {}) {
	http.request.mockImplementation(
		(url: string, _options: unknown, callback: (r: IncomingMessage) => void) => {
			const request = new EventEmitter() as EventEmitter & { end: () => void; destroy: () => void };
			request.destroy = () => {
				destroys++;
			};
			request.end = () =>
				queueMicrotask(() => {
					const chosen = map.get(url);
					if (!chosen) throw new Error("unexpected fixture URL");
					const incoming = new EventEmitter() as EventEmitter & {
						statusCode: number;
						headers: Record<string, string | undefined>;
						complete: boolean;
						destroy: () => void;
					};
					incoming.statusCode = mode.status ?? 200;
					incoming.headers = { ...chosen.headers };
					incoming.complete = mode.complete ?? true;
					incoming.destroy = () => {
						destroys++;
					};
					if (mode.encoding !== undefined) incoming.headers["content-encoding"] = mode.encoding;
					if (mode.length !== undefined) incoming.headers["content-length"] = mode.length;
					callback(incoming as unknown as IncomingMessage);
					if (mode.neverEnd) return;
					incoming.emit(
						"data",
						mode.tooLarge ? Buffer.alloc(8 * 1024 * 1024 + 1) : Buffer.from(chosen.bytes),
					);
					mode.beforeEnd?.();
					incoming.emit("end");
				});
			return request as unknown as ClientRequest;
		},
	);
}
beforeEach(() => {
	map = fixture();
	destroys = 0;
	http.request.mockReset();
	nativeHttp();
});
afterEach(() => {
	vi.restoreAllMocks();
	vi.useRealTimers();
	vi.unstubAllEnvs();
});

describe("manual release content bindings only", () => {
	it("collects all fixed channels, pages and rechecks with opaque content states, not human assessment", async () => {
		const { observer, urls } = testSource(map),
			o = await observer.observe();
		expect(o.kind).toBe("CONTENT_BINDINGS_ONLY");
		expect(o.origin).toBe("TEST_ONLY");
		expect(o.inventories.map((x) => x.releases.length)).toEqual([3, 101, 0]);
		expect(o.receipts).toHaveLength(13);
		expect(o.inventories[1]?.coverage).toBe("bounded-pages-with-page1-recheck");
		expect(o.inventories[1]?.pages).toHaveLength(2);
		expect(urls.filter((u) => u === zbusPage(1))).toHaveLength(2);
		expect(urls.filter((u) => u === zbusPage(2))).toHaveLength(1);
		const releases = o.inventories[0]?.releases;
		expect(releases?.[0]?.name).toEqual({ state: "missing" });
		expect(releases?.[0]?.body).toEqual({ state: "null" });
		expect(releases?.[1]?.name).toEqual({ state: "null" });
		expect(releases?.[1]?.body).toEqual({ state: "missing" });
		expect(releases?.[2]?.body).toEqual({
			state: "string",
			bytes: Buffer.byteLength(BODY_CANARY),
			sha256: createHash("sha256").update(BODY_CANARY).digest("hex"),
		});
		expect(o.inventories[2]?.project.archived).toEqual({ state: "missing" });
		expect(Object.isFrozen(o.inventories[0]?.releases)).toBe(true);
		const serialized = JSON.stringify(o);
		expect(serialized).not.toContain(BODY_CANARY);
		expect(serialized).not.toContain("fixture_release_3");
		for (const key of [
			"assessed",
			"approved",
			"manualRead",
			"relevance",
			"dispositions",
			"SecurityBasis",
		])
			expect(serialized).not.toContain(`"${key}"`);
	});
	it("has a real native path with fixed TLS/GET options and no source or proxy override", async () => {
		vi.stubEnv("HTTPS_PROXY", "https://example.invalid/proxy");
		const o = await createNativeManualReleaseObserver().observe();
		expect(o.origin).toBe("NATIVE");
		expect(http.request).toHaveBeenCalledTimes(13);
		for (const [url, options] of http.request.mock.calls) {
			expect(map.has(url)).toBe(true);
			expect(options).toEqual({
				method: "GET",
				rejectUnauthorized: true,
				agent: false,
				maxHeaderSize: 16384,
				headers: {
					accept: "application/json",
					"accept-encoding": "identity",
					"user-agent": "draftyak-native-dependency-policy",
				},
			});
		}
	});
	it("retains supported inventories above historical observations without using historical count caps", async () => {
		map.set(GTK_PAGE, response(Array.from({ length: 99 }, (_, i) => githubRelease(i + 1))));
		putZbusPages(
			map,
			Array.from({ length: 401 }, (_, i) => githubRelease(i + 1000)),
		);
		const o = await testSource(map).observer.observe();
		expect(o.inventories.map((c) => c.releases.length)).toEqual([99, 401, 0]);
		expect(o.inventories[1]?.pages).toHaveLength(5);
	});
	it("rejects serialized or TEST_ONLY observations at the native comparison seam before fetching", async () => {
		const { observer } = testSource(map),
			o = await observer.observe(),
			native = createNativeManualReleaseObserver();
		await expect(native.revalidate(o)).rejects.toThrow(ManualSourceError);
		await expect(observer.revalidate({ ...o, origin: "NATIVE" })).rejects.toThrow(
			ManualSourceError,
		);
		expect(http.request).not.toHaveBeenCalled();
	});
	it.each([9999, 10000])(
		"checks monotonic body completion at %ims before a delayed timer callback",
		async (elapsed) => {
			vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
			let now = 0;
			vi.spyOn(performance, "now").mockImplementation(() => now);
			nativeHttp({
				beforeEnd: () => {
					if (http.request.mock.calls.length === 1) now += elapsed;
				},
			});
			const native = createNativeManualReleaseObserver();
			if (elapsed < 10000) {
				expect((await native.observe()).receipts).toHaveLength(13);
				expect(destroys).toBe(0);
			} else {
				await expect(native.observe()).rejects.toMatchObject({ code: "M_SOURCE_UNAVAILABLE" });
				expect(http.request).toHaveBeenCalledTimes(1);
				expect(destroys).toBe(2);
			}
			expect(vi.getTimerCount()).toBe(0);
		},
	);
	it("aborts a body that never completes at the ten-second timer", async () => {
		vi.useFakeTimers();
		nativeHttp({ neverEnd: true });
		const p = createNativeManualReleaseObserver().observe(),
			refusal = expect(p).rejects.toMatchObject({ code: "M_SOURCE_UNAVAILABLE" });
		await vi.advanceTimersByTimeAsync(10000);
		await refusal;
		expect(destroys).toBe(2);
	});
	it.each([
		{ status: 301 },
		{ status: 401 },
		{ status: 403 },
		{ status: 429 },
		{ encoding: "gzip" },
		{ length: "8388609" },
		{ length: "1" },
		{ complete: false },
		{ tooLarge: true },
	])("refuses unsupported native HTTP %j", async (mode) => {
		nativeHttp(mode);
		await expect(createNativeManualReleaseObserver().observe()).rejects.toMatchObject({
			code: "M_SOURCE_UNAVAILABLE",
		});
		expect(http.request).toHaveBeenCalledTimes(1);
		expect(destroys).toBeGreaterThan(0);
	});
	it.each(["366664320.0", "366664320e0", '"366664320"', "-1", "0"])(
		"refuses unsupported exact project id token %s",
		async (token) => {
			const original = map.get(GTK_PROJECT);
			if (!original) throw new Error("fixture missing");
			map.set(GTK_PROJECT, {
				...original,
				bytes: new TextEncoder().encode(
					new TextDecoder().decode(original.bytes).replace('"id":366664320', `"id":${token}`),
				),
			});
			await expect(testSource(map).observer.observe()).rejects.toThrow(ManualSourceError);
		},
	);
	it.each(["9007199254740991.1", "1.0", "1e0", '"1"', "null"])(
		"refuses unsupported exact release id token %s",
		async (token) => {
			const original = map.get(GTK_PAGE);
			if (!original) throw new Error("fixture missing");
			map.set(GTK_PAGE, {
				...original,
				bytes: new TextEncoder().encode(
					new TextDecoder().decode(original.bytes).replace('"id":1', `"id":${token}`),
				),
			});
			await expect(testSource(map).observer.observe()).rejects.toThrow(ManualSourceError);
		},
	);
	it("preserves the maximum safe actual release id without an ordinal or alias", async () => {
		map.set(GTK_PAGE, response([githubRelease(Number.MAX_SAFE_INTEGER)]));
		const o = await testSource(map).observer.observe();
		expect(o.inventories[0]?.releases[0]?.id).toBe(Number.MAX_SAFE_INTEGER);
	});
	it.each([
		{ id: 1 },
		{ full_name: "other/project" },
		{ private: true },
		{ default_branch: null },
		{ archived: undefined },
	])("rejects unsupported project identity %j", async (change) => {
		const original = map.get(GTK_PROJECT);
		if (!original) throw new Error("fixture missing");
		map.set(GTK_PROJECT, response({ ...(body(original) as JsonRecord), ...change }));
		await expect(testSource(map).observer.observe()).rejects.toThrow(ManualSourceError);
	});
	it("refuses duplicate release ids or tags across otherwise valid pages", async () => {
		for (const duplicate of ["id", "tag_name"]) {
			map = fixture();
			const r = githubRelease(2000);
			r[duplicate] = duplicate === "id" ? 1000 : "v1000";
			map.set(
				zbusPage(2),
				response([r], {
					link: `${githubLink(639304056, 1, "prev")}, ${githubLink(639304056, 1, "first")}`,
				}),
			);
			await expect(testSource(map).observer.observe()).rejects.toThrow(ManualSourceError);
		}
	});
	it("refuses unsupported populated GitLab releases without interpreting them as assessed content", async () => {
		map.set(GITLAB_PAGE, response([{}], gitlabHeaders()));
		await expect(testSource(map).observer.observe()).rejects.toMatchObject({
			code: "M_SCHEMA_UNQUALIFIED",
		});
	});
	it.each([
		"wrong-project",
		"credentials",
		"encoded-query",
		"duplicate-query",
		"wrong-page",
		"too-many-pages",
	])("refuses hostile pagination %s before following a URL", async (kind) => {
		let link = githubLink(639304056, 2, "next");
		if (kind === "wrong-project") link = githubLink(1, 2, "next");
		if (kind === "credentials") link = link.replace("https://", "https://user:pass@");
		if (kind === "encoded-query") link = link.replace("page=2", "%70age=2");
		if (kind === "duplicate-query") link = link.replace("page=2", "page=2&page=2");
		if (kind === "wrong-page") link = githubLink(639304056, 3, "next");
		if (kind === "too-many-pages") link = githubLink(639304056, 101, "next");
		const original = map.get(zbusPage(1));
		if (!original) throw new Error("fixture missing");
		map.set(zbusPage(1), { ...original, headers: { link } });
		const { observer, urls } = testSource(map);
		await expect(observer.observe()).rejects.toThrow(ManualSourceError);
		expect(urls).not.toContain(zbusPage(2));
	});
	it("refuses a saturated first-only M1 page or saturated terminal M2 page", async () => {
		map.set(GTK_PAGE, response(Array.from({ length: 100 }, (_, i) => githubRelease(i + 1))));
		await expect(testSource(map).observer.observe()).rejects.toThrow(ManualSourceError);
		map = fixture();
		putZbusPages(
			map,
			Array.from({ length: 100 }, (_, i) => githubRelease(i + 1000)),
		);
		await expect(testSource(map).observer.observe()).rejects.toThrow(ManualSourceError);
	});
	it.each([{ "x-page": "2" }, { "x-next-page": "2" }, { "x-total": "1" }, { link: undefined }])(
		"refuses unsupported GitLab terminal metadata %j",
		async (change) => {
			map.set(GITLAB_PAGE, response([], { ...gitlabHeaders(), ...change }));
			await expect(testSource(map).observer.observe()).rejects.toThrow(ManualSourceError);
		},
	);
	it("refuses changed content or project metadata during the selected rechecks", async () => {
		for (const kind of ["body", "metadata"]) {
			map = fixture();
			let projectCalls = 0,
				pageCalls = 0;
			const { observer } = testSource(map, {
				fetch: (url) => {
					if (url === GTK_PROJECT && ++projectCalls === 2 && kind === "metadata")
						map.set(
							url,
							response({
								id: 366664320,
								full_name: "gtk-rs/gtk-rs-core",
								private: false,
								archived: true,
								default_branch: "main",
							}),
						);
					if (url === GTK_PAGE && ++pageCalls === 2 && kind === "body")
						map.set(url, response([githubRelease(1)]));
				},
			});
			await expect(observer.observe()).rejects.toMatchObject({ code: "M_SOURCE_CHANGED" });
		}
	});
	it("preserves raw-response changes separately from unchanged selected content facts", async () => {
		const a = await testSource(map).observer.observe();
		const original = map.get(GTK_PROJECT);
		if (!original) throw new Error("fixture missing");
		map.set(GTK_PROJECT, response({ ...(body(original) as JsonRecord), ignoredCounter: 7 }));
		const b = await testSource(map).observer.observe();
		expect(b.semanticRevision).toBe(a.semanticRevision);
		expect(b.observationRevision).not.toBe(a.observationRevision);
		expect(JSON.stringify(b)).not.toContain("ignoredCounter");
	});
	it("revalidates actual content without renewing the original observation or human assessment", async () => {
		let wall = 1000;
		const originalPage = map.get(GTK_PAGE);
		if (!originalPage) throw new Error("fixture missing");
		const { observer } = testSource(map, { wall: () => wall });
		const o = await observer.observe();
		wall = 2000;
		await observer.revalidate(o);
		expect(o.completedAt).toBe(1000);
		map.set(GTK_PAGE, response([githubRelease(1)]));
		await expect(observer.revalidate(o)).rejects.toMatchObject({ code: "M_SOURCE_CHANGED" });
		map.set(GTK_PAGE, originalPage);
		wall = 1000 + 3600000;
		await expect(observer.revalidate(o)).rejects.toMatchObject({ code: "M_SOURCE_EXPIRED" });
	});
	describe("post-comparison original window", () => {
		it.each([
			{
				name: "refuses rollback behind the original observation",
				entry: 10000,
				fresh: 9999,
				expired: true,
			},
			{
				name: "refuses rollback behind comparison entry",
				entry: 10010,
				fresh: 10005,
				expired: true,
			},
			{ name: "accepts a stable comparison clock", entry: 10010, fresh: 10010, expired: false },
			{
				name: "accepts the original window one millisecond below one hour",
				entry: 10000,
				fresh: 3609999,
				expired: false,
			},
			{
				name: "refuses the original window at exactly one hour",
				entry: 10000,
				fresh: 3610000,
				expired: true,
			},
		])("$name", async ({ entry, fresh, expired }) => {
			let comparing = false,
				wallCalls = 0;
			const { observer, urls } = testSource(map, {
				wall: () => {
					if (!comparing) return 10000;
					return wallCalls++ === 0 ? entry : fresh;
				},
			});
			const original = await observer.observe(),
				before = JSON.stringify(original);
			expect(original.completedAt).toBe(10000);
			expect(Math.min(...original.receipts.map((r) => r.checkedAt))).toBe(10000);
			comparing = true;
			if (expired)
				await expect(observer.revalidate(original)).rejects.toMatchObject({
					code: "M_SOURCE_EXPIRED",
				});
			else await expect(observer.revalidate(original)).resolves.toBeUndefined();
			expect(urls).toHaveLength(26);
			expect(JSON.stringify(original)).toBe(before);
		});
	});
	it("enforces an independent monotonic collection ceiling", async () => {
		let mono = 0;
		const { observer } = testSource(map, {
			monotonic: () => mono,
			fetch: (_url, n) => {
				if (n === 13) mono = 120000;
			},
		});
		await expect(observer.observe()).rejects.toMatchObject({ code: "M_SOURCE_EXPIRED" });
	});
	it.each(["stale", "backward", "future"])(
		"refuses invalid actual wall observations %s",
		async (kind) => {
			let wall = 1000,
				calls = 0;
			const { observer } = testSource(map, {
				wall: () => {
					calls++;
					return kind === "future" && calls === 2 ? 9000 : wall;
				},
				fetch: (_url, n) => {
					if (n === 13 && kind !== "future") wall = kind === "stale" ? 1000 + 3600000 : 999;
				},
			});
			await expect(observer.observe()).rejects.toMatchObject({ code: "M_SOURCE_EXPIRED" });
		},
	);
	it("retains GitLab archive missing/null/value as distinct source states", async () => {
		const original = map.get(GITLAB_PROJECT);
		if (!original) throw new Error("fixture missing");
		const a = await testSource(map).observer.observe();
		map.set(GITLAB_PROJECT, response({ ...(body(original) as JsonRecord), archived: null }));
		const b = await testSource(map).observer.observe();
		expect(b.inventories[2]?.project.archived).toEqual({ state: "null" });
		expect(b.semanticRevision).not.toBe(a.semanticRevision);
	});
	it("refuses malformed UTF8, duplicate members and unsupported release metadata", async () => {
		const original = map.get(GTK_PROJECT);
		if (!original) throw new Error("fixture missing");
		for (const bytes of [
			new Uint8Array([255]),
			new TextEncoder().encode('{"id":366664320,"id":366664320}'),
		]) {
			map.set(GTK_PROJECT, { ...original, bytes });
			await expect(testSource(map).observer.observe()).rejects.toThrow(ManualSourceError);
		}
		map = fixture();
		const r = githubRelease(1);
		r.published_at = "2025-01-01T00:00:60Z";
		map.set(GTK_PAGE, response([r]));
		await expect(testSource(map).observer.observe()).rejects.toThrow(ManualSourceError);
	});
	it("uses the merged per-field UTF8 content bound without returning content", async () => {
		const r = githubRelease(1);
		r.body = "é".repeat(524288);
		map.set(GTK_PAGE, response([r]));
		const o = await testSource(map).observer.observe();
		expect(o.inventories[0]?.releases[0]?.body).toMatchObject({ state: "string", bytes: 1048576 });
		r.body += "x";
		map.set(GTK_PAGE, response([r]));
		await expect(testSource(map).observer.observe()).rejects.toThrow(ManualSourceError);
	}, 30000);
	it("bounds aggregate received bytes instead of accepting many individually bounded responses", async () => {
		for (const [url, r] of map) {
			const padded = new Uint8Array(8 * 1024 * 1024).fill(32);
			padded.set(r.bytes);
			map.set(url, { ...r, bytes: padded });
		}
		await expect(testSource(map).observer.observe()).rejects.toThrow(ManualSourceError);
	}, 30000);
	it("charges logical JSON nodes across the whole collection, including ignored metadata", async () => {
		for (const url of [GTK_PROJECT, GITLAB_PROJECT, "https://api.github.com/repos/z-galaxy/zbus"]) {
			const r = map.get(url);
			if (!r) throw new Error("fixture missing");
			map.set(
				url,
				response({ ...(body(r) as JsonRecord), opaqueCounters: new Array(600000).fill(0) }),
			);
		}
		await expect(testSource(map).observer.observe()).rejects.toThrow(ManualSourceError);
	}, 30000);
	it("bounds the encoded inventory after metadata escaping, not just each response", async () => {
		const releases = Array.from({ length: 8201 }, (_, i) => ({
			...githubRelease(1000 + i),
			tag_name: `v${i}${'"'.repeat(1010)}`,
			target_commitish: '"'.repeat(1024),
		}));
		putZbusPages(map, releases);
		await expect(testSource(map).observer.observe()).rejects.toThrow(ManualSourceError);
	}, 30000);
});
