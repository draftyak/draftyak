import { describe, expect, it } from "vitest";
import {
	createToolUpstream,
	manualClock,
	TOOL_FEED,
	TOOL_SECRET_PATH,
	TOOL_UPSTREAM_HOST,
} from "../src/index.ts";
import { rawGet, sha256 } from "./helpers.ts";

const START = Date.UTC(2026, 9, 19, 8, 0, 0, 900);
const ALLOWED = ["content-length", "content-type", "etag", "last-modified"];

// Counts as it reads, so the oversize body never sits in memory whole.
async function chunked(response: Response): Promise<{ bytes: number; chunks: number }> {
	const reader = response.body?.getReader();
	let bytes = 0;
	let chunks = 0;
	for (let read = await reader?.read(); read && !read.done; read = await reader?.read()) {
		bytes += read.value.byteLength;
		chunks += 1;
	}
	return { bytes, chunks };
}

// Each one alters the secret path in a way WHATWG URL parsing would undo or hide.
const ALTERED = [
	TOOL_SECRET_PATH.replace("%40", "@"),
	TOOL_SECRET_PATH.replace("%40", "%2540"),
	`${TOOL_SECRET_PATH}?x=1`,
	`${TOOL_SECRET_PATH}?`,
	`${TOOL_SECRET_PATH}#frag`,
	TOOL_SECRET_PATH.replace("/basic.ics", "/./basic.ics"),
	TOOL_SECRET_PATH.replace("/basic.ics", "/extra/../basic.ics"),
	TOOL_SECRET_PATH.replace("/basic.ics", "/extra/%2e%2e/basic.ics"),
	TOOL_SECRET_PATH.replaceAll("/", "\\").replace("\\", "/"),
];

describe("tool upstream", () => {
	it("serves the feed with validators, and headers outside tool-*'s allowlist", async () => {
		const upstream = createToolUpstream({ clock: manualClock(START) });
		const response = await upstream.fetch("/feed.ics");
		expect(response.status).toBe(200);
		expect(await response.text()).toBe(TOOL_FEED);
		const etag = `"${sha256(TOOL_FEED).slice(0, 16)}"`;
		expect(Object.fromEntries(ALLOWED.map((name) => [name, response.headers.get(name)]))).toEqual({
			"content-length": String(Buffer.byteLength(TOOL_FEED)),
			"content-type": "text/calendar; charset=utf-8",
			etag,
			"last-modified": "Mon, 19 Oct 2026 08:00:00 GMT",
		});
		const extra = [...response.headers.keys()].filter((name) => !ALLOWED.includes(name));
		expect(extra).toEqual(["date", "set-cookie", "x-upstream-trace"]);
	});

	it("answers If-None-Match and If-Modified-Since with 304 until the feed changes", async () => {
		const clock = manualClock(START);
		const upstream = createToolUpstream({ clock });
		const first = await upstream.fetch("/feed.ics");
		const etag = first.headers.get("etag") ?? "";
		const lastModified = first.headers.get("last-modified") ?? "";
		for (const ifNoneMatch of [etag, `W/${etag}`, `"other", ${etag}`, "*"]) {
			const cached = await upstream.fetch("/feed.ics", {
				headers: { "If-None-Match": ifNoneMatch },
			});
			expect(cached.status, ifNoneMatch).toBe(304);
			expect(cached.body).toBeNull();
			expect(cached.headers.get("etag")).toBe(etag);
		}
		const since = await upstream.fetch("/feed.ics", {
			headers: { "If-Modified-Since": lastModified },
		});
		expect(since.status).toBe(304);
		const stale = await upstream.fetch("/feed.ics", { headers: { "If-None-Match": '"other"' } });
		expect(stale.status).toBe(200);
		// RFC 9110 §13.1.3: with If-None-Match present, If-Modified-Since is ignored.
		const both = await upstream.fetch("/feed.ics", {
			headers: { "If-None-Match": '"other"', "If-Modified-Since": lastModified },
		});
		expect(both.status).toBe(200);

		clock.advance(60_000);
		upstream.setFeed(TOOL_FEED.replace("DYTEST busy", "DYTEST moved"));
		const changed = await upstream.fetch("/feed.ics", { headers: { "If-None-Match": etag } });
		expect(changed.status).toBe(200);
		expect(changed.headers.get("etag")).not.toBe(etag);
		expect(changed.headers.get("last-modified")).toBe("Mon, 19 Oct 2026 08:01:00 GMT");
		const modified = await upstream.fetch("/feed.ics", {
			headers: { "If-Modified-Since": lastModified },
		});
		expect(modified.status).toBe(200);
	});

	it("answers HEAD with the feed's headers and no body", async () => {
		const upstream = createToolUpstream();
		const head = await upstream.fetch("/feed.ics", { method: "HEAD" });
		expect(head.status).toBe(200);
		expect(head.headers.get("content-length")).toBe(String(Buffer.byteLength(TOOL_FEED)));
		expect(head.body).toBeNull();
	});

	it("serves the secret path only as sent, byte for byte, with %40 intact", async () => {
		const upstream = createToolUpstream();
		expect(TOOL_SECRET_PATH).toContain("%40");
		expect(upstream.secretUrl).toBe(`https://${TOOL_UPSTREAM_HOST}${TOOL_SECRET_PATH}`);
		const secret = await upstream.fetch(upstream.secretUrl);
		expect([secret.status, await secret.text()]).toEqual([200, TOOL_FEED]);
		const tabbed = TOOL_SECRET_PATH.replace("calendar", "cal\tendar");
		for (const path of [...ALTERED, tabbed]) {
			expect((await upstream.fetch(path)).status, path).toBe(404);
		}
		expect((await upstream.fetch(decodeURIComponent(upstream.secretUrl))).status).toBe(404);
		expect(upstream.recorder.takeRequests().map((request) => request.target)).toEqual([
			TOOL_SECRET_PATH,
			...ALTERED,
			tabbed,
			TOOL_SECRET_PATH.replace("%40", "@"),
		]);
	});

	it("serves the secret path only as sent over loopback too", async () => {
		const upstream = createToolUpstream();
		const listening = await upstream.listen();
		try {
			const secret = await fetch(`${listening.origin}${TOOL_SECRET_PATH}`);
			expect([secret.status, await secret.text()]).toEqual([200, TOOL_FEED]);
			expect(await rawGet(listening, TOOL_SECRET_PATH, TOOL_UPSTREAM_HOST)).toBe(200);
			for (const target of ALTERED) {
				expect(await rawGet(listening, target, TOOL_UPSTREAM_HOST), target).toBe(404);
			}
			const absolute = `http://${TOOL_UPSTREAM_HOST}${ALTERED[6]}`;
			expect(await rawGet(listening, absolute, TOOL_UPSTREAM_HOST)).toBe(404);
			const targets = upstream.recorder.takeRequests().map((request) => request.target);
			expect(targets).toEqual([TOOL_SECRET_PATH, TOOL_SECRET_PATH, ...ALTERED, ALTERED[6]]);
		} finally {
			await listening.close();
		}
	});

	it("takes only a secret path that URLs keep as it is and no public route answers", () => {
		for (const secretPath of ["calendar.ics", "/a b.ics", "/a.ics#x", "/a/../b.ics"]) {
			expect(() => createToolUpstream({ secretPath }), secretPath).toThrow(TypeError);
		}
		for (const secretPath of ["/feed.ics?token=s3cr%40t", "/redirect.ics?k=1", "/fe%65d.ics"]) {
			expect(() => createToolUpstream({ secretPath }), secretPath).toThrow(/public route/);
		}
		const custom = createToolUpstream({ secretPath: "/private/owner%40x.example/feed.ics?k=1" });
		expect(custom.secretUrl).toBe(
			`https://${TOOL_UPSTREAM_HOST}/private/owner%40x.example/feed.ics?k=1`,
		);
	});

	it("never matches a custom secret path decoded", async () => {
		const secretPath = "/private/owner%20x%22%C3%A9/feed.ics";
		const upstream = createToolUpstream({ secretPath });
		expect((await upstream.fetch(secretPath)).status).toBe(200);
		expect((await upstream.fetch('/private/owner x"é/feed.ics')).status).toBe(404);
		expect(
			(await upstream.fetch(new Request(`https://${TOOL_UPSTREAM_HOST}${secretPath}`))).status,
		).toBe(200);
	});

	it("returns a 3xx, which fetch's default mode follows and manual returns", async () => {
		const upstream = createToolUpstream();
		const moved = await upstream.fetch("/redirect.ics", { redirect: "manual" });
		expect(moved.status).toBe(302);
		expect(moved.headers.get("location")).toBe("/feed.ics");
		const followed = await upstream.fetch("/redirect.ics");
		expect([followed.status, await followed.text()]).toEqual([200, TOOL_FEED]);
		await expect(upstream.fetch("/redirect.ics", { redirect: "error" })).rejects.toThrow(TypeError);
		expect(upstream.recorder.takeRequests().map((request) => request.path)).toEqual([
			"/redirect.ics",
			"/redirect.ics",
			"/feed.ics",
			"/redirect.ics",
		]);
	});

	it("streams an oversize body past the 32 MiB cap, chunk by chunk", async () => {
		const upstream = createToolUpstream();
		const oversize = await upstream.fetch("/oversize.ics");
		expect(oversize.headers.get("content-length")).toBe(String(32 * 1024 * 1024 + 1));
		const { bytes, chunks } = await chunked(oversize);
		expect(bytes).toBe(32 * 1024 * 1024 + 1);
		expect(chunks).toBeGreaterThan(1);
		const small = createToolUpstream({ oversizeBytes: 70_000 });
		const response = await small.fetch("/oversize.ics");
		expect(response.headers.get("content-length")).toBe("70000");
		expect((await chunked(response)).bytes).toBe(70_000);
	});

	it("answers slowly, and an abort ends the wait", async () => {
		const upstream = createToolUpstream({ slowMs: 150 });
		const begun = performance.now();
		const slow = await upstream.fetch("/slow.ics");
		expect(performance.now() - begun).toBeGreaterThanOrEqual(130);
		expect([slow.status, await slow.text()]).toEqual([200, TOOL_FEED]);
		for (const slowMs of [30_000, Infinity]) {
			const stuck = createToolUpstream({ slowMs });
			const aborted = stuck.fetch("/slow.ics", { signal: AbortSignal.timeout(50) });
			await expect(aborted).rejects.toMatchObject({ name: "TimeoutError" });
		}
	});

	it("refuses a wait or a size it couldn't keep", () => {
		for (const slowMs of [-1, 1.5, 2 ** 31, Number.NaN]) {
			expect(() => createToolUpstream({ slowMs }), String(slowMs)).toThrow(RangeError);
		}
		for (const oversizeBytes of [-1, 1.5, Number.NaN, Infinity]) {
			expect(() => createToolUpstream({ oversizeBytes }), String(oversizeBytes)).toThrow(
				RangeError,
			);
		}
	});
});
