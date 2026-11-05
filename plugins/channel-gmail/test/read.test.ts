import {
	createFake,
	createGmailFake,
	GMAIL_HOST,
	GMAIL_READONLY_SCOPE,
	manualClock,
} from "@draftyak/fakes";
import { createMockHub, type MockHub, type MockPlugin } from "@draftyak/plugin-testkit";
import { CHANNEL_V1, channelV1 } from "@draftyak/protocol/channel-v1";
import { extensionDeclaration, ProbeResult } from "@draftyak/protocol/extension";
import {
	HOST_REQUEST_TIMEOUT_MS,
	HostFetchParams,
	type HostFetchResult,
	HostNotification,
} from "@draftyak/protocol/host-channel";
import { MessageBody } from "@draftyak/protocol/normalized-change";
import {
	createPluginContext,
	HostError,
	type MemoryHost,
	memoryHost,
	type PluginContext,
	PluginError,
} from "@draftyak/sdk";
import { describe, expect, it, vi } from "vitest";
import { decodeGmailMetadata } from "../src/decode.ts";
import { GmailHistoryError } from "../src/history/page.ts";
import { readHistoryPage } from "../src/history/read.ts";
import { fetchGmailBody, probeGmail } from "../src/read.ts";

const ID = "DYTEST-message-1";
const DATE = 1_710_000_000_123;
const REF = "00000000000000000000000002";
const STREAM_ID = "00000000000000000000000003";
const MAX_METADATA = 4 * 1024 * 1024;
const PLUGIN = "@example/gmail-read-data";
const BASE = "https://gmail.googleapis.com/gmail/v1/users/me";
const profile = {
	emailAddress: "DYTEST-owner@draftyak.example",
	messagesTotal: 1,
	threadsTotal: 1,
	historyId: "1001",
};
const metadata = (id = ID) => ({
	id,
	threadId: "DYTEST-thread-1",
	labelIds: ["INBOX"],
	internalDate: String(DATE),
	historyId: "1001",
	sizeEstimate: 42,
});

function bytesReply(bytes: Uint8Array, status = 200): HostFetchResult {
	return {
		status,
		headers: [["content-type", "application/json"]],
		body: { base64: Buffer.from(bytes).toString("base64url") },
	};
}
function jsonReply(value: unknown, status = 200): HostFetchResult {
	return bytesReply(new TextEncoder().encode(JSON.stringify(value)), status);
}
const referenceReply = (): HostFetchResult => ({
	status: 200,
	headers: [["content-type", "application/json"]],
	body: { ref: REF },
});
interface Wire {
	readonly context: PluginContext;
	readonly host: MemoryHost;
	readonly requests: HostFetchParams[];
	abort(): void;
	close(): void;
}
/** Scripted SDK wire results only: this does not implement extraction, blob storage or admission. */
function wire(
	reply: (request: HostFetchParams) => HostFetchResult | Promise<HostFetchResult>,
): Wire {
	const controller = new AbortController();
	const requests: HostFetchParams[] = [];
	const host = memoryHost((method, params) => {
		if (method !== "host/fetch") throw new HostError("UNSUPPORTED");
		const request = HostFetchParams.parse(params);
		requests.push(request);
		return reply(request);
	});
	return {
		context: createPluginContext({ plugin: PLUGIN }, host, controller.signal),
		host,
		requests,
		abort: () => controller.abort(),
		close() {
			controller.abort();
			host.close();
		},
	};
}
function body(f: Wire, id = ID) {
	return fetchGmailBody(f.context, { kind: "email", providerId: id });
}
async function refuses(work: () => Promise<unknown>, expected: string): Promise<boolean> {
	try {
		await work();
		return false;
	} catch (error) {
		return (
			error instanceof PluginError &&
			error.message === expected &&
			error.result.code === expected &&
			Object.keys(error.result).length === 1 &&
			!Object.hasOwn(error, "cause")
		);
	}
}
function pad(value: unknown, length: number): Uint8Array {
	const json = JSON.stringify(value);
	if (json.length > length) throw new Error("DYTEST padding unavailable");
	return new TextEncoder().encode(json + " ".repeat(length - json.length));
}
function streaming(bytes: Uint8Array, isProfile: boolean, chunkSize = 65_536): Wire {
	const f = wire((request) => {
		if (request.saveAs) return referenceReply();
		if (isProfile && !request.url.endsWith("/profile")) throw new HostError("BAD_REQUEST");
		setImmediate(() => {
			let sequence = 0;
			for (let at = 0; at < bytes.length; at += chunkSize) {
				const chunk = bytes.subarray(at, at + chunkSize);
				f.host.notify(
					HostNotification.parse({
						jsonrpc: "2.0",
						method: "host/stream.chunk",
						params: {
							streamId: STREAM_ID,
							sequence: sequence++,
							base64: Buffer.from(chunk).toString("base64url"),
							done: at + chunk.length === bytes.length,
						},
					}),
				);
			}
		});
		return {
			status: 200,
			headers: [
				["content-type", "application/json"],
				["content-length", "1"],
			],
			streamId: STREAM_ID,
		};
	});
	return f;
}

describe("Gmail fixed read DATA through the real SDK wire", () => {
	it("requests metadata then host raw extraction and returns only a validated MessageBody", async () => {
		const f = wire((request) => (request.saveAs ? referenceReply() : jsonReply(metadata())));
		try {
			const result = await body(f);
			expect(result).toEqual({
				message: {
					kind: "email.message",
					providerId: ID,
					threadId: "DYTEST-thread-1",
					labelIds: ["INBOX"],
					internalDate: DATE,
					sizeBytes: 42,
					raw: { ref: REF },
				},
			});
			expect(MessageBody.safeParse(result.message).success).toBe(true);
			expect(
				Object.isFrozen(result.message) &&
					Object.isFrozen(result.message.labelIds) &&
					Object.isFrozen(result.message.raw),
			).toBe(true);
			expect(
				f.requests.map(({ method, url, saveAs, stream }) => ({ method, url, saveAs, stream })),
			).toEqual([
				{
					method: "GET",
					url: `${BASE}/messages/${ID}?format=metadata`,
					saveAs: undefined,
					stream: true,
				},
				{
					method: "GET",
					url: `${BASE}/messages/${ID}?format=raw`,
					saveAs: { kind: "base64url-json-member", member: "raw" },
					stream: undefined,
				},
			]);
		} finally {
			f.close();
		}
	});

	it.each(["a/b?x#%\\z", "x".repeat(256)])(
		"encodes one schema-valid provider path segment %s",
		async (id) => {
			const f = wire((request) => (request.saveAs ? referenceReply() : jsonReply(metadata(id))));
			try {
				expect((await body(f, id)).message.providerId === id).toBe(true);
				expect(f.requests.map((r) => new URL(r.url).pathname)).toEqual([
					`/gmail/v1/users/me/messages/${encodeURIComponent(id)}`,
					`/gmail/v1/users/me/messages/${encodeURIComponent(id)}`,
				]);
			} finally {
				f.close();
			}
		},
	);

	it.each([".", "..", "", "x".repeat(257), "has space", "line\n", "snow\u2603"])(
		"refuses invalid network ID %j before fetching",
		async (id) => {
			const f = wire(() => referenceReply());
			try {
				expect(await refuses(() => body(f, id), "INVALID_INPUT")).toBe(true);
				expect(f.requests.length).toBe(0);
			} finally {
				f.close();
			}
		},
	);

	it("refuses chat references and caller accessors without a request", async () => {
		const f = wire(() => referenceReply());
		let getters = 0;
		const hostile = {
			kind: "email" as const,
			get providerId() {
				getters++;
				return ID;
			},
		};
		try {
			expect(
				await refuses(
					() => fetchGmailBody(f.context, { kind: "chat", channelId: "c", ts: "1" }),
					"INVALID_INPUT",
				),
			).toBe(true);
			expect(await refuses(() => fetchGmailBody(f.context, hostile), "INVALID_INPUT")).toBe(true);
			expect(getters).toBe(0);
			expect(f.requests.length).toBe(0);
		} finally {
			f.close();
		}
	});

	it.each([
		["foreign id", { ...metadata(), id: "DYTEST-other" }],
		["missing date", { ...metadata(), internalDate: undefined }],
		["numeric date", { ...metadata(), internalDate: DATE }],
		["unsafe date", { ...metadata(), internalDate: "9007199254740992" }],
		["empty thread", { ...metadata(), threadId: "" }],
		["duplicate labels", { ...metadata(), labelIds: ["INBOX", "INBOX"] }],
		[
			"too many labels",
			{ ...metadata(), labelIds: Array.from({ length: 257 }, (_, i) => `L${i}`) },
		],
		["negative size", { ...metadata(), sizeEstimate: -1 }],
	] as const)("refuses %s metadata before asking for raw", async (_name, value) => {
		const f = wire(() => jsonReply(value));
		try {
			expect(await refuses(() => body(f), "TRANSIENT")).toBe(true);
			expect(f.requests.length).toBe(1);
		} finally {
			f.close();
		}
	});

	it.each([
		["duplicate JSON key", new TextEncoder().encode('{"id":"x","id":"y"}')],
		["invalid UTF8", new Uint8Array([255])],
	] as const)("refuses %s metadata", async (_name, bytes) => {
		const f = wire(() => bytesReply(bytes));
		try {
			expect(await refuses(() => body(f), "TRANSIENT")).toBe(true);
			expect(f.requests.length).toBe(1);
		} finally {
			f.close();
		}
	});

	it.each(["profile", "metadata", "raw"] as const)(
		"refuses a valid SDK 206 %s result as incomplete DATA",
		async (part) => {
			const f = wire((request) => {
				if (request.saveAs) return { ...referenceReply(), status: part === "raw" ? 206 : 200 };
				return jsonReply(part === "profile" ? profile : metadata(), part === "raw" ? 200 : 206);
			});
			try {
				expect(
					await refuses(() => (part === "profile" ? probeGmail(f.context) : body(f)), "TRANSIENT"),
				).toBe(true);
				expect(f.requests.length).toBe(part === "raw" ? 2 : 1);
			} finally {
				f.close();
			}
		},
	);

	it.each([
		["inline envelope", jsonReply({ id: ID, raw: "RFZURVNULXJhdy1kYXRh" })],
		["invalid reference", { status: 200, headers: [], body: { ref: "not-a-ulid" } }],
	] as const)("refuses successful raw %s without an inline fallback", async (_name, raw) => {
		const f = wire((request) => (request.saveAs ? raw : jsonReply(metadata())));
		try {
			expect(await refuses(() => body(f), "TRANSIENT")).toBe(true);
			expect(f.requests.length).toBe(2);
		} finally {
			f.close();
		}
	});

	it.each([
		[401, undefined, "AUTH_EXPIRED"],
		[403, "forbidden", "PERMISSION_DENIED"],
		[403, "rateLimitExceeded", "RATE_LIMITED"],
		[403, "userRateLimitExceeded", "RATE_LIMITED"],
		[404, undefined, "NOT_FOUND"],
		[429, undefined, "RATE_LIMITED"],
		[503, undefined, "TRANSIENT"],
	] as const)("maps HTTP %s/%s without vendor text", async (status, reason, code) => {
		const f = wire(() =>
			jsonReply({ error: { message: "DYTEST-vendor-private-text", errors: [{ reason }] } }, status),
		);
		try {
			expect(await refuses(() => body(f), code)).toBe(true);
		} finally {
			f.close();
		}
	});

	it.each([
		["UNSUPPORTED", "UNSUPPORTED"],
		["DENIED", "PERMISSION_DENIED"],
		["TOO_LARGE", "QUOTA_EXCEEDED"],
		["TIMEOUT", "TRANSIENT"],
	] as const)("maps host %s to %s", async (hostCode, code) => {
		const f = wire(() => {
			throw new HostError(hostCode);
		});
		try {
			expect(await refuses(() => body(f), code)).toBe(true);
		} finally {
			f.close();
		}
	});

	it("does not copy arbitrary thrown error text or plugin details", async () => {
		const f = wire(() => {
			throw new PluginError("RATE_LIMITED", { detail: "DYTEST-do-not-return" });
		});
		try {
			expect(await refuses(() => body(f), "RATE_LIMITED")).toBe(true);
		} finally {
			f.close();
		}
	});

	it.each([65_536, 65_537])("counts actual profile stream bytes at %s", async (length) => {
		const f = streaming(pad(profile, length), true);
		try {
			if (length === 65_536) expect(await probeGmail(f.context)).toEqual({ status: "ok" });
			else expect(await refuses(() => probeGmail(f.context), "QUOTA_EXCEEDED")).toBe(true);
		} finally {
			f.close();
		}
	});

	it.each([
		["missing address", { ...profile, emailAddress: undefined }],
		["address controls", { ...profile, emailAddress: "DYTEST-owner\r\n@draftyak.example" }],
		["negative count", { ...profile, messagesTotal: -1 }],
		["unsafe count", { ...profile, threadsTotal: Number.MAX_SAFE_INTEGER + 1 }],
		["noncanonical history", { ...profile, historyId: "01" }],
	] as const)("refuses %s profile data without exposing it", async (_name, value) => {
		const f = wire(() => jsonReply(value));
		try {
			expect(await refuses(() => probeGmail(f.context), "TRANSIENT")).toBe(true);
			expect(f.requests.length).toBe(1);
		} finally {
			f.close();
		}
	});

	it.each([MAX_METADATA, MAX_METADATA + 1])(
		"counts actual metadata stream bytes at %s",
		async (length) => {
			const f = streaming(pad(metadata(), length), false);
			try {
				if (length === MAX_METADATA) expect((await body(f)).message.raw).toEqual({ ref: REF });
				else {
					expect(await refuses(() => body(f), "QUOTA_EXCEEDED")).toBe(true);
					expect(f.requests.length).toBe(1);
				}
			} finally {
				f.close();
			}
		},
	);

	it.each([8_192, 8_193])(
		"bounds SDK one-byte profile chunks independently at %s",
		async (length) => {
			const f = streaming(pad(profile, length), true, 1);
			try {
				if (length === 8_192) expect(await probeGmail(f.context)).toEqual({ status: "ok" });
				else expect(await refuses(() => probeGmail(f.context), "QUOTA_EXCEEDED")).toBe(true);
			} finally {
				f.close();
			}
		},
	);

	it.each([8_192, 8_193])(
		"shares the bounded SDK chunk progress with history reads at %s",
		async (length) => {
			const f = streaming(pad({ historyId: "1000" }, length), false, 1);
			try {
				const call = () => readHistoryPage(f.context, { startHistoryId: "1000" });
				if (length === 8_192) expect((await call()).changes.length).toBe(0);
				else expect(await refuses(call, "QUOTA_EXCEEDED")).toBe(true);
			} finally {
				f.close();
			}
		},
	);

	it("refuses an already aborted call without acquiring fetch", async () => {
		const f = wire(() => jsonReply(profile));
		f.abort();
		try {
			expect(await refuses(() => probeGmail(f.context), "TRANSIENT")).toBe(true);
			expect(f.requests.length).toBe(0);
		} finally {
			f.close();
		}
	});

	it("aborts a pending raw request and handles its late rejection", async () => {
		const entered = Promise.withResolvers<void>(),
			delayed = Promise.withResolvers<HostFetchResult>();
		const f = wire((request) => {
			if (request.saveAs) {
				entered.resolve();
				return delayed.promise;
			}
			return jsonReply(metadata());
		});
		try {
			const result = refuses(() => body(f), "TRANSIENT");
			await entered.promise;
			f.abort();
			expect(await result).toBe(true);
			expect(f.requests.length).toBe(2);
			delayed.reject(new Error("DYTEST-late-wire-failure"));
			await new Promise<void>((resolve) => setImmediate(resolve));
		} finally {
			delayed.resolve(referenceReply());
			f.close();
		}
	});

	it("aborts a pending SDK response stream", async () => {
		const entered = Promise.withResolvers<void>();
		const f = wire(() => {
			entered.resolve();
			return { status: 200, headers: [], streamId: "DYTEST-pending" };
		});
		try {
			const result = refuses(() => probeGmail(f.context), "TRANSIENT");
			await entered.promise;
			await new Promise<void>((resolve) => setImmediate(resolve));
			f.abort();
			expect(await result).toBe(true);
		} finally {
			f.close();
		}
	});

	it("uses the real thirty-second bound without waiting on the wire", async () => {
		vi.useFakeTimers();
		const delayed = Promise.withResolvers<HostFetchResult>();
		const f = wire(() => delayed.promise);
		try {
			const result = refuses(() => probeGmail(f.context), "TRANSIENT");
			await vi.advanceTimersByTimeAsync(HOST_REQUEST_TIMEOUT_MS);
			expect(await result).toBe(true);
		} finally {
			delayed.resolve(jsonReply(profile));
			f.close();
			vi.useRealTimers();
		}
	});
});

function fakeFixture(): {
	context: PluginContext;
	hub: MockHub;
	requests(): number;
	close(): Promise<void>;
} {
	const backend = createGmailFake({
		clock: manualClock(DATE),
		accessGrant: () => ({ scopes: [GMAIL_READONLY_SCOPE], expiresAt: DATE + 60_000 }),
	});
	backend.addMessage({
		id: ID,
		threadId: "DYTEST-thread-1",
		raw: new TextEncoder().encode("Subject: DYTEST read data\r\n\r\nSynthetic.\r\n"),
		internalDate: DATE,
		labelIds: ["INBOX"],
	});
	const upstream = createFake(
		{
			fetch(request) {
				const headers = new Headers(request.headers);
				headers.set("authorization", "Bearer synthetic-read-fixture");
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
						pathTemplate: "/gmail/v1/users/me/profile",
						query: [],
						maxBytes: MAX_METADATA + 1024,
						timeoutMs: 30_000,
					},
					{
						class: "read",
						method: "GET",
						host: GMAIL_HOST,
						pathTemplate: "/gmail/v1/users/me/messages/{id}",
						query: ["format"],
						maxBytes: MAX_METADATA + 1024,
						timeoutMs: 30_000,
					},
				],
			},
		},
		entry: {
			name: "gmail-read-data",
			version: "1.0.0",
			plugin: PLUGIN,
			account: "00000000000000000000000001",
			extensions: { [CHANNEL_V1]: extensionDeclaration(channelV1) },
			tools: [{ name: "gmail_probe_data", handler: (_args, context) => probeGmail(context) }],
		},
	};
	const hub = createMockHub({
		mode: "in-memory",
		plugin,
		upstreams: [upstream],
		account: { id: "00000000000000000000000001", mode: "read_only" },
	});
	const controller = new AbortController();
	return {
		context: createPluginContext({ plugin: PLUGIN }, hub.host, controller.signal),
		hub,
		requests: () => upstream.recorder.takeRequests().length,
		async close() {
			controller.abort();
			await hub.close();
		},
	};
}

describe("Gmail read DATA with the actual current testkit and FakeGmail", () => {
	it("probes the fixed profile without returning address, detail or logs", async () => {
		const f = fakeFixture();
		try {
			const result = await probeGmail(f.context);
			expect(result).toEqual({ status: "ok" });
			expect(ProbeResult.safeParse(result).success).toBe(true);
			expect(Object.keys(result)).toEqual(["status"]);
			expect(f.hub.host.logs.length).toBe(0);
		} finally {
			await f.close();
		}
	});
	it("honestly refuses object saveAs on the current unsupported host", async () => {
		const f = fakeFixture();
		try {
			expect(
				await refuses(
					() => fetchGmailBody(f.context, { kind: "email", providerId: ID }),
					"UNSUPPORTED",
				),
			).toBe(true);
			expect(f.requests()).toBe(1);
			expect(f.hub.host.denials.some((row) => row.reason === "STORAGE_MODE_UNSUPPORTED")).toBe(
				true,
			);
		} finally {
			await f.close();
		}
	});
});

describe("shared detached Gmail metadata DATA", () => {
	it("snapshots labels and preserves canonical uint64 without numeric rounding", () => {
		const input = { ...metadata(), labelIds: ["INBOX"], historyId: "18446744073709551615" };
		const value = decodeGmailMetadata(input);
		input.labelIds[0] = "TRASH";
		expect(value.labelIds).toEqual(["INBOX"]);
		expect(value.historyId).toBe("18446744073709551615");
	});
	it("refuses accessors and proxies without invoking their behavior", () => {
		let calls = 0;
		const accessor = {
			...metadata(),
			get payload() {
				calls++;
				return {};
			},
		};
		const proxy = new Proxy(metadata(), {
			ownKeys() {
				calls++;
				throw new Error("DYTEST-proxy");
			},
		});
		for (const input of [accessor, proxy]) {
			let invalid = false;
			try {
				decodeGmailMetadata(input);
			} catch (error) {
				invalid = error instanceof GmailHistoryError && error.code === "GMAIL_HISTORY_INVALID";
			}
			expect(invalid).toBe(true);
		}
		expect(calls).toBe(0);
	});
});
