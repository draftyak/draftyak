import { AsyncLocalStorage } from "node:async_hooks";
import type { LookupOptions } from "node:dns";
import type { PinnedAddress } from "./addresses.ts";

export interface NetworkAttempt {
	readonly signal: AbortSignal;
	readonly settled: Promise<void>;
	policyAllowed(): void;
	policyRefused(): void;
	resolved(): void;
	succeeded(): void;
	failed(): void;
}
interface AttemptBinding {
	readonly attempt: NetworkAttempt;
	readonly host: string;
	readonly port: number;
	consumed: boolean;
}
/** Internal fixture seam; absent from package exports and configuration. */
export interface NetworkTestHooks {
	readonly resolve?: (host: string, signal: AbortSignal) => Promise<readonly PinnedAddress[]>;
	readonly dial?: (pin: PinnedAddress, port: number) => PinnedAddress & { readonly port: number };
	readonly ca?: string;
	readonly lookupObserved?: (options: Pick<LookupOptions, "family" | "hints">) => void;
	readonly observer?: {
		beginAttempt(
			target: { host: string; port: number; transport: "tcp" },
			timeoutMs?: number,
		): NetworkAttempt;
		fail(): void;
	};
	readonly observationTimeoutMs?: number;
}
interface Context {
	readonly hooks: NetworkTestHooks;
	readonly pins: WeakMap<object, AttemptBinding>;
}
const context = new AsyncLocalStorage<Context>();
export function networkTestHooks(): NetworkTestHooks | undefined {
	return process.env.NODE_ENV === "test" && process.env.VITEST === "true"
		? context.getStore()?.hooks
		: undefined;
}
export function beginNetworkAttempt(host: string, port: number): NetworkAttempt | undefined {
	const hooks = networkTestHooks();
	return hooks?.observer?.beginAttempt(
		{ host, port, transport: "tcp" },
		hooks.observationTimeoutMs,
	);
}
export function rememberNetworkAttempt(
	pins: readonly PinnedAddress[],
	host: string,
	port: number,
	attempt: NetworkAttempt | undefined,
): void {
	if (!attempt || !networkTestHooks()) return;
	const binding: AttemptBinding = { attempt, host, port, consumed: false };
	for (const pin of pins) context.getStore()?.pins.set(pin, binding);
}
/** Validation copies preserve observation identity without consuming it or changing policy. */
export function copyNetworkAttempt(from: PinnedAddress, to: PinnedAddress): void {
	if (!networkTestHooks()) return;
	const state = context.getStore(),
		binding = state?.pins.get(from);
	if (binding) state?.pins.set(to, binding);
}
export function takeNetworkAttempt(
	host: string,
	port: number,
	pin: PinnedAddress,
):
	| {
			readonly attempt: NetworkAttempt;
			readonly resolved: boolean;
	  }
	| undefined {
	const hooks = networkTestHooks();
	if (!hooks?.observer) return undefined;
	const binding = context.getStore()?.pins.get(pin);
	if (!binding)
		return {
			attempt: hooks.observer.beginAttempt(
				{ host, port, transport: "tcp" },
				hooks.observationTimeoutMs,
			),
			resolved: false,
		};
	if (
		binding.consumed ||
		binding.host !== host ||
		binding.port !== port ||
		binding.attempt.signal.aborted
	) {
		hooks.observer.fail();
		throw new Error("Network request refused");
	}
	binding.consumed = true;
	return { attempt: binding.attempt, resolved: true };
}
export function withNetworkTestHooks<T>(hooks: NetworkTestHooks, run: () => T): T {
	if (process.env.NODE_ENV !== "test" || process.env.VITEST !== "true")
		throw new Error("Network fixtures require the test profile");
	return context.run({ hooks: Object.freeze({ ...hooks }), pins: new WeakMap() }, run);
}
