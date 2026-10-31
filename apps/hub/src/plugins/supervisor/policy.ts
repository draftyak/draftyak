import { MAX_LEASE_MS } from "@draftyak/protocol/channel-v1";

export const STARTUP_MS = 10_000;
export const CALL_MS = 30_000;
export const SYNC_MS = 120_000;
export const CANCEL_GRACE_MS = 5_000;
export const MAX_ADMITTED_CALLS = 16;
export const LIVENESS_INTERVAL_MS = 60_000;
export const LIVENESS_TIMEOUT_MS = 10_000;
export const IDLE_MS = 600_000;
export const LEASE_MIN_MS = 1_000;
export const LEASE_MAX_MS: number = MAX_LEASE_MS;
export const MAX_UNSCOPED_LEASES = 16;
export const RSS_LIMIT_BYTES = 536_870_912;
export const RSS_INTERVAL_MS = 5_000;
export const READING_TIMEOUT_MS = 2_000;
export const CRASH_LIMIT = 5;
export const CRASH_WINDOW_MS = 600_000;
export const KILL_CONFIRM_MS = 5_000;
export const COMPLETION_MS = 2_000;
/** How long a stop, retire, revoke or close waits for one process: kill, completion, destroys. */
export const END_BOUND_MS: number = KILL_CONFIRM_MS + 3 * COMPLETION_MS;
export const STDERR_LIMIT_BYTES = 1_048_576;
export const MAX_STDIN_FRAMES = 32;
/** Host streams (host/fetch with stream: true, host/ws.open) open at once per process. */
export const MAX_HOST_STREAMS = 16;

/** The longest deadline a call may have: channel_sync gets two minutes, every other tool 30 s. */
export function callLimitMs(toolName: string): number {
	return toolName === "channel_sync" ? SYNC_MS : CALL_MS;
}

export type ViolationKind =
	| "oversize"
	| "empty-line"
	| "parse-error"
	| "not-jsonrpc"
	| "handle"
	| "internal-message"
	| "unexpected-frame"
	| "bad-host-frame"
	| "unterminated"
	| "host-limit";

export type CrashReason =
	| "exit"
	| "spawn"
	| `violation:${ViolationKind}`
	| "memory-limit"
	| "memory-unobservable"
	| "call-timeout"
	| "start-timeout"
	| "surface"
	| "liveness"
	| "stderr-limit"
	| "cleanup";

/**
 * Why the supervisor itself ended a process: never counted as a crash (ADR 0013). "cancel" is the
 * kill after a caller's cancellation went unanswered, as an MCP server is told to leave it.
 */
export type StopReason = "idle" | "stop" | "cancel" | "retire" | "revoke" | "close";

export type ActivationRevokeReason =
	| "disable"
	| "quarantine"
	| "upgrade"
	| "uninstall"
	| "shutdown";
export type LocalRevokeReason = "crash-limit" | "surface" | "bundle" | "epoch";

export type SupervisorEventType =
	| "spawned"
	| "ready"
	| "stopped"
	| "crashed"
	| "disabled"
	| "revoked"
	| "held-writer"
	| "cleanup-failed"
	| "kill-unconfirmed"
	| "memory-reader-fallback";

export type SupervisorEventReason =
	| CrashReason
	| StopReason
	| ActivationRevokeReason
	| LocalRevokeReason;

/** Content-free: identities and fixed reasons only, never paths, argv, env, output or params. */
export type SupervisorEvent =
	| { readonly type: "memory-reader-fallback" }
	| {
			readonly type: Exclude<SupervisorEventType, "memory-reader-fallback">;
			readonly pluginId: string;
			readonly generation: string;
			readonly instanceId?: string;
			readonly reason?: SupervisorEventReason;
	  };

export type PluginEventType = Exclude<SupervisorEventType, "memory-reader-fallback">;

/** Sliding window of monotonic crash times for one activation. */
export class CrashWindow {
	readonly #times: number[] = [];

	/** Records one crash; true once CRASH_LIMIT crashes fall within CRASH_WINDOW_MS. */
	record(now: number): boolean {
		this.#times.push(now);
		while (this.#times.length > 0 && !(now - (this.#times[0] as number) < CRASH_WINDOW_MS))
			this.#times.shift();
		return this.#times.length >= CRASH_LIMIT;
	}
}
