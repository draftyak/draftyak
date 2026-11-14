import { performance } from "node:perf_hooks";

export interface PluginCrashBudget {
	readonly disabled: boolean;
	/** Returns the disabled state after recording one actual crash. */
	recordCrash(): boolean;
}

const WINDOW_MS = 10 * 60 * 1000;
const CRASH_LIMIT = 5;

/** Retain one budget across process restarts. This deny-only DATA never authorizes launch. */
export function createPluginCrashBudget(): PluginCrashBudget {
	const crashes: number[] = [];
	let disabled = false;
	const disable = (): true => {
		disabled = true;
		crashes.length = 0;
		return true;
	};
	return Object.freeze({
		get disabled(): boolean {
			return disabled;
		},
		recordCrash(): boolean {
			if (disabled) return true;
			try {
				const now = performance.now();
				const latest = crashes[crashes.length - 1];
				if (!Number.isFinite(now) || now < 0 || (latest !== undefined && now < latest)) {
					return disable();
				}
				// Expire the exact old boundary: the retained window is (now - WINDOW_MS, now].
				const cutoff = now - WINDOW_MS;
				while (crashes.length) {
					const oldest = crashes[0];
					if (oldest === undefined || oldest > cutoff) break;
					crashes.shift();
				}
				crashes.push(now);
				disabled = crashes.length >= CRASH_LIMIT;
				return disabled;
			} catch {
				return disable();
			}
		},
	});
}
