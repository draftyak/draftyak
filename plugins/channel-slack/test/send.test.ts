import { createSlackReadFake, createSlackSendFake, SLACK_READ_HOST } from "@draftyak/fakes/slack";
import type { SendRequest } from "@draftyak/protocol/channel-v1";
import { HOST_MAX_STREAM_BYTES, type HostFetchParams } from "@draftyak/protocol/host-channel";
import { SEND_TICKET_META } from "@draftyak/protocol/send-ticket";
import { defineChannelPlugin } from "@draftyak/sdk/channel";
import { createPluginContext } from "@draftyak/sdk/context";
import { PluginError } from "@draftyak/sdk/errors";
import type { HostFetch } from "@draftyak/sdk/fetch";
import { memoryHost } from "@draftyak/sdk/host";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { sendSlack } from "../src/send.ts";

const BODY = { ref: "01ARZ3NDEKTSV4RRFFQ69G5FAV" };
const ARGS: SendRequest = {
	method: "POST",
	url: "https://slack.com/api/chat.postMessage",
	contentType: "application/json",
	body: BODY,
};
// Checked fixture data only. The parent owns ticket minting, consumption and authority.
const TICKET = {
	id: "01ARZ3NDEKTSV4RRFFQ69G5FAW",
	outboxId: "01ARZ3NDEKTSV4RRFFQ69G5FAX",
	instanceId: "01ARZ3NDEKTSV4RRFFQ69G5FAY",
	method: "POST",
	url: ARGS.url,
	contentType: ARGS.contentType,
	headersSha256: "a".repeat(64),
	bodySha256: "b".repeat(64),
	exp: 1000,
};
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
	readonly stream?: boolean;
	readonly status?: number;
	readonly media?: string;
	readonly ref?: string;
	readonly failure?: boolean;
	readonly headersSeen?: Gate;
	readonly headerGate?: Gate;
	readonly cleanupSeen?: Gate;
	readonly cleanupGate?: Gate;
}
const json = (value: unknown, options: Omit<Plan, "bytes"> = {}): Plan => ({
	bytes: Buffer.from(JSON.stringify(value)),
	...options,
});
const success = () => ({ ok: true, channel: "CDYTEST01", ts: "1.000000001" });
interface Fixture {
	readonly controller: AbortController;
	readonly requests: HostFetchParams[];
	readonly signals: (AbortSignal | undefined)[];
	invoke(args?: unknown, metadata?: Readonly<Record<string, unknown>>): Promise<unknown>;
	dispose(): Promise<void>;
}
const fixtures: Fixture[] = [];
const network = vi.fn<typeof fetch>();
function fixture(
	plan: Plan,
	effect?: (request: HostFetchParams, signal: AbortSignal) => Promise<unknown>,
): Fixture {
	const controller = new AbortController(),
		requests: HostFetchParams[] = [];
	const signals: (AbortSignal | undefined)[] = [];
	let disposed = false,
		pump: Promise<void> | undefined,
		pumpError: unknown;
	const parent = memoryHost(async (method, raw, signal) => {
		if (method !== "host/fetch") throw new Error("DYTEST unexpected host method");
		const request = raw as HostFetchParams;
		requests.push(request);
		if (effect) return effect(request, signal);
		if (plan.failure) throw new Error("DYTEST private transport failure");
		const common = {
			status: plan.status ?? 200,
			headers: [["content-type", plan.media ?? "application/json"]],
		};
		return plan.stream
			? { ...common, streamId: "send-response" }
			: {
					...common,
					body:
						plan.ref === undefined
							? { base64: Buffer.from(plan.bytes).toString("base64url") }
							: { ref: plan.ref },
				};
	});
	const original = createPluginContext({ plugin: "slack-send-test" }, parent, controller.signal);
	const fetch: HostFetch = async (input, init) => {
		const signal = init?.signal instanceof AbortSignal ? init.signal : undefined;
		signals.push(signal);
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
		if (plan.stream) {
			pump = (async () => {
				for (
					let offset = 0, sequence = 0;
					offset < plan.bytes.length || sequence === 0;
					sequence++
				) {
					if (disposed || signal?.aborted || controller.signal.aborted) return;
					const end = Math.min(offset + 65_536, plan.bytes.length);
					parent.notify({
						jsonrpc: "2.0",
						method: "host/stream.chunk",
						params: {
							streamId: "send-response",
							sequence,
							done: end === plan.bytes.length,
							base64: Buffer.from(plan.bytes.subarray(offset, end)).toString("base64url"),
						},
					});
					if (end === plan.bytes.length) return;
					offset = end;
					await new Promise<void>((resolve) => setImmediate(resolve));
				}
			})();
			void pump.catch((error) => {
				if (!disposed && !signal?.aborted) pumpError = error;
			});
		}
		plan.headersSeen?.release();
		if (plan.headerGate) await plan.headerGate.promise;
		return response;
	};
	const context = Object.freeze({ ...original, fetch });
	const entry = defineChannelPlugin({
		manifest: {
			id: "@draftyak/slack-send-test",
			version: "1.0.0",
			sdk: "1.0.0",
			kind: "channel",
			contract: { extension: "io.github.draftyak/channel", version: 1 },
			isolation: "standard",
			auth: { kind: "none", scopes: [], requiredGrantedScopes: [] },
			credentials: { mode: "brokered", urlSecrets: [] },
			permissions: {},
			license: "Apache-2.0",
			dataClasses: ["community.content"],
			egress: {
				rules: [
					{
						class: "read",
						method: "GET",
						host: "chat.example.com",
						pathTemplate: "/read",
						maxBytes: 4096,
						timeoutMs: 1000,
					},
				],
			},
		},
		describe: () => ({ channel: "chat", mutations: [], attachments: false, listen: false }),
		probe: () => ({ status: "ok" }),
		sync: () => ({ changes: [], cursor: "done", more: false }),
		fetchBody: () => {
			throw new PluginError("NOT_FOUND");
		},
		send: (args, ctx) => sendSlack(ctx, args),
		reconcileSend: () => ({ candidates: [], complete: false }),
	});
	const tool = entry.tools.find((value) => value.name === "channel_send");
	if (!tool) throw new Error("DYTEST missing checked send handler");
	const owned: Fixture = {
		controller,
		requests,
		signals,
		invoke: async (args = ARGS, metadata = { [SEND_TICKET_META]: TICKET }) =>
			tool.handler(args, context, metadata),
		async dispose() {
			disposed = true;
			plan.headerGate?.release();
			plan.cleanupGate?.release();
			controller.abort();
			parent.close();
			await pump?.catch(() => {});
			expect(pumpError).toBeUndefined();
		},
	};
	fixtures.push(owned);
	return owned;
}
async function uncertain(promise: Promise<unknown>): Promise<void> {
	await expect(promise).rejects.toBeInstanceOf(PluginError);
	await expect(promise).rejects.toMatchObject({
		message: "SEND_UNCERTAIN",
		result: { code: "SEND_UNCERTAIN" },
	});
	await expect(promise).rejects.not.toHaveProperty("cause");
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

describe("Slack ticketed send transport", () => {
	it.each(["POST", "PUT", "PATCH"] as const)(
		"forwards the checked %s request exactly once through the SDK",
		async (method) => {
			const owned = fixture(json(success()));
			const args = { ...ARGS, method, contentType: "application/json; charset=utf-8" };
			const ticket = { ...TICKET, method, contentType: args.contentType };
			expect(await owned.invoke(args, { [SEND_TICKET_META]: ticket })).toEqual({
				message: { kind: "chat", channelId: "CDYTEST01", ts: "1.000000001" },
			});
			expect(owned.requests).toEqual([
				{
					method,
					url: args.url,
					headers: [["content-type", args.contentType]],
					body: BODY,
					sendTicket: ticket,
					stream: true,
				},
			]);
			expect(owned.signals).toHaveLength(1);
			expect(owned.signals[0]?.aborted).toBe(true);
			expect(owned.controller.signal.aborted).toBe(false);
		},
	);

	it("uses the genuine SDK metadata and argument gates before any fetch", async () => {
		const owned = fixture(json(success()));
		for (const metadata of [
			{},
			{ [SEND_TICKET_META]: null },
			{ [SEND_TICKET_META]: { id: TICKET.id } },
		])
			await expect(owned.invoke(ARGS, metadata)).rejects.toMatchObject({
				result: { code: "INVALID_INPUT" },
			});
		for (const args of [
			{ ...ARGS, method: "GET" },
			{ ...ARGS, body: { ref: "bad" } },
			{ ...ARGS, url: "http://slack.com/api/chat.postMessage" },
		])
			await expect(owned.invoke(args)).rejects.toMatchObject({ result: { code: "INVALID_INPUT" } });
		expect(owned.requests).toEqual([]);
		expect(owned.signals).toEqual([]);
	});

	it("reads a successful response beyond 64 KiB without projecting deep unrelated message metadata", async () => {
		let deep: unknown = "DYTEST ignored";
		for (let depth = 0; depth < 80; depth++) deep = { next: deep };
		const response = json(
			{ ...success(), message: { text: "x".repeat(70_000), deep } },
			{ stream: true },
		);
		expect(response.bytes.length).toBeGreaterThan(65_536);
		const owned = fixture(response);
		expect(await owned.invoke()).toEqual({
			message: { kind: "chat", channelId: "CDYTEST01", ts: "1.000000001" },
		});
		expect(owned.requests).toHaveLength(1);
	});

	it.each([
		json({ ok: false, error: "DYTEST private provider reason" }),
		json({ ok: true }),
		json({ ...success(), channel: "" }),
		json({ ...success(), ts: "bad stamp" }),
		json(success(), { status: 503 }),
		json(success(), { media: "text/plain" }),
		json(success(), { failure: true }),
		{ bytes: Buffer.from("{") },
		{ bytes: Buffer.from([0xc3, 0x28]) },
		{ bytes: Buffer.alloc(0), ref: BODY.ref },
	])(
		"does not turn an ambiguous post-dispatch response into a retry or a definitive refusal",
		async (plan) => {
			const owned = fixture(plan);
			await uncertain(owned.invoke());
			expect(owned.requests).toHaveLength(1);
			expect(owned.signals[0]?.aborted).toBe(true);
		},
	);

	it("refuses a real SDK response beyond its stream ceiling without a second send", async () => {
		const owned = fixture({ bytes: Buffer.alloc(HOST_MAX_STREAM_BYTES + 1, 0x20), stream: true });
		await uncertain(owned.invoke());
		expect(owned.requests).toHaveLength(1);
	});

	it("keeps an already cancelled checked send uncertain without dispatch", async () => {
		const owned = fixture(json(success()));
		owned.controller.abort();
		await uncertain(owned.invoke());
		expect(owned.requests).toEqual([]);
	});

	it("keeps cancellation after SDK response headers uncertain with only one dispatch", async () => {
		const headersSeen = gate(),
			headerGate = gate();
		const owned = fixture(json(success(), { headersSeen, headerGate }));
		const pending = owned.invoke(),
			refused = uncertain(pending);
		await headersSeen.promise;
		owned.controller.abort();
		headerGate.release();
		await refused;
		expect(owned.requests).toHaveLength(1);
	});

	it("does not report success when cancelled during genuine SDK reader cleanup", async () => {
		const cleanupSeen = gate(),
			cleanupGate = gate();
		const owned = fixture(json(success(), { cleanupSeen, cleanupGate }));
		const pending = owned.invoke(),
			refused = uncertain(pending);
		await cleanupSeen.promise;
		expect(owned.signals[0]?.aborted).toBe(true);
		expect(owned.controller.signal.aborted).toBe(false);
		owned.controller.abort();
		cleanupGate.release();
		await refused;
		expect(owned.requests).toHaveLength(1);
	});

	it("records one fake-provider effect when the reply is lost and never sends again", async () => {
		const read = createSlackReadFake({
			conversations: [
				{
					id: "CDYTEST01",
					name: "DYTEST room",
					kind: "public_channel",
					member: true,
					archived: false,
					sharing: "none",
					memberCount: 2,
				},
			],
		});
		const sender = createSlackSendFake({ read, userToken: "DYTEST-send" });
		const body = JSON.stringify({
			channel: "CDYTEST01",
			text: "DYTEST one effect",
			unfurl_links: false,
			unfurl_media: false,
		});
		const owned = fixture(json(success()), async (request, signal) => {
			expect(request.body).toEqual(BODY);
			expect(request.sendTicket).toEqual(TICKET);
			const url = new URL(request.url);
			url.hostname = SLACK_READ_HOST;
			const headers = new Headers();
			for (const [name, value] of request.headers) headers.append(name, value);
			headers.set("authorization", "Bearer DYTEST-send");
			const response = await sender.fetch(url, { method: request.method, headers, body, signal });
			expect(response.ok).toBe(true);
			throw new Error("DYTEST reply lost after provider effect");
		});
		await uncertain(owned.invoke());
		expect(owned.requests).toHaveLength(1);
		const url = new URL(`https://${SLACK_READ_HOST}/api/conversations.history`);
		url.searchParams.set("channel", "CDYTEST01");
		url.searchParams.set("limit", "100");
		const observed = await (await read.fetch(url)).json();
		expect(observed).toMatchObject({
			ok: true,
			messages: [{ user: read.ownerId, text: "DYTEST one effect" }],
		});
		expect((observed as { messages: unknown[] }).messages).toHaveLength(1);
	});
});
