import { type Context, Hono } from "hono";
import { httpDate, wait } from "../faults.ts";
import { rawTarget } from "../target.ts";
import { type Feed, notModified, padding } from "./feed.ts";

export interface ToolUpstreamRoutes {
	readonly feed: () => Feed;
	readonly secretPath: string;
	readonly slowMs: number;
	readonly oversizeBytes: number;
}

const CALENDAR = "text/calendar; charset=utf-8";
// Outside tool-*'s response allowlist (Content-Type, ETag, Last-Modified, Content-Length).
const EXTRA = { "Set-Cookie": "dytest-session=1; Path=/; HttpOnly", "X-Upstream-Trace": "dytest" };

function serveFeed(c: Context, feed: Feed): Response {
	const validators = { ETag: feed.etag, "Last-Modified": httpDate(feed.lastModified), ...EXTRA };
	if (notModified(feed, c.req.header("if-none-match"), c.req.header("if-modified-since"))) {
		return c.body(null, 304, validators);
	}
	const length = String(feed.body.byteLength);
	return c.body(feed.body, 200, {
		...validators,
		"Content-Type": CALENDAR,
		"Content-Length": length,
	});
}

export function toolUpstreamApp(routes: ToolUpstreamRoutes): Hono {
	const app = new Hono();
	app.get("/feed.ics", (c) => serveFeed(c, routes.feed()));
	app.get("/redirect.ics", (c) => c.redirect("/feed.ics", 302));
	app.get("/oversize.ics", (c) =>
		c.body(padding(routes.oversizeBytes), 200, {
			...EXTRA,
			"Content-Type": CALENDAR,
			"Content-Length": String(routes.oversizeBytes),
		}),
	);
	app.get("/slow.ics", async (c) => {
		await wait(routes.slowMs, c.req.raw.signal);
		return serveFeed(c, routes.feed());
	});
	// The secret feed matches the raw request target byte for byte, so %40 must arrive undecoded.
	app.get("*", (c) =>
		rawTarget(c.req.raw) === routes.secretPath ? serveFeed(c, routes.feed()) : c.body(null, 404),
	);
	app.onError((error) => {
		throw error;
	});
	return app;
}
