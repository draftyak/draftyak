import { createHash } from "node:crypto";
import { isProxy } from "node:util/types";
import type { MessageRef } from "@draftyak/protocol/channel-v1";
import { ProviderId } from "@draftyak/protocol/normalized-change";
import type { PluginContext } from "@draftyak/sdk/context";
import { PluginError } from "@draftyak/sdk/errors";

type ChatMessageRef = Extract<MessageRef, { kind: "chat" }>;

export interface SlackThreadObservation {
	readonly channelId: string;
	readonly ts: string;
	readonly threadTs: string;
}

export interface SlackThreadIndex {
	remember(observed: SlackThreadObservation): Promise<void>;
	find(message: ChatMessageRef): Promise<Readonly<SlackThreadObservation> | undefined>;
	forget(message: ChatMessageRef): Promise<void>;
}

function invalid(): never {
	throw new PluginError("INVALID_INPUT");
}

function transient(): never {
	throw new PluginError("TRANSIENT");
}

function record(raw: unknown, keys: readonly string[], strict = false): Record<string, unknown> {
	if (raw === null || typeof raw !== "object" || isProxy(raw)) invalid();
	const prototype = Object.getPrototypeOf(raw);
	if (prototype !== null && prototype !== Object.prototype) invalid();
	if (strict && Reflect.ownKeys(raw).some((key) => typeof key !== "string" || !keys.includes(key)))
		invalid();
	const result: Record<string, unknown> = Object.create(null);
	for (const key of keys) {
		const descriptor = Object.getOwnPropertyDescriptor(raw, key);
		if (descriptor === undefined) continue;
		if (!descriptor.enumerable || !("value" in descriptor)) invalid();
		result[key] = descriptor.value;
	}
	return result;
}

function providerId(raw: unknown): string {
	const parsed = ProviderId.safeParse(raw);
	if (!parsed.success) invalid();
	return parsed.data;
}

function timestamp(raw: unknown): string {
	const value = providerId(raw);
	if (!/^(?:0|[1-9][0-9]*)\.[0-9]{1,9}$/.test(value)) invalid();
	const dot = value.indexOf(".");
	const nanoseconds =
		BigInt(value.slice(0, dot)) * 1_000_000_000n + BigInt(value.slice(dot + 1).padEnd(9, "0"));
	if (nanoseconds / 1_000_000n > BigInt(Number.MAX_SAFE_INTEGER)) invalid();
	return value;
}

function target(raw: unknown): Readonly<{ channelId: string; ts: string }> {
	const data = record(raw, ["kind", "channelId", "ts"]);
	if (data.kind !== "chat") invalid();
	return Object.freeze({ channelId: providerId(data.channelId), ts: timestamp(data.ts) });
}

function observation(raw: unknown): Readonly<SlackThreadObservation> {
	const data = record(raw, ["channelId", "ts", "threadTs"]);
	return Object.freeze({
		channelId: providerId(data.channelId),
		ts: timestamp(data.ts),
		threadTs: timestamp(data.threadTs),
	});
}

function capture(ctx: unknown, scope: unknown) {
	if (
		typeof scope !== "string" ||
		scope.length === 0 ||
		scope.length > 4_096 ||
		!scope.isWellFormed()
	)
		invalid();
	const context = record(ctx, ["kv", "signal"]);
	if (context.signal === null || typeof context.signal !== "object" || isProxy(context.signal))
		invalid();
	try {
		Reflect.get(AbortSignal.prototype, "aborted", context.signal);
	} catch {
		invalid();
	}
	const methods = record(context.kv, ["get", "set", "delete"]);
	for (const method of [methods.get, methods.set, methods.delete]) {
		if (typeof method !== "function" || isProxy(method)) invalid();
	}
	return {
		scope,
		signal: context.signal as AbortSignal,
		receiver: context.kv,
		get: methods.get as PluginContext["kv"]["get"],
		set: methods.set as PluginContext["kv"]["set"],
		delete: methods.delete as PluginContext["kv"]["delete"],
	};
}

function assertActive(signal: AbortSignal): void {
	if (Reflect.get(AbortSignal.prototype, "aborted", signal)) transient();
}

function keyFor(
	scope: string,
	message: { readonly channelId: string; readonly ts: string },
): string {
	// Canonical JSON array [1, scope, channelId, exactTs], with primitive-only encoding.
	const data = `[1,${JSON.stringify(scope)},${JSON.stringify(message.channelId)},${JSON.stringify(message.ts)}]`;
	const digest = createHash("sha256")
		.update("draftyak/slack/thread-index/v1\0")
		.update(data)
		.digest("hex");
	return `slack:thread:v1:${digest}`;
}

/**
 * An advisory routing cache. Scope is caller DATA, never a read grant; the parent
 * owns backend isolation and lifetime. Only this adapter's own calls are serialized.
 */
export function createSlackThreadIndex(
	ctx: Pick<PluginContext, "kv" | "signal">,
	scope: string,
): Readonly<SlackThreadIndex> {
	const input = capture(ctx, scope);
	let pending: Promise<void> = Promise.resolve();
	function enqueue<T>(work: () => Promise<T>): Promise<T> {
		const operation = pending.then(async () => {
			try {
				assertActive(input.signal);
				const value = await work();
				assertActive(input.signal);
				return value;
			} catch {
				return transient();
			}
		});
		pending = operation.then(
			() => undefined,
			() => undefined,
		);
		return operation;
	}
	return Object.freeze({
		remember(raw: SlackThreadObservation): Promise<void> {
			const observed = observation(raw);
			const key = keyFor(input.scope, observed);
			const stored = Object.freeze({ v: 1, scope: input.scope, ...observed });
			return enqueue(async () => {
				await Reflect.apply(input.set, input.receiver, [key, stored]);
			});
		},
		find(raw: ChatMessageRef): Promise<Readonly<SlackThreadObservation> | undefined> {
			const message = target(raw);
			const key = keyFor(input.scope, message);
			return enqueue(async () => {
				const value: unknown = await Reflect.apply(input.get, input.receiver, [key]);
				assertActive(input.signal);
				// A cache miss is not authoritative evidence that a message or thread is absent.
				if (value === undefined || value === null) return undefined;
				const data = record(value, ["v", "scope", "channelId", "ts", "threadTs"], true);
				if (data.v !== 1 || data.scope !== input.scope) transient();
				const observed = observation(data);
				if (observed.channelId !== message.channelId || observed.ts !== message.ts) transient();
				return observed;
			});
		},
		forget(raw: ChatMessageRef): Promise<void> {
			const message = target(raw);
			const key = keyFor(input.scope, message);
			return enqueue(async () => {
				await Reflect.apply(input.delete, input.receiver, [key]);
			});
		},
	});
}
