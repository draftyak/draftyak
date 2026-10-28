import * as z from "zod";
import { DEVICE_API_SCHEMAS } from "../../src/device-api.ts";

export const path = "schemas/device-api-v1.schema.json";
export const schema: z.ZodType = z.union(Object.values(DEVICE_API_SCHEMAS)).meta({
	title: "DraftYak device API v1",
	description:
		"L2 requests, reviews, challenges, envelopes and ID-only event frames. Runtime binding rules are in device-api-v1.md.",
});
