import * as z from "zod";
import { copyByteView } from "../device-api/bytes.ts";
import { DeviceCapability } from "../entities/device.ts";
import { canonicalize, parseStrict } from "../jcs.ts";
import {
	GmailFlowAuthorization,
	GmailFlowAuthorizeRequest,
	GmailFlowClientRequest,
	GmailFlowRelayRequest,
	GmailFlowView,
	OAUTH_RELAY_RESPONSE_BYTES,
} from "./fields.ts";

export type OAuthRelayRouteId = "client" | "authorize" | "relay";
export interface OAuthRelayRoute {
	readonly id: OAuthRelayRouteId;
	readonly method: "POST";
	readonly path: string;
	readonly role: "device";
	readonly confirmation: "confirmed";
	readonly capability: "admin";
	readonly request: string;
	readonly requestBytes: number;
	readonly responseBytes: number;
	readonly response: string;
}
const route = (
	id: OAuthRelayRouteId,
	request: string,
	requestBytes: number,
	response: string,
): OAuthRelayRoute =>
	Object.freeze({
		id,
		method: "POST",
		path: `/device/v1/accounts/gmail/flow/${id}`,
		role: "device",
		confirmation: "confirmed",
		capability: "admin",
		request,
		requestBytes,
		responseBytes: OAUTH_RELAY_RESPONSE_BYTES,
		response,
	});
// Connecting an account is an admin op, so every call needs a confirmed admin device.
export const OAUTH_RELAY_ROUTES: readonly OAuthRelayRoute[] = Object.freeze([
	route("client", "GmailFlowClientRequest", 32_768, "GmailFlowView"),
	route("authorize", "GmailFlowAuthorizeRequest", 512, "GmailFlowAuthorization"),
	route("relay", "GmailFlowRelayRequest", 2048, "GmailFlowView"),
]);
/** The schemas the routes name, for the JSON Schema export. Check values with the route checks. */
export const OAUTH_RELAY_SCHEMAS: Readonly<Record<string, z.ZodType>> = Object.freeze({
	GmailFlowClientRequest,
	GmailFlowAuthorizeRequest,
	GmailFlowRelayRequest,
	GmailFlowAuthorization,
	GmailFlowView,
});

export interface OAuthRelayRequests {
	readonly client: GmailFlowClientRequest;
	readonly authorize: GmailFlowAuthorizeRequest;
	readonly relay: GmailFlowRelayRequest;
}
export interface OAuthRelayResponses {
	readonly client: GmailFlowView;
	readonly authorize: GmailFlowAuthorization;
	readonly relay: GmailFlowView;
}

/** A fixed message: it never carries a submitted value, member name or parser detail. */
export class OAuthRelayRefused extends Error {
	override name = "OAuthRelayRefused";
	constructor() {
		super("OAuth relay data refused");
	}
}

type Direction = "request" | "response";
const findRoute = (routeId: unknown): OAuthRelayRoute | undefined =>
	OAUTH_RELAY_ROUTES.find((entry) => entry.id === routeId);
const capOf = (entry: OAuthRelayRoute, direction: Direction): number =>
	direction === "request" ? entry.requestBytes : entry.responseBytes;

export function checkOAuthRelayLength(
	routeId: string,
	direction: Direction,
	byteLength: number,
): boolean {
	const entry = findRoute(routeId);
	return (
		entry !== undefined &&
		(direction === "request" || direction === "response") &&
		Number.isSafeInteger(byteLength) &&
		byteLength >= 0 &&
		byteLength <= capOf(entry, direction)
	);
}

function jsonObject(value: unknown): boolean {
	if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
	const prototype: unknown = Object.getPrototypeOf(value);
	return prototype === Object.prototype || prototype === null;
}

// The checked value, or undefined. A flow view is kept as it is: zod's record would copy it and
// drop a "__proto__" member.
function shape(entry: OAuthRelayRoute, direction: Direction, value: unknown): unknown {
	const name = direction === "request" ? entry.request : entry.response;
	if (name === "GmailFlowView") return jsonObject(value) ? value : undefined;
	const parsed = OAUTH_RELAY_SCHEMAS[name]?.safeParse(value);
	return parsed?.success === true ? parsed.data : undefined;
}

// Value form: the value's canonical JSON, checked as received bytes would be, so a value that
// isn't plain JSON data is refused and what passes is what the JSON holds.
function checkValue(routeId: string, direction: Direction, value: unknown): boolean {
	try {
		const entry = findRoute(routeId);
		if (entry === undefined || (direction !== "request" && direction !== "response")) return false;
		const text = canonicalize(value);
		return (
			Buffer.byteLength(text) <= capOf(entry, direction) &&
			shape(entry, direction, parseStrict(text)) !== undefined
		);
	} catch {
		return false;
	}
}

// Received form: the raw byte length is checked before anything is copied or parsed.
function receive(routeId: string, direction: Direction, bytes: unknown): unknown {
	try {
		const entry = findRoute(routeId);
		if (entry === undefined) return undefined;
		const received = copyByteView(bytes, capOf(entry, direction));
		return received === undefined ? undefined : shape(entry, direction, parseStrict(received));
	} catch {
		return undefined;
	}
}

export const checkOAuthRelayRequest = (routeId: string, value: unknown): boolean =>
	checkValue(routeId, "request", value);
export const checkOAuthRelayResponse = (routeId: string, value: unknown): boolean =>
	checkValue(routeId, "response", value);
export const checkOAuthRelayRequestBytes = (routeId: string, bytes: Uint8Array): boolean =>
	receive(routeId, "request", bytes) !== undefined;
export const checkOAuthRelayResponseBytes = (routeId: string, bytes: Uint8Array): boolean =>
	receive(routeId, "response", bytes) !== undefined;

export function parseOAuthRelayRequestBytes<K extends OAuthRelayRouteId>(
	routeId: K,
	bytes: Uint8Array,
): OAuthRelayRequests[K] {
	const value = receive(routeId, "request", bytes);
	if (value === undefined) throw new OAuthRelayRefused();
	return value as OAuthRelayRequests[K];
}
export function parseOAuthRelayResponseBytes<K extends OAuthRelayRouteId>(
	routeId: K,
	bytes: Uint8Array,
): OAuthRelayResponses[K] {
	const value = receive(routeId, "response", bytes);
	if (value === undefined) throw new OAuthRelayRefused();
	return value as OAuthRelayResponses[K];
}

// The peer form of the device API's admission cases.
const Peer = z.strictObject({
	role: z.string(),
	known: z.boolean(),
	revoked: z.boolean(),
	epoch: z.int().min(0),
	confirmedEpoch: z.int().min(0).nullable(),
	capabilities: z
		.array(DeviceCapability)
		.max(DeviceCapability.options.length)
		.refine((items) => new Set(items).size === items.length),
	sidecarClaim: z.boolean(),
	bootstrapDone: z.boolean(),
});

/** A known, non-revoked device confirmed in the current epoch that holds the route's capability. */
export function oauthRelayRouteAllows(routeId: string, peer: unknown): boolean {
	try {
		const entry = findRoute(routeId);
		const parsed = Peer.safeParse(peer);
		if (entry === undefined || !parsed.success) return false;
		const device = parsed.data;
		if (!device.known || device.revoked || device.role !== entry.role) return false;
		if (device.confirmedEpoch !== device.epoch) return false;
		return device.capabilities.includes(entry.capability);
	} catch {
		return false;
	}
}
