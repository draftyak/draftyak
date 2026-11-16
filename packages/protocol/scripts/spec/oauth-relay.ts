import * as z from "zod";
import { OAUTH_RELAY_SCHEMAS } from "../../src/oauth-relay.ts";

export const path = "schemas/oauth-relay-v1.schema.json";
export const schema: z.ZodType = z.union(Object.values(OAUTH_RELAY_SCHEMAS)).meta({
	title: "DraftYak OAuth relay v1",
	description:
		"The Gmail code relay's L2 requests, the authorization view and the flow view's outer form. Byte caps and admission are in oauth-relay-v1.md.",
});
