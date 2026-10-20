import * as z from "zod";
import { wholeString } from "../entities/common.ts";

export interface AuthMode {
	readonly scopes: string[];
	readonly requiredGrantedScopes: string[];
}
export const scope: z.ZodString = wholeString(
	z
		.string()
		.min(1)
		.max(256)
		.regex(/^[!-~]+$/),
);
export const scopes: z.ZodArray<typeof scope> = z
	.array(scope)
	.max(128)
	.refine((value) => new Set(value).size === value.length)
	.meta({ uniqueItems: true });
export const mode: z.ZodObject<
	{ scopes: typeof scopes; requiredGrantedScopes: typeof scopes },
	z.core.$strict
> = z.strictObject({ scopes, requiredGrantedScopes: scopes });
export const authFields: {
	scopes: typeof scopes;
	requiredGrantedScopes: typeof scopes;
	modes: z.ZodOptional<z.ZodObject<{ read_only: typeof mode }, z.core.$strict>>;
} = {
	scopes,
	requiredGrantedScopes: scopes,
	modes: z.strictObject({ read_only: mode }).optional(),
};
/** Required grants are a subset of the same mode's requested scopes. */
export function authScopesValid(
	value: AuthMode & { readonly modes?: { readonly read_only: AuthMode } },
): boolean {
	const valid = (entry: AuthMode): boolean =>
		entry.requiredGrantedScopes.every((name) => entry.scopes.includes(name));
	return valid(value) && (!value.modes || valid(value.modes.read_only));
}
