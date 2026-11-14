import { isPromise, isProxy } from "node:util/types";
import { type JSONRPCMessage, parseJSONRPCMessage } from "@modelcontextprotocol/client";

export class PluginResponseError extends Error {
	override readonly name = "PluginResponseError";
	readonly code = "PLUGIN_RESPONSE_UNAVAILABLE";
	constructor() {
		super("Plugin response unavailable");
	}
}

export type PluginResponseId = Extract<JSONRPCMessage, { method: string; id: unknown }>["id"];

export interface PluginResponseReceipt {
	readonly id: PluginResponseId;
	/** An actual matching logical response was observed; no response payload is retained. */
	readonly response: Promise<void>;
}

export interface PluginResponseTracker {
	trackOutgoing(raw: unknown): PluginResponseReceipt | undefined;
	receiveIncoming(raw: unknown): boolean;
	/** Stop new request reservations while preserving late responses. */
	fence(): void;
	/** Fence synchronously and return the same original retirement join every time. */
	retire(): Promise<void>;
}

const MAX_PENDING = 64;
const MAX_PASSIVE_NODES = 1_048_576;
const then = Promise.prototype.then;

function unavailable(): never {
	throw new PluginResponseError();
}

// SDK objects and decoded JSON must not run accessors while being classified.
// This is a bounded passive-data check, not another MCP schema or provenance check.
function message(raw: unknown): JSONRPCMessage {
	const active = new WeakSet<object>();
	const checked = new WeakSet<object>();
	const stack: { value: unknown; leave?: boolean }[] = [{ value: raw }];
	let nodes = 1;
	try {
		while (stack.length) {
			const item = stack.pop();
			if (!item) unavailable();
			const value = item.value;
			if (item.leave) {
				active.delete(value as object);
				checked.add(value as object);
				continue;
			}
			if (typeof value === "function" || typeof value === "symbol" || typeof value === "bigint")
				unavailable();
			if (value === null || typeof value !== "object") continue;
			if (isProxy(value) || active.has(value)) unavailable();
			if (checked.has(value)) continue;
			const prototype = Object.getPrototypeOf(value);
			if (
				prototype !== null &&
				prototype !== Object.prototype &&
				!(Array.isArray(value) && prototype === Array.prototype)
			)
				unavailable();
			active.add(value);
			stack.push({ value, leave: true });
			const descriptors = Object.getOwnPropertyDescriptors(value);
			const keys = Reflect.ownKeys(descriptors);
			if (keys.length > MAX_PASSIVE_NODES - nodes) unavailable();
			nodes += keys.length;
			for (const key of keys) {
				if (typeof key !== "string") unavailable();
				const descriptor = descriptors[key];
				if (!descriptor || !Object.hasOwn(descriptor, "value")) unavailable();
				stack.push({ value: descriptor.value });
			}
		}
		return parseJSONRPCMessage(raw);
	} catch {
		unavailable();
	}
}

interface PendingResponse {
	readonly receipt: PluginResponseReceipt;
	readonly resolve: () => void;
	readonly reject: (error: PluginResponseError) => void;
}

/**
 * Internal logical accounting only. Bind the ORIGINAL combined producer for owned-process
 * closure, IO completion and BOTH read pumps retiring after their buffered input is consumed.
 * Neither a type, stdout EOF, SDK close nor a caller's abort establishes that provenance.
 * The caller starts its original cleanup before awaiting retire(); this tracker stops no process.
 * A logical response says nothing about handler/background work or parent host-job completion.
 * Only active IDs are retained. Settled-ID reuse cannot distinguish a delayed old duplicate
 * from a new reply with that ID; it creates no replay or handler-completion guarantee.
 */
export function createPluginResponseTracker(
	originalReadAndProcessRetired: Promise<void>,
): PluginResponseTracker {
	if (
		!isPromise(originalReadAndProcessRetired) ||
		Object.getPrototypeOf(originalReadAndProcessRetired) !== Promise.prototype ||
		Object.hasOwn(originalReadAndProcessRetired, "constructor")
	)
		unavailable();
	const pending = new Map<PluginResponseId, PendingResponse>();
	let fenced = false;
	let resolveRetired!: () => void;
	let rejectRetired!: (error: PluginResponseError) => void;
	const retired = new Promise<void>((resolve, reject) => {
		resolveRetired = resolve;
		rejectRetired = reject;
	});
	void Promise.allSettled([retired]);

	function fence(): void {
		fenced = true;
	}
	function retire(): Promise<void> {
		fence();
		return retired;
	}
	function knownEnd(): void {
		fence();
		const originalReceipts = [...pending.values()];
		pending.clear();
		for (const entry of originalReceipts) entry.reject(new PluginResponseError());
		void Promise.allSettled([
			then.call(
				Promise.allSettled(originalReceipts.map((entry) => entry.receipt.response)),
				() => resolveRetired(),
				() => rejectRetired(new PluginResponseError()),
			),
		]);
	}
	function unknownEnd(): void {
		fence();
		// A failed producer proves no end: retain unmatched receipts, including late matches.
		rejectRetired(new PluginResponseError());
	}
	void Promise.allSettled([then.call(originalReadAndProcessRetired, knownEnd, unknownEnd)]);

	return Object.freeze({
		trackOutgoing(raw: unknown): PluginResponseReceipt | undefined {
			const parsed = message(raw);
			if (!("method" in parsed) || !("id" in parsed)) return undefined;
			if (fenced || pending.has(parsed.id) || pending.size >= MAX_PENDING) unavailable();
			let resolve!: () => void;
			let reject!: (error: PluginResponseError) => void;
			const response = new Promise<void>((yes, no) => {
				resolve = yes;
				reject = no;
			});
			void Promise.allSettled([response]);
			const receipt = Object.freeze({ id: parsed.id, response });
			pending.set(parsed.id, { receipt, resolve, reject });
			return receipt;
		},
		receiveIncoming(raw: unknown): boolean {
			const parsed = message(raw);
			if ("method" in parsed || parsed.id === undefined) return false;
			const entry = pending.get(parsed.id);
			if (!entry) return false;
			pending.delete(parsed.id);
			entry.resolve();
			return true;
		},
		fence,
		retire,
	});
}
