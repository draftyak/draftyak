import { isIP } from "node:net";
import { types } from "node:util";
import { parseStrict } from "@draftyak/protocol/jcs";

export const MAX_RESULT_BYTES = 1_048_576;
export const MAX_OBSERVERS = 64;
export const MAX_ATTEMPTS = 1024;
export const MAX_PENDING = 64;

export type RecorderCode =
	| "INVALID_RESULT"
	| "UNSUPPORTED_RESULT"
	| "COVERAGE_MISMATCH"
	| "OBSERVATION_MISSING"
	| "OBSERVATION_FAILED"
	| "INCOMPLETE_RESULT"
	| "PROFILE_FORBIDDEN"
	| "CAPACITY_EXCEEDED"
	| "CANARY_UNOBSERVED"
	| "CANARY_MATCHED"
	| "LIFECYCLE";

export class RecorderError extends Error {
	readonly code: RecorderCode;
	constructor(code: RecorderCode) {
		super(`Egress recorder: ${code}`);
		this.code = code;
	}
}

export interface Caller {
	readonly kind: "hub" | "plugin";
	readonly instanceId: string;
}
export interface ObserverDescriptor {
	readonly id: string;
	readonly caller: Caller;
}
export interface Destination {
	readonly host: string;
	readonly port: number;
	readonly transport: "tcp" | "udp";
}
export type Stage = "policy" | "dns" | "connect";
export type Outcome = "pending" | "succeeded" | "refused" | "failed";
export type ObserverState = "missing" | "active" | "complete" | "failed";
export type CanaryVerdict = "unobserved" | "observed-clean" | "matched" | "failed";
export interface RecordedAttempt {
	readonly observerId: string;
	readonly sequence: number;
	readonly destination: Destination;
	readonly outcome: Outcome;
	readonly stage: Stage;
}
export interface ObserverResult extends ObserverDescriptor {
	readonly state: ObserverState;
	readonly attempts: number;
	readonly canary: CanaryVerdict;
}
export interface RecorderResult {
	readonly format: "draftyak.egress-recorder";
	readonly version: 1;
	readonly scope: "component";
	readonly state: "complete" | "failed";
	readonly observers: readonly ObserverResult[];
	readonly attempts: readonly RecordedAttempt[];
}
export interface CoverageRequirements {
	readonly scope: "component" | "native";
	readonly observers: readonly ObserverDescriptor[];
	readonly canary: boolean;
}

export function invalid(): never {
	throw new RecorderError("INVALID_RESULT");
}
export function record(value: unknown, keys: readonly string[]): Record<string, unknown> {
	if (!value || typeof value !== "object" || types.isProxy(value) || Array.isArray(value))
		return invalid();
	const prototype = Object.getPrototypeOf(value);
	if (prototype !== Object.prototype && prototype !== null) return invalid();
	if (Reflect.ownKeys(value).length !== keys.length) return invalid();
	const snapshot: Record<string, unknown> = Object.create(null);
	for (const key of keys) {
		const descriptor = Object.getOwnPropertyDescriptor(value, key);
		if (!descriptor || !("value" in descriptor) || !descriptor.enumerable) return invalid();
		snapshot[key] = descriptor.value;
	}
	return Object.freeze(snapshot);
}
export function arrayValues(value: unknown, maximum: number, minimum = 0): readonly unknown[] {
	if (types.isProxy(value) || !Array.isArray(value)) return invalid();
	const length = Object.getOwnPropertyDescriptor(value, "length")?.value as unknown;
	if (
		!Number.isSafeInteger(length) ||
		(length as number) < minimum ||
		(length as number) > maximum ||
		Reflect.ownKeys(value).length !== (length as number) + 1
	)
		return invalid();
	const snapshot: unknown[] = [];
	for (let index = 0; index < (length as number); index++) {
		const own = Object.getOwnPropertyDescriptor(value, String(index));
		if (!own || !("value" in own) || !own.enumerable) return invalid();
		snapshot.push(own.value);
	}
	return Object.freeze(snapshot);
}
function token(value: unknown): string {
	if (typeof value !== "string" || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(value))
		return invalid();
	return value;
}
export function descriptor(value: unknown): ObserverDescriptor {
	const row = record(value, ["id", "caller"]);
	const caller = record(row.caller, ["kind", "instanceId"]);
	if (caller.kind !== "hub" && caller.kind !== "plugin") return invalid();
	return Object.freeze({
		id: token(row.id),
		caller: Object.freeze({ kind: caller.kind, instanceId: token(caller.instanceId) }),
	});
}
export function descriptors(values: unknown): readonly ObserverDescriptor[] {
	const rows = arrayValues(values, MAX_OBSERVERS, 1).map(descriptor);
	if (new Set(rows.map((row) => row.id)).size !== rows.length) return invalid();
	return Object.freeze(rows);
}
export function destination(value: unknown): Destination {
	const row = record(value, ["host", "port", "transport"]);
	if (
		typeof row.host !== "string" ||
		row.host.length > 253 ||
		row.host !== row.host.toLowerCase() ||
		row.host.includes("%") ||
		(!isIP(row.host) &&
			!/^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)*$/.test(
				row.host,
			)) ||
		!Number.isSafeInteger(row.port) ||
		(row.port as number) < 1 ||
		(row.port as number) > 65_535 ||
		(row.transport !== "tcp" && row.transport !== "udp")
	)
		return invalid();
	return Object.freeze({ host: row.host, port: row.port as number, transport: row.transport });
}

export function readResult(
	input: string | Uint8Array,
	required: CoverageRequirements,
): RecorderResult {
	const requirements = record(required, ["scope", "observers", "canary"]);
	if (requirements.scope !== "component" && requirements.scope !== "native") return invalid();
	if (typeof requirements.canary !== "boolean") return invalid();
	const expected = descriptors(requirements.observers);
	let parsed: unknown;
	try {
		if (
			(typeof input !== "string" && !(input instanceof Uint8Array)) ||
			(typeof input === "string" && input.length > MAX_RESULT_BYTES) ||
			(typeof input === "string" ? Buffer.byteLength(input) : input.byteLength) > MAX_RESULT_BYTES
		)
			return invalid();
		parsed = parseStrict(input);
	} catch {
		return invalid();
	}
	const result = record(parsed, ["format", "version", "scope", "state", "observers", "attempts"]);
	if (
		result.format !== "draftyak.egress-recorder" ||
		result.version !== 1 ||
		result.scope !== "component"
	)
		throw new RecorderError("UNSUPPORTED_RESULT");
	if (requirements.scope !== result.scope) throw new RecorderError("COVERAGE_MISMATCH");
	if (result.state !== "complete" && result.state !== "failed") return invalid();
	if (!Array.isArray(result.observers) || result.observers.length > MAX_OBSERVERS) return invalid();
	if (!Array.isArray(result.attempts) || result.attempts.length > MAX_ATTEMPTS) return invalid();
	const observers: ObserverResult[] = result.observers.map((value) => {
		const row = record(value, ["id", "caller", "state", "attempts", "canary"]);
		const base = descriptor({ id: row.id, caller: row.caller });
		if (
			typeof row.state !== "string" ||
			!["missing", "active", "complete", "failed"].includes(row.state) ||
			typeof row.canary !== "string" ||
			!["unobserved", "observed-clean", "matched", "failed"].includes(row.canary) ||
			!Number.isSafeInteger(row.attempts) ||
			(row.attempts as number) < 0 ||
			(row.attempts as number) > MAX_ATTEMPTS
		)
			return invalid();
		return Object.freeze({
			...base,
			state: row.state as ObserverState,
			attempts: row.attempts as number,
			canary: row.canary as CanaryVerdict,
		});
	});
	if (
		observers.length !== expected.length ||
		new Set(observers.map((row) => row.id)).size !== observers.length ||
		expected.some(
			(row) =>
				!observers.some(
					(actual) =>
						actual.id === row.id &&
						actual.caller.kind === row.caller.kind &&
						actual.caller.instanceId === row.caller.instanceId,
				),
		)
	)
		throw new RecorderError("COVERAGE_MISMATCH");
	const attempts: RecordedAttempt[] = result.attempts.map((value, index) => {
		const row = record(value, ["observerId", "sequence", "destination", "outcome", "stage"]);
		if (
			row.sequence !== index ||
			!observers.some((observer) => observer.id === row.observerId) ||
			typeof row.outcome !== "string" ||
			!["pending", "succeeded", "refused", "failed"].includes(row.outcome) ||
			typeof row.stage !== "string" ||
			!["policy", "dns", "connect"].includes(row.stage) ||
			(row.outcome === "succeeded" && row.stage !== "connect") ||
			(row.outcome === "refused" && row.stage !== "policy")
		)
			return invalid();
		return Object.freeze({
			observerId: row.observerId as string,
			sequence: index,
			destination: destination(row.destination),
			outcome: row.outcome as Outcome,
			stage: row.stage as Stage,
		});
	});
	if (
		observers.some(
			(observer) =>
				observer.attempts !==
				attempts.filter((attempt) => attempt.observerId === observer.id).length,
		)
	)
		return invalid();
	if (observers.some((observer) => observer.state === "missing"))
		throw new RecorderError("OBSERVATION_MISSING");
	if (result.state === "failed" || observers.some((observer) => observer.state === "failed"))
		throw new RecorderError("OBSERVATION_FAILED");
	if (
		observers.some((observer) => observer.state !== "complete") ||
		attempts.some((attempt) => attempt.outcome === "pending")
	)
		throw new RecorderError("INCOMPLETE_RESULT");
	if (requirements.canary) {
		if (observers.some((observer) => observer.canary === "failed"))
			throw new RecorderError("OBSERVATION_FAILED");
		if (observers.some((observer) => observer.canary === "unobserved"))
			throw new RecorderError("CANARY_UNOBSERVED");
		if (observers.some((observer) => observer.canary === "matched"))
			throw new RecorderError("CANARY_MATCHED");
	}
	return Object.freeze({
		format: "draftyak.egress-recorder",
		version: 1,
		scope: "component",
		state: "complete",
		observers: Object.freeze(observers),
		attempts: Object.freeze(attempts),
	});
}
