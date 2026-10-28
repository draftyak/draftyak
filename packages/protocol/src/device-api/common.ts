import * as z from "zod";
import { wholeString } from "../entities/common.ts";
import { CONFIRMATION_PRESETS, ConfirmationPreset, DeviceCapability } from "../entities/device.ts";
import { isCanonical } from "../jcs.ts";
import { MAX_PAYLOAD_LENGTH, PAIRING_PREFIX, PairingRole } from "../pairing.ts";
import { fromBase64Url, Sha256Hex, toBase64Url, Ulid } from "../scalars.ts";
import { isStatementType, parseStatement } from "../statements.ts";
import { byteViewLength } from "./bytes.ts";

export const MAX_STATEMENT_BYTES = 16_384;
export const DEVICE_STATEMENT_KINDS: readonly string[] = [
	"approval.send.v1",
	"pair-confirm.v1",
	"login.v1",
	"consent.v1",
	"agent-session.v1",
	"admin.v1",
];
export function checkStatementLength(bytes: Uint8Array): boolean {
	const length = byteViewLength(bytes);
	return length !== undefined && length <= MAX_STATEMENT_BYTES;
}
export function decodeDeviceStatement(
	kind: string,
	text: string,
): Record<string, unknown> | undefined {
	try {
		if (!DEVICE_STATEMENT_KINDS.includes(kind) || !isStatementType(kind) || text.length > 21_846)
			return undefined;
		const bytes = fromBase64Url(text);
		if (
			bytes === undefined ||
			!checkStatementLength(bytes) ||
			toBase64Url(bytes) !== text ||
			!isCanonical(bytes)
		)
			return undefined;
		return parseStatement(kind, bytes) as unknown as Record<string, unknown> | undefined;
	} catch {
		return undefined;
	}
}
export function presetFitsRole(preset: string, role: string): boolean {
	return ConfirmationPreset.safeParse(preset).success && role === "device";
}
export const Pin: z.ZodString = wholeString(
	z
		.string()
		.min(6)
		.max(64)
		.regex(/^[0-9]+$/),
)
	.refine((text) => !/[\r\n\u2028\u2029]/.test(text), { message: "ASCII digits only" })
	.meta({ not: { pattern: "[\\r\\n\\u2028\\u2029]" } });
export const StatementText: z.ZodString = z
	.string()
	.min(1)
	.max(21_846)
	.refine(
		(text) =>
			DEVICE_STATEMENT_KINDS.some((kind) => decodeDeviceStatement(kind, text) !== undefined),
		{ message: "canonical typed statement required" },
	);
export interface DeviceStatus {
	readonly deviceId: string;
	readonly epoch: number;
	readonly confirmed: boolean;
	readonly capabilities: readonly DeviceCapability[];
	readonly testUpstreams: boolean;
}
export const DeviceStatus: z.ZodType<DeviceStatus> = z
	.strictObject({
		deviceId: Ulid,
		epoch: z.int().min(0),
		confirmed: z.boolean(),
		capabilities: z.array(DeviceCapability).max(DeviceCapability.options.length),
		testUpstreams: z.boolean(),
	})
	.refine(
		(value) =>
			value.confirmed === value.capabilities.length > 0 &&
			value.capabilities.every(
				(capability, index, held) =>
					index === 0 ||
					DeviceCapability.options.indexOf(held[index - 1] as DeviceCapability) <
						DeviceCapability.options.indexOf(capability),
			),
		{ message: "confirmation and canonical capability set required" },
	)
	.meta({ id: "draftyak.device-api.DeviceStatus" });
export const BootstrapStatus: z.ZodType<DeviceStatus> = DeviceStatus.refine(
	(value) =>
		value.confirmed &&
		JSON.stringify(value.capabilities) === JSON.stringify(CONFIRMATION_PRESETS.desktop),
	{ message: "desktop bootstrap result required" },
).meta({ id: "draftyak.device-api.BootstrapStatus" });
export interface BootstrapRequest {
	readonly pin: string;
}
export const BootstrapRequest: z.ZodType<BootstrapRequest> = z
	.strictObject({ pin: Pin })
	.meta({ id: "draftyak.device-api.BootstrapRequest" });
export interface PairingWindowRequest {
	readonly role: PairingRole;
	readonly pin: string;
}
export const PairingWindowRequest: z.ZodType<PairingWindowRequest> = z
	.strictObject({ role: PairingRole, pin: Pin })
	.meta({ id: "draftyak.device-api.PairingWindowRequest" });
export interface PairingWindow {
	readonly pairingCode: string;
}
export const PairingWindow: z.ZodType<PairingWindow> = z
	.strictObject({
		pairingCode: z.string().max(MAX_PAYLOAD_LENGTH).startsWith(PAIRING_PREFIX),
	})
	.meta({ id: "draftyak.device-api.PairingWindow" });
export interface OperationCreated {
	readonly id: string;
}
export const OperationCreated: z.ZodType<OperationCreated> = z
	.strictObject({ id: Ulid })
	.meta({ id: "draftyak.device-api.OperationCreated" });
export interface SyncPause {
	readonly paused: boolean;
}
export const SyncPause: z.ZodType<SyncPause> = z
	.strictObject({ paused: z.boolean() })
	.meta({ id: "draftyak.device-api.SyncPause" });
export interface Accepted {
	readonly kind: string;
	readonly id: string;
}
export const Accepted: z.ZodType<Accepted> = z
	.strictObject({
		kind: z.enum([
			"approval.send.v1",
			"pair-confirm.v1",
			"login.v1",
			"consent.v1",
			"agent-session.v1",
			"admin.v1",
		]),
		id: Ulid,
	})
	.meta({ id: "draftyak.device-api.Accepted" });
export interface SignedEnvelope {
	readonly statement: string;
	readonly signature: string;
	readonly pin: string;
}
export const SignedEnvelope: z.ZodType<SignedEnvelope> = z
	.strictObject({
		statement: StatementText,
		signature: z
			.string()
			.length(86)
			.refine(
				(text) => {
					const bytes = fromBase64Url(text);
					return bytes?.length === 64 && toBase64Url(bytes) === text;
				},
				{ message: "64-byte canonical base64url signature required" },
			),
		pin: Pin,
	})
	.meta({ id: "draftyak.device-api.SignedEnvelope" });
export const ChallengeContext: z.ZodType<{ hub: string; device: string }> = z.strictObject({
	hub: Sha256Hex,
	device: Ulid,
});
