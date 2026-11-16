import * as z from "zod";
import { wholeString } from "../entities/common.ts";
import { SendUrl } from "../send-ticket.ts";
import { PublicDnsHost } from "../tool-v1/egress.ts";
import { authScopesValid, authFields as common } from "./auth-fields.ts";
import { issuerOAuth } from "./auth-issuer.ts";

export type { AuthMode } from "./auth-fields.ts";

const endpoint: z.ZodString = wholeString(
	SendUrl.refine((value) => {
		try {
			return PublicDnsHost.safeParse(new URL(value).hostname).success;
		} catch {
			return false;
		}
	}),
);
const oauth: z.ZodObject<
	typeof common & {
		kind: z.ZodLiteral<"oauth2-pkce-loopback">;
		endpoints: z.ZodObject<
			{
				authorization: typeof endpoint;
				token: typeof endpoint;
				revocation: z.ZodOptional<typeof endpoint>;
			},
			z.core.$strict
		>;
	},
	z.core.$strict
> = z.strictObject({
	...common,
	kind: z.literal("oauth2-pkce-loopback"),
	endpoints: z.strictObject({
		authorization: endpoint,
		token: endpoint,
		revocation: endpoint.optional(),
	}),
});
const basicKinds = ["manifest-app", "api-key", "token-paste", "url-secret", "none"] as const;
const basic: z.ZodObject<
	typeof common & { kind: z.ZodEnum<z.core.util.ToEnum<(typeof basicKinds)[number]>> },
	z.core.$strict
> = z.strictObject({ ...common, kind: z.enum(basicKinds) });

// Append a future module's actual schema here; its fields and types follow without another union.
// Self-types keep each tuple entry explicit for isolated declaration emit.
export const AUTH_VARIANTS = [
	oauth as typeof oauth,
	basic as typeof basic,
	issuerOAuth as typeof issuerOAuth,
] as const;
Object.freeze(AUTH_VARIANTS);
export type PluginAuth = z.infer<(typeof AUTH_VARIANTS)[number]>;
export type AuthKind = PluginAuth["kind"];
export const PluginAuth: z.ZodType<PluginAuth> = z
	.discriminatedUnion("kind", AUTH_VARIANTS)
	.refine(authScopesValid)
	.meta({ id: "draftyak.manifest.PluginAuth" });
