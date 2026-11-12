import { canonicalize } from "@draftyak/protocol/jcs";
import type { NativeDevicePeer } from "../authz/native-peer.ts";
import type { HubSession } from "../lifecycle/session.ts";
import {
	createOwnerSettings,
	OWNER_SETTINGS_MAX_BYTES,
	OwnerSettingsError,
	type OwnerSettingsHandle,
	type OwnerSettingsValue,
} from "./settings.ts";

export type NativeApiErrorCode = "INVALID_REQUEST" | "FORBIDDEN" | "NOT_FOUND" | "UNAVAILABLE";
export interface NativeApiResponse {
	readonly status: 200 | 400 | 403 | 404 | 503;
	readonly body: Uint8Array;
}
export interface NativeApiRouter {
	dispatch(
		peer: NativeDevicePeer,
		method: string,
		path: string,
		body: Uint8Array | undefined,
	): NativeApiResponse;
}

const SETTINGS_SCHEMA = "draftyak.entities.OwnerSettings";
export interface NativeApiRouteDescriptor {
	readonly operationId: "getOwnerSettings" | "putOwnerSettings";
	readonly method: "GET" | "PUT";
	readonly path: "/api/v1/settings";
	readonly request: Readonly<{
		schemaRef: typeof SETTINGS_SCHEMA | null;
		maxBytes: number;
	}>;
	readonly response: Readonly<{
		schemaRef: typeof SETTINGS_SCHEMA;
		maxBytes: number;
	}>;
	readonly errors: ReadonlyArray<
		Readonly<{
			status: 400 | 403 | 404 | 503;
			code: NativeApiErrorCode;
		}>
	>;
	readonly security: Readonly<{
		nativeOnly: true;
		capability: "read" | "admin";
	}>;
}

const encoder = new TextEncoder();
const ERROR_STATUS = Object.freeze({
	INVALID_REQUEST: 400,
	FORBIDDEN: 403,
	NOT_FOUND: 404,
	UNAVAILABLE: 503,
} as const);
const invalid = Object.freeze({ status: 400, code: "INVALID_REQUEST" } as const);
const forbidden = Object.freeze({ status: 403, code: "FORBIDDEN" } as const);
const notFound = Object.freeze({ status: 404, code: "NOT_FOUND" } as const);
const unavailable = Object.freeze({ status: 503, code: "UNAVAILABLE" } as const);

function errorResponse(code: NativeApiErrorCode): NativeApiResponse {
	return Object.freeze({
		status: ERROR_STATUS[code],
		body: encoder.encode(`{"code":"${code}"}`),
	});
}
function settingsResponse(value: OwnerSettingsValue): NativeApiResponse {
	const body = encoder.encode(canonicalize(value));
	if (body.byteLength > OWNER_SETTINGS_MAX_BYTES) throw new OwnerSettingsError("UNAVAILABLE");
	return Object.freeze({ status: 200, body });
}

interface Route extends NativeApiRouteDescriptor {
	handle(
		settings: OwnerSettingsHandle,
		peer: NativeDevicePeer,
		body: Uint8Array | undefined,
	): NativeApiResponse;
}
const ROUTES: readonly Route[] = Object.freeze([
	Object.freeze({
		operationId: "getOwnerSettings",
		method: "GET",
		path: "/api/v1/settings",
		request: Object.freeze({ schemaRef: null, maxBytes: 0 }),
		response: Object.freeze({ schemaRef: SETTINGS_SCHEMA, maxBytes: OWNER_SETTINGS_MAX_BYTES }),
		errors: Object.freeze([invalid, forbidden, notFound, unavailable]),
		security: Object.freeze({ nativeOnly: true, capability: "read" }),
		handle(settings: OwnerSettingsHandle, peer: NativeDevicePeer, body: Uint8Array | undefined) {
			if (body !== undefined) return errorResponse("INVALID_REQUEST");
			const value = settings.get(peer);
			return value === undefined ? errorResponse("NOT_FOUND") : settingsResponse(value);
		},
	}),
	Object.freeze({
		operationId: "putOwnerSettings",
		method: "PUT",
		path: "/api/v1/settings",
		request: Object.freeze({ schemaRef: SETTINGS_SCHEMA, maxBytes: OWNER_SETTINGS_MAX_BYTES }),
		response: Object.freeze({ schemaRef: SETTINGS_SCHEMA, maxBytes: OWNER_SETTINGS_MAX_BYTES }),
		errors: Object.freeze([invalid, forbidden, unavailable]),
		security: Object.freeze({ nativeOnly: true, capability: "admin" }),
		handle(settings: OwnerSettingsHandle, peer: NativeDevicePeer, body: Uint8Array | undefined) {
			if (body === undefined) return errorResponse("INVALID_REQUEST");
			return settingsResponse(settings.put(peer, body));
		},
	}),
]);

/** Metadata describes these handlers; the bound service enforces live device rights. */
export const NATIVE_API_ROUTE_DESCRIPTORS: readonly NativeApiRouteDescriptor[] = Object.freeze(
	ROUTES.map((route) =>
		Object.freeze({
			operationId: route.operationId,
			method: route.method,
			path: route.path,
			request: route.request,
			response: route.response,
			errors: route.errors,
			security: route.security,
		}),
	),
);

/** Peer identity comes from the native caller, separately from untrusted request data. */
export function createNativeApiRouter(session: HubSession): NativeApiRouter {
	const settings = createOwnerSettings(session);
	return Object.freeze({
		dispatch(
			peer: NativeDevicePeer,
			method: string,
			path: string,
			body: Uint8Array | undefined,
		): NativeApiResponse {
			if (typeof method !== "string" || typeof path !== "string")
				return errorResponse("INVALID_REQUEST");
			const route = ROUTES.find((entry) => entry.method === method && entry.path === path);
			if (route === undefined) return errorResponse("NOT_FOUND");
			try {
				return route.handle(settings, peer, body);
			} catch (error) {
				if (error instanceof OwnerSettingsError) {
					if (error.code === "INVALID_REQUEST") return errorResponse("INVALID_REQUEST");
					if (error.code === "FORBIDDEN") return errorResponse("FORBIDDEN");
				}
				return errorResponse("UNAVAILABLE");
			}
		},
	});
}
