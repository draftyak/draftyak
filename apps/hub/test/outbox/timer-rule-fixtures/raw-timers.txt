// Each line marked "raw timer" must get the plugin's diagnostic.
import { scheduler } from "node:timers/promises"; // raw timer
import * as timers from "timers"; // raw timer
import { setTimeout as sleep } from "timers/promises"; // raw timer
export { setTimeout as wait } from "node:timers/promises"; // raw timer
export * from "timers/promises"; // raw timer
import legacyTimers = require("node:timers"); // raw timer

const legacy = require("node:timers"); // raw timer
const loaded = module.require(`node:timers`); // raw timer
const builtin = process.getBuiltinModule("node:timers/promises"); // raw timer
const loader = process.getBuiltinModule; // raw timer
const anyModule = createRequire(import.meta.url); // raw timer

export async function claimLater(notBefore: number, claim: () => void): Promise<void> {
	setTimeout(claim, notBefore - Date.now()); // raw timer
	setInterval(claim, 15_000); // raw timer
	globalThis.setInterval(claim, 15_000); // raw timer
	const scope = globalThis; // raw timer
	const signal = AbortSignal.timeout(notBefore - Date.now()); // raw timer
	const optional = AbortSignal?.timeout(1_000); // raw timer
	const optionalCall = AbortSignal.timeout?.(1_000); // raw timer
	const computed = AbortSignal["timeout"](1_000); // raw timer
	const { timeout } = AbortSignal; // raw timer
	const host = global; // raw timer
	host["setTimeout"](claim, 1_000); // raw timer
	const later = await import("node:timers/promises" as string); // raw timer
	const templated = await import(`node:timers/promises`); // raw timer
	await Atomics.waitAsync(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 1_000).value; // raw timer
	const socket = { setTimeout: (ms: number) => ms }; // raw timer: the name is banned anywhere
	await sleep(1_000);
	await scheduler.wait(1_000);
	void [timers, legacyTimers, legacy, loaded, builtin, loader, anyModule, scope, signal, optional];
	void [optionalCall, computed, timeout, later, templated, socket];
}
