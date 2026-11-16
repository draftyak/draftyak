import * as z from "zod";
import { copyByteView } from "./device-api/bytes.ts";
import { DeviceCapability } from "./entities/device.ts";
import { SchedulingStatus } from "./hub-runtime/status.ts";
import { canonicalize, parseStrict } from "./jcs.ts";
import { ScheduledSummary } from "./scheduled-summary.ts";

export * from "./hub-runtime/status.ts";

export interface HubRuntimeRoute {
	readonly id: string;
	readonly method: "GET";
	readonly path: string;
	readonly role: "device";
	readonly capability: "read";
	readonly confirmation: "confirmed";
	readonly request: "none";
	readonly requestBytes: number;
	readonly responseBytes: number;
	readonly response: "SchedulingStatus" | "ScheduledSummary";
}
const entry = (
	id: string,
	path: string,
	responseBytes: number,
	response: HubRuntimeRoute["response"],
): HubRuntimeRoute =>
	Object.freeze({
		id,
		method: "GET",
		path,
		role: "device",
		capability: "read",
		confirmation: "confirmed",
		request: "none",
		requestBytes: 0,
		responseBytes,
		response,
	});
export const HUB_RUNTIME_ROUTES: readonly HubRuntimeRoute[] = Object.freeze([
	entry("scheduling", "/device/v1/scheduling", 4096, "SchedulingStatus"),
	entry("scheduling-outbox", "/device/v1/scheduling/outbox", 8192, "ScheduledSummary"),
]);
const answers: Readonly<Record<HubRuntimeRoute["response"], z.ZodType>> = Object.freeze({
	SchedulingStatus,
	ScheduledSummary,
});
function findRoute(routeId: string): HubRuntimeRoute | undefined {
	return HUB_RUNTIME_ROUTES.find((route) => route.id === routeId);
}

export function checkHubRuntimeRouteLength(
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
/** Both routes take no body: any received bytes, even none at all, are refused. */
export function checkHubRuntimeRequestBytes(
	routeId: string,
	bytes: Uint8Array | undefined,
): boolean {
	const route = findRoute(routeId);
	return route !== undefined && route.request === "none" && bytes === undefined;
}
/** The cap applies to the received bytes, before strict parsing. */
export function checkHubRuntimeResponseBytes(routeId: string, bytes: Uint8Array): boolean {
	try {
		const route = findRoute(routeId);
		if (route === undefined) return false;
		const received = copyByteView(bytes, route.responseBytes);
		return (
			received !== undefined && answers[route.response].safeParse(parseStrict(received)).success
		);
	} catch {
		return false;
	}
}
/** A convenience for a value without its received bytes: the cap applies to its canonical JSON. */
export function checkHubRuntimeResponse(routeId: string, value: unknown): boolean {
	try {
		const route = findRoute(routeId);
		if (route === undefined) return false;
		const parsed = answers[route.response].safeParse(value);
		return (
			parsed.success &&
			checkHubRuntimeRouteLength(routeId, "response", Buffer.byteLength(canonicalize(parsed.data)))
		);
	} catch {
		return false;
	}
}

// The peer form of the device API's route admission, so one view of the caller serves both.
const peerSchema = z.strictObject({
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
/** A known, non-revoked device confirmed in the current epoch that holds `read`. */
export function hubRuntimeRouteAllows(routeId: string, peer: unknown): boolean {
	try {
		const route = findRoute(routeId);
		const parsed = peerSchema.safeParse(peer);
		if (route === undefined || !parsed.success) return false;
		const p = parsed.data;
		return (
			p.known &&
			!p.revoked &&
			p.role === route.role &&
			p.confirmedEpoch === p.epoch &&
			p.capabilities.includes(route.capability)
		);
	} catch {
		return false;
	}
}
