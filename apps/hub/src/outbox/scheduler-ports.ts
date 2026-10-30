import type { AccountMode, ChatChannelType } from "@draftyak/protocol/entities/common";
import type { BrokerDateSample, SendWindowMs } from "./scheduler-rules.ts";
import type { SendAttempt } from "./ticket-storage.ts";

export type SchedulerErrorCode =
	| "INVALID_INPUT"
	| "SCHEDULING_UNAVAILABLE"
	| "NONEXISTENT_LOCAL_TIME"
	| "AMBIGUOUS_LOCAL_TIME"
	| "SCHEDULE_LIMIT"
	| "SCHEDULER_CONFIG"
	| "SCHEDULER_STATE"
	| "SCHEDULER_DATA"
	| "SCHEDULER_STORE";

export class SchedulerError extends Error {
	readonly code: SchedulerErrorCode;
	constructor(code: SchedulerErrorCode) {
		super(code);
		this.name = "SchedulerError";
		this.code = code;
	}
}

/** Read synchronously at every tick start and before every store read, write and claim call. */
export interface SchedulerGate {
	state(): "running" | "paused";
}

/** Native account mode; with no provider every account reads "unavailable" and nothing claims. */
export interface AccountModes {
	mode(accountId: string): AccountMode | "unavailable";
}

export interface PreclaimTarget {
	/** Fresh per read; the broker binds its Date sample to it. */
	readonly readId: string;
	readonly outboxId: string;
	readonly accountId: string;
	readonly kind: "email" | "chat";
	readonly conversationId: string | null;
	/** Integer microseconds since the epoch (watermarkMicros). */
	readonly inboundWatermark: number | null;
	readonly email?: { readonly threadId?: string };
	readonly chat?: {
		readonly channelId: string;
		readonly threadTs?: string;
		readonly channelName: string;
		readonly channelType: ChatChannelType;
		readonly external: boolean;
		readonly shared: boolean;
		readonly memberCount: number;
	};
}

export interface PreclaimObservation {
	/** Minted by the broker only, bound to target.readId. */
	readonly date: BrokerDateSample;
	/** The bounded read covered everything since the watermark. */
	readonly complete: boolean;
	/** The adapter's frozen-chat comparison; email reports "unchanged". */
	readonly facts: "unchanged" | "changed" | "unknown";
	/** Raw provider timestamp of the newest hub-classified inbound message. */
	readonly newestInbound: string | null;
}

export type PreclaimReader = (
	target: PreclaimTarget,
	signal: AbortSignal,
) => Promise<PreclaimObservation>;

export interface PreflightTarget {
	readonly readId: string;
	readonly accountId: string;
	readonly outboxIds: readonly string[];
	readonly earliestNotBefore: number;
}

export type PreflightResult =
	| { readonly ok: true; readonly date?: BrokerDateSample }
	| {
			readonly ok: false;
			readonly failure: "auth" | "probe" | "quota" | "clock" | "unavailable";
	  };

export type PreflightHook = (
	target: PreflightTarget,
	signal: AbortSignal,
) => Promise<PreflightResult>;

export interface ChannelHooks {
	readonly preclaim: PreclaimReader;
	readonly preflight?: PreflightHook;
}

export interface ClaimRequest {
	readonly outboxId: string;
	readonly accountId: string;
	readonly from: "APPROVED" | "SCHEDULED" | "RETRY_WAIT";
	/**
	 * The item's effective window. An immediate item's notBefore is its final approvedAt plus the
	 * frozen undo window, a scheduled item's is the frozen schedule instant, and deliverBy is the
	 * minimum signed deliverBy of the counted approvals, never extended. These are the values the
	 * send-ticket binding stores as notBefore and deliverBy.
	 */
	readonly window: SendWindowMs;
	/** Null only for an APPROVED item's first claim, which uses the hub clock. */
	readonly second: BrokerDateSample | null;
	/** What this check admitted; the claim recomputes both. */
	readonly checked: { readonly early: number; readonly late: number };
	/** Observed, in provider form; the claim rechecks it against the stored watermark. */
	readonly newestInbound: string | null;
}

export type ClaimResult =
	/** The one send attempt the claim created for this outbox id. */
	| { readonly kind: "claimed"; readonly attempt: SendAttempt }
	/** "fenced": the outbox id already has a send attempt, so it is never claimed again. */
	| { readonly kind: "refused"; readonly reason: "state" | "window" | "voided" | "fenced" }
	| { readonly kind: "busy"; readonly retryInMs: number };

/** SendPolicy outside any transaction, then one synchronous BEGIN IMMEDIATE; no request inside. */
export interface ClaimPort {
	claim(request: ClaimRequest, signal: AbortSignal): Promise<ClaimResult>;
}

export type HoldKind = "skew" | "clock" | "read" | "account" | "preflight" | "data";

export interface HoldView {
	readonly outboxId: string | null;
	readonly accountId: string;
	readonly kind: HoldKind;
	readonly scope: "item" | "account";
	readonly sinceWall: number;
}
