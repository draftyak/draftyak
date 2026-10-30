import * as z from "zod";
import { wholeString } from "../entities/common.ts";
import { SendUrl } from "../send-ticket.ts";
import { DNS_NAME, PublicDnsHost } from "../tool-v1/egress.ts";
import { scopes } from "./auth-fields.ts";

function publicHost(url: string): boolean {
	try {
		return PublicDnsHost.safeParse(new URL(url).hostname).success;
	} catch {
		return false;
	}
}
const issuer: z.ZodString = wholeString(
	z
		.string()
		.max(261)
		.regex(new RegExp(`^https:[/][/]${DNS_NAME}$`))
		.refine(publicHost)
		.meta({
			description:
				"An https origin on a public DNS name: no port, path, query, fragment or userinfo.",
		}),
);
const resource: z.ZodString = wholeString(
	SendUrl.refine((value) => !value.includes("?") && publicHost(value)).meta({
		description:
			"A canonical https URL on a public DNS name, with no query: the API the grant is for.",
	}),
);

// The endpoints come from the issuer's discovery document at run time.
export const issuerOAuth: z.ZodObject<
	{
		scopes: typeof scopes;
		requiredGrantedScopes: typeof scopes;
		kind: z.ZodLiteral<"oauth2-dynamic-agent">;
		issuer: z.ZodString;
		resource: z.ZodString;
	},
	z.core.$strict
> = z.strictObject({
	scopes,
	requiredGrantedScopes: scopes,
	kind: z.literal("oauth2-dynamic-agent"),
	issuer,
	resource,
});
