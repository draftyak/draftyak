import {
	createSlackReadFake,
	SLACK_READ_HOST,
	type SlackReadConversation,
	type SlackReadFake,
} from "@draftyak/fakes/slack";
import {
	type HostFetchParams,
	type HostMethod,
	type HostMethods,
	HostStreamChunk,
} from "@draftyak/protocol/host-channel";
import { createPluginContext, type PluginContext } from "@draftyak/sdk/context";
import { type HostRequestOptions, memoryHost } from "@draftyak/sdk/host";

export const LEGACY_SYNC_CHANNEL = "CDYTEST1";
export const LEGACY_SYNC_NOW = 1_800_000_100_000;

export interface LegacySyncGate {
	readonly entered: Promise<void>;
	release(): void;
}
interface OwnedGate extends LegacySyncGate {
	readonly waiting: Promise<void>;
	enter(): void;
}
export interface LegacySyncRequest {
	readonly params: HostFetchParams;
	readonly signal: AbortSignal | undefined;
}
export interface LegacySyncFixture {
	readonly fake: SlackReadFake;
	readonly values: Map<string, unknown>;
	readonly requests: readonly LegacySyncRequest[];
	readonly kvRequests: readonly { readonly method: string; readonly key: string }[];
	readonly unexpected: readonly HostMethod[];
	readonly pumpErrors: readonly unknown[];
	/** The kept fake always emits reply_count; this models only its absence on actual wire rows. */
	readonly omitReplyCounts: Set<string>;
	/** Counterfactual replies-only wire field mutations for negative correlation cases. */
	readonly replyThreadOverrides: Map<string, string>;
	rpc(): Readonly<{ context: PluginContext; shared: AbortController }>;
	gateNextBody(): LegacySyncGate;
	gateNextCleanup(): LegacySyncGate;
	close(): Promise<void>;
}

export function legacySyncConversation(
	id: string = LEGACY_SYNC_CHANNEL,
	patch: Partial<Omit<SlackReadConversation, "id">> = {},
): SlackReadConversation {
	return {
		id,
		name: "dytest-legacy-sync",
		kind: "public_channel",
		member: true,
		archived: false,
		sharing: "none",
		memberCount: 1,
		...patch,
	};
}

const turn = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

/** Genuine provider state and SDK transport; no listener, credential or native admission exists. */
export function createLegacySyncFixture(
	options: {
		readonly conversations?: readonly SlackReadConversation[];
		readonly nowMs?: number;
	} = {},
): LegacySyncFixture {
	const fake = createSlackReadFake({
		conversations: options.conversations ?? [legacySyncConversation()],
		nowMs: options.nowMs ?? LEGACY_SYNC_NOW,
	});
	const values = new Map<string, unknown>();
	const requests: LegacySyncRequest[] = [];
	const kvRequests: { method: string; key: string }[] = [];
	const unexpected: HostMethod[] = [];
	const pumpErrors: unknown[] = [];
	const omitReplyCounts = new Set<string>();
	const replyThreadOverrides = new Map<string, string>();
	const pumps: Promise<void>[] = [];
	const gates: OwnedGate[] = [];
	const bodyGates: OwnedGate[] = [];
	const cleanupGates: OwnedGate[] = [];
	const rpcs: { shared: AbortController; close(): void }[] = [];
	let streamNumber = 0;
	let closed = false;
	let closing: Promise<void> | undefined;
	const gate = (queue: OwnedGate[]): LegacySyncGate => {
		const entered = Promise.withResolvers<void>();
		const waiting = Promise.withResolvers<void>();
		const owned: OwnedGate = Object.freeze({
			entered: entered.promise,
			waiting: waiting.promise,
			enter: () => entered.resolve(),
			release: () => waiting.resolve(),
		});
		gates.push(owned);
		queue.push(owned);
		return owned;
	};
	const fixture: LegacySyncFixture = {
		fake,
		values,
		requests,
		kvRequests,
		unexpected,
		pumpErrors,
		omitReplyCounts,
		replyThreadOverrides,
		gateNextBody: () => gate(bodyGates),
		gateNextCleanup: () => gate(cleanupGates),
		rpc() {
			if (closed) throw new Error("DYTEST legacy fixture closed");
			const shared = new AbortController();
			const pending: LegacySyncRequest[] = [];
			const host = memoryHost(async (method, raw, signal) => {
				if (method === "host/kv.get") {
					const { key } = raw as HostMethods["host/kv.get"]["params"];
					kvRequests.push({ method, key });
					return { value: structuredClone(values.get(key) ?? null) };
				}
				if (method === "host/kv.set") {
					const { key, value } = raw as HostMethods["host/kv.set"]["params"];
					kvRequests.push({ method, key });
					values.set(key, structuredClone(value));
					return null;
				}
				if (method === "host/kv.delete") {
					const { key } = raw as HostMethods["host/kv.delete"]["params"];
					kvRequests.push({ method, key });
					values.delete(key);
					return null;
				}
				if (method !== "host/fetch") {
					unexpected.push(method);
					throw new Error("DYTEST unexpected legacy host method");
				}
				const params = raw as HostFetchParams;
				let trace = pending.shift();
				while (trace?.signal?.aborted) trace = pending.shift();
				if (!trace) throw new Error("DYTEST legacy request trace missing");
				const url = new URL(params.url);
				if (
					url.origin !== "https://slack.com" ||
					params.method !== "GET" ||
					params.body !== undefined ||
					params.sendTicket !== undefined ||
					params.saveAs !== undefined
				)
					throw new Error("DYTEST unexpected legacy provider request");
				url.hostname = SLACK_READ_HOST;
				const response = await fake.fetch(url, {
					method: params.method,
					headers: params.headers as [string, string][],
					signal,
				});
				let bytes = Buffer.from(await response.arrayBuffer());
				const alterReplyThread =
					url.pathname === "/api/conversations.replies" && replyThreadOverrides.size > 0;
				if ((omitReplyCounts.size > 0 || alterReplyThread) && response.ok) {
					const data: unknown = JSON.parse(bytes.toString("utf8"));
					if (
						data &&
						typeof data === "object" &&
						"messages" in data &&
						Array.isArray(data.messages)
					) {
						for (const row of data.messages) {
							if (row && typeof row === "object" && typeof row.ts === "string") {
								if (omitReplyCounts.has(row.ts)) delete row.reply_count;
								const thread = alterReplyThread ? replyThreadOverrides.get(row.ts) : undefined;
								if (thread !== undefined) row.thread_ts = thread;
							}
						}
						bytes = Buffer.from(JSON.stringify(data));
					}
				}
				const streamId = `dytest-legacy-${++streamNumber}`;
				const bodyGate = bodyGates.shift();
				const requestSignal = trace.signal;
				const pump = async (): Promise<void> => {
					await turn();
					bodyGate?.enter();
					await bodyGate?.waiting;
					let sequence = 0;
					for (let offset = 0; offset < bytes.length; offset += 16_384) {
						if (closed || shared.signal.aborted || requestSignal?.aborted) return;
						host.notify({
							jsonrpc: "2.0",
							method: "host/stream.chunk",
							params: HostStreamChunk.parse({
								streamId,
								sequence: sequence++,
								base64: bytes.subarray(offset, offset + 16_384).toString("base64url"),
								done: false,
							}),
						});
						await turn();
					}
					if (!closed && !shared.signal.aborted && !requestSignal?.aborted)
						host.notify({
							jsonrpc: "2.0",
							method: "host/stream.chunk",
							params: HostStreamChunk.parse({ streamId, sequence, base64: "", done: true }),
						});
				};
				pumps.push(
					pump().catch((error: unknown) => {
						pumpErrors.push(error);
						shared.abort(new Error("DYTEST legacy stream failed"));
					}),
				);
				return { status: response.status, headers: [...response.headers], streamId };
			});
			const originalRequest = host.request;
			host.request = function <M extends HostMethod>(
				method: M,
				params: HostMethods[M]["params"],
				requestOptions?: HostRequestOptions,
			): Promise<HostMethods[M]["result"]> {
				if (method === "host/fetch") {
					const trace = { params: params as HostFetchParams, signal: requestOptions?.signal };
					requests.push(trace);
					pending.push(trace);
				}
				return Reflect.apply(originalRequest, this, [method, params, requestOptions]);
			};
			const original = createPluginContext(
				{ plugin: "@draftyak/channel-slack", account: "dytest-legacy-account" },
				host,
				shared.signal,
			);
			const context = Object.freeze({
				...original,
				async fetch(...args: Parameters<PluginContext["fetch"]>) {
					const cleanup = cleanupGates.shift();
					const response = await Reflect.apply(original.fetch, original, args);
					if (cleanup && response.body) {
						const body = response.body;
						const getReader = body.getReader.bind(body);
						Object.defineProperty(body, "getReader", {
							value() {
								const reader = getReader();
								const cancel = reader.cancel.bind(reader);
								Object.defineProperty(reader, "cancel", {
									async value(reason?: unknown) {
										cleanup.enter();
										await cleanup.waiting;
										return cancel(reason);
									},
								});
								return reader;
							},
						});
					}
					return response;
				},
			});
			rpcs.push({ shared, close: () => host.close() });
			return Object.freeze({ context, shared });
		},
		close() {
			closing ??= (async () => {
				closed = true;
				for (const gate of gates) gate.release();
				for (const rpc of rpcs) {
					rpc.shared.abort();
					rpc.close();
				}
				await Promise.all(pumps);
				if (pumpErrors.length > 0) throw new Error("DYTEST legacy stream cleanup failed");
			})();
			return closing;
		},
	};
	return Object.freeze(fixture);
}
