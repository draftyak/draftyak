import * as z from "zod";
import { Sha256Hex, UtcMs } from "../scalars.ts";
import { SigningKey } from "./common.ts";
export interface HubKeyRotateStatement {
	readonly v: 1;
	readonly hub: string;
	readonly epoch: number;
	readonly keyUse: (typeof HUB_KEY_USES)[number];
	readonly newKey: string;
	readonly iat: number;
}
export const HUB_KEY_USES = ["identity"] as const;
export const HubKeyRotateStatement: z.ZodType<HubKeyRotateStatement> = z.strictObject({
	v: z.literal(1),
	hub: Sha256Hex,
	epoch: z.int().min(0),
	keyUse: z.enum(HUB_KEY_USES),
	newKey: SigningKey,
	iat: UtcMs,
});

export const HubKeyRotateDefinition: {
	readonly typ: "hub-key-rotate.v1";
	readonly schema: typeof HubKeyRotateStatement;
} = { typ: "hub-key-rotate.v1", schema: HubKeyRotateStatement };
