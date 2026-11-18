import { createHash } from "node:crypto";
import { channelV1, type SyncPage } from "@draftyak/protocol/channel-v1";
import { HostFetchParams, type HostFetchResult } from "@draftyak/protocol/host-channel";
import { canonicalize } from "@draftyak/protocol/jcs";
import { MAX_CHANGES } from "@draftyak/protocol/normalized-change";
import {
	createPluginContext,
	HostError,
	memoryHost,
	type PluginContext,
	PluginError,
} from "@draftyak/sdk";
import { afterAll, afterEach, describe, expect, it } from "vitest";
import {
	type GmailInitialOptions,
	type GmailInitialRequest,
	syncGmailInitial,
} from "../src/history/initial.ts";

const SINCE = 1_710_000_000_123;
const PROFILE = "/gmail/v1/users/me/profile";
const LIST = "/gmail/v1/users/me/messages";
const requests = channelV1.tools.channel_sync;
type Reply = (
	request: HostFetchParams,
	fixture: Fixture,
) => HostFetchResult | Promise<HostFetchResult>;
const active = new Set<Fixture>();

function deferred() {
	let resolve!: () => void;
	const promise = new Promise<void>((done) => {
		resolve = done;
	});
	return { promise, resolve };
}
function encoded(value: unknown): Buffer {
	return Buffer.from(JSON.stringify(value), "utf8");
}
function json(value: unknown, size?: number): HostFetchResult {
	const bytes = encoded(value);
	if (size !== undefined && size < bytes.length) throw new Error("DATA fixture size unavailable");
	return {
		status: 200,
		headers: [["content-type", "application/json"]],
		body: {
			base64: (size === undefined
				? bytes
				: Buffer.concat([bytes, Buffer.alloc(size - bytes.length, 32)])
			).toString("base64url"),
		},
	};
}
function profile(historyId = "1000") {
	return {
		emailAddress: "synthetic@draftyak.example",
		messagesTotal: 3,
		threadsTotal: 3,
		historyId,
	};
}
function ref(id: string) {
	return { id, threadId: `thread-${id}` };
}
function metadata(id: string, date = SINCE) {
	return {
		...ref(id),
		labelIds: ["INBOX", "UNREAD"],
		internalDate: String(date),
		sizeEstimate: 10,
	};
}
function fixed(error: unknown, code: string): boolean {
	return (
		error instanceof PluginError &&
		error.message === code &&
		error.result.code === code &&
		!Object.hasOwn(error, "cause") &&
		!Object.hasOwn(error.result, "detail")
	);
}
async function refuses(work: Promise<unknown>, code: string): Promise<void> {
	let failure: unknown;
	try {
		await work;
	} catch (error) {
		failure = error;
	}
	expect(fixed(failure, code)).toBe(true);
}

/** In-memory SDK responses only; no native account, authorization or vendor fixture. */
class Fixture {
	readonly reply: Reply;
	readonly calls: HostFetchParams[] = [];
	readonly controller = new AbortController();
	readonly released = deferred();
	readonly operations = new Set<Promise<unknown>>();
	readonly responses = new Set<Promise<HostFetchResult>>();
	readonly releases: (() => void)[] = [];
	context?: PluginContext;
	host?: ReturnType<typeof memoryHost>;
	body?: Promise<void>;
	private open = true;
	private teardown?: Promise<void>;
	constructor(reply: Reply) {
		this.reply = reply;
	}
	admit(): void {
		if (!this.open) throw new Error("DATA fixture admission closed");
	}
	start(work: (fixture: Fixture) => Promise<void>): Promise<void> {
		this.body = Promise.resolve().then(async () => {
			this.admit();
			this.host = memoryHost((method, params) => {
				this.admit();
				if (method !== "host/fetch") throw new HostError("UNSUPPORTED");
				const task = Promise.resolve().then(() => {
					this.admit();
					const request = HostFetchParams.parse(params);
					this.calls.push(request);
					return this.reply(request, this);
				});
				this.responses.add(task);
				void task.catch(() => {});
				return task;
			});
			this.context = createPluginContext(
				{ plugin: "@example/gmail-initial-data" },
				this.host,
				this.controller.signal,
			);
			await work(this);
		});
		void this.body.catch(() => {});
		return this.body;
	}
	run(request: GmailInitialRequest, options?: GmailInitialOptions): Promise<SyncPage> {
		this.admit();
		if (!this.context) throw new Error("DATA fixture not initialized");
		const original = syncGmailInitial(this.context, request, options);
		this.operations.add(original);
		void original.catch(() => {});
		return original;
	}
	async wait(original: Promise<void>): Promise<void> {
		await Promise.race([
			original,
			this.released.promise.then(() => {
				throw new Error("DATA fixture wait cancelled");
			}),
		]);
		this.admit();
	}
	finish(): Promise<void> {
		if (this.teardown) return this.teardown;
		this.open = false;
		this.controller.abort();
		this.released.resolve();
		for (const release of this.releases) release();
		this.teardown = (async () => {
			await Promise.allSettled(this.body ? [this.body] : []);
			await Promise.allSettled([...this.operations, ...this.responses]);
			this.host?.close();
			active.delete(this);
		})();
		return this.teardown;
	}
}
async function owned(reply: Reply, work: (fixture: Fixture) => Promise<void>): Promise<void> {
	const fixture = new Fixture(reply);
	active.add(fixture);
	const body = fixture.start(work);
	let failure: unknown,
		failed = false;
	try {
		await body;
	} catch (error) {
		failure = error;
		failed = true;
	}
	try {
		await fixture.finish();
	} catch (error) {
		if (!failed) failure = error;
		failed = true;
	}
	if (failed) throw failure;
}
async function finishAll(): Promise<void> {
	const outcomes = await Promise.allSettled([...active].map((fixture) => fixture.finish()));
	const failure = outcomes.find((value) => value.status === "rejected");
	if (failure?.status === "rejected") throw failure.reason;
}
afterEach(finishAll);
afterAll(finishAll);

function standard(page: unknown = { messages: [ref("one")] }): Reply {
	return (request) => {
		const url = new URL(request.url);
		if (url.pathname === PROFILE) return json(profile());
		if (url.pathname === LIST) return json(page);
		return json(metadata(decodeURIComponent(url.pathname.slice(LIST.length + 1))));
	};
}
function rewritten(cursor: string, change: (value: Record<string, unknown>) => void): string {
	const value = JSON.parse(
		Buffer.from(cursor.split(".")[2] ?? "", "base64url").toString("utf8"),
	) as Record<string, unknown>;
	change(value);
	const text = canonicalize(value);
	const stamp = createHash("sha256")
		.update("gmail-initial-data-v1\0")
		.update(text)
		.digest("base64url");
	return `gi1.c.${Buffer.from(text).toString("base64url")}.${stamp}`;
}

describe("Gmail initial/resync metadata DATA pages", () => {
	it.each(["initial", "resync"] as const)(
		"hydrates %s metadata with an inclusive window and a pre-read provider position",
		(mode) =>
			owned(
				(request) => {
					const url = new URL(request.url);
					if (url.pathname === PROFILE) return json(profile("18446744073709551615"));
					if (url.pathname === LIST)
						return json({ messages: [ref("old"), ref("edge"), ref("new")] });
					const id = url.pathname.slice(LIST.length + 1);
					return json(metadata(id, id === "old" ? SINCE - 1 : id === "edge" ? SINCE : SINCE + 1));
				},
				async (f) => {
					const page = await f.run({ mode, since: SINCE });
					expect(
						page.changes.map((change) => change.kind === "email.message" && change.providerId),
					).toEqual(["edge", "new"]);
					expect(page.cursor).toBe("gh1.p.18446744073709551615");
					expect(page.more).toBe(false);
					expect(requests.output.safeParse(page).success).toBe(true);
					expect(Object.isFrozen(page) && Object.isFrozen(page.changes)).toBe(true);
					expect(Object.keys(page).sort()).toEqual(["changes", "cursor", "more"]);
					expect(f.calls.every((call) => call.method === "GET")).toBe(true);
					expect(f.calls.map((call) => new URL(call.url).pathname)).toEqual([
						PROFILE,
						LIST,
						`${LIST}/old`,
						`${LIST}/edge`,
						`${LIST}/new`,
					]);
				},
			),
	);

	it.each(["initial", "resync"] as const)(
		"continues %s through empty and old-only pages without certifying the estimate",
		(mode) =>
			owned(
				(request) => {
					const url = new URL(request.url),
						token = url.searchParams.get("pageToken");
					if (url.pathname === PROFILE) return json(profile());
					if (url.pathname === LIST)
						return json(
							token === null
								? { messages: [ref("old")], nextPageToken: "page-one", resultSizeEstimate: 999999 }
								: token === "page-one"
									? { messages: [], nextPageToken: "page-two" }
									: { messages: [ref("new")] },
						);
					const id = url.pathname.slice(LIST.length + 1);
					return json(metadata(id, id === "old" ? SINCE - 1 : SINCE));
				},
				async (f) => {
					const first = await f.run({ mode, since: SINCE });
					expect(first.changes).toEqual([]);
					expect(first.more).toBe(true);
					const second = await f.run({ mode, since: SINCE, cursor: first.cursor });
					expect(second.changes).toEqual([]);
					expect(second.more).toBe(true);
					const third = await f.run({ mode, since: SINCE, cursor: second.cursor });
					expect(third.changes).toHaveLength(1);
					expect(third.more).toBe(false);
					expect(third.cursor).toBe("gh1.p.1000");
					expect(f.calls.filter((call) => new URL(call.url).pathname === PROFILE)).toHaveLength(1);
					expect(
						f.calls
							.filter((call) => new URL(call.url).pathname === LIST)
							.map((call) => new URL(call.url).searchParams.get("pageToken")),
					).toEqual([null, "page-one", "page-two"]);
				},
			),
	);

	it("returns an empty provider page without inventing deletions or whole-scan evidence", () =>
		owned(standard({ resultSizeEstimate: 100000 }), async (f) => {
			const page = await f.run({ mode: "initial", since: SINCE });
			expect(page).toEqual({ changes: [], cursor: "gh1.p.1000", more: false });
			expect(f.calls).toHaveLength(2);
		}));

	it.each(["mode", "since"] as const)(
		"refuses a continuation with a mismatched %s before I/O",
		(field) =>
			owned(standard({ messages: [], nextPageToken: "next" }), async (f) => {
				const page = await f.run({ mode: "initial", since: SINCE });
				const count = f.calls.length;
				await refuses(
					f.run({
						mode: field === "mode" ? "resync" : "initial",
						since: field === "since" ? SINCE + 1 : SINCE,
						cursor: page.cursor,
					}),
					"CURSOR_EXPIRED",
				);
				expect(f.calls).toHaveLength(count);
			}),
	);

	it.each([
		[
			"version",
			(value: Record<string, unknown>) => {
				value.v = 2;
			},
		],
		[
			"history leading zero",
			(value: Record<string, unknown>) => {
				value.historyId = "01000";
			},
		],
		[
			"history overflow",
			(value: Record<string, unknown>) => {
				value.historyId = "18446744073709551616";
			},
		],
		[
			"unknown field",
			(value: Record<string, unknown>) => {
				value.completeScan = true;
			},
		],
		[
			"control token",
			(value: Record<string, unknown>) => {
				value.pageToken = "next\n";
			},
		],
		[
			"invalid seen value",
			(value: Record<string, unknown>) => {
				value.seen = ["not-a-digest"];
			},
		],
		[
			"oversized seen ledger",
			(value: Record<string, unknown>) => {
				value.seen = Array.from({ length: 63 }, (_, i) => String(i).padStart(43, "A"));
			},
		],
	] as const)("rejects canonical but malformed continuation DATA: %s", (_name, change) =>
		owned(standard({ messages: [], nextPageToken: "next" }), async (f) => {
			const first = await f.run({ mode: "initial", since: SINCE });
			await refuses(
				f.run({ mode: "initial", since: SINCE, cursor: rewritten(first.cursor, change) }),
				"CURSOR_EXPIRED",
			);
			expect(f.calls).toHaveLength(2);
		}),
	);

	it.each(["digest", "base64", "duplicate", "whitespace"] as const)(
		"rejects noncanonical or inconsistent continuation bytes: %s",
		(kind) =>
			owned(standard({ messages: [], nextPageToken: "next" }), async (f) => {
				const first = await f.run({ mode: "initial", since: SINCE });
				let cursor = first.cursor;
				if (kind === "digest") cursor = cursor.slice(0, -1) + (cursor.endsWith("A") ? "B" : "A");
				else if (kind === "base64") {
					const parts = cursor.split(".");
					cursor = `gi1.c.${parts[2]}=.${parts[3]}`;
				} else {
					const text = Buffer.from(cursor.split(".")[2] ?? "", "base64url").toString("utf8");
					const altered = kind === "duplicate" ? text.replace('"v":1', '"v":1,"v":1') : ` ${text}`;
					const stamp = createHash("sha256")
						.update("gmail-initial-data-v1\0")
						.update(altered)
						.digest("base64url");
					cursor = `gi1.c.${Buffer.from(altered).toString("base64url")}.${stamp}`;
				}
				await refuses(f.run({ mode: "initial", since: SINCE, cursor }), "CURSOR_EXPIRED");
				expect(f.calls).toHaveLength(2);
			}),
	);

	it.each([
		{ mode: "delta", cursor: "gh1.p.1000" },
		{ mode: "initial", since: -1 },
		{ mode: "initial", since: 0.5 },
		{ mode: "initial", since: SINCE, unexpected: true },
		{ mode: "initial", since: SINCE, cursor: "" },
		{ mode: "initial", since: SINCE, cursor: "x".repeat(4097) },
	])("refuses invalid request DATA before reads: %j", (request) =>
		owned(standard(), async (f) => {
			await refuses(f.run(request as GmailInitialRequest), "INVALID_INPUT");
			expect(f.calls).toHaveLength(0);
		}),
	);

	it("does not invoke request accessors or proxy traps", () =>
		owned(standard(), async (f) => {
			let calls = 0;
			const accessor = {
				mode: "initial",
				get since() {
					calls++;
					return SINCE;
				},
			};
			await refuses(f.run(accessor as GmailInitialRequest), "INVALID_INPUT");
			const proxy = new Proxy(
				{ mode: "initial", since: SINCE },
				{
					ownKeys() {
						calls++;
						return [];
					},
				},
			);
			await refuses(f.run(proxy as GmailInitialRequest), "INVALID_INPUT");
			expect(calls).toBe(0);
			expect(f.calls).toHaveLength(0);
		}));

	it("refuses repeated provider tokens before hydrating another message", () =>
		owned(
			(request) => {
				const url = new URL(request.url);
				if (url.pathname === PROFILE) return json(profile());
				if (url.pathname === LIST)
					return json({
						messages: url.searchParams.has("pageToken") ? [ref("unread")] : [],
						nextPageToken: "same",
					});
				return json(metadata("unread"));
			},
			async (f) => {
				const first = await f.run({ mode: "initial", since: SINCE });
				await refuses(
					f.run({ mode: "initial", since: SINCE, cursor: first.cursor }),
					"CURSOR_EXPIRED",
				);
				expect(f.calls.map((call) => new URL(call.url).pathname)).toEqual([PROFILE, LIST, LIST]);
			},
		));

	it("refuses a multi-page token cycle", () =>
		owned(
			(request) => {
				const url = new URL(request.url);
				if (url.pathname === PROFILE) return json(profile());
				return json({
					messages: [],
					nextPageToken: url.searchParams.get("pageToken") === "a" ? "b" : "a",
				});
			},
			async (f) => {
				const a = await f.run({ mode: "initial", since: SINCE });
				const b = await f.run({ mode: "initial", since: SINCE, cursor: a.cursor });
				await refuses(f.run({ mode: "initial", since: SINCE, cursor: b.cursor }), "CURSOR_EXPIRED");
				expect(f.calls).toHaveLength(4);
			},
		));

	it("refuses a provider continuation that cannot fit the existing protocol cursor", () =>
		owned(standard({ messages: [ref("unread")], nextPageToken: '"'.repeat(2048) }), async (f) => {
			await refuses(f.run({ mode: "initial", since: SINCE }), "QUOTA_EXCEEDED");
			expect(f.calls).toHaveLength(2);
		}));

	it("does not read beyond the bounded provider-page ledger", () =>
		owned(
			(request) => {
				const url = new URL(request.url);
				if (url.pathname === PROFILE) return json(profile());
				const index = Number(url.searchParams.get("pageToken") ?? 0);
				return json({ messages: [], nextPageToken: String(index + 1) });
			},
			async (f) => {
				let cursor: string | undefined;
				for (let index = 0; index < 63; index++)
					cursor = (await f.run({ mode: "initial", since: SINCE, ...(cursor ? { cursor } : {}) }))
						.cursor;
				await refuses(f.run({ mode: "initial", since: SINCE, cursor }), "QUOTA_EXCEEDED");
				expect(f.calls.filter((call) => new URL(call.url).pathname === LIST)).toHaveLength(64);
			},
		));

	it("keeps page wire-byte accounting across filtered and emitted metadata", () => {
		const list = { messages: [ref("old"), ref("new")] },
			limit = encoded(list).length + 400;
		return owned(
			(request) => {
				const url = new URL(request.url);
				if (url.pathname === PROFILE) return json(profile());
				if (url.pathname === LIST) return json(list);
				const id = url.pathname.slice(LIST.length + 1);
				return json(metadata(id, id === "old" ? SINCE - 1 : SINCE), 200);
			},
			async (f) => {
				const page = await f.run({ mode: "initial", since: SINCE }, { maxBytes: limit });
				expect(page.changes).toHaveLength(1);
				await refuses(
					f.run({ mode: "initial", since: SINCE }, { maxBytes: limit - 1 }),
					"QUOTA_EXCEEDED",
				);
			},
		);
	});

	it.each([0, -1, 1.5, 4 * 1024 * 1024 + 1])(
		"refuses unavailable or invalid byte capacity before I/O: %s",
		(maxBytes) =>
			owned(standard(), async (f) => {
				await refuses(
					f.run({ mode: "initial", since: SINCE }, { maxBytes }),
					maxBytes === 0 ? "QUOTA_EXCEEDED" : "INVALID_INPUT",
				);
				expect(f.calls).toHaveLength(0);
			}),
	);

	it("keeps the protocol change bound on the actual list request", () =>
		owned(
			(request) => {
				const url = new URL(request.url);
				if (url.pathname === PROFILE) return json(profile());
				expect(url.searchParams.get("maxResults")).toBe(String(MAX_CHANGES));
				return json({
					messages: Array.from({ length: MAX_CHANGES + 1 }, (_, index) => ref(`m${index}`)),
				});
			},
			async (f) => {
				await refuses(f.run({ mode: "initial", since: SINCE }), "QUOTA_EXCEEDED");
				expect(f.calls).toHaveLength(2);
			},
		));

	it("rejects a metadata/list thread mismatch without returning partial changes", () =>
		owned(
			(request) => {
				const url = new URL(request.url);
				if (url.pathname === PROFILE) return json(profile());
				if (url.pathname === LIST) return json({ messages: [ref("one")] });
				return json({ ...metadata("one"), threadId: "different" });
			},
			async (f) => {
				await refuses(f.run({ mode: "initial", since: SINCE }), "TRANSIENT");
			},
		));

	it("observes cancellation before any read", () =>
		owned(standard(), async (f) => {
			f.controller.abort();
			await refuses(f.run({ mode: "initial", since: SINCE }), "TRANSIENT");
			expect(f.calls).toHaveLength(0);
		}));

	it("joins an originally held DATA response and admits no metadata after cancellation", () => {
		const entered = deferred(),
			gate = deferred();
		return owned(
			async (request) => {
				const url = new URL(request.url);
				if (url.pathname === PROFILE) return json(profile());
				entered.resolve();
				await gate.promise;
				return json({ messages: [ref("unread")] });
			},
			async (f) => {
				f.releases.push(gate.resolve);
				const original = f.run({ mode: "initial", since: SINCE });
				await f.wait(entered.promise);
				f.controller.abort();
				gate.resolve();
				await refuses(original, "TRANSIENT");
				expect(f.calls.map((call) => new URL(call.url).pathname)).toEqual([PROFILE, LIST]);
			},
		);
	});
});
