import { AsyncLocalStorage } from "node:async_hooks";
import type { LookupOptions } from "node:dns";
import type { PinnedAddress } from "./addresses.ts";

/** Internal fixture seam; absent from package exports and configuration. */
export interface NetworkTestHooks {
	readonly resolve?: (host: string, signal: AbortSignal) => Promise<readonly PinnedAddress[]>;
	readonly dial?: (pin: PinnedAddress, port: number) => PinnedAddress & { readonly port: number };
	readonly ca?: string;
	readonly lookupObserved?: (options: Pick<LookupOptions, "family" | "hints">) => void;
}
const context = new AsyncLocalStorage<NetworkTestHooks>();
export function networkTestHooks(): NetworkTestHooks | undefined {
	return context.getStore();
}
export function withNetworkTestHooks<T>(hooks: NetworkTestHooks, run: () => T): T {
	return context.run(Object.freeze({ ...hooks }), run);
}
