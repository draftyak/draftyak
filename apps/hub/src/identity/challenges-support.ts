import { types } from "node:util";
import { DEVICE_API_ERRORS } from "@draftyak/protocol/device-api";
import { AuthzError, deviceApiError } from "../authz/errors.ts";
import type { Clock } from "../kernel/clock.ts";
import { NativeOutboxError } from "../outbox/propose-errors.ts";
import { NativeAdminError } from "./admin-errors.ts";
import { PinError } from "./pin.ts";

export type ChallengeErrorCode =
	| "INVALID_REQUEST"
	| "KIND_UNAVAILABLE"
	| "NOT_FOUND"
	| "CHALLENGE_INVALID"
	| "SIGNATURE_INVALID"
	| "ACK_REQUIRED"
	| "STALE"
	| "LOCAL_TIME_MISMATCH"
	| "POLICY_DENIED"
	| "DRAFT_LOCKED"
	| "SCHEDULE_LIMIT"
	| "SCHEDULING_UNAVAILABLE"
	| "UNAVAILABLE"
	| "DEVICE_REFUSED"
	| "PIN_REFUSED";

export class ChallengeError extends Error {
	readonly code: ChallengeErrorCode;
	readonly detail: string | null;
	readonly wire: string;
	constructor(code: ChallengeErrorCode, cause?: AuthzError | PinError) {
		super(code);
		this.code = code;
		this.detail = cause?.code ?? null;
		this.wire = cause
			? deviceApiError(cause)
			: code === "KIND_UNAVAILABLE"
				? "INVALID_REQUEST"
				: Object.hasOwn(DEVICE_API_ERRORS, code)
					? code
					: "UNAVAILABLE";
	}
}
export function refuse(code: ChallengeErrorCode): never {
	throw new ChallengeError(code);
}
export function failure(error: unknown): ChallengeError {
	if (!types.isProxy(error) && error instanceof ChallengeError) return error;
	if (!types.isProxy(error) && error instanceof NativeAdminError)
		return new ChallengeError(error.code);
	if (!types.isProxy(error) && error instanceof NativeOutboxError)
		return new ChallengeError("STALE");
	if (!types.isProxy(error) && error instanceof AuthzError)
		return new ChallengeError("DEVICE_REFUSED", error);
	if (!types.isProxy(error) && error instanceof PinError)
		return new ChallengeError("PIN_REFUSED", error);
	return new ChallengeError("UNAVAILABLE");
}
export function guard<T>(work: () => T): T {
	try {
		return work();
	} catch (error) {
		throw failure(error);
	}
}
export interface ClockSample {
	readonly wall: number;
	readonly mono: number;
}
export function sample(clock: Clock): ClockSample {
	const wall = clock.wallMs(),
		mono = clock.monotonicMs();
	if (
		!Number.isSafeInteger(wall) ||
		wall < 0 ||
		!Number.isFinite(mono) ||
		mono < 0 ||
		mono > Number.MAX_SAFE_INTEGER
	)
		return refuse("UNAVAILABLE");
	return Object.freeze({ wall, mono });
}
/** Copy plain JSON data without invoking accessors, coercions or proxy traps. */
export function dataCopy(value: unknown, budget = { nodes: 20_000 }, depth = 0): unknown {
	if (--budget.nodes < 0 || depth > 32) return refuse("INVALID_REQUEST");
	if (value === null || typeof value === "boolean") return value;
	if (typeof value === "string") {
		if (value.length > 1_048_576) return refuse("INVALID_REQUEST");
		return value;
	}
	if (typeof value === "number") {
		if (!Number.isSafeInteger(value)) return refuse("INVALID_REQUEST");
		return value;
	}
	if (typeof value !== "object" || types.isProxy(value)) return refuse("INVALID_REQUEST");
	const array = Array.isArray(value),
		proto = Object.getPrototypeOf(value);
	if (array ? proto !== Array.prototype : proto !== Object.prototype && proto !== null)
		return refuse("INVALID_REQUEST");
	const keys = Reflect.ownKeys(value);
	if (keys.length > 20_000) return refuse("INVALID_REQUEST");
	if (array) {
		const length = Object.getOwnPropertyDescriptor(value, "length")?.value;
		if (!Number.isSafeInteger(length) || length > 20_000 || keys.length !== length + 1)
			return refuse("INVALID_REQUEST");
		const result: unknown[] = [];
		for (let i = 0; i < length; i++) {
			const d = Object.getOwnPropertyDescriptor(value, String(i));
			if (!d || !("value" in d)) return refuse("INVALID_REQUEST");
			result.push(dataCopy(d.value, budget, depth + 1));
		}
		return Object.freeze(result);
	}
	const result: Record<string, unknown> = Object.create(null);
	for (const key of keys) {
		if (typeof key !== "string") return refuse("INVALID_REQUEST");
		const d = Object.getOwnPropertyDescriptor(value, key);
		if (!d || !("value" in d)) return refuse("INVALID_REQUEST");
		result[key] = dataCopy(d.value, budget, depth + 1);
	}
	return Object.freeze(result);
}
