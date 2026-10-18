import * as z from "zod";
import { DeviceCapabilities, type DeviceCapability } from "../entities/device.ts";
import { PairingRole } from "../pairing.ts";
import { Sha256Hex, Ulid } from "../scalars.ts";
import { baseFields, type DeviceStatementBase, SigningKey, withLifetime } from "./common.ts";
export interface PairConfirmStatement extends DeviceStatementBase {
	readonly candidate: string;
	readonly role: PairingRole;
	readonly transportSpkiSha256: string;
	readonly signingKey: string;
	readonly capabilities: readonly DeviceCapability[];
}
export const PairConfirmStatement: z.ZodType<PairConfirmStatement> = withLifetime(
	z
		.strictObject({
			...baseFields,
			candidate: Ulid,
			role: PairingRole,
			transportSpkiSha256: Sha256Hex,
			signingKey: SigningKey,
			capabilities: DeviceCapabilities,
		})
		.refine((value) => value.device !== value.candidate, {
			message: "distinct candidate required",
		}),
);

export const PairConfirmDefinition: {
	readonly typ: "pair-confirm.v1";
	readonly schema: typeof PairConfirmStatement;
} = { typ: "pair-confirm.v1", schema: PairConfirmStatement };
