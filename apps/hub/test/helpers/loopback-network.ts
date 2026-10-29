interface NativeLoopbackGuard {
	readonly denialCode: number;
	assertActive(): void;
	loopbackAddress(address: unknown): boolean;
	restrictConnect(original: (...args: unknown[]) => unknown): (...args: unknown[]) => unknown;
}

/** Require the native-operation preload at process startup, before any DNS import. */
export function requireLoopbackNetworkGuard(): NativeLoopbackGuard {
	const require = createRequire(import.meta.url);
	// Vitest isolates globalThis; read only an already loaded preload, never load it late.
	const guard = require.cache[require.resolve("./loopback-preload.cjs")]?.exports as
		| NativeLoopbackGuard
		| undefined;
	if (!guard || !Object.isFrozen(guard)) throw new Error("Test loopback preload is required");
	guard.assertActive();
	return guard;
}

import { createRequire } from "node:module";
