import { canonicalize } from "@draftyak/protocol/jcs";
import { describe, expect, it } from "vitest";
import {
	OUTBOX_API_MAX_RESPONSE_BYTES,
	OUTBOX_GET_ROUTE_POLICY,
	outboxErrorResponse,
	outboxItemResponse,
} from "../../src/api/outbox-policy.ts";
import { parseNativeOutboxRequest } from "../../src/api/outbox-request.ts";

const ID = "01ARZ3NDEKTSV4RRFFQ69G5FAV";
const OTHER = "01ARZ3NDEKTSV4RRFFQ69G5FAW";
const decoder = new TextDecoder("utf-8", { fatal: true });
const item = () => ({
	id: ID,
	accountId: ID,
	draftId: ID,
	rev: 1,
	proposedBy: { kind: "owner", id: ID },
	contentHash: "a".repeat(64),
	flagsHash: "b".repeat(64),
	notBefore: null,
	deliverBy: null,
	requiredApprovals: 1,
	createdAt: 0,
	updatedAt: 0,
	state: "PENDING_APPROVAL",
	stateReason: null,
});

function error(value: ReturnType<typeof outboxItemResponse>, status: number, code: string): void {
	expect(value.status).toBe(status);
	expect(decoder.decode(value.body)).toBe(`{"code":"${code}"}`);
	expect(Object.isFrozen(value)).toBe(true);
}

describe("outbox API-local response policy", () => {
	it("declares a read-only data policy without registering an authenticated handler", () => {
		expect(OUTBOX_GET_ROUTE_POLICY).toEqual({
			operationId: "getOutboxItem",
			method: "GET",
			path: "/api/v1/outbox/{outboxId}",
			request: { schemaRef: null, maxBytes: 0 },
			response: { schemaRef: "draftyak.entities.OutboxItem", maxBytes: 1_048_576 },
			errors: [
				{ status: 400, code: "INVALID_REQUEST" },
				{ status: 403, code: "FORBIDDEN" },
				{ status: 404, code: "NOT_FOUND" },
				{ status: 503, code: "UNAVAILABLE" },
			],
			security: { nativeOnly: true, capability: "read" },
		});
		for (const value of [
			OUTBOX_GET_ROUTE_POLICY,
			OUTBOX_GET_ROUTE_POLICY.request,
			OUTBOX_GET_ROUTE_POLICY.response,
			OUTBOX_GET_ROUTE_POLICY.errors,
			...OUTBOX_GET_ROUTE_POLICY.errors,
			OUTBOX_GET_ROUTE_POLICY.security,
		])
			expect(Object.isFrozen(value)).toBe(true);
		expect(Object.hasOwn(OUTBOX_GET_ROUTE_POLICY, "dispatch")).toBe(false);
	});

	it("encodes the published parser's selected id and exact M1 item as canonical UTF-8", () => {
		const id = parseNativeOutboxRequest("GET", `/api/v1/outbox/${ID}`);
		const data = item();
		Object.freeze(data.proposedBy);
		Object.freeze(data);
		const response = outboxItemResponse(id, data);
		expect(response.status).toBe(200);
		expect(decoder.decode(response.body)).toBe(canonicalize(data));
		expect(response.body.byteLength).toBeLessThanOrEqual(OUTBOX_API_MAX_RESPONSE_BYTES);
		expect(Object.isFrozen(response)).toBe(true);
		expect(data).toEqual(item());
	});

	it("accepts null-prototype data records without changing the M1 wire shape", () => {
		const data = Object.assign(Object.create(null), item());
		data.proposedBy = Object.assign(Object.create(null), data.proposedBy);
		const response = outboxItemResponse(ID, data);
		expect(response.status).toBe(200);
		expect(decoder.decode(response.body)).toBe(canonicalize(item()));
	});

	it("preserves approved state as data without granting send authority", () => {
		const data = { ...item(), state: "APPROVED" };
		const response = outboxItemResponse(ID, data);
		expect(response.status).toBe(200);
		expect(JSON.parse(decoder.decode(response.body))).toEqual(data);
		expect(Object.keys(response).sort()).toEqual(["body", "status"]);
	});

	it("preserves the actual NEEDS_REAPPROVAL reason", () => {
		const data = { ...item(), state: "NEEDS_REAPPROVAL", stateReason: "restored" };
		expect(decoder.decode(outboxItemResponse(ID, data).body)).toBe(canonicalize(data));
	});

	it.each([
		{ ...item(), stateReason: "restored" },
		{ ...item(), state: "NEEDS_REAPPROVAL", stateReason: null },
		{ ...item(), requiredApprovals: 0 },
		{ ...item(), contentHash: "A".repeat(64) },
	])("refuses an invalid internal M1 item without echoing its fields", (data) => {
		error(outboxItemResponse(ID, data), 503, "UNAVAILABLE");
	});

	it("returns absence only as a fixed response for the reader's undefined result", () => {
		error(outboxItemResponse(ID, undefined), 404, "NOT_FOUND");
		error(outboxItemResponse("not-an-id", undefined), 400, "INVALID_REQUEST");
		error(outboxItemResponse(ID, null), 503, "UNAVAILABLE");
	});

	it("refuses a valid but different item id", () => {
		error(outboxItemResponse(ID, { ...item(), id: OTHER }), 503, "UNAVAILABLE");
	});

	it("does not substitute review snapshots or scheduled summaries for an outbox item", () => {
		for (const data of [
			{ ...item(), snapshot: {}, flags: [], requiredUsers: [ID], expiresAt: 1 },
			{
				scheduling: {},
				scopeHash: "a".repeat(64),
				pendingApprovalCount: 0,
				pendingApprovalIds: [],
				scheduledCount: 0,
				items: [],
			},
		])
			error(outboxItemResponse(ID, data), 503, "UNAVAILABLE");
	});

	it("does not invoke an accessor on the item or its proposer", () => {
		let calls = 0;
		const data = item();
		Object.defineProperty(data, "id", {
			enumerable: true,
			get() {
				calls++;
				return ID;
			},
		});
		error(outboxItemResponse(ID, data), 503, "UNAVAILABLE");
		const nested = item();
		Object.defineProperty(nested.proposedBy, "id", {
			enumerable: true,
			get() {
				calls++;
				return ID;
			},
		});
		error(outboxItemResponse(ID, nested), 503, "UNAVAILABLE");
		expect(calls).toBe(0);
	});

	it("refuses inherited records and hidden or symbol properties", () => {
		const inherited = Object.create(item());
		error(outboxItemResponse(ID, inherited), 503, "UNAVAILABLE");
		const hidden = item();
		Object.defineProperty(hidden, "state", { value: hidden.state, enumerable: false });
		error(outboxItemResponse(ID, hidden), 503, "UNAVAILABLE");
		const symbolic = Object.assign(item(), { [Symbol("extra")]: "untrusted" });
		error(outboxItemResponse(ID, symbolic), 503, "UNAVAILABLE");
	});

	it("refuses active and revoked proxies without invoking any traps", () => {
		let calls = 0;
		const proxy = new Proxy(item(), {
			get() {
				calls++;
				throw new Error("get trap");
			},
			ownKeys() {
				calls++;
				throw new Error("ownKeys trap");
			},
			getPrototypeOf() {
				calls++;
				throw new Error("prototype trap");
			},
		});
		error(outboxItemResponse(ID, proxy), 503, "UNAVAILABLE");
		error(outboxItemResponse(ID, { ...item(), proposedBy: proxy }), 503, "UNAVAILABLE");
		const revoked = Proxy.revocable(item(), {});
		revoked.revoke();
		error(outboxItemResponse(ID, revoked.proxy), 503, "UNAVAILABLE");
		expect(calls).toBe(0);
	});

	it("never coerces scalar objects or invokes toJSON", () => {
		let calls = 0;
		const scalar = {
			[Symbol.toPrimitive]() {
				calls++;
				return ID;
			},
		};
		error(outboxItemResponse(scalar, item()), 400, "INVALID_REQUEST");
		error(outboxItemResponse(ID, { ...item(), accountId: scalar }), 503, "UNAVAILABLE");
		const data = Object.defineProperty(item(), "toJSON", {
			get() {
				calls++;
				throw new Error("toJSON getter");
			},
		});
		error(outboxItemResponse(ID, data), 503, "UNAVAILABLE");
		expect(calls).toBe(0);
	});

	it("refuses oversized malformed source data with fixed bounded error bytes", () => {
		const data = { ...item(), contentHash: "a".repeat(OUTBOX_API_MAX_RESPONSE_BYTES + 1) };
		const response = outboxItemResponse(ID, data);
		error(response, 503, "UNAVAILABLE");
		expect(response.body.byteLength).toBeLessThan(64);
	});

	it.each([
		["INVALID_REQUEST", 400],
		["FORBIDDEN", 403],
		["NOT_FOUND", 404],
		["UNAVAILABLE", 503],
	] as const)("encodes only the fixed %s error", (code, status) => {
		error(outboxErrorResponse(code), status, code);
	});

	it("does not reflect unknown error codes or inspect an error object's code getter", () => {
		let calls = 0;
		const supplied = Object.create(null, {
			code: {
				get() {
					calls++;
					return "FORBIDDEN";
				},
			},
		});
		error(outboxErrorResponse(supplied), 503, "UNAVAILABLE");
		error(outboxErrorResponse("PRIVATE_INPUT"), 503, "UNAVAILABLE");
		expect(calls).toBe(0);
	});

	it("returns fresh response bytes, so a caller cannot change a later error", () => {
		const first = outboxErrorResponse("FORBIDDEN");
		first.body.fill(0);
		error(outboxErrorResponse("FORBIDDEN"), 403, "FORBIDDEN");
	});
});
