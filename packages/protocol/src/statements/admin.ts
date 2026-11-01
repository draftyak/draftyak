import * as z from "zod";
import { Sha256Hex, Ulid } from "../scalars.ts";
import { baseFields, type DeviceStatementBase, withLifetime } from "./common.ts";
// Closed groups. Later contracts extend their own group explicitly.
export const ADMIN_GROUPS = {
	plugins: ["plugin.install", "plugin.upgrade"],
	accounts: ["account.connect", "account.disconnect", "account.mode-full"],
	policy: ["policy.routing-loosen", "policy.auto-draft-enable"],
	tools: ["tool.instance-create", "tool.secret-set", "tool.enable", "tool.posture-no-train"],
	access: [
		"access.token-mint",
		"access.grant-widen",
		"access.cimd-host-add",
		"access.exposure-enable",
		"access.bind-address-add",
		"access.advertised-addresses-set",
	],
	security: ["security.device-capabilities", "security.pin-change", "security.key-rotate"],
	data: ["data.export", "data.backup"],
	ai: ["ai.credential-connect", "ai.credential-disconnect"],
	sms: [],
} as const;
export type AdminKind = (typeof ADMIN_GROUPS)[keyof typeof ADMIN_GROUPS][number];
export const ADMIN_KINDS: readonly AdminKind[] = Object.freeze(Object.values(ADMIN_GROUPS).flat());
export const AdminKind: z.ZodEnum<z.core.util.ToEnum<AdminKind>> = z.enum(ADMIN_KINDS);
export interface AdminStatement extends DeviceStatementBase {
	readonly op: string;
	readonly kind: AdminKind;
	readonly digest: string;
}
export const AdminStatement: z.ZodType<AdminStatement> = withLifetime(
	z.strictObject({ ...baseFields, op: Ulid, kind: AdminKind, digest: Sha256Hex }),
);

export const AdminDefinition: { readonly typ: "admin.v1"; readonly schema: typeof AdminStatement } =
	{ typ: "admin.v1", schema: AdminStatement };
