import * as z from "zod";
import { Sha256Hex, Ulid } from "../scalars.ts";
import { baseFields, type DeviceStatementBase, withLifetime } from "./common.ts";
export interface LoginStatement extends DeviceStatementBase {
	readonly login: string;
	readonly digest: string;
}
export const LoginStatement: z.ZodType<LoginStatement> = withLifetime(
	z.strictObject({ ...baseFields, login: Ulid, digest: Sha256Hex }),
);

export const LoginDefinition: { readonly typ: "login.v1"; readonly schema: typeof LoginStatement } =
	{ typ: "login.v1", schema: LoginStatement };
