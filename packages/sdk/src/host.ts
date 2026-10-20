import {
	HOST_MAX_ACTIVE_REQUESTS,
	HOST_REQUEST_TIMEOUT_MS,
	type HostErrorCode,
	type HostMethod,
	type HostMethods,
	HostNotification,
	jsonCopy,
	parseHostParams,
	parseHostResult,
} from "@draftyak/protocol/host-channel";

export class HostError extends Error {
	readonly code: HostErrorCode;
	constructor(code: HostErrorCode) {
		super(`Host channel: ${code}`);
		this.code = code;
	}
}
export interface HostRequestOptions {
	readonly signal?: AbortSignal;
	readonly timeoutMs?: number;
}
export interface HostChannel {
	request<M extends HostMethod>(
		method: M,
		params: HostMethods[M]["params"],
		options?: HostRequestOptions,
	): Promise<HostMethods[M]["result"]>;
	subscribe(listener: (notification: HostNotification) => void, onclose?: () => void): () => void;
	close(): void;
}
export type HostHandler = (
	method: HostMethod,
	params: unknown,
	signal: AbortSignal,
) => unknown | Promise<unknown>;
export interface MemoryHost extends HostChannel {
	notify(notification: HostNotification): void;
}

export function memoryHost(handler: HostHandler): MemoryHost {
	let closed = false;
	const active = new Set<AbortController>();
	const subscriptions = new Set<{
		readonly listener: (notification: HostNotification) => void;
		readonly onclose: (() => void) | undefined;
	}>();
	return {
		async request(method, params, options = {}) {
			if (closed || options.signal?.aborted) throw new HostError("DENIED");
			if (active.size >= HOST_MAX_ACTIVE_REQUESTS) throw new HostError("TOO_LARGE");
			let parsed: unknown;
			try {
				parsed = parseHostParams(method, params);
			} catch {
				throw new HostError("BAD_REQUEST");
			}
			const controller = new AbortController();
			active.add(controller);
			const timeoutMs = options.timeoutMs ?? HOST_REQUEST_TIMEOUT_MS;
			if (!Number.isFinite(timeoutMs) || timeoutMs <= 0 || timeoutMs > HOST_REQUEST_TIMEOUT_MS) {
				active.delete(controller);
				throw new HostError("BAD_REQUEST");
			}
			const abort = (): void => controller.abort(new HostError("DENIED"));
			options.signal?.addEventListener("abort", abort, { once: true });
			const timer = setTimeout(() => controller.abort(new HostError("TIMEOUT")), timeoutMs);
			try {
				const value = await Promise.race([
					Promise.resolve().then(() => {
						if (controller.signal.aborted) throw controller.signal.reason;
						return handler(method, parsed, controller.signal);
					}),
					new Promise<never>((_, reject) =>
						controller.signal.addEventListener("abort", () => reject(controller.signal.reason), {
							once: true,
						}),
					),
				]);
				if (controller.signal.aborted) throw controller.signal.reason;
				try {
					return parseHostResult(method, value);
				} catch {
					throw new HostError("BAD_REQUEST");
				}
			} finally {
				clearTimeout(timer);
				options.signal?.removeEventListener("abort", abort);
				active.delete(controller);
			}
		},
		subscribe(listener, onclose) {
			if (closed) throw new HostError("DENIED");
			const subscription = { listener, onclose };
			subscriptions.add(subscription);
			return () => {
				subscriptions.delete(subscription);
			};
		},
		notify(notification) {
			const value = HostNotification.parse(jsonCopy(notification));
			for (const subscription of [...subscriptions]) {
				if (closed) break;
				try {
					subscription.listener(value);
				} catch {
					/* One callback cannot suppress another subscription's control frame. */
				}
			}
		},
		close() {
			if (closed) return;
			closed = true;
			const closing = [...subscriptions];
			subscriptions.clear();
			for (const controller of active) controller.abort(new HostError("DENIED"));
			for (const subscription of closing) {
				try {
					subscription.onclose?.();
				} catch {
					/* Cleanup still reaches every subscription. */
				}
			}
		},
	};
}
