import { createSlackReadFake, SLACK_READ_HOST } from "@draftyak/fakes/slack";
import type { ReconcileTarget } from "@draftyak/protocol/channel-v1";
import type { HostFetchParams } from "@draftyak/protocol/host-channel";
import { createPluginContext, type PluginContext } from "@draftyak/sdk/context";
import { PluginError } from "@draftyak/sdk/errors";
import type { HostFetch } from "@draftyak/sdk/fetch";
import { memoryHost } from "@draftyak/sdk/host";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { reconcileSlackSend } from "../src/reconcile.ts";

const OWNER = "UDYTEST01",
	CHANNEL = "CDYTEST01";
const TARGET: ReconcileTarget = { kind: "chat", channelId: CHANNEL };
const row = (ts: string, user = OWNER, threadTs?: string) => ({
	type: "message",
	ts,
	user,
	text: "DYTEST untrusted candidate text",
	...(threadTs === undefined ? {} : { thread_ts: threadTs }),
});
const page = (messages: unknown[] = [], more = false, cursor?: string) => ({
	ok: true,
	messages,
	has_more: more,
	...(cursor === undefined ? {} : { response_metadata: { next_cursor: cursor } }),
});
interface Gate {
	readonly promise: Promise<void>;
	release(): void;
}
function gate(): Gate {
	const owned = Promise.withResolvers<void>();
	return { promise: owned.promise, release: () => owned.resolve() };
}
interface Plan {
	readonly bytes: Uint8Array;
	readonly failure?: boolean;
	readonly status?: number;
	readonly media?: string;
	readonly ref?: string;
	readonly headersSeen?: Gate;
	readonly headerGate?: Gate;
	readonly cleanupSeen?: Gate;
	readonly cleanupGate?: Gate;
	signal?: AbortSignal;
}
const json = (value: unknown, options: Omit<Plan, "bytes"> = {}): Plan => ({
	bytes: Buffer.from(JSON.stringify(value)),
	...options,
});
interface Fixture {
	readonly ctx: PluginContext;
	readonly controller: AbortController;
	readonly requests: HostFetchParams[];
	dispose(): Promise<void>;
}
const fixtures: Fixture[] = [];
const network = vi.fn<typeof fetch>();
function fixture(pages: Plan[] = [], self = json({ ok: true, user_id: OWNER })): Fixture {
	const controller = new AbortController(),
		requests: HostFetchParams[] = [];
	const ownedPlans = [self, ...pages],
		pending: Plan[] = [];
	const parent = memoryHost((method, raw) => {
		if (method !== "host/fetch") throw new Error("DYTEST unexpected host method");
		requests.push(raw as HostFetchParams);
		const plan = pending.shift();
		if (!plan) throw new Error("DYTEST missing response plan");
		if (plan.failure) throw new Error("DYTEST private read failure");
		return {
			status: plan.status ?? 200,
			headers: [["content-type", plan.media ?? "application/json"]],
			body:
				plan.ref === undefined
					? { base64: Buffer.from(plan.bytes).toString("base64url") }
					: { ref: plan.ref },
		};
	});
	const original = createPluginContext(
		{ plugin: "slack-reconcile-test", account: "DYTEST label is not a provider user" },
		parent,
		controller.signal,
	);
	const fetch: HostFetch = async (input, init) => {
		const url = new URL(input instanceof Request ? input.url : input.toString());
		const plan = url.pathname === "/api/auth.test" ? self : pages.shift();
		if (!plan) throw new Error("DYTEST unexpected fetch");
		plan.signal = init?.signal instanceof AbortSignal ? init.signal : undefined;
		pending.push(plan);
		const response = await original.fetch(input, init);
		if (plan.cleanupSeen && response.body !== null) {
			const body = response.body,
				getReader = body.getReader.bind(body);
			Object.defineProperty(body, "getReader", {
				configurable: true,
				value: () => {
					const reader = getReader(),
						cancel = reader.cancel.bind(reader);
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
		plan.headersSeen?.release();
		if (plan.headerGate) await plan.headerGate.promise;
		return response;
	};
	const owned: Fixture = {
		ctx: Object.freeze({ ...original, fetch }),
		controller,
		requests,
		async dispose() {
			for (const plan of ownedPlans) {
				plan.headerGate?.release();
				plan.cleanupGate?.release();
			}
			controller.abort();
			parent.close();
		},
	};
	fixtures.push(owned);
	return owned;
}
beforeEach(() => {
	network.mockReset();
	network.mockRejectedValue(new Error("DYTEST network forbidden"));
	vi.stubGlobal("fetch", network);
});
afterEach(async () => {
	try {
		for (const owned of fixtures.splice(0)) await owned.dispose();
		expect(network).not.toHaveBeenCalled();
	} finally {
		vi.unstubAllGlobals();
	}
});
const refs = (value: Awaited<ReturnType<typeof reconcileSlackSend>>) =>
	value.candidates.map((candidate) =>
		candidate.kind === "chat.message" ? candidate.ts : "unexpected-email",
	);

describe("Slack account-sent reconciliation candidates", () => {
	it("observes provider self identity and filters authors and time without matching content", async () => {
		const owned = fixture([
			json(page([row("1.000"), row("1.001000001", "UDYTEST02"), row("1.001"), row("1.001999999")])),
		]);
		const result = await reconcileSlackSend(owned.ctx, { attemptAt: 1001, target: TARGET });
		expect(refs(result)).toEqual(["1.001", "1.001999999"]);
		expect(result.complete).toBe(true);
		expect(Object.isFrozen(result)).toBe(true);
		expect(Object.isFrozen(result.candidates)).toBe(true);
		expect(
			result.candidates.every(
				(candidate) => candidate.kind === "chat.message" && candidate.author.id === OWNER,
			),
		).toBe(true);
		expect(owned.requests).toHaveLength(2);
		expect(owned.requests[0]).toEqual({
			method: "POST",
			url: "https://slack.com/api/auth.test",
			headers: [],
			stream: true,
		});
		const request = owned.requests[1],
			url = new URL(request?.url as string);
		expect(request).toMatchObject({ method: "GET", stream: true, headers: [] });
		expect(url.origin + url.pathname).toBe("https://slack.com/api/conversations.history");
		expect([...url.searchParams]).toEqual([
			["channel", CHANNEL],
			["limit", "100"],
			["oldest", "1.001"],
			["inclusive", "true"],
		]);
		for (const call of owned.requests)
			for (const key of ["body", "sendTicket", "saveAs", "lookupPermit"])
				expect(call).not.toHaveProperty(key);
	});

	it("selects replies for a target thread and excludes unrelated thread data", async () => {
		const owned = fixture([
			json(page([row("1.000"), row("2.000", OWNER, "1.000"), row("3.000", OWNER, "9.000")])),
		]);
		const result = await reconcileSlackSend(owned.ctx, {
			attemptAt: 1000,
			target: { ...TARGET, kind: "chat", threadTs: "1.000" },
		});
		expect(refs(result)).toEqual(["1.000", "2.000"]);
		expect(result.complete).toBe(true);
		const url = new URL(owned.requests[1]?.url as string);
		expect(url.pathname).toBe("/api/conversations.replies");
		expect(url.searchParams.get("ts")).toBe("1.000");
	});

	it("retains the exact maximum-safe millisecond attempt in the oldest query", async () => {
		const owned = fixture([json(page())]);
		expect(
			await reconcileSlackSend(owned.ctx, { attemptAt: Number.MAX_SAFE_INTEGER, target: TARGET }),
		).toEqual({ candidates: [], complete: true });
		expect(new URL(owned.requests[1]?.url as string).searchParams.get("oldest")).toBe(
			"9007199254740.991",
		);
	});

	it("deduplicates exact provider timestamp identities across pages without overwriting the first body", async () => {
		const owned = fixture([
			json(page([row("1.0"), row("2.0")], true, "next")),
			json(page([{ ...row("2.0"), text: "DYTEST later duplicate" }, row("3.0")])),
		]);
		const result = await reconcileSlackSend(owned.ctx, { attemptAt: 0, target: TARGET });
		expect(refs(result)).toEqual(["1.0", "2.0", "3.0"]);
		expect(result.complete).toBe(true);
		expect(result.candidates[1]).toMatchObject({ text: "DYTEST untrusted candidate text" });
		expect(new URL(owned.requests[2]?.url as string).searchParams.get("cursor")).toBe("next");
	});

	it.each([50, 51])(
		"bounds %s otherwise eligible unique candidates without inventing completeness",
		async (count) => {
			const owned = fixture([
				json(page(Array.from({ length: count }, (_, at) => row(`${at + 1}.0`)))),
			]);
			const result = await reconcileSlackSend(owned.ctx, { attemptAt: 0, target: TARGET });
			expect(result.candidates).toHaveLength(50);
			expect(result.complete).toBe(count === 50);
			expect(owned.requests).toHaveLength(2);
		},
	);

	it("does not mistake missing continuation or the 128-page work cap for complete coverage", async () => {
		const incomplete = fixture([json(page([row("1.0")], true))]);
		expect(
			await reconcileSlackSend(incomplete.ctx, { attemptAt: 0, target: TARGET }),
		).toMatchObject({ complete: false, candidates: [expect.objectContaining({ ts: "1.0" })] });
		const bounded = fixture(
			Array.from({ length: 128 }, (_, at) => json(page([], true, `next-${at}`))),
		);
		expect(await reconcileSlackSend(bounded.ctx, { attemptAt: 0, target: TARGET })).toEqual({
			candidates: [],
			complete: false,
		});
		expect(bounded.requests).toHaveLength(129);
	});

	it.each([json(page([], false), { failure: true }), json(page([{ ...row("2.0"), text: 7 }]))])(
		"keeps earlier candidates but marks a failed later read incomplete without retry",
		async (next) => {
			const owned = fixture([json(page([row("1.0")], true, "next")), next]);
			const result = await reconcileSlackSend(owned.ctx, { attemptAt: 0, target: TARGET });
			expect(refs(result)).toEqual(["1.0"]);
			expect(result.complete).toBe(false);
			expect(owned.requests).toHaveLength(3);
		},
	);

	it.each([
		json({ ok: false, error: "DYTEST private identity refusal" }),
		json({ ok: true }),
		json({ ok: true, user_id: "" }),
		json({ ok: true, user_id: OWNER }, { failure: true }),
		{ bytes: Buffer.from("{") },
		{ bytes: Buffer.alloc(0), ref: "01ARZ3NDEKTSV4RRFFQ69G5FAV" },
	])(
		"never labels broad history as account-sent when self identity is unavailable",
		async (self) => {
			const owned = fixture([json(page([row("1.0")]))], self);
			expect(await reconcileSlackSend(owned.ctx, { attemptAt: 0, target: TARGET })).toEqual({
				candidates: [],
				complete: false,
			});
			expect(owned.requests).toHaveLength(1);
		},
	);

	it("rejects invalid or unsupported requests before identity or history IO", () => {
		const owned = fixture();
		for (const attemptAt of [-1, 0.5, Number.NaN, Number.POSITIVE_INFINITY])
			expect(() => reconcileSlackSend(owned.ctx, { attemptAt, target: TARGET })).toThrow(
				"INVALID_INPUT",
			);
		expect(() =>
			reconcileSlackSend(owned.ctx, { attemptAt: 0, target: { kind: "email" } }),
		).toThrow("UNSUPPORTED");
		expect(() =>
			reconcileSlackSend(owned.ctx, {
				attemptAt: 0,
				target: { kind: "chat", channelId: CHANNEL, threadTs: "bad-stamp" },
			}),
		).toThrow("INVALID_INPUT");
		expect(owned.requests).toEqual([]);
	});

	it("rejects an aborted caller without returning candidates or making requests", async () => {
		const owned = fixture();
		owned.controller.abort();
		const pending = reconcileSlackSend(owned.ctx, { attemptAt: 0, target: TARGET });
		await expect(pending).rejects.toBeInstanceOf(PluginError);
		await expect(pending).rejects.toMatchObject({ result: { code: "TRANSIENT" } });
		expect(owned.requests).toEqual([]);
	});

	it("does not return accumulated candidates when a later genuine SDK response is cancelled", async () => {
		const headersSeen = gate(),
			headerGate = gate();
		const owned = fixture([
			json(page([row("1.0")], true, "next")),
			json(page([row("2.0")]), { headersSeen, headerGate }),
		]);
		const pending = reconcileSlackSend(owned.ctx, { attemptAt: 0, target: TARGET });
		const refused = expect(pending).rejects.toMatchObject({ result: { code: "TRANSIENT" } });
		await headersSeen.promise;
		owned.controller.abort();
		headerGate.release();
		await refused;
		expect(owned.requests).toHaveLength(3);
	});

	it("rejects cancellation during genuine self-response cleanup before scanning history", async () => {
		const cleanupSeen = gate(),
			cleanupGate = gate();
		const self = json({ ok: true, user_id: OWNER }, { cleanupSeen, cleanupGate });
		const owned = fixture([json(page([row("1.0")]))], self);
		const pending = reconcileSlackSend(owned.ctx, { attemptAt: 0, target: TARGET });
		const refused = expect(pending).rejects.toMatchObject({ result: { code: "TRANSIENT" } });
		await cleanupSeen.promise;
		expect(self.signal?.aborted).toBe(true);
		expect(owned.controller.signal.aborted).toBe(false);
		owned.controller.abort();
		cleanupGate.release();
		await refused;
		expect(owned.requests).toHaveLength(1);
	});

	it("uses observed self identity with genuine SDK and readonly FakeSlack history", async () => {
		const read = createSlackReadFake({
			ownerId: OWNER,
			conversations: [
				{
					id: CHANNEL,
					name: "DYTEST room",
					kind: "public_channel",
					member: true,
					archived: false,
					sharing: "none",
					memberCount: 2,
				},
			],
		});
		read.addMessage(CHANNEL, { ts: "2.000", user: OWNER, text: "DYTEST own" });
		read.addMessage(CHANNEL, { ts: "2.001", user: "UDYTEST02", text: "DYTEST own" });
		const controller = new AbortController(),
			requests: HostFetchParams[] = [];
		const parent = memoryHost(async (method, raw, signal) => {
			if (method !== "host/fetch") throw new Error("DYTEST unexpected host method");
			const request = raw as HostFetchParams;
			requests.push(request);
			const url = new URL(request.url);
			if (url.pathname === "/api/auth.test") {
				expect(request.method).toBe("POST");
				return {
					status: 200,
					headers: [["content-type", "application/json"]],
					body: {
						base64: Buffer.from(JSON.stringify({ ok: true, user_id: read.ownerId })).toString(
							"base64url",
						),
					},
				};
			}
			expect(request.method).toBe("GET");
			expect(url.origin).toBe("https://slack.com");
			url.hostname = SLACK_READ_HOST;
			const headers = new Headers();
			for (const [name, value] of request.headers) headers.append(name, value);
			const response = await read.fetch(url, { method: request.method, headers, signal });
			return {
				status: response.status,
				headers: [...response.headers],
				body: { base64: Buffer.from(await response.arrayBuffer()).toString("base64url") },
			};
		});
		try {
			const ctx = createPluginContext(
				{ plugin: "slack-reconcile-test" },
				parent,
				controller.signal,
			);
			const result = await reconcileSlackSend(ctx, { attemptAt: 2000, target: TARGET });
			expect(refs(result)).toEqual(["2.000"]);
			expect(result.complete).toBe(true);
			expect(requests).toHaveLength(2);
		} finally {
			controller.abort();
			parent.close();
		}
	});
});
