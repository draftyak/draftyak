import * as z from "zod";
import { PublicKeySpki } from "../entities/device.ts";
import { fromBase64Url, Sha256Hex, Ulid, UtcMs } from "../scalars.ts";
import { importSpki } from "../sign.ts";

export const STATEMENT_TTL_MS = 120_000;
export interface DeviceStatementBase {
	readonly v: 1;
	readonly hub: string;
	readonly epoch: number;
	readonly device: string;
	readonly nonce: string;
	readonly iat: number;
	readonly exp: number;
}
export const baseFields: {
	v: z.ZodLiteral<1>;
	hub: typeof Sha256Hex;
	epoch: z.ZodInt;
	device: typeof Ulid;
	nonce: z.ZodString;
	iat: typeof UtcMs;
	exp: typeof UtcMs;
} = Object.freeze({
	v: z.literal(1),
	hub: Sha256Hex,
	epoch: z.int().min(0),
	device: Ulid,
	nonce: z
		.string()
		.length(22)
		.refine((value) => fromBase64Url(value)?.length === 16, { message: "128-bit canonical nonce" }),
	iat: UtcMs,
	exp: UtcMs,
});
export function withLifetime<T extends z.ZodObject>(schema: T): T {
	return schema.refine(
		(body) => {
			const value = body as unknown as DeviceStatementBase;
			return value.iat <= value.exp && value.exp - value.iat <= STATEMENT_TTL_MS;
		},
		{ message: "statement lifetime" },
	);
}
export const SigningKey: z.ZodString = PublicKeySpki.refine(
	(value) => {
		try {
			importSpki(value);
			return true;
		} catch {
			return false;
		}
	},
	{ message: "canonical P256 key" },
);
export function isFresh(statement: DeviceStatementBase, now: number): boolean {
	try {
		const { iat, exp } = statement;
		return (
			UtcMs.safeParse(now).success &&
			UtcMs.safeParse(iat).success &&
			UtcMs.safeParse(exp).success &&
			now >= iat &&
			now <= exp &&
			iat <= exp &&
			exp - iat <= STATEMENT_TTL_MS
		);
	} catch {
		return false;
	}
}
