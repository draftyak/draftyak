import { Buffer } from "node:buffer";
import { createHmac, timingSafeEqual } from "node:crypto";
import { types } from "node:util";
import { canonicalize } from "@draftyak/protocol/jcs";
import { Sha256Hex, Ulid, UtcMs } from "@draftyak/protocol/scalars";
import { fields } from "../jobs/values.ts";
import {
	captureProviderConsentAcknowledgement,
	captureProviderConsentTarget,
	PROVIDER_CONSENT_VERSION,
	type ProviderConsentAcknowledgement,
	type ProviderConsentTarget,
	ProviderPolicyError,
} from "./provider-values.ts";

/** Authenticated storage DATA, not a current native grant, PIN proof or audit verification. */
export interface ProviderConsentRecord {
	readonly target: ProviderConsentTarget;
	readonly acknowledgement: ProviderConsentAcknowledgement;
	readonly version: number;
	readonly at: number;
	readonly deviceId: string;
	readonly ownerId: string;
	readonly epoch: number;
	readonly accountGeneration: number;
	readonly revoked: boolean;
	readonly auditSeq: number;
	readonly auditMac: string;
}
export const MAX_PROVIDER_CONSENT_RECORD_BYTES = 16_384;
const length = Object.getOwnPropertyDescriptor(
	Object.getPrototypeOf(Uint8Array.prototype),
	"byteLength",
)?.get;
const refused = (): ProviderPolicyError => new ProviderPolicyError();
function integer(value: unknown, min: number): number {
	if (typeof value !== "number" || !Number.isSafeInteger(value) || value < min) throw refused();
	return value;
}
function id(value: unknown): string {
	if (!Ulid.safeParse(value).success) throw refused();
	return value as string;
}
function record(input: unknown): ProviderConsentRecord {
	const raw = fields(input, [
		"target",
		"acknowledgement",
		"version",
		"at",
		"deviceId",
		"ownerId",
		"epoch",
		"accountGeneration",
		"revoked",
		"auditSeq",
		"auditMac",
	]);
	if (
		raw.version !== PROVIDER_CONSENT_VERSION ||
		!UtcMs.safeParse(raw.at).success ||
		typeof raw.revoked !== "boolean" ||
		!Sha256Hex.safeParse(raw.auditMac).success
	)
		throw refused();
	return Object.freeze({
		target: captureProviderConsentTarget(raw.target),
		acknowledgement: captureProviderConsentAcknowledgement(raw.acknowledgement),
		version: PROVIDER_CONSENT_VERSION,
		at: raw.at as number,
		deviceId: id(raw.deviceId),
		ownerId: id(raw.ownerId),
		epoch: integer(raw.epoch, 0),
		accountGeneration: integer(raw.accountGeneration, 1),
		revoked: raw.revoked,
		auditSeq: integer(raw.auditSeq, 1),
		auditMac: raw.auditMac as string,
	});
}
function mac(key: Uint8Array, payload: string): string {
	if (!types.isUint8Array(key) || length?.call(key) !== 32) throw refused();
	return createHmac("sha256", key)
		.update("draftyak/provider-consent/v1\n")
		.update(payload)
		.digest("hex");
}
export function sealProviderConsentRecord(
	key: Uint8Array,
	input: ProviderConsentRecord,
): Readonly<{ payload: string; mac: string }> {
	try {
		const payload = canonicalize(record(input));
		if (Buffer.byteLength(payload, "utf8") > MAX_PROVIDER_CONSENT_RECORD_BYTES) throw refused();
		return Object.freeze({ payload, mac: mac(key, payload) });
	} catch {
		throw refused();
	}
}
/** Verifies bytes/schema/binding only. The native service still checks all live authority. */
export function openProviderConsentRecord(
	key: Uint8Array,
	input: unknown,
	target: ProviderConsentTarget,
	now: number,
): ProviderConsentRecord {
	try {
		const row = fields(input, ["payload", "mac"]);
		if (
			typeof row.payload !== "string" ||
			row.payload.length < 1 ||
			row.payload.length > MAX_PROVIDER_CONSENT_RECORD_BYTES ||
			Buffer.byteLength(row.payload, "utf8") > MAX_PROVIDER_CONSENT_RECORD_BYTES ||
			!Sha256Hex.safeParse(row.mac).success ||
			!UtcMs.safeParse(now).success
		)
			throw refused();
		if (
			!timingSafeEqual(
				Buffer.from(mac(key, row.payload), "hex"),
				Buffer.from(row.mac as string, "hex"),
			)
		)
			throw refused();
		const saved = record(JSON.parse(row.payload));
		if (
			canonicalize(saved) !== row.payload ||
			saved.revoked ||
			saved.at > now ||
			canonicalize(saved.target) !== canonicalize(captureProviderConsentTarget(target))
		)
			throw refused();
		return saved;
	} catch {
		throw refused();
	}
}
