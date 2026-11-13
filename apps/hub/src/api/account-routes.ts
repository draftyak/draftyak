import { canonicalize } from "@draftyak/protocol/jcs";
import { Ulid } from "@draftyak/protocol/scalars";
import type { AccountPage, AccountRecord } from "../accounts/records.ts";
import type { NativeDevicePeer } from "../authz/native-peer.ts";
import type { HubSession } from "../lifecycle/session.ts";
import { AccountReadError, createNativeAccountReads } from "./accounts.ts";
import type { NativeApiErrorCode, NativeApiResponse } from "./router.ts";

/** Local UTF-8 response-body bound for these account routes. */
export const ACCOUNT_API_MAX_RESPONSE_BYTES = 1_048_576;

export interface NativeAccountApiRoutes {
	dispatch(
		peer: NativeDevicePeer,
		method: string,
		path: string,
		body: Uint8Array | undefined,
	): NativeApiResponse | undefined;
}

const BASE = "/api/v1/accounts";
const CURSOR = "?afterId=";
const MAX_PATH = BASE.length + CURSOR.length + 26;
const encoder = new TextEncoder();
const statuses = Object.freeze({
	INVALID_REQUEST: 400,
	FORBIDDEN: 403,
	NOT_FOUND: 404,
	UNAVAILABLE: 503,
} as const);

export interface NativeAccountApiRouteDescriptor {
	readonly operationId: "getAccount" | "pageAccounts";
	readonly method: "GET";
	readonly path: "/api/v1/accounts" | "/api/v1/accounts/{accountId}";
	readonly request: Readonly<{ schemaRef: null; maxBytes: 0 }>;
	readonly response: Readonly<{
		schemaRef: "draftyak.native.AccountRecord" | "draftyak.native.AccountPage";
		maxBytes: number;
	}>;
	readonly errors: ReadonlyArray<
		Readonly<{
			status: 400 | 403 | 404 | 503;
			code: NativeApiErrorCode;
		}>
	>;
	readonly security: Readonly<{ nativeOnly: true; capability: "read" }>;
}

const invalid = Object.freeze({ status: 400, code: "INVALID_REQUEST" } as const);
const forbidden = Object.freeze({ status: 403, code: "FORBIDDEN" } as const);
const notFound = Object.freeze({ status: 404, code: "NOT_FOUND" } as const);
const unavailable = Object.freeze({ status: 503, code: "UNAVAILABLE" } as const);
export const NATIVE_ACCOUNT_API_ROUTE_DESCRIPTORS: readonly NativeAccountApiRouteDescriptor[] =
	Object.freeze([
		Object.freeze({
			operationId: "pageAccounts",
			method: "GET",
			path: BASE,
			request: Object.freeze({ schemaRef: null, maxBytes: 0 }),
			response: Object.freeze({
				schemaRef: "draftyak.native.AccountPage",
				maxBytes: ACCOUNT_API_MAX_RESPONSE_BYTES,
			}),
			errors: Object.freeze([invalid, forbidden, unavailable]),
			security: Object.freeze({ nativeOnly: true, capability: "read" }),
		}),
		Object.freeze({
			operationId: "getAccount",
			method: "GET",
			path: "/api/v1/accounts/{accountId}",
			request: Object.freeze({ schemaRef: null, maxBytes: 0 }),
			response: Object.freeze({
				schemaRef: "draftyak.native.AccountRecord",
				maxBytes: ACCOUNT_API_MAX_RESPONSE_BYTES,
			}),
			errors: Object.freeze([invalid, forbidden, notFound, unavailable]),
			security: Object.freeze({ nativeOnly: true, capability: "read" }),
		}),
	]);

function errorResponse(code: NativeApiErrorCode): NativeApiResponse {
	return Object.freeze({ status: statuses[code], body: encoder.encode(`{"code":"${code}"}`) });
}

function response(value: AccountRecord | AccountPage): NativeApiResponse {
	const body = encoder.encode(canonicalize(value));
	return body.byteLength > ACCOUNT_API_MAX_RESPONSE_BYTES
		? errorResponse("UNAVAILABLE")
		: Object.freeze({ status: 200, body });
}

/** Bind metadata reads to the same original Session as the native caller's router. */
export function createNativeAccountApiRoutes(session: HubSession): NativeAccountApiRoutes {
	const reads = createNativeAccountReads(session);
	return Object.freeze({
		dispatch(
			peer: NativeDevicePeer,
			method: string,
			path: string,
			body: Uint8Array | undefined,
		): NativeApiResponse | undefined {
			if (typeof method !== "string" || typeof path !== "string")
				return errorResponse("INVALID_REQUEST");
			if (!path.startsWith(BASE)) return undefined;
			const rest = path.slice(BASE.length);
			// Other complete path segments belong to the surrounding router.
			if (rest.length !== 0 && /^[A-Za-z0-9_.~-]$/.test(rest[0] ?? "")) return undefined;
			if (
				method !== "GET" ||
				body !== undefined ||
				path.length > MAX_PATH ||
				/[^\x21-\x7e]/.test(path)
			)
				return errorResponse("INVALID_REQUEST");
			try {
				if (rest === "") return response(reads.page(peer, null));
				if (rest.startsWith(CURSOR)) {
					const after = rest.slice(CURSOR.length);
					if (!Ulid.safeParse(after).success) return errorResponse("INVALID_REQUEST");
					return response(reads.page(peer, after));
				}
				if (rest.startsWith("/")) {
					const id = rest.slice(1);
					if (!Ulid.safeParse(id).success) return errorResponse("INVALID_REQUEST");
					const record = reads.get(peer, id);
					return record === undefined ? errorResponse("NOT_FOUND") : response(record);
				}
				return errorResponse("INVALID_REQUEST");
			} catch (error) {
				if (error instanceof AccountReadError && error.code === "INVALID_REQUEST")
					return errorResponse("INVALID_REQUEST");
				if (error instanceof AccountReadError && error.code === "FORBIDDEN")
					return errorResponse("FORBIDDEN");
				return errorResponse("UNAVAILABLE");
			}
		},
	});
}
