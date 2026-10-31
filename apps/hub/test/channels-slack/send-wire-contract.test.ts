import { createHash } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	classifySlackSend,
	MAX_REQUEST_BYTES,
	renderSlackRequest,
} from "../../src/channels/slack/index.ts";
import {
	createSlackWireFake,
	MAX_STORED_BYTES,
	MAX_WIRE_BYTES,
	MAX_WIRE_CHUNKS,
	MAX_WIRE_MESSAGES,
	MAX_WIRE_REQUESTS,
	type SendStep,
	SLACK_URL,
	type SlackWireFake,
} from "./helpers/slack-wire-fake.ts";

const CHANNEL = "C0DYTEST1",
	OTHER = "D0DYTEST2";
const now = 1_760_000_000_000;
const base = {
	channelId: CHANNEL,
	text: "Synthetic reply",
	footer: "",
	authors: ["ai"],
	broadcast: false,
};
const sent: SendStep = { kind: "sent", channelId: CHANNEL };
const make = (steps: readonly SendStep[] = [sent]) =>
	createSlackWireFake({ channels: [CHANNEL, OTHER, "G0DYTEST3"], steps });
const post = (fake: SlackWireFake, rendered = renderSlackRequest(base)): Promise<Response> =>
	fake.fetch(rendered.url, {
		method: rendered.method,
		headers: Object.fromEntries(rendered.headers),
		body: rendered.body,
		redirect: "error",
	});
const classified = (observation: unknown, deliverBy = now + 900_000) =>
	classifySlackSend({ channelId: CHANNEL, now, deliverBy, retryAttempt: 0, observation });
const observe = async (response: Response): Promise<unknown> => {
	try {
		return {
			kind: "response",
			status: response.status,
			body: await response.json(),
			retryAfter: response.headers.get("retry-after") ?? undefined,
		};
	} catch {
		return { kind: "transport", written: "maybe" };
	}
};
beforeEach(() =>
	vi.stubGlobal(
		"fetch",
		vi.fn().mockRejectedValue(new Error("Native network forbidden in Slack wire fixture")),
	),
);
afterEach(() => {
	expect(globalThis.fetch).not.toHaveBeenCalled();
	vi.unstubAllGlobals();
	vi.restoreAllMocks();
});

describe("actual Slack renderer through a bounded in-memory wire fixture and classifier", () => {
	it.each([
		{
			name: "owner",
			authors: ["owner"],
			channelId: "G0DYTEST3",
			threadTs: undefined,
			expected: "<!here> & <@U0DYTEST>",
		},
		{
			name: "draft",
			authors: ["ai"],
			channelId: CHANNEL,
			threadTs: "1760000000.000001",
			expected: "&lt;!here&gt; &amp; &lt;@U0DYTEST&gt;",
		},
		{
			name: "agent",
			authors: ["agent"],
			channelId: OTHER,
			threadTs: null,
			expected: "&lt;!here&gt; &amp; &lt;@U0DYTEST&gt;",
		},
		{
			name: "plugin",
			authors: ["owner", "plugin"],
			channelId: OTHER,
			threadTs: null,
			expected: "&lt;!here&gt; &amp; &lt;@U0DYTEST&gt;",
		},
	])(
		"preserves intended $name text/channel/thread and independently decodes exact wire fields",
		async ({ authors, channelId, threadTs, expected }) => {
			const fake = make([{ kind: "sent", channelId }]);
			const request = renderSlackRequest({
				channelId,
				threadTs,
				authors,
				text: "<!here> & <@U0DYTEST>",
				footer: "",
				broadcast: false,
			});
			const response = await post(fake, request);
			const observation = await observe(response);
			expect(
				classifySlackSend({
					channelId,
					now,
					deliverBy: now + 900_000,
					retryAttempt: 0,
					observation,
				}),
			).toEqual({ state: "SENT", channelId, ts: "1760000000.000001" });
			const [message] = fake.captured();
			expect(message).toEqual({
				channel: channelId,
				...(threadTs ? { thread_ts: threadTs } : {}),
				text: expected,
				unfurl_links: false,
				unfurl_media: false,
				ts: "1760000000.000001",
				bodySha256: request.bodySha256,
			});
			expect(JSON.parse(request.body)).toEqual({
				channel: channelId,
				...(threadTs ? { thread_ts: threadTs } : {}),
				text: expected,
				unfurl_links: false,
				unfurl_media: false,
			});
			expect(request.headersSha256).toBe(
				createHash("sha256").update('[["content-type","application/json"]]').digest("hex"),
			);
			const [record] = fake.recorder.takeRequests();
			expect(record).toMatchObject({
				method: "POST",
				host: "slack.com",
				target: "/api/chat.postMessage",
				bodyLength: Buffer.byteLength(request.body),
				bodySha256: createHash("sha256").update(request.body).digest("hex"),
				headerNames: ["content-type"],
			});
			expect(record?.body).toHaveLength(0);
			expect(record?.headers).not.toHaveProperty("authorization");
			expect(fake.remaining()).toBe(0);
		},
	);
	it.each([false, true])("independently captures threaded broadcast %j", async (broadcast) => {
		const fake = make();
		const request = renderSlackRequest({ ...base, threadTs: "1.0", broadcast });
		expect(classified(await observe(await post(fake, request)))).toMatchObject({ state: "SENT" });
		expect(fake.captured()[0]).toMatchObject({ thread_ts: "1.0" });
		if (broadcast) expect(fake.captured()[0]?.reply_broadcast).toBe(true);
		else expect(fake.captured()[0]).not.toHaveProperty("reply_broadcast");
		expect(fake.captured()[0]?.bodySha256).toBe(
			createHash("sha256").update(request.body).digest("hex"),
		);
		expect(fake.remaining()).toBe(0);
	});
	it.each([false, null, 0, "false"])(
		"independently refuses an explicit non-true broadcast %j before commit",
		async (reply_broadcast) => {
			const fake = make();
			const body = JSON.stringify({
				...JSON.parse(renderSlackRequest({ ...base, threadTs: "1.0" }).body),
				reply_broadcast,
			});
			expect(
				(
					await fake.fetch(SLACK_URL, {
						method: "POST",
						headers: { "content-type": "application/json" },
						body,
					})
				).status,
			).toBe(400);
			expect(fake.captured()).toEqual([]);
			expect(fake.remaining()).toBe(1);
		},
	);
	it("preserves exact UTF-8, NFC and layout without decoding escaped mention text", async () => {
		const text = "caf\u00e9 \ud83e\uddad\n\t& <https://example.test/a|report>";
		const fake = make();
		const request = renderSlackRequest({ ...base, text });
		expect(classified(await observe(await post(fake, request)))).toMatchObject({ state: "SENT" });
		expect(fake.captured()[0]?.text).toBe(
			"caf\u00e9 \ud83e\uddad\n\t&amp; &lt;https://example.test/a|report&gt;",
		);
		expect(fake.captured()[0]?.bodySha256).toBe(
			createHash("sha256").update(Buffer.from(request.body, "utf8")).digest("hex"),
		);
	});
	it("commits the synthetic message before a public after-response drop and keeps the send UNKNOWN", async () => {
		const fake = make();
		fake.faults.add({ kind: "drop", method: "POST", path: "/api/chat.postMessage", after: true });
		await expect(post(fake)).rejects.toThrow("fetch failed");
		expect(fake.captured()).toHaveLength(1);
		expect(fake.remaining()).toBe(0);
		expect(classified({ kind: "transport", written: "maybe" })).toEqual({
			state: "UNKNOWN",
			reason: "ambiguous",
		});
		expect(fake.recorder.takeRequests()).toHaveLength(1);
	});
	it("loses an actual 2xx response body after storing the message and remains UNKNOWN", async () => {
		const fake = make([{ ...sent, reply: "body-lost" }]);
		const response = await post(fake);
		expect(response.status).toBe(200);
		expect(classified(await observe(response))).toEqual({ state: "UNKNOWN", reason: "ambiguous" });
		expect(fake.captured()).toHaveLength(1);
		expect(fake.remaining()).toBe(0);
	});
	it("does not invent idempotency: manually repeating the same wire bytes creates two different timestamps", async () => {
		const fake = make([sent, sent]);
		const request = renderSlackRequest(base);
		const first = fake.captured();
		expect(classified(await observe(await post(fake, request)))).toMatchObject({
			ts: "1760000000.000001",
		});
		const previous = fake.captured();
		expect(classified(await observe(await post(fake, request)))).toMatchObject({
			ts: "1760000000.000002",
		});
		expect(first).toHaveLength(0);
		expect(previous).toHaveLength(1);
		expect(Object.isFrozen(previous) && Object.isFrozen(previous[0])).toBe(true);
		expect(Reflect.set(previous[0] ?? {}, "text", "CANARY_MUTATED")).toBe(false);
		expect(fake.captured().map(({ bodySha256 }) => bodySha256)).toEqual([
			request.bodySha256,
			request.bodySha256,
		]);
		expect(fake.recorder.takeRequests()).toHaveLength(2);
	});
	it.each([
		{
			name: "HTTP 429",
			status: 429,
			body: '{"ok":false,"error":"ratelimited"}',
			retryAfter: "30",
			expected: { state: "RETRY_WAIT", notBefore: now + 30_000, reason: "rate_limited" },
		},
		{
			name: "rate wait outside window",
			status: 429,
			body: "{}",
			retryAfter: "901",
			expected: { state: "NEEDS_REAPPROVAL", reason: "missed" },
		},
		{
			name: "2xx rate error",
			status: 200,
			body: '{"ok":false,"error":"ratelimited"}',
			expected: { state: "RETRY_WAIT", notBefore: now + 60_000, reason: "rate_limited" },
		},
		{
			name: "explicit rejection",
			status: 400,
			body: '{"ok":false,"error":"invalid_arguments"}',
			expected: { state: "FAILED", reason: "rejected" },
		},
		{
			name: "alternate rate error with full Retry-After",
			status: 200,
			body: '{"ok":false,"error":"rate_limited"}',
			retryAfter: "300",
			expected: { state: "RETRY_WAIT", notBefore: now + 300_000, reason: "rate_limited" },
		},
		{
			name: "bodyless forbidden response remains ambiguous",
			status: 403,
			body: "{}",
			expected: { state: "UNKNOWN", reason: "ambiguous" },
		},
		{
			name: "forbidden response cannot acknowledge a send",
			status: 403,
			body: `{"ok":true,"channel":"${CHANNEL}","ts":"1.1"}`,
			expected: { state: "UNKNOWN", reason: "ambiguous" },
		},
		{
			name: "fatal error may have partly completed",
			status: 200,
			body: '{"ok":false,"error":"fatal_error"}',
			expected: { state: "UNKNOWN", reason: "ambiguous" },
		},
		{
			name: "5xx despite success-like body",
			status: 503,
			body: `{"ok":true,"channel":"${CHANNEL}","ts":"1.1"}`,
			expected: { state: "UNKNOWN", reason: "ambiguous" },
		},
		{
			name: "wrong channel acknowledgement",
			status: 200,
			body: `{"ok":true,"channel":"${OTHER}","ts":"1.1"}`,
			expected: { state: "UNKNOWN", reason: "ambiguous" },
		},
		{
			name: "noncanonical acknowledgement timestamp",
			status: 200,
			body: `{"ok":true,"channel":"${CHANNEL}","ts":"01.1"}`,
			expected: { state: "UNKNOWN", reason: "ambiguous" },
		},
		{
			name: "unknown private error",
			status: 200,
			body: '{"ok":false,"error":"CANARY_PRIVATE_PROVIDER_DETAIL"}',
			expected: { state: "UNKNOWN", reason: "ambiguous" },
		},
		{
			name: "HTTP 408",
			status: 408,
			body: "{}",
			expected: { state: "RETRY_WAIT", notBefore: now + 1000, reason: "http_408" },
		},
		{
			name: "malformed response body",
			status: 200,
			body: "CANARY_PRIVATE_NOT_JSON",
			expected: { state: "UNKNOWN", reason: "ambiguous" },
		},
	] as const)(
		"classifies actual scripted $name without a hidden second call",
		async ({ status, body, expected, ...entry }) => {
			const fake = make([
				{
					kind: "response",
					channelId: CHANNEL,
					status,
					body,
					...("retryAfter" in entry ? { retryAfter: entry.retryAfter } : {}),
				},
			]);
			const result = classified(await observe(await post(fake)));
			expect(result).toEqual(expected);
			expect(JSON.stringify(result)).not.toContain("CANARY_PRIVATE");
			expect(fake.captured()).toHaveLength(0);
			expect(fake.remaining()).toBe(0);
			expect(fake.recorder.takeRequests()).toHaveLength(1);
		},
	);
	it("does not follow a scripted redirect or treat its success-shaped body as a send", async () => {
		const fake = make([
			{
				kind: "response",
				channelId: CHANNEL,
				status: 302,
				body: `{"ok":true,"channel":"${CHANNEL}","ts":"1.1"}`,
			},
		]);
		await expect(post(fake)).rejects.toThrow("fetch failed");
		expect(classified({ kind: "transport", written: "maybe" })).toEqual({
			state: "UNKNOWN",
			reason: "ambiguous",
		});
		expect(fake.captured()).toEqual([]);
		expect(fake.remaining()).toBe(0);
		expect(fake.recorder.takeRequests()).toHaveLength(1);
	});
	it("public rate/drop-before faults do not store a message or spend a script", async () => {
		const fake = make();
		fake.faults.add({ kind: "rate-limit", retryAfter: 4 }, { kind: "drop" });
		expect(classified(await observe(await post(fake)))).toEqual({
			state: "RETRY_WAIT",
			reason: "rate_limited",
			notBefore: now + 4000,
		});
		await expect(post(fake)).rejects.toThrow("fetch failed");
		expect(classified({ kind: "transport", written: "maybe" })).toMatchObject({ state: "UNKNOWN" });
		expect(fake.captured()).toEqual([]);
		expect(fake.remaining()).toBe(1);
		expect(fake.recorder.takeRequests()).toHaveLength(2);
	});
	it("binds concurrent commits to distinct next policies rather than reusing a captured policy", async () => {
		const fake = make([sent, { ...sent, reply: "body-lost" }]);
		const responses = await Promise.all([post(fake), post(fake)]);
		expect(classified(await observe(responses[0] ?? new Response()))).toMatchObject({
			state: "SENT",
			ts: "1760000000.000001",
		});
		expect(classified(await observe(responses[1] ?? new Response()))).toMatchObject({
			state: "UNKNOWN",
		});
		expect(fake.captured().map(({ ts }) => ts)).toEqual(["1760000000.000001", "1760000000.000002"]);
		expect(fake.remaining()).toBe(0);
	});
});

describe("closed wire admission and bounded fixture state", () => {
	it.each([
		"https://SLACK.com/api/chat.postMessage",
		"https://slack.com:443/api/chat.postMessage",
		"https://%73lack.com/api/chat.postMessage",
		"https://slack.com/x/../api/chat.postMessage",
		`${SLACK_URL}?extra=1`,
		`${SLACK_URL}#fragment`,
		"https://other.example.test/api/chat.postMessage",
	])("refuses raw URL alias before normalization: %s", async (url) => {
		const fake = make();
		expect((await fake.fetch(url, { method: "POST", body: "{}" })).status).toBe(400);
		expect(fake.recorder.takeRequests()).toEqual([]);
		expect(fake.remaining()).toBe(1);
	});
	it("refuses credential headers before recorder, faults, or app and keeps policies bound to their channel", async () => {
		const fake = make();
		expect(
			(
				await fake.fetch(SLACK_URL, {
					method: "POST",
					headers: { authorization: "Bearer synthetic-test-only" },
					body: "{}",
				})
			).status,
		).toBe(400);
		expect(fake.recorder.takeRequests()).toEqual([]);
		expect((await post(fake, renderSlackRequest({ ...base, channelId: OTHER }))).status).toBe(409);
		expect(fake.remaining()).toBe(1);
		expect(classified(await observe(await post(fake)))).toMatchObject({ state: "SENT" });
	});
	it.each([
		{ parse: "full" },
		{ blocks: [] },
		{ attachments: [] },
		{ reply_broadcast: true },
		{ unfurl_links: true },
		{ unfurl_media: true },
		{ thread_ts: "01.1" },
		{ channel: "C0DYTEST1\n" },
		{ text: "caf\u0065\u0301" },
		{ text: "hello\r\nworld" },
	])("refuses unsupported or noncanonical JSON fields: %j", async (change) => {
		const fake = make();
		const body = JSON.stringify({ ...JSON.parse(renderSlackRequest(base).body), ...change });
		expect(
			(
				await fake.fetch(SLACK_URL, {
					method: "POST",
					headers: { "content-type": "application/json" },
					body,
				})
			).status,
		).toBe(400);
		expect(fake.captured()).toEqual([]);
		expect(fake.remaining()).toBe(1);
	});
	it.each(['"channel":"C0DYTEST1",', '"cha\\u006enel":"C0DYTEST1",'])(
		"refuses duplicate JSON members independently of a plausible last value: %s",
		async (member) => {
			const fake = make();
			const body = `{${member}${renderSlackRequest(base).body.slice(1)}`;
			expect(
				(
					await fake.fetch(SLACK_URL, {
						method: "POST",
						headers: { "content-type": "application/json" },
						body,
					})
				).status,
			).toBe(400);
			expect(fake.remaining()).toBe(1);
		},
	);
	it("refuses wrong methods and content types without storing or consuming a send", async () => {
		const fake = make();
		expect((await fake.fetch(SLACK_URL)).status).toBe(400);
		expect(
			(
				await fake.fetch(SLACK_URL, {
					method: "POST",
					headers: { "content-type": "text/plain" },
					body: renderSlackRequest(base).body,
				})
			).status,
		).toBe(400);
		expect(fake.captured()).toEqual([]);
		expect(fake.remaining()).toBe(1);
	});
	it("refuses invalid UTF-8 and excessive JSON nesting at the actual wire decoder", async () => {
		const fake = make();
		for (const body of [new Uint8Array([255]), `${"[".repeat(65)}0${"]".repeat(65)}`]) {
			expect(
				(
					await fake.fetch(SLACK_URL, {
						method: "POST",
						headers: { "content-type": "application/json" },
						body,
					})
				).status,
			).toBe(400);
		}
		expect(fake.captured()).toEqual([]);
		expect(fake.remaining()).toBe(1);
	});
	it("isolates queued configuration and refuses accessors/proxies/inherited sparse entries without hooks", async () => {
		const config = { channels: [CHANNEL], steps: [{ kind: "sent", channelId: CHANNEL }] };
		const fake = createSlackWireFake(config as { channels: string[]; steps: SendStep[] });
		config.channels[0] = OTHER;
		config.steps[0] = { kind: "sent", channelId: OTHER };
		expect(classified(await observe(await post(fake)))).toMatchObject({ state: "SENT" });
		let hooks = 0;
		const getter = () => {
			hooks++;
			throw new Error("CANARY_PRIVATE_CONFIG");
		};
		const hostile = Object.defineProperty({}, "steps", { enumerable: true, get: getter });
		const sparse: unknown[] = Array(1);
		Object.setPrototypeOf(sparse, { 0: getter });
		for (const value of [
			hostile,
			new Proxy({}, { ownKeys: getter }),
			{ channels: [CHANNEL], steps: sparse },
			{
				channels: [CHANNEL],
				steps: [Object.defineProperty({}, "kind", { enumerable: true, get: getter })],
			},
		])
			expect(() => createSlackWireFake(value as Parameters<typeof createSlackWireFake>[0])).toThrow(
				"Slack fixture refused",
			);
		expect(hooks).toBe(0);
	});
	it("caps channel/message/response configuration before serialization", () => {
		for (const value of [
			{ channels: Array(33).fill(CHANNEL), steps: [] },
			{ channels: [CHANNEL, CHANNEL], steps: [] },
			{ channels: [CHANNEL], steps: Array(MAX_WIRE_MESSAGES + 1).fill(sent) },
			{
				channels: [CHANNEL],
				steps: [{ kind: "response", channelId: CHANNEL, status: 200, body: "x".repeat(4097) }],
			},
		])
			expect(() => createSlackWireFake(value as Parameters<typeof createSlackWireFake>[0])).toThrow(
				"Slack fixture refused",
			);
		expect(MAX_STORED_BYTES).toBe(MAX_WIRE_BYTES * MAX_WIRE_MESSAGES);
	});
	it("accepts exact wire/text ceilings, refuses adjacent bytes before recorder, and remains usable", async () => {
		const fake = make([sent, sent]);
		const overhead = Buffer.byteLength(renderSlackRequest({ ...base, text: "x" }).body) - 1;
		const remaining = MAX_REQUEST_BYTES - overhead;
		const text = "\ud83e\uddad".repeat(Math.floor(remaining / 4)) + "x".repeat(remaining % 4);
		const exact = renderSlackRequest({ ...base, text });
		const original = Buffer.concat.bind(Buffer),
			lengths: number[] = [];
		vi.spyOn(Buffer, "concat").mockImplementation((parts, length) => {
			if (length === MAX_WIRE_BYTES) lengths.push(parts.length);
			return original(parts, length);
		});
		expect(Buffer.byteLength(exact.body)).toBe(MAX_WIRE_BYTES);
		expect((await post(fake, exact)).status).toBe(200);
		expect(lengths).toContain(2);
		expect(lengths.every((count) => count <= 2)).toBe(true);
		await expect(
			fake.fetch(SLACK_URL, { method: "POST", body: new Uint8Array(MAX_WIRE_BYTES + 1) }),
		).rejects.toThrow("Slack fixture refused");
		expect(fake.recorder.takeRequests()).toHaveLength(1);
		expect(
			(await post(fake, renderSlackRequest({ ...base, text: "x".repeat(40_000) }))).status,
		).toBe(200);
		expect(fake.captured()).toHaveLength(2);
	});
	it("bounds intrinsic bytes and rejects shared/subclass/proxy chunks without executing byte hooks", async () => {
		const fake = make();
		let hooks = 0;
		const large = new Uint8Array(MAX_WIRE_BYTES + 1);
		for (const key of ["byteLength", "byteOffset", "buffer"])
			Object.defineProperty(large, key, {
				get() {
					hooks++;
					return 0;
				},
			});
		for (const chunk of [
			large,
			new Uint8Array(new SharedArrayBuffer(1)),
			new (class extends Uint8Array {})(1),
			new Proxy(new Uint8Array(1), {
				get() {
					hooks++;
					throw new Error("CANARY_CHUNK");
				},
			}),
		]) {
			const body = new ReadableStream({
				start(controller) {
					controller.enqueue(chunk);
					controller.close();
				},
			});
			await expect(
				fake.fetch(SLACK_URL, { method: "POST", body, duplex: "half" } as RequestInit),
			).rejects.toThrow("Slack fixture refused");
		}
		expect(hooks).toBe(0);
		expect(fake.recorder.takeRequests()).toEqual([]);
	});
	it("copies tiny producer-reused chunks into at most two owned blocks", async () => {
		const fake = make();
		const request = renderSlackRequest({ ...base, text: "x".repeat(8193) });
		const bytes = Buffer.from(request.body);
		const original = Buffer.concat.bind(Buffer),
			lengths: number[] = [];
		vi.spyOn(Buffer, "concat").mockImplementation((parts, length) => {
			if (length === bytes.length) lengths.push(parts.length);
			return original(parts, length);
		});
		let at = 0;
		const reused = Buffer.alloc(1);
		const body = new ReadableStream(
			{
				pull(controller) {
					if (at === bytes.length) controller.close();
					else {
						reused[0] = bytes[at++] ?? 0;
						controller.enqueue(reused);
					}
				},
			},
			{ highWaterMark: 0 },
		);
		expect(
			(
				await fake.fetch(SLACK_URL, {
					method: "POST",
					headers: { "content-type": "application/json" },
					body,
					duplex: "half",
				} as RequestInit)
			).status,
		).toBe(200);
		expect(fake.captured()[0]?.bodySha256).toBe(request.bodySha256);
		expect(lengths.length).toBeGreaterThan(0);
		expect(lengths.every((count) => count === 1)).toBe(true);
	});
	it("cancels too many zero-byte chunks and a held body read before recorder/app", async () => {
		const fake = make();
		let pulls = 0,
			cancelled = 0;
		const infinite = new ReadableStream({
			pull(controller) {
				pulls++;
				controller.enqueue(new Uint8Array());
			},
			cancel() {
				cancelled++;
			},
		});
		await expect(
			fake.fetch(SLACK_URL, { method: "POST", body: infinite, duplex: "half" } as RequestInit),
		).rejects.toThrow("Slack fixture refused");
		expect(pulls).toBeLessThanOrEqual(MAX_WIRE_CHUNKS + 2);
		const controller = new AbortController();
		const held = new ReadableStream<Uint8Array>({
			cancel() {
				cancelled++;
			},
		});
		const work = fake.fetch(SLACK_URL, {
			method: "POST",
			body: held,
			signal: controller.signal,
			duplex: "half",
		} as RequestInit);
		controller.abort();
		await expect(work).rejects.toThrow("Slack fixture refused");
		expect(cancelled).toBe(2);
		expect(fake.recorder.takeRequests()).toEqual([]);
		expect(fake.remaining()).toBe(1);
	});
	it("caps lifetime requests without pretending an exhausted fixture sent anything", async () => {
		const fake = make();
		for (let i = 0; i < MAX_WIRE_REQUESTS; i++)
			expect((await fake.fetch(SLACK_URL)).status).toBe(400);
		expect((await post(fake)).status).toBe(429);
		expect(fake.recorder.takeRequests()).toHaveLength(MAX_WIRE_REQUESTS);
		expect(fake.captured()).toEqual([]);
		expect(fake.remaining()).toBe(1);
	});
});
