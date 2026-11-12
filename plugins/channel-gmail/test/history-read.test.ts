import {
	createFake,
	createGmailFake,
	GMAIL_HOST,
	GMAIL_READONLY_SCOPE,
	type GmailFake,
	manualClock,
} from "@draftyak/fakes";
import { createMockHub, type MockHub, type MockPlugin } from "@draftyak/plugin-testkit";
import { CHANNEL_V1, channelV1 } from "@draftyak/protocol/channel-v1";
import { extensionDeclaration } from "@draftyak/protocol/extension";
import { createPluginContext, type PluginContext, PluginError } from "@draftyak/sdk";
import { describe, expect, it } from "vitest";
import type { HistoryOptions } from "../src/history/page.ts";
import { readHistoryPage } from "../src/history/read.ts";
import type { HistoryReduction } from "../src/history/reduce.ts";

const MAX_BYTES = 4 * 1024 * 1024;
const DATE = 1_710_000_000_123;
const ACCOUNT = "00000000000000000000000001";
const RAW = new TextEncoder().encode("Subject: DYTEST history\r\n\r\nSynthetic body.\r\n");
const PLUGIN = "@example/gmail-history-read";
const HISTORY = "/gmail/v1/users/me/history";
const MESSAGES = "/gmail/v1/users/me/messages/";

function json(value: unknown, status = 200): Response {
	return new Response(JSON.stringify(value), {
		status,
		headers: { "content-type": "application/json" },
	});
}
function addedPage(count = 1) {
	return {
		historyId: String(1000 + count),
		history: Array.from({ length: count }, (_, index) => {
			const suffix = count === 500 ? String(index).padStart(32, "0") : String(index);
			const message = { id: `m${suffix}`, threadId: `t${suffix}` };
			return { id: String(1001 + index), messages: [message], messagesAdded: [{ message }] };
		}),
	};
}
function metadata(id = "m0") {
	return { id, threadId: `t${id.slice(1)}`, internalDate: String(DATE), labelIds: ["INBOX"] };
}
function padded(value: unknown, bytes: number, status = 200): Response {
	const text = JSON.stringify(value);
	if (text.length > bytes) throw new Error("Synthetic padding fixture unavailable");
	return new Response(text + " ".repeat(bytes - text.length), {
		status,
		headers: { "content-type": "application/json", "content-length": "1" },
	});
}
interface FixtureOptions {
	readonly prepare?: (backend: GmailFake) => void;
	readonly options?: HistoryOptions;
	readonly reply?: (request: Request) => Response | Promise<Response> | undefined;
}
interface Fixture {
	readonly hub: MockHub;
	readonly context: PluginContext;
	readonly backend: GmailFake;
	readonly start: string;
	readonly options: HistoryOptions;
	abort(): void;
	count(): number;
	requests(): readonly { method: string; path: string; query: string }[];
	call(): Promise<HistoryReduction>;
	close(): Promise<void>;
}

function fixture(settings: FixtureOptions = {}): Fixture {
	const clock = manualClock(DATE);
	const backend = createGmailFake({
		clock,
		accessGrant: () => ({ scopes: [GMAIL_READONLY_SCOPE], expiresAt: DATE + 60_000 }),
	});
	const start = backend.historyId;
	settings.prepare?.(backend);
	const options = settings.options ?? { startHistoryId: start };
	let count = 0;
	const upstream = createFake(
		{
			async fetch(request) {
				count++;
				const scripted = settings.reply?.(request);
				if (scripted !== undefined) return scripted;
				// Synthetic fixture authentication only; the component never supplies a credential.
				const headers = new Headers(request.headers);
				headers.set("authorization", "Bearer synthetic-history-fixture");
				return backend.fetch(new Request(request, { headers }));
			},
		},
		{ host: GMAIL_HOST },
	);
	const plugin: MockPlugin = {
		manifest: {
			id: PLUGIN,
			version: "1.0.0",
			kind: "channel",
			sdk: "1.0.0",
			runtime: "node",
			isolation: "standard",
			contract: { extension: CHANNEL_V1, version: 1 },
			auth: { kind: "none", scopes: [], requiredGrantedScopes: [] },
			credentials: { mode: "brokered", urlSecrets: [] },
			permissions: {},
			dataClasses: ["example.content"],
			license: "Apache-2.0",
			egress: {
				rules: [
					{
						class: "read",
						method: "GET",
						host: GMAIL_HOST,
						pathTemplate: HISTORY,
						query: ["startHistoryId", "maxResults", "pageToken"],
						maxBytes: MAX_BYTES + 1024,
						timeoutMs: 30_000,
					},
					{
						class: "read",
						method: "GET",
						host: GMAIL_HOST,
						pathTemplate: `${MESSAGES}{id}`,
						query: ["format"],
						maxBytes: MAX_BYTES + 1024,
						timeoutMs: 30_000,
					},
				],
			},
		},
		entry: {
			name: "gmail-history-read",
			version: "1.0.0",
			plugin: PLUGIN,
			account: ACCOUNT,
			extensions: { [CHANNEL_V1]: extensionDeclaration(channelV1) },
			tools: [
				{
					name: "gmail_history_read",
					timeoutMs: 120_000,
					handler: (_args, context) => readHistoryPage(context, options),
				},
			],
		},
	};
	const hub = createMockHub({
		mode: "in-memory",
		plugin,
		upstreams: [upstream],
		account: { id: ACCOUNT, mode: "read_only" },
	});
	const controller = new AbortController();
	const context = createPluginContext(
		{ plugin: PLUGIN, account: ACCOUNT },
		hub.host,
		controller.signal,
	);
	return {
		hub,
		context,
		backend,
		start,
		options,
		abort: () => controller.abort(),
		count: () => count,
		requests: () =>
			upstream.recorder.takeRequests().map(({ method, path, query }) => ({ method, path, query })),
		async call() {
			const result = await hub.call("gmail_history_read", {});
			if (
				result.isError === true ||
				!result.structuredContent ||
				typeof result.structuredContent !== "object"
			)
				throw new Error("Synthetic history invocation refused");
			return result.structuredContent as unknown as HistoryReduction;
		},
		async close() {
			controller.abort();
			await hub.close();
		},
	};
}

async function refused(operation: () => Promise<unknown>, code: string): Promise<boolean> {
	return operation().then(
		() => false,
		(error: unknown) =>
			error instanceof PluginError &&
			error.message === code &&
			error.result.code === code &&
			!Object.hasOwn(error, "cause") &&
			!Object.hasOwn(error.result, "detail"),
	);
}
async function direct(f: Fixture): Promise<HistoryReduction> {
	return readHistoryPage(f.context, f.options);
}
function seeded(backend: GmailFake, id = "m1", labels = ["INBOX"]): void {
	backend.addMessage({
		id,
		threadId: `t${id.slice(1)}`,
		raw: RAW,
		internalDate: DATE,
		labelIds: labels,
	});
}

describe("Gmail history transport", () => {
	it("uses the actual served SDK context and genuine Gmail state for add plus labels", async () => {
		const f = fixture({
			prepare: (backend) => {
				seeded(backend);
				backend.setLabels("m1", ["INBOX", "UNREAD"]);
			},
		});
		try {
			const result = await f.call();
			expect(result.changes.length).toBe(1);
			expect(result.changes[0]).toMatchObject({
				kind: "email.message",
				providerId: "m1",
				threadId: "t1",
				internalDate: DATE,
				labelIds: ["INBOX", "UNREAD"],
			});
			expect(
				result.historyId === f.backend.historyId && !result.more && result.nextPageToken === null,
			).toBe(true);
			const requests = f.requests();
			expect(requests.length).toBe(2);
			expect(requests.every((request) => request.method === "GET")).toBe(true);
			expect(new URLSearchParams(requests[0]?.query).get("maxResults")).toBe("500");
			expect(requests[1]?.path).toBe(`${MESSAGES}m1`);
			expect(new URLSearchParams(requests[1]?.query).get("format")).toBe("metadata");
		} finally {
			await f.close();
		}
	});

	it("keeps labels-only metadata complete and does not fabricate an upsert", async () => {
		const f = fixture({ prepare: (backend) => seeded(backend) });
		try {
			const start = f.backend.historyId;
			f.backend.setLabels("m1", ["STARRED"]);
			const result = await readHistoryPage(f.context, { startHistoryId: start });
			expect(result.changes).toEqual([
				{ kind: "email.labels", providerId: "m1", threadId: "t1", labelIds: ["STARRED"] },
			]);
			expect(f.count()).toBe(2);
		} finally {
			await f.close();
		}
	});

	it("does not hydrate a final explicit delete", async () => {
		const f = fixture({
			prepare: (backend) => {
				seeded(backend);
				backend.deleteMessage("m1");
			},
		});
		try {
			const result = await f.call();
			expect(result.changes).toEqual([{ kind: "email.deleted", providerId: "m1" }]);
			expect(f.count()).toBe(1);
		} finally {
			await f.close();
		}
	});

	it("hydrates a later explicit re-add without treating the intermediate delete as final", async () => {
		const f = fixture({
			prepare: (backend) => {
				seeded(backend);
				backend.deleteMessage("m1");
				seeded(backend, "m1", ["STARRED"]);
			},
		});
		try {
			const result = await f.call();
			expect(result.changes.length).toBe(1);
			expect(result.changes[0]).toMatchObject({
				kind: "email.message",
				providerId: "m1",
				labelIds: ["STARRED"],
			});
			expect(f.count()).toBe(2);
		} finally {
			await f.close();
		}
	});

	it("keeps an opaque continued-page token truthful without auto-draining", async () => {
		const f = fixture({
			options: {
				startHistoryId: "18446744073709551614",
				pageToken: "old/+token",
				seenPageTokens: ["old/+token"],
			},
			reply: () => json({ historyId: "18446744073709551615", nextPageToken: "next/+token" }),
		});
		try {
			const result = await f.call();
			expect(result.changes.length).toBe(0);
			expect(
				result.more &&
					result.nextPageToken === "next/+token" &&
					result.historyId === "18446744073709551615",
			).toBe(true);
			expect(f.count()).toBe(1);
			const query = new URLSearchParams(f.requests()[0]?.query);
			expect(query.get("startHistoryId")).toBe("18446744073709551614");
			expect(query.get("pageToken")).toBe("old/+token");
		} finally {
			await f.close();
		}
	});

	it("streams a large page and hydrates500 logical ids with501 sequential GETs", async () => {
		const wire = addedPage(500);
		expect(new TextEncoder().encode(JSON.stringify(wire)).byteLength > 65_536).toBe(true);
		const f = fixture({
			reply: (request) => {
				const url = new URL(request.url);
				return url.pathname === HISTORY
					? json(wire)
					: json(metadata(decodeURIComponent(url.pathname.slice(MESSAGES.length))));
			},
		});
		try {
			const result = await f.call();
			expect(result.changes.length).toBe(500);
			expect(f.count()).toBe(501);
			expect(result.changes.every((change) => change.kind === "email.message")).toBe(true);
		} finally {
			await f.close();
		}
	});

	it("refuses501 logical ids before issuing any hydration GET", async () => {
		const f = fixture({ reply: () => json(addedPage(501)) });
		try {
			expect(await refused(() => direct(f), "TRANSIENT")).toBe(true);
			expect(f.count()).toBe(1);
		} finally {
			await f.close();
		}
	});

	it.each([MAX_BYTES, MAX_BYTES + 1])(
		"charges aggregate response bytes across history and metadata at %i bytes",
		async (total) => {
			const message = metadata();
			const metadataBytes = new TextEncoder().encode(JSON.stringify(message)).byteLength;
			const f = fixture({
				reply: (request) =>
					new URL(request.url).pathname === HISTORY
						? padded(addedPage(), total - metadataBytes)
						: json(message),
			});
			try {
				if (total === MAX_BYTES) expect((await direct(f)).changes.length).toBe(1);
				else expect(await refused(() => direct(f), "QUOTA_EXCEEDED")).toBe(true);
				expect(f.count()).toBe(2);
			} finally {
				await f.close();
			}
		},
	);

	it.each([
		["history", 404, "CURSOR_EXPIRED"],
		["history", 410, "TRANSIENT"],
		["metadata", 404, "TRANSIENT"],
		["metadata", 410, "TRANSIENT"],
		["history", 401, "AUTH_EXPIRED"],
		["history", 403, "PERMISSION_DENIED"],
		["history", 429, "RATE_LIMITED"],
		["metadata", 401, "AUTH_EXPIRED"],
		["metadata", 403, "PERMISSION_DENIED"],
		["metadata", 429, "RATE_LIMITED"],
		["history", 503, "TRANSIENT"],
	] as const)(
		"maps %s status%i to fixed%s without retry or partial deletion",
		async (where, status, code) => {
			const f = fixture({
				reply: (request) => {
					const history = new URL(request.url).pathname === HISTORY;
					return (where === "history") === history
						? new Response("synthetic upstream detail", { status })
						: json(addedPage());
				},
			});
			try {
				expect(await refused(() => direct(f), code)).toBe(true);
				expect(f.count()).toBe(where === "history" ? 1 : 2);
			} finally {
				await f.close();
			}
		},
	);

	it.each([
		["history", "rateLimitExceeded"],
		["history", "userRateLimitExceeded"],
		["hydration", "rateLimitExceeded"],
		["hydration", "userRateLimitExceeded"],
	] as const)(
		"maps %s HTTP 403 reason %s without retry or a partial page",
		async (where, reason) => {
			const f = fixture({
				reply: (request) => {
					const pathname = new URL(request.url).pathname;
					if (
						(where === "history" && pathname === HISTORY) ||
						(where === "hydration" && pathname === `${MESSAGES}m1`)
					)
						return json(
							{ error: { message: "DYTEST-provider-private-text", errors: [{ reason }] } },
							403,
						);
					return pathname === HISTORY
						? json(addedPage(3))
						: json(metadata(pathname.slice(MESSAGES.length)));
				},
			});
			try {
				expect(await refused(() => direct(f), "RATE_LIMITED")).toBe(true);
				expect(f.requests().map((request) => request.path)).toEqual(
					where === "history" ? [HISTORY] : [HISTORY, `${MESSAGES}m0`, `${MESSAGES}m1`],
				);
				expect(f.count()).toBe(where === "history" ? 1 : 3);
			} finally {
				await f.close();
			}
		},
	);

	it.each([
		["unknown reason", '{"error":{"errors":[{"reason":"forbidden"}]}}'],
		["message only", '{"error":{"message":"rateLimitExceeded"}}'],
		["non-array errors", '{"error":{"errors":{"reason":"rateLimitExceeded"}}}'],
		["non-string reason", '{"error":{"errors":[{"reason":["rateLimitExceeded"]}]}}'],
		["malformed JSON", "{"],
		[
			"duplicate reason",
			'{"error":{"errors":[{"reason":"rateLimitExceeded","reason":"userRateLimitExceeded"}]}}',
		],
	] as const)("keeps %s HTTP 403 bodies a fixed permission refusal", async (_name, body) => {
		const f = fixture({ reply: () => new Response(body, { status: 403 }) });
		try {
			expect(await refused(() => direct(f), "PERMISSION_DENIED")).toBe(true);
			expect(f.count()).toBe(1);
		} finally {
			await f.close();
		}
	});

	it.each([MAX_BYTES, MAX_BYTES + 1])(
		"charges HTTP 403 reason bytes to the shared aggregate budget at %i bytes",
		async (total) => {
			const error = { error: { errors: [{ reason: "rateLimitExceeded" }] } },
				errorBytes = new TextEncoder().encode(JSON.stringify(error)).byteLength;
			const f = fixture({
				reply: (request) =>
					new URL(request.url).pathname === HISTORY
						? padded(addedPage(), total - errorBytes)
						: json(error, 403),
			});
			try {
				expect(
					await refused(() => direct(f), total === MAX_BYTES ? "RATE_LIMITED" : "QUOTA_EXCEEDED"),
				).toBe(true);
				expect(f.count()).toBe(2);
			} finally {
				await f.close();
			}
		},
	);

	it.each([8_192, 8_193])("bounds one-byte HTTP 403 reason chunks at %i", async (length) => {
		const text = JSON.stringify({ error: { errors: [{ reason: "rateLimitExceeded" }] } }),
			bytes = new TextEncoder().encode(text + " ".repeat(length - text.length));
		let offset = 0;
		const f = fixture({
			reply: () =>
				new Response(
					new ReadableStream<Uint8Array>(
						{
							pull(controller) {
								if (offset === bytes.length) controller.close();
								else controller.enqueue(bytes.subarray(offset, ++offset));
							},
						},
						{ highWaterMark: 0 },
					),
					{ status: 403 },
				),
		});
		try {
			expect(
				await refused(() => direct(f), length === 8_192 ? "RATE_LIMITED" : "QUOTA_EXCEEDED"),
			).toBe(true);
			expect(offset).toBe(length);
			expect(f.count()).toBe(1);
		} finally {
			await f.close();
		}
	});

	it("aborts an adopted HTTP 403 body read before interpreting a reason or hydrating", async () => {
		const started = Promise.withResolvers<void>(),
			cancelled = Promise.withResolvers<void>();
		const f = fixture({
			reply: () =>
				new Response(
					new ReadableStream<Uint8Array>(
						{
							pull() {
								started.resolve();
								return new Promise<void>(() => {});
							},
							cancel() {
								cancelled.resolve();
							},
						},
						{ highWaterMark: 0 },
					),
					{ status: 403 },
				),
		});
		let pending: Promise<boolean> | undefined;
		try {
			pending = refused(() => direct(f), "TRANSIENT");
			await Promise.race([
				started.promise,
				pending.then(() => {
					throw new Error("403 reader settled before adopting its body");
				}),
			]);
			f.abort();
			expect(await pending).toBe(true);
			await cancelled.promise;
			expect(f.count()).toBe(1);
		} finally {
			f.abort();
			try {
				if (pending) await pending;
			} finally {
				await f.close();
			}
		}
	});

	it.each(["history", "hydration"] as const)(
		"refuses valid JSON206 in the %s response as partial DATA",
		async (where) => {
			const f = fixture({
				reply: (request) => {
					const history = new URL(request.url).pathname === HISTORY;
					const value = history
						? where === "history"
							? { historyId: "1001" }
							: addedPage()
						: metadata();
					return new Response(JSON.stringify(value), {
						status: (where === "history") === history ? 206 : 200,
						headers: { "content-type": "application/json" },
					});
				},
			});
			try {
				expect(await refused(() => direct(f), "TRANSIENT")).toBe(true);
				expect(f.count()).toBe(where === "history" ? 1 : 2);
				expect(f.hub.host.denials.length).toBe(0);
			} finally {
				await f.close();
			}
		},
	);

	it.each([
		{ id: "other", threadId: "t0", internalDate: String(DATE), labelIds: ["INBOX"] },
		{ ...metadata(), threadId: "other" },
		{ id: "m0", threadId: "t0", labelIds: ["INBOX"] },
		{ id: "m0", threadId: "t0", internalDate: String(DATE) },
		{ ...metadata(), internalDate: "-1" },
	])("refuses mismatched or incomplete hydration metadata %#", async (message) => {
		const f = fixture({
			reply: (request) => json(new URL(request.url).pathname === HISTORY ? addedPage() : message),
		});
		try {
			expect(await refused(() => direct(f), "TRANSIENT")).toBe(true);
			expect(f.count()).toBe(2);
		} finally {
			await f.close();
		}
	});

	it.each(['{"historyId":"1000","historyId":"1001"}', "{", "[]"])(
		"refuses malformed or ambiguous history JSON %#",
		async (body) => {
			const f = fixture({ reply: () => new Response(body) });
			try {
				expect(await refused(() => direct(f), "TRANSIENT")).toBe(true);
				expect(f.count()).toBe(1);
			} finally {
				await f.close();
			}
		},
	);

	it("refuses invalid UTF8 without exposing the response bytes", async () => {
		const f = fixture({ reply: () => new Response(new Uint8Array([0xff, 0xfe, 0x7b])) });
		try {
			expect(await refused(() => direct(f), "TRANSIENT")).toBe(true);
		} finally {
			await f.close();
		}
	});

	it("validates detached options before any request and never invokes caller hooks", async () => {
		const f = fixture();
		let reads = 0;
		const accessor = Object.defineProperty({}, "startHistoryId", {
			enumerable: true,
			get() {
				reads++;
				return "1000";
			},
		});
		const proxy = new Proxy(
			{},
			{
				get() {
					reads++;
					return undefined;
				},
				ownKeys() {
					reads++;
					return [];
				},
			},
		);
		const cycle: Record<string, unknown> = { startHistoryId: "1000" };
		cycle.seenPageTokens = cycle;
		try {
			for (const options of [
				undefined,
				{ startHistoryId: "01" },
				{ startHistoryId: "18446744073709551616" },
				{ startHistoryId: "1000", pageToken: "bad token" },
				{ startHistoryId: "1000", seenPageTokens: Array(129).fill("token") },
				accessor,
				proxy,
				cycle,
			]) {
				expect(
					await refused(
						() => readHistoryPage(f.context, options as HistoryOptions),
						"INVALID_INPUT",
					),
				).toBe(true);
			}
			expect(reads).toBe(0);
			expect(f.count()).toBe(0);
		} finally {
			await f.close();
		}
	});

	it("does not fetch when the genuine SDK context is already aborted", async () => {
		const f = fixture();
		try {
			f.abort();
			expect(await refused(() => direct(f), "TRANSIENT")).toBe(true);
			expect(f.count()).toBe(0);
		} finally {
			await f.close();
		}
	});

	it("cancels an adopted Fake history transport without starting hydration", async () => {
		let entered: () => void = () => {};
		const started = new Promise<void>((resolve) => {
			entered = resolve;
		});
		let cancelled = 0;
		const f = fixture({
			reply: () =>
				new Response(
					new ReadableStream<Uint8Array>(
						{
							pull() {
								entered();
								return new Promise<void>(() => {});
							},
							cancel() {
								cancelled++;
							},
						},
						{ highWaterMark: 0 },
					),
				),
		});
		try {
			const pending = refused(() => direct(f), "TRANSIENT");
			await started;
			f.abort();
			expect(await pending).toBe(true);
			await new Promise<void>((resolve) => setImmediate(resolve));
			expect(cancelled > 0).toBe(true);
			expect(f.count()).toBe(1);
		} finally {
			await f.close();
		}
	});

	it("stops a pending second hydration when its actual context is aborted", async () => {
		let entered: () => void = () => {};
		const started = new Promise<void>((resolve) => {
			entered = resolve;
		});
		const f = fixture({
			reply: (request) => {
				const path = new URL(request.url).pathname;
				if (path === HISTORY) return json(addedPage(3));
				if (path.endsWith("m0")) return json(metadata());
				return new Response(
					new ReadableStream<Uint8Array>({
						pull() {
							entered();
							return new Promise<void>(() => {});
						},
					}),
				);
			},
		});
		try {
			const pending = refused(() => direct(f), "TRANSIENT");
			await started;
			f.abort();
			expect(await pending).toBe(true);
			expect(f.count()).toBe(3);
		} finally {
			await f.close();
		}
	});

	it("starts a fresh aggregate budget for a later real invocation after refusal", async () => {
		let large = true;
		const f = fixture({
			reply: () =>
				large ? padded({ historyId: "1000" }, MAX_BYTES + 1) : json({ historyId: "1000" }),
		});
		try {
			expect(await refused(() => direct(f), "QUOTA_EXCEEDED")).toBe(true);
			large = false;
			expect((await f.call()).changes.length).toBe(0);
			expect(f.count()).toBe(2);
		} finally {
			await f.close();
		}
	});
});

describe("history metadata fixed-endpoint boundary", () => {
	it.each([".", ".."])("refuses provider dot segment %s before a metadata request", async (id) => {
		let start = "";
		const f = fixture({
			reply(request) {
				if (new URL(request.url).pathname !== HISTORY) return undefined;
				const next = String(BigInt(start) + 1n);
				return json({
					historyId: next,
					history: [{ id: next, messagesAdded: [{ message: { id, threadId: "t0" } }] }],
				});
			},
		});
		start = f.start;
		try {
			expect(await refused(() => direct(f), "TRANSIENT")).toBe(true);
			expect(f.count()).toBe(1);
			expect(f.hub.host.denials.length).toBe(0);
		} finally {
			await f.close();
		}
	});

	it("validates every hydration path before the first metadata request", async () => {
		let start = "";
		const f = fixture({
			reply(request) {
				if (new URL(request.url).pathname !== HISTORY) return undefined;
				const next = String(BigInt(start) + 1n);
				return json({
					historyId: next,
					history: [
						{
							id: next,
							messagesAdded: [
								{ message: { id: "m0", threadId: "t0" } },
								{ message: { id: "..", threadId: "t1" } },
							],
						},
					],
				});
			},
		});
		start = f.start;
		try {
			expect(await refused(() => direct(f), "TRANSIENT")).toBe(true);
			expect(f.count()).toBe(1);
			expect(f.hub.host.denials.length).toBe(0);
		} finally {
			await f.close();
		}
	});
});
