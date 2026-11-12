import { types } from "node:util";
import * as z from "zod";
import { canConfirm, DeviceCapability } from "../entities/device.ts";
import { canonicalize, parseStrict } from "../jcs.ts";
import { ADMIN_KINDS, AgentSessionReviewSubject } from "../statements.ts";
import {
	AdminAccountSubject,
	AdminDataBackupSubject,
	AdminDeviceCapabilitiesSubject,
} from "./admin.ts";
import { copyByteView } from "./bytes.ts";
import { Challenge, ChallengeRequest } from "./challenge.ts";
import {
	Accepted,
	BootstrapRequest,
	BootstrapStatus,
	DeviceStatus,
	decodeDeviceStatement,
	OperationCreated,
	PairingWindow,
	PairingWindowRequest,
	SignedEnvelope,
	SyncPause,
} from "./common.ts";
import { EventFrame, EventsRequest } from "./events.ts";
import { OperationRequest, OperationReview, PairConfirmSubject, SendReview } from "./review.ts";

export interface DeviceApiRoute {
	readonly id: string;
	readonly method: "GET" | "POST";
	readonly path: string;
	readonly role: "device";
	readonly capability: "read" | "approve" | "admin" | "organize" | "requiredCapability" | null;
	readonly confirmation: "known" | "sidecar-bootstrap" | "confirmed";
	readonly request: string;
	readonly requestBytes: number;
	readonly responseBytes: number;
	readonly response: string;
	readonly statementType: string | null;
	readonly pairConfirmPolicy: boolean;
}
const entry = (
	id: string,
	method: "GET" | "POST",
	path: string,
	capability: DeviceApiRoute["capability"],
	confirmation: DeviceApiRoute["confirmation"],
	request: string,
	requestBytes: number,
	responseBytes: number,
	response: string,
	statementType: string | null = null,
	pairConfirmPolicy = false,
): DeviceApiRoute =>
	Object.freeze({
		id,
		method,
		path,
		role: "device",
		capability,
		confirmation,
		request,
		requestBytes,
		responseBytes,
		response,
		statementType,
		pairConfirmPolicy,
	});
export const DEVICE_API_ROUTES: readonly DeviceApiRoute[] = Object.freeze([
	entry("status", "GET", "/device/v1/status", null, "known", "none", 0, 1024, "DeviceStatus"),
	entry(
		"bootstrap",
		"POST",
		"/device/v1/bootstrap",
		null,
		"sidecar-bootstrap",
		"BootstrapRequest",
		1024,
		1024,
		"DeviceStatus",
	),
	entry(
		"pairing-window",
		"POST",
		"/device/v1/pairing/windows",
		"approve",
		"confirmed",
		"PairingWindowRequest",
		1024,
		2048,
		"PairingWindow",
	),
	entry(
		"send-review",
		"GET",
		"/device/v1/outbox/<id>/snapshot",
		"approve",
		"confirmed",
		"none",
		0,
		1_048_576,
		"SendReview",
	),
	entry(
		"new-operation",
		"POST",
		"/device/v1/operations",
		"requiredCapability",
		"confirmed",
		"OperationRequest",
		4096,
		1024,
		"OperationCreated",
		null,
		true,
	),
	entry(
		"operation-review",
		"GET",
		"/device/v1/operations/<id>",
		"requiredCapability",
		"confirmed",
		"none",
		0,
		1_048_576,
		"OperationReview",
	),
	entry(
		"challenge",
		"POST",
		"/device/v1/challenges",
		"requiredCapability",
		"confirmed",
		"ChallengeRequest",
		1024,
		32_768,
		"Challenge",
		null,
		true,
	),
	entry(
		"send-approval",
		"POST",
		"/device/v1/approval/send",
		"approve",
		"confirmed",
		"SignedEnvelope",
		32_768,
		1024,
		"Accepted",
		"approval.send.v1",
	),
	entry(
		"pair-confirmation",
		"POST",
		"/device/v1/pair-confirmations",
		"approve",
		"confirmed",
		"SignedEnvelope",
		32_768,
		1024,
		"Accepted",
		"pair-confirm.v1",
		true,
	),
	entry(
		"login",
		"POST",
		"/device/v1/login",
		"approve",
		"confirmed",
		"SignedEnvelope",
		32_768,
		1024,
		"Accepted",
		"login.v1",
	),
	entry(
		"consent",
		"POST",
		"/device/v1/consents",
		"approve",
		"confirmed",
		"SignedEnvelope",
		32_768,
		1024,
		"Accepted",
		"consent.v1",
	),
	entry(
		"agent-session",
		"POST",
		"/device/v1/agent-sessions",
		"approve",
		"confirmed",
		"SignedEnvelope",
		32_768,
		1024,
		"Accepted",
		"agent-session.v1",
	),
	entry(
		"admin",
		"POST",
		"/device/v1/admin",
		"admin",
		"confirmed",
		"SignedEnvelope",
		32_768,
		1024,
		"Accepted",
		"admin.v1",
	),
	entry(
		"sync-pause",
		"POST",
		"/device/v1/sync/pause",
		"organize",
		"confirmed",
		"SyncPause",
		1024,
		1024,
		"SyncPause",
	),
	entry(
		"events",
		"GET",
		"/device/v1/events",
		"read",
		"confirmed",
		"EventsRequest",
		1024,
		65_536,
		"EventFrame",
	),
]);
export const DEVICE_API_ERRORS: Readonly<Record<string, number>> = Object.freeze({
	INVALID_REQUEST: 400,
	FORBIDDEN: 403,
	NOT_FOUND: 404,
	TOO_LARGE: 413,
	PIN_INVALID: 403,
	PIN_LOCKED: 429,
	SIGNATURE_INVALID: 403,
	CHALLENGE_INVALID: 409,
	CODE_MISMATCH: 403,
	ACK_REQUIRED: 409,
	STALE: 409,
	LOCAL_TIME_MISMATCH: 409,
	WINDOW_UNAVAILABLE: 409,
	POLICY_DENIED: 403,
	DRAFT_LOCKED: 409,
	SCHEDULE_LIMIT: 409,
	SCHEDULING_UNAVAILABLE: 503,
	UNAVAILABLE: 503,
});
export const DEVICE_API_CAPABILITIES: Readonly<Record<string, "approve" | "admin">> = Object.freeze(
	{
		"approval.send.v1": "approve",
		"pair-confirm.v1": "approve",
		"login.v1": "approve",
		"consent.v1": "approve",
		"agent-session.v1": "approve",
		"admin.v1": "admin",
		"pair-confirm": "approve",
		login: "approve",
		consent: "approve",
		"agent-session": "approve",
		...Object.fromEntries(ADMIN_KINDS.map((kind) => [kind, "admin" as const])),
	},
);
export function requiredCapability(kind: string): "approve" | "admin" | undefined {
	return Object.hasOwn(DEVICE_API_CAPABILITIES, kind) ? DEVICE_API_CAPABILITIES[kind] : undefined;
}
export interface ApiError {
	readonly code: string;
}
export const ApiError: z.ZodType<ApiError> = z
	.strictObject({ code: z.enum(Object.keys(DEVICE_API_ERRORS) as [string, ...string[]]) })
	.meta({ id: "draftyak.device-api.ApiError" });
export function checkApiError(value: unknown, status: number): boolean {
	try {
		const parsed = ApiError.safeParse(value);
		return parsed.success && DEVICE_API_ERRORS[parsed.data.code] === status;
	} catch {
		return false;
	}
}
export function checkApiErrorBytes(bytes: Uint8Array, status: number): boolean {
	try {
		const received = copyByteView(bytes, 1024);
		return received !== undefined && checkApiError(parseStrict(received), status);
	} catch {
		return false;
	}
}
export const DEVICE_API_SCHEMAS: Readonly<Record<string, z.ZodType>> = Object.freeze({
	DeviceStatus,
	BootstrapRequest,
	BootstrapStatus,
	PairingWindowRequest,
	PairingWindow,
	OperationRequest,
	OperationCreated,
	SyncPause,
	Accepted,
	SendReview,
	PairConfirmSubject,
	OperationReview,
	AgentSessionReviewSubject,
	AdminAccountSubject,
	AdminDeviceCapabilitiesSubject,
	AdminDataBackupSubject,
	ChallengeRequest,
	Challenge,
	SignedEnvelope,
	EventsRequest,
	EventFrame,
	ApiError,
});

function findRoute(routeId: string): DeviceApiRoute | undefined {
	return DEVICE_API_ROUTES.find((route) => route.id === routeId);
}
export function checkRouteLength(
	routeId: string,
	direction: "request" | "response",
	byteLength: number,
): boolean {
	const route = findRoute(routeId);
	return (
		route !== undefined &&
		(direction === "request" || direction === "response") &&
		Number.isSafeInteger(byteLength) &&
		byteLength >= 0 &&
		byteLength <= (direction === "request" ? route.requestBytes : route.responseBytes)
	);
}
function parseShape(
	route: DeviceApiRoute,
	direction: "request" | "response",
	value: unknown,
): z.ZodSafeParseResult<unknown> | undefined {
	const name = direction === "request" ? route.request : route.response;
	const schema =
		direction === "response" && route.id === "bootstrap"
			? BootstrapStatus
			: DEVICE_API_SCHEMAS[name];
	return schema?.safeParse(value);
}
function checkParsedShape(
	route: DeviceApiRoute,
	direction: "request" | "response",
	value: unknown,
): boolean {
	if (route.statementType !== null) {
		if (direction === "response") return (value as Accepted).kind === route.statementType;
		return (
			decodeDeviceStatement(route.statementType, (value as SignedEnvelope).statement) !== undefined
		);
	}
	return true;
}
function checkShape(
	route: DeviceApiRoute,
	direction: "request" | "response",
	value: unknown,
): boolean {
	const parsed = parseShape(route, direction, value);
	return parsed?.success === true && checkParsedShape(route, direction, parsed.data);
}
function checkValue(routeId: string, direction: "request" | "response", value: unknown): boolean {
	try {
		const route = findRoute(routeId);
		if (route === undefined) return false;
		const name = direction === "request" ? route.request : route.response;
		if (name === "none") return value === undefined;
		const parsed = parseShape(route, direction, value);
		return (
			parsed?.success === true &&
			checkRouteLength(routeId, direction, Buffer.byteLength(canonicalize(parsed.data))) &&
			checkParsedShape(route, direction, parsed.data)
		);
	} catch {
		return false;
	}
}
export function checkRouteRequest(routeId: string, value: unknown): boolean {
	return checkValue(routeId, "request", value);
}
export function checkRouteResponse(routeId: string, value: unknown): boolean {
	return checkValue(routeId, "response", value);
}
export function checkRouteRequestBytes(routeId: string, bytes: Uint8Array | undefined): boolean {
	try {
		const route = findRoute(routeId);
		if (route === undefined) return false;
		if (route.request === "none") return bytes === undefined;
		const received = copyByteView(bytes, route.requestBytes);
		return received !== undefined && checkShape(route, "request", parseStrict(received));
	} catch {
		return false;
	}
}
export function checkRouteResponseBytes(routeId: string, bytes: Uint8Array): boolean {
	try {
		const route = findRoute(routeId);
		if (route === undefined) return false;
		const received = copyByteView(bytes, route.responseBytes);
		return received !== undefined && checkShape(route, "response", parseStrict(received));
	} catch {
		return false;
	}
}
const peerSchema = z.strictObject({
	role: z.string(),
	known: z.boolean(),
	revoked: z.boolean(),
	epoch: z.int().min(0),
	confirmedEpoch: z.int().min(0).nullable(),
	capabilities: z
		.array(DeviceCapability)
		.max(5)
		.refine((items) => new Set(items).size === items.length),
	sidecarClaim: z.boolean(),
	bootstrapDone: z.boolean(),
});
const peerFields = [
	"role",
	"known",
	"revoked",
	"epoch",
	"confirmedEpoch",
	"capabilities",
	"sidecarClaim",
	"bootstrapDone",
] as const;

// Capture own JSON data without invoking peer properties or capability-array hooks.
function peerData(value: unknown): Record<string, unknown> | undefined {
	if (value === null || typeof value !== "object" || types.isProxy(value)) return undefined;
	const prototype = Object.getPrototypeOf(value);
	if (prototype !== Object.prototype && prototype !== null) return undefined;
	if (Reflect.ownKeys(value).length !== peerFields.length) return undefined;
	const result: Record<string, unknown> = Object.create(null);
	for (const field of peerFields) {
		const slot = Object.getOwnPropertyDescriptor(value, field);
		if (!slot?.enumerable || !Object.hasOwn(slot, "value")) return undefined;
		const item: unknown = slot.value;
		if (
			field !== "capabilities" &&
			item !== null &&
			!["string", "number", "boolean"].includes(typeof item)
		)
			return undefined;
		result[field] = item;
	}
	const capabilities = result.capabilities;
	if (types.isProxy(capabilities) || !Array.isArray(capabilities)) return undefined;
	const length: unknown = Object.getOwnPropertyDescriptor(capabilities, "length")?.value;
	if (
		typeof length !== "number" ||
		!Number.isSafeInteger(length) ||
		length < 0 ||
		length > DeviceCapability.options.length
	)
		return undefined;
	const held: string[] = [];
	for (let index = 0; index < length; index++) {
		const slot = Object.getOwnPropertyDescriptor(capabilities, String(index));
		if (!slot || !Object.hasOwn(slot, "value") || typeof slot.value !== "string") return undefined;
		held.push(slot.value);
	}
	result.capabilities = held;
	return result;
}

const operationContext = z.strictObject({
	kind: z.string().optional(),
	preset: z.string().optional(),
});
export function routeAllows(
	routeId: string,
	peer: unknown,
	operation?: { kind?: string; preset?: string },
): boolean {
	try {
		const route = findRoute(routeId),
			parsed = peerSchema.safeParse(peerData(peer)),
			options = operationContext.safeParse(operation === undefined ? {} : operation);
		if (route === undefined || !parsed.success || !options.success) return false;
		const p = parsed.data,
			o = options.data;
		if (!p.known || p.revoked || p.role !== route.role) return false;
		const confirmed = p.confirmedEpoch === p.epoch;
		if (route.confirmation === "known") return true;
		if (route.confirmation === "sidecar-bootstrap")
			return !confirmed && p.sidecarClaim && !p.bootstrapDone;
		if (!confirmed) return false;
		if (
			routeId === "new-operation" &&
			o.kind !== "pair-confirm" &&
			!ADMIN_KINDS.includes(o.kind as (typeof ADMIN_KINDS)[number])
		)
			return false;
		if (
			routeId === "challenge" &&
			o.kind !== "approval.send.v1" &&
			o.kind !== "pair-confirm.v1" &&
			o.kind !== "admin.v1" &&
			o.kind !== "agent-session.v1"
		)
			return false;
		const capability =
			route.capability === "requiredCapability"
				? requiredCapability(o.kind ?? "")
				: route.capability;
		if (capability === undefined || capability === null || !p.capabilities.includes(capability))
			return false;
		if (
			route.pairConfirmPolicy &&
			(routeId === "pair-confirmation" || o.kind === "pair-confirm" || o.kind === "pair-confirm.v1")
		)
			return canConfirm(p.capabilities, o.preset as Parameters<typeof canConfirm>[1]);
		return true;
	} catch {
		return false;
	}
}
