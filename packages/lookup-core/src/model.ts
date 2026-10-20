import type {
	OwnerSettings,
	RoutingDestination,
	ToolInstance as StoredToolInstance,
	WorkingHours as StoredWorkingHours,
	ToolDestination,
	TrainingPosture,
} from "@draftyak/protocol/entities";
import type {
	ContextPreset,
	ContextPresetItem,
	PresetChannel,
	ToolArgumentsV1,
	ToolKind,
} from "@draftyak/protocol/tool-v1";

type ReadonlyData<T> = T extends readonly (infer Item)[]
	? readonly ReadonlyData<Item>[]
	: T extends object
		? { readonly [Key in keyof T]: ReadonlyData<T[Key]> }
		: T;

export type Channel = PresetChannel;
export type { ToolDestination, TrainingPosture };
export type Sensitivity = "normal" | "otp" | "shortcode" | "alnum";
export type DestinationClass = RoutingDestination;

/** Native channel shape; the hub supplies verified metadata. */
export function isChannel(value: unknown): value is Channel {
	if (typeof value === "string") return ["gmail", "slack", "sms"].includes(value);
	if (!value || typeof value !== "object" || Array.isArray(value)) return false;
	const plugin = (value as { plugin?: unknown }).plugin;
	return (
		Object.keys(value).length === 1 &&
		Object.keys(value)[0] === "plugin" &&
		typeof plugin === "string" &&
		plugin.length > 0
	);
}
export interface VerifiedThreadMeta {
	readonly account: string;
	readonly channel: Channel;
	readonly sender?:
		| {
				readonly kind: "gmail";
				readonly address: string;
				readonly topmostDmarc: "pass" | "fail";
				readonly aligned: boolean;
				readonly singleFrom: boolean;
		  }
		| { readonly kind: "slack"; readonly userId: string; readonly isBot: boolean };
	/** A To/Cc recipient chosen by the owner in a hub-verified outbound send; may be external. */
	readonly ownerRecipient?: string;
	readonly sensitivity?: Sensitivity;
	readonly automatic?: {
		readonly directToOwner: boolean;
		readonly knownContact: boolean;
		readonly bulk: boolean;
		readonly list: boolean;
		readonly noReply: boolean;
	};
}
export type WorkingHours = ReadonlyData<StoredWorkingHours>;
export type OwnerState = ReadonlyData<OwnerSettings>;
export type ToolInstance = ReadonlyData<StoredToolInstance> & {
	readonly approvedDigest: string;
	readonly currentDigest: string;
	readonly currentFieldsDigest: string;
	readonly currentDisclosureVersion: number;
	readonly outputMaxBytes: Readonly<Partial<Record<ToolKind, number>>>;
};
export interface LookupConsent {
	readonly account: string;
	readonly instance: string;
	readonly aiDestination: string;
	readonly active: boolean;
	readonly revoked: boolean;
	readonly kinds: readonly ToolKind[];
	readonly fieldsDigest: string;
	readonly disclosureVersion: number;
}
export interface RouteQuery {
	readonly phase: "arguments" | "result";
	readonly account: string;
	readonly channel: Channel;
	readonly classes: readonly string[];
	readonly target: string;
	readonly destinationClass: DestinationClass;
	readonly toolPosture: TrainingPosture;
	readonly effect: "lookup" | "prompt";
	readonly sensitivity: Sensitivity;
}
export interface OwnerConfig {
	readonly owner: OwnerState;
	readonly presets: readonly ContextPreset[];
	readonly instances: readonly ToolInstance[];
	readonly consents: readonly LookupConsent[];
	readonly aiDestination: string;
	readonly aiDestinationClass: DestinationClass;
	readonly route: (query: RouteQuery) => boolean;
}
export interface DraftConfirmation {
	readonly jobId: string;
	readonly account: string;
	readonly argumentDigests: readonly string[];
}
export interface LookupTrigger {
	readonly kind: "on-demand" | "automatic" | "mcp" | "scheduled-claim";
	readonly jobId: string;
	readonly presetId?: string;
	readonly disabledItems?: readonly number[];
	readonly confirmation?: DraftConfirmation;
}
export interface PlannedLookup {
	readonly ref: "c1" | "c2" | "c3";
	readonly jobId: string;
	readonly account: string;
	readonly channel: Channel;
	readonly aiDestination: string;
	readonly instance: ToolInstance;
	readonly kind: ToolKind;
	readonly arguments: ToolArgumentsV1[ToolKind];
	readonly argumentDigest: string;
	readonly messageDerived: boolean;
	readonly slackDerived: boolean;
	readonly owner: OwnerState;
}
export type SkipReason =
	| "TRIGGER_REFUSED"
	| "SENSITIVE"
	| "AUTOMATIC_INELIGIBLE"
	| "DISABLED"
	| "BINDING_UNAVAILABLE"
	| "INSTANCE_UNAVAILABLE"
	| "CONSENT_REQUIRED"
	| "ROUTE_REFUSED"
	| "CONFIRMATION_REQUIRED"
	| "DUPLICATE";
export interface LookupPlan {
	readonly jobId: string;
	readonly trigger: LookupTrigger["kind"];
	readonly calls: readonly PlannedLookup[];
	readonly skipped: readonly { readonly index: number; readonly reason: SkipReason }[];
	readonly pendingConfirmations: readonly PendingLookupConfirmation[];
}
export interface PendingLookupConfirmation {
	readonly index: number;
	readonly instance: string;
	readonly kind: ToolKind;
	readonly boundFields: readonly string[];
	readonly argumentDigest: string;
}
export class LookupError extends Error {
	readonly code: string;
	constructor(code: string) {
		super(code);
		this.name = "LookupError";
		this.code = code;
	}
}
export type PresetItem = ContextPresetItem;
