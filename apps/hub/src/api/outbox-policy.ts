import { types } from "node:util";
import { OutboxItem } from "@draftyak/protocol/entities/outbox";
import { canonicalize } from "@draftyak/protocol/jcs";
import { Ulid } from "@draftyak/protocol/scalars";
import type { NativeApiErrorCode, NativeApiResponse } from "./router.ts";

/** Limit only this API's UTF-8 JSON response; the M1 entity contract is unchanged. */
export const OUTBOX_API_MAX_RESPONSE_BYTES = 1_048_576;

export interface OutboxGetRoutePolicy {
	readonly operationId: "getOutboxItem";
	readonly method: "GET";
	readonly path: "/api/v1/outbox/{outboxId}";
	readonly request: Readonly<{ schemaRef: null; maxBytes: 0 }>;
	readonly response: Readonly<{
		schemaRef: "draftyak.entities.OutboxItem";
		maxBytes: number;
	}>;
	readonly errors: ReadonlyArray<
		Readonly<{ status: 400 | 403 | 404 | 503; code: NativeApiErrorCode }>
	>;
	readonly security: Readonly<{ nativeOnly: true; capability: "read" }>;
}

/**
 * Descriptive DATA only, not an active route registration or authorization check.
 * The actual receiver must enforce original Session/peer admission, owner/read rights,
 * and a current same-store transaction before handing an item to the encoder below.
 */
export const OUTBOX_GET_ROUTE_POLICY: OutboxGetRoutePolicy = Object.freeze({
	operationId: "getOutboxItem",
	method: "GET",
	path: "/api/v1/outbox/{outboxId}",
	request: Object.freeze({ schemaRef: null, maxBytes: 0 }),
	response: Object.freeze({
		schemaRef: "draftyak.entities.OutboxItem",
		maxBytes: OUTBOX_API_MAX_RESPONSE_BYTES,
	}),
	errors: Object.freeze([
		Object.freeze({ status: 400, code: "INVALID_REQUEST" } as const),
		Object.freeze({ status: 403, code: "FORBIDDEN" } as const),
		Object.freeze({ status: 404, code: "NOT_FOUND" } as const),
		Object.freeze({ status: 503, code: "UNAVAILABLE" } as const),
	]),
	security: Object.freeze({ nativeOnly: true, capability: "read" }),
});

const encoder = new TextEncoder();

/** Encode a closed transport error, without reading a supplied error object. */
export function outboxErrorResponse(code: unknown): NativeApiResponse {
	switch (code) {
		case "INVALID_REQUEST":
			return Object.freeze({ status: 400, body: encoder.encode('{"code":"INVALID_REQUEST"}') });
		case "FORBIDDEN":
			return Object.freeze({ status: 403, body: encoder.encode('{"code":"FORBIDDEN"}') });
		case "NOT_FOUND":
			return Object.freeze({ status: 404, body: encoder.encode('{"code":"NOT_FOUND"}') });
		default:
			return Object.freeze({ status: 503, body: encoder.encode('{"code":"UNAVAILABLE"}') });
	}
}

const FIELDS = [
	"id",
	"accountId",
	"draftId",
	"rev",
	"proposedBy",
	"contentHash",
	"flagsHash",
	"notBefore",
	"deliverBy",
	"requiredApprovals",
	"createdAt",
	"updatedAt",
	"state",
	"stateReason",
] as const;
const PROPOSER_FIELDS = ["kind", "id"] as const;

function record(value: unknown, fields: readonly string[]): Record<string, unknown> | undefined {
	if (value === null || typeof value !== "object" || types.isProxy(value)) return undefined;
	const prototype = Object.getPrototypeOf(value);
	if (prototype !== null && prototype !== Object.prototype) return undefined;
	const keys = Reflect.ownKeys(value);
	if (
		keys.length !== fields.length ||
		keys.some((key) => typeof key !== "string" || !fields.includes(key))
	)
		return undefined;
	const copy: Record<string, unknown> = Object.create(null);
	for (const key of fields) {
		const descriptor = Object.getOwnPropertyDescriptor(value, key);
		if (!descriptor?.enumerable || !Object.hasOwn(descriptor, "value")) return undefined;
		copy[key] = descriptor.value;
	}
	return copy;
}

function itemData(value: unknown): Record<string, unknown> | undefined {
	const copy = record(value, FIELDS);
	if (!copy) return undefined;
	const proposer = record(copy.proposedBy, PROPOSER_FIELDS);
	if (!proposer) return undefined;
	for (const [key, member] of Object.entries(copy)) {
		if (
			key !== "proposedBy" &&
			member !== null &&
			typeof member !== "string" &&
			typeof member !== "number"
		)
			return undefined;
	}
	if (typeof proposer.kind !== "string" || typeof proposer.id !== "string") return undefined;
	copy.proposedBy = proposer;
	return copy;
}

/**
 * Serialize an already-authorized read result. This function grants no access and performs no read.
 * Only the real bound reader may decide that an item is absent. Outbox state and proposedBy are DATA;
 * neither proves ownership, currentness, approval, or permission to send.
 */
export function outboxItemResponse(requestedId: unknown, value: unknown): NativeApiResponse {
	if (typeof requestedId !== "string" || !Ulid.safeParse(requestedId).success)
		return outboxErrorResponse("INVALID_REQUEST");
	if (value === undefined) return outboxErrorResponse("NOT_FOUND");
	try {
		const captured = itemData(value);
		if (!captured) return outboxErrorResponse("UNAVAILABLE");
		const parsed = OutboxItem.safeParse(captured);
		if (!parsed.success || parsed.data.id !== requestedId)
			return outboxErrorResponse("UNAVAILABLE");
		const bytes = encoder.encode(canonicalize(parsed.data));
		if (bytes.byteLength > OUTBOX_API_MAX_RESPONSE_BYTES) return outboxErrorResponse("UNAVAILABLE");
		return Object.freeze({ status: 200, body: bytes });
	} catch {
		return outboxErrorResponse("UNAVAILABLE");
	}
}
