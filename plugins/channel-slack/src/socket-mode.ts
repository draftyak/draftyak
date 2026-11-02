import { isProxy } from "node:util/types";
import {
	HOST_MAX_ACTIVE_REQUESTS,
	HOST_MAX_FRAME_BYTES,
	HOST_MAX_WS_DATA_LENGTH,
} from "@draftyak/protocol/host-channel";
import type { HostSocket, PluginContext } from "@draftyak/sdk/context";

/** A volatile deduplication window, not a durable event or read allowance. */
export const MAX_SLACK_SOCKET_EVENT_IDS = 4096;

export type SlackSocketResult = "notified" | "duplicate" | "ignored";
export interface SlackSocketProcessor {
	receive(wire: unknown): Promise<SlackSocketResult>;
	/** Retires this processor only; the caller retains its context and socket. */
	dispose(): void;
}
export interface SlackSocketProcessorOptions {
	readonly maxRememberedEvents?: number;
}

function invalid(): never {
	throw new Error("SLACK_SOCKET_INVALID");
}
function rememberedLimit(raw: unknown): number {
	const value = raw === undefined ? MAX_SLACK_SOCKET_EVENT_IDS : raw;
	if (
		typeof value !== "number" ||
		!Number.isSafeInteger(value) ||
		value < 1 ||
		value > MAX_SLACK_SOCKET_EVENT_IDS
	)
		invalid();
	return value;
}
function record(raw: unknown, keys: readonly string[]): Record<string, unknown> {
	if (raw === null || typeof raw !== "object" || isProxy(raw)) invalid();
	const prototype = Object.getPrototypeOf(raw);
	if (prototype !== null && prototype !== Object.prototype) invalid();
	const result: Record<string, unknown> = Object.create(null);
	for (const key of keys) {
		const descriptor = Object.getOwnPropertyDescriptor(raw, key);
		if (descriptor === undefined) continue;
		if (!descriptor.enumerable || !("value" in descriptor)) invalid();
		result[key] = descriptor.value;
	}
	return result;
}
function id(raw: unknown): string {
	if (typeof raw !== "string" || raw.length < 1 || raw.length > 128) invalid();
	for (let at = 0; at < raw.length; at++) {
		const code = raw.charCodeAt(at);
		if (code < 33 || code > 126) invalid();
	}
	return raw;
}
function frame(wire: unknown): { raw: unknown; type: string; envelopeId?: string } {
	if (
		typeof wire !== "string" ||
		wire.length > HOST_MAX_WS_DATA_LENGTH ||
		Buffer.byteLength(wire) > HOST_MAX_FRAME_BYTES
	)
		invalid();
	const raw: unknown = JSON.parse(wire);
	// Payload fields are deliberately not selected before the acknowledgement.
	const fields = record(raw, ["type", "envelope_id"]);
	const type = id(fields.type);
	if (!Object.hasOwn(fields, "envelope_id")) {
		if (type !== "hello" && type !== "disconnect") invalid();
		return { raw, type };
	}
	return { raw, type, envelopeId: id(fields.envelope_id) };
}
function eventId(raw: unknown): string {
	const payload = record(raw, ["payload"]).payload;
	const fields = record(payload, ["event_id", "event"]);
	const event = record(fields.event, ["type"]);
	id(event.type);
	return id(fields.event_id);
}

/**
 * Process already-delivered Socket Mode data during an existing SDK call scope.
 * No connection, subscription, credential, lease or native authority is created.
 * Successful notifications are remembered only within the bounded insertion window.
 */
export function createSlackSocketProcessor(
	ctx: Pick<PluginContext, "signal" | "changed">,
	socket: Pick<HostSocket, "sendAck">,
	options?: SlackSocketProcessorOptions,
): SlackSocketProcessor {
	const context = record(ctx, ["signal", "changed"]);
	const transport = record(socket, ["sendAck"]);
	const config = options === undefined ? {} : record(options, ["maxRememberedEvents"]);
	const maximum = rememberedLimit(config.maxRememberedEvents);
	if (
		typeof context.changed !== "function" ||
		isProxy(context.changed) ||
		typeof transport.sendAck !== "function" ||
		isProxy(transport.sendAck) ||
		context.signal === null ||
		typeof context.signal !== "object" ||
		isProxy(context.signal)
	)
		invalid();
	const signal = context.signal as AbortSignal;
	try {
		Reflect.get(AbortSignal.prototype, "aborted", signal);
	} catch {
		invalid();
	}
	const changed = context.changed as PluginContext["changed"];
	const ack = transport.sendAck as HostSocket["sendAck"];
	const remembered = new Set<string>();
	const pending = new Map<string, Promise<void>>();
	let receiving = 0;
	let disposed = false;
	function active(): void {
		if (disposed || Reflect.get(AbortSignal.prototype, "aborted", signal)) {
			throw new Error("SLACK_SOCKET_ABORTED");
		}
	}
	function dispose(): void {
		if (disposed) return;
		disposed = true;
		remembered.clear();
		Reflect.apply(EventTarget.prototype.removeEventListener, signal, ["abort", dispose]);
	}
	active();
	Reflect.apply(EventTarget.prototype.addEventListener, signal, ["abort", dispose, { once: true }]);

	async function notifyOnce(identity: string): Promise<SlackSocketResult> {
		if (remembered.has(identity)) return "duplicate";
		const existing = pending.get(identity);
		if (existing !== undefined) {
			await existing;
			active();
			return "duplicate";
		}
		// Reserve identity before entering even a synchronously reentrant notifier.
		const operation = Promise.resolve().then(async () => {
			active();
			await Reflect.apply(changed, ctx, []);
			active();
			remembered.add(identity);
			if (remembered.size > maximum) {
				const oldest = remembered.values().next().value;
				if (oldest !== undefined) remembered.delete(oldest);
			}
		});
		pending.set(identity, operation);
		try {
			await operation;
			return "notified";
		} finally {
			if (pending.get(identity) === operation) pending.delete(identity);
		}
	}
	async function receive(wire: unknown): Promise<SlackSocketResult> {
		active();
		if (receiving >= HOST_MAX_ACTIVE_REQUESTS) invalid();
		receiving++;
		try {
			const envelope = frame(wire);
			if (envelope.envelopeId === undefined) return "ignored";
			await Reflect.apply(ack, socket, [envelope.envelopeId]);
			active();
			if (envelope.type !== "events_api") return "ignored";
			return await notifyOnce(eventId(envelope.raw));
		} catch {
			active();
			invalid();
		} finally {
			receiving--;
		}
	}
	return Object.freeze({ receive, dispose });
}
