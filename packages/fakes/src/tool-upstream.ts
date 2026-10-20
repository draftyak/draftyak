import type { Hono } from "hono";
import { type Clock, checkDelay, createFaults } from "./faults.ts";
import type { Recorder } from "./recorder.ts";
import { createFake, type Fake } from "./server.ts";
import { toolUpstreamApp } from "./tool-upstream/app.ts";
import { makeFeed } from "./tool-upstream/feed.ts";

/** Under RFC 2606's reserved .example, so the name never resolves to a real host. */
export const TOOL_UPSTREAM_HOST = "feeds.draftyak.example";

/** A secret address with `%40` in its path, as owner-entered calendar addresses have. */
export const TOOL_SECRET_PATH =
	"/calendar/dytest-owner%40feeds.draftyak.example/private-5f3a9c1e/basic.ics";

export const TOOL_FEED: string = [
	"BEGIN:VCALENDAR",
	"VERSION:2.0",
	"PRODID:-//DraftYak//fakes tool upstream//EN",
	"BEGIN:VEVENT",
	"UID:dytest-1@feeds.draftyak.example",
	"DTSTAMP:20261019T080000Z",
	"DTSTART:20261019T150000Z",
	"DTEND:20261019T160000Z",
	"SUMMARY:DYTEST busy",
	"END:VEVENT",
	"BEGIN:VEVENT",
	"UID:dytest-2@feeds.draftyak.example",
	"DTSTAMP:20261019T080000Z",
	"DTSTART:20261020T130000Z",
	"DTEND:20261020T143000Z",
	"STATUS:TENTATIVE",
	"SUMMARY:DYTEST maybe busy",
	"END:VEVENT",
	"END:VCALENDAR",
	"",
].join("\r\n");

export interface ToolUpstreamOptions {
	readonly clock?: Clock;
	readonly recorder?: Recorder;
	/** The calendar served as text/calendar; TOOL_FEED by default. */
	readonly feed?: string;
	/**
	 * The secret feed's raw path and query, matched byte for byte; TOOL_SECRET_PATH by default. It
	 * must survive URL parsing as it is and may not decode to a public route's path.
	 */
	readonly secretPath?: string;
	/** How long /slow.ics waits: 30 s by default, past every lookup timeout; Infinity until aborted. */
	readonly slowMs?: number;
	/** /oversize.ics's length: 32 MiB + 1 byte by default, past the largest tool fetch cap. */
	readonly oversizeBytes?: number;
}

export interface ToolUpstream extends Fake {
	/** `https://feeds.draftyak.example<secretPath>`, what a test stores as the url-secret. */
	readonly secretUrl: string;
	/** Replaces the feed; its ETag and Last-Modified (from the clock) change with it. */
	setFeed(feed: string): void;
}

const decoded = (path: string): string => {
	try {
		return decodeURIComponent(path);
	} catch {
		return path;
	}
};

// fetch sends the secret path as it is, and no public route of the app answers for it.
function checkSecretPath(secretPath: string, app: Hono): void {
	const parsed = new URL(secretPath, `https://${TOOL_UPSTREAM_HOST}`);
	if (parsed.pathname + parsed.search !== secretPath) {
		throw new TypeError(`the secret path must be a raw path URLs keep as is: ${secretPath}`);
	}
	if (app.routes.some((route) => route.path === decoded(parsed.pathname))) {
		throw new TypeError(`the secret path leads to a public route: ${secretPath}`);
	}
}

/** A read-only feed host for tool plugins: validators, 304s, a 3xx, oversize, slow, secret. */
export function createToolUpstream(options: ToolUpstreamOptions = {}): ToolUpstream {
	const {
		secretPath = TOOL_SECRET_PATH,
		slowMs = 30_000,
		oversizeBytes = 32 * 1024 ** 2 + 1,
	} = options;
	checkDelay("slowMs", slowMs);
	if (!(Number.isSafeInteger(oversizeBytes) && oversizeBytes >= 0)) {
		throw new RangeError(`oversizeBytes must be a whole number of bytes: ${oversizeBytes}`);
	}
	const faults = createFaults({ clock: options.clock });
	let feed = makeFeed(options.feed ?? TOOL_FEED, faults.clock.now());
	const app = toolUpstreamApp({ feed: () => feed, secretPath, slowMs, oversizeBytes });
	checkSecretPath(secretPath, app);
	const fake = createFake(app, { host: TOOL_UPSTREAM_HOST, faults, recorder: options.recorder });
	return {
		...fake,
		secretUrl: `https://${TOOL_UPSTREAM_HOST}${secretPath}`,
		setFeed(text) {
			feed = makeFeed(text, faults.clock.now());
		},
	};
}
