import { types } from "node:util";
import {
	DEVICE_API_ROUTES,
	type DeviceApiRoute,
	presetFitsRole,
	requiredCapability,
	routeAllows,
} from "@draftyak/protocol/device-api";
import {
	ConfirmationPreset,
	canConfirm,
	DeviceCapability,
} from "@draftyak/protocol/entities/device";
import { Ulid } from "@draftyak/protocol/scalars";
import { ADMIN_KINDS } from "@draftyak/protocol/statements/admin";
import type { AuthorityState, DeviceFacts } from "../identity/devices.ts";
import { AuthzError, type AuthzErrorCode } from "./errors.ts";

const OPTIONS: readonly DeviceCapability[] = DeviceCapability.options;
export const CAPABILITY_BITS: Readonly<Record<DeviceCapability, number>> = Object.freeze(
	Object.fromEntries(OPTIONS.map((capability, index) => [capability, 1 << index])) as Record<
		DeviceCapability,
		number
	>,
);
const FULL_MASK = (1 << OPTIONS.length) - 1;

/** Own data properties of a plain object, each read once; undefined for anything else. */
export function plainRecord(
	value: unknown,
	required: readonly string[],
	optional: readonly string[] = [],
): Record<string, unknown> | undefined {
	if (value === null || typeof value !== "object" || types.isProxy(value)) return undefined;
	const prototype = Object.getPrototypeOf(value);
	if (prototype !== Object.prototype && prototype !== null) return undefined;
	const keys = Reflect.ownKeys(value);
	const record: Record<string, unknown> = Object.create(null);
	for (const key of keys) {
		if (typeof key !== "string" || (!required.includes(key) && !optional.includes(key)))
			return undefined;
		const descriptor = Object.getOwnPropertyDescriptor(value, key);
		if (!descriptor || !("value" in descriptor)) return undefined;
		record[key] = descriptor.value;
	}
	return required.every((key) => Object.hasOwn(record, key)) ? record : undefined;
}

/** The items of an ordinary dense array of at most `max` items, read without accessors. */
export function plainArray(value: unknown, max: number): unknown[] | undefined {
	if (!Array.isArray(value) || types.isProxy(value)) return undefined;
	if (Object.getPrototypeOf(value) !== Array.prototype) return undefined;
	const length = Object.getOwnPropertyDescriptor(value, "length")?.value;
	if (!Number.isSafeInteger(length) || length > max || Reflect.ownKeys(value).length !== length + 1)
		return undefined;
	const items: unknown[] = [];
	for (let index = 0; index < length; index++) {
		const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
		if (!descriptor || !("value" in descriptor)) return undefined;
		items.push(descriptor.value);
	}
	return items;
}

export function maskOf(capabilities: readonly DeviceCapability[]): number {
	const items = plainArray(capabilities, OPTIONS.length);
	if (!items) throw new AuthzError("CANDIDATE_INVALID");
	let mask = 0;
	for (const item of items) {
		const bit =
			typeof item === "string" && Object.hasOwn(CAPABILITY_BITS, item)
				? CAPABILITY_BITS[item as DeviceCapability]
				: 0;
		if (bit === 0 || (mask & bit) !== 0) throw new AuthzError("CANDIDATE_INVALID");
		mask |= bit;
	}
	return mask;
}

export function capabilitiesOf(mask: number): readonly DeviceCapability[] {
	if (!Number.isSafeInteger(mask) || mask < 0 || mask > FULL_MASK)
		throw new AuthzError("UNAVAILABLE");
	return Object.freeze(OPTIONS.filter((capability) => (mask & CAPABILITY_BITS[capability]) !== 0));
}

/** Exactly routeAllows' peer facts (device-api/catalogue.ts). */
export interface PeerFacts {
	readonly role: string;
	readonly known: boolean;
	readonly revoked: boolean;
	readonly epoch: number;
	readonly confirmedEpoch: number | null;
	readonly capabilities: readonly DeviceCapability[];
	readonly sidecarClaim: boolean;
	readonly bootstrapDone: boolean;
}
const PEER_KEYS = [
	"role",
	"known",
	"revoked",
	"epoch",
	"confirmedEpoch",
	"capabilities",
	"sidecarClaim",
	"bootstrapDone",
] as const;
const counter = (value: unknown): value is number =>
	typeof value === "number" && Number.isSafeInteger(value) && value >= 0;

function readPeer(peer: unknown): PeerFacts | "ROLE_REFUSED" | "UNAVAILABLE" {
	const record = plainRecord(peer, PEER_KEYS);
	if (!record) return "UNAVAILABLE";
	if (record.role !== "device") return "ROLE_REFUSED";
	const held = plainArray(record.capabilities, OPTIONS.length) ?? [undefined];
	const { known, revoked, epoch, confirmedEpoch, sidecarClaim, bootstrapDone } = record;
	if (
		!held.every((item) => typeof item === "string" && OPTIONS.includes(item as DeviceCapability)) ||
		new Set(held).size !== held.length ||
		typeof known !== "boolean" ||
		typeof revoked !== "boolean" ||
		!counter(epoch) ||
		(confirmedEpoch !== null && !counter(confirmedEpoch)) ||
		typeof sidecarClaim !== "boolean" ||
		typeof bootstrapDone !== "boolean"
	)
		return "UNAVAILABLE";
	return Object.freeze({
		role: "device",
		known,
		revoked,
		epoch,
		confirmedEpoch,
		capabilities: Object.freeze(held as DeviceCapability[]),
		sidecarClaim,
		bootstrapDone,
	});
}

const NONE: readonly DeviceCapability[] = Object.freeze([]);
/** Stored capabilities count only while unrevoked and confirmed in the current epoch. */
export function effectiveCapabilities(facts: DeviceFacts): readonly DeviceCapability[] {
	return !facts.revoked && facts.confirmedEpoch === facts.epoch ? facts.storedCapabilities : NONE;
}

export function peerOf(
	facts: DeviceFacts | undefined,
	state: Pick<AuthorityState, "epoch" | "bootstrapDone">,
): PeerFacts {
	if (!facts)
		return Object.freeze({
			role: "device",
			known: false,
			revoked: false,
			epoch: state.epoch,
			confirmedEpoch: null,
			capabilities: NONE,
			sidecarClaim: false,
			bootstrapDone: state.bootstrapDone,
		});
	return Object.freeze({
		role: facts.role,
		known: true,
		revoked: facts.revoked,
		epoch: facts.epoch,
		confirmedEpoch: facts.confirmedEpoch,
		capabilities: effectiveCapabilities(facts),
		// Stricter than M1.26: an older epoch's sidecar claimant never reaches a reopened bootstrap.
		sidecarClaim: facts.window === "sidecar" && facts.pairedEpoch === facts.epoch,
		bootstrapDone: facts.bootstrapDone,
	});
}

export function decideCapability(
	peer: PeerFacts,
	capability: DeviceCapability,
): AuthzErrorCode | undefined {
	const facts = readPeer(peer);
	if (typeof facts === "string") return facts;
	if (!facts.known) return "DEVICE_UNKNOWN";
	if (facts.revoked) return "DEVICE_REVOKED";
	if (facts.confirmedEpoch !== facts.epoch) return "DEVICE_PENDING";
	if (typeof capability !== "string" || !facts.capabilities.includes(capability))
		return "CAPABILITY_MISSING";
	return undefined;
}

/** A preset parsed before it can index CONFIRMATION_PRESETS. */
export function parsePreset(preset: unknown): ConfirmationPreset | undefined {
	return typeof preset === "string" && ConfirmationPreset.safeParse(preset).success
		? (preset as ConfirmationPreset)
		: undefined;
}

/** A current approver whose own capabilities cover everything the preset grants. */
export function approverRefusal(
	approver: PeerFacts,
	preset: ConfirmationPreset | undefined,
): AuthzErrorCode | undefined {
	const refusal = decideCapability(approver, "approve");
	if (refusal) return refusal;
	return preset !== undefined && canConfirm(approver.capabilities, preset)
		? undefined
		: "PRESET_REFUSED";
}

/** A candidate an approver or the CLI may confirm in this epoch. */
export function candidateRefusal(
	candidate: DeviceFacts | undefined,
	epoch: number,
): AuthzErrorCode | undefined {
	if (!candidate) return "DEVICE_UNKNOWN";
	if (candidate.revoked) return "DEVICE_REVOKED";
	if (candidate.confirmedEpoch === epoch) return "CANDIDATE_NOT_PENDING";
	// A sidecar claimant reaches authority only through bootstrap.
	if (candidate.window === "sidecar" && candidate.confirmedEpoch === null)
		return "CANDIDATE_INVALID";
	return undefined;
}

export function presetRefusal(
	preset: ConfirmationPreset,
	role: string,
): AuthzErrorCode | undefined {
	return presetFitsRole(preset, role) ? undefined : "PRESET_REFUSED";
}

const unavailableRoutes: ReadonlySet<string> = new Set(["login", "consent", "agent-session"]);
const unavailableKinds: ReadonlySet<string> = new Set([
	"login",
	"login.v1",
	"consent",
	"consent.v1",
	"agent-session",
	"agent-session.v1",
	"send-receipt.v1",
	"tool.instance-create",
	"tool.secret-set",
	"tool.enable",
	"tool.posture-no-train",
	"access.token-mint",
	"access.grant-widen",
	"access.cimd-host-add",
	"access.exposure-enable",
	"ai.credential-connect",
	"ai.credential-disconnect",
]);
/** Postponed in the pilot; the decisions read private copies of these sets. */
export const PILOT_UNAVAILABLE_ROUTES: ReadonlySet<string> = new Set(unavailableRoutes);
export const PILOT_UNAVAILABLE_KINDS: ReadonlySet<string> = new Set(unavailableKinds);

export function decideKind(peer: PeerFacts, kind: string): AuthzErrorCode | undefined {
	if (typeof kind !== "string") return "KIND_UNKNOWN";
	if (unavailableKinds.has(kind)) return "KIND_UNAVAILABLE";
	const capability = requiredCapability(kind);
	if (capability === undefined) return "KIND_UNKNOWN";
	return decideCapability(peer, capability);
}

interface Operation {
	readonly kind?: string;
	readonly preset?: string;
}
function readOperation(operation: unknown): Operation | undefined {
	if (operation === undefined) return Object.freeze({});
	const record = plainRecord(operation, [], ["kind", "preset"]);
	if (!record) return undefined;
	const context: { kind?: string; preset?: string } = {};
	for (const key of ["kind", "preset"] as const) {
		const value = record[key];
		if (value === undefined) continue;
		if (typeof value !== "string") return undefined;
		context[key] = value;
	}
	return Object.freeze(context);
}
const routeKinds: Readonly<Record<string, readonly string[]>> = Object.freeze({
	"new-operation": Object.freeze(["pair-confirm", ...ADMIN_KINDS]),
	challenge: Object.freeze(["approval.send.v1", "pair-confirm.v1", "agent-session.v1"]),
});

// The refusal code for facts routeAllows has refused.
function routeRefusal(
	route: DeviceApiRoute,
	facts: PeerFacts,
	operation: Operation,
): AuthzErrorCode {
	if (route.confirmation === "sidecar-bootstrap")
		return facts.bootstrapDone ? "BOOTSTRAP_DONE" : "BOOTSTRAP_REFUSED";
	if (!facts.known) return "DEVICE_UNKNOWN";
	if (facts.revoked) return "DEVICE_REVOKED";
	if (route.confirmation === "known") return "CAPABILITY_MISSING";
	if (facts.confirmedEpoch !== facts.epoch) return "DEVICE_PENDING";
	const kind = operation.kind ?? "";
	const kinds = Object.hasOwn(routeKinds, route.id) ? routeKinds[route.id] : undefined;
	if (
		route.capability === "requiredCapability" &&
		(requiredCapability(kind) === undefined || (kinds !== undefined && !kinds.includes(kind)))
	)
		return "KIND_UNKNOWN";
	const capability =
		route.capability === "requiredCapability" ? requiredCapability(kind) : route.capability;
	if (capability === undefined || capability === null || !facts.capabilities.includes(capability))
		return "CAPABILITY_MISSING";
	if (
		route.pairConfirmPolicy &&
		(route.id === "pair-confirmation" || kind === "pair-confirm" || kind === "pair-confirm.v1")
	)
		return "PRESET_REFUSED";
	return "CAPABILITY_MISSING";
}

/** Never more permissive than routeAllows; postponed routes and kinds fail closed first. */
export function decideRoute(
	peer: PeerFacts,
	routeId: string,
	operation?: { readonly kind?: string; readonly preset?: string },
): AuthzErrorCode | undefined {
	const route =
		typeof routeId === "string"
			? DEVICE_API_ROUTES.find((entry) => entry.id === routeId)
			: undefined;
	if (!route) return "ROUTE_UNKNOWN";
	if (unavailableRoutes.has(route.id)) return "ROUTE_UNAVAILABLE";
	const context = readOperation(operation);
	if (!context) return "KIND_UNKNOWN";
	if (context.kind !== undefined && unavailableKinds.has(context.kind)) return "KIND_UNAVAILABLE";
	const facts = readPeer(peer);
	if (typeof facts === "string") return facts;
	if (routeAllows(route.id, facts, context)) return undefined;
	return routeRefusal(route, facts, context);
}

export type Principal =
	| { readonly kind: "device"; readonly id: string }
	| { readonly kind: "cli" }
	| { readonly kind: "browser"; readonly id: string }
	| { readonly kind: "agent"; readonly id: string }
	| { readonly kind: "plugin"; readonly id: string };

/** A frozen copy of a well-formed principal; undefined for any other kind or shape. */
export function readPrincipal(principal: unknown): Principal | undefined {
	const record = plainRecord(principal, ["kind"], ["id"]);
	const kind = record?.kind;
	if (!record || typeof kind !== "string") return undefined;
	if (kind === "cli") return Object.hasOwn(record, "id") ? undefined : Object.freeze({ kind });
	if (kind !== "device" && kind !== "browser" && kind !== "agent" && kind !== "plugin")
		return undefined;
	const id = record.id;
	return typeof id === "string" && Ulid.safeParse(id).success
		? Object.freeze({ kind, id })
		: undefined;
}

/** The capability a need names, directly or through its statement or operation kind. */
export function needCapability(
	need: unknown,
): { readonly capability: DeviceCapability; readonly kind?: string } | undefined {
	if (typeof need !== "string") return undefined;
	if (OPTIONS.includes(need as DeviceCapability))
		return Object.freeze({ capability: need as DeviceCapability });
	const capability = requiredCapability(need);
	return capability === undefined ? undefined : Object.freeze({ capability, kind: need });
}
const PIN_REQUIRED = Object.freeze({ pin: "required" as const });
const PIN_NONE = Object.freeze({ pin: "none" as const });

export function decidePrincipal(
	principal: Exclude<Principal, { kind: "device" }>,
	need: DeviceCapability | string,
): { readonly pin: "required" | "none" } | AuthzErrorCode {
	const actor = readPrincipal(principal);
	if (!actor || actor.kind === "device" || actor.kind === "plugin") return "PRINCIPAL_REFUSED";
	const wanted = needCapability(need);
	if (actor.kind === "cli" && unavailableKinds.has(need) && !wanted) return "KIND_UNAVAILABLE";
	if (!wanted) return "KIND_UNKNOWN";
	const authority = wanted.capability === "approve" || wanted.capability === "admin";
	if (actor.kind !== "cli") return authority ? "PRINCIPAL_REFUSED" : "PRINCIPAL_UNAVAILABLE";
	// No CLI path approves or yields an approver: no approve kind, no device capability edit.
	if (wanted.capability === "approve" || wanted.kind === "security.device-capabilities")
		return "PRINCIPAL_REFUSED";
	if (unavailableKinds.has(need)) return "KIND_UNAVAILABLE";
	return wanted.capability === "admin" ? PIN_REQUIRED : PIN_NONE;
}
